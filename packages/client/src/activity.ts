/**
 * What the agent is doing, in five words.
 *
 * This file used to classify commands into nine verbs and hand the raw shell
 * line to the composer, where it sat behind a toggle. That was transparency
 * aimed at the wrong person: the reader did not come here to watch `sed -n`
 * scroll past, and being shown it does not make them able to do anything about
 * it. Someone debugging the agent has the transcript on disk, which is better
 * evidence than a two-line tail in a pill.
 *
 * So: five states, and nothing under them.
 *
 *   Thinking     the model is generating; no command is running
 *   Reading      looking at files
 *   Running      executing something — a script, a language, a tool
 *   Drawing      producing a figure
 *   Writing      putting blocks on the page
 *
 * Two rules the wording keeps from the version before it:
 *
 *   NEVER INVENT PROGRESS. "Writing", not "50% done" — the harness has no idea
 *   how far along a turn is. The honest progress indicator already exists and
 *   is better than any of this: the page assembles block by block on screen.
 *
 *   ORDER BY INTENT, NOT BY SYNTAX. A turn that writes a page reads a
 *   directory first; what the reader wants to know is that a page is being
 *   written.
 */
export type Doing = "Thinking" | "Reading" | "Running" | "Drawing" | "Writing";

export function describeCommand(command: string): Doing {
  const c = command.trim();

  // Writing wins over everything: it is the thing the reader is waiting for.
  if (/ui\/pages\//.test(c) || /(^|[\s;&|(])page\s+(set|after|before|rm|move|append)\b/.test(c)) {
    return /\.svg\b/.test(c) ? "Drawing" : "Writing";
  }
  if (/\.svg\b/.test(c)) return "Drawing";
  if (/\b(python3?|node|bash|sh|make|npm|pnpm|cargo|go)\b/.test(c)) return "Running";
  if (/^(ls|cat|head|tail|find|grep|rg|wc|stat|du|sed -n|file|tree)\b/.test(c)) return "Reading";
  return "Running";
}
