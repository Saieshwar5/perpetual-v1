/**
 * Workspaces — the surface the agent works in, as opposed to the one it writes.
 *
 * `ui/pages/` is the record: sealed at the end of the turn that wrote it, never
 * unwritten. `ui/apps/` is the opposite, on purpose. A list of files is
 * something you work IN: you click one and it opens, you go back and the list
 * returns, you narrow the search and it changes under you. None of that is
 * possible on a record, and none of it should be — so it lives in a second
 * tree, outside the seal, where rewriting the view is the normal thing to do
 * rather than a violation.
 *
 *   ui/apps/<id>/meta.json      {"title":"Files","view":"results"}
 *   ui/apps/<id>/view.ndjson    the blocks, rewritten as often as the work needs
 *
 * Nothing here is kept. When work in a workspace produces something worth
 * keeping, the agent writes THAT into a section — the workspace is where you
 * work, the site is where the result is written.
 *
 * The reading is deliberately looser than a page's. A page has structure rules
 * — one heading, first; doors last — because it is a document. A view is a
 * screen: a list, a detail, a form. It may be any blocks in any order.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateBlock, type Block } from "@perpetual/shared/blocks";
import type { AppView, Problem } from "@perpetual/shared/site";

export const APPS_REL = join("ui", "apps");

/** A workspace is named, not numbered: there is one `files`, one `mail`. */
const APP_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A view is a screen, not a document — but it is not a scroll either. */
const MAX_BLOCKS = 40;

export interface AppRead {
  app: AppView;
  problems: Problem[];
}

async function signature(dir: string): Promise<string> {
  try {
    const names = await readdir(dir);
    const stats = await Promise.all(
      names.map((n) => stat(join(dir, n)).then((s) => s.mtimeMs).catch(() => 0)),
    );
    return `${names.length}:${Math.max(0, ...stats)}`;
  } catch { return "gone"; }
}

export type AppCache = Map<string, { sig: string; read: AppRead }>;

async function readApp(appsDir: string, id: string): Promise<AppRead> {
  const problems: Problem[] = [];

  let title = id;
  let view: string | undefined;
  try {
    const meta = JSON.parse(await readFile(join(appsDir, id, "meta.json"), "utf8")) as
      { title?: unknown; view?: unknown };
    if (typeof meta.title === "string" && meta.title.trim()) title = meta.title.trim();
    if (typeof meta.view === "string" && meta.view.trim()) view = meta.view.trim();
  } catch (e) {
    const missing = e instanceof Error && e.message.includes("ENOENT");
    problems.push({
      page: id,
      message: missing
        ? `ui/apps/${id}/meta.json is missing. A workspace needs one: ` +
          '{"title":"Files","view":"results"}'
        : `ui/apps/${id}/meta.json is not valid JSON: ${
          e instanceof Error ? e.message : String(e)}`,
    });
  }

  let raw = "";
  try { raw = await readFile(join(appsDir, id, "view.ndjson"), "utf8"); }
  catch { return { app: { id, title, ...(view ? { view } : {}), blocks: [] }, problems }; }

  // Only complete lines, for the same reason a page reads that way: the file
  // is being appended to while this runs, and half a line is not a block.
  const lastNl = raw.lastIndexOf("\n");
  const complete = lastNl === -1 ? "" : raw.slice(0, lastNl);

  const blocks: Block[] = [];
  let lineNo = 0;
  for (const line of complete.split("\n")) {
    lineNo++;
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch {
      problems.push({
        page: id, line: lineNo,
        message: `ui/apps/${id}/view.ndjson: not valid JSON. One complete JSON object ` +
                 "per line.",
      });
      continue;
    }
    const v = validateBlock(parsed);
    if (!v.ok) { problems.push({ page: id, line: lineNo, message: v.error }); continue; }
    blocks.push(v.value);
  }

  if (blocks.length > MAX_BLOCKS) {
    problems.push({
      page: id,
      message: `${blocks.length} blocks in one view (max ${MAX_BLOCKS}). A view is a ` +
               "screen — a list, a detail, a form. Narrow it, or make picking one row " +
               "the way to see more.",
    });
  }

  return {
    app: { id, title, ...(view ? { view } : {}), blocks: blocks.slice(0, MAX_BLOCKS) },
    problems,
  };
}

/** Every workspace the session currently has open. */
export async function readApps(siteDir: string, cache?: AppCache): Promise<{
  apps: AppView[]; problems: Problem[];
}> {
  const appsDir = join(siteDir, APPS_REL);
  let entries: string[] = [];
  try { entries = await readdir(appsDir); } catch { return { apps: [], problems: [] }; }

  const apps: AppView[] = [];
  const problems: Problem[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    if (!APP_RE.test(name)) {
      problems.push({
        page: name,
        message: `"${name}" is not a usable workspace name. Lowercase letters, digits ` +
                 "and dashes: `files`, `mail`, `calendar`.",
      });
      continue;
    }
    if (cache) {
      const sig = await signature(join(appsDir, name));
      const hit = cache.get(name);
      if (hit && hit.sig === sig) {
        apps.push(hit.read.app);
        problems.push(...hit.read.problems);
        continue;
      }
      const read = await readApp(appsDir, name);
      cache.set(name, { sig, read });
      apps.push(read.app);
      problems.push(...read.problems);
      continue;
    }
    const read = await readApp(appsDir, name);
    apps.push(read.app);
    problems.push(...read.problems);
  }
  if (cache) for (const id of [...cache.keys()]) if (!entries.includes(id)) cache.delete(id);

  return { apps, problems };
}

/**
 * The command a row runs when it is picked — read from the FILE, never from
 * the client.
 *
 * The click arrives naming a workspace, a block and an option. What runs is
 * whatever the agent wrote beside that option on disk. The browser could
 * otherwise post a command of its own and have the controller run it in the
 * sandbox, which would turn a click into a shell.
 */
export function commandFor(app: AppView, block: string, option: string): {
  run: string; label: string; fields?: string[];
} | null {
  for (const b of app.blocks) {
    if (b.id !== block) continue;

    if (b.kind === "choice") {
      const o = b.options.find((x) => x.id === option);
      return o?.run ? { run: o.run, label: o.label } : null;
    }

    if (b.kind === "rows") {
      // A row's own command, or one of the actions beside it. `item.action` —
      // a dot, which an id may not contain, so the two can never be confused.
      const [rowId, actionId] = option.split(".");
      const row = b.items.find((x) => x.id === rowId);
      if (!row) return null;
      if (actionId == null) return row.run ? { run: row.run, label: row.title } : null;
      const a = row.actions?.find((x) => x.id === actionId);
      return a?.run ? { run: a.run, label: `${a.label} — ${row.title}` } : null;
    }

    if (b.kind === "form") {
      // The names the values are allowed to arrive under. Anything else the
      // client sends is dropped: a form defines its own fields, and a posted
      // key that is not one of them is not a field, it is an attempt.
      return b.run
        ? { run: b.run, label: b.submit ?? "Submit", fields: b.fields.map((f) => f.id) }
        : null;
    }

    if (b.kind === "confirm") {
      // Only the yes. There is nothing to run for a no — the view simply stays.
      return option === "confirm" && b.run
        ? { run: b.run, label: b.confirm ?? "Confirm" }
        : null;
    }
  }
  return null;
}

/**
 * A form's values, on their way to a command — as ENVIRONMENT, never as text.
 *
 * This is the one genuinely new risk the quartet introduces. A row's command
 * is written by the agent and carries exactly the agent's own authority, which
 * is nothing new. A form's values are written by the READER, and a value
 * spliced into a shell string would make a text field into a shell: one
 * `; rm -rf` in a subject line and the workspace is a terminal.
 *
 * So values never touch the command. They arrive as `FIELD_<ID>`, the command
 * reads them like any environment variable, and the worst a hostile value can
 * do is be a strange string inside one.
 */
export function fieldEnv(
  values: Record<string, unknown> | undefined, allowed: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!values) return env;
  for (const id of allowed) {
    const v = values[id];
    if (v == null) continue;
    env[`FIELD_${id.replace(/-/g, "_").toUpperCase()}`] =
      typeof v === "boolean" ? (v ? "1" : "") : String(v).slice(0, 8000);
  }
  return env;
}

/**
 * Watch the workspace tree the way the site is watched: diff two readings, say
 * what changed.
 *
 * Whole-view events rather than block ops. A page is reconciled block by block
 * so that amending one does not throw away the reader's scroll or the anchor
 * they are holding; a view is a screen that is MEANT to be replaced — going
 * back to the list is the file being rewritten — so the same machinery would
 * be complexity in service of nothing.
 */
export class AppWatcher {
  private siteDir: string;
  private prev = new Map<string, string>();
  private cache: AppCache = new Map();
  private seen = new Set<string>();
  private fresh: Problem[] = [];

  constructor(siteDir: string) { this.siteDir = siteDir; }

  /** Adopt what is already there without emitting. Used at turn start. */
  async prime(): Promise<AppView[]> {
    const { apps, problems } = await readApps(this.siteDir, this.cache);
    this.prev = new Map(apps.map((a) => [a.id, JSON.stringify(a)]));
    for (const p of problems) this.seen.add(`${p.page}:${p.line ?? 0}:${p.message}`);
    return apps;
  }

  async poll(): Promise<import("@perpetual/shared/events").TurnEvent[]> {
    const { apps, problems } = await readApps(this.siteDir, this.cache);
    const events: import("@perpetual/shared/events").TurnEvent[] = [];
    const next = new Map<string, string>();

    for (const app of apps) {
      const json = JSON.stringify(app);
      next.set(app.id, json);
      const before = this.prev.get(app.id);
      if (before === json) continue;
      events.push(before === undefined
        ? { type: "app_open", app }
        : { type: "app_view", app });
    }
    for (const id of this.prev.keys()) {
      if (!next.has(id)) events.push({ type: "app_close", app: id });
    }

    for (const p of problems) {
      const key = `${p.page}:${p.line ?? 0}:${p.message}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.fresh.push(p);
      events.push({ type: "problem", problem: p });
    }

    this.prev = next;
    return events;
  }

  /** Problems since the last drain, for the tool result the agent is reading. */
  drainFeedback(): string | null {
    if (!this.fresh.length) return null;
    const lines = this.fresh.map((p) => `  ${p.page}: ${p.message}`);
    this.fresh = [];
    return `[perpetual] the workspace you just wrote has problems:\n${lines.join("\n")}`;
  }
}
