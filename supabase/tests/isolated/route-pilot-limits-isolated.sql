-- Prueba SQL aislada de 20261127090000_route_pilot_limits_1000.sql (CONFIRMAR_CITAS-025).
-- ESCRITA Y NO EJECUTADA. Nunca contra el proyecto real.
-- Requisitos: una base local o desechable con el esquema de rutas y piloto de la V2 (RPC de 20261120050000,
-- 20261125090000 ya aplicada y sus tablas, con la fila única de route_pilot_budget y route_budget_lock) y la
-- migración 20261127090000 recién aplicada. Ejecutar con psql:
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f route-pilot-limits-isolated.sql
-- Todo ocurre dentro de una transacción que termina en ROLLBACK. Identificadores ficticios.

begin;

update confirmar_citas.route_pilot_budget
  set stopped = false, quota_verified_at = clock_timestamp(), external_usage = 0,
      actor = null, lease = null, operation = null, last_error = null, last_error_at = null
  where singleton is true;
delete from confirmar_citas.route_pilot_reservation;
delete from confirmar_citas.route_budget_reservation;
delete from confirmar_citas.route_budget_cooldown;
delete from confirmar_citas.route_budget_autocomplete_cooldown;
update confirmar_citas.route_budget_lock
  set lease = null, lease_until = null, paused_until = clock_timestamp() - interval '1 hour',
      last_charge = clock_timestamp() - interval '1 hour'
  where singleton is true;

do $test$
declare
  tecnico uuid := '00000000-0000-4000-8000-00000000000a';
  lease uuid := '00000000-0000-4000-8000-0000000000a1';
  status jsonb;
begin
  status := public.cc_route_pilot_status();
  assert (status->>'creditsLimit24h')::int = 1000, 'tope de créditos';
  assert (status->>'routingRequestsLimit24h')::int = 200, 'tope de consultas';

  -- Tope de seguridad.
  begin
    update confirmar_citas.route_pilot_limits set credits_24h = 2501 where singleton;
    raise exception 'se admitió un tope por encima de 2500';
  exception when check_violation then null;
  end;
  begin
    update confirmar_citas.route_pilot_limits set routing_24h = credits_24h + 1 where singleton;
    raise exception 'se admitieron más consultas que créditos';
  exception when check_violation then null;
  end;

  -- 200 consultas de ruta: no empieza otra ruta; el autocompletado sí.
  insert into confirmar_citas.route_pilot_reservation(charged_at, credits, routing)
    select clock_timestamp(), 2, true from generate_series(1, 200);
  assert not public.cc_route_pilot_begin(tecnico, lease, 'route'), 'no se admite la consulta 201';
  assert public.cc_route_pilot_begin(tecnico, lease, 'autocomplete'), 'quedan créditos';
  assert not public.cc_route_pilot_charge(tecnico, lease, 1, true), 'no se cobra una consulta de ruta más';
  perform public.cc_route_budget_end(lease);

  -- 1000 créditos: no empieza ninguna operación.
  insert into confirmar_citas.route_pilot_reservation(charged_at, credits, routing)
    select clock_timestamp(), 2, false from generate_series(1, 300);
  assert not public.cc_route_pilot_begin(tecnico, gen_random_uuid(), 'autocomplete'), 'tope de créditos';
end
$test$;

do $acl$
begin
  assert not has_table_privilege('service_role', 'confirmar_citas.route_pilot_limits', 'select,insert,update,delete'), 'tabla cerrada';
  assert not has_function_privilege('authenticated', 'public.cc_route_pilot_status()', 'execute'), 'solo service_role';
  assert has_function_privilege('service_role', 'public.cc_route_pilot_status()', 'execute'), 'service_role';
end
$acl$;

rollback;
