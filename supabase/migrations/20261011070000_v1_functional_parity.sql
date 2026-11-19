-- Restores per-user agenda navigation and safe V1 day-cleanup actions.
-- Additive only: existing appointments and preferences are not rewritten.
alter table confirmar_citas.user_preferences
  add column if not exists active_work_date date,
  add column if not exists ignored_by_work_date jsonb not null default '{}'::jsonb
    check (jsonb_typeof(ignored_by_work_date) = 'object' and pg_column_size(ignored_by_work_date) <= 65536);

create or replace function public.cc_my_ignored_interventions(p_work_date date)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician')
     or p_work_date is null or p_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select ignored_by_work_date -> p_work_date::text into v_result
    from confirmar_citas.user_preferences where user_id = v_actor;
  return coalesce(v_result, '[]'::jsonb);
end;
$$;

create or replace function public.cc_save_my_ignored_interventions(p_work_date date, p_rows jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_row jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician')
     or p_work_date is null or p_work_date < confirmar_citas.sync_cutoff()
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or (v_row - array['time','type']) <> '{}'::jsonb
       or coalesce(v_row->>'time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or length(coalesce(v_row->>'type','')) > 200 then
      raise exception 'invalid ignored intervention' using errcode = '22023';
    end if;
  end loop;
  insert into confirmar_citas.user_preferences as current_preferences(user_id, ignored_by_work_date)
    values (v_actor, jsonb_build_object(p_work_date::text, p_rows))
  on conflict (user_id) do update set ignored_by_work_date =
    jsonb_set(coalesce(current_preferences.ignored_by_work_date, '{}'::jsonb),
      array[p_work_date::text], excluded.ignored_by_work_date -> p_work_date::text, true),
    updated_at = clock_timestamp();
end;
$$;

create or replace function public.cc_my_active_work_date()
returns date
language plpgsql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_date date;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select active_work_date into v_date from confirmar_citas.user_preferences where user_id = v_actor;
  return v_date;
end;
$$;

create or replace function public.cc_set_my_active_work_date(p_work_date date)
returns void
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician')
     or p_work_date is null or p_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into confirmar_citas.user_preferences(user_id, active_work_date)
  values (v_actor, p_work_date)
  on conflict (user_id) do update set active_work_date = excluded.active_work_date,
    updated_at = clock_timestamp();
end;
$$;

create or replace function public.cc_delete_my_appointment_day(p_work_date date)
returns integer
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_count integer;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician')
     or p_work_date is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update confirmar_citas.user_preferences
    set ignored_by_work_date = coalesce(ignored_by_work_date, '{}'::jsonb) - p_work_date::text,
        updated_at = clock_timestamp()
    where user_id = v_actor;
  delete from confirmar_citas.appointments
  where technician_id = v_actor and work_date = p_work_date;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.cc_purge_my_appointments_before_today()
returns integer
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_count integer;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from confirmar_citas.appointments
  where technician_id = v_actor
    and work_date < (clock_timestamp() at time zone 'Europe/Madrid')::date;
  get diagnostics v_count = row_count;
  update confirmar_citas.user_preferences p set
    ignored_by_work_date = coalesce((
      select jsonb_object_agg(e.key,e.value) from jsonb_each(p.ignored_by_work_date) e
      where e.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        and e.key >= ((clock_timestamp() at time zone 'Europe/Madrid')::date)::text
    ), '{}'::jsonb), updated_at = clock_timestamp()
  where p.user_id = v_actor;
  return v_count;
end;
$$;

create or replace function confirmar_citas.purge_expired_appointments()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_local_date date := (v_started at time zone 'Europe/Madrid')::date;
  v_days integer;
  v_cutoff date;
  v_deleted integer := 0;
  v_remaining integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('confirmar-citas-retention', 0));
  select retention_days into strict v_days from confirmar_citas.global_settings where singleton;
  v_cutoff := confirmar_citas.retention_cutoff(v_started);
  delete from confirmar_citas.appointments where work_date < v_cutoff;
  get diagnostics v_deleted = row_count;
  update confirmar_citas.user_preferences p set
    ignored_by_work_date = coalesce((
      select jsonb_object_agg(e.key,e.value) from jsonb_each(p.ignored_by_work_date) e
      where e.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and e.key >= v_cutoff::text
    ), '{}'::jsonb), updated_at = clock_timestamp()
  where p.ignored_by_work_date <> '{}'::jsonb;
  select count(*)::integer into v_remaining from confirmar_citas.appointments where work_date < v_cutoff;
  insert into confirmar_citas.retention_runs(run_local_date,started_at,finished_at,cutoff_local_date,policy_days,deleted_appointments,result,details)
  values (v_local_date,v_started,clock_timestamp(),v_cutoff,v_days,v_deleted,
    case when v_remaining=0 then 'success' else 'verification_failed' end,
    jsonb_build_object('remaining_expired_appointments',v_remaining));
  if v_remaining <> 0 then raise exception 'retention verification failed' using errcode='55000'; end if;
  return jsonb_build_object('cutoff',v_cutoff,'deleted_appointments',v_deleted);
end;
$$;

revoke all on function public.cc_set_my_active_work_date(date) from public, anon, authenticated, service_role;
revoke all on function public.cc_my_active_work_date() from public, anon, authenticated, service_role;
revoke all on function public.cc_my_ignored_interventions(date) from public, anon, authenticated, service_role;
revoke all on function public.cc_save_my_ignored_interventions(date,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.cc_delete_my_appointment_day(date) from public, anon, authenticated, service_role;
revoke all on function public.cc_purge_my_appointments_before_today() from public, anon, authenticated, service_role;
grant execute on function public.cc_set_my_active_work_date(date) to authenticated;
grant execute on function public.cc_my_active_work_date() to authenticated;
grant execute on function public.cc_my_ignored_interventions(date) to authenticated;
grant execute on function public.cc_save_my_ignored_interventions(date,jsonb) to authenticated;
grant execute on function public.cc_delete_my_appointment_day(date) to authenticated;
grant execute on function public.cc_purge_my_appointments_before_today() to authenticated;
