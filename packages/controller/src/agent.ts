/**
 * The agent loop.
 *
 * One agent, one tool. The loop is small because the shape of the problem is
 * small: call the model, run whatever shell commands it asked for, call it
 * again, stop when it stops asking. What makes it an *agent* rather than a
 * generator is that the tool results go back in.
 *
 * Two things happen here that are specific to Perpetual:
 *
 *   1. THE SITE IS WATCHED, NOT REPORTED. Page events come from diffing the
 *      session directory on a timer, never from anything the model says. So a
 *      page appears the instant its line is written — mid-command, mid-turn —
 *      and a model that lies about having written one produces nothing.
 *
 *   2. VALIDATION FEEDS BACK THROUGH THE TOOL CHANNEL. A malformed block
 *      becomes a note appended to the output of the command that caused it.
 *      The agent is already reading that text, so the correction arrives where
 *      it will be acted on rather than in a log nobody reads.
 *
 * Both caps below are load-bearing rather than defensive: without them one
 * confused turn runs until the API key does.
 */
import { randomUUID } from "node:crypto";
import { createShell } from "./shell/tool.ts";
import { describeSandbox, mountPath, type SandboxConfig } from "./shell/sandbox.ts";
import { SiteWatcher } from "./watcher.ts";
import { readSite } from "./site.ts";
import { systemPrompt, turnMessage, NUDGE } from "./context.ts";
import type { Runtime, Effort } from "./runtime.ts";
import type { Anchor } from "@perpetual/shared/site";
import type { StopCause, TurnEvent } from "@perpetual/shared/events";

/**
 * Measured, not guessed. 14 was a guess made before any real page existed; a
 * rich page — seventeen blocks, a computed figure, and two self-repairs after
 * the markup guard flagged them — came to exactly 14 and was cut off
 * mid-verification. 22 sits comfortably above the observed ceiling and still
 * far below anything runaway.
 */
const MAX_STEPS = 22;
/** How many steps out the agent is told it is running low. */
const WARN_AT = 3;
const MAX_TURN_MS = 5 * 60_000;
const POLL_MS = 120;

export interface TurnOptions {
  ask: string;
  runtime: Runtime;
  sandbox: SandboxConfig;
  pastAsks: string[];
  /** Where in the site the question was asked from, if anywhere. */
  anchor?: Anchor;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface TurnSummary {
  commands: string[];
  steps: number;
  touched: string[];
  stopped: StopCause;
}

/** The countdown, phrased so the agent can act on it rather than just know it. */
function budgetNote(left: number): string | null {
  if (left > WARN_AT) return null;
  if (left <= 0) {
    return "[perpetual] This is your last command this turn. Anything not " +
           "written to ui/pages/ now will not exist.";
  }
  return `[perpetual] ${left} step${left === 1 ? "" : "s"} left this turn. ` +
         "Finish the page — write its closing blocks rather than starting anything new.";
}

/** A queue that lets the watcher and the loop both push into one stream. */
class EventQueue {
  private items: TurnEvent[] = [];
  private waiting: ((v: void) => void) | null = null;
  private closed = false;

  push(...evs: TurnEvent[]) {
    if (!evs.length) return;
    this.items.push(...evs);
    this.waiting?.(); this.waiting = null;
  }
  close() { this.closed = true; this.waiting?.(); this.waiting = null; }

  async *drain(): AsyncIterable<TurnEvent> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => { this.waiting = r; });
    }
  }
}

export function runTurn(o: TurnOptions): AsyncIterable<TurnEvent> & { summary: Promise<TurnSummary> } {
  const q = new EventQueue();
  const watcher = new SiteWatcher(o.sandbox.root);
  const shell = createShell(o.sandbox);
  const commands: string[] = [];
  const touched = new Set<string>();
  let steps = 0;
  // Anything but "done" means the agent was cut off with work possibly left.
  let stopped: StopCause = "done";

  const summary = (async (): Promise<TurnSummary> => {
    const started = Date.now();
    const usage = { input: 0, output: 0, cacheRead: 0, costUsd: 0 };

    // Everything already on disk is the baseline: this turn's events describe
    // only what this turn changed.
    const site = await watcher.prime();
    const before = new Set(site.pages.map((p) => p.id));

    const flush = async () => {
      const evs = await watcher.poll();
      for (const e of evs) {
        if (e.type === "page_open" || e.type === "page_replace") touched.add(e.page.id);
        else if (e.type === "page_block" || e.type === "page_meta") touched.add(e.page);
      }
      q.push(...evs);
    };

    // Poll while the model thinks and while commands run, so a page written
    // halfway through a long command still streams as it is written.
    const ticker = setInterval(() => { void flush().catch(() => {}); }, POLL_MS);
    ticker.unref?.();

    try {
      q.push({ type: "turn_start", ask: o.ask });

      const convo = o.runtime.conversation({
        system: await systemPrompt(),
        sandboxNote:
          `You are in ${mountPath(o.sandbox)} and it is the only writable place. ` +
          `Sandbox: ${describeSandbox(o.sandbox)}.`,
      });
      convo.user(turnMessage({
        ask: o.ask, site, pastAsks: o.pastAsks,
        ...(o.anchor ? { anchor: o.anchor } : {}),
      }));

      let nudged = false;

      for (; steps < MAX_STEPS; steps++) {
        if (o.signal?.aborted) { stopped = "aborted"; break; }
        if (Date.now() - started > MAX_TURN_MS) {
          stopped = "time";
          q.push({ type: "error", message: "Turn exceeded its time budget and was stopped." });
          break;
        }
        // Running out of budget is the agent's problem to solve, so tell it —
        // through the same channel it already acts on. A warned agent lands
        // the page; an unwarned one is cut off mid-sentence.
        if (MAX_STEPS - steps - 1 <= WARN_AT) stopped = "steps";

        const step = convo.step({
          ...(o.effort ? { effort: o.effort } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
        });
        for await (const ev of step) {
          if (ev.type === "text_delta") q.push({ type: "text_delta", delta: ev.delta });
        }
        const result = await step.result();
        usage.input += result.usage.input;
        usage.output += result.usage.output;
        usage.cacheRead += result.usage.cacheRead;
        usage.costUsd += result.usage.costUsd;

        if (result.errorMessage) {
          stopped = "error";
          q.push({ type: "error", message: result.errorMessage });
          break;
        }

        if (result.calls.length === 0) {
          await flush();
          // The one guarantee the harness makes on the agent's behalf: a turn
          // that produced no page is not a finished turn. Exactly one nudge —
          // twice would be nagging a model that has genuinely nothing to add.
          if (touched.size === 0 && !nudged) { nudged = true; convo.user(NUDGE); continue; }
          stopped = "done";                    // it stopped because it finished
          break;
        }

        for (const call of result.calls) {
          if (call.name !== "shell") {
            convo.toolResult(call.id, call.name, `No tool named "${call.name}". You have: shell.`, true);
            continue;
          }
          const command = String(call.args.command ?? "");
          const id = randomUUID().slice(0, 8);
          commands.push(command);
          q.push({ type: "tool_start", id, command });

          const r = await shell.run({
            command,
            ...(typeof call.args.timeout === "number" ? { timeoutSec: call.args.timeout } : {}),
            ...(o.signal ? { signal: o.signal } : {}),
            onOutput: (chunk) => q.push({ type: "tool_output", id, chunk }),
          });
          q.push({
            type: "tool_end", id, exitCode: r.exitCode, ms: r.ms,
            truncated: r.captured.truncated, killed: r.killed,
          });

          await flush();
          const notes = [watcher.drainFeedback(), budgetNote(MAX_STEPS - steps - 1)]
            .filter(Boolean).join("\n\n");
          convo.toolResult(call.id, "shell", notes ? `${r.text}\n\n${notes}` : r.text, false);
        }
      }

      await flush();
      const after = await readSite(o.sandbox.root);
      q.push({
        type: "turn_end",
        usage: { ...usage, ms: Date.now() - started, steps },
        pages: after.pages.length,
        stopped,
      });
      for (const id of after.pages.map((p) => p.id)) if (!before.has(id)) touched.add(id);
    } catch (e) {
      stopped = "error";
      q.push({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearInterval(ticker);
      q.close();
    }

    return { commands, steps, touched: [...touched], stopped };
  })();

  return Object.assign(q.drain(), { summary });
}
