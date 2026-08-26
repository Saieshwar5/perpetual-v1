/**
 * Structured input — a click that arrives as itself.
 *
 * The old return path was a string: clicking a door sent its question as if it
 * had been typed, and the server string-matched the ask against every door on
 * every page to guess that a button had been pressed. These tests pin down the
 * shape that replaces the guess, and the vocabulary rules that make an answer
 * impossible to misread.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlock } from "@perpetual/shared/blocks";
import { doorKey, choiceKey, type Selection } from "@perpetual/shared/site";
import { turnMessage } from "../src/context.ts";
import type { Site } from "@perpetual/shared/site";

const choice = (over: Record<string, unknown> = {}) => ({
  kind: "choice", id: "which-file", prompt: "Which one did you mean?",
  options: [
    { id: "a", label: "report-2025.pdf", hint: "~/Documents" },
    { id: "b", label: "report-final.pdf" },
  ],
  ...over,
});

const err = (v: unknown) => (validateBlock(v) as { error: string }).error;

/* ------------------------------------------------------------ vocabulary */

test("a choice is valid, and its options keep the ids the agent wrote", () => {
  const v = validateBlock(choice());
  assert.equal(v.ok, true);
});

test("a choice must have a name, because the answer has to say what it answers", () => {
  assert.match(err(choice({ id: undefined })), /needs an `id`/);
});

test("one option is not a choice, and nine is a search problem", () => {
  assert.match(err(choice({ options: [{ id: "a", label: "only" }] })), /2 to 8/);
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `opt ${i}` }));
  assert.match(err(choice({ options: nine })), /2 to 8/);
});

test("two options answering to the same name cannot be told apart", () => {
  assert.match(
    err(choice({ options: [{ id: "a", label: "one" }, { id: "a", label: "two" }] })),
    /used twice/,
  );
});

test("an option id is a token, not a sentence", () => {
  assert.match(
    err(choice({ options: [{ id: "The First One", label: "x" }, { id: "b", label: "y" }] })),
    /short name/,
  );
});

test("a door repeated in one block is one door the reader can click twice", () => {
  assert.match(
    err({ kind: "next", items: ["Why does it stop?", "Why does it stop?"] }),
    /repeats the question/,
  );
});

/* ------------------------------------------------------------ addressing */

test("the same question on two pages is two different doors", () => {
  const q = "How does this compare to the old method?";
  assert.notEqual(doorKey("002-costs", q), doorKey("005-margins", q));
});

test("a choice is addressed by its page and its name together", () => {
  assert.notEqual(choiceKey("002-costs", "which-file"), choiceKey("003-plans", "which-file"));
});

/* --------------------------------------------- what the agent is told */

const site: Site = {
  pages: [{
    id: "003-find-report", title: "Three files match", tier: 2, layout: "column",
    blocks: [choice() as never],
  }],
  problems: [],
};

test("a picked option reaches the agent as its own token, not as prose", () => {
  const selection: Selection = {
    page: "003-find-report", control: "choice", block: "which-file",
    option: "b", label: "report-final.pdf", prompt: "Which one did you mean?",
  };
  const msg = turnMessage({ ask: "Which one did you mean? — report-final.pdf", site, pastAsks: [], selection });

  assert.match(msg, /did not type this/);
  assert.match(msg, /`which-file`/, "says which control was answered");
  assert.match(msg, /`b`/, "says which option, by the id the agent wrote");
  assert.match(msg, /continue the work it was blocking/);
});

test("a door reaches the agent as a fork, which is the thing it must know", () => {
  const selection: Selection = {
    page: "003-find-report", control: "next",
    option: "Why does it stop at nine?", label: "Why does it stop at nine?",
  };
  const msg = turnMessage({ ask: selection.option, site, pastAsks: [], selection });

  assert.match(msg, /took a door/);
  assert.match(msg, /write one rather than amending/);
});

test("a typed question says nothing about clicks — the channel is not implicit", () => {
  const msg = turnMessage({ ask: "Why does it stop at nine?", site, pastAsks: [] });
  assert.doesNotMatch(msg, /did not type this/);
  assert.doesNotMatch(msg, /took a door/);
});
