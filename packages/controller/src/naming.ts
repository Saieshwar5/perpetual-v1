/**
 * What a session is CALLED. plans/46.
 *
 * The name used to be the first page's title, taken on the first turn and
 * frozen for good. Measured against a real store, that produced twelve
 * sessions and twelve useless names: every one of them "Hii" or "Hello",
 * including sessions of six, seven and nine pages about resumes, motors and
 * cleaning out Downloads. The list carried no information at all, so recency
 * was the only way to find anything.
 *
 * Two faults, compounding, and they are worth separating because the fixes
 * differ:
 *
 *   A GREETING IS NOT A SUBJECT. The name was decided at the moment the reader
 *   had said the least they would ever say. "Hii" is a fine title for a page —
 *   the page really is a greeting — and no name at all for a session.
 *
 *   A PAGE TITLE ANSWERS A DIFFERENT QUESTION. "What is this section?" is
 *   local and narrow, and rightly comes from one ask. "What was this whole
 *   conversation about?" is not that question, and borrowing the answer was
 *   the mistake underneath the first one.
 *
 * So: a session has no name until it has earned one, a derived name can still
 * be improved by one the agent wrote knowing what the work turned out to be,
 * and a name that has been earned never changes again — a title that keeps
 * drifting is as unfindable as one that never moves.
 */

/** What a session is called before it has earned anything better. */
export const UNTITLED = "New session";

/** How the current name was arrived at, which decides whether it may change. */
export type Named =
  /** Taken from the first page that was about something. May still improve. */
  | "derived"
  /** Written by the agent for the session itself, or by the reader. Final. */
  | "given";

/**
 * Words that say nothing about a subject: greetings, pleasantries, filler.
 *
 * Kept small and closed on purpose. The rule below fires only when EVERY word
 * is in here, so a list that is too eager cannot damage a real question —
 * "what is my resume about" survives on the strength of "resume" alone. The
 * risk of a short list is a greeting that slips through and names a session
 * badly; the risk of a long one is a real question silently losing its name,
 * which is worse and harder to notice.
 */
const NOTHING = new Set([
  "hi", "hii", "hiii", "hiiii", "hey", "heyy", "heyyy", "helo", "hello", "helloo",
  "hlo", "hallo", "yo", "sup", "hola", "howdy", "greetings", "morning",
  "afternoon", "evening", "night", "good", "day",
  "how", "are", "is", "r", "u", "you", "ur", "doing", "going", "its", "it",
  "thanks", "thank", "thx", "ty", "please", "pls", "ok", "okay", "k", "kk",
  "cool", "nice", "great", "awesome", "there", "again", "back",
  "bro", "man", "buddy", "mate", "dude", "friend", "sir",
  "test", "testing", "ping", "hmm", "hm", "ah", "oh",
  "yes", "yeah", "yep", "no", "nope", "sure", "fine", "well",
]);

/** Past this many words it is saying something, whatever the words are. */
const NOTHING_MAX_WORDS = 4;

/**
 * Does this ask say nothing about what the session is FOR?
 *
 * Deliberately conservative — short, and every single word a greeting. One
 * content word is enough to make an ask substantive, because a name derived
 * from a real question is nearly always better than no name, and a name
 * derived from "hii" is never better than none.
 */
export function saysNothing(ask: string): boolean {
  const words = ask
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")          // punctuation and emoji are not words
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;                     // punctuation, or nothing
  if (words.length > NOTHING_MAX_WORDS) return false;
  return words.every((w) => NOTHING.has(w));
}

/** A name is a label, not a sentence. Long ones are cut at a word. */
function clip(text: string, max = 52): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface NamedPage {
  title: string;
  /** The ask this page answered. What substantiveness is judged on. */
  ask?: string;
  /** A name for the SESSION, written by the agent on this page's meta.json. */
  session?: string;
}

/**
 * The session's name, given everything it has written.
 *
 * Returns null when nothing should change — which is most turns, and is the
 * point: a name worth having is one that stays put long enough to be
 * remembered.
 */
export function nameFor(
  current: { title: string; named?: Named },
  pages: readonly NamedPage[],
): { title: string; named: Named } | null {
  // Earned and final. The reader can still rename it; nothing automatic may.
  if (current.named === "given") return null;

  // The agent naming the session outright wins, whenever it arrives. It is the
  // only participant that has read both the question and its own answer, so it
  // is the one best placed to say what the whole thing was about.
  // (`given` already returned above, so reaching here means this is new.)
  const spoken = pages.find((p) => p.session?.trim());
  if (spoken) return { title: clip(spoken.session!), named: "given" };

  // A derived name is provisional only in that a written one may still replace
  // it. It is never swapped for ANOTHER derived name: a session renaming
  // itself every turn is one the reader can never find twice.
  if (current.named === "derived") return null;

  const first = pages.find((p) => !saysNothing(p.ask ?? p.title));
  if (!first) return null;                    // still nothing but greetings
  const title = clip(first.title);
  return { title, named: "derived" };
}
