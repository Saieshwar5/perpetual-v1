/**
 * The chrome, and the wiring behind it.
 *
 * Two zones, and the boundary between them is the architecture:
 *
 *   FIXED CHROME — the sidebar and the composer. Hand-built, identical in every
 *   session, never generated. The agent does not know it exists.
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
 * are PRESENTED: stacked into one scroll instead of dealt out as a deck, with
 * the question that produced each one standing above it.
 */
import { appendBlock, renderBlock, type BlockActions } from "./render.ts";
import { runTurn, type WireEvent } from "./stream.ts";
import { Flow } from "./flow.ts";
import { Sidebar } from "./side.ts";
import { AppCards } from "./apps.ts";
import { Composer } from "./composer.ts";
import { mountSettings, load as loadSettings } from "./settings.ts";
import { measureFlow } from "./measure.ts";
import { describeCommand } from "./activity.ts";
import { choiceKey, doorKey } from "@perpetual/shared/site";
import type { Anchor, AppView, Page, Selection, Site, SessionIndex }
  from "@perpetual/shared/site";
import type { RenderReport } from "@perpetual/shared/render";
import type { Block } from "@perpetual/shared/blocks";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const appEl = $("app");
// `.site`, not `.flow`: the `flow` BLOCK (a sequence of steps) already owns
// that class inside a page, and one of the two would have eaten the other.
const flowHost = $("site");
const sideHost = $("side");

const flow = new Flow(flowHost);
const side = new Sidebar(sideHost, $("sessions"), $<HTMLInputElement>("sidesearch"));
// Workspaces render as live cards in the flow, inside the current turn —
// the same host the run notice settles into, asked at creation time.
const panel = new AppCards(() => noticeHost() ?? flowHost, () => sessionId ?? "");
const floatHost = $("floathost");
const composer = new Composer($("pill"), floatHost);

let sessionId: string | null = null;
let pages: Page[] = [];
let think = "";
/** The running step's output tail, attached to its row only if it fails. */
let lastOutput = "";
let turn: AbortController | null = null;
/** Did the reader ask anything in this session while it was open? */
let attempted = false;
/** Every session, as loaded. The sidebar filters this rather than refetching. */
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

    // A picture lives beside the page that shows it; the controller serves it
    // by name out of that directory.
    asset: (src) =>
      `/sessions/${sessionId}/asset?page=${encodeURIComponent(page)}&file=${
        encodeURIComponent(src)}`,
    granted: (path) => grants.includes(path),
    allow: (path) => void allowDirectory(path),

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

/**
 * The question that produced a section, standing above it.
 *
 * The reader's asks used to live in the rail, listed down the side of the work
 * they produced. That was a table of contents pretending to be a conversation:
 * you could see the questions, but never beside the answers they got.
 *
 * They belong in the scroll. Each one is the record of what was asked, and it
 * is also what gives the site its rhythm — ask, answer, ask, answer — which is
 * why the hairline that used to separate sections is gone: the question is the
 * separator now, and two separators would be one too many.
 *
 * OUTSIDE `.doc`, deliberately. Everything inside a `.doc` is a block the agent
 * wrote and the reader can point at; this is the reader's own sentence, and
 * pointing at it would mean asking the agent about a question they just asked.
 */
function askBubble(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ask";
  const said = document.createElement("p");
  said.textContent = text;
  el.append(said);
  return el;
}

/**
 * One turn: what was asked, and what got written because of it.
 *
 * The section keeps its own element and its own `data-page`, so everything
 * that addresses a block — `docFor`, the anchor, the keyed ops, the render
 * report — works exactly as it did. The wrapper only puts a question above it.
 */
function makeTurn(page: Page, ask: string | null): { turn: HTMLElement; root: HTMLElement } {
  const turn = document.createElement("section");
  turn.className = "turn";
  if (ask) turn.append(askBubble(ask));
  const { root } = makePanel(page);
  root.dataset.page = page.id;
  turn.append(root);
  return { turn, root };
}

/**
 * The question the reader just asked, on screen before there is an answer.
 *
 * The alternative is a second of nothing: they press enter and the site is
 * exactly as it was until the agent's first block lands. Held here so the
 * section can be dropped into it when the turn opens one.
 */
let pendingTurn: HTMLElement | null = null;

function openPendingTurn(ask: string) {
  closePendingTurn();
  const turn = document.createElement("section");
  turn.className = "turn pending";
  turn.append(askBubble(ask));
  flowHost.append(turn);
  pendingTurn = turn;
  // To the TOP, not to the foot. The question the reader just sent belongs at
  // the top of the view with the answer filling in below it — sent to the foot
  // it lands against the composer and the page then creeps upward as blocks
  // arrive. plans/41.
  flow.toTopOf(turn);
}

/** Nothing came of it, or something did — either way it stops being pending. */
function closePendingTurn(keep = false) {
  if (!pendingTurn) return;
  if (!keep) pendingTurn.remove();
  else pendingTurn.classList.remove("pending");
  pendingTurn = null;
}

function addPage(page: Page, opts: { goto?: boolean } = {}) {
  // One question, one answer: a second section written in the same turn hangs
  // under the same question rather than repeating it.
  const ask = page.ask && page.ask !== pages.at(-1)?.ask ? page.ask : null;

  let turn: HTMLElement;
  let root: HTMLElement;
  if (pendingTurn) {
    // The reader's question is already on screen. The section lands underneath
    // the one they asked, not under a second copy of it.
    turn = pendingTurn;
    ({ root } = makePanel(page));
    root.dataset.page = page.id;
    turn.append(root);
    closePendingTurn(true);
  } else {
    ({ turn, root } = makeTurn(page, ask));
  }

  root.querySelector<HTMLElement>(".doc")!.dataset.blocks = String(page.blocks.length);
  flow.add({ id: page.id, root: turn });
  pages.push(page);
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
      if (b.kind !== "next" && b.kind !== "choice" && b.kind !== "grant") continue;
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

flow.onChange = (i, id) => {
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
 * A row that carries its own command. No model, no turn, no cost — the
 * controller runs it in the same sandbox and hands back what the view became.
 */
async function runRow(
  app: string, block: string, option: string,
  values?: Record<string, string | boolean>,
) {
  if (!sessionId || composer.busy) return;
  panel.working(true);
  panel.note(app, "");
  try {
    const r = await fetch(`/sessions/${sessionId}/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app, block, option, ...(values ? { values } : {}) }),
    });
    const out = await r.json() as {
      ran?: boolean; exitCode?: number; output?: string;
      app?: AppView | null; error?: string;
    };
    if (out.error) { panel.note(app, out.error, true); return; }
    if (out.app) panel.set(out.app);
    // Nothing ran, which is not a failure: a row or a form without a command is
    // a question for the agent, and asking it is what the reader meant.
    if (out.ran === false) { panel.askInstead(); return; }
    // A command that failed says so, with the tail that explains it. Silence
    // would look exactly like a row that does nothing.
    if (out.ran && out.exitCode !== 0) {
      panel.note(app, out.output?.trim() || `that did not work (exit ${out.exitCode})`, true);
    }
  } catch (e) {
    panel.note(app, e instanceof Error ? e.message : String(e), true);
  } finally {
    panel.working(false);
  }
}

panel.onRun = (app, block, option, values) => void runRow(app, block, option, values);

// Declining a confirmation is a real answer: nothing runs, nobody is asked,
// and saying so is better than a button that appears to do nothing.
panel.onCancel = (app) => panel.note(app, "Left as it was.");

panel.onAsk = (selection) => {
  pendingSelection = selection;
  void composer.send(`${selection.prompt ? `${selection.prompt} — ` : ""}${selection.label}`);
};


/* ------------------------------------------------------- what this session can do
 *
 * Two chips on the composer: where the agent may write, and which model is
 * answering. Both are CHROME — the agent renders none of it and cannot reach
 * the endpoints behind it. That is the point rather than an implementation
 * detail: a working directory the agent could set would be a suggestion, and
 * an agent that can widen its own write access has not been contained.
 */
const workdirBtn = $<HTMLButtonElement>("workdirbtn");
const modelBtn = $<HTMLButtonElement>("modelbtn");
const picker = $("picker");
const modelMenu = $("modelmenu");

let workdir: string | null = null;
/**
 * Directories the reader has ALLOWED this session, on top of `workdir`.
 * plans/45. Set only by the controller's answer — never from a block.
 */
let grants: string[] = [];
/**
 * Where this session's workspace has MOVED, and how far in it moved. plans/47.
 *
 * The picker used to lock the moment a session wrote a page. What it was
 * protecting is real — two sections about two different `x.ts` look identical
 * — but the answer is to say where the work moved, not to forbid moving.
 */
let moves: SessionIndex["moves"] = [];
let model: string | null = null;
let models: string[] = [];
/** What the server answers with when a session has not picked. */
let defaultModel: string | null = null;
/** Where the picker is browsing, which is not yet where the session writes. */
let browsing: string | null = null;

const short = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

function paintBar() {
  // "Nowhere to write" was never true and is now plainly false: a session
  // without a chosen directory writes in its OWN, which is a place, and the
  // chip should name it rather than describe an absence. plans/45.
  const extra = grants.length ? ` +${grants.length}` : "";
  workdirBtn.querySelector(".barlabel")!.textContent =
    (workdir ? short(workdir).split("/").pop() || short(workdir) : "This session") + extra;
  const allowed = grants.length
    ? `\nAlso allowed: ${grants.map(short).join(", ")}.`
    : "";
  workdirBtn.title = (!workdir
    ? "Working in this session's own workspace. It can read your files, and it "
      + "will ask before writing anywhere else. Click to point it at a project."
    : `Working in ${workdir} — click to change`) + allowed;
  workdirBtn.classList.toggle("on", Boolean(workdir) || grants.length > 0);
  modelBtn.querySelector(".barlabel")!.textContent =
    (model ?? "").split(":").pop()?.split("/").pop()?.replace(/^claude-/, "") || "model";
  modelBtn.title = model ? `Answering with ${model}` : "Choose a model";
}

/** Both popovers are mutually exclusive; opening one closes the other. */
function closeMenus() {
  picker.hidden = true;
  modelMenu.hidden = true;
  workdirBtn.setAttribute("aria-expanded", "false");
  modelBtn.setAttribute("aria-expanded", "false");
}

/**
 * Chosen before the session exists. plans/42.
 *
 * A session is created by the first QUESTION, so on a new one there is no id
 * to POST settings to — and `saveSettings` used to return silently, so the
 * picker opened, browsed, accepted a click on "Work here" and did nothing at
 * all. No error, no change, no way to tell.
 *
 * The choice is held here instead and applied the moment the session comes
 * into existence, which keeps "a session exists because you asked something"
 * true rather than littering the list with empty ones.
 */
let pendingSettings: { workdir?: string | null; model?: string | null } = {};

async function saveSettings(patch: { workdir?: string | null; model?: string | null }) {
  if (!sessionId) {
    pendingSettings = { ...pendingSettings, ...patch };
    // Shown as chosen straight away: the reader picked it, and it WILL be the
    // session's workspace. Nothing else can intervene between here and the
    // first turn.
    if (patch.workdir !== undefined) workdir = patch.workdir;
    if (patch.model !== undefined) model = patch.model ?? defaultModel;
    paintBar();
    return;
  }
  const r = await fetch(`/sessions/${sessionId}/settings`, {
    method: "POST", body: JSON.stringify(patch),
  });
  const out = await r.json() as SessionIndex & { error?: string };
  if (out.error) { status(out.error, "bad"); return; }
  workdir = out.workdir ?? null;
  model = out.model ?? defaultModel;
  // A move the reader just made is drawn where they are looking, not on the
  // next reload — the pages above it were written somewhere else, and that
  // stops being true the moment they pick.
  const fresh = (out.moves ?? []).slice((moves ?? []).length);
  moves = out.moves ?? [];
  for (const mv of fresh) flowHost.append(moveLine(mv));
  paintBar();
}

/**
 * The reader allows a directory the agent asked for. plans/45.
 *
 * Straight to the controller, exactly like the workspace picker: the agent
 * wrote the request and has no part in the answer. Then the turn — because a
 * grant is only ever asked for in order to get on with something, and making
 * the reader type "ok now do it" after they have already said yes is asking
 * twice.
 */
async function allowDirectory(path: string) {
  if (!sessionId || composer.busy) return;
  const r = await fetch(`/sessions/${sessionId}/grant`, {
    method: "POST", body: JSON.stringify({ path }),
  });
  const out = await r.json() as { grants?: string[]; error?: string };
  if (out.error) { status(out.error, "bad"); return; }
  grants = out.grants ?? grants;
  paintBar();
  repaintControls();
  void composer.send(`I've allowed you to write in ${path}. Go ahead.`);
}

/**
 * The line the flow draws where the work moved. plans/47.
 *
 * This is what replaced the lock. A section is a record of work done in a
 * place, and the danger was never that the place changes — it is that it
 * changes SILENTLY, leaving two sections about two different `x.ts` looking
 * identical. Said out loud, in the scroll, at the point it happened, the
 * record is true again and the reader keeps their freedom to move.
 */
function moveLine(mv: NonNullable<SessionIndex["moves"]>[number]): HTMLElement {
  const el = document.createElement("div");
  el.className = "moveline";
  const text = document.createElement("span");
  text.textContent = mv.revoked
    ? `Write access to ${short(mv.revoked)} withdrawn from here`
    : mv.to
      ? `Working in ${short(mv.to)} from here`
      : "Working in this session's own workspace from here";
  el.append(text);
  if (mv.from) el.title = `Was ${short(mv.from)}`;
  return el;
}

/* ------------------------------------------------------- background jobs */

/**
 * The jobs bar. plans/50. A background job is a process running on the
 * reader's machine after the turn that started it has ended — invisible, it
 * is exactly the thing this product promises never to have. So while any
 * run, they sit above the composer: command, elapsed time, a pin, and a ✕.
 *
 * The pin is the reader's alone. Unpinned jobs die at their time limit — the
 * safe default; pinning one says "until I stop it", and only this chrome can
 * say that. The agent's own stop channel is a file in the workspace; these
 * controls never pass through it.
 */
const jobsBar = $("jobsbar");
let jobsTimer: number | undefined;

function watchJobs() {
  clearInterval(jobsTimer);
  jobsTimer = setInterval(() => void paintJobs(), 3000) as unknown as number;
  void paintJobs();
}

async function paintJobs() {
  if (!sessionId) { jobsBar.hidden = true; return; }
  const r = await fetch(`/sessions/${sessionId}/jobs`).catch(() => null);
  if (!r?.ok) { jobsBar.hidden = true; return; }
  const { jobs } = await r.json() as { jobs: {
    id: string; command: string; startedAt: number; pinned: boolean; done: boolean;
  }[] };
  const running = jobs.filter((j) => !j.done);
  jobsBar.hidden = !running.length;
  if (!running.length) return;

  jobsBar.replaceChildren(...running.map((j) => {
    const row = document.createElement("div");
    row.className = "jobrow";
    const cmd = document.createElement("span");
    cmd.className = "jobcmd";
    cmd.textContent = j.command.split("\n")[0]!.slice(0, 60);
    cmd.title = j.command;
    const age = document.createElement("span");
    age.className = "jobage";
    const mins = Math.floor((Date.now() - j.startedAt) / 60_000);
    age.textContent = mins < 1 ? "just started" : `${mins}m`;

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "jobpin" + (j.pinned ? " on" : "");
    pin.textContent = j.pinned ? "pinned" : "pin";
    pin.title = j.pinned
      ? "Running until you stop it — click to put the time limit back"
      : "Keep running until you stop it, ignoring the time limit";
    pin.addEventListener("click", () => void jobAction(j.id, j.pinned ? "unpin" : "pin"));

    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "jobstop";
    stop.textContent = "✕";
    stop.title = "Stop this job";
    stop.setAttribute("aria-label", `Stop: ${cmd.textContent}`);
    stop.addEventListener("click", () => void jobAction(j.id, "stop"));

    row.append(cmd, age, pin, stop);
    return row;
  }));
}

async function jobAction(job: string, action: "stop" | "pin" | "unpin") {
  if (!sessionId) return;
  const r = await fetch(`/sessions/${sessionId}/jobs`, {
    method: "POST", body: JSON.stringify({ job, action }),
  });
  const out = await r.json() as { error?: string };
  if (out.error) status(out.error, "bad");
  void paintJobs();
}

/** Apply what was chosen before the session existed. Called once, after it does. */
async function flushPendingSettings() {
  const patch = pendingSettings;
  pendingSettings = {};
  if (!sessionId || (patch.workdir === undefined && patch.model === undefined)) return;
  await saveSettings(patch);
}

/**
 * Where this session writes, at the top of the picker — one concept, one
 * place. plans/49. The chip says "+1"; this is where you see what the +1 is
 * and take it back. Revoking is one click, no dialog: it narrows the agent,
 * costs nothing that cannot be re-granted with a tap on the page, and the
 * flow records where the access ended.
 */
function paintWrites() {
  const box = picker.querySelector(".pickwrites")!;
  box.replaceChildren();

  const home = document.createElement("div");
  home.className = "wline";
  const homeLabel = document.createElement("span");
  homeLabel.className = "wpath";
  homeLabel.textContent = workdir ? short(workdir) : "This session's own workspace";
  home.append(homeLabel);
  box.append(home);

  for (const g of grants) {
    const line = document.createElement("div");
    line.className = "wline";
    const label = document.createElement("span");
    label.className = "wpath";
    label.textContent = short(g);
    const off = document.createElement("button");
    off.type = "button";
    off.className = "woff";
    off.textContent = "✕";
    off.title = `Withdraw write access to ${short(g)} — the agent can ask again`;
    off.setAttribute("aria-label", off.title);
    off.addEventListener("click", () => void revokeGrant(g));
    line.append(label, off);
    box.append(line);
  }
}

async function revokeGrant(path: string) {
  if (!sessionId || composer.busy) return;
  const r = await fetch(`/sessions/${sessionId}/grant`, {
    method: "POST", body: JSON.stringify({ path, revoke: true }),
  });
  const out = await r.json() as { grants?: string[]; moves?: SessionIndex["moves"]; error?: string };
  if (out.error) { status(out.error, "bad"); return; }
  grants = out.grants ?? [];
  // Drawn where it happened, like a move — and the grant block on the page
  // reverts to an answerable request, so taking access back never strands
  // the work: one tap re-asks, one tap re-allows.
  const fresh = (out.moves ?? []).slice((moves ?? []).length);
  moves = out.moves ?? moves;
  for (const mv of fresh) flowHost.append(moveLine(mv));
  paintBar();
  repaintControls();
  paintWrites();
}

async function browse(path?: string) {
  const r = await fetch(`/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  const out = await r.json() as
    { path: string; parent: string | null; dirs: string[]; error?: string };
  if (out.error) { status(out.error, "bad"); return; }
  browsing = out.path;
  picker.querySelector(".pickpath")!.textContent = short(out.path);
  (picker.querySelector(".pickup") as HTMLButtonElement).disabled = !out.parent;

  const list = picker.querySelector(".picklist")!;
  list.replaceChildren();
  if (!out.dirs.length) {
    const empty = document.createElement("div");
    empty.className = "pickempty";
    empty.textContent = "No folders in here.";
    list.append(empty);
  }
  for (const name of out.dirs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pickrow";
    row.textContent = name;
    row.addEventListener("click", () => void browse(`${out.path}/${name}`));
    list.append(row);
  }
}

workdirBtn.addEventListener("click", () => {
  const wasOpen = !picker.hidden;
  closeMenus();
  if (wasOpen) return;
  // No session yet is FINE. Choosing where to work before asking is the
  // normal order — you decide what you are working on, then you ask about it.
  // This used to refuse outright ("Ask something first"), which made the one
  // moment the choice matters most the one moment it was impossible. The
  // choice is held and applied when the session is created. plans/42.
  picker.hidden = false;
  workdirBtn.setAttribute("aria-expanded", "true");
  paintWrites();
  void browse(workdir ?? undefined);
});

picker.querySelector(".pickup")!.addEventListener("click", () => {
  if (browsing) void browse(browsing.split("/").slice(0, -1).join("/") || "/");
});
picker.querySelector(".pickuse")!.addEventListener("click", () => {
  if (browsing) void saveSettings({ workdir: browsing });
  closeMenus();
});
picker.querySelector(".pickclear")!.addEventListener("click", () => {
  void saveSettings({ workdir: null });
  closeMenus();
});

/**
 * The model menu, grown up. plans/48.
 *
 * It was a flat list of the boot provider's three ids. It is now every
 * provider the controller knows: the keyed ones expand into their models,
 * the keyless ones show a password field, and pasting a key is the whole
 * setup — no .env, no restart. A model from another provider travels as
 * `provider:model`, and the session records it like any other.
 */
interface ProviderInfo {
  id: string; title: string; keyEnv: string; hasKey: boolean;
  source: "env" | "stored" | null; models: string[]; prefix?: string;
}

function pickModel(id: string) {
  if (!sessionId) { model = id; paintBar(); closeMenus(); return; }
  void saveSettings({ model: id });
  closeMenus();
}

/** Which provider group is expanded. One at a time; the menu is a menu. */
let openProvider: string | null = null;

async function paintModelMenu() {
  const { providers } = await (await fetch("/providers")).json() as
    { providers: ProviderInfo[] };
  modelMenu.replaceChildren();

  // ONLY the providers with a key, and ONLY their models. There used to be a
  // curated list of the boot provider's ids painted first — which meant a
  // Fireworks-only setup opened its menu onto three Anthropic names it could
  // not answer with. The menu now shows exactly what this machine can run:
  // nothing here is ever a model you cannot actually pick.
  const keyed = providers.filter((prov) => prov.hasKey);

  // One configured provider is the common case, and a menu of one collapsed
  // group is a menu with an extra click in it — its models show directly.
  const only = keyed.length === 1 ? keyed[0]!.id : null;

  for (const prov of keyed) {
    const expanded = openProvider === prov.id || prov.id === only;
    if (!only) {
      const head = document.createElement("button");
      head.type = "button";
      head.className = "provrow" + (expanded ? " open" : "");
      const name = document.createElement("span");
      name.textContent = prov.title;
      head.append(name);
      head.addEventListener("click", () => {
        openProvider = openProvider === prov.id ? null : prov.id;
        void paintModelMenu();
      });
      modelMenu.append(head);
    }
    if (!expanded) continue;

    const box = document.createElement("div");
    box.className = "provmodels";
    for (const mid of prov.models) {
      const short = prov.prefix && mid.startsWith(prov.prefix)
        ? mid.slice(prov.prefix.length) : mid;
      const qualified = `${prov.id}:${short}`;
      const row = document.createElement("button");
      row.type = "button";
      row.className = only ? "pickrow" : "pickrow sub";
      row.textContent = short;
      // Both spellings of "this one": the qualified id a pick records, and
      // the bare id an older session or the boot default may carry.
      if (qualified === model || mid === model || short === model) row.classList.add("on");
      row.addEventListener("click", () => pickModel(qualified));
      box.append(row);
    }
    modelMenu.append(box);
  }
  if (!keyed.length) {
    const hint = document.createElement("div");
    hint.className = "provstate";
    hint.style.padding = "8px 12px";
    hint.textContent = "No providers configured — add a key in settings.";
    modelMenu.append(hint);
  }

  modelMenu.hidden = false;
  modelBtn.setAttribute("aria-expanded", "true");
}

modelBtn.addEventListener("click", () => {
  const wasOpen = !modelMenu.hidden;
  closeMenus();
  if (wasOpen) return;
  void paintModelMenu();
});

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (picker.contains(t) || modelMenu.contains(t)) return;
  if (workdirBtn.contains(t) || modelBtn.contains(t)) return;
  closeMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenus();
});

/**
 * Closing is the reader's, and closing means GONE: the directory goes with it.
 * A workspace that comes back on reload was not closed, it was hidden.
 */
panel.onClose = (app) => {
  panel.remove(app);
  if (!sessionId) return;
  void fetch(`/sessions/${sessionId}/apps?app=${encodeURIComponent(app)}`,
    { method: "DELETE" }).catch(() => {});
};

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
  // Still read, because the ANCHOR depends on it: a question asked mid-scroll
  // is about the block you are looking at, and one asked at the end is about
  // the site. What no longer depends on it is how the composer LOOKS —
  // plans/41: one floating pill, one size, its border always visible, so the
  // place you type does not move or change shape as you scroll past it.
  atSiteEnd = flow.atEnd;
  flowHost.classList.toggle("atend", atSiteEnd);
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
  for (const section of flowHost.querySelectorAll<HTMLElement>(".panel")) {
    const doc = section.querySelector<HTMLElement>(".doc");
    const page = section.dataset.page;
    if (!doc || !page) continue;
    // `.ghost` is speech still forming — not a block, so not a candidate.
    for (const [i, node] of [...doc.children].filter((n) => !n.classList.contains("ghost")).entries()) {
      const r = node.getBoundingClientRect();
      const gap = Math.abs((r.top + r.bottom) / 2 - mid);
      if (gap < bestGap) { bestGap = gap; best = i; bestPage = page; }
    }
  }
  if (!bestPage || best === -1) return { page: id };
  const block = pages.find((p) => p.id === bestPage)?.blocks[best];
  return { page: bestPage, index: best, ...(block?.id ? { id: block.id } : {}) };
}

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

/* ------------------------------------------------------------- sessions */

/** The list in the sidebar, refetched whenever it can have changed. */
async function loadSessions() {
  library = (await (await fetch("/sessions")).json()) as SessionIndex[];
  side.set(library);
  side.setActive(sessionId);
}

/**
 * A blank site, waiting for a question.
 *
 * There is no library to go back to any more, so this is what "no session
 * open" looks like: the middle of the screen, the composer, and three real
 * questions. A session still comes into existence because something was
 * ASKED — nothing is created by pressing this.
 */
async function newSession(opts: { focus?: boolean } = {}) {
  await retireIfUnused(sessionId);
  sessionId = null;
  attempted = false;
  pages = [];
  clearPaintQueue();
  flow.clear();
  pendingTurn = null;
  location.hash = "";
  side.setActive(null);
  panel.clear();
  flowHost.replaceChildren(emptyState());
  appEl.dataset.empty = "1";

  pendingSettings = {};
  workdir = null;
  grants = [];
  moves = [];
  clearInterval(jobsTimer);
  jobsBar.hidden = true;
  paintBar();
  composer.placeholder("Ask anything…");
  composer.clear();
  status("");
  if (opts.focus !== false) composer.open();
}

/**
 * What to show someone with nothing open.
 *
 * "Ask something" is an instruction, not an explanation. The examples are
 * clickable because the fastest way to explain a product that answers by
 * writing a website is to have it answer one.
 */
function emptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "firstrun";

  const h = document.createElement("h1");
  h.textContent = "Ready when you are.";
  wrap.append(h);

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
  stuck: "kept failing the same way and was stopped",
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

/* --------------------------------------------------------------- session */

async function openSession(id: string, opts: { starting?: boolean } = {}) {
  if (id !== sessionId) await retireIfUnused(sessionId);
  sessionId = id;
  attempted = Boolean(opts.starting);
  composer.placeholder("Ask anything…");
  location.hash = `#/s/${id}`;
  appEl.dataset.empty = "";

  flow.clear();
  flowHost.replaceChildren();          // the empty state, if it was up
  pages = [];

  // THE QUESTION SURVIVES THE CLEAR. On a first message the ask bubble is
  // drawn before the session exists — and this call is what brings the session
  // into being, so both clears above land on a flow the caller has just,
  // deliberately, put something into. Detaching it left the reader with no
  // evidence their question had gone anywhere: it reappeared only when the
  // agent's first block arrived and `flow.add` re-attached its section by
  // accident. Keeping the variable without keeping the node was half a fix.
  if (opts.starting && pendingTurn) {
    flowHost.append(pendingTurn);
    flow.toTopOf(pendingTurn, { animate: false });
  } else pendingTurn = null;

  const [index, site, apps] = await Promise.all([
    fetch(`/sessions/${id}`).then((r) => r.json()) as
      Promise<SessionIndex & { lastTurn?: { stopped: string; ask: string; error?: string } }>,
    fetch(`/sessions/${id}/site`).then((r) => r.json()) as Promise<Site>,
    fetch(`/sessions/${id}/apps`).then((r) => r.json()) as Promise<{ apps: AppView[] }>,
  ]);
  side.setActive(id);
  side.rename(id, index.title);
  // Both are properties of the conversation, not of the process: a session
  // resumed tomorrow writes where it wrote today and answers with the same model.
  workdir = index.workdir ?? null;
  grants = index.grants ?? [];
  moves = index.moves ?? [];
  model = index.model ?? defaultModel;
  paintBar();
  answered = index.answered ?? {};
  chosen = index.chosen ?? {};
  // The moves are drawn between the pages they came between, so a section
  // written in one directory and a section written in another are told apart
  // by a line that says so. plans/47.
  site.pages.forEach((p, i) => {
    for (const mv of moves ?? []) if (mv.after === i) flowHost.append(moveLine(mv));
    addPage(p);
  });
  // A workspace belongs to its session, so it comes back with it — and never
  // travels to another one. AFTER the pages: cards parent into the last turn,
  // which has to exist before anything can land in it.
  panel.setAll(apps.apps ?? []);
  watchJobs();

  // RESUME, offered rather than automatic. plans/48. A session reopened after
  // a crash or a cut-off used to present its half-written page as if it were
  // finished — the interruption was only ever marked while you watched it
  // happen. The transcript knows better, so say so, with the same one-action
  // mark the live path uses. Not for "aborted": stopping was a choice, and a
  // choice does not need repairing.
  const bad = index.lastTurn && index.lastTurn.stopped !== "done"
    && index.lastTurn.stopped !== "aborted";
  if (bad && pages.length) markUnfinished(index.lastTurn!.stopped);

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
/**
 * Change the page, and keep up with it if the reader was at the foot.
 *
 * It used to call `flow.toEnd({animate:false})` — an instant jump, per block,
 * with blocks arriving in clumps of five. `keepUp` hands the decision to the
 * one rAF loop that owns the scroll, so a clump of five is one smooth
 * movement rather than five jumps. plans/43.
 */
function stickToEnd(change: () => void) {
  const wasAtEnd = flow.atEnd;
  change();
  if (!wasAtEnd) return;
  flow.keepUp();
  placeComposer();
}

/* ------------------------------------------------------------------- turn */

/**
 * The forming block — speech being typed. plans/40.
 *
 * ONE ghost paragraph, at the end of whichever section the agent is speaking
 * into. `forming` events grow it; any real page event clears it first,
 * because the block the ghost previewed is about to land exactly where the
 * ghost stood. It lives INSIDE `.doc` so it sits on the page's measure, and
 * carries the `ghost` class so everything that zips `doc.children` against
 * `page.blocks` knows to skip it.
 */
let ghost: HTMLElement | null = null;

/**
 * The paint queue: arrival is not painting. plans/43.
 *
 * The controller polls the session directory every 120ms and emits everything
 * it found, so one `cat >> page.ndjson` heredoc of five lines arrives as five
 * `page_block` events in a single microtask — five nodes appended in one
 * frame, five entry animations starting on the same tick. It reads as a clump
 * landing rather than a page assembling, and it is why the shell path always
 * felt lumpier than the streamed one.
 *
 * So blocks queue and drain ONE PER FRAME. Nothing about the data changes;
 * only the pacing of the DOM writes. A block that arrives alone is painted on
 * the next frame — imperceptible — and a clump of five becomes a cascade.
 *
 * The queue is per-document and drained in order, so a page never assembles
 * out of sequence.
 */
interface Queued { doc: HTMLElement; block: Block; page: string }
const paintQueue: Queued[] = [];
let painting: number | undefined;

function queueBlock(doc: HTMLElement, block: Block, page: string) {
  paintQueue.push({ doc, block, page });
  if (painting !== undefined) return;
  const drain = () => {
    const next = paintQueue.shift();
    if (!next) { painting = undefined; return; }
    // A document removed while its blocks were in flight — a page replaced or
    // a session switched — drops its queued work rather than resurrecting it.
    if (next.doc.isConnected) {
      stickToEnd(() => appendBlock(next.doc, next.block, actionsFor(next.page)));
    }
    painting = requestAnimationFrame(drain);
  };
  painting = requestAnimationFrame(drain);
}

/** A session change throws away whatever was still waiting to be painted. */
function clearPaintQueue() {
  paintQueue.length = 0;
  if (painting !== undefined) cancelAnimationFrame(painting);
  painting = undefined;
}

/**
 * What the agent is doing — and, if you ask, how. plans/41, plans/44.
 *
 * One quiet line beside the answer being written. Five words rotate through
 * it and nothing else is shown BY DEFAULT: someone reading about margins did
 * not come here to watch `sed -n` go past.
 *
 * But the work is now KEPT rather than discarded, behind a disclosure that is
 * closed until you open it. Two things made that worth building. A turn's
 * failure already had exactly this treatment — the command was the only thing
 * that explained it — and there was no reason the same evidence should be
 * unavailable when a turn merely went oddly rather than wrongly. And reading a
 * session back afterwards showed the agent spending a third of its steps
 * re-validating JSON it had already written, which is the kind of thing you
 * can only notice if you can see it.
 *
 * THREE RULES it obeys:
 *
 *   1. IT TRAILS THE CONTENT. It used to be appended when the first tool
 *      started — before the first `page_open` — so it landed between the
 *      question and the answer and stayed there while blocks streamed in
 *      underneath it. It is re-appended after every page event now, and
 *      appending a node that is already in the document MOVES it.
 *   2. IT IS STICKY WHILE RUNNING. Trailing the content is not enough on an
 *      answer longer than a screen: the notice would trail it right off the
 *      bottom. Pinned to the viewport it stays visible however far the reader
 *      has scrolled, and it becomes the one signal that something is still
 *      happening below.
 *   3. IT SURVIVES THE TURN. Collapsed, in the flow, as that turn's record of
 *      how its answer was made.
 */
let notice: HTMLElement | null = null;
let noticeLog: HTMLElement | null = null;
let noticeSteps = 0;

/** At most this many steps kept per turn — a turn is capped at 22 anyway. */
const MAX_LOG_STEPS = 25;
/** And this much output per step: a tail is evidence, a log is a terminal. */
const MAX_LOG_TAIL = 2000;

/** Does the reader want to watch the machine? Remembered, like the theme. */
function wantsWork(): boolean {
  try {
    return JSON.parse(localStorage.getItem("perpetual.settings") ?? "{}").work === true;
  } catch { return false; }
}
function rememberWork(on: boolean) {
  try {
    const raw = JSON.parse(localStorage.getItem("perpetual.settings") ?? "{}");
    localStorage.setItem("perpetual.settings", JSON.stringify({ ...raw, work: on }));
  } catch { /* a private window must not break the disclosure */ }
}

/**
 * Where the notice hangs: the turn IN FLIGHT.
 *
 * It used to be `flowHost.querySelector(".panel:last-child")`, which returns
 * the first match in DOCUMENT ORDER — the last panel of the FIRST turn. So on
 * any session with more than one turn the notice appeared near the top of the
 * scroll, above the question that had just been asked.
 */
function noticeHost(): HTMLElement | null {
  return pendingTurn
    ?? flowHost.querySelector<HTMLElement>(".turn:last-child")
    ?? flowHost;
}

function makeNotice(): HTMLElement {
  const n = document.createElement("div");
  n.className = "doing running";
  const dot = document.createElement("span");
  dot.className = "ddot";
  const label = document.createElement("span");
  label.className = "dlabel";

  // The disclosure. Always here, closed unless the reader has said otherwise.
  const d = document.createElement("details");
  d.className = "dwhy";
  if (wantsWork()) d.open = true;
  const sum = document.createElement("summary");
  sum.textContent = "show work";
  const log = document.createElement("div");
  log.className = "dlog";
  d.append(sum, log);
  d.addEventListener("toggle", () => rememberWork(d.open));

  // The way back to the stream, when it has run on past the reader.
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "djump";
  jump.hidden = true;
  jump.addEventListener("click", () => flow.toEnd());

  n.append(dot, label, jump, d);
  noticeLog = log;
  noticeSteps = 0;
  return n;
}

function showDoing(word: string) {
  if (!notice) {
    notice = makeNotice();
    unseen = 0;
    /*
     * WHILE RUNNING IT LIVES IN THE COMPOSER'S OWN FURNITURE. plans/44.
     *
     * It was `position: sticky` in the scroll, offset by a guess at the
     * composer's height — and the guess was 27px short, so the notice's lower
     * third (the `show work` line) sat behind the pill. Measuring the composer
     * instead of guessing did not fix it: the number came out a layout too
     * early every time, and no amount of re-measuring got two elements to
     * agree about where the floor was.
     *
     * So it stops being a second element. `.floathost` is already anchored to
     * the viewport, already painted above the page, and already stacks what is
     * in it — putting the notice there, above the pill, makes clearing the
     * composer a fact of layout rather than a number that can drift.
     */
    floatHost.insertBefore(notice, composer.root);
  }
  notice.querySelector(".dlabel")!.textContent = word;
  notice.classList.remove("bad");
}

/**
 * Keep the notice at the end of what has been written.
 *
 * Appending a node that is already in the document moves it, so this is the
 * whole of rule 1 — called after every page event, it hops the notice past
 * whatever just landed.
 */
function trailNotice() {
  if (!notice) return;
  // While a turn runs the notice lives in the composer's furniture, where it
  // is always visible and always clears the pill. Trailing is for the SETTLED
  // one, which belongs in the flow beside the answer it describes — moving a
  // running one back into the scroll would undo the whole point.
  if (notice.classList.contains("running")) return;
  const host = noticeHost();
  if (host && notice.parentElement !== host) host.append(notice);
  else if (host && host.lastElementChild !== notice) host.append(notice);
}

/** One step, as it starts. The log grows; the label says the word. */
function logStep(word: string, command: string) {
  showDoing(word);
  if (!noticeLog) return;
  if (noticeSteps >= MAX_LOG_STEPS) return;
  noticeSteps++;
  const row = document.createElement("div");
  row.className = "dstep";
  const n = document.createElement("span");
  n.className = "dn";
  n.textContent = String(noticeSteps).padStart(2, "0");
  const verb = document.createElement("span");
  verb.className = "dverb";
  verb.textContent = word;
  const cmd = document.createElement("code");
  cmd.className = "dcmd";
  cmd.textContent = command.split("\n")[0]!.slice(0, 300);
  row.append(n, verb, cmd);
  noticeLog.append(row);
}

/** And how it ended. Output is attached only when there is a reason to read it. */
function logResult(ok: boolean, ms: number, output: string) {
  const row = noticeLog?.lastElementChild as HTMLElement | undefined;
  if (!row || !row.classList.contains("dstep")) return;
  row.classList.toggle("bad", !ok);
  const mark = document.createElement("span");
  mark.className = "dmark";
  mark.textContent = `${(ms / 1000).toFixed(1)}s ${ok ? "✓" : "✗"}`;
  row.append(mark);
  if (!ok && output.trim()) {
    const pre = document.createElement("pre");
    pre.className = "dout";
    pre.textContent = output.split("\n").slice(-8).join("\n").slice(-MAX_LOG_TAIL);
    row.append(pre);
  }
}

/**
 * A command failed. The log opens itself — this is the one moment the command
 * stops being noise and starts being the answer.
 */
function noticeFailed() {
  if (!notice) showDoing("Running");
  notice!.classList.add("bad");
  notice!.querySelector(".dlabel")!.textContent = "That step failed";
  const d = notice!.querySelector<HTMLDetailsElement>(".dwhy");
  if (d) d.open = true;
}

/**
 * The turn ended. The notice stops being live and becomes the record of it:
 * un-sticks, stops pulsing, and keeps the log for anyone who wants to know
 * how this answer was made.
 */
function settleNotice(word: string) {
  if (!notice) return;
  notice.classList.remove("running");
  // Out of the chrome and into the scroll: a live status belongs where the
  // reader is looking, a record belongs beside the answer it describes.
  noticeHost()?.append(notice);
  notice.querySelector<HTMLElement>(".djump")!.hidden = true;
  if (!notice.classList.contains("bad")) {
    notice.querySelector(".dlabel")!.textContent = word;
  }
  // Nothing to show and nothing went wrong: it was a turn with no commands at
  // all — streamed straight out — so there is no work to keep.
  if (noticeSteps === 0 && !notice.classList.contains("bad")) clearNotice();
  notice = null;
  noticeLog = null;
}

/**
 * Rule 3: say when the answer has run on past the reader. plans/44.
 *
 * The page deliberately does NOT chase the stream — an answer here is a
 * composed document whose opening is the part you most need to read, so
 * following it the way a chat does would slide the lead out from under you.
 * The cost of not following is that a long answer grows out of sight and
 * nothing says so.
 *
 * So: count what has landed below the fold, and offer the way to it. Costs
 * nothing when the answer fits on screen, which is most of them.
 */
let unseen = 0;

function noticeArrival() {
  if (!notice) return;
  const jump = notice.querySelector<HTMLElement>(".djump");
  if (!jump) return;
  if (flow.atEnd) { unseen = 0; jump.hidden = true; return; }
  unseen++;
  jump.textContent = `↓ ${unseen} new`;
  jump.hidden = false;
}

function clearNotice() {
  notice?.remove();
  notice = null;
  noticeLog = null;
  noticeSteps = 0;
}

function clearGhost() {
  ghost?.remove();
  ghost = null;
}

/**
 * Turn the ghost INTO the block it was previewing. plans/43.
 *
 * The flash this removes: a paragraph typed itself out as a ghost, the line
 * completed, `clearGhost()` deleted the visible text, and `appendBlock()` put
 * an identical paragraph back — from `opacity: 0`, sliding 7px. Text the
 * reader had already read vanished and faded in again, on every block.
 *
 * When the arriving block is the prose the ghost was already showing, the node
 * stays: drop the class, drop the caret, and it simply becomes real. No
 * removal, no insertion, no entry animation, and — because nothing left the
 * document — no height change for the scroll loop to chase.
 *
 * Returns true when it took the block; false means render it normally.
 */
function promoteGhost(page: string, index: number, block: Block, doc: HTMLElement): boolean {
  if (!ghost || ghost.parentElement !== doc) return false;
  // A skeleton held a SHAPE open, not words — there is nothing in it to
  // promote, so it is removed and the real block rendered normally. It did its
  // job by reserving the space the block is about to occupy.
  if (ghost.dataset.shape) return false;
  // Only prose, and only the LAST slot: the ghost sits at the end of the doc,
  // so a block landing anywhere else is not the one it was previewing.
  if (block.kind !== "prose" || index !== doc.children.length - 1) return false;
  // The ghost shows raw text; the block renders inline marks. Compare with the
  // marks stripped, so `**piston**` and `piston` are recognised as the same
  // sentence rather than as a mismatch that flashes anyway.
  const bare = (t: string) => t.replace(/\*\*|[`*]/g, "").trim();
  if (bare(ghost.textContent ?? "") !== bare(block.text)) return false;

  const real = renderBlock(block, actionsFor(page));
  // Move the rendered children in rather than replacing the node: the element
  // the reader is looking at is the element that stays.
  ghost.replaceChildren(...real.childNodes);
  ghost.className = real.className;
  for (const { name, value } of [...real.attributes]) {
    if (name !== "class") ghost.setAttribute(name, value);
  }
  ghost = null;
  return true;
}

/**
 * Blocks whose ghost is a SHAPE rather than words. plans/43.
 *
 * Prose types itself out because its content is meaningful as it arrives.
 * A chart's is not — half a chart is a false shape, and no honest preview of
 * it exists. What can be previewed is its FOOTPRINT: something chart-shaped,
 * roughly the right height, so the finished block drops into a space that is
 * already there instead of shoving the page down when it lands.
 *
 * The heights are approximations of the real blocks' and they do not need to
 * be exact — reserving most of the space removes most of the shift.
 */
const SKELETON: Record<string, { rows: number; tall?: boolean }> = {
  chart: { rows: 1, tall: true },
  figure: { rows: 1, tall: true },
  table: { rows: 4 },
  metrics: { rows: 1 },
  stat: { rows: 1 },
  card: { rows: 2 },
  split: { rows: 2 },
  flow: { rows: 1 },
  list: { rows: 3 },
  code: { rows: 3 },
  next: { rows: 3 },
};

function showForming(pageId: string, text: string | null, kind: string | null) {
  const doc = docFor(pageId);
  if (!doc) return;
  const shape = kind ? SKELETON[kind] : undefined;

  if (!ghost || ghost.parentElement !== doc) {
    clearGhost();
    ghost = document.createElement(shape ? "div" : "p");
    ghost.className = "ghost";
    doc.append(ghost);
  }

  stickToEnd(() => {
    // A block with prose types it. One without gets its shape held open.
    if (text !== null && !shape) {
      ghost!.className = "ghost";
      ghost!.textContent = text;
      return;
    }
    if (!shape) return;
    if (ghost!.dataset.shape === kind) return;      // already standing
    ghost!.dataset.shape = kind!;
    ghost!.className = `ghost skel${shape.tall ? " tall" : ""}`;
    ghost!.replaceChildren(...Array.from({ length: shape.rows }, () => {
      const bar = document.createElement("span");
      bar.className = "skelbar";
      return bar;
    }));
  });
}

function handle(ev: WireEvent) {
  // Anything that changes what a page looks like is worth re-measuring — the
  // agent is told about the page as it stands, not as it was when it opened.
  if (ev.type.startsWith("page_")) { scheduleReport(); scheduleRevisions(); }

  // The ghost previews the block about to land, so any OTHER page event makes
  // it stale and it goes — which also keeps every index below pointing at a
  // real block. `page_block` is the exception: that is the block it was
  // previewing, and it is promoted in place rather than removed and rebuilt.
  if (ev.type.startsWith("page_") && ev.type !== "page_block") clearGhost();

  // Rule 1: the notice trails whatever has just been written. Appending a node
  // already in the document moves it, so this is the whole of it. plans/44.
  if (ev.type.startsWith("page_")) { trailNotice(); noticeArrival(); }

  switch (ev.type) {
    case "forming":
      showForming(ev.page, ev.text, ev.kind);
      break;

    case "text_delta":
      // The model's private prose. It used to be printed into the status line
      // a fragment at a time, which put the machine's inner monologue in front
      // of someone who asked a question. It is now only EVIDENCE that a turn
      // is alive, and the word for that is "Thinking".
      think += ev.delta;
      if (!notice || notice.classList.contains("bad")) showDoing("Thinking");
      break;

    case "tool_start":
      think = "";
      lastOutput = "";
      logStep(describeCommand(ev.command), ev.command);
      break;

    case "tool_output":
      // Held for the step's own row, and attached to it only if it fails.
      lastOutput = (lastOutput + ev.chunk).slice(-4000);
      break;

    case "tool_end": {
      const ok = ev.exitCode === 0 && !ev.killed;
      logResult(ok, ev.ms, lastOutput);
      if (!ok) noticeFailed();
      break;
    }

    case "page_open":
      addPage(ev.page, { goto: true });
      status("writing", "work");
      break;

    case "page_block": {
      const doc = docFor(ev.page);
      const page = pages.find((p) => p.id === ev.page);
      if (!doc || !page) break;
      page.blocks[ev.index] = ev.block;
      // The ghost was already showing this paragraph: keep the node it is in.
      if (promoteGhost(ev.page, ev.index, ev.block, doc)) { flow.keepUp(); break; }
      queueBlock(doc, ev.block, ev.page);
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
      reaim();
      break;
    }

    case "page_meta": {
      const p = pages.find((x) => x.id === ev.page);
      if (!p) break;
      p.title = ev.title;
      if (ev.ask) p.ask = ev.ask;
      // The session takes its name from its first section, so naming that one
      // renames the session — in the sidebar, which is where its name lives now.
      if (pages[0] === p && sessionId) side.rename(sessionId, ev.title);
      break;
    }

    case "page_remove":
      flow.remove(ev.page);
      pages = pages.filter((p) => p.id !== ev.page);
      break;

    // The workspace tree, watched exactly like the site and arriving down the
    // same channel. Whole views, not block ops: a view is meant to be replaced.
    case "app_open":
      panel.set(ev.app);
      status(`opened ${ev.app.title.toLowerCase()}`, "work");
      break;

    case "app_view":
      // In place: the card repaints where it stands, nothing is dragged.
      panel.set(ev.app);
      break;

    case "app_close":
      panel.remove(ev.app);
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
      clearGhost();
      // The notice settles into the flow as this turn's record of how its
      // answer was made — collapsed, unless the reader asked to watch.
      settleNotice(ev.stopped === "done" ? "Done" : "Stopped early");
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
      /**
       * A finished turn says NOTHING. plans/41.
       *
       * It used to print `3 pages · 5 steps · 35.6s · cache 60641` into the
       * composer — the harness reporting on itself, in the place the reader
       * types, about a question they had already got an answer to. Pages and
       * steps and cache reads are numbers for someone tuning the agent; the
       * reader is looking at the page it just wrote. The full accounting is in
       * the transcript, and `pnpm report` reads it.
       *
       * A turn that was CUT OFF still speaks, because that is the one case the
       * page does not tell the truth by itself: it looks finished and is not.
       * Even then, in words, with no telemetry attached.
       */
      if (ev.stopped === "steps") {
        status("Stopped early — the answer may be unfinished.", "bad");
      } else if (ev.stopped === "time") {
        status("Stopped on the time limit — the answer may be unfinished.", "bad");
      } else if (ev.stopped === "context") {
        status("Ran out of room to think — the answer may be unfinished.", "bad");
      } else {
        status("");
      }
      break;
    }

    case "error":
      clearGhost();
      noticeFailed();
      settleNotice("That turn failed");
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
  // Not "bad": the reader did this on purpose, and everything already
  // written is kept. An alarm tone would make a choice look like a crash.
  status("stopped — everything written so far is kept", "work");
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

// The composer only ever asks now. It used to do double duty — filtering the
// library on one view and asking on the other — because there was one composer
// for two screens. The sidebar has its own search, so this one has one job.

/** The last question asked, so a failed turn can offer to run it again. */
let lastAsk = "";
let lastFailed = "";

composer.onSubmit = async (q) => {
  if (composer.busy) return;
  lastAsk = q;
  lastFailed = "";

  // Asked with nothing open: the session comes into existence because of the
  // question, and we move to it at once so the reader watches it assemble.
  const fresh = !sessionId;
  // Consumed here and nowhere else: a click sets it immediately before
  // sending, so anything typed arrives with it already empty.
  let selection = pendingSelection;
  pendingSelection = undefined;
  // One surface now, so a typed sentence needs no disambiguating: the agent
  // is told which workspaces are open in every turn message, and a click
  // still says exactly where it came from.
  // A click already says where it came from; an implicit anchor on top of it
  // would be a second, weaker answer to the same question.
  const anchor = fresh || selection ? undefined : (aim ?? currentAnchor());
  clearAim();
  think = "";
  composer.working();
  panel.working(true);
  // The question goes on screen before anything answers it. Without this the
  // site sits exactly as it was until the agent's first block lands, and the
  // reader has no evidence their question went anywhere.
  appEl.dataset.empty = "";
  if (fresh) flowHost.replaceChildren();          // the empty state, if it was up
  openPendingTurn(q);
  // The activity line already says "Thinking"; the status line is for what the
  // model is actually saying while it does, which arrives as text deltas.
  status("");
  turn = new AbortController();

  try {
    const id = fresh ? await startSession() : sessionId!;
    // What the reader chose before there was a session to choose it for.
    if (fresh) await flushPendingSettings();
    attempted = true;               // this session has been used; it stays
    for await (const ev of runTurn(id, q, anchor, selection, turn.signal)) handle(ev);
  } catch (err) {
    if ((err as Error)?.name !== "AbortError") {
      status(err instanceof Error ? err.message : String(err), "bad");
    }
  } finally {
    turn = null;
    // A question that produced nothing keeps its place in the record of what
    // was asked — with the retry the composer is already offering.
    if (pendingTurn) {
      pendingTurn.classList.remove("pending");
      pendingTurn.classList.add("unanswered");
      pendingTurn = null;
    }
    composer.done();
    panel.working(false);
    placeComposer();
    void loadSessions();
  }
};

/* ------------------------------------------------------------------- boot */

side.onNew = () => void newSession();

/**
 * Deleting a session. The server route has always existed; it only ever
 * lacked a button. Jobs, workspace, record — the directory goes whole.
 */
side.onDelete = async (id) => {
  const r = await fetch(`/sessions/${id}`, { method: "DELETE" });
  const out = await r.json() as { removed?: string; error?: string };
  // The one refusal: a turn is running in it. Say so rather than half-work.
  if (out.error) { status(out.error, "bad"); return; }
  // Deleting the session you are looking at leaves you somewhere real —
  // the empty state, ready to ask — never a view of a directory that is gone.
  if (id === sessionId) await newSession({ focus: false });
  void loadSessions();
};
side.onPick = (id) => { if (id !== sessionId) void openSession(id); };

$("newsession").addEventListener("click", () => void newSession());
$("searchmin").addEventListener("click", () => side.focusSearch());

/**
 * The sidebar's width, which is a reading decision and therefore the reader's.
 *
 * Wide it is the session list; narrow it is a strip of icons that still gets
 * you to a new session and to search. Kept in the same store as the type size
 * and read before first paint, so it does not snap shut a frame after load.
 */
function setSidebar(min: boolean) {
  document.documentElement.dataset.side = min ? "min" : "";
  $("sidetoggle").setAttribute("aria-expanded", String(!min));
  try {
    const raw = JSON.parse(localStorage.getItem("perpetual.settings") ?? "{}");
    localStorage.setItem("perpetual.settings",
      JSON.stringify({ ...raw, sidebar: min ? "min" : "wide" }));
  } catch { /* a private window must not break the layout */ }
  // The site's frame changed, so where its end is may have too.
  placeComposer();
}

$("sidetoggle").addEventListener("click",
  () => setSidebar(document.documentElement.dataset.side !== "min"));

// The settings panel is anchored beside its button in the sidebar's foot, so
// the sidebar is held open while the panel is up — otherwise its anchor slides
// out from under it.
mountSettings(
  $("prefsbtn"), $("prefs"),
  (open) => {
    sideHost.classList.toggle("pinned", open);
    if (open) void paintPlatformSettings();
  },
  // Text size and measure change how tall the site is, which changes whether
  // the reader is at the end of it.
  () => placeComposer(),
);
$("prefs").querySelector(".prefclose")!.addEventListener("click", () => {
  $("prefs").hidden = true;
  sideHost.classList.remove("pinned");
});

/**
 * The control-room sections: providers, sandbox, tools, prompt. plans/49.
 * Filled when settings opens, from the same endpoints the rest of the chrome
 * uses — settings is a view of the platform, not a second copy of it.
 */
async function paintPlatformSettings() {
  const [prov, plat, health, prompt] = await Promise.all([
    fetch("/providers").then((r) => r.json()) as Promise<{ providers: ProviderInfo[] }>,
    fetch("/platform").then((r) => r.json()) as Promise<{
      sandboxed: boolean; sandbox: string;
      net: { value: boolean; source: string };
      credentials: { available: string[]; visible: string[]; source: string };
      harness: {
        turnMs: { value: number; source: string };
        steps: { value: number; source: string };
        jobMs: { value: number; source: string };
        effort: { value: string; source: string };
        fixed: { label: string; value: string; why: string }[];
      };
    }>,
    fetch("/health").then((r) => r.json()) as Promise<{
      tools?: { name: string; ok: boolean; checked: boolean; note?: string }[];
    }>,
    fetch("/prompt").then((r) => r.json()) as Promise<{ system: string }>,
  ]);

  /* ---- providers: name, state, key in or key out ---- */
  const pbox = $("setproviders");
  pbox.replaceChildren(...prov.providers.map((pr) => {
    const line = document.createElement("div");
    line.className = "provline";
    const name = document.createElement("span");
    name.className = "provname";
    name.textContent = pr.title;
    line.append(name);

    if (pr.source === "env") {
      const tag = document.createElement("span");
      tag.className = "provenv";
      tag.textContent = `${pr.keyEnv} (environment)`;
      line.append(tag);
    } else if (pr.hasKey) {
      const tag = document.createElement("span");
      tag.className = "provkeyed";
      tag.textContent = "key set ✓";
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "provforget";
      forget.textContent = "Forget";
      forget.addEventListener("click", () => {
        void fetch("/providers/key", {
          method: "POST", body: JSON.stringify({ provider: pr.id, key: null }),
        }).then(() => paintPlatformSettings());
      });
      line.append(tag, forget);
    } else {
      const form = document.createElement("form");
      form.className = "keyform";
      const input = document.createElement("input");
      input.type = "password";
      input.placeholder = pr.keyEnv;
      input.autocomplete = "off";
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "Save";
      form.append(input, save);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        void fetch("/providers/key", {
          method: "POST",
          body: JSON.stringify({ provider: pr.id, key: input.value.trim() }),
        }).then(() => paintPlatformSettings());
      });
      line.append(form);
    }
    return line;
  }));

  /* ---- what the agent can do: four consequences, each with its lever ---- */
  const sbox = $("setsandbox");
  sbox.replaceChildren();

  const lever = (mark: string, label: string) => {
    const line = document.createElement("div");
    line.className = "sbline";
    const m = document.createElement("span");
    m.className = "sbmark";
    m.textContent = mark;
    const l = document.createElement("span");
    l.textContent = label;
    line.append(m, l);
    return line;
  };

  // 1. Computation — always on, and saying so is the point: a control that
  //    does not exist should not look like one that is merely switched off.
  const compute = lever("✓", "Compute with anything installed");
  const always = document.createElement("span");
  always.className = "sbwho";
  always.textContent = "always — this is its hands";
  compute.append(always);
  sbox.append(compute);

  // 2. Writing — the rule, since the directories vary per session.
  const write = lever("✎", "Write only in each session's workspace, plus what you grant when it asks");
  sbox.append(write);

  // 3. The network.
  const netLine = lever("⌁", "Reach the internet");
  if (plat.net.source === "env") {
    const who = document.createElement("span");
    who.className = "sbwho";
    who.textContent = `${plat.net.value ? "on" : "off"} · set by PERPETUAL_NET`;
    netLine.append(who);
  } else {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "sbtoggle" + (plat.net.value ? " on" : "");
    t.textContent = plat.net.value ? "on" : "off";
    t.addEventListener("click", () => {
      void fetch("/platform", {
        method: "POST", body: JSON.stringify({ net: !plat.net.value }),
      }).then(async (r) => {
        const out = await r.json() as { error?: string };
        if (out.error) status(out.error, "bad");
        void paintPlatformSettings();
      });
    });
    netLine.append(t);
  }
  sbox.append(netLine);

  // 4. Identity — the chips ARE the tool-approval system: gh without its
  //    credential is an inert binary that prints "not logged in".
  const credHead = lever("🔑", "Act as you");
  const credWhy = document.createElement("span");
  credWhy.className = "sbwho";
  credWhy.textContent = "each identity off until you turn it on";
  credHead.append(credWhy);
  if (plat.credentials.source === "env") {
    const who = document.createElement("span");
    who.className = "sbwho";
    who.textContent = "set by PERPETUAL_CREDENTIALS";
    credHead.append(who);
  }
  sbox.append(credHead);

  const grid = document.createElement("div");
  grid.className = "credgrid";
  for (const cname of plat.credentials.available) {
    const chip = document.createElement("button");
    chip.type = "button";
    const on = plat.credentials.visible.includes(cname);
    chip.className = "credchip" + (on ? " on" : "");
    chip.textContent = cname;
    chip.disabled = plat.credentials.source === "env";
    chip.title = on
      ? `${cname} is visible to the agent — click to hide it`
      : `${cname} reads as empty inside the sandbox — click to make it visible`;
    chip.addEventListener("click", () => {
      const next = on
        ? plat.credentials.visible.filter((c) => c !== cname)
        : [...plat.credentials.visible, cname];
      void fetch("/platform", {
        method: "POST", body: JSON.stringify({ credentials: next }),
      }).then(async (r) => {
        const out = await r.json() as { error?: string };
        if (out.error) status(out.error, "bad");
        void paintPlatformSettings();
      });
    });
    grid.append(chip);
  }
  sbox.append(grid);

  const fact = document.createElement("div");
  fact.className = "sbline";
  const factText = document.createElement("span");
  factText.className = "sbfact" + (plat.sandboxed ? "" : " toolbad");
  factText.textContent = `Enforced by the kernel, not by a list: ${plat.sandbox}`;
  fact.append(factText);
  sbox.append(fact);

  /* ---- harness: four dials, then the calibrations as facts ---- */
  const hbox = $("setharness");
  hbox.replaceChildren();

  const dial = (label: string, opts: { v: string; label: string }[],
    current: string, source: string, set: (v: string) => unknown) => {
    const line = document.createElement("div");
    line.className = "sbline";
    const l = document.createElement("span");
    l.textContent = label;
    line.append(l);
    if (source === "env") {
      const who = document.createElement("span");
      who.className = "sbwho";
      who.textContent = `${current} · set by environment`;
      line.append(who);
    } else {
      const seg = document.createElement("div");
      seg.className = "seg";
      for (const o of opts) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.v = o.v;
        b.textContent = o.label;
        b.classList.toggle("on", o.v === current);
        b.addEventListener("click", () => void set(o.v));
        seg.append(b);
      }
      line.append(seg);
    }
    hbox.append(line);
  };

  const setHarness = (patch: Record<string, unknown>) =>
    fetch("/platform", { method: "POST", body: JSON.stringify({ harness: patch }) })
      .then(async (r) => {
        const out = await r.json() as { error?: string };
        if (out.error) status(out.error, "bad");
        void paintPlatformSettings();
      });

  const h = plat.harness;
  dial("Turn time budget",
    [{ v: "300000", label: "5m" }, { v: "600000", label: "10m" }, { v: "900000", label: "15m" }],
    String(h.turnMs.value), h.turnMs.source,
    (v) => setHarness({ turnMs: Number(v) }));
  dial("Step backstop",
    [{ v: "20", label: "20" }, { v: "40", label: "40" }, { v: "80", label: "80" }],
    String(h.steps.value), h.steps.source,
    (v) => setHarness({ steps: Number(v) }));
  dial("Background job lifetime",
    [{ v: "1800000", label: "30m" }, { v: "3600000", label: "1h" }, { v: "10800000", label: "3h" }],
    String(h.jobMs.value), h.jobMs.source,
    (v) => setHarness({ jobMs: Number(v) }));
  dial("Reasoning effort",
    [{ v: "default", label: "Model default" }, { v: "low", label: "Low" },
     { v: "medium", label: "Med" }, { v: "high", label: "High" }],
    h.effort.value, h.effort.source,
    (v) => setHarness({ effort: v === "default" ? null : v }));

  for (const f of h.fixed) {
    const line = document.createElement("div");
    line.className = "sbline fixedline";
    const l = document.createElement("span");
    l.textContent = f.label;
    const v = document.createElement("span");
    v.className = "sbwho";
    v.textContent = f.value;
    line.append(l, v);
    line.title = f.why;
    hbox.append(line);
  }

  /* ---- tools ---- */
  const tbox = $("settools");
  tbox.replaceChildren(...(health.tools ?? []).map((t) => {
    const line = document.createElement("div");
    line.className = "toolline";
    const mark = document.createElement("span");
    mark.className = t.ok ? "toolok" : "toolbad";
    mark.textContent = t.ok ? (t.checked ? "✓" : "·") : "✗";
    const name = document.createElement("span");
    name.textContent = t.name;
    line.append(mark, name);
    if (t.note) {
      const note = document.createElement("span");
      note.className = "toolnote";
      note.textContent = t.note;
      line.append(note);
    }
    return line;
  }));

  /* ---- the prompt, verbatim ---- */
  $("setprompt").textContent = prompt.system;
}


// A resize changes the frame the page has to fit inside.
let resizing: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => placeComposer(), 150) as unknown as number;
});

// A closed tab sends nothing, so `keepalive` is what makes this land. The
// server's sweep is the backstop for the cases where even that fails.
window.addEventListener("pagehide", () => void retireIfUnused(sessionId, { unloading: true }));

// Keyboard help. The shortcuts existed and nothing said so.
const keys = $("keys");
const showKeys = (on: boolean) => { keys.hidden = !on; };
$("keysclose").addEventListener("click", () => showKeys(false));
window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLElement
    && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
  if ((e.key === "b" || e.key === "B") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    setSidebar(document.documentElement.dataset.side !== "min");
  }
  if (e.key === "?" && !typing) { e.preventDefault(); showKeys(keys.hidden); }
  if (e.key === "Escape" && !keys.hidden) showKeys(false);
});

const health = await (await fetch("/health")).json() as {
  hasKey: boolean; model: string; provider: string; sandbox: string;
  replay: boolean; models?: string[];
};
// The provider and sandbox chips are gone from the foot: they were
// configuration, and configuration reads in SETTINGS, which shows the same
// facts with room to act on them. What stays visible without asking is what
// the chrome cannot let the agent fake and the reader cannot miss:
// Replay stamps the whole sidebar, not a chip. A subtle badge already cost a
// whole evaluation once — a full-height edge cannot be read past.
models = health.models ?? [];
defaultModel = health.model;
model = defaultModel;
paintBar();
sideHost.classList.toggle("replay", health.replay);
// An UNSANDBOXED run is not a settings fact — it is a standing condition,
// and it marks the settings button itself so it cannot go unseen.
if (health.sandbox.includes("UNSANDBOXED")) {
  $("prefsbtn").classList.add("unlocked");
  $("prefsbtn").title = health.sandbox;
}
$("modedot").title = health.replay ? "replay — no model" : `${health.model} · ${health.sandbox}`;
if (!health.hasKey) status("No API key set — export one and restart the controller", "bad");

const hash = /^#\/s\/([a-f0-9]+)$/.exec(location.hash);
await loadSessions();
if (hash) await openSession(hash[1]!);
else await newSession();
