/**
 * The three budgets a turn runs against, and the one that had no gauge.
 *
 * Steps were counted, time was counted, and context was not — so a turn that
 * filled the window died holding a half-written page, and a single 429 did the
 * same because nothing ever asked the provider for a retry. These are the
 * tests for the guards, and for the cache that stops the watcher re-reading a
 * site that has not changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY_POLICY } from "../src/runtime.ts";
import { readSite, type SiteCache } from "../src/site.ts";
import { runTurn } from "../src/agent.ts";

/* ------------------------------------------------------------------ retries */

test("the turn asks the provider layer for retries — it defaults to none", () => {
  // pi-ai calls the SDK with maxRetries: 0 and its own wrapper defaults to 0,
  // so not passing this is three layers of retry switched off.
  assert.ok(RETRY_POLICY.maxRetries >= 2, "a single blip must not end a turn");
});

test("a retry cannot outlast the turn it is inside", () => {
  // MAX_TURN_MS is five minutes. A provider asking for longer than the cap
  // fails fast instead of stalling a page the reader is watching.
  assert.ok(RETRY_POLICY.maxRetryDelayMs <= 60_000);
  assert.ok(RETRY_POLICY.maxRetries * RETRY_POLICY.maxRetryDelayMs < 5 * 60_000);
});

/* ------------------------------------------------------------ context guard */

/** A model that reports whatever context size the test wants. */
function runtimeReporting(inputTokens: number, contextWindow = 100_000) {
  const toolResults: string[] = [];
  let step = 0;
  const runtime = {
    modelId: "test", providerId: "test", contextWindow,
    conversation: () => ({
      user() {},
      toolResult(_id: string, _n: string, text: string) { toolResults.push(text); },
      step() {
        const calls = step++ < 3
          ? [{ id: `c${step}`, name: "shell", args: { command: "echo hi" } }]
          : [];
        const result = {
          calls,
          usage: { input: inputTokens, output: 10, cacheRead: 0, costUsd: 0 },
        };
        return Object.assign((async function* () {})(), { result: async () => result });
      },
    }),
  };
  return { runtime, toolResults };
}

async function turnWith(inputTokens: number, window = 100_000) {
  const root = await mkdtemp(join(tmpdir(), "perp-ctx-"));
  await mkdir(join(root, "ui", "pages"), { recursive: true });
  const { runtime, toolResults } = runtimeReporting(inputTokens, window);
  const stream = runTurn({
    ask: "x", runtime: runtime as never,
    sandbox: { root, net: false, unsafe: true }, pastAsks: [],
  });
  for await (const _ of stream) { /* drain */ }
  const summary = await stream.summary;
  await rm(root, { recursive: true, force: true });
  return { toolResults, summary };
}

test("a turn well inside its context is told nothing", async () => {
  const { toolResults } = await turnWith(30_000);          // 30%
  assert.ok(!toolResults.some((t) => t.includes("of your context")),
    "a gauge that speaks when there is nothing to say is noise");
});

test("past 60% it is told the number and what to do", async () => {
  const { toolResults } = await turnWith(65_000);          // 65%
  const note = toolResults.find((t) => t.includes("of your context"));
  assert.ok(note, "the warning must reach the model, not a log");
  assert.match(note!, /65%/, "the number, so it can tell whether it helped");
  assert.match(note!, /65k of 100k tokens/);
  assert.match(note!, /Stop exploring and start writing/);
});

test("past 80% the advice becomes an instruction", async () => {
  const { toolResults } = await turnWith(85_000);
  const note = toolResults.find((t) => t.includes("of your context"))!;
  assert.match(note, /Write what you have to ui\/pages\/ NOW/);
  assert.match(note, /Do not read another file/);
});

test("past 92% the turn stops itself rather than being refused", async () => {
  const { summary } = await turnWith(95_000);
  assert.equal(summary.stopped, "context",
    "stopping while the page is coherent beats the provider ending it for us");
  assert.ok(summary.steps < 3, "and it stops at once, not after more work");
});

test("the gauge is the latest reading, not a running total", async () => {
  // Each request carries the whole conversation, so summing the steps would
  // count the same messages over and over and warn at a third of the truth.
  const { toolResults } = await turnWith(30_000);
  assert.ok(!toolResults.some((t) => t.includes("of your context")),
    "three steps at 30% is still 30%, not 90%");
});

/* -------------------------------------------------------------- site cache */

async function site() {
  const root = await mkdtemp(join(tmpdir(), "perp-cache-"));
  const dir = join(root, "ui", "pages", "001-x");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "X" }));
  await writeFile(join(dir, "page.ndjson"),
    '{"kind":"heading","text":"A claim"}\n{"kind":"prose","text":"One."}\n');
  return { root, dir };
}

test("a cached read of an unchanged site equals an uncached one", async () => {
  const { root } = await site();
  const cache: SiteCache = new Map();
  const cold = await readSite(root);
  await readSite(root, cache);
  const warm = await readSite(root, cache);
  assert.deepEqual(warm, cold, "the cache must be invisible in the result");
});

test("a new block is seen — the cache must not hide the thing it exists for", async () => {
  const { root, dir } = await site();
  const cache: SiteCache = new Map();
  await readSite(root, cache);
  await new Promise((r) => setTimeout(r, 12));            // mtime granularity
  await appendFile(join(dir, "page.ndjson"), '{"kind":"prose","text":"Two."}\n');
  assert.equal((await readSite(root, cache)).pages[0]!.blocks.length, 3);
});

test("a regenerated figure is seen, even though page.ndjson never changed", async () => {
  const { root, dir } = await site();
  await writeFile(join(dir, "page.ndjson"),
    '{"kind":"heading","text":"A claim"}\n{"kind":"figure","src":"f.svg"}\n');
  await writeFile(join(dir, "f.svg"),
    '<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>');
  const cache: SiteCache = new Map();
  const before = await readSite(root, cache);
  assert.match((before.pages[0]!.blocks[1] as { svg?: string }).svg!, /width="4"/);

  await new Promise((r) => setTimeout(r, 12));
  await writeFile(join(dir, "f.svg"),
    '<svg viewBox="0 0 10 10"><rect width="9" height="9"/></svg>');
  const after = await readSite(root, cache);
  assert.match((after.pages[0]!.blocks[1] as { svg?: string }).svg!, /width="9"/,
    "the signature is the whole directory, not just the block file");
});

test("a page that goes away stops being remembered", async () => {
  const { root, dir } = await site();
  const cache: SiteCache = new Map();
  await readSite(root, cache);
  assert.equal(cache.size, 1);
  await rm(dir, { recursive: true, force: true });
  const after = await readSite(root, cache);
  assert.equal(after.pages.length, 0);
  assert.equal(cache.size, 0, "or the cache would grow for the life of the session");
});

test("problems survive the cache — a stale page does not go quiet", async () => {
  const { root, dir } = await site();
  // Two headings — a problem that is still a problem. This used to be "no
  // heading", which plans/39 §4.1 made legal; the test is about the CACHE, so
  // it only ever needed some page the validator complains about.
  await writeFile(join(dir, "page.ndjson"),
    '{"kind":"heading","text":"one"}\n{"kind":"heading","text":"two"}\n');
  const cache: SiteCache = new Map();
  const first = await readSite(root, cache);
  const again = await readSite(root, cache);
  assert.ok(first.problems.length > 0);
  assert.deepEqual(again.problems, first.problems,
    "the agent must keep being told, not only the first time");
});
