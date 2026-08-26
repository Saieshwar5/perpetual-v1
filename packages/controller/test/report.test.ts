/**
 * The scorecard — reading back what the agent actually did.
 *
 * The classifier is the whole risk here: a number that miscounts is worse than
 * no number, because it will be believed. So the cases below are REAL commands
 * taken from `.perpetual` transcripts — what a model actually ran when it had
 * no safe way to change a page — rather than commands invented to pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editStyle, reportOn, format } from "../src/report.ts";
import { SessionStore } from "../src/sessions.ts";

/* --------------------------------------------- classifying what a turn did */

test("`sed -i` on a page counts as hand-edited — it really happened", () => {
  assert.equal(editStyle([
    "cd /session/ui/pages/003-engine-metrics\n" +
    "sed -i 's/turned the wheels.\\*\\*/turned the wheels./' page.ndjson\ntail -1 page.ndjson",
  ]), "hand-edited");
});

test("a model writing its own page editor in python counts as hand-edited", () => {
  // Verbatim from a real turn. Given no safe way to change one block, the
  // model built one inline — and spent a step of its budget doing it.
  assert.equal(editStyle([
    "cd /session/ui/pages/003-engine-metrics\npython3 - <<'PY'\n" +
    "lines = open('page.ndjson').read().splitlines()\nout = []\n" +
    "open('/tmp/p.ndjson','w').write('\\n'.join(out)+'\\n')\nPY\nmv /tmp/p.ndjson page.ndjson",
  ]), "hand-edited");
});

test("a python script that only READS a page is not an edit", () => {
  assert.equal(editStyle([
    "python3 -c \"\nimport json\nfor i,ln in enumerate(open('page.ndjson')):\n" +
    "    b=json.loads(ln); print(i+1, b['kind'])\n\"",
  ]), null);
});

test("appending is recognised as the safe thing it is", () => {
  assert.equal(editStyle([
    "cd /session/ui/pages/003-x\ncat >> page.ndjson <<'EOF'\n{\"kind\":\"prose\",\"text\":\"x\"}\nEOF",
  ]), "append");
});

test("rewriting the whole file is correct but counted apart from appending", () => {
  assert.equal(editStyle([
    "cd /session/ui/pages/002-x && cat > page.ndjson <<'EOF'\n{\"kind\":\"heading\",\"text\":\"x\"}\nEOF",
  ]), "rewrite");
});

test("using `page` wins, even in a turn that also appended", () => {
  assert.equal(editStyle([
    "cat >> ui/pages/003-x/page.ndjson <<'EOF'\n{\"kind\":\"prose\",\"text\":\"x\"}\nEOF",
    "page set 003-x lead '{\"kind\":\"prose\",\"text\":\"y\"}'",
  ]), "page-tool", "running the safe tool and also appending is doing right twice");
});

test("without `page`, the riskiest thing in the turn is what gets reported", () => {
  assert.equal(editStyle([
    "cat > ui/pages/003-x/page.ndjson <<'EOF'\n{}\nEOF",
    "sed -i 's/a/b/' ui/pages/003-x/page.ndjson",
  ]), "hand-edited", "a turn that also ran sed is not a clean turn");
});

test("a turn that never touched a page has no style at all", () => {
  assert.equal(editStyle(["ls -la ui/pages/", "cat ui/pages/001-x/meta.json"]), null);
});

/* ------------------------------------------------------- reading a session */

const BLOCKS = [
  { kind: "heading", id: "claim", text: "A claim" },
  { kind: "prose", id: "lead", text: "A paragraph." },
  { kind: "prose", text: "An unnamed paragraph." },
];

async function fixture(turns: unknown[], blocks: unknown[] = BLOCKS) {
  const root = await mkdtemp(join(tmpdir(), "perp-report-"));
  const store = new SessionStore(root);
  const s = await store.create();
  const dir = join(store.siteDir(s.id), "ui", "pages", "001-x");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "X" }));
  await writeFile(join(dir, "page.ndjson"), blocks.map((b) => JSON.stringify(b)).join("\n") + "\n");
  for (const t of turns) await store.appendTurn(s.id, t as never);
  return { store, id: s.id };
}

test("a partly named page is counted as partly named, not as a win", async () => {
  const { store } = await fixture([]);
  const r = await reportOn(store);
  assert.equal(r.totals.blocks, 3);
  assert.equal(r.totals.namedBlocks, 2);
  assert.equal(r.totals.fullyNamed, 0, "two of three named buys nothing");
  assert.equal(r.totals.partlyNamed, 1);
});

test("a page is amended only by a turn that did not create it", async () => {
  const { store } = await fixture([
    { at: "1", ask: "write it", touched: ["001-x"], commands: ["cat >> ui/pages/001-x/page.ndjson"], steps: 3, stopped: "done" },
    { at: "2", ask: "fix it", touched: ["001-x"], commands: ["sed -i 's/a/b/' ui/pages/001-x/page.ndjson"], steps: 2, stopped: "done" },
  ]);
  const r = await reportOn(store);
  assert.equal(r.totals.amendmentTurns, 1, "the first turn created the page; only the second amended it");
  assert.equal(r.totals.amendments["hand-edited"], 1);
  assert.equal(r.totals.amendments.append, 0);
});

test("a risky count carries the command behind it, so it can be looked into", async () => {
  const { store } = await fixture([
    { at: "1", ask: "write", touched: ["001-x"], commands: ["cat >> ui/pages/001-x/page.ndjson"], steps: 1, stopped: "done" },
    { at: "2", ask: "that number is wrong", touched: ["001-x"], commands: ["sed -i 's/5/6/' ui/pages/001-x/page.ndjson"], steps: 1, stopped: "done" },
  ]);
  const r = await reportOn(store);
  assert.equal(r.totals.examples.length, 1);
  assert.match(r.totals.examples[0]!.command, /sed -i/);
  assert.match(format(r), /that number is wrong/, "and it is printed, not just stored");
});

test("replay sessions are left out — no model wrote them", async () => {
  const { store } = await fixture([], [
    { kind: "heading", text: "A replayed page, written by shell, one line at a time" },
  ]);
  const r = await reportOn(store);
  assert.equal(r.replaySkipped, 1);
  assert.equal(r.totals.blocks, 0, "counting replay would report a model that ignores every feature");
});

test("an empty install says so instead of printing zeros", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-report-empty-"));
  const out = format(await reportOn(new SessionStore(root)));
  assert.match(out, /Nothing to report yet/);
  assert.match(out, /pnpm dev/);
});
