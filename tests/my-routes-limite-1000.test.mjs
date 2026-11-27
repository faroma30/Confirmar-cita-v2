// CONFIRMAR_CITAS-025: topes del piloto 1.000 créditos y 200 consultas de ruta por 24 h, con tope de seguridad de
// 2.500. Datos ficticios, sin red ni Supabase: la migración se comprueba como texto (NO se ejecuta SQL) y la base
// se imita en memoria con los topes y el rango leídos de la propia migración.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ensurePilotRenewed, renewalFields } from "../supabase/functions/my-routes-estimate/pilot-renewal.mjs";
import { describePilot } from "../my-routes-pilot.mjs";

const read = async path => (await readFile(new URL("../supabase/" + path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const sql = await read("migrations/20261127090000_route_pilot_limits_1000.sql");
const [, CREDITS, ROUTES] = sql.match(/values \(true, (\d+), (\d+)\);/).map(Number);
const [, MIN, CAP] = sql.match(/route_pilot_limits_safety_cap check \(credits_24h between (\d+) and (\d+)\)/).map(Number);

/** Cuerpo (entre $function$) de la definición de una función en un archivo SQL. */
function body(source, name) {
  const start = source.search(new RegExp("create or replace function public\\." + name + "\\(", "i"));
  assert.ok(start >= 0, name);
  return source.slice(start).split("$function$")[1];
}

const H = 3600_000;
const T0 = Date.parse("2026-11-27T07:00:00Z");

function fakePilotDb() {
  const db = { clock: T0, stopped: false, external: 21, verified: T0, reservations: [], caps: { credits: CREDITS, routing: ROUTES } };
  const usage = () => {
    const live = db.reservations.filter(r => r.at > db.clock - 24 * H);
    return { credits: live.reduce((sum, r) => sum + r.credits, 0), routing: live.filter(r => r.routing).length };
  };
  const fresh = () => db.verified > db.clock - 24 * H;
  /** Restricciones de la tabla route_pilot_limits: false = la base rechaza el cambio. */
  db.configureCaps = (credits, routing) => {
    if (!Number.isInteger(credits) || credits < MIN || credits > CAP || routing < 1 || routing > credits) return false;
    db.caps = { credits, routing };
    return true;
  };
  const rpcs = {
    cc_route_pilot_status() {
      const u = usage();
      return { active: !db.stopped && fresh(), stopped: db.stopped, creditsReserved24h: u.credits, creditsLimit24h: db.caps.credits,
        routingRequests24h: u.routing, routingRequestsLimit24h: db.caps.routing, externalUsageAtVerification: db.external,
        quotaVerifiedAt: new Date(db.verified).toISOString(), lastError: null, lastErrorAt: null };
    },
    cc_route_pilot_configure({ p_external_usage: value, p_stop: stop }) {
      db.stopped = stop;
      if (value !== null) { db.external = value; db.verified = db.clock; }
      return true;
    },
    cc_route_pilot_begin({ p_operation: operation }) {
      const u = usage();
      return !(db.stopped || !fresh() || u.credits >= db.caps.credits
        || (operation === "route" && u.routing >= db.caps.routing) || db.external + u.credits >= 3000);
    },
    cc_route_pilot_charge({ p_credits: credits, p_is_routing: routing }) {
      const u = usage();
      if (db.stopped || !fresh() || u.credits + credits > db.caps.credits || (routing && u.routing >= db.caps.routing)
        || db.external + u.credits + credits > 3000) return false;
      db.reservations.push({ at: db.clock, credits, routing });
      return true;
    },
  };
  db.backend = { async rpc(name, args = {}) { return { data: rpcs[name](args), error: null }; } };
  db.status = async () => (await db.backend.rpc("cc_route_pilot_status")).data;
  db.begin = async (operation = "route") => (await db.backend.rpc("cc_route_pilot_begin", { p_operation: operation })).data;
  db.charge = async (credits, routing = false) =>
    (await db.backend.rpc("cc_route_pilot_charge", { p_credits: credits, p_is_routing: routing })).data;
  return db;
}

const view = async db => {
  const status = await db.status();
  return describePilot({ ...status, enabled: true, ...renewalFields(status) }, new Date(db.clock));
};

test("la migración fija 1.000 créditos y 200 consultas, con tope de seguridad 2.500 y la tabla cerrada", () => {
  assert.deepEqual([CREDITS, ROUTES, MIN, CAP], [1000, 200, 1, 2500]);
  assert.match(sql.split("\n").slice(0, 3).join("\n"), /PENDIENTE DE APLICAR \(CONFIRMAR_CITAS-025\)/);
  assert.match(sql, /routing_24h between 1 and credits_24h/);
  assert.match(sql, /singleton boolean primary key default true check \(singleton\)/);
  assert.match(sql, /alter table confirmar_citas\.route_pilot_limits enable row level security;/);
  assert.match(sql, /revoke all on confirmar_citas\.route_pilot_limits from public, anon, authenticated, service_role;/);
  assert.doesNotMatch(sql, /grant [^;]*on confirmar_citas\.route_pilot_limits/i);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.ok(sql.indexOf("do $guard$") < sql.indexOf("create table"), "la guarda va antes de cualquier cambio");
  for (const name of ["cc_route_pilot_begin\\(uuid, uuid, text\\)", "cc_route_pilot_charge\\(uuid, uuid, integer, boolean\\)", "cc_route_pilot_status\\(\\)"]) {
    assert.match(sql, new RegExp("revoke all on function public\\." + name + " from public, anon, authenticated;"));
    assert.match(sql, new RegExp("grant execute on function public\\." + name + " to service_role;"));
  }
  const defined = [...sql.matchAll(/create or replace function public\.(\w+)\(/gi)].map(m => m[1]);
  assert.deepEqual(defined, ["cc_route_pilot_begin", "cc_route_pilot_charge", "cc_route_pilot_status"],
    "configure, report, end y el presupuesto compartido no se redefinen");
});

test("las tres funciones solo cambian en los topes frente a las ya aplicadas (24 h, paradas y consumo externo iguales)", async () => {
  const ref = await read("migrations/20261120050000_route_pilot_applied_reference.sql");
  const lease = await read("migrations/20261125090000_route_pilot_release_lease.sql");
  const undo = name => body(sql, name)
    .replace("  caps confirmar_citas.route_pilot_limits%rowtype;\n", "")
    .replace("  select * into strict caps from confirmar_citas.route_pilot_limits where singleton is true;\n", "")
    .replace("  cross join confirmar_citas.route_pilot_limits caps\n  where p.singleton is true and caps.singleton is true;",
      "  where p.singleton is true;")
    .replace(/caps\.credits_24h/g, "50").replace(/caps\.routing_24h/g, "10");
  assert.equal(undo("cc_route_pilot_begin"), body(lease, "cc_route_pilot_begin"));
  assert.equal(undo("cc_route_pilot_charge"), body(ref, "cc_route_pilot_charge"));
  assert.equal(undo("cc_route_pilot_status"), body(ref, "cc_route_pilot_status"));
  for (const name of ["cc_route_pilot_begin", "cc_route_pilot_charge", "cc_route_pilot_status"]) {
    assert.doesNotMatch(body(sql, name), /\b(50|10)\b/, name + ": sin topes escritos a mano");
  }
});

test("criterio 1: hasta 200 consultas de ruta en 24 h; la 201.ª se rechaza con el mensaje de siempre", async () => {
  const db = fakePilotDb();
  for (let i = 0; i < 200; i++) {
    assert.equal(await db.begin(), true, `consulta ${i + 1}`);
    assert.equal(await db.charge(2, true), true, `consulta ${i + 1}`);
    db.clock += 60_000;
  }
  assert.equal(await db.charge(1, true), false, "la 201.ª no se cobra");
  assert.equal(await db.begin("route"), false);
  assert.equal(await db.begin("autocomplete"), true, "lo que no es ruta sigue dentro de los créditos");
  const v = await view(db);
  assert.equal(v.cause, "routes_limit");
  assert.equal(v.message, "Tope diario alcanzado: 200/200 consultas de ruta en las últimas 24 h. Vuelve a intentarlo más tarde.");
  db.clock = T0 + 24 * H + 1000; // sale de la ventana la primera consulta
  assert.equal((await ensurePilotRenewed(db.backend, { now: () => db.clock })).renewed, true);
  assert.equal(await db.begin(), true, "ventana móvil y renovación diaria iguales");
});

test("criterio 1: hasta 1.000 créditos en 24 h; no se pasa y el motivo es el de siempre", async () => {
  const db = fakePilotDb();
  for (let i = 0; i < 499; i++) assert.equal(await db.charge(2), true);
  assert.equal(await db.charge(1), true);
  assert.equal(await db.charge(2), false, "999 + 2 pasaría del tope");
  assert.equal(await db.charge(1), true);
  assert.equal((await db.status()).creditsReserved24h, 1000);
  assert.equal(await db.charge(1), false);
  assert.equal(await db.begin("route"), false);
  assert.equal(await db.begin("autocomplete"), false);
  const v = await view(db);
  assert.equal(v.canCalculate, false);
  assert.equal(v.cause, "credits_limit");
  assert.equal(v.message, "Tope diario alcanzado: 1000/1000 créditos en las últimas 24 h. Vuelve a intentarlo más tarde.");
});

test("criterio 1: el tope de seguridad de 2.500 créditos no se puede superar", () => {
  const db = fakePilotDb();
  for (const credits of [2501, 3000, 100000, 0, -1, 2500.5]) assert.equal(db.configureCaps(credits, 200), false, String(credits));
  assert.equal(db.configureCaps(200, 201), false, "más consultas que créditos");
  assert.deepEqual(db.caps, { credits: 1000, routing: 200 });
  assert.equal(db.configureCaps(2500, 200), true, "2.500 es el máximo admitido");
  // Nada en la migración quita ni amplía la restricción.
  assert.doesNotMatch(sql, /drop constraint|alter constraint|disable trigger/i);
  assert.equal(sql.split("insert into confirmar_citas.route_pilot_limits").length, 2);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /update confirmar_citas\.route_pilot_limits/);
});

test("criterio 2: «Consultar consumo» muestra los límites nuevos (del servidor y por defecto)", async () => {
  const db = fakePilotDb();
  await db.charge(2, true);
  const v = await view(db);
  assert.equal(v.message, "Piloto disponible.");
  assert.ok(v.lines.includes("Quedan 998 créditos internos y 199 consultas de ruta (últimas 24 h: 2/1000 créditos, 1/200 consultas)."));
  assert.match(v.lines.join(" "), /Se renueva solo cada 24 h mientras esté activado, con el mismo límite/);
  const sinTopes = describePilot({ enabled: true, active: true, stopped: false, creditsReserved24h: 0, routingRequests24h: 0,
    quotaVerifiedAt: new Date(T0).toISOString() }, new Date(T0));
  assert.match(sinTopes.lines.join(" "), /Quedan 1000 créditos internos y 200 consultas de ruta/);
});

test("antes de aplicar la migración, la app muestra los límites que dé el servidor (50 y 10)", () => {
  const v = describePilot({ enabled: true, active: true, stopped: false, creditsReserved24h: 6, creditsLimit24h: 50,
    routingRequests24h: 1, routingRequestsLimit24h: 10, quotaVerifiedAt: new Date(T0).toISOString() }, new Date(T0));
  assert.match(v.lines.join(" "), /últimas 24 h: 6\/50 créditos, 1\/10 consultas/);
});

test("la prueba SQL aislada está sin ejecutar y termina en rollback", async () => {
  const isolated = await read("tests/isolated/route-pilot-limits-isolated.sql");
  assert.match(isolated, /ESCRITA Y NO EJECUTADA/);
  assert.match(isolated, /^begin;$/m);
  assert.match(isolated, /^rollback;$/m);
});
