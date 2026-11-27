// CONFIRMAR_CITAS-027: portal bien interpretado (el complemento se aparta), campo «Escribir la calle»,
// «Corregir a mano», «Dejarla como está» y hasta 5 sugerencias. Datos inventados, sin red, sin Supabase y sin
// Geoapify: CartoCiudad y Geoapify simulados.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as app from "../my-routes-address.mjs";
import {
  calculateJourney, chooseOfficialStreet, editableAddress, exteriorStreet, incompleteReason, journeyAddresses,
  journeyFingerprint, providerPlan, streetFields, streetVariant,
} from "../supabase/functions/my-routes-estimate/core.mjs";
import { parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { createCloudRoutes, officialAddressData } from "../my-routes-cloud.mjs";
import { correctedLocation, mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const read = async path => (await readFile(new URL("../" + path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const CP = "17599", TOWN = "Vilafictícia";
const oracle = street => `${street}, ${CP}, VILAFICTICIA`;

// ---------- Parte B: portal y complemento ----------

// [dirección tipo Oracle, calle que se busca, portal, complemento]
const TABLA = [
  // Mismas formas que los cuatro casos reales del 27/11, con nombres inventados.
  ["CARRER ROURES I PINS 41 1º E", "Carrer Roures i Pins", "41", "1º E"],
  ["PRESIDENT PERE FICCIO 18 6 3", "President Pere Ficcio", "18", "6 3"],
  ["Vilaficticix 39", "Vilaficticix", "39", ""],
  ["REC TORRENT PROVES 20", "Rec Torrent Proves", "20", ""],
  // Piso, puerta, escalera, bajos, ático.
  ["CARRER FICCIO 41 1E", "Carrer Ficcio", "41", "1E"],
  ["CARRER FICCIO 41 1º-E", "Carrer Ficcio", "41", "1º-E"],
  ["CARRER FICCIO 41 1 E", "Carrer Ficcio", "41", "1 E"],
  ["CARRER FICCIO 41-1º 2ª", "Carrer Ficcio", "41", "1º 2ª"],
  ["CARRER FICCIO 18 6-3", "Carrer Ficcio", "18", "6-3"],
  ["CARRER FICCIO 18 6 3 2", "Carrer Ficcio", "18", "6 3 2"],
  ["CARRER FICCIO 18 PRAL", "Carrer Ficcio", "18", "Pral"],
  ["CARRER FICCIO 18 PRAL 2A", "Carrer Ficcio", "18", "Pral 2A"],
  ["CARRER FICCIO 18 BAJOS", "Carrer Ficcio", "18", "Bajos"],
  ["CARRER FICCIO 18 BXS 1", "Carrer Ficcio", "18", "Bxs 1"],
  ["CARRER FICCIO 18 ESC A", "Carrer Ficcio", "18", "Esc A"],
  ["CARRER FICCIO 18 ESC A 3 1", "Carrer Ficcio", "18", "Esc A 3 1"],
  ["CARRER FICCIO 18 ATICO", "Carrer Ficcio", "18", "Atico"],
  ["CARRER FICCIO 18 2N 1A", "Carrer Ficcio", "18", "2n 1a"],
  ["FICCIO 18 4 B", "Ficcio", "18", "4 B"],
  // Letra, rango, bis y marca de número.
  ["CARRER FICCIO 41B", "Carrer Ficcio", "41B", ""],
  ["CARRER FICCIO 41-B 2 1", "Carrer Ficcio", "41B", "2 1"],
  ["CARRER FICCIO 41 B 2º", "Carrer Ficcio", "41B", "2º"],
  ["CARRER FICCIO 41-43", "Carrer Ficcio", "41", ""],
  ["CARRER FICCIO 41-43 1º 1ª", "Carrer Ficcio", "41", "1º 1ª"],
  ["CARRER FICCIO 9 BIS 3 2", "Carrer Ficcio", "9 bis", "3 2"],
  ["CARRER FICCIO Nº 9 3 2", "Carrer Ficcio", "9", "3 2"],
  // Calles con número en el nombre.
  ["CALLE 9 DE JULIO 12", "Calle 9 de Julio", "12", ""],
  ["CALLE 9 DE JULIO 12 3º B", "Calle 9 de Julio", "12", "3º B"],
  ["AVINGUDA 11 DE SETEMBRE 5 6 3", "Avinguda 11 de Setembre", "5", "6 3"],
  ["CARRER GRUP 25 DE SETEMBRE 4", "Carrer Grup 25 de Setembre", "4", ""],
  ["CARRETERA N 340 12 2 1", "Carretera n 340", "12", "2 1"],
];

test("tabla de direcciones tipo Oracle: portal = primer número tras la calle; lo demás es complemento", () => {
  for (const [text, street, portal, complement] of TABLA) {
    const fields = streetFields(oracle(text));
    assert.ok(fields, text);
    assert.equal(fields.street.toLowerCase(), street.toLowerCase(), text);
    assert.equal(fields.housenumber, portal, text);
    const editable = editableAddress(oracle(text));
    assert.equal(editable.number, portal, text);
    assert.equal(editable.complement.toLowerCase(), complement.toLowerCase(), "el complemento se conserva: " + text);
  }
});

test("complemento separado por comas: se conserva y no cambia la búsqueda", () => {
  const address = "CARRER FICCIO 41, 1º E, " + CP + ", VILAFICTICIA";
  assert.equal(streetFields(address).housenumber, "41");
  assert.equal(streetFields(address).street, "Carrer Ficcio");
  assert.deepEqual(editableAddress(address), { street: "Carrer Ficcio", number: "41", complement: "1º E",
    postalCode: CP, municipality: "Vilaficticia", province: "" });
});

test("sin número («S/N», solo piso o solo número de la calle): «missing_number», sin buscar", () => {
  for (const text of ["CARRER FICCIO S/N", "CARRER FICCIO S/N 2 1", "CALLE 9 DE JULIO S/N", "CARRER FICCIO 1º 2ª",
    "AVINGUDA 11 DE SETEMBRE", "CARRER FICCIO BAJOS"]) {
    assert.equal(streetFields(oracle(text)), null, text);
    assert.equal(incompleteReason(oracle(text)), "missing_number", text);
  }
  assert.equal(exteriorStreet("Carrer Ficcio S/N 2 1").noNumber, true);
  // Un teléfono en la línea sigue bloqueando la búsqueda.
  assert.equal(streetFields(oracle("CARRER FICCIO 5 600 123 456")), null);
});

test("la app y la función analizan las direcciones con el mismo módulo (copias idénticas)", async () => {
  assert.equal(await read("my-routes-address.mjs"), await read("supabase/functions/my-routes-estimate/oracle-address.mjs"));
  for (const [text] of TABLA) assert.deepEqual(app.editableAddress(oracle(text)), editableAddress(oracle(text)));
  assert.match(await read(".github/workflows/pages.yml"), /^\s+my-routes-address\.mjs$/m);
});

// ---------- Servidor simulado ----------

const fila = changes => ({ province: "Girona", muni: TOWN, poblacion: null, postalCode: CP, type: "callejero",
  lat: 0, lng: 0, portalNumber: null, extension: null, state: 0, ...changes });
const via = (tipo, nombre) => fila({ tip_via: tipo, address: `${tipo} ${nombre}, ${TOWN}` });
const portalFila = (tipo, nombre, numero, lat) => fila({ type: "portal", tip_via: tipo, address: nombre, portalNumber: numero, lat, lng: 2.2 });
const plano = value => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// `calles`: callejero oficial que devuelve la lista; `portales`: respuestas de `findJsonp` por palabra.
function servidor({ calles = [], geo = () => [] } = {}) {
  const log = [], sent = [];
  const carto = async url => {
    assert.equal(url.hostname, "www.cartociudad.es");
    const params = Object.fromEntries(url.searchParams);
    const find = url.pathname.endsWith("/findJsonp");
    log.push((find ? "carto findJsonp " : "carto candidates ") + JSON.stringify(params));
    sent.push(params);
    const word = plano(params.q);
    let data = [];
    if (word.startsWith("ficticia")) data = [portalFila("CALLE", "FICTICIA", 1, 42.1)];
    else if (word.startsWith("pins")) data = [portalFila("CARRER", "PINS", 9, 42.12)];
    else if (!/\d/u.test(params.q)) data = calles.filter(row => word.split(",")[0].split(" ").some(part => plano(row.address).includes(part.slice(0, 4))));
    return new Response(find ? "callback(" + JSON.stringify(data) + ")" : JSON.stringify(data), { status: 200 });
  };
  const geoapify = async url => {
    assert.equal(url.hostname, "api-eu.geoapify.com");
    const params = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "apiKey"));
    if (url.pathname.endsWith("/routing")) { log.push("geoapify routing"); return Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] }); }
    log.push((params.street ? "geoapify estructurada " : "geoapify texto ") + JSON.stringify(params.street
      ? { street: params.street, housenumber: params.housenumber, postcode: params.postcode, city: params.city } : { text: params.text }));
    sent.push(params);
    return Response.json({ results: geo(params) });
  };
  return { log, sent, carto, geoapify };
}
const casa = `Calle Ficticia 1, ${CP}, ${TOWN}`;
async function jornada(addresses, server) {
  const details = [], suggestions = [], officials = [];
  const { addresses: allowed, reasons } = providerPlan(addresses, true);
  const estimates = await calculateJourney(allowed, { apiKey: "clave-ficticia", manualFreePilot: true, reasons, details,
    suggestions, officials, charge: async () => true, fetcher: server.geoapify, cartociudad: { fetcher: server.carto } });
  return { estimates, details, suggestions, officials, reasons };
}
const SEIS = [via("AVINGUDA", "ROUREDA"), via("PLAÇA", "ROUREDA"), via("PASSEIG", "ROUREDA"), via("CARRER", "ROUREDES"),
  via("CAMÍ", "ROUREDA VELLA"), via("CARRER", "ROURETA"), via("CARRER", "ROUREDA ALTA")];

test("el complemento no se envía a CartoCiudad ni a Geoapify y no cambia las consultas", async () => {
  const consultas = [];
  for (const text of ["CARRER ROUREDA 18 6 3", "CARRER ROUREDA 18", "CARRER ROUREDA 18 1º E"]) {
    const server = servidor();
    await jornada([casa, oracle(text), casa], server);
    const own = server.log.filter(line => /roureda/iu.test(line));
    assert.ok(own.length >= 2, text);
    for (const line of own) assert.doesNotMatch(line, /6 3|1º|18 \d| E[",]/u, line);
    consultas.push(own);
  }
  assert.deepEqual(consultas[0], consultas[1]);
  assert.deepEqual(consultas[2], consultas[1]);
});

test("«PTGE <nombre>» sin Passatge oficial: hasta 5 sugerencias de cualquier tipo, la de nombre igual primero", async () => {
  const choice = chooseOfficialStreet(SEIS, streetFields(oracle("PTGE ROUREDA 1")));
  assert.equal(choice.street, null);
  assert.equal(choice.suggestions.length, 5);
  assert.deepEqual(choice.suggestions.slice(0, 3), ["Avinguda Roureda", "Plaça Roureda", "Passeig Roureda"]);
  assert.ok(choice.suggestions.some(name => name.startsWith("Carrer ")), "cualquier tipo de vía");
  const r = await jornada([casa, oracle("PTGE ROUREDA 1"), casa], servidor({ calles: SEIS }));
  assert.equal(r.suggestions[1].length, 5);
  for (const location of r.suggestions[1]) assert.doesNotThrow(() => parseActivityEdits([["clave", { travel: "travel", location }]]));
  const client = officialAddressData({ suggestions: [r.suggestions[1]] }, 1);
  assert.equal(client.suggestions[0].length, 5, "la app acepta las 5");
});

test("topes y secuencia de una vía «PTGE» sin coincidencia: ≤ 3 CartoCiudad y ≤ 2 Geoapify, tipo conservado", async () => {
  const server = servidor({ calles: SEIS });
  await jornada([casa, oracle("PTGE ROUREDA 1"), casa], server);
  const own = server.log.filter(line => /roureda/iu.test(line));
  assert.deepEqual(own, [
    'carto findJsonp {"q":"Roureda 1, Vilaficticia"}',
    'carto candidates {"q":"Roureda","limit":"10","cod_postal_filter":"17599"}',
    'carto candidates {"q":"Roureda 1","limit":"5","cod_postal_filter":"17599"}',
    'geoapify estructurada {"street":"Passatge Roureda","housenumber":"1","postcode":"17599","city":"Vilaficticia"}',
    'geoapify texto {"text":"Passatge de Roureda 1, 17599 Vilaficticia, Girona, España"}',
  ]);
  // Con vocal: «de l'».
  const vocal = servidor();
  await jornada([casa, oracle("PTGE ERMITA 1"), casa], vocal);
  const ermita = vocal.log.filter(line => /ermita/iu.test(line));
  assert.equal(ermita.filter(line => line.startsWith("carto")).length, 3);
  assert.equal(ermita.filter(line => line.startsWith("geoapify")).length, 2);
  assert.match(ermita.at(-2), /"street":"Passatge Ermita"/);
  assert.match(ermita.at(-1), /"text":"Passatge de l'Ermita 1, /);
});

test("Geoapify con «Passatge de la/de/de l'»: la variante encuentra la calle y conserva el tipo", async () => {
  const encontrada = { country_code: "es", street: "Passatge de l'Ermita", housenumber: "1", postcode: CP, city: TOWN,
    lat: 42.13, lon: 2.2, result_type: "building", rank: { confidence: 0.95, match_type: "full_match" } };
  const server = servidor({ geo: params => params.text?.startsWith("Passatge de l'Ermita") ? [encontrada] : [] });
  const r = await jornada([casa, oracle("PTGE ERMITA 1"), casa], server);
  assert.deepEqual(r.estimates.map(Boolean), [true, true]);
});

test("variantes con y sin artículo; sin tipo de vía no se inventa ninguna", () => {
  assert.equal(streetVariant("Passatge Ermita"), "Passatge de l'Ermita");
  assert.equal(streetVariant("Passatge Roureda"), "Passatge de Roureda");
  assert.equal(streetVariant("Pasaje Estrella"), "Pasaje de la Estrella");
  assert.equal(streetVariant("Passatge de l'Ermita"), "Passatge Ermita");
  assert.equal(streetVariant("Passatge de la Roureda"), "Passatge Roureda");
  assert.equal(streetVariant("Carrer dels Pins"), "Carrer Pins");
  assert.equal(streetVariant("Roureda"), "");
  assert.equal(streetVariant("President Pere Ficcio"), "");
});

test("calle que CartoCiudad sí tiene: la búsqueda de reserva es la de siempre (sin variante)", async () => {
  const server = servidor({ calles: [via("CARRER", "ROUREDA")] });
  await jornada([casa, oracle("CARRER ROUREDA 7"), casa], server);
  assert.ok(server.log.some(line => line.startsWith('geoapify texto {"text":"Carrer Roureda 7, ')));
});

test("la calle escrita conserva su tipo hacia Geoapify; CartoCiudad busca sin tipo ni artículos, como siempre", async () => {
  for (const typed of ["Passatge de la Roureda", "Pasaje Roureda", "Camí de la Roureda", "Plaça Roureda"]) {
    const location = correctedLocation(editableAddress(oracle("PTGE ROUREDA 1")), typed, "1", "Vilaficticia");
    assert.equal(location.street, typed);
    const server = servidor();
    await jornada([casa, `${location.street} ${location.number}, ${location.postalCode}, ${location.municipality}`, casa], server);
    assert.ok(server.log.some(line => line.includes(`"street":"${typed}"`)), typed);
    assert.ok(server.log.includes('carto findJsonp {"q":"Roureda 1, Vilaficticia"}'), typed);
  }
});

test("correctedLocation: apóstrofos de móvil admitidos; caracteres no válidos, no", () => {
  const base = editableAddress(oracle("PTGE ESTRELLA 1"));
  assert.equal(correctedLocation(base, "  Passatge de l´Estrella ", "1", "Vilaficticia").street, "Passatge de l'Estrella");
  assert.equal(correctedLocation(base, "Passatge, Estrella", "1", "Vilaficticia"), null);
  assert.equal(correctedLocation(base, "", "1", "Vilaficticia"), null);
});

// ---------- Pantalla ----------

const prefs = { home: { street: "Calle Ficticia", number: "1", municipality: TOWN, postalCode: CP }, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, calle) => ({ id, scheduled_time: hora, full_address: calle, postal_code: CP, population: "VILAFICTICIA", status: "pending" });
const all = (node, out = []) => { for (const child of node.children ?? []) { out.push(child); all(child, out); } return out; };
const cards = get => get("List").children.filter(node => node.tag === "article");
const buttons = (node, label) => all(node).filter(item => item.tag === "button" && item.textContent === label);
const forms = node => all(node).filter(item => item.tag === "form" && item.className === "dialog-form route-street-form");
const inputs = form => all(form).filter(item => item.tag === "input");
// El servidor simulado espera entre llamadas como la función real: se aguarda a que termine el cálculo.
async function idle(get) {
  await settle(30);
  for (let i = 0; i < 400 && (!get("List").children.length || /^Calculando/.test(get("CalculationNotice").textContent)); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await settle(30);
}

async function pantalla(citas, { server = servidor({ calles: SEIS }), wait = null, preferences = prefs } = {}) {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const bodies = [];
  const clock = { now: Date.parse("2026-11-27T08:00:00Z"), task: null };
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    bodies.push(body);
    const addresses = journeyAddresses(preferences, citas, [], parseActivityEdits(body.edits));
    assert.equal(await journeyFingerprint(addresses), body.fingerprint);
    const r = await jornada(addresses, server);
    return { data: { estimates: r.estimates, reasons: r.reasons, details: r.estimates.map((_, i) => r.details[i] ?? null),
      suggestions: addresses.map((_, i) => r.suggestions[i] ?? null),
      ...(wait && bodies.length === 1 ? { retryAfterSeconds: wait } : {}) }, error: null };
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    now: () => new Date(clock.now), timers: { set: task => { clock.task = task; return 1; }, clear: () => { clock.task = null; } },
    preferencesStore: { read: async () => preferences, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: [] }) });
  ui.sync();
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await settle(40);
  const advance = async seconds => {
    for (let i = 0; i < seconds; i++) { clock.now += 1000; const task = clock.task; clock.task = null; task?.(); }
    await idle(get);
  };
  const submit = async form => { form.events.submit({ preventDefault() {} }); await idle(get); };
  return { get, panel, bodies, server, advance, submit };
}
const dos = [cita("a", "09:00", "PTGE ROUREDA 1 2º 1ª"), cita("b", "11:00", "CARRER PINS 9")];

test("tarjeta: 5 sugerencias, «Dejarla como está» y «Escribir la calle» relleno con la calle legible", async () => {
  const p = await pantalla(dos);
  const card = cards(p.get)[1];
  const options = all(card).find(node => node.className === "route-address-options").children;
  assert.equal(options.length, 5);
  assert.equal(buttons(card, "Dejarla como está: Passatge Roureda").length, 1);
  const [form] = forms(card);
  assert.equal(form.hidden, false, "visible sin tocar nada");
  assert.deepEqual(inputs(form).map(input => input.value), ["Passatge Roureda", "1"]);
  assert.match(texts(form).join("|"), /Escribir la calle\|Número\|Probar/);
  assert.equal(buttons(card, "Corregir a mano").length, 1);
  assert.match(texts(card).join("\n"), /PTGE ROUREDA 1 2º 1ª/, "la ficha conserva el complemento");
  // El tramo siguiente depende de la misma dirección: botón «Corregir a mano», sin repetir el bloque.
  const next = cards(p.get)[2];
  assert.equal(buttons(next, "Corregir a mano").length, 1);
  assert.equal(forms(next).length, 0);
  form.hidden = true;
  buttons(next, "Corregir a mano")[0].events.click();
  assert.equal(form.hidden, false, "abre el editor ya relleno");
});

test("«Probar» aplica lo escrito, recalcula y la calle llega a Geoapify con su tipo", async () => {
  const p = await pantalla(dos);
  const [form] = forms(cards(p.get)[1]);
  inputs(form)[0].value = "Passatge de la Roureda Nova";
  await p.submit(form);
  assert.equal(p.bodies.length, 2);
  assert.deepEqual(p.bodies[1].edits[0][1], { travel: "travel", location: { street: "Passatge de la Roureda Nova",
    number: "1", municipality: "Vilaficticia", postalCode: CP } });
  assert.ok(p.server.log.some(line => line.includes('"street":"Passatge de la Roureda Nova"')));
  const card = cards(p.get)[1];
  const shown = texts(card).join("\n");
  assert.match(shown, /No encuentro esa calle en este pueblo\. Prueba a escribirla de otra forma o deja la dirección vacía en Editar para usar la de la agenda\./);
  assert.match(shown, /En la agenda: PTGE ROUREDA 1 2º 1ª, VILAFICTICIA/);
  assert.match(shown, /Editar/);
  assert.deepEqual(inputs(forms(card)[0]).map(input => input.value), ["Passatge de la Roureda Nova", "1"]);
  // «Dejarla como está» vuelve a la calle de Oracle.
  buttons(card, "Dejarla como está: Passatge Roureda")[0].events.click();
  await idle(p.get);
  assert.equal(p.bodies.at(-1).edits[0][1].location.street, "Passatge Roureda");
});

test("la calle que no existe no bloquea el resto de la ruta", async () => {
  const p = await pantalla([cita("a", "09:00", "PTGE ROUREDA 1"), cita("b", "11:00", "CARRER PINS 9"), cita("c", "13:00", "CARRER PINS 9")]);
  const [form] = forms(cards(p.get)[1]);
  inputs(form)[0].value = "Passatge Inexistent";
  await p.submit(form);
  const shown = texts(p.get("List")).join("\n");
  assert.match(shown, /No encuentro esa calle en este pueblo/);
  assert.match(shown, /🚗 30 min · 12 km desde Instalación/, "el tramo entre las otras dos se calcula");
});

test("campos vacíos o no válidos: aviso y no se envía nada", async () => {
  const p = await pantalla(dos);
  const [form] = forms(cards(p.get)[1]);
  const [street, number] = inputs(form);
  const status = () => all(form).find(node => node.attributes?.role === "status").textContent;
  street.value = ""; await p.submit(form); assert.equal(status(), "Escribe la calle.");
  street.value = "Passatge Roureda"; number.value = ""; await p.submit(form); assert.equal(status(), "Escribe también el número del portal.");
  street.value = "Passatge; Roureda"; number.value = "1"; await p.submit(form); assert.match(status(), /^Usa solo letras/);
  assert.equal(p.bodies.length, 1);
});

test("sin sugerencias («No encuentro la calle» / «ese número») también sale el campo", async () => {
  const p = await pantalla([cita("a", "09:00", "CARRER SENSE RES 5"), cita("b", "11:00", "CARRER PINS 9")], { server: servidor() });
  const card = cards(p.get)[1];
  assert.match(texts(card).join("\n"), /No encuentro la calle/);
  assert.equal(all(card).filter(node => node.className === "route-address-options").length, 0);
  assert.equal(forms(card)[0].hidden, false);
  assert.equal(buttons(card, "Dejarla como está: Carrer Sense Res").length, 1);
  const portal = servidor({ geo: params => params.street ? [{ country_code: "es", street: "Carrer Sense Res", housenumber: "99",
    postcode: CP, city: TOWN, lat: 42.2, lon: 2.2, result_type: "building", rank: { confidence: 1, match_type: "full_match" } }] : [] });
  const q = await pantalla([cita("a", "09:00", "CARRER SENSE RES 5"), cita("b", "11:00", "CARRER PINS 9")], { server: portal });
  assert.match(texts(cards(q.get)[1]).join("\n"), /No encuentro ese número/);
  assert.equal(forms(cards(q.get)[1])[0].hidden, false);
});

test("durante la espera la calle escrita queda aplicada y se recalcula sola al terminar", async () => {
  const p = await pantalla(dos, { wait: 80 });
  const [form] = forms(cards(p.get)[1]);
  inputs(form)[0].value = "Passatge de la Roureda";
  await p.submit(form);
  assert.equal(p.bodies.length, 1);
  assert.match(p.get("CalculationNotice").textContent, /La corrección queda aplicada y se recalculará sola/);
  assert.match(texts(p.get("List")).join("\n"), /Passatge de la Roureda 1/);
  await p.advance(80);
  assert.equal(p.bodies.length, 2);
  assert.equal(p.bodies[1].edits[0][1].location.street, "Passatge de la Roureda");
});

test("todo tramo sin calcular por la dirección muestra «Corregir a mano» (incompleta, sin número y domicilio)", async () => {
  const p = await pantalla([cita("a", "09:00", "CARRER FICCIO S/N"), cita("b", "11:00", "CARRER PINS 9"),
    cita("c", "13:00", "5"), cita("d", "15:00", "CARRER PINS 9")]);
  const list = cards(p.get).slice(1);
  const byAddress = list.filter(card => !/🚗/u.test(texts(card).join("")));
  assert.ok(byAddress.length >= 4);
  for (const card of byAddress) assert.equal(buttons(card, "Corregir a mano").length, 1,
    list.map(item => texts(item).join("|")).join(" // "));
  const [form] = forms(list[0]);
  assert.equal(form.hidden, true, "sin número: el editor se abre con el botón");
  buttons(list[0], "Corregir a mano")[0].events.click();
  assert.equal(form.hidden, false);
  assert.deepEqual(inputs(form).map(input => input.value), ["Carrer Ficcio", ""]);
  // Domicilio no localizado: el botón abre «Ajustes».
  const home = { ...prefs, home: { ...prefs.home, street: "Calle Perdida" } };
  const q = await pantalla([cita("a", "09:00", "CARRER PINS 9"), cita("b", "11:00", "CARRER PINS 9")], { preferences: home, server: servidor() });
  const back = cards(q.get).at(-1);
  assert.equal(buttons(back, "Corregir a mano").length, 1);
  assert.equal(buttons(cards(q.get)[1], "Corregir a mano").length, 1);
  q.get("SettingsPanel").hidden = true;
  await buttons(back, "Corregir a mano")[0].events.click();
  await settle(10);
  assert.equal(q.get("SettingsPanel").hidden, false);
});

test("móvil: campo y botones de 48 px, letra de 16 px, sin anchos fijos y el editor cerrado no ocupa sitio", async () => {
  const css = await read("agenda.css");
  assert.match(css, /#myRoutesView \.route-street-form input\{min-width:0;min-height:48px;margin-top:4px;font-size:16px\}/);
  assert.match(css, /#myRoutesView \.route-fix,[^{]*\.route-street-form \.button\{display:block;width:100%;min-height:48px/);
  assert.match(css, /#myRoutesView \.route-street-form\{grid-template-columns:minmax\(0,1fr\);min-width:0/);
  assert.match(css, /#myRoutesView \.route-street-form\[hidden\]\{display:none\}/);
});
