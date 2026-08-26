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
import type { Anchor, Site } from "@perpetual/shared/site";

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
/** A block, in a phrase — enough for the agent to know which one is meant. */
function describeBlock(b: Block): string {
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
  }
}

export function turnMessage(
  opts: { ask: string; site: Site; pastAsks: string[]; anchor?: Anchor },
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

  // The anchor is a strong hint, not an instruction. It tells the agent what
  // "that" refers to; the routing guidance in rules.md still decides whether
  // the answer amends this page or starts a new one.
  if (opts.anchor) {
    const page = opts.site.pages.find((p) => p.id === opts.anchor!.page);
    if (page) {
      const at = opts.anchor.index != null ? page.blocks[opts.anchor.index] : undefined;
      parts.push(
        `\nThe user is asking from **${page.id}** ("${page.title}")` +
        (at ? `, looking at ${describeBlock(at)}` : "") +
        ". If they are correcting or refining that page, rewrite it in place.",
      );
    }
  }

  parts.push(`\n--- The user now asks ---\n\n${opts.ask}`);
  return parts.join("\n");
}

export const NUDGE =
  "You stopped without writing anything to ui/pages/. The user sees a blank page — " +
  "your reply text is not shown to them anywhere. Write the page now.";
