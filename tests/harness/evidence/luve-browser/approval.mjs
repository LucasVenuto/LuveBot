// The approval card in the REAL app: Chrome real (CDP) -> the Hermes v0.22.5 panel with LuveBot loaded by Hermes itself -> the real backend -> a real run of a Bot whose fake model asks for a
// dangerous command (T08_TOOL_APPROVAL: two independent gates ask a person in turn, LuveBot's rule and then Hermes's own command gate). What is checked is where the FOCUS is, and what the card says,
// before, during and after a decision: with a REAL mouse and a REAL keyboard (Input.dispatchMouseEvent / dispatchKeyEvent; touch taps on the phone), in the conversation and in Hoje.
//   H=<harness scratch root with fixtures/credentials.json> [VIEW=desktop|celular] [SCHEME=light|dark] node approval.mjs   (the stack has to be up: run.sh with HOLD=1, ports 19119/18642/18000)
// Not covered: a real screen reader's speech (only the accessibility tree it reads), Safari/iOS.
import fs from "node:fs";
import path from "node:path";
import { launchChrome, sleep, OUT } from "./lib.mjs";

const H = process.env.H, VIEW = process.env.VIEW ?? "desktop", SCHEME = process.env.SCHEME ?? "light", mobile = VIEW === "celular", tag = `${VIEW}-${SCHEME}`;
const DASH = "http://127.0.0.1:19119", BOT = "vendas", PROMPT = "T08_TOOL_APPROVAL: request the dangerous tool.";
const creds = JSON.parse(fs.readFileSync(H + "/fixtures/credentials.json", "utf8"));
const chrome = await launchChrome({ width: mobile ? 390 : 1280, height: mobile ? 844 : 900, mobile });
const results = [], fails = [], problems = [], reqs = [];
const J = JSON.stringify;
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); if (!ok) fails.push(name); console.log(ok ? "  ok  " : "  FAIL", name, detail === "" ? "" : J(detail).slice(0, 260)); return !!ok; };
chrome.on((m) => {
  const p = m.params ?? {};
  if (m.method === "Runtime.exceptionThrown") problems.push("EXC " + J(p.exceptionDetails).slice(0, 300));
  if (m.method === "Log.entryAdded" && p.entry.level === "error" && !String(p.entry.url ?? "").endsWith("favicon.ico")) problems.push("error " + p.entry.text.slice(0, 200) + " " + (p.entry.url ?? ""));
  if (m.method === "Network.requestWillBeSent") reqs.push({ method: p.request.method, url: p.request.url });
});

const tabInfo = await chrome.newTab(DASH + "/"); const s = tabInfo.sessionId;
await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: SCHEME }] }, s);
await chrome.send("Emulation.setFocusEmulationEnabled", { enabled: true }, s);   // a headless page is "focused": focusin/focusout and :focus-visible behave as in a window in front
await chrome.send("Accessibility.enable", {}, s);
if (mobile) await chrome.send("Emulation.setTouchEmulationEnabled", { enabled: true }, s);
const ev = (e, o) => chrome.ev(s, e, o);
const until = async (e, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev("!!(" + e + ")")) return true; } catch { /* page navigating */ } await sleep(60); } return false; };
const shot = (n) => chrome.shot(s, `approval-${tag}-${n}.png`);

// ---------- real input ----------
const KEYS = { Tab: { key: "Tab", code: "Tab", vk: 9 }, Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, Space: { key: " ", code: "Space", vk: 32, text: " " } };
const press = async (name, { shift = false } = {}) => {
  const k = KEYS[name], modifiers = shift ? 8 : 0;
  await chrome.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text }, s);
  await chrome.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk }, s);
};
const type = (text) => chrome.send("Input.insertText", { text }, s);
/** A real click (mouse) or tap (touch) at the centre of an element, after scrolling it into view. */
async function tap(expr) {
  const r = await ev(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) return false;
  await sleep(80);
  const at = await ev(`(() => { const e = ${expr}; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (mobile) {
    await chrome.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] }, s);
    await chrome.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
  } else {
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, s);
    await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 }, s);
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 }, s);
  }
  return true;
}

// ---------- the page side: where the focus is, and the timeline of it ----------
const RECORDER = `(() => {
  if (window.__F) return;
  const d = (el) => { if (!el) return "null"; if (el === document.body) return "BODY"; const l = el.getAttribute("aria-label") || (/^(BUTTON|TEXTAREA|INPUT)$/.test(el.tagName) ? (el.value && el.tagName !== "BUTTON" ? "" : el.textContent.trim()) : "") || el.getAttribute("role") || ""; return el.tagName.toLowerCase() + (l ? "(" + l.slice(0, 32) + ")" : ""); };
  const F = window.__F = { log: [], d, t0: performance.now(), last: "" };
  F.mark = (w) => F.log.push({ t: Math.round(performance.now() - F.t0), w });
  setInterval(() => {
    const a = d(document.activeElement), st = document.querySelectorAll('[role=group][aria-label="Pedido de aprovação"] [role=status], [data-testid^=needs-you-item-] [role=status]').length;
    const k = a + "|" + st; if (k !== F.last) { F.last = k; F.log.push({ t: Math.round(performance.now() - F.t0), active: a, statusLines: st }); }
  }, 8);
})()`;
const CARD = `[role=group][aria-label="Pedido de aprovação"]`;
const ROW = `[data-testid^=needs-you-item-]`;   // Hoje: a request is a row
/** The newest card (in the conversation) or row (in Hoje) that still offers `label`. */
const pendingWith = (label, root = CARD) => `(() => { const c = [...document.querySelectorAll(${J(root)})].filter((g) => [...g.querySelectorAll("button")].some((b) => b.textContent.trim() === ${J(label)} && !b.disabled)).at(-1); return c ?? null; })()`;
const btnOf = (label, root = CARD) => `(() => { const c = ${pendingWith(label, root)}; return c ? [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === ${J(label)}) : null; })()`;
const active = () => ev(`window.__F.d(document.activeElement)`);
/** Closed cards: the confirmation lines on screen, with whether each holds the focus. */
const statusLines = () => ev(`[...document.querySelectorAll('${CARD} [role=status]')].map((e) => ({ text: e.textContent.trim().slice(0, 80), focused: e === document.activeElement, tabindex: e.getAttribute("tabindex"), inTabOrder: e.tabIndex >= 0 }))`);

/** The Chrome accessibility tree: the node of a `status` whose text is `text`, and whether Chrome calls it focused. */
async function axStatus(text) {
  const { nodes } = await chrome.send("Accessibility.getFullAXTree", {}, s);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const textOf = (n) => (n.role?.value === "StaticText" || n.role?.value === "InlineTextBox" ? n.name?.value ?? "" : (n.childIds ?? []).map((c) => textOf(byId.get(c))).join(""));
  const hit = nodes.filter((n) => n.role?.value === "status" && !n.ignored && textOf(n).includes(text)).at(-1);   // the newest: older closed cards stay on screen above it
  return hit ? { found: true, focused: !!hit.properties?.find((p) => p.name === "focused")?.value?.value, live: hit.properties?.find((p) => p.name === "live")?.value?.value } : { found: false };
}

/** Decide, and check what an assistive technology and a keyboard user need after it. `how(label)` clicks it; `says` is the confirmation. */
async function decided(label, how, says, name, root = CARD) {
  await ev(`window.__F.mark(${J("before " + name)})`);
  const before = await active();
  const card = pendingWith(label, root);
  check(`${name}: the card is asking (warning edge, ${label})`, await ev(`(() => { const c = ${card}; return !!c && (c.getAttribute("style") ?? "").includes("--color-warning") || ${J(root !== CARD)}; })()`));
  const t0 = Date.now();
  const sent = await how(label);
  check(`${name}: ${label} was pressed`, sent);
  const closed = await until(`[...document.querySelectorAll(${J(root)} + " [role=status]")].some((e) => e.textContent.trim().startsWith(${J(says)}))`, 20000);
  check(`${name}: the confirmation line "${says}" appears`, closed, { ms: Date.now() - t0, before });
  await sleep(250);
  const a = await active();
  const lines = await statusLines();
  const mine = lines.filter((l) => l.text.startsWith(says)).at(-1);   // the card just decided: older closed cards stay on screen above it
  check(`${name}: the FOCUS is on that line (not the page body)`, !!mine?.focused, { active: a });
  check(`${name}: the line is a live region reachable for focus() but not a Tab stop`, mine && mine.tabindex === "-1" && !mine.inTabOrder, mine);
  const ax = await axStatus(says);
  check(`${name}: Chrome's accessibility tree has a status node saying it, focused`, ax.found && ax.focused, ax);
  await sleep(1500);
  check(`${name}: still there and still holding the focus 1.5 s later (it did not live a round trip)`, (await statusLines()).some((l) => l.text.startsWith(says) && l.focused), { active: await active() });
  const timeline = await ev(`window.__F.log.slice(window.__F.log.findIndex((e) => e.w === ${J("before " + name)}))`);
  // the focus may sit on the body while the request is on its way (the pressed control turned disabled); once the confirmation line exists it takes it in the effect that follows the paint
  let bodyAfter = 0, seenLine = false, prev = null;
  for (const e of timeline) { if (e.statusLines != null) { if (!seenLine && e.statusLines > (timeline.find((x) => x.statusLines != null)?.statusLines ?? 0)) seenLine = true; if (prev && seenLine && prev.active === "BODY") bodyAfter += e.t - prev.t; prev = e; } }
  check(`${name}: the focus rested on the page body for under 300 ms after the line was there (30-150 ms measured across runs; a passive effect runs after the paint)`, bodyAfter < 300, { bodyAfterMs: bodyAfter });
  return { timeline, before, after: a };
}
const mouseOrTap = (root) => (label) => tap(btnOf(label, root));
const keyboard = (root) => async (label) => { const ok = await ev(`(() => { const b = ${btnOf(label, root)}; if (!b) return false; b.focus(); return document.activeElement === b; })()`); if (!ok) return false; await press("Enter"); return true; };

try {
// ---------- 1. the real panel, signed in, LuveBot loaded by Hermes ----------
console.log(`== ${tag}: the real app`);
const login = await ev(`fetch('/auth/password-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${J(J({ provider: "basic", username: creds.username, password: creds.password, next: "/" }))} }).then((r) => r.status)`);
check("sign in on the Hermes panel", login === 200, login);
await chrome.send("Page.navigate", { url: DASH + "/" }, s);
check("LuveBot opens inside the panel and lists the Bots", await until(`document.querySelector('.lb-root') && document.querySelectorAll('aside button[aria-pressed]').length >= 2`, 60000));
await ev(RECORDER);
await sleep(600);
await ev(`(() => { for (const t of ["No thanks", "Entendi"]) { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t); if (b) b.click(); } })()`, { gesture: true });
await sleep(300);
/** On the phone every screen (a conversation, Hoje...) is its own: the list of Bots and the menu are behind "Voltar para as conversas". */
const back = async () => { if (mobile && await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "Voltar para as conversas"); if (!b) return false; b.click(); return true; })()`, { gesture: true })) await sleep(500); };
const openBot = async () => { await back(); return (await ev(`(() => { const b = [...document.querySelectorAll('aside button[aria-pressed]')].find((x) => x.textContent.toLowerCase().includes(${J(BOT)})); if (!b) return false; b.click(); return true; })()`, { gesture: true })) && await until(`document.querySelector('textarea[aria-label=Mensagem]')`); };
const nav = async (label) => { await back(); return ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || x.textContent).trim() === ${J(label)}); if (!b) return false; b.click(); return true; })()`, { gesture: true }); };
check("open the Bot " + BOT, await openBot());
async function ask() {
  await tap(`document.querySelector('textarea[aria-label=Mensagem]')`);
  await type(PROMPT);
  await press("Enter");
  return until(pendingWith("Permitir uma vez"), 60000);
}
/** End a run that is still asking: decide what is left, by keyboard. */
async function drain(root = CARD) { for (let i = 0; i < 4; i++) { if (!(await until(pendingWith("Permitir uma vez", root), 6000))) return; await keyboard(root)("Permitir uma vez"); await sleep(1500); } }

// ---------- 2. conversation: Permitir uma vez, with the mouse (touch on the phone); then the second gate, with the keyboard ----------
console.log("== conversation: Permitir uma vez");
check("the Bot asks (first gate: LuveBot's rule)", await ask());
await shot("1-pedindo");
const cardInfo = await ev(`(() => { const c = ${pendingWith("Permitir uma vez")}; return { buttons: [...c.querySelectorAll("button")].map((b) => b.textContent.trim()), name: c.getAttribute("aria-label"), noForm: !c.querySelector("form") }; })()`);
check("the card offers exactly Permitir uma vez / Sempre permitir… / Negar…", J(cardInfo.buttons) === J(["Permitir uma vez", "Sempre permitir…", "Negar…"]), cardInfo);
await decided("Permitir uma vez", mouseOrTap(CARD), "Permitida uma vez.", "1st gate by " + (mobile ? "touch" : "mouse"));
await shot("2-decidido");
check("the second gate (Hermes's own command gate) asks next", await until(pendingWith("Permitir uma vez"), 60000));
await decided("Permitir uma vez", keyboard(CARD), "Permitida uma vez.", "2nd gate by keyboard (Enter)");
const twoLines = await statusLines();
check("both closed cards stay on screen as their confirmations, and no card of the first turn is asking any more", twoLines.length >= 2 && !(await ev(`!!${pendingWith("Permitir uma vez")}`)), twoLines.map((l) => l.text));
const calm = await ev(`[...document.querySelectorAll('${CARD}')].filter((g) => g.querySelector("[role=status]")).map((g) => g.getAttribute("style") ?? "")`);
check("closed cards lost the warning edge (calm border)", calm.length >= 2 && calm.every((st) => !st.includes("--color-warning") && st.includes("--color-border")), calm.map((x) => x.slice(0, 120)));
await until(`!document.querySelector('[aria-label="Parar"]')`, 30000);
await sleep(1000);
check("when the run ends the closed cards are still there", (await statusLines()).length >= 2);

// ---------- 3. conversation: Negar… (reason field takes the focus, Cancelar gives it back) ----------
console.log("== conversation: Negar…");
check("a new run asks again", await ask());
await tap(btnOf("Negar…"));
check("Negar… opens the reason form and the FOCUS goes into the reason field", await until(`document.activeElement?.tagName === "TEXTAREA" && document.activeElement.closest(${J(CARD)})`, 4000), { active: await active() });
await tap(btnOf("Cancelar"));
check("Cancelar gives the focus back to the button that opened it", await until(`document.activeElement?.textContent?.trim() === "Negar…"`, 4000), { active: await active() });
await tap(btnOf("Negar…"));
await until(`document.activeElement?.tagName === "TEXTAREA"`, 4000);
await type("não apague nada");
await press("Tab");
check("Tab from the reason goes to Confirmar negação (real keyboard)", (await active()).includes("Confirmar negação"), { active: await active() });
await ev(`window.__F.mark("before deny")`);
await press("Enter");
check("Negada. appears and holds the focus", await until(`[...document.querySelectorAll('${CARD} [role=status]')].some((e) => e.textContent.trim().startsWith("Negada.") && e === document.activeElement)`, 20000), { active: await active(), lines: (await statusLines()).map((l) => l.text) });
const axDeny = await axStatus("Negada.");
check("Chrome's accessibility tree has the status node saying Negada., focused", axDeny.found && axDeny.focused, axDeny);
await sleep(1500);
check("and it still holds it 1.5 s later", (await statusLines()).some((l) => l.text.startsWith("Negada.") && l.focused));
await shot("3-negada");
await until(`!document.querySelector('[aria-label="Parar"]')`, 30000);
await drain();

// ---------- 4. conversation: Sempre permitir… (the draft's name takes the focus) ----------
console.log("== conversation: Sempre permitir…");
check("a new run asks again", await ask());
await keyboard(CARD)("Sempre permitir…");
check("Sempre permitir… opens the draft form and the FOCUS goes into the rule's name", await until(`document.activeElement?.tagName === "INPUT" && document.activeElement.closest(${J(CARD)})`, 4000), { active: await active() });
await tap(btnOf("Cancelar"));
check("Cancelar gives the focus back to Sempre permitir…", await until(`document.activeElement?.textContent?.trim() === "Sempre permitir…"`, 4000), { active: await active() });
await press("Enter");
await until(`document.activeElement?.tagName === "INPUT"`, 4000);
await press("Tab");
check("Tab from the name goes to the confirm button", (await active()).includes("Criar rascunho"), { active: await active() });
await press("Enter");
check("the draft's confirmation appears and holds the focus", await until(`[...document.querySelectorAll('${CARD} [role=status]')].some((e) => e.textContent.trim().startsWith("Permitida uma vez; a regra ficou em rascunho.") && e === document.activeElement)`, 20000), { active: await active() });
await until(`!document.querySelector('[aria-label="Parar"]')`, 30000).catch(() => {});
await drain();

// ---------- 5. Hoje: the row decided HERE stays in its place ----------
console.log("== Hoje");
check("a new run asks again", await openBot() && await ask());
check("go to Hoje with the request pending", await nav("Hoje") && await until(`document.querySelector('[data-testid^=needs-you-item-] button')`, 20000));
await shot("4-hoje-pedindo");
const rowsBefore = await ev(`[...document.querySelectorAll(${J(ROW)})].map((r) => r.getAttribute("data-testid"))`);
const countBefore = await ev(`document.querySelector('[data-testid=needs-you-count]').textContent`);
const decidedRow = await ev(`${pendingWith("Permitir uma vez", ROW)}.getAttribute("data-testid")`);
await ev(`window.__F.mark("before hoje")`);
check("Hoje: the pending request is a row with its decision (a bare card)", rowsBefore.includes(decidedRow) && Number(countBefore) >= 1, { rowsBefore, countBefore });
await tap(btnOf("Permitir uma vez", ROW));
check("Hoje: the row says Permitida uma vez. and holds the FOCUS", await until(`(() => { const r = document.querySelector('[data-testid=${decidedRow}]'); const e = r?.querySelector("[role=status]"); return !!e && e.textContent.trim().startsWith("Permitida uma vez.") && e === document.activeElement; })()`, 20000), { active: await active() });
const axHoje = await axStatus("Permitida uma vez.");
check("Hoje: Chrome's accessibility tree has the status node, focused", axHoje.found && axHoje.focused, axHoje);
await sleep(3000);   // the read that follows the decision (loadAll) has come back by now and no longer lists it
const afterRead = await ev(`(() => { const r = document.querySelector('[data-testid=${decidedRow}]'); return { present: !!r, buttons: r ? r.querySelectorAll("button").length : -1, focused: r?.querySelector("[role=status]") === document.activeElement }; })()`);
check("Hoje: after the read that drops it from the list the row is still there, without buttons, holding the focus", afterRead.present && afterRead.buttons === 0 && afterRead.focused, afterRead);
const rowsNow = await ev(`[...document.querySelectorAll(${J(ROW)})].map((r) => ({ id: r.getAttribute("data-testid"), asking: [...r.querySelectorAll("button")].some((b) => b.textContent.trim() === "Permitir uma vez") }))`);
const countNow = await ev(`document.querySelector('[data-testid=needs-you-count]').textContent`);
check("Hoje: the count follows what is pending (rows still asking), not the kept row", Number(countNow) === rowsNow.filter((r) => r.asking).length, { countNow, rowsNow });
check("Hoje: the kept row keeps its place (first)", rowsNow[0]?.id === decidedRow, rowsNow.map((r) => r.id));
await shot("5-hoje-decidido");
await sleep(17000);   // past a live refresh of the screen (15 s)
const afterLive = await ev(`(() => { const r = document.querySelector('[data-testid=${decidedRow}]'); return { present: !!r, focused: r?.querySelector("[role=status]") === document.activeElement }; })()`);
check("Hoje: it survives a live refresh of the screen and the focus is still on it", afterLive.present && afterLive.focused, afterLive);
await drain(ROW);   // the second gate of that run, decided in Hoje
await sleep(1500);

} catch (e) { check("the script ran to its end: " + String(e.message).slice(0, 220), false); }

// ---------- 6. nothing leaked, nothing broke ----------
const offsite = reqs.filter((r) => !/^(http:\/\/127\.0\.0\.1:19119|data:|blob:|about:)/.test(r.url));
check("no request left 127.0.0.1", offsite.length === 0, offsite.slice(0, 3));
const secrets = ["password", "api_key", "vendas_api_key", "signing_key", "extra_canary"].map((k) => creds[k]).filter((v) => typeof v === "string" && v.length >= 8);   // the login name is shown on screen (the signed-in person), and is not a secret
check("no credential of this harness (password, keys) in a URL the page asked for", secrets.length > 0 && !reqs.some((r) => secrets.some((v) => r.url.includes(v))), { secretsChecked: secrets.length });
check("...nor in anything the page shows", secrets.length > 0 && !(await ev(`(() => { const t = document.documentElement.innerText + document.documentElement.outerHTML; return ${J(secrets)}.some((v) => t.includes(v)); })()`)));
check("no console error or exception", problems.length === 0, problems.slice(0, 5));
const timeline = await ev(`window.__F.log`);
fs.writeFileSync(path.join(OUT, `approval-${tag}.json`), J({ chrome: chrome.version, date: new Date().toISOString(), view: tag, fails, checks: results, focusTimeline: timeline }, null, 1));
console.log(`\n${results.length - fails.length}/${results.length} checks ok${fails.length ? " — FAILED: " + fails.join(" | ") : ""}`);
await chrome.stop();
process.exit(fails.length ? 1 : 0);
