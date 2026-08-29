/**
 * Background jobs — work that outlives its turn. plans/48.
 *
 * The turn model kills everything at the end, and rightly: the bwrap pid
 * namespace dies with its init, so nothing an agent starts can haunt the
 * machine. But that same guarantee put a ceiling on real work — a training
 * run, a long build, a dev server all need more than one five-minute turn,
 * and an agent that cannot start them simply avoids the work.
 *
 * So a command can be started AS A JOB: the same sandbox, the same wrapper,
 * but held by the controller instead of awaited by the turn. Its output goes
 * to a log file inside the session's own workspace, which is the whole
 * coordination model — the agent checks on a job the way it checks on
 * anything else here, by reading a file. No new state system; the site is
 * still the memory.
 *
 * The leash, because a process the turn does not own needs one:
 *
 *   BOUNDED IN NUMBER — a few per session, not a fleet.
 *   BOUNDED IN TIME — killed after JOB_MAX_MS however it is doing.
 *   OWNED — killed when its session is deleted, and all killed when the
 *   controller exits. Nothing survives the app.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** Enough for a build and a server side by side; not enough for a fork bomb. */
export const MAX_JOBS = 4;
export const JOB_MAX_MS = 30 * 60_000;
/** However generous the setting, a job is never immortal. */
export const JOB_CEILING_MS = 3 * 60 * 60_000;

export interface Job {
  id: string;
  command: string;
  startedAt: number;
  /** Where the output lands, relative to the session mount. */
  log: string;
  child: ChildProcess;
  stream: WriteStream;
  timer: NodeJS.Timeout | null;
  /** Watches for the agent's stop file — see startJob. */
  poll: NodeJS.Timeout;
  /** The leash's length, kept so unpinning can re-arm it. */
  maxMs: number;
  /**
   * The reader said "until I stop it": the leash is off. NEVER settable from
   * inside the sandbox — an agent that could pin its own job would outlive
   * the reader's intent, which is the self-granting rule again.
   */
  pinned: boolean;
  done: boolean;
  exitCode: number | null;
}

/** Keyed by the session's root — the same string every SandboxConfig carries. */
const jobs = new Map<string, Map<string, Job>>();

const killTree = (child: ChildProcess) => {
  try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ }
  setTimeout(() => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
  }, 300).unref();
};

export function startJob(opts: {
  root: string;
  command: string;
  file: string;
  args: string[];
  /** The leash's length, clamped to the ceiling. */
  maxMs?: number;
}): { ok: true; id: string; log: string } | { ok: false; error: string } {
  const maxMs = Math.min(JOB_CEILING_MS, Math.max(60_000, opts.maxMs ?? JOB_MAX_MS));
  const mine = jobs.get(opts.root) ?? new Map<string, Job>();
  jobs.set(opts.root, mine);
  for (const [id, j] of mine) if (j.done) mine.delete(id);
  if (mine.size >= MAX_JOBS) {
    return { ok: false, error: `${MAX_JOBS} jobs are already running in this session. ` +
      "Wait for one, or read its log and decide." };
  }

  const id = randomBytes(3).toString("hex");
  const logRel = join("workspace", ".jobs", `${id}.log`);
  const logAbs = join(opts.root, logRel);
  mkdirSync(join(opts.root, "workspace", ".jobs"), { recursive: true });
  const stream = createWriteStream(logAbs);
  stream.write(`$ ${opts.command}\n`);

  // Detached, same as a turn's command: the job owns a process group, so the
  // leash can kill everything it started. NO turn signal is attached — the
  // point is exactly that stopping the turn does not stop the job.
  const child = spawn(opts.file, opts.args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });

  const timer = setTimeout(() => {
    stream.write(`\n[job ${id}] still running after ${Math.round(maxMs / 60_000)} minutes — killed.\n`);
    killTree(child);
  }, maxMs);
  timer.unref();

  /**
   * THE AGENT'S KILL SWITCH — a file, like every other channel here.
   *
   * A later command cannot `kill` the job's pid: each command runs in its own
   * pid namespace and the job lives in another, so the isolation that makes
   * cleanup bulletproof makes cross-command kill a no-op. But both sides can
   * see the same FILES. So stopping a job is `touch workspace/.jobs/<id>.stop`
   * — the controller, which holds the real process handle outside every
   * namespace, notices within a second and kills the tree.
   */
  const stopFile = `${logAbs}`.replace(/\.log$/, ".stop");
  const poll = setInterval(() => {
    if (!existsSync(stopFile)) return;
    stream.write(`\n[job ${id}] stopped by request.\n`);
    killTree(child);
  }, 1000);
  poll.unref();

  const job: Job = {
    id, command: opts.command, startedAt: Date.now(),
    log: logRel, child, stream, timer, poll, maxMs, pinned: false,
    done: false, exitCode: null,
  };
  child.on("close", (code, sig) => {
    job.done = true;
    job.exitCode = code ?? (sig ? 137 : 1);
    if (job.timer) clearTimeout(job.timer);
    clearInterval(poll);
    stream.write(`\n[job ${id}] exited with code ${job.exitCode}.\n`);
    stream.end();
  });
  mine.set(id, job);
  return { ok: true, id, log: logRel };
}

export function listJobs(root: string): {
  id: string; command: string; log: string; startedAt: number;
  pinned: boolean; done: boolean; exitCode: number | null;
}[] {
  return [...(jobs.get(root)?.values() ?? [])].map((j) => ({
    id: j.id, command: j.command, log: j.log, startedAt: j.startedAt,
    pinned: j.pinned, done: j.done, exitCode: j.exitCode,
  }));
}

/** The reader's ✕ — same effect as the agent's stop file, no file needed. */
export function stopJob(root: string, id: string): boolean {
  const j = jobs.get(root)?.get(id);
  if (!j || j.done) return false;
  j.stream.write(`\n[job ${id}] stopped by the reader.\n`);
  killTree(j.child);
  return true;
}

/**
 * "Until I stop it" — the leash comes off, or goes back on. Reader-only:
 * this is reached through a chrome endpoint the sandbox cannot touch, so
 * long-lived-on-purpose is a grant, never an agent's choice.
 */
export function pinJob(root: string, id: string, pinned: boolean): boolean {
  const j = jobs.get(root)?.get(id);
  if (!j || j.done) return false;
  if (pinned && !j.pinned) {
    if (j.timer) clearTimeout(j.timer);
    j.timer = null;
    j.pinned = true;
    j.stream.write(`\n[job ${id}] pinned by the reader — running until stopped.\n`);
  } else if (!pinned && j.pinned) {
    // A fresh leash from now, not a resumed one: the reader is saying "back
    // to normal", and normal is the full length.
    j.timer = setTimeout(() => {
      j.stream.write(`\n[job ${id}] leash expired after unpinning — killed.\n`);
      killTree(j.child);
    }, j.maxMs);
    j.timer.unref();
    j.pinned = false;
    j.stream.write(`\n[job ${id}] unpinned — the time limit applies again.\n`);
  }
  return true;
}

/** The session is being deleted: everything it started goes with it. */
export function killJobsFor(root: string): void {
  const mine = jobs.get(root);
  if (!mine) return;
  for (const j of mine.values()) if (!j.done) killTree(j.child);
  jobs.delete(root);
}

/** The controller is exiting: nothing survives the app. */
export function killAllJobs(): void {
  for (const root of [...jobs.keys()]) killJobsFor(root);
}
