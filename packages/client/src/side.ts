/**
 * The sidebar — every session, and the way into any of them.
 *
 * It replaces two things at once, and that is the point of it:
 *
 *   THE LIBRARY, which was a whole screen you had to leave your work to reach.
 *   Starting a session meant travelling somewhere, and coming back meant
 *   travelling again. The list belongs beside the work, not instead of it.
 *
 *   THE RAIL, which had to carry identity, navigation and the environment in
 *   46px and did none of them comfortably. Its thread of asks has moved into
 *   the scroll itself, where the questions belong; what is left — where am I,
 *   what else is there, what is this running on — fits here with room to spare.
 *
 * The active session opens to show its sections, so the sidebar answers both
 * questions a reader has at once: which site am I in, and where in it. That
 * is the rail's map, in a place wide enough to read.
 */
import type { SessionIndex } from "@perpetual/shared/site";

export interface SideSection {
  id: string;
  /** The reader's own question, which is how they will look for it. */
  label: string;
}

/** How the list is grouped. Recency, because that is how anyone looks for one. */
const BUCKETS: { label: string; within: number }[] = [
  { label: "Today", within: 1 },
  { label: "Yesterday", within: 2 },
  { label: "Previous 7 days", within: 8 },
  { label: "Earlier", within: Infinity },
];

function bucketOf(iso: string): string {
  const days = (Date.now() - Date.parse(iso)) / 86_400_000;
  return (BUCKETS.find((b) => days < b.within) ?? BUCKETS.at(-1)!).label;
}

export class Sidebar {
  private root: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private sessions: SessionIndex[] = [];
  private sections: SideSection[] = [];
  private activeSession: string | null = null;
  private activeSection: string | null = null;
  private filter = "";

  onPick: (id: string) => void = () => {};
  onPickSection: (page: string) => void = () => {};
  onNew: () => void = () => {};

  constructor(root: HTMLElement, list: HTMLElement, search: HTMLInputElement) {
    this.root = root;
    this.list = list;
    this.search = search;
    this.search.addEventListener("input", () => {
      this.filter = this.search.value.trim();
      this.paint();
    });
    // A search that has found the session you wanted should open it, rather
    // than making you take your hands off the keyboard to click it.
    this.search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = this.shown()[0];
      if (first) this.onPick(first.id);
    });
  }

  /** The sessions, as loaded. Filtering is a view over this, not a refetch. */
  set(sessions: SessionIndex[]) {
    this.sessions = sessions;
    this.paint();
  }

  setActive(id: string | null) {
    this.activeSession = id;
    this.paint();
  }

  /** The sections of the session being read — the rail's map, rehoused. */
  setSections(sections: SideSection[], active: string | null = null) {
    this.sections = sections;
    this.activeSection = active;
    this.paint();
  }

  setActiveSection(page: string | null) {
    if (page === this.activeSection) return;
    this.activeSection = page;
    this.paint();
  }

  /** One session's row, updated in place — a rename must not redraw the list. */
  rename(id: string, title: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || s.title === title) return;
    s.title = title;
    this.paint();
  }

  focusSearch() {
    this.root.classList.remove("min");
    this.search.focus();
    this.search.select();
  }

  private shown(): SessionIndex[] {
    if (!this.filter) return this.sessions;
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    return this.sessions.filter((s) => {
      const hay = `${s.title} ${s.asks.join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  private paint() {
    const shown = this.shown();
    const rows: HTMLElement[] = [];
    let bucket = "";

    for (const s of shown) {
      // Grouped by recency, and the heading appears only when the bucket
      // changes — a label per row would be noise, not structure.
      const b = bucketOf(s.updatedAt);
      if (b !== bucket && !this.filter) {
        bucket = b;
        const h = document.createElement("div");
        h.className = "sgroup";
        h.textContent = b;
        rows.push(h);
      }
      rows.push(this.sessionRow(s));
      if (s.id === this.activeSession && this.sections.length) {
        rows.push(this.sectionList());
      }
    }

    if (!shown.length) {
      const empty = document.createElement("p");
      empty.className = "sempty";
      empty.textContent = this.filter
        ? "Nothing matches."
        : "No sessions yet. Ask something to start one.";
      rows.push(empty);
    }

    this.list.replaceChildren(...rows);
  }

  private sessionRow(s: SessionIndex): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = s.id === this.activeSession ? "srow on" : "srow";
    b.dataset.session = s.id;
    b.title = s.title;

    const dot = document.createElement("span");
    dot.className = "ico";
    dot.textContent = "◍";
    const label = document.createElement("span");
    label.className = "slabel wide";
    label.textContent = s.title;

    b.append(dot, label);
    b.addEventListener("click", () => this.onPick(s.id));
    return b;
  }

  private sectionList(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ssections wide";
    for (const [i, sec] of this.sections.entries()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = sec.id === this.activeSection ? "ssec on" : "ssec";
      b.dataset.page = sec.id;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(i + 1).padStart(2, "0");
      const label = document.createElement("span");
      label.className = "slabel";
      label.textContent = sec.label;
      b.append(n, label);
      b.addEventListener("click", () => this.onPickSection(sec.id));
      wrap.append(b);
    }
    return wrap;
  }
}
