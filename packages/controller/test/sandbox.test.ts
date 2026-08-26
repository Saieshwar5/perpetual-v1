/**
 * These are the tests that decide whether the harness is safe to point at a
 * model. Every one checks a containment claim made in plans/15 §5, and every
 * failure here is silent in production — the agent would simply have more
 * reach than intended and nothing would look wrong.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell } from "../src/shell/tool.ts";
import { bwrapAvailable } from "../src/shell/sandbox.ts";

const skip = !bwrapAvailable() ? "bubblewrap is not installed" : false;
const MARK = String.fromCharCode(1);

let root: string;
let sh: ReturnType<typeof createShell>;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "perp-test-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  sh = createShell({ root, net: false, unsafe: false });
});
after(async () => { await rm(root, { recursive: true, force: true }); });

test("the API key is invisible from inside", { skip }, async () => {
  process.env.PERP_FAKE_KEY = "sk-ant-do-not-leak";
  const r = await sh.run({ command: "env" });
  assert.doesNotMatch(r.text, /do-not-leak/);
  assert.doesNotMatch(r.text, /PERP_FAKE_KEY/);
  delete process.env.PERP_FAKE_KEY;
});

test("the home directory does not exist in the namespace", { skip }, async () => {
  const r = await sh.run({ command: "ls /home; ls ~/.ssh" });
  assert.match(r.text, /No such file or directory/);
});

test("only the session directory is writable", { skip }, async () => {
  const r = await sh.run({ command: "touch /usr/x; touch /etc/x; echo -n" });
  assert.equal((r.text.match(/Read-only file system/g) ?? []).length, 2);

  const w = await sh.run({ command: "echo inside > proof.txt && cat proof.txt" });
  assert.match(w.text, /inside/);
  assert.equal(await readFile(join(root, "proof.txt"), "utf8"), "inside\n");
});

test("there is no network", { skip }, async () => {
  const r = await sh.run({ command: "getent hosts example.com || echo NO-DNS", timeoutSec: 8 });
  assert.match(r.text, /NO-DNS/);
});

test("cd persists between commands, exports do not", { skip }, async () => {
  await sh.run({ command: "mkdir -p ui/pages && cd ui/pages" });
  const r = await sh.run({ command: "pwd" });
  assert.match(r.text, /\/session\/ui\/pages/);

  await sh.run({ command: "export SECRET=abc" });
  const e = await sh.run({ command: 'echo "[${SECRET:-unset}]"' });
  assert.match(e.text, /\[unset\]/, "the tool description promises exactly this");
  await sh.run({ command: "cd /session" });
});

test("a timeout kills the whole process tree and still returns output", { skip }, async () => {
  const started = Date.now();
  const r = await sh.run({ command: "echo begun; sleep 30; echo never", timeoutSec: 2 });
  assert.ok(Date.now() - started < 6000, "returned promptly");
  assert.equal(r.killed, true);
  assert.match(r.text, /begun/, "output before the kill survives");
  assert.doesNotMatch(r.text, /never/);
});

test("a backgrounded grandchild does not outlive the command", { skip }, async () => {
  await sh.run({ command: "bash -c 'sleep 45 &' ; echo spawned" });
  await new Promise((r) => setTimeout(r, 400));
  // --unshare-pid + --die-with-parent means the namespace collects it. Killing
  // only the direct child would leave this running for 45 seconds.
  const check = await sh.run({ command: "pgrep -a sleep || echo CLEAN" });
  assert.match(check.text, /CLEAN/);
});

test("exit codes are reported verbatim", { skip }, async () => {
  assert.match((await sh.run({ command: "exit 3" })).text, /exit code: 3/);
  assert.match((await sh.run({ command: "grep zzz /dev/null" })).text, /exit code: 1/);
  assert.match((await sh.run({ command: "true" })).text, /exit code: 0/);
});

test("stderr is interleaved with stdout in shell order", { skip }, async () => {
  const r = await sh.run({ command: "echo one; echo two >&2; echo three" });
  assert.match(r.text, /one\ntwo\nthree/);
});

test("the cwd marker never reaches the reader", { skip }, async () => {
  const r = await sh.run({ command: "echo visible" });
  assert.ok(!r.text.includes(MARK), "not in the result");
  let streamed = "";
  await sh.run({ command: "echo streamed", onOutput: (c) => { streamed += c; } });
  assert.ok(!streamed.includes(MARK), "not in the live stream either");
  assert.match(streamed, /streamed/);
});
