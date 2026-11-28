// CONFIRMAR_CITAS-023: sugerencias sin depender del CP guardado, todas las calles oficiales del mismo nombre
// en «¿Querías decir…?» y foco en el número. Sin red: CartoCiudad y Geoapify simulados.
// Solo lugares inventados (calles «Estel», «Brollador», «Roure» y el municipio «Vilafictícia»).
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateJourney, chooseOfficialStreet, journeyAddresses, journeyFingerprint, providerPlan, streetFields,
  suggestAddresses, suggestFallbackQuery, suggestQuery, SUGGEST_MAX_CALLS,
} from "../supabase/functions/my-routes-estimate/core.mjs";
import { parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { bindAddressAssistant } from "../my-routes-autocomplete.mjs";
import { createCloudRoutes } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const CP = "17599"; // CP oficial (inventado) de Vilafictícia.
const CP_GUARDADO = "17590"; // CP aproximado guardado por el técnico (distinto del oficial).
const fila = changes => ({ province: "Girona", muni: "Vilafictícia", poblacion: null, postalCode: CP, type: "callejero",
  lat: 0, lng: 0, portalNumber: null, extension: null, state: 0, ...changes });
const PLAZA = fila({ address: "PLAÇA ESTEL (DE L'), Vilafictícia", tip_via: "PLAÇA" });
const TRES = [fila({ address: "AVENIDA BROLLADOR (DEL), Vilafictícia", tip_via: "AVENIDA" }),
  fila({ address: "PLAÇA BROLLADOR (DEL), Vilafictícia", tip_via: "PLAÇA" }),
  fila({ address: "PASEO BROLLADOR (DEL), Vilafictícia", tip_via: "PASEO" })];

// CartoCiudad simulado que imita la respuesta real: con `cod_postal_filter` distinto del oficial, nada.
function cartoSimulado({ porMunicipio = [PLAZA], conCp = {} } = {}) {
  const sent = [];
  const fetcher = async url => {
    assert.equal(url.hostname, "www.cartociudad.es");
    assert.ok(url.pathname.endsWith("/candidates"));
    const params = Object.fromEntries(url.searchParams);
    sent.push(params);
    const data = params.cod_postal_filter ? conCp[params.cod_postal_filter] ?? [] : porMunicipio;
    return Response.json(data);
  };
  return { fetcher, sent };
}

// ---------- Criterio 1: CP guardado distinto del oficial ----------

test("suggest: con un CP guardado distinto del oficial devuelve la calle (por municipio, sin `cod_postal_filter`)", async () => {
  const { fetcher, sent } = cartoSimulado();
  const items = await suggestAddresses({ query: "Plaça Estel", municipality: "Vilafictícia", postalCode: CP_GUARDADO }, { fetcher });
  assert.deepEqual(sent, [{ q: "Estel, Vilafictícia", limit: "10" }], "una sola llamada, sin el CP como filtro");
  assert.deepEqual(items.map(item => item.label), ["Plaça de l'Estel · Vilafictícia (Girona) 17599"]);
  assert.equal(items[0].postalCode, CP, "con su CP oficial");
  // Lo que hacía la v14: el CP guardado como filtro → 0 resultados («Sin coincidencias»).
  const antes = cartoSimulado();
  const url = new URL("https://www.cartociudad.es/geocoder/api/geocoder/candidates");
  url.search = new URLSearchParams({ q: "Estel, Vilafictícia", limit: "10", cod_postal_filter: CP_GUARDADO });
  assert.deepEqual(await (await antes.fetcher(url)).json(), []);
});

test("suggest: solo el mismo municipio; el CP guardado solo ordena (primero los que coinciden)", async () => {
  const otra = fila({ address: "CARRER ESTEL, Vilafictícia", tip_via: "CARRER", postalCode: "17590" });
  const fuera = fila({ address: "CARRER ESTEL, Altrapoble", muni: "Altrapoble", postalCode: "17590", tip_via: "CARRER" });
  const { fetcher } = cartoSimulado({ porMunicipio: [PLAZA, fuera, otra] });
  const items = await suggestAddresses({ query: "Estel", municipality: "VILAFICTICIA", postalCode: "17590" }, { fetcher });
  assert.deepEqual(items.map(item => item.label), ["Carrer Estel · Vilafictícia (Girona) 17590", "Plaça de l'Estel · Vilafictícia (Girona) 17599"]);
  const sinCp = await suggestAddresses({ query: "Estel", municipality: "Vilafictícia" }, { fetcher });
  assert.deepEqual(sinCp.map(item => item.street), ["Plaça de l'Estel", "Carrer Estel"], "sin CP, el orden de CartoCiudad");
});

test("suggest: la 2.ª llamada (CP como filtro) solo si la 1.ª no da nada; sin municipio, la búsqueda de siempre", async () => {
  const porCp = cartoSimulado({ porMunicipio: [], conCp: { [CP]: [fila({ address: "CARRER ESTEL, Vilafictícia Nova", muni: "Vilafictícia Nova", tip_via: "CARRER" })] } });
  const items = await suggestAddresses({ query: "Estel", municipality: "Vilafictícia", postalCode: CP }, { fetcher: porCp.fetcher });
  assert.deepEqual(porCp.sent, [{ q: "Estel, Vilafictícia", limit: "10" }, { q: "Estel", limit: "10", cod_postal_filter: CP }]);
  assert.deepEqual(items.map(item => item.street), ["Carrer Estel"], "por CP se acepta aunque el municipio se escriba distinto");
  const nada = cartoSimulado({ porMunicipio: [] });
  assert.deepEqual(await suggestAddresses({ query: "Estel", municipality: "Vilafictícia", postalCode: CP_GUARDADO }, { fetcher: nada.fetcher }), []);
  assert.equal(nada.sent.length, 2);
  const sinCp = cartoSimulado({ porMunicipio: [] });
  await suggestAddresses({ query: "Estel", municipality: "Vilafictícia" }, { fetcher: sinCp.fetcher });
  assert.equal(sinCp.sent.length, 1, "sin CP no hay 2.ª llamada");
  assert.deepEqual(suggestQuery({ query: "Estel", postalCode: CP }), { q: "Estel", limit: "10", cod_postal_filter: CP });
  assert.equal(suggestFallbackQuery({ query: "Estel", postalCode: CP }), null, "sin municipio no hay reintento");
});

// ---------- Criterio 2: varias calles oficiales con el mismo nombre ----------

test("«PTGE <nombre>» con Avenida, Plaça y Paseo oficiales del mismo nombre → 3 sugerencias con su tipo, sin elección", () => {
  const fields = streetFields("PTGE BROLLADOR 5, 17599, VILAFICTICIA");
  assert.deepEqual(chooseOfficialStreet(TRES, fields),
    { same: false, street: null, suggestions: ["Avenida del Brollador", "Plaça del Brollador", "Paseo del Brollador"] });
  // Con una sola oficial de otro tipo tampoco se elige sola (el tipo de Oracle no existe entre las oficiales).
  assert.equal(chooseOfficialStreet([TRES[0]], fields).street, null);
  // Con su mismo tipo entre las oficiales no hay nada que corregir.
  const pasaje = fila({ address: "PASSATGE BROLLADOR (DEL), Vilafictícia", tip_via: "PASSATGE" });
  assert.equal(chooseOfficialStreet([...TRES, pasaje], fields).same, true);
});

// ---------- Jornada (servidor) con CartoCiudad simulado ----------

const CALLEJERO = {
  "ficticia#find": [fila({ type: "portal", address: "FICTICIA", tip_via: "CALLE", portalNumber: 1, lat: 42.1, lng: 2.2 })],
  "roure#find": [fila({ type: "portal", address: "ROURE", tip_via: "CARRER", portalNumber: 9, lat: 42.12, lng: 2.2 })],
  "brollador#lista": TRES,
  // CONFIRMAR_CITAS-034: solo se sugieren calles con portal localizable.
  "brollador#candidates": [["AVENIDA", 42.13], ["PLAÇA", 42.14], ["PASEO", 42.15]].map(([tipo, lat]) =>
    fila({ type: "portal", address: "BROLLADOR", tip_via: tipo, portalNumber: 5, lat, lng: 2.2 })),
  "estel#find": [fila({ type: "portal", address: "ESTEL", tip_via: "CARRER", portalNumber: 3, lat: 42.16, lng: 2.2 })],
  "estels#municipio": [fila({ address: "CARRER ESTEL (DE L'), Vilafictícia", tip_via: "CARRER" })],
};
const primera = q => q.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().split(/[ ,]/u)[0];
function carto(log) {
  return async url => {
    assert.equal(url.hostname, "www.cartociudad.es");
    const params = Object.fromEntries(url.searchParams);
    const find = url.pathname.endsWith("/findJsonp");
    const kind = find ? "find" : /\d/u.test(params.q) ? "candidates" : params.cod_postal_filter ? "lista" : "municipio";
    log.push("carto-" + kind + ":" + primera(params.q) + (params.cod_postal_filter ? "@" + params.cod_postal_filter : ""));
    const data = CALLEJERO[primera(params.q) + "#" + kind] ?? [];
    return new Response(find ? "callback(" + JSON.stringify(data) + ")" : JSON.stringify(data), { status: 200 });
  };
}
function geoapify(log) {
  return async url => {
    assert.equal(url.hostname, "api-eu.geoapify.com");
    if (url.pathname.endsWith("/routing")) { log.push("ruta"); return Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] }); }
    const texto = (url.searchParams.get("street") ?? url.searchParams.get("text") ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    log.push("geo:" + texto);
    return Response.json({ results: [] });
  };
}
const casa = "Calle Ficticia 1, 17599, Vilafictícia";
async function jornada(addresses) {
  const log = [], suggestions = [], details = [], officials = [];
  const { addresses: allowed, reasons } = providerPlan(addresses, true);
  const estimates = await calculateJourney(allowed, {
    apiKey: "clave-ficticia", manualFreePilot: true, reasons, details, officials, suggestions,
    charge: async () => true, fetcher: geoapify(log), cartociudad: { fetcher: carto(log) },
  });
  return { estimates, log, suggestions, details, officials };
}
// Llamadas de la búsqueda (las de comprobar las sugerencias, CONFIRMAR_CITAS-034, van después de Geoapify).
const porDireccion = (log, palabra) => ({
  carto: log.slice(0, log.findLastIndex(item => item.startsWith("geo:") && item.includes(palabra)))
    .filter(item => item.startsWith("carto-") && item.includes(":" + palabra)).length,
  geo: log.filter(item => item.startsWith("geo:") && item.includes(palabra)).length,
});

test("jornada: «PTGE» con tres oficiales → 3 sugerencias aplicables como `edits`; topes 3 CartoCiudad y 2 Geoapify", async () => {
  const r = await jornada([casa, "PTGE BROLLADOR 5, 17599, VILAFICTICIA", "CARRER DEL ROURE 9, 17599, VILAFICTICIA", casa]);
  assert.deepEqual(r.estimates.map(e => e?.durationSeconds ?? null), [null, null, 1800]);
  assert.deepEqual(r.suggestions[1].map(location => location.street), ["Avenida del Brollador", "Plaça del Brollador", "Paseo del Brollador"]);
  assert.equal(r.officials[1], null, "sin elección automática");
  for (const location of r.suggestions[1]) assert.doesNotThrow(() => parseActivityEdits([["clave", { travel: "travel", location }]]));
  const calls = porDireccion(r.log, "brollador");
  assert.deepEqual(calls, { carto: 3, geo: 2 }, "en el tope, sin pasarlo");
});

test("calle oficial: con el CP guardado no hay candidatas → un reintento por municipio sin CP (≤ 3 llamadas)", async () => {
  const r = await jornada([casa, "CARRER ESTELS 3, " + CP_GUARDADO + ", VILAFICTICIA", "CARRER DEL ROURE 9, 17599, VILAFICTICIA", casa]);
  const estels = r.log.filter(item => item.includes(":estels"));
  assert.deepEqual(estels, ["carto-find:estels", "carto-lista:estels@" + CP_GUARDADO, "carto-municipio:estels"]);
  assert.deepEqual(r.suggestions[1].map(location => location.street), ["Carrer de l'Estel"]);
  const calls = porDireccion(r.log, "estels");
  assert.deepEqual(calls, { carto: 3, geo: 2 }, "en el tope, sin pasarlo");
  // Con el CP correcto (o con candidatas) no hay reintento: el flujo del 022 no cambia.
  const ok = await jornada([casa, "PTGE BROLLADOR 5, 17599, VILAFICTICIA", casa]);
  assert.equal(ok.log.filter(item => item.startsWith("carto-municipio")).length, 0);
});

test("topes: ≤ 2 llamadas por sugerencia en todos los casos", async () => {
  const casos = [
    [{ porMunicipio: [PLAZA] }, { query: "Estel", municipality: "Vilafictícia", postalCode: CP_GUARDADO }],
    [{ porMunicipio: [] }, { query: "Estel", municipality: "Vilafictícia", postalCode: CP_GUARDADO }],
    [{ porMunicipio: [], conCp: { [CP]: [PLAZA] } }, { query: "Estel", municipality: "Vilafictícia", postalCode: CP }],
    [{ porMunicipio: [] }, { query: "Estel", postalCode: CP }],
    [{ porMunicipio: [] }, { query: "Estel" }],
  ];
  assert.equal(SUGGEST_MAX_CALLS, 2);
  for (const [respuesta, input] of casos) {
    const { fetcher, sent } = cartoSimulado(respuesta);
    await suggestAddresses(input, { fetcher });
    assert.ok(sent.length >= 1 && sent.length <= SUGGEST_MAX_CALLS, JSON.stringify(input));
  }
});

// ---------- Criterio 3: autorrelleno y foco en el número ----------

let focused = null;
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

test("interfaz: al elegir una sugerencia sin número se vacía el número anterior y el foco va a «Número o S/N»", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fields = Object.fromEntries(["street", "number", "municipality", "province", "postalCode"].map(key => [key, element("input")]));
  let placed;
  bindAddressAssistant({ fields, document: { createElement: element }, place: node => { placed = node; }, search: async () => [
    { street: "Plaça de l'Estel", number: "", municipality: "Vilafictícia", province: "Girona", postalCode: CP, label: "Plaça de l'Estel · Vilafictícia (Girona) 17599" },
    { street: "Carrer del Roure", number: "9", municipality: "Vilafictícia", province: "Girona", postalCode: CP, label: "Carrer del Roure 9 · Vilafictícia (Girona) 17599" },
  ] });
  const choices = placed.children[1];
  const escribe = async text => { fields.street.value = text; fields.street.events.input(); t.mock.timers.tick(300); await settle(2); };
  fields.number.value = "12"; // número de otra calle
  fields.municipality.value = "Vilafictícia";
  await escribe("Estel");
  choices.children[0].events.click();
  assert.equal(fields.street.value, "Plaça de l'Estel");
  assert.equal(fields.number.value, "", "número vacío");
  assert.equal(focused, fields.number, "foco en el número");
  await escribe("Roure");
  choices.children[1].events.click();
  assert.equal(fields.number.value, "9", "con número se rellena como hoy");
  assert.equal(focused, fields.street);
});

// ---------- Pantalla: «¿Querías decir…?» con las tres y sin repetir el bloque ----------

const prefsApp = { home: { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: CP }, keys: null, tourline: null, margin: 10 };
const citasApp = [
  { id: "a", scheduled_time: "09:00", scheduled_end_time: "10:00", full_address: "PTGE BROLLADOR 5", postal_code: CP, population: "VILAFICTICIA", status: "pending" },
  { id: "b", scheduled_time: "11:00", scheduled_end_time: "12:00", full_address: "CARRER DEL ROURE 9", postal_code: CP, population: "VILAFICTICIA", status: "pending" }];

test("pantalla: «¿Querías decir…?» con Avenida, Plaça y Paseo; el tramo siguiente solo da el motivo", async () => {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const log = [];
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    const addresses = journeyAddresses(prefsApp, citasApp, [], parseActivityEdits(body.edits));
    if (await journeyFingerprint(addresses) !== body.fingerprint) return { data: null, error: { status: 409 } };
    const plan = providerPlan(addresses, true);
    const details = [], officials = [], suggestions = [];
    const estimates = await calculateJourney(plan.addresses, { apiKey: "clave-ficticia", manualFreePilot: true, reasons: plan.reasons,
      details, officials, suggestions, charge: async () => true, fetcher: geoapify(log), cartociudad: { fetcher: carto(log) } });
    return { data: { estimates, reasons: plan.reasons, details: estimates.map((_, i) => details[i] ?? null),
      officials: plan.addresses.map((_, i) => officials[i] ?? null), suggestions: plan.addresses.map((_, i) => suggestions[i] ?? null) }, error: null };
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    autocomplete: async () => [], preferencesStore: { read: async () => prefsApp, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citasApp, ignored: [] }) });
  ui.sync();
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await settle(16);
  const all = (node, out = []) => { for (const child of node.children ?? []) { out.push(child); all(child, out); } return out; };
  const botones = all(get("List")).filter(node => node.tag === "button" && /Brollador/.test(node.textContent)).map(node => node.textContent);
  assert.deepEqual(botones, ["Avenida del Brollador", "Plaça del Brollador", "Paseo del Brollador", "Dejarla como está: Passatge Brollador"], "una sola vez, con su tipo");
  const list = texts(get("List")).join("\n");
  assert.equal(list.match(/¿Querías decir…\?/g)?.length, 1);
  assert.match(list, /Motivo: La otra dirección del tramo no se encontró\./);
});
