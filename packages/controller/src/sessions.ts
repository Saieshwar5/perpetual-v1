/**
 * Sessions are directories. plans/13 §3.
 *
 * One directory is four things at once, and that coincidence is the whole
 * design: the session, the agent's sandbox root, the website, and the export
 * bundle. Delete the directory and everything about the session is gone; copy
 * it and everything came along. Nothing has to be kept in sync because there
 * is only ever one copy of anything.
 *
 *   <root>/sessions/<id>/
 *     session.json      controller-owned index — outside the sandbox
 *     transcript.jsonl   controller-owned turn log — outside the sandbox
 *     log.jsonl          controller-owned diagnostics
 *     site/              THE BIND MOUNT. Everything below is the agent's.
 *       ui/pages/NNN-slug/{meta.json,page.ndjson}
 *       workspace/       scratch; the renderer never looks here
 *
 * The controller's own files sit OUTSIDE `site/` deliberately. The agent has
 * full authority over its world; it has none over the record of what happened.
 */
import { mkdir, readFile, writeFile, readdir, rename, appendFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionIndex } from "@perpetual/shared/site";

/** One entry in transcript.jsonl. This is the agent's memory across turns. */
export interface TranscriptTurn {
  at: string;
  ask: string;
  /** Set when the turn did not finish. Kept, because a failure is a record. */
  error?: string;
  /** Why the turn ended. Anything but "done" means work may be missing. */
  stopped?: string;
  /** Page ids this turn created or changed — what the agent has to show for it. */
  touched: string[];
  /** A compact record of the work, for context. Commands only, no output. */
  commands: string[];
  steps: number;
}

export class SessionStore {
  readonly root: string;

  // Written longhand: parameter properties are not valid under Node's
  // type-stripping mode, which is how this package runs.
  constructor(root: string) {
    this.root = root;
  }

  dir(id: string) { return join(this.root, "sessions", id); }
  /** The sandbox bind mount, and the website. */
  siteDir(id: string) { return join(this.dir(id), "site"); }

  private async writeAtomic(path: string, data: string) {
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);              // atomic: no half-written index on crash
  }

  async create(): Promise<SessionIndex> {
    const id = randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const index: SessionIndex = {
      id, title: "New session", createdAt: now, updatedAt: now, pageCount: 0,
      asks: [], answered: {}, chosen: {},
    };
    // The agent's world is created empty but complete, so its first command
    // never has to guess at the layout.
    await mkdir(join(this.siteDir(id), "ui", "pages"), { recursive: true });
    await mkdir(join(this.siteDir(id), "workspace"), { recursive: true });
    await this.writeAtomic(join(this.dir(id), "session.json"), JSON.stringify(index, null, 2));
    return index;
  }

  async read(id: string): Promise<SessionIndex> {
    const raw = JSON.parse(await readFile(join(this.dir(id), "session.json"), "utf8"));
    return { answered: {}, chosen: {}, ...raw } as SessionIndex;   // older sessions predate these
  }

  async write(index: SessionIndex) {
    index.updatedAt = new Date().toISOString();
    await this.writeAtomic(join(this.dir(index.id), "session.json"), JSON.stringify(index, null, 2));
  }

  async list(): Promise<SessionIndex[]> {
    try {
      const ids = await readdir(join(this.root, "sessions"));
      const all = await Promise.all(ids.map((i) => this.read(i).catch(() => null)));
      return all.filter((s): s is SessionIndex => s !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch { return []; }
  }

  async appendTurn(id: string, turn: TranscriptTurn) {
    await appendFile(join(this.dir(id), "transcript.jsonl"), JSON.stringify(turn) + "\n", "utf8");
  }

  async transcript(id: string): Promise<TranscriptTurn[]> {
    try {
      const raw = await readFile(join(this.dir(id), "transcript.jsonl"), "utf8");
      return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TranscriptTurn);
    } catch { return []; }
  }

  /**
   * Was this session ever used?
   *
   * The test is the transcript, not the page count: a turn that failed
   * produced no page but is still something that happened, and sweeping it
   * away would hide exactly the failures worth looking at. A session with no
   * transcript at all is one where the reader clicked "New" and walked away.
   */
  async unused(id: string): Promise<boolean> {
    try {
      await stat(join(this.dir(id), "transcript.jsonl"));
      return false;                                  // a turn was attempted
    } catch { /* no transcript — keep checking */ }
    try {
      const pages = await readdir(join(this.siteDir(id), "ui", "pages"));
      return pages.filter((p) => !p.startsWith(".")).length === 0;
    } catch { return true; }                          // no pages directory at all
  }

  /** Remove a session and everything in it. The directory IS the session. */
  async remove(id: string) {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  /**
   * Retire sessions nobody ever used. plans/13 §3 — a session is a directory,
   * so tidying up is deleting one.
   *
   * The age guard matters: a session is created the instant "New" is clicked
   * and stays empty until the reader types. Without it, opening the library in
   * a second tab would delete the session open in the first.
   */
  async sweep(opts: { graceMs: number; skip: ReadonlySet<string> }): Promise<string[]> {
    const removed: string[] = [];
    const cutoff = Date.now() - opts.graceMs;
    for (const s of await this.list()) {
      if (opts.skip.has(s.id)) continue;
      if (Date.parse(s.createdAt) > cutoff) continue;
      if (!(await this.unused(s.id))) continue;
      await this.remove(s.id);
      removed.push(s.id);
    }
    return removed;
  }

  async log(id: string, entry: Record<string, unknown>) {
    await appendFile(
      join(this.dir(id), "log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      "utf8",
    ).catch(() => {});
  }
}
