/**
 * The anchor is the point of the invoked composer: a turn now carries where it
 * was asked from, so "make that shorter" has a referent. These check that the
 * referent survives into the prompt in a form the model can act on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { turnMessage } from "../src/context.ts";
import type { Site } from "@perpetual/shared/site";

const site: Site = {
  problems: [],
  pages: [{
    id: "003-margin-analysis", title: "Margin analysis", tier: 2, layout: "column",
    ask: "how are our margins",
    blocks: [
      { kind: "heading", text: "Margins are set by mix, not by price" },
      { kind: "metrics", items: [
        { value: "$4.2M", label: "ARR" }, { value: "18%", label: "growth" }] },
      { kind: "table", headers: ["Segment", "Margin", "Share"], rows: [["SMB", "61%", "40%"]] },
    ],
  }],
};

test("without an anchor the prompt says only what exists", () => {
  const m = turnMessage({ ask: "make it shorter", site, pastAsks: [] });
  assert.match(m, /003-margin-analysis/);
  assert.doesNotMatch(m, /asking from/);
  assert.match(m, /--- The user now asks ---\n\nmake it shorter$/);
});

test("an anchored ask names the page and the block being looked at", () => {
  const m = turnMessage({
    ask: "that second number is wrong", site, pastAsks: [],
    anchor: { page: "003-margin-analysis", index: 1 },
  });
  assert.match(m, /asking from \*\*003-margin-analysis\*\* \("Margin analysis"\)/);
  assert.match(m, /a metrics block reading "\$4\.2M ARR", "18% growth"/);
  // Not a hint any more: pointing at a section is what places the answer in it.
  assert.match(m, /that is the section the answer belongs in/);
  assert.match(m, /rather than writing a new one/);
});

test("each block kind describes itself usefully", () => {
  const at = (i: number) => turnMessage({
    ask: "x", site, pastAsks: [], anchor: { page: "003-margin-analysis", index: i },
  });
  assert.match(at(0), /a heading block beginning "Margins are set by mix/);
  assert.match(at(2), /a 3-column table headed "Segment", "Margin", "Share"/);
});

test("an anchor pointing at nothing is ignored rather than fabricated", () => {
  const gone = turnMessage({ ask: "x", site, pastAsks: [], anchor: { page: "099-ghost" } });
  assert.doesNotMatch(gone, /asking from/);
  const noIndex = turnMessage({ ask: "x", site, pastAsks: [], anchor: { page: "003-margin-analysis" } });
  assert.match(noIndex, /asking from \*\*003-margin-analysis\*\*/);
  assert.doesNotMatch(noIndex, /looking at/);
});
