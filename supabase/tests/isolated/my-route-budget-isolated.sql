\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create role service_role;
create schema confirmar_citas;
-- Model updating a disposable installation that already has the previous budget.
\ir ../../sql_editor/DRAFT_my_route_budget.sql
\ir ../../migrations/20261118100000_route_geoapify_budget.sql

do $$
begin
  if has_function_privilege('authenticated','public.cc_route_budget_charge(uuid,integer)','execute') or
     has_function_privilege('anon','public.cc_route_budget_begin_operation(uuid,uuid,text)','execute') or
     has_table_privilege('service_role','confirmar_citas.route_budget_autocomplete_cooldown','select') or
     has_table_privilege('service_role','confirmar_citas.route_budget_reservation','insert')
  then raise exception 'ACL leaked'; end if;
end $$;
set role service_role;
do $$
declare a uuid := '00000000-0000-4000-8000-000000000001'; b uuid := '00000000-0000-4000-8000-000000000002';
begin
  if public.cc_route_budget_begin_operation(a,a,'other') then raise exception 'unrecognised operation'; end if;
  if not public.cc_route_budget_begin_operation(a,a,'autocomplete') then raise exception 'first lease'; end if;
  if public.cc_route_budget_begin(b,current_date,b) then raise exception 'second lease across operations'; end if;
  perform public.cc_route_budget_end(b);
  if public.cc_route_budget_charge(b,1) or public.cc_route_budget_charge(a,3) then raise exception 'invalid reserve'; end if;
  if not public.cc_route_budget_charge(a,1) then raise exception 'valid autocomplete reserve'; end if;
  if public.cc_route_budget_charge(a,1) then raise exception 'rate cap'; end if;
  perform public.cc_route_budget_end(a);
  perform pg_sleep(0.35);
  if not public.cc_route_budget_begin(a,current_date,a) then raise exception 'independent autocomplete cooldown'; end if;
  if not public.cc_route_budget_charge(a,2) then raise exception 'valid routing reserve'; end if;
  perform public.cc_route_budget_end(a);
  perform pg_sleep(0.35);
  if public.cc_route_budget_begin(a,current_date + 1,a) then raise exception 'actor cooldown bypass'; end if;
  if not public.cc_route_budget_begin(b,current_date,b) then raise exception 'released lease'; end if;
end $$;
reset role;
insert into confirmar_citas.route_budget_reservation select now(),1 from generate_series(1,2497);
set role service_role;
do $$
declare b uuid := '00000000-0000-4000-8000-000000000002';
begin
  if public.cc_route_budget_charge(b,1) then raise exception 'shared 2500-credit cap bypass'; end if;
  perform public.cc_route_budget_end(b);
  if public.cc_route_budget_begin_operation(b,b,'autocomplete') then raise exception 'autocomplete bypass at full quota'; end if;
end $$;
reset role;
update confirmar_citas.route_budget_reservation set charged_at=now()-interval '25 hours';
set role service_role;
do $$
declare b uuid := '00000000-0000-4000-8000-000000000002'; c uuid := '00000000-0000-4000-8000-000000000003';
begin
  if not public.cc_route_budget_begin_operation(b,b,'autocomplete') then raise exception 'rolling quota did not reset'; end if;
  if not public.cc_route_budget_charge(b,1) then raise exception 'no credit after rolling reset'; end if;
  perform public.cc_route_budget_end(b, true);
  perform pg_sleep(0.35);
  if public.cc_route_budget_begin_operation(c,c,'autocomplete') or public.cc_route_budget_begin(c,current_date,c)
  then raise exception 'shared provider pause bypass'; end if;
end $$;
reset role;
select 'PASS: shared route and autocomplete quota, exclusive lease, rolling window and ACL';
