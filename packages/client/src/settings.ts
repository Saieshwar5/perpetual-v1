/**
 * Reader settings. plans/17 §3.
 *
 * Three dials — theme, type size, page width — and they are CHROME. The agent
 * never renders a control, never picks a colour, never sets a size. What
 * changes here is that the reader gains a dial the agent cannot see, which is
 * the two-zone boundary working exactly as it does everywhere else.
 *
 * Three dials and no more, deliberately. The ambition is "the reader can make
 * this comfortable", not "the reader can redesign it" — anything the agent
 * legitimately controls (the layout mode, which blocks appear) stays out.
 */
export type Theme = "system" | "light" | "dark";
export type TypeScale = "small" | "normal" | "large" | "larger";
export type Measure = "normal" | "wide";
/**
 * Provisional. Columns should simply be right, and a dial for them is an
 * admission that they might not be — it exists so the same page can be judged
 * both ways, and should come out once it has been.
 */
export type Columns = "auto" | "off";

export interface Settings {
  theme: Theme; type: TypeScale; measure: Measure; columns: Columns;
}

const KEY = "perpetual.settings";
const DEFAULTS: Settings = {
  theme: "system", type: "normal", measure: "normal", columns: "auto",
};

const TYPE_SCALE: Record<TypeScale, string> = {
  small: ".92", normal: "1", large: "1.12", larger: "1.26",
};
// The page's outer cap — text, figures and the composer all sit inside it, so
// this one number is the width of everything. In rem, not ch: `ch` resolves
// against the element's own font size, so the same value would mean one width
// on the container and another on a paragraph.
const PAGE: Record<Measure, string> = { normal: "54rem", wide: "64rem" };

/** A private window can throw on access; a settings failure must never take
 *  the page down, so every read and write is guarded. */
export function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}

export function save(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* nothing to do */ }
}

export function apply(s: Settings) {
  const root = document.documentElement;
  // "system" means no stamp at all — the media query decides, which is the
  // un-stamped state the stylesheet is written around.
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  root.style.setProperty("--type", TYPE_SCALE[s.type] ?? "1");
  root.style.setProperty("--page-base", PAGE[s.measure] ?? "54rem");
}

/** Wire the popover. Returns nothing: settings are self-contained. */
/**
 * @param onToggle lets the caller hold the rail open while the panel is up —
 *                 the button lives inside a strip that expands on hover, so
 *                 without this the panel's anchor moves out from under it the
 *                 moment the pointer leaves.
 */
export function mountSettings(
  button: HTMLElement, panel: HTMLElement,
  onToggle: (open: boolean) => void = () => {},
  onChange: (s: Settings) => void = () => {},
) {
  let current = load();
  apply(current);

  const paint = () => {
    for (const seg of panel.querySelectorAll<HTMLElement>(".seg")) {
      const key = seg.dataset.key as keyof Settings;
      for (const b of seg.querySelectorAll<HTMLButtonElement>("button")) {
        b.classList.toggle("on", b.dataset.v === current[key]);
        b.setAttribute("aria-pressed", String(b.dataset.v === current[key]));
      }
    }
  };

  panel.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
    const seg = b?.closest<HTMLElement>(".seg");
    if (!b || !seg) return;
    current = { ...current, [seg.dataset.key as keyof Settings]: b.dataset.v } as Settings;
    apply(current);
    save(current);
    paint();
    // Type size and measure change how much fits, so the layout decision has
    // to be made again.
    onChange(current);
  });

  const close = () => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    onToggle(false);
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
    onToggle(!panel.hidden);
    if (!panel.hidden) paint();
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node)) close();
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  paint();
  return () => current;
}
