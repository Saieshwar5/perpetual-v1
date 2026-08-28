/**
 * The escape hatch. plans/36.
 *
 * This is the one feature in the codebase whose tests are almost entirely about
 * what happens when it is OFF, and that is deliberate. A switch that grants a
 * model a mailbox is not dangerous because of what it does when asked for — it
 * is dangerous if it can arrive without being asked for, or if a session can be
 * unlocked without anyone being able to tell.
 *
 * So:
 *
 *   LOCKED IS THE DEFAULT, AND IS SILENT. No environment, no mount, no
 *   credential variable, nothing on the PATH that works.
 *
 *   IT CANNOT ARRIVE SIDEWAYS. It is named rather than boolean, and it does not
 *   turn on the network even though it is useless without it.
 *
 *   A BROKEN UNLOCK IS A REFUSAL. Never a quiet fall back to locked: a test
 *   session that silently re-locked is one where the results mean nothing.
 *
 *   AN UNLOCKED SESSION SAYS SO. The string the chrome renders has to carry it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wrapCommand, describeSandbox, sandboxEnv, HOST_MOUNT, GWS_CONFIG_MOUNT,
  type SandboxConfig, type Unlocked,
} from "../src/shell/sandbox.ts";
import { resolveUnlocked, findGws, TEST_PROFILE } from "../src/unlocked.ts";
import { adaptersDir, readAdapters } from "../src/adapters.ts";

const LOCKED: SandboxConfig = { root: "/tmp/site", net: false, unsafe: false };
const OPEN: Unlocked = { what: "gws", bin: "/host/gws", configDir: "/host/conf" };

const argvOf = (cfg: SandboxConfig) => wrapCommand("true", cfg).args.join(" ");

/* ------------------------------------------------------- locked by default */

test("with nothing set, nothing is unlocked", async () => {
  assert.equal(await resolveUnlocked({}), null);
  assert.equal(await resolveUnlocked({ PERPETUAL_UNLOCKED: "" }), null);
  assert.equal(await resolveUnlocked({ PERPETUAL_UNLOCKED: "  " }), null);
});

test("a locked sandbox mounts no host binary and names no credential", () => {
  const args = argvOf(LOCKED);
  assert.doesNotMatch(args, new RegExp(HOST_MOUNT));
  assert.doesNotMatch(args, new RegExp(GWS_CONFIG_MOUNT));
  assert.doesNotMatch(args, /GOOGLE_WORKSPACE_CLI/);
  assert.doesNotMatch(args, /PERPETUAL_GWS_HOST/);
  // And the environment agrees, which is the half a mount test would miss.
  assert.deepEqual(
    Object.keys(sandboxEnv("/session")).filter((k) => /GOOGLE|GWS/.test(k)), []);
});

test("unlocking is named, so the next hatch cannot ride in on this one", async () => {
  const r = await resolveUnlocked({ PERPETUAL_UNLOCKED: "1" });
  assert.ok(r && "error" in r);
  assert.match(r.error, /only thing this server knows how to unlock is `gws`/);

  for (const asked of ["everything", "true", "gws,drive", "GWS"]) {
    const bad = await resolveUnlocked({ PERPETUAL_UNLOCKED: asked });
    assert.ok(bad && "error" in bad, `${asked} must not unlock anything`);
  }
});

test("unlocking does not turn on the network", () => {
  // gws is useless without it, and that is exactly why this must stay separate:
  // one switch implying another is how a grant arrives unnoticed.
  const args = argvOf({ ...LOCKED, unlocked: OPEN });
  assert.match(args, /--unshare-net/);
});

test("a missing credential is a refusal, with the command that makes one", async () => {
  const r = await resolveUnlocked({
    PERPETUAL_UNLOCKED: "gws",
    PERPETUAL_GWS_BIN: process.execPath,          // a real ELF, so this is not what fails
    PERPETUAL_GWS_TEST_DIR: "/nowhere/at/all",
  });
  assert.ok(r && "error" in r);
  assert.match(r.error, /gws auth login --services gmail/);
  // --services gmail on purpose: full mail, but no Drive and no cloud-platform.
  assert.match(r.error, /throwaway/, "it says to consider a spare account");
  assert.ok(!("unlocked" in r), "never a silent fall back to locked");
});

test("a missing binary is a refusal too, not a locked session", async () => {
  const r = await resolveUnlocked({ PERPETUAL_UNLOCKED: "gws", PERPETUAL_GWS_BIN: "/no/such" });
  assert.ok(r && "error" in r);
  assert.match(r.error, /no gws binary was found/);
});

/* ---------------------------------------------------------- when it is on */

test("an unlocked sandbox mounts the binary read-only and its credential writable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perp-unlock-"));
  await mkdir(join(dir, "conf"), { recursive: true });
  const cfg = { ...LOCKED, net: true, unlocked: { ...OPEN, configDir: join(dir, "conf") } };
  const args = wrapCommand("true", cfg).args;

  const bin = args.indexOf(`${HOST_MOUNT}/gws`);
  assert.ok(bin > 0);
  assert.equal(args[bin - 2], "--ro-bind", "the binary is never writable");
  assert.equal(args[bin - 1], "/host/gws");

  const conf = args.indexOf(GWS_CONFIG_MOUNT);
  assert.equal(args[conf - 2], "--bind", "gws caches refreshed tokens, so this must be writable");

  // The binary, not the directory it lives in: a directory bind would put an
  // installer script and a package manifest in reach for no reason.
  assert.ok(!args.includes("/host"), "only the one file");
  await rm(dir, { recursive: true, force: true });
});

test("an unlocked session says so in the string the chrome renders", () => {
  const said = describeSandbox({ ...LOCKED, net: true, unlocked: OPEN });
  assert.match(said, /^GWS UNLOCKED/, "first, and in capitals");
  assert.match(describeSandbox(LOCKED), /^bubblewrap/);
  assert.doesNotMatch(describeSandbox(LOCKED), /UNLOCKED/);
});

test("the real gws is found through its node shim, or not at all", async () => {
  const found = await findGws({ PATH: process.env.PATH });
  if (found === null) return;                       // not installed here; fine
  const head = await readFile(found);
  assert.deepEqual([...head.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46],
    "the shim is a node script; the thing worth mounting is the binary beside it");
});

/* ------------------------------------------------------------------- DNS */

test("network on brings a resolver with it", () => {
  // The network was on and every hostname failed: /etc/resolv.conf is a symlink
  // into /run on a systemd-resolved machine, and /run was not in the namespace.
  const on = argvOf({ ...LOCKED, net: true });
  assert.doesNotMatch(on, /--unshare-net/);
  assert.match(on, /resolv\.conf|systemd\/resolve|--ro-bind-try/,
    "a network with no resolver is not a network");
  assert.match(argvOf(LOCKED), /--unshare-net/);
});

/* ------------------------------------------------------------ the wrapper */

const wrapper = join(adaptersDir(), "gws", "bin", "gws");

function runWrapper(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(wrapper, args, { env: { PATH: "/usr/bin:/bin", ...env } },
      (e, out, err) => done({ code: e && "code" in e ? Number(e.code) : 0, out, err }));
  });
}

test("locked, the wrapper explains rather than failing obscurely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perp-wrap-"));
  const r = await runWrapper(["--version"], {
    PERPETUAL_SITE: dir, PERPETUAL_GWS_HOST: "/no/such/gws",
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /this session is locked/);
  assert.match(r.err, /mail/, "it points at what DOES work");
  assert.deepEqual(await readdir(join(dir, "ui", "requests")).catch(() => []), [],
    "a command that never ran is not journaled");
  await rm(dir, { recursive: true, force: true });
});

test("unlocked, the wrapper records the command and then gets out of the way", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perp-wrap-"));
  const r = await runWrapper(["gmail", "+triage", "--max", "2"], {
    PERPETUAL_SITE: dir, PERPETUAL_GWS_HOST: "/bin/echo",
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /gmail \+triage --max 2/, "arguments are passed through untouched");

  const [name] = await readdir(join(dir, "ui", "requests"));
  const entry = JSON.parse(await readFile(join(dir, "ui", "requests", name!), "utf8"));
  assert.equal(entry.verb, "gws.direct");
  assert.deepEqual(entry.argv, ["gmail", "+triage", "--max", "2"]);
  assert.match(entry.note, /outside the verb table/);
  await rm(dir, { recursive: true, force: true });
});

test("the wrapper does not write a secret into the journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perp-wrap-"));
  await runWrapper(["auth", "--token", "ya29.super-secret-value"], {
    PERPETUAL_SITE: dir, PERPETUAL_GWS_HOST: "/bin/echo",
  });
  const [name] = await readdir(join(dir, "ui", "requests"));
  const text = await readFile(join(dir, "ui", "requests", name!), "utf8");
  assert.doesNotMatch(text, /super-secret-value/);
  assert.match(text, /<redacted>/);
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ the adapter */

test("the gws adapter exists and declares what it needs", async () => {
  const { adapters } = await readAdapters();
  const gws = adapters.find((a) => a.name === "gws")!;
  assert.ok(gws, "the recipe ships even when the switch is off");
  assert.deepEqual(gws.needs, ["unlocked"]);
  assert.equal(gws.hasBin, true, "the journaling wrapper is what `gws` resolves to");

  const recipe = await readFile(join(adaptersDir(), "gws", "tool.md"), "utf8");
  assert.match(recipe, /it can write/i, "the summary has to say the dangerous part");
  assert.match(recipe, /never a task to perform/i);
  assert.ok(TEST_PROFILE.endsWith("gws-test"), "never ~/.config/gws");
});
