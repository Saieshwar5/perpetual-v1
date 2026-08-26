// Minimal Chrome DevTools Protocol driver: launch, evaluate, report.
const port = 9333;
const url = process.argv[2];
const script = await (await import("node:fs/promises")).readFile(process.argv[3], "utf8");

const { spawn } = await import("node:child_process");
const chrome = spawn("chromium", [
  "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, "--window-size=1440,900", url,
], { stdio: "ignore", detached: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  } catch { /* not up yet */ }
}
if (!target) { console.error("chromium never came up"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const mine = ++id;
  const onMsg = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === mine) { ws.removeEventListener("message", onMsg); resolve(m.result); }
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id: mine, method, params }));
});

await sleep(2500);                                   // let the app boot and fit
const r = await send("Runtime.evaluate", {
  expression: script, awaitPromise: true, returnByValue: true,
});
console.log(r.result?.value ?? JSON.stringify(r.exceptionDetails ?? r, null, 1));
ws.close();
try { process.kill(-chrome.pid); } catch { /* gone */ }
process.exit(0);
