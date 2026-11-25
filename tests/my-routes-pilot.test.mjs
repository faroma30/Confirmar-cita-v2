// Estados del piloto y botones de Mis rutas (CONFIRMAR_CITAS-006). Datos ficticios, sin red.
import test from "node:test";
import assert from "node:assert/strict";
import { canOfferPilotStop, describePilot, madridClock, madridDayTime, stopConfirmation } from "../my-routes-pilot.mjs";
import { createCloudRoutes } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const now = new Date("2026-11-25T08:30:00Z"); // 09:30 en Madrid
const base = {
  active: true, stopped: false, enabled: true, creditsReserved24h: 0, creditsLimit24h: 50,
  routingRequests24h: 0, routingRequestsLimit24h: 10, externalUsageAtVerification: 19,
  quotaVerifiedAt: "2026-11-25T05:40:00Z", lastError: null, lastErrorAt: null,
};
// El estado real leído en CONFIRMAR_CITAS-005 (solo estados y fechas): parado por Geoapify el 20/11 a las 10:45.
const parado = { ...base, active: false, stopped: true, quotaVerifiedAt: "2026-11-20T05:40:00Z",
  lastError: "provider_limited", lastErrorAt: "2026-11-20T09:45:36Z" };

test("horas en Madrid", () => {
  assert.equal(madridClock(now), "09:30");
  assert.equal(madridDayTime("2026-11-20T09:45:36Z"), "20/11 a las 10:45");
  assert.equal(madridDayTime("2026-07-01T08:00:00Z"), "01/07 a las 10:00");
  assert.equal(madridDayTime(null), "");
  assert.equal(madridClock("no es fecha"), "");
});

test("stopped por rechazo de Geoapify: causa concreta con fecha, sin «Quedan» y sin botón de desactivar", () => {
  const view = describePilot(parado, now);
  assert.equal(view.canCalculate, false);
  assert.equal(view.canStop, false);
  assert.equal(view.cause, "provider_limited");
  assert.equal(view.message, "Piloto parado: Geoapify rechazó la consulta el 20/11 a las 10:45. Avisa al administrador.");
  assert.match(view.lines.join(" "), /Además, la verificación de consumo caducó \(última: 20\/11 a las 06:40\)/);
  assert.match(view.lines.join(" "), /Consumo de las últimas 24 h: 0\/50 créditos, 0\/10 consultas de ruta\./);
  assert.doesNotMatch(view.lines.join(" "), /Quedan/);
});

test("stopped sin error del proveedor y por distancia", () => {
  assert.equal(describePilot({ ...base, active: false, stopped: true }, now).message,
    "Piloto parado: lo desactivó el administrador. Avisa al administrador para reactivarlo.");
  const lejos = describePilot({ ...base, active: false, stopped: true, lastError: "route_estimate_exceeded", lastErrorAt: "2026-11-24T16:05:00Z" }, now);
  assert.equal(lejos.message, "Piloto parado: un tramo superó la distancia reservada el 24/11 a las 17:05. Avisa al administrador.");
});

test("active=false por verificación caducada (sin parar)", () => {
  const view = describePilot({ ...base, active: false, quotaVerifiedAt: "2026-11-23T07:00:00Z" }, now);
  assert.equal(view.cause, "verification_expired");
  assert.equal(view.message, "Verificación de consumo caducada (última: 23/11 a las 08:00). El administrador debe renovarla cada 24 h.");
  assert.equal(view.canStop, true);
  assert.equal(describePilot({ ...base, active: false, quotaVerifiedAt: null }, now).short, "consumo de Geoapify sin verificar");
});

test("enabled=false: no aprobado", () => {
  const view = describePilot({ ...base, enabled: false }, now);
  assert.equal(view.cause, "not_approved");
  assert.match(view.message, /^No aprobado:/);
  assert.equal(view.canStop, false);
});

test("topes de 50 créditos y 10 rutas", () => {
  const creditos = describePilot({ ...base, creditsReserved24h: 50 }, now);
  assert.equal(creditos.cause, "credits_limit");
  assert.match(creditos.message, /^Tope diario alcanzado: 50\/50 créditos/);
  const rutas = describePilot({ ...base, creditsReserved24h: 12, routingRequests24h: 10 }, now);
  assert.equal(rutas.cause, "routes_limit");
  assert.match(rutas.message, /^Tope diario alcanzado: 10\/10 consultas de ruta/);
  assert.doesNotMatch(rutas.lines.join(" "), /Quedan/);
});

test("disponible: quedan créditos y consultas; lastError con fecha", () => {
  const view = describePilot({ ...base, creditsReserved24h: 8, routingRequests24h: 3, lastError: "timeout", lastErrorAt: "2026-11-25T07:12:00Z" }, now);
  assert.equal(view.canCalculate, true);
  assert.equal(view.message, "Piloto disponible.");
  assert.ok(view.lines.includes("Último error: tiempo de espera agotado el 25/11 a las 08:12."));
  assert.match(view.lines.join(" "), /Quedan 42 créditos internos y 7 consultas de ruta/);
  assert.equal(describePilot(null, now), null);
  assert.equal(describePilot("error", now), null);
});

const casa = { street: "Calle Ficticia", number: "1", municipality: "Villaficticia", postalCode: "00001" };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle, postal_code: "00001", population: "Villaficticia", status: "pending" });

function mount(pilot, { confirm = null } = {}) {
  const { panel, get } = fakePanel();
  const calls = { pilot: [], estimate: 0 };
  const provider = {
    manual: true, clear() {},
    pilot: op => { calls.pilot.push(op); return pilot(op); },
    // Con cachedOnly la PWA real no llama al servidor; solo se cuentan las consultas reales.
    async estimateJourney(legs, options) { if (!options.cachedOnly) calls.estimate++; return []; },
  };
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => ({ id: "tecnico-ficticio", role: "technician" }),
    getDate: () => "2026-11-25", now: () => now, confirmAction: confirm, provider,
    preferencesStore: { read: async () => ({ home: casa, keys: null, tourline: null, margin: 10 }), clear() {} },
    loadActivities: async () => ({ appointments: [cita("a", "09:00", "10:00", "Calle Uno 10"), cita("b", "11:00", "12:00", "Calle Dos 20")], ignored: [] }) });
  ui.sync();
  return { get, calls };
}

test("pantalla con el piloto parado: motivo junto a «Calcular», sin «Desactivar» y tramos que dicen por qué", async () => {
  const { get, calls } = mount(async () => parado);
  get("Tab").events.click();
  await settle();
  assert.equal(get("PilotControls").hidden, false);
  assert.equal(get("Calculate").disabled, true);
  assert.equal(get("CalculateReason").hidden, false);
  assert.equal(get("CalculateReason").textContent, "No se puede calcular: piloto parado por un rechazo de Geoapify.");
  assert.equal(get("PilotStop").hidden, true);
  const notice = get("PilotNotice").textContent;
  assert.match(notice, /^Piloto parado: Geoapify rechazó la consulta el 20\/11 a las 10:45\. Avisa al administrador\./);
  assert.match(notice, /Actualizado a las 09:30\.$/);
  assert.doesNotMatch(notice, /Quedan/);
  const list = texts(get("List")).join("\n");
  assert.match(list, /Tiempo y distancia no disponibles: el cálculo está detenido \(piloto parado por un rechazo de Geoapify\)\./);
  assert.match(list, /Hora de salida no disponible: falta el primer tramo: el cálculo está detenido/);
  assert.match(list, /Tiempo libre: 60 min \(1 h\) desde el fin de Instalación · 09:00\./);
  // Pulsar «Calcular» deshabilitado no consulta al servidor.
  await get("Calculate").events.click();
  assert.equal(calls.estimate, 0);
  assert.deepEqual(calls.pilot, ["status"]);
});

test("«Consultar consumo» muestra carga y hora de actualización", async () => {
  let release;
  const { get } = mount(() => new Promise(resolve => { release = resolve; }));
  get("Tab").events.click();
  await settle();
  assert.equal(get("PilotStatus").disabled, true);
  assert.equal(get("PilotStatus").attributes["aria-busy"], "true");
  assert.equal(get("PilotStatus").textContent, "Consultando…");
  assert.equal(get("PilotNotice").textContent, "Consultando el estado del piloto…");
  release({ ...base });
  await settle();
  assert.equal(get("PilotStatus").disabled, false);
  assert.equal(get("PilotStatus").textContent, "Consultar consumo");
  assert.match(get("PilotNotice").textContent, /^Piloto disponible\. Quedan 50 créditos internos/);
  assert.match(get("PilotNotice").textContent, /Actualizado a las 09:30\.$/);
  assert.equal(get("Calculate").disabled, false);
  assert.equal(get("CalculateReason").hidden, true);
  assert.match(texts(get("List")).join("\n"), /Tiempo y distancia no disponibles: aún no se han calculado; pulsa «Calcular desplazamientos»\./);
});

test("técnico (CONFIRMAR_CITAS-007): no ve «Desactivar piloto» aunque el piloto esté activo y pulsarlo no hace nada", async () => {
  const asked = [];
  const { get, calls } = mount(async () => ({ ...base }), { confirm: message => { asked.push(message); return true; } });
  get("Tab").events.click();
  await settle();
  assert.equal(describePilot(base, now).canStop, true, "el piloto está activo: antes del 007 se ofrecía");
  assert.equal(get("PilotStop").hidden, true);
  get("PilotStop").events.click();
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(calls.pilot, ["status"]);
});

test("solo el Administrador puede ver «Desactivar piloto», y solo si tiene efecto", () => {
  const activo = describePilot(base, now);
  assert.equal(canOfferPilotStop({ id: "admin-ficticio", role: "admin" }, activo), true);
  assert.equal(canOfferPilotStop({ id: "admin-ficticio", role: "admin" }, describePilot(parado, now)), false);
  assert.equal(canOfferPilotStop({ id: "tecnico-ficticio", role: "technician" }, activo), false);
  assert.equal(canOfferPilotStop({ id: "master-ficticio", role: "master" }, activo), false);
  assert.equal(canOfferPilotStop(null, activo), false);
  assert.match(stopConfirmation, /para todos los técnicos/);
});

test("el cliente solo envía «stop» con rol Administrador; «status» sigue siendo del técnico", async () => {
  const sent = [];
  let actor = { id: "tecnico-ficticio", role: "technician" };
  const cloud = createCloudRoutes({
    invoke: async (name, { body }) => { sent.push([name, body.operation, body.expectedActor]); return { data: { ...base, stopped: body.operation === "stop" }, error: null }; },
    getActor: () => actor,
  });
  assert.equal(await cloud.pilot("stop"), null);
  assert.equal((await cloud.pilot("status")).stopped, false);
  actor = { id: "master-ficticio", role: "master" };
  assert.equal(await cloud.pilot("stop"), null);
  actor = { id: "admin-ficticio", role: "admin" };
  assert.equal((await cloud.pilot("stop")).stopped, true);
  assert.deepEqual(sent, [["my-routes-estimate", "status", "tecnico-ficticio"], ["my-routes-estimate", "stop", "admin-ficticio"]]);
});

test("si la consulta de estado falla se dice, con la hora", async () => {
  const { get } = mount(async () => null);
  get("Tab").events.click();
  await settle();
  assert.equal(get("PilotNotice").textContent, "No se pudo comprobar el estado del piloto. Vuelve a intentarlo. Actualizado a las 09:30.");
  assert.equal(get("PilotStatus").disabled, false);
});
