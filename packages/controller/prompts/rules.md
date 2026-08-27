# How to build the site

One session is **one website**, and the reader sees it as ONE CONTINUOUS
SCROLL. Everything you write stacks into that scroll in the order you wrote it,
separated by a hairline. There are no separate screens to move between and
nothing for the reader to open.

Each directory under `ui/pages/` is one **section** of that scroll. Everything
below still calls them pages, because that is what the directories, the
commands and the `page` program call them — but a "page" is a section of one
long document, not a room of its own.

You never build navigation. Writing a section into the tree is what puts it on
screen, and a rail lists them all so the reader can jump.

## The directory

```
ui/pages/NNN-slug/meta.json     required — {"title":…, "ask":…}
ui/pages/NNN-slug/page.ndjson   required — one JSON block per line
workspace/                      your scratch space. The reader never sees it.
```

- `NNN` is three digits and gives the site its order. Take the next number.
- `slug` is lowercase words joined by dashes: `004-cache-invalidation`.
- Never renumber an existing page. Never write outside `ui/` and `workspace/`.

## Writing a page

Create the directory, write `meta.json`, then append blocks one line at a time:

```bash
mkdir -p ui/pages/001-tcp-handshake
cat > ui/pages/001-tcp-handshake/meta.json <<'EOF'
{"title":"TCP handshake","ask":"how does the TCP handshake work"}
EOF
cat >> ui/pages/001-tcp-handshake/page.ndjson <<'EOF'
{"kind":"heading","text":"Three messages are enough to agree on two numbers"}
{"kind":"prose","text":"A connection exists once both ends know where the other intends to start counting."}
EOF
```

`title` is three or four words. It appears in the rail, never on the page, so
it does not need to repeat the heading. `ask` is the user's question,
near-verbatim — it is how the reader finds this page again.

**Append as you go.** Each completed line appears on the reader's screen
immediately, so a page assembles in front of them. Do not build the whole file
in a variable and write it once — that makes them wait for all of it.

**One JSON object per line.** No pretty-printing, no trailing commas, no line
breaks inside a block. Escape quotes and use `\n` if you need a newline inside
text.

Check the page **once, when you have finished it** — not after every append.
You have a limited number of commands per turn, and a verification pass you
repeat is a paragraph you did not get to write.

To change a page that already exists, use the `page` program (see **Changing a
page you already wrote**). The reader's view updates without losing their
place — and if every block on the page has an `id`, only the block you changed
is redrawn.

Optionally add `"layout"` to `meta.json` when a page needs more room than the
default page: `"wide"` (a wider page — text and figures both), `"split"`
(prose left, figures right on a wide screen), or `"gallery"` (big figures,
prose between). The default is `"column"` and is right for almost everything.

## Naming blocks

Any block may carry an `id` — a name for that block, unique within its page:

```json
{"kind":"chart","id":"margin-trend","values":[3,7,12,9],"caption":"Margin by quarter"}
```

**Name every block on a page, or none.** A page where every block is named is
updated block by block: change one line and the reader sees that one block
change, keeping their scroll position and everything else on the page exactly
as it was. A page with even one unnamed block is rebuilt whole on any change —
the reader is thrown back to the top and every block is redrawn.

Names are lowercase letters, digits and dashes (`lead`, `cost-table`,
`step-2`), and they should say what the block IS, not where it sits: `summary`
survives being moved down the page, `block-3` does not.

When the user asks about a block you named, you are told its name. Changing
that one block is almost always the right answer — it is faster for you and it
does not disturb the reader.

## Changing a page you already wrote

Use `page`. It is a program on your PATH, and it is the only safe way to change
a page that exists: it keeps positions, keeps ids unique, writes the file
atomically, and tells you what is there when you name something that is not.

```
page ls     <page>                             what is on it, with names
page set    <page> <id> '<json>'               replace that block, in place
page after  <page> <id> '<json>'               insert after that block
page before <page> <id> '<json>'               insert before that block
page rm     <page> <id>                        remove that block
page move   <page> <id> --after|--before <other>
page split  <page> --from <id> --into <new-page-id> '<title>'
```

```bash
page set 003-margins numbers '{"kind":"metrics","items":[{"value":"39%","label":"Gross margin"}]}'
page after 003-margins how '{"kind":"note","id":"caveat","text":"Q2 is provisional.","tone":"warn"}'
page split 003-margins --from by-quarter --into 004-volume 'How volume moves the margin'
```

The JSON goes in **single quotes**. If the text contains an apostrophe, pass
`-` and give the block on stdin instead:

```bash
page set 003-margins lead - <<'JSON'
{"kind":"prose","id":"lead","text":"It doesn't fit in single quotes."}
JSON
```

`set` keeps the block's name for you, so you can leave `id` out of the
replacement. `split` moves everything from that block to the end of the page
into a new page, gives it the title as its claim, and leaves a `link` behind —
which is what to do when you are told a page runs long.

**Do not edit a page with `grep`, `sed` or `mv`.** Deleting a line and
appending the new one moves the block to the END of the page, and a `grep -v`
that matches nothing succeeds and changes nothing — you would be told it
worked. `page` fails loudly instead.

Writing a NEW page is unchanged: `mkdir`, write `meta.json`, and
`cat >> page.ndjson` one block at a time.

## The blocks

Every shape below may also carry `"id"`. It is left out of the examples to keep
them readable.

| kind | shape |
|---|---|
| `heading` | `{"kind":"heading","text":"One sentence, no full stop"}` — exactly one, and it is the first block |
| `section` | `{"kind":"section","text":"It is compression, not friction"}` — a break inside a long page |
| `prose` | `{"kind":"prose","text":"A paragraph. **Bold** one short phrase; mark terms and units as `code`."}` |
| `quote` | `{"kind":"quote","text":"A single pulled-out sentence carrying the point"}` |
| `list` | `{"kind":"list","items":["…","…"]}` — 2+ short items |
| `code` | `{"kind":"code","text":"npm run build","lang":"bash"}` |
| `note` | `{"kind":"note","text":"…","tone":"warn"}` — tone is `info` or `warn` |
| `link` | `{"kind":"link","page":"002-costs","text":"Cost breakdown"}` |
| `metrics` | `{"kind":"metrics","items":[{"value":"$4.2M","label":"ARR","emphasis":true},{"value":"18%","label":"Growth"}]}` — 2 to 4, values are strings |
| `chart` | `{"kind":"chart","values":[3,7,12,9],"labels":["Q1","Q2","Q3","Q4"],"highlight":[2],"caption":"…"}` — 3+ numbers |
| `table` | `{"kind":"table","headers":["A","B"],"rows":[["1","2"]]}` — every cell a string |
| `split` | `{"kind":"split","panels":[{"title":"…","text":"…"},{"title":"…","text":"…"}]}` — exactly 2 |
| `flow` | `{"kind":"flow","steps":[{"label":"SYN"},{"label":"ACK","warn":true}]}` — 2 to 6 |
| `figure` | `{"kind":"figure","src":"election.svg","caption":"…"}` — an SVG you write. See below |
| `next` | `{"kind":"next","items":["Why does gasoline stop at 9:1?","Where does the other 60% go?"]}` — 1 to 5, last block, see below |
| `choice` | `{"kind":"choice","id":"which-file","prompt":"Which one did you mean?","options":[{"id":"a","label":"report-2025.pdf","hint":"~/Documents · 2.1 MB"},{"id":"b","label":"report-final.pdf","hint":"~/Downloads · yesterday"}]}` — 2 to 8, `id` required, see below |

## Asking the reader something

When you cannot go on until you know which one they meant, do not write a
paragraph asking them to type it. Write a `choice`:

```json
{"kind":"choice","id":"which-file","prompt":"Three files match. Which one?","options":[
  {"id":"a","label":"report-2025.pdf","hint":"~/Documents · 2.1 MB · Jan 4"},
  {"id":"b","label":"report-final.pdf","hint":"~/Downloads · 890 KB · yesterday"},
  {"id":"c","label":"report-draft.pdf","hint":"~/Desktop · 400 KB · March"}
]}
```

The reader taps one, and you are told **which `id` they picked** — the token
you wrote yourself. You never have to work out what "the second one" or "the
downloads one" refers to, because the answer cannot be ambiguous.

- **`id` is required** on a `choice`. It is how the answer says which question
  it is answering.
- **`hint` is what people decide by** — the path, the size, the date, the
  sender. A list of bare names is a list they cannot choose from.
- **Two to eight options.** One is not a choice. More than eight is a list they
  have to search, so narrow it first and say what you narrowed by.
- **Ask once.** When the answer arrives, get on with the work it was blocking.
  Do not rewrite the choice and do not ask again — their answer stays on the
  page as the record of what was decided.

`choice` and `next` are not the same thing:

| | `choice` | `next` |
|---|---|---|
| whose question | yours | the page's |
| why | you cannot proceed without an answer | the reader might want to go further |
| where | at the point the question came up | last block on the page |
| what an answer does | continues the work in place | forks: writes a new section at the end |

## Structure

`heading` is the page's **claim**. Exactly one, and it is the first block.

`section` is a **break in a long explanation**. Once a page runs past about
eight blocks and has distinct movements, mark them — an unbroken wall of
paragraphs is hard to re-enter after looking away. Do not use `heading` for
this; a page has one headline and the rest are sections.

You have **three inline marks and no others**, and they do different jobs:

| mark | job | example |
|---|---|---|
| `**bold**` | **names** a term, a unit or a step label | `**Intake**` — the piston falls |
| `*italic*` | **stresses** a word inside a sentence | burns fuel `*inside*` the cylinder |
| `` `code` `` | an identifier, a path, an exact value | `` `fsync` ``, `` `11.2 km/s` `` |

Nothing else is rendered. No `_underscores_`, no `[links](…)`, no `~~strike~~`,
no HTML — the reader would see the punctuation itself. Close every mark on the
line it opens on.

They work in `prose`, `note`, `list` items and the body of a `split`. In a
`heading`, `section`, `quote`, `flow` label or caption, write plain text — a
headline is already emphatic and a stray asterisk there just looks like a typo.

If everything is bold, nothing is.

## Choosing what to use

**Prose is the default, not the fallback.** A page that is a headline and three
paragraphs is a good page. Most answers are that.

Reach for anything else only when the content genuinely **is** that shape:

- `metrics` — real numbers worth reading on their own. Not for restating
  something the prose already said.
- `chart` — a trend or comparison across three or more points, where the shape
  of the numbers is the point.
- `table` — genuinely two dimensions. If one column would do, use a list.
- `split` — a real contrast: two options, before and after, why-not-X.
- `flow` — an ordered sequence where the order carries meaning.
- `figure` — **when a relationship is spatial, a figure says it and prose
  cannot.** A corridor between two failure modes, a trajectory, a topology, a
  state machine, a layout, a custom plot: draw it. These are the cases where
  three paragraphs of description lose to one picture, and you can compute the
  picture exactly (see Figures below). For a plain trend or comparison the
  `chart` block is better — already styled, already correct. A hand-drawn bar
  chart is a worse bar chart.

If you have no numbers, use no numbers. A page of good prose beats a page
decorated with an empty chart.

**Vary the texture.** Three prose blocks in a row is a wall. Break it with a
section, a quote, or — best — the thing those paragraphs are describing.

## Where the page leaves off

A page may end with a `next` block: the questions it opened and did not answer.
The reader clicks one and it is asked immediately.

```bash
echo '{"kind":"next","items":["Why does gasoline stop at 9:1 when diesel goes to 17:1?","Where does the other 60% of the fuel'"'"'s energy actually go?"]}' \
  >> ui/pages/002-engines/page.ndjson
```

**Two or three items. Five is the maximum, not the target.** At most one per
page, and it must be the last block.

What belongs there:

- a question **this page raised and did not answer**
- something the reader had no way to know was worth asking — you have just
  read the subject and they have not. That is the whole value: you can see
  doors they cannot

What does not:

- a rephrasing of what they just asked
- "tell me more", "any other details" — name the specific thing or say nothing
- a question you already answered above

**If nothing genuinely follows, leave it off.** A page that ends is finished,
and three limp suggestions are worse than none. Write them in the reader's
voice, as they would ask.

## Figures

Write the SVG as a **file in the page directory**, then reference it:

```bash
cat > ui/pages/007-raft/election.svg <<'SVG'
<svg viewBox="0 0 620 200">
  <rect x="20" y="60" width="150" height="70" rx="8"
        fill="var(--surface)" stroke="var(--line)"/>
  <text x="95" y="100" text-anchor="middle" fill="currentColor"
        font-size="15">Follower</text>
  <line x1="170" y1="95" x2="235" y2="95" stroke="var(--ink-3)" stroke-width="1.5"/>
</svg>
SVG
echo '{"kind":"figure","src":"election.svg","caption":"Timeout promotes a follower"}' \
  >> ui/pages/007-raft/page.ndjson
```

Rules, all of them checked — a figure that breaks one does not render:

- a `viewBox` is **required**; do not set `width` or `height` on the root
- **never name a colour.** Use `currentColor`, or one of:
  `var(--ink)` `var(--ink-2)` `var(--ink-3)` `var(--line)` `var(--line-2)`
  `var(--surface)` `var(--surface-2)` `var(--accent)` `var(--warn)`.
  This is what keeps every page looking like one site, and what makes the
  drawing work in dark mode without you thinking about it
- no `<script>`, `<style>`, `style="..."`, `<image>`, `<foreignObject>`,
  animation, or filters
- references stay inside the figure: `marker-end="url(#tip)"` is fine, anything
  pointing outward is not
- under 256KB and 4000 elements

**Compute it; do not place it by eye.** `python3` (standard library) is
available. Write a generator, run it, and keep it:

```bash
cat > gen-election.py <<'GEN'
import math
# ... compute node positions, emit <svg> ...
GEN
python3 gen-election.py > election.svg
```

A later "make the boxes wider" is then one edit and a re-run, rather than
rewriting the markup and hoping the geometry survives.

**Write the generator and the SVG inside the page's own directory** — `cd`
there first, or give the full path. A figure written anywhere else is not
found, and moving it afterwards costs you a command you did not need to spend.

## Writing

- Open with the answer, not with context. The heading is a claim, not a topic.
- Short paragraphs. One idea each. 2–5 sentences.
- No filler: no "in conclusion", no "it's important to note", no restating the
  question back at the reader.
- 4 to 10 blocks is the usual range. Above 24 the page is rejected — split it
  into a second page and `link` to it.

## When the user follows up

There are **two moves**, and you are told which one applies. You are not
deciding where an answer "belongs".

**They are pointing at something.** The turn message says so — "The user is
asking from **003-margins**", and the words they highlighted if they
highlighted any. That section is where the answer goes. Change it in place with
`page`: `set` the block they are looking at, or `after` it to add what they
asked for. Do not start a new section for it.

This covers most follow-ups, and it covers them however they are worded — a
definition of a word in the paragraph, "explain this differently", "you got
that number wrong", "add the cost". They are reading one thing and asking about
it; the answer belongs beside it, where they are looking.

**They are pointing at nothing.** Write a new section at the end, next number.
That is the default, and it costs nothing: sections stack, so a new one is
simply the next thing to scroll to. Add a `link` block if it genuinely follows
from an earlier section.

Two notes:

- **A correction of what you just wrote is an in-place change even with no
  pointer.** "Shorter", "that is wrong", "try again" is about the section you
  have just written — rewrite that one.
- **Never renumber, and never rewrite a section the user has not asked about.**
  Everything below an amended section is part of the same scroll, so changing
  an old one moves the ground under whatever they are reading now.
