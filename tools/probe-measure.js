(() => {
  const out = [];
  const doc = document.querySelector(".panel.is-current .doc");
  const deck = document.getElementById("site");
  const body = [...doc.children].filter(n => n.tagName === "P" && n.previousElementSibling?.tagName !== "H1");
  const ps = getComputedStyle(body[0]);

  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${ps.fontStyle} ${ps.fontWeight} ${ps.fontSize} ${ps.fontFamily}`;
  const sample = body.map(p => p.textContent).join(" ");
  const avgChar = ctx.measureText(sample).width / sample.length;

  const widthOf = (sel) => {
    const n = doc.querySelector(`:scope > ${sel}`);
    return n ? Math.round(n.getBoundingClientRect().width) : null;
  };

  out.push(`deck usable      ${deck.clientWidth}px`);
  out.push(`doc box          ${doc.clientWidth}px      unused ${deck.clientWidth - doc.clientWidth}px`);
  out.push("");
  out.push(`PROSE            ${Math.round(body[0].getBoundingClientRect().width)}px  ->  ${(body[0].getBoundingClientRect().width / avgChar).toFixed(0)} chars/line`);
  for (const [label, sel] of [["figure", ".figure"], ["chart", ".chartwrap"], ["table", ".tablewrap"],
                              ["metrics", ".metrics"], ["split", ".split"], ["flow", ".flow"],
                              ["heading", "h1"], ["next", ".next"]]) {
    const w = widthOf(sel);
    if (w) out.push(`${label.padEnd(16)} ${w}px`);
  }
  return out.join("\n");
})()
