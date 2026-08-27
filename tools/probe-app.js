/**
 * The workspace panel, checked in a real browser.
 *
 * The claim that matters most is the one about COST: clicking a row that
 * carries its own command must not start a turn. If that ever regresses, the
 * panel still works and quietly becomes a chatbot — three seconds and a model
 * call to open a file you can already see.
 *
 * Run it against a session with a workspace open:
 *
 *   pnpm replay                                    # in one shell
 *   # ask it "find my files about margins", then:
 *   node tools/drive.mjs "http://127.0.0.1:4321/#/s/<id>" tools/probe-app.js
 */
(async () => {
  const out = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const app = document.getElementById("app");
  const p = document.getElementById("apppanel");
  const site = document.getElementById("site");

  out.push(`panel open      ${!p.hidden}  app[data-panel] ${JSON.stringify(app.dataset.panel)}`);
  out.push(`title / view    ${JSON.stringify(p.querySelector(".ptitle").textContent)} / ${JSON.stringify(p.querySelector(".pview").textContent)}`);
  out.push(`sidebar         ${JSON.stringify(document.documentElement.dataset.side)} (collapsed to make room)`);
  const sr = site.getBoundingClientRect(), pr = p.getBoundingClientRect();
  out.push(`no overlap      site right ${Math.round(sr.right)}  panel left ${Math.round(pr.left)}`);
  const rows = [...p.querySelectorAll(".copt")];
  out.push(`rows            ${rows.length}  first ${JSON.stringify(rows[0]?.textContent?.slice(0, 40))}`);

  // clicking a row must NOT start a turn
  const before = document.querySelectorAll(".turn").length;
  const t0 = performance.now();
  rows[0].click();
  for (let i = 0; i < 40 && p.querySelector(".ptitle").textContent === "Files" && !p.querySelector(".pdoc h1"); i++) await sleep(100);
  await sleep(300);
  out.push(`clicked a row   ${Math.round(performance.now() - t0)}ms  view now ${JSON.stringify(p.querySelector(".pview").textContent)}`);
  out.push(`  shows         ${JSON.stringify(p.querySelector(".pdoc h1")?.textContent)}  code ${!!p.querySelector(".pdoc code")}`);
  out.push(`  turns started ${document.querySelectorAll(".turn").length - before} (0 = no model was asked)`);

  // and back
  const back = [...p.querySelectorAll(".copt")].find(b => /Back/.test(b.textContent));
  back.click();
  await sleep(600);
  out.push(`back            view ${JSON.stringify(p.querySelector(".pview").textContent)}  rows ${p.querySelectorAll(".copt").length}`);

  // widen, then restore
  p.querySelector(".pwide").click();
  await sleep(300);
  out.push(`widened         panel ${Math.round(p.getBoundingClientRect().width)}px`);
  p.querySelector(".pwide").click();
  await sleep(300);

  // a row with no command asks the agent instead
  const ask = [...p.querySelectorAll(".copt")];
  out.push(`rows again      ${ask.length}`);

  // the panel's own composer exists and is scoped
  out.push(`panel composer  ${JSON.stringify(p.querySelector(".pask input").placeholder)}`);

  // closing takes it away
  p.querySelector(".pclose").click();
  await sleep(500);
  out.push(`closed          hidden ${p.hidden}  data-panel ${JSON.stringify(app.dataset.panel)}  site right ${Math.round(site.getBoundingClientRect().right)}`);
  const sid = location.hash.replace("#/s/", "");
  const still = await (await fetch(`/sessions/${sid}/apps`)).json();
  out.push(`  on disk       ${JSON.stringify(still.apps.map(a => a.id))} (empty = closing removed it)`);
  return out.join("\n");
})()
