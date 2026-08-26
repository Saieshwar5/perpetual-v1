/**
 * What the agent is doing, in the reader's words.
 *
 * The composer used to print the shell command itself — `cat >> ui/pages/003-x/
 * page.ndjson <<'EOF'` — which is the implementation, not the work. It leaks
 * the architecture at exactly the moment the reader wants reassurance, and it
 * asks someone who came here to read about margins to parse bash.
 *
 * So the command is classified into an activity. Two rules the wording obeys:
 *
 *   NEVER INVENT PROGRESS. "Writing" and not "50% done" — the harness has no
 *   idea how far along a turn is, and a progress bar that lies is worse than
 *   no progress bar. The honest progress indicator already exists and is
 *   better than any of this: the page assembles block by block on screen.
 *
 *   KEEP THE TRUTH REACHABLE. The raw command stays one click away. When
 *   something goes wrong it is the only thing that explains it, so it is
 *   hidden by default and never deleted.
 */
export interface Activity {
  /** What is happening, in one word the reader already knows. */
  verb: string;
  /** The page it is happening to, when the command names one. */
  page?: string;
}

/** `ui/pages/003-margins/page.ndjson` and `page set 003-margins …` both name a page. */
const PAGE_IN_PATH = /ui\/pages\/(\d{3,}-[a-z0-9][a-z0-9-]*)/;
const PAGE_IN_TOOL = /\bpage\s+(?:ls|set|after|before|rm|move|split)\s+(\d{3,}-[a-z0-9][a-z0-9-]*)/;

/**
 * First match wins, and the order is by INTENT rather than by how the command
 * looks. A turn that writes a page also reads a directory first; what the
 * reader wants to know is that a page is being written.
 */
export function describeCommand(command: string): Activity {
  const c = command.trim();
  const page = PAGE_IN_TOOL.exec(c)?.[1] ?? PAGE_IN_PATH.exec(c)?.[1];
  const at = (verb: string): Activity => (page ? { verb, page } : { verb });

  // Editing an existing page, which is a different thing from writing one.
  if (/(^|[\s;&|(])page\s+split\b/.test(c)) return at("Splitting");
  if (/(^|[\s;&|(])page\s+(set|after|before|rm|move)\b/.test(c)) return at("Revising");

  // Drawing. Checked before "running a script", because a script that produces
  // an SVG is a figure being drawn — that is what the reader is waiting for.
  if (/\.svg\b/.test(c)) return at("Drawing");
  if (/\b(python3?|node)\b/.test(c)) return at("Computing");

  // Writing. A new page starts with a directory and its meta.
  if (/mkdir[^\n]*ui\/pages/.test(c)) return at("Starting");
  if (/>\s*\S*meta\.json/.test(c)) return at("Naming");
  if (/>>?\s*\S*page\.ndjson/.test(c)) return at("Writing");

  // Reading. Last, so that a command which reads AND writes counts as writing.
  if (/^(ls|cat|head|tail|find|grep|rg|wc|stat|du|sed -n)\b/.test(c)) return at("Reading");

  return at("Working");
}

/**
 * The activity as one line, with the page's own title rather than its id.
 *
 * `003-margins` is a filename; "Margins held at 38%" is what the reader is
 * looking at. The resolver is passed in because the client owns the pages and
 * this file should not.
 */
export function activityLine(
  a: Activity, titleOf: (page: string) => string | undefined,
): string {
  const title = a.page ? titleOf(a.page) : undefined;
  if (!title) return a.verb;
  const short = title.length > 38 ? `${title.slice(0, 37)}…` : title;
  return `${a.verb} “${short}”`;
}
