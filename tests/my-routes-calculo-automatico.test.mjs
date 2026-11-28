// CONFIRMAR_CITAS-035: textos de los tramos, hora de vuelta a casa y cálculo automático al importar y al abrir
// Mis rutas. Datos inventados, sin red, sin Supabase y sin Geoapify: la función está imitada.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildLegs, combineActivities, formatRouteLocation, homeArrival } from "../my-routes.mjs";
import { createCloudRoutes } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { createRpcRouteDays, madridDay, savableDate } from "../my-routes-saved.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const CP = "17599", TOWN = "Vilafictícia";
const prefs = { home: { street: "Avinguda Pins", number: "1", municipality: TOWN, postalCode: CP }, keys: null,
  tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle,
  postal_code: CP, population: "VILAFICTICIA", status: "pending" });
const citas = [cita("a", "09:00", "10:00", "CARRER PROVA 12"), cita("b", "11:00", "12:00", "CARRER OLIVERA 3")];
const sinDireccion = [{ type: "Desplazamiento Alianzas", time: "17:00", end_time: "18:00" }];
const TECH = "00000000-0000-4000-8000-00000000000a";
const TODAY = "2026-12-01", TOMORROW = "2026-12-02";

function database(clock) {
  const rows = new Map();
  return async (name, args) => {
    const key = args.p_expected_technician_id + "|" + args.p_work_date;
    if (!savableDate(args.p_work_date, clock.value)) return { data: name === "cc_my_route_day" ? [] : false, error: null };
    if (name === "cc_my_route_day") return { data: structuredClone(rows.get(key) ?? []), error: null };
    rows.set(key, structuredClone(args.p_legs));
    return { data: true, error: null };
  };
}

const store = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

// `state.reply`: "ok" (por defecto), "network", o un cuerpo 429 de la función.
const world = (extra = {}) => ({ agenda: citas, ignored: [], bodies: [], loads: 0, reply: "ok", wait: 0,
  clock: { value: new Date("2026-12-01T07:00:00Z") }, storage: store(), db: null, ...extra });

async function app(state, { role = "technician", date = TODAY, autoCalculation = true, hold = null } = {}) {
  const { panel, get } = fakePanel();
  const actor = { id: TECH, role };
  const timer = {};
  const legs = () => buildLegs(formatRouteLocation(prefs.home), combineActivities(state.agenda, state.ignored, prefs));
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    state.bodies.push(body);
    if (hold) await hold;
    if (state.reply === "network") throw new Error("sin red");
    if (state.reply !== "ok") {
      const reply = state.reply;
      return { data: null, error: { status: 429, context: { status: 429, clone: () => ({ json: async () => reply }) } } };
    }
    const estimates = legs().map((_, index) => body.only && !body.only.includes(index) ? null
      : { durationSeconds: 21 * 60, distanceMeters: 19100, calculatedAt: state.clock.value.toISOString() });
    return { data: { estimates, ...(state.wait ? { retryAfterSeconds: state.wait } : {}) }, error: null };
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => date, provider,
    now: () => state.clock.value, autoCalculation, autoStorage: state.storage,
    timers: { set: task => { timer.task = task; return 1; }, clear() {} },
    savedDays: state.db ? createRpcRouteDays({ rpc: state.db, getActor: () => actor }) : null,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => { state.loads++; return { appointments: state.agenda, ignored: state.ignored }; } });
  ui.sync();
  const idle = () => settle(25);
  const list = () => texts(get("List")).join("\n");
  const card = title => get("List").children.find(node => node.tag === "article" && node.children[0].textContent === title);
  const travel = title => card(title).children.find(node => node.className === "route-travel").textContent;
  const open = async () => { get("Tab").events.click(); await idle(); };
  const close = () => get("AgendaTab").events.click();
  const reopen = async () => { close(); await open(); };
  const imported = async (day = date) => { await ui.imported(day); await idle(); };
  const endWait = async seconds => {
    state.clock.value = new Date(state.clock.value.getTime() + seconds * 1000 + 1000);
    timer.task();
    await idle();
  };
  const notice = () => get("CalculationNotice").textContent;
  return { get, ui, actor, list, travel, open, close, reopen, imported, endWait, notice, idle };
}

// ---------- A: textos y hora de vuelta ----------

test("A1–A3: «desde casa», «desde la cita anterior», regreso con la hora y resumen con la vuelta", async () => {
  const phone = await app(world(), { autoCalculation: false });
  await phone.open();
  await phone.get("Calculate").events.click();
  await phone.idle();
  assert.equal(phone.travel("09:00 · Instalación"), "🚗 21 min · 19,1 km desde casa");
  assert.equal(phone.travel("11:00 · Instalación"), "🚗 21 min · 19,1 km desde la cita anterior");
  assert.equal(phone.travel("Regreso a casa"), "🚗 21 min · 19,1 km · Llegas a casa hacia las 12:21");
  assert.match(phone.list(), /Sal de casa a las 08:29\nVuelves a casa hacia las 12:21\n/);
  assert.match(phone.list(), /Llegada estimada a casa: 12:21/);
  assert.doesNotMatch(phone.list(), /desde Instalación \(/);
});

test("A4: cuenta el fin de la última actividad aunque no tenga dirección ni desplazamiento", async () => {
  const phone = await app(world({ ignored: sinDireccion }), { autoCalculation: false });
  await phone.open();
  await phone.get("Calculate").events.click();
  await phone.idle();
  assert.equal(phone.travel("17:00 · Desplazamiento Alianzas"), "Sin desplazamiento");
  assert.equal(phone.travel("Regreso a casa"), "🚗 21 min · 19,1 km · Llegas a casa hacia las 18:21");
  assert.match(phone.list(), /Vuelves a casa hacia las 18:21/);
  assert.match(phone.list(), /Llegada estimada a casa: 18:21/);
});

test("A4: sin regreso calculado o sin fin de la última actividad no se muestra ninguna hora", async () => {
  const phone = await app(world(), { autoCalculation: false });
  await phone.open();
  assert.equal(phone.travel("Regreso a casa"), "Sin calcular");
  assert.doesNotMatch(phone.list(), /Vuelves a casa|Llegas a casa/);
  const open = await app(world({ ignored: [{ type: "Desplazamiento Alianzas", time: "17:00" }] }), { autoCalculation: false });
  await open.open();
  await open.get("Calculate").events.click();
  await open.idle();
  assert.equal(open.travel("Regreso a casa"), "🚗 21 min · 19,1 km");
  assert.doesNotMatch(open.list(), /Vuelves a casa|Llegas a casa/);
  assert.match(open.list(), /Llegada estimada no disponible\./);
});

test("A4: reglas de la hora de vuelta (solape, día siguiente y datos que faltan)", () => {
  const stop = (time, endTime) => ({ time, endTime });
  const back = { durationSeconds: 1250 };
  assert.deepEqual(homeArrival([stop("09:00", "13:00"), stop("10:00", "11:00")], back), { dayOffset: 0, time: "13:21" });
  assert.deepEqual(homeArrival([stop("09:00", ""), stop("11:00", "12:00")], back), { dayOffset: 0, time: "12:21" });
  assert.deepEqual(homeArrival([stop("23:00", "23:50")], back), { dayOffset: 1, time: "00:11" });
  assert.equal(homeArrival([stop("09:00", "10:00"), stop("", "")], back), null);
  assert.equal(homeArrival([stop("09:00", "10:00")], null), null);
  assert.equal(homeArrival([], back), null);
});

// ---------- B: cálculo automático ----------

test("B1: importar hoy o mañana lanza un solo cálculo, sin abrir Mis rutas, y queda guardado", async () => {
  for (const day of [TODAY, TOMORROW]) {
    const state = world();
    state.db = database(state.clock);
    const phone = await app(state, { date: day });
    await phone.imported(day);
    assert.equal(state.bodies.length, 1, day);
    assert.equal(state.bodies[0].date, day);
    await phone.open();
    assert.equal(state.bodies.length, 1, "abrir después no repite");
    assert.equal(phone.travel("11:00 · Instalación"), "🚗 21 min · 19,1 km desde la cita anterior");
  }
});

test("B7: reimportar la misma agenda no gasta (tampoco al recargar la app); si cambia, solo lo cambiado", async () => {
  const state = world();
  state.db = database(state.clock);
  const phone = await app(state);
  await phone.imported();
  await phone.imported();
  await (await app(state)).imported();
  assert.equal(state.bodies.length, 1);
  state.agenda = [citas[0], cita("b", "11:00", "12:00", "CARRER NOU 4")];
  await (await app(state)).imported();
  assert.equal(state.bodies.length, 2);
  assert.deepEqual(state.bodies[1].only, [1, 2]);
});

test("B4: otra fecha no calcula sola (ni al importar ni al abrir)", async () => {
  for (const day of ["2026-11-30", "2026-12-03"]) {
    const state = world();
    const phone = await app(state, { date: day });
    await phone.imported(day);
    await phone.open();
    assert.equal(state.bodies.length, 0, day);
    assert.equal(phone.travel("09:00 · Instalación"), "Sin calcular");
  }
});

test("B6: al abrir hoy con tramos sin calcular se calcula una vez; abrir y cerrar no repite", async () => {
  const state = world();
  const phone = await app(state);
  await phone.open();
  assert.equal(state.bodies.length, 1);
  assert.equal(phone.travel("09:00 · Instalación"), "🚗 21 min · 19,1 km desde casa");
  await phone.reopen();
  // Recargada y sin nada guardado en la base: la marca del dispositivo impide repetir.
  const reloaded = await app(state);
  await reloaded.open();
  await reloaded.reopen();
  assert.equal(state.bodies.length, 1);
  assert.equal(reloaded.travel("09:00 · Instalación"), "Sin calcular");
  assert.doesNotMatch(JSON.stringify([...state.storage.values]), /carrer|prova|vilafict/i, "solo huellas");
});

test("B6: cambiar la fecha a mañana también calcula una vez; al día siguiente se permite un intento nuevo", async () => {
  const state = world({ reply: { code: "credits_limit" } });
  const phone = await app(state);
  await phone.open();
  phone.get("Date").value = TOMORROW;
  phone.get("Date").events.change();
  await phone.idle();
  phone.get("Date").events.change();
  await phone.idle();
  assert.deepEqual(state.bodies.map(body => body.date), [TODAY, TOMORROW]);
  state.clock.value = new Date("2026-12-02T07:00:00Z");
  const next = await app(state, { date: TOMORROW });
  await next.open();
  await next.reopen();
  assert.deepEqual(state.bodies.map(body => body.date), [TODAY, TOMORROW, TOMORROW]);
});

test("B3: piloto apagado, tope alcanzado o sin red: la importación no falla, queda «Sin calcular» con su motivo y no se repite", async () => {
  const cases = [
    [{ code: "pilot_stopped" }, /El cálculo está desactivado/],
    [{ code: "credits_limit" }, /Se han gastado los créditos de las últimas 24 horas/],
    [{ code: "routes_limit" }, /máximo de cálculos de las últimas 24 horas/],
    ["network", /No se pudo conectar con el servicio de rutas/],
  ];
  for (const [reply, message] of cases) {
    const state = world({ reply });
    const phone = await app(state);
    await assert.doesNotReject(phone.imported());
    await phone.open();
    await phone.reopen();
    assert.equal(state.bodies.length, 1, JSON.stringify(reply));
    assert.equal(phone.travel("09:00 · Instalación"), "Sin calcular");
    assert.match(phone.notice(), message);
    assert.equal(phone.get("Calculate").disabled, false, "el botón manual sigue");
    state.reply = "ok";
    await phone.get("Calculate").events.click();
    await phone.idle();
    assert.equal(state.bodies.length, 2);
    assert.match(phone.travel("09:00 · Instalación"), /desde casa/);
    await phone.reopen();
    assert.doesNotMatch(phone.notice(), message, "el motivo antiguo no vuelve tras calcular a mano");
  }
});

test("B3: si el servidor pide esperar, se calcula solo al terminar la espera", async () => {
  const state = world({ reply: { code: "wait", retryAfterSeconds: 90 } });
  const phone = await app(state);
  await phone.imported();
  assert.equal(state.bodies.length, 1);
  await phone.open();
  assert.equal(state.bodies.length, 1, "durante la espera no se pide nada");
  assert.equal(phone.get("Calculate").disabled, true);
  state.reply = "ok";
  phone.close();
  await phone.endWait(90);
  assert.equal(state.bodies.length, 2);
  await phone.open();
  assert.equal(state.bodies.length, 2);
  assert.match(phone.travel("09:00 · Instalación"), /desde casa/);
});

test("B3: una espera que no termina nunca se reintenta como mucho tres veces", async () => {
  const state = world({ reply: { code: "wait", retryAfterSeconds: 60 } });
  const phone = await app(state);
  await phone.imported();
  for (let round = 0; round < 6; round++) await phone.endWait(60);
  assert.equal(state.bodies.length, 4);
});

test("B3: con la espera de 2 minutos en marcha, una agenda cambiada se pospone y calcula solo lo cambiado", async () => {
  const state = world({ wait: 120 });
  const phone = await app(state);
  await phone.imported();
  state.agenda = [citas[0], cita("b", "11:00", "12:00", "CARRER NOU 4")];
  await phone.imported();
  assert.equal(state.bodies.length, 1);
  state.wait = 0;
  await phone.endWait(120);
  assert.equal(state.bodies.length, 2);
  assert.deepEqual(state.bodies[1].only, [1, 2]);
});

test("un cálculo cada vez: importar y abrir mientras calcula no lanza otro, y el botón espera", async () => {
  let release;
  const state = world();
  const phone = await app(state, { hold: new Promise(resolve => { release = resolve; }) });
  const first = phone.ui.imported(TODAY);
  const second = phone.ui.imported(TODAY);
  await phone.open();
  assert.equal(state.bodies.length, 1);
  assert.equal(phone.get("Calculate").disabled, true);
  assert.equal(phone.notice(), "Calculando desplazamientos…");
  release();
  await Promise.all([first, second]);
  await phone.idle();
  assert.equal(state.bodies.length, 1);
  assert.equal(phone.get("Calculate").disabled, false);
  assert.match(phone.travel("09:00 · Instalación"), /desde casa/);
});

test("B5: una importación hecha como Master o Administrador no lee rutas ni llama a la función", async () => {
  for (const role of ["master", "admin"]) {
    const state = world();
    const phone = await app(state, { role });
    await phone.imported();
    assert.equal(state.bodies.length, 0, role);
    assert.equal(state.loads, 0, role);
  }
});

test("B2: el botón manual recalcula toda la ruta aunque ya esté calculada", async () => {
  const state = world();
  state.db = database(state.clock);
  await (await app(state)).imported();
  const phone = await app(state);
  await phone.open();
  assert.equal(state.bodies.length, 1);
  await phone.get("Calculate").events.click();
  await phone.idle();
  assert.equal(state.bodies.length, 2);
  assert.equal(state.bodies[1].only, undefined);
  assert.equal(madridDay(state.clock.value), TODAY);
});

// ---------- B1: la importación de app.js ----------

async function oracleImport({ error = null, changeDate = false } = {}) {
  const source = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("async function saveOracleText()");
  const body = source.slice(start, source.indexOf("\nasync function loadMasterAppointments", start));
  const imports = [], notices = [], failures = [];
  const scope = {
    $: () => ({ value: "texto ficticio" }), appointmentNotice: message => notices.push(message),
    selectedAppointmentTeam: "equipo", appointmentTeams: [{ id: "equipo" }], appointmentPreferences: {},
    parseOracleInstallations: () => ({ installations: [], ignored: [{ type: "Comida", time: "14:00" }] }),
    activeUser: { id: TECH }, importChangesBySource: new Map(), appointmentIdentityIndex: [],
    matchesAppointment: () => false, stableSourceKey: async () => "", compareImportedAppointment: () => [],
    supabase: { rpc: async () => { if (changeDate) scope.setDate("2026-12-09"); return { data: 0, error }; } },
    oracleImportFailure: () => failures.push(true), loadOwnAppointments: async () => true,
    myRoutes: { imported: date => { imports.push(date); return Promise.resolve(); } },
  };
  const fn = new Function("scope", ...Object.keys(scope), "let appointmentDate = " + JSON.stringify(TOMORROW)
    + ";\nscope.setDate = value => { appointmentDate = value; };\n" + body + "\nreturn saveOracleText;");
  await fn(scope, ...Object.values(scope))();
  return { imports, notices, failures };
}

test("B1: la app pide el cálculo solo tras una importación guardada, con la fecha importada", async () => {
  const ok = await oracleImport();
  assert.deepEqual(ok.imports, [TOMORROW]);
  assert.match(ok.notices.at(-1), /Importación guardada/);
  const failed = await oracleImport({ error: { message: "invalid import" } });
  assert.deepEqual(failed.imports, []);
  assert.equal(failed.failures.length, 1);
  assert.deepEqual((await oracleImport({ changeDate: true })).imports, [TOMORROW]);
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /autoCalculation: true,/);
});
