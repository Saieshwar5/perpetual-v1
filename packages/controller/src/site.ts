/**
 * Reading — and verifying — the website the agent wrote.
 *
 * There is no tool schema between the agent and the page any more: it writes
 * files with the same shell it does everything else with. So the forcing
 * function moves here, to the READ side, and it works in three layers
 * (plans/15, and the rules the system prompt teaches):
 *
 *   teach     the system prompt states the rules
 *   verify    this file checks every page on every read, and the diagnostics
 *             it produces are handed straight back to the agent as tool output
 *   enforce   nothing that fails validation reaches the browser
 *
 * The middle layer is the interesting one. A problem here is not an error to
 * log — it is a repair instruction the agent reads on its next command and
 * acts on. That is why `message` is written as prose aimed at the agent.
 *
 * THE PARTIAL-LINE RULE. `page.ndjson` is append-only, one block per line, and
 * a read can land mid-write. Everything before the last newline is complete by
 * construction; anything after it is ignored. This is what makes progressive
 * assembly safe without any locking: a block is either wholly there or not
 * there at all, and `cat >>` — the most natural thing a shell can do — is
 * exactly the right way to produce it.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateBlock, checkMarkup, textFields, type Block } from "@perpetual/shared/blocks";
import { sanitizeSvg } from "./svg.ts";
import type { Layout, Page, Problem, Site, Tier } from "@perpetual/shared/site";

export const PAGES_REL = join("ui", "pages");
const DIR_RE = /^(\d{3,})-[a-z0-9][a-z0-9-]*$/;
const MAX_BLOCKS = 24;

/**
 * Tier is DERIVED, never declared. plans/16 §13.2.
 *
 * The agent used to write `"tier":2` into meta.json, and the reader used to
 * check it. That was a second copy of a fact the blocks already carried — and
 * a second copy can disagree with the first. It did: a page could declare
 * tier 1 and render a figure.
 *
 * So the blocks are the declaration and this is the reading of it. The field
 * cannot be wrong because nobody writes it, the agent has one less thing to
 * get right on every page, and `tier` becomes a fact about a page rather than
 * a claim about one. The word stays useful for talking about capability
 * levels; it just is not data any more.
 *
 * Tiers are nested — 2 is 1 plus components, 3 is 2 plus figures — so a
 * page's tier is the highest any of its blocks needs.
 */
const TIER1_KINDS = new Set([
  "heading", "section", "prose", "quote", "list", "code", "note", "link", "next",
]);
const TIER2_KINDS = new Set(["metrics", "chart", "table", "split", "flow"]);

function tierOf(kind: string): Tier {
  if (TIER1_KINDS.has(kind)) return 1;
  if (TIER2_KINDS.has(kind)) return 2;
  return 3;
}

function tierOfPage(blocks: { kind: string }[]): Tier {
  return blocks.reduce<Tier>((t, b) => (tierOf(b.kind) > t ? tierOf(b.kind) : t), 1);
}

const LAYOUTS = new Set(["column", "wide", "split", "gallery"]);

function metaFrom(id: string, raw: unknown): { meta: Page; problems: Problem[] } {
  const problems: Problem[] = [];
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  let title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : "";
  if (!title) {
    // Recoverable: derive from the slug rather than refuse the page. A missing
    // title should cost the agent a nudge, not the user their answer.
    title = id.replace(/^\d+-/, "").replace(/-/g, " ");
    problems.push({ page: id, message: "meta.json has no `title`; using the slug instead." });
  }

  let layout: Layout = "column";
  if (typeof r.layout === "string" && LAYOUTS.has(r.layout)) layout = r.layout as Layout;
  else if (r.layout != null) {
    problems.push({ page: id, message: `meta.json \`layout\` must be one of: ${[...LAYOUTS].join(", ")}.` });
  }

  const meta: Page = {
    // `tier` is filled in from the blocks once they are read. Nothing in
    // meta.json contributes to it.
    id, title, tier: 1, layout, blocks: [],
    ...(typeof r.ask === "string" && r.ask.trim() ? { ask: r.ask.trim() } : {}),
  };
  return { meta, problems };
}

async function readPage(pagesDir: string, id: string): Promise<{ page: Page; problems: Problem[] }> {
  const problems: Problem[] = [];

  let rawMeta: unknown = {};
  try { rawMeta = JSON.parse(await readFile(join(pagesDir, id, "meta.json"), "utf8")); }
  catch (e) {
    const missing = e instanceof Error && e.message.includes("ENOENT");
    problems.push({
      page: id,
      message: missing
        ? "meta.json is missing. Every page needs one: {\"title\":\"…\",\"ask\":\"…\"}"
        : `meta.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  const { meta, problems: metaProblems } = metaFrom(id, rawMeta);
  problems.push(...metaProblems);

  let raw = "";
  try { raw = await readFile(join(pagesDir, id, "page.ndjson"), "utf8"); }
  catch {
    // Not a problem yet — the directory may have been created a millisecond
    // before the first append. An empty page simply has no blocks.
    return { page: meta, problems };
  }

  // Only complete lines. See THE PARTIAL-LINE RULE above.
  const lastNl = raw.lastIndexOf("\n");
  const complete = lastNl === -1 ? "" : raw.slice(0, lastNl);

  let blocks: Block[] = [];
  /** id -> the line that claimed it, for the duplicate message below. */
  const idLines = new Map<string, number>();
  let lineNo = 0;
  for (const line of complete.split("\n")) {
    lineNo++;
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch {
      problems.push({
        page: id, line: lineNo,
        message: "not valid JSON. One complete JSON object per line — no pretty-printing, " +
                 "no trailing commas. If the text contains quotes or newlines, escape them.",
      });
      continue;
    }
    const v = validateBlock(parsed);
    if (!v.ok) { problems.push({ page: id, line: lineNo, message: v.error }); continue; }

    // Reported, not refused: a stray asterisk is a blemish, not a broken page,
    // and losing the paragraph would cost the reader far more than the mark.
    for (const f of textFields(v.value)) {
      const bad = checkMarkup(f.text, f.honoured);
      if (bad) problems.push({ page: id, line: lineNo, message: `${f.where}: ${bad}` });
    }
    // Uniqueness is the one thing an id MUST have, and it is a property of the
    // page rather than of the line — so it is checked here, where the page is.
    // ENFORCED rather than reported: a duplicate name would make the keyed
    // reconciliation choose the wrong block, which is worse than a page that
    // simply falls back to being rebuilt. The block keeps its content and
    // loses only the name it could not have.
    const named = v.value.id;
    if (named != null) {
      const taken = idLines.get(named);
      if (taken != null) {
        problems.push({
          page: id, line: lineNo,
          message: `\`id\` "${named}" is already used on line ${taken}. Ids name ONE ` +
                   "block each — that is what lets a later command update this block " +
                   "and nothing else. This one is being ignored; give it its own name.",
        });
        delete (v.value as { id?: string }).id;
      } else {
        idLines.set(named, lineNo);
      }
    }
    blocks.push(v.value);
  }

  // Naming half a page buys nothing: reconciliation is all-or-nothing (see
  // `watcher.ts`), so a page with one unnamed block is still rebuilt whole.
  // Worth one sentence to the agent, because the fix is small and the gain is
  // the difference between amending a page and replacing it.
  const namedCount = blocks.filter((b) => b.id != null).length;
  if (namedCount > 0 && namedCount < blocks.length) {
    problems.push({
      page: id,
      message: `${namedCount} of ${blocks.length} blocks have an \`id\`. Ids work per ` +
               "page, not per block: until every block on this page has one, changing " +
               "any of them rebuilds the whole page and the reader loses their place. " +
               "Name the rest, or none.",
    });
  }

  // Structure. `heading` is the page's claim and `section` breaks a long
  // explanation; without these two rules the model reaches for `heading` four
  // times and the reader gets four 2.5rem headlines stacked down the page.
  if (blocks.length > 0) {
    const first = blocks[0]!;
    if (first.kind !== "heading") {
      problems.push({
        page: id,
        message: `the first block is a \`${first.kind}\`. A page opens with its ` +
                 "`heading` — one sentence stating the claim. Use `section` for breaks " +
                 "further down.",
      });
    }
    const extra = blocks.filter((b) => b.kind === "heading").length - 1;
    if (extra > 0) {
      problems.push({
        page: id,
        message: `${extra + 1} \`heading\` blocks. A page has exactly one — its claim. ` +
                 "Use `section` for the breaks inside a long explanation.",
      });
    }
  }

  // `next` is where the page hands over, so it goes where a page hands over.
  const nexts = blocks.filter((b) => b.kind === "next").length;
  if (nexts > 1) {
    problems.push({
      page: id,
      message: `${nexts} \`next\` blocks. A page has at most one — the questions it ` +
               "leaves open, gathered in one place at the end.",
    });
  }
  if (nexts === 1 && blocks.at(-1)!.kind !== "next") {
    problems.push({
      page: id,
      message: "the `next` block is not the last block. It is what the reader sees " +
               "when they have finished reading, so it belongs at the end.",
    });
  }

  if (blocks.length > MAX_BLOCKS) {
    problems.push({
      page: id,
      message: `${blocks.length} blocks is too many for one page (max ${MAX_BLOCKS}). ` +
               "Split it into a second page — pages are cheap, long pages are not.",
    });
  }

  // Figures: read the referenced file and rebuild it through the sanitiser.
  // ENFORCED, not reported — a figure that fails does not render, because
  // there is no such thing as a partially-safe drawing.
  const resolved: Block[] = [];
  for (const [i, b] of blocks.entries()) {
    if (b.kind !== "figure") { resolved.push(b); continue; }

    let raw: string;
    try { raw = await readFile(join(pagesDir, id, b.src), "utf8"); }
    catch {
      problems.push({
        page: id,
        message: `figure references "${b.src}", which is not in this page's directory. ` +
                 "Figures live beside page.ndjson.",
      });
      continue;
    }

    // The id prefix must be unique per figure: every figure on a page is
    // inlined into ONE document, so they share an id namespace. A named figure
    // prefixes with its name — it survives being moved, where a positional
    // prefix would change every internal id the moment a block above it moved.
    const clean = sanitizeSvg(raw, b.id ? `${id}-${b.id}` : `${id}-${i}`);
    if (!clean.ok) {
      problems.push({ page: id, message: `${b.src} ${clean.error}` });
      continue;
    }
    resolved.push({ ...b, svg: clean.svg });
  }
  blocks = resolved;

  return { page: { ...meta, tier: tierOfPage(blocks), blocks }, problems };
}

/**
 * Read the whole site. Cheap enough to call on a timer: a session holds a
 * handful of small files, and correctness-by-rescan beats maintaining an
 * incremental index that can drift from the directory it describes.
 */
export async function readSite(siteDir: string): Promise<Site> {
  const pagesDir = join(siteDir, PAGES_REL);
  let entries: string[] = [];
  try { entries = await readdir(pagesDir); } catch { return { pages: [], problems: [] }; }

  const problems: Problem[] = [];
  const valid: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!DIR_RE.test(name)) {
      problems.push({
        page: name,
        message: `"${name}" is not a valid page directory. Use NNN-slug — three digits, ` +
                 "a dash, then lowercase words joined by dashes: 003-margin-analysis.",
      });
      continue;
    }
    valid.push(name);
  }
  // Numeric prefix IS the site order, so sorting the names sorts the website.
  valid.sort();

  const pages: Page[] = [];
  for (const id of valid) {
    const { page, problems: p } = await readPage(pagesDir, id);
    pages.push(page);
    problems.push(...p);
  }

  // One website: a link that points nowhere breaks the promise that every page
  // is reachable from every other, so it is checked here rather than trusted.
  const ids = new Set(pages.map((p) => p.id));
  for (const page of pages) {
    for (const b of page.blocks) {
      if (b.kind === "link" && !ids.has(b.page)) {
        problems.push({
          page: page.id,
          message: `link points at "${b.page}", which is not a page in this site. ` +
                   `Existing pages: ${[...ids].join(", ") || "(none)"}.`,
        });
      }
    }
  }

  return { pages, problems };
}

/** The next directory name the agent should use. Told to it in the prompt. */
export function nextPageId(site: Site, slug: string): string {
  const n = site.pages.length + 1;
  return `${String(n).padStart(3, "0")}-${slug}`;
}
