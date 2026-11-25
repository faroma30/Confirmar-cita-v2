// CONFIRMAR_CITAS-007: «stop» del piloto solo para el Administrador. Datos ficticios, sin red ni Supabase.
// La Edge Function (Deno) no se ejecuta aquí: se prueba su módulo de decisión y, de forma estática, su uso en index.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PILOT_STOP_FORBIDDEN, canStopPilot, pilotStopRejection } from "../supabase/functions/my-routes-estimate/pilot-control.mjs";

const claims = { iat: 2_000_000_000 };
const perfil = role => ({ role, status: "active", must_change_password: false, activation_verified_at: "2026-10-01T08:00:00Z", sessions_invalid_before: null });
const rpc = data => async () => ({ data, error: null });

test("técnico: el servidor rechaza «stop» con 403 y mensaje claro", async () => {
  const rejection = await pilotStopRejection(rpc(perfil("technician")), claims);
  assert.equal(rejection.status, 403);
  assert.equal(rejection.body.error, PILOT_STOP_FORBIDDEN);
  assert.equal(rejection.body.code, "admin_only");
  assert.match(PILOT_STOP_FORBIDDEN, /^Solo el administrador puede desactivar el piloto/);
});

test("Master: se trata como técnico (ROLES_Y_PERMISOS: no gestiona configuración global) → 403", async () => {
  assert.equal((await pilotStopRejection(rpc(perfil("master")), claims)).status, 403);
});

test("Administrador activo: «stop» permitido", async () => {
  assert.equal(await pilotStopRejection(rpc(perfil("admin")), claims), null);
  assert.equal(canStopPilot(perfil("admin"), claims), true);
});

test("Administrador no válido: inactivo, sin activar, contraseña pendiente o sesión invalidada → 403", async () => {
  for (const cambio of [{ status: "disabled" }, { must_change_password: true }, { activation_verified_at: null },
    { sessions_invalid_before: 2_000_000_100 }]) {
    assert.equal((await pilotStopRejection(rpc({ ...perfil("admin"), ...cambio }), claims)).status, 403, JSON.stringify(cambio));
  }
  assert.equal((await pilotStopRejection(rpc(null), claims)).status, 403);
});

test("si no se puede leer el perfil, 503 sin tocar el piloto", async () => {
  assert.equal((await pilotStopRejection(async () => ({ data: null, error: { code: "PGRST" } }), claims)).status, 503);
  assert.equal((await pilotStopRejection(async () => { throw new Error("sin red"); }, claims)).status, 503);
});

test("index.ts comprueba el rol antes de parar el piloto y «status» no cambia", async () => {
  const source = await readFile(new URL("../supabase/functions/my-routes-estimate/index.ts", import.meta.url), "utf8");
  const stopBranch = source.indexOf('if (input.operation === "stop") {');
  const check = source.indexOf('pilotStopRejection(() => auth.client.rpc("cc_my_profile"), auth.claims)');
  const configure = source.indexOf("cc_route_pilot_configure");
  assert.ok(stopBranch > source.indexOf("auth.user.id !== input.expectedActor"), "después de validar la sesión");
  assert.ok(stopBranch < check && check < configure, "rol comprobado antes de cc_route_pilot_configure");
  assert.ok(configure < source.indexOf("routeAccess(Deno.env"), "el Administrador no necesita estar en la lista de técnicos");
  assert.equal(source.split("cc_route_pilot_configure").length, 2, "una sola llamada a configure (la del Administrador)");
  assert.match(source, /const control = input\.operation === "status" \|\| input\.operation === "stop";/);
  assert.match(source, /const status = await backend\.rpc\("cc_route_pilot_status"\);/);
});
