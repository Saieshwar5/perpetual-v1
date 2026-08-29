/**
 * Workspaces, inline — cards in the one scroll, where everything else already
 * is.
 *
 * They used to live in a panel down the right side. The reasoning was sound —
 * a workspace is the one surface allowed to change under you, and keeping it
 * physically apart kept that distinction visible — but the price was a second
 * place: its own chrome, three layout modes, and a whole "context" subsystem
 * to disambiguate which surface a typed sentence was about. Two places to
 * look, and a rule the reader had to learn.
 *
 * One rule now: EVERYTHING THE AGENT DOES APPEARS IN THE FLOW, IN ORDER. A
 * workspace renders as a live card inside the turn that opened it — bordered
 * and marked, because unlike the sealed prose around it this part can change —
 * and updates in place as the agent rewrites its view. The seal is untouched:
 * the card is still `ui/apps/<name>/view.ndjson`, a separate file drawn in a
 * different spot, never blocks smuggled onto a page.
 *
 * Two ways to touch a row, unchanged, and still the whole performance story:
 *
 *   IT CARRIES A COMMAND — the controller runs it and hands back the new view.
 *   No model, no cost, about as fast as the command.
 *
 *   IT DOES NOT — the pick becomes a turn, exactly like a choice on a page.
 *   The model comes back for the things that need judgement.
 */
import { renderBlock, type BlockActions } from "./render.ts";
import type { AppView, Selection } from "@perpetual/shared/site";
import type { Choice } from "@perpetual/shared/blocks";

interface Card {
  view: AppView;
  root: HTMLElement;
  body: HTMLElement;
  note: HTMLElement;
}

export class AppCards {
  private cards = new Map<string, Card>();
  /** Where a new card lands: the current turn. Asked at creation, not kept. */
  private host: () => HTMLElement;
  /** The session a picture would be served from. Asked, never held: it changes. */
  private session: () => string;

  /** A row that carries a command: run it, and show whatever the view became. */
  onRun: (app: string, block: string, option: string,
    values?: Record<string, string | boolean>) => void = () => {};
  /** A row that does not: ask the agent, carrying what was picked. */
  onAsk: (selection: Selection) => void = () => {};
  onClose: (app: string) => void = () => {};

  constructor(host: () => HTMLElement, session: () => string) {
    this.host = host;
    this.session = session;
  }

  get open() { return this.cards.size > 0; }

  /** One workspace by id, for chrome that needs to name it. */
  get(id: string): AppView | undefined { return this.cards.get(id)?.view; }

  /** Everything the session has open. Used on load, after the pages are in. */
  setAll(apps: AppView[]) {
    for (const id of [...this.cards.keys()]) {
      if (!apps.some((a) => a.id === id)) this.remove(id);
    }
    for (const a of apps) this.set(a);
  }

  /** One workspace appeared or changed. In place, never a re-mount. */
  set(app: AppView) {
    let card = this.cards.get(app.id);
    if (!card) {
      card = this.makeCard(app);
      this.cards.set(app.id, card);
      this.host().append(card.root);
    }
    card.view = app;
    this.paint(card);
  }

  remove(id: string) {
    const card = this.cards.get(id);
    if (!card) return;
    card.root.remove();
    this.cards.delete(id);
  }

  clear() {
    for (const c of this.cards.values()) c.root.remove();
    this.cards.clear();
  }

  /** What the last command said, when it failed. Never a terminal. */
  note(app: string, text: string, bad = false) {
    const card = this.cards.get(app);
    if (!card) return;
    card.note.textContent = text;
    card.note.classList.toggle("bad", bad);
    card.note.hidden = !text;
  }

  /** A command is running, or a turn is: the cards say so rather than freezing. */
  working(on: boolean) {
    for (const c of this.cards.values()) c.root.classList.toggle("busy", on);
  }

  /**
   * What to ask if the controller reports that nothing ran.
   *
   * A row without a command is not broken — it is a question for the agent,
   * and the answer to "nothing ran" is to ask it rather than to do nothing.
   */
  private pendingAsk: { app: string; blockId: string; option: string; label: string } | null = null;

  /** Called by the caller when `/act` came back saying it ran nothing. */
  askInstead() {
    const p = this.pendingAsk;
    this.pendingAsk = null;
    if (!p) return;
    const view = this.cards.get(p.app)?.view;
    if (!view) return;
    const prompt = view.blocks.find((b) => b.id === p.blockId && b.kind === "confirm");
    this.onAsk({
      app: p.app, page: p.app, control: "choice",
      block: p.blockId, option: p.option, label: p.label,
      ...(prompt && prompt.kind === "confirm" ? { prompt: prompt.prompt } : {}),
    });
  }

  /** A confirmation declined. Nothing runs, and nobody is asked. */
  onCancel: (app: string, block: string) => void = () => {};

  private makeCard(app: AppView): Card {
    const root = document.createElement("section");
    root.className = "appcard";
    root.dataset.app = app.id;

    const box = document.createElement("div");
    box.className = "acard";

    const head = document.createElement("header");
    head.className = "ahead";
    const dot = document.createElement("span");
    dot.className = "adot";
    const title = document.createElement("span");
    title.className = "atitle";
    const view = document.createElement("span");
    view.className = "aview";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "aclose";
    close.setAttribute("aria-label", "Close the workspace");
    close.textContent = "✕";
    close.addEventListener("click", () => this.onClose(app.id));
    head.append(dot, title, view, close);

    const body = document.createElement("div");
    body.className = "pdoc";
    const note = document.createElement("div");
    note.className = "pnote";
    note.hidden = true;

    box.append(head, body, note);
    root.append(box);
    return { view: app, root, body, note };
  }

  private paint(card: Card) {
    const app = card.view;
    card.root.querySelector(".atitle")!.textContent = app.title;
    const viewEl = card.root.querySelector<HTMLElement>(".aview")!;
    viewEl.textContent = app.view ?? "";
    viewEl.hidden = !app.view;

    const acts = this.actionsFor(app);
    card.body.replaceChildren(...app.blocks.map((b) => renderBlock(b, acts)));
  }

  private actionsFor(app: AppView): BlockActions {
    return {
      // Doors and links belong to the site, not to a workspace: a workspace is
      // not a document and has nowhere to hand over to.
      link: () => {},
      answered: () => null,
      picked: () => null,
      next: () => {},
      // A workspace shows pictures out of its own directory, the same way a
      // page does out of its. Access requests belong on the record, not on a
      // surface that is about to be rewritten — so no `allow` here.
      asset: (src) =>
        `/sessions/${this.session()}/asset?app=${encodeURIComponent(app.id)}&file=${
          encodeURIComponent(src)}`,
      choose: (b: Choice, o: { id: string; label: string }) => {
        if (!b.id) return;
        // A multi answer is a joined id that matches no single option, so it
        // falls through to the agent — which is where several picks belong.
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
        this.pendingAsk = { app: app.id, blockId, option, label };
      },

      submit: (blockId, values) => {
        this.onRun(app.id, blockId, "submit", values);
        // A form with no command is a form the agent fills in for you: what was
        // typed has to travel with the question, or it is lost.
        this.pendingAsk = {
          app: app.id, blockId, option: "submit",
          label: Object.entries(values)
            .filter(([, v]) => v !== "" && v !== false)
            .map(([k, v]) => `${k}: ${v === true ? "yes" : v}`).join(" · ") || "submitted",
        };
      },
    };
  }
}
