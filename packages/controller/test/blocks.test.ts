/**
 * The validator is the forcing function now that there is no tool schema, so
 * these tests check the two things that matter: that a bad block is caught,
 * and that the message says enough to repair it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlock } from "@perpetual/shared/blocks";

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
