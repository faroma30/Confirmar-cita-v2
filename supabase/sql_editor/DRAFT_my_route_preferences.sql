-- DRAFT: validate in an isolated Supabase database before connecting the browser.
begin;

create table confirmar_citas.technician_route_preferences (
  technician_id uuid primary key references confirmar_citas.profiles(user_id) on delete cascade,
  home text check (char_length(home) between 1 and 500),
  margin_minutes integer not null default 10 check (margin_minutes between 0 and 180)
);

alter table confirmar_citas.technician_route_preferences enable row level security;
revoke all on confirmar_citas.technician_route_preferences from public, anon, authenticated, service_role;
create policy route_preferences_owner on confirmar_citas.technician_route_preferences
  for all to authenticated
  using (technician_id = auth.uid() and confirmar_citas.current_app_role() = 'technician')
  with check (technician_id = auth.uid() and confirmar_citas.current_app_role() = 'technician');

-- The expected actor prevents requests queued by an older browser session
-- from reading or writing the preferences of a newly authenticated user.
create function public.cc_my_route_preferences(p_expected_technician_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null or actor is distinct from p_expected_technician_id or confirmar_citas.current_app_role() is distinct from 'technician' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select jsonb_build_object('home', coalesce(p.home, ''), 'margin', p.margin_minutes)
    into result
    from confirmar_citas.technician_route_preferences p
    where p.technician_id = actor;
  return coalesce(result, jsonb_build_object('home', '', 'margin', 10));
end;
$$;

create function public.cc_save_my_route_preferences(p_expected_technician_id uuid, p_home text, p_margin integer)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare actor uuid := auth.uid();
begin
  if actor is null or actor is distinct from p_expected_technician_id or confirmar_citas.current_app_role() is distinct from 'technician' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if char_length(p_home) > 500 or p_margin is null or p_margin not between 0 and 180 then
    raise exception 'invalid route preferences' using errcode = '22023';
  end if;
  insert into confirmar_citas.technician_route_preferences(technician_id, home, margin_minutes)
    values(actor, nullif(btrim(p_home), ''), p_margin)
    on conflict (technician_id) do update set home = excluded.home, margin_minutes = excluded.margin_minutes;
end;
$$;

revoke all on function public.cc_my_route_preferences(uuid), public.cc_save_my_route_preferences(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.cc_my_route_preferences(uuid), public.cc_save_my_route_preferences(uuid, text, integer)
  to authenticated;

commit;
