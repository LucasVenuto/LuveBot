// node clarify.mjs   (REPO=<a checkout with the K-3b card; default: this one>, OUT=<dir>)   The Bot's question and its Skip button, in a real Chrome, inside the REAL Conversation:
// geometry (light/dark, desktop/phone/320, PT/EN), contrast, a real keyboard (Tab, Shift+Tab, Enter, Space), the accessibility tree, and where FOCUS is before, during and after
// a skip, an answer and a refusal. Not covered: a real screen reader's speech (only the accessibility tree it reads).
import fs from "node:fs";
import path from "node:path";
import { buildGlue, startStatic, launchChrome, PROXY_URL, sleep, OUT } from "./lib.mjs";
await buildGlue("glue-clarify.tsx", "glue-clarify.js");
fs.writeFileSync(path.join(OUT, "page.html"), `<!doctype html><html lang="pt-BR"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>clarify</title>
<link rel="stylesheet" href="/dashboard-plugins/luvebot/dist/style.css"><body style="margin:0"><div id="root"></div><script src="/glue-clarify.js"></script>`);
const srv = startStatic();
const chrome = await launchChrome({});
const problems = [];
chrome.on((m) => { if (m.method === "Runtime.exceptionThrown") problems.push("EXC " + JSON.stringify(m.params.exceptionDetails).slice(0, 300)); if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !String(m.params.entry.url).endsWith("favicon.ico")) problems.push(m.params.entry.text.slice(0, 200)); });

const KEYS = { Tab: { key: "Tab", code: "Tab", vk: 9 }, Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, Space: { key: " ", code: "Space", vk: 32, text: " " } };
const results = []; const fails = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); if (!ok) fails.push(name); console.log(ok ? "  ok  " : "  FAIL", name, detail); };

async function open(query, { w = 1000, h = 800, mobile = false, dark = false } = {}) {
  const tab = await chrome.newTab(null); const s = tab.sessionId;
  await chrome.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }, s);
  await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, s);
  await chrome.send("Emulation.setFocusEmulationEnabled", { enabled: true }, s);
  await chrome.send("Accessibility.enable", {}, s);
  await chrome.send("Page.navigate", { url: `${PROXY_URL}/?${query}&scheme=${dark ? "dark" : "light"}` }, s);
  const ev = (e, o) => chrome.ev(s, e, o);
  const until = async (e, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev("!!(" + e + ")")) return true; await sleep(40); } return false; };
  const press = async (name, { shift = false } = {}) => {
    const k = KEYS[name]; const modifiers = shift ? 8 : 0;
    await chrome.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text }, s);
    await chrome.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk }, s);
  };
  const type = (text) => chrome.send("Input.insertText", { text }, s);
  const active = () => ev(`(() => { const e = document.activeElement; if (!e || e === document.body) return "BODY"; const l = e.getAttribute("aria-label") || (e.tagName === "BUTTON" || e.tagName === "TEXTAREA" ? e.textContent.trim() : "") || e.getAttribute("role") || ""; return e.tagName.toLowerCase() + (l ? "(" + l.slice(0, 40) + ")" : "") })()`);
  const ok = await until(`document.querySelector('[data-testid=clarify-card]')`);
  await sleep(300);
  return { s, ev, until, press, type, active, ok, close: () => chrome.send("Target.closeTarget", { targetId: tab.targetId }) };
}

// ---------- contrast, in page ----------
const CONTRAST_JS = `(() => {
  const parse = (c) => { const m = c.match(/^rgba?\\(([^)]+)\\)$/); if (m) { const p = m[1].split(/[ ,\\/]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
    const k = c.match(/^color\\(srgb ([^)]+)\\)$/); if (k) { const p = k[1].split(/[ \\/]+/).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 }; } return null; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; } } let b = { r: 255, g: 255, b: 255, a: 1 }; for (const c of stack.reverse()) b = over(c, b); return b; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  window.__contrast = { parse, over, bgOf, ratio };
})()`;

const GEOM = (sel) => `(() => {
  const card = document.querySelector('[data-testid=clarify-card]'); const [send, skip] = [...card.querySelectorAll('button')];
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const a = r(send), z = r(skip), c = r(card);
  const sameRow = Math.abs(a.y - z.y) < 8;
  return { send: a, skip: z, card: c, sameRow, gap: sameRow ? z.x - a.r : z.y - a.b, after: !!(send.compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_FOLLOWING),
    inside: z.x >= c.x && z.r <= c.r && a.x >= c.x && a.r <= c.r, sw: document.documentElement.scrollWidth, iw: innerWidth, skipText: skip.textContent.trim(), skipName: skip.getAttribute('aria-label'), sendText: send.textContent.trim() };
})()`;

// ---------- 1. geometry, contrast: every view ----------
console.log("== geometry and contrast");
const VIEWS = {
  "desktop-claro-pt": { q: "kind=text", v: { w: 1000, h: 800 } }, "desktop-escuro-pt": { q: "kind=one", v: { w: 1000, h: 800, dark: true } }, "desktop-claro-en": { q: "kind=many&lang=en", v: { w: 1000, h: 800 } },
  "celular-claro-pt": { q: "kind=text&long=1", v: { w: 390, h: 800, mobile: true } }, "celular-escuro-en": { q: "kind=one&lang=en&long=1", v: { w: 390, h: 800, mobile: true, dark: true } },
  "estreito320-claro-pt": { q: "kind=many&long=1", v: { w: 320, h: 700, mobile: true } },
};
const geoms = {};
for (const [label, { q, v }] of Object.entries(VIEWS)) {
  const p = await open(q, v);
  check(`${label}: the card is there`, p.ok);
  await p.ev(CONTRAST_JS);
  const g = await p.ev(GEOM());
  geoms[label] = g;
  check(`${label}: Skip comes AFTER Answer in the DOM, inside the card, no sideways scroll`, g.after && g.inside && g.sw <= g.iw, JSON.stringify({ after: g.after, inside: g.inside, sw: g.sw, iw: g.iw }));
  check(`${label}: Skip is apart from Answer (>= 24px between them)`, g.gap >= 24, `gap ${g.gap}px ${g.sameRow ? "same row" : "stacked"}`);
  check(`${label}: visible text is a word of its accessible name ("${g.skipText}" in "${g.skipName}")`, g.skipName.toLowerCase().includes(g.skipText.toLowerCase()), "");
  const min = v.mobile ? 44 : 24;
  check(`${label}: target size of both buttons >= ${min}px`, Math.min(g.send.h, g.send.w, g.skip.h, g.skip.w) >= min, `send ${g.send.w}x${g.send.h}, skip ${g.skip.w}x${g.skip.h}`);
  const c = await p.ev(`(() => { const { parse, bgOf, ratio, over } = window.__contrast; const skip = document.querySelector('[data-testid=clarify-card]').querySelectorAll('button')[1];
    const cs = getComputedStyle(skip); const bg = bgOf(skip); const fg = over(parse(cs.color), bg); const ring = parse(getComputedStyle(document.documentElement).getPropertyValue('--color-ring') || '') ;
    return { fg: cs.color, bg: JSON.stringify(bg), text: ratio(fg, bg) } })()`);
  check(`${label}: Skip text contrast >= 4.5`, c.text >= 4.5, c.text.toFixed(2));
  await chrome.shot(p.s, `clarify-${label}.png`);
  await p.close();
}

// the wrap: a card so narrow that the two buttons cannot share a line
{
  const p = await open("kind=text", { w: 1000, h: 800 });
  await p.ev(`document.querySelector('[data-testid=clarify-card]').style.width = '170px'`); await sleep(200);
  const g = await p.ev(GEOM());
  check("wrapped (170px card): Skip is still after Answer, on its own line with a >= 12px row gap", g.after && !g.sameRow && g.gap >= 12 && g.inside, JSON.stringify({ gap: g.gap, same: g.sameRow }));
  await chrome.shot(p.s, "clarify-quebra.png");
  await p.close();
}

// ---------- 2. the keyboard and the focus: a skip ----------
const WATCH = `(() => { window.__t = { statusAt: null, cardGoneAt: null, texts: [] }; const t0 = performance.now();
  const look = () => { const card = document.querySelector('[data-testid=clarify-card]'); const st = card && card.querySelector('[role=status]'); const now = Math.round(performance.now() - t0);
    if (st && st.textContent && window.__t.statusAt === null) { window.__t.statusAt = now; window.__t.texts.push(st.textContent); }
    if (!card && window.__t.statusAt !== null && window.__t.cardGoneAt === null) window.__t.cardGoneAt = now; };
  new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true }); look(); })()`;

for (const how of ["Enter", "Space"]) {
  console.log(`== keyboard: skip with ${how}`);
  const p = await open("kind=text&latency=80");
  await p.ev(`document.querySelector('textarea[aria-label="Sua resposta"]').focus()`);
  check(`[${how}] the answer field has focus`, (await p.active()).startsWith("textarea"), await p.active());
  await p.press("Tab");
  check(`[${how}] Tab from the empty answer field lands on "Pular esta pergunta" (Answer is disabled)`, (await p.active()) === "button(Pular esta pergunta)", await p.active());
  const ring = await p.ev(`(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, matches: e.matches(':focus-visible') } })()`);
  check(`[${how}] the focus ring shows (focus-visible, solid, >= 2px)`, ring.matches && ring.style === "solid" && parseFloat(ring.width) >= 2, JSON.stringify(ring));
  const ringContrast = await p.ev(CONTRAST_JS + `;(() => { const { parse, bgOf, ratio, over } = window.__contrast; const e = document.activeElement; const bg = bgOf(e.parentElement); return ratio(over(parse(getComputedStyle(e).outlineColor), bg), bg) })()`);
  check(`[${how}] the focus ring contrast against the card >= 3`, ringContrast >= 3, ringContrast.toFixed(2));
  await p.press("Tab");
  check(`[${how}] the next Tab leaves the card (attach button), Skip is not a trap`, (await p.active()).includes("Anexar"), await p.active());
  await p.press("Tab", { shift: true });
  check(`[${how}] Shift+Tab comes back to Skip`, (await p.active()) === "button(Pular esta pergunta)", await p.active());
  await p.ev(WATCH);
  await p.ev(`H.focus.length = 0`);
  await p.press(how);
  const during = await p.ev(`new Promise((r) => setTimeout(() => r({ active: document.activeElement === document.body ? "BODY" : document.activeElement.tagName + ':' + (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent).slice(0,30), disabled: document.activeElement.disabled, posts: H.posts.slice() }), 20))`);
  check(`[${how}] ONE request, exactly {request_id, execution_generation, skip: true}`, during.posts.length === 1 && JSON.stringify(Object.keys(during.posts[0]).sort()) === '["execution_generation","request_id","skip"]' && during.posts[0].skip === true, JSON.stringify(during.posts));
  console.log("   focus while the request is in flight:", JSON.stringify(during.active), "disabled:", during.disabled);
  await sleep(1500);
  const after = await p.active();
  const t = await p.ev(`window.__t`);
  const focusLog = await p.ev(`H.focus.slice()`);
  console.log("   focus log:", JSON.stringify(focusLog));
  console.log("   timings:", JSON.stringify(t), "focus now:", after);
  results.push({ name: `[${how}] observed`, ok: true, detail: JSON.stringify({ during, after, t, focusLog }) });
  check(`[${how}] after the skip the focus is NOT lost to the page body`, after !== "BODY", `focus now: ${after}`);
  // what a screen reader is given now: the card is "Pergunta do Bot", the focused node is the confirmation (a status), no button is left in it
  {
    const { root } = await chrome.send("DOM.getDocument", { depth: 0 }, p.s);
    const { nodeId } = await chrome.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-testid=clarify-card]" }, p.s);
    if (!nodeId) check(`[${how}] AX: the card is still in the page to be read`, false, "the card is gone");
    else {
    const { node } = await chrome.send("DOM.describeNode", { nodeId }, p.s);
    const { nodes } = await chrome.send("Accessibility.getFullAXTree", {}, p.s);
    const cardAx = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
    const act = await chrome.send("Runtime.evaluate", { expression: "document.activeElement" }, p.s);
    const actNode = await chrome.send("DOM.describeNode", { objectId: act.result.objectId }, p.s);
    const focused = nodes.find((n) => n.backendDOMNodeId === actNode.node.backendNodeId);   // the node that really has focus (the root also carries a 'focused' flag)
    const text = (n) => { const out = []; const by = new Map(nodes.map((x) => [x.nodeId, x])); const w = (m) => { if (!m) return; if (m.role?.value === "StaticText") out.push(m.name?.value); (m.childIds ?? []).forEach((i) => w(by.get(i))); }; w(n); return out.join(" "); };
    const buttons = nodes.filter((n) => n.role?.value === "button" && n.parentId === cardAx?.nodeId);
    console.log("   AX after:", JSON.stringify({ card: cardAx?.name?.value, focusedRole: focused?.role?.value, focusedText: focused && text(focused), buttonsInCard: buttons.length }));
    check(`[${how}] AX: the card is named "Pergunta do Bot" (no longer "esperando"), the focused node is a status saying it was skipped, no button is left`, cardAx?.name?.value === "Pergunta do Bot" && focused?.role?.value === "status" && /Pulada/.test(text(focused) ?? "") && buttons.length === 0, "");
    }
  }
  check(`[${how}] the confirmation "Pulada…" stays on screen long enough to be read (>= 2 s) or is announced by a live region that outlives the card`, t.statusAt !== null && (t.cardGoneAt === null || t.cardGoneAt - t.statusAt >= 2000), `shown at ${t.statusAt} ms, card gone at ${t.cardGoneAt} ms`);
  await chrome.shot(p.s, `clarify-depois-${how}.png`);
  await p.close();
}

// the same on a dark phone, in English, with a choice: the ring on the confirmation line
console.log("== dark phone: skip with the keyboard");
{
  const p = await open("kind=one&lang=en&latency=80", { w: 390, h: 800, mobile: true, dark: true });
  await p.ev(`document.querySelector('input[name="clarify-q1"]').focus()`);
  for (let i = 0; i < 6 && (await p.active()) !== "button(Skip this question)"; i++) await p.press("Tab");
  check("[dark phone] Tab reaches Skip", (await p.active()) === "button(Skip this question)", await p.active());
  await chrome.shot(p.s, "clarify-celular-escuro-foco-no-pular.png");
  await p.press("Enter"); await sleep(1200);
  const ring = await p.ev(`(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, role: e.getAttribute('role'), style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, matches: e.matches(':focus-visible'), w: Math.round(e.getBoundingClientRect().width), sw: document.documentElement.scrollWidth, iw: innerWidth } })()`);
  console.log("   ", JSON.stringify(ring));
  check("[dark phone] the confirmation line holds the focus and shows a ring, no sideways scroll", ring.role === "status" && ring.matches && ring.style !== "none" && parseFloat(ring.width) > 0 && ring.sw <= ring.iw, JSON.stringify(ring));
  await chrome.shot(p.s, "clarify-celular-escuro-depois.png");
  await p.close();
}

// ---------- 3. the answer: focus, text field, choices ----------
console.log("== keyboard: an answer");
for (const kind of ["text", "one", "many"]) {
  const p = await open(`kind=${kind}&latency=80`);
  if (kind === "text") { await p.ev(`document.querySelector('textarea[aria-label="Sua resposta"]').focus()`); await p.type("Acme"); await p.press("Enter"); await sleep(150); check("[text] plain Enter in the field sends nothing", (await p.ev(`H.posts.length`)) === 0); await p.press("Tab"); }
  else { await p.ev(`document.querySelector('input[name="clarify-q1"]').focus()`); await p.press("Space"); if (kind === "many") { await p.press("Tab"); await p.press("Space"); } else { await p.ev(`document.querySelector('input[name="clarify-q1"]').focus()`); }
    for (let i = 0; i < 4 && (await p.active()) !== "button(Responder)"; i++) await p.press("Tab"); }
  check(`[${kind}] Tab reaches "Responder" by keyboard`, (await p.active()) === "button(Responder)", await p.active());
  await p.ev(WATCH); await p.ev(`H.focus.length = 0`);
  await p.press("Enter"); await sleep(1500);
  const after = await p.active(); const t = await p.ev(`window.__t`); const fl = await p.ev(`H.focus.slice()`);
  console.log(`   [${kind}] focus log:`, JSON.stringify(fl), "| timings:", JSON.stringify(t), "| now:", after, "| posted:", JSON.stringify(await p.ev(`H.posts`)));
  results.push({ name: `[${kind}] answer observed`, ok: true, detail: JSON.stringify({ after, t, fl }) });
  check(`[${kind}] after the answer the focus is NOT lost to the page body`, after !== "BODY", `focus now: ${after}`);
  check(`[${kind}] "Resposta enviada" stays long enough to be read (>= 2 s) or a live region outlives the card`, t.statusAt !== null && (t.cardGoneAt === null || t.cardGoneAt - t.statusAt >= 2000), `shown at ${t.statusAt} ms, card gone at ${t.cardGoneAt} ms`);
  await p.close();
}

// ---------- 4. a refused skip: focus and the alert ----------
console.log("== a refused skip");
{
  const p = await open("kind=text&latency=60&fail=request_not_pending");
  await p.ev(`document.querySelector('textarea[aria-label="Sua resposta"]').focus()`); await p.press("Tab"); await p.ev(`H.focus.length = 0`);
  await p.press("Enter"); await sleep(900);
  const alert = await p.ev(`(document.querySelector('[data-testid=clarify-card] [role=alert]') || {}).textContent || null`);
  const after = await p.active();
  console.log("   alert:", alert, "| focus now:", after, "| log:", JSON.stringify(await p.ev(`H.focus.slice()`)));
  check("[refused] the refusal is said in words, in an alert", !!alert && alert.length > 10, String(alert));
  check("[refused] the focus is NOT lost to the page body, and the button works again", after !== "BODY", `focus now: ${after}`);
  check("[refused] Skip is enabled again", await p.ev(`!document.querySelectorAll('[data-testid=clarify-card] button')[1].disabled`));
  await p.close();
}

// ---------- 5. no login ----------
console.log("== without a login");
{
  const p = await open("kind=text&auth=loopback");
  await p.until(`document.querySelector('[data-testid=clarify-card] [role=status]')`);
  const st = await p.ev(`({ skipDisabled: document.querySelectorAll('[data-testid=clarify-card] button')[1].disabled, said: document.querySelector('[data-testid=clarify-card] [role=status]').textContent })`);
  check("[loopback] Skip is disabled and the card says why", st.skipDisabled && /login/i.test(st.said), JSON.stringify(st));
  await p.ev(`document.querySelector('textarea[aria-label="Sua resposta"]').focus()`); await p.press("Tab");
  check("[loopback] Tab goes past both disabled buttons, out of the card", !(await p.active()).includes("Pular") && !(await p.active()).includes("Responder"), await p.active());
  await p.close();
}

// ---------- 6. the accessibility tree ----------
console.log("== accessibility tree");
for (const [label, q] of [["texto", "kind=text"], ["uma-escolha", "kind=one"], ["varias", "kind=many&lang=en"]]) {
  const p = await open(q);
  const { root } = await chrome.send("DOM.getDocument", { depth: 0 }, p.s);
  const { nodeId } = await chrome.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-testid=clarify-card]" }, p.s);
  const { node } = await chrome.send("DOM.describeNode", { nodeId }, p.s);
  const { nodes } = await chrome.send("Accessibility.getFullAXTree", {}, p.s);
  const by = new Map(nodes.map((n) => [n.nodeId, n]));
  const cardAx = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
  const lines = [];
  const walk = (n, d) => { if (!n) return; const role = n.role?.value, name = n.name?.value; const props = (n.properties ?? []).filter((x) => ["disabled", "checked", "focusable", "required"].includes(x.name)).map((x) => `${x.name}=${x.value.value}`).join(","); if (!n.ignored && role !== "generic" && role !== "none") lines.push(`${"  ".repeat(d)}${role}${name ? ` "${name}"` : ""}${props ? ` [${props}]` : ""}`); for (const id of n.childIds ?? []) walk(by.get(id), n.ignored || role === "generic" ? d : d + 1); };
  walk(cardAx, 0);
  console.log(`   AX (${label}):\n` + lines.map((l) => "     " + l).join("\n"));
  const skip = nodes.find((n) => n.role?.value === "button" && n.name?.value && /Pular esta pergunta|Skip this question/.test(n.name.value));
  check(`[ax ${label}] the button is exposed as a button named "${skip?.name?.value}", not ignored`, !!skip && !skip.ignored, "");
  const sent = nodes.find((n) => n.role?.value === "button" && /^(Responder|Answer)$/.test(n.name?.value ?? ""));
  check(`[ax ${label}] the card is a group named by its heading, the Answer button is separate from Skip`, cardAx?.role?.value === "group" && !!sent && sent !== skip, `card: ${cardAx?.role?.value} "${cardAx?.name?.value}"`);
  results.push({ name: `[ax ${label}] tree`, ok: true, detail: lines.join(" | ") });
  await p.close();
}

fs.writeFileSync(path.join(OUT, "clarify-result.json"), JSON.stringify({ chrome: chrome.version, results, geoms, problems }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks green; ${fails.length} failing; console problems: ${problems.length}`, problems.slice(0, 3));
if (fails.length) console.log("FAILING:\n - " + fails.join("\n - "));
await chrome.stop(); srv.close();
process.exit(fails.length || problems.length ? 1 : 0);
