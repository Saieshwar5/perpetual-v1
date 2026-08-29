/**
 * The composer. plans/17.
 *
 * There is no permanent input bar. A fixed footer costs 120px of every screen
 * and, worse, signals "this is a chat" — the one thing the whole product is
 * built to not be.
 *
 * So the composer is QUIET rather than absent. Mid-page it is a hairline that
 * says where you are in the site and can be clicked; it becomes an input when
 * there is a reason to — a block pointed at, a turn running, or the end of the
 * last page, where the reader has genuinely run out of website.
 *
 * It used to have two homes, re-parented into a `.dock` element built into
 * every page. One home now: the size is a class, so nothing is moved, nothing
 * is blurred, and no page carries space for a composer that is not there.
 *
 * IT IS AN INPUT, AND NOTHING ELSE. It used to carry the running turn as
 * well — the live command, a tail of its output, a toggle to reveal the bash.
 * That made the place you TYPE into the place the machine reported on itself,
 * and the two have nothing to do with each other. What the agent is doing now
 * appears in the scroll, beside the answer it is producing, where the reader
 * is already looking.
 *
 * What stays here is what belongs to the act of asking: the question, what it
 * is pointed at, and the way to stop a turn you no longer want.
 */
export type ComposerState = "idle" | "open" | "busy";

/** Long enough that a pointer merely passing over the bottom edge never grows it. */
const HOVER_MS = 130;

export class Composer {
  readonly root: HTMLElement;
  private floatHost: HTMLElement;
  private input: HTMLInputElement;
  private form: HTMLFormElement;

  private aimEl: HTMLElement;
  private aimText: HTMLElement;
  private statusEl: HTMLElement;
  private state: ComposerState = "idle";
  /**
   * The pointer is resting ON the composer.
   *
   * Different from the pointer crossing the page, which must never grow
   * anything — that is the jumpiness worth avoiding. Moving onto the composer
   * is an intention, and the short delay is what tells the two apart: a
   * pointer travelling past the bottom edge is gone before it fires.
   */
  private hovering = false;
  private hoverTimer: number | undefined;

  onSubmit: (text: string) => void = () => {};
  onStop: () => void = () => {};
  /** Fires on every keystroke. The library uses it to filter the grid. */
  onType: (text: string) => void = () => {};
  /** Fires when the composer opens or closes, so the caller can take aim. */
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  /** The reader stopped pointing at a block, without closing the composer. */
  onUnaim: () => void = () => {};

  constructor(root: HTMLElement, floatHost: HTMLElement) {
    this.root = root;
    this.floatHost = floatHost;

    this.form = root.querySelector(".pform")!;
    this.input = root.querySelector("input")!;
    this.aimEl = root.querySelector(".aim")!;
    this.aimText = root.querySelector(".aimtext")!;
    this.statusEl = root.querySelector(".pstatus")!;

    root.querySelector(".stop")!.addEventListener("click", () => this.onStop());
    root.querySelector(".aimoff")!.addEventListener("click", (e) => {
      e.stopPropagation();          // the aim is dropped; the composer stays open
      this.onUnaim();
    });
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      this.clear();
      this.onSubmit(text);
    });

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); this.close(); }
    });
    // Escape stops a running turn from anywhere — the reflex people already
    // have. Guarded to `busy` so it cannot swallow the Escape that closes
    // menus when nothing is running; `close()` above handles the idle case.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.state === "busy") this.onStop();
    });
    // Clicking into the field IS opening it, now that there is no button in
    // front of it. `open()` focuses, so the guard stops it recursing.
    this.input.addEventListener("focus", () => { if (this.state === "idle") this.open(); });

    root.addEventListener("pointerenter", () => {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => { this.hovering = true; this.paint(); },
        HOVER_MS) as unknown as number;
    });
    root.addEventListener("pointerleave", () => {
      clearTimeout(this.hoverTimer);
      if (this.hovering) { this.hovering = false; this.paint(); }
    });
    this.input.addEventListener("input", () => this.onType(this.input.value));

    window.addEventListener("keydown", (e) => {
      const typing = e.target instanceof HTMLElement
        && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); this.open();
      } else if (e.key === "/" && !typing && this.state === "idle") {
        e.preventDefault(); this.open();
      }
    });

    this.paint();
  }

  get busy() { return this.state === "busy"; }
  get text() { return this.input.value; }
  /**
   * What this question is pointing at, in words.
   *
   * The anchor has always travelled with every turn — the agent was told which
   * page and which block — but the reader was never told it existed. Saying it
   * out loud is what turns a hidden mechanism into something you would think
   * to use.
   */
  aim(text: string | null, opts: { cancellable?: boolean; faded?: boolean } = {}) {
    this.aimText.textContent = text ?? "";
    this.aimEl.hidden = !text;
    // Cancellable only when there is something to cancel: the question a turn
    // is running under is a fact, not a choice.
    this.aimEl.classList.toggle("cancellable", Boolean(text) && opts.cancellable !== false);
    // Faded means the block is no longer on screen — still pointed at, but the
    // reader cannot see it, so it should not look as certain as one they can.
    this.aimEl.classList.toggle("faded", Boolean(opts.faded));
  }

  placeholder(text: string) { this.input.placeholder = text; }

  clear() { this.input.value = ""; this.onType(""); }

  open() {
    if (this.state === "busy") return;
    // Guess what the reader is looking at only when the composer actually
    // OPENS. Re-guessing on every click while it is already open overwrites
    // the block they just chose — and, worse, marks the overwrite as something
    // they did not choose, so the click that undoes an aim never registered.
    const wasOpen = this.state === "open";
    this.state = "open";
    this.paint();
    if (!wasOpen) this.onOpen();
    this.input.focus();
    this.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  close() {
    if (this.state === "busy") return;
    this.state = "idle";
    this.aim(null);
    this.paint();
    this.onClose();
  }

  /**
   * Send text as if the reader had typed it — how a `next` question is asked.
   * It goes through onSubmit, so a clicked door and a typed question take
   * exactly the same path.
   */
  send(text: string) {
    if (this.state === "busy") return;
    this.input.value = "";
    this.onSubmit(text);
  }

  /** A turn started. The pill floats while it runs, so it survives scrolling. */
  working() {
    this.state = "busy";
    // The question is NOT echoed here. It used to be, back when the composer
    // was the only place a running turn was visible — but the ask is now drawn
    // in the scroll the moment it is sent, so repeating it above the input
    // meant the reader saw their sentence still sitting in the box and read
    // that as "it did not send".
    this.aim(null);
    if (this.root.parentElement !== this.floatHost) this.floatHost.append(this.root);
    this.paint();
  }

  done() {
    this.state = "idle";
    this.paint();
  }

  status(text: string, tone: "" | "work" | "bad" = "") {
    this.statusEl.textContent = text;
    this.statusEl.className = `pstatus ${tone}`;
  }

  /**
   * A turn failed. Says so, and offers the only thing the reader wants.
   *
   * Failure used to look like every other status line, and the way forward was
   * to type the question again — so a provider hiccup cost the reader their
   * sentence. The question is already known; asking them to reproduce it is
   * the harness making its problem theirs.
   */
  failed(message: string, retry: () => void) {
    this.statusEl.className = "pstatus bad";
    this.statusEl.textContent = `${message} `;
    const again = document.createElement("button");
    again.type = "button";
    again.className = "retry";
    again.textContent = "Try again";
    again.addEventListener("click", retry);
    this.statusEl.append(again);
  }

  private paint() {
    this.root.dataset.state = this.state;
    // ONE SIZE, ALWAYS. It used to shrink to a hairline mid-scroll and grow at
    // the foot of the site, so the thing you type into changed shape depending
    // on where you had scrolled to — and its border came and went with it.
    // A composer you cannot always see is one you have to go and find.
    this.root.dataset.size = "full";
  }
}
