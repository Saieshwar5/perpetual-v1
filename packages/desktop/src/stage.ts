/**
 * Assemble exactly what ships. plans/38 §7 phase 3.
 *
 * electron-builder wants ONE directory that looks like an app. This repo is a
 * pnpm workspace where the app is four packages and a bundler, so something
 * has to do the assembling, and doing it here — in twenty lines of copying we
 * can read — beats teaching the builder about workspace layouts through its
 * `files` globs.
 *
 * THE STAGE IS AN ALLOWLIST. Nothing is excluded; things are named. That is
 * the difference between a build that ships `.env` the day someone moves it
 * and a build that cannot.
 *
 * The layout it produces is the one `main.ts`'s `locate()` expects when
 * packaged, and the two must be read together:
 *
 *     stage/
 *       package.json            name, version, main — nothing else
 *       dist/main.cjs           the bundled controller + main process
 *       dist/preload.cjs
 *       packages/client/…       index.html, style.css, dist/main.js, fonts/
 *       packages/controller/…   prompts/, sandbox-bin/, adapters/
 *
 * Of those, `sandbox-bin/` and `adapters/` are the ones electron-builder is
 * told to leave OUT of the asar (§5.2): bwrap binds them and the kernel execs
 * them, and neither can be done to a path inside an archive. `prompts/` stays
 * in, because it is only ever read through Node's fs, which Electron patches
 * to see into asar.
 */
import { cp, mkdir, readFile, rm, writeFile, stat, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "..");
const PACKAGES = join(DESKTOP, "..");
const STAGE = join(DESKTOP, "stage");

/** What goes in, and where it lands. Relative to the workspace's packages/. */
const COPY: [from: string, to: string][] = [
  ["client/index.html", "packages/client/index.html"],
  ["client/style.css", "packages/client/style.css"],
  ["client/dist/main.js", "packages/client/dist/main.js"],
  ["client/fonts", "packages/client/fonts"],
  ["controller/prompts", "packages/controller/prompts"],
  ["controller/sandbox-bin", "packages/controller/sandbox-bin"],
  ["controller/adapters", "packages/controller/adapters"],
];

/** The programs the agent runs. If one of these loses its bit, it is not a
 *  program any more — and asar packing is not careful about modes. */
const EXECUTABLE = [
  "packages/controller/sandbox-bin/page",
  "packages/controller/adapters/files/bin/files",
  "packages/controller/adapters/mail/bin/mail",
];

const exists = (p: string) => stat(p).then(() => true, () => false);

await rm(STAGE, { recursive: true, force: true });
await mkdir(join(STAGE, "dist"), { recursive: true });

// The bundles. Built by `pnpm build` before this runs; missing them is a
// build-order mistake worth saying out loud rather than shipping around.
for (const f of ["main.cjs", "preload.cjs"]) {
  const from = join(DESKTOP, "dist", f);
  if (!await exists(from)) {
    throw new Error(`dist/${f} is missing — run \`pnpm --filter @perpetual/desktop build\` first.`);
  }
  await cp(from, join(STAGE, "dist", f));
}

for (const [from, to] of COPY) {
  const src = join(PACKAGES, from);
  if (!await exists(src)) throw new Error(`nothing at ${src} — the stage list is stale.`);
  await cp(src, join(STAGE, to), { recursive: true });
}

// Modes, restated rather than trusted. `cp` preserves them here; the asar
// step downstream is the part that does not, which is why these three are
// also asserted after packaging.
for (const rel of EXECUTABLE) {
  const p = join(STAGE, rel);
  if (!await exists(p)) throw new Error(`${rel} did not make it into the stage.`);
  await chmod(p, 0o755);
}

/**
 * The app's own package.json — written, never copied.
 *
 * A copied one drags devDependencies, scripts and whatever else the workspace
 * file happens to hold into a shipped artifact. What an Electron app needs is
 * a handful of fields, so a handful is what it gets.
 *
 * `author` and `homepage` are here because .deb and .rpm REQUIRE a maintainer
 * and a homepage and will not build without them — they are the package's
 * authorship, the same identity that is already on every commit in this repo.
 */
const version = JSON.parse(
  await readFile(join(DESKTOP, "package.json"), "utf8")).version ?? "0.0.0";
await writeFile(join(STAGE, "package.json"), JSON.stringify({
  name: "perpetual",
  productName: "Perpetual",
  version,
  main: "dist/main.cjs",
  description: "An agent interface with no chat in it",
  homepage: "https://github.com/Saieshwar5/perpetual-v1",
  author: { name: "sai eshwar gandrath", email: "saieshwargandrath5@gmail.com" },
  license: "UNLICENSED",
}, null, 2) + "\n");

console.log(`  staged  ${STAGE}`);
for (const [, to] of COPY) console.log(`          ${to}`);
