// Diagnóstico CONFIRMAR_CITAS-004: ¿coincide la huella de la jornada que calcula la PWA publicada (main 3routes11)
// con la que recalcula el servidor DESPLEGADO en Supabase (my-routes-estimate v8, CONFIRMAR_CITAS-005)?
// Si no coincide, ese servidor respondería 409 «Los datos de la ruta han cambiado». Datos 100 % ficticios.
import test from "node:test";
import assert from "node:assert/strict";
import { buildLegs, combineActivities, formatRouteLocation } from "../my-routes.mjs";
import { routeFingerprint } from "../my-routes-cloud.mjs";
import { journeyAddresses, journeyFingerprint } from "../supabase/functions/my-routes-estimate/core.mjs";

const casa = { street: "Calle Ficticia", number: "1", municipality: "Villaficticia", postalCode: "00001" };
const llaves = { street: "Avenida Inventada", number: "2", municipality: "Villaficticia", postalCode: "00001" };
const tour = { street: "Plaza Imaginaria", number: "3", municipality: "Villaficticia", postalCode: "00001" };
const cita = (id, hora, calle) => ({ id, scheduled_time: hora, full_address: calle, postal_code: "00001", population: "Villaficticia", status: "pending" });
const otra = (tipo, hora, calle = "") => ({ type: tipo, time: hora, full_address: calle, postal_code: calle ? "00001" : "", population: calle ? "Villaficticia" : "" });

async function huellas(prefs, citas, otras) {
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, otras, prefs, new Map()));
  const pwa = legs.length ? await routeFingerprint(legs) : null;
  const servidor = await journeyFingerprint(journeyAddresses(prefs, citas, otras));
  return { pwa, servidor };
}

const escenarios = {
  "solo instalaciones Oracle": [{ home: casa, keys: null, tourline: null }, [cita("a", "09:00", "Calle Uno 10"), cita("b", "11:00", "Calle Dos 20")], []],
  "domicilio con provincia": [{ home: { ...casa, province: "Provincia Ficticia" }, keys: null, tourline: null }, [cita("a", "09:00", "Calle Uno 10"), cita("b", "11:00", "Calle Dos 20")], []],
  "recogida de llaves con dirección propia en la agenda": [{ home: casa, keys: llaves, tourline: null }, [cita("a", "11:00", "Calle Uno 10")], [otra("Recogida de llaves", "09:00", "Calle Agenda 5")]],
  "Tourline Alianzas sin dirección en la agenda": [{ home: casa, keys: null, tourline: tour }, [cita("a", "11:00", "Calle Uno 10")], [otra("Tourline Alianzas", "09:00")]],
  "pausa con texto extra (pausa por defecto, CONFIRMAR_CITAS-016)": [{ home: casa, keys: null, tourline: null }, [cita("a", "09:00", "Calle Uno 10"), cita("b", "13:00", "Calle Dos 20")], [otra("Pausa comida larga", "11:00")]],
};

for (const [nombre, [prefs, citas, otras]] of Object.entries(escenarios)) {
  test("paridad de huella: " + nombre, async () => {
    const { pwa, servidor } = await huellas(prefs, citas, otras);
    assert.equal(pwa, servidor, "la PWA y el servidor calculan jornadas distintas (el servidor respondería 409)");
  });
}


// CONFIRMAR_CITAS-005: escenarios con `edits` (las mismas ediciones que la PWA enviaría en el cuerpo).
import { parseActivityEdits } from "../supabase/functions/my-routes-estimate/policy.mjs";
async function huellasConEdits(prefs, citas, otras, elegir) {
  const base = combineActivities(citas, otras, prefs, new Map());
  const entries = elegir(base);
  const legs = buildLegs(formatRouteLocation(prefs.home), combineActivities(citas, otras, prefs, new Map(entries)));
  const pwa = legs.length ? await routeFingerprint(legs) : null;
  const servidor = await journeyFingerprint(journeyAddresses(prefs, citas, otras, parseActivityEdits(entries)));
  return { pwa, servidor };
}
const lugar = { street: "Calle Escrita", number: "7", municipality: "Villaficticia", postalCode: "00001" };
const conEdits = {
  "pausa pendiente convertida en desplazamiento con dirección manual": [[{ home: casa, keys: null, tourline: null }, [cita("a", "09:00", "Calle Uno 10"), cita("b", "13:00", "Calle Dos 20")], [otra("Pausa comida larga", "11:00")]],
    base => base.filter(a => a.editableTravel).map(a => [a.key, { travel: "travel", location: lugar }])],
  "pausa pendiente marcada como pausa": [[{ home: casa, keys: null, tourline: null }, [cita("a", "09:00", "Calle Uno 10"), cita("b", "13:00", "Calle Dos 20")], [otra("Pausa comida larga", "11:00")]],
    base => base.filter(a => a.editableTravel).map(a => [a.key, { travel: "pause", location: null }])],
};
for (const [nombre, [[prefs, citas, otras], elegir]] of Object.entries(conEdits)) {
  test("paridad de huella con edits: " + nombre, async () => {
    const { pwa, servidor } = await huellasConEdits(prefs, citas, otras, elegir);
    assert.equal(pwa, servidor, "la PWA y el servidor calculan jornadas distintas (el servidor respondería 409)");
  });
}
