-- =====================================================================================
-- PENDIENTE DE APLICAR (CONFIRMAR_CITAS-031). Escrita y NO ejecutada. Solo Supabase de la V2
-- (no es el de Controla). Aplicar únicamente con el botón autorizado, con `supabase db query -f`
-- (nunca `db push`).
-- =====================================================================================
-- Decisión del Director (28/11/2026): Mis rutas conserva el cálculo ya hecho solo de HOY y MAÑANA
-- (Europe/Madrid) y por técnico. No hay tarea programada: lo anterior a hoy se borra dentro de la
-- propia base, al leer (lo del técnico) y al guardar (lo de todos).
-- Se guarda solo lo necesario para pintar tiempos, kilómetros y motivos: huellas SHA-256 de cada tramo,
-- números, horas y códigos. La función de guardado rechaza cualquier otro campo o texto libre, así que
-- no caben direcciones, nombres ni teléfonos.
-- No cambia ninguna tabla, función, tope, espera ni permiso existente. No afecta a la retención de citas.
-- Prueba aislada (escrita, no ejecutada): supabase/tests/isolated/route-saved-days-isolated.sql
-- =====================================================================================
begin;

do $guard$
begin
  if to_regclass('confirmar_citas.route_saved_day') is not null
     or to_regprocedure('public.cc_my_route_day(uuid,date)') is not null
     or to_regprocedure('public.cc_save_my_route_day(uuid,date,jsonb)') is not null then
    raise exception 'CONFIRMAR_CITAS-031: ya existe parte de esta migracion; no se cambia nada';
  end if;
  if to_regprocedure('confirmar_citas.current_app_role()') is null
     or to_regclass('confirmar_citas.profiles') is null then
    raise exception 'CONFIRMAR_CITAS-031: faltan las piezas esperadas de la base; no se cambia nada';
  end if;
end
$guard$;

create table confirmar_citas.route_saved_day (
  technician_id uuid not null references confirmar_citas.profiles(user_id) on delete cascade,
  work_date date not null,
  legs jsonb not null check (jsonb_typeof(legs) = 'array'),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (technician_id, work_date)
);
create index route_saved_day_date on confirmar_citas.route_saved_day (work_date);
alter table confirmar_citas.route_saved_day enable row level security;
revoke all on confirmar_citas.route_saved_day from public, anon, authenticated, service_role;
create policy route_saved_day_owner on confirmar_citas.route_saved_day
  for all to authenticated
  using (technician_id = auth.uid() and confirmar_citas.current_app_role() = 'technician')
  with check (technician_id = auth.uid() and confirmar_citas.current_app_role() = 'technician');

-- Lee lo guardado del propio técnico y, antes, borra sus días anteriores a hoy. Devuelve [] si no hay nada.
create function public.cc_my_route_day(p_expected_technician_id uuid, p_work_date date)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (statement_timestamp() at time zone 'Europe/Madrid')::date;
  v_legs jsonb;
begin
  if v_actor is null or v_actor is distinct from p_expected_technician_id
     or confirmar_citas.current_app_role() is distinct from 'technician' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from confirmar_citas.route_saved_day d where d.technician_id = v_actor and d.work_date < v_today;

  select d.legs into v_legs
    from confirmar_citas.route_saved_day d
    where d.technician_id = v_actor and d.work_date = p_work_date
      and d.work_date between v_today and v_today + 1;
  return coalesce(v_legs, '[]'::jsonb);
end;
$$;

-- Guarda hoy o mañana del propio técnico. Siempre borra antes los días anteriores a hoy de TODOS.
-- Devuelve false (sin guardar) para cualquier otro día. Una lista vacía elimina lo guardado de ese día.
create function public.cc_save_my_route_day(p_expected_technician_id uuid, p_work_date date, p_legs jsonb)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (statement_timestamp() at time zone 'Europe/Madrid')::date;
  v_leg jsonb;
  v_field record;
begin
  if v_actor is null or v_actor is distinct from p_expected_technician_id
     or confirmar_citas.current_app_role() is distinct from 'technician' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from confirmar_citas.route_saved_day d where d.work_date < v_today;

  if p_work_date is null or p_work_date < v_today or p_work_date > v_today + 1 then
    return false;
  end if;
  if p_legs is null or jsonb_typeof(p_legs) is distinct from 'array' then
    raise exception 'invalid route day' using errcode = '22023';
  end if;
  if jsonb_array_length(p_legs) > 101 or octet_length(p_legs::text) > 60000 then
    raise exception 'invalid route day' using errcode = '22023';
  end if;

  for v_leg in select e.item from jsonb_array_elements(p_legs) as e(item) loop
    if jsonb_typeof(v_leg) is distinct from 'object' or not (v_leg ?& array['a', 's', 't']) then
      raise exception 'invalid route day' using errcode = '22023';
    end if;
    for v_field in select f.name, f.item from jsonb_each(v_leg) as f(name, item) loop
      if not coalesce(case
        when v_field.name in ('a', 's') then
          jsonb_typeof(v_field.item) = 'string' and (v_field.item #>> '{}') ~ '^[a-f0-9]{64}$'
        when v_field.name in ('d', 'm') then
          case when jsonb_typeof(v_field.item) = 'number'
            then (v_field.item #>> '{}')::numeric between 0 and 10000000 else false end
        when v_field.name = 't' then
          jsonb_typeof(v_field.item) = 'string'
          and (v_field.item #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
        when v_field.name in ('r', 'dt', 'dg') then
          jsonb_typeof(v_field.item) = 'string' and (v_field.item #>> '{}') ~ '^[a-z_]{1,40}$'
        when v_field.name = 'ap' then jsonb_typeof(v_field.item) = 'boolean'
        when v_field.name = 'src' then
          case when jsonb_typeof(v_field.item) = 'array' then
            jsonb_array_length(v_field.item) = 2 and not exists (
              select 1 from jsonb_array_elements(v_field.item) as s(item)
              where s.item not in ('null'::jsonb, '"cartociudad"'::jsonb, '"geoapify"'::jsonb))
          else false end
        else false
      end, false) then
        raise exception 'invalid route day' using errcode = '22023';
      end if;
    end loop;
  end loop;

  if jsonb_array_length(p_legs) = 0 then
    delete from confirmar_citas.route_saved_day d where d.technician_id = v_actor and d.work_date = p_work_date;
    return true;
  end if;

  insert into confirmar_citas.route_saved_day (technician_id, work_date, legs, updated_at)
  values (v_actor, p_work_date, p_legs, statement_timestamp())
  on conflict (technician_id, work_date) do update set legs = excluded.legs, updated_at = excluded.updated_at;
  return true;
end;
$$;

revoke all on function public.cc_my_route_day(uuid, date), public.cc_save_my_route_day(uuid, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.cc_my_route_day(uuid, date), public.cc_save_my_route_day(uuid, date, jsonb)
  to authenticated;

commit;
