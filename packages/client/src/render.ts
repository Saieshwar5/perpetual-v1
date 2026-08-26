/**
 * The block renderer — the component library.
 *
 * The agent supplies data; this supplies the implementation. That division is
 * what makes a chart correct and a page unbreakable: the agent chooses WHAT to
 * say, never HOW it is drawn, so page 007 looks like it belongs beside page
 * 002 without anyone having to enforce consistency.
 */
import { INLINE_SPLIT_RE } from "@perpetual/shared/blocks";
import type { Block } from "@perpetual/shared/blocks";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * The whole inline vocabulary: `**bold**` and `` `code` ``. Everything else
 * stays literal text.
 *
 * Three marks, because the model uses three jobs and they are not
 * interchangeable: **bold** NAMES a term, a unit or a step label; *italic*
 * STRESSES a word inside a sentence; `code` marks an identifier or a value.
 *
 * Italics were left out of the first version on the theory that bold covered
 * emphasis. Four real pages later the model had reached for them four times
 * and the reader was seeing raw asterisks. The lesson generalises: decide this
 * kind of thing by running it, not by reasoning about it.
 */
function inline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  // One definition, shared with the validator — see INLINE_SPLIT_RE. A local
  // copy would drift, and then the guard and the renderer would disagree.
  for (const part of text.split(INLINE_SPLIT_RE)) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      frag.append(el("strong", undefined, part.slice(2, -2)));
    } else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      frag.append(el("code", "tok", part.slice(1, -1)));
    } else if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      frag.append(el("em", undefined, part.slice(1, -1)));
    } else {
      frag.append(document.createTextNode(part));
    }
  }
  return frag;
}

/** What a block can ask the app to do when the reader clicks it. */
export interface BlockActions {
  link?: (page: string) => void;
  next?: (question: string) => void;
  /** The page a door already produced, if it has been walked through. */
  answered?: (question: string) => string | null;
}

/**
 * Render one block, and stamp its name onto the node when it has one.
 *
 * The stamp is what lets everything else address a block without counting:
 * the ops from a keyed page find their node by name, and a held anchor
 * re-resolves through it after the agent has moved things around. One place
 * does it, so no case in the switch below has to remember to.
 */
export function renderBlock(b: Block, on: BlockActions = {}): HTMLElement {
  const node = buildBlock(b, on);
  if (b.id) node.dataset.blockId = b.id;
  return node;
}

function buildBlock(b: Block, on: BlockActions = {}): HTMLElement {
  switch (b.kind) {
    case "heading":
      return el("h1", undefined, b.text);

    case "section":
      return el("h2", undefined, b.text);

    case "prose": {
      const p = el("p");
      p.append(inline(b.text));
      return p;
    }

    case "quote":
      return el("blockquote", undefined, b.text);

    case "list": {
      const ul = el("ul");
      for (const item of b.items) {
        const li = el("li");
        li.append(inline(item));
        ul.append(li);
      }
      return ul;
    }

    case "code": {
      const pre = el("pre", "code");
      pre.append(el("code", undefined, b.text));
      if (b.lang) pre.dataset.lang = b.lang;
      return pre;
    }

    case "note": {
      const n = el("div", `note ${b.tone === "warn" ? "warn" : "info"}`);
      n.append(inline(b.text));
      return n;
    }

    case "link": {
      const a = el("button", "pagelink", b.text ?? b.page);
      a.type = "button";
      a.addEventListener("click", () => on.link?.(b.page));
      return a;
    }

    case "metrics": {
      const wrap = el("div", "metrics");
      for (const m of b.items) {
        const card = el("div", m.emphasis ? "metric up" : "metric");
        card.append(el("span", "v", m.value), el("span", "k", m.label));
        wrap.append(card);
      }
      return wrap;
    }

    case "chart": {
      const wrap = el("figure", "chartwrap");
      const c = el("div", "chart");
      const max = Math.max(...b.values, 1);
      b.values.forEach((v, i) => {
        const col = el("div", "col");
        const bar = el("i", b.highlight?.includes(i) ? "hi" : undefined);
        bar.style.height = `${Math.max(2, Math.round((v / max) * 100))}%`;
        bar.title = `${b.labels?.[i] ?? i + 1}: ${v}`;
        col.append(bar);
        if (b.labels?.[i]) col.append(el("span", "cl", b.labels[i]));
        c.append(col);
      });
      wrap.append(c);
      if (b.caption) wrap.append(el("figcaption", undefined, b.caption));
      return wrap;
    }

    case "table": {
      // The frame and the scroller are two elements on purpose: whatever scrolls
      // clips its own descendants, and the block's gutter mark sits outside it.
      const frame = el("div", "tablewrap");
      const scroll = el("div", "tscroll");
      const t = el("table");
      const hr = el("tr");
      for (const h of b.headers) hr.append(el("th", undefined, h));
      t.append(hr);
      for (const row of b.rows) {
        const tr = el("tr");
        for (const cell of row) tr.append(el("td", undefined, cell));
        t.append(tr);
      }
      scroll.append(t);
      frame.append(scroll);
      return frame;
    }

    case "split": {
      const s = el("div", "split");
      for (const panel of b.panels) {
        const box = el("div", "pane");
        const body = el("p");
        body.append(inline(panel.text));
        box.append(el("h4", undefined, panel.title), body);
        s.append(box);
      }
      return s;
    }

    case "next": {
      // One fork, not a menu. Taking a branch closes the others: the site is a
      // single ordered sequence, and one page spawning three siblings would
      // put three unrelated tangents in a row.
      const wrap = el("nav", "next");
      wrap.setAttribute("aria-label", "Questions this page leaves open");
      const forkTaken = b.items.some((q) => on.answered?.(q));

      for (const q of b.items) {
        const built = on.answered?.(q) ?? null;
        const row = el("button", "nextq", q);
        row.type = "button";

        if (built) {
          // The room exists now, so the door leads to it instead of asking again.
          row.classList.add("taken");
          row.title = "Go to the page this opened";
          row.addEventListener("click", () => on.link?.(built));
        } else if (forkTaken) {
          // Context, and a record of the fork: what else this page opened onto,
          // and which way you went.
          row.classList.add("spent");
          row.disabled = true;
        } else {
          row.addEventListener("click", () => on.next?.(q));
        }
        wrap.append(row);
      }
      return wrap;
    }

    case "figure": {
      const fig = el("figure", "figure");
      const holder = el("div", "svgwrap");
      // innerHTML with a single, narrow provenance: this string was produced
      // by the controller's sanitiser, which does not filter the agent's
      // markup but REBUILDS it from an allowlist. Nothing else may be assigned
      // here, and the agent has no other path to markup on this page.
      holder.innerHTML = b.svg ?? "";
      const label = b.alt ?? b.caption;
      if (label) { holder.setAttribute("role", "img"); holder.setAttribute("aria-label", label); }
      fig.append(holder);
      if (b.caption) fig.append(el("figcaption", undefined, b.caption));
      return fig;
    }

    case "flow": {
      const f = el("div", "flow");
      b.steps.forEach((step, i) => {
        if (i) f.append(el("span", "to", "→"));
        f.append(el("div", step.warn ? "step warn" : "step", step.label));
      });
      return f;
    }
  }
}

/** The staggered entry from plans/07 §5 — one block, as it lands. */
export function appendBlock(
  host: HTMLElement, block: Block, on: BlockActions = {},
): HTMLElement {
  const node = renderBlock(block, on);
  host.append(node);
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.animate(
      [{ opacity: 0, transform: "translateY(7px) scale(.985)" }, { opacity: 1, transform: "none" }],
      { duration: 200, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" },
    );
  }
  return node;
}
