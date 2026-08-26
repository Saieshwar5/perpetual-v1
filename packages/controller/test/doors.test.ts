/**
 * A page's `next` block is ONE FORK, not a menu.
 *
 * The site is a single ordered sequence — force-scroll moves along it and the
 * rail is a linear thread — so one page spawning three siblings would put
 * three unrelated tangents in a row and imply a progression that is not there.
 * Taking a branch therefore closes the others.
 *
 * These check the half that lives on the server: which door was walked
 * through, and whether a branch was actually taken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions.ts";
import { readSite } from "../src/site.ts";

const DOORS = ["Why does gasoline stop at 9:1?", "Where does the other 60% go?"];

async function session() {
  const store = new SessionStore(await mkdtemp(join(tmpdir(), "perp-doors-")));
  const s = await store.create();
  const dir = join(store.siteDir(s.id), "ui", "pages", "001-engines");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), '{"title":"Engines"}');
  await writeFile(join(dir, "page.ndjson"),
    '{"kind":"heading","text":"h"}\n' + JSON.stringify({ kind: "next", items: DOORS }) + "\n");
  return { store, id: s.id };
}

/** The server's rule, in the shape server.ts applies it. */
function record(
  index: { answered: Record<string, string> },
  before: Awaited<ReturnType<typeof readSite>>,
  createdIds: string[],
  input: string,
) {
  const wasADoor = before.pages.some(
    (p) => p.blocks.some((b) => b.kind === "next" && b.items.includes(input)),
  );
  if (wasADoor && createdIds[0]) index.answered[input] = createdIds[0];
}

test("a new session starts with no doors taken", async () => {
  const { store, id } = await session();
  assert.deepEqual((await store.read(id)).answered, {});
  await rm(store.root, { recursive: true, force: true });
});

test("walking through a door records which page it built", async () => {
  const { store, id } = await session();
  const index = await store.read(id);
  record(index, await readSite(store.siteDir(id)), ["002-knock"], DOORS[0]!);
  await store.write(index);

  assert.deepEqual((await store.read(id)).answered, { [DOORS[0]!]: "002-knock" });
  await rm(store.root, { recursive: true, force: true });
});

test("a door that produced no page spends nothing", async () => {
  // If the turn amended a page instead of writing one, no fork happened — and
  // a click that went nowhere must not close off its siblings.
  const { store, id } = await session();
  const index = await store.read(id);
  record(index, await readSite(store.siteDir(id)), [], DOORS[0]!);
  assert.deepEqual(index.answered, {});
  await rm(store.root, { recursive: true, force: true });
});

test("a typed question that is not a door records nothing", async () => {
  const { store, id } = await session();
  const index = await store.read(id);
  record(index, await readSite(store.siteDir(id)), ["002-something"], "something else entirely");
  assert.deepEqual(index.answered, {});
  await rm(store.root, { recursive: true, force: true });
});

test("the record survives a reload, so the fork stays closed", async () => {
  const { store, id } = await session();
  const index = await store.read(id);
  record(index, await readSite(store.siteDir(id)), ["002-knock"], DOORS[0]!);
  await store.write(index);

  const reloaded = await store.read(id);
  const site = await readSite(store.siteDir(id));
  const doors = site.pages[0]!.blocks.find((b) => b.kind === "next")!;
  assert.equal(doors.kind, "next");
  if (doors.kind !== "next") return;

  const taken = doors.items.filter((q) => reloaded.answered[q]);
  const spent = doors.items.filter((q) => !reloaded.answered[q]);
  assert.deepEqual(taken, [DOORS[0]], "one leads to the room it built");
  assert.deepEqual(spent, [DOORS[1]], "the other is context now");
  await rm(store.root, { recursive: true, force: true });
});
