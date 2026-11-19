begin;

alter table confirmar_citas.appointment_private_data add column oracle_end_time time without time zone;

create or replace function public.cc_save_my_ignored_interventions(p_work_date date, p_rows jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician')
     or p_work_date is null or p_work_date < confirmar_citas.sync_cutoff()
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or (v_row - array['time','type','customer_name','phone','population','full_address','postal_code','end_time']) <> '{}'::jsonb
       or coalesce(jsonb_typeof(v_row->'time'),'') <> 'string'
       or coalesce(jsonb_typeof(v_row->'type'),'') <> 'string'
       or coalesce(v_row->>'time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v_row ? 'end_time' and (
         coalesce(v_row->>'end_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or (v_row->>'end_time') collate "C" < (v_row->>'time') collate "C"
       ))
       or length(coalesce(v_row->>'type','')) > 200
       or (v_row ? 'customer_name' and (jsonb_typeof(v_row->'customer_name') <> 'string' or length(v_row->>'customer_name') > 200))
       or (v_row ? 'phone' and (jsonb_typeof(v_row->'phone') <> 'string' or length(v_row->>'phone') > 40))
       or (v_row ? 'population' and (jsonb_typeof(v_row->'population') <> 'string' or length(v_row->>'population') > 120))
       or (v_row ? 'full_address' and (jsonb_typeof(v_row->'full_address') <> 'string' or length(v_row->>'full_address') > 500))
       or (v_row ? 'postal_code' and (jsonb_typeof(v_row->'postal_code') <> 'string' or length(v_row->>'postal_code') > 20)) then
      raise exception 'invalid ignored intervention' using errcode = '22023';
    end if;
  end loop;

  insert into confirmar_citas.user_preferences as current_preferences(user_id, ignored_by_work_date)
    values (v_actor, jsonb_build_object(p_work_date::text, p_rows))
  on conflict (user_id) do update set ignored_by_work_date = jsonb_set(
    current_preferences.ignored_by_work_date, array[p_work_date::text], p_rows, true
  ), updated_at = clock_timestamp();
end;
$$;

create or replace function public.cc_my_appointments(p_work_date date)
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
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'source_key',a.source_key,'work_date',a.work_date,
    'scheduled_time',to_char(a.scheduled_time,'HH24:MI'),
    'scheduled_end_time',to_char(d.oracle_end_time,'HH24:MI'),'population',a.population,
    'prospect_ref',a.prospect_ref,'status',a.status::text,'contacted_at',a.contacted_at,
    'last_synced_at',a.last_synced_at,'updated_at',a.updated_at,'source_missing',a.source_missing,
    'installation_type',coalesce(d.installation_type,''),'phone',coalesce(d.phone,''),
    'full_address',coalesce(d.full_address,''),'postal_code',coalesce(d.postal_code,''),
    'private_note',coalesce(d.private_note,''),'cancellation_reason',coalesce(d.cancellation_reason,'')
  ) order by a.scheduled_time,a.id),'[]'::jsonb) into v_result
  from confirmar_citas.appointments a
  left join confirmar_citas.appointment_private_data d
    on d.appointment_id=a.id and d.technician_id=v_actor
  where a.technician_id=v_actor and a.work_date=p_work_date
    and a.work_date>=confirmar_citas.sync_cutoff()
    and a.team_id is not null and confirmar_citas.is_team_member(a.team_id);
  return v_result;
end;
$$;

-- The ordinary and ignored writes must commit together or both roll back.
create function public.cc_import_oracle_agenda(
  p_team_id uuid, p_work_date date, p_installations jsonb, p_ignored jsonb
)
returns integer language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_installations jsonb;
  v_count integer;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if jsonb_typeof(p_installations) is distinct from 'array'
     or jsonb_typeof(p_ignored) is distinct from 'array' then
    raise exception 'invalid import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_installations) > 500 or jsonb_array_length(p_ignored) > 100
     or octet_length(p_installations::text) > 1048576 or octet_length(p_ignored::text) > 65536
     or (jsonb_array_length(p_installations) = 0 and jsonb_array_length(p_ignored) = 0) then
    raise exception 'invalid import size' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_installations) as row(value)
    where jsonb_typeof(value) is distinct from 'object' or (value ? 'end_time' and (
      coalesce(value->>'end_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or (value->>'end_time') collate "C" < left(value->>'scheduled_time', 5) collate "C"
    ))) then
    raise exception 'invalid import date or time format' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cc_import_oracle_agenda:' || v_actor::text, 0));
  select coalesce(jsonb_agg(value - 'end_time' order by position), '[]'::jsonb)
    into v_installations from jsonb_array_elements(p_installations) with ordinality as rows(value, position);
  v_count := public.cc_sync_appointment_batch(p_team_id, p_work_date, v_installations);
  perform public.cc_save_my_ignored_interventions(p_work_date, p_ignored);
  update confirmar_citas.appointment_private_data d
     set oracle_end_time = (row.value->>'end_time')::time
    from confirmar_citas.appointments a, jsonb_array_elements(p_installations) as row(value)
   where d.appointment_id = a.id and d.technician_id = v_actor
     and a.technician_id = v_actor and a.team_id = p_team_id and a.work_date = p_work_date
     and a.source_key = (row.value->>'source_key')::uuid;
  return v_count;
end;
$$;

revoke all on function public.cc_import_oracle_agenda(uuid,date,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cc_import_oracle_agenda(uuid,date,jsonb,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
