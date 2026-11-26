// CONFIRMAR_CITAS-017: cálculo parcial, motivo concreto por tramo y calles catalanas más tolerantes.
// Sin red ni Geoapify: respuestas simuladas. Calles y municipios inventados (Vilafictícia, Santa Ficció).
import test from "node:test";
import assert from "node:assert/strict";
import {
  LEG_DETAILS, calculateJourney, chooseCandidate, incompleteReason, journeyAddresses, journeyFingerprint, legacyReason,
  missReason, providerPlan, sameMunicipality, sameStreet, streetFields,
} from "../supabase/functions/my-routes-estimate/core.mjs";
import { homeOptIn, parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { buildLegs, combineActivities, formatRouteLocation, sendableRouteLocation } from "../my-routes.mjs";
import { createCloudRoutes, legDetails, routeFingerprint } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

// ---------- 1. Comparación tolerante de calles y municipios ----------

test("ignora cada artículo catalán y castellano («de», «del», «dels», «de la», «de les», «d'», «d'en», «de l'», «la», «el», «els», «les»)", () => {
  const pares = [
    ["Carrer de Prova", "CARRER PROVA"], ["Carrer del Prova", "Carrer Prova"], ["Carrer dels Prova", "Carrer Prova"],
    ["Carrer de la Prova", "Carrer Prova"], ["Carrer de les Proves", "Carrer Proves"], ["Carrer d'Prova", "Carrer Prova"],
    ["Carrer d'en Prova", "CARRER PROVA"], ["Carrer de l'Olivera", "CARRER OLIVERA"], ["Carrer la Prova", "Carrer Prova"],
    ["Carrer el Prova", "Carrer Prova"], ["Carrer els Prova", "Carrer Prova"], ["Carrer les Proves", "Carrer Proves"],
    ["Carrer de na Prova", "Carrer Prova"], ["Carrer Sant Joan de les Proves", "CARRER SANT JOAN PROVES"],
    ["Carrer d’en Prova", "Carrer d´en Prova"], ["Carrer de l´Olivera", "Carrer de l'Olivera"],
  ];
  for (const [geoapify, oracle] of pares) assert.equal(sameStreet(geoapify, oracle), true, geoapify + " / " + oracle);
});

test("equivalencias de tipo de vía, tipo duplicado o traducido y acentos", () => {
  const pares = [
    ["Carrer Prova", "Calle Prova"], ["Carrer Prova", "C. Prova"], ["Calle Prova", "C/ Prova"],
    ["Avinguda Prova", "Avenida Prova"], ["Avinguda Prova", "Av. Prova"], ["Avinguda Prova", "Avda. Prova"],
    ["Plaça Prova", "Plaza Prova"], ["Plaça Prova", "Pl. Prova"], ["Passeig Prova", "Paseo Prova"],
    ["Passeig Prova", "Pg. Prova"], ["Camí Prova", "Camino Prova"], ["Carretera Prova", "Ctra. Prova"],
    ["Carrer de Prova", "Calle Carrer de Prova"], ["Plaça Major", "PLAZA PLAÇA MAJOR"], ["Carrer Estació", "Carrer Estacio"],
  ];
  for (const [geoapify, oracle] of pares) assert.equal(sameStreet(geoapify, oracle), true, geoapify + " / " + oracle);
  // Clases distintas nunca coinciden; tampoco calles distintas.
  for (const [a, b] of [["Avinguda Prova", "Carrer Prova"], ["Plaça Major", "Carrer Major"], ["Passeig Prova", "Camí Prova"],
    ["Carrer Prova", "Carrer Altra"], ["Carrer de la Prova Nova", "Carrer Prova"], ["", ""], ["Carrer de", "Carrer"]]) {
    assert.equal(sameStreet(a, b), false, a + " / " + b);
  }
});

test("municipio igual sin acentos ni artículos; otro municipio no", () => {
  assert.equal(sameMunicipality("Vilafictícia", "VILAFICTICIA"), true);
  assert.equal(sameMunicipality("Santa Ficció", "SANTA FICCIO"), true);
  assert.equal(sameMunicipality("L'Escala Fictícia", "ESCALA FICTICIA"), true);
  assert.equal(sameMunicipality("La Bisbal de Ficció", "BISBAL DE FICCIO"), true);
  assert.equal(sameMunicipality("Vilafictícia", "Altrepoble"), false);
  assert.equal(sameMunicipality("Vilafictícia de Dalt", "Vilafictícia"), false);
  assert.equal(sameMunicipality("", ""), false);
});

const CP = "17599";
const oracle = calle => calle + ", " + CP + ", VILAFICTICIA";
const result = (changes = {}) => ({
  country_code: "es", street: "Carrer d'en Prova", housenumber: "12", postcode: CP, city: "Vilafictícia", county: "Girona",
  lat: 42.1, lon: 2.2, result_type: "building", rank: { confidence: 0.95, match_type: "full_match" }, ...changes,
});

test("formas de Oracle «CARRER <NOMBRE> n, CP, MUNICIPIO» y «CALLE CARRER DE L´<NOMBRE> n» con municipio sin acentos", () => {
  assert.deepEqual(chooseCandidate([result()], streetFields(oracle("CARRER PROVA 12"))), { point: [42.1, 2.2], outcome: "found" });
  assert.deepEqual(chooseCandidate([result({ street: "Carrer de l'Olivera", housenumber: "3" })],
    streetFields(oracle("CALLE CARRER DE L´OLIVERA 3"))), { point: [42.1, 2.2], outcome: "found" });
  // El municipio puede venir en town/village; el código postal distinto se acepta solo en el mismo municipio.
  assert.equal(chooseCandidate([result({ city: undefined, village: "Vilafictícia", postcode: "17598" })],
    streetFields(oracle("CARRER PROVA 12"))).outcome, "found");
});

test("seguridad: nunca acepta otro municipio y código postal, otro portal, otro país ni otra clase de vía", () => {
  const fields = streetFields(oracle("CARRER PROVA 12"));
  for (const changes of [
    { city: "Altrepoble", postcode: "17000" }, { housenumber: "14" }, { country_code: "fr" },
    { street: "Avinguda d'en Prova" }, { street: "Plaça de la Prova" }, { result_type: "street" },
  ]) assert.equal(chooseCandidate([result(changes)], fields).outcome, "none", JSON.stringify(changes));
  // Dos sitios igual de probables: sigue el aviso.
  assert.equal(chooseCandidate([result(), result({ lat: 42.3, street: "Carrer de Prova" })], fields).outcome, "ambiguous");
  assert.equal(missReason([result({ housenumber: "14" })], fields), "portal_not_found");
  assert.equal(missReason([result({ city: "Altrepoble", postcode: "17000" })], fields), "street_not_found");
  assert.equal(missReason([], fields), "street_not_found");
});

test("direcciones que no se pueden buscar: falta el portal o falta calle y municipio", () => {
  assert.equal(incompleteReason(oracle("CARRER SENSE NUMERO")), "missing_number");
  assert.equal(incompleteReason(oracle("CARRER PROVA S/N")), "missing_number");
  assert.equal(incompleteReason("17599, VILAFICTICIA"), "incomplete");
  assert.equal(incompleteReason("CARRER PROVA 12"), "incomplete");
  assert.equal(incompleteReason(""), "incomplete");
});

// ---------- 2. Jornada simulada (respuestas inventadas de Geoapify) ----------

// Calle de Oracle (normalizada) → calle que devolvería Geoapify y su posición inventada.
const callejero = {
  "prova": ["Carrer d'en Prova", 42.10], "olivera": ["Carrer de l'Olivera", 42.11], "pins": ["Avinguda dels Pins", 42.12],
  "nou": ["Carrer Nou", 42.13], "lluny": ["Carrer Lluny", 44.5],
};
const clave = texto => texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
  .replace(/^(calle|carrer|avenida|avinguda|av)\b\.?\s*/u, "").replace(/\b(de|del|dels|d|l|en)\b|'/gu, " ").replace(/\s+/g, " ").trim()
  .replace(/\s+\d+\b.*$/u, "");
function geoapify(log, { ambiguous = [], otherPortal = [] } = {}) {
  return async url => {
    const p = url.searchParams;
    if (url.pathname.endsWith("/routing")) {
      log.push("ruta");
      return Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] });
    }
    const street = p.get("street") ?? p.get("text").split(",")[0];
    const name = clave(street);
    log.push((p.has("text") ? "texto:" : "estructurada:") + name);
    const found = callejero[name];
    if (!found) return Response.json({ results: [] });
    const portal = p.get("housenumber") ?? /\s(\d+)$/u.exec(street)?.[1];
    const row = result({ street: found[0], housenumber: otherPortal.includes(name) ? "999" : portal, lat: found[1] });
    return Response.json({ results: ambiguous.includes(name) ? [row, { ...row, lat: found[1] + 0.05 }] : [row] });
  };
}
const charged = log => async (credits, isRouting) => { log.push(isRouting ? "cobro-ruta" : "cobro-busqueda"); return true; };

async function plan(addresses, options) {
  const { addresses: allowed, reasons } = providerPlan(addresses, false);
  const details = reasons.map(reason => reason === "privacy" ? "privacy" : null);
  const estimates = await calculateJourney(allowed, { apiKey: "clave-ficticia", manualFreePilot: true, reasons, details, ...options });
  return { estimates, reasons, details };
}

const casa = "Calle Ficticia 1, 17599, Vilafictícia";

test("jornada de 4 visitas con una dirección imposible: se calculan los tramos posibles y los demás dan su motivo", async () => {
  const log = [];
  const { estimates, reasons, details } = await plan(
    [casa, oracle("CARRER PROVA 12"), oracle("CARRER INEXISTENT 99"), oracle("CALLE CARRER DE L´OLIVERA 3"), oracle("AV. PINS 7"), casa],
    { fetcher: geoapify(log), charge: charged([]) });
  assert.deepEqual(estimates.map(e => e?.durationSeconds ?? null), [null, null, null, 1800, null]);
  assert.deepEqual(details, ["privacy", "street_not_found", "other_end", null, "privacy"]);
  assert.deepEqual(reasons, ["privacy", "not_found", "not_found", null, "privacy"], "3routes14 sigue entendiendo los motivos");
  // Máximo 2 llamadas por dirección (solo la imposible gasta las dos) y 0 rutas para tramos con un extremo sin resolver.
  assert.deepEqual(log, ["estructurada:prova", "estructurada:inexistent", "texto:inexistent", "estructurada:olivera",
    "estructurada:pins", "ruta"]);
});

test("la dirección imposible al final: se calculan los dos primeros tramos entre visitas", async () => {
  const log = [];
  const { estimates, details } = await plan(
    [casa, oracle("CARRER PROVA 12"), oracle("CALLE CARRER DE L´OLIVERA 3"), oracle("AV. PINS 7"), oracle("CARRER INEXISTENT 99"), casa],
    { fetcher: geoapify(log), charge: charged([]) });
  assert.deepEqual(estimates.map(Boolean), [false, true, true, false, false]);
  assert.deepEqual(details, ["privacy", null, null, "street_not_found", "privacy"]);
  assert.equal(log.filter(item => item === "ruta").length, 2);
});

test("todos los motivos tienen un código estable y su equivalente para 3routes14", async () => {
  const run = async (addresses, extra = {}) => (await plan([casa, ...addresses, casa], { fetcher: geoapify([], extra), charge: charged([]) })).details;
  assert.deepEqual(await run([oracle("CARRER PROVA 12"), oracle("CARRER SENSE NUMERO")]), ["privacy", "missing_number", "privacy"]);
  assert.deepEqual(await run([oracle("CARRER SENSE NUMERO"), oracle("CARRER PROVA 12")]), ["privacy", "other_end_incomplete", "privacy"]);
  assert.deepEqual(await run([oracle("CARRER PROVA 12"), "17599, VILAFICTICIA"]), ["privacy", "incomplete", "privacy"]);
  assert.deepEqual(await run([oracle("CARRER PROVA 12"), oracle("CARRER NOU 4")], { otherPortal: ["nou"] }), ["privacy", "portal_not_found", "privacy"]);
  assert.deepEqual(await run([oracle("CARRER PROVA 12"), oracle("CARRER NOU 4")], { ambiguous: ["nou"] }), ["privacy", "ambiguous", "privacy"]);
  assert.deepEqual(await run([oracle("CARRER PROVA 12"), oracle("CARRER LLUNY 4")]), ["privacy", "no_route", "privacy"]);
  assert.deepEqual(await run([oracle("CARRER INEXISTENT 1"), oracle("CARRER PROVA 12")]), ["privacy", "other_end", "privacy"]);
  assert.deepEqual([...legDetails].sort(), [...LEG_DETAILS].sort(), "la app y el servidor comparten los códigos");
  const legacy = new Set(["privacy", "incomplete", "not_found", "no_route", null]);
  for (const detail of LEG_DETAILS) assert.ok(legacy.has(legacyReason(detail)), detail);
});

test("una ambigüedad gasta una sola llamada; una dirección sin portal no gasta ninguna", async () => {
  const log = [];
  await plan([casa, oracle("CARRER PROVA 12"), oracle("CARRER NOU 4"), oracle("CARRER SENSE NUMERO"), casa],
    { fetcher: geoapify(log, { ambiguous: ["nou"] }), charge: charged([]) });
  assert.deepEqual(log, ["estructurada:prova", "estructurada:nou"]);
});

test("tope del piloto: con algún tramo calculado se devuelve el resultado parcial; sin ninguno, 429 como antes", async () => {
  let charges = 0, limited = 0;
  const { estimates, reasons, details } = await plan(
    [casa, oracle("CARRER PROVA 12"), oracle("CALLE CARRER DE L´OLIVERA 3"), oracle("AV. PINS 7"), casa],
    { fetcher: geoapify([]), charge: async () => ++charges <= 3, onPilotLimit: () => limited++ });
  assert.deepEqual(estimates.map(Boolean), [false, true, false, false]);
  assert.deepEqual(details, ["privacy", null, "pilot_limit", "privacy"]);
  assert.deepEqual(reasons, ["privacy", null, null, "privacy"]);
  assert.equal(limited, 1, "el servidor lo registra como «quota», igual que antes");
  await assert.rejects(plan([casa, oracle("CARRER PROVA 12"), oracle("CALLE CARRER DE L´OLIVERA 3"), casa],
    { fetcher: geoapify([]), charge: async () => false }), { status: 429 });
  // Un rechazo de Geoapify (401/403/429) sigue deteniendo el piloto aunque haya tramos calculados.
  for (const status of [401, 403, 429]) {
    let calls = 0;
    await assert.rejects(plan([casa, oracle("CARRER PROVA 12"), oracle("CALLE CARRER DE L´OLIVERA 3"), oracle("AV. PINS 7"), casa], {
      charge: async () => true,
      fetcher: async (url, init) => ++calls === 4 ? new Response("", { status }) : geoapify([])(url, init),
    }), { status: 429, providerLimited: true });
  }
});

test("la respuesta nunca incluye coordenadas ni datos de Geoapify, solo códigos", async () => {
  const { estimates, reasons, details } = await plan(
    [casa, oracle("CARRER PROVA 12"), oracle("CARRER INEXISTENT 99"), oracle("CALLE CARRER DE L´OLIVERA 3"), casa],
    { fetcher: geoapify([]), charge: charged([]) });
  const body = JSON.stringify({ estimates, reasons, details });
  assert.doesNotMatch(body, /42\.1|Carrer|Prova|Olivera|lat|lon/);
  for (const detail of details) assert.ok(detail === null || LEG_DETAILS.includes(detail));
});

// ---------- 3. App: motivo por tramo, totales parciales, corrección con edits y compatibilidad ----------

const prefs = { home: { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: CP }, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle,
  postal_code: CP, population: "VILAFICTICIA", status: "pending" });
const citas = [cita("a", "09:00", "10:00", "CARRER PROVA 12"), cita("b", "11:00", "12:00", "CARRER INEXISTENT 99"),
  cita("c", "13:00", "14:00", "CALLE CARRER DE L´OLIVERA 3"), cita("d", "15:00", "16:00", "AV. PINS 7")];

// Servidor simulado con las mismas funciones que index.ts. `legacy` imita la función v10 (sin `details`).
function fakeServer(log, { legacy = false, agenda = citas } = {}) {
  return async body => {
    const useHome = homeOptIn(body);
    let addresses;
    try { addresses = journeyAddresses(prefs, agenda, [], parseActivityEdits(body.edits)); }
    catch { return { data: null, error: { status: 400 } }; }
    if (await journeyFingerprint(addresses) !== body.fingerprint) return { data: null, error: { status: 409 } };
    const { addresses: allowed, reasons } = providerPlan(addresses, useHome);
    const details = reasons.map(reason => reason === "privacy" ? "privacy" : null);
    const estimates = await calculateJourney(allowed, {
      apiKey: "clave-ficticia", manualFreePilot: true, reasons, ...(legacy ? {} : { details }),
      charge: async () => true, fetcher: geoapify(log),
    });
    return { data: legacy ? { estimates, reasons } : { estimates, reasons, details }, error: null };
  };
}

function mountApp({ log, bodies, legacy = false, agenda = citas }) {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const server = fakeServer(log, { legacy, agenda });
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    bodies.push(body);
    return server(body);
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: agenda, ignored: [] }) });
  ui.sync();
  return get;
}

async function calculate(get, open = true) {
  if (open) { get("Tab").events.click(); await settle(); }
  await get("Calculate").events.click();
  await settle(14);
  return texts(get("List")).join("\n");
}
const card = (get, title) => get("List").children.find(node => node.tag === "article" && node.children[0].textContent === title);

test("pantalla: motivo por tramo, invitación a corregir, totales de los tramos calculados y aviso general solo sin ninguno", async () => {
  const log = [], bodies = [];
  const get = mountApp({ log, bodies });
  const list = await calculate(get);
  assert.match(list, /Motivo: Geoapify no encuentra esta calle en ese municipio\.\nCorrígela en «Editar desplazamiento» de esta actividad y vuelve a calcular\./);
  assert.match(list, /Motivo: La otra dirección del tramo no se encontró\.\nCorrígela en «Editar desplazamiento» de Instalación · 11:00 y vuelve a calcular\./);
  assert.match(list, /Motivo: Tramo excluido por privacidad\./);
  assert.match(list, /Conducción total \(1 de 5 tramos\): 30 min · 12 km/);
  assert.doesNotMatch(list, /la consulta no devolvió este tramo/);
  assert.equal(get("CalculationNotice").textContent,
    "Desplazamientos calculados en 1 de 5 tramos. El motivo de los demás está junto a cada tramo.");
  // La instalación con la dirección fallida ofrece «Editar desplazamiento»; las demás instalaciones, no.
  const fallida = card(get, "Instalación · 11:00");
  assert.equal(fallida.children.find(node => node.tag === "details").children[0].textContent, "Editar desplazamiento");
  assert.equal(card(get, "Instalación · 13:00").children.some(node => node.tag === "details"), false);
});

test("corrección con edits: la dirección escrita en «Editar desplazamiento» se envía y el recálculo la usa (sin 409)", async () => {
  const log = [], bodies = [];
  const get = mountApp({ log, bodies });
  await calculate(get);
  const form = card(get, "Instalación · 11:00").children.find(node => node.tag === "details").children.find(node => node.tag === "form");
  const inputs = form.children[0].children.filter(node => node.tag === "label").map(label => label.children[0]);
  [inputs[0].value, inputs[1].value, inputs[2].value, inputs[3].value] = ["Carrer Nou", "5", "Vilafictícia", CP];
  form.events.submit({ preventDefault() {} });
  await settle();
  log.length = 0;
  const list = await calculate(get, false);
  assert.equal(bodies.length, 2);
  const [[, edit]] = bodies[1].edits;
  assert.deepEqual(edit, { travel: "travel", location: { street: "Carrer Nou", number: "5", municipality: "Vilafictícia", postalCode: CP } });
  assert.ok(log.includes("estructurada:nou"), "Geoapify recibe la dirección corregida");
  assert.ok(!log.some(item => item.endsWith(":inexistent")), "y ya no la de la agenda");
  assert.match(list, /Conducción total \(3 de 5 tramos\): 90 min · 36 km/);
  assert.doesNotMatch(list, /no encuentra esta calle|La otra dirección/);
});

test("paridad de huella con una dirección corregida en una instalación de Oracle", async () => {
  const location = { street: "Carrer Nou", number: "5", municipality: "Vilafictícia", postalCode: CP };
  const base = combineActivities(citas, [], prefs);
  const entries = [[base[1].key, { travel: "travel", location }]];
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, [], prefs, new Map(entries)));
  assert.equal(await routeFingerprint(legs), await journeyFingerprint(journeyAddresses(prefs, citas, [], parseActivityEdits(entries))));
  assert.equal(sendableRouteLocation(location), true);
  // Lo que el servidor rechazaría (400) no sale del dispositivo.
  for (const bad of [{ ...location, street: "Carrer, Nou" }, { ...location, municipality: "Vila 2" }, { ...location, number: "600 123 456" }]) {
    assert.equal(sendableRouteLocation(bad), false);
    assert.throws(() => parseActivityEdits([[base[1].key, { travel: "travel", location: bad }]]));
  }
});

test("compatibilidad: la web nueva con la función v10 (sin `details`) muestra los motivos de siempre", async () => {
  const get = mountApp({ log: [], bodies: [], legacy: true });
  const list = await calculate(get);
  assert.match(list, /Tiempo y distancia no disponibles\.\nMotivo: Geoapify no encontró una coincidencia única para la dirección\./);
  assert.match(list, /Conducción total \(1 de 5 tramos\)/);
  assert.doesNotMatch(list, /Corrígela/);
});

test("compatibilidad: la función nueva solo añade un campo opcional; `reasons` usa el vocabulario de 3routes14", async () => {
  const bodies = [];
  const server = fakeServer([]);
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, [], prefs));
  const response = await server({ date: "2026-11-25", fingerprint: await routeFingerprint(legs), expectedActor: "tecnico-ficticio" });
  bodies.push(response);
  assert.deepEqual(Object.keys(response.data).sort(), ["details", "estimates", "reasons"]);
  const legacy = new Set(["privacy", "incomplete", "not_found", "no_route"]);
  assert.ok(response.data.reasons.every(reason => reason === null || legacy.has(reason)));
  assert.equal(response.data.estimates.length, legs.length);
  // La capa de 3routes14 (my-routes-cloud) filtra motivos desconocidos y no lee `details`: nada se rompe.
  const cloud = createCloudRoutes({ getActor: () => ({ id: "tecnico-ficticio", role: "technician" }),
    invoke: async () => ({ data: { ...response.data, details: ["raro", ...response.data.details.slice(1)] }, error: null }) });
  const estimates = await cloud.estimateJourney(legs, { date: "2026-11-25" });
  assert.equal(estimates.details[0], null, "un código desconocido se descarta");
  assert.equal(estimates.reasons.length, legs.length);
});

test("cada código de motivo tiene su texto en pantalla", async () => {
  const textos = {
    privacy: "Tramo excluido por privacidad.", incomplete: "La dirección no tiene calle, portal y municipio utilizables.",
    missing_number: "Falta el número del portal.", street_not_found: "Geoapify no encuentra esta calle en ese municipio.",
    portal_not_found: "Geoapify encuentra la calle, pero no este número de portal.", ambiguous: "Hay varios sitios posibles con esta dirección.",
    other_end: "La otra dirección del tramo no se encontró.", other_end_incomplete: "A la otra dirección del tramo le falta calle, portal o municipio.",
    pilot_limit: "Tope diario del piloto alcanzado.", no_route: "Geoapify no devolvió una ruta utilizable para este tramo.",
  };
  assert.deepEqual(Object.keys(textos).sort(), [...LEG_DETAILS].sort());
  for (const [code, text] of Object.entries(textos)) {
    const { panel, get } = fakePanel();
    const actor = { id: "tecnico-ficticio", role: "technician" };
    const provider = { manual: false, clear() {}, async estimateJourney(legs) {
      const estimates = legs.map(() => null);
      Object.defineProperty(estimates, "details", { value: legs.map((_, index) => index === 1 ? code : "privacy") });
      return estimates;
    } };
    const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
      preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
      loadActivities: async () => ({ appointments: citas.slice(0, 2), ignored: [] }) });
    ui.sync();
    get("Tab").events.click();
    await settle(10);
    assert.ok(texts(get("List")).includes("Motivo: " + text), code);
  }
});

test("una instalación sin dirección completada a mano se envía en edits: sus dos tramos se calculan (antes, «la consulta no devolvió este tramo»)", async () => {
  const log = [], bodies = [];
  const agenda = [citas[0], { ...citas[1], full_address: "", postal_code: "", population: "" }, citas[2]];
  const get = mountApp({ log, bodies, agenda });
  let list = await calculate(get);
  assert.match(list, /Tramo pendiente: revisa Instalación \(11:00\)\./);
  const details = card(get, "Instalación · 11:00").children.find(node => node.tag === "details");
  assert.equal(details.children[0].textContent, "Completar dirección");
  const form = details.children.find(node => node.tag === "form");
  const inputs = form.children[0].children.filter(node => node.tag === "label").map(label => label.children[0]);
  [inputs[0].value, inputs[1].value, inputs[2].value, inputs[3].value] = ["Carrer Nou", "5", "Vilafictícia", CP];
  form.events.submit({ preventDefault() {} });
  await settle();
  list = await calculate(get, false);
  assert.equal(bodies.at(-1).edits.length, 1);
  assert.doesNotMatch(list, /la consulta no devolvió este tramo/);
  assert.match(list, /Conducción total \(2 de 4 tramos\): 60 min · 24 km/);
});
