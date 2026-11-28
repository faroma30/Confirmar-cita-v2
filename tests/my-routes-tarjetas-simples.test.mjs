// CONFIRMAR_CITAS-026: tarjetas simples de Mis rutas (actividad, dirección y desplazamiento) y mensajes claros
// cuando hay que esperar. Datos inventados, sin red, sin Supabase y sin Geoapify. La migración se comprueba
// como texto (NO se ejecuta SQL).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { shortAddress } from "../my-routes.mjs";
import { createCloudRoutes } from "../my-routes-cloud.mjs";
import { countdownClock, describeRouteBlock, formatWait, routeBlockMessages, unknownBlockMessage } from "../my-routes-pilot.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { BLOCK_CODES, blockCause, chargeRefusal, remainingWait } from "../supabase/functions/my-routes-estimate/block-cause.mjs";
import * as core from "../supabase/functions/my-routes-estimate/core.mjs";
import * as policy from "../supabase/functions/my-routes-estimate/policy.mjs";
import * as control from "../supabase/functions/my-routes-estimate/pilot-control.mjs";
import * as renewal from "../supabase/functions/my-routes-estimate/pilot-renewal.mjs";
import * as cause from "../supabase/functions/my-routes-estimate/block-cause.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const read = async path => (await readFile(new URL("../" + path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

// ---------- Jornada inventada ----------
const casa = { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: "17599" };
const prefs = { home: casa, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle,
  postal_code: "17599", population: "Vilafictícia", status: "pending" });
const citas = [cita("a", "09:00", "10:00", "Calle Uno 10"), cita("b", "11:00", "12:00", "Calle Inventada 99"),
  cita("c", "13:00", "14:00", "Calle Tres 3"), cita("d", "15:00", "16:00", "Calle Cuatro 4"), cita("e", "17:00", "18:00", "")];
const comida = [{ type: "Comida", time: "14:00", end_time: "14:45" }];
const tramo = (min, km) => ({ durationSeconds: min * 60, distanceMeters: km * 1000, calculatedAt: "2026-11-25T08:00:00Z" });

const visible = node => {
  const out = [];
  const walk = item => {
    if (typeof item === "string") { out.push(item); return; }
    if (item.tag === "details") { out.push("[" + item.children[0].textContent + "]"); return; }
    if (item.textContent) out.push(item.textContent);
    for (const child of item.children ?? []) walk(child);
  };
  for (const child of node.children) walk(child);
  return out;
};
const all = (node, out = []) => { for (const child of node.children ?? []) { out.push(child); all(child, out); } return out; };
const cards = get => get("List").children.filter(node => node.tag === "article");

// 6 tramos: casa→a, a→b, b→c, c→d, d→e (sin dirección), e→casa. Calculados: casa→a y c→d.
async function mountSix() {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const provider = { manual: false, clear() {}, async estimateJourney(legs) {
    const estimates = legs.map((_, index) => index === 0 ? tramo(14, 14.5) : index === 3 ? tramo(8, 5.25) : null);
    Object.defineProperty(estimates, "details", { value: legs.map((_, i) => i === 1 ? "street_not_found" : i === 2 ? "other_end" : null) });
    Object.defineProperty(estimates, "diagnostics", { value: legs.map((_, i) => i === 1 || i === 2 ? "no_results" : null) });
    Object.defineProperty(estimates, "sources", { value: legs.concat(0).map(() => "cartociudad") });
    Object.defineProperty(estimates, "officials", { value: legs.concat(0).map((_, i) => i === 1 ? "Calle Uno" : null) });
    Object.defineProperty(estimates, "suggestions", { value: legs.concat(0).map((_, i) => i === 2
      ? [{ street: "Calle Inventada Nueva", number: "99", municipality: "Vilafictícia", postalCode: "17599" }] : null) });
    return estimates;
  } };
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: comida }) });
  ui.sync();
  get("Tab").events.click();
  await settle(10);
  return get;
}

test("dirección en una línea: sin código postal, país ni pueblo repetido", () => {
  assert.equal(shortAddress("Calle Uno 10, 17599, VILAFICTICIA"), "Calle Uno 10, VILAFICTICIA");
  assert.equal(shortAddress("Calle Uno 10, 17599, Vilafictícia, 17599, VILAFICTICIA, España"), "Calle Uno 10, Vilafictícia");
  assert.equal(shortAddress("Calle Uno 10, 17599 Vilafictícia"), "Calle Uno 10, Vilafictícia");
  assert.equal(shortAddress("Calle Uno 1, 17599, Vilafictícia (Girona)"), "Calle Uno 1, Vilafictícia (Girona)");
  assert.equal(shortAddress(""), "");
});

test("cada tarjeta: hora y actividad, dirección y desplazamiento, en ese orden; sin tiempo libre ni códigos", async () => {
  const get = await mountSix();
  const [summary, a, b, c, comidaCard, d, e, back] = cards(get).map(visible);
  assert.deepEqual(summary, ["Sal de casa a las 08:36", "Conducción total: 22 min · 19,8 km", "2 de 6 desplazamientos calculados", "[Más detalles]"]);
  assert.deepEqual(a, ["09:00 · Instalación", "Calle Uno 10, Vilafictícia", "🚗 14 min · 14,5 km desde casa", "Abrir en Google Maps", "[Más detalles]"]);
  assert.deepEqual(b.slice(0, 3), ["11:00 · Instalación", "Calle Inventada 99, Vilafictícia", "No encuentro la calle"]);
  assert.deepEqual(c.slice(0, 3), ["13:00 · Instalación", "Calle Tres 3, Vilafictícia", "No encuentro la otra dirección"]);
  assert.deepEqual(comidaCard.slice(0, 2), ["14:00 · Comida", "Sin desplazamiento"]);
  assert.deepEqual(d.slice(0, 3), ["15:00 · Instalación", "Calle Cuatro 4, Vilafictícia", "🚗 8 min · 5,3 km desde la cita anterior"]);
  assert.deepEqual(e.slice(0, 3), ["17:00 · Instalación", "Sin dirección", "Falta la dirección"]);
  assert.deepEqual(back.slice(0, 2), ["Regreso a casa", "Falta la dirección de la otra actividad"]);
  const shown = visible(get("List")).join("\n");
  assert.doesNotMatch(shown, /Tiempo libre|Te sobran|Te faltan|Faltan \d|Llegarías|Con desplazamiento|Tiempo y distancia|detalle:|origen:|calle oficial|→|Motivo|no_results|street_not_found/);
});

test("lo técnico y el tiempo libre siguen en «Más detalles», cerrado por defecto; nada se borra", async () => {
  const get = await mountSix();
  const more = all(get("List")).filter(node => node.tag === "details" && node.className === "route-more");
  assert.equal(more.length, 8);
  assert.ok(more.every(node => !node.open && node.children[0].textContent === "Más detalles"));
  const hidden = more.flatMap(node => texts(node)).join("\n");
  for (const wanted of [/detalle: no_results/, /origen: cartociudad → cartociudad/, /calle oficial: Calle Uno/,
    /Casa → Instalación · 09:00/, /Tiempo libre: 60 min \(1 h\) desde el fin de Instalación · 09:00\./,
    /Tiempo libre total: /, /Llegada estimada: 08:50/, /Estimación sin tráfico/, /Dirección completa: Calle Uno 10, 17599, Vilafictícia/,
    /Motivo: No se encuentra esta calle en ese municipio\./]) assert.match(hidden, wanted);
});

test("«¿Querías decir…?» y «Editar» siguen a la vista y funcionan; la atribución sale una vez al final", async () => {
  const get = await mountSix();
  const shown = visible(get("List")).join("\n");
  assert.equal(shown.match(/¿Querías decir…\?/g).length, 1);
  assert.match(shown, /Calle Inventada Nueva/);
  assert.match(shown, /\[Editar\]/);
  const last = get("List").children.at(-1);
  assert.equal(last.textContent, "Datos de rutas: ");
  assert.equal(shown.match(/Datos de rutas:/g).length, 1);
  const button = all(get("List")).find(node => node.tag === "button" && node.textContent === "Calle Inventada Nueva");
  button.events.click();
  await settle(10);
  assert.match(visible(get("List")).join("\n"), /Calle Inventada Nueva 99, Vilaficticia|Calle Inventada Nueva 99, Vilafictícia/);
  const html = await read("index.html");
  assert.equal(html.match(/CartoCiudad © IGN-CNIG/g).length, 1);
  assert.equal(html.match(/Al abrir un tramo, sus direcciones se comparten con Google Maps\./g).length, 1);
  assert.ok(html.indexOf('id="myRoutesList"') < html.indexOf('id="myRoutesAttribution"'));
});

test("el campo de fecha no puede ensanchar la tarjeta en pantallas estrechas", async () => {
  const css = await read("agenda.css");
  assert.match(css, /#myRoutesDate\{display:block;width:100%;min-width:0;max-width:100%;-webkit-appearance:none;appearance:none\}/);
  assert.match(css, /#myRoutesDate::-webkit-date-and-time-value\{min-width:0;text-align:left\}/);
  assert.match(css, /@media\(max-width:680px\)\{#myRoutesView \.agenda-controls\{grid-template-columns:minmax\(0,1fr\)\}\}/);
  assert.match(css, /#myRoutesView \.agenda-controls>\*\{min-width:0\}/);
});

// ---------- Mensajes de espera y de límite ----------
test("formato de la espera", () => {
  assert.equal(formatWait(80), "1 min 20 s");
  assert.equal(formatWait(120), "2 min");
  assert.equal(formatWait(40), "40 s");
  assert.equal(countdownClock(80), "1:20");
  assert.equal(countdownClock(5), "0:05");
});

test("cada causa de 429 tiene su mensaje; sin código (v16), uno genérico; nunca «cuota del piloto»", () => {
  assert.deepEqual(Object.keys(routeBlockMessages).sort(), [...BLOCK_CODES].sort());
  const messages = BLOCK_CODES.map(code => describeRouteBlock({ code }).message);
  assert.equal(new Set(messages).size, BLOCK_CODES.length);
  assert.equal(describeRouteBlock({ code: "wait", retryAfterSeconds: 80 }).message, "Espera 1 min 20 s y vuelve a pulsar.");
  for (const body of [undefined, { error: "Cuota temporal alcanzada." }, { code: "raro", retryAfterSeconds: 80 }]) {
    assert.deepEqual(describeRouteBlock(body), { code: null, retryAfterSeconds: null, message: unknownBlockMessage });
  }
  for (const bad of [0, -3, 1.5, "80", 100000]) assert.equal(describeRouteBlock({ code: "wait", retryAfterSeconds: bad }).retryAfterSeconds, null);
  for (const message of [...messages, unknownBlockMessage]) assert.doesNotMatch(message, /cuota del piloto/i);
});

const suggestion = { street: "Calle Inventada Nueva", number: "99", municipality: "Vilafictícia", postalCode: "17599" };
const blocked = body => ({ data: null, error: { context: { status: 429, clone: () => ({ json: async () => body }) } } });
const partial = extra => body => {
  const length = 3;
  return { data: { estimates: [tramo(14, 14.5), null, null].slice(0, length), details: [null, "street_not_found", "other_end"],
    suggestions: [null, null, [suggestion], null], ...extra }, error: null };
};

function mountWaiting(replies) {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const bodies = [];
  const clock = { now: Date.parse("2026-11-27T08:00:00Z"), task: null };
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    bodies.push(body);
    return replies[Math.min(bodies.length, replies.length) - 1](body);
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    now: () => new Date(clock.now), timers: { set: task => { clock.task = task; return 1; }, clear: () => { clock.task = null; } },
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas.slice(0, 2), ignored: [] }) });
  ui.sync();
  const advance = async seconds => {
    for (let i = 0; i < seconds; i++) { clock.now += 1000; const task = clock.task; clock.task = null; task?.(); }
    await settle(20);
  };
  const open = async () => { get("Tab").events.click(); await settle(); await get("Calculate").events.click(); await settle(20); };
  const choose = async () => {
    all(get("List")).find(node => node.tag === "button" && node.textContent === suggestion.street).events.click();
    await settle(20);
  };
  return { get, bodies, clock, advance, open, choose, ui };
}

test("429 por espera: mensaje con los segundos, botón con cuenta atrás que se reactiva y tarjetas a la vista", async () => {
  const app = mountWaiting([() => blocked({ code: "wait", retryAfterSeconds: 80 })]);
  await app.open();
  assert.equal(app.get("CalculationNotice").textContent, "Espera 1 min 20 s y vuelve a pulsar.");
  assert.equal(app.get("Calculate").disabled, true);
  assert.equal(app.get("Calculate").textContent, "Espera 1:20");
  assert.equal(cards(app.get).length, 4, "resumen, dos actividades y regreso");
  await app.advance(1);
  assert.equal(app.get("Calculate").textContent, "Espera 1:19");
  await app.get("Calculate").events.click();
  assert.equal(app.bodies.length, 1, "durante la espera no se llama a la función");
  await app.advance(79);
  assert.equal(app.get("Calculate").disabled, false);
  assert.equal(app.get("Calculate").textContent, "Calcular desplazamientos");
  assert.equal(app.get("CalculationNotice").textContent, "");
  assert.equal(app.bodies.length, 1, "pulsar el botón no programa un recálculo");
});

test("elegir una calle durante la espera: no se llama, la corrección queda aplicada y se recalcula al terminar", async () => {
  const app = mountWaiting([partial({ retryAfterSeconds: 80 }), partial({})]);
  await app.open();
  assert.equal(app.get("Calculate").textContent, "Espera 1:20", "tras calcular, la espera se ve en el botón");
  await app.advance(20);
  await app.choose();
  assert.equal(app.bodies.length, 1);
  assert.match(app.get("CalculationNotice").textContent, /^Espera 1 min y vuelve a pulsar\. La corrección queda aplicada/);
  assert.match(visible(app.get("List")).join("\n"), /Calle Inventada Nueva 99/);
  await app.advance(60);
  assert.equal(app.bodies.length, 2, "se recalcula solo");
  assert.deepEqual(app.bodies[1].edits[0][1].location.street, "Calle Inventada Nueva");
});

test("si el servidor responde «espera» al elegir la calle, la elección no se pierde y se reintenta una vez", async () => {
  const app = mountWaiting([partial({}), () => blocked({ code: "wait", retryAfterSeconds: 30 }), partial({})]);
  await app.open();
  assert.equal(app.get("Calculate").disabled, false, "función sin retryAfterSeconds: sin cuenta atrás");
  await app.choose();
  assert.equal(app.bodies.length, 2);
  assert.match(app.get("CalculationNotice").textContent, /^Espera 30 s y vuelve a pulsar\. La corrección queda aplicada/);
  assert.match(visible(app.get("List")).join("\n"), /Calle Inventada Nueva 99/);
  await app.advance(30);
  assert.equal(app.bodies.length, 3);
  assert.deepEqual(app.bodies[2].edits, app.bodies[1].edits);
});

test("si cambia la fecha durante la espera no se recalcula solo; el botón queda listo", async () => {
  const app = mountWaiting([partial({ retryAfterSeconds: 30 }), partial({})]);
  await app.open();
  await app.choose();
  app.get("Date").value = "2026-11-26";
  app.get("Date").events.change();
  await settle();
  await app.advance(30);
  assert.equal(app.bodies.length, 1);
  assert.equal(app.get("Calculate").disabled, false);
});

test("web nueva con la función v16: 429 sin código muestra el texto genérico, sin cuenta atrás", async () => {
  const app = mountWaiting([() => blocked({ error: "Cuota temporal alcanzada." })]);
  await app.open();
  assert.equal(app.get("CalculationNotice").textContent, unknownBlockMessage);
  assert.equal(app.get("Calculate").disabled, false);
  assert.equal(app.get("Calculate").textContent, "Calcular desplazamientos");
});

test("otro tipo de límite: su mensaje, sin cuenta atrás", async () => {
  const app = mountWaiting([() => blocked({ code: "credits_limit" })]);
  await app.open();
  assert.equal(app.get("CalculationNotice").textContent, routeBlockMessages.credits_limit);
  assert.equal(app.get("Calculate").disabled, false);
});

// ---------- Función ----------
const activo = { stopped: false, active: true, creditsReserved24h: 30, creditsLimit24h: 1000, routingRequests24h: 5,
  routingRequestsLimit24h: 200, externalUsageAtVerification: 21, lastError: null };
const libre = { waitSeconds: 0, busy: false, paused: false, sharedLimit: false };
const db = ({ status = activo, budget = libre, calls = [] } = {}) => ({ calls, rpc: async name => {
  calls.push(name);
  if (name === "cc_route_pilot_status") return status ? { data: status, error: null } : { data: null, error: true };
  if (name === "cc_route_budget_wait") return budget ? { data: budget, error: null } : { data: null, error: { code: "PGRST202" } };
  return { data: null, error: true };
} });
const who = { actor: "00000000-0000-4000-8000-00000000000a", operation: "route" };

test("función: un código por causa; solo la espera lleva segundos; nada más sale en la respuesta", async () => {
  const cases = [
    [{ status: { ...activo, stopped: true } }, { code: "pilot_stopped" }],
    [{ status: { ...activo, stopped: true, lastError: "provider_limited" } }, { code: "provider_limited" }],
    [{ status: { ...activo, stopped: true, lastError: "route_estimate_exceeded" } }, { code: "route_too_long" }],
    [{ status: { ...activo, active: false } }, { code: "pilot_unverified" }],
    [{ status: { ...activo, creditsReserved24h: 1000 } }, { code: "credits_limit" }],
    [{ status: { ...activo, routingRequests24h: 200 } }, { code: "routes_limit" }],
    [{ status: { ...activo, externalUsageAtVerification: 2970 } }, { code: "external_limit" }],
    [{ budget: { ...libre, sharedLimit: true, waitSeconds: 80 } }, { code: "shared_limit" }],
    [{ budget: { ...libre, waitSeconds: 80, busy: true } }, { code: "wait", retryAfterSeconds: 80 }],
    [{ budget: { ...libre, paused: true } }, { code: "provider_limited" }],
    [{ budget: { ...libre, busy: true } }, { code: "busy" }],
    [{}, {}],
  ];
  for (const [state, expected] of cases) assert.deepEqual(await blockCause(db(state), who), expected, JSON.stringify(state));
});

test("función sin la migración: las causas del estado siguen saliendo y la espera queda sin código", async () => {
  assert.deepEqual(await blockCause(db({ budget: null }), who), {});
  assert.deepEqual(await blockCause(db({ budget: null, status: { ...activo, creditsReserved24h: 1000 } }), who), { code: "credits_limit" });
  assert.equal(await remainingWait(db({ budget: null }), who.actor), null);
  assert.deepEqual(await blockCause({ rpc: async () => { throw new Error("sin red"); } }, who), {});
});

test("función: rechazo durante el cálculo (Geoapify o margen propio) y lectura sin escrituras", async () => {
  const calls = [];
  assert.deepEqual(await chargeRefusal(db({ calls }), { ...who, providerLimited: true }), { code: "provider_limited" });
  assert.deepEqual(calls, []);
  assert.deepEqual(await chargeRefusal(db({ calls, budget: { ...libre, waitSeconds: 100 } }), { ...who, providerLimited: false }),
    { code: "budget_refused", retryAfterSeconds: 100 });
  assert.deepEqual(await chargeRefusal(db({ status: { ...activo, creditsReserved24h: 1000 } }), { ...who, providerLimited: false }), { code: "credits_limit" });
  assert.deepEqual([...new Set(calls)], ["cc_route_pilot_status", "cc_route_budget_wait"]);
});

// La función completa (index.ts) con la autenticación, la base y los proveedores imitados.
async function handler({ booking = true, budget = libre, status = activo, calculate }) {
  const source = (await read("supabase/functions/my-routes-estimate/index.ts")).replace(/^import .*$/gm, "");
  let serve;
  const actor = "00000000-0000-4000-8000-00000000000a";
  const backend = { rpc: async name => {
    if (name === "cc_route_pilot_begin") return { data: booking, error: null };
    if (name === "cc_route_pilot_status") return { data: status, error: null };
    if (name === "cc_route_budget_wait") return budget ? { data: budget, error: null } : { data: null, error: true };
    return { data: true, error: null };
  } };
  const client = { rpc: async name => ({ data: name === "cc_my_route_locations_v2" ? prefs : [], error: null }) };
  client.rpc = async name => ({ error: null, data: name === "cc_my_route_locations_v2" ? prefs : name === "cc_my_appointments" ? citas.slice(0, 2) : [] });
  const env = { MY_ROUTES_GEOAPIFY_KEY: "clave-ficticia", MY_ROUTES_GEOAPIFY_APPROVED: "yes", MY_ROUTES_GEOAPIFY_MANUAL_FREE_PILOT: "yes",
    MY_ROUTES_GEOAPIFY_ACCESS: JSON.stringify({ [actor]: "home-and-activities" }), MY_ROUTES_CARTOCIUDAD: "no" };
  const scope = {
    Deno: { env: { get: name => env[name] }, serve: fn => { serve = fn; } },
    jsonResponse: (_, body, code = 200) => ({ body, status: code }), preflightOrReject: () => null,
    currentUser: async () => ({ user: { id: actor }, client, claims: {} }), serviceClient: () => backend,
    ...core, ...policy, ...control, ...renewal, ...cause,
    ...(calculate ? { calculateJourney: calculate } : {}),
  };
  new Function(...Object.keys(scope), stripTypeScriptTypes(source))(...Object.values(scope));
  const fingerprint = await core.journeyFingerprint(core.journeyAddresses(prefs, citas.slice(0, 2), [], new Map()));
  return serve({ text: async () => JSON.stringify({ date: "2026-11-25", fingerprint, expectedActor: actor }), signal: new AbortController().signal });
}

test("index.ts: 429 con causa y segundos; éxito con la espera; sin la migración, como antes", async () => {
  const ok = async () => [null, null, null];
  const waiting = await handler({ booking: false, budget: { ...libre, waitSeconds: 75 } });
  assert.deepEqual(waiting, { status: 429, body: { error: "Cuota temporal alcanzada.", code: "wait", retryAfterSeconds: 75 } });
  const old = await handler({ booking: false, budget: null });
  assert.deepEqual(old, { status: 429, body: { error: "Cuota temporal alcanzada." } });
  const done = await handler({ calculate: ok, budget: { ...libre, waitSeconds: 119 } });
  assert.equal(done.status, 200);
  assert.equal(done.body.retryAfterSeconds, 119);
  const plain = await handler({ calculate: ok, budget: null });
  assert.equal(Object.hasOwn(plain.body, "retryAfterSeconds"), false);
  const provider = await handler({ calculate: async () => { throw Object.assign(new Error("x"), { status: 429, providerLimited: true }); } });
  assert.deepEqual(provider, { status: 429, body: { error: "Cuota temporal alcanzada.", code: "provider_limited" } });
  const refused = await handler({ calculate: async () => { throw Object.assign(new Error("x"), { status: 429, providerLimited: false }); },
    budget: { ...libre, waitSeconds: 110 } });
  assert.deepEqual(refused.body, { error: "Cuota temporal alcanzada.", code: "budget_refused", retryAfterSeconds: 110 });
});

test("migración: solo añade una función de lectura para service_role; no toca topes, esperas ni tablas", async () => {
  const sql = await read("supabase/migrations/20261127120000_route_budget_wait.sql");
  assert.match(sql, /PENDIENTE DE APLICAR/);
  const code = sql.replace(/--.*$/gm, "");
  assert.match(code, /^\s*begin;/);
  assert.match(code, /commit;\s*$/);
  assert.equal(code.match(/create function/g).length, 1);
  assert.doesNotMatch(code, /\b(create or replace|alter|drop|insert|update|delete|truncate)\b/i);
  assert.match(code, /language sql\n stable security definer/);
  assert.match(code, /revoke all on function public\.cc_route_budget_wait\(uuid\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.cc_route_budget_wait\(uuid\) to service_role;/);
  const applied = await read("supabase/migrations/20261120050000_route_pilot_applied_reference.sql");
  assert.ok(applied.includes("interval '2 minutes'") && applied.includes(">= 2500"), "lo que exige la guarda");
  assert.match(await read("supabase/tests/isolated/route-budget-wait-isolated.sql"), /^rollback;/m);
});
