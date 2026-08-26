/**
 * `next` — the questions a page leaves open.
 *
 * `link` points at a room that exists; `next` points at one the agent would
 * build if asked. The structural rules exist because it is the page handing
 * over, so it has to be where a page hands over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBlock } from "@perpetual/shared/blocks";
import { readSite } from "../src/site.ts";

async function fixture(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "perp-next-"));
  await mkdir(join(d, "ui", "pages"), { recursive: true });
  return d;
}
const page = async (root: string, id: string, lines: string) => {
  await mkdir(join(root, "ui", "pages", id), { recursive: true });
  await writeFile(join(root, "ui", "pages", id, "meta.json"), '{"title":"X"}');
  await writeFile(join(root, "ui", "pages", id, "page.ndjson"), lines);
};

test("a next block holds one to five questions", () => {
  const ok = (items: string[]) =>
    assert.equal(validateBlock({ kind: "next", items }).ok, true, items.join("|"));
  const no = (items: unknown[], re: RegExp) => {
    const r = validateBlock({ kind: "next", items });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, re);
  };

  ok(["Why does gasoline stop at 9:1?"]);
  ok(["a?", "b?", "c?"]);
  no([], /1 to 5 questions/);
  no(["a", "b", "c", "d", "e", "f"], /1 to 5 questions/);
  no(["ok?", ""], /items\[1\] is empty/);
  // A door is a line you click, not an essay.
  no(["x".repeat(200)], /is 200 characters.*question the reader will click/s);
});

test("it goes last, and only once", async () => {
  const d = await fixture();
  await page(d, "001-good",
    '{"kind":"heading","text":"h"}\n{"kind":"prose","text":"p"}\n{"kind":"next","items":["a?"]}\n');
  await page(d, "002-early",
    '{"kind":"heading","text":"h"}\n{"kind":"next","items":["a?"]}\n{"kind":"prose","text":"p"}\n');
  await page(d, "003-twice",
    '{"kind":"heading","text":"h"}\n{"kind":"next","items":["a?"]}\n{"kind":"next","items":["b?"]}\n');

  const site = await readSite(d);
  const forPage = (id: string) => site.problems.filter((p) => p.page === id);

  assert.deepEqual(forPage("001-good"), []);
  assert.match(forPage("002-early")[0]!.message, /not the last block.*belongs at the end/s);
  assert.match(forPage("003-twice")[0]!.message, /2 `next` blocks.*at most one/s);
  await rm(d, { recursive: true, force: true });
});

test("it is text, so it does not lift a page out of tier 1", async () => {
  const d = await fixture();
  await page(d, "001-x", '{"kind":"heading","text":"h"}\n{"kind":"next","items":["a?"]}\n');
  const site = await readSite(d);
  assert.equal(site.pages[0]!.tier, 1);
  await rm(d, { recursive: true, force: true });
});

test("marks in a question are caught — a button cannot render them", async () => {
  const d = await fixture();
  await page(d, "001-x",
    '{"kind":"heading","text":"h"}\n{"kind":"next","items":["Why does **knock** happen?"]}\n');
  const site = await readSite(d);
  assert.match(site.problems[0]!.message, /items\[0\].*not rendered here/s);
  await rm(d, { recursive: true, force: true });
});
