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
 * It also carries the turn while it runs. Three states:
 *
 *   idle   "Ask ⌘K"
 *   open   the input, focused
 *   busy   the live command, its output tail, and a stop button
 *
 * Folding those together is deliberate. Status about a turn belongs where you
 * started the turn, not in a corner of the chrome — and it is what finally
 * makes a turn cancellable, since the abort path has always worked server-side
 * and only ever lacked a button.
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
  private verbEl: HTMLElement;
  private rawBtn: HTMLButtonElement;
  private rawEl: HTMLElement;
  private cmdEl: HTMLElement;
  private outEl: HTMLElement;
  private statusEl: HTMLElement;
  private state: ComposerState = "idle";
  private wantsCompact = true;
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
    this.verbEl = root.querySelector(".verb")!;
    this.rawBtn = root.querySelector(".rawbtn")!;
    this.rawEl = root.querySelector(".raw")!;
    this.cmdEl = root.querySelector(".cmd")!;
    this.outEl = root.querySelector(".out")!;
    this.statusEl = root.querySelector(".pstatus")!;

    root.querySelector(".stop")!.addEventListener("click", () => this.onStop());
    root.querySelector(".aimoff")!.addEventListener("click", (e) => {
      e.stopPropagation();          // the aim is dropped; the composer stays open
      this.onUnaim();
    });
    this.rawBtn.addEventListener("click", () => {
      const open = this.rawEl.hidden;
      this.rawEl.hidden = !open;
      this.rawBtn.setAttribute("aria-expanded", String(open));
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
   * Shrink to the hairline, or grow to the input.
   *
   * A request rather than a command: a running turn is always full, because it
   * carries the activity, the stop button and the status, and a turn that ran
   * invisibly would be worse than a composer that takes up room.
   */
  compact(yes: boolean) {
    this.wantsCompact = yes;
    this.paint();
  }

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
  working(asking?: string) {
    this.state = "busy";
    // Keep the question on screen while the turn runs. Without it a turn shows
    // a command and a spinner, and nothing saying what was even asked.
    this.aim(asking ? `“${asking}”` : null, { cancellable: false });
    this.verbEl.textContent = "Thinking";
    this.verbEl.classList.remove("bad");
    this.cmdEl.textContent = "";
    this.outEl.textContent = "";
    this.cmdEl.classList.remove("bad");
    this.rawEl.hidden = true;
    this.rawBtn.setAttribute("aria-expanded", "false");
    if (this.root.parentElement !== this.floatHost) this.floatHost.append(this.root);
    this.paint();
  }

  done() {
    this.state = "idle";
    this.paint();
  }

  /**
   * What is happening, and — folded away — the command that is doing it.
   *
   * The reader gets a word they know; the raw command stays reachable behind
   * the toggle for the moment it is the only thing that explains a failure.
   */
  activity(line: string, raw: string) {
    this.verbEl.textContent = line;
    this.verbEl.classList.remove("bad");
    this.cmdEl.textContent = raw.split("\n")[0]!.slice(0, 200);
    this.outEl.textContent = "";
  }

  /** A tail, not a log: evidence that something is happening, not a terminal. */
  output(chunk: string) {
    this.outEl.textContent = (this.outEl.textContent + chunk).split("\n").slice(-2).join("\n");
  }

  /**
   * A command failed. The raw command opens itself: this is exactly the moment
   * it stops being noise and starts being the answer.
   */
  commandFailed() {
    this.verbEl.classList.add("bad");
    this.cmdEl.classList.add("bad");
    this.rawEl.hidden = false;
    this.rawBtn.setAttribute("aria-expanded", "true");
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
    // Short only when there is nothing to say to it: no block pointed at, not
    // at the end of the site, not focused, no turn running, and the pointer
    // somewhere else.
    const small = this.wantsCompact && this.state === "idle" && !this.hovering;
    this.root.dataset.size = small ? "min" : "full";
  }
}
