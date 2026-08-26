/**
 * Block identity — the `id` field and what it buys.
 *
 * The point of these tests is not that ids parse. It is that a NAMED page
 * reports what happened to it (insert, remove, move, one block changed) where
 * an unnamed page can only report "it is different now, here it is again".
 * That difference is the reader keeping their scroll position and their
 * anchor, so it is worth pinning down precisely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSite } from "../src/site.ts";
import { SiteWatcher } from "../src/watcher.ts";
import { validateBlock } from "@perpetual/shared/blocks";
import type { Block } from "@perpetual/shared/blocks";
import type { TurnEvent } from "@perpetual/shared/events";

async function fixture(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "perp-id-"));
  await mkdir(join(d, "ui", "pages"), { recursive: true });
  return d;
}

const PAGE = "001-margins";

/** Write a page from block objects, so tests read as the page they describe. */
async function write(root: string, blocks: unknown[]) {
  const dir = join(root, "ui", "pages", PAGE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "Margins" }));
  await writeFile(
    join(dir, "page.ndjson"),
    blocks.map((b) => JSON.stringify(b)).join("\n") + "\n",
  );
}

const head = (id?: string) => ({ kind: "heading", text: "Margins hold", ...(id ? { id } : {}) });
const prose = (id: string | undefined, text: string) =>
  ({ kind: "prose", text, ...(id ? { id } : {}) });

const types = (evs: TurnEvent[]) => evs.map((e) => e.type);

/* ------------------------------------------------------------- the field */

test("an id must be a name, not an arbitrary string", async () => {
  const ok = validateBlock({ kind: "prose", text: "x", id: "margin-trend" });
  assert.equal(ok.ok, true);

  for (const bad of ["Margin Trend", "margin_trend", "-leading", "x".repeat(41), 7]) {
    const v = validateBlock({ kind: "prose", text: "x", id: bad });
    assert.equal(v.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.match((v as { error: string }).error, /lowercase letters, digits and dashes/);
  }
});

test("a duplicate id is dropped, not honoured — and the agent is told which line took it", async () => {
  const d = await fixture();
  await write(d, [head("h"), prose("lead", "first"), prose("lead", "second")]);

  const site = await readSite(d);
  const page = site.pages[0]!;
  assert.equal(page.blocks.length, 3, "the block itself survives; only its name does not");
  assert.equal(page.blocks[1]!.id, "lead");
  assert.equal(page.blocks[2]!.id, undefined);

  const dup = site.problems.find((p) => /already used/.test(p.message));
  assert.ok(dup, "a duplicate must be reported");
  assert.equal(dup!.line, 3, "reported against the line that lost, not the one that kept it");
  assert.match(dup!.message, /line 2/);
  await rm(d, { recursive: true, force: true });
});

test("naming half a page is reported, because half a page earns nothing", async () => {
  const d = await fixture();
  await write(d, [head("h"), prose("lead", "named"), prose(undefined, "not named")]);
  const site = await readSite(d);
  assert.ok(
    site.problems.some((p) => /2 of 3 blocks have an `id`/.test(p.message)),
    "the agent should be told it is halfway",
  );
  await rm(d, { recursive: true, force: true });
});

/* ------------------------------------------------ what identity is FOR */

test("an insert into a named page is an insert, not a rebuild", async () => {
  const d = await fixture();
  await write(d, [head("h"), prose("lead", "one"), prose("tail", "two")]);
  const w = new SiteWatcher(d);
  await w.prime();

  // A note lands between two paragraphs that did not change.
  await write(d, [head("h"), prose("lead", "one"), prose("mid", "inserted"), prose("tail", "two")]);
  const evs = await w.poll();

  assert.deepEqual(types(evs), ["page_block_insert"]);
  const ins = evs[0] as Extract<TurnEvent, { type: "page_block_insert" }>;
  assert.equal(ins.index, 2);
  assert.equal((ins.block as Block).id, "mid");
  await rm(d, { recursive: true, force: true });
});

test("the same insert into an unnamed page can only be a whole-page replace", async () => {
  const d = await fixture();
  await write(d, [head(), prose(undefined, "one"), prose(undefined, "two")]);
  const w = new SiteWatcher(d);
  await w.prime();

  await write(d, [head(), prose(undefined, "one"), prose(undefined, "inserted"), prose(undefined, "two")]);
  assert.deepEqual(types(await w.poll()), ["page_replace"],
    "this is the behaviour ids exist to improve on");
  await rm(d, { recursive: true, force: true });
});

test("a removal names the slot that went, and nothing else moves", async () => {
  const d = await fixture();
  await write(d, [head("h"), prose("a", "one"), prose("b", "two"), prose("c", "three")]);
  const w = new SiteWatcher(d);
  await w.prime();

  await write(d, [head("h"), prose("a", "one"), prose("c", "three")]);
  const evs = await w.poll();
  assert.deepEqual(types(evs), ["page_block_remove"]);
  assert.equal((evs[0] as Extract<TurnEvent, { type: "page_block_remove" }>).index, 2);
  await rm(d, { recursive: true, force: true });
});

test("a reorder is a move, so the node survives it", async () => {
  const d = await fixture();
  await write(d, [head("h"), prose("a", "one"), prose("b", "two"), prose("c", "three")]);
  const w = new SiteWatcher(d);
  await w.prime();

  // c is pulled up above b.
  await write(d, [head("h"), prose("a", "one"), prose("c", "three"), prose("b", "two")]);
  const evs = await w.poll();
  assert.deepEqual(types(evs), ["page_block_move"]);
  const mv = evs[0] as Extract<TurnEvent, { type: "page_block_move" }>;
  assert.deepEqual([mv.from, mv.to], [3, 2]);
  await rm(d, { recursive: true, force: true });
});

test("editing one named block touches only that block, whatever else moved", async () => {
  const d = await fixture();
  await write(d, [head("h"), prose("a", "one"), prose("b", "two")]);
  const w = new SiteWatcher(d);
  await w.prime();

  // The agent corrects `b` AND drops a block in above it, in one write.
  await write(d, [head("h"), prose("a", "one"), prose("mid", "new"), prose("b", "corrected")]);
  const evs = await w.poll();

  assert.deepEqual(types(evs), ["page_block_insert", "page_block_replace"]);
  const rep = evs[1] as Extract<TurnEvent, { type: "page_block_replace" }>;
  assert.equal(rep.index, 3, "the index is where the block IS once the insert has been applied");
  assert.equal((rep.block as { text: string }).text, "corrected");
  await rm(d, { recursive: true, force: true });
});

test("the ops, applied in order, reproduce the file exactly", async () => {
  const d = await fixture();
  const before = [head("h"), prose("a", "1"), prose("b", "2"), prose("c", "3"), prose("d", "4")];
  const after = [head("h"), prose("d", "4"), prose("b", "2 edited"), prose("new", "5"), prose("a", "1")];
  await write(d, before);
  const w = new SiteWatcher(d);
  await w.prime();
  await write(d, after);

  // Replay the ops against a copy of the old list, exactly as the client does.
  const work: Block[] = JSON.parse(JSON.stringify(before));
  for (const e of await w.poll()) {
    if (e.type === "page_block_insert") work.splice(e.index, 0, e.block);
    else if (e.type === "page_block_remove") work.splice(e.index, 1);
    else if (e.type === "page_block_move") work.splice(e.to, 0, ...work.splice(e.from, 1));
    else if (e.type === "page_block_replace") work[e.index] = e.block;
    else assert.fail(`a named page should not need ${e.type}`);
  }
  assert.deepEqual(work, after, "the client must land on exactly what is on disk");
  await rm(d, { recursive: true, force: true });
});

test("appending to a named page still streams block by block", async () => {
  const d = await fixture();
  await write(d, [head("h"), prose("a", "one")]);
  const w = new SiteWatcher(d);
  await w.prime();

  await write(d, [head("h"), prose("a", "one"), prose("b", "two"), prose("c", "three")]);
  assert.deepEqual(types(await w.poll()), ["page_block", "page_block"],
    "progressive assembly is the common case and must not be traded away");
  await rm(d, { recursive: true, force: true });
});
