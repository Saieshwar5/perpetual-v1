/**
 * Retiring sessions nobody used.
 *
 * The whole risk here is deleting something that mattered, so these tests are
 * mostly about what the sweep must NOT touch: a session with a page, a session
 * whose only turn failed, a session with a turn running, and a session created
 * a moment ago that the reader is probably still looking at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions.ts";

const store = async () => new SessionStore(await mkdtemp(join(tmpdir(), "perp-sweep-")));
const exists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };

const withPage = async (s: SessionStore, id: string) => {
  const dir = join(s.siteDir(id), "ui", "pages", "001-x");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), '{"title":"X"}');
  await writeFile(join(dir, "page.ndjson"), '{"kind":"heading","text":"x"}\n');
};

test("a session nobody touched is unused", async () => {
  const s = await store();
  const a = await s.create();
  assert.equal(await s.unused(a.id), true);
  await rm(s.root, { recursive: true, force: true });
});

test("a session with a page is not unused", async () => {
  const s = await store();
  const a = await s.create();
  await withPage(s, a.id);
  assert.equal(await s.unused(a.id), false);
  await rm(s.root, { recursive: true, force: true });
});

test("a session whose only turn FAILED is not unused", async () => {
  // The one that matters. A failed turn produces no page, and sweeping it
  // would delete the evidence of exactly the failure worth looking at.
  const s = await store();
  const a = await s.create();
  await s.appendTurn(a.id, {
    at: new Date().toISOString(), ask: "something", touched: [], commands: [], steps: 0,
    error: "401 invalid api key",
  });
  assert.equal(await s.unused(a.id), false);
  await rm(s.root, { recursive: true, force: true });
});

test("the sweep removes only the unused, and leaves the rest alone", async () => {
  const s = await store();
  const empty = await s.create();
  const used = await s.create();
  await withPage(s, used.id);

  const removed = await s.sweep({ graceMs: 0, skip: new Set() });
  assert.deepEqual(removed, [empty.id]);
  assert.equal(await exists(s.dir(empty.id)), false, "the directory is gone");
  assert.equal(await exists(s.dir(used.id)), true);
  assert.deepEqual((await s.list()).map((x) => x.id), [used.id]);
  await rm(s.root, { recursive: true, force: true });
});

test("a session created moments ago survives the sweep", async () => {
  // A session is created the instant "New" is clicked and stays empty until
  // the reader types. Without the grace, opening the library in a second tab
  // would delete the session open in the first.
  const s = await store();
  const fresh = await s.create();
  assert.deepEqual(await s.sweep({ graceMs: 10 * 60_000, skip: new Set() }), []);
  assert.equal(await exists(s.dir(fresh.id)), true);
  await rm(s.root, { recursive: true, force: true });
});

test("a session with a turn running is never swept", async () => {
  const s = await store();
  const busy = await s.create();
  assert.deepEqual(await s.sweep({ graceMs: 0, skip: new Set([busy.id]) }), []);
  assert.equal(await exists(s.dir(busy.id)), true);
  await rm(s.root, { recursive: true, force: true });
});

test("removing a session takes the whole directory, agent files included", async () => {
  const s = await store();
  const a = await s.create();
  await withPage(s, a.id);
  await writeFile(join(s.siteDir(a.id), "workspace", "scratch.txt"), "leftovers");
  await s.remove(a.id);
  assert.equal(await exists(s.dir(a.id)), false);
  await rm(s.root, { recursive: true, force: true });
});
