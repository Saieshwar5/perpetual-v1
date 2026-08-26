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
}

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

/** Build the argv that runs `script` under containment. */
export function wrapCommand(script: string, cfg: SandboxConfig): { file: string; args: string[] } {
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
    "--chdir", MOUNT,
  ];
  for (const [k, v] of Object.entries(sandboxEnv(MOUNT))) args.push("--setenv", k, v);
  args.push("/bin/bash", "-c", script);
  return { file: "bwrap", args };
}

/** The path the agent is told about, which differs only in unsafe mode. */
export function mountPath(cfg: SandboxConfig): string {
  return cfg.unsafe ? cfg.root : MOUNT;
}

export function describeSandbox(cfg: SandboxConfig): string {
  if (cfg.unsafe) return "UNSANDBOXED (PERPETUAL_UNSAFE=1)";
  return `bubblewrap · ${cfg.net ? "network ON" : "no network"} · writable: ${MOUNT}`;
}
