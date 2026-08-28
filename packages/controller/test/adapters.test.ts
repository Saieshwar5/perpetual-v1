/**
 * Tool adapters — a recipe per CLI, discovered on demand.
 *
 * What is worth testing here is not the parser. It is the three promises the
 * standard makes:
 *
 *   THE INDEX IS CHEAP. Names and shapes in the turn message, recipes on disk.
 *   If the recipes ever leak into the prompt, twenty tools cost twenty
 *   recipes in every conversation.
 *
 *   A BROKEN MANIFEST IS LOUD. An adapter the agent is never told about looks
 *   exactly like one that was never installed, so it has to complain.
 *
 *   YOURS WINS. The point of a standard is that someone else can write one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  frontmatter, readAdapters, describeAdapters, adaptersDir,
} from "../src/adapters.ts";
import { BLOCK_DOCS, BLOCK_KINDS, validateBlock } from "@perpetual/shared/blocks";

async function tools(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "perp-tools-"));
  return d;
}

async function put(root: string, name: string, text: string, bin?: string) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "tool.md"), text);
  if (bin) {
    await mkdir(join(root, name, "bin"), { recursive: true });
    await writeFile(join(root, name, "bin", name), bin);
  }
}

const MAIL = `---
name: mail
title: Mail
surface: workspace
summary: read and reply to mail
needs: [credential:gmail, net]
check: mail --self-test
---

# Mail

The recipe.
`;

/* ------------------------------------------------------------- the manifest */

test("frontmatter reads scalars and lists, and hands back the body", () => {
  const { meta, body } = frontmatter(MAIL);
  assert.equal(meta.name, "mail");
  assert.equal(meta.surface, "workspace");
  assert.deepEqual(meta.needs, ["credential:gmail", "net"]);
  assert.match(body, /^# Mail/m);
  assert.doesNotMatch(body, /surface:/, "the manifest is not part of the recipe");
});

test("a file with no frontmatter is all body", () => {
  const { meta, body } = frontmatter("# Just a document\n");
  assert.deepEqual(meta, {});
  assert.match(body, /Just a document/);
});

/* ------------------------------------------------------------- discovery */

test("an adapter is read, and its bin is noticed", async () => {
  const d = await tools();
  await put(d, "mail", MAIL, "#!/bin/sh\n");
  const { adapters, problems } = await readAdapters(d);
  const mail = adapters.find((a) => a.name === "mail")!;

  assert.deepEqual(problems.filter((p) => p.name === "mail"), []);
  assert.equal(mail.title, "Mail");
  assert.equal(mail.surface, "workspace");
  assert.deepEqual(mail.needs, ["credential:gmail", "net"]);
  assert.equal(mail.hasBin, true);
  assert.equal(mail.local, true);
  assert.match(mail.path, /tools\.local\/mail$/, "the reader's own are mounted apart");
  await rm(d, { recursive: true, force: true });
});

test("a manifest that says nothing useful is a problem, not a silent skip", async () => {
  const d = await tools();
  await put(d, "quiet", "---\nname: quiet\n---\n# No summary\n");
  await put(d, "odd", "---\nname: odd\nsummary: x\nsurface: sideways\n---\n");
  await mkdir(join(d, "empty"), { recursive: true });

  const { adapters, problems } = await readAdapters(d);
  assert.deepEqual(adapters.filter((a) => a.local).map((a) => a.name), []);
  const said = Object.fromEntries(problems.map((p) => [p.name, p.message]));
  assert.match(said.quiet!, /no `summary`/);
  assert.match(said.odd!, /one of workspace, page, either/);
  assert.match(said.empty!, /no tool\.md/);
  await rm(d, { recursive: true, force: true });
});

test("the reader's own adapter wins a name clash", async () => {
  const d = await tools();
  await put(d, "files", "---\nname: files\nsummary: mine, not yours\nsurface: page\n---\n");
  const { adapters } = await readAdapters(d);
  const files = adapters.filter((a) => a.name === "files");
  assert.equal(files.length, 1, "one name, one tool");
  assert.equal(files[0]!.summary, "mine, not yours");
  assert.equal(files[0]!.local, true);
  await rm(d, { recursive: true, force: true });
});

/* ----------------------------------------------------------- the index */

test("the turn message gets names and shapes — never the recipes", async () => {
  const d = await tools();
  await put(d, "mail", MAIL);
  const { adapters } = await readAdapters(d);
  const line = describeAdapters(adapters)!;

  assert.match(line, /mail \(workspace\) — read and reply to mail/);
  assert.match(line, /\[needs credential:gmail, net\]/);
  assert.match(line, /cat \/opt\/perpetual\/tools/, "it says where to read the rest");
  assert.doesNotMatch(line, /# Mail/, "the recipe stays on disk");
  assert.ok(line.length < 1200, "an index that grows like a prompt is not an index");
  await rm(d, { recursive: true, force: true });
});

test("no adapters is no line at all", () => {
  assert.equal(describeAdapters([]), null);
});

/* --------------------------------------------------- the ones that ship */

test("the built-in adapters are readable, and say what they are", async () => {
  const { adapters, problems } = await readAdapters();
  assert.deepEqual(problems, []);
  const names = adapters.map((a) => a.name);
  assert.deepEqual(names, ["files", "git"]);

  const files = adapters.find((a) => a.name === "files")!;
  assert.equal(files.surface, "workspace");
  assert.equal(files.hasBin, true, "files ships the script its recipe promises");

  const git = adapters.find((a) => a.name === "git")!;
  assert.equal(git.surface, "page",
    "the standard has to be able to say `no workspace` as clearly as `workspace`");
  assert.equal(git.hasBin, false, "git is a real program; wrapping it would get in the way");
  assert.ok(adaptersDir().endsWith("adapters"));
});

/* ------------------------------------------------- the printed reference */

test("every block kind is documented, or the suite fails", () => {
  // The reference in docs/ is generated from these. A kind with no entry is a
  // block nobody can look up — and the way that gets noticed is here, rather
  // than by a reader finding a gap.
  for (const kind of BLOCK_KINDS) {
    const doc = BLOCK_DOCS[kind];
    assert.ok(doc, `${kind} has no entry in BLOCK_DOCS`);
    assert.ok(doc.purpose.length > 20, `${kind}: purpose says nothing`);
    assert.ok(doc.example.includes(`"kind":"${kind}"`), `${kind}: the example is not one`);
  }
});

test("every documented example is a block that actually validates", () => {
  // A reference whose examples do not parse is worse than none: it teaches the
  // agent to write blocks that will be refused.
  for (const kind of BLOCK_KINDS) {
    const v = validateBlock(JSON.parse(BLOCK_DOCS[kind].example));
    assert.equal(v.ok, true, `${kind}: ${v.ok ? "" : v.error}`);
  }
});
