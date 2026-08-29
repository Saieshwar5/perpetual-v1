/**
 * Grants: the reader widens what a session may write, one directory at a time.
 * plans/45.
 *
 * The whole safety argument is about WHO ANSWERS. The agent writes a `grant`
 * block — a request, drawn on the page — and the answer travels a route no
 * command in the sandbox can reach. So these tests are about the gates on
 * that route and about the sandbox honouring what came through it. A grant
 * the agent could write for itself would be no grant at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlock, IMAGE_RE } from "@perpetual/shared/blocks";
import { sandboxEnv, wrapCommand, sessionWorkspace } from "../src/shell/sandbox.ts";

const err = (v: unknown) => (validateBlock(v) as { error: string }).error;

/* ------------------------------------------------------------- the block */

test("a grant names one directory and says why", () => {
  const v = validateBlock({
    kind: "grant", path: "~/Downloads",
    reason: "to rename the seven resumes in place",
  });
  assert.equal(v.ok, true);
});

test("a path must be a real place, named in full", () => {
  assert.match(err({ kind: "grant", path: "Downloads", reason: "x" }),
    /absolute or start with/);
  assert.match(err({ kind: "grant", path: "~/../../etc", reason: "x" }),
    /cannot contain/);
  assert.match(err({ kind: "grant", path: "~/Downloads" }),
    /`reason` must say what you would do/);
});

/* ----------------------------------------------------------- the sandbox */

const cfg = { root: "/tmp/sess", net: false, unsafe: false };

test("a session with no chosen directory still has somewhere to write", () => {
  const env = sandboxEnv(cfg);
  assert.equal(env.PERPETUAL_WORKDIR, "/session/workspace",
    "its own — never nothing, and never another session's");
  assert.equal(env.PERPETUAL_GRANTS, undefined);
});

test("a chosen directory wins, and grants ride beside it", () => {
  const env = sandboxEnv({ ...cfg, workdir: "/home/x/proj", grants: ["/home/x/Downloads"] });
  assert.equal(env.PERPETUAL_WORKDIR, "/home/x/proj");
  assert.equal(env.PERPETUAL_GRANTS, "/home/x/Downloads");
});

test("every granted directory is bound writable, by name", () => {
  const { args } = wrapCommand("true",
    { ...cfg, grants: ["/home/x/Downloads", "/home/x/Documents"] }, {});
  for (const dir of ["/home/x/Downloads", "/home/x/Documents"]) {
    const at = args.indexOf(dir);
    assert.notEqual(at, -1, `${dir} is mounted`);
    assert.equal(args[at - 1], "--bind", "writable, not --ro-bind");
  }
});

test("nothing is bound when nothing was granted", () => {
  const { args } = wrapCommand("true", cfg, {});
  assert.equal(args.filter((a) => a === "--bind").length, 1,
    "only the session's own record");
});

test("the session's workspace is inside the mount, so it needs no bind at all", () => {
  assert.ok(sessionWorkspace(cfg).startsWith("/session/"),
    "reachable from inside the sandbox and from nowhere else");
});

/* ------------------------------------------------------------- pictures */

test("an image name cannot climb out of the page directory", () => {
  assert.equal(IMAGE_RE.test("page-1.png"), true);
  assert.equal(IMAGE_RE.test("shot.jpeg"), true);
  for (const bad of ["../secret.png", "/etc/x.png", "a/b.png", ".hidden.png",
                     "x.svg", "x.png.sh", "x"]) {
    assert.equal(IMAGE_RE.test(bad), false, `${bad} is refused`);
  }
});

/* ------------------------------------------------------------ the route */

/**
 * The endpoint, live. This is the one that carries the security claim, so it
 * is tested against the real server rather than against a description of it.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { SessionStore } from "../src/sessions.ts";

test("only a directory the agent ASKED for, and the reader saw, can be granted", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-grant-srv-"));
  // Somewhere real, inside home, that this test owns.
  const target = join(homedir(), ".perpetual-grant-test");
  await mkdir(target, { recursive: true });

  process.env.PERPETUAL_REPLAY = "1";
  const server = await startServer({ root, port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

  try {
    const s = await (await fetch(`${base}/sessions`, { method: "POST" })).json() as { id: string };
    const store = new SessionStore(root);

    // Nothing has been asked for yet: a grant request is refused outright.
    // This is the gate that matters — without it, anything that can reach the
    // endpoint can widen the sandbox.
    const early = await post(`/sessions/${s.id}/grant`, { path: target });
    assert.equal(early.status, 400);
    assert.match((await early.json() as { error: string }).error, /Nothing on this site asked/);

    // The agent asks, on a page the reader can see.
    const dir = join(store.siteDir(s.id), "ui", "pages", "001-ask");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "Ask", ask: "x" }));
    await writeFile(join(dir, "page.ndjson"),
      JSON.stringify({ kind: "grant", path: target, reason: "to rename them in place" }) + "\n");

    // Outside the home directory is refused however loudly it is asked for.
    const outside = await post(`/sessions/${s.id}/grant`, { path: "/etc" });
    assert.equal(outside.status, 400);

    // A directory that does not exist is refused: bwrap cannot bind nothing.
    const missing = await post(`/sessions/${s.id}/grant`, { path: `${target}/nope` });
    assert.equal(missing.status, 400);

    // The one that was asked for, and only that one.
    const ok = await post(`/sessions/${s.id}/grant`, { path: target });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as { grants: string[] }).grants, [target]);
    assert.deepEqual((await store.read(s.id)).grants, [target], "and it is persisted");

    // Twice is once: the reader allowing the same directory again is not two.
    await post(`/sessions/${s.id}/grant`, { path: target });
    assert.deepEqual((await store.read(s.id)).grants, [target]);
  } finally {
    await server.close();
    delete process.env.PERPETUAL_REPLAY;
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("a grant can be taken back, and the record says where", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-revoke-"));
  const target = join(homedir(), ".perpetual-revoke-test");
  await mkdir(target, { recursive: true });

  process.env.PERPETUAL_REPLAY = "1";
  const server = await startServer({ root, port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

  try {
    const s = await (await fetch(`${base}/sessions`, { method: "POST" })).json() as { id: string };
    const store = new SessionStore(root);

    // Asked for on a page, granted — the setup the revoke undoes.
    const dir = join(store.siteDir(s.id), "ui", "pages", "001-ask");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "Ask", ask: "x" }));
    await writeFile(join(dir, "page.ndjson"),
      JSON.stringify({ kind: "grant", path: target, reason: "to rename them" }) + "\n");
    await post(`/sessions/${s.id}/grant`, { path: target });
    assert.deepEqual((await store.read(s.id)).grants, [target]);

    // Revoking needs none of granting's gates — narrowing is always allowed.
    const r = await post(`/sessions/${s.id}/grant`, { path: target, revoke: true });
    assert.equal(r.status, 200);
    const after = await store.read(s.id);
    assert.equal(after.grants, undefined, "the list empties out entirely");
    assert.equal(after.moves?.at(-1)?.revoked, target, "and the flow will say where");

    // Revoking what is not granted is an error, not a shrug.
    const again = await post(`/sessions/${s.id}/grant`, { path: target, revoke: true });
    assert.equal(again.status, 400);

    // The full circle: it can be granted again — the request is still on the page.
    const back = await post(`/sessions/${s.id}/grant`, { path: target });
    assert.equal(back.status, 200);
    assert.deepEqual((await store.read(s.id)).grants, [target]);
  } finally {
    await server.close();
    delete process.env.PERPETUAL_REPLAY;
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
