/**
 * The figure sanitiser. plans/16 §4.
 *
 * THE POSTURE: this does not remove bad things from the input. It parses the
 * input and REBUILDS a new document out of only the things it recognised.
 * Anything the parser does not understand — an unknown namespace, a malformed
 * tag, an attribute not on the list — simply does not survive into the output.
 * A stripper has to anticipate every attack; a rebuilder only has to know what
 * it allows.
 *
 * A violation refuses the WHOLE figure rather than silently dropping part of
 * it. A diagram missing a chunk is worse than no diagram, and the agent gets
 * told exactly which element or attribute to fix — which it can act on.
 *
 * Two rules here are not about safety at all:
 *
 *   - A figure may name no colours (§5). This is what makes twelve
 *     agent-authored pages look like one website, and what makes a diagram
 *     invert correctly in dark mode without the agent thinking about it.
 *
 *   - Every id is rewritten to be unique per figure. Two figures on one page
 *     are inlined into the SAME document, so two `<linearGradient id="g">`
 *     would collide and the second figure would silently paint itself with the
 *     first one's gradient.
 */

export type SvgResult =
  | { ok: true; svg: string; elements: number }
  | { ok: false; error: string };

export const MAX_SVG_BYTES = 256 * 1024;
export const MAX_SVG_ELEMENTS = 4000;

const ELEMENTS = new Set([
  "svg", "g", "defs", "title", "desc", "use", "symbol",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "marker", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern",
]);

/** Elements whose text content is kept. Everywhere else, text is whitespace. */
const TEXTUAL = new Set(["text", "tspan", "textPath", "title", "desc"]);

const ATTRS = new Set([
  // geometry
  "x", "y", "width", "height", "d", "cx", "cy", "r", "rx", "ry", "points",
  "x1", "y1", "x2", "y2", "transform", "viewBox", "preserveAspectRatio", "dx", "dy",
  // paint
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "opacity", "paint-order",
  // text
  "font-family", "font-size", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "letter-spacing", "word-spacing", "textLength", "startOffset",
  // structure
  "id", "class", "marker-start", "marker-mid", "marker-end", "clip-path", "mask",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "spreadMethod", "patternUnits", "patternContentUnits", "clipPathUnits", "maskUnits",
  "refX", "refY", "markerWidth", "markerHeight", "markerUnits", "orient", "overflow",
  // references — value-checked below
  "href", "xlink:href",
]);

/** Attributes whose value must be a token, not a colour. plans/16 §5. */
const PAINT_ATTRS = new Set(["fill", "stroke", "stop-color", "color", "flood-color"]);

const TOKENS = [
  "--ink", "--ink-2", "--ink-3", "--line", "--line-2",
  "--surface", "--surface-2", "--accent", "--accent-sf", "--warn", "--warn-sf",
];
const KEYWORDS = new Set(["none", "currentColor", "transparent", "inherit"]);
const VAR_RE = new RegExp(`^var\\(\\s*(${TOKENS.join("|")})\\s*\\)$`);
const LOCAL_URL_RE = /^url\(\s*#([A-Za-z_][\w.:-]*)\s*\)$/;
const LOCAL_REF_RE = /^#([A-Za-z_][\w.:-]*)$/;
const NAME_RE = /[A-Za-z_][\w.:-]*/y;

interface El { name: string; attrs: [string, string][]; children: (El | string)[] }

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;");

/** Undo the entity forms a well-formed document may legitimately contain. */
const unesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
   .replace(/&amp;/g, "&");

class Refused extends Error {}

// Declared, not assigned to a const: TypeScript only narrows control flow
// after a `never`-returning call when it is a function declaration.
function refuse(m: string): never { throw new Refused(m); }

/**
 * Parse into a tree, refusing anything unrecognised on the way through.
 * Deliberately strict: unquoted attribute values, stray `<`, and unbalanced
 * tags are all refusals rather than best-effort recoveries, because a
 * best-effort recovery of a hostile document is where sanitisers get bypassed.
 */
function parse(src: string): El {
  let i = 0;
  let count = 0;
  const stack: El[] = [];
  let root: El | undefined;

  const push = (el: El) => {
    if (++count > MAX_SVG_ELEMENTS) {
      refuse(`more than ${MAX_SVG_ELEMENTS} elements. Simplify the drawing or generate fewer of them.`);
    }
    if (stack.length) stack[stack.length - 1]!.children.push(el);
    else if (root) refuse("more than one root element. A figure is one <svg>.");
    else root = el;
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    i = lt;

    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end === -1) refuse("an unterminated comment.");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {                    // <?xml … ?>
      const end = src.indexOf("?>", i);
      if (end === -1) refuse("an unterminated processing instruction.");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      // DOCTYPE, ENTITY, CDATA. Entity declarations are the billion-laughs
      // vector and nothing legitimate needs them in a figure.
      refuse("a DOCTYPE, CDATA or ENTITY declaration. Figures are plain SVG markup.");
    }
    if (src.startsWith("</", i)) {
      i += 2;
      const name = readName(src, i);
      i += name.length;
      i = skipTo(src, i, ">") + 1;
      const open = stack.pop();
      if (!open) refuse(`a closing </${name}> with nothing open.`);
      if (open.name !== name) refuse(`</${name}> where </${open.name}> was expected.`);
      continue;
    }

    // An opening tag.
    i += 1;
    const name = readName(src, i);
    if (!name) refuse("a stray `<`. Escape it as &lt; if it is text.");
    i += name.length;
    if (!ELEMENTS.has(name)) {
      refuse(`<${name}> is not allowed in a figure. ` +
        (name === "script" || name === "style"
          ? "Figures are drawings, not documents — no scripts and no CSS."
          : name === "foreignObject"
            ? "Use <text> and <tspan> for labels."
            : name === "image"
              ? "Figures cannot load external files. Draw it with paths and shapes."
              : `Allowed: ${[...ELEMENTS].join(", ")}.`));
    }

    const el: El = { name, attrs: [], children: [] };
    for (;;) {
      i = skipWs(src, i);
      if (src.startsWith("/>", i)) { push(el); i += 2; break; }
      if (src[i] === ">") { push(el); stack.push(el); i += 1; break; }
      if (i >= src.length) refuse(`an unterminated <${name}> tag.`);

      const attr = readName(src, i);
      if (!attr) refuse(`something unreadable inside the <${name}> tag.`);
      i += attr.length;
      i = skipWs(src, i);
      if (src[i] !== "=") refuse(`attribute \`${attr}\` on <${name}> has no value.`);
      i = skipWs(src, i + 1);
      const quote = src[i];
      if (quote !== '"' && quote !== "'") {
        refuse(`the value of \`${attr}\` on <${name}> is not quoted.`);
      }
      const end = src.indexOf(quote, i + 1);
      if (end === -1) refuse(`an unterminated value for \`${attr}\` on <${name}>.`);
      el.attrs.push([attr, unesc(src.slice(i + 1, end))]);
      i = end + 1;
    }
  }

  if (stack.length) refuse(`<${stack[stack.length - 1]!.name}> is never closed.`);
  if (!root) refuse("no <svg> element.");
  return root;

  function text(raw: string) {
    if (!raw.trim()) return;
    const host = stack[stack.length - 1];
    if (!host) refuse("text outside the <svg> element.");
    if (!TEXTUAL.has(host.name)) return;      // whitespace and stray labels: dropped
    host.children.push(unesc(raw));
  }
}

const skipWs = (s: string, i: number) => { while (i < s.length && /\s/.test(s[i]!)) i++; return i; };
const skipTo = (s: string, i: number, ch: string) => {
  const at = s.indexOf(ch, i);
  return at === -1 ? refuse(`an unterminated tag.`) : at;
};
function readName(s: string, i: number): string {
  NAME_RE.lastIndex = i;
  return NAME_RE.exec(s)?.[0] ?? "";
}

/** Check a paint value against the token palette. plans/16 §5. */
function checkPaint(attr: string, value: string, el: string): string {
  const v = value.trim();
  if (KEYWORDS.has(v) || VAR_RE.test(v)) return v;
  if (LOCAL_URL_RE.test(v)) return v;            // gradient / pattern reference
  refuse(
    `${attr}="${value}" on <${el}> names a colour. Figures may not — the site's ` +
    "palette has to hold across every page and both themes. Use currentColor, " +
    `or one of: ${TOKENS.map((t) => `var(${t})`).join(", ")}.`,
  );
}

/** Rebuild from the allowlist, rewriting ids so two figures cannot collide. */
function build(el: El, idPrefix: string, isRoot: boolean): string {
  const attrs: string[] = [];

  for (const [rawName, rawValue] of el.attrs) {
    const name = rawName === "xlink:href" ? "href" : rawName;

    // Author sizing is discarded: the client owns how big a figure is drawn.
    if (isRoot && (name === "width" || name === "height")) continue;
    if (name.startsWith("on")) {
      refuse(`\`${rawName}\` on <${el.name}> is an event handler. Figures do not run code.`);
    }
    if (name === "xmlns" || name === "xmlns:xlink" || name === "version") continue;
    if (!ATTRS.has(name)) {
      refuse(`\`${rawName}\` on <${el.name}> is not an allowed attribute.`);
    }

    let value = rawValue;
    if (PAINT_ATTRS.has(name)) value = checkPaint(name, value, el.name);

    if (name === "id") {
      value = `${idPrefix}-${value}`;
    } else if (name === "href") {
      const m = LOCAL_REF_RE.exec(value.trim());
      if (!m) {
        refuse(`href="${value}" on <${el.name}> points outside the figure. ` +
          "Only local references like href=\"#arrowhead\" are allowed.");
      }
      value = `#${idPrefix}-${m[1]}`;
    } else {
      const m = LOCAL_URL_RE.exec(value.trim());
      if (m) value = `url(#${idPrefix}-${m[1]})`;
    }

    attrs.push(`${name}="${esc(value)}"`);
  }

  const open = `<${el.name}${attrs.length ? " " + attrs.join(" ") : ""}`;
  if (el.children.length === 0) return `${open}/>`;
  const inner = el.children
    .map((c) => (typeof c === "string" ? esc(c) : build(c, idPrefix, false)))
    .join("");
  return `${open}>${inner}</${el.name}>`;
}

function countEls(el: El): number {
  return 1 + el.children.reduce<number>((n, c) => n + (typeof c === "string" ? 0 : countEls(c)), 0);
}

/**
 * @param idPrefix must be unique per figure within a page — the sanitised SVGs
 *                 are inlined into one document and share an id namespace.
 */
export function sanitizeSvg(input: string, idPrefix: string): SvgResult {
  try {
    const bytes = Buffer.byteLength(input);
    if (bytes > MAX_SVG_BYTES) {
      refuse(`${Math.round(bytes / 1024)}KB exceeds the ${MAX_SVG_BYTES / 1024}KB limit. ` +
        "Simplify the paths or generate fewer elements.");
    }
    const root = parse(input);
    if (root.name !== "svg") refuse(`the root element is <${root.name}>, not <svg>.`);

    const viewBox = root.attrs.find(([k]) => k === "viewBox")?.[1];
    if (!viewBox || !/^\s*-?[\d.]+([\s,]+-?[\d.]+){3}\s*$/.test(viewBox)) {
      refuse("the root <svg> needs a valid viewBox, e.g. viewBox=\"0 0 600 320\". " +
        "Without one the figure cannot be sized to the page.");
    }

    return { ok: true, svg: build(root, idPrefix, true), elements: countEls(root) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    return { ok: false, error: `could not be parsed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
