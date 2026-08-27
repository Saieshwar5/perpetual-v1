/**
 * The `page` program — the agent's only safe way to change a page it wrote.
 *
 * Tested as a program, because that is what it is: argv in, files and exit
 * codes out. The cases below are the ones the shell version got wrong, and
 * each is written as the scenario rather than the mechanism, because the
 * scenario is why the program exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "sandbox-bin", "page");

const PAGE = "003-margins";
const START = [
  { kind: "heading", id: "claim", text: "Margins held at 38%" },
  { kind: "prose", id: "lead", text: "Pricing absorbed the cost rise." },
  { kind: "metrics", id: "numbers", items: [{ value: "38%", label: "Gross margin" }] },
  { kind: "prose", id: "how", text: "Passed through in two steps." },
  { kind: "table", id: "by-quarter", headers: ["Q", "Margin"], rows: [["Q1", "37%"]] },
  { kind: "next", id: "doors", items: ["What if volume falls?"] },
];

async function site(blocks: unknown[] = START) {
  const root = await mkdtemp(join(tmpdir(), "perp-page-"));
  const dir = join(root, "ui", "pages", PAGE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title: "Margins", ask: "how?" }));
  await writeFile(join(dir, "page.ndjson"), blocks.map((b) => JSON.stringify(b)).join("\n") + "\n");
  return root;
}

/** argv in, {code, out, err} out — a failure is a result here, not a throw. */
async function page(root: string, ...args: string[]) {
  try {
    const { stdout } = await run(BIN, args, { env: { ...process.env, PERPETUAL_SITE: root } });
    return { code: 0, out: stdout, err: "" };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

const read = async (root: string, id = PAGE) =>
  (await readFile(join(root, "ui", "pages", id, "page.ndjson"), "utf8"))
    .trim().split("\n").map((l) => JSON.parse(l) as { kind: string; id?: string });

const ids = (blocks: { id?: string }[]) => blocks.map((b) => b.id);

/* ------------------------------------------------------- appending safely */

test("append puts the block above the doors, where `cat >>` would break the page", async () => {
  const root = await site();
  const r = await page(root, "append", PAGE,
    '{"kind":"prose","id":"caveat","text":"Q2 is provisional."}');
  assert.equal(r.code, 0, r.err);
  const after = await read(root);
  assert.deepEqual(ids(after),
    ["claim", "lead", "numbers", "how", "by-quarter", "caveat", "doors"]);
  assert.equal(after.at(-1)!.kind, "next", "the doors are still where the page hands over");
  assert.match(r.out, /above the doors/, "and it says so, so the agent learns the rule");
});

test("append on a page with no doors is simply the end", async () => {
  const root = await site(START.slice(0, 5));
  await page(root, "append", PAGE, '{"kind":"prose","id":"tail","text":"One more thing."}');
  assert.deepEqual(ids(await read(root)),
    ["claim", "lead", "numbers", "how", "by-quarter", "tail"]);
});

test("appending doors of your own puts them last, not above the old ones", async () => {
  const root = await site(START.slice(0, 3));
  await page(root, "append", PAGE, '{"kind":"next","id":"doors","items":["And then?"]}');
  const after = await read(root);
  assert.equal(after.at(-1)!.kind, "next");
});

test("append refuses a name that is already taken", async () => {
  const root = await site();
  const r = await page(root, "append", PAGE, '{"kind":"prose","id":"lead","text":"Twice."}');
  assert.equal(r.code, 2);
  assert.match(r.err, /already the name of another block/);
  assert.deepEqual(ids(await read(root)), ids(START), "and the page is untouched");
});

test("append refuses an unnamed block on a fully named page", async () => {
  const root = await site();
  const r = await page(root, "append", PAGE, '{"kind":"prose","text":"No name."}');
  assert.equal(r.code, 2);
  assert.match(r.err, /all-or-nothing/);
});

test("unquoted JSON on append is named as the shell splitting it", async () => {
  const root = await site();
  const r = await page(root, "append", PAGE, '{"kind":"prose",', 'text:"split"}');
  assert.equal(r.code, 2);
  assert.match(r.err, /split by the shell/);
  assert.match(r.err, /page append <page> '/);
});

/* ------------------------------------------------- the scenario that broke */

test("replacing a block keeps its position — the whole reason this exists", async () => {
  const root = await site();
  const r = await page(root, "set", PAGE, "numbers",
    '{"kind":"metrics","items":[{"value":"39%","label":"Gross margin"}]}');

  assert.equal(r.code, 0);
  const after = await read(root);
  assert.deepEqual(ids(after), ["claim", "lead", "numbers", "how", "by-quarter", "doors"],
    "the shell version moved it to the end, past the closing questions");
  assert.equal(
    (after[2] as unknown as { items: { value: string }[] }).items[0]!.value, "39%",
  );
});

test("a replacement keeps the name even when it does not carry one", async () => {
  const root = await site();
  await page(root, "set", PAGE, "lead", '{"kind":"prose","text":"Rewritten."}');
  assert.equal((await read(root))[1]!.id, "lead",
    "losing the id would silently drop the page out of block-by-block updates");
});

test("a wrong name fails loudly and lists what is there", async () => {
  const root = await site();
  const before = await readFile(join(root, "ui", "pages", PAGE, "page.ndjson"), "utf8");
  const r = await page(root, "set", PAGE, "metrics", '{"kind":"prose","text":"x"}');

  assert.equal(r.code, 2, "grep -v matched nothing and reported success");
  assert.match(r.err, /no block named `metrics`/);
  assert.match(r.err, /claim, lead, numbers, how, by-quarter, doors/);
  assert.equal(await readFile(join(root, "ui", "pages", PAGE, "page.ndjson"), "utf8"), before,
    "and nothing was touched");
});

test("unquoted JSON is named as the shell's doing, not left as a usage dump", async () => {
  const root = await site();
  // What the shell hands over when the agent forgets the single quotes.
  const r = await page(root, "set", PAGE, "lead", '{kind:prose', 'text:hello}');
  assert.equal(r.code, 2);
  assert.match(r.err, /split by the shell/);
  assert.match(r.err, /single quotes/);
});

/* --------------------------------------------------------------- inserting */

test("a block can be put where it belongs, which no shell one-liner does", async () => {
  const root = await site();
  await page(root, "after", PAGE, "how",
    '{"kind":"note","id":"caveat","text":"Q2 is provisional."}');
  assert.deepEqual(ids(await read(root)),
    ["claim", "lead", "numbers", "how", "caveat", "by-quarter", "doors"]);
});

test("a named page will not accept an unnamed block", async () => {
  const root = await site();
  const r = await page(root, "after", PAGE, "how", '{"kind":"note","text":"no name"}');
  assert.equal(r.code, 2);
  assert.match(r.err, /all-or-nothing/);
});

test("two blocks cannot share a name", async () => {
  const root = await site();
  const r = await page(root, "after", PAGE, "how",
    '{"kind":"note","id":"lead","text":"taken"}');
  assert.equal(r.code, 2);
  assert.match(r.err, /already the name/);
});

/* ------------------------------------------------------- removing, moving */

test("removing takes one block and leaves the order alone", async () => {
  const root = await site();
  await page(root, "rm", PAGE, "numbers");
  assert.deepEqual(ids(await read(root)), ["claim", "lead", "how", "by-quarter", "doors"]);
});

test("moving reorders without rewriting anything", async () => {
  const root = await site();
  await page(root, "move", PAGE, "by-quarter", "--after", "lead");
  assert.deepEqual(ids(await read(root)),
    ["claim", "lead", "by-quarter", "numbers", "how", "doors"]);
});

/* ----------------------------------------- the answer to "this page is long" */

test("split moves the tail, gives it a claim, and links back", async () => {
  const root = await site();
  const r = await page(root, "split", PAGE, "--from", "by-quarter",
    "--into", "004-volume", "How volume moves the margin");
  assert.equal(r.code, 0, r.err);

  const left = await read(root);
  assert.deepEqual(ids(left), ["claim", "lead", "numbers", "how", "to-volume"]);
  assert.equal(left.at(-1)!.kind, "link", "the page it came from keeps a way in");

  const made = await read(root, "004-volume");
  assert.deepEqual(made.map((b) => b.kind), ["heading", "table", "next"],
    "a page opens with its claim and ends with its doors");
  assert.equal(made[0]!.id, "claim", "ids are unique per page, so `claim` is free here");

  const meta = JSON.parse(
    await readFile(join(root, "ui", "pages", "004-volume", "meta.json"), "utf8"),
  );
  assert.equal(meta.title, "How volume moves the margin");
  assert.equal(meta.ask, "how?", "the new page answers the same question");
});

test("split refuses to move the whole page, or only the doors", async () => {
  const root = await site();
  const whole = await page(root, "split", PAGE, "--from", "claim", "--into", "004-x", "X");
  assert.equal(whole.code, 2);
  assert.match(whole.err, /move the whole page/);

  const doorsOnly = await page(root, "split", PAGE, "--from", "doors", "--into", "004-y", "Y");
  assert.equal(doorsOnly.code, 2);
  assert.match(doorsOnly.err, /only the closing questions/);
});

test("split will not overwrite a page that exists", async () => {
  const root = await site();
  await mkdir(join(root, "ui", "pages", "004-taken"), { recursive: true });
  const r = await page(root, "split", PAGE, "--from", "by-quarter", "--into", "004-taken", "T");
  assert.equal(r.code, 2);
  assert.match(r.err, /already exists/);
});

/* ------------------------------------------------------------- the file */

test("a page with a broken line is refused rather than rewritten around", async () => {
  const root = await site();
  await writeFile(
    join(root, "ui", "pages", PAGE, "page.ndjson"),
    '{"kind":"heading","id":"claim","text":"ok"}\n{not json\n',
  );
  const r = await page(root, "rm", PAGE, "claim");
  assert.equal(r.code, 2);
  assert.match(r.err, /line 2 is not valid JSON/);
  assert.match(r.err, /Nothing was changed/);
});

test("the temp file never survives a write", async () => {
  const root = await site();
  await page(root, "rm", PAGE, "numbers");
  await assert.rejects(access(join(root, "ui", "pages", PAGE, ".page.ndjson.tmp")));
});

test("an unknown page lists the pages that exist", async () => {
  const root = await site();
  const r = await page(root, "ls", "009-nowhere");
  assert.equal(r.code, 2);
  assert.match(r.err, /no page called `009-nowhere`/);
  assert.match(r.err, /003-margins/);
});
