# tools/

A two-hundred-line Chrome DevTools Protocol driver, kept because estimating
layout was wrong three times in a row and measuring was right every time.

```bash
pnpm dev                                    # in one shell
node tools/drive.mjs "http://127.0.0.1:4321/#/s/<id>" tools/probe-aim.js
```

`drive.mjs` launches headless chromium, waits for the app to settle, evaluates
a probe file in the page, and prints whatever it returns.

- `probe-aim.js`  — opens the composer, clicks blocks, checks the anchor moves
- `probe-wire.js` — intercepts the turn request and checks the clicked block
                    is the one that reaches the server
- `probe-next.js` — clicks one of the agent's suggested next questions and
                    checks it becomes a turn
- `probe-fork.js` — walks through one door and checks the others close
- `probe-measure.js` — the real characters-per-line, and how wide each kind of
                    block actually renders
- `probe-app.js`   — the workspace panel: it opens beside the site, a row with
                    a command runs WITHOUT a turn, back returns to the list,
                    and closing removes the directory
- `probe-shell.js` — the one-page shell: sidebar widths and persistence, the
                    site clearing it, questions in the scroll (and never being
                    pointable), section navigation, search, new session

It found the "instant" scroll that was quietly animating (`behavior: "auto"`
means "ask CSS", and CSS said `smooth`, so every session opened halfway up its
own site) and a click-to-anchor bug that
no unit test would have caught — opening the composer recomputed the implicit
anchor on top of the one the reader had just chosen.
