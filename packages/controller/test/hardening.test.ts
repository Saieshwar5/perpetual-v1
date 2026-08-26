/**
 * The ceilings and the wire that carries "stop".
 *
 * Every one of these is a guard that was missing rather than a feature that
 * was wrong, so each test is written as the thing that used to happen: a stop
 * button that stopped nothing, a shell that could fill the disk, a session
 * that could grow without anyone noticing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onClientGone } from "../src/disconnect.ts";
import { ulimits } from "../src/shell/sandbox.ts";
import { script } from "../src/shell/tool.ts";
import { SessionStore } from "../src/sessions.ts";

/* ----------------------------------------------------- noticing the reader */

/**
 * Run a streaming request, disconnect the client mid-flight, and report which
 * listeners heard about it. A real socket, because the bug was entirely in
 * what Node does with real sockets.
 */
async function disconnectMidStream(
  wire: (req: IncomingMessage, res: ServerResponse, gone: () => void) => void,
): Promise<{ heard: boolean }> {
  return new Promise((resolve) => {
    let heard = false;
    const server = createServer(async (req, res) => {
      // The shape that hides the bug: consume the body FIRST, exactly as the
      // turn endpoint does, so `req` has already closed by the time anything
      // is attached to it.
      await new Promise<void>((r) => { req.on("data", () => {}); req.on("end", () => r()); });
      res.writeHead(200, { "content-type": "text/event-stream" });
      wire(req, res, () => { heard = true; });

      let n = 0;
      const timer = setInterval(() => {
        res.write(`data: ${++n}\n\n`);
        if (n === 8) {
          clearInterval(timer);
          res.end();
          server.close();
          resolve({ heard });
        }
      }, 60);
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const c = spawn("curl", ["-sN", "-XPOST", "-d", '{"input":"x"}', `http://127.0.0.1:${port}/`],
        { stdio: "ignore" });
      setTimeout(() => c.kill(), 200);        // the reader closes the tab
    });
  });
}

test("the reader going away is heard — the stop button depends on it", async () => {
  const { heard } = await disconnectMidStream(onClientGone);
  assert.equal(heard, true);
});

test("...and listening on `req` hears nothing, which is what shipped", async () => {
  // Kept as a test rather than a comment: this is the exact line that made the
  // stop button a lie and let a closed tab bill the user to completion.
  const { heard } = await disconnectMidStream((req, _res, gone) => {
    req.on("close", gone);
  });
  assert.equal(heard, false,
    "`req` is the body stream; its close already happened before this ran");
});

/* ------------------------------------------------------------- the ceilings */

test("a sandboxed command is capped on file size, processes, memory and cores", () => {
  const u = ulimits({ root: "/x", net: false, unsafe: false });
  assert.match(u, /-f 131072/, "128MB per file");
  assert.match(u, /-u 256/);
  assert.match(u, /-v 4194304/);
  assert.match(u, /-c 0/);
  assert.match(u, /\|\| true/, "a kernel that refuses one must not fail the command");
});

test("the process cap is dropped when unsandboxed, where it would be dangerous", () => {
  // RLIMIT_NPROC counts against the real user. Without bwrap's user namespace
  // to reset the count, 256 would be measured against every process the human
  // already has running, and the machine could stop forking.
  assert.doesNotMatch(ulimits({ root: "/x", net: false, unsafe: true }), /-u /);
});

test("the limits are set before anything the command starts", () => {
  const s = script("echo hi", "/session", "/session", ulimits({ root: "/x", net: false, unsafe: false }));
  assert.ok(s.indexOf("ulimit") < s.indexOf("echo hi"),
    "a limit applied after the command has already lost the argument");
});

/* --------------------------------------------------------------- disk held */

test("a session reports what it is holding, walking rather than trusting a total", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-size-"));
  const store = new SessionStore(root);
  const s = await store.create();
  const dir = join(store.siteDir(s.id), "ui", "pages", "001-x");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "page.ndjson"), "x".repeat(5000));
  await writeFile(join(store.siteDir(s.id), "workspace", "scratch.bin"), "y".repeat(20_000));

  const held = await store.size(s.id);
  assert.ok(held >= 25_000, `expected at least the two files, got ${held}`);
  assert.ok(held < 100_000, "and not the whole disk");
});

test("size counts nested directories, which is where a runaway would hide", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-size2-"));
  const store = new SessionStore(root);
  const s = await store.create();
  const deep = join(store.siteDir(s.id), "workspace", "a", "b", "c");
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "big.bin"), "z".repeat(50_000));
  assert.ok(await store.size(s.id) >= 50_000);
});

test("a session that is gone holds nothing, and does not throw", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-size3-"));
  assert.equal(await new SessionStore(root).size("nope"), 0);
});
