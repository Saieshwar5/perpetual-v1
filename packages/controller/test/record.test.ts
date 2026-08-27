/**
 * Published sections are a record.
 *
 * The agent adds to the site and never unwrites it. The kernel is what makes
 * that true — see the sealed-section cases in sandbox.test.ts, which try to
 * break it with a shell — and these are the two layers around it:
 *
 *   THE BACKSTOP. If a change reaches the files anyway (PERPETUAL_UNSAFE=1 has
 *   no sandbox at all), the reader still keeps what they read: the watcher
 *   refuses to carry it, and the agent is told what happened.
 *
 *   THE WAY ROUND IT. A correction is a new block naming the one it replaces.
 *   That reference has to resolve, or the reader is shown a revision of
 *   something that was never marked as revised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteWatcher } from "../src/watcher.ts";
import { readSite } from "../src/site.ts";
import type { TurnEvent } from "@perpetual/shared/events";

async function fixture(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "perp-record-"));
  await mkdir(join(d, "ui", "pages"), { recursive: true });
  return d;
}

async function write(root: string, page: string, blocks: unknown[], title = "Margins") {
  const dir = join(root, "ui", "pages", page);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title }));
  await writeFile(join(dir, "page.ndjson"),
    blocks.map((b) => JSON.stringify(b)).join("\n") + "\n");
}

const types = (evs: TurnEvent[]) => evs.map((e) => e.type);
const problem = (evs: TurnEvent[]) =>
  (evs.find((e) => e.type === "problem") as Extract<TurnEvent, { type: "problem" }> | undefined)
    ?.problem.message ?? "";

const PAGE = "001-margins";
const PUBLISHED = [
  { kind: "heading", id: "claim", text: "Margins held at 38%" },
  {
    kind: "metrics", id: "numbers",
    items: [{ value: "38%", label: "Gross margin" }, { value: "12%", label: "Net" }],
  },
];

/* ----------------------------------------------------------- the backstop */

test("a change to a published section is not carried to the reader", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  const w = new SiteWatcher(d);
  await w.prime();
  w.seal([PAGE]);

  await write(d, PAGE, [
    { kind: "heading", id: "claim", text: "Margins collapsed" },
    {
      kind: "metrics", id: "numbers",
      items: [{ value: "12%", label: "Gross margin" }, { value: "2%", label: "Net" }],
    },
  ]);
  const evs = await w.poll();

  assert.deepEqual(types(evs), ["problem"], "nothing that would redraw the section");
  assert.match(problem(evs), /published and cannot be changed/);
  assert.match(problem(evs), /supersedes/, "and the refusal carries the way round it");
  await rm(d, { recursive: true, force: true });
});

test("the refusal is said once, not on every poll", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  const w = new SiteWatcher(d);
  await w.prime();
  w.seal([PAGE]);

  await write(d, PAGE, [{ kind: "heading", id: "claim", text: "Changed" }]);
  assert.equal(types(await w.poll()).length, 1);
  assert.deepEqual(await w.poll(), [], "a tamper that stays is not a new problem");
  await rm(d, { recursive: true, force: true });
});

test("deleting a published section leaves it on the reader's screen", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  const w = new SiteWatcher(d);
  await w.prime();
  w.seal([PAGE]);

  await rm(join(d, "ui", "pages", PAGE), { recursive: true, force: true });
  const evs = await w.poll();

  assert.equal(types(evs).includes("page_remove"), false, "the one change nothing can undo");
  assert.match(problem(evs), /cannot be deleted/);
  await rm(d, { recursive: true, force: true });
});

test("an unsealed section is still fully live", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  const w = new SiteWatcher(d);
  await w.prime();
  w.seal([]);                                   // this turn is still writing it

  await write(d, PAGE, [...PUBLISHED, { kind: "prose", id: "how", text: "By pricing." }]);
  assert.deepEqual(types(await w.poll()), ["page_block"]);
  await rm(d, { recursive: true, force: true });
});

test("a new section is unaffected by what is sealed around it", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  const w = new SiteWatcher(d);
  await w.prime();
  w.seal([PAGE]);

  await write(d, "002-volume", [{ kind: "heading", text: "Volume moved it" }], "Volume");
  assert.deepEqual(types(await w.poll()), ["page_open", "page_block"]);
  await rm(d, { recursive: true, force: true });
});

/* -------------------------------------------------------- the way round it */

test("a correction that names a real block is accepted", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  await write(d, "002-correction", [
    { kind: "heading", id: "claim", text: "It was 34%" },
    {
      kind: "metrics", id: "fixed", supersedes: `${PAGE}/numbers`,
      items: [{ value: "34%", label: "Gross margin" }, { value: "9%", label: "Net" }],
    },
  ], "Correction");

  const site = await readSite(d);
  assert.deepEqual(site.problems, []);
  const fixed = site.pages[1]!.blocks[1]!;
  assert.equal(fixed.supersedes, `${PAGE}/numbers`, "and it survives the read");
  await rm(d, { recursive: true, force: true });
});

test("a correction pointing at nothing is a problem, and says what is there", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  await write(d, "002-correction", [
    { kind: "heading", id: "claim", text: "It was 34%" },
    { kind: "prose", id: "fix", supersedes: `${PAGE}/profit`, text: "It was 34%." },
  ], "Correction");

  const site = await readSite(d);
  assert.equal(site.problems.length, 1);
  assert.match(site.problems[0]!.message, /no block there is called that/);
  assert.match(site.problems[0]!.message, /claim, numbers/, "the names it could have meant");
  await rm(d, { recursive: true, force: true });
});

test("a correction naming a section that does not exist is a problem", async () => {
  const d = await fixture();
  await write(d, PAGE, PUBLISHED);
  await write(d, "002-correction", [
    { kind: "heading", id: "claim", text: "It was 34%" },
    { kind: "prose", id: "fix", supersedes: "009-gone/numbers", text: "It was 34%." },
  ], "Correction");

  const site = await readSite(d);
  assert.equal(site.problems.length, 1);
  assert.match(site.problems[0]!.message, /not a section here/);
  await rm(d, { recursive: true, force: true });
});

test("a block cannot supersede itself", async () => {
  const d = await fixture();
  await write(d, PAGE, [
    { kind: "heading", id: "claim", text: "Margins" },
    { kind: "prose", id: "loop", supersedes: `${PAGE}/loop`, text: "Still?" },
  ]);

  const site = await readSite(d);
  assert.match(site.problems[0]!.message, /supersedes itself/);
  await rm(d, { recursive: true, force: true });
});
