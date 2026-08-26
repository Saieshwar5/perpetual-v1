/**
 * The block vocabulary — the contract between the agent and the renderer.
 *
 * The agent does not call a tool to emit these. It WRITES them, one JSON
 * object per line, into `ui/pages/NNN-slug/page.ndjson`, using the same shell
 * it uses for everything else. So this file has two jobs:
 *
 *   1. describe the shapes (for the renderer, in types)
 *   2. VERIFY them, with a message good enough to hand back to the agent
 *
 * Job 2 is why the validator is hand-written rather than a schema library.
 * "line 4: metrics.items[1].label is missing" is a repair instruction; a
 * TypeBox union error is a puzzle. The agent reads these and fixes its own
 * file on the next command, so the wording is load-bearing.
 *
 * Deliberately dependency-free: the client bundles these types, and the
 * controller needs the validator, and neither should drag pi-ai along.
 */

export interface Heading { kind: "heading"; text: string }
/**
 * A break in a long explanation. plans/17 §B1.
 *
 * The first real model run put FOUR `heading` blocks on one page — the page's
 * claim, then three section breaks — because the vocabulary had one word for
 * two jobs. It was right to want the distinction; we had not given it one.
 */
export interface Section { kind: "section"; text: string }
export interface Prose { kind: "prose"; text: string }
export interface Quote { kind: "quote"; text: string }
export interface List { kind: "list"; items: string[] }
export interface Metrics {
  kind: "metrics";
  items: { value: string; label: string; emphasis?: boolean }[];
}
export interface Chart {
  kind: "chart";
  values: number[];
  labels?: string[];
  highlight?: number[];
  caption?: string;
}
export interface Table { kind: "table"; headers: string[]; rows: string[][] }
export interface Split { kind: "split"; panels: { title: string; text: string }[] }
export interface Flow { kind: "flow"; steps: { label: string; warn?: boolean }[] }
export interface Code { kind: "code"; text: string; lang?: string }
export interface Note { kind: "note"; text: string; tone?: "info" | "warn" }
/** A link to another page in this site. The target is verified on read. */
export interface Link { kind: "link"; page: string; text?: string }

/**
 * Doors the reader did not know were there.
 *
 * `link` points at a room that exists; `next` points at one the agent would
 * build if asked. The difference from a chat's suggested-questions widget is
 * that these are not rephrasings of what was just asked — they are questions
 * the PAGE raised, which the reader had no way to know were worth asking,
 * because the agent has just read the subject and they have not.
 */
export interface Next { kind: "next"; items: string[] }

/**
 * A drawing. Tier 3. plans/16 §3.
 *
 * The agent writes `src` — an SVG file beside page.ndjson — and never `svg`.
 * The controller reads that file, rebuilds it through the sanitiser, and fills
 * `svg` in on the way to the client, which inlines it. The agent cannot put
 * markup on the wire directly, by construction.
 */
export interface Figure {
  kind: "figure";
  /** A `.svg` filename in this page's own directory. No paths. */
  src: string;
  caption?: string;
  alt?: string;
  /** Filled in by the controller. Sanitised markup, safe to inline. */
  svg?: string;
}

export type Block =
  | Heading | Section | Prose | Quote | List | Metrics | Chart
  | Table | Split | Flow | Code | Note | Link | Figure | Next;

export type BlockKind = Block["kind"];

export const BLOCK_KINDS: readonly BlockKind[] = [
  "heading", "section", "prose", "quote", "list", "metrics", "chart",
  "table", "split", "flow", "code", "note", "link", "figure", "next",
];

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

/* ------------------------------------------------------- inline vocabulary */

/**
 * The whole of it: `**bold**`, `*italic*`, `` `code` ``.
 *
 * Three marks because the model demonstrably uses three jobs. From four real
 * pages: 14 bolds, 4 italics, 2 codes — and bold/italic were never
 * interchangeable. Bold NAMES (a term, a unit, a step label); italic STRESSES
 * a word inside a sentence. Shipping only bold, as we first did, meant the
 * reader saw literal asterisks four times in four pages.
 */
export const CODE_RE = /`[^`]+`/;
export const BOLD_RE = /\*\*[^*]+\*\*/;
// The closing `*` must be preceded by a non-space, as in CommonMark. Without
// that, "This *never closes and 3 * 4" parses as one long italic span — the
// reader gets silently mis-rendered text instead of a diagnostic.
export const ITALIC_RE = /(?<!\*)\*[^*\s](?:[^*]*[^*\s])?\*(?!\*)/;

/**
 * The splitter the renderer uses. Exported so there is exactly one definition
 * of the inline vocabulary: a copy in the client would drift from the guard,
 * and then the checker and the renderer would disagree about the same text.
 * Bold is first in the alternation so `**x**` is never read as italic.
 */
export const INLINE_SPLIT_RE = new RegExp(
  `(${BOLD_RE.source}|${CODE_RE.source}|${ITALIC_RE.source})`, "g",
);

/** Kinds whose text is rendered through the inline vocabulary. */
export const INLINE_KINDS: ReadonlySet<string> = new Set(["prose", "note", "list", "split"]);

/**
 * Markup the reader would see as literal punctuation.
 *
 * Nothing used to notice this. A mark we do not honour rendered as raw
 * asterisks and only a human reading the page ever found out — which is
 * exactly how four stray italics reached a live page. The method is to remove
 * everything we DO honour and complain about what is left that still looks
 * like markup.
 *
 * @param honoured whether this field runs through the inline vocabulary at all
 */
export function checkMarkup(text: string, honoured: boolean): string | null {
  if (!text) return null;

  // Anything inside backticks is literal on purpose; scan around it.
  const bare = text.replace(new RegExp(CODE_RE.source, "g"), " ");

  if (!honoured) {
    if (CODE_RE.test(text) || BOLD_RE.test(bare) || ITALIC_RE.test(bare)) {
      return "inline marks are not rendered here — the reader sees the asterisks " +
             "or backticks literally. Write it plain, or move the emphasis into a " +
             "`prose` block.";
    }
    return null;
  }

  const rest = bare
    .replace(new RegExp(BOLD_RE.source, "g"), " ")
    .replace(new RegExp(ITALIC_RE.source, "g"), " ");

  if (/\[[^\]]+\]\([^)]+\)/.test(rest)) {
    return "that looks like a markdown link, which is not rendered. To point at " +
           "another page use a `link` block; there is nothing else to link to.";
  }
  if (/~~/.test(rest)) return "`~~strikethrough~~` is not rendered. Say it in words instead.";
  if (/<\/?(b|i|em|strong|br|p|a|span|div|h[1-6])\b/i.test(rest)) {
    return "HTML is not rendered in text — the reader sees the tags. Use " +
           "`**bold**`, `*italic*` or `` `code` ``.";
  }
  if (/(^|\s)_[^_\s][^_]*_(\s|$|[.,;:!?])/.test(rest)) {
    return "`_underscores_` are not rendered. Use `*italic*` for stress.";
  }
  if (/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s)/.test(rest)) {
    return "markdown structure (headings, bullets) is not rendered inside a block. " +
           "Use a `section` block for a break, or a `list` block for items.";
  }
  // Only an asterisk that is TOUCHING a word reads as an attempted mark.
  // A free-standing one is arithmetic or a footnote — "3 * 4" is not markup,
  // and a guard that says it is would be worse than no guard at all.
  if (/\*\S|\S\*/.test(rest)) {
    return "an unpaired `*`. Emphasis is `*italic*` or `**bold**`, both closed on " +
           "the same line — an odd asterisk reaches the reader as punctuation.";
  }
  if (/`\S|\S`/.test(rest)) {
    return "an unpaired backtick. Code is `` `like this` ``, closed on the same line.";
  }
  return null;
}

/** Every text the reader will actually read, with whether marks work there. */
export function textFields(b: Block): { where: string; text: string; honoured: boolean }[] {
  const out: { where: string; text: string; honoured: boolean }[] = [];
  const honoured = INLINE_KINDS.has(b.kind);
  switch (b.kind) {
    case "heading": case "section": case "prose": case "quote": case "note":
      out.push({ where: b.kind, text: b.text, honoured });
      break;
    case "list":
      b.items.forEach((t, i) => out.push({ where: `items[${i}]`, text: t, honoured }));
      break;
    case "next":
      // Clickable questions, rendered as plain text — a mark here would reach
      // the reader as punctuation inside a button.
      b.items.forEach((t, i) => out.push({ where: `items[${i}]`, text: t, honoured: false }));
      break;
    case "split":
      b.panels.forEach((pn, i) => {
        out.push({ where: `panels[${i}].title`, text: pn.title, honoured: false });
        out.push({ where: `panels[${i}].text`, text: pn.text, honoured });
      });
      break;
    case "flow":
      b.steps.forEach((st, i) => out.push({ where: `steps[${i}]`, text: st.label, honoured: false }));
      break;
    case "chart": case "figure":
      if (b.caption) out.push({ where: "caption", text: b.caption, honoured: false });
      break;
    // code is literal by definition; table cells and metric labels are data.
    default: break;
  }
  return out;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/**
 * Validate one parsed NDJSON line.
 *
 * Unknown *optional* fields are tolerated on purpose: an agent that adds
 * `"note": "..."` to a prose block has made a page that still renders, and
 * rejecting it would trade a working page for a lecture. Everything the
 * renderer actually reads is checked strictly.
 */
export function validateBlock(v: unknown): Valid<Block> {
  if (!isRec(v)) return { ok: false, error: "not a JSON object" };
  const kind = v.kind;
  if (typeof kind !== "string") return { ok: false, error: "missing `kind`" };
  if (!(BLOCK_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `unknown kind "${kind}" (valid: ${BLOCK_KINDS.join(", ")})` };
  }

  const bad = (m: string): Valid<Block> => ({ ok: false, error: `${kind}: ${m}` });

  switch (kind as BlockKind) {
    case "heading":
    case "section":
    case "prose":
    case "quote":
      if (!str(v.text)) return bad("`text` must be a non-empty string");
      break;

    case "code":
      if (typeof v.text !== "string" || v.text.length === 0) {
        return bad("`text` must be a non-empty string");
      }
      break;

    case "note":
      if (!str(v.text)) return bad("`text` must be a non-empty string");
      if (v.tone != null && v.tone !== "info" && v.tone !== "warn") {
        return bad('`tone` must be "info" or "warn"');
      }
      break;

    case "link":
      if (!str(v.page)) return bad("`page` must be the id of another page, e.g. \"002-costs\"");
      break;

    case "next": {
      if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > 5) {
        return bad("`items` must hold 1 to 5 questions (two or three is usually right)");
      }
      for (const [i, q] of v.items.entries()) {
        if (!str(q)) return bad(`items[${i}] is empty`);
        if ((q as string).length > 160) {
          return bad(`items[${i}] is ${(q as string).length} characters. Each one is a ` +
            "question the reader will click, not a paragraph — keep it to a line.");
        }
      }
      break;
    }

    case "figure": {
      if (!str(v.src)) return bad('`src` must name an .svg file beside page.ndjson, e.g. "flow.svg"');
      const src = v.src as string;
      // A page owns its figures. Confining the name here means the resolver
      // never has to reason about traversal at all.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/.test(src)) {
        return bad(`\`src\` is "${src}" — it must be a plain .svg filename in this page's ` +
          "own directory. No slashes, no `..`, no absolute paths.");
      }
      break;
    }

    case "list":
      if (!Array.isArray(v.items) || v.items.length < 2) return bad("`items` needs at least 2 entries");
      if (!v.items.every(str)) return bad("every entry in `items` must be a non-empty string");
      break;

    case "metrics": {
      if (!Array.isArray(v.items) || v.items.length < 2 || v.items.length > 4) {
        return bad("`items` must hold 2 to 4 entries");
      }
      for (const [i, m] of v.items.entries()) {
        if (!isRec(m)) return bad(`items[${i}] is not an object`);
        if (!str(m.value)) return bad(`items[${i}].value is missing (the number, as text)`);
        if (!str(m.label)) return bad(`items[${i}].label is missing (what it measures)`);
      }
      break;
    }

    case "chart": {
      if (!Array.isArray(v.values) || v.values.length < 3) return bad("`values` needs at least 3 numbers");
      if (!v.values.every((n) => typeof n === "number" && Number.isFinite(n))) {
        return bad("`values` must be finite numbers, not strings");
      }
      if (v.labels != null && (!Array.isArray(v.labels) || !v.labels.every(str))) {
        return bad("`labels` must be an array of strings");
      }
      break;
    }

    case "table": {
      if (!Array.isArray(v.headers) || v.headers.length < 2) return bad("`headers` needs at least 2 columns");
      if (!v.headers.every(str)) return bad("every header must be a non-empty string");
      if (!Array.isArray(v.rows) || v.rows.length === 0) return bad("`rows` is empty");
      for (const [i, r] of v.rows.entries()) {
        if (!Array.isArray(r)) return bad(`rows[${i}] is not an array`);
        if (r.length !== v.headers.length) {
          return bad(`rows[${i}] has ${r.length} cells but there are ${v.headers.length} headers`);
        }
        if (!r.every((c) => typeof c === "string")) return bad(`rows[${i}] must hold strings — quote numbers`);
      }
      break;
    }

    case "split": {
      if (!Array.isArray(v.panels) || v.panels.length !== 2) return bad("`panels` must hold exactly 2 entries");
      for (const [i, p] of v.panels.entries()) {
        if (!isRec(p) || !str(p.title) || !str(p.text)) {
          return bad(`panels[${i}] needs both \`title\` and \`text\``);
        }
      }
      break;
    }

    case "flow": {
      if (!Array.isArray(v.steps) || v.steps.length < 2 || v.steps.length > 6) {
        return bad("`steps` must hold 2 to 6 entries");
      }
      for (const [i, s] of v.steps.entries()) {
        if (!isRec(s) || !str(s.label)) return bad(`steps[${i}].label is missing`);
      }
      break;
    }
  }

  return { ok: true, value: v as unknown as Block };
}
