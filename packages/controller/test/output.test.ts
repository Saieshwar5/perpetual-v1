import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputAccumulator, formatResult, MAX_LINES } from "../src/shell/output.ts";
import { readFileSync } from "node:fs";

test("passes short output through untouched", () => {
  const a = new OutputAccumulator();
  a.push("one\ntwo\nthree");
  const c = a.finish();
  assert.equal(c.text, "one\ntwo\nthree");
  assert.equal(c.truncated, false);
  assert.equal(c.totalLines, 3);
});

test("keeps the head AND the tail, not a prefix", () => {
  // The point of the design: context is at the top, the error is at the
  // bottom, and a head-only clip would throw away the answer.
  const a = new OutputAccumulator();
  for (let i = 0; i < 5000; i++) a.push(`line ${i}\n`);
  const c = a.finish();
  assert.equal(c.truncated, true);
  assert.match(c.text, /^line 0\n/, "first line survived");
  assert.match(c.text, /line 4999$/, "last line survived");
  assert.match(c.text, /\[\.\.\. \d+ lines elided \.\.\.\]/);
  assert.ok(c.text.split("\n").length <= MAX_LINES + 2);
});

test("spills the full output and names the file", () => {
  const a = new OutputAccumulator();
  for (let i = 0; i < 5000; i++) a.push(`line ${i}\n`);
  const c = a.finish();
  assert.ok(c.spillPath, "a spill path is reported");
  const full = readFileSync(c.spillPath!, "utf8");
  assert.ok(full.includes("line 2500"), "the elided middle is on disk");

  const text = formatResult({ captured: c, exitCode: 0, killed: false, timeoutSec: 120 });
  assert.ok(text.includes(c.spillPath!), "the model is told where the rest is");
});

test("chunk boundaries do not split lines", () => {
  const a = new OutputAccumulator();
  a.push("hel"); a.push("lo\nwor"); a.push("ld\n");
  assert.equal(a.finish().text, "hello\nworld");
});

test("a nonzero exit is reported as a result, not an error", () => {
  const a = new OutputAccumulator();
  a.push("");
  const text = formatResult({ captured: a.finish(), exitCode: 1, killed: false, timeoutSec: 120 });
  assert.match(text, /exit code: 1/);
  assert.doesNotMatch(text, /error/i);
});

test("a timeout is reported as a result too", () => {
  const a = new OutputAccumulator();
  a.push("partial work\n");
  const text = formatResult({ captured: a.finish(), exitCode: 137, killed: true, timeoutSec: 5 });
  assert.match(text, /killed after 5s \(timeout\)/);
  assert.match(text, /partial work/, "partial output survives the kill");
});
