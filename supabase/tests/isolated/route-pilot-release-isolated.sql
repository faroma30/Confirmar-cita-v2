-- Prueba SQL aislada de 20261125090000_route_pilot_release_lease.sql (CONFIRMAR_CITAS-006).
-- ESCRITA Y NO EJECUTADA. Nunca contra el proyecto real.
-- Requisitos: una base local o desechable con el esquema de rutas y piloto de la V2
-- (las RPC de 20261120050000_route_pilot_applied_reference.sql y sus tablas, con la fila
-- única de route_pilot_budget y route_budget_lock). Ejecutar con psql desde esta carpeta:
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f route-pilot-release-isolated.sql
-- Todo ocurre dentro de una transacción que termina en ROLLBACK. Identificadores ficticios.

begin;

\ir ../../migrations/20261125090000_route_pilot_release_lease.sql

-- Estado de partida: piloto activo, sin reservas ni pausas.
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
  tecnico_a uuid := '00000000-0000-4000-8000-00000000000a';
  tecnico_b uuid := '00000000-0000-4000-8000-00000000000b';
  lease_a uuid := '00000000-0000-4000-8000-0000000000a1';
  lease_b uuid := '00000000-0000-4000-8000-0000000000b1';
  lease_a2 uuid := '00000000-0000-4000-8000-0000000000a2';
  pilot record;
begin
  -- 1. A reserva el piloto para una ruta.
  assert public.cc_route_pilot_begin(tecnico_a, lease_a, 'route'), 'A debería poder empezar';
  select actor, lease into pilot from confirmar_citas.route_pilot_budget where singleton is true;
  assert pilot.actor = tecnico_a and pilot.lease = lease_a, 'la reserva debería ser de A';

  -- 2. Mientras la lease de A está viva, B no puede empezar.
  assert not public.cc_route_pilot_begin(tecnico_b, lease_b, 'autocomplete'), 'B no debería empezar con A en curso';

  -- 3. Al terminar (finally de la función): cc_route_pilot_end y cc_route_budget_end liberan la reserva.
  assert not public.cc_route_pilot_end(tecnico_b, lease_a), 'otro actor no puede liberar la reserva de A';
  assert public.cc_route_pilot_end(tecnico_a, lease_a), 'A libera su reserva';
  perform public.cc_route_budget_end(lease_a, false);
  select actor, lease into pilot from confirmar_citas.route_pilot_budget where singleton is true;
  assert pilot.actor is null and pilot.lease is null, 'la reserva del piloto debería quedar libre';

  -- 4. Ahora B sí puede empezar (antes del arreglo recibía false → 429).
  assert public.cc_route_pilot_begin(tecnico_b, lease_b, 'autocomplete'), 'B debería poder empezar tras liberar A';

  -- 5. Proceso cortado sin finally: la lease de B caduca y la reserva del piloto queda colgada.
  update confirmar_citas.route_budget_lock set lease_until = clock_timestamp() - interval '1 second'
    where singleton is true;
  assert public.cc_route_pilot_begin(tecnico_a, lease_a2, 'autocomplete'), 'una reserva caducada no debe bloquear a A';

  -- 6. cc_route_budget_end por sí solo (función v8 sin cc_route_pilot_end) también libera el piloto.
  perform public.cc_route_budget_end(lease_a2, false);
  select actor, lease into pilot from confirmar_citas.route_pilot_budget where singleton is true;
  assert pilot.actor is null and pilot.lease is null, 'cc_route_budget_end debería liberar la reserva del piloto';

  -- 7. El piloto parado sigue bloqueando a todos.
  update confirmar_citas.route_pilot_budget set stopped = true where singleton is true;
  update confirmar_citas.route_budget_lock set last_charge = clock_timestamp() - interval '1 hour' where singleton is true;
  delete from confirmar_citas.route_budget_autocomplete_cooldown;
  assert not public.cc_route_pilot_begin(tecnico_b, gen_random_uuid(), 'autocomplete'), 'con el piloto parado no se empieza';

  raise notice 'route-pilot-release-isolated: OK';
end
$test$;

rollback;
