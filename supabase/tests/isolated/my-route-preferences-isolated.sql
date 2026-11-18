\set ON_ERROR_STOP on
-- Run only in a freshly initialized disposable database without application schemas.
do $$
begin
  if exists (select from pg_namespace where nspname in ('auth', 'confirmar_citas')) then
    raise exception 'Expected a pristine disposable database';
  end if;
end $$;
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema confirmar_citas;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
create type confirmar_citas.app_role as enum ('technician','master','admin');
create table confirmar_citas.profiles (
  user_id uuid primary key, role confirmar_citas.app_role, status text,
  must_change_password boolean default false, sessions_invalid_before bigint
);
create table confirmar_citas.teams (id int primary key, active boolean);
create table confirmar_citas.team_members (
  team_id int, user_id uuid, member_role confirmar_citas.app_role, status text
);
-- Mirrors the effective role check in the master technician access reset migration.
create function confirmar_citas.current_app_role()
returns confirmar_citas.app_role language sql stable security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
  select p.role from confirmar_citas.profiles p
  where p.user_id = auth.uid() and p.status = 'active' and not p.must_change_password
    and (p.sessions_invalid_before is null or
         coalesce((auth.jwt() ->> 'iat')::bigint, 0) >= p.sessions_invalid_before)
    and (p.role <> 'technician' or exists (
      select 1 from confirmar_citas.team_members tm
      join confirmar_citas.teams t on t.id = tm.team_id and t.active
      where tm.user_id = p.user_id and tm.member_role = 'technician' and tm.status = 'active'
    ))
$$;
\ir ../../sql_editor/DRAFT_my_route_preferences.sql
insert into confirmar_citas.profiles(user_id, role, status, sessions_invalid_before) values
 ('00000000-0000-4000-8000-000000000001','technician','active',5),
 ('00000000-0000-4000-8000-000000000002','technician','active',null),
 ('00000000-0000-4000-8000-000000000003','master','active',null),
 ('00000000-0000-4000-8000-000000000004','technician','inactive',null);
insert into confirmar_citas.teams values (1,true);
insert into confirmar_citas.team_members
 select 1,user_id,role,'active' from confirmar_citas.profiles where role='technician';
grant usage on schema confirmar_citas to authenticated;
do $$
begin
  if not exists (select from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='confirmar_citas' and c.relname='technician_route_preferences' and c.relrowsecurity)
    then raise exception 'RLS is not enabled'; end if;
  if has_table_privilege('authenticated','confirmar_citas.technician_route_preferences','SELECT,INSERT,UPDATE,DELETE')
    then raise exception 'Direct access permitted'; end if;
  if has_function_privilege('anon','public.cc_my_route_preferences(uuid)','EXECUTE')
    or has_function_privilege('anon','public.cc_save_my_route_preferences(uuid,text,integer)','EXECUTE')
    or has_function_privilege('service_role','public.cc_my_route_preferences(uuid)','EXECUTE')
    then raise exception 'Unexpected function grant'; end if;
end $$;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","iat":10}';
do $$
begin
  if public.cc_my_route_preferences((current_setting('request.jwt.claims')::jsonb->>'sub')::uuid) <> '{"home":"","margin":10}'::jsonb then raise exception 'Missing defaults'; end if;
  begin
    perform public.cc_my_route_preferences('00000000-0000-4000-8000-000000000002');
    raise exception 'Mismatched actor read allowed';
  exception when insufficient_privilege then null; end;
  perform public.cc_save_my_route_preferences('00000000-0000-4000-8000-000000000001','  Synthetic A  ',25);
  begin
    perform public.cc_save_my_route_preferences('00000000-0000-4000-8000-000000000002','stale session write',20);
    raise exception 'Mismatched actor write allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.cc_save_my_route_preferences('00000000-0000-4000-8000-000000000001','invalid margin',181);
    raise exception 'Invalid margin accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform * from confirmar_citas.technician_route_preferences;
    raise exception 'Direct read allowed';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","iat":10}';
do $$
begin
  if public.cc_my_route_preferences((current_setting('request.jwt.claims')::jsonb->>'sub')::uuid) <> '{"home":"","margin":10}'::jsonb then raise exception 'Cross-user leak'; end if;
  perform public.cc_save_my_route_preferences('00000000-0000-4000-8000-000000000002','Synthetic B',180);
  if public.cc_my_route_preferences((current_setting('request.jwt.claims')::jsonb->>'sub')::uuid) <> '{"home":"Synthetic B","margin":180}'::jsonb then raise exception 'B write not persisted'; end if;
end $$;
set request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","iat":10}';
do $$
begin
  if public.cc_my_route_preferences((current_setting('request.jwt.claims')::jsonb->>'sub')::uuid) <> '{"home":"Synthetic A","margin":25}'::jsonb then raise exception 'A write not persisted'; end if;
  perform public.cc_save_my_route_preferences('00000000-0000-4000-8000-000000000001',' ',0);
  if public.cc_my_route_preferences((current_setting('request.jwt.claims')::jsonb->>'sub')::uuid) <> '{"home":"","margin":0}'::jsonb then raise exception 'Clear/update failed'; end if;
end $$;
do $$
declare claim text;
begin
  foreach claim in array array[
    '{"sub":"00000000-0000-4000-8000-000000000003","iat":10}',
    '{"sub":"00000000-0000-4000-8000-000000000004","iat":10}',
    '{"sub":"00000000-0000-4000-8000-000000000001","iat":4}',
    '{}'
  ] loop
    perform set_config('request.jwt.claims',claim,true);
    begin
      perform public.cc_my_route_preferences((current_setting('request.jwt.claims')::jsonb->>'sub')::uuid);
      raise exception 'Unauthorized read succeeded';
    exception when insufficient_privilege then null; end;
    begin
      perform public.cc_save_my_route_preferences((claim::jsonb->>'sub')::uuid,'unauthorized',10);
      raise exception 'Unauthorized write succeeded';
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;
set role anon;
do $$
begin
  begin
    perform public.cc_my_route_preferences((current_setting('request.jwt.claims')::jsonb->>'sub')::uuid);
    raise exception 'Anonymous read succeeded';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS: isolated route preferences' as result;
