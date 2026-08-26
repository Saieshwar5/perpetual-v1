/**
 * The local controller. plans/13 §9.
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
import { readFile } from "node:fs/promises";
import { join, extname, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, PROVIDERS, type Runtime } from "./runtime.ts";
import { createReplayRuntime } from "./replay-runtime.ts";
import { SessionStore } from "./sessions.ts";
import { readSite } from "./site.ts";
import { runTurn } from "./agent.ts";
import { bwrapAvailable, describeSandbox, type SandboxConfig } from "./shell/sandbox.ts";

// Anchored to this module, never to process.cwd(): `pnpm dev` runs the server
// from packages/controller, where a cwd-relative path silently resolves wrong.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

const PORT = Number(process.env.PORT ?? 4321);
const ROOT = process.env.PERPETUAL_HOME ?? join(REPO, ".perpetual");
const CLIENT = join(REPO, "packages", "client");
const REPLAY = process.env.PERPETUAL_REPLAY === "1";
const PROVIDER = process.env.PERPETUAL_PROVIDER ?? "anthropic";
/** The env var that must hold the key, for whichever provider is selected. */
const KEY_ENV = PROVIDERS[PROVIDER]?.keyEnv ?? "ANTHROPIC_API_KEY";
const API_KEY = process.env[KEY_ENV];
const UNSAFE = process.env.PERPETUAL_UNSAFE === "1";
const NET = process.env.PERPETUAL_NET === "1";

const store = new SessionStore(ROOT);
const inFlight = new Set<string>();

/** How long an unused session survives before the sweep takes it. */
const SWEEP_GRACE_MS = 10 * 60_000;

// A missing sandbox is a refusal, not a downgrade. The machine without bwrap
// is exactly the machine where running unsandboxed matters most.
if (!UNSAFE && !bwrapAvailable()) {
  console.error(
    "\n  bubblewrap (bwrap) is not installed, and the agent runs arbitrary shell\n" +
    "  commands. Install it (Arch: pacman -S bubblewrap), or set PERPETUAL_UNSAFE=1\n" +
    "  to run without any containment. Do not do the second one casually.\n",
  );
  process.exit(1);
}

let runtime: Runtime | null = null;
let runtimeError: string | null = null;
try {
  runtime = REPLAY ? createReplayRuntime() : createRuntime({
    provider: PROVIDER,
    ...(API_KEY ? { apiKey: API_KEY } : {}),
    ...(process.env.PERPETUAL_MODEL ? { model: process.env.PERPETUAL_MODEL } : {}),
  });
} catch (e) {
  runtimeError = e instanceof Error ? e.message : String(e);
}

const sandboxFor = (id: string): SandboxConfig =>
  ({ root: store.siteDir(id), net: NET, unsafe: UNSAFE });

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

/** Everything the client may fetch. An allowlist, not a path guard. */
const STATIC = new Set(["index.html", "style.css", "dist/main.js"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function turn(req: IncomingMessage, res: ServerResponse, id: string) {
  if (!runtime) return json(res, 503, { error: runtimeError ?? "runtime unavailable" });
  if (!REPLAY && !API_KEY) {
    return json(res, 503, {
      error: `${KEY_ENV} is not set. Put it in .env or export it and restart, ` +
             "or run `pnpm replay` to exercise the pipeline without a key.",
    });
  }
  if (inFlight.has(id)) return json(res, 409, { error: "a turn is already running" });

  const body = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  const { input, anchor } = JSON.parse(body || "{}") as
    { input?: string; anchor?: { page?: string; index?: number } };
  if (!input?.trim()) return json(res, 400, { error: "input required" });

  const index = await store.read(id);
  // What existed before the turn: needed to tell a NEW page from a rewritten
  // one, and to look up the doors that were on offer when the reader clicked.
  const before = await readSite(store.siteDir(id));
  const existing = new Set(before.pages.map((p) => p.id));

  inFlight.add(id);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const stream = runTurn({
    ask: input,
    runtime,
    sandbox: sandboxFor(id),
    pastAsks: index.asks,
    ...(anchor?.page ? {
      anchor: { page: anchor.page, ...(typeof anchor.index === "number" ? { index: anchor.index } : {}) },
    } : {}),
    signal: ac.signal,
    ...(process.env.PERPETUAL_EFFORT ? { effort: process.env.PERPETUAL_EFFORT as never } : {}),
  });

  try {
    for await (const ev of stream) send(ev);
    const s = await stream.summary;

    const site = await readSite(store.siteDir(id));

    // A door spends only when a branch was actually TAKEN. If the turn amended
    // a page instead of writing one, no fork happened and the siblings stay
    // open — a click that went nowhere should not close anything off.
    const created = site.pages.map((p) => p.id).filter((pid) => !existing.has(pid));
    const wasADoor = before.pages.some(
      (p) => p.blocks.some((b) => b.kind === "next" && b.items.includes(input)),
    );
    if (wasADoor && created[0]) index.answered[input] = created[0];

    index.asks.push(input);
    index.pageCount = site.pages.length;
    // The session takes its name from its first page — the same way a website
    // is named by its home page rather than by a field someone had to fill in.
    if (site.pages[0]) index.title = site.pages[0].title;
    await store.write(index);
    await store.appendTurn(id, {
      at: new Date().toISOString(), ask: input,
      touched: s.touched, commands: s.commands, steps: s.steps, stopped: s.stopped,
    });
    send({ type: "turn_saved", pages: site.pages.length, answered: index.answered });
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
    inFlight.delete(id);
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    if (p === "/health") {
      return json(res, 200, {
        ok: true,
        model: runtime?.modelId ?? null,
        provider: REPLAY ? "replay" : PROVIDER,
        hasKey: REPLAY || Boolean(API_KEY),
        replay: REPLAY,
        sandbox: describeSandbox({ root: "", net: NET, unsafe: UNSAFE }),
        root: ROOT,
      });
    }
    if (p === "/sessions" && req.method === "POST") return json(res, 200, await store.create());
    if (p === "/sessions" && req.method === "GET") {
      // Swept on the way to the library, which is the only place they would
      // have been seen. Never touches a session with a turn running.
      await store.sweep({ graceMs: SWEEP_GRACE_MS, skip: inFlight }).catch(() => []);
      return json(res, 200, await store.list());
    }

    const m = /^\/sessions\/([a-f0-9]+)(\/turn|\/site)?$/.exec(p);
    if (m) {
      const id = m[1]!;
      if (m[2] === "/turn" && req.method === "POST") return await turn(req, res, id);
      if (!m[2] && req.method === "DELETE") {
        if (inFlight.has(id)) return json(res, 409, { error: "a turn is running" });
        await store.remove(id);
        return json(res, 200, { removed: id });
      }
      if (m[2] === "/site") return json(res, 200, await readSite(store.siteDir(id)));
      if (req.method === "GET") return json(res, 200, await store.read(id));
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
});

// A stale controller from an earlier run is the overwhelmingly likely cause,
// and the default trace says none of that.
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(
    `\n  Port ${PORT} is already in use — most likely a controller still running\n` +
    "  from an earlier session. Either stop it:\n\n" +
    `      fuser -k ${PORT}/tcp\n\n` +
    "  or start this one somewhere else:\n\n" +
    `      PORT=4322 pnpm dev\n`,
  );
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  perpetual  http://127.0.0.1:${PORT}`);
  console.log(`  provider  ${REPLAY ? "replay" : PROVIDER}`);
  console.log(`  model     ${runtime?.modelId ?? runtimeError ?? "unavailable"}`);
  console.log(`  key       ${REPLAY ? "replay mode (no key needed)"
    : API_KEY ? `${KEY_ENV} set` : `${KEY_ENV} NOT SET — /turn will 503`}`);
  console.log(`  sandbox   ${describeSandbox({ root: "", net: NET, unsafe: UNSAFE })}`);
  console.log(`  sessions  ${ROOT}\n`);
});
