/**
 * Provider API keys, owned by the controller. plans/48.
 *
 * Keys used to be environment variables read once at boot: changing one meant
 * editing `.env` and restarting the app, and there was no way to hold keys
 * for two providers at once. They are a runtime setting now — written through
 * a chrome endpoint, kept in one file the controller owns.
 *
 * The rules, each load-bearing:
 *
 *   WRITE-ONLY FROM THE OUTSIDE. No endpoint ever returns a key — only the
 *   fact that one is set. The UI is a password field, not a vault viewer.
 *
 *   NEVER IN THE SANDBOX. `sandboxEnv` is an allowlist and these are not on
 *   it. A key the agent could read is a key the next prompt injection owns —
 *   there is a test asserting `env` inside the sandbox cannot see it, and
 *   this store must never weaken that.
 *
 *   ENV STILL WINS. `FIREWORKS_API_KEY=… pnpm dev` keeps working, unchanged,
 *   for headless runs and CI. The store is for people; the environment is for
 *   scripts.
 *
 * On disk: one JSON file beside the sessions, mode 0600. Not encrypted —
 * `.env` never was either, and pretending a same-disk cipher with a same-disk
 * key is security would be worse than saying plainly: this file is as private
 * as your home directory.
 */
import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";

let file: string | null = null;
let cache: Record<string, string> | null = null;

/** Point the store somewhere. Called by startServer, before anything reads. */
export function credentialsFile(path: string): void {
  file = path;
  cache = null;
}

async function load(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (!file) return {};
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    cache = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => typeof v === "string" && v)) as Record<string, string>;
  } catch { cache = {}; }
  return cache;
}

/**
 * The key for a provider: the environment's, or the store's.
 *
 * Environment first, always — a deliberately-exported variable is the most
 * explicit thing on the machine, and quietly overriding it with a file would
 * make debugging a wrong-key problem maddening.
 */
export async function keyFor(provider: string, keyEnv: string): Promise<string | undefined> {
  return process.env[keyEnv] || (await load())[provider];
}

/** Is a key set at all, and where from? For chrome that shows state, never keys. */
export async function keySource(
  provider: string, keyEnv: string,
): Promise<"env" | "stored" | null> {
  if (process.env[keyEnv]) return "env";
  return (await load())[provider] ? "stored" : null;
}

/** Set (non-empty) or clear (empty/null) one provider's stored key. */
export async function setKey(provider: string, key: string | null): Promise<void> {
  if (!file) throw new Error("credential store not initialised");
  const keys = { ...(await load()) };
  if (key?.trim()) keys[provider] = key.trim();
  else delete keys[provider];

  await mkdir(dirname(file), { recursive: true });
  // Atomic, then clamped: a crash mid-write must not leave half a key, and
  // the file must never spend a moment world-readable.
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => {});
  cache = keys;
}

/** For tests: forget the cached file contents. */
export function resetCredentialCache(): void {
  cache = null;
}

export const defaultCredentialsFile = (root: string): string =>
  join(root, "credentials.json");
