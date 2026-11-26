// CONFIRMAR_CITAS-018: direcciones de Oracle con abreviaturas, sin tipo de vía, número con letra, piso y puerta,
// «S/N» y municipios con artículos en mayúscula; código de detalle por dirección fallida.
// Sin red ni Geoapify: respuestas simuladas. Calles y municipios INVENTADOS (Vilafictícia, Ribes de Ficció, CP 1759x).
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADDRESS_DIAGNOSTICS, LEG_DETAILS, addressDiagnostic, calculateJourney, chooseCandidate, cleanOracleText, exteriorStreet,
  freeTextQuery, incompleteReason, journeyAddresses, journeyFingerprint, municipalityName, providerPlan, sameMunicipality,
  sameStreet, streetFields,
} from "../supabase/functions/my-routes-estimate/core.mjs";
import { homeOptIn, parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
import { buildLegs, combineActivities, formatRouteLocation } from "../my-routes.mjs";
import { addressDiagnostics, createCloudRoutes, routeFingerprint } from "../my-routes-cloud.mjs";
import { mountMyRoutes } from "../my-routes-ui.mjs";
import { fakePanel, settle, texts } from "./my-routes-fake-dom.mjs";

const CP = "17599";
const oracle = (calle, municipio = "VILAFICTICIA", cp = CP) => calle + ", " + cp + ", " + municipio;

// ---------- 1. Abreviaturas de tipo de vía ----------

test("cada abreviatura catalana y castellana, con y sin punto, se expande a su tipo", () => {
  const tabla = {
    "PTGE": "Passatge", "PTGE.": "Passatge", "PTG": "Passatge", "PJE": "Pasaje", "PSJE.": "Pasaje", "PG": "Passeig", "PG.": "Passeig",
    "PS": "Paseo", "PSO.": "Paseo", "CTRA": "Carretera", "CTRA.": "Carretera", "CRTA": "Carretera", "AV": "Avenida",
    "AV.": "Avenida", "AVDA": "Avenida", "AVDA.": "Avenida", "AVGDA": "Avinguda", "AVGDA.": "Avinguda", "PL": "Plaza",
    "PL.": "Plaza", "PÇA": "Plaça", "PÇA.": "Plaça", "PZA": "Plaza", "PZA.": "Plaza", "RDA": "Ronda", "RDA.": "Ronda",
    "TRAV": "Travessera", "TRAV.": "Travessera", "TRV": "Travesía", "CM": "Camino", "CM.": "Camino", "URB": "Urbanización",
    "URB.": "Urbanización", "POL": "Polígono", "POL.": "Polígono", "BDA": "Barriada", "BDA.": "Barriada", "C/": "Calle",
    "C.": "Calle", "CL": "Calle", "RBLA.": "Rambla",
  };
  for (const [abreviatura, tipo] of Object.entries(tabla)) {
    assert.equal(cleanOracleText(abreviatura + " FICCIO 1"), tipo + " Ficcio 1", abreviatura);
  }
  assert.equal(cleanOracleText("C/FICCIO 1"), "Calle Ficcio 1", "C/ pegado al nombre");
  // Ambiguas (PSG: passeig o passatge; CR: carrer o carretera): se busca solo por el nombre.
  assert.equal(cleanOracleText("PSG FICCIO 1"), "Ficcio 1");
  assert.equal(cleanOracleText("CR FICCIO 1"), "Ficcio 1");
  // Un nombre que solo empieza como una abreviatura no se toca.
  assert.equal(cleanOracleText("PLATANERS 4"), "Plataners 4");
  assert.equal(cleanOracleText("CARRER POLVORI 4"), "Carrer Polvori 4");
});

test("las abreviaturas valen también en la comparación tolerante (equivalencias de tipo)", () => {
  const pares = [
    ["Passatge de la Ficció", "PTGE FICCIO"], ["Pasaje Ficción", "PJE. FICCION"], ["Passatge de la Ficció", "Pasaje Ficció"],
    ["Passeig de la Ficció", "PG FICCIO"], ["Passeig de la Ficció", "PSO. FICCIO"], ["Carretera de Ficció", "CTRA FICCIO"],
    ["Avinguda de la Ficció", "AVGDA FICCIO"], ["Avinguda de la Ficció", "AVDA. FICCIO"], ["Plaça de la Ficció", "PÇA FICCIO"],
    ["Plaça de la Ficció", "PZA FICCIO"], ["Ronda de Ficció", "RDA FICCIO"], ["Travessera de Ficció", "TRAV FICCIO"],
    ["Travessia de Ficció", "Travesía Ficció"], ["Camí de Ficció", "CM FICCIO"], ["Urbanització Ficció", "URB FICCIO"],
    ["Polígon de Ficció", "POL. FICCIO"], ["Barriada de Ficció", "BDA FICCIO"], ["Carrer de Ficció", "C/ FICCIO"],
    ["Passeig de la Ficció", "PSG FICCIO"], ["Passatge de la Ficció", "PSG FICCIO"], ["Carrer de Ficció", "CR FICCIO"],
  ];
  for (const [geoapify, texto] of pares) {
    assert.equal(sameStreet(geoapify, cleanOracleText(texto)), true, geoapify + " / " + texto);
  }
  // Clases distintas siguen sin coincidir.
  for (const [a, b] of [["Passatge de la Ficció", "PL FICCIO"], ["Polígon de Ficció", "CARRER FICCIO"], ["Ronda de Ficció", "AV FICCIO"]]) {
    assert.equal(sameStreet(a, cleanOracleText(b)), false, a + " / " + b);
  }
});

// ---------- 2. Calle sin tipo, número, piso y puerta ----------

test("calle sin tipo de vía: se busca solo con el nombre y se acepta el candidato con el mismo nombre", () => {
  const fields = streetFields(oracle("ROURE 9"));
  assert.equal(fields.street, "Roure");
  assert.equal(fields.housenumber, "9");
  for (const geoapify of ["Carrer del Roure", "Passatge del Roure", "Roure"]) assert.equal(sameStreet(geoapify, fields.street), true, geoapify);
  assert.equal(sameStreet("Carrer del Freixe", fields.street), false);
  const row = { country_code: "es", street: "Carrer del Roure", housenumber: "9", postcode: CP, city: "Vilafictícia", lat: 42.2, lon: 2.3,
    result_type: "building", rank: { confidence: 0.95, match_type: "full_match" } };
  assert.equal(chooseCandidate([row], fields).outcome, "found");
});

test("todos los formatos de número: letra, rango, Nº, NUM, bajo, escalera, puerta, piso y S/N", () => {
  const casos = {
    "CARRER FICCIO 9": "9", "CARRER FICCIO 9A": "9A", "CARRER FICCIO 9 A": "9A", "CARRER FICCIO 9-11": "9",
    "CARRER FICCIO 9 - 11": "9", "CARRER FICCIO Nº 9": "9", "CARRER FICCIO Nº9": "9", "CARRER FICCIO NUM 9": "9",
    "CARRER FICCIO NÚM. 9": "9", "CARRER FICCIO 9 BJ": "9", "CARRER FICCIO 9 BAJO": "9", "CARRER FICCIO 9 ESC A": "9",
    "CARRER FICCIO 9 PTA 3": "9", "CARRER FICCIO 9 PISO 2": "9", "CARRER FICCIO 9 LOCAL": "9", "CARRER FICCIO 9 1º 2ª": "9",
    "CARRER FICCIO 9 A 2º 2º": "9A", "CARRER FICCIO 9 2N 1A": "9", "CARRER FICCIO 9 BIS": "9 bis", "CARRER FICCIO 9 BIS 1º": "9 bis",
    "FICCIO 9 A 2º 2º": "9A", "CARRER 1 DE MAIG 9-11": "9",
  };
  for (const [calle, portal] of Object.entries(casos)) {
    const fields = streetFields(oracle(calle));
    assert.ok(fields, calle);
    assert.equal(fields.housenumber, portal, calle);
    assert.doesNotMatch(fields.street, /\d[ºª]|\b(?:bj|bajo|esc|pta|piso|local|nº|num)\b/iu, calle);
  }
  assert.equal(streetFields(oracle("CARRER 1 DE MAIG 9-11")).street, "Carrer 1 de Maig", "un número dentro del nombre se conserva");
  // El número en su propia parte separada por comas, también con el piso.
  assert.equal(streetFields("CARRER FICCIO, 9 A 2º, " + CP + ", VILAFICTICIA").housenumber, "9A");
  // Sin número: no se busca y el motivo es claro.
  for (const calle of ["CARRER FICCIO S/N", "CARRER FICCIO S/N BJ", "CARRER FICCIO S.N.", "CARRER FICCIO 2º", "AVINGUDA 11 DE SETEMBRE"]) {
    assert.equal(streetFields(oracle(calle)), null, calle);
    assert.equal(incompleteReason(oracle(calle)), "missing_number", calle);
  }
  assert.equal(exteriorStreet("Carrer Ficcio S/n").noNumber, true);
  // Un teléfono nunca se toma como portal ni se busca.
  assert.equal(streetFields(oracle("CARRER FICCIO 5 600 123 456")), null);
});

test("municipio: artículos en minúscula y comparación sin acentos ni mayúsculas", () => {
  assert.equal(municipalityName("Ribes De Ficció"), "Ribes de Ficció");
  assert.equal(municipalityName("Sant Joan De Les Ficcions"), "Sant Joan de les Ficcions");
  assert.equal(municipalityName("La Vall D'En Ficció"), "La Vall d'en Ficció");
  assert.equal(streetFields(oracle("CARRER FICCIO 9", "Ribes De Ficció")).city, "Ribes de Ficció");
  assert.equal(streetFields(oracle("CARRER FICCIO 9", "RIBES DE FICCIO")).city, "Ribes de Ficcio");
  assert.equal(sameMunicipality("Ribes de Ficció", "RIBES DE FICCIO"), true);
  assert.equal(sameMunicipality("Ribes de Ficció", "Ribes De Ficcio"), true);
  assert.equal(sameMunicipality("Ribes de Ficció", "Ribes d'Altra"), false);
});

// ---------- 3. Geoapify simulado (callejero inventado, al estilo de OpenStreetMap) ----------

const callejero = [
  { calle: "Passatge de la Ficció", portales: ["1"], ciudad: "Vilafictícia", cp: CP, lat: 42.10 },
  { calle: "Carrer del Roure", portales: ["9"], ciudad: "Vilafictícia", cp: CP, lat: 42.11 },
  { calle: "Carrer dels Pins", portales: ["9"], ciudad: "Ribes de Ficció", cp: "17598", lat: 42.12 },
  { calle: "Carrer de l'Olivera", portales: ["9A", "9"], ciudad: "Vilafictícia", cp: CP, lat: 42.13 },
  { calle: "Carrer Ficticia", portales: ["1"], ciudad: "Vilafictícia", cp: CP, lat: 42.14 },
];
const sinTipo = texto => texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/'/gu, " ")
  .replace(/^(calle|carrer|passatge|pasaje|avinguda|avenida)\s+/u, "").replace(/\b(de|del|dels|la|l|el)\b/gu, " ").replace(/\s+/gu, " ").trim();
function geoapify(log, sent = []) {
  return async url => {
    const p = url.searchParams;
    sent.push(Object.fromEntries([...p].filter(([key]) => key !== "apiKey")));
    if (url.pathname.endsWith("/routing")) {
      log.push("ruta");
      return Response.json({ features: [{ properties: { distance: 12000, time: 1800 } }] });
    }
    const structured = p.has("street");
    const [calleTexto] = (p.get("text") ?? "").split(",");
    const street = structured ? p.get("street") : calleTexto.replace(/\s+\S+$/u, "");
    const portal = structured ? p.get("housenumber") : /\s(\S+)$/u.exec(calleTexto)?.[1];
    log.push((structured ? "estructurada:" : "texto:") + sinTipo(street) + ":" + portal);
    const via = callejero.find(item => sinTipo(item.calle) === sinTipo(street));
    if (!via) return Response.json({ results: [] });
    const base = { country_code: "es", street: via.calle, postcode: via.cp, city: via.ciudad, county: "Girona", lat: via.lat, lon: 2.2 };
    // Como Geoapify: si el portal no existe devuelve la calle (sin portal), que no sirve para calcular.
    if (!via.portales.includes(portal)) return Response.json({ results: [{ ...base, result_type: "street", rank: { confidence: 0.6, match_type: "match_by_street" } }] });
    return Response.json({ results: [{ ...base, housenumber: portal, result_type: "building", rank: { confidence: 0.95, match_type: "full_match" } }] });
  };
}

async function plan(addresses, options) {
  const { addresses: allowed, reasons } = providerPlan(addresses, false);
  const details = reasons.map(reason => reason === "privacy" ? "privacy" : null);
  const diagnostics = [];
  const estimates = await calculateJourney(allowed, { apiKey: "clave-ficticia", manualFreePilot: true, reasons, details, diagnostics,
    charge: async () => true, ...options });
  return { estimates, reasons, details, diagnostics };
}
const casa = "Calle Ficticia 1, 17599, Vilafictícia";

test("jornada como la del 25/11 (4 visitas con los patrones 1-4): se calculan los tramos cuyos extremos se resuelven", async () => {
  const log = [], sent = [];
  const { estimates, details, diagnostics } = await plan([casa,
    oracle("PTGE FICCIO 1"),                       // 1. abreviatura no reconocida antes
    oracle("ROURE 9 A 2º 2º"),                     // 2 y 3. sin tipo, número con letra, piso y puerta
    oracle("CARRER PINS 9", "RIBES DE FICCIO", "17598"), // 4 y 5. sin artículos y municipio sin acento
    oracle("CARRER OLIVERA 9 A BJ"),               // 3. número con letra y bajo
    casa], { fetcher: geoapify(log, sent) });
  // Los 3 tramos entre visitas se calculan; los dos del domicilio quedan por privacidad (sin «Usar mi domicilio»).
  assert.deepEqual(estimates.map(e => e?.durationSeconds ?? null), [null, 1800, 1800, 1800, null]);
  assert.deepEqual(details, ["privacy", null, null, null, "privacy"]);
  assert.deepEqual(diagnostics, [null, null, null, null, null]);
  // «9 A»: primero 9A (estructurada) y, como ese portal no existe, 9 en texto libre: las dos formas en 2 llamadas.
  assert.deepEqual(log, ["estructurada:ficcio:1", "estructurada:roure:9A", "texto:roure:9", "ruta", "estructurada:pins:9", "ruta",
    "estructurada:olivera:9A", "ruta"]);
  // Piso, puerta, escalera y bajo nunca llegan a Geoapify.
  const enviado = JSON.stringify(sent);
  assert.doesNotMatch(enviado, /º|ª|\bBJ\b|\bBj\b|bajo|esc|pta|piso/iu);
  for (const params of sent.filter(params => params.housenumber)) assert.match(params.housenumber, /^\d{1,5}[A-Z]?$/u);
});

test("máximo 2 llamadas por dirección y 0 rutas para tramos con un extremo sin resolver", async () => {
  const log = [];
  await plan([casa, oracle("CARRER INVENTADA 9 A 1º"), oracle("PTGE FICCIO 1"), oracle("CARRER FICCIO S/N"), casa],
    { fetcher: geoapify(log) });
  assert.deepEqual(log, ["estructurada:inventada:9A", "texto:inventada:9", "estructurada:ficcio:1"]);
  const porDireccion = new Map();
  for (const item of log.filter(item => item !== "ruta")) {
    const clave = item.split(":")[1];
    porDireccion.set(clave, (porDireccion.get(clave) ?? 0) + 1);
  }
  for (const [clave, llamadas] of porDireccion) assert.ok(llamadas <= 2, clave);
});

test("texto libre con el portal sin letra; la búsqueda estructurada con la letra", () => {
  const fields = streetFields(oracle("CARRER OLIVERA 9 A 2º"));
  assert.equal(fields.housenumber, "9A");
  assert.equal(freeTextQuery({ ...fields, housenumber: "9" }), "Carrer Olivera 9, 17599 Vilaficticia, Girona, España");
});

test("el portal exacto gana al número sin letra; un número distinto nunca se acepta", () => {
  const fields = streetFields(oracle("CARRER OLIVERA 9 A"));
  const row = changes => ({ country_code: "es", street: "Carrer de l'Olivera", housenumber: "9A", postcode: CP, city: "Vilafictícia",
    lat: 42.13, lon: 2.2, result_type: "building", rank: { confidence: 0.95, match_type: "full_match" }, ...changes });
  assert.deepEqual(chooseCandidate([row({ housenumber: "9", lat: 42.2 }), row()], fields).point, [42.13, 2.2]);
  assert.equal(chooseCandidate([row({ housenumber: "9" })], fields).outcome, "found");
  assert.equal(chooseCandidate([row({ housenumber: "9-11" })], streetFields(oracle("CARRER OLIVERA 10"))).outcome, "found");
  for (const housenumber of ["8", "10", "9B", "19"]) assert.equal(chooseCandidate([row({ housenumber })], fields).outcome, "none", housenumber);
  // Pedido 9 (sin letra): 9A no se acepta.
  assert.equal(chooseCandidate([row()], streetFields(oracle("CARRER OLIVERA 9"))).outcome, "none");
});

// ---------- 4. Códigos de detalle ----------

const fila = changes => ({ country_code: "es", street: "Carrer del Roure", housenumber: "9", postcode: CP, city: "Vilafictícia", lat: 42.2, lon: 2.3,
  result_type: "building", rank: { confidence: 0.95, match_type: "full_match" }, ...changes });

test("cada código de detalle (servidor)", async () => {
  const fields = streetFields(oracle("CARRER ROURE 9"));
  assert.equal(addressDiagnostic([], fields).code, "no_results");
  assert.equal(addressDiagnostic([fila({ street: "Carrer del Freixe" })], fields).code, "street_mismatch");
  assert.equal(addressDiagnostic([fila({ city: "Altrepoble", postcode: "17000" })], fields).code, "municipality_mismatch");
  assert.equal(addressDiagnostic([fila({ city: undefined, postcode: "17000" })], fields).code, "postcode_mismatch");
  assert.equal(addressDiagnostic([fila({ housenumber: "11" })], fields).code, "number_mismatch");
  assert.equal(addressDiagnostic([fila({ street: "Carrer del Freixe" }), fila({ housenumber: "11" })], fields).code, "number_mismatch",
    "cuenta el resultado más cercano");
  const run = async (address, rows) => (await plan([casa, oracle("PTGE FICCIO 1"), address, casa], {
    fetcher: async url => url.pathname.endsWith("/routing")
      ? Response.json({ features: [{ properties: { distance: 1, time: 1 } }] })
      : Response.json({ results: url.searchParams.get("street")?.includes("Ficcio") || url.searchParams.get("text")?.includes("Ficcio")
        ? [{ ...fila({ street: "Passatge de la Ficció", housenumber: "1", lat: 42.1 }) }] : rows }),
  }));
  const casos = {
    no_results: [oracle("CARRER ROURE 9"), []],
    street_mismatch: [oracle("CARRER ROURE 9"), [fila({ street: "Carrer del Freixe" })]],
    municipality_mismatch: [oracle("CARRER ROURE 9"), [fila({ city: "Altrepoble", postcode: "17000" })]],
    postcode_mismatch: [oracle("CARRER ROURE 9"), [fila({ city: undefined, postcode: "17000" })]],
    number_mismatch: [oracle("CARRER ROURE 9"), [fila({ housenumber: "11" })]],
    ambiguous: [oracle("CARRER ROURE 9"), [fila(), fila({ lat: 42.4 })]],
    missing_number: [oracle("CARRER ROURE S/N"), []],
    missing_street: ["17599, VILAFICTICIA", []],
  };
  assert.deepEqual(Object.keys(casos).sort(), [...ADDRESS_DIAGNOSTICS].sort());
  assert.deepEqual([...addressDiagnostics].sort(), [...ADDRESS_DIAGNOSTICS].sort(), "la app y el servidor comparten los códigos");
  for (const [codigo, [address, rows]] of Object.entries(casos)) {
    const { diagnostics, details } = await run(address, rows);
    assert.equal(diagnostics[1], codigo, codigo);
    assert.ok(LEG_DETAILS.includes(details[1]), codigo + " conserva su motivo");
    assert.deepEqual([diagnostics[0], diagnostics[2]], [null, null], codigo);
  }
  // El tramo siguiente («la otra dirección…») lleva el código de la dirección que lo bloquea.
  const siguiente = await plan([casa, oracle("PTGE FICCIO 1"), oracle("CARRER INVENTADA 9"), oracle("CARRER ROURE 9"), casa],
    { fetcher: geoapify([]) });
  assert.deepEqual(siguiente.details, ["privacy", "street_not_found", "other_end", "privacy"]);
  assert.equal(siguiente.diagnostics[1], "no_results");
  assert.equal(siguiente.diagnostics[2], "no_results");
});

test("los códigos de detalle no contienen direcciones, respuestas del proveedor ni coordenadas", async () => {
  const { estimates, reasons, details, diagnostics } = await plan(
    [casa, oracle("PTGE FICCIO 1"), oracle("CARRER INVENTADA 9 A 2º"), oracle("ROURE 9 A 2º 2º"), oracle("CARRER ROURE S/N"), casa],
    { fetcher: geoapify([]) });
  const body = JSON.stringify({ estimates, reasons, details, diagnostics });
  assert.doesNotMatch(body, /42\.1|Carrer|Roure|Ficci|Inventada|Passatge|lat"|lon"|17599/);
  for (const code of diagnostics) assert.ok(code === null || ADDRESS_DIAGNOSTICS.includes(code));
});

// ---------- 5. App: detalle bajo el motivo, «S/N» y compatibilidad ----------

const prefs = { home: { street: "Calle Ficticia", number: "1", municipality: "Vilafictícia", postalCode: CP }, keys: null, tourline: null, margin: 10 };
const cita = (id, hora, fin, calle) => ({ id, scheduled_time: hora, scheduled_end_time: fin, full_address: calle,
  postal_code: CP, population: "VILAFICTICIA", status: "pending" });
const citas = [cita("a", "09:00", "10:00", "PTGE FICCIO 1"), cita("b", "11:00", "12:00", "ROURE 9 A 2º 2º"),
  cita("c", "13:00", "14:00", "CARRER INVENTADA 9 A 2º"), cita("e", "15:00", "16:00", "CARRER OLIVERA 9 A BJ"),
  cita("d", "17:00", "18:00", "CARRER ROURE S/N")];

// Servidor simulado con las mismas funciones que index.ts. `legacy` imita la función v11 (sin `diagnostics`).
function fakeServer(log, sent, { legacy = false } = {}) {
  return async body => {
    let addresses;
    try { addresses = journeyAddresses(prefs, citas, [], parseActivityEdits(body.edits)); }
    catch { return { data: null, error: { status: 400 } }; }
    if (await journeyFingerprint(addresses) !== body.fingerprint) return { data: null, error: { status: 409 } };
    const { addresses: allowed, reasons } = providerPlan(addresses, homeOptIn(body));
    const details = reasons.map(reason => reason === "privacy" ? "privacy" : null);
    const diagnostics = [];
    const estimates = await calculateJourney(allowed, {
      apiKey: "clave-ficticia", manualFreePilot: true, reasons, details, ...(legacy ? {} : { diagnostics }),
      charge: async () => true, fetcher: geoapify(log, sent),
    });
    const data = { estimates, reasons, details: estimates.map((_, i) => details[i] ?? null) };
    if (!legacy) data.diagnostics = estimates.map((_, i) => diagnostics[i] ?? null);
    return { data, error: null };
  };
}

async function mountApp({ legacy = false } = {}) {
  const { panel, get } = fakePanel();
  const actor = { id: "tecnico-ficticio", role: "technician" };
  const log = [], sent = [], responses = [];
  const server = fakeServer(log, sent, { legacy });
  const provider = createCloudRoutes({ getActor: () => actor, invoke: async (name, { body }) => {
    if (body.operation) return { data: null, error: null };
    const response = await server(body);
    responses.push(response);
    return response;
  } });
  const ui = mountMyRoutes({ panel, agenda: { hidden: false }, getActor: () => actor, getDate: () => "2026-11-25", provider,
    preferencesStore: { read: async () => prefs, write: async () => {}, clear() {} },
    loadActivities: async () => ({ appointments: citas, ignored: [] }) });
  ui.sync();
  get("Tab").events.click();
  await settle();
  await get("Calculate").events.click();
  await settle(14);
  return { get, list: texts(get("List")).join("\n"), log, sent, responses };
}

const nodes = (node, out = []) => { for (const child of node.children ?? []) { out.push(child); nodes(child, out); } return out; };

test("pantalla: «detalle: <código>» discreto bajo el motivo y motivo claro para «S/N»", async () => {
  const { get, list, sent } = await mountApp();
  assert.match(list, /Motivo: Geoapify no encuentra esta calle en ese municipio\.\ndetalle: no_results\nCorrígela en «Editar desplazamiento» de esta actividad/);
  assert.match(list, /Motivo: La otra dirección del tramo no se encontró\.\ndetalle: no_results\n/);
  assert.match(list, /Motivo: Dirección sin número: corrígela en «Editar desplazamiento»\.\ndetalle: missing_number/);
  assert.match(list, /Conducción total \(1 de 6 tramos\): 30 min · 12 km/);
  const detalles = nodes(get("List")).filter(node => /^detalle: /.test(node.textContent));
  assert.ok(detalles.length >= 3);
  for (const node of detalles) assert.equal(node.className, "fine");
  assert.doesNotMatch(JSON.stringify(sent), /º|ª/);
});

test("compatibilidad: la web nueva con la función v11 (sin `diagnostics`) no muestra detalle y no falla", async () => {
  const { list, responses } = await mountApp({ legacy: true });
  assert.equal(Object.hasOwn(responses[0].data, "diagnostics"), false);
  assert.doesNotMatch(list, /detalle:/);
  assert.match(list, /Motivo: Geoapify no encuentra esta calle en ese municipio\./);
  assert.match(list, /Conducción total \(1 de 6 tramos\)/);
});

test("compatibilidad: la función nueva solo añade el campo opcional `diagnostics`; códigos desconocidos se descartan", async () => {
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, [], prefs));
  const response = await fakeServer([], [])({ date: "2026-11-25", fingerprint: await routeFingerprint(legs), expectedActor: "tecnico-ficticio" });
  assert.deepEqual(Object.keys(response.data).sort(), ["details", "diagnostics", "estimates", "reasons"]);
  const legacy = new Set(["privacy", "incomplete", "not_found", "no_route"]);
  assert.ok(response.data.reasons.every(reason => reason === null || legacy.has(reason)));
  const cloud = createCloudRoutes({ getActor: () => ({ id: "tecnico-ficticio", role: "technician" }),
    invoke: async () => ({ data: { ...response.data, diagnostics: ["raro", ...response.data.diagnostics.slice(1)] }, error: null }) });
  const estimates = await cloud.estimateJourney(legs, { date: "2026-11-25" });
  assert.equal(estimates.diagnostics[0], null, "un código desconocido se descarta");
  assert.equal(estimates.diagnostics.length, legs.length);
});
