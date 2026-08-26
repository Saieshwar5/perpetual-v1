(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = [];
  const doors = () => [...document.querySelectorAll(".panel[data-page='001-how-does-a-block'] .nextq")]
    .map(r => `${r.classList.contains("taken") ? "taken " : r.classList.contains("spent") ? "spent " : "OPEN  "}${r.disabled ? "[inert] " : "[live]  "}${r.textContent.slice(0, 40)}`);

  out.push("BEFORE:"); out.push(...doors().map(d => "  " + d));

  document.querySelectorAll(".panel[data-page='001-how-does-a-block'] .nextq")[0].click();
  for (let i = 0; i < 40 && !document.querySelector(".nextq.taken"); i++) await wait(400);
  await wait(600);

  out.push("AFTER walking through the first:"); out.push(...doors().map(d => "  " + d));
  const taken = document.querySelector(".nextq.taken");
  taken.click();                       // the taken door should now navigate
  await wait(500);
  out.push(`clicking the taken door goes to: ${document.querySelector(".panel.is-current").dataset.page}`);
  return out.join("\n");
})()
