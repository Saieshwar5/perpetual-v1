/**
 * The words the reader highlighted.
 *
 * A block is a coarse referent — "about this paragraph" is true of five
 * sentences at once — and until now that was the finest aim the product had.
 * A highlighted phrase is one the AGENT WROTE, so quoting it back is an exact
 * reference with nothing left to interpret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { turnMessage } from "../src/context.ts";
import type { Site } from "@perpetual/shared/site";

const PARA = "The key is air density. At 30,000 ft the air around the wing is roughly "
  + "30% as dense as at sea level — about two-thirds of it has been left behind.";

const site: Site = {
  pages: [{
    id: "002-cruise-altitude", title: "Cruising altitude is a fuel-economy decision",
    tier: 2, layout: "column",
    blocks: [
      { kind: "heading", id: "claim", text: "Cruising altitude is a fuel-economy decision" },
      { kind: "prose", id: "intro", text: "A 777 at cruise is not chasing adventure." },
      { kind: "prose", id: "density", text: PARA },
    ] as never,
  }],
  problems: [],
};

const base = { ask: "is this right?", site, pages: [], pastAsks: [] };

test("a highlighted phrase reaches the agent as a quote, not as the paragraph", () => {
  const msg = turnMessage({
    ...base,
    anchor: { page: "002-cruise-altitude", index: 2, id: "density",
              quote: "roughly 30% as dense as at sea level" },
  });
  assert.match(msg, /highlighted, inside it/);
  assert.match(msg, /> roughly 30% as dense as at sea level/);
  assert.match(msg, /Treat that as what "this" refers to/);
});

test("the block is still named, so a correction knows what to supersede", () => {
  const msg = turnMessage({
    ...base,
    anchor: { page: "002-cruise-altitude", index: 2, id: "density", quote: "30% as dense" },
  });
  assert.match(msg, /`density`/, "the quote narrows the aim; it does not replace the address");
  assert.match(msg, /"supersedes":"002-cruise-altitude\/density"/,
    "the exact string to write, not a description of it");
});

test("an unnamed block cannot be superseded, and the agent is told so", () => {
  const unnamed: Site = {
    pages: [{
      id: "002-cruise-altitude", title: "Cruise", tier: 1, layout: "column",
      blocks: [{ kind: "prose", text: PARA }] as never,
    }],
    problems: [],
  };
  const msg = turnMessage({ ...base, site: unnamed,
    anchor: { page: "002-cruise-altitude", index: 0 } });
  assert.doesNotMatch(msg, /"supersedes"/);
  assert.match(msg, /name the section in words/);
});

test("pointing at a block without highlighting says nothing about a quote", () => {
  const msg = turnMessage({
    ...base, anchor: { page: "002-cruise-altitude", index: 2, id: "density" },
  });
  assert.doesNotMatch(msg, /highlighted/);
  assert.match(msg, /looking at/);
});

test("a quote survives the page moving under the reader, because the id does", () => {
  // The block has been pushed down a slot since the reader started typing.
  const moved: Site = {
    ...site,
    pages: [{ ...site.pages[0]!, blocks: [
      site.pages[0]!.blocks[0]!,
      { kind: "note", id: "caveat", text: "Provisional." } as never,
      site.pages[0]!.blocks[1]!,
      site.pages[0]!.blocks[2]!,
    ] }],
  };
  const msg = turnMessage({
    ...base, site: moved,
    anchor: { page: "002-cruise-altitude", index: 2, id: "density", quote: "30% as dense" },
  });
  assert.match(msg, /`density`/, "resolved by name, not by the stale index 2");
  assert.match(msg, /air around the wing/, "and it describes the right block");
  assert.match(msg, /> 30% as dense/);
});
