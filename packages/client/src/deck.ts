/**
 * The deck: one page on screen at a time, force-scroll between them.
 *
 * Force scroll means the boundary of a page is a wall you push through, not an
 * edge you fall off. Three mechanisms, each fixing a specific way the naive
 * version feels wrong:
 *
 *   DEAD ZONE. The first ~40px of over-scroll does nothing at all. Without it,
 *   a page whose content happens to end exactly at the fold flips the moment
 *   you reach the bottom, and the reader never gets to rest there.
 *
 *   RUBBER BAND. Past the dead zone the page moves, with resistance, and it is
 *   fully reversible until it commits. The reader can see a page turn starting
 *   and back out of it — which is what makes the gesture feel safe enough to
 *   use hard.
 *
 *   QUIET LOCK. After a commit, further wheel events are swallowed until the
 *   wheel goes SILENT for 140ms. Not a fixed timer: a trackpad's momentum tail
 *   keeps firing events for up to a second after your fingers lift, and a
 *   timer either cuts the lock too early (flipping three pages on one flick)
 *   or too late (eating a deliberate second push). Silence is the honest
 *   signal that the gesture ended.
 */
const DEAD = 40;          // px of over-scroll that does nothing
const COMMIT = 190;       // px of charge that turns the page
const QUIET_MS = 140;     // silence that ends a gesture
const MAX_PULL = 90;      // how far the rubber band can stretch

export interface DeckPage {
  id: string;
  /** The full-height panel. */
  root: HTMLElement;
  /** The element that scrolls internally. */
  scroller: HTMLElement;
}

export class Deck {
  private host: HTMLElement;
  private pages: DeckPage[] = [];
  private current = 0;
  private charge = 0;
  private locked = false;
  private quiet: number | undefined;
  private animating = false;
  onChange: (index: number, id: string) => void = () => {};

  constructor(host: HTMLElement) {
    this.host = host;
    host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  get index() { return this.current; }
  get count() { return this.pages.length; }
  get activeId() { return this.pages[this.current]?.id ?? null; }
  pageAt(id: string) { return this.pages.find((p) => p.id === id); }

  clear() {
    this.pages = [];
    this.current = 0;
    this.charge = 0;
    this.host.replaceChildren();
  }

  add(page: DeckPage) {
    this.pages.push(page);
    this.host.append(page.root);
    this.place();
  }

  remove(id: string) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i === -1) return;
    this.pages[i]!.root.remove();
    this.pages.splice(i, 1);
    this.current = Math.min(this.current, Math.max(0, this.pages.length - 1));
    this.place();
    this.announce();
  }

  /** Position every panel relative to the current one. */
  private place(offset = 0) {
    this.pages.forEach((p, i) => {
      const rel = i - this.current;
      p.root.style.transform = `translate3d(0, calc(${rel * 100}% + ${offset}px), 0)`;
      p.root.style.visibility = Math.abs(rel) <= 1 ? "visible" : "hidden";
      p.root.classList.toggle("is-current", rel === 0);
      p.root.setAttribute("aria-hidden", rel === 0 ? "false" : "true");
    });
  }

  goto(index: number, opts: { animate?: boolean } = {}) {
    const next = Math.max(0, Math.min(this.pages.length - 1, index));
    if (next === this.current && !this.charge) { this.place(); return; }
    this.charge = 0;
    this.current = next;
    if (opts.animate === false) {
      this.host.classList.add("no-anim");
      this.place();
      void this.host.offsetHeight;                   // flush before re-enabling
      this.host.classList.remove("no-anim");
    } else {
      this.animating = true;
      this.place();
      setTimeout(() => { this.animating = false; }, 260);
    }
    this.pages[this.current]?.scroller.scrollTo({ top: 0 });
    this.announce();
  }

  gotoId(id: string, opts?: { animate?: boolean }) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i !== -1) this.goto(i, opts ?? {});
  }

  private announce() {
    const p = this.pages[this.current];
    if (p) this.onChange(this.current, p.id);
  }

  private onKey(e: KeyboardEvent) {
    const typing = e.target instanceof HTMLElement
      && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
    if (typing) return;
    if (e.key === "PageDown") { e.preventDefault(); this.goto(this.current + 1); }
    if (e.key === "PageUp") { e.preventDefault(); this.goto(this.current - 1); }
  }

  private endGesture() {
    this.locked = false;
    if (this.charge !== 0) { this.charge = 0; this.place(); }
  }

  private onWheel(e: WheelEvent) {
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.endGesture(), QUIET_MS) as unknown as number;

    if (this.animating) { e.preventDefault(); return; }
    if (this.locked) { e.preventDefault(); return; }

    const page = this.pages[this.current];
    if (!page) return;

    const s = page.scroller;
    const down = e.deltaY > 0;
    const atTop = s.scrollTop <= 0;
    const atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 1;

    // Inside the page: let the browser scroll. Any charge built up at a
    // boundary is abandoned the moment the reader moves back into content.
    if ((down && !atBottom) || (!down && !atTop)) {
      if (this.charge !== 0) { this.charge = 0; this.place(); }
      return;
    }

    const target = this.current + (down ? 1 : -1);
    if (target < 0 || target >= this.pages.length) {
      // No neighbour. A small immovable pull says "this is the end" — better
      // than nothing happening, which reads as a broken scroll.
      e.preventDefault();
      this.charge = Math.max(-DEAD * 2, Math.min(DEAD * 2, this.charge + e.deltaY));
      this.place(-Math.sign(this.charge) * Math.min(14, Math.abs(this.charge) / 6));
      return;
    }

    e.preventDefault();
    this.charge += e.deltaY;

    const past = Math.abs(this.charge) - DEAD;
    if (past <= 0) { this.place(); return; }

    if (Math.abs(this.charge) >= COMMIT) {
      this.locked = true;                            // held until the wheel goes quiet
      this.goto(target);
      return;
    }
    // Resistance grows as you pull: sqrt keeps the start responsive and the
    // end heavy, so the commit point can be felt rather than guessed.
    const pull = Math.min(MAX_PULL, Math.sqrt(past) * 7);
    this.place(-Math.sign(this.charge) * pull);
  }
}
