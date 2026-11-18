import test from "node:test";
import assert from "node:assert/strict";
import { arrivalAfter, buildLegs, combineActivities, createRoutePreferences, createRpcRoutePreferences, createRpcRouteLocations, estimateLeg, formatRouteLocation, validateRouteLocations, mapsLink, mayArriveLate, recommendedDeparture } from "./my-routes.mjs";
import { mountMyRoutes } from "./my-routes-ui.mjs";

const appointment = { scheduled_time: "10:00:00", full_address: "Calle ficticia 10", status: "pending" };
const ignored = [{ time: "08:30", type: "Mantenimiento", full_address: "Calle ficticia 1" },
  { time: "09:30", type: "Valoración" }, { time: "07:00", type: "Pausa" }];
test("une ambas fuentes sin mutar estados y ordena los trabajos", () => {
  const activities = combineActivities([Object.freeze(appointment), { ...appointment, status: "cancelled" }], ignored);
  assert.deepEqual(activities.map(({ time, type }) => [time, type]), [
    ["08:30", "Mantenimiento"], ["09:30", "Valoración"], ["10:00", "Instalación"],
  ]);
  assert.equal(appointment.status, "pending");
  assert.equal(activities[1].address, "");
  assert.equal(buildLegs("Casa ficticia", activities).length, 4);
});

test("ida y regreso para una visita, sin enlaces si falta un extremo", () => {
  const [activity] = combineActivities([appointment], []);
  const legs = buildLegs("Casa & portal", [activity]);
  const url = new URL(mapsLink(legs[0]));
  assert.equal(url.hostname, "www.google.com");
  assert.equal(url.searchParams.get("origin"), "Casa & portal");
  assert.equal(url.searchParams.get("destination"), appointment.full_address);
  assert.equal(legs[1].to.type, "Casa");
  assert.equal(mapsLink(buildLegs("", [activity])[0]), "");
  assert.equal(buildLegs("", []).length, 0);
});

test("estimaciones validadas y salida solo con duración válida", async () => {
  const [leg] = buildLegs("Casa ficticia", combineActivities([appointment], []));
  const result = { durationSeconds: 900, distanceMeters: 4000, calculatedAt: "2026-11-17T08:00:00Z" };
  assert.deepEqual(await estimateLeg(leg, { estimate: async () => result }), result);
  assert.equal(await estimateLeg(leg, null), null);
  assert.equal(await estimateLeg(leg, { estimate: async () => { throw Error("synthetic"); } }), null);
  assert.equal(await estimateLeg(leg, { estimate: async () => ({ ...result, distanceMeters: -1 }) }), null);
  assert.deepEqual(recommendedDeparture("10:00", result.durationSeconds, 10), { dayOffset: 0, time: "09:35" });
  assert.deepEqual(recommendedDeparture("00:15", result.durationSeconds, 10), { dayOffset: -1, time: "23:50" });
  assert.equal(recommendedDeparture("10:00", null, 10), null);
  assert.equal(recommendedDeparture("", 900, 10), null);
});

test("preferencias aisladas, borrado, errores y acceso de Master denegado", async () => {
  let actor = { id: "A", role: "technician" };
  const preferences = createRoutePreferences(() => actor);
  assert.deepEqual(await preferences.read(), { home: "", margin: 10 });
  await preferences.write({ home: "Casa ficticia A", margin: 15 });
  assert.equal((await preferences.read()).home, "Casa ficticia A");
  await assert.rejects(preferences.write({ home: "", margin: -1 }));
  assert.equal((await preferences.read()).margin, 15);
  await preferences.write({ home: "", margin: 15 });
  assert.equal((await preferences.read()).home, "");
  await preferences.write({ home: "Casa ficticia A", margin: 15 });
  actor = { id: "B", role: "technician" };
  assert.deepEqual(await preferences.read(), { home: "", margin: 10 });
  actor.role = "master";
  await assert.rejects(preferences.read());
  await assert.rejects(preferences.write({ home: "Casa ficticia", margin: 10 }));
});

function element() {
  return {
    children: [], value: "", hidden: true, events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute() {}, reset() {}, focus() {},
    append(node) { this.children.push(node); },
    replaceChildren() { this.children.length = 0; },
  };
}

test("la pestaña renderiza la ruta y rechaza respuestas de otra sesión", async () => {
  const elements = new Map();
  const panel = { ownerDocument: { createElement: element }, querySelector(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  } };
  const get = id => panel.querySelector("#myRoutes" + id);
  get("Tab").parentElement = element();
  let actor = { id: "A", role: "technician" };
  let load = async () => ({ appointments: [appointment], ignored });
  const preferencesStore = { read: async () => ({home:null, keys:null, tourline:null, margin:10}), clear() {} };
  const ui = mountMyRoutes({ panel, agenda: element(), getActor: () => actor,
    getDate: () => "2026-11-17", loadActivities: () => load(), preferencesStore });
  ui.sync();
  assert.equal(get("Tab").parentElement.hidden, false);
  get("Tab").events.click();
  await new Promise(setImmediate);
  const rendered = JSON.stringify(get("List").children);
  assert.match(rendered, /Tiempo no disponible/);
  assert.match(rendered, /Casa → Mantenimiento/);
  assert.match(rendered, /Instalación · 10:00 → Casa/);
  load = async () => { throw Error("sensitive synthetic error"); };
  get("Date").events.change();
  await new Promise(setImmediate);
  assert.equal(get("Notice").textContent, "No se pudo cargar la ruta. Vuelve a intentarlo.");
  let release;
  load = () => new Promise(resolve => { release = resolve; });
  get("Date").events.change();
  await new Promise(setImmediate);
  actor = { id: "B", role: "master" };
  ui.sync();
  release({ appointments: [appointment], ignored });
  await new Promise(setImmediate);
  assert.equal(get("Tab").parentElement.hidden, true);
  assert.equal(panel.querySelector("#myRoutes-home-street").value, "");
  assert.deepEqual(get("List").children, []);
});


test("el adaptador persiste, modifica y elimina mediante RPC con identidad esperada", async () => {
  let actor = { id: "A", role: "technician" };
  const records = new Map();
  const calls = [];
  const rpc = async (name, params) => {
    calls.push({ name, params });
    if (name === "cc_save_my_route_preferences") {
      records.set(params.p_expected_technician_id, { home: params.p_home ?? "", margin: params.p_margin });
      return { data: null };
    }
    return { data: records.get(params.p_expected_technician_id) ?? { home: "", margin: 10 } };
  };
  const configure = () => createRpcRoutePreferences({ rpc, getActor: () => actor });
  await configure().write({ home: "  Casa sintética A  ", margin: 20 });
  assert.deepEqual(await configure().read(), { home: "Casa sintética A", margin: 20 });
  assert.equal(calls[0].params.p_expected_technician_id, "A");
  actor = { id: "B", role: "technician" };
  assert.deepEqual(await configure().read(), { home: "", margin: 10 });
  actor = { id: "A", role: "technician" };
  await configure().write({ home: "", margin: 20 });
  assert.equal(calls.at(-1).params.p_home, null);
  assert.deepEqual(await configure().read(), { home: "", margin: 20 });
  actor = { id: "A", role: "master" };
  const before = calls.length;
  await assert.rejects(configure().read(), /no disponibles/);
  assert.equal(calls.length, before);
});

test("la persistencia descarta una respuesta de la sesión anterior y oculta errores internos", async () => {
  let actor = { id: "A", role: "technician" }, finish;
  const delayed = createRpcRoutePreferences({
    getActor: () => actor, rpc: () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = delayed.read();
  actor = { id: "B", role: "technician" };
  finish({ data: { home: "Casa sintética A", margin: 10 } });
  await assert.rejects(pending, /No se pudo acceder/);
  const failing = createRpcRoutePreferences({
    getActor: () => actor, rpc: async () => { throw Error("Casa privada sintética"); },
  });
  await assert.rejects(failing.read(), { message: "No se pudo acceder a las preferencias de ruta." });
});

test("el regreso y el aviso de retraso dependen de una hora de fin válida", () => {
  const [first, second] = combineActivities([
    { ...appointment, scheduled_time: "10:00", scheduled_end_time: "10:30" },
    { ...appointment, scheduled_time: "10:40", scheduled_end_time: "08:00" },
  ], []);
  const estimate = { durationSeconds: 600 };
  assert.equal(mayArriveLate({ from: first, to: second }, estimate), false);
  assert.equal(mayArriveLate({ from: first, to: second }, { durationSeconds: 601 }), true);
  assert.equal(mayArriveLate({ from: first, to: second }, null), false);
  assert.equal(arrivalAfter(second.endTime, 600), null);
  assert.equal(arrivalAfter(first.endTime, 600).time, "10:40");
  assert.deepEqual(arrivalAfter("23:55", 600), { dayOffset: 1, time: "00:05" });
});

test("los errores de cuota dejan el tiempo sin estimar y no provocan reintentos", async () => {
  const [leg] = buildLegs("Casa sintética", combineActivities([appointment], []));
  for (const status of [403, 429]) {
    let calls = 0;
    const provider = {
      async estimate() {
        calls++;
        throw Object.assign(new Error("respuesta privada sintética"), { status });
      },
    };
    assert.equal(await estimateLeg(leg, provider), null);
    assert.equal(calls, 1);
    assert.equal(await estimateLeg({ ...leg, from: { address: "" } }, provider), null);
    assert.equal(calls, 1);
  }
  assert.equal(await estimateLeg(leg, null), null);
});

test("los RPC rechazan sesiones ausentes y ocultan errores de autenticación", async () => {
  let actor = null;
  let calls = 0;
  const preferences = createRpcRoutePreferences({
    getActor: () => actor,
    async rpc() {
      calls++;
      return { data: null, error: { code: "PGRST301", message: "detalle privado sintético" } };
    },
  });
  await assert.rejects(preferences.read(), /no disponibles/);
  assert.equal(calls, 0);
  actor = { id: "A", role: "technician" };
  await assert.rejects(preferences.read(), { message: "No se pudo acceder a las preferencias de ruta." });
  await assert.rejects(preferences.write({ home: "Casa sintética", margin: 10 }),
    { message: "No se pudo acceder a las preferencias de ruta." });
  assert.equal(calls, 2);
});


const usual = {
  home: { street: "Vía de prueba", number: "", municipality: "Municipio ficticio", postalCode: "" },
  keys: { street: "Centro ficticio de llaves", number: "S/N", municipality: "Municipio ficticio", postalCode: "08000" },
  tourline: { street: "Almacén ficticio", number: "2 bis", municipality: "Municipio ficticio", postalCode: "" },
  margin: 10,
};

test("incluye la jornada Oracle completa y aplica solo las dos ubicaciones habituales correspondientes", () => {
  const base = [
    { time: "11:50", type: "PAI Lanzamiento", full_address: "Vía original 5" },
    { time: "11:00", type: "Recogida de llaves", full_address: "Vía original 6" },
    { time: "12:30", type: "Tourline / Recogida de material", full_address: "Vía original 7" },
    { time: "09:30", type: "Mantenimiento correctivo", full_address: "Vía original 8" },
    { time: "13:30", type: "Avería", full_address: "Sin dirección" },
    { time: "14:00", type: "Entrega de llaves", full_address: "Vía original 10" },
    { time: "14:20", type: "Otra visita de Oracle", full_address: "Vía original 11" },
  ].map(Object.freeze);
  const result = combineActivities([appointment], base, usual);
  assert.deepEqual(result.map(({ time }) => time), ["09:30", "10:00", "11:00", "11:50", "12:30", "13:30", "14:00", "14:20"]);
  assert.equal(result[0].address, "Vía original 8");
  assert.equal(result[2].address, formatRouteLocation(usual.keys));
  assert.equal(result[3].address, "Vía original 5");
  assert.equal(result[4].address, formatRouteLocation(usual.tourline));
  assert.equal(result[5].address, "");
  assert.equal(result[6].address, "Vía original 10");
  assert.ok(result.every(a => a.endTime === ""));
  const legs = buildLegs(formatRouteLocation(usual.home), result);
  assert.equal(mapsLink(legs[5]), "");
  assert.equal(mapsLink(legs[6]), "");
  assert.equal(legs[5].to.type, "Avería");
  assert.equal(legs[6].from.type, "Avería");
  assert.equal(combineActivities([], base).find(a => a.time === "11:00").address, "Vía original 6");
  assert.equal(combineActivities([], base).find(a => a.time === "12:30").address, "Vía original 7");
});

test("valida ubicaciones estructuradas y tolera número o código postal vacíos", () => {
  assert.deepEqual(validateRouteLocations(usual), usual);
  assert.equal(formatRouteLocation(usual.home), "Vía de prueba, Municipio ficticio");
  assert.equal(formatRouteLocation(usual.keys), "Centro ficticio de llaves S/N, 08000, Municipio ficticio");
  assert.throws(() => validateRouteLocations({ ...usual, keys: { ...usual.keys, municipality: "" } }));
  assert.throws(() => validateRouteLocations({ ...usual, keys: { ...usual.keys, postalCode: "123" } }));
  assert.throws(() => validateRouteLocations({ ...usual, keys: { ...usual.keys, name: "Dato ajeno" } }));
  assert.throws(() => validateRouteLocations({ ...usual, margin: 181 }));
});

test("Ajustes guarda mediante RPC, vuelve a la jornada y conserva las ubicaciones al cambiar de fecha", async () => {
  const elements = new Map();
  const panel = { ownerDocument: { createElement: element }, querySelector(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  } };
  const get = id => panel.querySelector("#myRoutes" + id);
  get("Tab").parentElement = element();
  let actor = { id: "A", role: "technician" };
  let saved = usual;
  const writes = [];
  const prefs = createRpcRouteLocations({ getActor: () => actor, async rpc(name, p) {
    assert.equal(p.p_expected_technician_id, "A");
    if (name === "cc_save_my_route_locations") {
      saved = { home: p.p_home, keys: p.p_keys, tourline: p.p_tourline, margin: p.p_margin };
      writes.push(saved);
      return { data: null };
    }
    assert.equal(name, "cc_my_route_locations_v2");
    return { data: saved };
  } });
  const dates = [];
  const ui = mountMyRoutes({ panel, agenda: element(), getActor: () => actor, getDate: () => "2026-11-17",
    preferencesStore: prefs, async loadActivities(date) {
      dates.push(date);
      return { appointments: [], ignored: [{ time: "11:00", type: "Recogida llaves" }] };
    } });
  ui.sync();
  get("Tab").events.click();
  await new Promise(setImmediate);
  assert.match(JSON.stringify(get("List").children), /Centro ficticio de llaves/);
  await get("OpenSettings").events.click();
  assert.equal(get("Content").hidden, true);
  assert.equal(get("Settings").hidden, false);
  get("Clear-home").events.click();
  get("Margin").valueAsNumber = 25;
  await get("Settings").events.submit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(writes.length, 1);
  assert.equal(saved.home, null);
  assert.equal(saved.margin, 25);
  assert.deepEqual(saved.keys, usual.keys);
  assert.equal(get("SettingsPanel").hidden, true);
  get("Date").value = "2026-11-18";
  get("Date").events.change();
  await new Promise(setImmediate);
  assert.equal(dates.at(-1), "2026-11-18");
  assert.match(JSON.stringify(get("List").children), /Centro ficticio de llaves/);
  actor = { id: "B", role: "master" };
  ui.sync();
  assert.equal(get("Tab").parentElement.hidden, true);
  assert.equal(get("-keys-street").value, "");
});


test("conserva provincia de la sugerencia en el formato usado para identificar la ruta", () => {
  const detailed = { ...usual, keys: { ...usual.keys, province: "  Madrid  " } };
  const clean = validateRouteLocations(detailed);
  assert.equal(clean.keys.province, "Madrid");
  assert.match(formatRouteLocation(clean.keys), /Municipio ficticio \(Madrid\)$/);
  assert.ok(!Object.hasOwn(clean.home, "province"));
  assert.throws(() => validateRouteLocations({ ...detailed, keys: { ...detailed.keys, province: "Madrid, España" } }));
});
