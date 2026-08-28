/**
 * These are the tests that decide whether the harness is safe to point at a
 * model. Every one checks a containment claim, and every failure here is
 * silent in production — the agent would simply have more reach than intended
 * and nothing would look wrong.
 *
 * The claims changed with plans/37. The sandbox now READS the whole disk on
 * purpose, so the tests that mattered under the old posture ("no home
 * directory", "nothing outside the session exists") no longer describe
 * anything true. What replaced them is narrower and, being narrower, worth
 * more: secrets are absent, writes are confined to two named places, and the
 * controller's own record cannot be edited by the thing it is a record of.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
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
  await mkdir(join(root, "ui", "pages"), { recursive: true });
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

test("the home directory is readable — that is the point of plans/37", { skip }, async () => {
  const r = await sh.run({ command: "ls ~ >/dev/null && echo READABLE" });
  assert.match(r.text, /READABLE/);
});

test("…and secrets in it are EMPTY, not forbidden", { skip }, async () => {
  // Absent rather than protected: a directory that is not in the namespace
  // cannot be reached by a clever command, an unlucky glob, or an agent that
  // was talked into it by something it read. Only paths that exist on this
  // machine are checked — an absent one is already the outcome we want.
  const r = await sh.run({
    command: 'for d in ~/.ssh ~/.gnupg ~/.aws ~/.config/gh; do ' +
      '[ -d "$d" ] && echo "$d:$(ls -A "$d" | wc -l)"; done; echo END',
  });
  for (const line of r.text.split("\n")) {
    const m = /^(\S+):(\d+)$/.exec(line.trim());
    if (m) assert.equal(m[2], "0", `${m[1]} is not empty inside the sandbox`);
  }
});

test("the home directory is NOT writable", { skip }, async () => {
  const r = await sh.run({ command: "touch ~/perp-should-fail 2>&1; echo -n" });
  assert.match(r.text, /Read-only file system/);
});

test("with no working directory, only the session is writable", { skip }, async () => {
  const r = await sh.run({ command: "touch /usr/x; touch /etc/x; echo -n" });
  assert.equal((r.text.match(/Read-only file system/g) ?? []).length, 2);

  const w = await sh.run({ command: "echo inside > /session/proof.txt && cat /session/proof.txt" });
  assert.match(w.text, /inside/);
  assert.equal(await readFile(join(root, "proof.txt"), "utf8"), "inside\n");
});

test("a chosen working directory is writable, and it is the only addition", { skip }, async () => {
  const work = await mkdtemp(join(tmpdir(), "perp-work-"));
  const outside = await mkdtemp(join(tmpdir(), "perp-outside-"));
  const w = createShell({ root, net: false, unsafe: false, workdir: work });

  const there = await w.run({ command: "pwd; echo yes > made.txt && cat made.txt" });
  assert.match(there.text, new RegExp(work), "a command starts where the reader is working");
  assert.equal(await readFile(join(work, "made.txt"), "utf8"), "yes\n");

  // Choosing one directory does not quietly open anywhere else. A neighbour in
  // /tmp does not even exist inside — /tmp is a fresh tmpfs — and a real path
  // that does exist is read-only. Both are refusals; only the wording differs.
  const no = await w.run({ command: `touch ${outside}/x 2>&1; touch ~/x 2>&1; echo -n` });
  assert.match(no.text, /No such file or directory/);
  assert.match(no.text, /Read-only file system/);
  assert.doesNotMatch(no.text, /^touch: cannot touch.*\n?$/,
    "neither write may quietly succeed");

  await rm(work, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("the controller's own record cannot be written, even from inside a workdir", { skip }, async () => {
  // The sessions root lives inside the repo by default. A reader who picks
  // that repo to work in would otherwise be handing the agent session.json —
  // the file that records which sections are sealed.
  const work = await mkdtemp(join(tmpdir(), "perp-repo-"));
  const sessions = join(work, ".perpetual");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "session.json"), '{"open":[]}');

  const w = createShell({
    root, net: false, unsafe: false, workdir: work, sessionsRoot: sessions,
  });
  const r = await w.run({
    command: `echo hacked > ${sessions}/session.json 2>&1; ` +
             `rm -rf ${sessions} 2>&1; echo -n`,
  });
  assert.match(r.text, /Read-only file system/);
  assert.equal(await readFile(join(sessions, "session.json"), "utf8"), '{"open":[]}');
  await rm(work, { recursive: true, force: true });
});

test("network off means no network AND no resolver", { skip }, async () => {
  // --unshare-net removes the network, not the resolver: systemd-resolved is
  // reached over a unix socket, and unix sockets are not network-namespaced.
  // A sandbox that can still look names up can still SEND, one lookup at a
  // time. This test caught exactly that when /run started coming from the host.
  const r = await sh.run({ command: "getent hosts example.com || echo NO-DNS", timeoutSec: 10 });
  assert.match(r.text, /NO-DNS/);
});

test("cd persists between commands, exports do not", { skip }, async () => {
  await sh.run({ command: "cd /session/ui/pages" });
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

/* --------------------------------------------------- the published record */

/**
 * The seal, checked the only way that means anything: by trying to break it
 * with a shell.
 *
 * The rule lives in the kernel rather than in the prompt or the `page` program
 * because the agent has a whole shell — the scorecard caught the model running
 * `sed -i` on a page file and writing its own editor when it lacked a tool. So
 * every route in is tried here, including the two that bypass every check the
 * controller could make: a redirect, and deleting the directory outright.
 */
test("a published section cannot be changed by any command", { skip }, async () => {
  const site = await mkdtemp(join(tmpdir(), "perp-sealed-"));
  const page = join(site, "ui", "pages", "001-margins");
  await mkdir(page, { recursive: true });
  await writeFile(join(page, "meta.json"), '{"title":"Margins","ask":"how?"}');
  const original = '{"kind":"heading","id":"claim","text":"Margins held"}\n';
  await writeFile(join(page, "page.ndjson"), original);

  const sealed = createShell({ root: site, net: false, unsafe: false, sealed: ["001-margins"] });
  try {
    for (const command of [
      "echo tampered > ui/pages/001-margins/page.ndjson",
      "echo tampered >> ui/pages/001-margins/page.ndjson",
      "sed -i s/held/fell/ ui/pages/001-margins/page.ndjson",
      "rm -f ui/pages/001-margins/page.ndjson",
      "rm -rf ui/pages/001-margins",
      "mv ui/pages/001-margins ui/pages/009-moved",
      "python3 -c \"open('ui/pages/001-margins/page.ndjson','w').write('x')\"",
      "touch ui/pages/001-margins/new-file",
    ]) {
      const r = await sh_run(sealed, command);
      assert.notEqual(r.exitCode, 0, `\`${command}\` was allowed`);
    }
    assert.equal(await readFile(join(page, "page.ndjson"), "utf8"), original,
      "the section the reader read is exactly as it was published");
  } finally {
    await rm(site, { recursive: true, force: true });
  }
});

test("a section that is NOT published is still fully writable", { skip }, async () => {
  const site = await mkdtemp(join(tmpdir(), "perp-open-"));
  await mkdir(join(site, "ui", "pages", "001-open"), { recursive: true });
  const sh2 = createShell({ root: site, net: false, unsafe: false, sealed: [] });
  try {
    const r = await sh_run(sh2, "echo '{\"kind\":\"prose\",\"text\":\"hi\"}' "
      + "> ui/pages/001-open/page.ndjson && wc -l < ui/pages/001-open/page.ndjson");
    assert.equal(r.exitCode, 0, r.text);
    assert.match(r.text, /1/);
  } finally {
    await rm(site, { recursive: true, force: true });
  }
});

test("a new section can still be created beside the sealed ones", { skip }, async () => {
  const site = await mkdtemp(join(tmpdir(), "perp-grow-"));
  await mkdir(join(site, "ui", "pages", "001-old"), { recursive: true });
  await writeFile(join(site, "ui", "pages", "001-old", "page.ndjson"), "{}\n");
  const sh3 = createShell({ root: site, net: false, unsafe: false, sealed: ["001-old"] });
  try {
    const r = await sh_run(sh3,
      "mkdir -p ui/pages/002-new && echo hello > ui/pages/002-new/page.ndjson && echo ok");
    assert.equal(r.exitCode, 0, r.text);
    assert.match(r.text, /ok/, "the site grows even though nothing in it may change");
  } finally {
    await rm(site, { recursive: true, force: true });
  }
});

/** The shell's own signature, kept in one place so the cases above stay readable. */
function sh_run(shell: ReturnType<typeof createShell>, command: string) {
  return shell.run({ command });
}
