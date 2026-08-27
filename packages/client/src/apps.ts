/**
 * The workspace panel — where you WORK with the agent, beside where you read
 * what it wrote.
 *
 * The scroll is a record: sections, sealed, permanent. Some things are not
 * records. A list of files is something you work in — click one and it opens,
 * go back and the list returns, narrow the search and it changes under you.
 * Putting that in the scroll would mean either a mutable section (which the
 * seal forbids, correctly) or a new section per click (which is a transcript
 * of your own clicking, not a workspace).
 *
 * So it gets its own surface, beside the conversation rather than instead of
 * it: half the questions you ask are ABOUT what is in the panel, and both have
 * to be visible for that to work. It uses the abundant dimension — width —
 * which is the same reason the chrome has always lived down the side.
 *
 * Two ways to touch a row, and the difference is the whole performance story:
 *
 *   IT CARRIES A COMMAND — the controller runs it and hands back the new view.
 *   No model, no cost, about as fast as the command. Opening a file you can
 *   already see needs no judgement, and paying a model turn for it is what
 *   makes a generated app feel like a chatbot in a costume.
 *
 *   IT DOES NOT — the pick becomes a turn, exactly like a choice on a page.
 *   The model comes back for the things that need judgement.
 */
import { renderBlock, type BlockActions } from "./render.ts";
import type { AppView, Selection } from "@perpetual/shared/site";
import type { Choice } from "@perpetual/shared/blocks";

export class AppPanel {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private viewEl: HTMLElement;
  private bodyEl: HTMLElement;
  private noteEl: HTMLElement;
  private input: HTMLInputElement;
  private apps = new Map<string, AppView>();
  private current: string | null = null;
  private tabs: HTMLElement;

  /** A row that carries a command: run it, and show whatever the view became. */
  onRun: (app: string, block: string, option: string,
    values?: Record<string, string | boolean>) => void = () => {};
  /** A row that does not: ask the agent, carrying what was picked. */
  onAsk: (selection: Selection) => void = () => {};
  /** Typed into the panel's own composer, which is scoped to this workspace. */
  onSubmit: (app: string, text: string) => void = () => {};
  onClose: (app: string) => void = () => {};
  /** The panel opened or closed, so the layout can make room for it. */
  onLayout: (open: boolean) => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.tabs = root.querySelector(".ptabs")!;
    this.titleEl = root.querySelector(".ptitle")!;
    this.viewEl = root.querySelector(".pview")!;
    this.bodyEl = root.querySelector(".pbody")!;
    this.noteEl = root.querySelector(".pnote")!;
    this.input = root.querySelector(".pask input")!;

    root.querySelector(".pclose")!.addEventListener("click", () => {
      if (this.current) this.onClose(this.current);
    });
    root.querySelector(".pwide")!.addEventListener("click", () => {
      root.classList.toggle("wide");
    });
    root.querySelector(".pask form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text || !this.current) return;
      this.input.value = "";
      this.onSubmit(this.current, text);
    });
  }

  get open() { return this.apps.size > 0; }
  get activeId() { return this.current; }

  /** Everything the session has open. Used on load and after a turn. */
  setAll(apps: AppView[]) {
    const was = this.open;
    this.apps = new Map(apps.map((a) => [a.id, a]));
    if (!this.current || !this.apps.has(this.current)) {
      this.current = apps[0]?.id ?? null;
    }
    this.paint();
    if (was !== this.open) this.onLayout(this.open);
  }

  /** One workspace appeared or changed. */
  set(app: AppView, opts: { focus?: boolean } = {}) {
    const was = this.open;
    this.apps.set(app.id, app);
    if (opts.focus !== false || !this.current) this.current = app.id;
    this.paint();
    if (was !== this.open) this.onLayout(this.open);
  }

  remove(id: string) {
    const was = this.open;
    this.apps.delete(id);
    if (this.current === id) this.current = [...this.apps.keys()][0] ?? null;
    this.paint();
    if (was !== this.open) this.onLayout(this.open);
  }

  clear() {
    const was = this.open;
    this.apps.clear();
    this.current = null;
    this.paint();
    if (was) this.onLayout(false);
  }

  /** What the last command said, when it failed. Never a terminal. */
  note(text: string, bad = false) {
    this.noteEl.textContent = text;
    this.noteEl.classList.toggle("bad", bad);
    this.noteEl.hidden = !text;
  }

  /** A command is running, or a turn is: the panel says so rather than freezing. */
  working(on: boolean) {
    this.root.classList.toggle("busy", on);
    this.input.disabled = on;
  }

  private actionsFor(app: AppView): BlockActions {
    return {
      // Doors and links belong to the site, not to a workspace: a workspace is
      // not a document and has nowhere to hand over to.
      link: () => {},
      answered: () => null,
      picked: () => null,
      next: () => {},
      choose: (b: Choice, o: { id: string; label: string }) => {
        if (!b.id) return;
        const opt = b.options.find((x) => x.id === o.id);
        if (opt?.run) { this.onRun(app.id, b.id, o.id); return; }
        this.onAsk({
          app: app.id, page: app.id, control: "choice",
          block: b.id, option: o.id, label: o.label, prompt: b.prompt,
        });
      },

      /**
       * A row, a row's action, or a confirmation.
       *
       * Which of the two paths it takes is decided by the FILE, not here: the
       * controller looks the option up and tells us whether anything ran. A
       * row with no command is a question, and asking it is the fallback.
       */
      act: (blockId, option, label) => {
        if (option === "cancel") { this.onCancel(app.id, blockId); return; }
        this.onRun(app.id, blockId, option);
        this.pendingAsk = { blockId, option, label };
      },

      submit: (blockId, values) => {
        this.onRun(app.id, blockId, "submit", values);
        // A form with no command is a form the agent fills in for you: what was
        // typed has to travel with the question, or it is lost.
        this.pendingAsk = {
          blockId, option: "submit",
          label: Object.entries(values)
            .filter(([, v]) => v !== "" && v !== false)
            .map(([k, v]) => `${k}: ${v === true ? "yes" : v}`).join(" · ") || "submitted",
        };
      },
    };
  }

  /**
   * What to ask if the controller reports that nothing ran.
   *
   * A row without a command is not broken — it is a question for the agent,
   * and the answer to "nothing ran" is to ask it rather than to do nothing.
   */
  private pendingAsk: { blockId: string; option: string; label: string } | null = null;

  /** Called by the caller when `/act` came back saying it ran nothing. */
  askInstead() {
    const p = this.pendingAsk;
    this.pendingAsk = null;
    const app = this.current ? this.apps.get(this.current) : undefined;
    if (!p || !app) return;
    const prompt = app.blocks.find((b) => b.id === p.blockId && b.kind === "confirm");
    this.onAsk({
      app: app.id, page: app.id, control: "choice",
      block: p.blockId, option: p.option, label: p.label,
      ...(prompt && prompt.kind === "confirm" ? { prompt: prompt.prompt } : {}),
    });
  }

  /** A confirmation declined. Nothing runs, and nobody is asked. */
  onCancel: (app: string, block: string) => void = () => {};



  private paint() {
    this.root.hidden = !this.open;
    if (!this.open) { this.root.classList.remove("wide"); return; }

    // Tabs only when there is a choice to make. One workspace needs no tabs,
    // and an empty tab strip is chrome asking to be noticed for nothing.
    const many = this.apps.size > 1;
    this.tabs.hidden = !many;
    if (many) {
      this.tabs.replaceChildren(...[...this.apps.values()].map((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = a.id === this.current ? "ptab on" : "ptab";
        b.textContent = a.title;
        b.addEventListener("click", () => { this.current = a.id; this.paint(); });
        return b;
      }));
    }

    const app = this.current ? this.apps.get(this.current) : undefined;
    if (!app) return;
    this.titleEl.textContent = app.title;
    this.viewEl.textContent = app.view ?? "";
    this.viewEl.hidden = !app.view;
    this.input.placeholder = `Ask about ${app.title.toLowerCase()}…`;

    const acts = this.actionsFor(app);
    const doc = document.createElement("div");
    doc.className = "pdoc";
    for (const b of app.blocks) doc.append(renderBlock(b, acts));
    this.bodyEl.replaceChildren(doc);
  }
}
