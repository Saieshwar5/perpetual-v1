/**
 * Adaptive columns. plans/17, phase 2.
 *
 * Every real page the agent writes comes out about two screens tall, which
 * means reading one takes TWO gestures: a normal scroll inside the page, then
 * a force-scroll between pages. That is a leak in the whole idea — pages are
 * supposed to be things you move between.
 *
 * So a page that does not fit in one column is given two. Four of the five
 * real pages measured then fit on one screen with nothing to scroll, and
 * force-scroll becomes the only movement in the product.
 *
 * TWO COLUMNS ARE ONLY BAD BECAUSE OF SCROLLING — you read down the left, then
 * have to scroll back up to start the right. That objection is entirely about
 * scrolling, so the rule below only ever uses columns when the page fits
 * whole. Books and newspapers have done this forever for the same reason: the
 * page is a fixed frame.
 *
 * There is no height arithmetic here. Estimating is where this would go wrong
 * — an unbreakable figure near a column boundary pushes a gap no formula
 * predicts — so instead we try a layout and ask the browser whether it
 * overflowed.
 */
export type Fit = "single" | "columns" | "scroll";

import type { BlockOverflow, PageRender } from "@perpetual/shared/render";

/**
 * @param sheet the scroller
 * @param doc   the document inside it
 * @param allow false pins single-column, for comparing the two by eye
 */
export function fitPage(sheet: HTMLElement, doc: HTMLElement, allow = true): Fit {
  // A compact dock first: the roomy version exists to let a scrolling page be
  // pushed past its end, and a page that fits has no end to push past.
  sheet.classList.add("fits");
  doc.classList.remove("cols-2");

  // The whole test, and it is exact: does the scroller need to scroll?
  const overflows = () => sheet.scrollHeight > sheet.clientHeight + 1;

  if (!overflows()) return "single";

  if (allow) {
    doc.classList.add("cols-2");
    if (!overflows()) return "columns";
    doc.classList.remove("cols-2");
  }

  sheet.classList.remove("fits");
  return "scroll";
}

/**
 * The same test, run for its ANSWER rather than for its effect.
 *
 * `fitPage` leaves the winning layout applied, which is exactly right when the
 * reader is looking at a finished page and exactly wrong while one is being
 * written: a page that flips into two columns halfway through being assembled
 * and back out again a second later is worse than one that waits. So this
 * saves the classes, asks the question, and puts them back.
 *
 * Nothing paints in between — the whole thing is synchronous, and the browser
 * has no opportunity to draw an intermediate state — so the reader sees the
 * page they were already reading while the agent gets told what it made.
 */
export function probePage(sheet: HTMLElement, doc: HTMLElement, allow = true): {
  fit: Fit; screens: number;
} {
  const hadFits = sheet.classList.contains("fits");
  const hadCols = doc.classList.contains("cols-2");
  try {
    const fit = fitPage(sheet, doc, allow);
    // Measured in the single-column state, because that is the state the
    // agent can do something about: it can shorten a page, and it cannot
    // choose whether the page is given columns.
    sheet.classList.add("fits");
    doc.classList.remove("cols-2");
    const screens = sheet.clientHeight > 0
      ? Math.round((sheet.scrollHeight / sheet.clientHeight) * 10) / 10
      : 1;
    return { fit, screens };
  } finally {
    sheet.classList.toggle("fits", hadFits);
    doc.classList.toggle("cols-2", hadCols);
  }
}

/**
 * Everything about the deck as it actually rendered, for the agent that wrote
 * it. Read-only: see `probePage`.
 *
 * The overflow pass looks only at the two blocks that CAN overflow — code and
 * tables, the two that scroll sideways inside their own frame. A figure scales
 * and prose wraps, so neither can be too wide by construction.
 */
export function measureDeck(
  deck: HTMLElement, allow = true,
): { width: number; pages: PageRender[] } {
  const pages: PageRender[] = [];
  for (const panel of deck.querySelectorAll<HTMLElement>(".panel")) {
    const sheet = panel.querySelector<HTMLElement>(".sheet");
    const doc = panel.querySelector<HTMLElement>(".doc");
    const page = panel.dataset.page;
    if (!sheet || !doc || !page) continue;

    const { fit, screens } = probePage(sheet, doc, allow);

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
    pages.push({ page, fit, screens, wide });
  }
  return { width: deck.clientWidth, pages };
}

/**
 * Re-fit every page. Cheap enough to call on a settled turn, a resize, or a
 * change of reading dial — a session holds a handful of pages, and each test
 * is two forced layouts.
 */
export function fitAll(deck: HTMLElement, allow = true): Record<Fit, number> {
  const tally: Record<Fit, number> = { single: 0, columns: 0, scroll: 0 };
  for (const panel of deck.querySelectorAll<HTMLElement>(".panel")) {
    const sheet = panel.querySelector<HTMLElement>(".sheet");
    const doc = panel.querySelector<HTMLElement>(".doc");
    if (sheet && doc) tally[fitPage(sheet, doc, allow)]++;
  }
  return tally;
}
