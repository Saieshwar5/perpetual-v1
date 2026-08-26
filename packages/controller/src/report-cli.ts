/**
 * `pnpm report [session-id …]` — what has the agent actually been doing?
 *
 * Reads only what is already on disk. No key, no network, no turn run: this
 * looks at the sessions you already have and prints what they say about the
 * model's behaviour, which is the one thing the 133 tests cannot tell you.
 */
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "./sessions.ts";
import { reportOn, format } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const ROOT = process.env.PERPETUAL_HOME ?? join(REPO, ".perpetual");

const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const store = new SessionStore(ROOT);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(await reportOn(store, ids), null, 2));
} else {
  console.log(format(await reportOn(store, ids)));
}
