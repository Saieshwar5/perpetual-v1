/**
 * The rail — the session's only navigation, and its memory.
 *
 * Collapsed it is a 44px strip of ticks: position in the site, at a glance,
 * costing almost no screen. Hovered it becomes the THREAD — the list of what
 * the user actually asked, oldest at the top.
 *
 * Listing the asks rather than the agent's page titles is the whole point. A
 * reader looking for something remembers their own question, not the three
 * words the agent chose to name the answer. It also removes the need for a
 * separate session map: the thread already does that job.
 */
export interface RailItem { id: string; ask: string; title: string }

export class Rail {
  private root: HTMLElement;
  private ticks: HTMLElement;
  private list: HTMLElement;
  private items: RailItem[] = [];
  private active = 0;
  onPick: (id: string) => void = () => {};

  /**
   * @param root  the rail itself — it owns the expand-on-focus behaviour
   * @param mount where the ticks and thread go, so the rail can also hold a
   *              head and a foot around them
   */
  constructor(root: HTMLElement, mount: HTMLElement = root) {
    this.root = root;
    this.ticks = document.createElement("div");
    this.ticks.className = "ticks";
    this.list = document.createElement("nav");
    this.list.className = "thread";
    this.list.setAttribute("aria-label", "Pages in this session");
    mount.append(this.ticks, this.list);

    // Focus opens it too, so the thread is reachable without a pointer.
    root.addEventListener("focusin", () => root.classList.add("open"));
    root.addEventListener("focusout", (e) => {
      if (!root.contains(e.relatedTarget as Node)) root.classList.remove("open");
    });
  }

  set(items: RailItem[]) { this.items = items; this.paint(); }

  setActive(i: number) { this.active = i; this.paint(); }

  private paint() {
    this.ticks.replaceChildren(...this.items.map((_, i) => {
      const t = document.createElement("span");
      t.className = i === this.active ? "tick on" : "tick";
      return t;
    }));

    this.list.replaceChildren(...this.items.map((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = i === this.active ? "row on" : "row";
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(i + 1).padStart(2, "0");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = it.ask || it.title;
      b.append(n, label);
      b.addEventListener("click", () => this.onPick(it.id));
      return b;
    }));

    const row = this.list.children[this.active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }
}
