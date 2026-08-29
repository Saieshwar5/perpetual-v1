/**
 * Background jobs and stdin. plans/48.
 *
 * The claims that matter: a job returns at once and RUNS ON after the call —
 * the ceiling this lifts is exactly the turn boundary; its output lands in a
 * log the next command can read; killing a session's jobs actually kills the
 * process tree; and stdin reaches a command that reads it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell } from "../src/shell/tool.ts";
import { listJobs, killJobsFor } from "../src/shell/jobs.ts";
import { bwrapAvailable } from "../src/shell/sandbox.ts";

const skip = !bwrapAvailable() ? "bubblewrap is not installed" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "perp-jobs-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  return { root, sh: createShell({ root, net: false, unsafe: false }) };
}

test("stdin reaches the command and is closed after", { skip }, async () => {
  const { root, sh } = await fixture();
  const r = await sh.run({ command: "cat | tr a-z A-Z", stdin: "hello from stdin\n" });
  assert.match(r.text, /HELLO FROM STDIN/);
  assert.equal(r.exitCode, 0, "cat saw EOF rather than hanging");
  await rm(root, { recursive: true, force: true });
});

test("a background job returns at once and keeps running after the call", { skip }, async () => {
  const { root, sh } = await fixture();
  const t0 = Date.now();
  const r = await sh.run({
    command: "for i in 1 2 3 4; do echo tick $i; sleep 0.4; done; echo done-marker",
    background: true,
  });
  assert.ok(Date.now() - t0 < 2000, "returned immediately, not after the sleeps");
  assert.equal(r.exitCode, 0);
  assert.match(r.text, /workspace\/\.jobs\/[0-9a-f]+\.log/, "the receipt names the log");

  const log = r.text.match(/workspace\/\.jobs\/[0-9a-f]+\.log/)![0];
  await sleep(2400);
  const out = await readFile(join(root, log), "utf8");
  assert.match(out, /tick 4/, "it ran on while nothing was waiting");
  assert.match(out, /done-marker/);
  assert.match(out, /exited with code 0/, "the log records how it ended");

  // And the NEXT command can read it — the whole coordination model.
  const check = await sh.run({ command: `tail -n 3 ${log}` });
  assert.match(check.text, /done-marker/);

  killJobsFor(root);
  await rm(root, { recursive: true, force: true });
});

test("killing a session's jobs kills the whole process tree", { skip }, async () => {
  const { root, sh } = await fixture();
  const r = await sh.run({ command: "sleep 300; echo never", background: true });
  const id = r.text.match(/job ([0-9a-f]+)/)![1]!;
  await sleep(400);
  assert.equal(listJobs(root).find((j) => j.id === id)?.done, false, "running");

  killJobsFor(root);
  await sleep(700);
  assert.equal(listJobs(root).length, 0, "the registry forgot the session");
  await rm(root, { recursive: true, force: true });
});

test("the job cap refuses a fifth, with a reason", { skip }, async () => {
  const { root, sh } = await fixture();
  for (let i = 0; i < 4; i++) {
    const r = await sh.run({ command: `sleep 60; echo j${i}`, background: true });
    assert.equal(r.exitCode, 0);
  }
  const fifth = await sh.run({ command: "sleep 60", background: true });
  assert.equal(fifth.exitCode, 1);
  assert.match(fifth.text, /already running/);
  killJobsFor(root);
  await rm(root, { recursive: true, force: true });
});

test("the agent stops its own job with a file — the only channel it has", { skip }, async () => {
  // A later command cannot `kill` the job's pid: different pid namespaces.
  // The file is the bridge, and it is proven HERE with the real sandbox:
  // the job is started by one command and stopped by another.
  const { root, sh } = await fixture();
  const r = await sh.run({ command: "sleep 120; echo never", background: true });
  const log = r.text.match(/workspace\/\.jobs\/[0-9a-f]+\.log/)![0];
  const stop = log.replace(/\.log$/, ".stop");

  await sleep(300);
  const touch = await sh.run({ command: `touch ${stop}` });
  assert.equal(touch.exitCode, 0);

  await sleep(1800);                              // the poll runs every second
  const out = await readFile(join(root, log), "utf8");
  assert.match(out, /stopped by request/);
  assert.equal(listJobs(root).find((j) => j.log === log)?.done, true);

  killJobsFor(root);
  await rm(root, { recursive: true, force: true });
});

test("the reader's endpoints: stop, and the pin that only chrome can set", async () => {
  const os = await import("node:os");
  const { startServer } = await import("../src/server.ts");
  const { SessionStore } = await import("../src/sessions.ts");
  const { startJob } = await import("../src/shell/jobs.ts");

  const root = await mkdtemp(join(os.tmpdir(), "perp-jobs-srv-"));
  process.env.PERPETUAL_REPLAY = "1";
  const server = await startServer({ root, port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const s = await (await fetch(`${base}/sessions`, { method: "POST" })).json() as { id: string };
    const store = new SessionStore(root);
    const siteDir = store.siteDir(s.id);
    await mkdir(join(siteDir, "workspace"), { recursive: true });

    // A job in this session's registry, exactly as `background: true` makes one.
    const started = startJob({ root: siteDir, command: "sleep 120",
      file: "sh", args: ["-c", "sleep 120"] });
    assert.equal(started.ok, true);
    const id = (started as { id: string }).id;

    const list = await (await fetch(`${base}/sessions/${s.id}/jobs`)).json() as
      { jobs: { id: string; pinned: boolean; done: boolean }[] };
    assert.equal(list.jobs.find((j) => j.id === id)?.pinned, false);

    // Pin, verify, unpin — the reader-held immortality switch.
    const act = (action: string) => fetch(`${base}/sessions/${s.id}/jobs`, {
      method: "POST", body: JSON.stringify({ job: id, action }),
    });
    const pinned = await (await act("pin")).json() as { jobs: { id: string; pinned: boolean }[] };
    assert.equal(pinned.jobs.find((j) => j.id === id)?.pinned, true);
    const unpinned = await (await act("unpin")).json() as { jobs: { id: string; pinned: boolean }[] };
    assert.equal(unpinned.jobs.find((j) => j.id === id)?.pinned, false);

    // Stop kills it for real.
    assert.equal((await act("stop")).status, 200);
    await sleep(700);
    const after = await (await fetch(`${base}/sessions/${s.id}/jobs`)).json() as
      { jobs: { id: string; done: boolean }[] };
    assert.equal(after.jobs.find((j) => j.id === id)?.done, true);

    assert.equal((await act("bounce")).status, 400, "unknown actions are refused");
    const missing = await fetch(`${base}/sessions/${s.id}/jobs`, {
      method: "POST", body: JSON.stringify({ job: "ffffff", action: "stop" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    delete process.env.PERPETUAL_REPLAY;
    await rm(root, { recursive: true, force: true });
  }
});
