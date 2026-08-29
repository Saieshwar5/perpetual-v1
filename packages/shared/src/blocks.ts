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

/**
 * The one field every block may carry: a name for itself.
 *
 * Without it a block's only name is its POSITION, and position is a name that
 * changes when anything above it changes. That is the ceiling on everything
 * interactive: the watcher can only express "one block changed, count
 * identical" — an insert, a delete or a reorder collapses to "throw the page
 * away and rebuild it", the reader loses their place, and a held anchor points
 * at whatever slid into the slot. Doors already worked around this by keying
 * their taken-state on the question TEXT, because there was no key.
 *
 * So: an optional, agent-chosen, stable name. Blocks that have one can be
 * updated, moved, removed and pointed at BY NAME. It is the same primitive
 * every UI framework converged on independently — a key on a list item.
 *
 * Optional, and all-or-nothing per page (see `site.ts`): a page where every
 * block is named is reconciled by name, and a page with any unnamed block
 * behaves exactly as it always has. Nothing existing breaks; the agent opts
 * in one page at a time.
 */
export interface BlockBase {
  /** Lowercase, digits and dashes: `margin-trend`. Unique within its page. */
  id?: string;
  /**
   * How wide this block is, in twelfths of the page. plans/39.
   *
   * The one field that turns a stack into a LAYOUT. Every block was full
   * width, always, so a page could only ever be a column — which is the shape
   * of a document, and the reason twelve good blocks still read as an essay.
   * Three blocks at `span: 4` sit side by side; two at `span: 6` split the
   * page in half; anything without a span stays full width, as before.
   *
   * NOT nesting, deliberately. A container block would have to be closed
   * before it could be drawn, and pages here are appended one line at a time
   * and rendered as they land — the reader watches the page assemble. A hint
   * on a flat block keeps one line meaning one finished thing, so streaming,
   * `page set <id>`, and the read-only seal all keep working untouched.
   *
   * The agent chooses the ARRANGEMENT; the stylesheet still chooses every
   * pixel. `span: 4` says "one third"; what one third looks like is not the
   * agent's business, which is what keeps a thousand sessions looking like one
   * product.
   */
  span?: number;
  /**
   * What this block REPLACES, as `<page>/<block-id>`.
   *
   * The agent cannot unwrite a published section, so a correction is a new
   * block that says what it corrects. Nothing is edited: the original stays on
   * the page, exactly as written, and the reader is shown that it was revised
   * and where the revision is. That is strictly more information than an edit
   * left behind, because an edit destroys the fact that the first answer was
   * wrong.
   */
  supersedes?: string;
}

export interface Heading extends BlockBase { kind: "heading"; text: string }
/**
 * A break in a long explanation. plans/17 §B1.
 *
 * The first real model run put FOUR `heading` blocks on one page — the page's
 * claim, then three section breaks — because the vocabulary had one word for
 * two jobs. It was right to want the distinction; we had not given it one.
 */
export interface Section extends BlockBase { kind: "section"; text: string }
export interface Prose extends BlockBase { kind: "prose"; text: string }
export interface Quote extends BlockBase { kind: "quote"; text: string }
export interface List extends BlockBase { kind: "list"; items: string[] }
export interface Metrics extends BlockBase {
  kind: "metrics";
  items: { value: string; label: string; emphasis?: boolean }[];
}
export interface Chart extends BlockBase {
  kind: "chart";
  values: number[];
  labels?: string[];
  highlight?: number[];
  caption?: string;
}
export interface Table extends BlockBase { kind: "table"; headers: string[]; rows: string[][] }
export interface Split extends BlockBase { kind: "split"; panels: { title: string; text: string }[] }
export interface Flow extends BlockBase { kind: "flow"; steps: { label: string; warn?: boolean }[] }
export interface Code extends BlockBase { kind: "code"; text: string; lang?: string }
export interface Note extends BlockBase { kind: "note"; text: string; tone?: "info" | "warn" }
/** A link to another page in this site. The target is verified on read. */
export interface Link extends BlockBase { kind: "link"; page: string; text?: string }

/**
 * Doors the reader did not know were there.
 *
 * `link` points at a room that exists; `next` points at one the agent would
 * build if asked. The difference from a chat's suggested-questions widget is
 * that these are not rephrasings of what was just asked — they are questions
 * the PAGE raised, which the reader had no way to know were worth asking,
 * because the agent has just read the subject and they have not.
 */
export interface Next extends BlockBase { kind: "next"; items: string[] }

/**
 * A question the agent asks the reader, answered by TOUCH.
 *
 * The other half of the loop. Everything the agent says is structured — one
 * validated object per line — and everything the reader said back was a
 * sentence, which the agent then had to parse to find out which of the three
 * files it had just listed was meant. `choice` removes the parsing: the agent
 * writes the options and gets back the `id` it wrote itself. The ambiguity is
 * gone by construction rather than by prompting.
 *
 * Not the same thing as `next`, and the difference is worth keeping:
 *
 *   `next`   — questions the PAGE raises. Taking one forks the site: a new
 *              page gets written, and the siblings become the record of it.
 *   `choice` — a question the AGENT raises because it cannot proceed without
 *              an answer. Taking one usually continues the work in place.
 *
 * They share the channel (a Selection) and nothing else.
 */
export interface Choice extends BlockBase {
  kind: "choice";
  /** What is being asked. One line: "Which report did you mean?" */
  prompt: string;
  /**
   * More than one option may be right — "delete which of these?".
   *
   * The reader toggles any number and confirms once, and the answer arrives
   * as the picked ids joined with commas, in the order the options were
   * written. One string, so the whole single-pick channel — the record, the
   * Selection, the repaint after reload — carries it without knowing the
   * difference.
   */
  multi?: boolean;
  /** Multi only: what the confirming button says. "Delete these", "Compare them". */
  submit?: string;
  options: {
    /** The agent's own token. It comes back verbatim; it never has to be parsed. */
    id: string;
    label: string;
    /** The line under the label — the metadata a person actually decides by. */
    hint?: string;
    /**
     * A command to run when this option is picked — WORKSPACES ONLY.
     *
     * Without it, picking an option asks the agent, and a model turn is three
     * seconds and a fraction of a cent. That is the right price for a
     * question and a ridiculous one for opening a file you can already see:
     * twenty clicks browsing a list would be twenty turns.
     *
     * So a workspace row can carry the command its own click runs. The
     * controller executes it in the same sandbox, rewrites the view, and no
     * model is involved — the agent builds the app, and the app runs without
     * it. The model comes back only when something needs judgement.
     *
     * Ignored on a page: a section is a record, and a record does not act.
     */
    run?: string;
  }[];
}

/**
 * A drawing. Tier 3. plans/16 §3.
 *
 * The agent writes `src` — an SVG file beside page.ndjson — and never `svg`.
 * The controller reads that file, rebuilds it through the sanitiser, and fills
 * `svg` in on the way to the client, which inlines it. The agent cannot put
 * markup on the wire directly, by construction.
 */
export interface Figure extends BlockBase {
  kind: "figure";
  /** A `.svg` filename in this page's own directory. No paths. */
  src: string;
  caption?: string;
  alt?: string;
  /** Filled in by the controller. Sanitised markup, safe to inline. */
  svg?: string;
}

/**
 * A picture. The one thing a `figure` cannot be.
 *
 * `figure` is SVG and only SVG, because SVG is markup and markup has to be
 * sanitised before it can be inlined. A photograph, a screenshot, a page of a
 * PDF rendered to PNG — none of those are markup, and none of them could be
 * shown at all. "Show me what this looks like" is too ordinary an ask to have
 * no answer.
 *
 * Never inlined. The bytes stay a file beside `page.ndjson` and the client
 * fetches them from the controller by name, so a large picture costs one
 * request rather than a megabyte of base64 in every event that mentions it.
 */
export interface Image extends BlockBase {
  kind: "image";
  /** An image filename in this page's own directory. No paths. */
  src: string;
  /** What it shows, for anyone who cannot see it. */
  alt?: string;
  caption?: string;
}

/**
 * ASKING FOR A DIRECTORY — the one block whose button is not the agent's.
 *
 * A session writes in its own workspace and nowhere else. When the work
 * genuinely needs somewhere on the reader's disk — "rename the resumes where
 * they actually live" — the agent does not get it by asking in prose and
 * hoping, and it certainly does not get it silently. It writes one of these:
 * the path, and why.
 *
 * What makes it safe is where the ANSWER goes. Every other block's click is
 * handed to the agent to interpret. This one's is not: Allow is chrome, wired
 * to a controller endpoint the agent cannot reach, exactly like the workspace
 * picker it extends. So the agent can request access and can never grant
 * itself any — the same shape as the seal, where the rule lives somewhere the
 * agent has no reach rather than somewhere it is asked to respect.
 */
export interface Grant extends BlockBase {
  kind: "grant";
  /** An absolute path, or one under `~`. Held to the home directory. */
  path: string;
  /** Why this work needs it. The reader is deciding, so give them the case. */
  reason: string;
}

/* ------------------------------------------------------ the app quartet */

/**
 * Four shapes, and between them they are nearly every app screen ever built:
 *
 *   a LIST of things  ->  the DETAIL of one  ->  a FORM to change it  ->  a
 *   CONFIRMATION before it happens
 *
 * Apps differ in what they hold, not in how they are shaped: an inbox, a file
 * list, search results, an order history and a day's agenda are the same
 * screen with different contents. So these are four blocks rather than one per
 * app, and the test for a fifth is whether it would serve three unrelated
 * ones.
 *
 * WORKSPACES ONLY. A page is a record, and a record does not act — a button on
 * a sealed section is either a lie or a hole in the seal. The site reader
 * rejects them, by name, with the reason.
 */

/**
 * The list primitive.
 *
 * `choice` was doing this job and it is the wrong tool: a choice is a
 * QUESTION — it has a prompt, it stops at eight options because more than
 * eight is a search problem, and answering it is recorded as an answer. An
 * inbox is not a question, thirty messages is normal, and a row needs more
 * than one thing you can do to it.
 */
export interface Rows extends BlockBase {
  kind: "rows";
  /** Required: an action has to say which list it came from. */
  id: string;
  /**
   * Put a box above the list that narrows it as the reader types.
   *
   * Entirely the client's doing — no command, no turn, no cost — because
   * "which of these says «margin»" is a question the reader's own eyes are
   * already asking and the answer is sitting in the DOM. Worth having on any
   * list long enough to scroll; noise on a list of three.
   */
  filter?: boolean;
  items: {
    id: string;
    title: string;
    /** The line under it — sender, path, size, date. What people scan. */
    meta?: string;
    /** One line of the thing itself: a subject line, the first line of a file. */
    note?: string;
    /** A small, fixed vocabulary. Anything freer becomes decoration. */
    state?: "unread" | "done" | "warn";
    /** What picking the row itself does. Without it, picking asks the agent. */
    run?: string;
    /** Up to three, beside the row: Archive, Delete, Open. */
    actions?: { id: string; label: string; run?: string }[];
  }[];
}

/** The detail primitive: the key/value header every detail view opens with. */
export interface Fields extends BlockBase {
  kind: "fields";
  items: { label: string; value: string }[];
}

/**
 * The one that turns a workspace from something you read into something you
 * use. Without it there is no reply, no rename, no filter, no quantity.
 *
 * The values reach the command as ENVIRONMENT, never as text spliced into it.
 * A row's command is written by the agent and carries exactly the agent's own
 * authority; a form's values are written by the READER, and interpolating
 * those into a shell string would make a text field into a shell.
 */
export interface Form extends BlockBase {
  kind: "form";
  id: string;
  /** What the button says. "Send", "Rename", "Search". */
  submit?: string;
  /** What submitting runs. Without it, submitting asks the agent instead. */
  run?: string;
  fields: {
    id: string;
    label: string;
    type: "text" | "textarea" | "select" | "number" | "checkbox" | "date";
    /** Pre-filled, because the agent usually knows most of the answer. */
    value?: string;
    placeholder?: string;
    /** `select` only. */
    options?: { value: string; label: string }[];
    /** `textarea` only: how tall it starts. */
    rows?: number;
    required?: boolean;
  }[];
}

/**
 * The gate. Reads are cheap and writes are gated (plans/21 §4): anything
 * outward-facing or irreversible goes behind one of these.
 *
 * `detail` is the load-bearing field — it says exactly what is about to
 * happen, which is the difference between consent and a habit of clicking yes.
 */
export interface Confirm extends BlockBase {
  kind: "confirm";
  id: string;
  prompt: string;
  detail?: string;
  /** The button that does it. Never pre-focused, in the renderer. */
  confirm?: string;
  cancel?: string;
  run?: string;
}

/**
 * A bounded box holding one idea. plans/39.
 *
 * The block that makes `span` worth having. Three paragraphs side by side are
 * three paragraphs; three CARDS side by side are a comparison you can take in
 * at a glance, because the border is what tells the eye where one thing ends
 * and the next begins.
 *
 * `title` is optional because a card is sometimes just a bounded remark. When
 * it has one it is two or three words — a label, not a sentence. The body
 * takes the same three inline marks as prose.
 */
export interface Card extends BlockBase {
  kind: "card";
  title?: string;
  text: string;
  /** `accent` for the one that matters, `warn` for the one that bites. */
  tone?: "plain" | "accent" | "warn";
}

/**
 * One number, big, with what it measures and which way it is going. plans/39.
 *
 * `metrics` already shows two to four numbers as a fixed row — it is one
 * block, and it decides its own arrangement. A `stat` is a single number that
 * takes a `span` like anything else, so it can sit beside a chart, share a
 * row with two others, or run four across. The difference is who arranges
 * them: `metrics` does it for you, `stat` lets the agent compose.
 *
 * `delta` and `trend` are the interface half. A number alone is a fact; a
 * number with a direction is information, and it is the thing a reader looks
 * for first on any screen that reports on something.
 */
export interface Stat extends BlockBase {
  kind: "stat";
  /** The number, as text — "34%", "$4.2M", "9:1". Formatting is the agent's. */
  value: string;
  /** What it measures. Two or three words. */
  label: string;
  /** The movement, in the agent's own words: "+6 since Q2", "down from 41%". */
  delta?: string;
  /** Which way that movement points. Colour comes from here, never from the text. */
  trend?: "up" | "down" | "flat";
}

export type Block =
  | Heading | Section | Prose | Quote | List | Metrics | Chart
  | Table | Split | Flow | Code | Note | Link | Figure | Image | Next | Choice
  | Card | Stat | Grant
  | Rows | Fields | Form | Confirm;

export type BlockKind = Block["kind"];

export const BLOCK_KINDS: readonly BlockKind[] = [
  "heading", "section", "prose", "quote", "list", "metrics", "chart",
  "table", "split", "flow", "code", "note", "link", "figure", "image",
  "next", "choice", "card", "stat", "grant",
  "rows", "fields", "form", "confirm",
];

/** What an `image` may be. Raster only — markup goes through `figure`, sanitised. */
export const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp|avif)$/i;

/** How many columns a page is divided into. Twelve, because it halves, thirds and quarters. */
export const SPAN_COLUMNS = 12;

/** The four that only mean anything in a workspace. See the quartet above. */
export const APP_KINDS: readonly BlockKind[] = ["rows", "fields", "form", "confirm"];

/** A list, not a scroll of a thousand. Past this, narrow it or paginate. */
export const MAX_ROWS = 50;

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Every block, in one line and one example.
 *
 * This exists so the vocabulary can be PRINTED — `pnpm blocks` writes
 * docs/ui-elements.md from it — and a printed reference that is written by
 * hand is wrong three pull requests later. We added four kinds and two fields
 * in two days; a copy of the list somewhere else would already be stale.
 *
 * Kept beside the validator on purpose, and a test asserts that every kind has
 * an entry: adding a block without saying what it is fails the suite rather
 * than quietly shipping an undocumented one.
 */
export interface BlockDoc {
  /** What it is FOR, in one sentence. Not what it looks like. */
  purpose: string;
  /** A real one, valid against the validator below. */
  example: string;
  /** The limits that are checked, in the reader's words. */
  limits?: string;
  /** Where it may appear. Absent means anywhere. */
  only?: "workspace";
}

export const BLOCK_DOCS: Record<BlockKind, BlockDoc> = {
  heading: {
    purpose: "The page's claim — the one sentence the rest of it has to earn.",
    example: '{"kind":"heading","text":"A wing flies by throwing air downwards"}',
    limits: "Exactly one per page, and it is the first block.",
  },
  section: {
    purpose: "A break inside a long explanation. A movement, not a second headline.",
    example: '{"kind":"section","text":"It is compression, not friction"}',
  },
  prose: {
    purpose: "A paragraph. The default, not the fallback — most answers are these.",
    example: '{"kind":"prose","text":"Lift is the reaction to a **mass of air** pushed down."}',
    limits: "Three inline marks and no others: **bold**, *italic*, `code`.",
  },
  quote: {
    purpose: "One sentence pulled out because it carries the point.",
    example: '{"kind":"quote","text":"Pilots call it the coffin corner."}',
  },
  list: {
    purpose: "Short items that belong together and have no second dimension.",
    example: '{"kind":"list","items":["Speed, which sets how much air arrives","Angle"]}',
    limits: "2 or more items.",
  },
  code: {
    purpose: "Literal text — a command, a file, an exact value. Nothing inside is interpreted.",
    example: '{"kind":"code","text":"npm run build","lang":"bash"}',
  },
  note: {
    purpose: "The caveat or the gotcha, set aside from the argument.",
    example: '{"kind":"note","text":"Q2 is provisional.","tone":"warn"}',
    limits: "`tone` is `info` or `warn`.",
  },
  link: {
    purpose: "A jump to another section. Rarely needed in one scroll.",
    example: '{"kind":"link","page":"002-costs","text":"Cost breakdown"}',
  },
  metrics: {
    purpose: "Real numbers worth reading on their own, not a restatement of the prose.",
    example: '{"kind":"metrics","items":[{"value":"$4.2M","label":"ARR","emphasis":true},'
      + '{"value":"18%","label":"Growth"}]}',
    limits: "2 to 4 items; values are strings, so the agent controls the formatting.",
  },
  chart: {
    purpose: "A trend or comparison where the SHAPE of the numbers is the argument.",
    example: '{"kind":"chart","values":[3,7,12,9],"labels":["Q1","Q2","Q3","Q4"],'
      + '"highlight":[2],"caption":"Margin by quarter"}',
    limits: "3 or more values. Two numbers are a comparison, not a shape.",
  },
  table: {
    purpose: "Genuinely two-dimensional data. If one column would do, use a list.",
    example: '{"kind":"table","headers":["Altitude","Drag"],"rows":[["Low","High"]]}',
    limits: "Every cell a string.",
  },
  split: {
    purpose: "A real contrast: before and after, option A against option B.",
    example: '{"kind":"split","panels":[{"title":"Before","text":"…"},'
      + '{"title":"After","text":"…"}]}',
    limits: "Exactly 2 panels. A third makes it a table.",
  },
  flow: {
    purpose: "An ordered sequence where the order carries the meaning.",
    example: '{"kind":"flow","steps":[{"label":"SYN"},{"label":"ACK","warn":true}]}',
    limits: "2 to 6 steps.",
  },
  figure: {
    purpose: "A drawing, when a relationship is spatial and prose cannot say it.",
    example: '{"kind":"figure","src":"election.svg","caption":"Timeout promotes a follower"}',
    limits: "An SVG the agent writes beside the page. A viewBox is required, no width or "
      + "height, and no colour may be named — only currentColor and the palette tokens.",
  },
  card: {
    purpose: "A bounded box holding one idea, so several can sit side by side and be "
      + "compared at a glance.",
    example: '{"kind":"card","span":4,"title":"Intake","text":"The piston falls and '
      + 'the inlet valve opens."}',
    limits: "`tone` is \"plain\", \"accent\" or \"warn\". Give it a `span` — a card at "
      + "full width is a note with a border.",
  },
  stat: {
    purpose: "One number, large, with what it measures and which way it is moving.",
    example: '{"kind":"stat","span":3,"value":"9:1","label":"Compression ratio",'
      + '"delta":"vs 17:1 for diesel","trend":"flat"}',
    limits: "`trend` is \"up\", \"down\" or \"flat\" and decides the colour. For two to "
      + "four numbers you are not arranging yourself, `metrics` is less work.",
  },
  next: {
    purpose: "The questions this page opened and did not answer. Clicking one asks it.",
    example: '{"kind":"next","items":["Why does gasoline stop at 9:1?"]}',
    limits: "1 to 5, at most one per page, and it is the last block.",
  },
  image: {
    purpose: "A picture: a photograph, a screenshot, a rendered page.",
    example: '{"kind":"image","src":"page-1.png","alt":"The first page of the resume",'
      + '"caption":"Rendered from the PDF"}',
    limits: "A .png/.jpg/.gif/.webp/.avif file beside page.ndjson. A drawing you " +
      "generated as SVG is a `figure`.",
  },
  grant: {
    purpose: "Ask the reader for write access to one directory.",
    example: '{"kind":"grant","path":"~/Documents","reason":"to rename the resumes '
      + 'where they actually live"}',
    limits: "One directory, absolute or under `~`. The reader decides — you cannot " +
      "grant yourself anything.",
  },
  choice: {
    purpose: "A question the agent cannot proceed without an answer to.",
    example: '{"kind":"choice","id":"which-file","prompt":"Which one did you mean?",'
      + '"options":[{"id":"a","label":"report-2025.pdf","hint":"~/Documents · 2.1 MB"},'
      + '{"id":"b","label":"report-final.pdf","hint":"~/Downloads · yesterday"}]}',
    limits: "2 to 8 options, `id` required. The hint is what people decide by. " +
      "`\"multi\":true` lets several be picked at once; the answer returns as the " +
      "ids joined with commas.",
  },
  rows: {
    purpose: "The list you scan and act on: an inbox, a file list, search results.",
    example: '{"kind":"rows","id":"inbox","items":[{"id":"m1","title":"Invoice #4821",'
      + '"meta":"Acme · yesterday","state":"unread","run":"mail show 4821",'
      + '"actions":[{"id":"arch","label":"Archive","run":"mail archive 4821"}]}]}',
    limits: "Up to 50 rows, `state` is unread/done/warn, at most 3 actions each.",
    only: "workspace",
  },
  fields: {
    purpose: "The key/value header a detail view opens with.",
    example: '{"kind":"fields","items":[{"label":"From","value":"Acme"},'
      + '{"label":"Received","value":"Tuesday 14:02"}]}',
    limits: "1 to 12 pairs. More than a dozen facts is the detail itself.",
    only: "workspace",
  },
  form: {
    purpose: "Inputs the reader fills and submits — the block that makes a workspace act.",
    example: '{"kind":"form","id":"reply","submit":"Send","run":"mail reply 4821",'
      + '"fields":[{"id":"to","label":"To","type":"text","value":"a@b.c"},'
      + '{"id":"body","label":"Message","type":"textarea","rows":6}]}',
    limits: "1 to 10 fields; types text, textarea, select, number, checkbox, date. Values "
      + "reach the command as $FIELD_<ID> environment variables — never write them into it.",
    only: "workspace",
  },
  confirm: {
    purpose: "The gate before anything irreversible or outward-facing.",
    example: '{"kind":"confirm","id":"send","prompt":"Send this reply?",'
      + '"detail":"84 words to billing@acme.com","confirm":"Send","run":"mail send draft"}',
    limits: "`detail` says exactly what is about to happen.",
    only: "workspace",
  },
};

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
    case "choice":
      out.push({ where: "prompt", text: b.prompt, honoured: false });
      if (b.submit) out.push({ where: "submit", text: b.submit, honoured: false });
      b.options.forEach((o, i) => {
        out.push({ where: `options[${i}].label`, text: o.label, honoured: false });
        if (o.hint) out.push({ where: `options[${i}].hint`, text: o.hint, honoured: false });
      });
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
    // The quartet's text is all labels and values: read for stray markup, but
    // never given marks of its own. A row title with an asterisk in it is a
    // filename, not emphasis.
    case "rows":
      b.items.forEach((it, i) => {
        out.push({ where: `items[${i}].title`, text: it.title, honoured: false });
        if (it.meta) out.push({ where: `items[${i}].meta`, text: it.meta, honoured: false });
        if (it.note) out.push({ where: `items[${i}].note`, text: it.note, honoured: false });
      });
      break;
    case "fields":
      b.items.forEach((it, i) => {
        out.push({ where: `items[${i}].label`, text: it.label, honoured: false });
        out.push({ where: `items[${i}].value`, text: it.value, honoured: false });
      });
      break;
    case "form":
      b.fields.forEach((f, i) => out.push({ where: `fields[${i}].label`, text: f.label, honoured: false }));
      break;
    case "confirm":
      out.push({ where: "prompt", text: b.prompt, honoured: false });
      if (b.detail) out.push({ where: "detail", text: b.detail, honoured: false });
      break;
    case "chart": case "figure": case "image":
      if (b.caption) out.push({ where: "caption", text: b.caption, honoured: false });
      break;
    case "grant":
      out.push({ where: "reason", text: b.reason, honoured: false });
      break;
    case "card":
      // The body takes the inline marks; the title does not, for the same
      // reason a heading does not — a label is already emphatic.
      out.push({ where: "text", text: b.text, honoured: true });
      if (b.title) out.push({ where: "title", text: b.title, honoured: false });
      break;
    case "stat":
      out.push({ where: "label", text: b.label, honoured: false });
      if (b.delta) out.push({ where: "delta", text: b.delta, honoured: false });
      break;
    // code is literal by definition; table cells and metric labels are data.
    default: break;
  }
  return out;
}

/**
 * How long a workspace row's command may be.
 *
 * Generous enough for a real command with paths and flags, short enough that
 * a view file cannot become a program. Anything longer is a script, and a
 * script belongs in the workspace directory where it can be read.
 */
export const MAX_RUN = 400;

/** See BlockBase. Kept beside the validator so the rule has one definition. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * `<page>/<block-id>` — see BlockBase.supersedes.
 *
 * Only the SHAPE is checked here. Whether the page and the block exist is a
 * property of the whole site, so it is checked where the site is read.
 */
export const REF_RE = /^[0-9]{3}-[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]{0,39}$/;

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

  // A name has to be usable as one: readable in a diff, typeable in a prompt,
  // safe as a DOM attribute. Uniqueness is a property of the PAGE, so it is
  // checked where the page is read, not here.
  if (v.id != null) {
    if (typeof v.id !== "string" || !ID_RE.test(v.id)) {
      return bad(`\`id\` is ${JSON.stringify(v.id)}. An id is lowercase letters, ` +
        "digits and dashes, starting with a letter or digit, up to 40 characters — " +
        '`margin-trend`, `step-2`. It is a name you can refer to later.');
    }
  }

  // Checked here rather than per-kind because it applies to every block. An
  // out-of-range span is a layout that silently does not happen, so it is
  // worth a sentence that says what the number means.
  if (v.span != null) {
    if (typeof v.span !== "number" || !Number.isInteger(v.span)
        || v.span < 1 || v.span > SPAN_COLUMNS) {
      return bad(`\`span\` is ${JSON.stringify(v.span)}. It is how many of ` +
        `${SPAN_COLUMNS} columns this block fills — a whole number from 1 to ` +
        `${SPAN_COLUMNS}. Three blocks at 4 sit side by side; two at 6 split ` +
        "the page. Leave it out for full width.");
    }
  }

  if (v.supersedes != null) {
    if (typeof v.supersedes !== "string" || !REF_RE.test(v.supersedes)) {
      return bad(`\`supersedes\` is ${JSON.stringify(v.supersedes)}. It names the block ` +
        "this one replaces, as `<page>/<block-id>` — `002-cruise-altitude/burn`. " +
        "The block it names must have an id.");
    }
  }

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
      const asked = new Set<string>();
      for (const [i, q] of v.items.entries()) {
        if (!str(q)) return bad(`items[${i}] is empty`);
        if (asked.has(q as string)) {
          return bad(`items[${i}] repeats the question on items[${[...asked].indexOf(q as string)}]. ` +
            "A door is identified by its question, so two identical ones are one door " +
            "the reader can click twice.");
        }
        asked.add(q as string);
        if ((q as string).length > 160) {
          return bad(`items[${i}] is ${(q as string).length} characters. Each one is a ` +
            "question the reader will click, not a paragraph — keep it to a line.");
        }
      }
      break;
    }

    case "choice": {
      // The only block that REQUIRES a name. When the reader picks an option,
      // the answer has to say which control it came from — and a position
      // cannot say that: it changes the moment anything above it does.
      if (!str(v.id)) {
        return bad("needs an `id`. It is the one block the reader answers, so it has " +
          'to have a name the answer can carry: {"kind":"choice","id":"which-report",…}');
      }
      if (!str(v.prompt)) {
        return bad("`prompt` must say what is being asked, in one line — " +
          '"Which report did you mean?"');
      }
      if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > 8) {
        // One option is not a choice, and nine is a search problem: the reader
        // cannot hold nine things in mind, so a long list wants narrowing
        // first — which is what the prompt is for.
        return bad("`options` must hold 2 to 8 entries. One is not a choice; more than " +
          "eight is a list the reader has to search, so narrow it first.");
      }
      if (v.multi != null && typeof v.multi !== "boolean") {
        return bad("`multi` is `true` or absent. It says several options may be picked " +
          "together; it is not a count or a mode name.");
      }
      if (v.submit != null) {
        if (!v.multi) {
          return bad("`submit` only means something on a multi choice: it is the button " +
            "that confirms several picks at once. A single pick needs no button.");
        }
        if (!str(v.submit)) {
          return bad('`submit` must be the confirming button\'s label — "Delete these".');
        }
      }
      const seen = new Set<string>();
      for (const [i, o] of v.options.entries()) {
        if (!isRec(o)) return bad(`options[${i}] is not an object`);
        if (!str(o.id) || !ID_RE.test(o.id as string)) {
          return bad(`options[${i}].id must be a short name — lowercase letters, digits ` +
            "and dashes. It is what comes back when the reader picks this one, so you " +
            "never have to work out which option they meant.");
        }
        if (seen.has(o.id as string)) {
          return bad(`options[${i}].id "${o.id}" is used twice. Two options that answer ` +
            "to the same name cannot be told apart.");
        }
        seen.add(o.id as string);
        if (!str(o.label)) return bad(`options[${i}].label is missing (what the reader reads)`);
        if (o.hint != null && !str(o.hint)) return bad(`options[${i}].hint is empty — omit it instead`);
        if (o.run != null) {
          if (v.multi) {
            // Several commands fired by one confirmation is not a thing the
            // reader agreed to option by option. Per-item actions are `rows`.
            return bad(`options[${i}].run cannot sit on a multi choice: the picks are ` +
              "confirmed together and reach you as one answer. When each item needs " +
              "its own command, that is `rows`.");
          }
          if (!str(o.run) || (o.run as string).length > MAX_RUN) {
            return bad(`options[${i}].run must be a shell command under ${MAX_RUN} ` +
              "characters. It is what this row does when it is picked, and it runs in " +
              "your sandbox exactly as if you had run it yourself.");
          }
        }
      }
      break;
    }

    /* ------------------------------------------------ the app quartet */

    case "rows": {
      if (v.filter != null && typeof v.filter !== "boolean") {
        return bad("`filter` is `true` or absent. It puts a box above the list that " +
          "narrows it as the reader types.");
      }
      if (!str(v.id)) {
        return bad('needs an `id`: a row\'s action has to say which list it came ' +
          'from. {"kind":"rows","id":"inbox",…}');
      }
      if (!Array.isArray(v.items) || v.items.length === 0) {
        return bad("`items` must hold at least one row.");
      }
      if (v.items.length > MAX_ROWS) {
        return bad(`${v.items.length} rows is more than a list (max ${MAX_ROWS}). ` +
          "Narrow it, or make one row the way to see the rest.");
      }
      const rowIds = new Set<string>();
      for (const [i, it] of v.items.entries()) {
        if (!isRec(it)) return bad(`items[${i}] is not an object`);
        if (!str(it.id) || !ID_RE.test(it.id as string)) {
          return bad(`items[${i}].id must be a short name — lowercase letters, digits ` +
            "and dashes. It is what comes back when this row is picked.");
        }
        if (rowIds.has(it.id as string)) {
          return bad(`items[${i}].id "${it.id}" is used twice. Two rows that answer to ` +
            "the same name cannot be told apart.");
        }
        rowIds.add(it.id as string);
        if (!str(it.title)) return bad(`items[${i}].title is missing (what the reader reads)`);
        for (const f of ["meta", "note"] as const) {
          if (it[f] != null && !str(it[f])) return bad(`items[${i}].${f} is empty — omit it`);
        }
        if (it.state != null && !["unread", "done", "warn"].includes(it.state as string)) {
          return bad(`items[${i}].state is ${JSON.stringify(it.state)}. It is one of ` +
            "`unread`, `done`, `warn` — a small fixed set, so a state means the same " +
            "thing everywhere.");
        }
        if (it.run != null && (!str(it.run) || (it.run as string).length > MAX_RUN)) {
          return bad(`items[${i}].run must be a command under ${MAX_RUN} characters`);
        }
        if (it.actions != null) {
          if (!Array.isArray(it.actions) || it.actions.length > 3) {
            return bad(`items[${i}].actions holds at most 3. More than three things ` +
              "beside a row is a menu, and a menu belongs on the detail screen.");
          }
          const actIds = new Set<string>();
          for (const [j, a] of it.actions.entries()) {
            if (!isRec(a)) return bad(`items[${i}].actions[${j}] is not an object`);
            if (!str(a.id) || !ID_RE.test(a.id as string)) {
              return bad(`items[${i}].actions[${j}].id must be a short name`);
            }
            if (actIds.has(a.id as string)) {
              return bad(`items[${i}].actions[${j}].id "${a.id}" is used twice on one row`);
            }
            actIds.add(a.id as string);
            if (!str(a.label)) return bad(`items[${i}].actions[${j}].label is missing`);
            if (a.run != null && (!str(a.run) || (a.run as string).length > MAX_RUN)) {
              return bad(`items[${i}].actions[${j}].run must be a command under ${MAX_RUN}`);
            }
          }
        }
      }
      break;
    }

    case "fields": {
      if (!Array.isArray(v.items) || v.items.length === 0 || v.items.length > 12) {
        return bad("`items` must hold 1 to 12 label/value pairs. This is the header of " +
          "a detail view — more than a dozen facts is the detail itself, which is prose " +
          "or a table.");
      }
      for (const [i, it] of v.items.entries()) {
        if (!isRec(it)) return bad(`items[${i}] is not an object`);
        if (!str(it.label)) return bad(`items[${i}].label is missing`);
        if (!str(it.value)) return bad(`items[${i}].value is missing`);
      }
      break;
    }

    case "form": {
      if (!str(v.id)) return bad('needs an `id`: {"kind":"form","id":"reply",…}');
      if (!Array.isArray(v.fields) || v.fields.length === 0 || v.fields.length > 10) {
        return bad("`fields` must hold 1 to 10 inputs. A form longer than ten is a " +
          "questionnaire — ask for what you need now and ask again later.");
      }
      if (v.submit != null && !str(v.submit)) return bad("`submit` is empty — omit it");
      if (v.run != null && (!str(v.run) || (v.run as string).length > MAX_RUN)) {
        return bad(`\`run\` must be a command under ${MAX_RUN} characters. The values ` +
          "reach it as environment variables named after the fields — do not write them " +
          "into the command yourself.");
      }
      const fieldIds = new Set<string>();
      for (const [i, f] of v.fields.entries()) {
        if (!isRec(f)) return bad(`fields[${i}] is not an object`);
        if (!str(f.id) || !ID_RE.test(f.id as string)) {
          return bad(`fields[${i}].id must be a short name — it names the value on the ` +
            "way to your command.");
        }
        if (fieldIds.has(f.id as string)) {
          return bad(`fields[${i}].id "${f.id}" is used twice`);
        }
        fieldIds.add(f.id as string);
        if (!str(f.label)) return bad(`fields[${i}].label is missing`);
        const types = ["text", "textarea", "select", "number", "checkbox", "date"];
        if (!str(f.type) || !types.includes(f.type as string)) {
          return bad(`fields[${i}].type is ${JSON.stringify(f.type)}. One of: ${
            types.join(", ")}.`);
        }
        if (f.type === "select") {
          if (!Array.isArray(f.options) || f.options.length < 2) {
            return bad(`fields[${i}] is a select and needs 2 or more \`options\`, each ` +
              '{"value":…,"label":…}.');
          }
          for (const [j, o] of f.options.entries()) {
            if (!isRec(o) || !str(o.value) || !str(o.label)) {
              return bad(`fields[${i}].options[${j}] needs a value and a label`);
            }
          }
        }
      }
      break;
    }

    case "confirm": {
      if (!str(v.id)) return bad('needs an `id`: {"kind":"confirm","id":"send",…}');
      if (!str(v.prompt)) {
        return bad("`prompt` must ask the question in one line — " +
          '"Send this reply to billing@acme.com?"');
      }
      if (v.detail != null && !str(v.detail)) {
        return bad("`detail` is empty — omit it. It is what says exactly what is about " +
          "to happen, which is the difference between consent and a habit of saying yes.");
      }
      for (const f of ["confirm", "cancel"] as const) {
        if (v[f] != null && !str(v[f])) return bad(`\`${f}\` is empty — omit it`);
      }
      if (v.run != null && (!str(v.run) || (v.run as string).length > MAX_RUN)) {
        return bad(`\`run\` must be a command under ${MAX_RUN} characters`);
      }
      break;
    }

    case "card":
      if (!str(v.text)) {
        return bad("`text` must be a non-empty string — it is what the card says");
      }
      if (v.title != null && !str(v.title)) {
        return bad("`title` is empty — omit it. A card without a title is fine; " +
          "one with an empty heading is a gap the reader has to explain to themselves");
      }
      if (v.tone != null && !["plain", "accent", "warn"].includes(v.tone as string)) {
        return bad('`tone` must be "plain", "accent" or "warn"');
      }
      break;

    case "stat":
      if (!str(v.value)) {
        return bad('`value` is the number, written as text — "34%", "$4.2M", "9:1". ' +
          "You choose the formatting; nothing downstream reformats it.");
      }
      if (!str(v.label)) return bad("`label` must say what the number measures");
      if (v.delta != null && !str(v.delta)) {
        return bad("`delta` is empty — omit it. It is the movement in words: " +
          '"+6 since Q2"');
      }
      if (v.trend != null && !["up", "down", "flat"].includes(v.trend as string)) {
        return bad('`trend` must be "up", "down" or "flat" — it is which way `delta` ' +
          "points, and it is where the colour comes from");
      }
      break;

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

    case "image": {
      if (!str(v.src)) {
        return bad('`src` must name an image file beside page.ndjson, e.g. "shot.png"');
      }
      if (!IMAGE_RE.test(v.src as string)) {
        return bad(`\`src\` is "${v.src}" — it must be a plain .png, .jpg, .gif, .webp ` +
          "or .avif filename in this page's own directory. No slashes, no `..`, no " +
          "absolute paths. A drawing you generated as SVG is a `figure`, not an `image`.");
      }
      if (v.alt != null && !str(v.alt)) return bad("`alt` is empty — omit it instead");
      if (v.caption != null && !str(v.caption)) return bad("`caption` is empty — omit it instead");
      break;
    }

    case "grant": {
      if (!str(v.path)) {
        return bad('`path` must be the directory you need, e.g. "~/Documents". ' +
          "One directory, named exactly.");
      }
      const path = v.path as string;
      if (!path.startsWith("/") && !path.startsWith("~")) {
        return bad(`\`path\` is "${path}" — it must be absolute or start with \`~\`. ` +
          "The reader is deciding about a real place on their disk, so name it in full.");
      }
      if (path.includes("..")) return bad("`path` cannot contain `..` — name the directory itself.");
      if (!str(v.reason)) {
        return bad("`reason` must say what you would do with it, in one line — the reader " +
          "is being asked to widen what you can change, and they decide on the reason.");
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
