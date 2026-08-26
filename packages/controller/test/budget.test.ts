/**
 * The turn budget.
 *
 * A rich real page — seventeen blocks, a computed figure, two self-repairs —
 * came to exactly the old 14-step cap and was cut off mid-verification, and
 * nothing anywhere said so: `error: none`, no event, no status. A truncated
 * turn was indistinguishable from a finished one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions.ts";
import { runTurn } from "../src/agent.ts";
import { bwrapAvailable } from "../src/shell/sandbox.ts";

const skip = !bwrapAvailable() ? "bubblewrap is not installed" : false;

/** A model that never stops asking for commands, and records what it is told. */
function endless(results: string[]) {
  return {
    modelId: "endless", providerId: "endless",
    conversation: () => ({
      user() {},
      toolResult(_id: string, _n: string, text: string) { results.push(text); },
      step: () => Object.assign((async function* () { /* no text */ })(), {
        result: async () => ({
          calls: [{ id: `c${results.length}`, name: "shell", args: { command: "echo working" } }],
          usage: { input: 0, output: 0, cacheRead: 0, costUsd: 0 }, stopReason: "toolUse",
        }),
      }),
    }),
  };
}

test("an agent that never stops is cut off, and the turn says so", { skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "perp-budget-"));
  const store = new SessionStore(home);
  const s = await store.create();
  const results: string[] = [];

  let end: { stopped?: string; steps?: number } = {};
  const stream = runTurn({
    ask: "go for ever", runtime: endless(results) as never,
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false }, pastAsks: [],
  });
  for await (const ev of stream) if (ev.type === "turn_end") end = { stopped: ev.stopped, steps: ev.usage.steps };
  const summary = await stream.summary;

  assert.equal(end.stopped, "steps", "the turn reports WHY it ended");
  assert.equal(summary.stopped, "steps", "and the transcript records it");
  assert.equal(end.steps, 22);

  await rm(home, { recursive: true, force: true });
});

test("the agent is warned before it runs out, through the channel it acts on", { skip }, async () => {
  // The markup guard proved this model repairs its own work when told in a
  // tool result. The budget uses the same channel for the same reason.
  const home = await mkdtemp(join(tmpdir(), "perp-warn-"));
  const store = new SessionStore(home);
  const s = await store.create();
  const results: string[] = [];

  for await (const _ of runTurn({
    ask: "go for ever", runtime: endless(results) as never,
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false }, pastAsks: [],
  })) { /* drain */ }

  const warned = results.filter((r) => r.includes("[perpetual]") && r.includes("left this turn"));
  const last = results.at(-1)!;

  assert.equal(warned.length, 3, "a three-step countdown, not a single surprise");
  assert.match(warned[0]!, /3 steps left this turn.*Finish the page/s);
  assert.match(warned[2]!, /1 step left this turn/);
  assert.match(last, /last command this turn/);

  // Early commands carry no note at all — a countdown that never stops is noise.
  assert.equal(results.slice(0, 15).some((r) => r.includes("left this turn")), false);

  await rm(home, { recursive: true, force: true });
});

test("a turn that finishes on its own says so", { skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "perp-done-"));
  const store = new SessionStore(home);
  const s = await store.create();

  const quick = {
    modelId: "quick", providerId: "quick",
    conversation: () => {
      let n = 0;
      return {
        user() {}, toolResult() {},
        step: () => Object.assign((async function* () {})(), {
          result: async () => ({
            calls: n++ === 0
              ? [{ id: "c1", name: "shell", args: { command:
                  'mkdir -p ui/pages/001-x && printf %s \'{"title":"X"}\' > ui/pages/001-x/meta.json && ' +
                  'printf %s\\\\n \'{"kind":"heading","text":"done"}\' > ui/pages/001-x/page.ndjson' } }]
              : [],
            usage: { input: 0, output: 0, cacheRead: 0, costUsd: 0 },
            stopReason: n === 1 ? "toolUse" : "stop",
          }),
        }),
      };
    },
  };

  let stopped: string | undefined;
  const stream = runTurn({
    ask: "quick one", runtime: quick as never,
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false }, pastAsks: [],
  });
  for await (const ev of stream) if (ev.type === "turn_end") stopped = ev.stopped;
  await stream.summary;

  assert.equal(stopped, "done");
  await rm(home, { recursive: true, force: true });
});
