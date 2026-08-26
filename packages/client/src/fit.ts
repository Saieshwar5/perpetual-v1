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
 * Re-fit every page — as ONE decision about the site, not six about pages.
 *
 * The per-page version produced a website whose pages had different shapes: in
 * a real six-page session, five pages were one 864px column and the sixth was
 * two columns at 1334px. Each verdict was individually correct and the result
 * looked broken, because whether a page "fits" is a property of the reader's
 * WINDOW — its height, their text size, the exact block mix — and not of the
 * site. Nothing the reader could see explained why one page was different, and
 * resizing the window could flip it back.
 *
 * The rule, and the strict half is the important one:
 *
 *   no page overflows                    -> single everywhere, nothing to fix
 *   EVERY page overflows AND fits in two -> columns everywhere
 *   anything else                        -> single everywhere
 *
 * It has to be EVERY, twice over. A page that scrolls IN two columns is the
 * exact failure columns exist to avoid — read down the left, scroll back up,
 * read down the right — so one page that cannot be rescued sends the whole
 * site back to one column. And a page that already fits in one column would be
 * split into two half-empty ones, which looks like a mistake, so a single
 * short page also keeps the site single. The bias is toward the layout that is
 * never wrong.
 */
export function fitAll(deck: HTMLElement, allow = true): Record<Fit, number> {
  const panels: { sheet: HTMLElement; doc: HTMLElement }[] = [];
  for (const panel of deck.querySelectorAll<HTMLElement>(".panel")) {
    const sheet = panel.querySelector<HTMLElement>(".sheet");
    const doc = panel.querySelector<HTMLElement>(".doc");
    if (sheet && doc) panels.push({ sheet, doc });
  }

  // Measure first, decide once, then apply. Applying as we measure is how the
  // per-page version ended up unable to see the site at all.
  const seen = panels.map(({ sheet, doc }) => probePage(sheet, doc, allow));
  const columnsEverywhere = allow
    && seen.length > 0
    && seen.every((f) => f.fit === "columns");

  const tally: Record<Fit, number> = { single: 0, columns: 0, scroll: 0 };
  for (const [i, { sheet, doc }] of panels.entries()) {
    const verdict = columnsEverywhere ? "columns" : applySingle(sheet, doc);
    if (columnsEverywhere) {
      sheet.classList.add("fits");
      doc.classList.add("cols-2");
    }
    tally[verdict]++;
    void seen[i];
  }
  return tally;
}

/** Lay a page out in one column, and say whether it needed to scroll. */
function applySingle(sheet: HTMLElement, doc: HTMLElement): Fit {
  doc.classList.remove("cols-2");
  sheet.classList.add("fits");
  if (sheet.scrollHeight > sheet.clientHeight + 1) {
    sheet.classList.remove("fits");
    return "scroll";
  }
  return "single";
}
