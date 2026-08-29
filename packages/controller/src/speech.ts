/**
 * Speech: the model's own stream, routed. plans/40.
 *
 * The agent used to have exactly one way to say anything — write a file
 * through the shell — and the model's streamed text was thrown away. This
 * module is the second route: line-buffer the stream, and every line that IS
 * a valid block goes into the section this turn is writing, immediately,
 * validated by the same validator as everything else.
 *
 * The routing rule is one character. A line whose first non-space byte is `{`
 * is a speech candidate; everything else is the model thinking out loud and
 * stays private, exactly as before. So the old guarantee — nothing
 * unvalidated reaches the reader — survives intact; what changed is that
 * VALID lines now reach them without paying a bash round-trip each.
 *
 * Three design points that are easy to lose:
 *
 *   1. THE FILE IS STILL THE RECORD. This module appends to page.ndjson and
 *      then asks the watcher to look (`flush`); it never fabricates a page
 *      event from what the model said. The watcher stays the single source
 *      of page_* events, which is what keeps replay, the seal and the tests
 *      honest.
 *   2. THE TARGET IS EAGER. The section is created when the first candidate
 *      line BEGINS, not when it completes — the `page_open` has to stream
 *      before the first forming text or the reader's very first block (which
 *      is the whole of a short answer) would appear with no typing at all.
 *      A section that ends the turn empty is removed; an empty directory is
 *      not a reply.
 *   3. REJECTS TEACH. A line that fails validation is not written, and the
 *      validator's message — already phrased as a repair instruction — is
 *      queued for the model through the same channels as every other
 *      correction: the next tool result, or an injected note when the model
 *      had already stopped.
 */
import { mkdir, readdir, readFile, rm, writeFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateBlock, APP_KINDS, type Block } from "@perpetual/shared/blocks";

/** A line larger than this is not speech, whatever it thinks it is. */
const MAX_LINE = 64 * 1024;
/** How many times a turn may be re-prompted over rejected lines. */
export const MAX_REJECT_NOTES = 3;

export interface SpeechHooks {
  /** Plain thinking, forwarded as status. Carries the delta, not the line. */
  status(delta: string): void;
  /**
   * The block being streamed, as far as it is known.
   *
   * `text` is the prose so far, for the ghost that types itself. `kind`
   * arrives much earlier — it is the first field of the line — and is what
   * lets the client put a chart-shaped or table-shaped SKELETON on the page
   * while the data is still arriving. Structure cannot be revealed
   * progressively (half a chart is a false shape), but its FOOTPRINT can, and
   * that is what stops it appearing in one shot. plans/43.
   */
  forming(page: string, text: string | null, kind: string | null): void;
  /** A line landed on disk: poll the watcher NOW so the event streams. */
  flush(): Promise<void>;
}

/**
 * The kind of block being streamed, from the first field of the line.
 *
 * Available within the first dozen bytes — `{"kind":"chart",…` — which is
 * long before the data it describes. That gap is the whole opportunity: the
 * client can reserve the right shape and the right height, and the finished
 * block drops into a space that is already there rather than pushing the page
 * around when it lands.
 */
export function formingKind(line: string): string | null {
  const m = /"kind"\s*:\s*"([a-z]+)"/.exec(line);
  return m ? m[1]! : null;
}

/**
 * The partial-text scanner. Given an incomplete line like
 * `{"kind":"prose","text":"Canberra — chos`, return the readable content of
 * its `text` field so far, or null if there is none yet.
 *
 * Hand-rolled rather than a partial-JSON dependency: the one field we ever
 * want mid-line is a string, and scanning a string is thirty lines with no
 * failure mode worse than "no ghost this block".
 */
export function formingText(line: string): string | null {
  const m = /"text"\s*:\s*"/.exec(line);
  if (!m) return null;
  let out = "";
  let i = m.index + m[0].length;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '"') break;                      // the field closed; stop there
    if (c === "\\") {
      const n = line[i + 1];
      if (n === undefined) break;              // dangling escape — wait for more
      if (n === "u") {
        const hex = line.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * One value, one string, whatever order its keys were written in.
 *
 * Only used to tell two blocks apart, so it needs to be stable rather than
 * pretty: sort the keys at every level and serialise.
 */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** First few words of the ask, dressed as a rail title. */
export function titleFrom(ask: string): string {
  const words = ask.trim().replace(/[?.!]+$/, "").split(/\s+/).slice(0, 4).join(" ");
  const t = words.slice(0, 40) || "Reply";
  return t[0]!.toUpperCase() + t.slice(1);
}

export function slugFrom(ask: string): string {
  return ask.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .split("-").filter(Boolean).slice(0, 4).join("-") || "reply";
}

export class SpeechChannel {
  private buf = "";
  /** null = line not yet classified; true = candidate; false = plain. */
  private candidate: boolean | null = null;
  private targetId: string | null = null;
  /** Did SPEECH create the target (so an empty one is ours to remove)? */
  private created = false;
  private landed = 0;
  private rejects: string[] = [];
  private toldWhere = false;
  private overflow = false;

  private root: string;
  private ask: string;
  private on: SpeechHooks;

  // Plain assignments, not parameter properties: the controller runs under
  // --experimental-strip-types, which strips types and refuses syntax that
  // GENERATES code — and `private x` in a constructor is exactly that.
  constructor(root: string, ask: string, on: SpeechHooks) {
    this.root = root;
    this.ask = ask;
    this.on = on;
  }

  /** Blocks that actually landed this turn. */
  get spoke(): number { return this.landed; }
  get target(): string | null { return this.targetId; }

  /**
   * A section opened this turn — by the shell, or by us. Speech follows the
   * section the turn is writing, so a shell-built section and the reply about
   * it are one section, not two fighting over a number.
   */
  notice(pageId: string): void {
    this.targetId = pageId;
  }

  /** Feed one text delta from the model's stream. */
  async feed(delta: string): Promise<void> {
    let rest = delta;
    while (rest) {
      const nl = rest.indexOf("\n");
      const chunk = nl === -1 ? rest : rest.slice(0, nl);
      rest = nl === -1 ? "" : rest.slice(nl + 1);

      if (chunk) {
        this.buf += chunk;
        if (this.candidate === null) {
          const seen = this.buf.trimStart();
          if (seen) this.candidate = seen.startsWith("{");
          // Plain lines stream out as they always did — including whatever
          // was buffered while the line was still unclassified.
          if (this.candidate === false) { this.on.status(this.buf); this.buf = ""; }
        } else if (this.candidate === false) {
          this.on.status(chunk);
        }
        // Not an else: the chunk that CLASSIFIED the line as a candidate also
        // starts the ghost, and — more importantly — creates the target
        // eagerly, so the page_open streams before the first forming text.
        if (this.candidate === true) {
          if (this.buf.length > MAX_LINE) {
            if (!this.overflow) {
              this.overflow = true;
              this.rejects.push(
                `a streamed line passed ${Math.round(MAX_LINE / 1024)}KB and was dropped. ` +
                "A block is one line of JSON; anything that size belongs in a file, " +
                "written through the shell.");
            }
          } else {
            await this.ensureTarget();
            const text = formingText(this.buf);
            const kind = formingKind(this.buf);
            // Emitted as soon as EITHER is known: the kind lands first and
            // raises the skeleton, the text follows and types into it.
            if (this.targetId && (text !== null || kind !== null)) {
              this.on.forming(this.targetId, text, kind);
            }
          }
        }
      }

      if (nl !== -1) await this.endLine();
    }
  }

  /** The stream stopped without a trailing newline — treat it as the newline. */
  async endStep(): Promise<void> {
    if (this.buf.trim() || this.candidate === false) await this.endLine();
  }

  /**
   * What the model needs to hear, drained once per opportunity: rejected
   * lines, and — once — where its reply is landing, so a generator script
   * knows which directory the figure belongs in.
   */
  drainNotes(): string | null {
    const parts: string[] = [];
    if (this.rejects.length) {
      parts.push("[perpetual] " +
        (this.rejects.length === 1 ? "A streamed line was rejected: "
          : `${this.rejects.length} streamed lines were rejected:\n  - `) +
        this.rejects.join("\n  - ") +
        "\nNothing rejected was written. Fix the block and stream it again.");
      this.rejects = [];
    }
    if (!this.toldWhere && this.targetId && this.landed > 0) {
      this.toldWhere = true;
      parts.push(`[perpetual] Your reply is being written into ui/pages/${this.targetId}/ — ` +
        "put any figure or generator for it there.");
    }
    return parts.length ? parts.join("\n\n") : null;
  }

  /**
   * Turn over. If speech created a section and nothing ever landed in it,
   * take it back out — with the flush that tells the watcher, so the client
   * that saw `page_open` also sees it close.
   */
  async finish(): Promise<void> {
    if (this.created && this.landed === 0 && this.targetId) {
      await rm(join(this.root, "ui", "pages", this.targetId), { recursive: true, force: true })
        .catch(() => {});
      this.targetId = null;
      await this.on.flush().catch(() => {});
    }
  }

  /* ----------------------------------------------------------- internals */

  private async endLine(): Promise<void> {
    const line = this.buf;
    const wasCandidate = this.candidate;
    const overflowed = this.overflow;
    this.buf = "";
    this.candidate = null;
    this.overflow = false;

    if (wasCandidate === false) { this.on.status("\n"); return; }
    if (!wasCandidate || overflowed || !line.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      this.rejects.push(`not valid JSON (${e instanceof Error ? e.message.slice(0, 80) : "parse error"}): ` +
        `\`${line.slice(0, 60)}…\``);
      return;
    }

    const v = validateBlock(parsed);
    if (!v.ok) { this.rejects.push(v.error); return; }
    if ((APP_KINDS as readonly string[]).includes(v.value.kind)) {
      this.rejects.push(`\`${v.value.kind}\` is a workspace block. Speech writes the record; ` +
        "a workspace is written through the shell, into ui/apps/<name>/view.ndjson.");
      return;
    }

    await this.ensureTarget();
    if (!this.targetId) return;
    const file = join(this.root, "ui", "pages", this.targetId, "page.ndjson");

    // ALREADY THERE — do not say it twice.
    //
    // Speech and the shell append to the same file and neither knows about
    // the other, so an agent that both `cat >>`s a block and streams it puts
    // it on the page twice. The prompt says pick one route; this is the guard
    // for when it does not, and it costs one read of a file that holds at
    // most a couple of dozen short lines.
    //
    // Scoped to the section being written, which is always THIS turn's — a
    // published page is sealed, and `ensureTarget` only ever takes the next
    // number or the directory a command of this turn just made. So a match
    // here is a duplicate, never a legitimate echo of something older.
    if (await this.alreadyThere(file, v.value)) return;

    // Normalized, one line, trailing newline: exactly what `cat >>` produces.
    await appendFile(file, JSON.stringify(v.value) + "\n", "utf8");
    this.landed++;
    // Now, not on the next 120ms tick: the block should land the moment the
    // line does, the same immediacy the loop gives a finished shell command.
    await this.on.flush();
  }

  /**
   * Is this exact block already in the section?
   *
   * Compared by CONTENT, not by bytes: the shell's line was typed by the
   * model and ours went through `JSON.stringify`, so the same block can
   * differ in key order and spacing while being the same block. Canonicalise
   * both and the comparison is honest.
   */
  private async alreadyThere(file: string, block: Block): Promise<boolean> {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (!raw) return false;
    const want = canon(block);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { if (canon(JSON.parse(line)) === want) return true; } catch { /* not ours to judge */ }
    }
    return false;
  }

  private async ensureTarget(): Promise<void> {
    if (this.targetId) return;
    const pagesDir = join(this.root, "ui", "pages");
    await mkdir(pagesDir, { recursive: true });
    const names = await readdir(pagesDir).catch(() => [] as string[]);
    let max = 0;
    for (const n of names) {
      const m = /^(\d{3})-/.exec(n);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const id = `${String(max + 1).padStart(3, "0")}-${slugFrom(this.ask)}`;
    const dir = join(pagesDir, id);
    // Never adopt a directory that already exists — the number came from the
    // same listing, so a hit here is a race with a shell command, and the
    // shell wins.
    if (await stat(dir).then(() => true, () => false)) { this.targetId = id; return; }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"),
      JSON.stringify({ title: titleFrom(this.ask), ask: this.ask }) + "\n", "utf8");
    this.created = true;
    this.targetId = id;
    // Streams the page_open before the first forming text.
    await this.on.flush();
  }
}
