/**
 * What the site turned out to look like, for the agent that wrote it.
 *
 * This replaces `fit.ts`, and the deletion is the point. Fitting used to be a
 * DECISION — try one column, try two, ask the browser whether it overflowed —
 * because a deck page was a fixed frame and anything that did not fit inside it
 * was a second gesture the reader had to make. A flow has no frames: a section
 * is as tall as it is, and the reader scrolls, which is the only movement in
 * the product now.
 *
 * So nothing here changes the layout. It only MEASURES, for the one loop that
 * always mattered: the agent finds out how tall its section came out and how
 * wide its table wants to be, on the reader's actual screen.
 *
 * Read-only, deliberately. Anything that mutated the page while a turn was
 * writing it would reflow the reader's view mid-sentence.
 */
import type { BlockOverflow, PageRender } from "@perpetual/shared/render";

/** Taller than this many screens and the section is a scroll rather than a view. */
const A_SCREEN = 1.02;

/**
 * Measure every section as it currently stands.
 *
 * `screens` is the section's height in viewport-fuls — 1.0 is exactly one
 * screen — and it is the number the agent can actually act on, because the one
 * thing it controls is how much it writes.
 *
 * The overflow pass looks only at the two blocks that CAN overflow: code and
 * tables, the two that scroll sideways inside their own frame. A figure scales
 * and prose wraps, so neither can be too wide by construction.
 */
export function measureFlow(host: HTMLElement): { width: number; pages: PageRender[] } {
  const pages: PageRender[] = [];
  const screen = host.clientHeight || 1;

  for (const panel of host.querySelectorAll<HTMLElement>(".panel")) {
    const doc = panel.querySelector<HTMLElement>(".doc");
    const page = panel.dataset.page;
    if (!doc || !page) continue;

    const screens = Math.round((panel.offsetHeight / screen) * 10) / 10;

    const wide: BlockOverflow[] = [];
    for (const [i, node] of [...doc.children].entries()) {
      if (!(node instanceof HTMLElement)) continue;
      const scroller = node.querySelector<HTMLElement>(".tscroll, code");
      if (!scroller) continue;
      const wants = scroller.scrollWidth;
      const has = scroller.clientWidth;
      if (wants > has + 1) {
        wide.push({
          kind: node.classList.contains("tablewrap") ? "table" : "code",
          wants, has,
          ...(node.dataset.blockId ? { id: node.dataset.blockId } : { id: `#${i}` }),
        });
      }
    }

    pages.push({ page, fit: screens > A_SCREEN ? "scroll" : "single", screens, wide });
  }
  return { width: host.clientWidth, pages };
}
