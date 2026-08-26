(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = [];
  const pill = document.getElementById("pill");
  const rows = [...document.querySelectorAll(".panel.is-current .nextq")];
  out.push(`rendered ${rows.length} doors: ${JSON.stringify(rows.map(r => r.textContent.slice(0, 34)))}`);

  let sent = null;
  const real = window.fetch;
  window.fetch = (u, o) => {
    if (String(u).includes("/turn")) { sent = JSON.parse(o.body); return new Promise(() => {}); }
    return real(u, o);
  };

  rows[1].click();
  await wait(400);
  out.push(`clicked door #2`);
  out.push(`  on the wire: ${JSON.stringify(sent)}`);
  out.push(`  composer state: ${pill.dataset.state}`);
  out.push(`  showing the question: ${JSON.stringify(pill.querySelector(".aim").textContent)}`);
  return out.join("\n");
})()
