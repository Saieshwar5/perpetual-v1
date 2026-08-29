/**
 * Workspaces: the surface the agent works in.
 *
 * Three claims are worth a test here, and they are the three that would be
 * silent if they broke:
 *
 *   IT IS NOT THE RECORD. A workspace lives outside `ui/pages/`, so the seal
 *   does not reach it and the site does not know it exists. If either of those
 *   stopped being true, a workspace would either freeze or start turning up in
 *   the reader's permanent site.
 *
 *   A ROW'S COMMAND COMES OFF THE DISK. The click names a workspace, a block
 *   and an option; what runs is whatever the AGENT wrote beside that option.
 *   Taking it off the wire would make a click into a shell.
 *
 *   THE VIEW IS REPLACEABLE. Going back to a list is the file being rewritten,
 *   and the watcher has to report that as a view rather than as an amendment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApps, commandFor, AppWatcher } from "../src/apps.ts";
import { readSite } from "../src/site.ts";
import { validateBlock } from "@perpetual/shared/blocks";
import type { TurnEvent } from "@perpetual/shared/events";

async function fixture(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "perp-app-"));
  await mkdir(join(d, "ui", "pages"), { recursive: true });
  return d;
}

async function writeApp(root: string, id: string, blocks: unknown[], meta = {}) {
  const dir = join(root, "ui", "apps", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "Files", ...meta }));
  await writeFile(join(dir, "view.ndjson"),
    blocks.map((b) => JSON.stringify(b)).join("\n") + "\n");
}

const LIST = {
  kind: "choice", id: "matches", prompt: "Which one?",
  options: [
    { id: "q3", label: "q3-margins.csv", hint: "reports · 4.2 KB", run: "files/show q3" },
    { id: "deck", label: "board-deck.md", hint: "notes · 18 KB", run: "files/show deck" },
    { id: "explain", label: "Explain these" },
  ],
};

const types = (evs: TurnEvent[]) => evs.map((e) => e.type);

/* ------------------------------------------------------- not the record */

test("a workspace is not part of the site", async () => {
  const d = await fixture();
  await writeApp(d, "files", [LIST]);

  const site = await readSite(d);
  assert.deepEqual(site.pages, [], "the reader's site knows nothing about it");
  assert.deepEqual(site.problems, []);

  const { apps } = await readApps(d);
  assert.deepEqual(apps.map((a) => a.id), ["files"]);
  await rm(d, { recursive: true, force: true });
});

test("a view may be any blocks in any order — it is a screen, not a document", async () => {
  const d = await fixture();
  // No heading, and a choice first: both would be problems on a page.
  await writeApp(d, "files", [LIST, { kind: "prose", text: "Three matched." }]);
  const { problems } = await readApps(d);
  assert.deepEqual(problems, []);
  await rm(d, { recursive: true, force: true });
});

test("a workspace with a broken line reports it and keeps the rest", async () => {
  const d = await fixture();
  await writeApp(d, "files", [LIST]);
  await writeFile(join(d, "ui", "apps", "files", "view.ndjson"),
    `${JSON.stringify(LIST)}\n{not json}\n`);
  const { apps, problems } = await readApps(d);
  assert.equal(apps[0]!.blocks.length, 1);
  assert.match(problems[0]!.message, /not valid JSON/);
  await rm(d, { recursive: true, force: true });
});

/* --------------------------------------------------- the row's command */

test("`run` is read from the file, by name — never from what the click said", () => {
  const v = validateBlock(LIST);
  assert.equal(v.ok, true);
  const app = { id: "files", title: "Files", blocks: [v.ok ? v.value : null] } as never;
  assert.equal(commandFor(app, "matches", "q3")?.run, "files/show q3");
  assert.equal(commandFor(app, "matches", "deck")?.run, "files/show deck");

  // A row with no command is a question for the agent, and says so by being
  // nothing here rather than by being an empty string that could be run.
  assert.equal(commandFor(app, "matches", "explain"), null);
  // Nothing the client can name reaches anything the agent did not write.
  assert.equal(commandFor(app, "matches", "rm -rf /"), null);
  assert.equal(commandFor(app, "nosuch", "q3"), null);
});

test("a command longer than a command is refused", () => {
  const bad = validateBlock({
    ...LIST,
    options: [{ id: "a", label: "a", run: "x".repeat(401) }, { id: "b", label: "b" }],
  });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /under 400 characters/);
});

test("a page may carry `run` and nothing runs it — a record does not act", async () => {
  const d = await fixture();
  const dir = join(d, "ui", "pages", "001-files");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "Files", ask: "?" }));
  await writeFile(join(dir, "page.ndjson"),
    `${JSON.stringify({ kind: "heading", id: "claim", text: "Files" })}\n${
      JSON.stringify(LIST)}\n`);

  const site = await readSite(d);
  assert.deepEqual(site.problems, [], "it validates, because the field is legal");
  const { apps } = await readApps(d);
  assert.deepEqual(apps, [], "and it is not a workspace, so nothing will ever run it");
  await rm(d, { recursive: true, force: true });
});

/* ------------------------------------------------------------ watching */

test("a workspace appearing, changing and going away", async () => {
  const d = await fixture();
  const w = new AppWatcher(d);
  await w.prime();

  await writeApp(d, "files", [LIST], { view: "3 matches" });
  const opened = await w.poll();
  assert.deepEqual(types(opened), ["app_open"]);
  const first = opened[0] as Extract<TurnEvent, { type: "app_open" }>;
  assert.equal(first.app.view, "3 matches");

  // Going back to a list is the file being rewritten — a whole view, not an
  // amendment, because a workspace has no reader's place to keep.
  await writeApp(d, "files", [{ kind: "heading", text: "q3-margins.csv" }], { view: "q3" });
  const changed = await w.poll();
  assert.deepEqual(types(changed), ["app_view"]);
  assert.equal((changed[0] as Extract<TurnEvent, { type: "app_view" }>).app.view, "q3");

  assert.deepEqual(await w.poll(), [], "a view that did not change is not an event");

  await rm(join(d, "ui", "apps", "files"), { recursive: true, force: true });
  assert.deepEqual(types(await w.poll()), ["app_close"]);
  await rm(d, { recursive: true, force: true });
});

test("a workspace named something unusable is refused, not guessed at", async () => {
  const d = await fixture();
  await writeApp(d, "Files Ltd", [LIST]);
  const { apps, problems } = await readApps(d);
  assert.deepEqual(apps, []);
  assert.match(problems[0]!.message, /not a usable workspace name/);
  await rm(d, { recursive: true, force: true });
});

test("two workspaces are two workspaces", async () => {
  const d = await fixture();
  await writeApp(d, "files", [LIST]);
  await writeApp(d, "mail", [LIST], { title: "Mail" });
  const { apps } = await readApps(d);
  assert.deepEqual(apps.map((a) => a.id), ["files", "mail"]);
  assert.deepEqual(apps.map((a) => a.title), ["Files", "Mail"]);
  await rm(d, { recursive: true, force: true });
});

/* -------------------------------------------- runs that will actually run */

test("a run naming an invented verb is a problem the agent hears about NOW", async () => {
  // The real failure: rows saying `run: "show <file>"` for a helper that was
  // never put anywhere, and the reader's click was the first thing to notice.
  const d = await fixture();
  await writeApp(d, "resumes", [
    { kind: "rows", id: "list", items: [
      { id: "a", title: "resume.pdf", run: "show /tmp/resume.pdf" },
    ] },
  ]);
  const { problems } = await readApps(d);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.message, /`show` is not a command/);
  assert.match(problems[0]!.message, /files show/, "points at the two-word adapter form");
  await rm(d, { recursive: true, force: true });
});

test("a helper shipped in the workspace directory passes — executable only", async () => {
  const d = await fixture();
  await writeApp(d, "resumes", [
    { kind: "rows", id: "list", items: [
      { id: "a", title: "resume.pdf", run: "show /tmp/resume.pdf" },
    ] },
  ]);
  const helper = join(d, "ui", "apps", "resumes", "show");
  await writeFile(helper, "#!/bin/sh\necho ok\n");

  // Present but not executable: a different, actionable message.
  const notExec = await readApps(d);
  assert.equal(notExec.problems.length, 1);
  assert.match(notExec.problems[0]!.message, /chmod \+x/);

  await chmod(helper, 0o755);
  const execd = await readApps(d);
  assert.deepEqual(execd.problems, [], "an executable helper is a valid verb");
  await rm(d, { recursive: true, force: true });
});

test("installed programs, builtins and shell-shaped commands are left alone", async () => {
  const d = await fixture();
  await writeApp(d, "files", [
    { kind: "rows", id: "list", items: [
      { id: "a", title: "fine", run: "cat /tmp/x | head -3" },
      { id: "b", title: "builtin", run: "cd /tmp && ls" },
      { id: "c", title: "env prefix", run: "LC_ALL=C sort /tmp/x" },
      { id: "d", title: "a path", run: "./helper --flag" },
      { id: "e", title: "not ours to parse", run: "\"$SOME_VAR\" x" },
    ] },
  ]);
  const { problems } = await readApps(d);
  assert.deepEqual(problems, []);
  await rm(d, { recursive: true, force: true });
});
