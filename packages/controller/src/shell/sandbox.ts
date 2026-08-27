/**
 * The sandbox. plans/15 §5.
 *
 * The agent's only tool is a shell, so containment cannot be done by checking
 * paths in tool arguments — you cannot string-match your way to containing
 * bash. It has to be done by the kernel. bubblewrap gives unprivileged
 * namespaces with no daemon, no image, and about a millisecond of overhead.
 *
 * The shape of the answer: the session's `site/` directory is bind-mounted at
 * /session and is the ONLY writable path. Everything else is read-only or
 * simply absent from the namespace — `~/.ssh` is not protected, it does not
 * exist. Network is off unless the session was granted it.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 *   1. The escape hatch lives in HARNESS CONFIG, never in the tool schema.
 *      The model must not be able to ask its way out of the sandbox.
 *   2. A missing bwrap is a REFUSAL, not a silent downgrade. Otherwise
 *      "unsandboxed" quietly becomes the default on the first machine that
 *      lacks it, which is exactly the machine where it matters.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the session directory appears from inside the sandbox. */
export const MOUNT = "/session";

/**
 * Where the agent's own programs appear, and where they come from.
 *
 * NOT a second tool. The agent still has exactly one — the shell — and this is
 * a directory on its PATH, the way /usr/bin already is. The distinction
 * matters: a tool is something the model calls through the schema and can
 * therefore be argued into misusing; a program is something it runs, which
 * fails with a message and an exit code like everything else in a shell.
 *
 * Read-only, and outside the one writable path, so the agent cannot rewrite
 * the program that edits its pages.
 */
export const TOOLS_MOUNT = "/opt/perpetual/bin";
export const toolsDir = () =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sandbox-bin");

export interface SandboxConfig {
  /** Real path to the session's `site/` directory. */
  root: string;
  /** Grant network access to this session. Off by default. */
  net: boolean;
  /** Set by PERPETUAL_UNSAFE=1. Development only; never a fallback. */
  unsafe: boolean;
  /**
   * Section ids that are PUBLISHED, and therefore read-only for this turn.
   *
   * The agent may add to the site forever and may never unwrite it. That rule
   * cannot live in the prompt: the scorecard caught the model running `sed -i`
   * on a page file and writing its own Python editor when it lacked a tool, so
   * a rule it can break is not a rule. It cannot live in the `page` program
   * either — the agent has a whole shell, and `cat >` does not go through it.
   *
   * It lives in the kernel, the same way containment does everywhere else
   * here. Each of these is bind-mounted over itself read-only inside the
   * otherwise-writable tree, so `sed -i`, `cat >`, `rm` and a hand-rolled
   * editor all fail with EROFS — and the directory cannot be deleted or
   * renamed either, because a mount point cannot be unlinked.
   */
  sealed?: string[];
}

/** Section ids come off a directory listing; they still have to be safe as paths. */
const SECTION_RE = /^[0-9]{3}-[a-z0-9][a-z0-9-]*$/;

export function bwrapAvailable(): boolean {
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

/**
 * The environment the command sees. This IS the API-key defence: the key lives
 * in the controller's env, and an allowlist means it cannot be read from
 * inside the sandbox even by `env`. Verified by a test, because the failure is
 * silent and total.
 */
export function sandboxEnv(mount: string): Record<string, string> {
  return {
    PATH: `${TOOLS_MOUNT}:/usr/local/bin:/usr/bin:/bin`,
    HOME: mount,
    LANG: "C.UTF-8",
    TERM: "dumb",
    PWD: mount,
    // Keeps tools that shell out to a pager from hanging forever on a pipe.
    PAGER: "cat",
    GIT_PAGER: "cat",
  };
}

/**
 * What the command may USE, as opposed to what it may see.
 *
 * The namespaces contain reach: the agent cannot see a home directory, and
 * `~/.ssh` does not exist rather than being protected. They contain nothing
 * about consumption. Asked directly, the sandboxed shell reported `file size
 * unlimited`, `virtual memory unlimited`, `max user processes 30040` — and
 * wrote a 40MB file into the session without complaint. A runaway loop, a
 * mistyped `dd`, or a fork bomb could fill the disk or the machine, and this
 * runs model-authored code on a personal computer.
 *
 * bwrap has no rlimit flags, which is probably why this was missed. bash's own
 * `ulimit` does the job, applies to the whole process tree, and needs no extra
 * binary in the sandbox.
 *
 * Every value below was chosen by trying it, not by reasoning:
 *
 *   -f  128MB per file. A figure is kilobytes and a page is smaller; anything
 *       approaching this is a mistake, and `dd` stops at the limit rather than
 *       filling the disk. (bash counts -f in 1024-byte blocks — verified.)
 *   -u  256 processes, and ONLY when sandboxed. RLIMIT_NPROC counts against
 *       the real user, so in unsafe mode this would count the host's existing
 *       processes and could stop the machine forking at all. bwrap's user
 *       namespace resets the count, which is why it is safe there — checked by
 *       running a loop of forks under `ulimit -u 64` inside the sandbox.
 *   -v  4GB of address space. python3 and a real figure job run fine under it;
 *       node is not in the sandbox's PATH at all, which is the tool that would
 *       most likely object.
 *   -c  no core dumps: a crashing process should not leave a GB in the session.
 *
 * RSS is deliberately absent — Linux ignores RLIMIT_RSS, so a true memory cap
 * needs cgroups (systemd-run), which is a bigger dependency than this is worth
 * today.
 */
export function ulimits(cfg: SandboxConfig): string {
  const parts = ["-c 0", "-f 131072", "-v 4194304"];
  if (!cfg.unsafe) parts.push("-u 256");
  // Never fatal: a kernel that refuses one of these should still run the
  // command, just without that guard.
  return `ulimit ${parts.join(" ")} 2>/dev/null || true`;
}

/**
 * Build the argv that runs `script` under containment.
 *
 * `extra` is per-run environment — a workspace form's values, which reach the
 * command this way BECAUSE they must never be spliced into it. Names are
 * checked here as well as at the caller: `--setenv` with a name containing an
 * equals sign or a null would be a second way to say something.
 */
export function wrapCommand(
  script: string, cfg: SandboxConfig, extra: Record<string, string> = {},
): { file: string; args: string[] } {
  if (cfg.unsafe) return { file: "/bin/bash", args: ["-c", script] };

  const args = [
    "--die-with-parent",
    "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
    ...(cfg.net ? [] : ["--unshare-net"]),
    "--clearenv",
    // Read-only system. /bin, /lib, /sbin are symlinks into /usr on modern
    // distros; recreating them keeps shebangs like #!/bin/sh working.
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/sbin", "/sbin",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // The agent's own programs: read-only, and outside the writable path.
    "--ro-bind", toolsDir(), TOOLS_MOUNT,
    // The one writable path.
    "--bind", cfg.root, MOUNT,
    // …with the published sections mounted read-only over themselves. Order
    // matters: bwrap applies these in sequence, so a ro-bind onto a subpath of
    // an already-bound tree makes exactly that subtree read-only.
    ...sealedBinds(cfg),
    "--chdir", MOUNT,
  ];
  for (const [k, v] of Object.entries(sandboxEnv(MOUNT))) args.push("--setenv", k, v);
  for (const [k, v] of Object.entries(extra)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) continue;
    args.push("--setenv", k, v);
  }
  args.push("/bin/bash", "-c", script);
  return { file: "bwrap", args };
}

/**
 * The read-only overlays for published sections. Exported for the test that
 * checks a sealed section really is unwritable from inside the sandbox.
 */
export function sealedBinds(cfg: SandboxConfig): string[] {
  const args: string[] = [];
  for (const id of cfg.sealed ?? []) {
    if (!SECTION_RE.test(id)) continue;      // never build a path out of anything else
    args.push("--ro-bind", join(cfg.root, "ui", "pages", id), `${MOUNT}/ui/pages/${id}`);
  }
  return args;
}

/** The path the agent is told about, which differs only in unsafe mode. */
export function mountPath(cfg: SandboxConfig): string {
  return cfg.unsafe ? cfg.root : MOUNT;
}

export function describeSandbox(cfg: SandboxConfig): string {
  const sealed = cfg.sealed?.length
    ? ` · ${cfg.sealed.length} published section${cfg.sealed.length === 1 ? "" : "s"} read-only`
    : "";
  if (cfg.unsafe) return `UNSANDBOXED (PERPETUAL_UNSAFE=1)${sealed}`;
  return `bubblewrap · ${cfg.net ? "network ON" : "no network"} · writable: ${MOUNT}${sealed}`;
}
