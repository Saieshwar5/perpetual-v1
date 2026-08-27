---
name: git
title: Git
surface: page
summary: read a repository's history — answers belong in a section, not a workspace
check: git --version
needs: []
---

# Git

A repository the reader has put in `workspace/`, read with the `git` already in
the sandbox. There is no `bin/` here: `git` is a real program with a real
manual, and wrapping it would only get in the way.

This adapter exists to say something more useful than "how to run git": **git
answers are page-shaped.** That is why it is here — the standard has to be able
to say "no workspace" as clearly as it says "workspace".

## Why a section and not a workspace

A workspace is for a list you pick from and act on. Almost nothing about
reading history is: "who last touched this file", "what changed in that
commit", "when did this test start failing" all have ANSWERS, and an answer
belongs in the record where it stays.

The exception is genuine browsing — "let me look through the last fifty
commits" — where picking is the point. Then open one, and follow the shape in
**Browsing**, below.

## The commands worth knowing

```bash
git -C workspace/<repo> log --oneline -20
git -C workspace/<repo> log -1 --format='%H%n%an%n%ad%n%s' <ref>
git -C workspace/<repo> show --stat <ref>
git -C workspace/<repo> blame -L 40,60 <file>
git -C workspace/<repo> diff --stat <a>..<b>
```

Always `-C`: the agent's working directory is the session root, not the repo.

## How to render what comes back

- **A list of commits** → a `table` with columns `When`, `Who`, `What`. Not a
  `list` — three fields is two dimensions.
- **One commit** → a `heading` of the subject, then `metrics` of files changed,
  insertions, deletions, then the body as `prose`, then `code` for the parts of
  the diff that carry the point. Never the whole diff: a section is an answer,
  not a paste.
- **Blame** → a `code` block with the lines, and `prose` naming who and when.
  The line numbers matter, so keep them.
- **A count or a date** → one sentence. `metrics` for a number nobody asked to
  compare is decoration.

## Browsing

If the reader really is browsing, one `rows` block of commits: **title** the
subject, **meta** `<author> · <relative date> · <short sha>`, **run** a command
that shows that commit into the view. A commit's `state` is never `unread`.

Close the workspace when they stop browsing, and write what they found into a
section — the workspace is scratch and the section is what remains.
