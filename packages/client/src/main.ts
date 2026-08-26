/**
 * The chrome, and the wiring behind it.
 *
 * Two zones, and the boundary between them is the architecture:
 *
 *   FIXED CHROME — the library, the header, the rail, the composer. Hand-built,
 *   identical in every session, never generated. The agent does not know it
 *   exists.
 *
 *   THE CANVAS — the deck of pages in the middle. Rendered from files in the
 *   session directory and from nothing else.
 *
 * Every `page_*` event below came from the controller watching a directory, so
 * this file never has to decide whether to believe the agent. It renders what
 * was written.
 */
import { appendBlock, renderBlock, type BlockActions } from "./render.ts";
import { runTurn, type WireEvent } from "./stream.ts";
import { Deck } from "./deck.ts";
import { Rail } from "./rail.ts";
import { Composer } from "./composer.ts";
import { mountSettings, load as loadSettings } from "./settings.ts";
import { fitAll, measureDeck } from "./fit.ts";
import { describeCommand, activityLine } from "./activity.ts";
import { choiceKey, doorKey } from "@perpetual/shared/site";
import type { Anchor, Page, Selection, Site, SessionIndex } from "@perpetual/shared/site";
import type { RenderReport } from "@perpetual/shared/render";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const libraryView = $("library");
const sessionView = $("session");
const grid = $("grid");
const deckHost = $("deck");
const railHost = $("rail");
const titleEl = $("stitle");

const deck = new Deck(deckHost);
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
    link: (id) => deck.gotoId(id),
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

/** Build one panel. `.sheet` is the scroller; the deck moves `.panel`. */
function makePanel(page: Page) {
  const root = document.createElement("section");
  root.className = "panel";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const doc = document.createElement("article");
  // The layout modes are the whole of "layout freedom" (plans/16 §7): four
  // compositions we style, rather than a stylesheet the agent writes.
  doc.className = `doc lay-${page.layout ?? "column"}`;
  sheet.append(doc);
  root.append(sheet);
  const acts = actionsFor(page.id);
  for (const b of page.blocks) appendBlock(doc, b, acts);
  sheet.addEventListener("scroll", () => { if (page.id === deck.activeId) placeComposer(); },
    { passive: true });
  return { root, sheet, doc };
}

function addPage(page: Page, opts: { goto?: boolean } = {}) {
  const { root, sheet, doc } = makePanel(page);
  root.dataset.page = page.id;
  doc.dataset.blocks = String(page.blocks.length);
  deck.add({ id: page.id, root, scroller: sheet });
  pages.push(page);
  paintRail();
  if (opts.goto) deck.goto(deck.count - 1);
}

function docFor(id: string): HTMLElement | null {
  return deckHost.querySelector<HTMLElement>(`.panel[data-page="${id}"] .doc`);
}

/**
 * Decide one column, two, or scrolling — once the page has settled.
 *
 * Never mid-stream: a page that fits in one column at block 4 needs two by
 * block 9, and re-deciding on every arriving block would make it jump about
 * while the reader is watching it assemble. During a turn it stays single and
 * scrolls, which is exactly what it did before.
 */
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
 * Tell the agent what its page turned out to look like.
 *
 * The one signal that never existed. The agent writes blocks and finds out
 * whether they PARSE; it has never found out whether they fit. This measures
 * the deck as it currently stands and posts it to the running turn, where the
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
  const { width, pages: measured } = measureDeck(deckHost, loadSettings().columns !== "off");
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

function refit() {
  const tally = fitAll(deckHost, loadSettings().columns !== "off");
  deckHost.dataset.fit = JSON.stringify(tally);
}

function paintRail() {
  rail.set(pages.map((p) => ({ id: p.id, ask: p.ask ?? "", title: p.title })));
  rail.setActive(deck.index);
  composer.position(pages.length ? `${deck.index + 1} / ${pages.length}` : "");
}

deck.onChange = (i, id) => {
  rail.setActive(i);
  composer.position(pages.length ? `${i + 1} / ${pages.length}` : "");
  // Moving to another page drops the aim. A block the reader has scrolled past
  // is a reminder they can go back to; one on a page they have LEFT is a claim
  // about something they are no longer looking at.
  if (aim && aim.page !== id && !composer.busy) setAim({ page: id });
  placeComposer();
};

/**
 * Is the reader out of website?
 *
 * The composer used to inflate at the bottom of EVERY page, and that was the
 * wrong moment: the bottom of page 3 of 6 does not mean "you are finished, ask
 * something" — it means "keep going, there is more", and the gesture that
 * belongs there is the force-scroll to page 4. Interrupting it with a full
 * input box argues against the one movement the product is built around.
 *
 * The bottom of the LAST page is different. There is nothing left to scroll
 * to, so asking is honestly the next step.
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
  const id = deck.activeId;
  const sheet = id ? deckHost.querySelector<HTMLElement>(`.panel[data-page="${id}"] .sheet`) : null;
  const lastPage = deck.count === 0 || deck.index === deck.count - 1;
  // Read from scroll position and page index only — never from the composer's
  // own height, which changes as a result of this decision and would oscillate.
  const atBottom = !sheet || sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 24;
  atSiteEnd = lastPage && atBottom;

  deckHost.classList.toggle("atend", atSiteEnd);
  composer.compact(!atSiteEnd && !aim);
  if (!aim) {
    composer.placeholder(atSiteEnd
      ? "Ask a follow-up, or something new…"
      : "Ask about this page, or something new…");
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

function clearAim() {
  for (const n of deckHost.querySelectorAll(".anchored")) n.classList.remove("anchored");
  aimWatch?.disconnect();
  aimWatch = undefined;
  aim = undefined;
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

  if (aim.id) {
    const now = page.blocks.findIndex((b) => b.id === aim!.id);
    if (now === -1) { setAim({ page: aim.page }); return; }
    if (now !== aim.index) setAim({ ...aim, index: now });
    else setAim(aim);                               // repaint: the node may be new
    return;
  }
  // Unnamed: the index may still be right, but nothing can prove it. Keep it
  // only while it points at a block of the same kind — otherwise let it go.
  const still = page.blocks[aim.index];
  setAim(still ? aim : { page: aim.page });
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
 * if they leave the page it lives on.
 */
let aimWatch: IntersectionObserver | undefined;

function watchAim(node: Element) {
  aimWatch?.disconnect();
  aimWatch = new IntersectionObserver(
    ([entry]) => { if (entry) paintAim(!entry.isIntersecting); },
    // A block half in view is still in view: the reader can see it and check it.
    { root: node.closest(".sheet"), threshold: 0.15 },
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
  const what = AIM_LABEL[block.kind] ?? "this";
  composer.aim(offScreen ? `about ${what}, further up ↑` : `about ${what}`, { faded: offScreen });
  composer.placeholder("Change this, or ask about it…");
}

function setAim(a: Anchor | undefined) {
  for (const n of deckHost.querySelectorAll(".anchored")) n.classList.remove("anchored");
  aimWatch?.disconnect();
  aimWatch = undefined;
  aim = a;
  const node = a?.index != null ? docFor(a.page)?.children[a.index] : undefined;
  if (node) { node.classList.add("anchored"); watchAim(node); }
  paintAim();
}

/**
 * What the reader is looking at: the block nearest the middle of the view.
 * This is the referent that makes "that number is wrong" mean something.
 *
 * At the END of a page there is no single block being looked at — the whole
 * page is — so a docked composer anchors to the page and nothing narrower.
 */
function currentAnchor(): Anchor | undefined {
  const id = deck.activeId;
  if (!id) return undefined;
  const doc = docFor(id);
  // At the end of the site there is no single block being looked at — the
  // whole page is — so the question anchors to the page and nothing narrower.
  if (!doc || atSiteEnd) return { page: id };
  const mid = deckHost.getBoundingClientRect().top + deckHost.clientHeight / 2;
  let best = -1, bestGap = Infinity;
  for (const [i, node] of [...doc.children].entries()) {
    const r = node.getBoundingClientRect();
    const gap = Math.abs((r.top + r.bottom) / 2 - mid);
    if (gap < bestGap) { bestGap = gap; best = i; }
  }
  if (best === -1) return { page: id };
  const block = pages.find((p) => p.id === id)?.blocks[best];
  return { page: id, index: best, ...(block?.id ? { id: block.id } : {}) };
}
rail.onPick = (id) => deck.gotoId(id);

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
    + "writes the next page. One session is one small website.";
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
 * Put a mark at the end of a page that was cut off, with the one action worth
 * offering. Nothing else in the product says a page is incomplete — it simply
 * stops, and stopping looks the same as finishing.
 */
function markUnfinished(cause: string) {
  const id = deck.activeId;
  const doc = id ? docFor(id) : null;
  if (!doc || doc.querySelector(".cutshort")) return;

  const box = document.createElement("div");
  box.className = "note warn cutshort";
  box.textContent = `This page stopped early — the agent ${
    CUT_SHORT[cause] ?? "was interrupted"}. `;
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pagelink";
  go.textContent = "Finish it";
  go.addEventListener("click", () => void composer.send("Finish this page — it was cut short."));
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

  deck.clear();
  pages = [];

  const [index, site] = await Promise.all([
    fetch(`/sessions/${id}`).then((r) => r.json()) as Promise<SessionIndex>,
    fetch(`/sessions/${id}/site`).then((r) => r.json()) as Promise<Site>,
  ]);
  titleEl.textContent = index.title;
  answered = index.answered ?? {};
  chosen = index.chosen ?? {};
  for (const p of site.pages) addPage(p);

  // Always open on the last page — a session is resumed at its newest answer,
  // and the reader scrolls back for the rest.
  if (pages.length) deck.goto(pages.length - 1, { animate: false });
  paintRail();
  refit();
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

/* ------------------------------------------------------------------- turn */

function handle(ev: WireEvent) {
  // Anything that changes what a page looks like is worth re-measuring — the
  // agent is told about the page as it stands, not as it was when it opened.
  if (ev.type.startsWith("page_")) scheduleReport();

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
      appendBlock(doc, ev.block, actionsFor(ev.page));
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
    // None of them refit. Fitting is settled once the turn is, exactly as it
    // is for an append or a whole-page replace — a page that reflowed into two
    // columns halfway through being amended would be worse than one that waits.
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
      // Rebuilt in place, so the panel keeps its identity and the reader keeps
      // their position in the deck.
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
      deck.remove(ev.page);
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
      refit();
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
deckHost.addEventListener("click", (e) => {
  if (composer.busy || !sessionId) return;
  const target = e.target as HTMLElement;
  if (target.closest("button")) return;             // links and figures keep their own clicks
  const node = target.closest<HTMLElement>(".doc > *");
  const doc = node?.parentElement;
  const id = doc?.closest<HTMLElement>(".panel")?.dataset.page;
  if (!node || !doc || !id) return;
  // Open FIRST: opening recomputes the implicit aim, and it would otherwise
  // land on top of the one the reader just chose.
  composer.open();
  const index = [...doc.children].indexOf(node);
  // Clicking the block you are already pointing at stops pointing at it — the
  // gesture undoes itself, which is the one people try first.
  if (aim?.page === id && aim.index === index) { composer.onUnaim(); return; }
  // The name, when the block has one, is what keeps this pointing at the thing
  // the reader chose even if the agent rearranges the page while they type.
  const blockId = node.dataset.blockId;
  setAim({ page: id, index, ...(blockId ? { id: blockId } : {}) });
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
  // Text size, measure and the columns dial all change what fits.
  () => { refit(); placeComposer(); },
);

// A resize changes the frame the page has to fit inside.
let resizing: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => { refit(); placeComposer(); }, 150) as unknown as number;
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
