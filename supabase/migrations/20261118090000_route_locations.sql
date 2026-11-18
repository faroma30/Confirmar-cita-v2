-- Private structured locations for Mis rutas. No external provider is enabled here.
begin;

create table if not exists confirmar_citas.technician_route_preferences (
  technician_id uuid primary key references confirmar_citas.profiles(user_id) on delete cascade,
  home text check (char_length(home) between 1 and 500),
  margin_minutes integer not null default 10 check (margin_minutes between 0 and 180)
);
alter table confirmar_citas.technician_route_preferences
  add column home_location jsonb,
  add column key_pickup_location jsonb,
  add column tourline_location jsonb;
alter table confirmar_citas.technician_route_preferences enable row level security;
revoke all on confirmar_citas.technician_route_preferences from public, anon, authenticated, service_role;
drop policy if exists route_preferences_owner on confirmar_citas.technician_route_preferences;
create policy route_preferences_owner on confirmar_citas.technician_route_preferences
  for all to authenticated
  using (technician_id = auth.uid() and confirmar_citas.current_app_role() = 'technician')
  with check (technician_id = auth.uid() and confirmar_citas.current_app_role() = 'technician');

create function confirmar_citas.normalize_route_location(p_location jsonb)
returns jsonb
language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_street text;
  v_number text;
  v_municipality text;
  v_postal_code text;
begin
  if p_location is null or p_location = 'null'::jsonb then
    return null;
  end if;

  if jsonb_typeof(p_location) is distinct from 'object' then
    raise exception 'invalid route location' using errcode = '22023';
  end if;
  if (p_location - array['street','number','municipality','postalCode']) <> '{}'::jsonb
     or jsonb_typeof(p_location -> 'street') is distinct from 'string'
     or jsonb_typeof(p_location -> 'number') is distinct from 'string'
     or jsonb_typeof(p_location -> 'municipality') is distinct from 'string'
     or (p_location ? 'postalCode' and jsonb_typeof(p_location -> 'postalCode') is distinct from 'string') then
    raise exception 'invalid route location' using errcode = '22023';
  end if;

  v_street := btrim(p_location ->> 'street');
  v_number := btrim(p_location ->> 'number');
  v_municipality := btrim(p_location ->> 'municipality');
  v_postal_code := btrim(coalesce(p_location ->> 'postalCode', ''));
  if char_length(v_street) not between 1 and 200
     or char_length(v_number) not between 1 and 30
     or char_length(v_municipality) not between 1 and 100
     or concat(v_street, v_number, v_municipality) ~ '[[:cntrl:]]'
     or v_postal_code !~ '^([0-9]{5})?$' then
    raise exception 'invalid route location' using errcode = '22023';
  end if;

  return jsonb_build_object('street', v_street, 'number', v_number, 'municipality', v_municipality, 'postalCode', v_postal_code);
end;
$$;
revoke all on function confirmar_citas.normalize_route_location(jsonb) from public, anon, authenticated, service_role;

create function public.cc_my_route_locations(p_expected_technician_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
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
$$;

create function public.cc_save_my_route_locations(
  p_expected_technician_id uuid, p_home jsonb, p_keys jsonb, p_tourline jsonb, p_margin integer
)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
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
    v_home_text := concat_ws(', ', concat_ws(' ', v_home ->> 'street', v_home ->> 'number'),
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
$$;

revoke all on function public.cc_my_route_locations(uuid),
  public.cc_save_my_route_locations(uuid, jsonb, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.cc_my_route_locations(uuid),
  public.cc_save_my_route_locations(uuid, jsonb, jsonb, jsonb, integer) to authenticated;

commit;

