/**
 * Where the controller's own files live. plans/38 §5.1, §10.
 *
 * This is a test about PACKAGING, which is why it looks like it is testing
 * `join`. It is not: it is testing the claim that every consumer of a resource
 * path asks the same module, so that a packaged build can move all of them at
 * once by answering one question differently.
 *
 * The failure this exists to catch is silent and total. A build where
 * `toolsDir()` still points three directories up from a bundled module does
 * not error at boot — it errors on the reader's first question, inside bwrap,
 * as a shell that cannot find `page`.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setResources, resources, roots, toolsDir, adaptersDir, promptsDir, repoRoot,
} from "../src/paths.ts";
import { toolsDir as fromSandbox } from "../src/shell/sandbox.ts";
import { adaptersDir as fromAdapters } from "../src/adapters.ts";

afterEach(() => setResources(undefined));

test("from source, the three resource directories are real and populated", async () => {
  // Not "the string ends with sandbox-bin" — the point is that these paths
  // exist, because a path that resolves nowhere is exactly what packaging
  // breaks and what a string comparison would happily accept.
  const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);
  assert.ok(await isDir(toolsDir()), `${toolsDir()} should be a directory`);
  assert.ok(await isDir(adaptersDir()), `${adaptersDir()} should be a directory`);
  assert.ok(await isDir(promptsDir()), `${promptsDir()} should be a directory`);

  // The two files the agent cannot work without: the page program it runs, and
  // the rules it is given.
  assert.ok(await stat(join(toolsDir(), "page")).then(() => true, () => false));
  assert.ok(await stat(join(promptsDir(), "rules.md")).then(() => true, () => false));
});

test("the page program is executable, because bwrap execs it", async () => {
  const s = await stat(join(toolsDir(), "page"));
  assert.ok(s.mode & 0o111, "sandbox-bin/page must carry an executable bit");
});

test("an injected root moves every resource at once", async () => {
  const fake = await mkdtemp(join(tmpdir(), "perp-res-"));
  try {
    await mkdir(join(fake, "sandbox-bin"), { recursive: true });
    setResources(fake);
    assert.equal(resources(), fake);
    assert.equal(toolsDir(), join(fake, "sandbox-bin"));
    assert.equal(adaptersDir(), join(fake, "adapters"));
    assert.equal(promptsDir(), join(fake, "prompts"));
  } finally {
    await rm(fake, { recursive: true, force: true });
  }
});

test("the sandbox and the adapters read the SAME answer", () => {
  // The whole point. These two modules used to walk up from their own file —
  // from different depths — and a packaged build would have moved neither.
  const fake = join(tmpdir(), "perp-res-shared");
  setResources(fake);
  assert.equal(fromSandbox(), join(fake, "sandbox-bin"));
  assert.equal(fromAdapters(), join(fake, "adapters"));
});

test("the environment carries the answer across a spawn", () => {
  const before = process.env.PERPETUAL_RESOURCES;
  try {
    process.env.PERPETUAL_RESOURCES = join(tmpdir(), "perp-res-env");
    assert.equal(resources(), join(tmpdir(), "perp-res-env"));

    // An embedder that has the value in hand beats one that had to serialise
    // it. Both exist because the desktop build spawns nothing and the browser
    // build is configured entirely by environment.
    setResources(join(tmpdir(), "perp-res-set"));
    assert.equal(resources(), join(tmpdir(), "perp-res-set"));
  } finally {
    if (before === undefined) delete process.env.PERPETUAL_RESOURCES;
    else process.env.PERPETUAL_RESOURCES = before;
  }
});

test("the repository root is not on the resource path", () => {
  // `repoRoot` answers a question only a checkout can answer, so it must not
  // move when resources do — otherwise a packaged build would silently look
  // for `packages/client` inside its own unpacked asar and find it, which is
  // the bug that looks like it works.
  const was = repoRoot();
  setResources(join(tmpdir(), "perp-res-elsewhere"));
  assert.equal(repoRoot(), was);
});

test("the two roots split read from mount, and the split is the packaging rule", () => {
  // The bug this exists for: `prompts/` is read with `readFile`, which sees
  // into an asar; `sandbox-bin/` and `adapters/` are bind-mounted and exec'd,
  // which does not. One root for both is wrong in whichever direction you
  // collapse it — a packaged build got `ENOENT … app.asar.unpacked/…/agent.md`
  // one way, and a silently toolless agent the other.
  const asar = join(tmpdir(), "perp-app.asar", "packages", "controller");
  const unpacked = join(tmpdir(), "perp-app.asar.unpacked", "packages", "controller");
  setResources({ read: asar, mount: unpacked });

  assert.equal(promptsDir(), join(asar, "prompts"), "prompts are READ");
  assert.equal(toolsDir(), join(unpacked, "sandbox-bin"), "programs are MOUNTED");
  assert.equal(adaptersDir(), join(unpacked, "adapters"), "adapters are MOUNTED");

  // Nothing that gets mounted may sit under the archive path, ever.
  for (const p of [toolsDir(), adaptersDir()]) {
    assert.ok(!/app\.asar(?!\.unpacked)/.test(p), `${p} is inside the archive`);
  }
});

test("a bare string still sets both, which is every non-packaged caller", () => {
  const one = join(tmpdir(), "perp-single");
  setResources(one);
  assert.deepEqual(roots(), { read: one, mount: one });
  assert.equal(resources(), one);
});
