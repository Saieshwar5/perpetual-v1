/**
 * The block renderer — the component library.
 *
 * The agent supplies data; this supplies the implementation. That division is
 * what makes a chart correct and a page unbreakable: the agent chooses WHAT to
 * say, never HOW it is drawn, so page 007 looks like it belongs beside page
 * 002 without anyone having to enforce consistency.
 */
import { INLINE_SPLIT_RE } from "@perpetual/shared/blocks";
import type { Block, Choice, Form } from "@perpetual/shared/blocks";

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
  /** The option already picked on this choice, if the reader has answered it. */
  picked?: (blockId: string) => string | null;
  /** The reader picked one. The click carries the option's own id, not its words. */
  choose?: (block: Choice, option: { id: string; label: string }) => void;

  /* --------------------------------------------------- the app quartet */

  /**
   * A row, a row's action, or a confirmation was taken.
   *
   * `option` is the token that goes back: a row id, `row.action` for one of
   * the buttons beside it, or `confirm` for a confirmation's yes. The renderer
   * builds the token and nothing downstream has to parse a label.
   */
  act?: (blockId: string, option: string, label: string) => void;
  /** A form was submitted, with what the reader typed into it. */
  submit?: (blockId: string, values: Record<string, string | boolean>) => void;

  /* ----------------------------------------------------- pictures, access */

  /**
   * Where the bytes of a picture live. The caller knows which page or
   * workspace it is rendering; this block only knows a filename.
   */
  asset?: (src: string) => string;
  /** The reader allowed a directory. Goes to the controller, never the agent. */
  allow?: (path: string) => void;
  /** Has this path already been allowed? Then the block is a record, not a question. */
  granted?: (path: string) => boolean;
}

/**
 * Render one block, and stamp its name onto the node when it has one.
 *
 * The stamp is what lets everything else address a block without counting:
 * the ops from a keyed page find their node by name, and a held anchor
 * re-resolves through it after the agent has moved things around. One place
 * does it, so no case in the switch below has to remember to.
 */
/** One input, built from its declared type. Six types, and no others. */
function fieldInput(formId: string, f: Form["fields"][number]): HTMLElement {
  const id = `f-${formId}-${f.id}`;
  if (f.type === "textarea") {
    const t = document.createElement("textarea");
    t.id = id;
    t.rows = Math.min(Math.max(2, f.rows ?? 4), 16);
    if (f.value) t.value = f.value;
    if (f.placeholder) t.placeholder = f.placeholder;
    if (f.required) t.required = true;
    return t;
  }
  if (f.type === "select") {
    const sel = document.createElement("select");
    sel.id = id;
    for (const o of f.options ?? []) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (f.value === o.value) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  }
  const i = document.createElement("input");
  i.id = id;
  i.type = f.type === "checkbox" ? "checkbox" : f.type === "number" ? "number"
    : f.type === "date" ? "date" : "text";
  if (f.type === "checkbox") i.checked = f.value === "1" || f.value === "true";
  else if (f.value) i.value = f.value;
  if (f.placeholder) i.placeholder = f.placeholder;
  if (f.required) i.required = true;
  return i;
}

export function renderBlock(b: Block, on: BlockActions = {}): HTMLElement {
  const node = buildBlock(b, on);
  if (b.id) node.dataset.blockId = b.id;
  // What this block replaces, carried on the node so the site can be marked up
  // in one pass afterwards. The marking cannot happen here: the block it names
  // usually lives in another section, which may not be rendered yet.
  if (b.supersedes) node.dataset.supersedes = b.supersedes;
  // How wide, in twelfths. A data attribute rather than an inline style: the
  // stylesheet decides what four twelfths looks like, and at what width it
  // stops meaning anything and everything goes back to one column. The agent
  // supplies the arrangement; it never supplies a pixel. plans/39.
  if (b.span) node.dataset.span = String(b.span);
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

    /* ------------------------------------------------ the layout pair */

    case "card": {
      // A bordered box, and the border is the whole point: it is what tells
      // the eye where one idea stops and the next starts, which is what makes
      // three of them side by side readable as a comparison rather than as
      // three paragraphs that happen to be short.
      const c = el("div", `card${b.tone && b.tone !== "plain" ? ` ${b.tone}` : ""}`);
      if (b.title) c.append(el("h3", "cardt", b.title));
      const body = el("p", "cardb");
      body.append(inline(b.text));
      c.append(body);
      return c;
    }

    case "stat": {
      const s = el("div", `stat${b.trend ? ` ${b.trend}` : ""}`);
      s.append(el("span", "v", b.value), el("span", "k", b.label));
      // The arrow comes from `trend`, never from the words — an agent writing
      // "▲ +6%" into `delta` would be styling, and styling is not its job.
      if (b.delta) {
        const d = el("span", "d");
        if (b.trend && b.trend !== "flat") {
          d.append(el("i", "arrow", b.trend === "up" ? "↑" : "↓"));
        }
        d.append(document.createTextNode(b.delta));
        s.append(d);
      }
      return s;
    }

    case "chart": {
      const wrap = el("figure", "chartwrap");
      const c = el("div", "chart");
      // Transitions are enabled one frame AFTER the bars have their heights,
      // so the first paint is static and only a later data change animates.
      // See `.chart.settled` — this is the other half of that rule.
      requestAnimationFrame(() => c.classList.add("settled"));
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

    case "choice": {
      // The reader answers by touching one. The three states are the ones a
      // door already has — open, taken, and the siblings it closed — because a
      // decision, once made, should stay on the page as the record of it.
      //
      // A MULTI choice answers with several: tapping toggles, and one button
      // confirms. The answer is the picked ids joined with commas — a single
      // string, so everything downstream of here (the record, the Selection,
      // the repaint after reload) carries it without knowing the difference.
      const wrap = el("div", "choice");
      const answeredWith = b.id ? on.picked?.(b.id) ?? null : null;
      const taken = new Set(answeredWith ? answeredWith.split(",") : []);
      wrap.append(el("p", "cprompt", b.prompt));

      const opts = el("div", "copts");
      const picked = new Set<string>();
      let go: HTMLButtonElement | null = null;

      for (const o of b.options) {
        const btn = el("button", "copt");
        btn.type = "button";
        btn.append(el("span", "clabel", o.label));
        if (o.hint) btn.append(el("span", "chint", o.hint));

        if (taken.has(o.id)) {
          btn.classList.add("taken");
          btn.disabled = true;
        } else if (answeredWith) {
          btn.classList.add("spent");
          btn.disabled = true;
        } else if (b.multi) {
          // Toggling is free — nothing leaves the page until the confirm.
          btn.setAttribute("aria-pressed", "false");
          btn.addEventListener("click", () => {
            const now = !picked.has(o.id);
            picked[now ? "add" : "delete"](o.id);
            btn.classList.toggle("picked", now);
            btn.setAttribute("aria-pressed", String(now));
            if (go) go.disabled = picked.size === 0;
          });
        } else {
          btn.addEventListener("click", () => on.choose?.(b, { id: o.id, label: o.label }));
        }
        opts.append(btn);
      }
      wrap.append(opts);

      if (b.multi && !answeredWith) {
        go = el("button", "cgo");
        go.type = "button";
        go.disabled = true;
        go.textContent = b.submit ?? "These ones";
        go.addEventListener("click", () => {
          // In the order the options were WRITTEN, not the order they were
          // tapped — the agent wrote the list and reads the answer against it.
          const sel = b.options.filter((o) => picked.has(o.id));
          if (!sel.length) return;
          on.choose?.(b, {
            id: sel.map((o) => o.id).join(","),
            label: sel.map((o) => o.label).join(", "),
          });
        });
        wrap.append(go);
      }
      return wrap;
    }

    /* ------------------------------------------------ the app quartet */

    case "rows": {
      // A list you scan and act on, not a question you answer. The row itself
      // is the primary action; anything beside it is secondary and looks it.
      const wrap = el("div", "rows");
      const rows: { row: HTMLElement; hay: string }[] = [];
      for (const it of b.items) {
        const row = el("div", `row${it.state ? ` is-${it.state}` : ""}`);
        rows.push({ row, hay: `${it.title} ${it.meta ?? ""} ${it.note ?? ""}`.toLowerCase() });
        const main = el("button", "rowmain");
        main.type = "button";
        main.append(el("span", "rowtitle", it.title));
        if (it.meta) main.append(el("span", "rowmeta", it.meta));
        if (it.note) main.append(el("span", "rownote", it.note));
        main.addEventListener("click", () => on.act?.(b.id, it.id, it.title));
        row.append(main);

        if (it.actions?.length) {
          const acts = el("div", "rowacts");
          for (const a of it.actions) {
            const btn = el("button", "rowact");
            btn.type = "button";
            btn.textContent = a.label;
            btn.addEventListener("click", (e) => {
              e.stopPropagation();          // the row's own action is not this one
              on.act?.(b.id, `${it.id}.${a.id}`, a.label);
            });
            acts.append(btn);
          }
          row.append(acts);
        }
        wrap.append(row);
      }

      // Narrowing a long list is the reader's own eyes, done faster. No
      // command, no turn, no cost — every row is already here, so hiding the
      // ones that do not match is the whole of it.
      if (!b.filter) return wrap;
      const box = el("div", "rowsfilter");
      const input = document.createElement("input");
      input.type = "search";
      input.placeholder = `Filter ${b.items.length} rows…`;
      input.setAttribute("aria-label", "Filter this list");
      const count = el("span", "rowscount");
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        for (const { row, hay } of rows) {
          const hit = !q || hay.includes(q);
          row.hidden = !hit;
          if (hit) shown++;
        }
        count.textContent = q && shown !== rows.length ? `${shown} of ${rows.length}` : "";
      });
      box.append(input, count);
      const outer = el("div", "rowsbox");
      outer.append(box, wrap);
      return outer;
    }

    case "fields": {
      const dl = el("dl", "fields");
      for (const f of b.items) {
        dl.append(el("dt", undefined, f.label));
        dl.append(el("dd", undefined, f.value));
      }
      return dl;
    }

    case "form": {
      const form = document.createElement("form");
      form.className = "appform";
      for (const f of b.fields) {
        const row = el("div", "frow");
        const label = el("label", "flabel", f.label);
        label.htmlFor = `f-${b.id}-${f.id}`;
        row.append(label);
        row.append(fieldInput(b.id, f));
        form.append(row);
      }
      const submit = el("button", "fsubmit", b.submit ?? "Submit");
      (submit as HTMLButtonElement).type = "submit";
      form.append(submit);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const values: Record<string, string | boolean> = {};
        for (const f of b.fields) {
          const node = form.querySelector<HTMLInputElement | HTMLTextAreaElement
            | HTMLSelectElement>(`#f-${CSS.escape(b.id)}-${CSS.escape(f.id)}`);
          if (!node) continue;
          values[f.id] = f.type === "checkbox"
            ? (node as HTMLInputElement).checked
            : node.value;
        }
        on.submit?.(b.id, values);
      });
      return form;
    }

    case "confirm": {
      // The dangerous one is never the default. `detail` says exactly what is
      // about to happen, which is the difference between consent and a habit
      // of saying yes — so it is shown, not tucked away.
      const wrap = el("div", "confirm");
      wrap.append(el("p", "cprompt", b.prompt));
      if (b.detail) wrap.append(el("p", "cdetail", b.detail));
      const acts = el("div", "cacts");
      const no = el("button", "cno", b.cancel ?? "Not yet");
      (no as HTMLButtonElement).type = "button";
      no.addEventListener("click", () => on.act?.(b.id, "cancel", b.cancel ?? "Not yet"));
      const yes = el("button", "cyes", b.confirm ?? "Confirm");
      (yes as HTMLButtonElement).type = "button";
      yes.addEventListener("click", () => on.act?.(b.id, "confirm", b.confirm ?? "Confirm"));
      acts.append(no, yes);
      wrap.append(acts);
      return wrap;
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

    case "image": {
      const fig = el("figure", "figure image");
      const img = document.createElement("img");
      // The controller serves it by name out of the page's own directory. The
      // agent never puts bytes or a URL on the wire — only a filename that had
      // to look like one to get this far.
      img.src = on.asset?.(b.src) ?? "";
      img.alt = b.alt ?? b.caption ?? "";
      img.loading = "lazy";
      // A picture whose file is missing is a broken icon and a mystery. Say so.
      img.addEventListener("error", () => {
        img.replaceWith(el("div", "imggone", `${b.src} is not in this page's directory`));
      });
      fig.append(img);
      if (b.caption) fig.append(el("figcaption", undefined, b.caption));
      return fig;
    }

    case "grant": {
      // The agent asks; the CHROME answers. `allow` goes to a controller
      // endpoint nothing in the sandbox can reach, so this block can request
      // access and can never grant any.
      const wrap = el("div", "grant");
      const done = on.granted?.(b.path) ?? false;
      wrap.append(el("p", "gpath", b.path));
      wrap.append(el("p", "greason", b.reason));

      const acts = el("div", "gacts");
      if (done) {
        wrap.classList.add("allowed");
        acts.append(el("span", "gdone", "Allowed for this session"));
      } else {
        const yes = el("button", "gyes");
        yes.type = "button";
        yes.textContent = "Allow";
        yes.addEventListener("click", () => on.allow?.(b.path));
        const no = el("button", "gno");
        no.type = "button";
        no.textContent = "Not now";
        no.addEventListener("click", () => {
          // Declining is local and quiet: nothing is granted, nobody is asked,
          // and the reader is not made to explain themselves to a machine.
          wrap.classList.add("declined");
          acts.replaceChildren(el("span", "gdone", "Not allowed"));
        });
        acts.append(yes, no);
      }
      wrap.append(acts);
      return wrap;
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
  // The grid is opt-in per page, and this is the one place that turns it on —
  // which is why it lives here rather than in the two callers. A page becomes
  // a grid the moment its FIRST spanned block lands, including mid-stream, so
  // a section that starts as prose and later lays out three cards does not
  // have to be re-rendered to get its columns. plans/39.
  if (block.span) host.classList.add("spans");
  host.append(node);
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.animate(
      [{ opacity: 0, transform: "translateY(7px) scale(.985)" }, { opacity: 1, transform: "none" }],
      { duration: 200, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" },
    );
  }
  return node;
}
