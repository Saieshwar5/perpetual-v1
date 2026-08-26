/**
 * The composer. plans/17.
 *
 * There is no permanent input bar. A fixed footer costs 120px of every screen
 * and, worse, signals "this is a chat" — the one thing the whole product is
 * built to not be. So the composer is invoked, and it is a single element that
 * DOCKS at the end of a page and FLOATS when you are scrolled up. One
 * affordance, never two competing ones, and it belongs to the document rather
 * than hovering over the application.
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

export class Composer {
  readonly root: HTMLElement;
  private floatHost: HTMLElement;
  private input: HTMLInputElement;
  private form: HTMLFormElement;
  private invite: HTMLButtonElement;
  private aimEl: HTMLElement;
  private cmdEl: HTMLElement;
  private outEl: HTMLElement;
  private statusEl: HTMLElement;
  private state: ComposerState = "idle";

  onSubmit: (text: string) => void = () => {};
  onStop: () => void = () => {};
  /** Fires on every keystroke. The library uses it to filter the grid. */
  onType: (text: string) => void = () => {};
  /** Fires when the composer opens or closes, so the caller can take aim. */
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  constructor(root: HTMLElement, floatHost: HTMLElement) {
    this.root = root;
    this.floatHost = floatHost;
    this.invite = root.querySelector(".invite")!;
    this.form = root.querySelector(".pform")!;
    this.input = root.querySelector("input")!;
    this.aimEl = root.querySelector(".aim")!;
    this.cmdEl = root.querySelector(".cmd")!;
    this.outEl = root.querySelector(".out")!;
    this.statusEl = root.querySelector(".pstatus")!;

    this.invite.addEventListener("click", () => this.open());
    root.querySelector(".stop")!.addEventListener("click", () => this.onStop());

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
  /** Docked means the reader is at the end of a page; floating means mid-page. */
  get docked() { return this.root.classList.contains("docked"); }

  /**
   * What this question is pointing at, in words.
   *
   * The anchor has always travelled with every turn — the agent was told which
   * page and which block — but the reader was never told it existed. Saying it
   * out loud is what turns a hidden mechanism into something you would think
   * to use.
   */
  aim(text: string | null) {
    this.aimEl.textContent = text ?? "";
    this.aimEl.hidden = !text;
  }

  /**
   * Which host the pill returns to when it is not docked. The library and the
   * session are different views, so the composer is re-homed as you move
   * between them rather than duplicated — one element, one set of shortcuts,
   * one behaviour to learn.
   */
  setHome(host: HTMLElement) {
    this.floatHost = host;
    if (this.root.parentElement !== host) host.append(this.root);
    this.root.classList.remove("docked");
  }

  placeholder(text: string) { this.input.placeholder = text; }

  clear() { this.input.value = ""; this.onType(""); }

  /**
   * Move into a page's dock, or back to floating. Only ever while idle: moving
   * a node blurs whatever is inside it, so re-docking mid-sentence would eat
   * the reader's focus and their caret position.
   */
  dockTo(dock: HTMLElement | null) {
    if (this.state !== "idle") return;
    const target = dock ?? this.floatHost;
    if (this.root.parentElement !== target) target.append(this.root);
    this.root.classList.toggle("docked", Boolean(dock));
  }

  open() {
    if (this.state === "busy") return;
    this.state = "open";
    this.paint();
    this.onOpen();
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
    this.aim(asking ? `“${asking}”` : null);
    this.cmdEl.textContent = "";
    this.outEl.textContent = "";
    this.cmdEl.classList.remove("bad");
    if (this.root.parentElement !== this.floatHost) {
      this.floatHost.append(this.root);
      this.root.classList.remove("docked");
    }
    this.paint();
  }

  done() {
    this.state = "idle";
    this.paint();
  }

  command(text: string) {
    this.cmdEl.textContent = text.split("\n")[0]!.slice(0, 120);
    this.cmdEl.classList.remove("bad");
    this.outEl.textContent = "";
  }

  /** A tail, not a log: evidence that something is happening, not a terminal. */
  output(chunk: string) {
    this.outEl.textContent = (this.outEl.textContent + chunk).split("\n").slice(-2).join("\n");
  }

  commandFailed() { this.cmdEl.classList.add("bad"); }

  status(text: string, tone: "" | "work" | "bad" = "") {
    this.statusEl.textContent = text;
    this.statusEl.className = `pstatus ${tone}`;
  }

  private paint() {
    this.root.dataset.state = this.state;
  }
}
