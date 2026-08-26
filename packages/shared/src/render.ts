/**
 * What a page turned out to LOOK like — the one thing the agent could never
 * find out about its own work.
 *
 * The loop had a hole in it. The agent writes blocks, the validator checks
 * that they parse and that no markup leaks, and the reader sees the result —
 * but nothing ever told the agent that the page it just wrote runs two and a
 * half screens, or that its table is 1300px wide in an 800px column. It was
 * composing with its eyes closed, and the only critic in the system was the
 * person reading the page.
 *
 * The browser already knows all of it: `fit.ts` asks it, on every page, on
 * every settle. This is that answer, on the wire, going the other way.
 *
 * Deliberately facts, not opinions. "2.4 screens" is measured; "too long" is a
 * judgement, and the judgement belongs in the note the agent reads (see the
 * controller's `notes.ts`) where it can be worded as something to act on.
 */

/** What the fit test concluded. Mirrors `Fit` in the client's fit.ts. */
export type PageFit = "single" | "columns" | "scroll";

export interface BlockOverflow {
  /** The block's own name, when it has one. */
  id?: string;
  kind: string;
  /** How wide it wants to be, and how much room it has, in CSS pixels. */
  wants: number;
  has: number;
}

export interface PageRender {
  page: string;
  fit: PageFit;
  /** Height of the page in viewport-fuls. 1.0 means it fills the screen exactly. */
  screens: number;
  /** Blocks that scroll sideways inside themselves. */
  wide: BlockOverflow[];
}

/**
 * One report for the whole deck, carrying the READER'S conditions with it.
 *
 * Without those, a note about a page that scrolls is unfalsifiable: it may be
 * a page that is too long, or a reader at XL text in a narrow window. The
 * agent has to be told which, or it will start writing for a viewport that
 * only one person has.
 */
export interface RenderReport {
  /** The width the page had, in CSS pixels. */
  width: number;
  /** The reader's text-size dial: "normal", "large", … */
  type: string;
  pages: PageRender[];
}
