/**
 * The validator is the forcing function now that there is no tool schema, so
 * these tests check the two things that matter: that a bad block is caught,
 * and that the message says enough to repair it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlock, textFields } from "@perpetual/shared/blocks";

const ok = (v: unknown) => {
  const r = validateBlock(v);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
};
const bad = (v: unknown, matching: RegExp) => {
  const r = validateBlock(v);
  assert.equal(r.ok, false, "expected this to be rejected");
  if (!r.ok) assert.match(r.error, matching);
};

test("accepts every documented block shape", () => {
  ok({ kind: "heading", text: "A claim" });
  ok({ kind: "prose", text: "Some **emphasis** here." });
  ok({ kind: "quote", text: "One line." });
  ok({ kind: "list", items: ["a", "b"] });
  ok({ kind: "code", text: "ls -la", lang: "bash" });
  ok({ kind: "note", text: "careful", tone: "warn" });
  ok({ kind: "link", page: "002-costs" });
  ok({ kind: "metrics", items: [{ value: "1", label: "a" }, { value: "2", label: "b" }] });
  ok({ kind: "chart", values: [1, 2, 3], labels: ["a", "b", "c"] });
  ok({ kind: "table", headers: ["a", "b"], rows: [["1", "2"]] });
  ok({ kind: "split", panels: [{ title: "a", text: "x" }, { title: "b", text: "y" }] });
  ok({ kind: "flow", steps: [{ label: "one" }, { label: "two", warn: true }] });
});

test("rejects with a message the agent can act on", () => {
  bad({ kind: "chartt", values: [1, 2, 3] }, /unknown kind "chartt".*valid:/);
  bad({ kind: "prose" }, /`text` must be a non-empty string/);
  bad({ kind: "metrics", items: [{ value: "1" }, { value: "2", label: "b" }] }, /items\[0\]\.label/);
  bad({ kind: "chart", values: ["1", "2", "3"] }, /must be finite numbers, not strings/);
  bad({ kind: "table", headers: ["a", "b"], rows: [["1"]] }, /rows\[0\] has 1 cells but there are 2/);
  bad({ kind: "table", headers: ["a", "b"], rows: [[1, 2]] }, /must hold strings — quote numbers/);
  bad({ kind: "split", panels: [{ title: "a", text: "x" }] }, /exactly 2/);
  bad({ kind: "flow", steps: [{ label: "a" }] }, /2 to 6/);
  bad({ kind: "list", items: ["only one"] }, /at least 2/);
  bad("not an object", /not a JSON object/);
});

test("tolerates extra fields rather than losing a working page", () => {
  // An agent that adds a field it invented has still produced something the
  // renderer can draw. Refusing it would trade the answer for a lecture.
  ok({ kind: "prose", text: "hello", note: "ignored" });
});

/* ======================================================= span, card, stat
 *
 * plans/39. The layout pair, and the field that makes them worth having.
 * These check the two things that would fail silently: a span outside the
 * grid (a layout that simply does not happen), and a card or stat that
 * validates but carries nothing to draw.
 */

test("span is a whole number of twelfths, and says so when it is not", () => {
  const ok = validateBlock({ kind: "prose", text: "x", span: 6 });
  assert.equal(ok.ok, true);

  for (const bad of [0, 13, 4.5, "4", -2]) {
    const r = validateBlock({ kind: "prose", text: "x", span: bad });
    assert.equal(r.ok, false, `span ${JSON.stringify(bad)} should be refused`);
    // The message has to teach the grid, not just refuse: an agent told
    // "invalid span" learns nothing it can act on.
    assert.match((r as { error: string }).error, /12 columns|1 to 12/);
  }
});

test("a block without a span is still valid — the grid is opt-in", () => {
  assert.equal(validateBlock({ kind: "prose", text: "x" }).ok, true);
});

test("span rides on every kind, not just the new ones", () => {
  for (const b of [
    { kind: "table", headers: ["A", "B"], rows: [["1", "2"]], span: 8 },
    { kind: "chart", values: [1, 2, 3], span: 6 },
    { kind: "figure", src: "a.svg", span: 4 },
  ]) {
    assert.equal(validateBlock(b).ok, true, `${b.kind} should accept a span`);
  }
});

test("a card needs something to say", () => {
  assert.equal(validateBlock({ kind: "card", text: "The piston falls." }).ok, true);
  assert.equal(
    validateBlock({ kind: "card", span: 4, title: "Intake", text: "It falls.", tone: "accent" }).ok,
    true);
  assert.equal(validateBlock({ kind: "card" }).ok, false);
  // An empty title is a gap the reader has to explain to themselves.
  assert.equal(validateBlock({ kind: "card", text: "x", title: "" }).ok, false);
  assert.equal(validateBlock({ kind: "card", text: "x", tone: "loud" }).ok, false);
});

test("a stat is a number, a label, and optionally which way it moved", () => {
  assert.equal(validateBlock({ kind: "stat", value: "9:1", label: "Compression" }).ok, true);
  assert.equal(validateBlock({
    kind: "stat", value: "34%", label: "Margin", delta: "+6 since Q2", trend: "up",
  }).ok, true);

  assert.equal(validateBlock({ kind: "stat", label: "Margin" }).ok, false);
  assert.equal(validateBlock({ kind: "stat", value: "34%" }).ok, false);
  // The colour comes from `trend` and nowhere else, so an unknown one is a
  // stat that would silently render grey.
  assert.equal(validateBlock({ kind: "stat", value: "1", label: "x", trend: "sideways" }).ok, false);
});

test("a card's body takes the inline marks; its title does not", () => {
  const fields = textFields({ kind: "card", title: "Intake", text: "The **piston** falls." } as never);
  const body = fields.find((f) => f.where === "text");
  const title = fields.find((f) => f.where === "title");
  assert.equal(body?.honoured, true, "the body renders **bold**");
  assert.equal(title?.honoured, false, "a title is a label, and already emphatic");
});
