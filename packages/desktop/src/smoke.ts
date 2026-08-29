/**
 * Did packaging keep the seven files that have to be real? plans/38 §10.
 *
 * This is not a unit test and it does not belong in `pnpm test`: it asserts
 * things about an artifact that only exists after `pnpm pack`. It is here
 * because the failure it catches is the worst kind this project has — SILENT.
 *
 * `sandbox.ts` mounts the two trees differently:
 *
 *     --ro-bind      sandbox-bin  → errors loudly if the path is missing
 *     --ro-bind-try  adapters     → SUCCEEDS if the path is missing
 *
 * So an asar that swallowed `adapters/` produces an app that starts, renders,
 * runs turns, and quietly has no tools. Nothing on screen says why. The banner
 * says `tools     none` and that is the entire symptom. Twice during phase 2 a
 * wrong path presented exactly like that, and both times it took a while to
 * notice — hence a check that runs on the built thing and names what it wants.
 *
 *     pnpm pack && pnpm smoke
 */
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/ → the package → release/. Not one level higher: that is packages/.
const RELEASE = join(HERE, "..", "release");

interface Check { ok: boolean; what: string; detail?: string }
const checks: Check[] = [];
const ok = (what: string, detail?: string) =>
  checks.push({ ok: true, what, ...(detail ? { detail } : {}) });
const bad = (what: string, detail: string) => checks.push({ ok: false, what, detail });

const isFile = (p: string) => stat(p).then((s) => s.isFile(), () => false);
const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

/** The unpacked linux build electron-builder leaves beside the installers. */
async function findUnpacked(): Promise<string | null> {
  const names = await readdir(RELEASE).catch(() => [] as string[]);
  for (const n of names) {
    if (!n.includes("unpacked")) continue;
    const p = join(RELEASE, n);
    if (await isDir(p)) return p;
  }
  return null;
}

const app = await findUnpacked();
if (!app) {
  console.error(`\n  Nothing built. Run \`pnpm pack\` first — expected an ` +
    `*-unpacked directory under ${RELEASE}\n`);
  process.exit(1);
}

const asar = join(app, "resources", "app.asar");
const unpacked = join(app, "resources", "app.asar.unpacked");

if (await isFile(asar)) ok("app.asar exists");
else bad("app.asar exists", `not at ${asar}`);

if (await isDir(unpacked)) ok("app.asar.unpacked exists");
else {
  bad("app.asar.unpacked exists",
    "nothing was unpacked — asarUnpack did not match, and the agent has no " +
    "programs and no tools");
}

const CTL = join(unpacked, "packages", "controller");

/**
 * The three programs. Existence AND the executable bit, because asar packing
 * does not reliably carry modes and a program without its bit is not a program
 * — it is a `Permission denied` inside a namespace, four frames from anything
 * that would explain it.
 */
for (const rel of [
  "sandbox-bin/page",
  "adapters/files/bin/files",
  "adapters/mail/bin/mail",
]) {
  const p = join(CTL, rel);
  const s = await stat(p).catch(() => null);
  if (!s) bad(`${rel} is present`, `missing from ${unpacked}`);
  else if (!(s.mode & 0o111)) bad(`${rel} is executable`, `mode ${(s.mode & 0o777).toString(8)}`);
  else ok(`${rel}`, `executable, ${s.size} bytes`);
}

/**
 * The four recipes. These are what `--ro-bind-try` loses in silence, so they
 * are named one at a time rather than counted: "4 adapters" would pass with
 * four copies of the wrong one.
 */
for (const name of ["files", "git", "gws", "mail"]) {
  const p = join(CTL, "adapters", name, "tool.md");
  if (await isFile(p)) ok(`adapters/${name}/tool.md`);
  else bad(`adapters/${name}/tool.md`, "missing — this fails SILENTLY at runtime");
}

/**
 * And the other half of the rule: things read through Node's fs SHOULD still
 * be in the archive. An unpacked `prompts/` is not broken, but it means the
 * asarUnpack globs are wider than they were meant to be, and the next thing
 * they catch will be something that should have stayed private.
 */
if (await isDir(join(unpacked, "packages", "controller", "prompts"))) {
  bad("prompts/ stayed inside the asar",
    "it was unpacked — asarUnpack is matching more than sandbox-bin and adapters");
} else {
  ok("prompts/ stayed inside the asar");
}

// Nothing that is not ours.
for (const leak of [".env", "node_modules", "packages/controller/src", "packages/controller/test"]) {
  const inAsar = await isDir(join(unpacked, leak)) || await isFile(join(unpacked, leak));
  if (inAsar) bad(`${leak} did not ship`, "found in app.asar.unpacked");
}
ok("no source, tests, .env or node_modules unpacked");

const pad = Math.max(...checks.map((c) => c.what.length));
console.log(`\n  perpetual — packaging smoke test\n  ${app}\n`);
for (const c of checks) {
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.what.padEnd(pad)}  ${c.detail ?? ""}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed
  ? `\n  ${failed} failed — the build is not shippable.\n`
  : "\n  the seven files that must be real, are.\n");
process.exit(failed ? 1 : 0);
