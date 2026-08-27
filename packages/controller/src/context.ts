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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Block } from "@perpetual/shared/blocks";
import { choiceKey, doorKey } from "@perpetual/shared/site";
import type { Anchor, Selection, Site } from "@perpetual/shared/site";

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

let cached: string | undefined;

/** The cache-stable prefix: identity + the rules. Read once per process. */
export async function systemPrompt(): Promise<string> {
  if (cached) return cached;
  const [agent, rules] = await Promise.all([
    readFile(join(PROMPTS, "agent.md"), "utf8"),
    readFile(join(PROMPTS, "rules.md"), "utf8"),
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
    case "link":
      return `a link to ${b.page}`;
    case "next":
      return `the questions this page leaves open`;
    case "choice":
      return `the choice "${b.prompt}"`;
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
  if (sel.control === "next") {
    return `\nThe user did not type this — they took a door on **${sel.page}**: ` +
      `"${sel.option}". That is a fork: they are asking for a page that does not ` +
      "exist yet, so write one rather than amending the page they came from.";
  }
  return `\nThe user did not type this — they answered your choice ` +
    `\`${sel.block}\` on **${sel.page}**` +
    (sel.prompt ? ` ("${sel.prompt}")` : "") +
    ` by picking \`${sel.option}\` — ${sel.label}. That is the answer you were ` +
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

  if (opts.selection) parts.push(describeSelection(opts.selection));

  parts.push(`\n--- The user now asks ---\n\n${opts.ask}`);
  return parts.join("\n");
}

export const NUDGE =
  "You stopped without writing anything to ui/pages/. The user sees a blank page — " +
  "your reply text is not shown to them anywhere. Write the page now.";
