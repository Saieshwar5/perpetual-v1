/**
 * A runtime that scripts shell commands instead of calling a model.
 *
 * Set PERPETUAL_REPLAY=1. It is not a mock of the model — it drives the REAL
 * loop, the REAL sandboxed shell, and the REAL watcher, so what it exercises
 * is everything except the model's judgement. That makes the whole system
 * developable and demonstrable before an API key exists, and means a UI
 * regression can never hide behind "the model was slow today".
 *
 * The commands it issues are exactly the ones prompts/rules.md teaches, which
 * makes this the executable copy of that document: if the rules change and
 * this replay stops producing a valid page, the rules were wrong.
 */
import type { Conversation, Runtime, Step, StepEvent, StepResult, ToolCall } from "./runtime.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-")
    || "answer";
}

/**
 * The workspace script, for an ask that wants a surface rather than a page.
 *
 * Same job as the page script below: an executable copy of what rules.md
 * teaches, so a rule that stops working shows up here before it shows up in a
 * session. It also makes the whole workspace path — the second watcher, the
 * panel, the run-a-row endpoint — testable with no model and no credentials.
 */
function workspacePlan(ask: string, num: string): { say: string; command: string }[] {
  const id = `${num}-${slugify(ask)}`;
  const dir = `ui/pages/${id}`;
  const meta = JSON.stringify({ title: "Files", ask });

  return [
    {
      say: "Looking for what matches.",
      command: "mkdir -p workspace/notes workspace/reports && "
        + "printf 'margins held\n' > workspace/reports/q3-margins.csv && "
        + "printf 'the board deck\n' > workspace/notes/board-deck.md && "
        + "printf 'older numbers\n' > workspace/reports/q2-margins.csv && "
        + "find workspace -name '*margin*' -o -name '*deck*' | head",
    },
    {
      say: "Opening a workspace for them.",
      // The script every row points at: one place that knows how to draw a
      // file, so a row is a command rather than a program.
      command: `mkdir -p ui/apps/files && cat > ui/apps/files/show <<'SH'
#!/bin/bash
# usage: show --list | show <path> | show --rename <path>
cd "$(dirname "$0")/../../.." || exit 1
list() {
  cat > ui/apps/files/meta.json <<'M'
{"title":"Files","view":"3 matches"}
M
  cat > ui/apps/files/view.ndjson <<'V'
{"kind":"rows","id":"matches","items":[{"id":"q3","title":"q3-margins.csv","meta":"workspace/reports · 4.2 KB · Tuesday","note":"margins held at 38% through the cost rise","state":"unread","run":"ui/apps/files/show workspace/reports/q3-margins.csv","actions":[{"id":"rename","label":"Rename","run":"ui/apps/files/show --rename workspace/reports/q3-margins.csv"}]},{"id":"deck","title":"board-deck.md","meta":"workspace/notes · 18 KB · last month","note":"the board deck","run":"ui/apps/files/show workspace/notes/board-deck.md"},{"id":"q2","title":"q2-margins.csv","meta":"workspace/reports · 3.9 KB · April","note":"older numbers","state":"done","run":"ui/apps/files/show workspace/reports/q2-margins.csv"}]}
V
}
if [ "$1" = "--list" ]; then list; exit 0; fi
if [ "$1" = "--rename" ]; then
  f="$2"
  if [ -n "$FIELD_NAME" ]; then
    mv "$f" "$(dirname "$f")/$FIELD_NAME" && list
    exit 0
  fi
  cat > ui/apps/files/meta.json <<M
{"title":"Files","view":"rename"}
M
  {
    printf '{"kind":"heading","text":"Rename this file"}\\n'
    printf '{"kind":"fields","items":[{"label":"Path","value":"%s"},{"label":"Size","value":"%s bytes"}]}\\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
    printf '{"kind":"form","id":"rename","submit":"Rename","run":"ui/apps/files/show --rename %s","fields":[{"id":"name","label":"New name","type":"text","value":"%s","required":true}]}\\n' "$f" "\${f##*/}"
    printf '{"kind":"confirm","id":"drop","prompt":"Delete this file instead?","detail":"%s · this cannot be undone","confirm":"Delete","cancel":"Keep it","run":"rm -f %s && ui/apps/files/show --list"}\\n' "$f" "$f"
  } > ui/apps/files/view.ndjson
  exit 0
fi
f="$1"
{
  printf '{"kind":"heading","text":"%s"}\\n' "\${f##*/}"
  printf '{"kind":"fields","items":[{"label":"Path","value":"%s"},{"label":"Size","value":"%s bytes"}]}\\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
  printf '{"kind":"code","text":%s,"lang":"text"}\\n' "$(head -c 300 "$f" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
  printf '{"kind":"rows","id":"actions","items":[{"id":"back","title":"Back to the matches","meta":"the three files","run":"ui/apps/files/show --list"},{"id":"explain","title":"Explain what this file is","meta":"asks the agent — this one needs judgement"}]}\\n'
} > ui/apps/files/view.ndjson
cat > ui/apps/files/meta.json <<M
{"title":"Files","view":"\${f##*/}"}
M
SH
chmod +x ui/apps/files/show && ui/apps/files/show --list && echo opened`,
    },
    {
      say: "Saying what I found.",
      command: `mkdir -p ${dir} && cat > ${dir}/meta.json <<'META'
${meta}
META
cat >> ${dir}/page.ndjson <<'NDJ'
{"kind":"heading","text":"Three files mention margins"}
{"kind":"prose","text":"They are open in the workspace beside this. Pick one to read it — that costs nothing, because the row carries the command that opens it. Ask me about one when you want an opinion rather than the contents."}
NDJ
echo wrote`,
    },
  ];
}

function plan(ask: string, num: string): { say: string; command: string }[] {
  if (/\bfile|files|find\b/i.test(ask)) return workspacePlan(ask, num);
  const id = `${num}-${slugify(ask)}`;
  const dir = `ui/pages/${id}`;
  const esc = (s: string) => JSON.stringify(s);
  const meta = JSON.stringify({ title: ask.split(/\s+/).slice(0, 4).join(" "), ask });

  return [
    {
      say: "Looking at what is already here.",
      command: "ls -la ui/pages/ && echo '---' && cat ui/pages/*/meta.json 2>/dev/null | head -20",
    },
    {
      say: "Starting the page.",
      command: `mkdir -p ${dir} && cat > ${dir}/meta.json <<'META'\n${meta}\nMETA\necho wrote meta`,
    },
    {
      say: "Writing the opening.",
      command: `cat >> ${dir}/page.ndjson <<'NDJ'
{"kind":"heading","text":"A replayed page, written by shell, one line at a time"}
{"kind":"prose","text":${esc(`You asked: ${ask}. There is no model behind this page — a scripted sequence of shell commands wrote it into the session directory, and the controller turned those writes into what you are reading.`)}}
NDJ
echo 2 blocks`,
    },
    {
      say: "Adding the detail.",
      command: `cat >> ${dir}/page.ndjson <<'NDJ'
{"kind":"section","text":"How a line becomes a block"}
{"kind":"prose","text":"Each line above appeared the moment it was appended. Nothing announced it. The controller re-reads this directory every \`120ms\` and turns the difference into events, so the filesystem is the only thing the renderer trusts."}
{"kind":"flow","steps":[{"label":"shell appends a line"},{"label":"watcher diffs the directory"},{"label":"block slides onto the page"}]}
{"kind":"metrics","items":[{"value":"1","label":"tool","emphasis":true},{"value":"1","label":"website per session"},{"value":"120ms","label":"watch interval"}]}
NDJ
echo 5 blocks`,
    },
    {
      say: "Computing the diagram.",
      command: `cat > ${dir}/gen.py <<'GEN'
import math
W, R = 620, 62
xs = [110, 310, 510]
out = ['<svg viewBox="0 0 %d 210">' % W]
out.append('<defs><marker id="tip" viewBox="0 0 8 8" refX="7" refY="4" '
           'markerWidth="7" markerHeight="7" orient="auto">'
           '<path d="M0 0 L8 4 L0 8 z" fill="var(--ink-3)"/></marker></defs>')
for x, label in zip(xs, ["shell appends", "watcher diffs", "block lands"]):
    out.append('<rect x="%d" y="70" width="%d" height="70" rx="9" fill="var(--surface)" '
               'stroke="var(--line)"/>' % (x - R, 2 * R))
    out.append('<text x="%d" y="110" text-anchor="middle" font-size="14" '
               'fill="currentColor">%s</text>' % (x, label))
for a, b in zip(xs, xs[1:]):
    out.append('<line x1="%d" y1="105" x2="%d" y2="105" stroke="var(--ink-3)" '
               'stroke-width="1.5" marker-end="url(#tip)"/>' % (a + R + 6, b - R - 12))
out.append('<text x="310" y="185" text-anchor="middle" font-size="12" '
           'fill="var(--accent)">120ms, every time</text>')
out.append('</svg>')
print("".join(out))
GEN
python3 ${dir}/gen.py > ${dir}/figure.svg && wc -c < ${dir}/figure.svg`,
    },
    {
      say: "Placing the figure.",
      command: `cat >> ${dir}/page.ndjson <<'NDJ'
{"kind":"figure","src":"figure.svg","caption":"The path a block takes — drawn by a script in this page's own directory","alt":"Three boxes joined by arrows"}
NDJ
echo placed`,
    },
    {
      say: "Closing it out.",
      command: `cat >> ${dir}/page.ndjson <<'NDJ'
{"kind":"section","text":"Where the boundary sits"}
{"kind":"split","panels":[{"title":"What the agent controls","text":"Everything inside the session directory: the pages, their order, their content, and its own scratch space."},{"title":"What it never touches","text":"The rail, the header, the session list, and the record of what happened. That chrome is the backbone and is not generated."}]}
{"kind":"quote","text":"The agent does not return a page. It writes one, and the renderer notices."}
{"kind":"next","items":["How does a half-written line stay invisible?","What stops the agent writing outside its session?","Why is the tier derived instead of declared?"]}
NDJ
ls -l ${dir}`,
    },
  ];
}

export function createReplayRuntime(): Runtime {
  return {
    modelId: "replay",
    providerId: "replay",
    // Big enough that the context guard never fires in replay: the scripted
    // turn is fixed, so a warning about running out would be noise.
    contextWindow: 1_000_000,
    conversation(): Conversation {
      let ask = "";
      let num = "001";
      let index = 0;

      return {
        user(text) {
          const m = /\b(\d{3})-<slug>/.exec(text);
          if (m) num = m[1]!;
          const at = text.indexOf("--- The user now asks ---");
          // A nudge has no marker; it must not overwrite the real question.
          if (at !== -1) ask = text.slice(at).split("\n").slice(2).join("\n").trim();
          else if (!ask) ask = text.trim();
        },
        toolResult() { /* the script does not branch on output */ },
        step(): Step {
          const steps = plan(ask, num);
          const here = steps[index++];
          let calls: ToolCall[] = [];

          async function* iterate(): AsyncIterable<StepEvent> {
            if (!here) return;                       // out of script: end the turn
            for (const word of here.say.split(" ")) {
              await sleep(24);
              yield { type: "text_delta", delta: word + " " };
            }
            const call: ToolCall = {
              id: `replay-${index}`, name: "shell", args: { command: here.command },
            };
            calls = [call];
            yield { type: "tool_call", call };
          }

          const it = iterate()[Symbol.asyncIterator]();
          return {
            [Symbol.asyncIterator]: () => it,
            async result(): Promise<StepResult> {
              while (true) { const n = await it.next(); if (n.done) break; }
              return {
                calls,
                usage: { input: 1800, output: 240, cacheRead: index > 1 ? 1600 : 0, costUsd: 0 },
                stopReason: calls.length ? "toolUse" : "stop",
              };
            },
          };
        },
      };
    },
  };
}
