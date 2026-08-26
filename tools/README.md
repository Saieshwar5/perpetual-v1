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

It found the adaptive-columns crossover (my estimate said four of five pages
would fit; the first measurement said none did) and a click-to-anchor bug that
no unit test would have caught — opening the composer recomputed the implicit
anchor on top of the one the reader had just chosen.
