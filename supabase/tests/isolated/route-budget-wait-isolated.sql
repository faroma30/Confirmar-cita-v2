-- Prueba SQL aislada de 20261127120000_route_budget_wait.sql (CONFIRMAR_CITAS-026).
-- ESCRITA Y NO EJECUTADA. Nunca contra el proyecto real.
-- Requisitos: base local o desechable con el esquema de rutas de la V2 y la migración recién aplicada.
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f route-budget-wait-isolated.sql
-- Todo ocurre dentro de una transacción que termina en ROLLBACK. Identificadores ficticios.

begin;

delete from confirmar_citas.route_budget_reservation;
delete from confirmar_citas.route_budget_cooldown;
update confirmar_citas.route_budget_lock
  set lease = null, lease_until = null, paused_until = clock_timestamp() - interval '1 hour'
  where singleton is true;

do $test$
declare
  tecnico uuid := '00000000-0000-4000-8000-00000000000a';
  otro uuid := '00000000-0000-4000-8000-00000000000b';
  estado jsonb;
begin
  estado := public.cc_route_budget_wait(tecnico);
  assert estado = '{"waitSeconds":0,"busy":false,"paused":false,"sharedLimit":false}'::jsonb, 'sin espera';
  insert into confirmar_citas.route_budget_cooldown(actor, started_at)
    values (tecnico, clock_timestamp() - interval '40 seconds');
  assert (public.cc_route_budget_wait(tecnico)->>'waitSeconds')::int between 1 and 80, 'faltan unos 80 s';
  assert (public.cc_route_budget_wait(otro)->>'waitSeconds')::int = 0, 'la espera es de cada técnico';
  insert into confirmar_citas.route_budget_reservation(charged_at, credits)
    values (clock_timestamp() - interval '1 minute', 2500);
  assert (public.cc_route_budget_wait(otro)->>'sharedLimit')::boolean, 'cupo compartido agotado';
  assert not has_function_privilege('authenticated', 'public.cc_route_budget_wait(uuid)', 'execute'), 'solo service_role';
  assert not has_function_privilege('anon', 'public.cc_route_budget_wait(uuid)', 'execute'), 'solo service_role';
end
$test$;

rollback;
