/**
 * What the agent actually did — read back from what it left behind.
 *
 * Every feature built since block identity rests on an assumption about model
 * behaviour that nobody has checked: that it names its blocks, that it reaches
 * for `choice` instead of asking in prose, that it edits with `page` instead
 * of improvising shell, that being told a page runs long changes what it does
 * next. Those are not code questions — the tests already prove the code works
 * — they are questions about a model, and the only honest way to answer them
 * is to look at real runs.
 *
 * Nothing new has to be recorded to do it. Every turn already writes its ask,
 * its touched pages, its stop cause and EVERY SHELL COMMAND it ran into
 * `transcript.jsonl`, and `store.transcript()` has always been able to read
 * them back. Nothing has ever called it. This does.
 *
 * The counting rule throughout: measure, never infer intent. "Used `page`" is
 * a command that starts with `page`; it is not a judgement about whether the
 * amendment was a good idea. Where a number cannot be measured honestly, it is
 * left out rather than estimated — the whole reason `tools/` exists is that
 * estimating was wrong three times in a row.
 */
import { readSite } from "./site.ts";
import { SessionStore, type TranscriptTurn } from "./sessions.ts";
import { BLOCK_KINDS } from "@perpetual/shared/blocks";

/* ------------------------------------------------------------- classifying */

/**
 * How a turn changed a page that already existed.
 *
 * Two rules, and they point in opposite directions on purpose. If the turn
 * used `page` at all it is credited with that — running the safe tool and also
 * appending is doing the right thing twice. Otherwise the RISKIEST thing it
 * did is what gets reported, because the point of the number is to surface
 * danger, and a turn that rewrote a page cleanly and also ran `sed -i` on it
 * is not a clean turn.
 */
export type EditStyle =
  /** `page set|after|rm|move|split` — positions kept, failures loud. */
  | "page-tool"
  /** `cat >>` only. Always safe, and the only safe way before the tool existed. */
  | "append"
  /** `cat >` over the whole file: correct, but every block is redrawn. */
  | "rewrite"
  /** grep/sed/awk/mv against page.ndjson — the way that silently moves blocks. */
  | "hand-edited";

const PAGE_TOOL = /(^|[\s;&|(])page\s+(ls|set|after|before|rm|move|split)\b/;
const APPEND = />>\s*\S*page\.ndjson/;
const REWRITE = /(^|[^>])>\s*\S*page\.ndjson/;
const HAND = new RegExp([
  // Text tools pointed at a file of JSON. `sed -i` on page.ndjson is the one
  // that actually happened, and one unlucky regex corrupts the whole page.
  "(grep|sed|awk|head|tail)\\b[^\\n]*page\\.ndjson",
  // Rewrite-through-a-temp-file, which is where a block silently moves.
  "mv\\s+\\S+\\s+\\S*page\\.ndjson",
  // The model writing its OWN page editor, inline, because it had none. This
  // is the pattern that made the case for the `page` program: given no safe
  // way to change one block, a good model invents one on the spot — and
  // spends a step of its budget doing it, every time.
  "open\\([^)]*page\\.ndjson[^)]*['\"]w",
].join("|"));

export function editStyle(commands: string[]): EditStyle | null {
  const all = commands.join("\n");
  if (PAGE_TOOL.test(all)) return "page-tool";
  if (HAND.test(all)) return "hand-edited";
  if (REWRITE.test(all)) return "rewrite";
  if (APPEND.test(all)) return "append";
  return null;
}

/**
 * A session written by the replay runtime rather than by a model.
 *
 * They have to be excluded or every number is wrong: replay writes a fixed
 * page with no ids, never uses `choice`, and never amends anything — so
 * counting it as agent behaviour would report a model that ignores every
 * feature, when no model was involved at all.
 */
const REPLAY_MARK = "A replayed page, written by shell";

/* ---------------------------------------------------------------- the shape */

export interface SessionReport {
  id: string;
  title: string;
  replay: boolean;
  turns: number;
  pages: number;
  blocks: number;
  namedBlocks: number;
  /** Pages where EVERY block has an id — the only ones updated block by block. */
  fullyNamed: number;
  /** Pages where some blocks are named and some are not: the worst case. */
  partlyNamed: number;
  kinds: Record<string, number>;
  /** Turns that changed a page they did not create, and how. */
  amendments: Record<EditStyle, number>;
  amendmentTurns: number;
  /** Blocks that name what they replace — the way a correction is made now. */
  corrections: number;
  /** Blocks that have been superseded by a later one. Never more than `corrections`. */
  superseded: number;
  /** Real commands behind the risky counts, so a number can be looked into. */
  examples: { style: EditStyle; ask: string; command: string }[];
  stopped: Record<string, number>;
  steps: number[];
}

export interface Report {
  sessions: SessionReport[];
  totals: Omit<SessionReport, "id" | "title" | "replay">;
  replaySkipped: number;
}

const emptyTotals = (): Report["totals"] => ({
  turns: 0, pages: 0, blocks: 0, namedBlocks: 0, fullyNamed: 0, partlyNamed: 0,
  kinds: {}, amendments: { "page-tool": 0, append: 0, rewrite: 0, "hand-edited": 0 },
  amendmentTurns: 0, corrections: 0, superseded: 0, examples: [], stopped: {}, steps: [],
});

/* ------------------------------------------------------------- the reading */

export async function reportOn(store: SessionStore, ids?: string[]): Promise<Report> {
  const list = ids?.length ? ids : (await store.list()).map((s) => s.id);
  const sessions: SessionReport[] = [];

  for (const id of list) {
    const [site, turns, index] = await Promise.all([
      readSite(store.siteDir(id)).catch(() => ({ pages: [], problems: [] })),
      store.transcript(id).catch(() => [] as TranscriptTurn[]),
      store.read(id).catch(() => null),
    ]);

    const s: SessionReport = {
      id, title: index?.title ?? "(untitled)",
      replay: site.pages.some((p) => p.blocks.some(
        (b) => "text" in b && typeof b.text === "string" && b.text.includes(REPLAY_MARK),
      )),
      turns: turns.length, pages: site.pages.length,
      blocks: 0, namedBlocks: 0, fullyNamed: 0, partlyNamed: 0,
      kinds: {},
      amendments: { "page-tool": 0, append: 0, rewrite: 0, "hand-edited": 0 },
      amendmentTurns: 0,
      corrections: 0, superseded: 0,
      examples: [],
      stopped: {}, steps: [],
    };

    for (const page of site.pages) {
      const named = page.blocks.filter((b) => b.id).length;
      s.blocks += page.blocks.length;
      s.namedBlocks += named;
      if (page.blocks.length && named === page.blocks.length) s.fullyNamed++;
      else if (named > 0) s.partlyNamed++;
      for (const b of page.blocks) s.kinds[b.kind] = (s.kinds[b.kind] ?? 0) + 1;
    }

    // Corrections. Published sections cannot be edited, so this is the only
    // way the agent can say "that was wrong" — and counting it is how we find
    // out whether it learned to, or whether it just stops correcting itself.
    const revised = new Set<string>();
    for (const page of site.pages) {
      for (const b of page.blocks) {
        if (!b.supersedes) continue;
        s.corrections++;
        revised.add(b.supersedes);
      }
    }
    s.superseded = revised.size;

    // A page is CREATED by the first turn that touches it. Any later turn that
    // touches it again is amending something that already exists — which is
    // the operation the last three branches are about.
    const seen = new Set<string>();
    for (const t of turns) {
      s.stopped[t.stopped ?? "unknown"] = (s.stopped[t.stopped ?? "unknown"] ?? 0) + 1;
      if (typeof t.steps === "number") s.steps.push(t.steps);

      const amends = (t.touched ?? []).some((p) => seen.has(p));
      for (const p of t.touched ?? []) seen.add(p);
      if (!amends) continue;

      s.amendmentTurns++;
      const style = editStyle(t.commands ?? []);
      if (!style) continue;
      s.amendments[style]++;
      if (style === "hand-edited" && s.examples.length < 3) {
        const worst = (t.commands ?? []).find((c) => HAND.test(c));
        if (worst) s.examples.push({ style, ask: t.ask, command: worst });
      }
    }

    sessions.push(s);
  }

  const real = sessions.filter((s) => !s.replay);
  const totals = emptyTotals();
  for (const s of real) {
    totals.turns += s.turns; totals.pages += s.pages;
    totals.blocks += s.blocks; totals.namedBlocks += s.namedBlocks;
    totals.fullyNamed += s.fullyNamed; totals.partlyNamed += s.partlyNamed;
    totals.amendmentTurns += s.amendmentTurns;
    totals.corrections += s.corrections; totals.superseded += s.superseded;
    totals.examples.push(...s.examples);
    totals.steps.push(...s.steps);
    for (const [k, n] of Object.entries(s.kinds)) totals.kinds[k] = (totals.kinds[k] ?? 0) + n;
    for (const [k, n] of Object.entries(s.stopped)) totals.stopped[k] = (totals.stopped[k] ?? 0) + n;
    for (const k of Object.keys(totals.amendments) as EditStyle[]) {
      totals.amendments[k] += s.amendments[k];
    }
  }

  return { sessions, totals, replaySkipped: sessions.length - real.length };
}

/* ------------------------------------------------------------- the printing */

const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((n / of) * 100)}%`);
const bar = (n: number, of: number, width = 24) =>
  of === 0 ? "" : "█".repeat(Math.round((n / of) * width)).padEnd(width, "·");

/**
 * Every number gets a sentence saying what it means and which way is good.
 *
 * A scorecard nobody can read is a scorecard nobody looks at twice — and the
 * one thing that must not happen here is the numbers becoming decoration.
 */
export function format(r: Report): string {
  const t = r.totals;
  const totals = t;
  const out: string[] = [];
  const line = (s = "") => out.push(s);

  line("AGENT SCORECARD");
  line(`  ${t.turns} turns · ${t.pages} pages · ${t.blocks} blocks` +
    (r.replaySkipped ? ` · ${r.replaySkipped} replay session(s) skipped` : ""));
  if (t.turns === 0) {
    line();
    line("  Nothing to report yet. Run some real turns first:  pnpm dev");
    return out.join("\n");
  }

  line();
  line("NAMES — can a page be updated one block at a time?");
  line(`  blocks named        ${bar(t.namedBlocks, t.blocks)}  ${t.namedBlocks}/${t.blocks}  ${pct(t.namedBlocks, t.blocks)}`);
  line(`  pages FULLY named   ${bar(t.fullyNamed, t.pages)}  ${t.fullyNamed}/${t.pages}  ${pct(t.fullyNamed, t.pages)}`);
  if (t.partlyNamed) {
    line(`  pages partly named  ${t.partlyNamed} — the worst case: named blocks buy nothing`);
    line("                      unless EVERY block on the page has an id.");
  }
  line("  Higher is better. A page that is not fully named is thrown away and");
  line("  redrawn on every change, and the reader sees the whole page flash.");

  line();
  line("THE RECORD — does it correct itself without unwriting anything?");
  line(`  corrections written ${String(t.corrections).padStart(4)}  blocks that name what they replace`);
  line(`  blocks superseded   ${String(t.superseded).padStart(4)}  marked as revised, still on the page`);
  if (t.corrections === 0) {
    line("  Nothing corrected yet. Worth watching: a published section is read-only,");
    line("  so an agent that cannot correct itself will quietly stop trying.");
  }

  line();
  line("EDITING — how does it change a page that already exists?");
  line("  Under the seal this should be near zero: the only sections a turn may");
  line("  change are the ones it is writing, plus one left open by a turn that");
  line("  was cut short or left problems behind.");
  if (t.amendmentTurns === 0) {
    line("  No turn has ever changed a page it did not just create.");
  } else {
    for (const k of ["page-tool", "append", "rewrite", "hand-edited"] as EditStyle[]) {
      const n = t.amendments[k];
      const note = {
        "page-tool": "safe: position kept, failures loud",
        append: "safe, but only ever adds to the end",
        rewrite: "correct, but redraws the whole page",
        "hand-edited": "RISKY: silently moves blocks, fails silently",
      }[k];
      line(`  ${k.padEnd(12)} ${bar(n, t.amendmentTurns, 14)} ${String(n).padStart(3)}  ${note}`);
    }
    line(`  ${t.amendmentTurns} amendment turn(s) in total.`);
    for (const e of totals.examples.slice(0, 2)) {
      const first = e.command.split("\n").map((l) => l.trim()).filter(Boolean)
        .find((l) => /page\.ndjson|open\(/.test(l)) ?? e.command.split("\n")[0]!;
      line(`    e.g. "${e.ask.slice(0, 40)}" ran:  ${first.slice(0, 74)}`);
    }
  }

  line();
  line("VOCABULARY — which blocks does it actually reach for?");
  const used = BLOCK_KINDS.filter((k) => t.kinds[k]);
  const unused = BLOCK_KINDS.filter((k) => !t.kinds[k]);
  for (const k of [...used].sort((a, b) => (t.kinds[b] ?? 0) - (t.kinds[a] ?? 0))) {
    line(`  ${k.padEnd(9)} ${String(t.kinds[k]).padStart(4)}  ${bar(t.kinds[k] ?? 0, t.blocks, 18)}`);
  }
  if (unused.length) {
    line(`  never used: ${unused.join(", ")}`);
    line("  A block kind at zero after many turns is a prompt problem, not a");
    line("  code problem — the rules are not making the case for it.");
  }

  line();
  line("TURNS — where do they end?");
  for (const [k, n] of Object.entries(t.stopped).sort((a, b) => b[1] - a[1])) {
    const note = {
      done: "finished on its own — good",
      steps: "ran out of commands — the budget may be too tight",
      time: "ran out of time",
      aborted: "the reader stopped it",
      error: "the model or the provider failed",
    }[k] ?? "";
    line(`  ${k.padEnd(8)} ${String(n).padStart(3)}  ${note}`);
  }
  if (t.steps.length) {
    const sorted = [...t.steps].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)]!;
    line(`  steps per turn: median ${mid}, worst ${sorted.at(-1)} (the cap is 22)`);
  }

  line();
  line("PER SESSION");
  for (const s of r.sessions) {
    const tag = s.replay ? "  (replay — not a model)" : "";
    line(`  ${s.id}  ${s.turns}t ${s.pages}p  named ${pct(s.namedBlocks, s.blocks)}` +
      `  "${s.title.slice(0, 34)}"${tag}`);
  }

  return out.join("\n");
}
