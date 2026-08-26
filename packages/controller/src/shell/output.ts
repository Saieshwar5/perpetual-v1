/**
 * Bounded output capture for a shell command.
 *
 * The whole design serves one reader: the model. Two consequences that are not
 * obvious until you watch an agent hit them:
 *
 *   - Truncation keeps the HEAD and the TAIL, never a prefix. Context lives at
 *     the start of output; the error that actually matters lives at the end. A
 *     head-only clip throws away the answer and keeps the preamble.
 *
 *   - Truncated output NAMES the spill file. That turns a dead end into a
 *     workflow: the model's next command is `grep ... /tmp/perp-shell-x.log`.
 *     Without the path, a large output is simply lost work.
 *
 * Nothing here touches a process; it is a string sink with a memory bound, so
 * it is the one part of the harness that can be tested exhaustively.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export const MAX_LINES = 800;
export const MAX_BYTES = 40_000;
/** Of the kept lines, how many come from the head. The rest come from the tail. */
const HEAD_SHARE = 0.2;

export interface Captured {
  text: string;
  truncated: boolean;
  totalLines: number;
  spillPath?: string;
}

export class OutputAccumulator {
  private lines: string[] = [];
  private partial = "";
  private bytes = 0;
  private total = 0;
  // Written with a synchronous fd rather than a WriteStream: the moment the
  // path appears in a tool result the model may `grep` it, so the file has to
  // be complete on disk the instant finish() returns — and a stream's flush is
  // not guaranteed by then. This is the rare overflow path; the cost is fine.
  private spillFd: number | undefined;
  private spillPath: string | undefined;

  push(chunk: string) {
    this.bytes += Buffer.byteLength(chunk);
    if (this.spillFd !== undefined) writeSync(this.spillFd, chunk);

    const parts = (this.partial + chunk).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(line);
      this.total++;
    }

    // Overflow: start spilling everything to disk, and keep only a rolling
    // window in memory. Opened lazily so the common small command never
    // touches the filesystem at all.
    if (this.spillFd === undefined && (this.total > MAX_LINES * 2 || this.bytes > MAX_BYTES * 2)) {
      this.spillPath = join(tmpdir(), `perp-shell-${randomBytes(4).toString("hex")}.log`);
      this.spillFd = openSync(this.spillPath, "w");
      writeSync(this.spillFd, this.lines.join("\n") + "\n");
    }
    // Keep head + a generous tail; the middle is what gets dropped.
    const cap = MAX_LINES * 2;
    if (this.lines.length > cap) {
      const head = Math.floor(MAX_LINES * HEAD_SHARE);
      this.lines = [...this.lines.slice(0, head), ...this.lines.slice(-(cap - head))];
    }
  }

  finish(): Captured {
    if (this.partial) { this.lines.push(this.partial); this.total++; this.partial = ""; }
    if (this.spillFd !== undefined) { closeSync(this.spillFd); this.spillFd = undefined; }

    const keptAll = this.total <= MAX_LINES && this.bytes <= MAX_BYTES;
    if (keptAll) {
      return { text: this.lines.join("\n"), truncated: false, totalLines: this.total };
    }

    const head = Math.floor(MAX_LINES * HEAD_SHARE);
    const tail = MAX_LINES - head;
    const shown = [
      ...this.lines.slice(0, head),
      `[... ${this.total - head - tail} lines elided ...]`,
      ...this.lines.slice(-tail),
    ];
    return {
      text: shown.join("\n"),
      truncated: true,
      totalLines: this.total,
      ...(this.spillPath ? { spillPath: this.spillPath } : {}),
    };
  }
}

/**
 * The result the model reads. Format matters as much as content:
 * the exit code is always present because models chain decisions on it, and a
 * nonzero exit is INFORMATION, not a tool failure — a `grep` that matches
 * nothing exits 1 and has told you something true.
 */
export function formatResult(o: {
  captured: Captured;
  exitCode: number;
  killed: boolean;
  timeoutSec: number;
  cwd?: string;
}): string {
  const parts: string[] = [];
  parts.push(o.captured.text.length ? o.captured.text : "(no output)");
  parts.push("---");
  parts.push(o.killed ? `killed after ${o.timeoutSec}s (timeout)` : `exit code: ${o.exitCode}`);
  if (o.cwd) parts.push(`cwd: ${o.cwd}`);
  if (o.captured.truncated) {
    parts.push(
      `[output truncated: showing ${MAX_LINES} of ${o.captured.totalLines} lines` +
      (o.captured.spillPath ? `; full output: ${o.captured.spillPath}` : "") + "]",
    );
  }
  return parts.join("\n");
}
