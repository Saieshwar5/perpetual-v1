/**
 * Turning a measurement into something the agent can act on.
 *
 * The system already has one channel for this and it works: a validation
 * problem is appended to the output of the command that caused it, so the
 * correction arrives where the agent is already reading. Layout feedback goes
 * down the same pipe, in the same voice — a fact, then the thing to do about
 * it, in the fewest words that will land.
 *
 * Three rules the wording has to obey, and they are the difference between
 * advice and nagging:
 *
 *   1. MEASURED, NOT JUDGED. "2.4 screens" is a fact. "too long" is an
 *      opinion, and an agent that is told its work is bad without being told
 *      the number cannot tell whether it fixed it.
 *   2. THE READER'S CONDITIONS COME WITH IT. A page that scrolls may be a page
 *      that is too long, or a reader at XL text in a narrow window. Without
 *      the width and the dial, the agent starts writing for a viewport only
 *      one person has.
 *   3. ONCE PER PAGE PER TURN. The client re-measures on every block that
 *      lands; saying the same thing five times as a page assembles would
 *      drown the tool output the agent actually needs to read.
 */
import type { PageRender, RenderReport } from "@perpetual/shared/render";

/** Below this, a page that scrolls is scrolling by a hair and not worth a word. */
const LONG_ENOUGH_TO_MENTION = 1.35;

/** A queue the running turn drains into its next tool result. */
export class NoteQueue {
  private items: string[] = [];
  /** Pages already commented on, so a settling page is not reported five times. */
  private said = new Set<string>();

  /**
   * @param touched only pages this turn wrote — a note about a page the agent
   *                did not touch is someone else's problem and unactionable.
   */
  add(report: RenderReport, touched: Set<string>) {
    for (const p of report.pages) {
      if (!touched.has(p.page) || this.said.has(p.page)) continue;
      const note = describe(p, report);
      if (!note) continue;
      this.said.add(p.page);
      this.items.push(note);
    }
  }

  drain(): string | null {
    if (!this.items.length) return null;
    const all = this.items.join("\n");
    this.items = [];
    return `[perpetual] how your page actually rendered:\n${all}`;
  }
}

function describe(p: PageRender, r: RenderReport): string | null {
  const lines: string[] = [];
  const where = `at the reader's ${r.width}px width and ${r.type} text size`;

  if (p.fit === "scroll" && p.screens >= LONG_ENOUGH_TO_MENTION) {
    lines.push(
      `  ${p.page} runs ${p.screens} screens ${where}, and two columns did not ` +
      "rescue it — so the reader has to scroll inside the page before they can " +
      "move past it. Pages are cheap and long pages are not: consider splitting " +
      "the tail into its own page and linking to it.",
    );
  } else if (p.fit === "columns") {
    lines.push(
      `  ${p.page} did not fit in one column ${where} and was given two, which ` +
      "it fits in. Nothing to fix — worth knowing, because a block added now " +
      "may push it into scrolling.",
    );
  }

  for (const w of p.wide) {
    lines.push(
      `  ${p.page}: the ${w.kind} \`${w.id}\` wants ${w.wants}px and has ${w.has}px, ` +
      `so it scrolls sideways ${where}. Sideways scrolling is the one movement ` +
      "the reader cannot see the end of — drop a column, shorten the cells, or " +
      "let the lines wrap.",
    );
  }

  return lines.length ? lines.join("\n") : null;
}
