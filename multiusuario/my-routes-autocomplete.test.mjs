import test from "node:test";
import assert from "node:assert/strict";
import { bindRouteAutocomplete } from "./my-routes-autocomplete.mjs";
import { createCloudRouteAutocomplete, createCloudRoutes } from "./my-routes-cloud.mjs";

function element() {
  return {
    children: [], events: {}, value: "", hidden: false,
    setAttribute() {},
    addEventListener(type, handler) { this.events[type] = handler; },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children.length = 0; },
    focus() { this.focused = true; },
  };
}
function picker(search, isAllowed = () => true) {
  const fields = Object.fromEntries(["street", "municipality", "province", "postalCode", "number"].map(key => [key, element()]));
  const label = element();
  label.after = node => label.append(node);
  fields.street.closest = () => label;
  fields.street.id = "street-field";
  const clear = bindRouteAutocomplete({
    fields, eligible: isAllowed, document: { createElement: element }, cancelOthers() {}, search,
  });
  const [box] = label.children;
  const [status, choices] = box.children;
  function input(text) {
    fields.street.value = text;
    fields.street.events.input();
  }
  return { fields, status, choices, input, clear };
}
const suggestion = (municipality, postalCode = "") => ({ street: "Calle Mayor", municipality, postalCode });
const calleMayor = [suggestion("Madrid"), suggestion("Alcalá de Henares")];
const tick = async t => { t.mock.timers.tick(450); await Promise.resolve(); };

test("debounce, calle homónima, selección y portal manual", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const ui = picker(async (query, signal) => {
    calls++;
    assert.equal(query, "Calle Mayor");
    assert.equal(signal.aborted, false);
    return calleMayor;
  });
  ui.input("Cal");
  await tick(t);
  assert.equal(calls, 0);
  ui.input("Calle");
  ui.input("Calle   Mayor");
  ui.input("Calle Mayor");
  await tick(t);
  assert.equal(calls, 1);
  assert.deepEqual(ui.choices.children.map(c => c.textContent),
    ["Calle Mayor · Madrid", "Calle Mayor · Alcalá de Henares"]);
  ui.fields.number.value = "12 bis";
  ui.fields.postalCode.value = "28013";
  ui.choices.children[1].events.click();
  assert.equal(ui.fields.street.value, "Calle Mayor");
  assert.equal(ui.fields.municipality.value, "Alcalá de Henares");
  assert.equal(ui.fields.postalCode.value, "");
  assert.equal(ui.fields.number.value, "12 bis");
  assert.equal(ui.fields.number.focused, true);
});

test("cancela peticiones obsoletas y mantiene disponibles los campos manuales tras un error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [];
  let allowed = true;
  const ui = picker((query, signal) => new Promise((resolve, reject) => requests.push({ query, signal, resolve, reject })), () => allowed);
  ui.input("Calle Mayor");
  await tick(t);
  ui.input("Calle Nueva");
  assert.equal(requests[0].signal.aborted, true);
  await tick(t);
  requests[0].resolve(calleMayor);
  await Promise.resolve();
  assert.equal(ui.choices.children.length, 0);
  requests[1].reject(new Error("detalle privado simulado"));
  await Promise.resolve();
  assert.match(ui.status.textContent, /manualmente/);
  assert.doesNotMatch(ui.status.textContent, /privado/);
  ui.clear();
  assert.equal(requests[1].signal.aborted, true);
  allowed = false;
  ui.input("Calle Mayor");
  await tick(t);
  assert.equal(requests.length, 2);
  assert.equal(ui.fields.street.value, "Calle Mayor");
});

test("usa solo la Edge Function, descarta datos no válidos y propaga la cancelación", async () => {
  let actor = { id: "fixture-a", role: "technician" };
  const signal = new AbortController();
  const requests = [];
  let reply = { suggestions: [suggestion("Madrid", "28013"), suggestion("Ficticia", "00000x")] };
  const lookup = createCloudRouteAutocomplete({
    getActor: () => actor,
    async invoke(name, opts) { requests.push({ name, opts }); return { data: reply }; },
  });
  assert.deepEqual(await lookup("Calle Mayor", signal.signal), [suggestion("Madrid", "28013")]);
  assert.deepEqual(requests[0], {
    name: "my-routes-estimate",
    opts: { body: { operation: "autocomplete", query: "Calle Mayor", expectedActor: "fixture-a" }, signal: signal.signal },
  });
  reply = null;
  await assert.rejects(lookup("Calle Mayor", signal.signal), /No se pudieron cargar/);
  actor = { id: "fixture-a", role: "master" };
  assert.deepEqual(await lookup("Calle Mayor", signal.signal), []);
  actor = { id: "fixture-a", role: "technician" };
  signal.abort();
  assert.deepEqual(await lookup("Calle Mayor", signal.signal), []);
  assert.equal(requests.length, 2);
});

test("envía solo la huella de ruta, deduplica peticiones en curso y conserva posiciones sin tramo", async () => {
  let invoked = 0, release;
  const actor = { id: "fixture-a", role: "technician" };
  const client = createCloudRoutes({ getActor: () => actor, invoke(name, { body }) {
    invoked++;
    assert.equal(name, "my-routes-estimate");
    assert.deepEqual(Object.keys(body).sort(), ["date", "expectedActor", "fingerprint"]);
    assert.match(body.fingerprint, /^[0-9a-f]{64}$/);
    return new Promise(resolve => { release = resolve; });
  } });
  const stops = [{ address: "Casa ficticia" }, { address: "Actividad ficticia" }, { address: "" }, { address: "Casa ficticia" }];
  const legs = stops.slice(1).map((to, i) => ({ from: stops[i], to }));
  const date = { date: "2026-11-18" };
  const requests = [client.estimateJourney(legs, date), client.estimateJourney(legs, date)];
  while (!release) await new Promise(setImmediate);
  const estimates = [{ durationSeconds: 300, distanceMeters: 400, calculatedAt: "2026-11-18T09:00:00Z" }, null, null];
  release({ data: { estimates } });
  assert.deepEqual(await Promise.all(requests), [estimates, estimates]);
  assert.equal(invoked, 1);
});


test("muestra provincia y CP de referencia, conserva la provincia y no asigna ese CP al portal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ui = picker(async () => [
    { ...suggestion("Madrid"), province: "Madrid", displayPostalCode: "28013" },
    { ...suggestion("Alcalá de Henares"), province: "Madrid", displayPostalCode: "28801" },
  ]);
  ui.input("Calle Mayor");
  await tick(t);
  assert.match(ui.choices.children[1].textContent, /Alcalá de Henares · Madrid · 28801/);
  ui.fields.number.value = "48";
  ui.choices.children[1].events.click();
  assert.equal(ui.fields.province.value, "Madrid");
  assert.equal(ui.fields.postalCode.value, "");
  assert.equal(ui.fields.number.value, "48");
  ui.fields.municipality.value = "Otro municipio";
  ui.fields.municipality.events.input();
  assert.equal(ui.fields.province.value, "");
});
