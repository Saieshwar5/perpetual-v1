/**
 * The read-side contract. With no tool schema between the agent and the page,
 * these rules ARE the contract — and the tests double as the specification of
 * what prompts/rules.md promises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSite } from "../src/site.ts";
import { SiteWatcher } from "../src/watcher.ts";

async function fixture(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "perp-site-"));
  await mkdir(join(d, "ui", "pages"), { recursive: true });
  return d;
}
/**
 * Every page opens with a heading, because every real page does — the
 * structural rule checks it. Pass `raw` when the test is about that rule
 * itself, or about line numbers.
 */
const page = async (
  root: string, id: string, meta: unknown, lines: string, raw = false,
) => {
  await mkdir(join(root, "ui", "pages", id), { recursive: true });
  await writeFile(join(root, "ui", "pages", id, "meta.json"), JSON.stringify(meta));
  const body = raw || lines.startsWith('{"kind":"heading"')
    ? lines
    : `{"kind":"heading","text":"${id}"}\n${lines}`;
  await writeFile(join(root, "ui", "pages", id, "page.ndjson"), body);
};

test("reads pages in directory order, which is site order", async () => {
  const d = await fixture();
  await page(d, "002-second", { title: "Second", tier: 1 }, '{"kind":"prose","text":"b"}\n');
  await page(d, "001-first", { title: "First", tier: 1 }, '{"kind":"prose","text":"a"}\n');
  await page(d, "010-tenth", { title: "Tenth", tier: 1 }, '{"kind":"prose","text":"j"}\n');
  const site = await readSite(d);
  assert.deepEqual(site.pages.map((p) => p.id), ["001-first", "002-second", "010-tenth"]);
  await rm(d, { recursive: true, force: true });
});

test("a half-written last line is invisible", async () => {
  // The rule the whole streaming design rests on: `cat >>` can be caught
  // mid-write, and a block must be wholly there or not there at all.
  const d = await fixture();
  await page(d, "001-x", { title: "X" },
    '{"kind":"prose","text":"complete"}\n{"kind":"prose","text":"half wri');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.blocks.length, 2, "the heading and the complete line, not the partial");
  assert.equal(site.problems.length, 0, "a partial line is not an error");
  await rm(d, { recursive: true, force: true });
});

test("a malformed line becomes a repairable problem, and the rest still renders", async () => {
  const d = await fixture();
  await page(d, "001-x", { title: "X" },
    '{"kind":"heading","text":"h"}\n{"kind":"prose","text":"good"}\n{"kind":"nope"}\nnot json at all\n{"kind":"quote","text":"also good"}\n');
  const site = await readSite(d);
  assert.deepEqual(site.pages[0]!.blocks.map((b) => b.kind), ["heading", "prose", "quote"]);
  assert.equal(site.problems.length, 2);
  assert.equal(site.problems[0]!.line, 3);
  assert.match(site.problems[0]!.message, /unknown kind "nope"/);
  assert.equal(site.problems[1]!.line, 4);
  await rm(d, { recursive: true, force: true });
});

test("a badly named directory is refused, with the naming rule in the message", async () => {
  const d = await fixture();
  await page(d, "MyPage", { title: "X" }, '{"kind":"prose","text":"a"}\n');
  const site = await readSite(d);
  assert.equal(site.pages.length, 0);
  assert.match(site.problems[0]!.message, /NNN-slug/);
  await rm(d, { recursive: true, force: true });
});

test("a missing title costs a nudge, not the page", async () => {
  const d = await fixture();
  await page(d, "001-margin-analysis", {}, '{"kind":"prose","text":"a"}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.title, "margin analysis");
  assert.match(site.problems[0]!.message, /no `title`/);
  await rm(d, { recursive: true, force: true });
});

test("tier is derived from the blocks, not read from meta.json", async () => {
  // The field used to be written by the agent and checked here, which meant a
  // page could declare tier 1 and render a figure. Now the blocks are the
  // declaration, so the two cannot disagree.
  const d = await fixture();
  await page(d, "001-text", { title: "A" }, '{"kind":"prose","text":"a"}\n');
  await page(d, "002-parts", { title: "B" },
    '{"kind":"prose","text":"a"}\n{"kind":"metrics","items":[{"value":"1","label":"a"},{"value":"2","label":"b"}]}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.tier, 1);
  assert.equal(site.pages[1]!.tier, 2);
  assert.deepEqual(site.problems, [], "nothing to get wrong means nothing to report");
  await rm(d, { recursive: true, force: true });
});

test("a declared tier is ignored entirely", async () => {
  // Whatever meta.json says, the blocks decide — and nothing is refused for
  // disagreeing, because there is no longer anything to disagree with.
  const d = await fixture();
  await page(d, "001-x", { title: "X", tier: 1 },
    '{"kind":"prose","text":"a"}\n{"kind":"metrics","items":[{"value":"1","label":"a"},{"value":"2","label":"b"}]}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.tier, 2, "derived, not the declared 1");
  assert.deepEqual(site.pages[0]!.blocks.map((b) => b.kind), ["heading", "prose", "metrics"]);
  assert.deepEqual(site.problems, []);
  await rm(d, { recursive: true, force: true });
});

test("a figure is read from disk, sanitised, and inlined into the block", async () => {
  const d = await fixture();
  await page(d, "001-x", { title: "X" },
    '{"kind":"figure","src":"flow.svg","caption":"the path"}\n');
  await writeFile(join(d, "ui", "pages", "001-x", "flow.svg"),
    '<svg width="900" viewBox="0 0 100 50"><rect width="20" height="10" fill="var(--accent)"/></svg>');

  const site = await readSite(d);
  assert.deepEqual(site.problems, []);
  const fig = site.pages[0]!.blocks[1]!;
  assert.equal(fig.kind, "figure");
  if (fig.kind !== "figure") return;
  assert.match(fig.svg!, /^<svg viewBox="0 0 100 50">/, "author sizing dropped");
  assert.match(fig.svg!, /fill="var\(--accent\)"/);
  await rm(d, { recursive: true, force: true });
});

test("a figure that fails sanitisation does not render", async () => {
  // Unlike the tier check, this one is enforced: there is no such thing as a
  // partially-safe drawing.
  const d = await fixture();
  await page(d, "001-x", { title: "X" },
    '{"kind":"prose","text":"before"}\n{"kind":"figure","src":"bad.svg"}\n');
  await writeFile(join(d, "ui", "pages", "001-x", "bad.svg"),
    '<svg viewBox="0 0 9 9"><rect fill="#ff0000" width="1" height="1"/></svg>');

  const site = await readSite(d);
  assert.deepEqual(site.pages[0]!.blocks.map((b) => b.kind), ["heading", "prose"],
    "the figure is dropped, the rest of the page survives");
  assert.match(site.problems[0]!.message, /bad\.svg.*names a colour/s);
  await rm(d, { recursive: true, force: true });
});

test("a figure pointing at a missing file says where figures live", async () => {
  const d = await fixture();
  await page(d, "001-x", { title: "X" }, '{"kind":"figure","src":"ghost.svg"}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.blocks.length, 1, "only the heading is left");
  assert.match(site.problems[0]!.message, /"ghost\.svg", which is not in this page's directory/);
  await rm(d, { recursive: true, force: true });
});

test("a figure src cannot escape the page directory", async () => {
  // Confined in the validator, so the resolver never reasons about traversal.
  const d = await fixture();
  await page(d, "001-x", { title: "X" },
    '{"kind":"figure","src":"../../../etc/passwd"}\n{"kind":"figure","src":"/etc/shadow"}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.blocks.length, 1, "only the heading is left");
  assert.equal(site.problems.length, 2);
  for (const p of site.problems) assert.match(p.message, /plain \.svg filename/);
  await rm(d, { recursive: true, force: true });
});

test("a regenerated figure swaps one block, keeping the reader's place", async () => {
  const d = await fixture();
  const svg = join(d, "ui", "pages", "001-x", "flow.svg");
  await page(d, "001-x", { title: "X" },
    '{"kind":"prose","text":"a"}\n{"kind":"figure","src":"flow.svg"}\n');
  await writeFile(svg, '<svg viewBox="0 0 9 9"><rect width="1" height="1" fill="var(--ink)"/></svg>');

  const w = new SiteWatcher(d);
  await w.prime();
  await writeFile(svg, '<svg viewBox="0 0 9 9"><rect width="4" height="4" fill="var(--accent)"/></svg>');

  const evs = await w.poll();
  assert.deepEqual(evs.map((e) => e.type), ["page_block_replace"]);
  await rm(d, { recursive: true, force: true });
});

test("a section has at most one heading, and it opens the section", async () => {
  // Found by running it: the first real model run put FOUR heading blocks on
  // one page, and every one rendered as an <h1>. The vocabulary had one word
  // for two jobs; now it has two, and the count is checked.
  //
  // What is NOT checked any more is that there is one at all. plans/39 §4.1:
  // requiring a headline on a two-sentence reply is what made every answer
  // look like a magazine piece.
  const d = await fixture();
  await page(d, "001-good", { title: "A" },
    '{"kind":"heading","text":"The claim"}\n{"kind":"prose","text":"a"}\n' +
    '{"kind":"section","text":"A movement"}\n{"kind":"prose","text":"b"}\n');
  await page(d, "002-four-h1", { title: "B" },
    '{"kind":"heading","text":"one"}\n{"kind":"heading","text":"two"}\n{"kind":"heading","text":"three"}\n', true);
  await page(d, "003-no-head", { title: "C" },
    '{"kind":"prose","text":"Canberra — chosen in 1908 as a compromise."}\n');
  await page(d, "004-late-head", { title: "D" },
    '{"kind":"prose","text":"a"}\n{"kind":"heading","text":"halfway down"}\n', true);

  const site = await readSite(d);
  const forPage = (id: string) => site.problems.filter((p) => p.page === id);

  assert.deepEqual(forPage("001-good"), [], "heading then sections is correct");
  assert.match(forPage("002-four-h1")[0]!.message, /3 `heading` blocks.*at most one.*Use `section`/s);
  // THE POINT OF THIS PLAN. A bare answer is a whole reply, not a broken page.
  assert.deepEqual(forPage("003-no-head"), [],
    "a section with no heading is a short answer, which is allowed");
  assert.match(forPage("004-late-head")[0]!.message, /`heading` is not the first block/);
  await rm(d, { recursive: true, force: true });
});

test("section is text, so it does not lift a page out of tier 1", async () => {
  const d = await fixture();
  await page(d, "001-x", { title: "X" },
    '{"kind":"heading","text":"a"}\n{"kind":"section","text":"b"}\n{"kind":"prose","text":"c"}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.tier, 1);
  await rm(d, { recursive: true, force: true });
});

test("a page layout must be one of the four modes", async () => {
  const d = await fixture();
  await page(d, "001-x", { title: "X", layout: "gallery" }, '{"kind":"prose","text":"a"}\n');
  await page(d, "002-y", { title: "Y", layout: "freeform" }, '{"kind":"prose","text":"a"}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.layout, "gallery");
  assert.equal(site.pages[1]!.layout, "column", "an unknown mode falls back");
  assert.match(site.problems[0]!.message, /`layout` must be one of/);
  await rm(d, { recursive: true, force: true });
});

test("a link to a page that does not exist is caught", async () => {
  const d = await fixture();
  await page(d, "001-x", { title: "X" }, '{"kind":"link","page":"009-ghost"}\n');
  const site = await readSite(d);
  assert.match(site.problems[0]!.message, /"009-ghost", which is not a page/);
  assert.match(site.problems[0]!.message, /Existing pages: 001-x/);
  await rm(d, { recursive: true, force: true });
});

test("appending streams block by block; rewriting replaces wholesale", async () => {
  const d = await fixture();
  const w = new SiteWatcher(d);
  await w.prime();

  await page(d, "001-x", { title: "X" }, '{"kind":"prose","text":"one"}\n');
  let evs = await w.poll();
  assert.deepEqual(evs.map((e) => e.type), ["page_open", "page_block", "page_block"]);

  await writeFile(join(d, "ui", "pages", "001-x", "page.ndjson"),
    '{"kind":"heading","text":"001-x"}\n{"kind":"prose","text":"one"}\n{"kind":"prose","text":"two"}\n');
  evs = await w.poll();
  assert.deepEqual(evs.map((e) => e.type), ["page_block"], "an append streams");

  await writeFile(join(d, "ui", "pages", "001-x", "page.ndjson"),
    '{"kind":"heading","text":"rewritten"}\n{"kind":"prose","text":"and shorter"}\n');
  evs = await w.poll();
  assert.deepEqual(evs.map((e) => e.type), ["page_replace"], "a rewrite replaces");

  await rm(d, { recursive: true, force: true });
});

test("problems are reported to the agent once, in its own channel", async () => {
  const d = await fixture();
  const w = new SiteWatcher(d);
  await w.prime();
  await page(d, "001-x", { title: "X" }, '{"kind":"prose"}\n');
  await w.poll();

  const feedback = w.drainFeedback();
  assert.match(feedback!, /\[perpetual\]/);
  assert.match(feedback!, /line 2: prose: `text` must be a non-empty string/);
  assert.equal(w.drainFeedback(), null, "not repeated on the next command");

  await w.poll();
  assert.equal(w.drainFeedback(), null, "and not re-raised while it stays broken");
  await rm(d, { recursive: true, force: true });
});
