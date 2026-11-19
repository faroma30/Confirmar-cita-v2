-- Keep only the current authenticated worker's ignored Oracle rows (including
-- their own contact fields) within the existing per-user retention boundary.
begin;

create or replace function public.cc_save_my_ignored_interventions(p_work_date date, p_rows jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row jsonb;
  v_existing jsonb;
  v_updated jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician')
     or p_work_date is null or p_work_date < confirmar_citas.sync_cutoff()
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or (v_row - array['time','type','customer_name','phone','population','full_address','postal_code']) <> '{}'::jsonb
       or coalesce(jsonb_typeof(v_row->'time'),'') <> 'string'
       or coalesce(jsonb_typeof(v_row->'type'),'') <> 'string'
       or coalesce(v_row->>'time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or length(coalesce(v_row->>'type','')) > 200
       or (v_row ? 'customer_name' and (jsonb_typeof(v_row->'customer_name') <> 'string' or length(v_row->>'customer_name') > 200))
       or (v_row ? 'phone' and (jsonb_typeof(v_row->'phone') <> 'string' or length(v_row->>'phone') > 40))
       or (v_row ? 'population' and (jsonb_typeof(v_row->'population') <> 'string' or length(v_row->>'population') > 120))
       or (v_row ? 'full_address' and (jsonb_typeof(v_row->'full_address') <> 'string' or length(v_row->>'full_address') > 500))
       or (v_row ? 'postal_code' and (jsonb_typeof(v_row->'postal_code') <> 'string' or length(v_row->>'postal_code') > 20)) then
      raise exception 'invalid ignored intervention' using errcode = '22023';
    end if;
  end loop;

  select coalesce(ignored_by_work_date, '{}'::jsonb) into v_existing
    from confirmar_citas.user_preferences where user_id = v_actor;
  v_existing := coalesce(v_existing, '{}'::jsonb);
  v_updated := jsonb_set(v_existing, array[p_work_date::text], p_rows, true);
  if pg_column_size(v_updated) > 65536 then
    raise exception 'invalid ignored intervention' using errcode = '22023';
  end if;

  insert into confirmar_citas.user_preferences as current_preferences(user_id, ignored_by_work_date)
    values (v_actor, v_updated)
  on conflict (user_id) do update set ignored_by_work_date = excluded.ignored_by_work_date,
    updated_at = clock_timestamp();
end;
$$;

revoke all on function public.cc_save_my_ignored_interventions(date,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cc_save_my_ignored_interventions(date,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
