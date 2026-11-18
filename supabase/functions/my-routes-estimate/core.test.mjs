import test from "node:test";
import assert from "node:assert/strict";
import { autocompleteQuery, autocompleteStreets, calculateJourney, journeyAddresses, journeyFingerprint, streetFields } from "./core.mjs";
import { buildLegs, combineActivities } from "../../../multiusuario/my-routes.mjs";
import { createCloudRoutes, routeFingerprint } from "../../../multiusuario/my-routes-cloud.mjs";

const home = "Calle Sintética 10, 28000, Madrid";
const prefs = { home: { street: "Calle Sintética", number: "10", municipality: "Madrid", postalCode: "28000" }, keys: null, tourline: null };
const jobs = [{ scheduled_time: "10:00", full_address: "Calle Prueba 12, piso reservado", postal_code: "28000", population: "Madrid" }];
const ignored = [{ time: "09:00", type: "Mantenimiento", full_address: "Calle Ensayo 14", postal_code: "28000", population: "Madrid" },
  { time: "12:00", type: "Valoración" }];
const consecutive = [home, "Calle Prueba 12, 28000 Madrid", home];
function location(params, changes = {}) {
  return { country_code: "es", postcode: params.get("postcode") ?? "28000", city: params.get("city"), street: params.get("street"),
    housenumber: params.get("housenumber"), lat: 40 + parseInt(params.get("housenumber"), 10) / 1000, lon: -3,
    result_type: "building", rank: { confidence: 0.95, match_type: "full_match" }, ...changes };
}

test("servidor y navegador coinciden en orden y tramos con direcciones ausentes", async () => {
  const legs = buildLegs(home, combineActivities(jobs, ignored));
  assert.equal(await journeyFingerprint(journeyAddresses(prefs, jobs, ignored)), await routeFingerprint(legs));
  assert.equal(streetFields("Calle 10 sin datos de municipio"), null);
  assert.equal(streetFields("Calle de Prueba S/N, Madrid"), null);
  assert.deepEqual(streetFields(journeyAddresses(prefs, jobs, ignored)[2]), {
    street: "Calle Prueba", housenumber: "12", postcode: "28000", city: "Madrid", country: "España", filter: "countrycode:es", limit: "2",
  });
  assert.deepEqual(streetFields("Calle 8 de marzo 12 bis, Madrid"), {
    street: "Calle 8 de marzo", housenumber: "12 bis", city: "Madrid", country: "España", filter: "countrycode:es", limit: "2",
  });
});

test("recogida de llaves, Tourline y PAI conservan el orden y la dirección apropiada", () => {
  const route = journeyAddresses({ ...prefs, keys: { street: "Calle Llaves", number: "3", municipality: "Madrid" },
    tourline: { street: "Calle Material", number: "4", municipality: "Madrid" } }, jobs, [
    { type: "Pausa", time: "09:30" },
    { type: "Recogida de llaves", time: "11:00", full_address: "Calle Original 9", population: "Madrid" },
    { type: "PAI Lanzamiento", time: "11:50", full_address: "Calle Original 8", population: "Madrid" },
    { type: "Tourline / Recogida de material", time: "12:15" },
    { type: "Avería", time: "12:45", full_address: "Sin dirección", population: "Madrid" },
  ]);
  assert.deepEqual(route, [home, "Calle Prueba 12, piso reservado, 28000, Madrid", "Calle Llaves 3, Madrid",
    "Calle Original 8, Madrid", "Calle Material 4, Madrid", "", home]);
});

test("Geoapify recibe solo campos estructurados y coordenadas; reserva cada llamada antes de consultar", async () => {
  const events = [];
  const estimates = await calculateJourney(journeyAddresses(prefs, jobs, ignored), {
    apiKey: "fake-test-key",
    charge: async amount => { events.push(amount); return true; },
    fetcher: async (url, options) => {
      assert.equal(url.hostname, "api-eu.geoapify.com");
      assert.equal(options.headers, undefined);
      assert.doesNotMatch(url.href, /reservado|telefono|notas|jwt/i);
      const p = url.searchParams;
      events.push(url.pathname);
      if (p.has("housenumber")) return Response.json({ results: [null, location(p)] });
      assert.equal(p.get("mode"), "drive");
      assert.equal(p.get("units"), "metric");
      assert.equal(p.get("traffic"), "free_flow");
      return Response.json({ features: [{ properties: { distance: 1200, time: 240 } }] });
    },
  });
  assert.deepEqual(estimates.map(x => x?.durationSeconds ?? null), [240, 240, null, null]);
  assert.deepEqual(events, [1, "/v1/geocode/search", 1, "/v1/geocode/search", 2, "/v1/routing", 1, "/v1/geocode/search", 2, "/v1/routing"]);
});

test("si hay dos portales creíbles sin código postal, se descarta el tramo", async () => {
  const paths = [];
  const result = await calculateJourney([home, "Calle Prueba 12, Madrid", home], {
    apiKey: "fake-test-key", charge: async () => true,
    fetcher: async url => {
      paths.push(url.pathname);
      const p = url.searchParams;
      return Response.json({ results: p.has("postcode") ? [location(p)] : [location(p), location(p, { lat: 40.015, postcode: "28001" })] });
    },
  });
  assert.deepEqual(paths, ["/v1/geocode/search", "/v1/geocode/search"]);
  assert.deepEqual(result, [null, null]);
});

test("límite y rechazo del proveedor detienen las solicitudes pendientes", async () => {
  const failIfCalled = () => assert.fail("no se autorizó la salida");
  await assert.rejects(calculateJourney(consecutive, { apiKey: "key", charge: async () => false, fetcher: failIfCalled }), { status: 429 });
  for (const status of [403, 429, 0]) {
    let requests = 0;
    await assert.rejects(calculateJourney(consecutive, {
      apiKey: "key", charge: async () => true, fetcher: async () => {
        requests++;
        if (!status) throw Error("sensitive detail");
        return new Response("", { status });
      },
    }), { message: "Route service unavailable", status: status ? 429 : 503, providerLimited: Boolean(status) });
    assert.equal(requests, 1);
  }
});

function suggestionsResponse() {
  return Response.json({ results: [
    { country_code: "es", result_type: "street", street: "Calle Fira", city: "Municipio A", postcode: "08000", lat: 40, lon: -3, place_id: "private-extra-field" },
    { country_code: "es", result_type: "street", street: "Calle Fira", city: "Municipio A", postcode: "08001" },
    { country_code: "es", result_type: "street", street: "Calle Fira", city: "Municipio B", postcode: "28000" },
    { country_code: "es", result_type: "building", street: "Calle Fira", city: "Municipio B", housenumber: "15" },
    { country_code: "fr", result_type: "street", street: "Calle Fira", city: "Fuera del país" },
  ] });
}

test("autocompletado conserva municipios distintos y evita postales, portales y coordenadas inciertos", async () => {
  let reserved = 0;
  const result = await autocompleteStreets(" Calle  Fira ", {
    apiKey: "fake-test-key", charge: async amount => { reserved += amount; return true; },
    fetcher: async (url, options) => {
      assert.equal(reserved, 1);
      assert.equal(url.hostname, "api-eu.geoapify.com");
      assert.equal(url.pathname, "/v1/geocode/autocomplete");
      assert.equal(url.searchParams.get("text"), "Calle Fira");
      assert.equal(url.searchParams.get("type"), "street");
      assert.equal(url.searchParams.get("filter"), "countrycode:es");
      assert.equal(options.headers, undefined);
      return suggestionsResponse();
    },
  });
  assert.deepEqual(result, [
    { street: "Calle Fira", municipality: "Municipio A", postalCode: "", label: "Calle Fira · Municipio A" },
    { street: "Calle Fira", municipality: "Municipio B", postalCode: "", label: "Calle Fira · Municipio B" },
  ]);
  const explicit = await autocompleteStreets("Calle Fira 08001", {
    apiKey: "fake-test-key", charge: async () => true, fetcher: async () => suggestionsResponse(),
  });
  assert.equal(explicit[0].postalCode, "08001");
  assert.equal(explicit[1].postalCode, "");
});

test("autocompletado inválido, cancelado o fuera de cuota no contacta al proveedor", async () => {
  assert.equal(autocompleteQuery("Fir"), "");
  assert.equal(autocompleteQuery("Calle x@example.test"), "");
  assert.equal(autocompleteQuery("Calle 123456789"), "");
  const failIfCalled = () => assert.fail("no se autorizó la salida");
  await assert.rejects(autocompleteStreets("Fir", { charge: failIfCalled, fetcher: failIfCalled }), { status: 400 });
  await assert.rejects(autocompleteStreets("Calle Fira", { charge: async () => false, fetcher: failIfCalled }), { status: 429 });
  await assert.rejects(autocompleteStreets("Calle Fira", {
    signal: AbortSignal.abort(), charge: failIfCalled, fetcher: failIfCalled,
  }), { status: 503 });
});

test("cliente deduplica por jornada y descarta los resultados al cambiar de usuario", async () => {
  const legs = buildLegs(home, combineActivities(jobs, []));
  let actor = { id: "A", role: "technician" }, calls = 0, finish;
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, options) => {
    calls++;
    assert.equal(name, "my-routes-estimate");
    assert.deepEqual(Object.keys(options.body).sort(), ["date", "expectedActor", "fingerprint"]);
    assert.doesNotMatch(JSON.stringify(options), /Sintética|Prueba/);
    return new Promise(resolve => { finish = resolve; });
  } });
  const options = { date: "2026-11-17" };
  const one = provider.estimateJourney(legs, options), two = provider.estimateJourney(legs, options);
  while (!finish) await new Promise(setImmediate);
  await new Promise(setImmediate);
  actor = { id: "B", role: "master" };
  finish({ data: { estimates: [{ distanceMeters: 33 }, { distanceMeters: 44 }] } });
  assert.deepEqual(await one, []);
  assert.deepEqual(await two, []);
  assert.deepEqual(await provider.estimateJourney(legs, options), []);
  assert.equal(calls, 1);
});
