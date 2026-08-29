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
 *   2. A FIXED STARTING DIRECTORY. Every command starts in the session's
 *      record; `cd` binds only the command it is in. It used to carry — $PWD
 *      came back through a marker and the next command started there — and
 *      that convenience was a record bug in disguise: the prompt promised the
 *      agent a fresh shell, so after a `cd "$PERPETUAL_WORKDIR"` its next
 *      relative `ui/pages/...` write landed in the reader's workspace,
 *      invisible to the watcher, outside the record. A command whose meaning
 *      depends on the previous command's cd is a command that cannot be read
 *      alone — say where you are working, every time.
 *
 *   3. PROCESS-TREE KILL, ON EVERY PATH. spawn detached so the command owns a
 *      process group, then kill the GROUP on timeout, on abort, on disconnect.
 *      Killing only the direct child is the difference between a tool and a
 *      demo: `npm run dev &` outlives your session forever.
 */
import { spawn } from "node:child_process";
import { OutputAccumulator, formatResult, type Captured } from "./output.ts";
import { startJob } from "./jobs.ts";
import { wrapCommand, mountPath, startDir, toolsDir, ulimits, type SandboxConfig } from "./sandbox.ts";

export const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
/** Between SIGTERM and SIGKILL. Long enough to flush, short enough to feel instant. */
const GRACE_MS = 250;

export interface ShellRequest {
  command: string;
  timeoutSec?: number;
  /** Text piped to the command's standard input, then closed. */
  stdin?: string;
  /**
   * Start the command as a JOB — held by the controller, outliving the turn,
   * output streaming to a log file in the session's workspace. See jobs.ts.
   */
  background?: boolean;
  /**
   * Extra environment for this one run. How a workspace form's values reach
   * the command it submits to — as variables, never as text inside it.
   */
  env?: Record<string, string>;
  /** Where to run, in sandbox coordinates. Defaults to the session's record. */
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
 * Wrap the user command so that stderr interleaves with stdout in the shell's
 * own ordering (one pipe, no reordering races). The script's exit status is
 * the command's own — nothing runs after it.
 */
export function script(
  command: string, cwd: string, fallback: string, prologue = "",
): string {
  return [
    "exec 2>&1",
    // Resource limits first, so they bind everything the command starts.
    ...(prologue ? [prologue] : []),
    `cd ${q(cwd)} 2>/dev/null || cd ${q(fallback)}`,
    command,
  ].join("\n");
}

export function createShell(cfg: SandboxConfig) {
  const home = startDir(cfg);

  async function run(req: ShellRequest): Promise<ShellResult> {
    const started = Date.now();
    const timeoutSec = Math.min(Math.max(1, req.timeoutSec ?? DEFAULT_TIMEOUT_SEC), MAX_TIMEOUT_SEC);
    const acc = new OutputAccumulator();
    const { file, args } = wrapCommand(
      script(req.command, req.cwd ?? home, home, ulimits(cfg)), cfg, req.env ?? {},
    );

    // A job: same wrapper, same sandbox, held by the controller instead of
    // awaited here. The turn gets its receipt and moves on; the log file is
    // the channel from then on. Deliberately deaf to the turn's signal —
    // stopping the turn must not stop the build it started.
    if (req.background) {
      const startedJob = startJob({ root: cfg.root, command: req.command, file, args,
        ...(cfg.jobMaxMs ? { maxMs: cfg.jobMaxMs } : {}) });
      const text = startedJob.ok
        ? `[background] job ${startedJob.id} started.\n` +
          `Output streams to ${startedJob.log} — read it with a later command ` +
          `(\`tail -n 40 ${startedJob.log}\`). Stop it any time with ` +
          `\`touch ${startedJob.log.replace(/\.log$/, ".stop")}\`. It runs until it ` +
          "finishes, is stopped, or its time limit passes. Do not wait for it in a " +
          "loop — finish this reply and check when there is something to check."
        : `[background] not started: ${startedJob.error}`;
      const captured = { text, truncated: false, totalLines: 1 } as ShellResult["captured"];
      return { text, exitCode: startedJob.ok ? 0 : 1, killed: false,
        cwd: home, captured, ms: Date.now() - started };
    }

    const child = spawn(file, args, {
      detached: true,                     // own process group — see (3) above
      stdio: [req.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
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

    if (req.stdin != null) {
      child.stdin?.write(req.stdin);
      child.stdin?.end();
    }

    let killed = false;

    const emit = (raw: string) => {
      if (raw) { acc.push(raw); req.onOutput?.(raw); }
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
    req.signal?.removeEventListener("abort", onAbort);

    const captured = acc.finish();
    return {
      text: formatResult({ captured, exitCode, killed, timeoutSec }),
      exitCode, killed, cwd: home, captured,
      ms: Date.now() - started,
    };
  }

  return { run, get cwd() { return home; }, home };
}

export type Shell = ReturnType<typeof createShell>;
