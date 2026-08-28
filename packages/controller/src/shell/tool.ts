/**
 * The one tool.
 *
 * The schema is two fields; all the sophistication is in the machinery. That
 * ratio is the point of the design (plans/15 §2): a shell tool with ten knobs
 * is a worse shell tool, because the model already knows the shell and every
 * knob is a thing it has to learn instead.
 *
 * Three mechanisms earn their place here:
 *
 *   1. FRESH PROCESS PER COMMAND. No persistent session, so a hung REPL in
 *      command 3 cannot poison command 4, and there is no sentinel-parsing or
 *      shell-died detection to get wrong.
 *
 *   2. CWD EMULATION. The one thing people actually miss from a stateless
 *      shell is that `cd` does not stick. Printing $PWD through a marker and
 *      starting the next command there closes the gap in about ten lines.
 *      Exported variables still do not persist — and the tool description says
 *      so plainly, which models follow.
 *
 *   3. PROCESS-TREE KILL, ON EVERY PATH. spawn detached so the command owns a
 *      process group, then kill the GROUP on timeout, on abort, on disconnect.
 *      Killing only the direct child is the difference between a tool and a
 *      demo: `npm run dev &` outlives your session forever.
 */
import { spawn } from "node:child_process";
import { OutputAccumulator, formatResult, type Captured } from "./output.ts";
import { wrapCommand, mountPath, toolsDir, ulimits, type SandboxConfig } from "./sandbox.ts";
import type { Broker } from "../broker.ts";

export const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
/** Between SIGTERM and SIGKILL. Long enough to flush, short enough to feel instant. */
const GRACE_MS = 250;

/** Delimits the cwd report. U+0001 cannot appear in a path and is invisible in output. */
const MARK = "\u0001";
const MARK_RE = /\u0001([^\u0001]*)\u0001\s*$/;

export interface ShellRequest {
  command: string;
  timeoutSec?: number;
  /**
   * Extra environment for this one run. How a workspace form's values reach
   * the command it submits to — as variables, never as text inside it.
   */
  env?: Record<string, string>;
  /** Where to run, in sandbox coordinates. Defaults to the last known cwd. */
  cwd?: string;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface ShellResult {
  /** Formatted for the model, not for a human. */
  text: string;
  exitCode: number;
  killed: boolean;
  cwd: string;
  captured: Captured;
  ms: number;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wrap the user command so that: stderr interleaves with stdout in the shell's
 * own ordering (one pipe, no reordering races), the command's exit code
 * survives the trailing marker, and $PWD comes back last.
 */
export function script(
  command: string, cwd: string, fallback: string, prologue = "",
): string {
  return [
    "exec 2>&1",
    // Resource limits first, so they bind everything the command starts.
    ...(prologue ? [prologue] : []),
    `cd ${q(cwd)} 2>/dev/null || cd ${q(fallback)}`,
    "{",
    command,
    "}",
    "__perp_code=$?",
    `printf '\\001%s\\001' "$PWD"`,
    "exit $__perp_code",
  ].join("\n");
}

/**
 * @param broker answers capability calls from inside, while a command runs.
 *
 * Listening only for the life of a command is not an optimisation — it is the
 * honest lifetime. Nothing in the sandbox can call the broker when no command
 * of the sandbox's is running, so a socket that outlived one would be reach
 * granted for no reason.
 */
export function createShell(cfg: SandboxConfig, broker?: Broker) {
  const home = mountPath(cfg);
  let cwd = home;

  async function run(req: ShellRequest): Promise<ShellResult> {
    const started = Date.now();
    // Before the spawn, so `mail list` as the very first thing a command does
    // still finds someone listening.
    const stopBroker = broker ? await broker.serve(cfg.root).catch(() => null) : null;
    const timeoutSec = Math.min(Math.max(1, req.timeoutSec ?? DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC);
    const acc = new OutputAccumulator();
    const { file, args } = wrapCommand(
      script(req.command, req.cwd ?? cwd, home, ulimits(cfg)), cfg, req.env ?? {},
    );

    const child = spawn(file, args, {
      detached: true,                     // own process group — see (3) above
      stdio: ["ignore", "pipe", "pipe"],
      // Only bwrap sees this — except in unsafe mode, where there is no bwrap
      // and this IS the command's environment, so the agent's own programs
      // have to be reachable here too.
      // Unsafe mode has no bwrap, so THIS is the command's environment and the
      // per-run values have to be merged here instead.
      env: cfg.unsafe
        ? {
            PATH: [toolsDir(), ...(cfg.binPaths ?? []),
              process.env.PATH ?? "/usr/bin:/bin"].join(":"),
            HOME: cfg.root,
            PERPETUAL_SITE: cfg.root,
            ...(req.env ?? {}),
          }
        : { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });

    let killed = false;
    let pending = "";                     // holds back a possible marker prefix

    /** Feed a chunk out, but never leak the trailing marker to the UI. */
    const emit = (raw: string) => {
      pending += raw;
      const at = pending.indexOf(MARK);
      const safe = at === -1 ? pending : pending.slice(0, at);
      pending = at === -1 ? "" : pending.slice(at);
      if (safe) { acc.push(safe); req.onOutput?.(safe); }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);

    const killTree = () => {
      killed = true;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      }, GRACE_MS).unref();
    };

    const timer = setTimeout(killTree, timeoutSec * 1000);
    const onAbort = () => killTree();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("error", () => resolve(127));
      child.on("close", (code, sig) => resolve(code ?? (sig ? 137 : 1)));
    });
    clearTimeout(timer);
    stopBroker?.();
    req.signal?.removeEventListener("abort", onAbort);

    // The marker is the last thing on the pipe. If the command called `exit`
    // directly it never printed, and the previous cwd simply stands.
    const m = MARK_RE.exec(pending);
    const newCwd = m?.[1];
    const changed = Boolean(newCwd && newCwd !== cwd);
    if (newCwd) cwd = newCwd;
    const leftover = pending.replace(MARK_RE, "");
    if (leftover) { acc.push(leftover); req.onOutput?.(leftover); }

    const captured = acc.finish();
    return {
      text: formatResult({
        captured, exitCode, killed, timeoutSec,
        ...(changed ? { cwd } : {}),
      }),
      exitCode, killed, cwd, captured,
      ms: Date.now() - started,
    };
  }

  return { run, get cwd() { return cwd; }, home };
}

export type Shell = ReturnType<typeof createShell>;
