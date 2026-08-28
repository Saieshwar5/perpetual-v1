/**
 * Choosing where the agent may write. plans/37.
 *
 * Two claims, and both are about the reader keeping control of something the
 * agent would otherwise decide for itself:
 *
 *   THE PICKER CANNOT LEAVE HOME. It chooses a place to WRITE, and offering to
 *   mount `/` or `/etc` is not a feature anyone asked for.
 *
 *   A CREDENTIAL IS VISIBLE ONLY WHEN NAMED. Nothing is un-hidden by default,
 *   and un-hiding one thing does not un-hide its neighbours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { listDirs, within } from "../src/dirs.ts";
import {
  wrapCommand, sandboxEnv, SECRETS, CREDENTIALS, startDir, type SandboxConfig,
} from "../src/shell/sandbox.ts";

const BASE: SandboxConfig = { root: "/tmp/site", net: true, unsafe: false };
const argvOf = (cfg: SandboxConfig) => wrapCommand("true", cfg).args;

/* ------------------------------------------------------------ the picker */

test("the picker stays inside the reader's home", () => {
  const home = homedir();
  assert.equal(within(home), home);
  assert.equal(within(join(home, "projects")), join(home, "projects"));
  assert.equal(within("~/projects"), join(home, "projects"));

  for (const bad of ["/", "/etc", "/usr/bin", "/home/someone-else", `${home}/../../etc`]) {
    assert.equal(within(bad), null, `${bad} must not be offerable`);
  }
});

test("listing gives directory names and nothing about files", async () => {
  const out = await listDirs();
  assert.ok(!("error" in out));
  assert.equal(out.path, homedir());
  assert.equal(out.parent, null, "home is the top; there is no `up` from it");
  assert.ok(Array.isArray(out.dirs));
});

test("a path outside home is refused with a reason, not an empty list", async () => {
  const out = await listDirs("/etc");
  assert.ok("error" in out);
  assert.match(out.error, /inside your home directory/);
});

/* ------------------------------------------------------- what is hidden */

test("secrets are covered, and only ones that exist", () => {
  const args = argvOf(BASE).join(" ");
  // Whatever this machine actually has, every covered path must be a tmpfs and
  // must be one of the names we published — not a surprise.
  const covered = argvOf(BASE)
    .map((a, i) => (argvOf(BASE)[i - 1] === "--tmpfs" ? a : null))
    .filter((a): a is string => Boolean(a) && a!.startsWith(homedir()));
  for (const path of covered) {
    const rel = path.slice(homedir().length + 1);
    assert.ok(SECRETS.includes(rel) || rel === ".cache",
      `${rel} is covered but is not in SECRETS`);
  }
  assert.match(args, /--tmpfs/, "something is covered on a real machine");
});

test("nothing is un-hidden unless it was named", () => {
  const hidden = argvOf(BASE).join(" ");
  const shown = argvOf({ ...BASE, credentials: ["gws"] }).join(" ");
  const gws = join(homedir(), CREDENTIALS.gws!);

  // Naming it takes it off the tmpfs list and binds it WRITABLE — these CLIs
  // cache refreshed tokens, and a read-only config directory fails as "Failed
  // to get token", which reads like a broken login rather than a broken mount.
  assert.ok(!shown.includes(`--tmpfs ${gws}`), "named, so no longer covered");
  if (hidden.includes(`--tmpfs ${gws}`)) {
    assert.match(shown, new RegExp(`--bind ${gws} ${gws}`), "and writable");
  }

  // Its neighbours are untouched by that decision.
  const gh = join(homedir(), CREDENTIALS.gh!);
  assert.equal(shown.includes(`--bind ${gh} ${gh}`), false,
    "naming one credential does not name another");
});

test("a credential that was named gets the environment that makes it work", () => {
  assert.equal(sandboxEnv(BASE).GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND, undefined);
  // There is no session bus in here. Without this, a credential the reader
  // deliberately made visible fails with "Failed to get token".
  assert.equal(
    sandboxEnv({ ...BASE, credentials: ["gws"] }).GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND,
    "file");
});

/* -------------------------------------------------------- where it writes */

test("no working directory means one writable path, and it is the record", () => {
  const args = argvOf(BASE);
  const binds = args
    .map((a, i) => (args[i - 1] === "--bind" ? a : null))
    .filter(Boolean);
  assert.deepEqual(binds, ["/tmp/site"], "the session, and nothing else");
  assert.equal(startDir(BASE), "/session");
});

test("a working directory is bound at its REAL path", () => {
  // Not remapped to a tidy /work. An absolute path in the agent's answer has to
  // mean something to the reader after they close the app.
  const work = join(homedir(), "projects", "thing");
  const args = argvOf({ ...BASE, workdir: work });
  const at = args.indexOf(work);
  assert.ok(at > 0);
  assert.equal(args[at - 1], "--bind");
  assert.equal(args[at + 1], work, "bound at its own path, not remapped");
  assert.equal(startDir({ ...BASE, workdir: work }), work);
  assert.equal(sandboxEnv({ ...BASE, workdir: work }).PERPETUAL_WORKDIR, work);
});

test("the sessions root is pinned read-only after the working directory", () => {
  // Order is the whole of bwrap's semantics: the sessions root lives inside the
  // repo, so a reader who picks that repo would otherwise get a writable
  // session.json — the file that says which sections are sealed.
  const work = join(homedir(), "repo");
  const sessions = join(work, ".perpetual");
  const args = argvOf({ ...BASE, workdir: work, sessionsRoot: sessions });
  const bindAt = args.indexOf(work);
  const pinAt = args.indexOf(sessions);
  assert.ok(pinAt > bindAt, "pinned after, or the bind would win");
  assert.equal(args[pinAt - 1], "--ro-bind-try");
});
