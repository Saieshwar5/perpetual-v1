/**
 * The app quartet: rows, fields, form, confirm.
 *
 * Four shapes, because every app screen is a list of things, the detail of
 * one, a form to change it, or a confirmation before it happens. The tests
 * that matter are not the shapes though — they are the two seams:
 *
 *   A PAGE CANNOT ACT. These belong to a workspace. On a sealed section a
 *   button is either a lie or a hole in the seal.
 *
 *   A FORM'S VALUES ARE THE READER'S TEXT. A row's command is written by the
 *   agent and carries the agent's own authority, which is nothing new. A form
 *   value spliced into a shell string would make a text field into a shell —
 *   so values travel as environment, and only the ones the form declared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBlock } from "@perpetual/shared/blocks";
import { commandFor, fieldEnv } from "../src/apps.ts";
import { readSite } from "../src/site.ts";
import type { AppView } from "@perpetual/shared/site";

const ok = (v: unknown) => {
  const r = validateBlock(v);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.value : null!;
};
const err = (v: unknown) => {
  const r = validateBlock(v);
  assert.equal(r.ok, false, "should have been refused");
  return r.ok ? "" : r.error;
};

const ROWS = {
  kind: "rows", id: "inbox",
  items: [
    {
      id: "m1", title: "Invoice #4821", meta: "Acme · yesterday",
      note: "Please find attached…", state: "unread", run: "mail show 4821",
      actions: [{ id: "arch", label: "Archive", run: "mail archive 4821" }],
    },
    { id: "m2", title: "re: Thursday", meta: "Sam · 2 days ago" },
  ],
};

const FORM = {
  kind: "form", id: "reply", submit: "Send", run: "mail reply 4821",
  fields: [
    { id: "to", label: "To", type: "text", value: "billing@acme.com" },
    { id: "body", label: "Message", type: "textarea", rows: 6 },
    { id: "copy-me", label: "Copy me", type: "checkbox" },
  ],
};

/* --------------------------------------------------------------- shapes */

test("a list of rows, with a state and an action beside one", () => {
  const b = ok(ROWS);
  assert.equal(b.kind, "rows");

  assert.match(err({ ...ROWS, id: undefined }), /needs an `id`/);
  assert.match(err({ ...ROWS, items: [] }), /at least one row/);
  assert.match(
    err({ ...ROWS, items: Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, title: "x" })) }),
    /more than a list/,
  );
  assert.match(
    err({ ...ROWS, items: [{ id: "a", title: "x", state: "starred" }] }),
    /`unread`, `done`, `warn`/,
  );
  assert.match(
    err({ ...ROWS, items: [{ id: "a", title: "x", actions: [1, 2, 3, 4] }] }),
    /at most 3/,
  );
  assert.match(
    err({ ...ROWS, items: [{ id: "a", title: "x" }, { id: "a", title: "y" }] }),
    /used twice/,
  );
});

test("fields is a header, not the detail itself", () => {
  ok({ kind: "fields", items: [{ label: "From", value: "Acme" }] });
  assert.match(err({ kind: "fields", items: [] }), /1 to 12/);
  assert.match(
    err({ kind: "fields", items: Array.from({ length: 13 }, () => ({ label: "a", value: "b" })) }),
    /1 to 12/,
  );
  assert.match(err({ kind: "fields", items: [{ label: "From" }] }), /value is missing/);
});

test("a form declares its inputs, and only six types exist", () => {
  ok(FORM);
  ok({ ...FORM, fields: [{ id: "when", label: "When", type: "date" }] });
  ok({
    ...FORM,
    fields: [{
      id: "folder", label: "Folder", type: "select",
      options: [{ value: "in", label: "Inbox" }, { value: "arch", label: "Archive" }],
    }],
  });

  assert.match(err({ ...FORM, id: undefined }), /needs an `id`/);
  assert.match(err({ ...FORM, fields: [{ id: "x", label: "X", type: "richtext" }] }),
    /One of: text, textarea, select, number, checkbox, date/);
  assert.match(err({ ...FORM, fields: [{ id: "x", label: "X", type: "select" }] }),
    /2 or more `options`/);
  assert.match(
    err({ ...FORM, fields: Array.from({ length: 11 }, (_, i) => ({ id: `f${i}`, label: "x", type: "text" })) }),
    /1 to 10/,
  );
  // The command is told not to interpolate, in the message it will actually read.
  assert.match(err({ ...FORM, run: "x".repeat(401) }), /environment variables/);
});

test("a confirmation says what is about to happen", () => {
  ok({ kind: "confirm", id: "send", prompt: "Send this?", detail: "84 words", run: "mail send" });
  assert.match(err({ kind: "confirm", id: "send" }), /`prompt` must ask the question/);
  assert.match(err({ kind: "confirm", prompt: "Send?" }), /needs an `id`/);
});

/* --------------------------------------------------- a page cannot act */

test("the quartet is refused on a page, by name, with the reason", async () => {
  const d = await mkdtemp(join(tmpdir(), "perp-appblock-"));
  const dir = join(d, "ui", "pages", "001-inbox");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "Inbox", ask: "?" }));
  await writeFile(join(dir, "page.ndjson"),
    `${JSON.stringify({ kind: "heading", id: "claim", text: "Inbox" })}\n${
      JSON.stringify(ROWS)}\n`);

  const site = await readSite(d);
  assert.equal(site.problems.length, 1);
  assert.match(site.problems[0]!.message, /`rows` is a workspace block/);
  assert.match(site.problems[0]!.message, /ui\/apps\/<name>\/view\.ndjson/);
  await rm(d, { recursive: true, force: true });
});

/* ------------------------------------------------------- what runs, and */

const view = (blocks: unknown[]): AppView =>
  ({ id: "mail", title: "Mail", blocks: blocks.map((b) => ok(b)) });

test("a row runs its own command; a row's action runs the action's", () => {
  const v = view([ROWS]);
  assert.equal(commandFor(v, "inbox", "m1")?.run, "mail show 4821");
  assert.equal(commandFor(v, "inbox", "m1.arch")?.run, "mail archive 4821");

  // A row with no command is a question for the agent, and says so by being
  // nothing here rather than by being something that could run.
  assert.equal(commandFor(v, "inbox", "m2"), null);
  assert.equal(commandFor(v, "inbox", "m1.nosuch"), null);
  assert.equal(commandFor(v, "inbox", "nosuch"), null);
});

test("a confirmation runs on yes and never on no", () => {
  const v = view([{ kind: "confirm", id: "drop", prompt: "Delete?", run: "rm -f x" }]);
  assert.equal(commandFor(v, "drop", "confirm")?.run, "rm -f x");
  assert.equal(commandFor(v, "drop", "cancel"), null, "there is nothing to run for a no");
});

test("a form carries the names its values may arrive under", () => {
  const v = view([FORM]);
  const found = commandFor(v, "reply", "submit")!;
  assert.equal(found.run, "mail reply 4821");
  assert.deepEqual(found.fields, ["to", "body", "copy-me"]);
});

/* ------------------------------------- the reader's text meets a shell */

test("values travel as environment, and only the declared ones", () => {
  const env = fieldEnv(
    { to: "billing@acme.com", body: "Friday.", "copy-me": true, sneaky: "PATH" },
    ["to", "body", "copy-me"],
  );
  assert.deepEqual(env, {
    FIELD_TO: "billing@acme.com",
    FIELD_BODY: "Friday.",
    FIELD_COPY_ME: "1",
  });
  assert.equal("FIELD_SNEAKY" in env, false, "a key the form never declared is not a field");
});

test("a hostile value stays a value", () => {
  const env = fieldEnv({ name: "safe; touch PWNED && echo $(whoami)" }, ["name"]);
  // Nothing is escaped, quoted or stripped — because nothing needs to be. It
  // is not going into a command; it is going into a variable.
  assert.equal(env.FIELD_NAME, "safe; touch PWNED && echo $(whoami)");
  assert.equal(Object.keys(env).length, 1);
});

test("an unchecked box and an absent value are not the same as an empty one", () => {
  assert.deepEqual(fieldEnv({ copy: false }, ["copy"]), { FIELD_COPY: "" });
  assert.deepEqual(fieldEnv({}, ["copy"]), {});
  assert.deepEqual(fieldEnv(undefined, ["copy"]), {});
});

test("a value cannot be an essay", () => {
  const env = fieldEnv({ body: "x".repeat(20_000) }, ["body"]);
  assert.equal(env.FIELD_BODY!.length, 8000);
});
