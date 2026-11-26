// CONFIRMAR_CITAS-022: calle oficial más parecida, domicilio siempre en la ruta y asistente de direcciones.
// Sin red: CartoCiudad y Geoapify simulados. Solo lugares públicos (filas de las fixtures del 020) o inventados.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calculateJourney, chooseOfficialStreet, journeyAddresses, journeyFingerprint, officialStreetName, providerPlan,
  similarity, streetFields, streetKey, suggestAddresses, suggestQuery, suggestionRows,
} from "../supabase/functions/my-routes-estimate/core.mjs";
import { homeOptIn, parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { bindAddressAssistant } from "../my-routes-autocomplete.mjs";
import { createCloudAddressSuggest, createCloudRoutes } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const CP = "17599";
const fila = changes => ({ province: "Girona", muni: "Vilafictícia", poblacion: null, postalCode: CP, type: "callejero",
  lat: 0, lng: 0, portalNumber: null, extension: null, state: 0, ...changes });

// ---------- 1. Nombre oficial y elección de la calle más parecida ----------

test("nombre oficial de las filas de CartoCiudad (formas reales de las fixtures públicas del 020)", () => {
  assert.equal(officialStreetName({ type: "callejero", address: "PLAÇA AJUNTAMENT (DE L'), Ribes de Freser", tip_via: "PLAÇA", muni: "Ribes de Freser" }), "Plaça de l'Ajuntament");
  assert.equal(officialStreetName({ type: "callejero", address: "MAS LA FARGA (Ripoll)", tip_via: null, muni: "Ripoll" }), "Mas la Farga");
  assert.equal(officialStreetName({ type: "portal", address: 'PLAÇA L"AJUNTAMENT 3, Ripoll', tip_via: "PLAÇA", muni: "Ripoll", portalNumber: 3 }), "Plaça l'Ajuntament");
  assert.equal(officialStreetName({ type: "callejero", address: "CARRETERA SANT JOAN DE LES ABADESSES, DE, Olot", tip_via: "CARRETERA", muni: "Olot" }), "Carretera de Sant Joan de les Abadesses");
  assert.equal(officialStreetName({ type: "toponimo", address: "Ajuntament de Campdevànol, Campdevànol", muni: "Campdevànol" }), "", "un topónimo no es una calle");
  assert.equal(officialStreetName({ type: "Municipio", address: "Vilafictícia" }), "");
});

test("comparación sin tipo de vía, artículos, acentos ni mayúsculas", () => {
  assert.equal(streetKey("Carrer dels Clavataires"), "clavataires");
  assert.equal(streetKey("CARRER CLAVETAIRES"), "clavetaires");
  assert.equal(streetKey("Passatge de la Fontanella"), "fontanella");
  assert.ok(similarity("clavetaires", "clavataires") >= 0.85);
  assert.ok(similarity("clavetaires", "major") < 0.5);
});

test("«CLAVETAIRES» frente a «dels Clavataires»: una sola candidata clara → se usa", () => {
  const fields = streetFields("CARRER CLAVETAIRES 4, 17599, VILAFICTICIA");
  const rows = [fila({ address: "CARRER CLAVATAIRES (DELS), Vilafictícia", tip_via: "CARRER" }),
    fila({ address: "CARRER MAJOR, Vilafictícia", tip_via: "CARRER" })];
  assert.deepEqual(chooseOfficialStreet(rows, fields), { same: false, street: "Carrer dels Clavataires", suggestions: [] });
});

test("«PTGE» frente a «Passatge de la …»: la abreviatura y el artículo no impiden la elección", () => {
  const fields = streetFields("PTGE FONTANELA 2, 17599, VILAFICTICIA");
  const rows = [fila({ address: "PASSATGE FONTANELLA (DE LA), Vilafictícia", tip_via: "PASSATGE" })];
  assert.equal(chooseOfficialStreet(rows, fields).street, "Passatge de la Fontanella");
});

test("con dudas no decide: hasta 3 sugerencias del mismo municipio; otra clase de vía nunca se elige sola", () => {
  const fields = streetFields("CARRER FONTETA 3, 17599, VILAFICTICIA");
  const dudosas = [fila({ address: "CARRER FONTETES, Vilafictícia", tip_via: "CARRER" }),
    fila({ address: "CARRER FONTETA ALTA, Vilafictícia", tip_via: "CARRER" }),
    fila({ address: "CARRER FONTANETA, Vilafictícia", tip_via: "CARRER" }),
    fila({ address: "CARRER FONTETS, Vilafictícia", tip_via: "CARRER" }),
    fila({ address: "CARRER FONTETA, Altrapoble", muni: "Altrapoble", postalCode: "17598", tip_via: "CARRER" })];
  const choice = chooseOfficialStreet(dudosas, fields);
  assert.equal(choice.street, null);
  assert.ok(choice.suggestions.length > 0 && choice.suggestions.length <= 3);
  assert.ok(!choice.suggestions.some(name => /Altrapoble/.test(name)));
  const plaza = chooseOfficialStreet([fila({ address: "PLAÇA FONTETE, Vilafictícia", tip_via: "PLAÇA" })], fields);
  assert.equal(plaza.street, null, "una plaza no sustituye a una calle sin preguntar");
  assert.deepEqual(plaza.suggestions, ["Plaça Fontete"]);
  // La misma calle oficial: no hay nada que corregir.
  assert.equal(chooseOfficialStreet([fila({ address: "CARRER FONTETA, Vilafictícia", tip_via: "CARRER" })], fields).same, true);
  // Fixture pública (020, «PTGE FARGA» inventado en Ripoll): «Mas la Farga» solo como sugerencia.
  const ripoll = streetFields("PTGE FARGA 2, 17500, RIPOLL");
  const farga = chooseOfficialStreet([{ type: "callejero", address: "MAS LA FARGA (Ripoll)", muni: "Ripoll", postalCode: "17500 17863", tip_via: null }], ripoll);
  assert.deepEqual(farga, { same: false, street: null, suggestions: ["Mas la Farga"] });
});

// ---------- 2. Jornada con la calle oficial (CartoCiudad simulado) ----------

const CALLEJERO = {
  // q → respuesta. Clave: primera palabra normalizada de `q` y si lleva número.
  "clavetaires": [],
  "clavetaires#lista": [fila({ address: "CARRER CLAVATAIRES (DELS), Vilafictícia", tip_via: "CARRER" })],
  "clavataires": fila({ type: "portal", address: "CLAVATAIRES", tip_via: "CARRER", portalNumber: 4, lat: 42.11, lng: 2.2 }),
  "fonteta": [],
  // Dos calles igual de parecidas (0,875): no se decide.
  "fonteta#lista": [fila({ address: "CARRER FONTETAS, Vilafictícia", tip_via: "CARRER" }), fila({ address: "CARRER FONTETAT, Vilafictícia", tip_via: "CARRER" })],
  "roure": fila({ type: "portal", address: "ROURE", tip_via: "CARRER", portalNumber: 9, lat: 42.12, lng: 2.2 }),
  "ficticia": fila({ type: "portal", address: "FICTICIA", tip_via: "CALLE", portalNumber: 1, lat: 42.1, lng: 2.2 }),
};
const primera = q => q.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().split(/[ ,]/u)[0];
function carto(log, sent) {
  return async url => {
    assert.equal(url.hostname, "www.cartociudad.es");
    const params = Object.fromEntries(url.searchParams);
    sent.push(params);
    const conNumero = /\d/u.test(params.q);
    const kind = url.pathname.endsWith("/findJsonp") ? "find" : conNumero ? "candidates" : "lista";
    log.push("carto-" + kind + ":" + primera(params.q));
    const data = (kind === "lista" ? CALLEJERO[primera(params.q) + "#lista"] : kind === "find" ? CALLEJERO[primera(params.q)] : []) ?? [];
    const text = JSON.stringify(data);
    return new Response(kind === "find" ? "callback(" + text + ")" : text, { status: 200 });
  };
}
function geoapify(log) {
  return async url => {
    assert.equal(url.hostname, "api-eu.geoapify.com");
    if (url.pathname.endsWith("/routing")) { log.push("ruta"); return Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] }); }
    log.push("geo");
    return Response.json({ results: [] });
  };
}
const oracle = calle => calle + ", " + CP + ", VILAFICTICIA";
const casa = "Calle Ficticia 1, 17599, Vilafictícia";

async function jornada(addresses) {
  const log = [], sent = [], officials = [], suggestions = [], details = [], sources = [];
  let charges = 0;
  const { addresses: allowed, reasons } = providerPlan(addresses, true);
  const estimates = await calculateJourney(allowed, {
    apiKey: "clave-ficticia", manualFreePilot: true, reasons, details, sources, officials, suggestions,
    charge: async () => { charges++; return true; }, fetcher: geoapify(log), cartociudad: { fetcher: carto(log, sent) },
  });
  return { estimates, log, sent, officials, suggestions, details, sources, charges };
}

test("calle oficial elegida: portal encontrado en CartoCiudad con 3 llamadas como máximo y sin Geoapify para la dirección", async () => {
  const r = await jornada([casa, oracle("CARRER CLAVETAIRES 4"), oracle("CARRER DEL ROURE 9"), casa]);
  assert.deepEqual(r.estimates.map(e => e?.durationSeconds ?? null), [1800, 1800, 1800]);
  assert.deepEqual(r.log.filter(item => item.includes("clav")), ["carto-find:clavetaires", "carto-lista:clavetaires", "carto-find:clavataires"]);
  assert.ok(!r.log.includes("geo"), "ningún crédito de Geoapify para buscar direcciones");
  assert.equal(r.charges, 3, "solo las rutas gastan créditos");
  assert.equal(r.officials[1], "Carrer dels Clavataires");
  assert.deepEqual(r.officials.filter(Boolean), ["Carrer dels Clavataires"]);
  assert.deepEqual(r.sources, ["cartociudad", "cartociudad", "cartociudad", "cartociudad"]);
  assert.deepEqual(r.sent.find(params => !/\d/.test(params.q)), { q: "Clavetaires", limit: "10", cod_postal_filter: CP });
});

test("con dudas: sugerencias aplicables como `edits`; máximo 3 llamadas a CartoCiudad y 2 a Geoapify por dirección", async () => {
  const r = await jornada([casa, oracle("CARRER FONTETA 3 2º 1a"), oracle("CARRER DEL ROURE 9"), casa]);
  assert.equal(r.estimates[0], null);
  assert.equal(r.details[0], "street_not_found");
  assert.equal(r.log.filter(item => item.startsWith("carto-") && item.endsWith(":fonteta")).length, 3);
  assert.equal(r.log.filter(item => item === "geo").length, 2);
  assert.ok(r.suggestions[1].length >= 1 && r.suggestions[1].length <= 3);
  for (const location of r.suggestions[1]) {
    assert.deepEqual(Object.keys(location).sort(), ["municipality", "number", "postalCode", "street"]);
    assert.equal(location.number, "3", "nunca el piso ni la puerta");
    assert.equal(location.postalCode, CP);
    // La sugerencia pasa la validación de `edits` del servidor.
    assert.doesNotThrow(() => parseActivityEdits([["clave", { travel: "travel", location }]]));
  }
  assert.equal(r.officials[1], null);
  assert.doesNotMatch(JSON.stringify(r.sent), /º|1a/);
});

// ---------- 3. Domicilio siempre en la ruta (servidor) ----------

test("el servidor usa siempre el domicilio; `useHome` se acepta por compatibilidad y otro tipo sigue siendo inválido", async () => {
  const source = await readFile(new URL("../supabase/functions/my-routes-estimate/index.ts", import.meta.url), "utf8");
  assert.match(source, /const plan = providerPlan\(addresses, true\);/);
  assert.match(source, /if \(homeOptIn\(input\) === null\) return invalid\(\);/);
  assert.match(source, /\["date", "fingerprint", "expectedActor", "edits", "useHome"\]/);
  assert.equal(homeOptIn({ useHome: true }), true);
  assert.equal(homeOptIn({}), false);
  assert.equal(homeOptIn({ useHome: "sí" }), null);
  const prefs = { home: { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: CP }, margin: 10 };
  const citas = [{ id: "a", scheduled_time: "09:00", full_address: "CARRER DEL ROURE 9", postal_code: CP, population: "VILAFICTICIA" }];
  const addresses = journeyAddresses(prefs, citas, []);
  assert.deepEqual(providerPlan(addresses, true).reasons, [null, null], "sin «privacy»");
  assert.match(await journeyFingerprint(addresses), /^[a-f0-9]{64}$/);
});

// ---------- 4. Modo `suggest` (CartoCiudad, gratis) ----------

test("modo suggest: solo CartoCiudad `candidates`, sin piloto ni créditos ni Geoapify", async () => {
  const source = await readFile(new URL("../supabase/functions/my-routes-estimate/index.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("if (suggest) {") > 0 && source.indexOf("if (suggest) {") < source.indexOf("cc_route_pilot_begin"),
    "responde antes de reservar el piloto");
  assert.match(source, /if \(!control && !suggest && !enabled\) return disabled\(\);/);
  assert.match(source, /\["operation", "query", "municipality", "postalCode", "expectedActor"\]/);
  assert.match(source, /if \(suggest && !cartoOn\) return disabled\(\);/);
  const sent = [];
  const items = await suggestAddresses({ query: "Carrer de la Font", municipality: "Ripoll", postalCode: "17500" }, {
    fetcher: async url => {
      assert.equal(url.hostname, "www.cartociudad.es");
      assert.ok(url.pathname.endsWith("/candidates"));
      sent.push(Object.fromEntries(url.searchParams));
      return Response.json([
        { type: "portal", address: "CALLE FONT 5, Ripoll", tip_via: "CALLE", muni: "Ripoll", province: "Girona", postalCode: "17500", portalNumber: 5 },
        { type: "callejero", address: "PLAÇA FONT (DE LA), Ripoll", tip_via: "PLAÇA", muni: "Ripoll", province: "Girona", postalCode: "17500", lat: 0, lng: 0 },
        { type: "callejero", address: "CALLE FONT, Altrapoble", tip_via: "CALLE", muni: "Altrapoble", postalCode: "17598", lat: 0, lng: 0 },
        { type: "toponimo", address: "Font del Pla, Ripoll", muni: "Ripoll", postalCode: "17500" },
      ]);
    },
  });
  assert.deepEqual(sent, [{ q: "Font, Ripoll", limit: "10", cod_postal_filter: "17500" }]);
  assert.deepEqual(items.map(item => item.label), ["Calle Font 5 · Ripoll (Girona) 17500", "Plaça de la Font · Ripoll (Girona) 17500"]);
  assert.deepEqual(items[0], { street: "Calle Font", number: "5", municipality: "Ripoll", province: "Girona", postalCode: "17500", label: items[0].label });
  await assert.rejects(suggestAddresses({ query: "Font" }, { fetcher: async () => new Response("x", { status: 500 }) }), error => error.status === 503);
});

test("modo suggest: la consulta se valida (3 letras, sin teléfonos, CP de 5 cifras)", () => {
  assert.equal(suggestQuery({ query: "Fo" }), null);
  assert.equal(suggestQuery({ query: "600 123 456" }), null);
  assert.equal(suggestQuery({ query: "Major", postalCode: "175" }), null);
  assert.equal(suggestQuery({ query: "Major<script>" }), null);
  assert.deepEqual(suggestQuery({ query: "Avda. Major 12" }), { q: "Major 12", limit: "10" });
  assert.deepEqual(suggestionRows([{ type: "portal", address: "CALLE MAJOR 1 B, Vilafictícia", tip_via: "CALLE", muni: "Vilafictícia", postalCode: CP, portalNumber: 1, extension: "B" }]).map(item => item.number), ["1B"]);
});

// ---------- 5. Asistente en la app ----------

function element(tag = "") {
  return {
    tag, children: [], events: {}, attributes: {}, value: "", hidden: false, textContent: "",
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, handler) { this.events[type] = handler; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren() { this.children.length = 0; },
    focus() { focused = this; },
  };
}
let focused = null;
function asistente(search) {
  const fields = Object.fromEntries(["street", "number", "municipality", "province", "postalCode"].map(key => [key, element("input")]));
  fields.street.id = "calle";
  let placed;
  const clear = bindAddressAssistant({ fields, search, document: { createElement: element }, place: node => { placed = node; } });
  const [status, choices, manual, credit] = placed.children;
  const input = text => { fields.street.value = text; fields.street.events.input(); };
  return { fields, status, choices, manual, credit, input, clear, results: placed };
}
const avanza = async t => { t.mock.timers.tick(300); await settle(2); };

test("asistente: 3 letras, 300 ms, pueblo visible, autorrelleno de los 5 campos y foco en el número si falta", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queries = [];
  const ui = asistente(async query => {
    queries.push(query);
    return [{ street: "Carrer dels Clavataires", number: "", municipality: "Vilafictícia", province: "Girona", postalCode: CP, label: "Carrer dels Clavataires · Vilafictícia (Girona) 17599" },
      { street: "Calle Font", number: "5", municipality: "Altrapoble", province: "Girona", postalCode: "17598", label: "Calle Font 5 · Altrapoble (Girona) 17598" }];
  });
  assert.equal(ui.fields.street.attributes.role, "combobox");
  ui.input("Cl");
  await avanza(t);
  assert.equal(queries.length, 0, "menos de 3 letras: nada");
  ui.fields.municipality.value = "Vilafictícia";
  ui.input("Cla");
  t.mock.timers.tick(299);
  assert.equal(queries.length, 0, "espera 300 ms entre teclas");
  await avanza(t);
  assert.deepEqual(queries, [{ query: "Cla", municipality: "Vilafictícia", postalCode: "" }]);
  assert.equal(ui.results.hidden, false);
  assert.equal(ui.fields.street.attributes["aria-expanded"], "true");
  assert.deepEqual(ui.choices.children.map(node => node.textContent), ["Carrer dels Clavataires · Vilafictícia (Girona) 17599", "Calle Font 5 · Altrapoble (Girona) 17598"]);
  assert.match(ui.status.textContent, /2 direcciones sugeridas/);
  assert.equal(ui.credit.hidden, false);
  ui.choices.children[0].events.click();
  assert.deepEqual(Object.fromEntries(Object.entries(ui.fields).map(([key, input]) => [key, input.value])),
    { street: "Carrer dels Clavataires", number: "", municipality: "Vilafictícia", province: "Girona", postalCode: CP });
  assert.equal(focused, ui.fields.number, "sin número: foco en el número");
  assert.equal(ui.results.hidden, true);
  ui.input("Font");
  await avanza(t);
  ui.choices.children[1].events.click();
  assert.equal(ui.fields.number.value, "5");
  assert.equal(ui.fields.municipality.value, "Altrapoble");
  assert.equal(focused, ui.fields.street);
});

test("asistente: «Escribir a mano», teclado, Escape y error del servicio (p. ej. la función v13 sin `suggest`)", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let fail = false;
  const ui = asistente(async () => { calls++; if (fail) throw new Error("400"); return [{ street: "Calle Font", number: "", municipality: "Ripoll", postalCode: "", label: "Calle Font · Ripoll" }]; });
  ui.input("Font");
  await avanza(t);
  ui.fields.street.events.keydown({ key: "ArrowDown", preventDefault() {} });
  assert.equal(focused, ui.choices.children[0]);
  ui.fields.street.events.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ui.results.hidden, true);
  ui.input("Fonts");
  await avanza(t);
  ui.manual.events.click();
  ui.input("Fonts del Pla");
  await avanza(t);
  assert.equal(calls, 2, "a mano no se busca más");
  ui.input("");
  fail = true;
  ui.input("Major");
  await avanza(t);
  assert.equal(ui.status.textContent, "No se pudieron cargar sugerencias. Puedes escribir la dirección a mano.");
});

test("cliente: el asistente solo usa el modo `suggest` (nunca `autocomplete` de Geoapify) y descarta datos no válidos", async () => {
  const bodies = [];
  const suggest = createCloudAddressSuggest({ getActor: () => ({ id: "tecnico-ficticio", role: "technician" }), invoke: async (name, { body }) => {
    assert.equal(name, "my-routes-estimate");
    bodies.push(body);
    return { data: { suggestions: [{ street: "Calle Font", number: "5", municipality: "Ripoll", province: "Girona", postalCode: "17500" },
      { street: "<b>", municipality: "Ripoll", postalCode: "" }, { street: "Calle Mala", municipality: "Ripoll", postalCode: "123" }] }, error: null };
  } });
  const items = await suggest({ query: "Font", municipality: "Ripoll", postalCode: "" }, new AbortController().signal);
  assert.deepEqual(bodies, [{ operation: "suggest", query: "Font", expectedActor: "tecnico-ficticio", municipality: "Ripoll" }]);
  assert.deepEqual(items.map(item => item.label), ["Calle Font 5 · Ripoll (Girona) 17500"]);
  const v13 = createCloudAddressSuggest({ getActor: () => ({ id: "t", role: "technician" }), invoke: async () => ({ data: null, error: { status: 400 } }) });
  await assert.rejects(v13({ query: "Font" }, new AbortController().signal));
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /autocomplete: myRoutesGeoapify \? createCloudAddressSuggest\(myRoutesGeoapify\) : null/);
  assert.doesNotMatch(app, /createCloudRouteAutocomplete/);
});

// ---------- 6. Pantalla: Ajustes, Editar desplazamiento, calle oficial y «¿Querías decir…?» ----------

const prefsApp = { home: { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: CP }, keys: null, tourline: null, margin: 10 };
const citasApp = [{ id: "a", scheduled_time: "09:00", scheduled_end_time: "10:00", full_address: "CARRER CLAVETAIRES 4", postal_code: CP, population: "VILAFICTICIA", status: "pending" },
  { id: "b", scheduled_time: "11:00", scheduled_end_time: "12:00", full_address: "CARRER FONTETA 3", postal_code: CP, population: "VILAFICTICIA", status: "pending" }];

function mountApp({ searches = [] } = {}) {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const bodies = [];
  const log = [];
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    bodies.push(body);
    const addresses = journeyAddresses(prefsApp, citasApp, [], parseActivityEdits(body.edits));
    if (await journeyFingerprint(addresses) !== body.fingerprint) return { data: null, error: { status: 409 } };
    const plan = providerPlan(addresses, true);
    const details = [], diagnostics = [], approx = [], sources = [], officials = [], suggestions = [];
    const estimates = await calculateJourney(plan.addresses, { apiKey: "clave-ficticia", manualFreePilot: true, reasons: plan.reasons,
      details, diagnostics, approx, sources, officials, suggestions, charge: async () => true, fetcher: geoapify(log),
      cartociudad: { fetcher: carto(log, []) } });
    return { data: { estimates, reasons: plan.reasons, details: estimates.map((_, i) => details[i] ?? null),
      diagnostics: estimates.map((_, i) => diagnostics[i] ?? null), approx: estimates.map((_, i) => approx[i] === true),
      sources: plan.addresses.map((_, i) => sources[i] ?? null), officials: plan.addresses.map((_, i) => officials[i] ?? null),
      suggestions: plan.addresses.map((_, i) => suggestions[i] ?? null) }, error: null };
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    autocomplete: async (query, signal) => { searches.push(query); return []; },
    preferencesStore: { read: async () => prefsApp, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citasApp, ignored: [] }) });
  ui.sync();
  return { get, panel, bodies, log };
}
const card = (get, title) => get("List").children.find(node => node.tag === "article" && node.children[0].textContent === title);
const all = (node, out = []) => { for (const child of node.children ?? []) { out.push(child); all(child, out); } return out; };

test("pantalla: «calle oficial: …» en letra pequeña y «¿Querías decir…?» que se aplica con un toque y recalcula", async () => {
  const { get, bodies } = mountApp();
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await settle(16);
  let list = texts(get("List")).join("\n");
  assert.match(list, /calle oficial: Carrer dels Clavataires/);
  const oficial = all(get("List")).find(node => node.textContent === "calle oficial: Carrer dels Clavataires");
  assert.equal(oficial.className, "fine");
  assert.match(list, /Motivo: No se encuentra esta calle en ese municipio\.\ndetalle: no_results/);
  assert.match(list, /¿Querías decir…\?/);
  const fallida = card(get, "Instalación · 11:00");
  const boton = all(fallida).find(node => node.tag === "button" && node.textContent === "Carrer Fontetas");
  assert.ok(boton, "la sugerencia es un botón");
  boton.events.click();
  await settle(20);
  assert.equal(bodies.length, 2, "un toque recalcula");
  const [[, edit]] = bodies[1].edits;
  assert.deepEqual(edit, { travel: "travel", location: { street: "Carrer Fontetas", number: "3", municipality: "Vilaficticia", postalCode: CP } });
  for (let i = 0; i < 100 && !texts(get("List")).join("").includes("Fontetas 3"); i++) await new Promise(resolve => setTimeout(resolve, 50));
  list = texts(get("List")).join("\n");
  assert.match(list, /Carrer Fontetas 3, 17599, Vilaficticia/);
});

test("pantalla: asistente en Ajustes (domicilio, recogida de llaves, Tourline) y en «Editar desplazamiento», con provincia", async t => {
  const searches = [];
  const { get, panel } = mountApp({ searches });
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await settle(16);
  const editar = card(get, "Instalación · 11:00").children.find(node => node.tag === "details");
  const group = editar.children.find(node => node.tag === "form").children[0];
  assert.deepEqual(group.children.filter(node => node.tag === "label").map(node => node.textContent),
    ["Calle o vía", "Portal (opcional)", "Municipio", "Provincia (opcional)", "Código postal (opcional)"]);
  const results = group.children[1];
  assert.equal(results.className, "route-address-results", "el asistente va debajo de la calle");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const street = group.children[0].children[0];
  group.hidden = false; // el DOM de prueba crea los nodos ocultos; en el navegador el grupo está visible
  group.children.filter(node => node.tag === "label")[2].children[0].value = "Vilafictícia";
  street.value = "Fontetes";
  street.events.input();
  t.mock.timers.tick(300);
  await settle(2);
  for (const kind of ["home", "keys", "tourline"]) {
    const input = panel.querySelector("#myRoutes-" + kind + "-street");
    assert.equal(input.attributes.role, "combobox", kind);
  }
  assert.deepEqual(searches, [{ query: "Fontetes", municipality: "Vilafictícia", postalCode: "" }], "busca con el pueblo visible");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<legend>Recogida de llaves<\/legend>/);
  assert.match(html, /<legend>Tourline \/ Recogida de material<\/legend>/);
});

test("textos neutros: ningún motivo de dirección nombra a Geoapify; se mantienen «detalle:» y «origen:»", async () => {
  const ui = await readFile(new URL("../my-routes-ui.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /Geoapify no encuentra|Geoapify encuentra la calle|Geoapify no encontró/);
  assert.match(ui, /street_not_found: "No se encuentra esta calle en ese municipio\."/);
  assert.match(ui, /"detalle: " \+ diagnostic/);
  assert.match(ui, /"origen: " \+ origin/);
  assert.match(ui, /Geoapify no devolvió una ruta utilizable/, "la ruta sí es de Geoapify");
});
