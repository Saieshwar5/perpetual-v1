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

/**
 * A model that never stops asking for commands, and records what it is told.
 * The command VARIES per step, deliberately: an agent that runs the identical
 * command forever is caught by the repeat detector long before the cap, which
 * is its own test below — this stub exists to reach the backstop.
 */
function endless(results: string[], command: (n: number) => string = (n) => `echo working ${n}`) {
  return {
    modelId: "endless", providerId: "endless",
    conversation: () => ({
      user() {},
      toolResult(_id: string, _n: string, text: string) { results.push(text); },
      step: () => Object.assign((async function* () { /* no text */ })(), {
        result: async () => ({
          calls: [{ id: `c${results.length}`, name: "shell",
            args: { command: command(results.length) } }],
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
  assert.equal(end.steps, 40, "a backstop, not a policy — see plans/48");

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

test("the same command with the same result is told at 2 and stopped at 3", { skip }, async () => {
  // The failure the step cap could never see: not too much work, but the same
  // non-work over and over. Eighteen repeats used to burn eighteen steps.
  const home = await mkdtemp(join(tmpdir(), "perp-stuck-"));
  const store = new SessionStore(home);
  const s = await store.create();
  const results: string[] = [];

  let end: { stopped?: string; steps?: number } = {};
  const stream = runTurn({
    ask: "loop", runtime: endless(results, () => "echo the same thing") as never,
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false }, pastAsks: [],
  });
  for await (const ev of stream) if (ev.type === "turn_end") end = { stopped: ev.stopped, steps: ev.usage.steps };
  const summary = await stream.summary;

  assert.equal(end.stopped, "stuck");
  assert.equal(summary.stopped, "stuck");
  assert.equal(results.length, 3, "three identical runs is an answer, not a budget");
  assert.ok(results.some((r) => r.includes("run that exact command before")),
    "told before stopped, through the channel it acts on");

  await rm(home, { recursive: true, force: true });
});

test("failing differently every time is told at 3 and stopped at 6", { skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), "perp-fail-"));
  const store = new SessionStore(home);
  const s = await store.create();
  const results: string[] = [];

  let end: { stopped?: string; steps?: number } = {};
  const stream = runTurn({
    // A DIFFERENT failure each step, so the repeat detector stays quiet and
    // the failure streak is what fires.
    ask: "fail", runtime: endless(results, (n) => `ls /nowhere-${n}`) as never,
    sandbox: { root: store.siteDir(s.id), net: false, unsafe: false }, pastAsks: [],
  });
  for await (const ev of stream) if (ev.type === "turn_end") end = { stopped: ev.stopped, steps: ev.usage.steps };

  assert.equal(end.stopped, "stuck");
  assert.equal(results.length, 6, "six failures ran, and no more");
  assert.ok(results.some((r) => r.includes("failed commands in a row")),
    "the streak is named while there is still room to change course");

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
