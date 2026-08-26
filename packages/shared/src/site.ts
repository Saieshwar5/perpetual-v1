/**
 * The site — one session, one website.
 *
 * A session's `ui/` directory IS the website. There is no second tree and no
 * detached page: every page the agent writes joins one ordered sequence, and
 * the order is the directory order (`001-`, `002-`, ...). Connection between
 * pages is therefore a property of the filesystem, not something the agent has
 * to remember to do — writing the page connects it.
 */
import type { Block } from "./blocks.ts";

/**
 * How much freedom a page took — DERIVED from its blocks, never declared.
 *
 * 1 text only · 2 text plus components · 3 plus figures.
 *
 * The agent does not write this and cannot influence it except by choosing
 * blocks, which is the only honest way to influence it. Useful for a badge or
 * for statistics; not a permission.
 */
export type Tier = 1 | 2 | 3;

/**
 * The bounded alternative to free CSS. plans/16 §7 — four compositions the
 * client styles, rather than a stylesheet the agent writes.
 *
 * Unlike `tier`, this one the agent DOES declare, and rightly: nothing about
 * the blocks says whether a page wants the reading column or a wider measure.
 * That is a judgement only the author can make, so it is the one presentation
 * field worth asking for.
 */
export type Layout = "column" | "wide" | "split" | "gallery";

export interface PageMeta {
  /** Directory name: `003-margin-analysis`. Sorts into site order. */
  id: string;
  title: string;
  /** The user ask this page answers. Drives the rail's thread. */
  ask?: string;
  /** Derived from `blocks`. See Tier. */
  tier: Tier;
  layout: Layout;
}

/**
 * Where a question was asked from. plans/17.
 *
 * The composer is invoked at a place in the document rather than living in a
 * fixed bar, so a turn can carry its own referent. This is what lets "make
 * that shorter" mean something — until now the agent got a bare string and had
 * to guess what "that" was.
 */
export interface Anchor {
  page: string;
  /** Index of the block the reader was looking at, when known. */
  index?: number;
  /**
   * The block's own id, when it has one. Both are carried because they answer
   * different questions: `index` is where it was, `id` is what it was.
   *
   * The composer HOLDS an anchor while the reader types, so a page the agent
   * rewrites mid-sentence used to leave the anchor pointing at whatever slid
   * into that slot. An id survives the rewrite — the client re-resolves the
   * index from it, and the agent is told the name rather than a position that
   * may already have moved.
   */
  id?: string;
  /**
   * The words the reader had selected, when they selected any.
   *
   * A block is a coarse referent: "about this paragraph" is true of five
   * sentences at once. When the reader highlights a phrase they have said
   * something much more precise, and the agent WROTE that phrase — so quoting
   * it back is an exact reference with nothing left to interpret.
   */
  quote?: string;
}

/**
 * What the reader TOUCHED, rather than what they typed.
 *
 * The other half of the loop, and the thing the product was missing. Until now
 * the only way anything reached the agent was a sentence: clicking a door
 * called `composer.send(question)`, which sent the door's text as if it had
 * been typed, and the server worked backwards — string-matching the ask
 * against every door on every page — to guess that a button had been pressed.
 *
 * That guess is wrong in four ways. Typing a sentence that happens to match a
 * door counts as clicking it. Two pages offering the same question collide,
 * because the record was keyed on the text alone. The agent is never told a
 * click happened at all. And nothing that is not a sentence — a file, a mail,
 * an option — can be clickable, because a string is the only thing the channel
 * carries.
 *
 * So a click travels as itself: which control, on which page, and which option
 * — the agent's own token, handed back unchanged.
 */
export interface Selection {
  /** The page the control is on. */
  page: string;
  /**
   * Which control. `choice` blocks are required to carry an `id` precisely so
   * this can name one; a door is named by its page and its question.
   */
  block?: string;
  /** What kind of control it was. The agent is told different things about each. */
  control: "choice" | "next";
  /** The option's own id, or — for a door — the question itself. */
  option: string;
  /** What the reader saw on the thing they touched. */
  label: string;
  /** The question the control asked, when it asked one. */
  prompt?: string;
}

/**
 * The two records of what has been touched, keyed the same way on both sides.
 *
 * Defined here rather than in the client and the server separately, because a
 * key that is computed in two places is a key that will eventually be computed
 * two ways — which is exactly how doors ended up keyed on question text alone
 * and colliding across pages.
 */
export const doorKey = (page: string, question: string) => `${page}\n${question}`;
export const choiceKey = (page: string, block: string) => `${page}\n${block}`;

export interface Problem {
  page: string;
  /** 1-based line in page.ndjson, when the problem is a line. */
  line?: number;
  message: string;
}

export interface Page extends PageMeta {
  blocks: Block[];
}

export interface Site {
  pages: Page[];
  problems: Problem[];
}

export interface SessionIndex {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pageCount: number;
  /** Every user ask, oldest first — the rail's thread. */
  asks: string[];
  /**
   * Doors that have been walked through: the exact `next` question, mapped to
   * the page it produced.
   *
   * A page's `next` block is ONE FORK, not a menu. The site is a single
   * ordered sequence — force-scroll moves along it, the rail is a linear
   * thread — so one page spawning three siblings would put three unrelated
   * tangents in a row and imply a progression that is not there. Taking a
   * branch therefore closes the others: the one taken becomes a link to the
   * room it built, and the rest stay on the page as a record of the fork.
   */
  answered: Record<string, string>;
  /**
   * Choices already answered: `choiceKey(page, block)` -> the option's id.
   *
   * Separate from `answered` because they record different things. A door maps
   * to the PAGE it built — that is what makes it a link afterwards. A choice
   * maps to the OPTION that was picked, which usually builds nothing: it
   * answers a question the agent could not proceed without.
   */
  chosen: Record<string, string>;
}
