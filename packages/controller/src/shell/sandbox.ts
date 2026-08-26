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

/** Where the session directory appears from inside the sandbox. */
export const MOUNT = "/session";

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
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: mount,
    LANG: "C.UTF-8",
    TERM: "dumb",
    PWD: mount,
    // Keeps tools that shell out to a pager from hanging forever on a pipe.
    PAGER: "cat",
    GIT_PAGER: "cat",
  };
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
