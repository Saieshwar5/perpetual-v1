/**
 * The runtime seam. plans/13 §7.
 *
 * pi-ai is imported here and NOWHERE else. Everything above this file talks to
 * a `Conversation`, so replacing or forking the LLM layer (plans/12) means
 * rewriting one file against one small interface.
 *
 * The seam is stateful on purpose. A multi-step agent turn has to hand the
 * provider back its own assistant messages verbatim — thinking signatures,
 * tool-call ids, the lot — and any attempt to model those in our own types
 * loses fidelity the provider needs. So the message array stays inside, and
 * callers only ever say "the user said X" or "that tool returned Y".
 */
import { createModels, Type, type Context, type Message, type Provider, type Tool } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { DEFAULT_TIMEOUT_SEC } from "./shell/tool.ts";

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Ask for retries. Everything below this line was already switched off.
 *
 * pi-ai calls the provider SDK with `maxRetries: 0` on purpose — the SDKs'
 * built-in retry timers ignore an AbortSignal, so a reader pressing stop would
 * wait out a backoff that nobody could cancel. It replaces them with its own
 * wrapper, which is cancellable and otherwise mirrors the SDK policy exactly.
 *
 * But that wrapper defaults to `maxRetries ?? 0`, and this file never passed a
 * number. So all three layers of retry were off, and a single 429 or 503 —
 * ordinary weather for a serverless endpoint — killed the whole turn. The
 * reader lost their question and kept a half-written page that nothing owned
 * finishing.
 *
 * The library already does the hard part: it retries 408/409/429/5xx and
 * connection failures, never a 400 or a bad key, honours the server's own
 * Retry-After, and backs off exponentially with jitter.
 *
 * The delay cap is the one judgement here. A provider that asks for longer
 * than this fails immediately instead of waiting, because a turn has five
 * minutes in total and a reader is watching a page that has stopped growing —
 * a clear failure beats a silent two-minute stall.
 */
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

export type StepEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCall };

export interface StepResult {
  calls: ToolCall[];
  usage: { input: number; output: number; cacheRead: number; costUsd: number };
  stopReason: string;
  errorMessage?: string;
}

export interface Step extends AsyncIterable<StepEvent> {
  result(): Promise<StepResult>;
}

export interface Conversation {
  user(text: string): void;
  toolResult(callId: string, name: string, text: string, isError: boolean): void;
  step(opts: { effort?: Effort; signal?: AbortSignal }): Step;
}

export interface Runtime {
  readonly modelId: string;
  readonly providerId: string;
  /**
   * How much the model can hold, in tokens. Reported by the catalogue rather
   * than guessed: the loop uses it to warn the agent before it runs out, and a
   * number that is wrong in the optimistic direction is worse than none.
   */
  readonly contextWindow: number;
  conversation(opts: { system: string; sandboxNote: string }): Conversation;
}

/**
 * Providers are registered here and only here, which is the point of the seam:
 * the loop, the shell, the watcher and the client have no idea who is serving
 * the model. Adding one is a row in this table.
 *
 * Fireworks reaches most of its catalogue over the Anthropic Messages wire
 * format, so tool calling behaves the way the rest of this file expects. Its
 * models report `supportsEagerToolInputStreaming: false` — which used to be
 * disqualifying and no longer is: progressive page assembly now comes from
 * watching the filesystem, not from parsing half-streamed tool arguments.
 */
export const PROVIDERS: Record<string, {
  make(): Provider;
  keyEnv: string;
  defaultModel: string;
  /** Prefix that turns a short model name into a catalogue id. */
  prefix?: string;
}> = {
  anthropic: {
    make: anthropicProvider,
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-opus-5",
  },
  fireworks: {
    make: fireworksProvider,
    keyEnv: "FIREWORKS_API_KEY",
    defaultModel: "accounts/fireworks/models/deepseek-v4-pro",
    prefix: "accounts/fireworks/models/",
  },
};

/**
 * The one tool. Two fields — see plans/15 §2 on why the schema stays tiny and
 * the machinery stays deep. The description carries the two facts the model
 * cannot infer: that state is per-command, and where it is allowed to write.
 */
/** Exported so a test can assert the turn asks for retries at all. */
export const RETRY_POLICY = {
  maxRetries: MAX_RETRIES,
  maxRetryDelayMs: MAX_RETRY_DELAY_MS,
} as const;

export function shellTool(sandboxNote: string): Tool {
  return {
    name: "shell",
    description:
      "Run a bash command. This is your only tool; it is how you read, write, search, " +
      "transform, and inspect.\n\n" +
      `Each command runs in a FRESH bash. \`cd\` persists between commands; exported ` +
      "variables and sourced environments do NOT — chain them with `&&` in one command.\n\n" +
      sandboxNote + "\n\n" +
      "stdout and stderr are interleaved. The exit code is always reported. Long output " +
      "is truncated head-and-tail and the full text is written to a file whose path you " +
      "are given, so you can grep it with your next command.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to run." }),
      timeout: Type.Optional(Type.Number({
        description: `Seconds before the command is killed. Default ${DEFAULT_TIMEOUT_SEC}.`,
      })),
    }),
  };
}

export function createRuntime(
  opts: { provider?: string; model?: string; apiKey?: string } = {},
): Runtime {
  const providerId = opts.provider ?? "anthropic";
  const entry = PROVIDERS[providerId];
  if (!entry) {
    throw new Error(
      `Unknown provider "${providerId}". Available: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }

  const models = createModels();
  models.setProvider(entry.make());

  // Fireworks ids are paths (`accounts/fireworks/models/deepseek-v4-pro`), so
  // accept the short name too — nobody should have to type the prefix.
  const asked = opts.model ?? entry.defaultModel;
  const model = models.getModel(providerId, asked)
    ?? (entry.prefix ? models.getModel(providerId, entry.prefix + asked) : undefined);
  if (!model) {
    const near = models.getModels(providerId)
      .map((m) => m.id).filter((id) => id.includes(asked.split("/").pop() ?? asked)).slice(0, 5);
    throw new Error(
      `Unknown model "${asked}" for provider "${providerId}".` +
      (near.length ? `\nDid you mean:\n  ${near.join("\n  ")}` : "") +
      `\nRun \`pnpm models ${providerId}\` for the full catalogue.`,
    );
  }
  const modelId = model.id;

  return {
    modelId,
    providerId,
    contextWindow: model.contextWindow,
    conversation({ system, sandboxNote }) {
      const messages: Message[] = [];
      const tools = [shellTool(sandboxNote)];

      return {
        user(text) {
          messages.push({ role: "user", content: text, timestamp: Date.now() });
        },
        toolResult(callId, name, text, isError) {
          messages.push({
            role: "toolResult",
            toolCallId: callId,
            toolName: name,
            content: [{ type: "text", text }],
            isError,
            timestamp: Date.now(),
          });
        },
        step({ effort, signal }) {
          const context: Context = { systemPrompt: system, messages, tools };
          const stream = models.streamSimple(model, context, {
            reasoning: effort ?? "low",
            ...RETRY_POLICY,
            ...(signal ? { signal } : {}),
            ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          } as never);
          return driveStep(stream, messages);
        },
      };
    },
  };
}

/**
 * Turn one pi-ai stream into StepEvents, and append the resulting assistant
 * message to the conversation. Exported so the replay runtime can be tested
 * against the identical consumer.
 */
export function driveStep(
  stream: AsyncIterable<any> & { result(): Promise<any> },
  messages: Message[],
): Step {
  let final: any;
  let streamError: string | undefined;

  async function* iterate(): AsyncIterable<StepEvent> {
    for await (const ev of stream) {
      switch (ev.type) {
        case "text_delta":
          yield { type: "text_delta", delta: ev.delta };
          break;
        // Announced at `toolcall_end`, not on the deltas: a half-typed command
        // is a lie, and the UI showing one is worse than showing nothing.
        case "toolcall_end":
          if (ev.toolCall?.id) {
            yield {
              type: "tool_call",
              call: { id: ev.toolCall.id, name: ev.toolCall.name, args: ev.toolCall.arguments ?? {} },
            };
          }
          break;
        case "done":
          final = ev.message;
          break;
        case "error":
          final = ev.error;
          streamError = ev.error?.errorMessage ?? `stream ${ev.reason}`;
          break;
      }
    }
    if (!final) final = await stream.result();
    // The assistant message goes back verbatim — signatures, ids and all.
    if (final) messages.push(final as Message);
  }

  const it = iterate()[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]: () => it,
    async result(): Promise<StepResult> {
      // Drain anything the caller left unread, so `final` is always populated.
      while (!final) { const n = await it.next(); if (n.done) break; }
      const u = final?.usage ?? {};
      const calls: ToolCall[] = (final?.content ?? [])
        .filter((c: any) => c.type === "toolCall")
        .map((c: any) => ({ id: c.id, name: c.name, args: c.arguments ?? {} }));
      return {
        calls,
        usage: {
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheRead: u.cacheRead ?? 0,
          costUsd: u.cost?.total ?? 0,
        },
        stopReason: final?.stopReason ?? "stop",
        ...(streamError ?? final?.errorMessage
          ? { errorMessage: streamError ?? final.errorMessage }
          : {}),
      };
    },
  };
}
