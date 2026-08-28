/**
 * Tool adapters — what a CLI is, and what its UI should look like.
 *
 * The agent knows how to build a page. It does not know `git log`'s flags, or
 * which of a mail client's twelve fields belong on a row, or that a count of
 * unread messages wants a sentence rather than a whole workspace. Left to
 * improvise it will get there, differently every session — and an inbox that
 * looks different on Tuesday than it did on Monday is a demo, not a product.
 *
 * So a tool brings its own instructions:
 *
 *   adapters/<name>/tool.md     frontmatter manifest + the UI recipe
 *   adapters/<name>/bin/…       optional scripts, on the agent's PATH
 *
 * Read ON DEMAND, never injected. The turn message carries one line naming the
 * tools that exist; the recipe itself is a file the agent reads when it uses
 * one. Twenty adapters cost the same as none until one is needed.
 *
 * TWO SOURCES. The built-ins ship with the product; a user directory adds to
 * them and wins on a name clash, because the point of a standard is that
 * someone else can write one. Neither is writable from inside the sandbox: an
 * adapter is configuration, and configuration the agent can edit is not
 * configuration.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Where built-in adapters live, and where they appear inside the sandbox. */
export const ADAPTERS_MOUNT = "/opt/perpetual/tools";
export const LOCAL_MOUNT = "/opt/perpetual/tools.local";
export const adaptersDir = () =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "adapters");

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Where an answer from this tool usually belongs.
 *
 * A DEFAULT, not a rule, and the distinction matters. "Show me my mail" wants
 * a workspace; "how many unread do I have" wants one sentence — same tool,
 * different answers. A static list of which tools get a UI would be wrong
 * about half of them and could not be fixed by editing the list. So the
 * manifest says what the tool is usually shaped like, the recipe says when not
 * to, and the request decides.
 */
export type Surface = "workspace" | "page" | "either";

export interface Adapter {
  name: string;
  title: string;
  surface: Surface;
  /** One line, for the index the agent is given every turn. */
  summary: string;
  /** Capabilities this needs before it can work. Granted by the reader, never asked for. */
  needs: string[];
  /** A command that proves the tool is present and behaving. */
  check?: string;
  /** Where the agent will find it: a path inside the sandbox. */
  path: string;
  /** Where it is on this machine. */
  dir: string;
  /** True when it came from the user's own directory rather than the repo. */
  local: boolean;
  /** Does it ship scripts to put on the PATH? */
  hasBin: boolean;
  /**
   * Why this tool cannot work right now, if it cannot.
   *
   * Set by the server once it knows what is actually configured. A tool that
   * needs something absent is still LISTED, carrying its reason: silently
   * dropping it would make a misconfigured tool look exactly like one that was
   * never installed, which is the failure this whole registry exists to make
   * loud (plans/15 rule 2 — never a silent downgrade).
   */
  unavailable?: string;
}

export interface AdapterProblem { name: string; message: string }

/**
 * A deliberately small frontmatter reader: `key: value` and `key: [a, b]`.
 *
 * No YAML dependency for six scalar fields. Anything a real YAML parser would
 * accept and this would not — anchors, nesting, block scalars — is something a
 * manifest should not contain: the moment a manifest needs a parser, it has
 * stopped being a manifest.
 */
export function frontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const meta: Record<string, string | string[]> = {};
  if (!text.startsWith("---")) return { meta, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta, body: text };

  for (const line of text.slice(3, end).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf(":");
    if (at === -1) continue;
    const key = t.slice(0, at).trim();
    let raw = t.slice(at + 1).trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      meta[key] = raw.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
      continue;
    }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    meta[key] = raw;
  }
  // `\n---` consumed above; the body starts after that line.
  const nl = text.indexOf("\n", end + 1);
  return { meta, body: nl === -1 ? "" : text.slice(nl + 1) };
}

async function readAdapter(dir: string, name: string, mount: string, local: boolean): Promise<
  { adapter: Adapter } | { problem: AdapterProblem }
> {
  let text: string;
  try { text = await readFile(join(dir, "tool.md"), "utf8"); }
  catch {
    return { problem: { name, message: "has no tool.md, so nothing says what it is." } };
  }

  const { meta } = frontmatter(text);
  const str = (k: string) => (typeof meta[k] === "string" ? meta[k] : undefined);

  const surface = str("surface") ?? "either";
  if (!["workspace", "page", "either"].includes(surface)) {
    return {
      problem: {
        name,
        message: `surface is "${surface}". It is one of workspace, page, either — where ` +
                 "an answer from this tool usually belongs.",
      },
    };
  }
  const summary = str("summary");
  if (!summary) {
    return {
      problem: { name, message: "has no `summary`. It is the one line the agent is given " +
        "every turn, and without it nobody knows this tool is worth reading about." },
    };
  }

  let hasBin = false;
  try { hasBin = (await stat(join(dir, "bin"))).isDirectory(); } catch { /* none */ }

  return {
    adapter: {
      name,
      title: str("title") ?? name,
      surface: surface as Surface,
      summary,
      needs: Array.isArray(meta.needs) ? meta.needs : [],
      ...(str("check") ? { check: str("check")! } : {}),
      path: `${mount}/${name}`,
      dir,
      local,
      hasBin,
    },
  };
}

async function readDir(dir: string, mount: string, local: boolean) {
  const adapters: Adapter[] = [];
  const problems: AdapterProblem[] = [];
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return { adapters, problems }; }

  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    if (!NAME_RE.test(name)) {
      problems.push({
        name,
        message: `"${name}" is not a usable tool name. Lowercase letters, digits and dashes.`,
      });
      continue;
    }
    try { if (!(await stat(join(dir, name))).isDirectory()) continue; } catch { continue; }
    const r = await readAdapter(join(dir, name), name, mount, local);
    if ("adapter" in r) adapters.push(r.adapter); else problems.push(r.problem);
  }
  return { adapters, problems };
}

/**
 * Everything installed, the user's own winning a name clash.
 *
 * @param localDir the reader's own adapter directory, if they have one
 */
export async function readAdapters(localDir?: string): Promise<{
  adapters: Adapter[]; problems: AdapterProblem[];
}> {
  const built = await readDir(adaptersDir(), ADAPTERS_MOUNT, false);
  const mine = localDir ? await readDir(localDir, LOCAL_MOUNT, true) : { adapters: [], problems: [] };

  const byName = new Map<string, Adapter>();
  for (const a of built.adapters) byName.set(a.name, a);
  for (const a of mine.adapters) byName.set(a.name, a);   // yours wins

  return {
    adapters: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems: [...built.problems, ...mine.problems],
  };
}

/**
 * The one line the agent gets every turn.
 *
 * Names and shapes only — never the recipes. The whole point of a recipe on
 * disk is that it costs nothing until it is read, and a turn message that
 * carried them would put every tool's instructions in every conversation.
 */
export function describeAdapters(adapters: Adapter[]): string | null {
  if (!adapters.length) return null;
  const list = adapters
    .map((a) => `  ${a.name} (${a.surface}) — ${a.summary}${
      a.unavailable ? `  [UNAVAILABLE: ${a.unavailable}]`
        : a.needs.length ? `  [needs ${a.needs.join(", ")}]` : ""}`)
    .join("\n");
  return `\nTools installed here:\n${list}\n` +
    "Before using one, read its recipe — `cat " +
    `${adapters[0]!.path}/tool.md\` — which says how to run it and what its UI ` +
    "should look like. Its `bin/` is already on your PATH.";
}
