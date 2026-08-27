/**
 * The flow: one continuous scroll, made of sections.
 *
 * This replaces the deck — one page on screen at a time, force-scrolled
 * between — and the reason is the whole of the routing problem.
 *
 * A deck asks a question on every turn that nothing can answer reliably: WHICH
 * ROOM does this answer belong in? The agent had to judge it from prose, the
 * judgement was invisible until it was wrong, and a wrong one left the answer
 * in a room the reader had to hunt for. A flow does not ask. Sections stack in
 * the order they were written, and the only two moves left are "add one at the
 * end" and "change the one they are pointing at" — neither of which is a guess.
 *
 * What the file still owns is everything the deck owned APART from movement:
 * which section the reader is in (so a question can anchor to it), whether they
 * have reached the end of the site (so the composer can grow), and the jump
 * that the rail and a `link` block perform.
 *
 * The host — `#site` in the markup — scrolls; sections are plain blocks inside
 * it. There is no transform, no charge, no lock, no rubber band: a scroll is a
 * scroll, and every gesture the reader's browser already knows works unchanged.
 */
export interface FlowSection {
  id: string;
  /** The section's root element. Laid out in normal flow inside the host. */
  root: HTMLElement;
}

/** How close to the bottom still counts as the end of the site. */
const END_SLACK = 24;

export class Flow {
  private host: HTMLElement;
  private sections: FlowSection[] = [];
  private current = 0;
  /** Set while a programmatic scroll is in flight, so it cannot fight the reader. */
  private jumping: number | undefined;
  onChange: (index: number, id: string) => void = () => {};
  /** Fires on every scroll, settled or not — the composer sizes itself from it. */
  onScroll: () => void = () => {};

  /**
   * The site changing height without anyone scrolling.
   *
   * A figure finishing its layout, a webfont landing, a block arriving — each
   * makes the scroll taller, and "is the reader at the end of it?" was only
   * ever re-asked on a scroll event. So the composer could sit full-size at a
   * foot that had moved a screen further down, and `atend` styling stayed on a
   * site that was no longer at its end.
   */
  private grew: ResizeObserver | undefined;
  /**
   * Was the reader at the foot of the site when it last moved?
   *
   * If they were, they stay there when it grows — the same rule a terminal or
   * a chat uses. If they had scrolled up to read something, nothing moves
   * them: growth below where you are reading is not a reason to be taken
   * somewhere else.
   */
  private pinned = true;

  constructor(host: HTMLElement) {
    this.host = host;
    host.addEventListener("scroll", () => this.onHostScroll(), { passive: true });
    window.addEventListener("keydown", (e) => this.onKey(e));
    if (typeof ResizeObserver !== "undefined") {
      this.grew = new ResizeObserver(() => {
        if (this.pinned) this.host.scrollTo({ top: this.host.scrollHeight, behavior: "instant" });
        this.onScroll();
      });
    }
  }

  get index() { return this.current; }
  get count() { return this.sections.length; }
  get activeId() { return this.sections[this.current]?.id ?? null; }
  get element() { return this.host; }

  /**
   * Has the reader run out of website?
   *
   * The one thing the composer needs to know, and in a flow it is a single
   * question about a single scroller rather than "last page AND at its bottom".
   */
  get atEnd() {
    return this.host.scrollTop + this.host.clientHeight >= this.host.scrollHeight - END_SLACK;
  }

  clear() {
    this.sections = [];
    this.current = 0;
    this.grew?.disconnect();
    this.host.replaceChildren();
  }

  add(section: FlowSection) {
    this.sections.push(section);
    this.host.append(section.root);
    this.grew?.observe(section.root);
    if (this.sections.length === 1) this.announce();
  }

  remove(id: string) {
    const i = this.sections.findIndex((s) => s.id === id);
    if (i === -1) return;
    this.grew?.unobserve(this.sections[i]!.root);
    this.sections[i]!.root.remove();
    this.sections.splice(i, 1);
    this.current = Math.min(this.current, Math.max(0, this.sections.length - 1));
    this.announce();
  }

  /**
   * Bring a section to the top of the view.
   *
   * `animate: false` is an instant jump, for opening a session at its newest
   * section: a smooth scroll through nine sections of a site the reader has not
   * seen yet is a second of scenery on the way to where they asked to be.
   *
   * "instant", never "auto". `behavior: "auto"` does not mean "jump" — it means
   * "do whatever CSS says", and CSS here says `scroll-behavior: smooth`. Every
   * jump that was supposed to be instant was quietly animating: the session
   * opened halfway up its own site, and a section streaming in tried to glide
   * once per arriving block.
   */
  goto(index: number, opts: { animate?: boolean } = {}) {
    const next = Math.max(0, Math.min(this.sections.length - 1, index));
    const section = this.sections[next];
    if (!section) return;
    this.current = next;
    // Going somewhere specific is the opposite of following the foot.
    this.pinned = false;
    this.host.scrollTo({
      top: section.root.offsetTop,
      behavior: opts.animate === false ? "instant" : "smooth",
    });
    // Whatever the scroll handler concludes on the way there, the destination
    // is what the reader asked for.
    clearTimeout(this.jumping);
    this.jumping = setTimeout(() => { this.jumping = undefined; }, 420) as unknown as number;
    this.announce();
  }

  gotoId(id: string, opts?: { animate?: boolean }) {
    const i = this.sections.findIndex((s) => s.id === id);
    if (i !== -1) this.goto(i, opts ?? {});
  }

  /** Straight to the foot of the site — where a new section has just landed. */
  toEnd(opts: { animate?: boolean } = {}) {
    this.pinned = true;
    this.host.scrollTo({
      top: this.host.scrollHeight,
      behavior: opts.animate === false ? "instant" : "smooth",
    });
    this.current = Math.max(0, this.sections.length - 1);
    this.announce();
  }

  /**
   * Which section the reader is in: the one under the middle of the view.
   *
   * The middle rather than the top, because a section boundary crossing the top
   * edge changes the answer while the reader is still reading the section
   * above it — and this answer is what a question with no explicit aim gets
   * attached to.
   */
  private sectionAtMiddle(): number {
    const mid = this.host.scrollTop + this.host.clientHeight / 2;
    let best = 0;
    for (const [i, s] of this.sections.entries()) {
      if (s.root.offsetTop <= mid) best = i; else break;
    }
    return best;
  }

  private onHostScroll() {
    this.pinned = this.atEnd;
    this.onScroll();
    if (this.jumping) return;
    const i = this.sectionAtMiddle();
    if (i === this.current) return;
    this.current = i;
    this.announce();
  }

  private announce() {
    // The section the reader is in is marked, as it was in the deck. Nothing in
    // the stylesheet leans on it — it is a handle: for the probes in `tools/`,
    // and for anything that needs to ask the DOM where the reader is without
    // going through this class.
    for (const [i, s] of this.sections.entries()) {
      s.root.classList.toggle("is-current", i === this.current);
    }
    const s = this.sections[this.current];
    if (s) this.onChange(this.current, s.id);
  }

  /**
   * PageUp/PageDown move by SECTION rather than by screen.
   *
   * The browser would scroll a viewport-ful, which in a flow is an arbitrary
   * distance that usually lands mid-paragraph. Section-to-section is the
   * movement the site is made of, and it is what these keys meant on the deck.
   */
  private onKey(e: KeyboardEvent) {
    const typing = e.target instanceof HTMLElement
      && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
    if (typing) return;
    if (e.key === "PageDown") { e.preventDefault(); this.goto(this.sectionAtMiddle() + 1); }
    if (e.key === "PageUp") { e.preventDefault(); this.goto(this.sectionAtMiddle() - 1); }
  }
}
