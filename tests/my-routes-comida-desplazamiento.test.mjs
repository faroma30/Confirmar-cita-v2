// CONFIRMAR_CITAS-016 (opción A): Comida, Almuerzo, Pausa y Descanso salen «sin desplazamiento» por defecto
// y el cambio manual se respeta (edits). Desde CONFIRMAR_CITAS-031, «Desplazamiento…» sin dirección también.
// Jornadas 100 % ficticias, sin red ni Geoapify.
import test from "node:test";
import assert from "node:assert/strict";
import { buildLegs, combineActivities, formatRouteLocation } from "../my-routes.mjs";
import { combineActivities as serverCombine } from "../supabase/functions/my-routes-estimate/route-agenda.mjs";
import { routeFingerprint } from "../my-routes-cloud.mjs";
import { calculateJourney, journeyAddresses, journeyFingerprint, providerPlan } from "../supabase/functions/my-routes-estimate/core.mjs";
import { parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const casa = { street: "Calle Ficticia", number: "1", municipality: "Villaficticia", postalCode: "00001" };
const prefs = { home: casa, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle, postal_code: "00001", population: "Villaficticia", status: "pending" });
const otra = (tipo, hora, fin, calle = "") => ({ type: tipo, time: hora, end_time: fin, full_address: calle, postal_code: calle ? "00001" : "", population: calle ? "Villaficticia" : "" });
const citas = [cita("a", "09:00", "10:00", "Calle Uno 10"), cita("b", "13:00", "14:00", "Calle Dos 20")];

const pausas = ["Comida", "Comida larga", "COMIDA CON EL EQUIPO", "Almuerzo", "Almuerzo rápido", "Pausa", "Pausa-café",
  "Pausa para comida", "Descanso", "Descanso 15 min", "Comidas", "Descansos del convenio"];
const noPausas = ["Comidilla", "Pausado", "Recomida", "Mantenimiento", "Valoración"];

test("Comida, Almuerzo, Pausa y Descanso (con o sin texto extra) son pausa sin desplazamiento por defecto", () => {
  for (const tipo of pausas) {
    const [activity] = combineActivities([], [otra(tipo, "11:00", "12:00")], prefs);
    assert.equal(activity.defaultTravel, "pause", tipo);
    assert.equal(activity.travel, "pause", tipo);
    assert.equal(activity.address, "", tipo);
  }
  for (const tipo of noPausas) {
    const [activity] = combineActivities([], [otra(tipo, "11:00", "12:00")], prefs);
    assert.equal(activity.defaultTravel, "travel", tipo);
  }
  // Ninguna sale ya como «pendiente de decidir».
  const todas = combineActivities(citas, [...pausas, ...noPausas].map((tipo, i) => otra(tipo, "1" + (i % 10) + ":00", "")), prefs);
  assert.equal(todas.some(a => a.travel === "undecided"), false);
  // Una instalación de Oracle nunca es pausa, aunque su texto empiece igual.
  assert.equal(combineActivities([cita("c", "09:00", "10:00", "Calle Comida 3")], [], prefs)[0].travel, "travel");
});

test("app y servidor deciden igual cada actividad (misma regla en my-routes.mjs y route-agenda.mjs)", () => {
  const otras = [...pausas, ...noPausas].map((tipo, i) => otra(tipo, String(8 + (i % 12)).padStart(2, "0") + ":00", ""));
  otras.push(otra("Desplazamiento a obra", "19:00", "", "Calle Tres 30"));
  const pick = list => list.map(a => [a.key, a.travel, a.defaultTravel, a.address, a.noDestination]);
  assert.deepEqual(pick(serverCombine(citas, otras, prefs)), pick(combineActivities(citas, otras, prefs)));
});

test("el cambio manual del técnico se respeta: una comida marcada «con desplazamiento» vuelve a tener tramo", () => {
  const otras = [otra("Comida larga", "11:00", "12:00")];
  const base = combineActivities(citas, otras, prefs);
  const comida = base.find(a => a.editableTravel);
  assert.equal(buildLegs(formatRouteLocation(casa), base).length, 3);
  const editada = combineActivities(citas, otras, prefs, new Map([[comida.key, { travel: "travel", location: null }]]));
  assert.equal(editada.find(a => a.editableTravel).travel, "travel");
  assert.equal(buildLegs(formatRouteLocation(casa), editada).length, 4);
  // El servidor acepta esa edición (es la que envía la app en `edits`).
  assert.equal(parseActivityEdits([[comida.key, { travel: "travel", location: null }]]).get(comida.key).travel, "travel");
});

async function huellas(otras, entries = []) {
  const legs = buildLegs(formatRouteLocation(casa), combineActivities(citas, otras, prefs, new Map(entries)));
  const pwa = legs.length ? await routeFingerprint(legs) : null;
  const servidor = await journeyFingerprint(journeyAddresses(prefs, citas, otras, parseActivityEdits(entries)));
  return { pwa, servidor };
}

const escenarios = {
  "comida con texto extra": [[otra("Comida con el equipo", "11:00", "12:00")]],
  "almuerzo y descanso el mismo día": [[otra("Almuerzo rápido", "10:15", "10:30"), otra("Descanso 15 min", "12:00", "12:15")]],
  "desplazamiento sin destino": [[otra("Desplazamiento", "11:00", "11:30")]],
  "desplazamiento con dirección en la agenda": [[otra("Desplazamiento a obra", "11:00", "11:30", "Calle Tres 30")]],
};
for (const [nombre, [otras]] of Object.entries(escenarios)) {
  test("paridad de huella (opción A): " + nombre, async () => {
    const { pwa, servidor } = await huellas(otras);
    assert.equal(pwa, servidor, "la PWA y el servidor calculan jornadas distintas (el servidor respondería 409)");
  });
}

test("paridad de huella (opción A) con edits: comida cambiada a «con desplazamiento» y desplazamiento marcado como pausa", async () => {
  const otras = [otra("Comida larga", "11:00", "12:00"), otra("Desplazamiento", "12:10", "12:30")];
  const base = combineActivities(citas, otras, prefs);
  const [comida, desplazamiento] = base.filter(a => a.editableTravel);
  for (const entries of [
    [[comida.key, { travel: "travel", location: null }]],
    [[desplazamiento.key, { travel: "pause", location: null }]],
    [[comida.key, { travel: "travel", location: null }], [desplazamiento.key, { travel: "pause", location: null }]],
  ]) {
    const { pwa, servidor } = await huellas(otras, entries);
    assert.equal(pwa, servidor, JSON.stringify(entries));
  }
});

test("«Desplazamiento» sin destino: solo si el técnico pide desplazamiento queda pendiente, sin gastar créditos", async () => {
  const otras = [otra("Desplazamiento", "10:15", "10:45")];
  const excluded = combineActivities(citas, otras, prefs).find(a => a.editableTravel);
  assert.equal(excluded.travel, "pause");
  assert.equal(excluded.noDestination, false);
  const asked = new Map([[excluded.key, { travel: "travel", location: null }]]);
  const activities = combineActivities(citas, otras, prefs, asked);
  const desplazamiento = activities.find(a => a.editableTravel);
  assert.equal(desplazamiento.travel, "travel");
  assert.equal(desplazamiento.address, "");
  assert.equal(desplazamiento.noDestination, true);
  // Con dirección en la agenda o escrita a mano ya no es «sin destino».
  assert.equal(combineActivities([], [otra("Desplazamiento", "10:15", "", "Calle Tres 30")], prefs)[0].noDestination, false);
  const manual = { street: "Calle Escrita", number: "7", municipality: "Villaficticia", postalCode: "00001" };
  assert.equal(combineActivities([], otras, prefs, new Map([[desplazamiento.key, { travel: "travel", location: manual }]]))[0].noDestination, false);
  assert.equal(combineActivities([], otras, prefs, new Map([[desplazamiento.key, { travel: "pause", location: null }]]))[0].noDestination, false);

  // Servidor: las direcciones de la jornada llevan el hueco vacío y Geoapify no se llama para esos tramos.
  const addresses = journeyAddresses(prefs, citas, otras, parseActivityEdits([...asked]));
  assert.equal(addresses.length, 5);
  assert.equal(addresses[2], "");
  const plan = providerPlan(addresses, false);
  let fetches = 0;
  let charges = 0;
  const reasons = [...plan.reasons];
  const estimates = await calculateJourney(plan.addresses, {
    apiKey: "clave-ficticia", manualFreePilot: true, reasons,
    charge: async () => { charges++; return true; },
    fetcher: async () => { fetches++; return Response.json({ results: [] }); },
  });
  assert.deepEqual(estimates, [null, null, null, null]);
  assert.equal(fetches, 0, "ninguna llamada a Geoapify");
  assert.equal(charges, 0, "ningún crédito gastado");
  assert.deepEqual(reasons.slice(1, 3), ["incomplete", "incomplete"]);
});

test("la tarjeta de «Desplazamiento» sin destino sale como pausa: «Sin desplazamiento» y sin aviso", async () => {
  const otras = [otra("Desplazamiento", "10:15", "10:45"), otra("Comida", "11:00", "12:00")];
  const { panel, get } = fakePanel();
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => ({ id: "tecnico-ficticio", role: "technician" }),
    getDate: () => "2026-11-25", provider: null, preferencesStore: { read: async () => prefs, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: otras }) });
  ui.sync();
  get("Tab").events.click();
  await settle();
  const list = texts(get("List")).join("\n");
  assert.doesNotMatch(list, /sin destino|Falta el destino|Tramo pendiente/);
  assert.doesNotMatch(list, /Pendiente de decidir/);
  assert.match(list, /Sin desplazamiento/);
  const card = get("List").children.find(node => node.tag === "article" && node.children[0].textContent === "10:15 · Desplazamiento");
  assert.ok(card.children.some(node => node.textContent === "Sin desplazamiento"));
  assert.ok(card.children.some(node => node.tag === "details" && node.className === "subpanel"), "el técnico puede cambiarlo");
});
