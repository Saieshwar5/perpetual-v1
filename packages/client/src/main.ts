/**
 * The chrome, and the wiring behind it.
 *
 * Two zones, and the boundary between them is the architecture:
 *
 *   FIXED CHROME — the library, the header, the rail, the composer. Hand-built,
 *   identical in every session, never generated. The agent does not know it
 *   exists.
 *
 *   THE CANVAS — the flow in the middle: one continuous scroll made of
 *   sections, rendered from files in the session directory and from nothing
 *   else.
 *
 * Every `page_*` event below came from the controller watching a directory, so
 * this file never has to decide whether to believe the agent. It renders what
 * was written.
 *
 * A note on the word "page". On disk and on the wire a section is still a
 * page — `ui/pages/NNN-slug`, `page_open`, `page_block` — because that is what
 * the agent writes and what the watcher reports. What changed is only how they
 * are PRESENTED: stacked into one scroll instead of dealt out as a deck.
 */
import { appendBlock, renderBlock, type BlockActions } from "./render.ts";
import { runTurn, type WireEvent } from "./stream.ts";
import { Flow } from "./flow.ts";
import { Rail } from "./rail.ts";
import { Composer } from "./composer.ts";
import { mountSettings, load as loadSettings } from "./settings.ts";
import { measureFlow } from "./measure.ts";
import { describeCommand, activityLine } from "./activity.ts";
import { choiceKey, doorKey } from "@perpetual/shared/site";
import type { Anchor, Page, Selection, Site, SessionIndex } from "@perpetual/shared/site";
import type { RenderReport } from "@perpetual/shared/render";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const libraryView = $("library");
const sessionView = $("session");
const grid = $("grid");
// `.site`, not `.flow`: the `flow` BLOCK (a sequence of steps) already owns
// that class inside a page, and one of the two would have eaten the other.
const flowHost = $("site");
const railHost = $("rail");
const titleEl = $("stitle");

const flow = new Flow(flowHost);
const rail = new Rail(railHost, $("railmid"));
const composer = new Composer($("pill"), $("floathost"));
const libHost = $("libhost");
const matchEl = $("matchline");

let sessionId: string | null = null;
let pages: Page[] = [];
let think = "";
let turn: AbortController | null = null;
/** Did the reader ask anything in this session while it was open? */
let attempted = false;
/** The library, as loaded. Filtering is a view over this, not a refetch. */
let library: SessionIndex[] = [];
/** What a rendered block may do. Defined once so every render path agrees. */
/** Doors already walked through: `doorKey(page, question)` -> the page it built. */
let answered: Record<string, string> = {};
/** Choices already answered: `choiceKey(page, block)` -> the option's id. */
let chosen: Record<string, string> = {};

/**
 * What the reader touched, waiting to travel with the turn it started.
 *
 * Held for the moment between the click and the submit rather than passed
 * through the composer, because the composer is chrome: it knows about text
 * and nothing about blocks. Set immediately before `send`, consumed and
 * cleared at the top of `onSubmit`, so a typed question can never pick one up.
 */
let pendingSelection: Selection | undefined;

/**
 * The actions for blocks on ONE page.
 *
 * Per page rather than global, because every answer has to say where it came
 * from: two pages can offer the same door, and a choice is only identified by
 * its page and its name together. The global version of this is exactly how
 * doors ended up colliding across pages.
 */
function actionsFor(page: string): BlockActions {
  return {
    link: (id) => flow.gotoId(id),
    // Old sessions recorded doors by question text alone. Read those too, so a
    // session from before the key changed still shows what was taken.
    answered: (q) => answered[doorKey(page, q)] ?? answered[q] ?? null,
    picked: (block) => chosen[choiceKey(page, block)] ?? null,

    // A door the agent offered. Clicking it still asks the question — that is
    // what a door IS — but it now says so: which page, which question.
    next: (q) => {
      clearAim();
      pendingSelection = { page, control: "next", option: q, label: q };
      void composer.send(q);
    },

    // A choice the agent asked. The ask reads as the exchange it was, so the
    // rail's thread stays legible; the option's id travels beside it, and that
    // is what the agent actually reads.
    choose: (b, o) => {
      if (!b.id) return;
      clearAim();
      pendingSelection = {
        page, control: "choice", block: b.id,
        option: o.id, label: o.label, prompt: b.prompt,
      };
      // Painted at once, so the answer lands under the reader's finger rather
      // than after a turn. The server records it on the way in, so a reload
      // agrees with what they just saw.
      chosen[choiceKey(page, b.id)] = o.id;
      repaintControls();
      void composer.send(`${b.prompt} — ${o.label}`);
    },
  };
}

/** The actions for whichever page a node belongs to. */
const actionsForNode = (doc: Element): BlockActions =>
  actionsFor(doc.closest<HTMLElement>(".panel")?.dataset.page ?? "");
let filter = "";

const status = (text: string, tone: "" | "work" | "bad" = "") => composer.status(text, tone);

/* ------------------------------------------------------------------ pages */

/**
 * Build one section.
 *
 * It used to carry a `.sheet` — an internal scroller, one per page, because
 * each page was a frame with its own overflow. There is one scroller now, the
 * flow itself, so a section is a plain block in normal flow and the browser
 * lays them out end to end.
 */
function makePanel(page: Page) {
  const root = document.createElement("section");
  root.className = "panel";
  const doc = document.createElement("article");
  // The layout modes are the whole of "layout freedom" (plans/16 §7): four
  // compositions we style, rather than a stylesheet the agent writes.
  doc.className = `doc lay-${page.layout ?? "column"}`;
  root.append(doc);
  const acts = actionsFor(page.id);
  for (const b of page.blocks) appendBlock(doc, b, acts);
  return { root, doc };
}

function addPage(page: Page, opts: { goto?: boolean } = {}) {
  const { root, doc } = makePanel(page);
  root.dataset.page = page.id;
  doc.dataset.blocks = String(page.blocks.length);
  flow.add({ id: page.id, root });
  pages.push(page);
  paintRail();
  // A section that has just been opened is the one the reader wants to watch
  // being written, and in a flow that is a scroll rather than a page turn.
  if (opts.goto) flow.toEnd();
}

function docFor(id: string): HTMLElement | null {
  return flowHost.querySelector<HTMLElement>(`.panel[data-page="${id}"] .doc`);
}

/**
 * Re-render every control. Their markup depends on what the reader has
 * ANSWERED, which lives in the session rather than in the page file — so
 * nothing upstream notices when it changes and they have to be repainted by
 * hand.
 */
function repaintControls() {
  for (const page of pages) {
    const doc = docFor(page.id);
    if (!doc) continue;
    const acts = actionsFor(page.id);
    for (const [i, b] of page.blocks.entries()) {
      if (b.kind !== "next" && b.kind !== "choice") continue;
      doc.children[i]?.replaceWith(renderBlock(b, acts));
    }
  }
}

/**
 * Mark what has been revised, and what revised it.
 *
 * The agent cannot change a section once it is published — it corrects by
 * writing a new block that names the one it replaces. That leaves the record
 * complete, which is the point, but it would also leave a wrong sentence
 * sitting up the page with nothing to say it had been corrected. Anyone
 * scrolling past it later would read it as current.
 *
 * So the pair is drawn as a pair: the old block dims and gains a way DOWN to
 * its revision, the new one gains a way BACK UP to what it replaced. Nothing
 * is hidden and nothing is edited — this is decoration derived from the files,
 * recomputed from scratch whenever the site changes, because a correction can
 * name a block in a section rendered long before it.
 */
function paintRevisions() {
  for (const n of flowHost.querySelectorAll(".revmark")) n.remove();
  for (const n of flowHost.querySelectorAll(".superseded")) n.classList.remove("superseded");

  for (const node of flowHost.querySelectorAll<HTMLElement>("[data-supersedes]")) {
    const ref = node.dataset.supersedes!;
    const [page, block] = ref.split("/");
    const target = flowHost.querySelector<HTMLElement>(
      `.panel[data-page="${page}"] [data-block-id="${block}"]`);
    if (!target) continue;                       // the validator has already said so

    target.classList.add("superseded");
    target.append(revMark("Revised below ↓", () => {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      flash(node);
    }));
    node.append(revMark("Replaces what is above ↑", () => {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      flash(target);
    }));
  }
}

/**
 * Debounced, because it is a whole-site pass and page events arrive one block
 * at a time. Short — shorter than the render report's settle — so a correction
 * is marked as soon as the block carrying it lands rather than at turn end.
 */
let revTimer: number | undefined;
function scheduleRevisions() {
  clearTimeout(revTimer);
  revTimer = setTimeout(paintRevisions, 120) as unknown as number;
}

function revMark(text: string, go: () => void): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "revmark";
  b.textContent = text;
  // The block underneath is clickable too — pointing at it is how you ask
  // about it — so this must not be read as pointing at anything.
  b.addEventListener("click", (e) => { e.stopPropagation(); go(); });
  b.addEventListener("mouseup", (e) => e.stopPropagation());
  return b;
}

/** Say "here" once, for someone who has just been sent across the site. */
function flash(node: HTMLElement) {
  node.classList.remove("found");
  void node.offsetWidth;                          // restart the animation
  node.classList.add("found");
  setTimeout(() => node.classList.remove("found"), 1600);
}

/**
 * Tell the agent what its page turned out to look like.
 *
 * The one signal that never existed. The agent writes blocks and finds out
 * whether they PARSE; it has never found out how tall they came out. This
 * measures the flow as it currently stands and posts it to the running turn, where the
 * controller turns it into a note in the agent's next tool result — the same
 * channel a validation problem already arrives in, so the agent reads it where
 * it is already reading and can act on it before the turn ends.
 *
 * Only while a turn is running, and debounced: a page is written a block at a
 * time, and measuring a half-written page would report a paragraph as a page.
 * The settle is longer than the watcher's poll, so what gets measured is a
 * page that has stopped growing rather than one caught mid-sentence.
 */
const REPORT_SETTLE_MS = 400;
let reportTimer: number | undefined;

function reportRender() {
  if (!sessionId || !turn) return;
  const { width, pages: measured } = measureFlow(flowHost);
  if (!measured.length) return;
  const report: RenderReport = { width, type: loadSettings().type, pages: measured };
  // Fire and forget. This is advice for the agent, not part of the turn: a
  // failed report must never disturb the page the reader is watching.
  void fetch(`/sessions/${sessionId}/rendered`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    keepalive: true,
  }).catch(() => {});
}

function scheduleReport() {
  if (!turn) return;
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportRender, REPORT_SETTLE_MS) as unknown as number;
}

function paintRail() {
  rail.set(pages.map((p) => ({ id: p.id, ask: p.ask ?? "", title: p.title })));
  rail.setActive(flow.index);
  composer.position(pages.length ? `${flow.index + 1} / ${pages.length}` : "");
}

flow.onChange = (i, id) => {
  rail.setActive(i);
  composer.position(pages.length ? `${i + 1} / ${pages.length}` : "");
  // Scrolling out of the section the aim lives in drops it to that section. A
  // block the reader has scrolled past is a reminder they can go back to; one
  // in a section they have LEFT is a claim about something they are no longer
  // looking at.
  if (aim && aim.page !== id && !composer.busy) setAim({ page: id });
  placeComposer();
};

// The composer's size follows the scroll, and the scroll is now one scroller
// rather than one per page — so this is a single subscription instead of a
// listener attached to every panel as it was built.
flow.onScroll = () => placeComposer();

/**
 * Is the reader out of website?
 *
 * The composer used to inflate at the bottom of EVERY page, because every page
 * was a scroller with its own bottom, and the bottom of page 3 of 6 does not
 * mean "you are finished, ask something". In a flow the question is honest and
 * singular: there is one bottom, and reaching it means there is nothing left to
 * read — which is exactly when asking is the next step.
 */
let atSiteEnd = false;

/**
 * Size the composer for where the reader is.
 *
 * There is one composer and one home. It used to be re-parented into a `.dock`
 * built into every page — N docks for one composer, 26vh of reserved space at
 * the end of each of them, and a re-parent that blurred whatever was focused
 * (which is why docking had to be blocked whenever the reader was mid-sentence).
 * All of that is now a class on one element.
 */
function placeComposer() {
  // Read from the scroller only — never from the composer's own height, which
  // changes as a result of this decision and would oscillate.
  atSiteEnd = flow.atEnd;

  flowHost.classList.toggle("atend", atSiteEnd);
  composer.compact(!atSiteEnd && !aim);
  if (!aim) {
    composer.placeholder(atSiteEnd
      ? "Ask a follow-up, or something new…"
      : "Ask about what you are reading, or something new…");
  }
}

/** What each block is, in the reader's words. */
const AIM_LABEL: Record<string, string> = {
  heading: "the headline", section: "this section", prose: "this paragraph",
  quote: "this quote", list: "this list", code: "this code", note: "this note",
  metrics: "these numbers", chart: "this chart", table: "this table",
  split: "this comparison", flow: "this sequence", figure: "this figure",
  link: "this link",
};

/**
 * The anchor, held while the composer is open rather than recomputed at submit.
 *
 * Held, because the reader has to be able to SEE what they are pointing at
 * before they commit to a sentence about it — and a value that moved between
 * being shown and being sent would be worse than no value at all.
 */
let aim: Anchor | undefined;
/**
 * Did the READER point at this, or did the app guess it?
 *
 * Opening the composer takes a guess — the block nearest the middle of the
 * view — so that "make that shorter" means something without anyone having to
 * click first. That guess must never be treated as a decision. Clicking the
 * block you are pointing at undoes it, and without this flag the FIRST click
 * on the middle block undid an aim the reader had never made: open, guess that
 * block, then read the click that caused the open as "undo". The block in the
 * middle of the screen was unselectable, and no other block was.
 */
let aimChosen = false;

function clearAim() {
  for (const n of flowHost.querySelectorAll(".anchored")) n.classList.remove("anchored");
  aimWatch?.disconnect();
  aimWatch = undefined;
  aim = undefined;
  aimChosen = false;
  composer.aim(null);
}

/**
 * Re-resolve the held anchor after the page moved underneath it.
 *
 * The reader points at a paragraph and starts typing; the agent, mid-sentence,
 * inserts a note above it. The anchor was an INDEX, so it now points at
 * whatever slid into that slot — the reader would be asking about a block they
 * never chose, and the mark in the gutter would be beside the wrong thing.
 *
 * A named block has a name, so this finds it again. An unnamed one cannot be
 * found, and the honest thing is to drop to the page rather than keep a
 * position that is probably a lie.
 */
function reaim() {
  if (!aim) return;
  if (aim.index == null) return;                    // already page-level
  const page = pages.find((p) => p.id === aim!.page);
  if (!page) { setAim(undefined); return; }

  const chosen = aimChosen;                         // survives the re-set below
  if (aim.id) {
    const now = page.blocks.findIndex((b) => b.id === aim!.id);
    if (now === -1) { setAim({ page: aim.page }); return; }
    if (now !== aim.index) setAim({ ...aim, index: now }, chosen);
    else setAim(aim, chosen);                       // repaint: the node may be new
    return;
  }
  // Unnamed: the index may still be right, but nothing can prove it. Keep it
  // only while it points at a block of the same kind — otherwise let it go.
  const still = page.blocks[aim.index];
  setAim(still ? aim : { page: aim.page }, still ? chosen : false);
}

/**
 * Watches whether the block being pointed at is still on screen.
 *
 * The rule the anchor was built on — "the reader has to be able to SEE what
 * they are pointing at before they commit to a sentence about it" — was only
 * enforced at the moment of pointing. Scroll three screens away and the aim
 * stayed, invisible, attached to a paragraph the reader could no longer check.
 * A question can be sent at something they never chose and never see.
 *
 * So the aim follows the reader: still theirs while the block is off screen,
 * but shown as a reminder they can click to go back to, and dropped entirely
 * if they scroll out of the section it lives in.
 */
let aimWatch: IntersectionObserver | undefined;

function watchAim(node: Element) {
  aimWatch?.disconnect();
  aimWatch = new IntersectionObserver(
    ([entry]) => { if (entry) paintAim(!entry.isIntersecting); },
    // A block half in view is still in view: the reader can see it and check it.
    // The flow is the scroller now, so it is also the frame "on screen" means.
    { root: flowHost, threshold: 0.15 },
  );
  aimWatch.observe(node);
}

/** Draw the aim line for the current `aim`, faded when it is off screen. */
function paintAim(offScreen = false) {
  const a = aim;
  const page = a ? pages.find((p) => p.id === a.page) : undefined;
  const block = a?.index != null ? page?.blocks[a.index] : undefined;
  if (!a || !block) {
    composer.aim(null);
    composer.placeholder("Ask a follow-up, or something new…");
    return;
  }
  // The reader's own words beat a category: "about this paragraph" is true of
  // five sentences at once, and they picked one.
  const what = a.quote
    ? `“${a.quote.length > 52 ? `${a.quote.slice(0, 51)}…` : a.quote}”`
    : AIM_LABEL[block.kind] ?? "this";
  composer.aim(offScreen ? `about ${what}, further up ↑` : `about ${what}`, { faded: offScreen });
  composer.placeholder("Change this, or ask about it…");
}

function setAim(a: Anchor | undefined, chosen = false) {
  for (const n of flowHost.querySelectorAll(".anchored")) n.classList.remove("anchored");
  aimWatch?.disconnect();
  aimWatch = undefined;
  aim = a;
  // Only a block the reader indicated is theirs to undo.
  aimChosen = chosen && a?.index != null;
  const node = a?.index != null ? docFor(a.page)?.children[a.index] : undefined;
  if (node) { node.classList.add("anchored"); watchAim(node); }
  paintAim();
}

/**
 * What the reader is looking at: the block nearest the middle of the view.
 * This is the referent that makes "that number is wrong" mean something.
 *
 * Every section is searched rather than just the active one. In a deck only
 * one page could be on screen, so "the active page" and "what is in front of
 * them" were the same thing; in a flow a section boundary can sit anywhere,
 * and the block at the middle of the view is the honest answer wherever it
 * lives.
 *
 * At the END of the site there is no single block being looked at — the last
 * section as a whole is — so the question anchors to it and nothing narrower.
 */
function currentAnchor(): Anchor | undefined {
  const id = flow.activeId;
  if (!id) return undefined;
  if (atSiteEnd) return { page: id };

  const mid = flowHost.getBoundingClientRect().top + flowHost.clientHeight / 2;
  let bestPage: string | undefined;
  let best = -1, bestGap = Infinity;
  for (const panel of flowHost.querySelectorAll<HTMLElement>(".panel")) {
    const doc = panel.querySelector<HTMLElement>(".doc");
    const page = panel.dataset.page;
    if (!doc || !page) continue;
    for (const [i, node] of [...doc.children].entries()) {
      const r = node.getBoundingClientRect();
      const gap = Math.abs((r.top + r.bottom) / 2 - mid);
      if (gap < bestGap) { bestGap = gap; best = i; bestPage = page; }
    }
  }
  if (!bestPage || best === -1) return { page: id };
  const block = pages.find((p) => p.id === bestPage)?.blocks[best];
  return { page: bestPage, index: best, ...(block?.id ? { id: block.id } : {}) };
}
rail.onPick = (id) => flow.gotoId(id);

/**
 * Leaving a session nobody used: take it with you.
 *
 * The server sweeps too, but only on the way to the library and only after a
 * grace period — this is the immediate path, so an abandoned "New session"
 * never appears in the list at all. Guarded on `attempted` rather than on the
 * page count: a turn that failed produced no page but is still worth keeping.
 */
async function retireIfUnused(id: string | null, opts: { unloading?: boolean } = {}) {
  if (!id || attempted || pages.length > 0 || turn) return;
  const req = fetch(`/sessions/${id}`, { method: "DELETE", keepalive: true });
  if (!opts.unloading) await req.catch(() => {});
}

/* --------------------------------------------------------------- library */

async function showLibrary(opts: { focus?: boolean } = {}) {
  await retireIfUnused(sessionId);
  sessionId = null;
  location.hash = "";
  libraryView.hidden = false;
  sessionView.hidden = true;

  // The composer comes with us. On this view it is the primary action, so it
  // opens rather than waiting to be invoked.
  composer.setHome(libHost);
  // Never short here: on the library there is no page to be quiet about, and
  // asking is the only thing to do.
  composer.compact(false);
  composer.placeholder("Ask anything — or type to find an earlier session");
  composer.clear();
  if (opts.focus !== false) composer.open();
  status("");

  library = (await (await fetch("/sessions")).json()) as SessionIndex[];
  paintLibrary();
}

/** Does this session answer anything like what is being typed? */
function matches(s: SessionIndex, q: string): boolean {
  if (!q) return true;
  const hay = `${s.title} ${s.asks.join(" ")}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function paintLibrary() {
  const shown = library.filter((s) => matches(s, filter));

  // The count is what makes the filter worth having: it answers "have I asked
  // this before?" before a model call is spent finding out.
  matchEl.textContent = !filter
    ? ""
    : shown.length
      ? `${shown.length} of ${library.length} session${library.length === 1 ? "" : "s"} match`
      : "";

  grid.replaceChildren(...shown.map((s) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    const h = document.createElement("h3");
    h.textContent = s.title;
    const last = document.createElement("p");
    last.className = "last";
    last.textContent = s.asks.at(-1) ?? "No pages yet";
    const meta = document.createElement("div");
    meta.className = "cmeta";
    meta.textContent = `${s.pageCount} page${s.pageCount === 1 ? "" : "s"} · ${when(s.updatedAt)}`;
    card.append(h, last, meta);
    card.addEventListener("click", () => openSession(s.id));
    return card;
  }));

  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    if (filter) {
      empty.textContent = "No sessions match. Press ↵ to ask it as a new question.";
      grid.replaceChildren(empty);
    } else if (library.length) {
      grid.replaceChildren();
    } else {
      // The first screen anyone sees, and it used to be one flat sentence. It
      // is the only chance to say what this is — so it says it, and offers
      // three real questions rather than asking the reader to invent one.
      grid.replaceChildren(firstRun());
    }
  }
}

/**
 * What to show someone who has never used this.
 *
 * An empty grid teaches nothing, and "ask something" is an instruction, not an
 * explanation. The examples are clickable because the fastest way to explain a
 * product that writes a website in answer to a question is to answer one.
 */
function firstRun(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "firstrun";

  const p = document.createElement("p");
  p.textContent = "Ask a question and this writes you a page about it — "
    + "a real one, with figures and tables, not a chat reply. Ask again and it "
    + "writes the next part, below. One session is one long page you scroll.";
  wrap.append(p);

  const row = document.createElement("div");
  row.className = "tryrow";
  for (const q of [
    "How does a four-stroke engine work?",
    "Why do neural networks need so much data?",
    "What actually happens when I press Enter on a URL?",
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "try";
    b.textContent = q;
    b.addEventListener("click", () => void composer.send(q));
    row.append(b);
  }
  wrap.append(row);
  return wrap;
}

/** Why a turn stopped, in the reader's terms rather than the loop's. */
const CUT_SHORT: Record<string, string> = {
  steps: "ran out of commands",
  time: "ran out of time",
  context: "ran out of room to think",
  error: "hit an error",
};

/**
 * Put a mark at the end of the section that was cut off, with the one action
 * worth offering. Nothing else in the product says an answer is incomplete —
 * it simply stops, and stopping looks the same as finishing.
 *
 * The LAST section, not the active one: the reader may have scrolled away
 * while the turn ran, and the unfinished work is where it was being written.
 */
function markUnfinished(cause: string) {
  const id = pages.at(-1)?.id;
  const doc = id ? docFor(id) : null;
  if (!doc || doc.querySelector(".cutshort")) return;

  const box = document.createElement("div");
  box.className = "note warn cutshort";
  box.textContent = `This answer stopped early — the agent ${
    CUT_SHORT[cause] ?? "was interrupted"}. `;
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pagelink";
  go.textContent = "Finish it";
  go.addEventListener("click",
    () => void composer.send("Finish this section — it was cut short."));
  box.append(go);
  doc.append(box);
}

function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/* --------------------------------------------------------------- session */

async function openSession(id: string, opts: { starting?: boolean } = {}) {
  if (id !== sessionId) await retireIfUnused(sessionId);
  sessionId = id;
  attempted = Boolean(opts.starting);
  composer.setHome($("floathost"));
  composer.placeholder("Ask anything…");
  location.hash = `#/s/${id}`;
  libraryView.hidden = true;
  sessionView.hidden = false;

  flow.clear();
  pages = [];

  const [index, site] = await Promise.all([
    fetch(`/sessions/${id}`).then((r) => r.json()) as Promise<SessionIndex>,
    fetch(`/sessions/${id}/site`).then((r) => r.json()) as Promise<Site>,
  ]);
  titleEl.textContent = index.title;
  answered = index.answered ?? {};
  chosen = index.chosen ?? {};
  for (const p of site.pages) addPage(p);

  // Always open at the foot of the site — a session is resumed at its newest
  // answer, and the reader scrolls back for the rest. Instantly, not smoothly:
  // a nine-section glide past work they have not read yet is scenery on the way
  // to where they asked to be.
  paintRevisions();
  if (pages.length) {
    flow.toEnd({ animate: false });
    // And again once the browser has settled. Fonts and figures land after the
    // first layout, and each one makes the site taller — so a session opened
    // "at the end" ended up a screen short of it.
    requestAnimationFrame(() => {
      flow.toEnd({ animate: false });
      placeComposer();
    });
  }
  paintRail();
  placeComposer();
  // An empty session has nothing to read, so open the composer rather than
  // making a first-time reader hunt for it.
  // Not when a turn is already on its way in — the pill is about to go busy.
  if (opts.starting) { /* the caller drives the composer */ }
  else if (!pages.length) { status("Ask something to start this site."); composer.open(); }
  else status("");
}

/** A session is created because a question was asked, never on its own. */
async function startSession(): Promise<string> {
  const s = (await (await fetch("/sessions", { method: "POST" })).json()) as SessionIndex;
  await openSession(s.id, { starting: true });
  return s.id;
}

/**
 * Keep the foot of the site under the reader while a section is being written.
 *
 * A deck page grew inside its own frame, so an arriving block never moved
 * anything. In one scroll it does: the reader watching a section assemble at
 * the bottom of the window would have each new paragraph land BELOW the fold
 * and have to chase it. So if they were at the foot before the block landed,
 * they are still at the foot after it — and if they had scrolled up to read
 * something, nothing moves them.
 *
 * Instant, never smooth: a glide per block would still be running when the
 * next one arrived.
 */
function stickToEnd(change: () => void) {
  const wasAtEnd = flow.atEnd;
  change();
  if (!wasAtEnd) return;
  flow.toEnd({ animate: false });
  placeComposer();
}

/* ------------------------------------------------------------------- turn */

function handle(ev: WireEvent) {
  // Anything that changes what a page looks like is worth re-measuring — the
  // agent is told about the page as it stands, not as it was when it opened.
  if (ev.type.startsWith("page_")) { scheduleReport(); scheduleRevisions(); }

  switch (ev.type) {
    case "text_delta":
      // Prose between tool calls is status, never content. The user's answer
      // is the page; this is only evidence that something is alive.
      think += ev.delta;
      status(think.trim().split("\n").pop()!.slice(-90), "work");
      break;

    case "tool_start":
      think = "";
      composer.activity(
        activityLine(describeCommand(ev.command), (id) => pages.find((p) => p.id === id)?.title),
        ev.command,
      );
      break;

    case "tool_output":
      composer.output(ev.chunk);
      break;

    case "tool_end":
      if (ev.exitCode !== 0 || ev.killed) composer.commandFailed();
      break;

    case "page_open":
      addPage(ev.page, { goto: true });
      status("writing", "work");
      break;

    case "page_block": {
      const doc = docFor(ev.page);
      const page = pages.find((p) => p.id === ev.page);
      if (!doc || !page) break;
      page.blocks[ev.index] = ev.block;
      stickToEnd(() => appendBlock(doc, ev.block, actionsFor(ev.page)));
      break;
    }

    case "page_block_replace": {
      const doc = docFor(ev.page);
      const page = pages.find((p) => p.id === ev.page);
      const node = doc?.children[ev.index];
      if (!doc || !page || !node) break;
      page.blocks[ev.index] = ev.block;
      // Swapped in place: everything around it keeps its identity, and the
      // reader keeps their scroll position.
      node.replaceWith(renderBlock(ev.block, actionsFor(ev.page)));
      reaim();
      break;
    }

    // The keyed ops. Each one is a surgical change to a page that would
    // otherwise have been thrown away and rebuilt: the reader keeps their
    // scroll position, and every node that did not change keeps its identity —
    // its animations, its anchored mark, and the focus inside it.
    //
    // Surgical matters more in a flow than it did in a deck: everything BELOW
    // the amended section is part of the same scroll, so rebuilding a section
    // the reader has scrolled past would move the ground under what they are
    // reading now.
    case "page_block_insert": {
      const doc = docFor(ev.page);
      const page = pages.find((p) => p.id === ev.page);
      if (!doc || !page) break;
      page.blocks.splice(ev.index, 0, ev.block);
      const node = renderBlock(ev.block, actionsFor(ev.page));
      const at = doc.children[ev.index];
      if (at) doc.insertBefore(node, at); else doc.append(node);
      reaim();
      break;
    }

    case "page_block_remove": {
      const doc = docFor(ev.page);
      const page = pages.find((p) => p.id === ev.page);
      if (!doc || !page) break;
      page.blocks.splice(ev.index, 1);
      doc.children[ev.index]?.remove();
      reaim();
      break;
    }

    case "page_block_move": {
      const doc = docFor(ev.page);
      const page = pages.find((p) => p.id === ev.page);
      const node = doc?.children[ev.from];
      if (!doc || !page || !node) break;
      page.blocks.splice(ev.to, 0, ...page.blocks.splice(ev.from, 1));
      // Moved, not re-rendered: a figure keeps its drawing, a chart keeps its
      // bars where they are, and nothing flashes.
      const at = doc.children[ev.to > ev.from ? ev.to + 1 : ev.to];
      if (at) doc.insertBefore(node, at); else doc.append(node);
      reaim();
      break;
    }

    case "page_replace": {
      const i = pages.findIndex((p) => p.id === ev.page.id);
      const doc = docFor(ev.page.id);
      if (i === -1 || !doc) break;
      pages[i] = ev.page;
      doc.className = `doc lay-${ev.page.layout ?? "column"}`;
      // Rebuilt in place, so the section keeps its identity and the reader
      // keeps their position in the scroll.
      doc.replaceChildren();
      const acts = actionsFor(ev.page.id);
      for (const b of ev.page.blocks) appendBlock(doc, b, acts);
      paintRail();
      reaim();
      break;
    }

    case "page_meta": {
      const p = pages.find((x) => x.id === ev.page);
      if (!p) break;
      p.title = ev.title;
      if (ev.ask) p.ask = ev.ask;
      if (pages[0] === p) titleEl.textContent = ev.title;
      paintRail();
      break;
    }

    case "page_remove":
      flow.remove(ev.page);
      pages = pages.filter((p) => p.id !== ev.page);
      paintRail();
      break;

    case "problem":
      // Not shown as an error: the agent is told about it and usually fixes it
      // on the next command, so surfacing it as a failure would be a lie.
      console.warn("[page problem]", ev.problem);
      break;

    case "turn_saved":
      // The controls did not change on disk, so the watcher will not report
      // them — but what has been answered has. Repaint them by hand.
      answered = ev.answered;
      chosen = ev.chosen ?? {};
      repaintControls();
      // Repainting a control builds a new node, which drops any revision mark
      // that was sitting on it.
      scheduleRevisions();
      break;

    case "turn_end": {
      // A page the agent was cut off in the middle of looks exactly like a
      // finished one. Marking it is what makes the failure recoverable rather
      // than silent — and the mark carries the way to finish it.
      if (ev.stopped !== "done" && ev.stopped !== "aborted") markUnfinished(ev.stopped);
      // What the turn cost, kept where the environment lives. The number was
      // always computed and always thrown away — and it is the one thing you
      // actually want when comparing two models.
      if (ev.usage.costUsd > 0) {
        const spent = $("spent");
        spent.hidden = false;
        spent.textContent = `$${ev.usage.costUsd < 0.01
          ? ev.usage.costUsd.toFixed(4) : ev.usage.costUsd.toFixed(2)}`;
        spent.title = `last turn · ${ev.usage.input + ev.usage.cacheRead} in, ${ev.usage.output} out`;
      }
      const summary = `${ev.pages} page${ev.pages === 1 ? "" : "s"} · ${ev.usage.steps} step${
        ev.usage.steps === 1 ? "" : "s"} · ${Math.round(ev.usage.ms / 100) / 10}s` +
        (ev.usage.cacheRead ? ` · cache ${ev.usage.cacheRead}` : "");
      // A turn that was cut off used to look exactly like one that finished.
      if (ev.stopped === "steps") {
        status(`stopped after ${ev.usage.steps} steps — the page may be unfinished. ${summary}`, "bad");
      } else if (ev.stopped === "time") {
        status(`stopped on the time budget — the page may be unfinished. ${summary}`, "bad");
      } else if (ev.stopped === "context") {
        status(`ran out of room to think — the page may be unfinished. ${summary}`, "bad");
      } else {
        status(summary);
      }
      break;
    }

    case "error":
      // A failed turn used to cost the reader their question: the error looked
      // like every other status line and the only way forward was to type it
      // again. It is kept, and it offers the thing they want.
      lastFailed = lastAsk;
      if (lastFailed) composer.failed(ev.message, () => void composer.send(lastFailed));
      else status(ev.message, "bad");
      break;
  }
}

composer.onStop = () => {
  // The server's abort path has always worked — closing the stream kills the
  // shell's whole process tree. It only ever lacked a button.
  turn?.abort();
  status("stopped", "bad");
};

composer.onOpen = () => { if (sessionId) setAim(currentAnchor()); };
composer.onClose = () => clearAim();
// Dropping the aim is not closing the composer: the reader still wants to ask,
// just about the page rather than one paragraph of it.
composer.onUnaim = () => {
  setAim(aim ? { page: aim.page } : undefined);
  composer.placeholder("Ask about this page, or something new…");
};

// Point at something else. Implicit aim is a guess; a click is a decision,
// and it is how you say "that row", not "that page".
/** As much of a quote as is worth carrying: enough to be exact, not a page. */
const MAX_QUOTE = 400;

/**
 * Which block the reader just indicated, and the words if they highlighted any.
 *
 * THE BUG THIS REPLACES. A `click` fires on the nearest common ancestor of
 * where the mouse went down and where it came up. Press inside a paragraph and
 * release in the 1.15rem gap below it — which is what happens whenever anyone
 * overshoots the end of a sentence they are selecting — and the target is the
 * `.doc` itself. `.doc` is not a child of `.doc`, so `closest('.doc > *')`
 * returned null and the handler gave up in silence: the text was selected, and
 * nothing pointed at anything.
 *
 * So the block is found three ways, in order of what the reader meant:
 *
 *   1. WHERE THE SELECTION STARTED. `anchorNode` is where the drag began, so
 *      an overshoot cannot lose it — and a selection spanning two blocks
 *      anchors to the first while keeping the whole quote.
 *   2. What was clicked, for a plain click with no selection.
 *   3. The nearest block by distance, when the point landed in the gap between
 *      two of them. Somebody clicking in the space under a paragraph means
 *      that paragraph, not nothing.
 */
function pointedAt(e: MouseEvent): { node: HTMLElement; doc: HTMLElement; quote: string } | null {
  const target = e.target as HTMLElement;
  const sel = window.getSelection();
  const selected = sel && !sel.isCollapsed ? sel.toString().trim() : "";

  const from = selected && sel?.anchorNode
    ? (sel.anchorNode.nodeType === 1
        ? sel.anchorNode as HTMLElement
        : sel.anchorNode.parentElement)
    : target;

  let node = from?.closest<HTMLElement>(".doc > *") ?? null;

  if (!node) {
    // In the gap between blocks: the closest one vertically is the one meant.
    const doc = (target.closest<HTMLElement>(".doc")
      ?? from?.closest<HTMLElement>(".doc")) ?? null;
    if (!doc) return null;
    let best: HTMLElement | null = null;
    let gap = Infinity;
    for (const child of doc.children) {
      if (!(child instanceof HTMLElement)) continue;
      const r = child.getBoundingClientRect();
      const d = e.clientY < r.top ? r.top - e.clientY
        : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
      if (d < gap) { gap = d; best = child; }
    }
    node = best;
  }

  const doc = node?.parentElement ?? null;
  if (!node || !doc) return null;

  // Trim the quote to the block it belongs to. Overshooting the end of a
  // sentence is now harmless rather than fatal, which means it will happen all
  // the time — and a quote that runs on into the next block's chart labels is
  // noise arriving as if it were the reader's aim.
  let quote = selected;
  if (quote && sel?.rangeCount) {
    try {
      const r = sel.getRangeAt(0).cloneRange();
      if (!node.contains(r.startContainer)) r.setStartBefore(node);
      if (!node.contains(r.endContainer)) r.setEndAfter(node);
      quote = r.toString().trim();
    } catch { /* a range we cannot clamp is better sent whole than dropped */ }
  }
  return { node, doc, quote: quote.slice(0, MAX_QUOTE) };
}

// `mouseup` rather than `click`: a click's target is a compromise between two
// points, and the selection is only settled once the button comes up.
flowHost.addEventListener("mouseup", (e) => {
  if (composer.busy || !sessionId) return;
  const target = e.target as HTMLElement;
  if (target.closest("button")) return;             // links and figures keep their own clicks
  const found = pointedAt(e);
  if (!found) return;
  const { node, doc, quote } = found;
  const id = doc.closest<HTMLElement>(".panel")?.dataset.page;
  if (!id) return;
  // Open FIRST: opening recomputes the implicit aim, and it would otherwise
  // land on top of the one the reader just chose.
  composer.open();
  const index = [...doc.children].indexOf(node);
  // Clicking the block you are already pointing at stops pointing at it — the
  // gesture undoes itself, which is the one people try first. Only if the
  // reader CHOSE it, though: `composer.open()` above has just guessed at the
  // block nearest the middle of the view, and undoing a guess nobody made is
  // how the middle of the screen became unclickable. Selecting words inside it
  // is not the undo gesture either: it is a narrower aim.
  if (!quote && aimChosen && aim?.page === id && aim.index === index) {
    composer.onUnaim(); return;
  }
  // The name, when the block has one, is what keeps this pointing at the thing
  // the reader chose even if the agent rearranges the page while they type.
  const blockId = node.dataset.blockId;
  setAim({
    page: id, index,
    ...(blockId ? { id: blockId } : {}),
    ...(quote ? { quote } : {}),
  }, true);
});

composer.onType = (text) => { if (!sessionId) { filter = text; paintLibrary(); } };

/** The last question asked, so a failed turn can offer to run it again. */
let lastAsk = "";
let lastFailed = "";

composer.onSubmit = async (q) => {
  if (composer.busy) return;
  lastAsk = q;
  lastFailed = "";

  // Asked from the library: the session comes into existence because of the
  // question, and we move to it at once so the reader watches it assemble.
  const fromLibrary = !sessionId;
  // Consumed here and nowhere else: a click sets it immediately before
  // sending, so anything typed arrives with it already empty.
  const selection = pendingSelection;
  pendingSelection = undefined;
  // A click already says where it came from; an implicit anchor on top of it
  // would be a second, weaker answer to the same question.
  const anchor = fromLibrary || selection ? undefined : (aim ?? currentAnchor());
  clearAim();
  think = "";
  composer.working(q);
  // The activity line already says "Thinking"; the status line is for what the
  // model is actually saying while it does, which arrives as text deltas.
  status("");
  turn = new AbortController();

  try {
    const id = fromLibrary ? await startSession() : sessionId!;
    attempted = true;               // this session has been used; it stays
    for await (const ev of runTurn(id, q, anchor, selection, turn.signal)) handle(ev);
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      status(err instanceof Error ? err.message : String(err), "bad");
    }
  } finally {
    turn = null;
    composer.done();
    placeComposer();
  }
};

/* ------------------------------------------------------------------- boot */

// The settings button sits in a strip that expands on hover, so the rail is
// pinned open while the panel is up — otherwise its anchor slides away.
mountSettings(
  $("prefsbtn"), $("prefs"),
  (open) => railHost.classList.toggle("open", open),
  // Text size and measure change how tall the site is, which changes whether
  // the reader is at the end of it.
  () => placeComposer(),
);

// A resize changes the frame the page has to fit inside.
let resizing: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => placeComposer(), 150) as unknown as number;
});

// A closed tab sends nothing, so `keepalive` is what makes this land. The
// server's sweep is the backstop for the cases where even that fails.
window.addEventListener("pagehide", () => void retireIfUnused(sessionId, { unloading: true }));

// One way home. "New" was a second button for the same action once the
// library became the place you ask from.
$("back").addEventListener("click", () => void showLibrary());

// The rail opens because it was asked to. Hover-to-open meant a panel covering
// a quarter of the page every time the pointer crossed the left edge.
$("railtoggle").addEventListener("click", () => {
  const open = railHost.classList.toggle("open");
  $("railtoggle").setAttribute("aria-expanded", String(open));
});

// Keyboard help. The shortcuts existed and nothing said so.
const keys = $("keys");
const showKeys = (on: boolean) => { keys.hidden = !on; };
$("keysclose").addEventListener("click", () => showKeys(false));
window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLElement
    && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
  if (e.key === "?" && !typing) { e.preventDefault(); showKeys(keys.hidden); }
  if (e.key === "Escape" && !keys.hidden) showKeys(false);
});

const health = await (await fetch("/health")).json() as
  { hasKey: boolean; model: string; provider: string; sandbox: string; replay: boolean };
$("badge").textContent = health.replay ? "replay" : health.provider ?? "model";
// The model is a fact about the session and it changes often while building,
// so it is shown rather than hidden in .env. Switching it still needs a
// restart — the runtime is built once per process — which is the server-side
// half of this and a separate piece of work.
// The last segment only: `accounts/fireworks/models/deepseek-v4-flash-0731`
// is a path, and the chip is 46px of rail. The full id is in the tooltip.
$("model").textContent = health.replay ? "scripted" : health.model.split("/").pop() ?? health.model;
$("model").title = `${health.model} — set by PERPETUAL_MODEL; changing it needs a restart`;
$("sandbox").textContent = health.sandbox;
// Replay stamps the whole rail, not a chip. A subtle badge already cost a
// whole evaluation once — a full-height edge cannot be read past.
railHost.classList.toggle("replay", health.replay);
$("modedot").title = health.replay ? "replay — no model" : `${health.model} · ${health.sandbox}`;
if (!health.hasKey) status("No API key set — export one and restart the controller", "bad");

const hash = /^#\/s\/([a-f0-9]+)$/.exec(location.hash);
if (hash) await openSession(hash[1]!);
else await showLibrary();
