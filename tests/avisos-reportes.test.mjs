// CONFIRMAR_CITAS-039: el Administrador ve en el botón ⚠ cuántos reportes hay pendientes, se actualiza solo
// con la app visible y recibe un aviso sin datos cuando entra uno nuevo. Sin red y con datos ficticios.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIssuesUI } from "../issues-ui.mjs";

const WIFI_TEXT = "Nuevo reporte de Wifi Connect";
const CC_TEXT = "Nuevo reporte de Confirmar Citas";
const PRIVATE = ["Persona Ficticia", "Texto privado ficticio", "Equipo Ficticio", "Red-Ficticia"];

function fakeElement(tag = "div") {
  const classes = new Set();
  const listeners = {};
  const attributes = new Map();
  let text = "";
  const node = {
    tag, id: "", type: "", value: "", files: [], children: [], parent: null, disabled: false,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => ((force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name)),
    },
    get className() { return [...classes].join(" "); },
    set className(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); },
    get textContent() { return node.children.length ? node.children.map(child => child.textContent).join("\n") : text; },
    set textContent(value) { node.children = []; text = String(value); },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
    addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); },
    dispatch: (type) => { for (const handler of listeners[type] ?? []) handler({ preventDefault() {} }); },
    append: (...items) => { for (const item of items) { item.parent = node; node.children.push(item); } },
    replaceChildren: (...items) => { node.children = []; text = ""; node.append(...items); },
    remove: () => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = null; },
    querySelector: () => (node.submitButton ??= fakeElement("button")),
    reset() {}, focus() {}, scrollIntoView() {},
  };
  return node;
}

function setup({ role = "admin", cc = 0, wifi = 0, visible = true } = {}) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) {
      const node = fakeElement();
      node.id = id;
      if (/Badge$|Count$|^issuesPanel$|^issueAdminInbox$|^issueDetail$/.test(id)) node.classList.add("hidden");
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const body = fakeElement("body");
  const documentListeners = {};
  const document = {
    body, visibilityState: visible ? "visible" : "hidden",
    createElement: tag => fakeElement(tag),
    addEventListener: (type, handler) => { (documentListeners[type] ??= []).push(handler); },
  };
  globalThis.document = document;
  const windowListeners = {};
  const timers = new Map();
  let nextTimer = 0;
  const window = {
    addEventListener: (type, handler) => { (windowListeners[type] ??= []).push(handler); },
    setInterval: (handler, delay) => { timers.set(++nextTimer, { handler, delay }); return nextTimer; },
    clearInterval: id => { timers.delete(id); },
  };
  const db = { cc, wifi, status: "pending", category: "agenda", fail: false, calls: [], hook: null };
  const row = category => ({
    id: "00000000-0000-4000-8000-000000000001", worker: PRIVATE[0], role: "technician", team: PRIVATE[2],
    category, excerpt: PRIVATE[1], status: db.status, created_at: "2026-11-28T10:00:00Z", app_version: "ficticia",
  });
  async function rpc(name, args) {
    db.calls.push({ name, args });
    if (db.fail) return { data: null, error: { message: "sin red" } };
    let result;
    if (name === "cc_admin_issue_reports") result = { total: db.cc + db.wifi, pending_count: db.cc + db.wifi, items: [row(db.category)] };
    else if (name === "cc_admin_wifi_ocr_reports") result = { total: db.wifi, pending_count: db.wifi, items: [row("wifi_ocr")] };
    else if (name === "cc_my_issue_reports") result = { total: 0, unread_count: 2, items: [] };
    else if (name === "cc_issue_report_detail") result = { ...row(db.category), description: PRIVATE[1], updated_at: "2026-11-28T10:00:00Z", metadata: { ssid_candidate: PRIVATE[3] } };
    else result = {};
    if (db.hook) await db.hook(name);
    return { data: result, error: null };
  }
  const profile = { role, status: "active", activation_verified_at: "2026-01-01", must_change_password: false };
  const navigation = { opened: 0, open() { navigation.opened += 1; }, close() {}, abandon() {} };
  const notices = [];
  const ui = createIssuesUI({
    $, getSupabase: () => ({ rpc }), getProfile: () => profile, navigation,
    notify: message => notices.push(message), appVersion: "ficticia", window, document,
  });
  ui.bind();
  const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  const header = () => ({ hidden: $("reportUnreadBadge").classList.contains("hidden"), text: $("reportUnreadBadge").textContent });
  const toasts = () => body.children.filter(node => node.id === "reportToast");
  const toastLines = () => toasts().flatMap(node => node.children.filter(child => child.tag !== "button").flatMap(child => child.textContent.split("\n")));
  const dismiss = () => toasts()[0].children.find(child => child.tag === "button").dispatch("click");
  const start = async () => { await ui.refreshIndicator(); await flush(); };
  const tick = async () => { for (const timer of [...timers.values()]) timer.handler(); await flush(); };
  const visibility = async state => {
    document.visibilityState = state;
    for (const handler of documentListeners.visibilitychange ?? []) handler();
    await flush();
  };
  const focus = async () => { for (const handler of windowListeners.focus ?? []) handler(); await flush(); };
  const adminCalls = () => db.calls.filter(call => call.name.startsWith("cc_admin_"));
  return { $, ui, db, profile, navigation, notices, timers, flush, header, toasts, toastLines, dismiss, start, tick, visibility, focus, adminCalls };
}

test("el botón ⚠ de la cabecera conserva su contador y su estilo en la página", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const button = html.slice(html.indexOf('<button id="reportError"'), html.indexOf("</button>", html.indexOf('<button id="reportError"')));
  assert.match(button, /class="hero-report hidden"/);
  assert.match(button, /<span id="reportUnreadBadge" class="report-badge hidden"/);
  assert.doesNotMatch(readFileSync(new URL("../issues-ui.mjs", import.meta.url), "utf8"), /\.style\.|#[0-9a-f]{3,6};/i);
});

for (const [cc, wifi, expected] of [[0, 0, null], [1, 0, "1"], [0, 1, "1"], [60, 39, "99"], [70, 30, "99+"]]) {
  test(`Administrador: ⚠ con ${cc + wifi} pendientes muestra ${expected ?? "nada"}`, async () => {
    const app = setup({ cc, wifi });
    await app.start();
    assert.deepEqual(app.header(), expected ? { hidden: false, text: expected } : { hidden: true, text: "" });
    assert.match(app.$("reportError").getAttribute("aria-label"), /buzón de reportes/i);
    if (expected) assert.match(app.$("reportUnreadBadge").getAttribute("aria-label"), /pendientes/i);
  });
}

test("las consultas del contador son las dos actuales, de una sola fila y sin filtros", async () => {
  const app = setup({ cc: 1, wifi: 1 });
  await app.start();
  const names = new Set(app.adminCalls().map(call => call.name));
  assert.deepEqual([...names].sort(), ["cc_admin_issue_reports", "cc_admin_wifi_ocr_reports"]);
  for (const { name, args } of app.adminCalls()) {
    assert.deepEqual(args, name === "cc_admin_issue_reports"
      ? { p_status: null, p_category: null, p_search: null, p_limit: 1, p_offset: 0 }
      : { p_status: null, p_search: null, p_limit: 1, p_offset: 0 });
  }
});

for (const role of ["technician", "master"]) {
  test(`${role}: ⚠ sigue como antes, sin consultas del Administrador, sondeo ni aviso`, async () => {
    const app = setup({ role, cc: 5, wifi: 5 });
    await app.start();
    assert.deepEqual(app.header(), { hidden: false, text: "2" });
    await app.visibility("hidden");
    await app.visibility("visible");
    await app.focus();
    assert.equal(app.timers.size, 0);
    assert.equal(app.adminCalls().length, 0);
    assert.equal(app.toasts().length, 0);
    app.$("reportError").dispatch("click");
    await app.flush();
    assert.equal(app.navigation.opened, 1);
    assert.equal(app.$("issueCompose").classList.contains("hidden"), false);
    assert.equal(app.$("issueAdminInbox").classList.contains("hidden"), true);
    assert.equal(app.adminCalls().length, 0);
  });
}

test("Administrador: al tocar ⚠ se abre el buzón y se retira el aviso", async () => {
  const app = setup({ wifi: 1 });
  await app.start();
  app.$("reportError").dispatch("click");
  await app.flush();
  assert.equal(app.navigation.opened, 1);
  assert.equal(app.$("issueAdminInbox").classList.contains("hidden"), false);
  assert.equal(app.$("issueCompose").classList.contains("hidden"), true);
  assert.equal(app.$("issuesTitle").textContent, "Reportes de errores");
  assert.ok(app.adminCalls().some(call => call.args.p_limit === 20), "carga el listado del buzón");
  assert.equal(app.toasts().length, 0);
});

test("sondeo cada 1-2 minutos con la app visible: uno solo, y se para al ocultarla", async () => {
  const app = setup();
  await app.start();
  await app.start();
  assert.equal(app.timers.size, 1);
  const [{ delay }] = app.timers.values();
  assert.ok(delay >= 60_000 && delay <= 120_000, String(delay));
  let before = app.adminCalls().length;
  await app.tick();
  assert.equal(app.adminCalls().length, before + 2);
  await app.visibility("hidden");
  assert.equal(app.timers.size, 0);
  before = app.adminCalls().length;
  await app.focus();
  assert.equal(app.adminCalls().length, before);
});

test("al volver a la app (visibilidad o foco) consulta y reanuda el sondeo", async () => {
  const app = setup({ visible: false });
  await app.start();
  assert.equal(app.timers.size, 0);
  assert.equal(app.adminCalls().length, 0);
  app.db.wifi = 1;
  await app.visibility("visible");
  assert.equal(app.timers.size, 1);
  assert.deepEqual(app.header(), { hidden: false, text: "1" });
  app.db.wifi = 2;
  await app.focus();
  assert.deepEqual(app.header(), { hidden: false, text: "2" });
});

test("cerrar la sesión para el sondeo, borra contadores y aviso; al volver a entrar avisa otra vez", async () => {
  const app = setup({ cc: 2 });
  await app.start();
  app.ui.reset();
  assert.equal(app.timers.size, 0);
  assert.equal(app.toasts().length, 0);
  assert.deepEqual(app.header(), { hidden: true, text: "" });
  assert.equal(app.$("reportError").getAttribute("aria-label"), "Reportar error");
  assert.equal(app.$("reportUnreadBadge").getAttribute("aria-label"), "Respuestas nuevas");
  app.profile.status = "disabled";
  const before = app.adminCalls().length;
  await app.visibility("visible");
  await app.focus();
  assert.equal(app.adminCalls().length, before);
  assert.equal(app.timers.size, 0);
  app.profile.status = "active";
  await app.start();
  assert.deepEqual(app.toastLines(), [CC_TEXT]);
});

test("si la cuenta deja de estar activa, el siguiente intento para el sondeo y limpia", async () => {
  const app = setup({ cc: 1 });
  await app.start();
  app.profile.status = "disabled";
  const before = app.adminCalls().length;
  await app.tick();
  assert.equal(app.adminCalls().length, before);
  assert.equal(app.timers.size, 0);
  assert.equal(app.toasts().length, 0);
  assert.deepEqual(app.header(), { hidden: true, text: "" });
});

test("una respuesta que llega después de cerrar la sesión no pinta nada", async () => {
  const app = setup({ cc: 3 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.db.hook = () => gate;
  const pending = app.ui.refreshIndicator();
  await app.flush();
  app.ui.reset();
  release();
  await pending;
  await app.flush();
  assert.deepEqual(app.header(), { hidden: true, text: "" });
  assert.equal(app.toasts().length, 0);
});

for (const [name, counts, lines] of [
  ["sin pendientes", {}, []],
  ["Wifi Connect", { wifi: 2 }, [WIFI_TEXT]],
  ["Confirmar Citas", { cc: 3 }, [CC_TEXT]],
  ["las dos categorías", { cc: 1, wifi: 1 }, [WIFI_TEXT, CC_TEXT]],
]) {
  test(`aviso al abrir la app, ${name}`, async () => {
    const app = setup(counts);
    await app.start();
    assert.deepEqual(app.toastLines(), lines);
    assert.ok(app.toasts().length <= 1);
  });
}

test("aviso solo cuando sube el contador, una vez por reporte nuevo y descartable", async () => {
  const app = setup();
  await app.start();
  assert.equal(app.toasts().length, 0);
  app.db.wifi = 1;
  await app.tick();
  assert.deepEqual(app.toastLines(), [WIFI_TEXT]);
  app.dismiss();
  assert.equal(app.toasts().length, 0);
  await app.tick();
  await app.focus();
  await app.start();
  assert.equal(app.toasts().length, 0, "el mismo reporte no vuelve a avisar");
  app.db.cc = 1;
  await app.tick();
  assert.deepEqual(app.toastLines(), [CC_TEXT]);
  app.dismiss();
  app.db.cc = 0;
  await app.tick();
  assert.equal(app.toasts().length, 0, "al bajar no avisa");
  app.db.cc = 1;
  await app.tick();
  assert.deepEqual(app.toastLines(), [CC_TEXT]);
});

test("el aviso anterior sin descartar se completa y desaparece cuando ya no hay pendientes", async () => {
  const app = setup({ wifi: 1 });
  await app.start();
  app.db.cc = 1;
  await app.tick();
  assert.deepEqual(app.toastLines(), [WIFI_TEXT, CC_TEXT]);
  assert.equal(app.toasts().length, 1);
  app.db.cc = 0; app.db.wifi = 0;
  await app.tick();
  assert.equal(app.toasts().length, 0);
});

test("el aviso no lleva ningún dato del reporte", async () => {
  const app = setup({ cc: 1, wifi: 1 });
  await app.start();
  const shown = app.toasts()[0].textContent;
  assert.deepEqual(shown.split("\n"), [WIFI_TEXT, CC_TEXT, "Cerrar"]);
  for (const value of PRIVATE) assert.ok(!shown.includes(value), value);
  for (const id of ["reportUnreadBadge", "adminPendingBadge"]) assert.match(app.$(id).textContent, /^\d+$/);
  assert.deepEqual(app.notices, []);
});

test("si un reporte entra entre las dos consultas, no se avisa de una categoría equivocada", async () => {
  const app = setup({ cc: 2 });
  await app.start();
  app.dismiss();
  let arrived = false;
  // La primera consulta del par aún no ve el reporte nuevo y la segunda ya sí.
  app.db.hook = () => { if (!arrived) { arrived = true; app.db.wifi = 1; } };
  await app.tick();
  await app.tick();
  await app.tick();
  assert.deepEqual(app.toastLines(), [WIFI_TEXT]);
});

test("un fallo de la consulta conserva los números y no avisa", async () => {
  const app = setup({ cc: 2 });
  await app.start();
  app.dismiss();
  app.db.fail = true;
  await app.tick();
  assert.deepEqual(app.header(), { hidden: false, text: "2" });
  assert.equal(app.toasts().length, 0);
  app.db.fail = false;
  await app.tick();
  assert.equal(app.toasts().length, 0);
});

test("pestaña y botón ⚠ salen de la misma fuente; con el filtro Wifi Connect la pestaña cuenta solo esos", async () => {
  const app = setup({ cc: 2, wifi: 3 });
  await app.start();
  assert.equal(app.$("adminPendingBadge").textContent, "5");
  app.$("issueCategoryFilter").value = "wifi_ocr";
  app.$("issueCategoryFilter").dispatch("change");
  await app.flush();
  assert.equal(app.$("adminPendingBadge").textContent, "3");
  assert.deepEqual(app.header(), { hidden: false, text: "5" });
  app.db.cc = 4;
  await app.tick();
  assert.equal(app.$("adminPendingBadge").textContent, "3");
  assert.deepEqual(app.header(), { hidden: false, text: "7" });
  app.$("issueCategoryFilter").value = "agenda";
  app.$("issueCategoryFilter").dispatch("change");
  await app.flush();
  assert.equal(app.$("adminPendingBadge").textContent, "7");
});

async function openAndSave(app, status) {
  app.$("reportError").dispatch("click");
  await app.flush();
  app.$("issueAdminList").children[0].dispatch("click");
  await app.flush();
  app.$("issueNewStatus").value = status;
  app.db.status = status;
}

test("devolver un reporte a Pendiente no avisa como si fuera nuevo", async () => {
  const app = setup();
  app.db.status = "reviewing";
  await app.start();
  await openAndSave(app, "pending");
  app.db.cc = 1;
  app.$("issueAdminAction").dispatch("submit");
  await app.flush();
  assert.deepEqual(app.header(), { hidden: false, text: "1" });
  assert.equal(app.toasts().length, 0);
});

test("resolver uno mientras entra otro de la misma categoría sí avisa del nuevo", async () => {
  const app = setup({ cc: 1 });
  await app.start();
  app.dismiss();
  await openAndSave(app, "resolved");
  app.db.cc = 1;   // el resuelto sale y entra uno nuevo: el número no cambia
  app.$("issueAdminAction").dispatch("submit");
  await app.flush();
  assert.deepEqual(app.toastLines(), [CC_TEXT]);
});
