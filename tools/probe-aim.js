(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = [];
  const pill = document.getElementById("pill");
  const panel = document.querySelector(".panel.is-current");
  const doc = panel.querySelector(".doc");
  const aim = () => pill.querySelector(".aim").textContent;
  const ph  = () => pill.querySelector("input").placeholder;

  out.push(`page has ${doc.children.length} blocks, layout=${doc.className}`);
  out.push(`at rest: state=${pill.dataset.state} docked=${pill.classList.contains("docked")} placeholder=${JSON.stringify(ph())}`);

  pill.querySelector(".invite").click();
  await wait(150);
  out.push(`invoked: state=${pill.dataset.state} aim=${JSON.stringify(aim())} marked=${document.querySelectorAll(".anchored").length}`);

  const kinds = [...doc.children].map(n => n.tagName.toLowerCase() + "." + (n.className || ""));
  const i = kinds.findIndex(k => k.includes("metrics"));
  const target = doc.children[i > 0 ? i : 3];
  target.click();
  await wait(150);
  const marked = document.querySelector(".anchored");
  out.push(`clicked child #${[...doc.children].indexOf(target)} (${target.tagName.toLowerCase()}${target.className ? "." + target.className : ""})`);
  out.push(`  aim=${JSON.stringify(aim())}  markIsThatBlock=${marked === target}`);

  const other = doc.children[0];
  other.click();
  await wait(150);
  out.push(`clicked child #0 (${other.tagName.toLowerCase()}): aim=${JSON.stringify(aim())} markMoved=${document.querySelector(".anchored") === other}`);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  pill.querySelector("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(150);
  out.push(`escaped: state=${pill.dataset.state} marked=${document.querySelectorAll(".anchored").length} aimHidden=${pill.querySelector(".aim").hidden}`);
  return out.join("\n");
})()
