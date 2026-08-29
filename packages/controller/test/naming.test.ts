/**
 * What a session is called. plans/46.
 *
 * These tests exist because the old rule — first page's title, taken once and
 * frozen — was measured against a real store and produced twelve sessions all
 * called "Hii" or "Hello", several of them six to nine pages of genuine work.
 * The last test replays those exact histories, because a naming rule is only
 * worth anything against the asks people actually type.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { saysNothing, nameFor, UNTITLED } from "../src/naming.ts";

test("greetings and pleasantries say nothing about a subject", () => {
  for (const a of ["Hii", "hlo", "hey", "Hello!", "how r u ?", "hey there",
                   "thanks", "ok", "yo", "good morning", "   ", "?!"]) {
    assert.equal(saysNothing(a), true, `${JSON.stringify(a)} names nothing`);
  }
});

test("one content word is enough to be about something", () => {
  for (const a of ["I want to sumerize my resume", "hi can you find my resume",
                   "explain the TCP handshake", "what did i ask u ?",
                   "clean up my Downloads"]) {
    assert.equal(saysNothing(a), false, `${JSON.stringify(a)} says something`);
  }
});

test("a session opening with a greeting stays unnamed until work arrives", () => {
  const fresh = { title: UNTITLED };
  assert.equal(nameFor(fresh, [{ title: "Hello", ask: "Hii" }]), null,
    "nothing to name it after yet");

  const now = nameFor(fresh, [
    { title: "Hello", ask: "Hii" },
    { title: "Resume versions", ask: "I want to sumerize my resume" },
  ]);
  assert.deepEqual(now, { title: "Resume versions", named: "derived" });
});

test("a derived name is never swapped for another derived name", () => {
  const named = { title: "Resume versions", named: "derived" as const };
  assert.equal(nameFor(named, [
    { title: "Resume versions", ask: "I want to sumerize my resume" },
    { title: "Downloads cleanup", ask: "clean up my Downloads" },
  ]), null, "a session that renames itself every turn cannot be found twice");
});

test("a name the agent wrote for the session beats a derived one, once", () => {
  const derived = { title: "Resume versions", named: "derived" as const };
  const better = nameFor(derived, [
    { title: "Resume versions", ask: "find my resume", session: "Sorting out the resumes" },
  ]);
  assert.deepEqual(better, { title: "Sorting out the resumes", named: "given" });

  // And then it is final: nothing automatic may move it again.
  assert.equal(nameFor({ title: "Sorting out the resumes", named: "given" }, [
    { title: "X", ask: "y", session: "Something else entirely" },
  ]), null);
});

test("a long name is cut at a word, not mid-word", () => {
  const out = nameFor({ title: UNTITLED }, [{
    title: "x", ask: "y",
    session: "Everything about the internal combustion engine and its many variants",
  }])!;
  assert.ok(out.title.length <= 53, out.title);
  assert.ok(out.title.endsWith("…"));
  assert.ok(!/\s…$/.test(out.title), "no dangling space before the ellipsis");
});

test("the real sessions that were all called Hii get real names", () => {
  // Verbatim from the store this replaced: every one of these was "Hii".
  const histories: { asks: string[]; want: string }[] = [
    {
      asks: ["Hii", "I want to sumerize my resume", "search in the Downloads"],
      want: "I want to sumerize my resume",
    },
    {
      asks: ["Hii", "can you explian about the eectric motor . how they work",
             "can you list the projects  in the my_folder in my machine"],
      want: "can you explian about the eectric motor . how they work",
    },
    {
      asks: ["Hii", "how r u ?", "what did i ask u ?", "can you find my resume in my machine"],
      want: "what did i ask u ?",
    },
  ];

  for (const h of histories) {
    // Titles here stand in for what the agent would write — the point under
    // test is WHICH page gets to name the session, not how it words it. Long
    // ones come back clipped, which is the other half of the job.
    const pages = h.asks.map((a) => ({ title: a, ask: a }));
    const out = nameFor({ title: UNTITLED }, pages)!;
    assert.ok(h.want.startsWith(out.title.replace(/…$/, "")), `${out.title} ← ${h.want}`);
    assert.notEqual(out.title, "Hii");
    assert.equal(out.named, "derived");
  }
});
