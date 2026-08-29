/**
 * `pnpm dev` — the browser mode. plans/38 §7, phase 1.
 *
 * All this does is start the server and print what it started. Everything that
 * used to happen at the bottom of server.ts happens inside `startServer` now,
 * where the other caller — the Electron main process — can have it too.
 *
 * The browser mode is not a legacy path. It is what `pnpm test`, `pnpm replay`
 * and the probes in tools/ drive, and it is the reason none of them had to
 * learn about packaging.
 */
import { startServer, describeBoot } from "./server.ts";

try {
  const { url } = await startServer();
  const boot = describeBoot();
  console.log(`\n  perpetual  ${url}`);
  for (const [k, v] of Object.entries(boot)) {
    console.log(`  ${k.padEnd(9)} ${v}`);
  }
  console.log("");
} catch (e) {
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
