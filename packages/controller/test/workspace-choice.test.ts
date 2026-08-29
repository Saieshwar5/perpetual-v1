/**
 * A session's own workspace, and the directories the reader adds to it.
 * plans/42, plans/45.
 *
 * Every session is born able to write somewhere — its own directory, inside
 * its own record, shared with no other session. A session that could write
 * nowhere is an agent that reads the whole disk and changes nothing on it,
 * which looks like a working agent right up until it is asked to do
 * something.
 *
 * On top of that the reader may point the session at a real project (once,
 * before it has written — a session whose workspace changes underneath it has
 * a record about two different directories) and may allow further directories
 * one at a time, in answer to a `grant` the agent wrote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions.ts";
import { startServer } from "../src/server.ts";

import { readSite } from "../src/site.ts";

test("a session is born with its own workspace directory, shared with nobody", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-sess-"));
  const store = new SessionStore(root);

  const a = await store.create();
  const b = await store.create();
  assert.equal(a.workdir, undefined, "no directory of the reader's is claimed by default");

  // The place PERPETUAL_WORKDIR points when nothing was chosen. It has to
  // exist: bwrap cannot bind nothing, and an agent told it may write
  // somewhere absent fails for a reason it cannot see.
  for (const s of [a, b]) {
    const ws = join(store.siteDir(s.id), "workspace");
    assert.ok(await stat(ws).then((x) => x.isDirectory(), () => false), "it is real");
  }
  assert.notEqual(join(store.siteDir(a.id), "workspace"),
    join(store.siteDir(b.id), "workspace"), "and no two sessions share one");

  // Pointing a session at a real project is still the reader's to do.
  const chosen = await store.create(homedir());
  assert.equal(chosen.workdir, homedir());
  assert.equal((await store.read(chosen.id)).workdir, homedir(), "and it is persisted");

  await rm(root, { recursive: true, force: true });
});

test("a grant is remembered, once, alongside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-grant-"));
  const store = new SessionStore(root);
  const s = await store.create();
  assert.equal(s.grants, undefined, "a session starts with nothing granted");

  const index = await store.read(s.id);
  index.grants = [...new Set([...(index.grants ?? []), "/home/x/Documents"])];
  index.grants = [...new Set([...index.grants, "/home/x/Documents"])];
  await store.write(index);

  assert.deepEqual((await store.read(s.id)).grants, ["/home/x/Documents"],
    "allowing the same directory twice is one grant");

  await rm(root, { recursive: true, force: true });
});

test("the workspace can move mid-session, and the record says where", async () => {
  // It used to be fixed the moment a session wrote a page. The argument was
  // sound — two sections about two different `x.ts` look identical — but the
  // answer is to SAY where the work moved, not to forbid moving. Grants had
  // already made the writable set mutable; this door was a leftover.
  const root = await mkdtemp(join(tmpdir(), "perp-move-"));
  const a = await mkdtemp(join(homedir(), ".perpetual-move-a-"));
  const b = await mkdtemp(join(homedir(), ".perpetual-move-b-"));

  process.env.PERPETUAL_REPLAY = "1";
  const server = await startServer({ root, port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  const store = new SessionStore(root);
  const set = (id: string, workdir: string | null) =>
    fetch(`${base}/sessions/${id}/settings`, {
      method: "POST", body: JSON.stringify({ workdir }),
    });

  try {
    const s = await (await fetch(`${base}/sessions`, { method: "POST" })).json() as { id: string };

    // Chosen before anything is written: the choice itself, not a move.
    assert.equal((await set(s.id, a)).status, 200);
    assert.equal((await store.read(s.id)).workdir, a);
    assert.equal((await store.read(s.id)).moves, undefined, "nothing to be honest about yet");

    // The session writes, which is exactly where the old rule slammed shut.
    const pages = join(store.siteDir(s.id), "ui", "pages");
    await mkdir(join(pages, "001-x"), { recursive: true });
    await writeFile(join(pages, "001-x", "meta.json"), JSON.stringify({ title: "X", ask: "x" }));
    await writeFile(join(pages, "001-x", "page.ndjson"),
      '{"kind":"prose","text":"Written in the first directory."}\n');

    const moved = await set(s.id, b);
    assert.equal(moved.status, 200, "the reader may still change their mind");

    const after = await store.read(s.id);
    assert.equal(after.workdir, b);
    assert.equal(after.moves?.length, 1);
    assert.equal(after.moves![0]!.after, 1, "one page stood above the line");
    assert.equal(after.moves![0]!.from, a);
    assert.equal(after.moves![0]!.to, b);

    // Back to the session's own workspace: a move with no `to`.
    await set(s.id, null);
    const home = await store.read(s.id);
    assert.equal(home.workdir, undefined);
    assert.equal(home.moves?.length, 2);
    assert.equal(home.moves![1]!.to, undefined);

    // Setting the same directory again is not a move.
    await set(s.id, null);
    assert.equal((await store.read(s.id)).moves?.length, 2);
  } finally {
    await server.close();
    delete process.env.PERPETUAL_REPLAY;
    for (const d of [root, a, b]) await rm(d, { recursive: true, force: true });
  }
});
