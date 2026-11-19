import test from "node:test";
import assert from "node:assert/strict";
import { parseOracleInstallations } from "./agenda-parser.mjs";

const services = ["Mantenimiento", "Avería", "Reparación", "Revisión", "Inspección"]
  .map(type => type + " Kit Hogar");
const block = (hour, type, prospect) =>
  `${hour}:00 - ${hour}:30 Tipo: ${type} Panel: Central - Municipio de prueba - Calle Ficticia 5 CP: 28001 Mto: ${prospect}`;

test("un servicio con palabra de instalación se conserva pero queda fuera del lote", () => {
  const input = [block("09", "Instalación Kit Hogar", 101),
    ...services.map((type, i) => block(String(10 + i), type, 102 + i))].join("\n");
  const result = parseOracleInstallations(input);
  assert.deepEqual(result.installations.map(row => row.prospect_ref), ["101"]);
  assert.deepEqual(result.ignored.map(row => row.type), services);
  assert.deepEqual(result.ignored.map(row => row.time), ["10:00", "11:00", "12:00", "13:00", "14:00"]);
  assert.ok(result.ignored.every(row => row.full_address === "Calle Ficticia 5"));
});

test("las palabras configuradas se recortan y siguen la misma normalización que el RPC", () => {
  const input = block("09", "Instalación Kit Básico", 101);
  assert.equal(parseOracleInstallations(input, ["   KÍT BÁSICO   ", null, " "]).installations.length, 1);
  assert.equal(parseOracleInstallations(input, [" "]).installations.length, 0);
});

test("fin validado de una instalación y una intervención ignorada", () => {
  const input = "19/11/2026 " + [
    block("09", "Instalación Kit Hogar", 101).replace("09:00 - 09:30", "9:00 - 9:30"),
    block("11", "Comida Alianzas", 102),
    block("12", "Mantenimiento", 103).replace("12:00 - 12:30", "12:00 - 25:30"),
    block("23", "Inspección Kit Hogar", 104).replace("23:00 - 23:30", "23:00 - 0:30"),
  ].join("\n");
  const parsed = parseOracleInstallations(input);
  assert.equal(parsed.installations[0].time, "09:00");
  assert.equal(parsed.installations[0].end_time, "09:30");
  assert.equal(parsed.installations[0].work_date, undefined);
  assert.deepEqual(parsed.ignored.map(row => [row.time, row.end_time]), [
    ["11:00", "11:30"], ["12:00", undefined], ["23:00", undefined],
  ]);
});
