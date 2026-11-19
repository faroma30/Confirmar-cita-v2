import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOracleInstallations, stableSourceKey } from "./agenda-parser.mjs";
import { compareImportedAppointment } from "./agenda-parity.mjs";
import { combineActivities } from "./my-routes.mjs";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const handler = app.slice(app.indexOf("const oracleImportErrors"), app.indexOf("async function loadMasterAppointments()"));
const source = [
  ["09:00", "10:00", "Instalación Kit Hogar"],
  ["08:00", "08:30", "Tourline"],
  ["11:00", "11:45", "Instalación Kit Premium"],
  ["10:00", "10:30", "Valoración"],
  ["12:00", "12:30", "Comida"],
  ["13:00", "13:45", "Mantenimiento Kit Hogar"],
].map(([start, end, type], i) => `${start} - ${end} Tipo: ${type} Panel: Central - Municipio de prueba - Calle Sintética ${i+1} CP: 28001 Mto: ${i+1}`).join("\n");

function setup(value = source, resultOf = () => ({ data: 2, error: null, status: 200 })) {
  const input = { value };
  const notices = [];
  const calls = [];
  const teams = [{ id: "team" }];
  const changes = new Map();
  const deps = {
    $: () => input, appointmentNotice: (message, kind) => notices.push({ message, kind }),
    setVisible: () => {}, parseOracleInstallations, stableSourceKey, compareImportedAppointment,
    appointmentDate: "2026-11-20", selectedAppointmentTeam: "team", appointmentTeams: teams,
    appointmentPreferences: {}, activeUser: { id: "synthetic" }, appointmentIdentityIndex: [],
    matchesAppointment: () => false, importChangesBySource: changes, loadOwnAppointments: async () => true,
    supabase: { async rpc(name, args) { calls.push({ name, args }); return resultOf(); } },
  };
  return { input, notices, calls, run: new Function(...Object.keys(deps), handler + "\nreturn processOracleText;")(...Object.values(deps)) };
}

test("la importación real envía las seis actividades juntas y conserva dirección, tipo e intervalo", async () => {
  const { run, calls, input, notices } = setup();
  await run();
  assert.equal(input.value, "");
  assert.equal(notices.at(-1).kind, "success");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "cc_import_oracle_agenda");
  const { p_installations: installations, p_ignored: ignored } = calls[0].args;
  assert.equal(installations.length, 2);
  assert.equal(ignored.length, 4);
  assert.ok([...installations, ...ignored].every(row => row.full_address && row.end_time));
  const agenda = combineActivities(installations.map(row => ({ ...row, id: row.source_key })), ignored);
  assert.deepEqual(agenda.map(row => row.time), ["08:00","09:00","10:00","11:00","12:00","13:00"]);
  assert.equal(agenda.find(row => row.type === "Comida").travel, "pause");
  input.value = source;
  await run();
  assert.deepEqual(calls[1], calls[0]);
});

test("un rechazo conserva el texto y solo muestra valores técnicos seguros", async () => {
  const { run, calls, input, notices } = setup(source, () => ({ status: 400, error: {
    code: "22023", message: "invalid installation import", details: "DATO PRIVADO", hint: "DATO PRIVADO",
  } }));
  await run();
  assert.equal(calls.length, 1);
  assert.equal(input.value, source);
  assert.match(notices.at(-1).message, /HTTP 400 · 22023/);
  assert.doesNotMatch(notices.at(-1).message, /DATO PRIVADO/);
});

test("un fallo inesperado y un texto sin actividades no provocan una importación vacía", async () => {
  const missing = setup("texto ajeno a Oracle");
  await missing.run();
  assert.deepEqual(missing.calls, []);
  assert.equal(missing.input.value, "texto ajeno a Oracle");
  const broken = setup(source, () => { throw Error("DATO PRIVADO"); });
  await broken.run();
  assert.equal(broken.input.value, source);
  assert.equal(broken.notices.at(-1).kind, "error");
  assert.doesNotMatch(broken.notices.at(-1).message, /DATO PRIVADO/);
});

test("dos pulsaciones simultáneas solo hacen un intento", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { run, calls } = setup(source, () => gate);
  const first = run();
  await run();
  release({ data: 2, status: 200 });
  await first;
  assert.equal(calls.length, 1);
});
