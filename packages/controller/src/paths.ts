/**
 * Where the controller's own files live. plans/38 §5.1, §5.2.
 *
 * There used to be four answers to this question — `sandbox.ts` walked two
 * directories up from `import.meta.url` for the page program, `adapters.ts`
 * walked one up for the recipes, `context.ts` walked one up for the prompts,
 * and `server.ts` walked three up for the repo. All four were right, and all
 * four are wrong the moment the code is bundled into an `app.asar`, where the
 * module's own URL no longer describes anything on the filesystem.
 *
 * So: one module, and one place to override it — but TWO answers, because the
 * question genuinely has two.
 *
 * An asar archive is transparent to Node's `fs` and opaque to everything else.
 * That splits our own files cleanly in half:
 *
 *   READ   prompts/         readFile, so it may stay inside the archive
 *   MOUNT  sandbox-bin/     bwrap binds it, the kernel execs it, so it has
 *          adapters/        to be a real path on a real filesystem
 *
 * From source the two roots are the same directory and none of this shows.
 * Packaged they are `app.asar` and `app.asar.unpacked`, and collapsing them to
 * one is a bug in whichever direction you collapse: prompts unpacked widens
 * the unpack list for no reason, and adapters packed makes the agent silently
 * toolless. Phase 3 shipped the second one for about ten minutes.
 *
 * THE OVERRIDE IS NOT A CONVENIENCE. A packaged desktop build has to say where
 * `sandbox-bin/` ended up, because bwrap BINDS that path and the kernel EXECS
 * what is inside it — an archive member is neither bindable nor executable.
 * `PERPETUAL_RESOURCES` (or `setResources`, for an Electron main that has the
 * value in hand rather than in the environment) is how it says so.
 *
 * Resolution order, first hit wins:
 *
 *   1. `setResources(dir)`      — an embedder that knows
 *   2. `PERPETUAL_RESOURCES`    — the same thing, across a spawn
 *   3. this file's own location — running from source, which is today
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `packages/controller`, when the code is running from source.
 *
 * Computed lazily and defensively, because a bundler is entitled to leave
 * `import.meta.url` empty — esbuild's cjs output says so out loud — and this
 * module loading is not the moment to find out. A bundled build has no source
 * tree to walk anyway; it has `setResources`, which is the point.
 */
function fromSource(): string | undefined {
  const here = import.meta.url;
  if (!here || !here.startsWith("file:")) return undefined;
  try { return resolve(dirname(fileURLToPath(here)), ".."); } catch { return undefined; }
}

/** Both roots. Equal from source; different, and both right, when packaged. */
export interface Roots {
  /** Files the controller reads. May be inside an asar. */
  read: string;
  /** Files bwrap binds and the kernel execs. Never inside an asar. */
  mount: string;
}

let injected: Roots | undefined;

/**
 * Point the controller at its resources.
 *
 * Call before anything reads a path — practically, before `startServer`. A
 * bare string sets both roots, which is what a source checkout wants and what
 * every test wants. `undefined` puts it back, which is for tests and for
 * nothing else.
 *
 * It is deliberately a plain setter rather than a parameter threaded through
 * every call site: `toolsDir()` is reached from inside a shell invocation four
 * frames below anything that knows about packaging.
 */
export function setResources(dir: string | Roots | undefined): void {
  if (dir === undefined) injected = undefined;
  else if (typeof dir === "string") injected = { read: resolve(dir), mount: resolve(dir) };
  else injected = { read: resolve(dir.read), mount: resolve(dir.mount) };
}

/**
 * The directory holding `sandbox-bin/`, `adapters/` and `prompts/`.
 *
 * Read every time rather than cached at import: a test that sets the
 * environment after loading the module should be believed, and this is a
 * `join` on a string, not a stat.
 */
export function roots(): Roots {
  if (injected) return injected;
  const env = process.env.PERPETUAL_RESOURCES;
  if (env) return { read: resolve(env), mount: resolve(env) };
  const src = fromSource();
  if (src) return { read: src, mount: src };
  // Reached only in a bundle whose embedder forgot. Saying so beats resolving
  // to the process cwd and failing later, inside bwrap, as a missing `page`.
  throw new Error(
    "Cannot locate the controller's resources. A bundled build must call " +
    "setResources() or set PERPETUAL_RESOURCES before starting the server.");
}

/**
 * The read root, for callers that do not care about the distinction — which
 * is most of them, since the two are the same everywhere but inside a
 * packaged app.
 */
export const resources = (): string => roots().read;

/** The agent's own programs — `page`, and whatever joins it. plans/34. MOUNT. */
export const toolsDir = (): string => join(roots().mount, "sandbox-bin");

/** The built-in tool adapters. MOUNT: bound into the namespace, and exec'd. */
export const adaptersDir = (): string => join(roots().mount, "adapters");

/** The system prompt and the rules. READ: `readFile` only, never mounted. */
export const promptsDir = (): string => join(roots().read, "prompts");

/**
 * The repository, for the things that only exist in a checkout.
 *
 * The CLIs (`pnpm blocks`, `pnpm report`) and the browser mode's static files.
 * A packaged app has no repository, which is why nothing on the turn path may
 * call this — the desktop build passes an explicit client directory and an
 * explicit sessions root instead.
 */
export function repoRoot(): string {
  const src = fromSource();
  if (!src) throw new Error("There is no repository — this is a packaged build.");
  return resolve(src, "..", "..");
}

/** Where sessions live when nobody said otherwise. Source-checkout default. */
export const defaultHome = (): string =>
  process.env.PERPETUAL_HOME ?? join(repoRoot(), ".perpetual");
