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
import { readSite, type SiteCache } from "./site.ts";
import type { Block } from "@perpetual/shared/blocks";
import type { Page, Problem, Site } from "@perpetual/shared/site";
import type { TurnEvent } from "@perpetual/shared/events";

const key = (p: Problem) => `${p.page}:${p.line ?? "-"}:${p.message}`;
const same = (a: Block, b: Block) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Is this section exactly what was published?
 *
 * Everything the reader can see, which is the meta and the blocks. `tier` is
 * derived from the blocks, so comparing it would be comparing the same fact
 * twice.
 */
const samePage = (a: Page, b: Page) =>
  a.title === b.title && a.ask === b.ask && a.layout === b.layout
  && JSON.stringify(a.blocks) === JSON.stringify(b.blocks);

/**
 * Is this page reconcilable by name?
 *
 * All-or-nothing, deliberately. A half-keyed list is the worst of both: the
 * named blocks reconcile while the unnamed ones shuffle underneath them, and
 * the result is a page that is *sometimes* stable — harder to reason about
 * than one that never is. So a page earns block-by-block updates by naming
 * every block, and `site.ts` tells the agent when it has named only some.
 */
function keyed(blocks: Block[]): boolean {
  return blocks.length > 0 && blocks.every((b) => typeof b.id === "string" && b.id.length > 0);
}

/**
 * The keyed reconciliation: what HAPPENED, rather than what it now looks like.
 *
 * Ops are emitted against a WORKING COPY of the previous list, so every index
 * is the index at the moment that op is applied. The client mutates its own
 * array and its DOM with the same ops in the same order and lands on the same
 * page — no list-diffing code shared between the two, and no chance of the two
 * implementations drifting apart.
 *
 * Removals go first, back to front, so the alignment pass that follows only
 * ever inserts or moves. That keeps it linear and, more importantly, keeps it
 * readable: remove, then walk, and nothing else.
 */
function keyedOps(page: string, before: Block[], after: Block[]): TurnEvent[] {
  const evs: TurnEvent[] = [];
  const work = [...before];
  const wanted = new Set(after.map((b) => b.id));

  for (let i = work.length - 1; i >= 0; i--) {
    if (!wanted.has(work[i]!.id)) {
      evs.push({ type: "page_block_remove", page, index: i });
      work.splice(i, 1);
    }
  }

  for (const [i, want] of after.entries()) {
    // Ids are unique per page, so this can only find it at or after i: every
    // slot before i already holds the block it is supposed to hold.
    const at = work.findIndex((b, j) => j >= i && b.id === want.id);
    if (at === -1) {
      evs.push({ type: "page_block_insert", page, index: i, block: want });
      work.splice(i, 0, want);
      continue;
    }
    if (at !== i) {
      evs.push({ type: "page_block_move", page, from: at, to: i });
      work.splice(i, 0, ...work.splice(at, 1));
    }
    if (!same(work[i]!, want)) {
      evs.push({ type: "page_block_replace", page, index: i, block: want });
      work[i] = want;
    }
  }
  return evs;
}

export class SiteWatcher {
  private siteDir: string;
  private prev = new Map<string, Page>();
  /**
   * Pages as last read, so a poll where nothing changed reads nothing. The
   * watcher polls eight times a second for the length of a turn and almost
   * every one of those polls used to re-read and re-parse the entire site.
   */
  private cache: SiteCache = new Map();
  private seenProblems = new Set<string>();
  /** Problems raised since the last drain — fed back to the agent. */
  private fresh: Problem[] = [];
  /**
   * Published sections. A change to one of these is not rendered.
   *
   * The sandbox already makes them read-only, so under bwrap this can never
   * fire. It exists for the two cases the mount does not cover: PERPETUAL_UNSAFE=1,
   * which has no sandbox at all, and any future path that writes into the site
   * without going through it. A guarantee with one point of failure is not a
   * guarantee.
   */
  private sealed = new Set<string>();
  /** Sealed sections already complained about, so one tamper is one complaint. */
  private tampered = new Set<string>();

  constructor(siteDir: string) {
    this.siteDir = siteDir;
  }

  /** Declare what is published. Called once, at turn start. */
  seal(ids: Iterable<string>) {
    this.sealed = new Set(ids);
  }

  /** Adopt the current state without emitting. Used at turn start. */
  async prime(): Promise<Site> {
    const site = await readSite(this.siteDir, this.cache);
    this.prev = new Map(site.pages.map((p) => [p.id, p]));
    for (const p of site.problems) this.seenProblems.add(key(p));
    return site;
  }

  async poll(): Promise<TurnEvent[]> {
    const site = await readSite(this.siteDir, this.cache);
    const events: TurnEvent[] = [];
    const next = new Map(site.pages.map((p) => [p.id, p]));

    for (const [i, page] of site.pages.entries()) {
      const before = this.prev.get(page.id);

      // Published, and changed anyway. The reader keeps what was published:
      // no events go out, `prev` is left holding the published version, and
      // the agent is told what it did and what to do instead.
      if (before && this.sealed.has(page.id) && !samePage(before, page)) {
        next.set(page.id, before);
        if (!this.tampered.has(page.id)) {
          this.tampered.add(page.id);
          const problem: Problem = {
            page: page.id,
            message: "this section is published and cannot be changed — the reader is " +
              "still seeing what was written, and your change was not applied. Say it " +
              "in a new section instead, and if it replaces something, put " +
              `\`"supersedes":"${page.id}/<block-id>"\` on the block that replaces it.`,
          };
          this.fresh.push(problem);
          events.push({ type: "problem", problem });
        }
        continue;
      }

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

      // A plain append streams the same way whether the page is named or not,
      // and it is the common case by a wide margin — so it stays first, ahead
      // of any reconciliation. Progressive assembly is untouched by all this.
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
      } else if (keyed(before.blocks) && keyed(page.blocks)) {
        // Named on both sides: say what happened. An insert stays an insert, a
        // deletion stays a deletion, and every block that did not change keeps
        // its node — which is the whole reason ids exist.
        events.push(...keyedOps(page.id, before.blocks, page.blocks));
      } else if (changed.length > 0 || page.blocks.length !== before.blocks.length) {
        events.push({ type: "page_replace", page });
      }
    }

    for (const [id, page] of this.prev) {
      if (next.has(id)) continue;
      // A published section that has been deleted stays on the reader's
      // screen. Removing it is the one change that cannot be corrected by
      // writing more, so the refusal matters most here.
      if (this.sealed.has(id)) {
        next.set(id, page);
        if (!this.tampered.has(id)) {
          this.tampered.add(id);
          const problem: Problem = {
            page: id,
            message: "this section is published and cannot be deleted. It is still on " +
              "the reader's screen. Put it back if you removed its files, and write " +
              "what you wanted to say in a new section.",
          };
          this.fresh.push(problem);
          events.push({ type: "problem", problem });
        }
        continue;
      }
      events.push({ type: "page_remove", page: id });
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
