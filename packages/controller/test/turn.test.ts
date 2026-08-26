/**
 * The whole loop, end to end, with the replay runtime standing in for the
 * model. Everything else is real: the sandboxed shell runs, files land on
 * disk, the watcher diffs them, and the events are the ones the browser gets.
 *
 * What this proves is the claim the architecture rests on — that the page the
 * user SEES and the page PERSISTED on disk are the same page, arrived at by
 * one path rather than two that can drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions.ts";
import { createReplayRuntime } from "../src/replay-runtime.ts";
import { runTurn } from "../src/agent.ts";
import { readSite } from "../src/site.ts";
import { bwrapAvailable } from "../src/shell/sandbox.ts";

const skip = !bwrapAvailable() ? "bubblewrap is not installed" : false;

test("a turn writes a page, and what streamed equals what persisted", { skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "perp-turn-"));
  const store = new SessionStore(home);
  const s = await store.create();

  const stream = runTurn({
    ask: "how does the TCP handshake work",
    runtime: createReplayRuntime(),
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false },
    pastAsks: [],
  });

  const kinds: string[] = [];
  const types: string[] = [];
  let opened: string | null = null;
  for await (const ev of stream) {
    types.push(ev.type);
    if (ev.type === "page_open") opened = ev.page.id;
    if (ev.type === "page_block") kinds.push(ev.block.kind);
    if (ev.type === "error") assert.fail(ev.message);
  }
  await stream.summary;

  assert.equal(opened, "001-how-does-the-tcp");
  assert.ok(types.includes("tool_start") && types.includes("tool_end"));
  assert.ok(kinds.length >= 5, `streamed ${kinds.length} blocks`);
  assert.equal(kinds[0], "heading");

  const site = await readSite(store.siteDir(s.id));
  assert.equal(site.pages.length, 1);
  assert.equal(site.problems.length, 0, JSON.stringify(site.problems));
  assert.deepEqual(
    site.pages[0]!.blocks.map((b) => b.kind), kinds,
    "the rendered page and the stored page are the same page",
  );

  await rm(home, { recursive: true, force: true });
});

test("a second turn takes the next number without being told", { skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "perp-turn2-"));
  const store = new SessionStore(home);
  const s = await store.create();
  const sandbox = { root: store.siteDir(s.id), net: false, unsafe: false };
  const runtime = createReplayRuntime();

  for await (const _ of runTurn({ ask: "first question here", runtime, sandbox, pastAsks: [] })) { /* drain */ }
  for await (const _ of runTurn({
    ask: "second question here", runtime, sandbox, pastAsks: ["first question here"],
  })) { /* drain */ }

  const site = await readSite(store.siteDir(s.id));
  assert.deepEqual(site.pages.map((p) => p.id), ["001-first-question-here", "002-second-question-here"]);
  await rm(home, { recursive: true, force: true });
});

test("the agent's own record is not inside its sandbox", { skip }, async () => {
  // session.json and transcript.jsonl sit beside `site/`, not in it. The agent
  // has full authority over its world and none over the record of what it did.
  const home = await mkdtemp(join(tmpdir(), "perp-reach-"));
  const store = new SessionStore(home);
  const s = await store.create();
  await store.appendTurn(s.id, {
    at: "now", ask: "x", touched: [], commands: [], steps: 0,
  });

  const { createShell } = await import("../src/shell/tool.ts");
  const sh = createShell({ root: store.siteDir(s.id), net: false, unsafe: false });
  const r = await sh.run({ command: "ls -R / 2>/dev/null | grep -c transcript.jsonl || echo 0" });
  assert.match(r.text, /^0/m, "the transcript is not reachable from inside");

  await rm(home, { recursive: true, force: true });
});

test("an anchored ask reaches the model as a referent", { skip }, async () => {
  // Proves the wiring the invoked composer exists for: the page and block the
  // reader was looking at travel with the question.
  const home = await mkdtemp(join(tmpdir(), "perp-anchor-"));
  const store = new SessionStore(home);
  const s = await store.create();
  const sandbox = { root: store.siteDir(s.id), net: false, unsafe: false };

  for await (const _ of runTurn({
    ask: "how does a WAL work", runtime: createReplayRuntime(), sandbox, pastAsks: [],
  })) { /* drain */ }

  // A runtime that records what it was told and then stops.
  let seen = "";
  const spy = {
    modelId: "spy", providerId: "spy",
    conversation: () => ({
      user(text: string) { if (!seen) seen = text; },
      toolResult() {},
      step: () => Object.assign((async function* () { /* no calls */ })(), {
        result: async () => ({
          calls: [], usage: { input: 0, output: 0, cacheRead: 0, costUsd: 0 }, stopReason: "stop",
        }),
      }),
    }),
  };

  for await (const _ of runTurn({
    ask: "that number is wrong",
    runtime: spy as never, sandbox, pastAsks: ["how does a WAL work"],
    anchor: { page: "001-how-does-a-wal", index: 1 },
  })) { /* drain */ }

  assert.match(seen, /asking from \*\*001-how-does-a-wal\*\*/);
  assert.match(seen, /looking at a prose block/);
  assert.match(seen, /that number is wrong/);
  await rm(home, { recursive: true, force: true });
});

test("stopping a turn kills the work, not just the stream", { skip }, async () => {
  // The stop button aborts the request; the server aborts the turn; the shell
  // kills the whole process group. A command left running would be invisible.
  const home = await mkdtemp(join(tmpdir(), "perp-stop-"));
  const store = new SessionStore(home);
  const s = await store.create();
  const ac = new AbortController();

  const slow = {
    modelId: "slow", providerId: "slow",
    conversation: () => ({
      user() {}, toolResult() {},
      step: () => Object.assign((async function* () { /* nothing to stream */ })(), {
        result: async () => ({
          calls: [{ id: "c1", name: "shell", args: { command: "sleep 45" } }],
          usage: { input: 0, output: 0, cacheRead: 0, costUsd: 0 }, stopReason: "toolUse",
        }),
      }),
    }),
  };

  const started = Date.now();
  const stream = runTurn({
    ask: "something slow", runtime: slow as never,
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false },
    pastAsks: [], signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 400);
  for await (const _ of stream) { /* drain */ }
  await stream.summary;

  assert.ok(Date.now() - started < 8000, "the turn ended promptly, not after 45s");

  const { createShell } = await import("../src/shell/tool.ts");
  const sh = createShell({ root: store.siteDir(s.id), net: false, unsafe: false });
  const check = await sh.run({ command: "pgrep -a sleep || echo CLEAN" });
  assert.match(check.text, /CLEAN/, "no command survived the stop");

  await rm(home, { recursive: true, force: true });
});

test("server paths are anchored to the module, not the cwd", async () => {
  // Regression: `pnpm dev` runs the server from packages/controller, so a
  // cwd-relative client path resolved to packages/controller/packages/client
  // and every static fetch 404'd.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const uses = src.split("\n").filter((l) => l.includes("process.cwd()") && !l.trim().startsWith("//"));
  assert.deepEqual(uses, [], "server.ts must not resolve paths from process.cwd()");
});
