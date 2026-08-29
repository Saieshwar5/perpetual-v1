/**
 * The Electron main process. plans/38 §3, §7 phase 2.
 *
 * The controller runs HERE — imported, not spawned, listening on an ephemeral
 * loopback port — and the window loads that port. Which means the renderer is
 * the same origin it has always been, every `fetch("/sessions")` in the client
 * keeps working unedited, and there is exactly one process tree to quit.
 *
 * What this file is responsible for, and nothing else:
 *
 *   - finding the controller's resources, which packaging moves (§5.1)
 *   - starting the server and holding the handle that stops it (§5.6)
 *   - a window that cannot be talked into becoming a Node process (§9)
 *
 * It deliberately does NOT know about blocks, pages, turns or the agent. The
 * day it does, the browser mode is dead and plans/38 §8 has been broken.
 */
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServer, describeBoot, type RunningServer } from "@perpetual/controller";
import { setResources } from "@perpetual/controller/paths";

/**
 * Where our own files ended up.
 *
 * Two layouts, and the difference is the whole of §5.1/§5.2. From source,
 * `packages/controller` and `packages/client` sit beside this package. Packaged,
 * they are inside `app.asar` — except `sandbox-bin/` and `adapters/`, which
 * bwrap BINDS and the kernel EXECS, so electron-builder unpacks them and they
 * are reached through `app.asar.unpacked` instead.
 */
function locate(): { read: string; mount: string; client: string } {
  const appPath = app.getAppPath();                 // …/app.asar when packaged
  const packaged = appPath.includes("app.asar");
  if (!packaged) {
    // From `dist/`, up to `packages/`, across. NOT `app.getAppPath()`: run as
    // `electron dist/main.cjs` that is the SCRIPT's directory, not the
    // package's, and the difference is one level — which resolves to a
    // directory that does not exist and shows up only as "tools: none".
    const packages = join(__dirname, "..", "..");
    const controller = join(packages, "controller");
    // From source there is no archive, so the two roots are one directory.
    return { read: controller, mount: controller, client: join(packages, "client") };
  }
  const unpacked = appPath.replace(/app\.asar$/, "app.asar.unpacked");
  return {
    // Read through Node's fs, which sees into the archive: prompts/.
    read: join(appPath, "packages", "controller"),
    // Bound by bwrap and exec'd by the kernel, neither of which can see into
    // an archive: sandbox-bin/ and adapters/. §5.2, and the line packaging is
    // most likely to get wrong — in BOTH directions.
    mount: join(unpacked, "packages", "controller"),
    // Only ever read by us, so it may stay inside the archive.
    client: join(appPath, "packages", "client"),
  };
}

/**
 * The Content-Security-Policy the renderer runs under. §9.
 *
 * Set as a HEADER rather than a meta tag, because the page it protects is
 * served by our own controller and a header cannot be edited by anything the
 * agent writes into a session directory.
 *
 * `'unsafe-inline'` for style only, and for two known reasons: the theme guard
 * at the top of index.html, and the inline `style` attributes the block
 * renderer sets. Both are ours. Neither is a script.
 *
 * There is nothing on this list that is not `'self'`. §5.5 vendored the fonts
 * to make that true — a page that cannot reach a font host also cannot be told
 * apart by one, and it renders the same on a machine with no network.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The key, in development. plans/38 §7 — phase 5 owns the real answer.
 *
 * `pnpm dev` loads `.env` because the controller's dev script passes
 * `--env-file-if-exists`. `electron dist/main.cjs` passes nothing, so without
 * this the desktop build starts with no provider key and every turn 503s —
 * which reads as "the desktop app is broken" rather than "it was never told".
 *
 * FROM SOURCE ONLY. A packaged app has no repository and must not go looking
 * for one; its key comes from the environment today and from the OS keychain
 * in phase 5. Failure is silent on purpose: no `.env` is the normal case.
 */
function loadDevEnv(): void {
  if (app.isPackaged) return;
  const file = process.env.PERPETUAL_ENV_FILE
    ?? join(__dirname, "..", "..", "..", ".env");
  try { process.loadEnvFile(file); } catch { /* there usually is not one */ }
}

let running: RunningServer | null = null;
let win: BrowserWindow | null = null;

/**
 * One instance. §7 puts this in phase 4; it is here because two controllers
 * sharing one `userData/sessions` is not a rough edge, it is two writers on
 * one directory, and the sweep would eventually take a live session out from
 * under the other window.
 */
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

function createWindow(url: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 480,
    backgroundColor: "#111111",
    title: "Perpetual",
    show: false,
    webPreferences: {
      // §9, and none of these are adjustable. This renderer displays output
      // that an agent wrote. plans/16 §4 rebuilds SVG instead of stripping it
      // for exactly this reason; handing that same output a `require` would
      // throw the whole posture away in one line.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  // Nothing navigates away from the controller. A page that could would be a
  // page that can put anything at all inside our chrome.
  const ours = new URL(url).origin;
  w.webContents.on("will-navigate", (e, to) => {
    if (new URL(to).origin !== ours) e.preventDefault();
  });
  // No popups, ever. A link that wants a new window gets the system browser,
  // where it is visibly not us.
  w.webContents.setWindowOpenHandler(({ url: to }) => {
    if (/^https?:$/.test(new URL(to).protocol)) void shell.openExternal(to);
    return { action: "deny" };
  });
  // The renderer asks for nothing — no camera, no location, no notifications.
  w.webContents.session.setPermissionRequestHandler((_wc, _perm, done) => done(false));

  w.once("ready-to-show", () => w.show());
  void w.loadURL(url);
  return w;
}

app.whenReady().then(async () => {
  // Before the runtime is built, which is where the key is read.
  loadDevEnv();

  const { read, mount, client } = locate();

  // §5.1 fails SILENTLY, which is the whole reason paths.ts exists: a wrong
  // resources root does not throw, it just means the agent has no adapters and
  // no page program, and the first anyone hears of it is a turn that cannot
  // write. Two lines here turn that into a sentence on screen.
  for (const [what, where] of [
    ["the agent's programs", join(mount, "sandbox-bin", "page")],
    ["the tool adapters", join(mount, "adapters")],
    ["the agent's rules", join(read, "prompts", "rules.md")],
    ["the client", join(client, "index.html")],
  ] as const) {
    if (existsSync(where)) continue;
    dialog.showErrorBox("Perpetual is missing part of itself",
      `Could not find ${what} at ${where}. This is a packaging fault, not ` +
      "something you did — the build is incomplete.");
    app.exit(1);
    return;
  }

  setResources({ read, mount });

  session.defaultSession.webRequest.onHeadersReceived((details, done) => {
    done({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP],
      },
    });
  });

  try {
    running = await startServer({
      // 0: the kernel picks. A fixed port is a collision with the reader's own
      // `pnpm dev`, and there is no longer any reason to have one — nobody
      // types this URL.
      port: 0,
      // Never beside the binary. §5.4. `userData` itself, not a `sessions`
      // child: SessionStore appends that name, and passing it here produced
      // `…/sessions/sessions/<id>`, which works and is wrong.
      //
      // PERPETUAL_HOME still wins, because it is documented in the README and
      // honoured by every other entry point. A desktop build that quietly
      // ignored it would mean the same variable did something in one mode and
      // nothing in the other, which is worse than not supporting it.
      root: process.env.PERPETUAL_HOME ?? app.getPath("userData"),
      client,
    });
  } catch (e) {
    // The bwrap refusal lands here (§4, and server.ts `sandboxProblem`). A
    // desktop app that exits on stderr has not refused anything — it has
    // crashed — so it gets said in the one place a reader is looking.
    const message = e instanceof Error ? e.message : String(e);
    dialog.showErrorBox("Perpetual cannot start", message);
    app.exit(1);
    return;
  }

  const boot = describeBoot();
  console.log(`\n  perpetual  ${running.url}  (desktop)`);
  for (const [k, v] of Object.entries(boot)) console.log(`  ${k.padEnd(9)} ${v}`);
  console.log("");

  win = createWindow(running.url);
  win.on("closed", () => { win = null; });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && running) {
      win = createWindow(running.url);
    }
  });
});

// Quitting means the turns stop. §5.6: a turn is a model stream AND a bwrap
// process tree, and `onClientGone` only ever covered a closed socket. The
// window going away is not a closed socket.
let stopping = false;
app.on("before-quit", (e) => {
  if (stopping || !running) return;
  e.preventDefault();
  stopping = true;
  const held = running;
  running = null;
  held.close().catch(() => {}).finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());

// A crash in main must not leave a bwrap tree behind either.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => app.quit());
}

// Never load the packaged app's own files with node integration if something
// upstream flips a default. Belt to §9's braces.
app.enableSandbox();

// Everything else this file could be tempted to do — the folder dialog, the
// keychain, the window state — is phase 4 and 5, and arrives through
// preload.ts as named functions. There is no generic invoke bridge. §9.
if (!existsSync(join(__dirname, "preload.cjs"))) {
  console.error("  preload.cjs is missing — run the desktop build before electron.");
}
