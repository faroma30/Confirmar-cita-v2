-- =====================================================================================
-- YA APLICADA en producción el 20/11/2026; solo referencia, no ejecutar.
-- =====================================================================================
-- Piloto de Mis rutas (Geoapify, plan Free) tal como está definido en el Supabase de la V2.
-- Este SQL se aplicó directamente en el proyecto (fuera del historial de migraciones) y
-- se recuperó en solo lectura con pg_get_functiondef el 24/11/2026 (CONFIRMAR_CITAS-005).
-- El Supabase de la V2 NO es el de Controla.
--
-- Por qué está aquí: para que el repositorio tenga la definición real de las RPC del piloto
-- (cc_route_pilot_begin/charge/configure/report/status y route_pilot_usage) y de las RPC de
-- rutas que dependen de ellas. NO es una migración pendiente.
--
-- Si se usa la CLI de Supabase, márquese como aplicada SIN ejecutarla:
--   supabase migration repair --status applied 20261120050000
-- La guarda siguiente impide que se ejecute por accidente (db push / migration up fallan aquí
-- y la transacción no aplica nada).
--
-- Tablas: su DDL no se recuperó. Columnas deducidas de las funciones (solo referencia):
--   confirmar_citas.route_pilot_budget (fila única): singleton, stopped, external_usage,
--     quota_verified_at, last_error, last_error_at, actor, lease, operation
--   confirmar_citas.route_pilot_reservation: charged_at, credits, routing
--   confirmar_citas.route_budget_lock, route_budget_reservation, route_budget_cooldown,
--     route_budget_autocomplete_cooldown: ver migraciones 20261118100000/110000 (rama ci/mis-rutas-auth).
-- Permisos observados (CONFIRMAR_CITAS-005): RPC cc_route_pilot_* y cc_route_budget_* solo
-- service_role; cc_my_route_locations*, cc_save_my_route_locations: authenticated.
-- =====================================================================================

do $guard$
begin
  raise exception 'Referencia YA APLICADA el 20/11/2026 (route_pilot_applied_reference): no ejecutar. Usa "supabase migration repair --status applied 20261120050000".';
end
$guard$;

-- ===== cc_my_route_locations
CREATE OR REPLACE FUNCTION public.cc_my_route_locations(p_expected_technician_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select jsonb_object_agg(pref.kind,
    case when pref.kind in ('home','keys','tourline') and jsonb_typeof(pref.value) = 'object'
      then pref.value - 'province'
      else pref.value
    end)
  from jsonb_each(public.cc_my_route_locations_v2(p_expected_technician_id)) as pref(kind,value);
$function$
;

-- ===== cc_my_route_locations_v2
CREATE OR REPLACE FUNCTION public.cc_my_route_locations_v2(p_expected_technician_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null or v_actor is distinct from p_expected_technician_id
     or confirmar_citas.current_app_role() is distinct from 'technician' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object('home', p.home_location, 'keys', p.key_pickup_location,
    'tourline', p.tourline_location, 'margin', p.margin_minutes)
    into v_result
    from confirmar_citas.technician_route_preferences p
    where p.technician_id = v_actor;
  return coalesce(v_result, '{"home":null,"keys":null,"tourline":null,"margin":10}'::jsonb);
end;
$function$
;

-- ===== cc_route_budget_begin
CREATE OR REPLACE FUNCTION public.cc_route_budget_begin(p_actor uuid, p_day date, p_lease uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select case when p_day is null then false else public.cc_route_budget_begin_operation(p_actor, p_lease, 'route') end;
$function$
;

-- ===== cc_route_budget_begin_operation
CREATE OR REPLACE FUNCTION public.cc_route_budget_begin_operation(p_actor uuid, p_lease uuid, p_operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  state confirmar_citas.route_budget_lock%rowtype;
  stamp timestamptz;
begin
  if p_actor is null or p_lease is null or p_operation is null
    or p_operation not in ('route','autocomplete') then return false; end if;
  select * into strict state from confirmar_citas.route_budget_lock for update;
  stamp := clock_timestamp();
  if (state.lease is not null and state.lease_until > stamp)
    or state.paused_until > stamp or state.last_charge > stamp - interval '300 milliseconds' then return false; end if;
  delete from confirmar_citas.route_budget_reservation where charged_at <= stamp - interval '24 hours';
  if (select coalesce(sum(credits), 0) from confirmar_citas.route_budget_reservation) >= 2500 then return false; end if;
  if p_operation = 'autocomplete' then
    delete from confirmar_citas.route_budget_autocomplete_cooldown where started_at <= stamp - interval '500 milliseconds';
    insert into confirmar_citas.route_budget_autocomplete_cooldown(actor, started_at) values (p_actor, stamp)
      on conflict do nothing;
  else
    delete from confirmar_citas.route_budget_cooldown where started_at <= stamp - interval '2 minutes';
    insert into confirmar_citas.route_budget_cooldown(actor, started_at) values (p_actor, stamp)
      on conflict do nothing;
  end if;
  if not found then return false; end if;
  update confirmar_citas.route_budget_lock set lease = p_lease,
    lease_until = stamp + case when p_operation = 'autocomplete' then interval '8 seconds' else interval '65 seconds' end
    where singleton is true;
  return true;
end;
$function$
;

-- ===== cc_route_budget_charge
CREATE OR REPLACE FUNCTION public.cc_route_budget_charge(p_lease uuid, p_credits integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  state confirmar_citas.route_budget_lock%rowtype;
  stamp timestamptz;
begin
  if p_lease is null or p_credits is null or p_credits not between 1 and 2 then return false; end if;
  select * into strict state from confirmar_citas.route_budget_lock for update;
  stamp := clock_timestamp();
  if state.lease is distinct from p_lease or state.lease_until <= stamp
    or state.last_charge > stamp - interval '275 milliseconds' then return false; end if;
  delete from confirmar_citas.route_budget_reservation where charged_at <= stamp - interval '24 hours';
  if (select coalesce(sum(credits), 0) from confirmar_citas.route_budget_reservation) + p_credits > 2500 then return false; end if;
  insert into confirmar_citas.route_budget_reservation(charged_at, credits) values (stamp, p_credits);
  update confirmar_citas.route_budget_lock set last_charge = stamp
    where singleton is true;
  return true;
end;
$function$
;

-- ===== cc_route_budget_end
CREATE OR REPLACE FUNCTION public.cc_route_budget_end(p_lease uuid, p_provider_limited boolean DEFAULT false)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  update confirmar_citas.route_budget_lock
    set lease = null, lease_until = null, paused_until = case when p_provider_limited
      then clock_timestamp() + interval '15 minutes' else paused_until end
    where lease = p_lease;
$function$
;

-- ===== cc_route_pilot_begin
CREATE OR REPLACE FUNCTION public.cc_route_pilot_begin(p_actor uuid, p_lease uuid, p_operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  pilot confirmar_citas.route_pilot_budget%rowtype;
  usage record;
  stamp timestamptz;
begin
  if p_actor is null or p_lease is null or p_operation is null or p_operation not in ('route', 'autocomplete') then
    return false;
  end if;

  -- Begin and charge always acquire the pilot row before the shared budget row.
  select * into strict pilot from confirmar_citas.route_pilot_budget where singleton is true for update;
  stamp := clock_timestamp();
  if pilot.stopped or pilot.quota_verified_at is null or pilot.quota_verified_at <= stamp - interval '24 hours'
    or (pilot.actor is not null and pilot.actor <> p_actor) then
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
$function$
;

-- ===== cc_route_pilot_charge
CREATE OR REPLACE FUNCTION public.cc_route_pilot_charge(p_actor uuid, p_lease uuid, p_credits integer, p_is_routing boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  pilot confirmar_citas.route_pilot_budget%rowtype;
  usage record;
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
  select * into strict usage from confirmar_citas.route_pilot_usage(stamp);
  if usage.credits + p_credits > 50 or (p_is_routing and usage.routing_requests >= 10)
    or pilot.external_usage + usage.credits + p_credits > 3000 then
    return false;
  end if;

  if not public.cc_route_budget_charge(p_lease, p_credits) then return false; end if;
  insert into confirmar_citas.route_pilot_reservation(charged_at, credits, routing)
    values (stamp, p_credits, p_is_routing);
  return true;
end;
$function$
;

-- ===== cc_route_pilot_configure
CREATE OR REPLACE FUNCTION public.cc_route_pilot_configure(p_external_usage integer, p_stop boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
  if p_stop is null or (p_external_usage is not null and p_external_usage not between 0 and 3000)
    or (not p_stop and (p_external_usage is null or p_external_usage > 2950)) then
    return false;
  end if;
  update confirmar_citas.route_pilot_budget
    set stopped = p_stop,
        external_usage = coalesce(p_external_usage, external_usage),
        quota_verified_at = case when p_external_usage is null then quota_verified_at else clock_timestamp() end
    where singleton is true;
  return found;
end;
$function$
;

-- ===== cc_route_pilot_report
CREATE OR REPLACE FUNCTION public.cc_route_pilot_report(p_actor uuid, p_lease uuid, p_error text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
  if p_actor is null or p_lease is null or p_error is null or p_error not in (
    'quota', 'provider_limited', 'provider_unavailable', 'route_estimate_exceeded', 'timeout'
  ) then return false; end if;
  update confirmar_citas.route_pilot_budget
    set last_error = p_error, last_error_at = clock_timestamp(),
        stopped = stopped or p_error in ('provider_limited', 'route_estimate_exceeded')
    where singleton is true and actor = p_actor and lease = p_lease;
  return found;
end;
$function$
;

-- ===== cc_route_pilot_status
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
    'creditsLimit24h', 50,
    'routingRequests24h', usage.routing_requests,
    'routingRequestsLimit24h', 10,
    'externalUsageAtVerification', p.external_usage,
    'quotaVerifiedAt', p.quota_verified_at,
    'lastError', p.last_error,
    'lastErrorAt', p.last_error_at
  )
  from confirmar_citas.route_pilot_budget p
  cross join lateral confirmar_citas.route_pilot_usage(statement_timestamp()) usage
  where p.singleton is true;
$function$
;

-- ===== cc_save_my_route_locations
CREATE OR REPLACE FUNCTION public.cc_save_my_route_locations(p_expected_technician_id uuid, p_home jsonb, p_keys jsonb, p_tourline jsonb, p_margin integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_home jsonb;
  v_keys jsonb;
  v_tourline jsonb;
  v_home_text text;
begin
  if v_actor is null or v_actor is distinct from p_expected_technician_id
     or confirmar_citas.current_app_role() is distinct from 'technician' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_margin is null or p_margin not between 0 and 180 then
    raise exception 'invalid route margin' using errcode = '22023';
  end if;

  v_home := confirmar_citas.normalize_route_location(p_home);
  v_keys := confirmar_citas.normalize_route_location(p_keys);
  v_tourline := confirmar_citas.normalize_route_location(p_tourline);
  if v_home is not null then
    v_home_text := concat_ws(', ', concat_ws(' ', v_home ->> 'street', nullif(v_home ->> 'number', '')),
      concat_ws(' ', nullif(v_home ->> 'postalCode', ''), v_home ->> 'municipality'));
  end if;

  insert into confirmar_citas.technician_route_preferences
    (technician_id, home, home_location, key_pickup_location, tourline_location, margin_minutes)
  values (v_actor, v_home_text, v_home, v_keys, v_tourline, p_margin)
  on conflict (technician_id) do update set
    home = excluded.home,
    home_location = excluded.home_location,
    key_pickup_location = excluded.key_pickup_location,
    tourline_location = excluded.tourline_location,
    margin_minutes = excluded.margin_minutes;
end;
$function$
;

-- ===== confirmar_citas.normalize_route_location
CREATE OR REPLACE FUNCTION confirmar_citas.normalize_route_location(p_location jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_street text;
  v_number text;
  v_municipality text;
  v_postal_code text;
  v_province text;
begin
  if p_location is null or p_location = 'null'::jsonb then
    return null;
  end if;

  if jsonb_typeof(p_location) is distinct from 'object' then
    raise exception 'invalid route location' using errcode = '22023';
  end if;
  if (p_location - array['street','number','municipality','postalCode','province']) <> '{}'::jsonb
     or jsonb_typeof(p_location -> 'street') is distinct from 'string'
     or (p_location ? 'number' and jsonb_typeof(p_location -> 'number') is distinct from 'string')
     or jsonb_typeof(p_location -> 'municipality') is distinct from 'string'
     or (p_location ? 'postalCode' and jsonb_typeof(p_location -> 'postalCode') is distinct from 'string')
     or (p_location ? 'province' and jsonb_typeof(p_location -> 'province') is distinct from 'string') then
    raise exception 'invalid route location' using errcode = '22023';
  end if;

  v_street := btrim(p_location ->> 'street');
  v_number := btrim(coalesce(p_location ->> 'number', ''));
  v_municipality := btrim(p_location ->> 'municipality');
  v_postal_code := btrim(coalesce(p_location ->> 'postalCode', ''));
  v_province := btrim(coalesce(p_location ->> 'province', ''));
  if char_length(v_street) not between 1 and 200
     or char_length(v_number) > 30
     or char_length(v_municipality) not between 1 and 100
     or concat(v_street, v_number, v_municipality) ~ '[[:cntrl:]]'
     or v_postal_code !~ '^([0-9]{5})?$'
     or char_length(v_province) > 100
     or v_province ~ '[[:cntrl:]]'
     or v_province ~ U&'[\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069\FEFF]' then
    raise exception 'invalid route location' using errcode = '22023';
  end if;

  return jsonb_build_object('street', v_street, 'number', v_number, 'municipality', v_municipality, 'postalCode', v_postal_code)
    || case when v_province <> '' then jsonb_build_object('province', v_province) else '{}'::jsonb end;
end;
$function$
;

-- ===== confirmar_citas.route_pilot_usage
CREATE OR REPLACE FUNCTION confirmar_citas.route_pilot_usage(p_at timestamp with time zone)
 RETURNS TABLE(credits integer, routing_requests integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select coalesce(sum(r.credits), 0)::integer, count(*) filter (where r.routing)::integer
    from confirmar_citas.route_pilot_reservation r
    where r.charged_at > p_at - interval '24 hours';
$function$
;


