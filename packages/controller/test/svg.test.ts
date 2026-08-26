/**
 * The sanitiser is the only thing standing between an agent-authored file and
 * the reader's DOM, so these tests are written as attacks rather than as
 * coverage. Every refusal also has to explain itself: the message is handed
 * back to the agent, which fixes the figure and tries again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSvg, MAX_SVG_ELEMENTS } from "../src/svg.ts";

const S = (body: string, root = 'viewBox="0 0 100 100"') => `<svg ${root}>${body}</svg>`;
const ok = (input: string) => {
  const r = sanitizeSvg(input, "f1");
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.svg : "";
};
const no = (input: string, matching: RegExp) => {
  const r = sanitizeSvg(input, "f1");
  assert.equal(r.ok, false, "expected this to be refused");
  if (!r.ok) assert.match(r.error, matching);
};

test("a plain diagram survives", () => {
  const out = ok(S(
    '<rect x="10" y="10" width="80" height="40" fill="var(--surface)" stroke="var(--line)"/>' +
    '<text x="50" y="35" text-anchor="middle" fill="currentColor">Follower</text>',
  ));
  assert.match(out, /<rect x="10"/);
  assert.match(out, /Follower<\/text>/);
});

test("execution is refused, by element and by attribute", () => {
  no(S("<script>alert(1)</script>"), /<script> is not allowed.*no scripts/s);
  no(S('<rect onload="alert(1)" width="1" height="1"/>'), /event handler.*do not run code/s);
  no(S('<rect onclick="x()" width="1" height="1"/>'), /event handler/);
  no(S("<foreignObject><b>hi</b></foreignObject>"), /Use <text> and <tspan>/);
  no(S('<image href="http://evil/x.png"/>'), /cannot load external files/);
});

test("CSS is refused — it is a url\\(\\) carrier", () => {
  no(S("<style>*{}</style>"), /no scripts and no CSS/);
  no(S('<rect style="fill:red" width="1" height="1"/>'), /`style`.*not an allowed attribute/);
});

test("entity declarations are refused outright", () => {
  // The billion-laughs vector. Nothing legitimate in a figure needs it.
  no('<!DOCTYPE svg [<!ENTITY a "aaa">]><svg viewBox="0 0 1 1"/>', /DOCTYPE, CDATA or ENTITY/);
});

test("external references are refused; local ones survive", () => {
  no(S('<use href="http://evil/x#y"/>'), /points outside the figure/);
  const out = ok(S(
    '<defs><marker id="tip" viewBox="0 0 4 4"><path d="M0 0 L4 2 L0 4z" fill="var(--ink)"/></marker></defs>' +
    '<line x1="0" y1="0" x2="9" y2="9" stroke="var(--ink)" marker-end="url(#tip)"/>',
  ));
  assert.match(out, /id="f1-tip"/);
  assert.match(out, /marker-end="url\(#f1-tip\)"/);
});

test("ids are namespaced so two figures on a page cannot collide", () => {
  // Both figures are inlined into ONE document. Without this, the second
  // figure's url(#g) would silently resolve to the first figure's gradient.
  const src = S('<defs><linearGradient id="g"><stop offset="0" stop-color="var(--accent)"/>' +
    '</linearGradient></defs><rect width="9" height="9" fill="url(#g)"/>');
  const a = sanitizeSvg(src, "p7-0");
  const b = sanitizeSvg(src, "p7-1");
  assert.ok(a.ok && b.ok);
  assert.match(a.ok ? a.svg : "", /id="p7-0-g".*url\(#p7-0-g\)/s);
  assert.match(b.ok ? b.svg : "", /id="p7-1-g".*url\(#p7-1-g\)/s);
});

test("a figure may not name a colour", () => {
  // The rule that keeps every page looking like the same website, and makes
  // dark mode work without the agent thinking about it.
  no(S('<rect fill="#ff0000" width="1" height="1"/>'), /names a colour.*var\(--warn\)/s);
  no(S('<rect fill="red" width="1" height="1"/>'), /names a colour/);
  no(S('<rect stroke="rgb(1,2,3)" width="1" height="1"/>'), /names a colour/);
  no(S('<stop offset="0" stop-color="#eee"/>'), /names a colour/);
  ok(S('<rect fill="var(--accent)" stroke="currentColor" width="1" height="1"/>'));
  ok(S('<rect fill="none" width="1" height="1"/>'));
});

test("a viewBox is required and must be four numbers", () => {
  no("<svg><rect width='1' height='1'/></svg>", /needs a valid viewBox/);
  no('<svg viewBox="0 0 100"><rect width="1" height="1"/></svg>', /needs a valid viewBox/);
  ok('<svg viewBox="0,0,10,10"><rect width="1" height="1"/></svg>');
});

test("author sizing is discarded — the client owns how big a figure is", () => {
  const out = ok('<svg width="4000" height="3000" viewBox="0 0 10 10"><rect width="1" height="1"/></svg>');
  assert.doesNotMatch(out, /width="4000"/);
  assert.doesNotMatch(out, /height="3000"/);
  assert.match(out, /viewBox="0 0 10 10"/);
  // …but width on a child is geometry, not sizing, and must survive.
  assert.match(out, /<rect width="1"/);
});

test("malformed markup is refused rather than half-parsed", () => {
  // The mismatch is caught at the closing tag, which is a sharper error than
  // "never closed" — that one only fires when nothing closes it at all.
  no(S("<g><rect width='1' height='1'/>"), /<\/svg> where <\/g> was expected/);
  no("<svg viewBox='0 0 1 1'><g><rect width='1' height='1'/>", /<g> is never closed/);
  no(S("<rect width=1 height='1'/>"), /is not quoted/);
  no(S("<rect width height='1'/>"), /has no value/);
  no("<svg viewBox='0 0 1 1'><g></rect></g></svg>", /<\/rect> where <\/g> was expected/);
  no("not markup at all", /text outside the <svg> element/);
  no("<!-- only a comment -->", /no <svg> element/);
  no('<div viewBox="0 0 1 1"/>', /<div> is not allowed/);
});

test("text content is escaped, and text outside a label is dropped", () => {
  const out = ok(S('<text x="0" y="0" fill="currentColor">a &lt; b &amp; c</text>'));
  assert.match(out, /a &lt; b &amp; c/);
  assert.doesNotMatch(ok(S("<g>stray words</g>")), /stray words/);
});

test("size and element caps hold", () => {
  no(S('<rect width="1" height="1"/>'.repeat(MAX_SVG_ELEMENTS + 10)), /more than 4000 elements/);
  no(S(`<desc>${"x".repeat(300_000)}</desc>`), /exceeds the 256KB limit/);
});

test("comments and the xml declaration pass through harmlessly", () => {
  const out = ok('<?xml version="1.0"?><!-- made by gen.py --><svg viewBox="0 0 1 1">' +
    '<rect width="1" height="1"/></svg>');
  assert.doesNotMatch(out, /gen\.py/);
  assert.match(out, /^<svg/);
});
