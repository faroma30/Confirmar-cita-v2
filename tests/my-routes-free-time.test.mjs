// Tiempo entre actividades (CONFIRMAR_CITAS-006). Jornadas ficticias, sin red ni Geoapify.
import test from "node:test";
import assert from "node:assert/strict";
import { buildLegs, combineActivities, dayFreeTime, formatMinutes, formatRouteLocation, freeTimeBetween, legSlack } from "../my-routes.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const casa = { street: "Calle Ficticia", number: "1", municipality: "Villaficticia", postalCode: "00001" };
const prefs = { home: casa, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle, postal_code: "00001", population: "Villaficticia", status: "pending" });
const otra = (tipo, hora, fin, calle = "") => ({ type: tipo, time: hora, end_time: fin, full_address: calle, postal_code: calle ? "00001" : "", population: calle ? "Villaficticia" : "" });
const citas = [cita("a", "09:00", "10:00", "Calle Uno 10"), cita("b", "13:00", "14:00", "Calle Cuatro 40")];
const otras = [otra("Mantenimiento", "10:30", "11:15", "Calle Dos 20"), otra("Pausa comida larga", "11:15", "12:00"),
  otra("Valoración", "12:10", undefined, "Calle Tres 30")];

test("tiempo libre entre actividades según la agenda", () => {
  const activities = combineActivities(citas, otras, prefs);
  assert.deepEqual(activities.map(a => a.time), ["09:00", "10:30", "11:15", "12:10", "13:00"]);
  const gaps = activities.slice(1).map((activity, i) => freeTimeBetween(activities[i], activity));
  assert.deepEqual(gaps.map(g => g.minutes), [30, 0, 10, null]);
  assert.equal(gaps[3].reason, "no_end");
  assert.deepEqual(freeTimeBetween({ endTime: "10:00" }, { time: "" }), { minutes: null, reason: "no_start" });
  assert.equal(freeTimeBetween({ endTime: "10:20" }, { time: "10:00" }).minutes, -20);
  assert.deepEqual(dayFreeTime(activities), { minutes: 40, counted: 3, pairs: 4 });
  assert.equal(formatMinutes(45), "45 min");
  assert.equal(formatMinutes(135), "135 min (2 h 15 min)");
  assert.equal(formatMinutes(120), "120 min (2 h)");
});

test("sobra o falta tiempo descontando el desplazamiento; los tramos de casa no cuentan", () => {
  const activities = combineActivities(citas, otras, prefs);
  const legs = buildLegs(formatRouteLocation(casa), activities);
  const veinte = { durationSeconds: 1200 };
  assert.equal(legSlack(legs[0], veinte), null);
  assert.equal(legSlack(legs.at(-1), veinte), null);
  assert.deepEqual(legSlack(legs[1], veinte), { minutes: 10, late: false, reason: null, signed: 10 });
  assert.deepEqual(legSlack(legs[1], { durationSeconds: 2100 }), { minutes: 5, late: true, reason: null, signed: -5 });
  assert.equal(legSlack(legs[1], null), null);
  // CONFIRMAR_CITAS-016 (opción A): «Pausa comida larga» es pausa por defecto, así que no hay tramo hacia ella.
  assert.equal(legs.length, 5);
  assert.equal(legSlack(legs[3], veinte).reason, "no_end");
  // Una pausa intermedia alarga el fin del tramo (respeta la misma regla que el aviso de retraso).
  const conPausa = buildLegs(formatRouteLocation(casa), combineActivities(citas, [otras[0], otra("Pausa", "11:15", "12:00"), otras[2]], prefs));
  assert.equal(conPausa[2].from.endTime, "12:00");
  assert.deepEqual(legSlack(conPausa[2], veinte), { minutes: 10, late: true, reason: null, signed: -10 });
});

function estimateAll(legs) {
  return legs.map(leg => leg.from.address && leg.to.address
    ? { durationSeconds: 1200, distanceMeters: 5000, calculatedAt: "2026-11-25T08:00:00Z" } : null);
}

function mount({ provider = null } = {}) {
  const { panel, get } = fakePanel();
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => ({ id: "tecnico-ficticio", role: "technician" }),
    getDate: () => "2026-11-25", provider, preferencesStore: { read: async () => prefs, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: otras }) });
  ui.sync();
  return get;
}

test("sin Geoapify (proveedor desactivado) se ve el tiempo libre y los totales", async () => {
  const get = mount();
  get("Tab").events.click();
  await settle();
  const list = texts(get("List")).join("\n");
  assert.match(list, /Tiempo libre: 30 min desde el fin de Instalación · 09:00\./);
  assert.match(list, /Tiempo libre: 0 min desde el fin de Mantenimiento · 10:30\./);
  assert.match(list, /Tiempo libre: 10 min desde el fin de Pausa comida larga · 11:15\./);
  assert.match(list, /Sin hora de fin: no se puede calcular el tiempo libre \(falta el fin de Valoración · 12:10\)\./);
  assert.match(list, /Tiempo libre total: 40 min \(3 de 4 huecos; al resto le faltan horas\)\./);
  assert.doesNotMatch(list, /Te sobran|Llegarías/);
});

test("con estimación: «Te sobran» y «Llegarías tarde», y respeta las ediciones de la sesión", async () => {
  const get = mount({ provider: { manual: false, clear() {}, async estimateJourney(legs) { return estimateAll(legs); } } });
  get("Tab").events.click();
  await settle();
  let list = texts(get("List")).join("\n");
  // CONFIRMAR_CITAS-016 (opción A): «Pausa comida larga» sale por defecto como pausa sin desplazamiento,
  // así que el tramo va de Mantenimiento a Valoración.
  assert.match(list, /Pausa sin desplazamiento/);
  assert.doesNotMatch(list, /Pendiente de decidir/);
  assert.match(list, /Posible retraso: el trayecto supera el tiempo entre actividades\./);
  assert.match(list, /Llegarías 10 min tarde \(tiempo libre menos desplazamiento\)\./);
  assert.match(list, /Te sobran 10 min/);
  assert.match(list, /Tiempo libre total: 40 min/);
  // El técnico la cambia a «Sí, con desplazamiento» (edición de la sesión) y se respeta.
  const card = get("List").children.find(node => node.tag === "article" && node.children[0].textContent === "Pausa comida larga · 11:15");
  const form = card.children.find(node => node.tag === "details").children.find(node => node.tag === "form");
  const select = form.children[0].children[0];
  assert.equal(select.value, "pause");
  select.value = "travel";
  form.events.submit({ preventDefault() {} });
  await settle();
  list = texts(get("List")).join("\n");
  assert.doesNotMatch(list, /Pausa sin desplazamiento/);
  assert.match(list, /Con desplazamiento · Falta dirección/);
  assert.match(list, /Te sobran 10 min \(tiempo libre menos desplazamiento\)\./);
  assert.match(list, /Sin hora de fin: no se puede calcular si llegas a tiempo\./);
  assert.match(list, /Tiempo libre tras los desplazamientos entre actividades: 10 min \(1 tramos\)\./);
  // CONFIRMAR_CITAS-017: el total parcial dice cuántos tramos suma («Conducción total (N de M tramos)»).
  assert.match(list, /Conducción total \(\d+ de \d+ tramos\): /);
});
