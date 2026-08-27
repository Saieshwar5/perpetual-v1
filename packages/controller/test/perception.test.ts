/**
 * Perception — what the agent is told about its own output.
 *
 * Two channels, and they answer different questions. A render note says what
 * the page it just wrote LOOKS like, and arrives mid-turn where it can still
 * be acted on. An engagement summary says what the reader has DONE with the
 * site, and arrives at the top of the next turn.
 *
 * The wording is the feature here, not the plumbing: a note the agent cannot
 * act on is noise in the middle of the tool output it needs to read. So these
 * tests are mostly about what is said, what is left unsaid, and how often.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteQueue } from "../src/notes.ts";
import { turnMessage } from "../src/context.ts";
import { doorKey, choiceKey } from "@perpetual/shared/site";
import type { RenderReport } from "@perpetual/shared/render";
import type { Site } from "@perpetual/shared/site";

const report = (over: Partial<RenderReport["pages"][0]> = {}): RenderReport => ({
  width: 1394, type: "normal",
  pages: [{ page: "003-margins", fit: "scroll", screens: 2.4, wide: [], ...over }],
});

/* ---------------------------------------------------------- render notes */

test("a long page is reported as a measurement, with the reader's conditions", () => {
  const q = new NoteQueue();
  q.add(report(), new Set(["003-margins"]));
  const note = q.drain()!;

  assert.match(note, /how your page actually rendered/);
  assert.match(note, /2\.4 screens/, "the number, so the agent can tell whether it fixed it");
  assert.match(note, /1394px width and normal text size/, "whose screen this was");
  assert.match(note, /write the rest as the next section/, "and what to do about it");
});

test("a page that scrolls by a hair is not worth a word", () => {
  const q = new NoteQueue();
  q.add(report({ screens: 1.1 }), new Set(["003-margins"]));
  assert.equal(q.drain(), null);
});

test("a page the turn did not write is somebody else's problem", () => {
  const q = new NoteQueue();
  q.add(report(), new Set(["001-other"]));
  assert.equal(q.drain(), null);
});

test("a page is reported once, however often the client re-measures", () => {
  const q = new NoteQueue();
  const touched = new Set(["003-margins"]);
  q.add(report(), touched);
  assert.ok(q.drain(), "first measurement is worth saying");
  q.add(report({ screens: 2.9 }), touched);
  assert.equal(q.drain(), null, "the page settling is not five separate problems");
});

test("sideways scrolling names the block, and both numbers", () => {
  const q = new NoteQueue();
  q.add(report({
    fit: "single", screens: 0.8,
    wide: [{ id: "by-quarter", kind: "table", wants: 1326, has: 800 }],
  }), new Set(["003-margins"]));
  const note = q.drain()!;

  assert.match(note, /table `by-quarter`/);
  assert.match(note, /1326px and has 800px/);
  assert.match(note, /cannot see the end of/);
});

test("a section that fits a screen is not worth a word", () => {
  const q = new NoteQueue();
  q.add(report({ fit: "single", screens: 0.9 }), new Set(["003-margins"]));
  assert.equal(q.drain(), null, "nothing to act on is nothing to say");
});

/* ------------------------------------------------------------ engagement */

const site: Site = {
  pages: [
    {
      id: "001-margins", title: "Margins", tier: 2, layout: "column",
      blocks: [
        { kind: "heading", text: "Margins held" },
        { kind: "choice", id: "which-file", prompt: "Which one?", options: [
          { id: "a", label: "one" }, { id: "b", label: "two" }] },
        { kind: "next", items: ["Why nine?", "Where does the rest go?"] },
      ] as never,
    },
    {
      id: "002-costs", title: "Costs", tier: 1, layout: "column",
      blocks: [
        { kind: "heading", text: "Costs rose" },
        { kind: "next", items: ["Why nine?"] },
      ] as never,
    },
  ],
  problems: [],
};

const base = { ask: "and what about volume?", site, pastAsks: [] };

test("the agent is told how many of its doors were worth taking", () => {
  const msg = turnMessage({
    ...base,
    answered: { [doorKey("001-margins", "Why nine?")]: "003-why-nine" },
    chosen: { [choiceKey("001-margins", "which-file")]: "a" },
  });
  assert.match(msg, /1 of 3 doors you offered has been taken/);
});

test("the same question on two pages counts as two doors, not one", () => {
  // The old record keyed on question text alone, so taking "Why nine?" on one
  // page would have counted it taken on both.
  const msg = turnMessage({
    ...base,
    answered: { [doorKey("001-margins", "Why nine?")]: "003-why-nine" },
    chosen: {},
  });
  assert.match(msg, /1 of 3 doors/, "not 2 of 3");
});

test("a choice the reader walked past is named, with what to do instead", () => {
  const msg = turnMessage({ ...base, answered: {}, chosen: {} });
  assert.match(msg, /Still unanswered: 001-margins\/which-file/);
  assert.match(msg, /decide it yourself/);
});

test("an answered choice is not raised again", () => {
  const msg = turnMessage({
    ...base, answered: {}, chosen: { [choiceKey("001-margins", "which-file")]: "b" },
  });
  assert.doesNotMatch(msg, /Still unanswered/);
});

test("a site with no controls says nothing about engagement", () => {
  const bare: Site = {
    pages: [{
      id: "001-x", title: "X", tier: 1, layout: "column",
      blocks: [{ kind: "heading", text: "X" }] as never,
    }],
    problems: [],
  };
  const msg = turnMessage({ ask: "hello", site: bare, pastAsks: [] });
  assert.doesNotMatch(msg, /What the reader has done/);
});

/* ------------------------------------------------- the loop, end to end */

/**
 * The plumbing test: a note added while the turn is running has to reach the
 * MODEL, in the tool result — not the client, and not a log. Everything above
 * checks what is said; this checks that it is said to the right party at a
 * moment when it can still be acted on.
 */
test("a report that arrives mid-turn lands in the agent's next tool result", async () => {
  const { runTurn } = await import("../src/agent.ts");
  const { mkdtemp, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "perp-perceive-"));
  await mkdir(join(root, "ui", "pages"), { recursive: true });

  const toolResults: string[] = [];
  const notes = new NoteQueue();
  let step = 0;

  // A runtime that writes one page, then stops — the smallest thing that
  // exercises the loop's tool-result path.
  const runtime = {
    modelId: "test", providerId: "test",
    conversation: () => ({
      user() {},
      toolResult(_id: string, _name: string, text: string) { toolResults.push(text); },
      step() {
        const calls = step++ === 0
          ? [{ id: "c1", name: "shell", args: { command: "echo hello" } }]
          : [];
        const result = {
          calls, usage: { input: 0, output: 0, cacheRead: 0, costUsd: 0 },
        };
        return Object.assign((async function* () {})(), { result: async () => result });
      },
    }),
  };

  const stream = runTurn({
    ask: "anything", runtime: runtime as never,
    sandbox: { root, net: false, unsafe: true },
    pastAsks: [], notes,
  });

  // The client's report, arriving while the turn is in flight.
  notes.add(
    { width: 1394, type: "normal", pages: [{ page: "001-x", fit: "scroll", screens: 3.1, wide: [] }] },
    new Set(["001-x"]),
  );

  for await (const _ of stream) { /* drain */ }
  await stream.summary;

  const withNote = toolResults.find((t) => t.includes("how your page actually rendered"));
  assert.ok(withNote, "the note must reach the model through the tool channel");
  assert.match(withNote!, /3\.1 screens/);
  assert.match(withNote!, /hello/, "and it rides WITH the command output, not instead of it");
});
