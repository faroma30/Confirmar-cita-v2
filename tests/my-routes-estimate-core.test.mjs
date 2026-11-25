import test from "node:test";
import assert from "node:assert/strict";
import { autocompleteQuery, autocompleteStreets, calculateJourney, journeyAddresses, journeyFingerprint, streetFields } from "../supabase/functions/my-routes-estimate/core.mjs";
import { buildLegs, combineActivities } from "../my-routes.mjs";
import { createCloudRoutes, routeFingerprint } from "../my-routes-cloud.mjs";

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
    street: "Calle Prueba", housenumber: "12", postcode: "28000", city: "Madrid", country: "España", filter: "countrycode:es", limit: "5",
  });
  assert.deepEqual(streetFields("Calle 8 de marzo 12 bis, Madrid"), {
    street: "Calle 8 de marzo", housenumber: "12 bis", city: "Madrid", country: "España", filter: "countrycode:es", limit: "5",
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
  // Actualizada (CONFIRMAR_CITAS-006): la dirección escrita en la agenda tiene prioridad sobre la ubicación habitual.
  assert.deepEqual(route, [home, "Calle Prueba 12, piso reservado, 28000, Madrid", "Calle Original 9, Madrid",
    "Calle Original 8, Madrid", "Calle Material 4, Madrid", "", home]);
});

test("Geoapify recibe solo campos estructurados y coordenadas; reserva cada llamada antes de consultar", async () => {
  const events = [];
  const estimates = await calculateJourney(journeyAddresses(prefs, jobs, ignored), {
    apiKey: "fake-test-key", manualFreePilot: true,
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
    apiKey: "fake-test-key", manualFreePilot: true, charge: async () => true,
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
  await assert.rejects(calculateJourney(consecutive, { apiKey: "key", manualFreePilot: true, charge: async () => false, fetcher: failIfCalled }), { status: 429 });
  for (const status of [403, 429, 0]) {
    let requests = 0;
    await assert.rejects(calculateJourney(consecutive, {
      apiKey: "key", manualFreePilot: true, charge: async () => true, fetcher: async () => {
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
    { country_code: "es", result_type: "street", street: "Calle Fira", city: "Municipio A", county: "Provincia A", postcode: "08000", lat: 40, lon: -3, place_id: "private-extra-field" },
    { country_code: "es", result_type: "street", street: "Calle Fira", city: "Municipio A", county: "Provincia B", postcode: "08001" },
    { country_code: "es", result_type: "street", street: "Calle Fira", city: "Municipio B", postcode: "28000" },
    { country_code: "es", result_type: "building", street: "Calle Fira", city: "Municipio B", housenumber: "15" },
    { country_code: "fr", result_type: "street", street: "Calle Fira", city: "Fuera del país" },
  ] });
}

test("autocompletado conserva municipios distintos y evita postales, portales y coordenadas inciertos", async () => {
  let reserved = 0;
  const result = await autocompleteStreets(" Calle  Fira ", {
    apiKey: "fake-test-key", manualFreePilot: true, charge: async amount => { reserved += amount; return true; },
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
    { street: "Calle Fira", municipality: "Municipio A", province: "Provincia A", postalCode: "", displayPostalCode: "08000", label: "Calle Fira · Municipio A · Provincia A · 08000" },
    { street: "Calle Fira", municipality: "Municipio A", province: "Provincia B", postalCode: "", displayPostalCode: "08001", label: "Calle Fira · Municipio A · Provincia B · 08001" },
    { street: "Calle Fira", municipality: "Municipio B", postalCode: "", displayPostalCode: "28000", label: "Calle Fira · Municipio B · 28000" },
  ]);
  const explicit = await autocompleteStreets("Calle Fira 08001", {
    apiKey: "fake-test-key", manualFreePilot: true, charge: async () => true, fetcher: async () => suggestionsResponse(),
  });
  assert.equal(explicit[0].postalCode, "");
  assert.equal(explicit[1].postalCode, "08001");
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

test("se conserva la provincia seleccionada y se omite del parámetro city", async () => {
  const address = "Calle Prueba 12 A, 28000, Madrid (Provincia A)";
  const route = journeyAddresses({ ...prefs, home: { street: "Calle Prueba", number: "12 A", municipality: "Madrid",
    province: "Provincia A", postalCode: "28000" } }, jobs, []);
  assert.equal(route[0], address);
  assert.equal(route.at(-1), address);
  assert.equal(streetFields(address).province, "Provincia A");
  const result = await calculateJourney([address, address, address], {
    apiKey: "fake-test-key", manualFreePilot: true, charge: async () => true,
    fetcher: async url => {
      const p = url.searchParams;
      if (url.pathname.endsWith("/routing")) {
        return Response.json({ features: [{ properties: { distance: 0, time: 0 } }] });
      }
      assert.equal(p.get("city"), "Madrid");
      assert.equal(p.has("province"), false);
      assert.equal(p.has("state"), false);
      return Response.json({ results: [
        location(p, { county: "Provincia B", housenumber: "12A", lat: 42 }),
        location(p, { county: "Provincia A", housenumber: "12A" }),
      ] });
    },
  });
  assert.deepEqual(result.map(leg => leg?.distanceMeters), [0, 0]);
});

test("un inner_part puede confirmar el portal exacto, una calle homónima o varios puntos no", async () => {
  const address = "Calle Mayor 48, 28801, Alcalá de Henares";
  const inner = { result_type: "amenity", rank: { match_type: "inner_part", confidence: 1, confidence_building_level: 1 } };
  const check = async (rows, answered) => {
    let routeCalls = 0;
    const legs = await calculateJourney([address, address, address], {
      apiKey: "fake-test-key", manualFreePilot: true, charge: async () => true,
      fetcher: async url => {
        if (url.pathname.endsWith("/routing")) {
          routeCalls++;
          return Response.json({ features: [{ properties: { distance: 0, time: 0 } }] });
        }
        return Response.json({ results: rows(url.searchParams) });
      },
    });
    assert.equal(routeCalls, answered ? 1 : 0);
    assert.deepEqual(legs.map(leg => leg?.distanceMeters ?? null), answered ? [0, 0] : [null, null]);
  };
  await check(params => [
    location(params, { ...inner, street: "Avenida Mayor", lat: 41 }),
    location(params, { ...inner, housenumber: "49", lat: 42 }),
    location(params, { ...inner, result_type: "street", lat: 43 }),
    location(params, inner),
    location(params, inner),
  ], true);
  await check(params => [location(params, inner), location(params, { ...inner, lat: 41 })], false);
  await check(params => [location(params, { ...inner, rank: { match_type: "inner_part", confidence: 1 } })], false);
  await check(params => [location(params, { ...inner, rank: { ...inner.rank, confidence_building_level: 0.5 } })], false);
});

test("se unifican calles idénticas con CP en conflicto sin perder el CP escrito", async () => {
  const fetcher = async () => Response.json({ results: [
    { country_code: "es", result_type: "street", street: "Calle Mayor", city: "Alcalá de Henares", state: "Comunidad de Madrid", postcode: "28801" },
    { country_code: "es", result_type: "street", street: "Calle Mayor", city: "Alcalá de Henares", county: "Madrid", postcode: "28802" },
  ] });
  const options = { apiKey: "fake-test-key", manualFreePilot: true, charge: async () => true, fetcher };
  const [result] = await autocompleteStreets("Calle Mayor 28801", options);
  assert.equal(result.province, "Madrid");
  assert.equal(result.postalCode, "28801");
  assert.equal(result.displayPostalCode, undefined);
  assert.equal(result.label, "Calle Mayor · Alcalá de Henares · Madrid");
});


test("la etiqueta abreviada de autocomplete coincide con la calle del portal exacto", async () => {
  const address = "Calle Ruiz de Alarcón 23, 28014, Madrid (Madrid)";
  const estimates = await calculateJourney([address, address, address], {
    apiKey: "fake-test-key", manualFreePilot: true, charge: async () => true,
    fetcher: async url => url.pathname.endsWith("/routing")
      ? Response.json({ features: [{ properties: { distance: 25, time: 20 } }] })
      : Response.json({ results: [
        location(url.searchParams, { street: "Calle de Ruiz de Alarcón", state: "Community of Madrid" }),
        location(url.searchParams, { street: "Avenida de Ruiz de Alarcón", state: "Community of Madrid", lat: 42 }),
      ] }),
  });
  assert.deepEqual(estimates.map(x => x?.distanceMeters), [25, 25]);
});
