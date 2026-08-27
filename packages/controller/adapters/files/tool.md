---
name: files
title: Files
surface: workspace
summary: search and read files in this session's workspace directory
check: files --self-test
needs: []
---

# Files

Searching the session's own `workspace/` directory, and reading what is found.
Nothing outside it exists — the sandbox has no home directory and no network.

## Commands

```
files find <pattern>      search names and contents, and open the results
files show <path>         show one file: its facts, and the first of its text
files list                the results again, after a detour
```

Every one of them **writes the workspace view itself** — you do not have to
build the JSON. Run the command; the reader sees the result.

```bash
files find margin        # opens ui/apps/files/ with the matches
```

## When to open a workspace, and when not to

**Open one** when the answer is a list the reader will pick from: "find my
notes about X", "which config files mention Y", "what is in this directory".
Picking is the point, and picking is what a workspace is for.

**Do not open one** for a question that has an answer. "How many TypeScript
files are there?" is a sentence. "What does line 40 of server.ts say?" is a
`code` block in a section. A workspace for those is a filing cabinet handed to
someone who asked what time it is.

When you open one, still write a short section saying what you found and what
they can do with it — the workspace is scratch, and the section is what remains
after it closes.

## What the view looks like

`files find` builds this, and it is the shape to follow if you build one by
hand for a search this tool cannot do:

- one `rows` block, `id` of `matches`
- **title** — the file's name alone, not its path. The path is `meta`.
- **meta** — `<directory> · <size> · <modified>`, in that order. This is what
  people actually scan.
- **note** — the first matching line, trimmed. Leave it out for a name-only
  match; a note that says nothing is a row that is harder to read.
- **run** — `files show <path>`, so opening a file costs no turn.
- **state** — leave unset. A file is not unread.

The detail view is a `heading` of the filename, a `fields` block of path, size
and modified, a `code` block of the first 40 lines, and a `rows` block with two
entries: *Back to the matches* (which carries `run`) and *Explain what this file
is* (which does not, so it asks you — that is the one that needs judgement).

## What it will not do

No writing, moving or deleting. This adapter reads. If the reader asks to
change a file, do it with your own shell in the normal way — and if it is
destructive, put a `confirm` in front of it first.
