// CONFIRMAR_CITAS-034: «¿Querías decir…?» solo ofrece calles que el mismo cálculo localiza al elegirlas.
// Sin red: CartoCiudad y Geoapify simulados. Solo lugares inventados (municipio «Vilafictícia», calles
// «Rosellida» en el callejero y «Rosellides» en los portales: la misma vía escrita distinto en cada capa).
import test from "node:test";
import assert from "node:assert/strict";
import { calculateJourney, journeyAddresses, journeyFingerprint, providerPlan } from "../supabase/functions/my-routes-estimate/core.mjs";
import { parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { formatRouteLocation } from "../supabase/functions/my-routes-estimate/route-agenda.mjs";
import { createCloudRoutes } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const CP = "17599";
const TOWN = "Vilaficticia";
const fila = changes => ({ province: "Girona", muni: TOWN, poblacion: "Can Ficcio", postalCode: CP, type: "callejero",
  lat: 0, lng: 0, portalNumber: null, extension: null, state: 0, ...changes });
// Callejero: sin coordenadas ni portales (como `candidates` real).
const vial = (nombre, changes = {}) => fila({ tip_via: "CALLE", address: `CALLE ${nombre}, Can Ficcio (${TOWN})`, ...changes });
const portal = (nombre, numero, lat, changes = {}) =>
  fila({ type: "portal", tip_via: "CALLE", address: nombre, portalNumber: numero, lat, lng: 2.2, ...changes });
const plano = value => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const ROSELLIDES = [portal("ROSELLIDES", 46, 42.11)];

// `calles`: callejero que devuelve la búsqueda sin número. `portales`: [palabra buscada, filas de portal].
// Como el servicio real, la búsqueda con número es aproximada: devuelve el portal de la vía parecida.
function servidor({ calles = [vial("ROSELLIDA")], portales = [["rosellit", ROSELLIDES], ["rosellid", ROSELLIDES]], fallo = null } = {}) {
  const log = [];
  const carto = async url => {
    assert.equal(url.hostname, "www.cartociudad.es");
    const find = url.pathname.endsWith("/findJsonp");
    const q = plano(url.searchParams.get("q"));
    log.push((find ? "carto findJsonp " : "carto candidates ") + q);
    if (fallo?.(q, find)) throw new TypeError("sin red (simulado)");
    let data = [];
    if (q.startsWith("ficticia")) data = [portal("FICTICIA", 1, 42.1)];
    else if (q.startsWith("pins")) data = [portal("PINS", 9, 42.12)];
    else if (!/\d/u.test(q)) data = calles;
    else data = portales.find(([word]) => q.startsWith(word))?.[1] ?? [];
    return new Response(find ? "callback(" + JSON.stringify(data) + ")" : JSON.stringify(data), { status: 200 });
  };
  const geoapify = async url => {
    assert.equal(url.hostname, "api-eu.geoapify.com");
    if (url.pathname.endsWith("/routing")) {
      log.push("geoapify routing");
      return Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] });
    }
    log.push("geoapify geocode");
    return Response.json({ results: [] });
  };
  return { log, carto, geoapify };
}

async function jornada(addresses, server) {
  const details = [], suggestions = [];
  let credits = 0;
  const { addresses: allowed, reasons } = providerPlan(addresses, true);
  const estimates = await calculateJourney(allowed, { apiKey: "clave-ficticia", manualFreePilot: true, reasons, details,
    suggestions, charge: async amount => { credits += amount; return true; }, fetcher: server.geoapify,
    cartociudad: { fetcher: server.carto } });
  return { estimates, details, suggestions, credits, reasons };
}
const casa = `Calle Ficticia 1, ${CP}, ${TOWN}`;
const oracle = street => `${street}, ${CP}, ${TOWN.toUpperCase()}`;
const CASO = oracle("CALLE ROSELLITAS 46 URB. CAN FICCIO");

// Cada sugerencia, elegida como en la app (`edits` → dirección → cálculo), se localiza sin Geoapify.
async function exigeLocalizables(suggestions, server) {
  for (const location of suggestions ?? []) {
    const edit = parseActivityEdits([["clave", { travel: "travel", location }]]).get("clave");
    const antes = server.log.length;
    const r = await jornada([casa, formatRouteLocation(edit.location), casa], server);
    assert.deepEqual(r.estimates.map(Boolean), [true, true], "no se localiza al elegirla: " + location.street);
    assert.ok(!server.log.slice(antes).includes("geoapify geocode"), "sin créditos de búsqueda: " + location.street);
  }
}

test("calle del callejero sin portal y portales con otro nombre: solo se ofrece la que se localiza", async () => {
  const server = servidor();
  const r = await jornada([casa, CASO, casa], server);
  assert.deepEqual(r.estimates.map(Boolean), [false, false], "la calle de la agenda sigue sin localizarse");
  await exigeLocalizables(r.suggestions[1], server);
  assert.deepEqual(r.suggestions[1], [{ street: "Calle Rosellides", number: "46", municipality: TOWN, postalCode: CP }]);
});

test("comprobar las sugerencias no gasta: mismos créditos y llamadas a Geoapify, y se hace al final", async () => {
  const con = servidor();
  const a = await jornada([casa, CASO, casa], con);
  const sin = servidor({ calles: [], portales: [] });
  const b = await jornada([casa, CASO, casa], sin);
  assert.equal(a.credits, b.credits);
  assert.equal(a.credits, 2, "solo las dos búsquedas de reserva de Geoapify, como hasta ahora");
  assert.equal(con.log.filter(line => line.startsWith("geoapify")).length, 2);
  assert.ok(con.log.lastIndexOf("geoapify geocode") < con.log.lastIndexOf("carto findJsonp rosellides 46, " + plano(TOWN)));
});

test("sin ninguna localizable (sin portal, de otro núcleo o de otro tipo de vía) no hay sugerencia", async () => {
  const calles = [vial("ROSELLIDA"), vial("ROSELLETAS", { muni: "Altrapoble", poblacion: "Altrapoble" }),
    vial("ROSELLITES", { address: `CARRER ROSELLITES, Can Ficcio (${TOWN})`, tip_via: "CARRER" })];
  const otroSitio = portal("ROSELLETAS", 46, 42.4, { muni: "Altrapoble", poblacion: "Altrapoble", postalCode: "17598" });
  const server = servidor({ calles, portales: [["roselletas", [otroSitio]]] });
  const r = await jornada([casa, CASO, casa], server);
  assert.equal(r.suggestions[1], null);
  assert.ok(server.log.some(line => line.startsWith("carto findJsonp rosellida 46")), "se comprobó");
});

test("un portal de otro municipio o de otro número no genera sugerencia", async () => {
  const server = servidor({ calles: [], portales: [["rosellitas", [
    portal("ROSELLIDES", 48, 42.11),
    portal("ROSELLITES", 46, 42.4, { muni: "Altrapoble", poblacion: "Altrapoble", postalCode: "17598" }),
  ]]] });
  const r = await jornada([casa, CASO, casa], server);
  assert.equal(r.suggestions[1], null);
});

test("si CartoCiudad falla al comprobar, no se ofrece lo no comprobado y la ruta no cambia", async () => {
  const server = servidor({ fallo: q => q.startsWith("rosellid") && /\d/u.test(q) });
  const r = await jornada([casa, CASO, oracle("CARRER PINS 9"), oracle("CARRER PINS 9"), casa], server);
  assert.equal(r.suggestions[1], null);
  assert.deepEqual(r.estimates.map(Boolean), [false, false, true, true]);
});

test("como máximo 5 comprobaciones por dirección aunque haya más candidatas", async () => {
  const nombres = ["ROSELLIDA", "ROSELLITAT", "ROSELLETA", "ROSELLIT", "ROSELLINA", "ROSELLIA", "ROSELLICA"];
  const server = servidor({ calles: nombres.map(name => vial(name)), portales: [] });
  const r = await jornada([casa, CASO, casa], server);
  assert.equal(r.suggestions[1], null);
  const comprobadas = new Set(server.log.filter(line => /^carto findJsonp rosell(?!itas)/u.test(line)));
  assert.ok(comprobadas.size >= 1 && comprobadas.size <= 5, String(comprobadas.size));
});

// ---------- Pantalla ----------

const prefs = { home: { street: "Calle Ficticia", number: "1", municipality: TOWN, postalCode: CP }, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, calle) => ({ id, scheduled_time: hora, full_address: calle, postal_code: CP, population: TOWN.toUpperCase(), status: "pending" });
const all = (node, out = []) => { for (const child of node.children ?? []) { out.push(child); all(child, out); } return out; };
const cards = get => get("List").children.filter(node => node.tag === "article");
const buttons = (node, label) => all(node).filter(item => item.tag === "button" && item.textContent === label);
async function idle(get) {
  await settle(30);
  for (let i = 0; i < 400 && (!get("List").children.length || /^Calculando/.test(get("CalculationNotice").textContent)); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await settle(30);
}
async function pantalla(server) {
  const citas = [cita("a", "09:00", "CALLE ROSELLITAS 46 URB. CAN FICCIO"), cita("b", "11:00", "CARRER PINS 9")];
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    const addresses = journeyAddresses(prefs, citas, [], parseActivityEdits(body.edits));
    assert.equal(await journeyFingerprint(addresses), body.fingerprint);
    const r = await jornada(addresses, server);
    return { data: { estimates: r.estimates, reasons: r.reasons, details: r.estimates.map((_, i) => r.details[i] ?? null),
      suggestions: addresses.map((_, i) => r.suggestions[i] ?? null) }, error: null };
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: [] }) });
  ui.sync();
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await idle(get);
  return { get };
}

test("pantalla: la sugerencia ofrecida, al elegirla, calcula el tramo", async () => {
  const p = await pantalla(servidor());
  const card = cards(p.get)[1];
  assert.equal(buttons(card, "Calle Rosellida").length, 0, "la calle que luego no se encuentra no se ofrece");
  buttons(card, "Calle Rosellides")[0].events.click();
  await idle(p.get);
  const shown = texts(cards(p.get)[1]).join("\n");
  assert.match(shown, /🚗 30 min · 12 km/);
  assert.doesNotMatch(shown, /No encuentro/);
});

test("pantalla: sin sugerencia localizable quedan «Escribir la calle», «Corregir a mano» y «Dejarla como está»", async () => {
  const p = await pantalla(servidor({ portales: [] }));
  const card = cards(p.get)[1];
  assert.doesNotMatch(texts(card).join("\n"), /¿Querías decir/);
  assert.match(texts(card).join("\n"), /Escribir la calle/);
  assert.equal(buttons(card, "Corregir a mano").length, 1);
  assert.equal(buttons(card, "Dejarla como está: Calle Rosellitas").length, 1);
});
