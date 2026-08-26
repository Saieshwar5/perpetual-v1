(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = [];
  const pill = document.getElementById("pill");
  const doc = document.querySelector(".panel.is-current .doc");

  // Intercept the turn request so we can see exactly what goes on the wire.
  let sent = null;
  const real = window.fetch;
  window.fetch = (u, o) => {
    if (String(u).includes("/turn")) { sent = JSON.parse(o.body); return new Promise(() => {}); }
    return real(u, o);
  };

  const kinds = [...doc.children].map(n => n.className || n.tagName.toLowerCase());
  const i = kinds.findIndex(k => String(k).includes("metrics"));
  const target = doc.children[i];
  target.click();
  await wait(150);
  out.push(`clicked block #${i} (${target.className}) -> ${JSON.stringify(pill.querySelector(".aim").textContent)}`);

  const input = pill.querySelector("input");
  input.value = "where does this number come from?";
  pill.querySelector(".pform").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await wait(400);

  out.push(`on the wire: ${JSON.stringify(sent)}`);
  out.push(`anchor index matches the clicked block: ${sent?.anchor?.index === i}`);
  out.push(`marks cleared on submit: ${document.querySelectorAll(".anchored").length === 0}`);
  return out.join("\n");
})()
