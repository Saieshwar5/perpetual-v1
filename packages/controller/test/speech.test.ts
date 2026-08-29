/**
 * Speech: the model's stream, routed. plans/40.
 *
 * The claims worth checking are the ones that fail silently: a line split
 * across arbitrary delta boundaries must still land whole; a line that is not
 * a block must reach NOBODY (not the page, and not the reader's status line
 * as spilled JSON); an invalid line must come back as a teaching message; and
 * the section speech creates for itself must vanish if nothing ever landed
 * in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechChannel, formingText, formingKind, titleFrom, slugFrom } from "../src/speech.ts";
import { SessionStore } from "../src/sessions.ts";
import { createReplayRuntime } from "../src/replay-runtime.ts";
import { runTurn } from "../src/agent.ts";
import { readSite } from "../src/site.ts";

function channel(root: string, ask = "what is the capital of australia?") {
  const seen = { status: "", forming: [] as string[], kinds: [] as string[], flushes: 0 };
  const ch = new SpeechChannel(root, ask, {
    status: (d) => { seen.status += d; },
    forming: (_page, text, kind) => {
      if (text !== null) seen.forming.push(text);
      if (kind !== null) seen.kinds.push(kind);
    },
    flush: async () => { seen.flushes++; },
  });
  return { ch, seen };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

test("a block split across arbitrary deltas lands whole, normalized, once", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-speech-"));
  const { ch, seen } = channel(root);

  // Split mid-key, mid-escape, mid-word — the stream owes us nothing.
  for (const d of ['{"ki', 'nd":"pro', 'se","text":"Can', "berra — chosen in 19", '08."}\n']) {
    await ch.feed(d);
  }

  assert.equal(ch.spoke, 1);
  assert.ok(ch.target, "a section was created");
  const file = await readFile(join(root, "ui", "pages", ch.target!, "page.ndjson"), "utf8");
  assert.equal(file, '{"kind":"prose","text":"Canberra — chosen in 1908."}\n');
  const meta = JSON.parse(await readFile(join(root, "ui", "pages", ch.target!, "meta.json"), "utf8"));
  assert.equal(meta.ask, "what is the capital of australia?");
  assert.equal(meta.title, "What is the capital");
  // The ghost typed itself as the text grew.
  assert.ok(seen.forming.length >= 1, "forming events streamed");
  assert.ok(seen.forming.at(-1)!.startsWith("Canberra"), seen.forming.at(-1));
  // And none of the JSON leaked into the status line.
  assert.equal(seen.status.includes('"kind"'), false);
  await rm(root, { recursive: true, force: true });
});

test("a block the shell already wrote is not spoken onto the page again", async () => {
  // The real failure, from a real session: the agent shelled out the section
  // and its greeting, then streamed the same greeting — and the reader was
  // greeted twice. Speech and `cat >>` append to the same file.
  const root = await mkdtemp(join(tmpdir(), "perp-speech-"));
  const dir = join(root, "ui", "pages", "001-hello");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), '{"title":"Hello","ask":"Hii"}\n', "utf8");
  // Written as a model would type it into a heredoc: different key order and
  // spacing from what JSON.stringify produces, and the same block regardless.
  await writeFile(join(dir, "page.ndjson"),
    '{ "text": "Hi! I\'m Perpetual.", "kind": "prose" }\n', "utf8");

  const { ch } = channel(root, "Hii");
  // The watcher saw the shell open that section, so speech follows it — which
  // is what puts both routes on one file in the first place.
  ch.notice("001-hello");
  await ch.feed('{"kind":"prose","text":"Hi! I\'m Perpetual."}\n');
  await ch.feed('{"kind":"prose","text":"What are we looking at?"}\n');

  const file = await readFile(join(dir, "page.ndjson"), "utf8");
  const lines = file.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "the greeting landed once, the new line landed");
  assert.equal(lines.filter((l) => l.includes("I'm Perpetual")).length, 1);
  await rm(root, { recursive: true, force: true });
});

test("plain text stays status, exactly as it always did", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-speech-"));
  const { ch, seen } = channel(root);
  await ch.feed("Let me look at the file first.\nReading it now.");
  await ch.endStep();
  assert.equal(seen.status.includes("Let me look at the file first."), true);
  assert.equal(ch.spoke, 0);
  assert.equal(await exists(join(root, "ui", "pages")), false, "no section was created");
  await rm(root, { recursive: true, force: true });
});

test("an invalid line is not written, and the note teaches", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-speech-"));
  const { ch } = channel(root);
  await ch.feed('{"kind":"stat","label":"no value"}\n');
  assert.equal(ch.spoke, 0);
  const note = ch.drainNotes();
  assert.ok(note, "a note was queued");
  assert.match(note!, /rejected/);
  assert.match(note!, /`value`/, "the validator's own repair message rides along");
  // Eagerly created for the candidate line, then empty: finish() takes it back.
  await ch.finish();
  const dirs = await exists(join(root, "ui", "pages", "001-what-is-the-capital"));
  assert.equal(dirs, false, "the empty section was removed");
  await rm(root, { recursive: true, force: true });
});

test("workspace blocks cannot be spoken", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-speech-"));
  const { ch } = channel(root);
  await ch.feed('{"kind":"rows","id":"x","items":[{"id":"a","title":"t"}]}\n');
  assert.equal(ch.spoke, 0);
  assert.match(ch.drainNotes()!, /workspace/);
  await rm(root, { recursive: true, force: true });
});

test("a stream that ends without a newline still lands its line", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-speech-"));
  const { ch } = channel(root);
  await ch.feed('{"kind":"prose","text":"No trailing newline."}');
  assert.equal(ch.spoke, 0, "nothing lands before the line ends");
  await ch.endStep();
  assert.equal(ch.spoke, 1);
  await rm(root, { recursive: true, force: true });
});

test("speech follows the section the shell opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-speech-"));
  await mkdir(join(root, "ui", "pages", "004-built-by-shell"), { recursive: true });
  const { ch } = channel(root);
  ch.notice("004-built-by-shell");                  // what flush() does on page_open
  await ch.feed('{"kind":"prose","text":"About what I just built."}\n');
  const file = await readFile(join(root, "ui", "pages", "004-built-by-shell", "page.ndjson"), "utf8");
  assert.match(file, /About what I just built/);
  assert.equal(ch.spoke, 1);
  // No rival directory was created.
  assert.equal(await exists(join(root, "ui", "pages", "005-what-is-the-capital")), false);
  await rm(root, { recursive: true, force: true });
});

test("formingText reads the text field through escapes, and only that field", () => {
  assert.equal(formingText('{"kind":"prose","text":"Hi the'), "Hi the");
  assert.equal(formingText('{"kind":"prose","text":"a\\"b'), 'a"b');
  assert.equal(formingText('{"kind":"prose","text":"line\\none'), "line\none");
  assert.equal(formingText('{"kind":"prose","text":"x\\u00e9'), "xé");
  assert.equal(formingText('{"kind":"prose","text":"done","id":"x'), "done", "stops at the close quote");
  assert.equal(formingText('{"kind":"chart","values":[1'), null, "no text field, no ghost");
  // A dangling escape waits rather than guessing.
  assert.equal(formingText('{"kind":"prose","text":"half\\'), "half");
});

test("titles and slugs come out usable", () => {
  assert.equal(titleFrom("why is my server crashing on startup?"), "Why is my server");
  assert.equal(slugFrom("why is my server crashing on startup?"), "why-is-my-server");
  assert.equal(titleFrom("?"), "Reply");
  assert.equal(slugFrom("!!!"), "reply");
});

/* ----------------------------------------------------- the loop, end to end */

test("a spoken turn: streamed by the model, on disk at the end, zero commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "perp-speak-turn-"));
  const store = new SessionStore(home);
  const s = await store.create();

  // The replay runtime answers short "what …" asks by SPEAKING — no shell.
  const stream = runTurn({
    ask: "what is the capital of australia?",
    runtime: createReplayRuntime(),
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false },
    pastAsks: [],
  });

  const types: string[] = [];
  const kinds: string[] = [];
  for await (const ev of stream) {
    types.push(ev.type);
    if (ev.type === "page_block") kinds.push(ev.block.kind);
    if (ev.type === "error") assert.fail(ev.message);
  }
  const sum = await stream.summary;

  assert.equal(sum.stopped, "done");
  assert.deepEqual(sum.commands, [], "not one shell command ran");
  assert.ok(types.includes("page_open"), "the section opened");
  assert.ok(types.includes("forming"), "the ghost typed");
  assert.deepEqual(kinds, ["prose", "note", "chart"], "every spoken block landed, in order");

  const site = await readSite(store.siteDir(s.id));
  assert.equal(site.pages.length, 1);
  assert.equal(site.problems.length, 0, JSON.stringify(site.problems));
  assert.equal(site.pages[0]!.id, "001-what-is-the-capital");
  assert.equal(site.pages[0]!.blocks[0]!.kind, "prose", "a spoken reply needs no heading");
  await rm(home, { recursive: true, force: true });
});

test("the kind is known long before the data — that is what a skeleton needs", () => {
  // The whole opportunity in one assertion: `kind` is the first field, so it
  // is readable within a dozen bytes, while the values it describes are still
  // arriving. plans/43.
  assert.equal(formingKind('{"kind":"chart","values":[3'), "chart");
  assert.equal(formingKind('{"kind":"ch'), null, "a half-written kind is not a kind");
  assert.equal(formingKind('{"kind":"table","headers":['), "table");
  assert.equal(formingKind('{"values":[1,2]'), null);
});

test("a structured block forms with a kind and no text; prose forms with both", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-skel-"));
  const { ch, seen } = channel(root);
  await ch.feed('{"kind":"chart","values":[3,7,12],"caption":"Q');
  assert.ok(seen.kinds.includes("chart"), "the shape is announced while the data streams");
  assert.equal(seen.forming.length, 0, "a chart has no prose to type — half a chart is a lie");
  await rm(root, { recursive: true, force: true });
});
