// CONFIRMAR_CITAS-031: «Desplazamiento…» fuera del cálculo, resultado de hoy y mañana guardado por técnico y
// corrección que calcula solo sus tramos. Datos inventados, sin red, sin Supabase y sin Geoapify: la función
// (index.ts) se ejecuta con la base y Geoapify imitados; la base de rutas guardadas es un modelo de la migración
// (NO se ejecuta SQL: la migración se comprueba además como texto).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { buildLegs, combineActivities, formatRouteLocation } from "../my-routes.mjs";
import { createCloudRoutes, routeFingerprint } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { createRpcRouteDays, legSignatures, lookupRecord, keepRecord, madridDay, pendingRecord, persistableRecord, savableDate } from "../my-routes-saved.mjs";
import * as core from "../supabase/functions/my-routes-estimate/core.mjs";
import * as policy from "../supabase/functions/my-routes-estimate/policy.mjs";
import * as control from "../supabase/functions/my-routes-estimate/pilot-control.mjs";
import * as renewal from "../supabase/functions/my-routes-estimate/pilot-renewal.mjs";
import * as cause from "../supabase/functions/my-routes-estimate/block-cause.mjs";
import { fakePanel, texts } from "./my-routes-fake-dom.mjs";

const read = async path => (await readFile(new URL("../" + path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const CP = "17599", TOWN = "Vilafictícia";
const prefs = { home: { street: "Avinguda Pins", number: "1", municipality: TOWN, postalCode: CP }, keys: null,
  tourline: { street: "Carrer Olivera", number: "8", municipality: TOWN, postalCode: CP }, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle,
  postal_code: CP, population: "VILAFICTICIA", status: "pending" });
const citas = [cita("a", "09:00", "10:00", "CARRER PROVA 12"), cita("b", "11:00", "12:00", "CARRER INEXISTENT 99"),
  cita("c", "13:00", "14:00", "CARRER OLIVERA 3"), cita("d", "15:00", "16:00", "CARRER NOU 4")];
const otra = (type, time, end_time) => ({ type, time, end_time });
const TECH = "00000000-0000-4000-8000-00000000000a", OTHER = "00000000-0000-4000-8000-00000000000b";
const TODAY = "2026-12-01", TOMORROW = "2026-12-02";

// ---------- Geoapify y función imitados ----------
const calles = { prova: ["Carrer d'en Prova", 42.10], olivera: ["Carrer de l'Olivera", 42.11], pins: ["Avinguda dels Pins", 42.12], nou: ["Carrer Nou", 42.13] };
const clave = text => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
  .replace(/^(calle|carrer|avenida|avinguda|av)\b\.?\s*/u, "").replace(/\b(de|del|dels|d|l|en)\b|'/gu, " ").replace(/\s+/g, " ").trim().replace(/\s+\d+\b.*$/u, "");
const geoapify = async url => {
  const p = url.searchParams;
  if (url.pathname.endsWith("/routing")) return Response.json({ features: [{ properties: { distance: 12000, time: 600 } }] });
  const street = p.get("street") ?? p.get("text").split(",")[0];
  const found = calles[clave(street)];
  if (!found) return Response.json({ results: [] });
  return Response.json({ results: [{ country_code: "es", street: found[0], housenumber: p.get("housenumber") ?? /\s(\d+)$/u.exec(street)?.[1],
    postcode: CP, city: TOWN, county: "Girona", lat: found[1], lon: 2.2, result_type: "building", rank: { confidence: 0.95, match_type: "full_match" } }] });
};

async function server(state) {
  const source = (await read("supabase/functions/my-routes-estimate/index.ts")).replace(/^import .*$/gm, "");
  let serve;
  const backend = { rpc: async (name, args) => {
    if (name === "cc_route_pilot_charge") state.credits += args.p_credits;
    if (name === "cc_route_pilot_begin") state.bookings++;
    if (name === "cc_route_pilot_status") return { data: { active: true, stopped: false }, error: null };
    if (name === "cc_route_budget_wait") return { data: { waitSeconds: state.wait ?? 0, busy: false, paused: false, sharedLimit: false }, error: null };
    return { data: true, error: null };
  } };
  const client = { rpc: async name => ({ error: null, data: name === "cc_my_route_locations_v2" ? prefs
    : name === "cc_my_appointments" ? state.agenda : state.ignored }) };
  const env = { MY_ROUTES_GEOAPIFY_KEY: "clave-ficticia", MY_ROUTES_GEOAPIFY_APPROVED: "yes", MY_ROUTES_GEOAPIFY_MANUAL_FREE_PILOT: "yes",
    MY_ROUTES_GEOAPIFY_ACCESS: JSON.stringify({ [TECH]: "home-and-activities" }), MY_ROUTES_CARTOCIUDAD: "no" };
  const scope = {
    Deno: { env: { get: name => env[name] }, serve: fn => { serve = fn; } },
    jsonResponse: (_, body, status = 200) => ({ body, status }), preflightOrReject: () => null,
    currentUser: async () => ({ user: { id: TECH }, client, claims: {} }), serviceClient: () => backend,
    ...core, ...policy, ...control, ...renewal, ...cause,
    calculateJourney: (addresses, options) => core.calculateJourney(addresses, { ...options, fetcher: geoapify }),
  };
  new Function(...Object.keys(scope), stripTypeScriptTypes(source))(...Object.values(scope));
  return body => serve({ text: async () => JSON.stringify(body), signal: new AbortController().signal });
}

// Modelo de la migración: una fila por técnico y día; borra lo anterior a hoy al leer (propio) y al guardar (todos).
function database(clock) {
  const rows = new Map();
  const sweep = tech => { for (const [key, row] of rows) if (row.date < madridDay(clock()) && (!tech || row.tech === tech)) rows.delete(key); };
  return {
    rows,
    rpcFor: session => async (name, args) => {
      if (args.p_expected_technician_id !== session) return { data: null, error: { code: "42501" } };
      const date = args.p_work_date, key = session + "|" + date;
      if (name === "cc_my_route_day") {
        sweep(session);
        return { data: savableDate(date, clock()) ? structuredClone(rows.get(key)?.legs ?? []) : [], error: null };
      }
      sweep();
      if (!savableDate(date, clock())) return { data: false, error: null };
      if (!args.p_legs.length) rows.delete(key);
      else rows.set(key, { tech: session, date, legs: structuredClone(args.p_legs) });
      return { data: true, error: null };
    },
  };
}

const pause = () => new Promise(resolve => setTimeout(resolve, 120));
// Espera a que la pantalla y la función imitada terminen (la función dosifica las llamadas al proveedor).
async function wait(state, get) {
  let last = "", same = 0;
  for (let round = 0; round < 400 && same < 8; round++) {
    await pause();
    const next = JSON.stringify([state.bodies.length, state.credits, state.running, get("CalculationNotice").textContent, texts(get("List"))]);
    same = next === last && !state.running ? same + 1 : 0;
    last = next;
  }
  assert.ok(same >= 8, "la pantalla no ha terminado");
}
// Los 5 tramos calculados: el contador «N de M» desaparece y suman los cinco.
const COMPLETA = /Conducción total: 50 min · 60 km(?!\s*\d+ de \d+ desplazamientos calculados)/;
const clock = { value: new Date("2026-12-01T07:00:00Z") };
const now = () => clock.value;

async function device(state, { db = null, actorId = TECH, date = TODAY, agenda, ignored, rpc, timer = null } = {}) {
  const { panel, get } = fakePanel();
  const actor = { id: actorId, role: "technician" };
  const run = await server(state);
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    state.bodies.push(body);
    if (state.old && body.only) return { data: null, error: { status: 400 } };
    state.running++;
    const reply = await run(body).finally(() => { state.running--; });
    return reply.status === 200 ? { data: reply.body, error: null } : { data: null, error: { status: reply.status } };
  } });
  const saved = rpc ?? db?.rpcFor(actorId);
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => date, provider, now,
    timers: { set: task => { if (timer) timer.task = task; return 1; }, clear() {} },
    savedDays: saved ? createRpcRouteDays({ rpc: saved, getActor: () => actor }) : null,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: agenda ?? state.agenda, ignored: ignored ?? state.ignored }) });
  ui.sync();
  get("Tab").events.click();
  await wait(state, get);
  const list = () => texts(get("List")).join("\n");
  const card = title => get("List").children.find(node => node.tag === "article" && node.children[0].textContent === title);
  const travel = title => card(title).children.find(node => node.className === "route-travel").textContent;
  const calculate = async () => { await get("Calculate").events.click(); await wait(state, get); };
  const correct = async (title, street, number) => {
    const form = card(title).children.find(node => node.tag === "form");
    const inputs = form.children.filter(node => node.tag === "label").map(label => label.children[0]);
    inputs[0].value = street; inputs[1].value = number;
    form.events.submit({ preventDefault() {} });
    await wait(state, get);
  };
  return { get, ui, list, card, travel, calculate, correct };
}
const state = (extra = {}) => ({ agenda: citas, ignored: [], bodies: [], credits: 0, bookings: 0, running: 0, ...extra });

// ---------- C2: «Desplazamiento Alianzas» ----------

const jornada = [otra("Desplazamiento Alianzas", "08:00", "08:45"), otra("Comida Alianzas", "14:00", "14:45"),
  otra("Tourline Alianzas", "16:30", "16:45"), otra("Desplazamiento Alianzas", "17:00", "18:00")];

test("C2: «Desplazamiento Alianzas» sale «Sin desplazamiento», no cuenta y la ruta la salta; Tourline se calcula", async () => {
  const activities = combineActivities(citas, jornada, prefs);
  const excluded = activities.filter(item => item.type === "Desplazamiento Alianzas");
  assert.ok(excluded.every(item => item.skipped && item.travel === "pause" && !item.noDestination && item.address === ""));
  const legs = buildLegs(formatRouteLocation(prefs.home), activities);
  assert.equal(legs.length, 6, "casa, 4 instalaciones, Tourline y regreso");
  assert.equal(legs[0].from.type, "Casa");
  assert.equal(legs[0].to.time, "09:00");
  assert.equal(legs.at(-1).from.type, "Tourline Alianzas", "el regreso sale de la última actividad con dirección");
  assert.equal(legs.at(-1).from.endTime, "16:45", "la excluida no retrasa la salida de la anterior");
  assert.ok(legs.every(leg => leg.from.address && leg.to.address));
  const s = state({ ignored: jornada });
  const phone = await device(s);
  await phone.calculate();
  for (const title of ["08:00 · Desplazamiento Alianzas", "17:00 · Desplazamiento Alianzas", "14:00 · Comida Alianzas"]) {
    assert.equal(phone.travel(title), "Sin desplazamiento");
  }
  const shown = phone.list();
  assert.doesNotMatch(shown, /Falta el destino|sin destino|Completar dirección|jornada no empieza/);
  assert.match(shown, /Sal de casa a las 08:40/);
  assert.match(shown, /4 de 6 desplazamientos calculados/);
  assert.match(phone.travel("Regreso a casa"), /min · 12 km desde Tourline Alianzas \(16:30\)/);
  assert.match(phone.travel("16:30 · Tourline Alianzas"), /10 min · 12 km/);
});

test("C2: regla acotada y ampliable; con dirección se calcula; app y función iguales", async () => {
  const con = { type: "Desplazamiento Alianzas", time: "08:00", full_address: "Carrer Nou 2", population: TOWN, postal_code: CP };
  assert.equal(combineActivities([], [con], prefs)[0].travel, "travel");
  for (const type of ["Tourline Alianzas", "Recogida de llaves", "Mantenimiento Alianzas", "Desplazamientos varios"]) {
    assert.equal(combineActivities([], [otra(type, "08:00", "")], prefs)[0].skipped, undefined, type);
  }
  for (const type of ["Desplazamiento", "DESPLAZAMIENTO ALIANZAS", "Desplazamiento a obra"]) {
    assert.equal(combineActivities([], [otra(type, "08:00", "")], prefs)[0].skipped, true, type);
  }
  const [a, b] = await Promise.all(["my-routes.mjs", "supabase/functions/my-routes-estimate/route-agenda.mjs"].map(read));
  const rule = /const noTravelWithoutAddress = (\[.*\]);/;
  assert.equal(a.match(rule)[1], b.match(rule)[1]);
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, jornada, prefs));
  assert.equal(await routeFingerprint(legs), await core.journeyFingerprint(core.journeyAddresses(prefs, citas, jornada)));
});

test("compatibilidad: la función nueva acepta la cadena de 3routes23 (con la actividad excluida dentro)", async () => {
  const s = state({ ignored: jornada });
  const run = await server(s);
  const legacy = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, jornada, prefs, new Map(), { legacyTransit: true }));
  assert.equal(legacy.length, 8);
  const reply = await run({ date: TODAY, fingerprint: await routeFingerprint(legacy), expectedActor: TECH });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.estimates.length, legacy.length);
  const wrong = await run({ date: TODAY, fingerprint: "0".repeat(64), expectedActor: TECH });
  assert.equal(wrong.status, 409);
});

// ---------- C4: `only` en la función ----------

test("C4 función: `only` busca y cobra solo esos tramos; índices no válidos se rechazan sin reservar", async () => {
  const s = state();
  const run = await server(s);
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, [], prefs));
  const base = { date: TODAY, fingerprint: await routeFingerprint(legs), expectedActor: TECH };
  const full = await run(base);
  const fullCredits = s.credits;
  s.credits = 0;
  const part = await run({ ...base, only: [3] });
  assert.equal(part.status, 200);
  assert.deepEqual(part.body.estimates.map(Boolean), [false, false, false, true, false]);
  assert.deepEqual(part.body.details.filter(Boolean), []);
  assert.ok(s.credits === 4 && fullCredits > s.credits, `créditos: ruta entera ${fullCredits}, un tramo ${s.credits}`);
  assert.equal(full.body.estimates.filter(Boolean).length, 3);
  const bookings = s.bookings;
  for (const only of [[], [5], [-1], [1, 1], ["1"], 1, null]) {
    assert.equal((await run({ ...base, only })).status, 400, JSON.stringify(only));
  }
  assert.equal(s.bookings, bookings);
});

test("C4 función: con el tope agotado solo marca «pilot_limit» en los tramos pedidos", async () => {
  const addresses = core.journeyAddresses(prefs, [citas[0], citas[2], citas[3]], []);
  let charges = 0;
  const details = [];
  await core.calculateJourney(addresses, { apiKey: "x", manualFreePilot: true, details, only: new Set([1, 2]),
    fetcher: geoapify, charge: async () => ++charges <= 3 });
  assert.equal(details[2], "pilot_limit");
  assert.equal(details[0] ?? null, null);
  assert.equal(details[3] ?? null, null);
});

// ---------- C3 y C4 en la pantalla ----------

test("C3: cerrar y reabrir (u otro dispositivo) muestra lo guardado sin consultar ni gastar", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const db = database(now), s = state();
  const first = await device(s, { db });
  assert.match(first.travel("09:00 · Instalación"), /Sin calcular/);
  await first.calculate();
  assert.match(first.travel("09:00 · Instalación"), /10 min · 12 km desde casa/);
  const spent = s.credits, requests = s.bodies.length;
  assert.equal(db.rows.size, 1);
  const second = await device(s, { db });
  assert.equal(s.bodies.length, requests, "al abrir no se consulta la función");
  assert.equal(s.credits, spent);
  assert.match(second.travel("09:00 · Instalación"), /10 min · 12 km desde casa/);
  assert.equal(second.travel("11:00 · Instalación"), "No encuentro la calle");
  assert.equal(second.travel("13:00 · Instalación"), "No encuentro la otra dirección");
  assert.match(second.list(), /3 de 5 desplazamientos calculados\nActualizado a las \d{2}:\d{2}/);
  // En la base no hay ninguna dirección, municipio ni teléfono.
  const stored = JSON.stringify([...db.rows.values()].map(row => row.legs));
  assert.doesNotMatch(stored, /carrer|avinguda|prova|olivera|pins|vilafict|17599|officials|suggestions/i);
  for (const leg of [...db.rows.values()][0].legs) {
    assert.ok(Object.keys(leg).every(key => ["a", "s", "t", "d", "m", "r", "dt", "dg", "ap", "src"].includes(key)), Object.keys(leg).join());
  }
});

test("C3: si cambia una dirección de la agenda, solo sus tramos quedan «Sin calcular»", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const db = database(now), s = state();
  await (await device(s, { db })).calculate();
  const requests = s.bodies.length;
  const changed = citas.map(row => row.id === "d" ? { ...row, full_address: "CARRER PROVA 40" } : row);
  const phone = await device(s, { db, agenda: changed });
  assert.equal(s.bodies.length, requests);
  assert.match(phone.travel("09:00 · Instalación"), /10 min/);
  assert.equal(phone.travel("15:00 · Instalación"), "Sin calcular");
  assert.equal(phone.travel("Regreso a casa"), "Sin calcular");
  assert.equal(phone.travel("11:00 · Instalación"), "No encuentro la calle");
});

test("C3: solo hoy y mañana; al cambiar de día se borra lo anterior; otro técnico no ve nada", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const db = database(now), s = state();
  await (await device(s, { db, date: TOMORROW })).calculate();
  await (await device(s, { db, date: "2026-12-04" })).calculate();
  await (await device(s, { db, date: "2026-11-30" })).calculate();
  await (await device(s, { db })).calculate();
  assert.deepEqual([...db.rows.values()].map(row => row.date).sort(), [TODAY, TOMORROW]);
  const stranger = await device(state(), { db, actorId: OTHER });
  assert.equal(stranger.travel("09:00 · Instalación"), "Sin calcular");
  assert.deepEqual(await createRpcRouteDays({ rpc: db.rpcFor(OTHER), getActor: () => ({ id: TECH, role: "technician" }) }).read(TODAY), []);
  clock.value = new Date("2026-12-02T07:00:00Z");
  await device(s, { db, date: TOMORROW });
  assert.deepEqual([...db.rows.values()].map(row => row.date), [TOMORROW]);
});

test("C3: medianoche de Madrid y días que se guardan", () => {
  const late = new Date("2026-12-01T23:30:00Z");
  assert.equal(madridDay(late), TOMORROW);
  assert.equal(savableDate(TODAY, late), false);
  assert.equal(savableDate("2026-12-03", late), true);
  assert.equal(savableDate("2026-12-04", late), false);
  assert.equal(savableDate("2027-01-01", new Date("2026-12-31T10:00:00Z")), true);
});

test("C3: sin la migración la app sigue como antes y en la sesión conserva lo calculado", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const missing = async () => ({ data: null, error: { code: "PGRST202" } });
  const s = state();
  const phone = await device(s, { rpc: missing });
  await phone.calculate();
  assert.match(phone.travel("09:00 · Instalación"), /10 min · 12 km desde casa/);
  assert.equal((await device(s, { rpc: missing })).travel("09:00 · Instalación"), "Sin calcular");
  const broken = await device(s, { rpc: async () => { throw new Error("sin red"); } });
  assert.equal(broken.travel("09:00 · Instalación"), "Sin calcular");
});

test("C4: corregir una dirección calcula solo sus tramos, conserva los demás y actualiza lo guardado", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const db = database(now), s = state();
  const phone = await device(s, { db });
  await phone.calculate();
  const fullCredits = s.credits;
  const before = structuredClone([...db.rows.values()][0].legs);
  s.credits = 0;
  await phone.correct("11:00 · Instalación", "Carrer Nou", "99");
  const body = s.bodies.at(-1);
  assert.deepEqual(body.only, [1, 2], "el de llegada y el de salida");
  assert.ok(s.credits > 0 && s.credits < fullCredits, `créditos: jornada ${fullCredits}, corrección ${s.credits}`);
  assert.equal(s.credits, 7);
  assert.match(phone.list(), COMPLETA);
  const after = [...db.rows.values()][0].legs;
  assert.equal(after.length, 5);
  for (const index of [0, 3, 4]) assert.deepEqual(after[index], before[index], "tramo conservado " + index);
  assert.ok(after[1].d && after[2].d);
  // Reabrir (la corrección ya no está en memoria): lo guardado sigue a la vista y se dice de dónde sale.
  const requests = s.bodies.length;
  const reopened = await device(s, { db });
  assert.equal(s.bodies.length, requests);
  assert.match(reopened.list(), COMPLETA);
  assert.match(reopened.list(), /Calculado con la dirección que corregiste\./);
  // Recalcular toda la ruta sin la corrección no borra los tiempos ya calculados con ella.
  await reopened.calculate();
  assert.match(reopened.list(), COMPLETA);
});

test("C4: sin nada calculado, la corrección completa todos los pendientes", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const s = state();
  const phone = await device(s);
  await phone.calculate();
  const other = citas.map(row => row.id === "d" ? { ...row, full_address: "CARRER PROVA 40" } : row);
  s.agenda = other;
  s.credits = 0;
  phone.get("Date").events.change();
  await wait(s, phone.get);
  assert.equal(phone.travel("15:00 · Instalación"), "Sin calcular");
  await phone.correct("11:00 · Instalación", "Carrer Nou", "99");
  assert.deepEqual(s.bodies.at(-1).only, [1, 2, 3, 4], "sus dos tramos y los dos que estaban sin calcular");
});

test("C4: durante la espera de 2 minutos la corrección queda aplicada y al terminar calcula solo sus tramos", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const s = state({ wait: 120 }), timer = {};
  const phone = await device(s, { timer });
  await phone.calculate();
  const requests = s.bodies.length;
  s.credits = 0;
  await phone.correct("11:00 · Instalación", "Carrer Nou", "99");
  assert.equal(s.bodies.length, requests, "durante la espera no se pide nada");
  assert.equal(s.credits, 0);
  assert.match(phone.travel("09:00 · Instalación"), /10 min/, "lo calculado se mantiene");
  assert.equal(phone.travel("11:00 · Instalación"), "Sin calcular");
  s.wait = 0;
  clock.value = new Date("2026-12-01T07:02:01Z");
  timer.task();
  await wait(s, phone.get);
  assert.deepEqual(s.bodies.at(-1).only, [1, 2]);
  assert.equal(s.credits, 7);
  assert.match(phone.list(), COMPLETA);
});

test("C4: con la función v18 (rechaza `only`) la corrección calcula la ruta entera como hasta ahora", async () => {
  clock.value = new Date("2026-12-01T07:00:00Z");
  const s = state({ old: true });
  const phone = await device(s);
  await phone.calculate();
  await phone.correct("11:00 · Instalación", "Carrer Nou", "99");
  assert.ok(s.bodies.at(-2).only);
  assert.equal(s.bodies.at(-1).only, undefined);
  assert.match(phone.list(), COMPLETA);
});

test("reglas de los registros: pendientes, huellas, fallos que no borran tiempos y campos admitidos", async () => {
  assert.equal(pendingRecord(null), true);
  assert.equal(pendingRecord({ dt: "pilot_limit" }), true);
  assert.equal(pendingRecord({ dt: "street_not_found", r: "not_found" }), false);
  assert.equal(pendingRecord({ r: "no_route" }), false);
  assert.equal(pendingRecord({ d: 10 }), false);
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, [], prefs));
  const mine = await legSignatures(TECH, legs[1]), theirs = await legSignatures(OTHER, legs[1]);
  assert.notEqual(mine.a, theirs.a);
  const records = new Map();
  keepRecord(records, { a: mine.a, s: "corregida", d: 5, m: 6, t: "2026-12-01T07:00:00.000Z" });
  keepRecord(records, { ...mine, r: "not_found", t: "2026-12-01T08:00:00.000Z" });
  assert.equal(records.get(mine.a).d, 5);
  assert.equal(lookupRecord(records, mine, false).corrected, true);
  assert.equal(lookupRecord(records, mine, true), null, "con otra corrección en memoria: sin calcular");
  const clean = persistableRecord({ ...mine, d: 5, m: 6, t: "2026-12-01T08:00:00Z", dt: "Calle Falsa 1", officials: ["x"], street: "y" });
  assert.deepEqual(Object.keys(clean).sort(), ["a", "d", "m", "s", "t"]);
  assert.equal(persistableRecord({ a: "corta", s: mine.s, t: "2026-12-01T08:00:00Z" }), null);
});

test("migración: tabla con RLS por técnico, sin acceso directo, solo hoy y mañana y borrado de lo anterior", async () => {
  const sql = await read("supabase/migrations/20261128090000_route_saved_days.sql");
  assert.match(sql, /PENDIENTE DE APLICAR/);
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code, /^\s*begin;/);
  assert.match(code, /commit;\s*$/);
  assert.match(code, /enable row level security/);
  assert.match(code, /revoke all on confirmar_citas\.route_saved_day from public, anon, authenticated, service_role;/);
  assert.match(code, /using \(technician_id = auth\.uid\(\) and confirmar_citas\.current_app_role\(\) = 'technician'\)/);
  assert.equal(code.match(/v_actor is distinct from p_expected_technician_id/g).length, 2);
  assert.match(code, /delete from confirmar_citas\.route_saved_day d where d\.technician_id = v_actor and d\.work_date < v_today;/);
  assert.match(code, /delete from confirmar_citas\.route_saved_day d where d\.work_date < v_today;/);
  assert.match(code, /p_work_date < v_today or p_work_date > v_today \+ 1/);
  assert.match(code, /at time zone 'Europe\/Madrid'/);
  assert.match(code, /\('a', 's'\)[\s\S]*else false/);
  assert.doesNotMatch(code, /\b(drop|truncate|alter table (?!confirmar_citas\.route_saved_day)|create or replace)\b/i);
  assert.doesNotMatch(code, /cc_route_|appointment|retention|2 minutes|1000|2500/i);
  assert.equal(code.match(/grant execute/g).length, 1);
  assert.match(code, /to authenticated;/);
});
