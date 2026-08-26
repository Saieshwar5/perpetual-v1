/**
 * The wire protocol.
 *
 * Two families, and the split is the architecture:
 *
 *   `tool_*`   — the agent WORKING. Shell commands, their output, exit codes.
 *   `page_*`   — the agent SPEAKING. Derived by watching the session directory,
 *                never reported by the agent itself.
 *
 * Nothing the agent says produces a `page_*` event. Only what it *writes*
 * does. That is what makes "the filesystem is the API" true rather than
 * aspirational: the renderer trusts the directory, and the directory only.
 */
import type { Block } from "./blocks.ts";
import type { Page, Problem } from "./site.ts";

export type TurnEvent =
  /** A turn began. */
  | { type: "turn_start"; ask: string }
  /** The model is thinking out loud, between tool calls. Status, not content. */
  | { type: "text_delta"; delta: string }

  /** A shell command is about to run. */
  | { type: "tool_start"; id: string; command: string }
  /** Output arriving from a running command. */
  | { type: "tool_output"; id: string; chunk: string }
  /** The command finished (or was killed — a timeout is a result, not a fault). */
  | { type: "tool_end"; id: string; exitCode: number; ms: number; truncated: boolean; killed: boolean }

  /** A page directory appeared. Fires before its first block. */
  | { type: "page_open"; page: Page; index: number }
  /** One more block was appended to a page. The progressive-assembly path. */
  | { type: "page_block"; page: string; index: number; block: Block }
  /** One block changed in place — a regenerated figure, a corrected number. */
  | { type: "page_block_replace"; page: string; index: number; block: Block }
  /** A page changed in a way that is not an append — rewritten, or amended. */
  | { type: "page_replace"; page: Page }
  /** A page directory went away. */
  | { type: "page_remove"; page: string }
  /** Title or ask changed. */
  | { type: "page_meta"; page: string; title: string; ask?: string }

  /** Validation found something wrong. Also fed back to the agent. */
  | { type: "problem"; problem: Problem }

  | { type: "turn_end"; usage: Usage; pages: number; stopped: StopCause }
  | { type: "error"; message: string };

/**
 * Why a turn ended. Anything but "done" means the agent was cut off, and the
 * page may be unfinished — which used to be invisible: a truncated turn and a
 * completed one looked identical from every side.
 */
export type StopCause = "done" | "steps" | "time" | "aborted" | "error";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  ms: number;
  /** Model round-trips this turn. A high number means the agent is flailing. */
  steps: number;
}
