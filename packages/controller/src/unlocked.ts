/**
 * The escape hatch: a host CLI in the sandbox, with a credential. plans/36.
 *
 * Plan 35 put gws OUTSIDE the sandbox behind a four-verb table, because the
 * product should not hand a model a mailbox. That is still right for the
 * product. But we do not yet know what the product should DO with a mailbox,
 * and a verb table written from imagination will be wrong. The cheapest way to
 * write a right one is to let the agent use the real CLI and watch what it
 * reaches for.
 *
 * So: a switch. And the switch is honest about what it does — while it is on
 * there is NO ENFORCEMENT LEFT. Not weakened, absent. The agent can send,
 * reply, delete and label, and it can do those things because a message it read
 * told it to. All four of plan 35's defences are bypassed at once, which is
 * what "full access" means.
 *
 * What this file does is make that bounded and VISIBLE, rather than softer:
 *
 *   NAMED, NOT BOOLEAN. `PERPETUAL_UNLOCKED=gws`, so the next one of these has
 *   to be named too and cannot arrive as a side effect of this one.
 *
 *   ITS OWN CREDENTIAL. Never ~/.config/gws — a separate grant, made with
 *   `--services gmail`, so Drive and cloud-platform stay out even here, and so
 *   revoking it is one entry rather than a whole Google account.
 *
 *   A REFUSAL, NEVER A DOWNGRADE. If the switch is on and the credential is
 *   missing, the server does not start. A session that quietly fell back to
 *   locked is one where the test results mean nothing.
 */
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Unlocked } from "./shell/sandbox.ts";

/** The credential this switch uses. Deliberately not ~/.config/gws. */
export const TEST_PROFILE = join(homedir(), ".config", "perpetual", "gws-test");

export const UNLOCK_SETUP =
  `PERPETUAL_UNLOCKED=gws needs a credential of its own at ${TEST_PROFILE}.\n` +
  "Make one — and consider a throwaway Google account rather than your own,\n" +
  "because in this mode the agent can send and delete mail, and the refresh\n" +
  "token is readable from inside the sandbox:\n\n" +
  `    GOOGLE_WORKSPACE_CLI_CONFIG_DIR=${TEST_PROFILE} \\\n` +
  "      gws auth login --services gmail\n\n" +
  "`--services gmail` on purpose: full read AND write on mail, which is the\n" +
  "point, but no Drive and no cloud-platform. Revoke it at\n" +
  "myaccount.google.com/permissions when the testing is done.";

/** ELF magic. The node shim is a script; the thing worth mounting is a binary. */
async function isBinary(path: string): Promise<boolean> {
  try {
    const fh = await readFile(path, { encoding: null });
    return fh.length > 4 && fh[0] === 0x7f && fh[1] === 0x45 && fh[2] === 0x4c && fh[3] === 0x46;
  } catch { return false; }
}

const which = (name: string) => new Promise<string | null>((done) => {
  execFile("which", [name], (err, out) => done(err ? null : out.trim() || null));
});

/**
 * Find the real gws.
 *
 * What is on the PATH is a node shim that spawns a platform binary beside it.
 * Mounting the shim would mean mounting a node runtime and a package tree; the
 * binary needs only libc, libm and libgcc, all of which are already in the
 * read-only /usr the sandbox mounts. So it is one file and nothing else.
 */
export async function findGws(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const named = env.PERPETUAL_GWS_BIN;
  if (named) return (await isBinary(named)) ? named : null;

  const found = await which("gws");
  if (!found) return null;
  const real = await realpath(found).catch(() => found);
  if (await isBinary(real)) return real;

  // The shim case: …/@googleworkspace/cli/run.js → …/cli/bin/gws
  const beside = join(dirname(real), "bin", "gws");
  return (await isBinary(beside)) ? beside : null;
}

export type Unlock =
  | { unlocked: Unlocked }
  | { error: string }
  | null;                      // locked, which is the default and not a problem

/**
 * Read the switch. `null` means locked — the normal case, and silent.
 *
 * Note what is NOT here: nothing turns on the network. gws is useless without
 * it, and it still takes its own `PERPETUAL_NET=1`, because a tool switch that
 * quietly opened the network would be the kind of implication plans/21 §5 rule
 * 3 exists to forbid.
 */
export async function resolveUnlocked(env: NodeJS.ProcessEnv = process.env): Promise<Unlock> {
  const asked = (env.PERPETUAL_UNLOCKED ?? "").trim();
  if (!asked) return null;
  if (asked !== "gws") {
    return { error: `PERPETUAL_UNLOCKED=${asked} means nothing. The only thing this ` +
      "server knows how to unlock is `gws`." };
  }

  const bin = await findGws(env);
  if (!bin) {
    return { error: "PERPETUAL_UNLOCKED=gws, but no gws binary was found. Install the " +
      "Google Workspace CLI, or name the binary with PERPETUAL_GWS_BIN." };
  }

  const configDir = env.PERPETUAL_GWS_TEST_DIR ?? TEST_PROFILE;
  const ok = await stat(configDir).then((s) => s.isDirectory(), () => false);
  if (!ok) return { error: UNLOCK_SETUP };

  return { unlocked: { what: "gws", bin, configDir } };
}

/** The several lines that go on the terminal. Not a word in a status line. */
export function unlockBanner(u: Unlocked, net: boolean): string {
  return [
    "",
    "  ╭─────────────────────────────────────────────────────────────╮",
    "  │  GWS UNLOCKED — this session has full access to a mailbox   │",
    "  ╰─────────────────────────────────────────────────────────────╯",
    `    binary      ${u.bin}`,
    `    credential  ${u.configDir}`,
    `    network     ${net ? "ON" : "OFF — gws cannot reach Google. Set PERPETUAL_NET=1."}`,
    "",
    "    The agent can send, reply to and delete mail in this session, and",
    "    a message it reads can talk it into doing so. Every gws command is",
    "    journaled to ui/requests/ — that is a record, not a gate.",
    "",
    "    Revoke at myaccount.google.com/permissions when you are done.",
    "",
  ].join("\n");
}
