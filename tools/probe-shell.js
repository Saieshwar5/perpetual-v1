/**
 * The shell, checked in a real browser — the client's only regression net.
 *
 * Every assertion here is a claim that was made while building the one-page
 * shell, and every one of them was WRONG at least once during it: the site sat
 * behind the sidebar, the composer's "at the end" class went stale when a
 * figure finished laying out, and a rule meant for the last section of the
 * site matched every section because each one is now the last child of its own
 * turn.
 *
 * Run it against a session that has a few sections in it:
 *
 *   pnpm dev                                       # in one shell
 *   node tools/drive.mjs "http://127.0.0.1:4321/#/s/<id>" tools/probe-shell.js
 */
(async () => {
  const out = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const site = document.getElementById("site");
  const pill = document.getElementById("pill");

  out.push(`one page        views ${document.querySelectorAll(".view").length}  rail ${!!document.getElementById("rail")}`);
  out.push(`sidebar         width ${document.getElementById("side").getBoundingClientRect().width}  sessions ${document.querySelectorAll(".srow").length}`);
  out.push(`site left edge  ${Math.round(site.getBoundingClientRect().left)}  (should clear the sidebar)`);

  // opened at the foot, composer full
  out.push(`opened at end   ${site.scrollTop + site.clientHeight >= site.scrollHeight - 24}  atend ${site.classList.contains("atend")}  pill ${pill.dataset.size}`);

  // scrolling shrinks it, and the sidebar follows along
  site.scrollTo({ top: 0, behavior: "instant" });
  await sleep(300);
  out.push(`at top          pill ${pill.dataset.size}  active section ${document.querySelector(".ssec.on .slabel")?.textContent}`);

  // pointing still lands on a block, and never on a question
  const askP = document.querySelector(".ask p");
  askP.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 900, clientY: askP.getBoundingClientRect().top + 5 }));
  await sleep(150);
  out.push(`mouseup on ask  aim ${JSON.stringify(document.querySelector(".aimtext").textContent)}  (empty = questions are not pointable)`);

  const p = document.querySelector(".doc > p");
  p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: p.getBoundingClientRect().left + 5, clientY: p.getBoundingClientRect().top + 5 }));
  await sleep(200);
  out.push(`mouseup on block aim ${JSON.stringify(document.querySelector(".aimtext").textContent)}`);

  // the section list navigates
  const secs = document.querySelectorAll(".ssec");
  secs[secs.length - 1].click();
  await sleep(700);
  out.push(`clicked section  scrolled to ${Math.round(site.scrollTop)} of ${site.scrollHeight - site.clientHeight}`);

  // collapse persists
  document.getElementById("sidetoggle").click();
  await sleep(300);
  out.push(`collapsed        side attr ${document.documentElement.dataset.side}  width ${document.getElementById("side").getBoundingClientRect().width}  stored ${JSON.parse(localStorage.getItem("perpetual.settings")).sidebar}`);
  out.push(`  labels hidden  ${getComputedStyle(document.querySelector(".brand")).display}  search icon ${getComputedStyle(document.getElementById("searchmin")).display}`);
  document.getElementById("sidetoggle").click();
  await sleep(300);
  out.push(`expanded again   width ${document.getElementById("side").getBoundingClientRect().width}  search icon ${getComputedStyle(document.getElementById("searchmin")).display}`);

  // search filters
  const box = document.getElementById("sidesearch");
  box.value = "zzz-nothing";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  out.push(`search miss      rows ${document.querySelectorAll(".srow").length}  says ${JSON.stringify(document.querySelector(".sempty")?.textContent)}`);
  box.value = "";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(150);
  out.push(`search cleared   rows ${document.querySelectorAll(".srow").length}`);

  // new session clears the middle and centres the composer
  document.getElementById("newsession").click();
  await sleep(400);
  out.push(`new session      empty ${document.getElementById("app").dataset.empty}  turns ${document.querySelectorAll(".turn").length}  greeting ${JSON.stringify(document.querySelector(".firstrun h1")?.textContent)}`);
  out.push(`  hash           ${JSON.stringify(location.hash)}  active row ${document.querySelectorAll(".srow.on").length}`);
  return out.join("\n");
})()
