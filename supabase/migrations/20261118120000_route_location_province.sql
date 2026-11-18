-- Allow a province only as optional, user-scoped route address metadata.
-- Replacing the private normalizer preserves the existing RPC signatures and privileges.
begin;

create or replace function confirmar_citas.normalize_route_location(p_location jsonb)
returns jsonb
language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
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
$$;
create function public.cc_my_route_locations_v2(p_expected_technician_id uuid)
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

-- Existing clients validate the exact original location shape.
create or replace function public.cc_my_route_locations(p_expected_technician_id uuid)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_object_agg(pref.kind,
    case when pref.kind in ('home','keys','tourline') and jsonb_typeof(pref.value) = 'object'
      then pref.value - 'province'
      else pref.value
    end)
  from jsonb_each(public.cc_my_route_locations_v2(p_expected_technician_id)) as pref(kind,value);
$$;

revoke all on function public.cc_my_route_locations_v2(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cc_my_route_locations_v2(uuid) to authenticated;

commit;
