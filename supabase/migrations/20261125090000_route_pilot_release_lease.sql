-- =====================================================================================
-- PENDIENTE DE APLICAR (CONFIRMAR_CITAS-006). Escrita y NO ejecutada. Solo Supabase de la V2
-- (no es el de Controla). Aplicar únicamente con autorización registrada.
-- =====================================================================================
-- Problema: cc_route_pilot_begin asigna la fila única del piloto (actor, lease, operation)
-- al técnico que calcula, pero nada la libera al terminar. Después, cualquier otro técnico
-- recibe false en cc_route_pilot_begin (429 «Cuota temporal alcanzada») aunque el piloto
-- esté activo.
-- Corrección:
--   1. cc_route_pilot_end(p_actor, p_lease): libera la reserva del piloto si sigue siendo la
--      de ese actor y esa lease. La llama la Edge Function al terminar o fallar.
--   2. cc_route_budget_end: también libera la reserva del piloto de esa lease (así funciona
--      aunque la Edge Function desplegada siga siendo la v8). Respeta el orden de bloqueo
--      de cc_route_pilot_begin/charge: primero la fila del piloto, después route_budget_lock.
--   3. cc_route_pilot_begin: una reserva del piloto cuya lease ya no está viva en
--      route_budget_lock (proceso cortado sin finally) no bloquea a otro técnico.
--   4. Limpieza única de la reserva colgada que haya al aplicar.
-- Prueba aislada (escrita, no ejecutada): supabase/tests/isolated/route-pilot-release-isolated.sql
-- =====================================================================================

create or replace function public.cc_route_pilot_end(p_actor uuid, p_lease uuid)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'pg_temp'
as $function$
begin
  if p_actor is null or p_lease is null then return false; end if;
  update confirmar_citas.route_pilot_budget
    set actor = null, lease = null, operation = null
    where singleton is true and actor = p_actor and lease = p_lease;
  return found;
end;
$function$;

create or replace function public.cc_route_budget_end(p_lease uuid, p_provider_limited boolean default false)
 returns void
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'pg_temp'
as $function$
begin
  if p_lease is null then return; end if;
  -- Same lock order as cc_route_pilot_begin/charge: pilot row first, then the shared budget row.
  update confirmar_citas.route_pilot_budget
    set actor = null, lease = null, operation = null
    where singleton is true and lease = p_lease;
  update confirmar_citas.route_budget_lock
    set lease = null, lease_until = null, paused_until = case when p_provider_limited
      then clock_timestamp() + interval '15 minutes' else paused_until end
    where lease = p_lease;
end;
$function$;

create or replace function public.cc_route_pilot_begin(p_actor uuid, p_lease uuid, p_operation text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  pilot confirmar_citas.route_pilot_budget%rowtype;
  usage record;
  stamp timestamptz;
  held boolean;
begin
  if p_actor is null or p_lease is null or p_operation is null or p_operation not in ('route', 'autocomplete') then
    return false;
  end if;

  -- Begin and charge always acquire the pilot row before the shared budget row.
  select * into strict pilot from confirmar_citas.route_pilot_budget where singleton is true for update;
  stamp := clock_timestamp();
  -- A pilot reservation only blocks other technicians while its lease is still alive.
  select exists (
    select 1 from confirmar_citas.route_budget_lock l
    where l.lease = pilot.lease and l.lease_until > stamp
  ) into held;
  if pilot.stopped or pilot.quota_verified_at is null or pilot.quota_verified_at <= stamp - interval '24 hours'
    or (pilot.actor is not null and pilot.actor <> p_actor and held) then
    return false;
  end if;
  delete from confirmar_citas.route_pilot_reservation where charged_at <= stamp - interval '24 hours';
  select * into strict usage from confirmar_citas.route_pilot_usage(stamp);
  if usage.credits >= 50 or (p_operation = 'route' and usage.routing_requests >= 10)
    or pilot.external_usage + usage.credits >= 3000 then
    return false;
  end if;

  if not public.cc_route_budget_begin_operation(p_actor, p_lease, p_operation) then return false; end if;
  update confirmar_citas.route_pilot_budget set actor = p_actor, lease = p_lease, operation = p_operation
    where singleton is true;
  return true;
end;
$function$;

-- Same privileges as the other pilot RPCs: service_role only.
revoke all on function public.cc_route_pilot_end(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cc_route_pilot_end(uuid, uuid) to service_role;
revoke all on function public.cc_route_budget_end(uuid, boolean) from public, anon, authenticated;
grant execute on function public.cc_route_budget_end(uuid, boolean) to service_role;
revoke all on function public.cc_route_pilot_begin(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cc_route_pilot_begin(uuid, uuid, text) to service_role;

-- One-time cleanup: release a pilot reservation whose lease is no longer alive.
update confirmar_citas.route_pilot_budget p
  set actor = null, lease = null, operation = null
  where p.singleton is true and p.lease is not null
    and not exists (
      select 1 from confirmar_citas.route_budget_lock l
      where l.lease = p.lease and l.lease_until > clock_timestamp()
    );
