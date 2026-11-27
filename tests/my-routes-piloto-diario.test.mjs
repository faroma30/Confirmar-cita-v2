// CONFIRMAR_CITAS-024: renovación automática diaria del piloto de Mis rutas. Datos ficticios, sin red ni Supabase.
// La base se imita en memoria con la lógica de las RPC reales (20261120050000 y 20261125090000):
// caducidad de 24 h en begin/charge/status, topes 50 créditos / 10 consultas en ventana móvil de 24 h,
// configure(consumo, stop) y report (provider_limited y route_estimate_exceeded paran el piloto).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PILOT_WINDOW_MS, RENEW_MAX_STALE_MS, STOP_RECHECK_MS, confirmPilotStopped, ensurePilotRenewed, nextRenewalAt, renewalFields, shouldRenew,
} from "../supabase/functions/my-routes-estimate/pilot-renewal.mjs";
import { pilotStopRejection } from "../supabase/functions/my-routes-estimate/pilot-control.mjs";
import { describePilot } from "../my-routes-pilot.mjs";

const H = 3600_000;
const T0 = Date.parse("2026-11-26T05:47:00Z"); // activado por el Administrador (06:47 en Madrid)
const TECNICO = "00000000-0000-4000-8000-00000000000a";

function fakePilotDb(start = T0) {
  const db = { clock: start, stopped: false, external: 21, verified: start, lastError: null, lastErrorAt: null,
    actor: null, lease: null, operation: null, reservations: [], calls: [] };
  const usage = at => {
    const live = db.reservations.filter(r => r.at > at - PILOT_WINDOW_MS);
    return { credits: live.reduce((sum, r) => sum + r.credits, 0), routing: live.filter(r => r.routing).length };
  };
  const fresh = at => db.verified !== null && db.verified > at - PILOT_WINDOW_MS;
  const rpcs = {
    cc_route_pilot_status() {
      const u = usage(db.clock);
      return { active: !db.stopped && fresh(db.clock), stopped: db.stopped, creditsReserved24h: u.credits, creditsLimit24h: 50,
        routingRequests24h: u.routing, routingRequestsLimit24h: 10, externalUsageAtVerification: db.external,
        quotaVerifiedAt: db.verified === null ? null : new Date(db.verified).toISOString(), lastError: db.lastError,
        lastErrorAt: db.lastErrorAt };
    },
    cc_route_pilot_configure({ p_external_usage: usage, p_stop: stop }) {
      if (stop === null || stop === undefined || (usage !== null && (usage < 0 || usage > 3000))
        || (!stop && (usage === null || usage > 2950))) return false;
      db.stopped = stop;
      if (usage !== null) { db.external = usage; db.verified = db.clock; }
      return true;
    },
    cc_route_pilot_begin({ p_actor: actor, p_lease: lease, p_operation: operation }) {
      if (db.stopped || !fresh(db.clock) || (db.actor && db.actor !== actor)) return false;
      db.reservations = db.reservations.filter(r => r.at > db.clock - PILOT_WINDOW_MS);
      const u = usage(db.clock);
      if (u.credits >= 50 || (operation === "route" && u.routing >= 10) || db.external + u.credits >= 3000) return false;
      Object.assign(db, { actor, lease, operation });
      return true;
    },
    cc_route_pilot_charge({ p_actor: actor, p_lease: lease, p_credits: credits, p_is_routing: routing }) {
      if (db.stopped || !fresh(db.clock) || db.actor !== actor || db.lease !== lease) return false;
      const u = usage(db.clock);
      if (u.credits + credits > 50 || (routing && u.routing >= 10)) return false;
      db.reservations.push({ at: db.clock, credits, routing });
      return true;
    },
    cc_route_pilot_report({ p_error: error }) {
      db.lastError = error; db.lastErrorAt = new Date(db.clock).toISOString();
      db.stopped = db.stopped || ["provider_limited", "route_estimate_exceeded"].includes(error);
      return true;
    },
    cc_route_pilot_end() { db.actor = db.lease = db.operation = null; return true; },
  };
  db.backend = { async rpc(name, args = {}) {
    db.calls.push({ name, args });
    return { data: rpcs[name](args), error: null };
  } };
  db.now = () => db.clock;
  return db;
}

// Una consulta de ruta como la de index.ts: renovación diaria, begin, cobros (1 de ruta + extras) y fin.
async function calcular(db, { credits = 2 } = {}) {
  await ensurePilotRenewed(db.backend, { now: db.now });
  const lease = `lease-${db.calls.length}`;
  const begin = await db.backend.rpc("cc_route_pilot_begin", { p_actor: TECNICO, p_lease: lease, p_operation: "route" });
  if (begin.data !== true) return "429";
  let charged = 0;
  for (let i = 0; i < credits; i++) {
    const r = await db.backend.rpc("cc_route_pilot_charge", { p_actor: TECNICO, p_lease: lease, p_credits: 1, p_is_routing: i === 0 });
    if (r.data === true) charged++;
  }
  await db.backend.rpc("cc_route_pilot_end", { p_actor: TECNICO, p_lease: lease });
  return charged;
}

const configureCalls = db => db.calls.filter(c => c.name === "cc_route_pilot_configure");

test("criterio 1: activado → pasadas las 24 h sigue disponible y el contador de 24 h empieza de cero", async () => {
  const db = fakePilotDb();
  db.clock = T0 + 2 * H;
  assert.equal(await calcular(db, { credits: 6 }), 6);
  assert.equal((await db.backend.rpc("cc_route_pilot_status")).data.creditsReserved24h, 6);
  db.clock = T0 + 24 * H + 60_000; // 27/11 06:48 en Madrid: antes caducaba aquí
  assert.equal((await db.backend.rpc("cc_route_pilot_status")).data.active, false, "la base sigue caducando a las 24 h");
  const { status, renewed } = await ensurePilotRenewed(db.backend, { now: db.now });
  assert.equal(renewed, true);
  assert.equal(status.active, true);
  assert.equal(status.stopped, false);
  assert.equal(status.externalUsageAtVerification, 21, "el consumo externo declarado no cambia");
  assert.equal(status.quotaVerifiedAt, new Date(db.clock).toISOString());
  db.clock = T0 + 26 * H + 60_000; // pasadas 24 h desde los 6 créditos de ayer
  assert.equal((await db.backend.rpc("cc_route_pilot_status")).data.creditsReserved24h, 0, "contador de cero");
  assert.equal(await calcular(db, { credits: 2 }), 2);
  assert.deepEqual(configureCalls(db).map(c => c.args), [{ p_external_usage: 21, p_stop: false }], "una sola renovación");
  // Varios días seguidos: se renueva cada vez que pasan 24 h, sin que nadie haga nada.
  for (let dia = 2; dia <= 4; dia++) {
    db.clock = T0 + dia * 24 * H + 5 * 60_000;
    assert.equal(await calcular(db, { credits: 1 }), 1, `día ${dia}`);
  }
  assert.equal(configureCalls(db).length, 4);
});

test("mientras no han pasado las 24 h no se escribe nada (solo lecturas)", async () => {
  const db = fakePilotDb();
  db.clock = T0 + 23 * H;
  assert.equal((await ensurePilotRenewed(db.backend, { now: db.now })).renewed, false);
  assert.equal(configureCalls(db).length, 0);
});

test("criterio 1: desactivado por el Administrador → no se renueva nunca", async () => {
  const db = fakePilotDb();
  db.clock = T0 + 3 * H;
  await db.backend.rpc("cc_route_pilot_configure", { p_external_usage: null, p_stop: true });
  for (const horas of [25, 49, 24 * 7]) {
    db.clock = T0 + horas * H;
    assert.equal(await calcular(db), "429");
    const { status, renewed } = await ensurePilotRenewed(db.backend, { now: db.now });
    assert.equal(renewed, false);
    assert.equal(status.stopped, true);
  }
  assert.equal(configureCalls(db).length, 1, "solo la parada del Administrador");
});

test("criterio 1: parado por 401/403 (provider_limited) o distancia excedida → no se renueva", async () => {
  for (const error of ["provider_limited", "route_estimate_exceeded"]) {
    const db = fakePilotDb();
    db.clock = T0 + 5 * H;
    await db.backend.rpc("cc_route_pilot_report", { p_actor: TECNICO, p_lease: "x", p_error: error });
    db.clock = T0 + 30 * H;
    assert.equal(await calcular(db), "429", error);
    assert.equal((await ensurePilotRenewed(db.backend, { now: db.now })).renewed, false, error);
    assert.equal(configureCalls(db).length, 0, error);
    assert.equal(describePilot({ ...db.backend && (await db.backend.rpc("cc_route_pilot_status")).data, enabled: true, autoRenew: true }).cause, error);
  }
});

test("un error que no para (cuota, tiempo agotado) no impide la renovación, como hoy no impide calcular", async () => {
  const db = fakePilotDb();
  db.clock = T0 + 5 * H;
  await db.backend.rpc("cc_route_pilot_report", { p_actor: TECNICO, p_lease: "x", p_error: "quota" });
  db.clock = T0 + 25 * H;
  assert.equal((await ensurePilotRenewed(db.backend, { now: db.now })).renewed, true);
});

test("criterio 1: límites iguales que hoy tras la renovación (50 créditos y 10 consultas por 24 h)", async () => {
  const db = fakePilotDb();
  db.clock = T0 + 24 * H + 1000;
  let rutas = 0;
  while (await calcular(db, { credits: 1 }) === 1) { rutas++; db.clock += 1000; }
  assert.equal(rutas, 10, "10 consultas de ruta");
  const status = (await db.backend.rpc("cc_route_pilot_status")).data;
  assert.equal(status.creditsLimit24h, 50);
  assert.equal(status.routingRequestsLimit24h, 10);
  // Créditos: con consultas de 6 créditos se llega a 50 y no se pasa.
  const db2 = fakePilotDb();
  db2.clock = T0 + 24 * H + 1000;
  let total = 0;
  for (let i = 0; i < 12; i++) { const r = await calcular(db2, { credits: 6 }); if (r !== "429") total += r; db2.clock += 1000; }
  assert.equal(total, 50);
  // La renovación de un día con 50 créditos gastados no regala otros 50: la ventana es móvil.
  db2.clock = T0 + 48 * H + 5000; // se renueva otra vez, pero parte de los cobros siguen en las últimas 24 h
  const enVentana = (await db2.backend.rpc("cc_route_pilot_status")).data.creditsReserved24h;
  assert.ok(enVentana > 0 && enVentana < 50, `quedan ${enVentana} en la ventana`);
  const nuevos = await calcular(db2, { credits: 50 });
  assert.equal(configureCalls(db2).length, 2, "renovado de nuevo");
  assert.equal(enVentana + nuevos, 50, "nunca más de 50 créditos en 24 h");
});

test("nunca renueva sin verificación previa, con consumo externo fuera de rango o con el cálculo no aprobado", async () => {
  const caducado = { active: false, stopped: false, quotaVerifiedAt: new Date(T0).toISOString(), externalUsageAtVerification: 21 };
  const now = T0 + 25 * H;
  assert.equal(shouldRenew(caducado, now), true);
  assert.equal(shouldRenew({ ...caducado, quotaVerifiedAt: null }, now), false);
  assert.equal(shouldRenew({ ...caducado, externalUsageAtVerification: 2951 }, now), false);
  assert.equal(shouldRenew({ ...caducado, externalUsageAtVerification: null }, now), false);
  assert.equal(shouldRenew({ ...caducado, stopped: true }, now), false);
  assert.equal(shouldRenew({ ...caducado, stopped: undefined }, now), false, "si no se sabe, no");
  assert.equal(shouldRenew({ ...caducado, active: true }, now), false);
  assert.equal(shouldRenew(null, now), false);
  const db = fakePilotDb();
  db.clock = T0 + 25 * H;
  assert.equal((await ensurePilotRenewed(db.backend, { now: db.now, enabled: false })).renewed, false);
  assert.equal(configureCalls(db).length, 0);
});

test("lectura demasiado antigua (> 1 s) o fallo de la base: no se renueva y no se rompe nada", async () => {
  const db = fakePilotDb();
  db.clock = T0 + 25 * H;
  let tick = 0;
  const lento = () => db.clock + (tick++ === 0 ? 0 : RENEW_MAX_STALE_MS + 1);
  assert.equal((await ensurePilotRenewed(db.backend, { now: lento })).renewed, false);
  assert.equal(configureCalls(db).length, 0);
  const roto = { async rpc() { return { data: null, error: { code: "PGRST" } }; } };
  assert.deepEqual(await ensurePilotRenewed(roto, { now: db.now }), { status: null, renewed: false });
});

test("«Desactivar» del Administrador gana a una renovación que leyó el estado justo antes", async () => {
  const db = fakePilotDb();
  db.clock = T0 + 25 * H;
  // Renovación: lee el estado (caducado, activado)...
  const statusAntes = (await db.backend.rpc("cc_route_pilot_status")).data;
  assert.equal(shouldRenew(statusAntes, db.clock), true);
  // ...el Administrador desactiva...
  await db.backend.rpc("cc_route_pilot_configure", { p_external_usage: null, p_stop: true });
  // ...y la escritura de la renovación llega después (la peor carrera posible).
  await db.backend.rpc("cc_route_pilot_configure", { p_external_usage: 21, p_stop: false });
  assert.equal(db.stopped, false);
  let esperado = 0;
  assert.equal(await confirmPilotStopped(db.backend, { wait: async ms => { esperado = ms; } }), true);
  assert.equal(esperado, STOP_RECHECK_MS);
  assert.ok(STOP_RECHECK_MS > RENEW_MAX_STALE_MS * 2);
  assert.equal(db.stopped, true, "queda desactivado");
  // Sin carrera, la comprobación no escribe nada más.
  const n = configureCalls(db).length;
  assert.equal(await confirmPilotStopped(db.backend, { wait: async () => {} }), true);
  assert.equal(configureCalls(db).length, n);
});

test("criterio 1: un técnico o un Master no pueden desactivar ni reconfigurar el piloto", async () => {
  const perfil = role => ({ role, status: "active", must_change_password: false, activation_verified_at: "2026-10-01T08:00:00Z", sessions_invalid_before: null });
  const rpc = data => async () => ({ data, error: null });
  for (const role of ["technician", "master"]) {
    assert.equal((await pilotStopRejection(rpc(perfil(role)), { iat: 2_000_000_000 })).status, 403, role);
  }
  const source = await readFile(new URL("../supabase/functions/my-routes-estimate/index.ts", import.meta.url), "utf8");
  // La entrada solo admite las operaciones de siempre: ninguna nueva para reactivar o cambiar el consumo.
  assert.match(source, /const control = input\.operation === "status" \|\| input\.operation === "stop";/);
  assert.match(source, /const allowedKeys = control \? \["operation", "expectedActor"\]/);
  assert.doesNotMatch(source, /externalUsage|reactivate|renew"/);
  // La renovación solo usa el consumo guardado y siempre con p_stop: false; nunca toca topes.
  const module = (await readFile(new URL("../supabase/functions/my-routes-estimate/pilot-renewal.mjs", import.meta.url), "utf8"))
    .split(/\r?\n/).filter(line => !/^\s*(\/\/|\/\*\*)/.test(line)).join("\n");
  assert.equal(module.split("p_external_usage: status.externalUsageAtVerification, p_stop: false").length, 2);
  assert.doesNotMatch(module, /creditsLimit|routingRequestsLimit|\b50\b.*=|cc_route_pilot_begin/);
});

test("index.ts: renueva antes de reservar y en «status»; «stop» comprueba que queda parado", async () => {
  const source = await readFile(new URL("../supabase/functions/my-routes-estimate/index.ts", import.meta.url), "utf8");
  const stop = source.slice(source.indexOf('if (input.operation === "stop") {'), source.indexOf("const access = routeAccess"));
  assert.ok(stop.indexOf("pilotStopRejection") < stop.indexOf("cc_route_pilot_configure"));
  assert.ok(stop.indexOf("cc_route_pilot_configure") < stop.indexOf("confirmPilotStopped(backend)"));
  assert.doesNotMatch(stop, /ensurePilotRenewed/, "parar nunca renueva");
  const control = source.slice(source.indexOf("if (control) {"), source.indexOf("let addresses"));
  assert.match(control, /ensurePilotRenewed\(backend, \{ enabled \}\)/);
  assert.match(control, /\.\.\.renewalFields\(status\)/);
  const renew = source.indexOf("await ensurePilotRenewed(backend, { enabled }); } catch");
  assert.ok(renew > 0 && renew < source.indexOf('backend.rpc("cc_route_pilot_begin"'), "renovación antes de cc_route_pilot_begin");
  // 401/403/429 sin cambios: el informe de errores y la liberación siguen igual.
  assert.match(source, /failure = detail\?\.kind === "estimate_exceeded" \? "route_estimate_exceeded"\n\s+: providerLimited \? "provider_limited"/);
});

test("criterio 2: «Consultar consumo» muestra la próxima renovación y deja de decir que caduca", () => {
  const now = new Date(T0 + 2 * H);
  const estado = { enabled: true, active: true, stopped: false, creditsReserved24h: 6, creditsLimit24h: 50, routingRequests24h: 1,
    routingRequestsLimit24h: 10, externalUsageAtVerification: 21, quotaVerifiedAt: new Date(T0).toISOString(), lastError: null };
  const view = describePilot({ ...estado, ...renewalFields(estado) }, now);
  assert.equal(view.canCalculate, true);
  assert.equal(view.message, "Piloto disponible.");
  assert.ok(view.lines.includes("Se renueva solo cada 24 h mientras esté activado, con el mismo límite (próxima renovación: 27/11 a las 06:47)."));
  assert.match(view.lines.join(" "), /Quedan 44 créditos internos y 9 consultas de ruta/);
  assert.doesNotMatch([view.message, ...view.lines].join(" "), /caduc|debe renovarla/);
  assert.equal(nextRenewalAt(estado), new Date(T0 + PILOT_WINDOW_MS).toISOString());
  // Parado: ni renovación ni «caducó».
  const parado = { ...estado, active: false, stopped: true, quotaVerifiedAt: new Date(T0 - 30 * H).toISOString() };
  const p = describePilot({ ...parado, ...renewalFields(parado) }, now);
  assert.equal(p.cause, "stopped");
  assert.equal(nextRenewalAt(parado), null);
  assert.doesNotMatch([p.message, ...p.lines].join(" "), /caduc|Se renueva solo/);
  // No se pudo renovar (p. ej., consumo externo > 2950): se dice el motivo, sin hablar de caducidad.
  const sinRenovar = { ...estado, active: false, quotaVerifiedAt: new Date(T0 - 25 * H).toISOString(), externalUsageAtVerification: 2990 };
  const s = describePilot({ ...sinRenovar, ...renewalFields(sinRenovar) }, now);
  assert.equal(s.canCalculate, false);
  assert.match(s.message, /^El piloto no se ha podido renovar solo \(última renovación: 25\/11 a las 05:47\)\. Avisa al administrador\.$/);
  // Cuota agotada: el motivo de siempre.
  const tope = describePilot({ ...estado, creditsReserved24h: 50, ...renewalFields(estado) }, now);
  assert.equal(tope.cause, "credits_limit");
});

test("compatibilidad: con un servidor anterior (sin autoRenew) los mensajes son los de 3routes19", () => {
  const now = new Date(T0 + 25 * H);
  const viejo = { enabled: true, active: false, stopped: false, creditsReserved24h: 0, creditsLimit24h: 50, routingRequests24h: 0,
    routingRequestsLimit24h: 10, quotaVerifiedAt: new Date(T0).toISOString(), lastError: null };
  assert.equal(describePilot(viejo, now).message, "Verificación de consumo caducada (última: 26/11 a las 06:47). El administrador debe renovarla cada 24 h.");
  const activo = describePilot({ ...viejo, active: true }, new Date(T0 + H));
  assert.doesNotMatch(activo.lines.join(" "), /Se renueva solo/);
});
