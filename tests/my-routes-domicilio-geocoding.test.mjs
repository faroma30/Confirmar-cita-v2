// CONFIRMAR_CITAS-015: domicilio opcional (desactivado por defecto) y búsqueda de direcciones más fiable.
// Sin red ni Geoapify: respuestas simuladas. Direcciones inventadas o de lugares públicos (ayuntamientos).
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateJourney, chooseCandidate, cleanOracleText, freeTextQuery, journeyAddresses, journeyFingerprint,
  providerPlan, provinceFromPostcode, streetFields,
} from "../supabase/functions/my-routes-estimate/core.mjs";
import { homeOptIn, parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { createHomeConsent, homeConsentLabel } from "../my-routes.mjs";
import { createCloudRoutes } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { readFile } from "node:fs/promises";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const extra = { country: "España", filter: "countrycode:es", limit: "5" };

// ---------- 1. Normalización del texto de Oracle ----------

test("normaliza prefijos duplicados, apóstrofos raros y mayúsculas de Oracle", () => {
  assert.equal(cleanOracleText("CALLE CARRER DE L´ESTACIÓ 8"), "Carrer de l'Estació 8");
  assert.equal(cleanOracleText("CALLE  CARRER DE L ’ ESTACIÓ 8"), "Carrer de l'Estació 8");
  assert.equal(cleanOracleText("PLAZA PLAÇA DEL VI 1"), "Plaça del Vi 1");
  assert.equal(cleanOracleText("AVENIDA AVINGUDA DE LA FICCIÓ 12B"), "Avinguda de la Ficció 12b");
  assert.equal(cleanOracleText("C/ MAJOR 5"), "Calle Major 5");
  assert.equal(cleanOracleText("CALLE D´EN PRUEBA 3"), "Calle d'en Prueba 3");
  assert.equal(cleanOracleText("L´HOSPITALET DE FICCIÓ"), "L'Hospitalet de Ficció");
  assert.equal(cleanOracleText("SANT JOAN-DE-PROVA"), "Sant Joan-De-Prova");
  // Texto ya escrito a mano (no todo en mayúsculas): solo se limpian apóstrofos y espacios.
  assert.equal(cleanOracleText("Calle 8 de marzo 12 bis"), "Calle 8 de marzo 12 bis");
  assert.equal(cleanOracleText("Calle Mayor"), "Calle Mayor");
});

test("separa calle, número, código postal y municipio de direcciones tipo Oracle", () => {
  assert.deepEqual(streetFields("CALLE CARRER DE L´ESTACIÓ 8, 17999, VILAFICTÍCIA"), {
    street: "Carrer de l'Estació", housenumber: "8", postcode: "17999", city: "Vilafictícia", ...extra,
  });
  // Ajuntament de Girona (lugar público).
  assert.deepEqual(streetFields("PLAZA PLAÇA DEL VI 1, 17004, GIRONA"), {
    street: "Plaça del Vi", housenumber: "1", postcode: "17004", city: "Girona", ...extra,
  });
  // Ajuntament de Barcelona (lugar público).
  assert.deepEqual(streetFields("PLAZA PLAÇA DE SANT JAUME 1, 08002, BARCELONA"), {
    street: "Plaça de Sant Jaume", housenumber: "1", postcode: "08002", city: "Barcelona", ...extra,
  });
  // El número en su propia parte separada por comas.
  assert.deepEqual(streetFields("AVENIDA AVINGUDA FICTÍCIA, 64, 08999, VILAFICTÍCIA"), {
    street: "Avinguda Fictícia", housenumber: "64", postcode: "08999", city: "Vilafictícia", ...extra,
  });
  assert.equal(streetFields("CALLE CARRER DE L´ESTACIÓ S/N, 17999, VILAFICTÍCIA"), null);
});

test("deduce la provincia del código postal (tabla completa de España)", () => {
  const expected = { "01001": "Álava", "03001": "Alicante", "07001": "Illes Balears", "08002": "Barcelona", "15001": "A Coruña",
    "17004": "Girona", "20001": "Gipuzkoa", "25001": "Lleida", "28013": "Madrid", "35001": "Las Palmas",
    "38001": "Santa Cruz de Tenerife", "43001": "Tarragona", "46001": "Valencia", "48001": "Bizkaia", "51001": "Ceuta", "52001": "Melilla" };
  for (const [postcode, province] of Object.entries(expected)) assert.equal(provinceFromPostcode(postcode), province, postcode);
  for (const invalid of ["00001", "53000", "99999", "1700", "", undefined]) assert.equal(provinceFromPostcode(invalid), "");
  const provinces = new Set();
  for (let prefix = 1; prefix <= 52; prefix++) provinces.add(provinceFromPostcode(String(prefix).padStart(2, "0") + "000"));
  assert.equal(provinces.size, 52);
  assert.ok(!provinces.has(""));
});

test("el texto libre añade provincia y país, sin repetir la provincia si es el municipio", () => {
  assert.equal(freeTextQuery(streetFields("CALLE CARRER DE L´ESTACIÓ 8, 17999, VILAFICTÍCIA")),
    "Carrer de l'Estació 8, 17999 Vilafictícia, Girona, España");
  assert.equal(freeTextQuery(streetFields("PLAZA PLAÇA DEL VI 1, 17004, GIRONA")), "Plaça del Vi 1, 17004 Girona, España");
});

// ---------- 2. Elección del mejor candidato (respuestas simuladas de Geoapify) ----------

const fields = streetFields("CALLE CARRER DE L´ESTACIÓ 8, 17999, VILAFICTÍCIA");
const result = (changes = {}) => ({
  country_code: "es", street: "Carrer de l'Estació", housenumber: "8", postcode: "17999", city: "Vilafictícia", county: "Girona",
  lat: 41.9, lon: 2.8, result_type: "building", rank: { confidence: 0.95, match_type: "full_match" }, ...changes,
});

test("con varias coincidencias elige la que coincide en código postal y municipio", () => {
  const chosen = chooseCandidate([
    result({ postcode: "17998", lat: 41.95, rank: { confidence: 1, match_type: "full_match" } }),
    result({ rank: { confidence: 0.9, match_type: "full_match" } }),
  ], fields);
  assert.deepEqual(chosen, { point: [41.9, 2.8], outcome: "found" });
});

test("con la misma coincidencia elige la confianza claramente más alta; la provincia también desempata", () => {
  assert.deepEqual(chooseCandidate([
    result({ lat: 41.95, rank: { confidence: 0.7, match_type: "full_match" } }), result({ rank: { confidence: 0.98, match_type: "full_match" } }),
  ], fields).point, [41.9, 2.8]);
  // «Gerona» es un alias de Girona (código postal 17): gana frente a otra provincia con la misma confianza.
  assert.deepEqual(chooseCandidate([
    result({ lat: 41.95, county: "Barcelona" }), result({ county: "Gerona" }),
  ], fields).point, [41.9, 2.8]);
  // Duplicados del mismo punto cuentan como uno.
  assert.deepEqual(chooseCandidate([result(), result({ result_type: "amenity" })], fields).outcome, "found");
});

test("si de verdad es ambiguo sigue sin elegir; si nada encaja, lo dice", () => {
  assert.deepEqual(chooseCandidate([result({ lat: 41.95 }), result({ rank: { confidence: 0.93, match_type: "full_match" } })], fields),
    { point: null, outcome: "ambiguous" });
  assert.equal(chooseCandidate([], fields).outcome, "none");
  assert.equal(chooseCandidate([result({ housenumber: "9" }), result({ street: "Avinguda de l'Estació" }),
    result({ city: "Altrepoble", postcode: "17000" }), result({ country_code: "fr" }), result({ result_type: "street" })], fields).outcome, "none");
  assert.equal(chooseCandidate([result({ rank: { confidence: 0.5, match_type: "full_match" } })], fields).outcome, "none");
});

function geocodeFrom(params, changes = {}) {
  const street = params.get("street") ?? "Carrer de l'Estació";
  return result({ street, housenumber: params.get("housenumber") ?? "8", postcode: params.get("postcode") ?? "17999",
    city: params.get("city") ?? "Vilafictícia", lat: 41.9 + [...street].length / 1000, ...changes });
}
const routing = () => Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] });
const oracleA = "CALLE CARRER DE L´ESTACIÓ 8, 17999, VILAFICTÍCIA";
const oracleB = "AVENIDA AVINGUDA INVENTADA 20, 17999, VILAFICTÍCIA";

test("«CALLE CARRER DE L´ESTACIÓ 8» se resuelve con la búsqueda estructurada en un solo intento", async () => {
  const geocodes = [];
  const estimates = await calculateJourney(["", oracleA, oracleB, ""], {
    apiKey: "clave-ficticia", manualFreePilot: true, charge: async () => true,
    fetcher: async url => {
      if (url.pathname.endsWith("/routing")) return routing();
      const p = url.searchParams;
      geocodes.push(Object.fromEntries(p));
      assert.equal(p.get("filter"), "countrycode:es");
      assert.equal(p.get("country"), "España");
      return Response.json({ results: [geocodeFrom(p)] });
    },
  });
  assert.deepEqual(geocodes.map(p => [p.street, p.housenumber, p.postcode, p.city]),
    [["Carrer de l'Estació", "8", "17999", "Vilafictícia"], ["Avinguda Inventada", "20", "17999", "Vilafictícia"]]);
  assert.deepEqual(estimates.map(e => e?.durationSeconds ?? null), [null, 1800, null]);
});

test("si la estructurada no encuentra nada, un único intento de texto libre (máximo 2 llamadas por dirección)", async () => {
  const calls = [];
  const reasons = [];
  const estimates = await calculateJourney(["", oracleA, oracleB, ""], {
    apiKey: "clave-ficticia", manualFreePilot: true, charge: async () => true, reasons,
    fetcher: async url => {
      if (url.pathname.endsWith("/routing")) return routing();
      const p = url.searchParams;
      calls.push(p.has("text") ? "texto" : "estructurada");
      if (!p.has("text")) return Response.json({ results: [] });
      assert.match(p.get("text"), /, Girona, España$/);
      assert.equal(p.get("filter"), "countrycode:es");
      assert.equal(p.has("street"), false);
      // Solo responde la primera dirección: la segunda agota sus dos intentos.
      return Response.json({ results: p.get("text").startsWith("Carrer") ? [geocodeFrom(new URLSearchParams())] : [] });
    },
  });
  assert.deepEqual(calls, ["estructurada", "texto", "estructurada", "texto"]);
  assert.deepEqual(estimates, [null, null, null]);
  assert.equal(reasons[1], "not_found");
});

test("una ambigüedad real no gasta un segundo intento", async () => {
  let geocodes = 0;
  const reasons = [];
  await calculateJourney(["", oracleA, oracleA.replace("8,", "10,"), ""], {
    apiKey: "clave-ficticia", manualFreePilot: true, charge: async () => true, reasons,
    fetcher: async url => {
      geocodes++;
      const p = url.searchParams;
      return Response.json({ results: [geocodeFrom(p), geocodeFrom(p, { lat: 42.5, rank: { confidence: 0.93, match_type: "full_match" } })] });
    },
  });
  assert.equal(geocodes, 2);
  assert.equal(reasons[1], "not_found");
});

test("el segundo intento respeta los topes del piloto y el tratamiento de 401/403/429", async () => {
  let fetches = 0;
  let charges = 0;
  await assert.rejects(calculateJourney(["", oracleA, oracleB, ""], {
    apiKey: "clave-ficticia", manualFreePilot: true,
    charge: async () => ++charges < 2,
    fetcher: async () => { fetches++; return Response.json({ results: [] }); },
  }), { status: 429 });
  assert.equal(fetches, 1, "sin crédito no se hace la llamada de texto libre");
  for (const status of [401, 403, 429]) {
    const seen = [];
    await assert.rejects(calculateJourney(["", oracleA, oracleB, ""], {
      apiKey: "clave-ficticia", manualFreePilot: true, charge: async () => true,
      fetcher: async url => {
        seen.push(url.searchParams.has("text"));
        return url.searchParams.has("text") ? new Response("", { status }) : Response.json({ results: [] });
      },
    }), { status: 429, providerLimited: true });
    assert.deepEqual(seen, [false, true]);
  }
});

// ---------- 3. Domicilio opcional en el servidor ----------

const casa = { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: "17999" };
const prefs = { home: casa, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle,
  postal_code: "17999", population: "VILAFICTÍCIA", status: "pending" });
const citas = [cita("a", "09:00", "10:00", "CALLE CARRER DE L´ESTACIÓ 8"), cita("b", "11:00", "12:00", "AVENIDA AVINGUDA INVENTADA 20")];

test("el indicador useHome es explícito: ausente o false no usa el domicilio; otro tipo es inválido", () => {
  assert.equal(homeOptIn({ date: "2026-11-25" }), false);
  assert.equal(homeOptIn({ useHome: false }), false);
  assert.equal(homeOptIn({ useHome: true }), true);
  for (const value of ["true", 1, null, {}]) assert.equal(homeOptIn({ useHome: value }), null);
  const addresses = journeyAddresses(prefs, citas, []);
  const off = providerPlan(addresses, false);
  assert.deepEqual(off.addresses.map(Boolean), [false, true, true, false]);
  assert.deepEqual(off.reasons, ["privacy", null, "privacy"]);
  assert.deepEqual(providerPlan(addresses, "true"), off, "solo el booleano true activa el domicilio");
  const on = providerPlan(addresses, true);
  assert.deepEqual(on.addresses, addresses);
  assert.deepEqual(on.reasons, [null, null, null]);
});

// Servidor simulado con las mismas funciones que index.ts (sin Deno, Supabase ni red).
function fakeServer(log) {
  return async body => {
    const useHome = homeOptIn(body);
    if (useHome === null) return { data: null, error: { status: 400 } };
    const addresses = journeyAddresses(prefs, citas, [], parseActivityEdits(body.edits));
    if (await journeyFingerprint(addresses) !== body.fingerprint) return { data: null, error: { status: 409 } };
    const plan = providerPlan(addresses, useHome);
    const estimates = await calculateJourney(plan.addresses, {
      apiKey: "clave-ficticia", manualFreePilot: true, reasons: plan.reasons,
      charge: async (credits, isRouting) => { log.push(isRouting ? "ruta" : "geocoding"); return true; },
      fetcher: async url => url.pathname.endsWith("/routing") ? routing() : Response.json({ results: [geocodeFrom(url.searchParams)] }),
    });
    return { data: { estimates, reasons: plan.reasons }, error: null };
  };
}

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), values };
}

function mountApp({ consent, log, bodies }) {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const server = fakeServer(log);
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    bodies.push(body);
    return server(body);
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    homeConsent: consent, preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: [] }) });
  ui.sync();
  return get;
}

async function calculate(get) {
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await settle(12);
  return texts(get("List")).join("\n");
}

// CONFIRMAR_CITAS-022 (decisión del Director, 26/11/2026): el domicilio guardado se usa siempre y ya no hay
// casilla. Sustituye a la prueba del 015 «opción desactivada (por defecto)…».
test("sin casilla: el domicilio guardado se usa siempre, aunque la preferencia antigua del dispositivo esté desactivada", async () => {
  const log = [], bodies = [];
  const consent = createHomeConsent({ storage: storage(), getActor: () => ({ id: "tecnico-ficticio", role: "technician" }) });
  assert.equal(consent.read(), false, "preferencia antigua desactivada");
  const list = await calculate(mountApp({ consent, log, bodies }));
  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(bodies[0]).sort(), ["date", "expectedActor", "fingerprint", "useHome"]);
  assert.equal(bodies[0].useHome, true, "la función v13 sigue recibiendo el domicilio");
  assert.equal(log.filter(item => item === "geocoding").length, 3, "domicilio + dos visitas");
  assert.match(list, /Salida recomendada: 08:20/);
  assert.match(list, /Llegada estimada a casa: 12:30/);
  assert.doesNotMatch(list, /privacidad|fuera del piloto/);
});

test("sin domicilio guardado: no se envía `useHome` y el aviso invita a guardarlo", async () => {
  const log = [], bodies = [];
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const sinCasa = { ...prefs, home: null };
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    bodies.push(body);
    return { data: { estimates: [null, { distanceMeters: 1000, durationSeconds: 600, calculatedAt: new Date().toISOString() }, null] }, error: null };
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    preferencesStore: { read: async () => sinCasa, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: [] }) });
  ui.sync();
  const list = await calculate(get);
  assert.equal(get("Notice").textContent, "Guarda tu domicilio en Ajustes para calcular la salida.");
  assert.match(list, /Hora de salida no disponible: guarda tu domicilio en Ajustes para calcular la salida\./);
  assert.equal(bodies.every(body => !Object.hasOwn(body, "useHome")), true);
  assert.equal(log.length, 0);
});

test("opción activada: salen el primer y el último tramo y la hora de salida, y el domicilio se cobra igual", async () => {
  const log = [], bodies = [];
  const consent = createHomeConsent({ storage: storage(), getActor: () => ({ id: "tecnico-ficticio", role: "technician" }) });
  assert.equal(consent.write(true), true);
  const list = await calculate(mountApp({ consent, log, bodies }));
  assert.equal(bodies[0].useHome, true);
  assert.deepEqual(log.filter(item => item === "geocoding").length, 3, "domicilio + dos visitas, una búsqueda cada una");
  assert.deepEqual(log.filter(item => item === "ruta").length, 3);
  // 09:00 − 30 min de trayecto − 10 min de margen.
  assert.match(list, /Salida recomendada: 08:20/);
  assert.match(list, /Llegada estimada: 08:50/);
  assert.match(list, /Llegada estimada a casa: 12:30/);
  assert.match(list, /Conducción total: 90 min · 36 km/);
  assert.doesNotMatch(list, /privacidad|fuera del piloto/);
});

test("la preferencia es por técnico y por dispositivo; Master, Administrador o un fallo del almacenamiento la dejan desactivada", () => {
  const shared = storage();
  let actor = { id: "tecnico-ficticio", role: "technician" };
  const consent = createHomeConsent({ storage: shared, getActor: () => actor });
  consent.write(true);
  assert.equal(consent.read(), true);
  actor = { id: "otro-tecnico-ficticio", role: "technician" };
  assert.equal(consent.read(), false);
  for (const role of ["master", "admin"]) {
    actor = { id: "tecnico-ficticio", role };
    assert.equal(consent.read(), false);
    assert.equal(consent.write(true), false);
  }
  actor = { id: "tecnico-ficticio", role: "technician" };
  consent.write(false);
  assert.equal(consent.read(), false);
  assert.equal(shared.values.size, 0, "desactivar borra la marca");
  const broken = createHomeConsent({ storage: { getItem() { throw Error("bloqueado"); }, setItem() { throw Error("bloqueado"); } }, getActor: () => actor });
  assert.equal(broken.read(), false);
  assert.equal(broken.write(true), false);
});

test("CONFIRMAR_CITAS-022: Ajustes ya no tiene la casilla; guardar no toca la preferencia antigua", async () => {
  const shared = storage();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const consent = createHomeConsent({ storage: shared, getActor: () => actor });
  const { panel, get } = fakePanel();
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", homeConsent: consent,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} }, loadActivities: async () => ({ appointments: [], ignored: [] }) });
  ui.sync();
  get("Tab").events.click();
  await settle();
  get("OpenSettings").events.click();
  await settle();
  const box = panel.querySelector("#myRoutesUseHome");
  box.checked = true;
  get("Margin").valueAsNumber = 10;
  await get("Settings").events.submit({ preventDefault() {} });
  await settle();
  assert.equal(consent.read(), false, "la app ya no lee ni guarda la casilla");
  assert.equal(shared.values.size, 0);
});

test("CONFIRMAR_CITAS-022: Ajustes muestra el texto informativo del domicilio y ya no tiene la casilla", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(homeConsentLabel, "la etiqueta antigua se conserva solo por compatibilidad del módulo");
  assert.doesNotMatch(html, /myRoutesUseHome|type="checkbox"> Usar mi domicilio/);
  assert.match(html, /Tu domicilio se usa para calcular el primer y el último tramo y la hora de salida; se envía a CartoCiudad y Geoapify\./);
  assert.match(html, /Si no quieres que se use, no guardes ningún domicilio\./);
});
