-- =====================================================================================
-- PENDIENTE DE APLICAR (CONFIRMAR_CITAS-025). Escrita y NO ejecutada. Solo Supabase de la V2
-- (no es el de Controla). Aplicar únicamente con autorización registrada del Director.
-- =====================================================================================
-- Decisión del Director (27/11/2026 07:12): topes internos del piloto de Mis rutas
--   de 50 a 1.000 créditos y de 10 a 200 consultas de ruta por 24 h (ventana móvil).
-- Los topes estaban escritos dentro de cc_route_pilot_begin/charge/status. Pasan a una fila
-- única (confirmar_citas.route_pilot_limits) con un TOPE DE SEGURIDAD: la base rechaza
-- configurar más de 2.500 créditos al día (el plan Free de Geoapify da 3.000).
-- Sin cambios: ventana de 24 h, caducidad y renovación diaria, parada por 401/403/429 o
-- distancia excedida, desactivar, consumo externo + reservado <= 3.000 y el presupuesto
-- compartido de 2.500 de cc_route_budget_*.
-- Requiere 20261125090000 aplicada. Si las definiciones no son las esperadas, no cambia nada.
-- Prueba aislada (escrita, no ejecutada): supabase/tests/isolated/route-pilot-limits-isolated.sql
-- Cambiar los topes más adelante (como propietario, con autorización):
--   update confirmar_citas.route_pilot_limits set credits_24h = <1..2500>, routing_24h = <1..créditos> where singleton;
-- =====================================================================================
begin;

do $guard$
begin
  if position($needle$usage.credits >= 50 or (p_operation = 'route' and usage.routing_requests >= 10)$needle$ in pg_get_functiondef('public.cc_route_pilot_begin(uuid,uuid,text)'::regprocedure)) = 0 then
    raise exception 'CONFIRMAR_CITAS-025: la definicion de public.cc_route_pilot_begin no es la esperada; no se cambia nada';
  end if;
  if position($needle$l.lease = pilot.lease and l.lease_until > stamp$needle$ in pg_get_functiondef('public.cc_route_pilot_begin(uuid,uuid,text)'::regprocedure)) = 0 then
    raise exception 'CONFIRMAR_CITAS-025: la definicion de public.cc_route_pilot_begin no es la esperada; no se cambia nada';
  end if;
  if position($needle$usage.credits + p_credits > 50 or (p_is_routing and usage.routing_requests >= 10)$needle$ in pg_get_functiondef('public.cc_route_pilot_charge(uuid,uuid,integer,boolean)'::regprocedure)) = 0 then
    raise exception 'CONFIRMAR_CITAS-025: la definicion de public.cc_route_pilot_charge no es la esperada; no se cambia nada';
  end if;
  if position($needle$'creditsLimit24h', 50,$needle$ in pg_get_functiondef('public.cc_route_pilot_status()'::regprocedure)) = 0 then
    raise exception 'CONFIRMAR_CITAS-025: la definicion de public.cc_route_pilot_status no es la esperada; no se cambia nada';
  end if;
  if position($needle$'routingRequestsLimit24h', 10,$needle$ in pg_get_functiondef('public.cc_route_pilot_status()'::regprocedure)) = 0 then
    raise exception 'CONFIRMAR_CITAS-025: la definicion de public.cc_route_pilot_status no es la esperada; no se cambia nada';
  end if;
end
$guard$;

create table confirmar_citas.route_pilot_limits (
  singleton boolean primary key default true check (singleton),
  credits_24h integer not null
    constraint route_pilot_limits_safety_cap check (credits_24h between 1 and 2500),
  routing_24h integer not null
    constraint route_pilot_limits_routing check (routing_24h between 1 and credits_24h)
);
insert into confirmar_citas.route_pilot_limits(singleton, credits_24h, routing_24h) values (true, 1000, 200);
alter table confirmar_citas.route_pilot_limits enable row level security;
revoke all on confirmar_citas.route_pilot_limits from public, anon, authenticated, service_role;

create or replace function public.cc_route_pilot_begin(p_actor uuid, p_lease uuid, p_operation text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  pilot confirmar_citas.route_pilot_budget%rowtype;
  usage record;
  caps confirmar_citas.route_pilot_limits%rowtype;
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
  select * into strict caps from confirmar_citas.route_pilot_limits where singleton is true;
  select * into strict usage from confirmar_citas.route_pilot_usage(stamp);
  if usage.credits >= caps.credits_24h or (p_operation = 'route' and usage.routing_requests >= caps.routing_24h)
    or pilot.external_usage + usage.credits >= 3000 then
    return false;
  end if;

  if not public.cc_route_budget_begin_operation(p_actor, p_lease, p_operation) then return false; end if;
  update confirmar_citas.route_pilot_budget set actor = p_actor, lease = p_lease, operation = p_operation
    where singleton is true;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cc_route_pilot_charge(p_actor uuid, p_lease uuid, p_credits integer, p_is_routing boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  pilot confirmar_citas.route_pilot_budget%rowtype;
  usage record;
  caps confirmar_citas.route_pilot_limits%rowtype;
  stamp timestamptz;
begin
  if p_actor is null or p_lease is null or p_credits is null or p_credits not between 1 and 2
    or p_is_routing is null then
    return false;
  end if;

  select * into strict pilot from confirmar_citas.route_pilot_budget where singleton is true for update;
  stamp := clock_timestamp();
  if pilot.stopped or pilot.quota_verified_at is null or pilot.quota_verified_at <= stamp - interval '24 hours'
    or pilot.actor is distinct from p_actor or pilot.lease is distinct from p_lease
    or (p_is_routing and pilot.operation <> 'route') then
    return false;
  end if;
  select * into strict caps from confirmar_citas.route_pilot_limits where singleton is true;
  select * into strict usage from confirmar_citas.route_pilot_usage(stamp);
  if usage.credits + p_credits > caps.credits_24h or (p_is_routing and usage.routing_requests >= caps.routing_24h)
    or pilot.external_usage + usage.credits + p_credits > 3000 then
    return false;
  end if;

  if not public.cc_route_budget_charge(p_lease, p_credits) then return false; end if;
  insert into confirmar_citas.route_pilot_reservation(charged_at, credits, routing)
    values (stamp, p_credits, p_is_routing);
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cc_route_pilot_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'active', not p.stopped and coalesce(p.quota_verified_at > statement_timestamp() - interval '24 hours', false),
    'stopped', p.stopped,
    'creditsReserved24h', usage.credits,
    'creditsLimit24h', caps.credits_24h,
    'routingRequests24h', usage.routing_requests,
    'routingRequestsLimit24h', caps.routing_24h,
    'externalUsageAtVerification', p.external_usage,
    'quotaVerifiedAt', p.quota_verified_at,
    'lastError', p.last_error,
    'lastErrorAt', p.last_error_at
  )
  from confirmar_citas.route_pilot_budget p
  cross join lateral confirmar_citas.route_pilot_usage(statement_timestamp()) usage
  cross join confirmar_citas.route_pilot_limits caps
  where p.singleton is true and caps.singleton is true;
$function$
;

-- Same privileges as before: service_role only.
revoke all on function public.cc_route_pilot_begin(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cc_route_pilot_begin(uuid, uuid, text) to service_role;
revoke all on function public.cc_route_pilot_charge(uuid, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.cc_route_pilot_charge(uuid, uuid, integer, boolean) to service_role;
revoke all on function public.cc_route_pilot_status() from public, anon, authenticated;
grant execute on function public.cc_route_pilot_status() to service_role;

commit;
