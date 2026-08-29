/**
 * Browsing the reader's directories, so they can pick one to work in. plans/37.
 *
 * This exists because the browser cannot help. `showDirectoryPicker()` hands a
 * page an opaque handle, not a path, and what the sandbox needs to bind is a
 * real path on this machine. So the controller does the listing and the chrome
 * draws it.
 *
 * It reads directory NAMES and nothing else — never file contents, never sizes.
 * The reader is choosing a folder, and everything beyond its name is a detail
 * they did not ask this endpoint for.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";

/** Enough to fill a picker; a directory with more than this is not being browsed. */
const MAX_ENTRIES = 300;

/**
 * There is no shared default workspace any more. plans/45.
 *
 * There used to be one — `~/perpetual`, handed to every session at birth — and
 * one directory for every session that ever ran is the wrong shape twice over:
 * last week's work sits in the way of today's, and deleting a session leaves
 * its files behind with nothing to say whose they were.
 *
 * A session now writes in its OWN directory, inside its own record, which
 * makes every session independent by construction and takes its workspace with
 * it when it goes. See `sessionWorkspace` in shell/sandbox.ts. What the reader
 * picks here is the directory they want the work to happen in INSTEAD — a real
 * project on their disk — and anything further is granted one directory at a
 * time, by them, through `grant`.
 */

export interface DirListing {
  path: string;
  /** The parent, or null at the root — so the chrome can draw an "up". */
  parent: string | null;
  /** Directory names only, sorted, dotfiles last. */
  dirs: string[];
  /** True when this is somewhere the reader plausibly meant. */
  writable: boolean;
}

/**
 * A path we are willing to talk about.
 *
 * Confined to the home directory on purpose. The picker chooses a place to
 * WRITE, and offering to mount `/etc` or `/` writable is not a feature anyone
 * asked for — the failure mode of getting this wrong is the agent with write
 * access to the operating system.
 */
export function within(path: string): string | null {
  const home = homedir();
  const full = resolve(path.startsWith("~") ? join(home, path.slice(1)) : path);
  if (full !== home && !full.startsWith(home + sep)) return null;
  return full;
}

export async function listDirs(path?: string): Promise<DirListing | { error: string }> {
  const home = homedir();
  const full = within(path?.trim() || home);
  if (!full) {
    return { error: "A working directory has to be inside your home directory." };
  }

  let st;
  try { st = await stat(full); } catch { return { error: `There is nothing at ${full}.` }; }
  if (!st.isDirectory()) return { error: `${full} is a file, not a directory.` };

  let names: string[] = [];
  try { names = await readdir(full, { withFileTypes: true })
    .then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name)); }
  catch { return { error: `${full} cannot be read.` }; }

  names.sort((a, b) => {
    const ad = a.startsWith("."), bd = b.startsWith(".");
    if (ad !== bd) return ad ? 1 : -1;              // dotfiles last, not hidden
    return a.localeCompare(b);
  });

  return {
    path: full,
    parent: full === home ? null : dirname(full),
    dirs: names.slice(0, MAX_ENTRIES),
    writable: true,
  };
}
