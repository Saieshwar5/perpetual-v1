/**
 * Context assembly — filesystem only. plans/13 §8.
 *
 * No vector store, no embeddings, no summarisation. The insight that makes
 * that sufficient here: THE SITE IS THE MEMORY. Every turn's work ends as
 * files in the session directory, so "what happened before" is not a
 * transcript to compress — it is a directory the agent can `cat`. What it gets
 * up front is an inventory and the list of past asks; anything more, it reads.
 *
 * The system/user split is load-bearing. Everything stable lives in `system`,
 * because that is where pi-ai places the Anthropic cache breakpoint, and
 * everything per-turn lives after it. Backwards, and `cacheRead` sits at zero
 * and every turn pays full price.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promptsDir } from "./paths.ts";
import type { Block } from "@perpetual/shared/blocks";
import { choiceKey, doorKey } from "@perpetual/shared/site";
import { describeAdapters, type Adapter } from "./adapters.ts";
import type { Anchor, AppView, Selection, Site } from "@perpetual/shared/site";

let cached: string | undefined;

/** The cache-stable prefix: identity + the rules. Read once per process. */
export async function systemPrompt(): Promise<string> {
  if (cached) return cached;
  const [agent, rules] = await Promise.all([
    readFile(join(promptsDir(), "agent.md"), "utf8"),
    readFile(join(promptsDir(), "rules.md"), "utf8"),
  ]);
  cached = `${agent.trim()}\n\n---\n\n${rules.trim()}`;
  return cached;
}

/**
 * The volatile half. Two things the agent cannot infer from the filesystem
 * without spending commands on it: what the site already contains, and what
 * the user asked before. Everything else it can go and read.
 */
/**
 * A block, in a phrase — enough for the agent to know which one is meant.
 *
 * A named block leads with its name, because the name is ACTIONABLE: the agent
 * can rewrite the line carrying that id and the reader's page updates in place
 * around it. A description is only recognisable; a name is addressable.
 */
function describeBlock(b: Block): string {
  const what = describeBlockShape(b);
  return b.id ? `\`${b.id}\` — ${what}` : what;
}

function describeBlockShape(b: Block): string {
  switch (b.kind) {
    case "heading": case "section": case "prose": case "quote": case "note":
      return `a ${b.kind} block beginning "${b.text.slice(0, 60)}…"`;
    case "code":
      return `a code block beginning "${b.text.split("\n")[0]?.slice(0, 50)}…"`;
    case "list":
      return `a list beginning "${b.items[0]?.slice(0, 40)}…"`;
    case "metrics":
      return `a metrics block reading ${b.items.map((m) => `"${m.value} ${m.label}"`).join(", ")}`;
    case "chart":
      return `a chart of ${b.values.length} values${b.caption ? ` captioned "${b.caption}"` : ""}`;
    case "table":
      return `a ${b.headers.length}-column table headed ${b.headers.map((h) => `"${h}"`).join(", ")}`;
    case "split":
      return `a split comparing "${b.panels[0]?.title}" and "${b.panels[1]?.title}"`;
    case "flow":
      return `a flow: ${b.steps.map((s) => s.label).join(" → ")}`;
    case "figure":
      return `the figure ${b.src}${b.caption ? ` ("${b.caption}")` : ""}`;
    case "image":
      return `the image ${b.src}${b.caption ? ` ("${b.caption}")` : ""}`;
    case "grant":
      return `a request for write access to ${b.path}`;
    case "card":
      return `a card${b.title ? ` titled "${b.title}"` : ""} beginning "${
        b.text.slice(0, 40)}…"`;
    case "stat":
      return `the stat "${b.value} ${b.label}"`;
    case "link":
      return `a link to ${b.page}`;
    case "next":
      return `the questions this page leaves open`;
    case "choice":
      return `the choice "${b.prompt}"`;
    case "rows":
      return `a list of ${b.items.length}: ${b.items.slice(0, 3)
        .map((i) => `"${i.title}"`).join(", ")}${b.items.length > 3 ? ", …" : ""}`;
    case "fields":
      return `the details ${b.items.slice(0, 3).map((f) => f.label).join(", ")}`;
    case "form":
      return `the form \`${b.id}\` (${b.fields.map((f) => f.id).join(", ")})`;
    case "confirm":
      return `the confirmation "${b.prompt}"`;
  }
}

/**
 * A click, in the words the agent needs.
 *
 * Two controls, two different things to say — and the difference is the whole
 * reason the channel exists. A door is a FORK: the reader has asked for a room
 * that does not exist yet, so the answer is a new page. A choice is an ANSWER:
 * the agent asked something it could not proceed without, and now it can, so
 * the work continues where it was.
 *
 * The option comes back as the token the agent wrote itself. There is nothing
 * here to parse, which is the point — a sentence saying "the second one" is
 * the failure mode this replaces.
 */
function describeSelection(sel: Selection): string {
  // A pick in a WORKSPACE is a different thing from a pick on a page. A page
  // is a record and the answer to a choice on it is the next section; a
  // workspace is a surface being worked in, and the answer is usually a new
  // view. Saying which is what stops the agent writing a section every time
  // somebody clicks a row in a list.
  if (sel.app && sel.control === "typed") {
    return `\nThey typed that in the **${sel.app}** workspace, not on the site. It is ` +
      "about the work in front of them: do it, and rewrite " +
      `\`ui/apps/${sel.app}/view.ndjson\` to show where it got them. A section is for ` +
      "something worth keeping after the workspace closes.";
  }
  if (sel.app) {
    return `\nThe user did not type this — they picked \`${sel.option}\` (${sel.label}) ` +
      `in the **${sel.app}** workspace` +
      (sel.prompt ? `, which asked "${sel.prompt}"` : "") +
      ". They are working, not reading: do the thing they picked and rewrite " +
      `\`ui/apps/${sel.app}/view.ndjson\` to show where that got them. Only write a ` +
      "section if the work produced something worth keeping after the workspace " +
      "closes.";
  }
  if (sel.control === "next") {
    return `\nThe user did not type this — they took a door on **${sel.page}**: ` +
      `"${sel.option}". That is a fork: they are asking for a page that does not ` +
      "exist yet, so write one rather than amending the page they came from.";
  }
  // A multi choice answers with several ids in one string. Spelling them out
  // as a list is the difference between an answer the model reads and a token
  // it has to notice the commas in.
  const picked = sel.option.includes(",")
    ? `by picking ${sel.option.split(",").map((x) => `\`${x}\``).join(", ")} — ${sel.label}`
    : `by picking \`${sel.option}\` — ${sel.label}`;
  return `\nThe user did not type this — they answered your choice ` +
    `\`${sel.block}\` on **${sel.page}**` +
    (sel.prompt ? ` ("${sel.prompt}")` : "") +
    ` ${picked}. That is the answer you were ` +
    "waiting for: continue the work it was blocking. Do not ask again, and do not " +
    "rewrite the choice — the reader's answer stays on the page as the record of it.";
}

/**
 * What the reader DID with what was written — the other half of perception.
 *
 * The agent has always been told what was asked and never what happened next.
 * So it could not learn the things that only show up over a session: that its
 * doors are being ignored, which usually means they are too vague to be worth
 * clicking; that a choice it asked went unanswered, which usually means the
 * reader did not care and it should have picked one and said so.
 *
 * All of it is already on disk — the session records every door taken and
 * every choice answered. It has simply never been read back out.
 *
 * Counts and names only. A conclusion here ("your doors are bad") would be the
 * harness doing the agent's thinking for it, and it would be wrong as often as
 * not: two doors out of six is a bad hit rate on a reference page and a fine
 * one on a page the reader was only passing through.
 */
function describeEngagement(
  site: Site, answered: Record<string, string>, chosen: Record<string, string>,
): string | null {
  let doors = 0, taken = 0;
  const unanswered: string[] = [];

  for (const page of site.pages) {
    for (const b of page.blocks) {
      if (b.kind === "next") {
        doors += b.items.length;
        for (const q of b.items) {
          if (answered[doorKey(page.id, q)] ?? answered[q]) taken++;
        }
      } else if (b.kind === "choice" && b.id) {
        if (!chosen[choiceKey(page.id, b.id)]) unanswered.push(`${page.id}/${b.id}`);
      }
    }
  }

  const lines: string[] = [];
  if (doors) {
    lines.push(`  ${taken} of ${doors} door${doors === 1 ? "" : "s"} you offered ` +
      `${taken === 1 ? "has" : "have"} been taken.`);
  }
  if (unanswered.length) {
    lines.push(`  Still unanswered: ${unanswered.join(", ")}. A choice the reader ` +
      "walks past is one they did not need — decide it yourself and say which way " +
      "you went.");
  }
  return lines.length ? `\nWhat the reader has done here:\n${lines.join("\n")}` : null;
}

export function turnMessage(
  opts: {
    ask: string; site: Site; pastAsks: string[];
    apps?: AppView[];
    adapters?: Adapter[];
    anchor?: Anchor; selection?: Selection;
    answered?: Record<string, string>; chosen?: Record<string, string>;
  },
): string {
  const parts: string[] = [];

  if (opts.site.pages.length === 0) {
    parts.push("This session's site is empty. The page you write will be `001-<slug>`.");
  } else {
    const inventory = opts.site.pages
      .map((p, i) => `  ${i + 1}. ${p.id}  "${p.title}"  (${p.blocks.length} blocks)`)
      .join("\n");
    const n = String(opts.site.pages.length + 1).padStart(3, "0");
    parts.push(`This session's site has ${opts.site.pages.length} page(s):\n${inventory}\n`);
    parts.push(`A new page would be \`${n}-<slug>\`.`);
  }

  // Names and shapes only. The recipes stay on disk: that is the whole point
  // of a recipe on disk — twenty tools cost the same as none until one is used.
  const tools = describeAdapters(opts.adapters ?? []);
  if (tools) parts.push(tools);

  if (opts.apps?.length) {
    const list = opts.apps.map((a) => {
      const rows = a.blocks.filter((b) => b.kind === "choice").length;
      return `  ${a.id}  "${a.title}"${a.view ? ` · ${a.view}` : ""}  (${
        a.blocks.length} block(s)${rows ? `, ${rows} pickable` : ""})`;
    }).join("\n");
    parts.push(
      `\nWorkspaces open in this session, drawn live in the reader's scroll:\n${list}\n` +
      "A workspace is a surface to work IN, not a record: rewrite " +
      "`ui/apps/<id>/view.ndjson` whenever the work moves on, and remove the " +
      "directory when it is finished with.",
    );
  }

  if (opts.pastAsks.length) {
    parts.push(`\nEarlier in this session the user asked:\n${
      opts.pastAsks.slice(-8).map((a) => `  - ${a}`).join("\n")}`);
  }

  // The anchor says what "this" MEANS. It no longer says where the answer
  // goes, because nothing does: published sections are read-only and every
  // answer is written at the end. What the anchor still does — and the only
  // thing it was ever good at — is resolve the referent, so "is that right?"
  // is a question about one paragraph rather than about the site.
  if (opts.anchor) {
    const page = opts.site.pages.find((p) => p.id === opts.anchor!.page);
    if (page) {
      // Resolve by NAME first: the page may have moved under the reader while
      // they were typing, in which case the index is stale and the id is not.
      const byId = opts.anchor.id
        ? page.blocks.find((b) => b.id === opts.anchor!.id)
        : undefined;
      const at = byId ?? (opts.anchor.index != null ? page.blocks[opts.anchor.index] : undefined);
      parts.push(
        `\nThe user is asking from **${page.id}** ("${page.title}")` +
        (at ? `, looking at ${describeBlock(at)}` : "") +
        // The words beat the block. A paragraph is five sentences; a highlight
        // is one phrase, and it is a phrase THIS AGENT WROTE — so quoting it
        // back is an exact referent with nothing left to interpret. Without
        // it, "is this right?" about a highlighted number arrives as a
        // question about the whole paragraph.
        (opts.anchor.quote
          ? `.\nThey have highlighted, inside it:\n\n> ${opts.anchor.quote}\n\nTreat that as what "this" refers to`
          : "") +
        ". That section is published and cannot be changed — treat this as the " +
        "SUBJECT of the question and answer in a new section at the end." +
        (at?.id
          ? ` That block is named \`${at.id}\`, so if your answer replaces what it says, ` +
            `put \`"supersedes":"${page.id}/${at.id}"\` on the block that replaces it: ` +
            "the reader then sees the old one marked as revised, with a link to yours."
          : " Nothing there is named, so you cannot point a `supersedes` at it — " +
            "say what is true and name the section in words."),
      );
    }
  }

  const engagement = describeEngagement(
    opts.site, opts.answered ?? {}, opts.chosen ?? {},
  );
  if (engagement) parts.push(engagement);

  const typed = typedPick(opts.site, opts.ask, Boolean(opts.selection));
  if (typed) parts.push(typed);

  if (opts.selection) parts.push(describeSelection(opts.selection));

  // The decision that comes before the words, re-armed every turn because
  // rules read once fade and the drift toward prose is constant. One sentence,
  // ABOVE the ask: the ask stays the last thing in the message, always.
  parts.push(
    "\nDecide first: will the reader READ this reply, PICK from it, WORK in it, " +
    "or APPROVE something? Build that — a page to read, a `choice` to tap, a " +
    "workspace to work in, a `confirm` before anything irreversible. If your reply " +
    "would end by asking them to type something you could have listed, you chose wrong.",
  );

  parts.push(`\n--- The user now asks ---\n\n${opts.ask}`);
  return parts.join("\n");
}

/**
 * FUNCTION, not only form — the one drift the validator cannot see.
 *
 * Every block can be perfectly shaped and the reply still the wrong KIND: a
 * closing paragraph that asks the reader a question makes them TYPE what one
 * tap could have answered. The validator enforces "is this block well-formed";
 * nothing ever pushed back on "was this the right reply" — so the agent
 * drifted to prose, the cheapest valid output, and the reader paid for it.
 *
 * Deliberately narrow, because a nudge that fires on rhetorical questions
 * teaches the agent to ignore the channel: only the pages THIS turn wrote,
 * only when the very last block is prose ending in a question mark, and only
 * when the turn offered nothing tappable anywhere — no choice on its pages,
 * and no workspace open beside them.
 */
export function endsAskingToType(site: Site, touched: ReadonlySet<string>): string | null {
  const mine = site.pages.filter((p) => touched.has(p.id));
  const page = mine.at(-1);
  if (!page) return null;
  if (mine.some((p) => p.blocks.some((b) => b.kind === "choice"))) return null;
  const last = page.blocks.at(-1);
  if (!last || (last.kind !== "prose" && last.kind !== "note")) return null;
  if (!last.text.trim().endsWith("?")) return null;
  return "[perpetual] Your reply ends by asking the reader a question in prose — " +
    "they would have to TYPE the answer. If the answers are things you can list " +
    "(which file, which way, what scope), replace that closing paragraph with a " +
    "`choice` so one tap answers it: `page rm` the paragraph, append the choice. " +
    "If the question genuinely needs a typed sentence, leave it as it is and stop.";
}

/**
 * LAYER 3 of the same lesson, across turns: the reader typed their pick.
 *
 * When the ask is a short phrase that repeats an item the LAST page merely
 * listed, the reader did by hand what a `choice` would have done in one tap —
 * and this is the moment the cost is visible, so it is the moment to say so.
 *
 * Conservative on purpose: a typed ask only (a click already speaks for
 * itself), a short one, matched word-for-word against listed items — list
 * items and table cells, the shapes a pick-list wrongly becomes — and only
 * when that page offered no choice of its own.
 */
const PICK_STOP = new Set([
  "the", "this", "that", "these", "those", "what", "which", "show", "open",
  "tell", "explain", "more", "about", "please", "with", "from", "does", "how",
  "why", "one", "ones", "first", "second", "last", "yes", "okay",
]);

export function typedPick(site: Site, ask: string, hadSelection: boolean): string | null {
  if (hadSelection) return null;
  const words = ask.toLowerCase().split(/[^a-z0-9]+/).filter(
    (w) => w.length >= 4 && !PICK_STOP.has(w));
  if (!words.length || ask.trim().split(/\s+/).length > 6) return null;

  const page = site.pages.at(-1);
  if (!page || page.blocks.some((b) => b.kind === "choice")) return null;

  const listed: string[] = [];
  for (const b of page.blocks) {
    if (b.kind === "list") listed.push(...b.items);
    else if (b.kind === "table") for (const row of b.rows) listed.push(...row);
  }
  const hit = listed.some((item) => {
    const it = item.toLowerCase();
    return words.some((w) => it.includes(w));
  });
  if (!hit) return null;
  return "\nThe reader's message repeats an item you LISTED on the last page — " +
    "they had to type their pick. When a reply lists things the reader will " +
    "choose between, make the list a `choice` (or a workspace) so one tap answers " +
    "it. Do that with whatever this reply lists.";
}

export const NUDGE =
  "You stopped without writing anything to ui/pages/. The user sees a blank page — " +
  "your reply text is not shown to them anywhere. Write the page now.";
