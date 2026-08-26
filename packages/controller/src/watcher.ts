/**
 * Watching the website change.
 *
 * The agent never announces a page. It writes one, and this turns the
 * difference between two readings of the directory into events. That
 * indirection is the point: the renderer's source of truth is the filesystem,
 * so anything the agent *claims* is irrelevant and anything it *writes* is
 * immediately real — including edits to pages from previous turns, which
 * arrive here as ordinary diffs and need no special "amend" machinery.
 *
 * Append vs rewrite is distinguished deliberately. An append is the common
 * case and streams block-by-block, which is what makes a page assemble in
 * front of the user. Anything else is a wholesale replace, and the client
 * morphs the DOM rather than rebuilding it, so a rewritten page keeps its
 * scroll position and its identity.
 */
import { readSite } from "./site.ts";
import type { Page, Problem, Site } from "@perpetual/shared/site";
import type { TurnEvent } from "@perpetual/shared/events";

const key = (p: Problem) => `${p.page}:${p.line ?? "-"}:${p.message}`;

export class SiteWatcher {
  private siteDir: string;
  private prev = new Map<string, Page>();
  private seenProblems = new Set<string>();
  /** Problems raised since the last drain — fed back to the agent. */
  private fresh: Problem[] = [];

  constructor(siteDir: string) {
    this.siteDir = siteDir;
  }

  /** Adopt the current state without emitting. Used at turn start. */
  async prime(): Promise<Site> {
    const site = await readSite(this.siteDir);
    this.prev = new Map(site.pages.map((p) => [p.id, p]));
    for (const p of site.problems) this.seenProblems.add(key(p));
    return site;
  }

  async poll(): Promise<TurnEvent[]> {
    const site = await readSite(this.siteDir);
    const events: TurnEvent[] = [];
    const next = new Map(site.pages.map((p) => [p.id, p]));

    for (const [i, page] of site.pages.entries()) {
      const before = this.prev.get(page.id);

      if (!before) {
        // Open the page empty, then stream its blocks in. The client can start
        // a transition on the metadata alone, before any content exists.
        events.push({ type: "page_open", page: { ...page, blocks: [] }, index: i });
        page.blocks.forEach((b, bi) => events.push({ type: "page_block", page: page.id, index: bi, block: b }));
        continue;
      }

      // Tier is not compared: it is derived from the blocks, so a change in it
      // is always already described by the block events below.
      if (before.title !== page.title || before.ask !== page.ask) {
        events.push({
          type: "page_meta", page: page.id, title: page.title,
          ...(page.ask ? { ask: page.ask } : {}),
        });
      }

      const grew = page.blocks.length > before.blocks.length;
      const changed = before.blocks
        .map((b, bi) => (JSON.stringify(b) === JSON.stringify(page.blocks[bi]) ? -1 : bi))
        .filter((bi) => bi !== -1);

      if (grew && changed.length === 0) {
        for (let bi = before.blocks.length; bi < page.blocks.length; bi++) {
          events.push({ type: "page_block", page: page.id, index: bi, block: page.blocks[bi]! });
        }
      } else if (changed.length === 1 && page.blocks.length === before.blocks.length) {
        // The regenerated-figure case, and the corrected-number case. Swapping
        // one node keeps the reader's scroll position, where rebuilding the
        // page would throw it away — and a figure being iterated on is exactly
        // when that matters most.
        const bi = changed[0]!;
        events.push({ type: "page_block_replace", page: page.id, index: bi, block: page.blocks[bi]! });
      } else if (changed.length > 0 || page.blocks.length !== before.blocks.length) {
        events.push({ type: "page_replace", page });
      }
    }

    for (const id of this.prev.keys()) {
      if (!next.has(id)) events.push({ type: "page_remove", page: id });
    }

    for (const p of site.problems) {
      if (this.seenProblems.has(key(p))) continue;
      this.seenProblems.add(key(p));
      this.fresh.push(p);
      events.push({ type: "problem", problem: p });
    }

    this.prev = next;
    return events;
  }

  /**
   * Problems since the last drain, phrased for the agent. Appended to the
   * output of whichever command caused them, so the correction arrives in the
   * channel the agent is already reading.
   */
  drainFeedback(): string | null {
    if (this.fresh.length === 0) return null;
    const lines = this.fresh.map(
      (p) => `  ${p.page}${p.line ? ` line ${p.line}` : ""}: ${p.message}`,
    );
    this.fresh = [];
    return `[perpetual] the page you just wrote has problems the reader will not see:\n${
      lines.join("\n")}\nFix them before continuing.`;
  }

  get pageIds(): string[] { return [...this.prev.keys()]; }
}
