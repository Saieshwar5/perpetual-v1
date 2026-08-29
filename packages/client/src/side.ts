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
 * It lists SESSIONS AND NOTHING ELSE. The active session used to expand into
 * a numbered thread of every question asked in it — the rail's map, rehoused.
 * It was answering a question nobody had: the reader is looking at the scroll,
 * which already holds those questions in order, standing above the answers
 * they produced. A second copy in the margin was a table of contents for a
 * document you are already inside.
 *
 * The asks are still SEARCHED, though never shown. Typing "canberra" finds
 * the session that answered it, which is the one thing the thread was
 * genuinely good for and costs nothing to keep.
 */
import type { SessionIndex } from "@perpetual/shared/site";

/** How the list is grouped. Recency, because that is how anyone looks for one. */
const BUCKETS: { label: string; within: number }[] = [
  { label: "Today", within: 1 },
  { label: "Yesterday", within: 2 },
  { label: "Previous 7 days", within: 8 },
  { label: "Earlier", within: Infinity },
];

/** Enough to tell two same-named sessions apart, and no more. */
function whenOf(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bucketOf(iso: string): string {
  const days = (Date.now() - Date.parse(iso)) / 86_400_000;
  return (BUCKETS.find((b) => days < b.within) ?? BUCKETS.at(-1)!).label;
}

export class Sidebar {
  private root: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private sessions: SessionIndex[] = [];
  private activeSession: string | null = null;
  private filter = "";

  onPick: (id: string) => void = () => {};
  onNew: () => void = () => {};
  /** The reader deleted a session. Irreversible — the directory IS the session. */
  onDelete: (id: string) => void = () => {};

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

    // Two sessions with the same name is not a bug to prevent — "Resume
    // cleanup" twice is honest — but it IS the difference between finding one
    // and opening both. The duplicates say when they were, and only the
    // duplicates: a date on every row would be noise on the ones that need no
    // telling apart.
    const seen = new Map<string, number>();
    for (const s of shown) seen.set(s.title, (seen.get(s.title) ?? 0) + 1);
    const ambiguous = new Set(
      [...seen].filter(([, n]) => n > 1).map(([t]) => t));

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
      rows.push(this.sessionRow(s, ambiguous.has(s.title)));
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

  private sessionRow(s: SessionIndex, ambiguous = false): HTMLElement {
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
    if (ambiguous) {
      const when = document.createElement("span");
      when.className = "swhen";
      when.textContent = whenOf(s.updatedAt);
      b.append(when);
      b.title = `${s.title} · ${when.textContent}`;
    }

    /**
     * Deleting, in two touches and zero dialogs. plans/49.
     *
     * The ✕ appears on hover; the first click turns it into "Sure?" for a
     * few seconds; the second actually deletes. A dialog would be heavier
     * than the decision — but ONE click would be lighter than it, because a
     * session is its directory and deleting one is deleting everything it
     * ever wrote. Two clicks, the second one warned, is the weight of the
     * thing being done.
     */
    const del = document.createElement("span");
    del.className = "sdel";
    del.textContent = "✕";
    del.setAttribute("role", "button");
    del.setAttribute("aria-label", `Delete "${s.title}"`);
    del.title = "Delete this session — everything it wrote goes with it";
    let armed: number | undefined;
    del.addEventListener("click", (e) => {
      e.stopPropagation();                 // never also OPEN what is being deleted
      if (del.classList.contains("armed")) {
        clearTimeout(armed);
        this.onDelete(s.id);
        return;
      }
      del.classList.add("armed");
      del.textContent = "Sure?";
      armed = setTimeout(() => {
        del.classList.remove("armed");
        del.textContent = "✕";
      }, 3000) as unknown as number;
    });
    b.append(del);
    b.addEventListener("click", () => this.onPick(s.id));
    return b;
  }
}
