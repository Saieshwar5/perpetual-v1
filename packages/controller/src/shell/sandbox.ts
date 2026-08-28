/**
 * The sandbox. plans/15 §5, reshaped by plans/37.
 *
 * The agent's only tool is a shell, so containment cannot be done by checking
 * paths in tool arguments — you cannot string-match your way to containing
 * bash, and any list of "dangerous commands" is a list a model steps around
 * without meaning to. It has to be done by the kernel. bubblewrap gives
 * unprivileged namespaces with no daemon, no image, and about a millisecond of
 * overhead.
 *
 * The whole posture, in one sentence:
 *
 *   READ anything except secrets. WRITE only the session and one directory the
 *   reader chose. RUN anything installed.
 *
 * That is a deliberate loosening. Before, the session directory was the only
 * READABLE path as well as the only writable one, and it bought less than it
 * cost: an agent that cannot see your project cannot help with it, and every
 * real task began by copying files into a sandbox that was pretending the rest
 * of the computer did not exist.
 *
 * What is given up is real and worth naming. With the disk readable and the
 * network on, anything the agent can read it can also send somewhere. Two
 * things still hold, and they are the ones doing the work now: what is worth
 * stealing is NOT IN THE NAMESPACE — `~/.ssh` reads as empty rather than as
 * forbidden — and writes cannot leave the two places the reader picked.
 *
 * Three rules that are easy to get wrong and expensive to get wrong:
 *
 *   1. The escape hatch lives in HARNESS CONFIG, never in the tool schema.
 *      The model must not be able to ask its way out — which is why the
 *      working directory is chosen in chrome and arrives here as config,
 *      rather than being something a turn can set for itself.
 *   2. A missing bwrap is a REFUSAL, not a silent downgrade. Otherwise
 *      "unsandboxed" quietly becomes the default on the first machine that
 *      lacks it, which is exactly the machine where it matters.
 *   3. Everything read-only is read-only BY MOUNT. Nothing in this file looks
 *      at a command and decides whether to permit it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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
export const TOOLS_MOUNT = "/perpetual/bin";
export const toolsDir = () =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sandbox-bin");

/**
 * Tool adapters: a recipe per CLI, and the scripts that go with it.
 *
 * Same treatment as the programs above — read-only, outside the one writable
 * path — for the same reason. An adapter says what a tool is for and how its
 * UI should look; an adapter the agent could edit would be an instruction it
 * writes to itself.
 */
export const ADAPTERS_MOUNT = "/perpetual/tools";
export const LOCAL_ADAPTERS_MOUNT = "/perpetual/tools.local";

/**
 * Top-level directories that never come from the host.
 *
 * Everything else in `/` is bind-mounted read-only, which is what "read
 * anything" means in practice. These four are replaced rather than copied:
 * /proc and /dev get bwrap's own, /tmp gets a fresh tmpfs, and /perpetual is
 * ours — the reason our mounts moved off /opt, where the host may have real
 * software the reader wants to run.
 */
const OWN_TOP = new Set(["proc", "dev", "tmp", "perpetual", "session"]);

/**
 * What stays hidden once everything else is visible.
 *
 * Each of these is covered with an empty tmpfs, so it reads as EMPTY rather
 * than as forbidden — the same principle the old sandbox applied to the whole
 * disk, kept for the short list that is actually worth stealing. A directory
 * that is not in the namespace cannot be reached by a clever command, an
 * unlucky glob, or an agent that was talked into it by something it read.
 *
 * Paths are relative to the reader's home directory. Only ones that exist are
 * covered: a machine without a browser profile should not grow an empty one.
 */
export const SECRETS = [
  ".ssh", ".gnupg", ".aws", ".kube", ".netrc", ".git-credentials",
  ".password-store", ".local/share/keyrings", ".docker/config.json",
  ".mozilla", ".config/google-chrome", ".config/chromium",
  ".config/BraveSoftware", ".thunderbird",
  ".config/gh", ".config/gcloud", ".config/gws",
];

/**
 * Credential directories the reader can put back, by name.
 *
 * This is the tension the design runs into, and there is no clever way past
 * it: the files that make a CLI useful are exactly the files worth stealing.
 * `gws` works because ~/.config/gws holds a Google token — hide it and mail
 * does not work; show it and the agent has whatever that token has.
 *
 * So the honest arrangement. Nothing is visible by default, and the reader
 * names what to put back. Naming `gws` means "this session may act as me in
 * Gmail", said once, in config, on purpose.
 */
export const CREDENTIALS: Record<string, string> = {
  gws: ".config/gws",
  gh: ".config/gh",
  gcloud: ".config/gcloud",
  aws: ".aws",
  kube: ".kube",
  docker: ".docker/config.json",
  ssh: ".ssh",
  gnupg: ".gnupg",
};

export interface SandboxConfig {
  /** Real path to the session's `site/` directory. */
  root: string;
  /**
   * Network access. ON by default now.
   *
   * The agent may run anything installed, and most of what is installed is
   * useless offline. Leaving this off would have shipped a sandbox whose
   * headline feature did not work until you found the flag.
   */
  net: boolean;
  /**
   * The one directory outside the session this may WRITE to, chosen by the
   * reader in chrome.
   *
   * Absent is the default and is not a lesser mode: a session that only writes
   * its own record is exactly right for answering a question, and it is what
   * you want before you have decided the agent should touch your files.
   */
  workdir?: string;
  /**
   * Credential directories to leave visible — names from CREDENTIALS, or
   * absolute paths. Empty by default.
   */
  credentials?: string[];
  /** Set by PERPETUAL_UNSAFE=1. Development only; never a fallback. */
  unsafe: boolean;
  /**
   * Where ALL sessions live on disk — session.json, transcripts, other
   * sessions' pages.
   *
   * Passed in so it can be nailed read-only even when it falls INSIDE the
   * chosen working directory, which is exactly what happens when the reader
   * points a session at the repo this runs from. `session.json` records which
   * sections are sealed; a writable one would let a turn unseal itself.
   */
  sessionsRoot?: string;
  /** Real path to the built-in adapters, when there are any. */
  adapters?: string;
  /** Real path to the reader's own adapters, when they have some. */
  localAdapters?: string;
  /**
   * The `bin/` of each adapter that ships scripts, in sandbox coordinates and
   * in PATH order. Resolved by the caller from the registry, because PATH
   * does not expand globs — a wildcard entry would silently be one that never
   * matches anything.
   */
  binPaths?: string[];
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
export function sandboxEnv(cfg: SandboxConfig): Record<string, string> {
  const cwd = cfg.workdir ?? MOUNT;
  return {
    // An adapter's `bin/` is on the PATH, so a recipe can say `mail list`
    // rather than a path — the scripts ARE the tool, as far as the agent is
    // concerned. The host's own PATH follows, because "run anything installed"
    // has to include things that are not in /usr/bin.
    PATH: [
      TOOLS_MOUNT, ...(cfg.binPaths ?? []),
      ...(process.env.PATH ?? "").split(":").filter(Boolean),
      "/usr/local/bin", "/usr/bin", "/bin",
    ].join(":"),
    // The reader's REAL home, read-only. `~` now means what they mean by it,
    // and a tool looking for its own config in ~/.config finds it — which is
    // the point of the whole change, and also why SECRETS exists.
    HOME: homedir(),
    // Where the record is written. Not HOME any more: the two were the same
    // thing only because there was nothing else in the namespace.
    PERPETUAL_SITE: MOUNT,
    // The one place outside the record that can be written. Adapters read this
    // rather than guessing, so `files find` searches where the reader is
    // working instead of wherever the last `cd` happened to land.
    ...(cfg.workdir ? { PERPETUAL_WORKDIR: cfg.workdir } : {}),
    // Tool-specific, and it earns the exception: gws defaults to a keyring
    // that talks to the session bus, and there is no session bus in here. A
    // credential the reader deliberately made visible should WORK, rather than
    // failing with "Failed to get token" and looking like a login problem. The
    // file backend reads the key already sitting beside the credentials.
    ...(visibleCredentials(cfg).has("gws")
      ? { GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" } : {}),
    LANG: "C.UTF-8",
    TERM: "dumb",
    PWD: cwd,
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
 * Make DNS work when the network is on.
 *
 * `/etc` is bind-mounted read-only, which brings `/etc/resolv.conf` with it —
 * but on a systemd-resolved machine that is a SYMLINK into /run, and /run is
 * not in the namespace. So it arrives dangling: the network was on, every
 * hostname failed to resolve, and the error surfaced as "error sending
 * request" from whatever was trying to make one.
 *
 * Binding the target AT ITS OWN PATH is what works, and the reason is worth
 * writing down: mounting over `/etc/resolv.conf` silently does nothing, because
 * the destination is a dangling symlink and there is nothing there to mount
 * onto. Put the real file where the symlink is already pointing and it
 * resolves. Binding its directory rather than the file also brings the
 * resolver's own socket, which is what `nsswitch.conf` reaches for first.
 *
 * `--ro-bind-try` because a machine laid out differently should still get a
 * sandbox — just one that cannot look anything up, which is what it had before.
 */
function resolverBinds(): string[] {
  let real: string;
  try { real = realpathSync("/etc/resolv.conf"); } catch { return []; }
  if (real === "/etc/resolv.conf") return [];         // a real file, already in /etc
  const dir = dirname(real);
  return ["--ro-bind-try", dir, dir];
}

/**
 * Take the resolver away again when the network is off.
 *
 * `--unshare-net` removes the network, not the resolver: systemd-resolved is
 * reached over a UNIX SOCKET, and unix sockets do not live in the network
 * namespace. Now that /run comes from the host, a sandbox with no network
 * could still resolve names — which fetches nothing, but can certainly SEND
 * something, one lookup at a time.
 *
 * Caught by a test that had been passing for the old mount table and started
 * failing the moment /run arrived. Exactly what those tests are for.
 */
function resolverBlinds(): string[] {
  let real: string;
  try { real = realpathSync("/etc/resolv.conf"); } catch { return []; }
  if (real === "/etc/resolv.conf") return [];
  return ["--tmpfs", dirname(real)];
}

/**
 * The disk, read-only, one top-level directory at a time.
 *
 * Symlinks are recreated rather than followed: /bin, /lib and /sbin point into
 * /usr on modern distros, and turning them into real directories would work
 * right up until something compared paths and found /bin/sh was not /usr/bin/sh.
 */
function topBinds(): string[] {
  const args: string[] = [];
  let names: string[];
  try { names = readdirSync("/"); } catch { return args; }

  for (const name of names.sort()) {
    if (OWN_TOP.has(name)) continue;
    const path = `/${name}`;
    let st;
    try { st = lstatSync(path); } catch { continue; }
    if (st.isSymbolicLink()) {
      try { args.push("--symlink", readlinkSync(path), path); } catch { /* skip */ }
    } else if (st.isDirectory()) {
      args.push("--ro-bind-try", path, path);
    }
  }
  return args;
}

/**
 * Cover the secrets, and give the home directory somewhere to write a cache.
 *
 * The cache matters more than it looks: with HOME pointing at the reader's real
 * home and that home read-only, a great many tools fail on their first run
 * trying to create ~/.cache. An empty tmpfs there costs nothing, is thrown away
 * with the sandbox, and keeps `pip`, `npm`, `go` and friends working.
 */
/** The credential NAMES this session has been given, ignoring bare paths. */
function visibleCredentials(cfg: SandboxConfig): Set<string> {
  return new Set((cfg.credentials ?? []).filter((n) => n in CREDENTIALS));
}

function homeBinds(cfg: SandboxConfig): string[] {
  const home = homedir();
  const allowed = new Set<string>();
  for (const name of cfg.credentials ?? []) {
    if (name.startsWith("/")) { allowed.add(name); continue; }
    const rel = CREDENTIALS[name];
    if (rel) allowed.add(join(home, rel));
  }

  const args: string[] = [];
  for (const rel of SECRETS) {
    const path = join(home, rel);
    if (allowed.has(path)) continue;
    // Only what exists: a machine with no browser profile should not grow an
    // empty one, and an absent path is already the outcome we want.
    if (!existsSync(path)) continue;
    args.push("--tmpfs", path);
  }
  // An allowed credential is bound WRITABLE, over the read-only home.
  //
  // Not a generosity — a requirement. These CLIs cache refreshed access tokens
  // beside their credentials, and a read-only config directory fails as "Failed
  // to get token", which reads like a broken login rather than a broken mount.
  // The extra exposure over read-only is small: a token you can read is already
  // a token you can use.
  for (const path of allowed) {
    if (existsSync(path)) args.push("--bind", path, path);
  }
  args.push("--tmpfs", join(home, ".cache"));
  return args;
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
    ...(cfg.net ? resolverBinds() : ["--unshare-net"]),
    "--clearenv",
    // THE DISK, READ-ONLY. Every top-level directory except the four we
    // provide ourselves.
    //
    // Enumerated rather than `--ro-bind / /`, and the reason is load-bearing:
    // with the root itself read-only, bwrap cannot create the mount points for
    // anything that follows — it fails with "Can't mkdir parents for
    // /perpetual/tools: Read-only file system". Leaving the root as bwrap's own
    // tmpfs keeps /perpetual and /session creatable.
    ...topBinds(),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // The agent's own programs, and the adapters: read-only, and outside every
    // writable path, because configuration the agent can edit is not
    // configuration.
    //
    // `--ro-bind-try`, not `--ro-bind`: the reader's own adapter directory
    // usually does not exist, and bwrap refuses to start at all when a bind
    // source is missing. That turned every command in a session without a
    // local tools directory into "Can't find source path".
    "--ro-bind", toolsDir(), TOOLS_MOUNT,
    ...(cfg.adapters ? ["--ro-bind-try", cfg.adapters, ADAPTERS_MOUNT] : []),
    ...(cfg.localAdapters ? ["--ro-bind-try", cfg.localAdapters, LOCAL_ADAPTERS_MOUNT] : []),
    // …then the secrets are covered over, AFTER the home directory they live
    // in has been bound. Order is the whole trick: a tmpfs placed before its
    // parent bind would simply be replaced by it.
    ...homeBinds(cfg),
    // The resolver goes AFTER the disk, or the bind of /run puts it straight
    // back. Ordering is the whole of bwrap's semantics and the easiest thing
    // here to get quietly wrong — this exact mistake made a network-off
    // sandbox resolve names for one commit.
    ...(cfg.net ? [] : resolverBlinds()),
    // WRITABLE, and this is the entire list. The session's own record…
    "--bind", cfg.root, MOUNT,
    // …with the published sections mounted read-only over themselves. Order
    // matters here too: a ro-bind onto a subpath of an already-bound tree
    // makes exactly that subtree read-only.
    ...sealedBinds(cfg),
    // …and the one directory the reader chose, at its real path, so that
    // absolute paths in the agent's output mean something outside the sandbox.
    ...(cfg.workdir ? ["--bind", cfg.workdir, cfg.workdir] : []),
    // …and the controller's own state pinned read-only ON TOP of it. The
    // sessions root sits inside the repo by default, so a reader who chooses
    // that repo as their working directory would otherwise be handing the
    // agent write access to session.json — the file that records what is
    // sealed. Last, because the last mount over a path is the one that wins.
    ...(cfg.sessionsRoot ? ["--ro-bind-try", cfg.sessionsRoot, cfg.sessionsRoot] : []),
    "--chdir", cfg.workdir ?? MOUNT,
  ];
  for (const [k, v] of Object.entries(sandboxEnv(cfg))) {
    args.push("--setenv", k, v);
  }
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

/** Where the record lives, in the agent's coordinates. */
export function mountPath(cfg: SandboxConfig): string {
  return cfg.unsafe ? cfg.root : MOUNT;
}

/**
 * Where a command starts.
 *
 * The reader's working directory when there is one, because that is what they
 * meant by choosing it — a session pointed at a project should answer `ls`
 * with that project, not with the machinery of its own record.
 *
 * bwrap's `--chdir` is not enough on its own: the shell wrapper cds explicitly
 * so that `cd` can persist between commands, and that cd wins.
 */
export function startDir(cfg: SandboxConfig): string {
  return cfg.workdir ?? mountPath(cfg);
}

export function describeSandbox(cfg: SandboxConfig): string {
  const sealed = cfg.sealed?.length
    ? ` · ${cfg.sealed.length} published section${cfg.sealed.length === 1 ? "" : "s"} read-only`
    : "";
  // What the reader needs from this string is one thing: where can it write.
  // Reading is broad and uninteresting; writing is the part with consequences,
  // so it is the part that gets named.
  const writable = cfg.workdir ? `${MOUNT} + ${cfg.workdir}` : MOUNT;
  const creds = cfg.credentials?.length ? ` · credentials: ${cfg.credentials.join(", ")}` : "";
  if (cfg.unsafe) return `UNSANDBOXED (PERPETUAL_UNSAFE=1)${sealed}`;
  return `bubblewrap · ${cfg.net ? "network ON" : "no network"} · ` +
    `writable: ${writable}${creds}${sealed}`;
}
