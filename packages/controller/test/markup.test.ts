/**
 * The guard that should have existed the first time.
 *
 * Nothing used to notice a mark we do not render: it reached the page as
 * literal punctuation and only a human reading it found out. That is how four
 * stray italics shipped. The method here is to remove everything we DO honour
 * and complain about whatever still looks like markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMarkup, textFields } from "@perpetual/shared/blocks";

const ok = (t: string) => assert.equal(checkMarkup(t, true), null, `should pass: ${t}`);
const no = (t: string, re: RegExp) => {
  const m = checkMarkup(t, true);
  assert.ok(m, `should be flagged: ${t}`);
  assert.match(m!, re);
};

test("the three marks we render pass", () => {
  ok("An **internal combustion** engine burns fuel *inside* a sealed cylinder.");
  ok("The shield ablates at `3,000 °C`.");
  ok("**Intake** — the piston falls, and it *is* the only stroke that pushes.");
  ok("No marks at all.");
});

test("prose that is not markup is left alone", () => {
  // The false positives that would make the guard worse than useless.
  ok("Throughput is 3 * 4 requests per second.");
  ok("Set `max_tokens` and `some_var_name` in the config.");
  ok("A 5 * 5 grid, or 2 * 2 if you prefer.");
  ok("Costs rose 40% — see the table.");
});

test("marks we do not render are caught", () => {
  no("Use _underscores_ for emphasis.", /`_underscores_` are not rendered.*\*italic\*/s);
  no("See [the docs](https://example.com).", /markdown link.*`link` block/s);
  no("It was ~~fast~~ slow.", /strikethrough/);
  no("Press <b>enter</b> to continue.", /HTML is not rendered/);
  no("# A heading inside a paragraph", /markdown structure/);
});

test("an unclosed mark is caught, because it reaches the reader as punctuation", () => {
  no("This *never closes.", /unpaired `\*`/);
  no("An `unclosed backtick.", /unpaired backtick/);
});

test("marks in a field that does not render them are caught too", () => {
  // The second half of the failure: the one real *shed* was inside a `note`,
  // which did not run through the inline vocabulary at all.
  const m = checkMarkup("A **bold** headline", false);
  assert.match(m!, /not rendered here.*Write it plain/s);
  assert.equal(checkMarkup("A plain headline", false), null);
});

test("textFields knows where marks work and where they do not", () => {
  const honoured = (b: Parameters<typeof textFields>[0]) =>
    textFields(b).map((f) => [f.where, f.honoured]);

  assert.deepEqual(honoured({ kind: "prose", text: "x" }), [["prose", true]]);
  assert.deepEqual(honoured({ kind: "note", text: "x" }), [["note", true]]);
  assert.deepEqual(honoured({ kind: "heading", text: "x" }), [["heading", false]]);
  assert.deepEqual(honoured({ kind: "quote", text: "x" }), [["quote", false]]);
  assert.deepEqual(honoured({ kind: "list", items: ["a", "b"] }),
    [["items[0]", true], ["items[1]", true]]);
  // A split's title is a label and its body is prose — different rules.
  assert.deepEqual(honoured({ kind: "split", panels: [{ title: "t", text: "b" }, { title: "u", text: "c" }] }),
    [["panels[0].title", false], ["panels[0].text", true],
     ["panels[1].title", false], ["panels[1].text", true]]);
});
