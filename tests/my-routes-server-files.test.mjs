// Comprobaciones estáticas (sin red ni Supabase) del servidor y las migraciones de Mis rutas. CONFIRMAR_CITAS-006.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../supabase/", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("la función libera la reserva del piloto en el finally, después del informe y antes de cerrar la lease", async () => {
  const source = await read("functions/my-routes-estimate/index.ts");
  const block = source.slice(source.lastIndexOf("} finally {"));
  const report = block.indexOf("cc_route_pilot_report");
  const release = block.indexOf("cc_route_pilot_end");
  const end = block.indexOf("cc_route_budget_end");
  assert.ok(report > 0 && release > report && end > release, "orden esperado: report → pilot_end → budget_end");
  assert.match(block, /cc_route_pilot_end", \{ p_actor: auth\.user\.id, p_lease: lease \}/);
});

test("la migración de referencia está marcada como ya aplicada y no puede ejecutarse por accidente", async () => {
  const sql = await read("migrations/20261120050000_route_pilot_applied_reference.sql");
  assert.match(sql.split("\n").slice(0, 3).join("\n"), /YA APLICADA en producción el 20\/11\/2026; solo referencia, no ejecutar/);
  const guard = sql.indexOf("raise exception");
  assert.ok(guard > 0 && guard < sql.indexOf("CREATE OR REPLACE FUNCTION"), "la guarda debe ir antes de cualquier definición");
  for (const name of ["cc_route_pilot_begin", "cc_route_pilot_charge", "cc_route_pilot_configure", "cc_route_pilot_report", "cc_route_pilot_status", "route_pilot_usage"]) {
    assert.match(sql, new RegExp("FUNCTION (public|confirmar_citas)\\." + name + "\\("));
  }
});

test("la migración de corrección libera la reserva, respeta el orden de bloqueo y solo la usa service_role", async () => {
  const sql = await read("migrations/20261125090000_route_pilot_release_lease.sql");
  assert.match(sql, /PENDIENTE DE APLICAR/);
  assert.match(sql, /function public\.cc_route_pilot_end\(p_actor uuid, p_lease uuid\)/);
  const end = sql.slice(sql.indexOf("function public.cc_route_budget_end"), sql.indexOf("function public.cc_route_pilot_begin"));
  assert.ok(end.indexOf("route_pilot_budget") < end.indexOf("route_budget_lock"), "primero la fila del piloto");
  for (const name of ["cc_route_pilot_end", "cc_route_budget_end", "cc_route_pilot_begin"]) {
    assert.match(sql, new RegExp("revoke all on function public\\." + name + "\\([^)]*\\) from public, anon, authenticated"));
    assert.match(sql, new RegExp("grant execute on function public\\." + name + "\\([^)]*\\) to service_role"));
  }
  assert.match(sql, /pilot\.actor <> p_actor and held/);
  const isolated = await read("tests/isolated/route-pilot-release-isolated.sql");
  assert.match(isolated, /^begin;/m);
  assert.match(isolated, /^rollback;/m);
});
