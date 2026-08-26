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
