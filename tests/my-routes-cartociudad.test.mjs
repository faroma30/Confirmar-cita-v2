// CONFIRMAR_CITAS-020: CartoCiudad (IGN-CNIG) primero para las direcciones y Geoapify de reserva.
// Sin red: respuestas simuladas. Las «fixtures públicas» son respuestas reales de CartoCiudad para lugares
// PÚBLICOS (ayuntamientos y una calle de Madrid) guardadas en la Fase A; las jornadas usan calles INVENTADAS
// (Vilafictícia, CP 17599). Nunca direcciones de clientes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CARTOCIUDAD_TIMEOUT_MS, calculateJourney, cartoQueries, cartoStreetName, chooseCarto, decodeCarto, journeyAddresses,
  journeyFingerprint, parseCarto, providerPlan, streetFields,
} from "../supabase/functions/my-routes-estimate/core.mjs";
import { homeOptIn, parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { buildLegs, combineActivities, formatRouteLocation } from "../my-routes.mjs";
import { createCloudRoutes, routeFingerprint } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

// ---------- Fixtures públicas (Fase A, 2.ª ronda; acentos restaurados: la respuesta llega en ISO-8859-1) ----------
const row = changes => ({ province: "Girona", provinceCode: "17", comunidadAutonoma: "Cataluña/Catalunya", muniCode: "17147",
  geom: null, noNumber: false, stateMsg: "", extension: null, state: 0, refCatastral: null, countryCode: "011", ...changes });
const PUBLICAS = {
  // Ayuntamiento de Ripoll: `findJsonp` «Ajuntament 3, Ripoll».
  ripollFind: row({ id: "09.17.MUN_171470225559", muni: "Ripoll", type: "portal", address: "L\"AJUNTAMENT", postalCode: "17500",
    poblacion: "Ripoll", tip_via: "PLAÇA", lat: 42.201016597629035, lng: 2.1907982860734005, portalNumber: 3 }),
  // Ayuntamiento de Ribes de Freser: `candidates` «Ajuntament 3» con CP 17534 (dos municipios con el mismo CP).
  ribesCandidates: [
    row({ muni: "Pardines", poblacion: "Pardines", type: "portal", address: "PLAÇA L\"AJUNTAMENT 3, Pardines", postalCode: "17534",
      tip_via: "PLAÇA", lat: 42.311, lng: 2.212, portalNumber: 3 }),
    row({ muni: "Ribes de Freser", poblacion: "Ribes de Freser", type: "portal", address: "PLAÇA L\"AJUNTAMENT 3, Ribes de Freser",
      postalCode: "17534", tip_via: "PLAÇA", lat: 42.305, lng: 2.168, portalNumber: 3 }),
  ],
  // Control de Madrid: `findJsonp` «Mayor 1, Madrid» da la PLAZA Mayor; `candidates` con CP 28013 da la CALLE Mayor.
  madridFind: row({ province: "Madrid", muni: "Madrid", type: "portal", address: "MAYOR", postalCode: "28012", poblacion: "Madrid",
    tip_via: "PLAZA", lat: 40.41503361172608, lng: -3.7066727500781824, portalNumber: 1 }),
  madridCandidates: [
    row({ province: "Madrid", muni: "Madrid", type: "portal", address: "CALLE MAYOR 1, Madrid", postalCode: "28013", poblacion: "Madrid",
      tip_via: "CALLE", lat: 40.416461059323886, lng: -3.7046584169537073, portalNumber: 1 }),
    row({ province: "Madrid", muni: "Madrid", type: "portal", address: "CALLE MAYOR 1 C, Madrid", postalCode: "28013", poblacion: "Madrid",
      tip_via: "CALLE", lat: 40.41644578983111, lng: -3.70490213338375, portalNumber: 1 }),
  ],
  // Vial (callejero) de `candidates`: sin coordenadas (lat 0, lng 0) → nunca se usa.
  vialSinCoordenadas: row({ type: "callejero", address: "PLAÇA AJUNTAMENT, Ripoll", muni: "Ripoll", poblacion: "Ripoll",
    postalCode: "17500", tip_via: "PLAÇA", lat: 0, lng: 0, portalNumber: null }),
};

test("fixtures públicas: portal exacto con el formato normalizado; otra vía u otro municipio con el mismo CP no se aceptan", () => {
  const ripoll = streetFields("PL. DE L´AJUNTAMENT 3, 17500, RIPOLL");
  assert.deepEqual(chooseCarto(PUBLICAS.ripollFind, ripoll), { point: [42.201016597629035, 2.1907982860734005], approx: null });
  const ribes = streetFields("PLAÇA DE L'AJUNTAMENT 3, 17534, RIBES DE FRESER");
  assert.deepEqual(chooseCarto(PUBLICAS.ribesCandidates, ribes).point, [42.305, 2.168], "gana el mismo CP y municipio");
  const madrid = streetFields("CALLE MAYOR 1, 28013, MADRID");
  assert.equal(chooseCarto(PUBLICAS.madridFind, madrid).point, null, "Plaza Mayor no es la Calle Mayor");
  assert.deepEqual(chooseCarto(PUBLICAS.madridCandidates, madrid).point, [40.416461059323886, -3.7046584169537073],
    "pedido 1: el 1 C no se acepta");
  assert.deepEqual(chooseCarto(PUBLICAS.madridCandidates.slice(1), streetFields("CALLE MAYOR 1 C, 28013, MADRID")).point,
    [40.41644578983111, -3.70490213338375], "pedido 1 C: se acepta el 1 C");
  assert.deepEqual(chooseCarto([PUBLICAS.vialSinCoordenadas], ripoll), { point: null, approx: null });
  // Número distinto, otro municipio sin CP común, municipio o topónimo: nunca.
  for (const changes of [{ portalNumber: 5 }, { muni: "Ripollet", poblacion: "Ripollet", postalCode: "08291", province: "Barcelona" },
    { type: "Municipio" }, { type: "toponimo" }]) {
    assert.equal(chooseCarto({ ...PUBLICAS.ripollFind, ...changes }, ripoll).point, null, JSON.stringify(changes));
  }
});

test("solo se envían calle (sin tipo ni artículos), número, CP y municipio; nunca piso, puerta ni escalera", () => {
  assert.equal(cartoStreetName("Plaça de l'Ajuntament"), "Ajuntament");
  assert.equal(cartoStreetName("Carrer de la Força"), "Força");
  assert.equal(cartoStreetName("Passeig de Ragull"), "Ragull");
  assert.equal(cartoStreetName("Carrer 1 de Maig"), "1 de Maig", "los artículos del interior del nombre se conservan");
  assert.equal(cartoStreetName("Sant Quintí"), "Sant Quintí");
  const fields = streetFields("CARRER DEL ROURE 9 A 2º 1a ESC B, 17599, VILAFICTICIA");
  assert.deepEqual(cartoQueries(fields), {
    // Mayúsculas tal como llegan de Oracle (CartoCiudad no distingue mayúsculas: 1.ª ronda, «PG RAGULL 10»).
    find: { q: "ROURE 9, Vilaficticia" },
    candidates: { q: "ROURE 9", limit: "5", cod_postal_filter: "17599" },
  });
  assert.deepEqual(cartoQueries(streetFields("CARRER ROURE 9, VILAFICTICIA")).candidates, { q: "Roure 9, Vilaficticia", limit: "5" });
});

test("la respuesta se lee en UTF-8, en ISO-8859-1 y como JSONP", () => {
  const latin1 = Buffer.from('callback({"tip_via":"PLAÇA","muni":"Campdevànol"})', "latin1");
  assert.deepEqual(parseCarto(decodeCarto(new Uint8Array(latin1))), { tip_via: "PLAÇA", muni: "Campdevànol" });
  const utf8 = new TextEncoder().encode('[{"tip_via":"PLAÇA"}]');
  assert.deepEqual(parseCarto(decodeCarto(utf8, "application/json;charset=UTF-8")), [{ tip_via: "PLAÇA" }]);
  assert.deepEqual(parseCarto(decodeCarto(new Uint8Array(latin1), "text/javascript; charset=ISO-8859-1")).tip_via, "PLAÇA");
  assert.equal(CARTOCIUDAD_TIMEOUT_MS, 5000);
});

// ---------- Jornadas simuladas (calles inventadas) ----------
const CP = "17599";
const oracle = (calle, municipio = "VILAFICTICIA", cp = CP) => calle + ", " + cp + ", " + municipio;
const casa = "Calle Ficticia 1, 17599, Vilafictícia";
const ficticia = (changes) => ({ province: "Girona", muni: "Vilafictícia", poblacion: "Vilafictícia", postalCode: CP, type: "portal",
  extension: null, state: 0, ...changes });
// Callejero de CartoCiudad simulado: clave = nombre normalizado que llega en `q`.
const CARTO = {
  roure: { find: ficticia({ address: "ROURE", tip_via: "CARRER", portalNumber: 9, lat: 42.11, lng: 2.2 }) },
  pins: { find: [], candidates: [] },                              // sin resultados: Geoapify
  olivera: { find: ficticia({ type: "callejero", address: "OLIVERA", tip_via: "CARRER", portalNumber: null, lat: 42.13, lng: 2.2 }), candidates: [] },
  nou: { find: ficticia({ type: "Municipio", address: "Vilafictícia", tip_via: null, portalNumber: null, lat: 42.1, lng: 2.2 }), candidates: [] },
  ficcio: { find: [], candidates: [ficticia({ address: "PASSATGE LA FICCIO 1, Vilafictícia", tip_via: "PASSATGE", portalNumber: 1, lat: 42.1, lng: 2.2 })] },
};
const GEOAPIFY = [{ calle: "Carrer dels Pins", lat: 42.12, portales: ["9"] }];
const clave = texto => texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().split(/[ ,]/u)[0];

function cartociudad(log, sent, { fail = null } = {}) {
  return async (url, { signal }) => {
    assert.equal(url.hostname, "www.cartociudad.es");
    sent.push(Object.fromEntries(url.searchParams));
    const kind = url.pathname.endsWith("/findJsonp") ? "find" : "candidates";
    log.push("carto-" + kind + ":" + clave(url.searchParams.get("q")));
    if (fail === "http") return new Response("error", { status: 500 });
    if (fail === "slow") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    if (fail === "network") throw new TypeError("network");
    const data = CARTO[clave(url.searchParams.get("q"))]?.[kind] ?? [];
    const text = JSON.stringify(data);
    return new Response(kind === "find" ? "callback(" + text + ")" : text, { status: 200 });
  };
}

function geoapify(log, charges) {
  return async url => {
    assert.equal(url.hostname, "api-eu.geoapify.com");
    const p = url.searchParams;
    if (url.pathname.endsWith("/routing")) { log.push("ruta"); return Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] }); }
    const street = p.get("street") ?? (p.get("text") ?? "").split(",")[0].replace(/\s+\S+$/u, "");
    const portal = p.get("housenumber") ?? /\s(\S+),/u.exec(p.get("text") ?? "")?.[1];
    log.push((p.has("street") ? "geo-estructurada:" : "geo-texto:") + clave(street.replace(/^(carrer|calle|passatge)\s+(de\s+|del\s+|dels\s+)?/iu, "")));
    const via = GEOAPIFY.find(item => clave(item.calle.replace(/^Carrer dels /u, "")) === clave(street.replace(/^(carrer|calle)\s+(dels\s+)?/iu, "")));
    if (!via || !via.portales.includes(portal)) return Response.json({ results: [] });
    return Response.json({ results: [{ country_code: "es", street: via.calle, housenumber: portal, postcode: CP, city: "Vilafictícia",
      county: "Girona", lat: via.lat, lon: 2.2, result_type: "building", rank: { confidence: 0.95, match_type: "full_match" } }] });
  };
}

async function plan(addresses, { fail = null, timeoutMs } = {}) {
  const { addresses: allowed, reasons } = providerPlan(addresses, false);
  const log = [], sent = [], failures = [];
  let charges = 0;
  const details = reasons.map(reason => reason === "privacy" ? "privacy" : null);
  const diagnostics = [], approx = [], sources = [];
  const estimates = await calculateJourney(allowed, {
    apiKey: "clave-ficticia", manualFreePilot: true, reasons, details, diagnostics, approx, sources,
    charge: async () => { charges++; return true; }, fetcher: geoapify(log),
    cartociudad: { fetcher: cartociudad(log, sent, { fail }), onFailure: fault => failures.push(fault), timeoutMs },
  });
  return { estimates, reasons, details, diagnostics, approx, sources, log, sent, failures, charges };
}

test("portal exacto en CartoCiudad: 1 llamada, ninguna búsqueda en Geoapify; solo la ruta gasta créditos", async () => {
  const r = await plan([casa, oracle("CARRER DEL ROURE 9"), oracle("PTGE FICCIO 1"), casa]);
  assert.deepEqual(r.estimates.map(e => e?.durationSeconds ?? null), [null, 1800, null]);
  assert.deepEqual(r.log, ["carto-find:roure", "carto-find:ficcio", "carto-candidates:ficcio", "ruta"]);
  assert.equal(r.charges, 1, "CartoCiudad no gasta créditos del piloto");
  assert.deepEqual(r.sources, [null, "cartociudad", "cartociudad", null]);
  assert.deepEqual(r.approx, [false, false, false]);
});

test("vial sin portal: se usa la calle, el tramo queda «aprox.» y conserva el código de detalle", async () => {
  const r = await plan([casa, oracle("CARRER DEL ROURE 9"), oracle("CARRER OLIVERA 4"), casa]);
  assert.deepEqual(r.estimates.map(e => e?.durationSeconds ?? null), [null, 1800, null]);
  assert.deepEqual(r.approx, [false, true, false]);
  assert.deepEqual(r.diagnostics, [null, "number_mismatch", null]);
  assert.deepEqual(r.log, ["carto-find:roure", "carto-find:olivera", "carto-candidates:olivera", "ruta"], "sin Geoapify para el vial");
  assert.deepEqual(r.sources.slice(1, 3), ["cartociudad", "cartociudad"]);
});

// CONFIRMAR_CITAS-023: sin nada con el CP, un reintento por municipio (máximo 3 a CartoCiudad y 2 a Geoapify).
test("municipio solo o sin resultados: Geoapify como hoy (máximo 3 llamadas a CartoCiudad y 2 a Geoapify por dirección)", async () => {
  const r = await plan([casa, oracle("CARRER DEL ROURE 9"), oracle("CARRER DELS PINS 9"), oracle("CARRER NOU 7"), casa]);
  assert.deepEqual(r.estimates.map(e => e?.durationSeconds ?? null), [null, 1800, null, null]);
  assert.deepEqual(r.log, ["carto-find:roure", "carto-find:pins", "carto-candidates:pins", "carto-candidates:pins", "geo-estructurada:pins", "ruta",
    "carto-find:nou", "carto-candidates:nou", "carto-candidates:nou", "geo-estructurada:nou", "geo-texto:nou"]);
  assert.deepEqual(r.sources, [null, "cartociudad", "geoapify", null, null]);
  assert.deepEqual(r.details, ["privacy", null, "street_not_found", "privacy"]);
  assert.equal(r.diagnostics[2], "no_results");
  const porDireccion = new Map();
  for (const item of r.log.filter(item => item !== "ruta")) {
    const [servicio, calle] = [item.split("-")[0], item.split(":")[1]];
    porDireccion.set(servicio + calle, (porDireccion.get(servicio + calle) ?? 0) + 1);
  }
  for (const [key, calls] of porDireccion) assert.ok(calls <= (key.startsWith("carto") ? 3 : 2), key);
});

for (const fail of ["http", "network", "slow"]) {
  test(`CartoCiudad con fallo (${fail}): pasa a Geoapify sin parar el piloto ni marcar provider_limited`, async () => {
    const r = await plan([casa, oracle("CARRER DELS PINS 9"), oracle("CARRER DELS PINS 9 A"), oracle("CARRER DEL ROURE 9"), casa],
      { fail, timeoutMs: 30 });
    // Tras el primer fallo no se vuelve a esperar a CartoCiudad en la misma jornada.
    assert.equal(r.log.filter(item => item.startsWith("carto-")).length, 1);
    assert.deepEqual(r.failures.map(f => f.kind), [{ http: "provider_http", network: "network", slow: "timeout" }[fail]]);
    assert.equal(r.failures[0].stage, "cartociudad");
    assert.deepEqual(r.estimates.map(e => e?.durationSeconds ?? null), [null, 1800, null, null]);
    assert.ok(r.log.includes("geo-estructurada:pins"));
    assert.equal(r.charges, r.log.filter(item => item.startsWith("geo-") || item === "ruta").length, "solo Geoapify gasta créditos");
    assert.ok(!JSON.stringify(r.failures).match(/Pins|Roure|42\.|17599/u), "el aviso no lleva direcciones ni coordenadas");
  });
}

test("jornada mixta: CartoCiudad, vial aproximado, Geoapify y sin resultado; ni piso ni puerta salen del servidor", async () => {
  const r = await plan([casa, oracle("CARRER DEL ROURE 9 2º 1a"), oracle("CARRER DELS PINS 9 BJ"), oracle("CARRER OLIVERA 4 ESC A PTA 3"),
    oracle("CARRER INVENTADA 4"), casa]);
  assert.deepEqual(r.estimates.map(e => e?.durationSeconds ?? null), [null, 1800, 1800, null, null]);
  assert.deepEqual(r.approx, [false, false, true, false, false]);
  assert.deepEqual(r.diagnostics, [null, null, "number_mismatch", "no_results", null]);
  assert.deepEqual(r.sources, [null, "cartociudad", "geoapify", "cartociudad", null, null]);
  const enviado = JSON.stringify(r.sent);
  assert.doesNotMatch(enviado, /º|ª|\bBJ\b|esc|pta|\b1a\b/iu);
  for (const params of r.sent) assert.deepEqual(Object.keys(params).filter(k => !["q", "limit", "cod_postal_filter"].includes(k)), []);
  const body = JSON.stringify({ approx: r.approx, sources: r.sources, diagnostics: r.diagnostics, details: r.details });
  assert.doesNotMatch(body, /42\.|Roure|Pins|Olivera|Carrer|17599|lat|lng/u);
});

test("sin CartoCiudad activado el cálculo es el de la v12 (Geoapify primero)", async () => {
  const log = [];
  const sources = [];
  await calculateJourney(providerPlan([casa, oracle("CARRER DELS PINS 9"), oracle("CARRER DELS PINS 9"), casa], false).addresses,
    { apiKey: "clave-ficticia", manualFreePilot: true, reasons: [], details: [], diagnostics: [], sources, charge: async () => true, fetcher: geoapify(log) });
  assert.deepEqual(log, ["geo-estructurada:pins", "ruta"]);
  assert.deepEqual(sources, [null, "geoapify", "geoapify", null]);
});

// ---------- Servidor (index.ts) y app ----------
test("index.ts: CartoCiudad primero, interruptor MY_ROUTES_CARTOCIUDAD=no, campos opcionales y avisos sin direcciones", async () => {
  const source = await readFile(new URL("../supabase/functions/my-routes-estimate/index.ts", import.meta.url), "utf8");
  // CONFIRMAR_CITAS-022: el interruptor se lee una vez (`cartoOn`) y la llamada añade `officials` y `suggestions`.
  assert.match(source, /const cartoOn = Deno\.env\.get\("MY_ROUTES_CARTOCIUDAD"\) !== "no";/);
  assert.match(source, /const cartociudad = !cartoOn \? null/);
  assert.match(source, /\.\.\.context, only, reasons, details, diagnostics, approx, sources, officials, suggestions, cartociudad,/);
  assert.match(source, /approx: estimates\.map\(\(_, index\) => approx\[index\] === true\)/);
  assert.match(source, /sources: addresses\.map\(\(_, index\) => sources\[index\] \?\? null\)/);
  const warn = source.slice(source.indexOf("cartociudad_attempt_failed") - 80, source.indexOf("cartociudad_attempt_failed") + 120);
  assert.doesNotMatch(warn, /address|fields|point|lat/u);
  const core = await readFile(new URL("../supabase/functions/my-routes-estimate/core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(core.slice(core.indexOf("CONFIRMAR_CITAS-020")), /console\./u, "core no registra nada");
});

const prefs = { home: { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: CP }, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle,
  postal_code: CP, population: "VILAFICTICIA", status: "pending" });
const citas = [cita("a", "09:00", "10:00", "CARRER DEL ROURE 9"), cita("b", "11:00", "12:00", "CARRER DELS PINS 9"),
  cita("c", "13:00", "14:00", "CARRER OLIVERA 4"), cita("d", "15:00", "16:00", "CARRER INVENTADA 4")];

function fakeServer({ legacy = false } = {}) {
  return async body => {
    const addresses = journeyAddresses(prefs, citas, [], parseActivityEdits(body.edits));
    if (await journeyFingerprint(addresses) !== body.fingerprint) return { data: null, error: { status: 409 } };
    const { addresses: allowed, reasons } = providerPlan(addresses, homeOptIn(body));
    const details = reasons.map(reason => reason === "privacy" ? "privacy" : null);
    const diagnostics = [], approx = [], sources = [];
    const estimates = await calculateJourney(allowed, {
      apiKey: "clave-ficticia", manualFreePilot: true, reasons, details, diagnostics, approx, sources, charge: async () => true,
      fetcher: geoapify([]), ...(legacy ? {} : { cartociudad: { fetcher: cartociudad([], []) } }),
    });
    const data = { estimates, reasons, details: estimates.map((_, i) => details[i] ?? null), diagnostics: estimates.map((_, i) => diagnostics[i] ?? null) };
    if (!legacy) Object.assign(data, { approx: estimates.map((_, i) => approx[i] === true), sources: allowed.map((_, i) => sources[i] ?? null) });
    return { data, error: null };
  };
}

async function mountApp(options) {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const server = fakeServer(options);
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => body.operation ? { data: null, error: null } : server(body) });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: [] }) });
  ui.sync();
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await settle(14);
  return texts(get("List")).join("\n");
}

test("pantalla: tramo «(aprox.)» con su detalle y el origen de las direcciones en letra pequeña", async () => {
  const list = await mountApp();
  assert.match(list, /🚗 30 min · 12 km desde /);
  assert.match(list, /Estimación sin tráfico[^\n]*\n(?:Llegada[^\n]*\n)?(?:calle oficial:[^\n]*\n)*origen: cartociudad → geoapify/);
  assert.match(list, /🚗 30 min · 12 km \(aprox\.\) desde /);
  assert.match(list, /Estimación sin tráfico[^\n]*\naprox\.: la base oficial no tiene ese portal; se usa la calle\.\ndetalle: number_mismatch\norigen: geoapify → cartociudad/);
  assert.match(list, /Motivo: No se encuentra esta calle en ese municipio\.\ndetalle: no_results/);
});

test("compatibilidad: la web nueva con la función v12 (sin `approx` ni `sources`) no muestra «aprox.» ni origen", async () => {
  const list = await mountApp({ legacy: true });
  assert.doesNotMatch(list, /aprox\.|origen:/u);
  assert.match(list, /Motivo: /);
});

test("compatibilidad: la app descarta valores desconocidos y longitudes que no cuadran", async () => {
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, [], prefs));
  const response = await fakeServer()({ date: "2026-11-25", fingerprint: await routeFingerprint(legs), expectedActor: "tecnico-ficticio" });
  assert.deepEqual(Object.keys(response.data).sort(), ["approx", "details", "diagnostics", "estimates", "reasons", "sources"]);
  const cloud = createCloudRoutes({ getActor: () => ({ id: "tecnico-ficticio", role: "technician" }),
    invoke: async () => ({ data: { ...response.data, estimates: [...response.data.estimates], approx: response.data.approx.map(() => true), sources: ["otro", ...response.data.sources.slice(1)] }, error: null }) });
  const estimates = await cloud.estimateJourney(legs, { date: "2026-11-25" });
  assert.deepEqual(estimates.approx, estimates.map(Boolean), "«aprox.» solo en tramos con tiempo");
  assert.equal(estimates.sources[0], null);
  const corto = createCloudRoutes({ getActor: () => ({ id: "tecnico-ficticio", role: "technician" }),
    invoke: async () => ({ data: { ...response.data, estimates: [...response.data.estimates], approx: [true], sources: ["cartociudad"] }, error: null }) });
  const sinCampos = await corto.estimateJourney(legs, { date: "2026-11-25" });
  assert.equal(sinCampos.approx, undefined);
  assert.equal(sinCampos.sources, undefined);
});

test("atribución visible en Mis rutas", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const content = html.slice(html.indexOf('id="myRoutesContent"'), html.indexOf('id="myRoutesSettingsPanel"'));
  assert.match(content, /<p id="myRoutesAttribution" class="fine">Direcciones: CartoCiudad © IGN-CNIG \(CC BY 4\.0\) · Rutas: Geoapify<\/p>/);
});
