/**
 * The local controller. plans/13 §9, opened up by plans/38 §7.
 *
 * This module DEFINES a server and starts nothing. `startServer()` is the only
 * way in, because there are now two callers — `cli.ts` for the browser mode,
 * and the Electron main process, which needs an ephemeral port, a sessions
 * root under `userData`, and a bwrap refusal it can put in a dialog rather
 * than one that calls `process.exit` out from under it.
 *
 * One server per process, still: the state below is module-scoped because a
 * second controller in one process has never been a thing anyone wanted.
 *
 * Loopback only, so there is no auth: nothing off-machine can reach it. One
 * in-flight turn per session, enforced here — it simplifies the whole system
 * and matches the UI, where the input is locked while a turn runs.
 *
 * The route list is short because most of the state is not here. A session is
 * a directory, so "load a session" is a directory read, and the only endpoint
 * that does real work is the one that runs a turn.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { repoRoot, defaultHome } from "./paths.ts";
import { createRuntime, PROVIDERS, catalogueOf, type Runtime } from "./runtime.ts";
import { createReplayRuntime } from "./replay-runtime.ts";
import { SessionStore } from "./sessions.ts";
import { readSite, PAGES_REL } from "./site.ts";
import { nameFor } from "./naming.ts";
import { MAX_REJECT_NOTES } from "./speech.ts";
import { systemPrompt } from "./context.ts";
import { credentialsFile, defaultCredentialsFile, keyFor, keySource, setKey }
  from "./credentials.ts";
import { IMAGE_RE } from "@perpetual/shared/blocks";
import { readApps, commandFor, fieldEnv, APPS_REL } from "./apps.ts";
import { readAdapters, adaptersDir, type Adapter } from "./adapters.ts";
import { listDirs, within } from "./dirs.ts";
import { createShell, DEFAULT_TIMEOUT_SEC } from "./shell/tool.ts";
import { killJobsFor, killAllJobs, listJobs, stopJob, pinJob, MAX_JOBS, JOB_MAX_MS, JOB_CEILING_MS } from "./shell/jobs.ts";
import { runTurn, MAX_STEPS, MAX_TURN_MS, STUCK_TELL, STUCK_STOP, REPEAT_TELL, REPEAT_STOP, WARN_AT } from "./agent.ts";
import { bwrapAvailable, describeSandbox, mountPath, CREDENTIALS, type SandboxConfig } from "./shell/sandbox.ts";
import { choiceKey, doorKey, type Selection, type Site, type SessionIndex }
  from "@perpetual/shared/site";
import { onClientGone } from "./disconnect.ts";
import { NoteQueue } from "./notes.ts";
import type { RenderReport } from "@perpetual/shared/render";

/**
 * Everything below is read from the environment, and read INSIDE
 * `readEnv()` rather than at module scope. plans/38 §7.
 *
 * That is not tidiness. A bundled Electron main evaluates this module the
 * moment it is required — before `app.whenReady()`, and therefore before an
 * embedder has had any chance to load a `.env`. Read at module scope, a key
 * put in `.env` was invisible to the desktop build and every turn 503'd with
 * "ANTHROPIC_API_KEY is not set", which reads as a broken app rather than an
 * unconfigured one.
 *
 * So the module still starts nothing AND now reads nothing. `startServer` is
 * the moment both happen.
 */
let REPLAY = false;
let PROVIDER = "anthropic";
/** The env var that must hold the key, for whichever provider is selected. */
let KEY_ENV = "ANTHROPIC_API_KEY";
let API_KEY: string | undefined;
let UNSAFE = false;
// ON unless explicitly turned off. The agent may run anything installed, and
// most of what is installed is useless offline — a default of "off" shipped a
// sandbox whose headline feature did not work until you found the flag.
let NET = true;

/**
 * What the caller decides. Everything else here is read from the environment,
 * because everything else is a fact about the machine rather than a choice the
 * embedder makes.
 */
export interface ServerOptions {
  /** 0 asks the kernel for a free one — what the desktop build wants. */
  port?: number;
  /** Where sessions live. */
  root?: string;
  /** The directory holding index.html, style.css and dist/. */
  client?: string;
  host?: string;
}

export interface RunningServer {
  server: ReturnType<typeof createServer>;
  port: number;
  url: string;
  /** Aborts every running turn, then stops listening. plans/38 §5.6. */
  close(): Promise<void>;
}

/** Set by startServer, before anything can be routed at them. */
let ROOT = "";
let CLIENT = "";
let store: SessionStore;
const inFlight = new Set<string>();

/**
 * The turns currently running, so a report from the client can reach the agent
 * that is still writing.
 *
 * This is the only place the server holds state that is not on disk, and it is
 * held for seconds: a render report is only useful to the turn that caused it,
 * and a turn that has ended has nothing left to fix.
 */
interface ActiveTurn {
  notes: NoteQueue;
  /** Pages this turn has written. A note about any other page is unactionable. */
  touched: Set<string>;
  /** How to stop it — for the stop button, and for quitting. plans/38 §5.6. */
  abort: () => void;
}
const active = new Map<string, ActiveTurn>();

/** How long an unused session survives before the sweep takes it. */
const SWEEP_GRACE_MS = 10 * 60_000;

/**
 * Two ceilings the machine needs and nobody was counting.
 *
 * `inFlight` stopped a session running two turns at once. Nothing stopped
 * twenty sessions running one each — and a turn is a model stream, a bash
 * process tree, and a 120ms timer. On one person's computer that is unlikely
 * and unbounded, which is the combination worth one line.
 *
 * The size cap is a REFUSAL, never a deletion. A session's pages are the
 * reader's work; the honest response to one that has grown too large is to say
 * so and let them decide, not to tidy it away. It bites at the start of a turn
 * because that is the only moment where saying no costs nothing.
 */
const MAX_CONCURRENT_TURNS = 4;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/**
 * A missing sandbox is a refusal, not a downgrade. The machine without bwrap is
 * exactly the machine where running unsandboxed matters most.
 *
 * Returned rather than exited, because the second caller is a GUI: a desktop
 * app that vanishes on launch with a message on a stderr nobody is reading has
 * not refused anything, it has crashed. `startServer` still throws it — the
 * refusal is unchanged, only who gets to phrase it.
 */
export function sandboxProblem(): string | null {
  if (UNSAFE || bwrapAvailable()) return null;
  return "bubblewrap (bwrap) is not installed, and the agent runs arbitrary " +
    "shell commands. Install it (Arch: pacman -S bubblewrap), or set " +
    "PERPETUAL_UNSAFE=1 to run without any containment. Do not do the second " +
    "one casually.";
}

/**
 * Which models the composer may offer. plans/37.
 *
 * A short, curated list rather than everything a provider sells: the chip is a
 * choice, and a menu of forty is not a choice. `PERPETUAL_MODELS` overrides it
 * for anyone working against something else.
 */
let MODELS: string[] = [];
let DEFAULT_MODEL: string | undefined;

/**
 * Runtimes, built on demand and kept.
 *
 * They used to be built once at boot, which is why changing model needed a
 * restart. A runtime is a provider client and a model id — cheap to hold, and
 * there are three of them — so the cache is a Map and the model becomes a
 * property of the conversation rather than of the process.
 */
const runtimes = new Map<string, Runtime>();
let runtimeError: string | null = null;

/**
 * A session's model may now name its provider — `openai:gpt-5` — and an
 * unqualified id keeps meaning the boot provider, so every session recorded
 * before providers were selectable still answers with the model it recorded.
 */
function parseModel(id?: string): { provider: string; model?: string } {
  if (id) {
    const at = id.indexOf(":");
    if (at > 0 && PROVIDERS[id.slice(0, at)]) {
      return { provider: id.slice(0, at), model: id.slice(at + 1) };
    }
  }
  const model = id && MODELS.includes(id) ? id : DEFAULT_MODEL;
  return { provider: PROVIDER, ...(model ? { model } : {}) };
}

async function runtimeFor(model?: string): Promise<Runtime | null> {
  if (REPLAY) {
    if (!runtimes.has("replay")) runtimes.set("replay", createReplayRuntime());
    return runtimes.get("replay")!;
  }
  const want = parseModel(model);
  const cacheKey = `${want.provider}:${want.model ?? ""}`;
  const held = runtimes.get(cacheKey);
  if (held) return held;

  // The key comes from wherever one is: the environment first, then the
  // store the settings UI writes. No key is a soft failure with a message
  // the reader can act on, not a request the provider refuses cryptically.
  const entry = PROVIDERS[want.provider];
  const key = entry ? await keyFor(want.provider, entry.keyEnv) : undefined;
  if (!key && entry) {
    runtimeError = `No API key for ${entry.title}. Add one in the model menu, ` +
      `or export ${entry.keyEnv}.`;
    return null;
  }
  try {
    const made = createRuntime({
      provider: want.provider,
      ...(key ? { apiKey: key } : {}),
      ...(want.model ? { model: want.model } : {}),
    });
    runtimes.set(cacheKey, made);
    runtimeError = null;
    return made;
  } catch (e) {
    runtimeError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** The one built at boot, so a bad key or provider is a startup error. */
let runtime: Runtime | null = null;

/**
 * The adapters, read once at boot.
 *
 * Not per turn: they are configuration, they do not change while the server
 * runs, and re-reading a directory of markdown eight times a second to
 * discover that nothing moved is the mistake the site cache exists to fix.
 * Restart to pick up a new one — the same rule as the model.
 */
/** The reader's own adapters. Usually absent, which is not a problem. */
let LOCAL_ADAPTERS = "";
let HAS_LOCAL_ADAPTERS = false;
let ADAPTERS: Adapter[] = [];

/**
 * Credential directories put back into the namespace, by name. plans/37.
 *
 * Harness config, never a per-turn decision: naming `gws` here says "sessions
 * on this machine may act as me in Gmail", and that is a sentence the reader
 * says, not one the agent can talk its way into.
 */
let CREDS: string[] = [];

/**
 * Platform settings the chrome may change: the sandbox's network, and which
 * credential directories are visible. plans/49.
 *
 * Env vars stay the loudest voice — an exported PERPETUAL_NET is the most
 * explicit thing on the machine, and a UI that silently overrode it would
 * make a wrong-sandbox bug maddening. So each setting knows its SOURCE, the
 * UI shows it, and the file only speaks when the environment is silent.
 */
let NET_SOURCE: "env" | "stored" | "default" = "default";
let CREDS_SOURCE: "env" | "stored" | "default" = "default";

/**
 * The harness knobs a reader may turn: the two budgets, the job leash, and
 * the reasoning effort. Everything else about the loop — futility
 * thresholds, repair caps, the countdown — is calibration, not preference,
 * and is shown in settings but deliberately not stored here.
 */
interface Harness { turnMs?: number; steps?: number; jobMs?: number; effort?: string }
let HARNESS: Harness = {};
const EFFORTS = ["low", "medium", "high"];
/** Effort resolves env-first like every other setting. */
const effortValue = (): string | undefined =>
  process.env.PERPETUAL_EFFORT ?? HARNESS.effort;
const effortSource = (): "env" | "stored" | "default" =>
  process.env.PERPETUAL_EFFORT ? "env" : HARNESS.effort ? "stored" : "default";

const platformFile = () => join(ROOT, "platform.json");

async function loadPlatform(): Promise<void> {
  let stored: { net?: boolean; credentials?: string[]; harness?: Harness } = {};
  try { stored = JSON.parse(await readFile(platformFile(), "utf8")); } catch { /* none yet */ }
  if (stored.harness && typeof stored.harness === "object") HARNESS = stored.harness;
  if (process.env.PERPETUAL_NET !== undefined) NET_SOURCE = "env";
  else if (typeof stored.net === "boolean") { NET = stored.net; NET_SOURCE = "stored"; }
  if (process.env.PERPETUAL_CREDENTIALS !== undefined) CREDS_SOURCE = "env";
  else if (Array.isArray(stored.credentials)) {
    CREDS = stored.credentials.filter((c) => typeof c === "string" && c in CREDENTIALS);
    CREDS_SOURCE = "stored";
  }
}

async function savePlatform(): Promise<void> {
  const out: Record<string, unknown> = {};
  if (NET_SOURCE === "stored") out.net = NET;
  if (CREDS_SOURCE === "stored") out.credentials = CREDS;
  if (Object.keys(HARNESS).length) out.harness = HARNESS;
  await writeFile(platformFile(), JSON.stringify(out, null, 2) + "\n", "utf8");
}

/** Read the environment. Called once, by `startServer`, and nowhere else. */
function readEnv(): void {
  REPLAY = process.env.PERPETUAL_REPLAY === "1";
  PROVIDER = process.env.PERPETUAL_PROVIDER ?? "anthropic";
  KEY_ENV = PROVIDERS[PROVIDER]?.keyEnv ?? "ANTHROPIC_API_KEY";
  API_KEY = process.env[KEY_ENV];
  UNSAFE = process.env.PERPETUAL_UNSAFE === "1";
  NET = process.env.PERPETUAL_NET !== "0";
  MODELS = (process.env.PERPETUAL_MODELS ??
    "claude-opus-5,claude-sonnet-5,claude-haiku-4-5-20251001")
    .split(",").map((x) => x.trim()).filter(Boolean);
  DEFAULT_MODEL = process.env.PERPETUAL_MODEL ?? MODELS[0];
  CREDS = (process.env.PERPETUAL_CREDENTIALS ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * Run every adapter's self-test, in the same sandbox a turn would use.
 * plans/48 — never a silent downgrade, made real.
 *
 * The manifests have carried `check` commands from the start and nothing ever
 * ran them, so a broken tool looked identical to a working one until the
 * agent hit it mid-turn and burned steps on a stack trace. Checked once,
 * AFTER boot and off the boot path: results land within seconds and flow to
 * both audiences — the reader through /health, the agent through the same
 * `unavailable` note a missing credential already uses.
 */
async function checkAdapters(): Promise<void> {
  const scratch = join(ROOT, ".checks");
  await mkdir(join(scratch, "workspace"), { recursive: true }).catch(() => {});
  const shell = createShell({
    root: scratch, net: NET, unsafe: UNSAFE,
    adapters: adaptersDir(),
    ...(HAS_LOCAL_ADAPTERS ? { localAdapters: LOCAL_ADAPTERS } : {}),
    binPaths: ADAPTER_BINS(),
    notesDir: join(ROOT, "notes"),
    ...(CREDS.length ? { credentials: CREDS } : {}),
  });
  for (const a of ADAPTERS) {
    if (!a.check || a.unavailable) continue;
    const r = await shell.run({ command: a.check, timeoutSec: 20 });
    if (r.exitCode === 0) { a.healthy = true; continue; }
    const tail = r.text.split("\n").filter(Boolean).slice(-2).join(" · ").slice(0, 200);
    a.unavailable = `its self-test failed (exit ${r.exitCode})${tail ? `: ${tail}` : ""}`;
  }
}

/** The adapters' bins — what a view's `run` commands may resolve against. */
const ADAPTER_BINS = () => ADAPTERS.filter((a) => a.hasBin).map((a) => `${a.path}/bin`);

const sandboxFor = (
  id: string, sealed: string[] = [], workdir?: string, grants?: string[],
): SandboxConfig => ({
  root: store.siteDir(id), net: NET, unsafe: UNSAFE, sealed,
  sessionsRoot: ROOT,
  adapters: adaptersDir(),
  ...(HAS_LOCAL_ADAPTERS ? { localAdapters: LOCAL_ADAPTERS } : {}),
  binPaths: ADAPTERS.filter((a) => a.hasBin).map((a) => `${a.path}/bin`),
  notesDir: join(ROOT, "notes"),
  ...(HARNESS.jobMs ? { jobMaxMs: HARNESS.jobMs } : {}),
  ...(workdir ? { workdir } : {}),
  ...(grants?.length ? { grants } : {}),
  ...(CREDS.length ? { credentials: CREDS } : {}),
});

/**
 * The session's own workspace, made real.
 *
 * `PERPETUAL_WORKDIR` points here whenever the reader has chosen nowhere, and
 * an agent told it may write somewhere that does not exist is an agent whose
 * first command fails for a reason it cannot see. Sessions are born with it;
 * this is for the ones that predate it.
 */
const ensureWorkspace = (id: string) =>
  mkdir(join(store.siteDir(id), "workspace"), { recursive: true }).catch(() => {});

/**
 * Which sections this turn may still write into.
 *
 * Everything that exists is published — except what the last turn left open,
 * and openness is decided by the controller at the end of a turn (see
 * `stillOpen`). A section that was cut off mid-write, or that is still
 * carrying validation problems, was never really published: sealing it would
 * make a half-written section permanent and forbid the agent from repairing
 * its own mistake.
 */
function sealedFor(site: Site, index: SessionIndex): string[] {
  const open = new Set(index.open ?? []);
  return site.pages.map((p) => p.id).filter((pid) => !open.has(pid));
}

/**
 * What to leave unsealed for the NEXT turn.
 *
 * Only sections this turn touched, and only for the two reasons above. A turn
 * that finished cleanly leaves nothing open, which is the point: the ordinary
 * outcome is that everything written becomes a record.
 */
function stillOpen(touched: string[], site: Site, stopped: string): string[] {
  const broken = new Set(site.problems.map((p) => p.page));
  const live = new Set(site.pages.map((p) => p.id));
  return touched.filter((pid) =>
    live.has(pid) && (stopped !== "done" || broken.has(pid)));
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

/**
 * Everything the client may fetch. An allowlist, not a path guard.
 *
 * The fonts are ENUMERATED into it at boot rather than matched by prefix, so
 * this stays a list of files that exist and never becomes `/fonts/` plus a
 * hope about `..`. plans/38 §5.5.
 */
const STATIC = new Set(["index.html", "style.css", "dist/main.js"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function allowFonts(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const n of names) {
    if (n.endsWith(".woff2") || n === "fonts.css" || n === "OFL.txt") {
      STATIC.add(`fonts/${n}`);
    }
  }
}

async function turn(req: IncomingMessage, res: ServerResponse, id: string) {
  if (inFlight.has(id)) return json(res, 409, { error: "a turn is already running" });
  if (inFlight.size >= MAX_CONCURRENT_TURNS) {
    return json(res, 503, {
      error: `${inFlight.size} turns are already running. Wait for one to finish.`,
    });
  }

  const held = await store.size(id);
  if (held > MAX_SESSION_BYTES) {
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;
    return json(res, 507, {
      error: `This session is holding ${mb(held)}, over the ${mb(MAX_SESSION_BYTES)} limit. ` +
             "Nothing has been deleted — the agent writes into the session's own directory, " +
             "so clear out what you no longer need, or start a new session.",
    });
  }

  const body = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  const { input, anchor, selection } = JSON.parse(body || "{}") as
    { input?: string; anchor?: { page?: string; index?: number; id?: string; quote?: string };
      selection?: Selection };
  if (!input?.trim()) return json(res, 400, { error: "input required" });

  const index = await store.read(id);
  // The session's own workspace, before anything is told it may write there.
  await ensureWorkspace(id);
  // What existed before the turn: needed to tell a NEW page from a rewritten
  // one.
  const before = await readSite(store.siteDir(id));
  const existing = new Set(before.pages.map((p) => p.id));

  // A click identifies itself, so nothing here has to be inferred. What the
  // reader touched is recorded the moment the turn starts — a choice is
  // answered whether or not the turn that followed produced anything, because
  // the reader answered it either way.
  // A choice on a PAGE is answered once and the answer stays there as the
  // record of it. A pick in a workspace is not an answer to anything — it is a
  // click in a surface that is about to be rewritten — so it is not recorded.
  if (selection?.control === "choice" && selection.block && !selection.app) {
    index.chosen[choiceKey(selection.page, selection.block)] = selection.option;
    await store.write(index);
  }

  // The session's model, not the process's — resolved BEFORE the stream
  // opens, because "no key for that provider" has to arrive as a plain 503
  // the composer can show, not as a headers-already-sent wreck. Built on
  // first use and kept.
  const forThisTurn = (await runtimeFor(index.model)) ?? runtime;
  if (!forThisTurn) {
    return json(res, 503, { error: runtimeError ?? "no model runtime available" });
  }

  const notes = new NoteQueue();
  const touched = new Set<string>();
  const ac = new AbortController();
  active.set(id, { notes, touched, abort: () => ac.abort() });

  inFlight.add(id);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  // On `res`, never on `req` — see disconnect.ts. Attached to the request's
  // body stream, this listener was registered after that stream had already
  // closed, so it never fired: the stop button stopped nothing and a closed
  // tab left the turn running to completion.
  onClientGone(req, res, () => ac.abort());

  const stream = runTurn({
    ask: input,
    runtime: forThisTurn,
    sandbox: sandboxFor(id, sealedFor(before, index), index.workdir, index.grants),
    pastAsks: index.asks,
    adapters: ADAPTERS,
    ...(anchor?.page ? {
      anchor: {
        page: anchor.page,
        ...(typeof anchor.index === "number" ? { index: anchor.index } : {}),
        ...(anchor.id ? { id: anchor.id } : {}),
        ...(typeof anchor.quote === "string" && anchor.quote.trim()
          ? { quote: anchor.quote.slice(0, 400) } : {}),
      },
    } : {}),
    ...(selection?.page && selection.option ? { selection } : {}),
    notes,
    answered: index.answered,
    chosen: index.chosen,
    signal: ac.signal,
    ...(effortValue() ? { effort: effortValue() as never } : {}),
    ...(HARNESS.turnMs || HARNESS.steps ? { limits: {
      ...(HARNESS.steps ? { steps: HARNESS.steps } : {}),
      ...(HARNESS.turnMs ? { turnMs: HARNESS.turnMs } : {}),
    } } : {}),
  });

  try {
    for await (const ev of stream) {
      // Which pages this turn is responsible for, known as it goes rather than
      // at the end — a report arrives mid-turn or it arrives too late.
      if (ev.type === "page_open" || ev.type === "page_replace") touched.add(ev.page.id);
      else if (ev.type.startsWith("page_") && "page" in ev && typeof ev.page === "string") {
        touched.add(ev.page);
      }
      send(ev);
    }
    const s = await stream.summary;

    const site = await readSite(store.siteDir(id));

    // A door spends only when a branch was actually TAKEN. If the turn amended
    // a page instead of writing one, no fork happened and the siblings stay
    // open — a click that went nowhere should not close anything off.
    //
    // Which door, though, used to be a GUESS: the ask was string-matched
    // against every door on every page, so typing a sentence that happened to
    // match one counted as clicking it, and two pages offering the same
    // question shared one record. The click now says which door it was, on
    // which page, so there is nothing left to match.
    const created = site.pages.map((p) => p.id).filter((pid) => !existing.has(pid));
    if (selection?.control === "next" && created[0]) {
      index.answered[doorKey(selection.page, selection.option)] = created[0];
    }

    index.asks.push(input);
    index.pageCount = site.pages.length;
    // Everything else this turn wrote is now a record.
    index.open = stillOpen(s.touched, site, s.stopped);
    // What this session is called. It used to be the first page's title, taken
    // once and frozen — which named every session after its opening word and
    // left a store of nine-page sessions all called "Hii". plans/46.
    const naming = nameFor(index, site.pages);
    if (naming) {
      index.title = naming.title;
      index.named = naming.named;
    }
    await store.write(index);
    await store.appendTurn(id, {
      at: new Date().toISOString(), ask: input,
      touched: s.touched, commands: s.commands, steps: s.steps, stopped: s.stopped,
      // A failed turn with no reason on record made every post-mortem start
      // from nothing. The message the reader saw is the message the record keeps.
      ...(s.error ? { error: s.error } : {}),
    });
    send({
      type: "turn_saved", pages: site.pages.length,
      answered: index.answered, chosen: index.chosen,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    send({ type: "error", message });
    // A failed turn is still something that happened. Recording it keeps the
    // session out of the sweep and leaves the failure visible, which is the
    // whole point of having a transcript.
    await store.appendTurn(id, {
      at: new Date().toISOString(), ask: input, touched: [], commands: [], steps: 0,
      stopped: "error", error: message,
    }).catch(() => {});
  } finally {
    active.delete(id);
    inFlight.delete(id);
    res.end();
  }
}

/**
 * The client saying what a page turned out to look like.
 *
 * The only route that carries information the OTHER way — everywhere else the
 * client asks and the server answers. It is fire-and-forget by design: this is
 * advice for an agent, and a report that misses its turn is worth nothing but
 * must cost nothing either, so a late one is accepted and dropped rather than
 * failing anything the reader can see.
 */
async function rendered(req: IncomingMessage, res: ServerResponse, id: string) {
  const body = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  const turnNow = active.get(id);
  // No turn running: nobody is left who could act on it.
  if (!turnNow) return json(res, 204, {});
  try {
    const report = JSON.parse(body || "{}") as RenderReport;
    if (Array.isArray(report.pages)) turnNow.notes.add(report, turnNow.touched);
  } catch { /* a malformed report is not worth a word to anyone */ }
  return json(res, 204, {});
}

/**
 * A row in a workspace was picked, and it carries its own command.
 *
 * THE POINT OF THIS ENDPOINT is that no model is involved. Opening a file you
 * can already see is not a question — it needs no judgement, and paying three
 * seconds and a model call for it is what makes a generated app feel like a
 * chatbot wearing a costume. The agent writes the view AND what each row does;
 * this runs it and hands back what the view became.
 *
 * The command comes off the DISK, never off the wire. The click names a
 * workspace, a block and an option; what runs is whatever the agent wrote
 * beside that option. Trusting the posted command would turn a click into a
 * shell.
 */
const ACT_TIMEOUT_SEC = 20;

async function act(req: IncomingMessage, res: ServerResponse, id: string) {
  if (inFlight.has(id)) return json(res, 409, { error: "a turn is running" });

  const body = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  const { app, block, option, values } = JSON.parse(body || "{}") as
    { app?: string; block?: string; option?: string; values?: Record<string, unknown> };
  if (!app || !block || !option) return json(res, 400, { error: "app, block and option" });

  const { apps } = await readApps(store.siteDir(id), undefined, ADAPTER_BINS());
  const view = apps.find((a) => a.id === app);
  if (!view) return json(res, 404, { error: `no workspace called ${app}` });

  const found = commandFor(view, block, option);
  // Not every row acts. One without a command is a question for the agent, and
  // the client asks it as a turn instead — this says so rather than guessing.
  if (!found) return json(res, 200, { ran: false, app: view });

  const idx = await store.read(id);
  const cfg = sandboxFor(
    id, sealedFor(await readSite(store.siteDir(id)), idx), idx.workdir, idx.grants);
  // The workspace's own directory joins the PATH for its own clicks, so an
  // app is a directory holding its view AND its verbs: a helper script the
  // agent shipped beside view.ndjson runs by name, the way an adapter's does.
  const shell = createShell({
    ...cfg,
    binPaths: [join(mountPath(cfg), "ui", "apps", app), ...(cfg.binPaths ?? [])],
  });
  const r = await shell.run({
    command: found.run,
    timeoutSec: ACT_TIMEOUT_SEC,
    // Only the fields the form itself declared, and only as environment. See
    // `fieldEnv`: this is the seam where reader-authored text meets a shell.
    ...(found.fields ? { env: fieldEnv(values, found.fields) } : {}),
  });

  // Whatever the command did to the view, the answer is the view as it now is.
  const after = await readApps(store.siteDir(id), undefined, ADAPTER_BINS());
  return json(res, 200, {
    ran: true,
    exitCode: r.exitCode,
    // A tail, not a log: enough to explain a failure, never a terminal.
    output: r.text.split("\n").slice(-4).join("\n").slice(-1200),
    app: after.apps.find((a) => a.id === app) ?? null,
    problems: after.problems,
  });
}

/**
 * What the reader chose for this session: where it may write, and which model.
 *
 * Both are CHROME decisions, which is why they arrive here rather than through
 * anything the agent can reach. A turn that could widen its own write access
 * would make the working directory a suggestion.
 */
/**
 * The reader ALLOWS a directory. plans/45.
 *
 * The whole security argument for `grant` lives in this function being here
 * rather than in the agent's hands: the block on the page is a request, and
 * this endpoint — which no command in the sandbox can reach — is the only
 * thing that can turn one into access.
 *
 * Three gates, and each closes a different door:
 *
 *   WITHIN THE HOME DIRECTORY, like the picker. `/etc` is not on offer.
 *   IT MUST EXIST, and be a directory. bwrap cannot bind a path that is not
 *   there, and the failure would surface as a sandbox that will not start.
 *   IT MUST HAVE BEEN ASKED FOR. The path has to match a `grant` block the
 *   agent actually wrote and the reader actually saw. Nothing can be granted
 *   that was never on screen — not by a stray request, and not by a page the
 *   reader never read.
 */
async function grant(req: IncomingMessage, res: ServerResponse, id: string) {
  if (inFlight.has(id)) return json(res, 409, { error: "a turn is running" });
  const body = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  const { path, revoke } = JSON.parse(body || "{}") as { path?: string; revoke?: boolean };
  if (!path) return json(res, 400, { error: "path required" });

  const full = within(path);
  if (!full) return json(res, 400, { error: "That is outside your home directory." });

  // REVOKE: the door swings both ways. plans/49. Granting needed three gates;
  // taking access away needs none of them — narrowing the agent's reach is
  // always the reader's to do, even for a directory that no longer exists.
  // The next turn simply does not mount it, and the record says where the
  // access ended, the same way it says where the workspace moved.
  if (revoke) {
    const index = await store.read(id);
    if (!index.grants?.includes(full)) {
      return json(res, 400, { error: "That directory is not granted." });
    }
    index.grants = index.grants.filter((g) => g !== full);
    if (!index.grants.length) delete index.grants;
    const site = await readSite(store.siteDir(id));
    if (site.pages.length > 0) {
      index.moves = [...(index.moves ?? []), {
        at: new Date().toISOString(), after: site.pages.length, revoked: full,
      }];
    }
    await store.write(index);
    return json(res, 200, { grants: index.grants ?? [], moves: index.moves ?? [] });
  }

  const ok = await stat(full).then((s) => s.isDirectory(), () => false);
  if (!ok) return json(res, 400, { error: `There is no directory at ${full}.` });

  const site = await readSite(store.siteDir(id));
  const asked = site.pages.some((pg) => pg.blocks.some(
    (b) => b.kind === "grant" && within(b.path) === full));
  if (!asked) {
    return json(res, 400, {
      error: "Nothing on this site asked for that directory.",
    });
  }

  const index = await store.read(id);
  index.grants = [...new Set([...(index.grants ?? []), full])];
  await store.write(index);
  return json(res, 200, { grants: index.grants });
}

/**
 * A picture, by name, out of one page's own directory.
 *
 * Served rather than inlined: a screenshot is a megabyte, and a megabyte of
 * base64 riding every event that mentions the block would be paid for on
 * every poll. The client asks for it once and the browser caches it.
 *
 * The path is built from two tightly-shaped fragments and never from anything
 * the request says directly — a page id that looks like a page id, a filename
 * that looks like an image — and the result is checked to be inside the
 * directory it was supposed to be in. Three chances to reject, before any
 * byte is read.
 */
async function asset(req: IncomingMessage, res: ServerResponse, id: string, url: URL) {
  const file = url.searchParams.get("file") ?? "";
  const page = url.searchParams.get("page");
  const app = url.searchParams.get("app");
  if (!IMAGE_RE.test(file)) return json(res, 400, { error: "not an image name" });

  let dir: string;
  if (page && /^\d{3,}-[a-z0-9][a-z0-9-]*$/.test(page)) {
    dir = join(store.siteDir(id), PAGES_REL, page);
  } else if (app && /^[a-z0-9][a-z0-9-]{0,31}$/.test(app)) {
    dir = join(store.siteDir(id), APPS_REL, app);
  } else {
    return json(res, 400, { error: "page or app required" });
  }

  const full = join(dir, file);
  if (!full.startsWith(dir + sep)) return json(res, 400, { error: "outside the page" });

  const data = await readFile(full).catch(() => null);
  if (!data) return json(res, 404, { error: "no such image" });
  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    "content-type": IMAGE_MIME[ext] ?? "application/octet-stream",
    "content-length": String(data.length),
    // The bytes never change under a name: a new picture is a new file.
    "cache-control": "public, max-age=31536000, immutable",
  });
  return res.end(data);
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
};

/**
 * Is this a model this server can be asked for? Either one of the curated
 * unqualified ids (the boot provider's), or `provider:model` where the
 * provider is known and the model is in its catalogue.
 */
function validModel(id: string): boolean {
  if (MODELS.includes(id)) return true;
  const at = id.indexOf(":");
  if (at <= 0) return false;
  const provider = id.slice(0, at);
  const entry = PROVIDERS[provider];
  if (!entry) return false;
  const model = id.slice(at + 1);
  const cat = catalogueOf(provider);
  return cat.includes(model) || (Boolean(entry.prefix) && cat.includes(entry.prefix + model));
}

/**
 * The providers, for the model menu. Facts only — which exist, which have a
 * key and from where, and what each one offers. Never a key itself: the
 * store is write-only from the outside, like every password field.
 */
async function providers(res: ServerResponse) {
  const out = [];
  for (const [pid, entry] of Object.entries(PROVIDERS)) {
    const source = await keySource(pid, entry.keyEnv);
    out.push({
      id: pid,
      title: entry.title,
      keyEnv: entry.keyEnv,
      hasKey: source !== null,
      // "env" keys cannot be cleared from the UI — the environment is the
      // scripts' channel and the UI must not pretend to control it.
      source,
      models: catalogueOf(pid),
      ...(entry.prefix ? { prefix: entry.prefix } : {}),
      ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
    });
  }
  return json(res, 200, { providers: out, bootProvider: PROVIDER, models: MODELS });
}

/**
 * Set or clear one provider's API key. Chrome-only, like every setting: the
 * agent has no route to any endpoint, so it can never read, set, or exfiltrate
 * a key by asking nicely.
 */
async function providerKey(req: IncomingMessage, res: ServerResponse) {
  const body = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  const { provider, key } = JSON.parse(body || "{}") as { provider?: string; key?: string | null };
  const entry = provider ? PROVIDERS[provider] : undefined;
  if (!provider || !entry) return json(res, 400, { error: "unknown provider" });

  await setKey(provider, key ?? null);
  // Runtimes hold the old key; drop this provider's so the next turn builds
  // with the new one. A wrong key becomes a one-paste fix, not a restart.
  for (const k of [...runtimes.keys()]) if (k.startsWith(`${provider}:`)) runtimes.delete(k);
  if (provider === PROVIDER) { runtime = await runtimeFor(); }
  const source = await keySource(provider, entry.keyEnv);
  return json(res, 200, { provider, hasKey: source !== null, source });
}

async function settings(req: IncomingMessage, res: ServerResponse, id: string) {
  if (inFlight.has(id)) return json(res, 409, { error: "a turn is running" });
  const body = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  const { workdir, model } = JSON.parse(body || "{}") as
    { workdir?: string | null; model?: string | null };

  const index = await store.read(id);
  if (workdir !== undefined) {
    /**
     * THE WORKSPACE MAY CHANGE, AND THE RECORD SAYS WHEN. plans/47.
     *
     * It used to be fixed the moment a session wrote anything, and the
     * argument was the seal's: a section is a record of work done in a place,
     * so if the place moves underneath it, page 003 edited `x.ts` and page 007
     * edited a DIFFERENT `x.ts` with nothing on screen telling them apart.
     *
     * That argument survives; the prohibition does not. It was written when a
     * session had exactly ONE writable directory, so freezing it was the only
     * way to keep the record honest. Grants ended that — the reader can widen
     * a session mid-flight by allowing a directory — so the set of writable
     * places is already mutable, and bolting this one door while the other
     * stands open was a leftover rather than a boundary. In practice it locked
     * the picker on the reader's first answer, which is exactly when they have
     * seen enough to know which project they meant.
     *
     * So: allow it, and make the record TRUE rather than fixed. Every move is
     * kept, with the number of pages that existed when it happened, and the
     * chrome draws a line in the flow at that point. The two `x.ts` are told
     * apart by saying where the work moved, which is what the reader needed
     * all along.
     */
    const site = await readSite(store.siteDir(id));
    const before = index.workdir;

    if (workdir === null || workdir === "") delete index.workdir;
    else {
      const full = within(workdir);
      if (!full) return json(res, 400, { error: "That is outside your home directory." });
      const ok = await stat(full).then((s) => s.isDirectory(), () => false);
      if (!ok) return json(res, 400, { error: `There is no directory at ${full}.` });
      index.workdir = full;
    }

    // Only a real move, and only once the session has a history to be honest
    // about. Choosing before anything is written is not a move — it is the
    // choice, and there is nothing behind it to distinguish.
    if (index.workdir !== before && site.pages.length > 0) {
      index.moves = [...(index.moves ?? []), {
        at: new Date().toISOString(),
        after: site.pages.length,
        ...(before ? { from: before } : {}),
        ...(index.workdir ? { to: index.workdir } : {}),
      }];
    }
  }
  if (model !== undefined) {
    if (model === null || model === "") delete index.model;
    else if (!validModel(model)) return json(res, 400, { error: "unknown model" });
    else index.model = model;
  }
  await store.write(index);
  return json(res, 200, index);
}

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  // A base the parser needs and nothing reads: req.url is always a path.
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;

  try {
    if (p === "/health") {
      return json(res, 200, {
        ok: true,
        model: runtime?.modelId ?? null,
        models: MODELS,
        provider: REPLAY ? "replay" : PROVIDER,
        hasKey: REPLAY || Boolean(API_KEY),
        replay: REPLAY,
        sandbox: describeSandbox({ root: "", net: NET, unsafe: UNSAFE,
          ...(CREDS.length ? { credentials: CREDS } : {}) }),
        root: ROOT,
        // Every tool, with its verdict — ready, broken and why, or waiting on
        // something. The chrome shows this so a dead tool is a chip you can
        // read, not a surprise mid-answer.
        tools: ADAPTERS.map((a) => ({
          name: a.name, title: a.title,
          ok: !a.unavailable,
          checked: a.healthy === true || Boolean(a.unavailable),
          ...(a.unavailable ? { note: a.unavailable } : {}),
        })),
      });
    }
    // The directory picker's backing store. Names of directories, nothing else.
    if (p === "/dirs") {
      return json(res, 200, await listDirs(url.searchParams.get("path") ?? undefined));
    }
    if (p === "/models") {
      return json(res, 200, { models: MODELS, current: runtime?.modelId ?? null });
    }
    if (p === "/providers" && req.method === "GET") return await providers(res);
    if (p === "/providers/key" && req.method === "POST") return await providerKey(req, res);

    // What the agent is told, verbatim. Nothing about this product should be
    // easier for the agent to know than for the person running it.
    if (p === "/prompt" && req.method === "GET") {
      return json(res, 200, { system: await systemPrompt() });
    }

    if (p === "/platform" && req.method === "GET") {
      return json(res, 200, {
        sandboxed: !UNSAFE,
        net: { value: NET, source: NET_SOURCE },
        credentials: {
          available: Object.keys(CREDENTIALS),
          visible: CREDS,
          source: CREDS_SOURCE,
        },
        sandbox: describeSandbox({ root: "", net: NET, unsafe: UNSAFE,
          ...(CREDS.length ? { credentials: CREDS } : {}) }),
        harness: {
          turnMs: { value: HARNESS.turnMs ?? MAX_TURN_MS, source: HARNESS.turnMs ? "stored" : "default" },
          steps: { value: HARNESS.steps ?? MAX_STEPS, source: HARNESS.steps ? "stored" : "default" },
          jobMs: { value: HARNESS.jobMs ?? JOB_MAX_MS, source: HARNESS.jobMs ? "stored" : "default" },
          effort: { value: effortValue() ?? "default", source: effortSource() },
          // The calibrations, shown so a stopped turn can be traced to the
          // exact rule that stopped it — and fixed, because these interact
          // with each other and with model behaviour, and a wrong value
          // degrades the agent in ways that look like a broken product.
          fixed: [
            { label: "Repeated command", value: `told at ${REPEAT_TELL}, stopped at ${REPEAT_STOP}`,
              why: "the same command producing the same output is going nowhere" },
            { label: "Failing commands", value: `told at ${STUCK_TELL}, stopped at ${STUCK_STOP}`,
              why: "a streak of failures is stopped only after telling did not help" },
            { label: "Budget countdown", value: `last ${WARN_AT} steps`,
              why: "a warned agent lands the page; an unwarned one is cut off mid-sentence" },
            { label: "Context stop", value: "92% of the window",
              why: "stopped deliberately, before the provider refuses" },
            { label: "Command timeout", value: `${DEFAULT_TIMEOUT_SEC}s, max ${600}s`,
              why: "per shell command; the agent may ask for longer up to the max" },
            { label: "Background jobs", value: `${MAX_JOBS} per session`,
              why: "enough for a build and a server side by side" },
            { label: "Speech repairs", value: `${MAX_REJECT_NOTES} per turn`,
              why: "a model streaming bad lines runs out of patience before steps" },
          ],
        },
      });
    }
    if (p === "/platform" && req.method === "POST") {
      if (inFlight.size) return json(res, 409, { error: "a turn is running" });
      const body = await new Promise<string>((r) => {
        let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
      });
      const { net, credentials, harness } = JSON.parse(body || "{}") as
        { net?: boolean; credentials?: string[]; harness?: Harness };
      // An environment-set value is not the UI's to change — honesty means
      // saying who is in charge, not pretending.
      if (net !== undefined) {
        if (NET_SOURCE === "env") {
          return json(res, 409, { error: "PERPETUAL_NET is set in the environment" });
        }
        NET = Boolean(net); NET_SOURCE = "stored";
      }
      if (credentials !== undefined) {
        if (CREDS_SOURCE === "env") {
          return json(res, 409, { error: "PERPETUAL_CREDENTIALS is set in the environment" });
        }
        if (!Array.isArray(credentials) || credentials.some((c) => !(c in CREDENTIALS))) {
          return json(res, 400, { error: "unknown credential name" });
        }
        CREDS = credentials; CREDS_SOURCE = "stored";
      }
      if (harness !== undefined) {
        const next: Harness = { ...HARNESS };
        if ("turnMs" in harness) {
          if (harness.turnMs == null) delete next.turnMs;
          else next.turnMs = Math.min(20 * 60_000, Math.max(60_000, Number(harness.turnMs)));
        }
        if ("steps" in harness) {
          if (harness.steps == null) delete next.steps;
          else next.steps = Math.min(80, Math.max(10, Number(harness.steps)));
        }
        if ("jobMs" in harness) {
          if (harness.jobMs == null) delete next.jobMs;
          else next.jobMs = Math.min(JOB_CEILING_MS, Math.max(60_000, Number(harness.jobMs)));
        }
        if ("effort" in harness) {
          if (process.env.PERPETUAL_EFFORT) {
            return json(res, 409, { error: "PERPETUAL_EFFORT is set in the environment" });
          }
          if (harness.effort == null || harness.effort === "default") delete next.effort;
          else if (!EFFORTS.includes(harness.effort)) {
            return json(res, 400, { error: "effort is low, medium or high" });
          } else next.effort = harness.effort;
        }
        HARNESS = next;
      }
      await savePlatform();
      await loadAdapters();               // credential availability changed with it
      void checkAdapters().catch(() => {});
      return json(res, 200, { net: NET, credentials: CREDS, harness: HARNESS });
    }
    if (p === "/sessions" && req.method === "POST") {
      // No shared default any more: a session writes in its own directory
      // until the reader points it somewhere real. plans/45.
      const made = await store.create();
      return json(res, 200, made);
    }
    if (p === "/sessions" && req.method === "GET") {
      // Swept on the way to the library, which is the only place they would
      // have been seen. Never touches a session with a turn running.
      await store.sweep({ graceMs: SWEEP_GRACE_MS, skip: inFlight }).catch(() => []);
      return json(res, 200, await store.list());
    }

    const m = /^\/sessions\/([a-f0-9]+)(\/turn|\/site|\/rendered|\/apps|\/act|\/settings|\/grant|\/asset|\/jobs)?$/.exec(p);
    if (m) {
      const id = m[1]!;
      if (m[2] === "/asset" && req.method === "GET") return await asset(req, res, id, url);
      // The only route that can widen what a session may write, and the agent
      // cannot reach any route at all. plans/45.
      if (m[2] === "/grant" && req.method === "POST") return await grant(req, res, id);
      if (m[2] === "/settings" && req.method === "POST") return await settings(req, res, id);
      if (m[2] === "/turn" && req.method === "POST") return await turn(req, res, id);
      if (m[2] === "/rendered" && req.method === "POST") return await rendered(req, res, id);
      if (m[2] === "/act" && req.method === "POST") return await act(req, res, id);
      if (m[2] === "/apps" && req.method === "DELETE") {
        // The reader closes a workspace, and closing it means it is GONE — a
        // panel that reappears on reload was not closed, it was hidden.
        const app = url.searchParams.get("app") ?? "";
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(app)) return json(res, 400, { error: "app" });
        await rm(join(store.siteDir(id), APPS_REL, app), { recursive: true, force: true });
        return json(res, 200, { closed: app });
      }
      // The session's background jobs: visible, stoppable, pinnable — all
      // chrome. The agent's own stop channel is a file; these are the reader's.
      if (m[2] === "/jobs" && req.method === "GET") {
        return json(res, 200, { jobs: listJobs(store.siteDir(id)) });
      }
      if (m[2] === "/jobs" && req.method === "POST") {
        const body = await new Promise<string>((r) => {
          let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
        });
        const { job, action } = JSON.parse(body || "{}") as { job?: string; action?: string };
        if (!job || !action) return json(res, 400, { error: "job and action" });
        const root = store.siteDir(id);
        const ok = action === "stop" ? stopJob(root, job)
          : action === "pin" ? pinJob(root, job, true)
          : action === "unpin" ? pinJob(root, job, false)
          : null;
        if (ok === null) return json(res, 400, { error: "action is stop, pin or unpin" });
        if (!ok) return json(res, 404, { error: "no such running job" });
        return json(res, 200, { jobs: listJobs(root) });
      }
      if (m[2] === "/apps") {
        return json(res, 200, await readApps(store.siteDir(id), undefined, ADAPTER_BINS()));
      }
      if (!m[2] && req.method === "DELETE") {
        if (inFlight.has(id)) return json(res, 409, { error: "a turn is running" });
        // Everything the session started goes with it, jobs included.
        killJobsFor(store.siteDir(id));
        await store.remove(id);
        return json(res, 200, { removed: id });
      }
      if (m[2] === "/site") return json(res, 200, await readSite(store.siteDir(id)));
      if (req.method === "GET") {
        // The index, plus how the LAST turn ended — so a session reopened
        // after a crash can offer to continue instead of presenting a
        // half-written page as if it were finished. plans/48. Response-only:
        // derived from the transcript on the way out, never stored twice.
        const index = await store.read(id);
        const last = (await store.transcript(id)).at(-1);
        return json(res, 200, {
          ...index,
          ...(last ? { lastTurn: {
            stopped: last.stopped ?? "done",
            ask: last.ask,
            ...(last.error ? { error: last.error } : {}),
          } } : {}),
        });
      }
    }

    const rel = p === "/" ? "index.html" : normalize(p).replace(/^[/\\]+/, "");
    if (!STATIC.has(rel)) return json(res, 404, { error: "not found" });
    const file = join(CLIENT, rel);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    return res.end(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(res, msg.includes("ENOENT") ? 404 : 500, { error: msg });
  }
};

/**
 * Read the adapters, once.
 *
 * Not per turn: they are configuration, they do not change while the server
 * runs, and the complaint about a broken one has to be loud — an adapter with
 * a bad manifest is one the agent is never told about, which looks exactly
 * like an adapter that was never installed.
 */
async function loadAdapters(): Promise<void> {
  HAS_LOCAL_ADAPTERS = await stat(LOCAL_ADAPTERS).then((s) => s.isDirectory(), () => false);
  const { adapters, problems } = await readAdapters(
    HAS_LOCAL_ADAPTERS ? LOCAL_ADAPTERS : undefined);
  ADAPTERS = adapters;
  for (const p of problems) console.error(`  tool ${p.name}: ${p.message}`);

  // A tool whose credential is not in the namespace is told about ANYWAY, with
  // the reason attached. The agent then declines for the right cause instead of
  // running a command and reading a stack trace, and the reader learns there is
  // something to configure rather than that the tool was never built.
  for (const a of ADAPTERS) {
    const missing = a.needs
      .filter((n) => n.startsWith("credential:"))
      .map((n) => n.slice("credential:".length))
      .filter((n) => !CREDS.includes(n));
    if (missing.length) {
      a.unavailable = `${missing.join(", ")} is not visible in the sandbox — ` +
        'turn it on under "Act as you" in settings';
    }
  }
}

/** What the banner says, so both callers say the same thing about the machine. */
export function describeBoot(): Record<string, string> {
  return {
    provider: REPLAY ? "replay" : PROVIDER,
    model: runtime?.modelId ?? runtimeError ?? "unavailable",
    key: REPLAY ? "replay mode (no key needed)"
      : API_KEY ? `${KEY_ENV} set` : `${KEY_ENV} NOT SET — /turn will 503`,
    sandbox: describeSandbox({ root: "", net: NET, unsafe: UNSAFE,
      ...(CREDS.length ? { credentials: CREDS } : {}) }),
    sessions: ROOT,
    tools: ADAPTERS.length
      ? ADAPTERS.map((a) => a.name + (a.local ? "*" : "")).join(", ")
      : "none",
  };
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  // First, before anything reads a setting — including the bwrap refusal,
  // which depends on PERPETUAL_UNSAFE.
  readEnv();

  const problem = sandboxProblem();
  if (problem) throw new Error(problem);

  ROOT = opts.root ?? defaultHome();
  CLIENT = opts.client ?? join(repoRoot(), "packages", "client");
  LOCAL_ADAPTERS = join(ROOT, "tools");
  store = new SessionStore(ROOT);
  credentialsFile(defaultCredentialsFile(ROOT));
  await loadPlatform();
  // The agent's tool notebook — real before the first bind wants it.
  await mkdir(join(ROOT, "notes"), { recursive: true });

  // A bad key or provider is still discovered here rather than on the
  // reader's first question — but a MISSING key is no longer fatal: the
  // model menu can add one while the app runs, so the server starts and
  // says what is needed instead of refusing to exist.
  runtime = await runtimeFor();

  // Read before the first turn can ask for them.
  await loadAdapters();
  // Self-tests run AFTER boot, not on it: a slow check must not hold the
  // window, and a turn that starts first simply sees "not checked yet".
  void checkAdapters().catch(() => {});
  await allowFonts(join(CLIENT, "fonts"));

  const host = opts.host ?? "127.0.0.1";
  const want = opts.port ?? Number(process.env.PORT ?? 4321);
  const server = createServer(handle);

  await new Promise<void>((ok, fail) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      // A stale controller from an earlier run is the overwhelmingly likely
      // cause, and the default trace says none of that. Only worth saying when
      // a port was ASKED for — an ephemeral one cannot collide.
      if (e.code === "EADDRINUSE" && want !== 0) {
        fail(new Error(
          `Port ${want} is already in use — most likely a controller still ` +
          `running from an earlier session. Either stop it (fuser -k ${want}/tcp), ` +
          `or start this one somewhere else (PORT=${want + 1}).`));
      } else fail(e);
    });
    server.listen(want, host, ok);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : want;

  return {
    server, port, url: `http://${host}:${port}`,
    /**
     * Stop, and take the turns with it. plans/38 §5.6.
     *
     * A turn is a model stream AND a bwrap process tree. `onClientGone` covers
     * a closed tab; it does not cover the process itself going away, because
     * the socket may never get the chance to notice. So the aborts happen
     * first, explicitly, and `close` waits for the sockets they were writing to.
     */
    async close() {
      for (const t of active.values()) t.abort();
      active.clear();
      // Background jobs are the controller's wards; the controller is leaving.
      killAllJobs();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
