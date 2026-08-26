# Perpetual

An agent interface with no chat in it.

The agent answers by **building a website**. One session is one site; its pages
are what the reader scrolls between. There is no message list, no bubbles, and
no plain-text reply — if the agent has not written a page, from the user's side
it has not said anything.

## The idea in one diagram

```
┌─ FIXED CHROME ──────────────────────────────────────┐
│  library · header · rail · composer                 │
│  hand-built, identical in every session, ours       │
│                                                     │
│   ┌─ THE CANVAS ────────────────────────────────┐   │
│   │  rendered from files in the session dir,    │   │
│   │  and from nothing else. the agent's.        │   │
│   └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

The agent has **one tool: a shell**, in a bubblewrap sandbox whose only
writable path is the session directory. To say something it writes a file. The
controller watches that directory and turns every change into an event, so the
renderer trusts the filesystem and never the agent.

## Run it

```bash
pnpm install
pnpm replay                     # no API key needed — scripted shell commands
```

...then open http://127.0.0.1:4321. Replay drives the real loop, the real
sandbox and the real watcher; only the model's judgement is faked.

With a key — put it in `.env` (gitignored, loaded automatically):

```bash
cp .env.example .env      # then fill in the key
pnpm dev
```

```ini
# Fireworks
PERPETUAL_PROVIDER=fireworks
FIREWORKS_API_KEY=fw_...
PERPETUAL_MODEL=deepseek-v4-pro

# Anthropic (the default provider)
ANTHROPIC_API_KEY=sk-ant-...
```

`pnpm models fireworks` lists the catalogue — 23 models with context windows
and prices, no key needed. Short names work: `deepseek-v4-pro` expands to
`accounts/fireworks/models/deepseek-v4-pro`.

| variable | default | |
|---|---|---|
| `PERPETUAL_PROVIDER` | `anthropic` | `anthropic` or `fireworks` |
| `<PROVIDER>_API_KEY` | — | required unless `PERPETUAL_REPLAY=1` |
| `PERPETUAL_MODEL` | per provider | short name or full id |
| `PERPETUAL_EFFORT` | `low` | `minimal` … `max` |
| `PERPETUAL_HOME` | `./.perpetual` | where sessions live |
| `PERPETUAL_NET` | off | grant the sandbox network access |
| `PERPETUAL_UNSAFE` | off | run with NO sandbox. development only |

`bubblewrap` is required. Without it the controller refuses to start rather
than silently running an agent's shell commands unconfined.

## A session on disk

```
.perpetual/sessions/<id>/
  session.json            index: title, asks, page count
  transcript.jsonl        one line per turn
  log.jsonl
  site/                   ← the sandbox bind mount. the agent's world.
    ui/pages/001-slug/
      meta.json           {"title":…,"ask":…,"tier":2}
      page.ndjson         one JSON block per line, append-only
    workspace/            scratch. the renderer never looks here.
```

One directory is the session, the sandbox, the website, and the export bundle.
Nothing has to be kept in sync because there is only one copy of anything.

## Why NDJSON

`page.ndjson` is append-only, one block per line, and the controller reads only
what precedes the last newline. That single choice buys three things at once:

- **streaming** — each appended line is a block sliding onto the reader's page
- **atomicity** — a block is wholly there or not there; no locking
- **shell-nativeness** — `cat >>` is the most natural thing a shell can do

## Layout

```
packages/shared/       block vocabulary + validator, site types, wire events
packages/controller/   the local controller
  src/shell/           output.ts · sandbox.ts · tool.ts   ← the one tool
  src/site.ts          reads and VERIFIES the website
  src/watcher.ts       directory diff → events
  src/agent.ts         the loop
  src/runtime.ts       the only file that imports pi-ai
  prompts/             agent.md · rules.md   ← the main tuning knob
packages/client/       chrome, deck, rail, block renderer
proj-docs/plans/       the design, in 16 documents
```

## Test

```bash
pnpm test        # 32 tests: validator, output, sandbox containment, site rules, a full turn
pnpm typecheck
```

The sandbox tests are the ones that matter: they assert that the API key is
invisible from inside, that `$HOME` does not exist, that only the session
directory is writable, that there is no network, and that a backgrounded
grandchild cannot outlive its command.
