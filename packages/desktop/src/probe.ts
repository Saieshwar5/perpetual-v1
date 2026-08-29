/**
 * Phase 0. plans/38 §7 — does the sandbox survive Electron at all?
 *
 * This is the gate the rest of the desktop plan stands on, and it is
 * deliberately the first thing built. bwrap needs unprivileged user
 * namespaces; Electron ships its own sandbox, its own zygote, and (packaged)
 * whatever confinement AppImage or Flatpak brings. Any of those can take user
 * namespaces away, and the failure would not show up until Phase 3, after
 * everything had been built on the assumption.
 *
 * So: no window, no server, no client. Open an Electron main process, run
 * commands through the REAL `createShell` — the same one a turn uses — and
 * report what the kernel allowed. If this prints FAIL, plans/38 §4 is wrong
 * and the desktop build needs a different containment story before anything
 * else is written.
 *
 *     pnpm --filter @perpetual/desktop probe
 */
import { app } from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell } from "@perpetual/controller/shell/tool";
import { bwrapAvailable } from "@perpetual/controller/shell/sandbox";
import { setResources, resources } from "@perpetual/controller/paths";

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) =>
  checks.push({ name, ok, detail: detail.trim().slice(0, 200) });

async function probe(): Promise<void> {
  // A bundled main has no `import.meta.url` worth walking, which is the whole
  // point of paths.ts. In the real main this comes from `process.resourcesPath`
  // and `app.asar.unpacked`; here the source tree is next door.
  // From `dist/`, up to `packages/`, across to the controller. Not
  // `app.getAppPath()`: with a script argument that is the script's OWN
  // directory, which is a different place and quietly the wrong one.
  setResources(join(__dirname, "..", "..", "controller"));
  record("resources resolve", true, resources());

  record("bwrap on PATH", bwrapAvailable(),
    bwrapAvailable() ? "found" : "not installed — install bubblewrap first");
  if (!bwrapAvailable()) return;

  const root = await mkdtemp(join(tmpdir(), "perp-probe-"));
  await mkdir(join(root, "ui", "pages"), { recursive: true });
  try {
    const sh = createShell({
      root, net: false, unsafe: false, sealed: [], sessionsRoot: root,
      adapters: join(resources(), "adapters"),
      binPaths: [],
    });

    // 1. Can we enter a namespace at all? This is the one that fails when
    //    Electron's zygote or the packaging format has taken userns away.
    const hello = await sh.run({ command: "echo alive", timeoutSec: 20 });
    record("namespace enters", hello.exitCode === 0 && hello.text.includes("alive"),
      `exit ${hello.exitCode}: ${hello.text}`);

    // 2. Is the mount table the one plans/37 describes, or did something
    //    quietly hand us the host? A sandbox that runs but does not contain is
    //    worse than one that refuses.
    const write = await sh.run({
      command: "touch /session/probe-ok && echo wrote; touch /etc/probe-bad 2>&1 || echo refused",
      timeoutSec: 20,
    });
    record("writes confined", write.text.includes("wrote") && write.text.includes("refused"),
      write.text);

    // 3. Secrets absent rather than forbidden — plans/37 §3.
    const secret = await sh.run({
      command: "ls -A ~/.ssh 2>/dev/null | wc -l", timeoutSec: 20,
    });
    record("secrets empty", /(^|\D)0(\D|$)/.test(secret.text), secret.text);

    // 4. The agent's own program, through the mount that Phase 3's asarUnpack
    //    exists to keep real.
    const page = await sh.run({ command: "command -v page", timeoutSec: 20 });
    record("page program on PATH", page.exitCode === 0, page.text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  try {
    await probe();
  } catch (e) {
    record("probe ran", false, e instanceof Error ? e.message : String(e));
  }

  const pad = Math.max(...checks.map((c) => c.name.length));
  console.log("\n  perpetual — phase 0 sandbox probe\n");
  for (const c of checks) {
    console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(pad)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed
    ? `\n  ${failed} failed — plans/38 §4 does not hold on this machine.\n`
    : "\n  the sandbox works inside Electron. plans/38 phase 1 is unblocked.\n");
  app.exit(failed ? 1 : 0);
});
