-- Persistent appointment workspace for technicians and Masters.
-- Client contact data is stored only in an owner-scoped private table. The
-- Master summary RPC returns the supervision projection without those fields.
begin;

alter table confirmar_citas.appointments
  add column if not exists source_missing boolean not null default false;

alter table confirmar_citas.user_preferences
  add column if not exists installation_keywords text[] not null
    default array['kit hogar','kit básico','kit basico','kit negocio','kit premium']::text[],
  add column if not exists cancellation_email_to text,
  add column if not exists cancellation_email_cc text,
  add column if not exists cancellation_email_subject text;

create table confirmar_citas.appointment_private_data (
  appointment_id uuid primary key references confirmar_citas.appointments(id) on delete cascade,
  technician_id uuid not null references confirmar_citas.profiles(user_id) on delete restrict,
  installation_type text not null default '',
  phone text not null default '',
  full_address text not null default '',
  postal_code text not null default '',
  private_note text not null default '',
  cancellation_reason text not null default '',
  updated_at timestamptz not null default clock_timestamp(),
  check (length(phone) <= 40),
  check (length(installation_type) <= 200),
  check (length(full_address) <= 500),
  check (length(postal_code) <= 20),
  check (length(private_note) <= 4000),
  check (length(cancellation_reason) <= 2000)
);
create index appointment_private_data_owner_idx
  on confirmar_citas.appointment_private_data(technician_id, appointment_id);
alter table confirmar_citas.appointment_private_data enable row level security;
alter table confirmar_citas.appointment_private_data force row level security;
create policy appointment_private_data_owner_read
  on confirmar_citas.appointment_private_data for select to authenticated
  using (technician_id = auth.uid()
    and confirmar_citas.is_active_account()
    and confirmar_citas.current_app_role() in ('master','technician'));
revoke all on confirmar_citas.appointment_private_data from public, anon, authenticated, service_role;

create function public.cc_my_appointment_teams()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_role confirmar_citas.app_role; v_result jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  v_role := confirmar_citas.current_app_role();
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name),'[]'::jsonb)
  into v_result
  from confirmar_citas.team_members tm
  join confirmar_citas.teams t on t.id=tm.team_id and t.active
  where tm.user_id=v_actor and tm.status='active'
    and ((v_role='master' and tm.member_role='master')
      or (v_role='technician' and tm.member_role='technician'));
  return v_result;
end;
$$;

create function public.cc_my_appointments(p_work_date date)
returns jsonb
language plpgsql stable security definer
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
    'id', a.id, 'source_key', a.source_key, 'work_date', a.work_date,
    'scheduled_time', to_char(a.scheduled_time, 'HH24:MI'),
    'population', a.population, 'prospect_ref', a.prospect_ref,
    'status', a.status::text, 'contacted_at', a.contacted_at,
    'last_synced_at', a.last_synced_at, 'updated_at', a.updated_at,
    'source_missing', a.source_missing,
    'installation_type', coalesce(d.installation_type, ''),
    'phone', coalesce(d.phone, ''), 'full_address', coalesce(d.full_address, ''),
    'postal_code', coalesce(d.postal_code, ''), 'private_note', coalesce(d.private_note, ''),
    'cancellation_reason', coalesce(d.cancellation_reason, '')
  ) order by a.scheduled_time, a.id), '[]'::jsonb)
  into v_result
  from confirmar_citas.appointments a
  left join confirmar_citas.appointment_private_data d
    on d.appointment_id = a.id and d.technician_id = v_actor
  where a.technician_id = v_actor and a.work_date = p_work_date
    and a.work_date >= confirmar_citas.sync_cutoff();
  return v_result;
end;
$$;

create function public.cc_my_appointment_identity_index()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_key',a.source_key,'work_date',a.work_date,
    'scheduled_time',to_char(a.scheduled_time,'HH24:MI'),'population',a.population,
    'prospect_ref',a.prospect_ref,'installation_type',coalesce(d.installation_type,''),
    'phone',coalesce(d.phone,''),'full_address',coalesce(d.full_address,''),
    'postal_code',coalesce(d.postal_code,''),'private_note',coalesce(d.private_note,''),
    'cancellation_reason',coalesce(d.cancellation_reason,'')
  ) order by a.work_date,a.scheduled_time),'[]'::jsonb)
  into v_result from confirmar_citas.appointments a
  left join confirmar_citas.appointment_private_data d
    on d.appointment_id=a.id and d.technician_id=v_actor
  where a.technician_id=v_actor and a.work_date>=confirmar_citas.sync_cutoff();
  return v_result;
end;
$$;

create function public.cc_master_team_appointments(p_work_date date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() <> 'master'
     or p_work_date is null or p_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'technician_id', a.technician_id, 'technician', p.display_name,
    'team_id', a.team_id, 'work_date', a.work_date,
    'scheduled_time', to_char(a.scheduled_time, 'HH24:MI'),
    'population', a.population, 'prospect_ref', a.prospect_ref,
    'status', a.status::text, 'contacted_at', a.contacted_at,
    'last_updated_at', a.updated_at
  ) order by p.display_name, a.scheduled_time, a.id), '[]'::jsonb)
  into v_result
  from confirmar_citas.appointments a
  join confirmar_citas.profiles p on p.user_id = a.technician_id
  where a.work_date = p_work_date and a.work_date >= confirmar_citas.sync_cutoff()
    and a.team_id is not null
    and confirmar_citas.is_team_master(a.team_id)
    and confirmar_citas.is_technician_in_my_team(a.technician_id, a.team_id);
  return v_result;
end;
$$;

create function public.cc_sync_appointment_batch(p_team_id uuid, p_work_date date, p_rows jsonb)
returns integer
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid(); v_core_rows jsonb; v_count integer := 0;
  v_item jsonb; v_source_key uuid; v_appointment_id uuid; v_role confirmar_citas.app_role;
  v_installation_keywords text[];
  v_normalized_type text;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_role := confirmar_citas.current_app_role();
  if (v_role = 'technician' and not confirmar_citas.is_team_member(p_team_id))
     or (v_role = 'master' and not confirmar_citas.is_team_master(p_team_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array'
     or p_work_date is null or p_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'invalid import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 or octet_length(p_rows::text) > 1048576 then
    raise exception 'invalid import size' using errcode = '22023';
  end if;
  select p.installation_keywords into v_installation_keywords
  from confirmar_citas.user_preferences p where p.user_id=v_actor;
  v_installation_keywords := coalesce(v_installation_keywords,
    array['kit hogar','kit básico','kit basico','kit negocio','kit premium']::text[]);
  for v_item in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or (v_item - array['source_key','work_date','scheduled_time','population','prospect_ref','type',
         'kind','phone','full_address','postal_code','private_note','cancellation_reason']::text[]) <> '{}'::jsonb
      or v_item->>'kind' is distinct from 'installation'
      or v_item->>'work_date' is distinct from p_work_date::text then
      raise exception 'invalid installation import' using errcode = '22023';
    end if;
    v_normalized_type := translate(lower(coalesce(v_item->>'type','')),'áéíóúü','aeiouu');
    if length(btrim(v_normalized_type)) = 0
       or v_normalized_type ~ '(manten|averia|reparacion|revision|inspeccion)'
       or not exists (
         select 1 from unnest(v_installation_keywords) as keyword(value)
         where nullif(btrim(keyword.value),'') is not null
           and strpos(v_normalized_type,translate(lower(btrim(keyword.value)),'áéíóúü','aeiouu'))>0
       ) then
      raise exception 'invalid installation import' using errcode = '22023';
    end if;
    if length(coalesce(v_item->>'phone','')) > 40
       or length(coalesce(v_item->>'type','')) > 200
       or length(coalesce(v_item->>'full_address','')) > 500
       or length(coalesce(v_item->>'postal_code','')) > 20
       or length(coalesce(v_item->>'private_note','')) > 4000
       or length(coalesce(v_item->>'cancellation_reason','')) > 2000 then
      raise exception 'invalid private field size' using errcode = '22023';
    end if;
    if (v_item->>'source_key') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid source key' using errcode = '22023';
    end if;
    if exists (select 1 from confirmar_citas.appointments a
       where a.technician_id = v_actor and a.source_key = (v_item->>'source_key')::uuid
         and a.team_id is distinct from p_team_id) then
      raise exception 'appointment team ownership conflict' using errcode = '42501';
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'source_key', value->'source_key', 'work_date', value->'work_date',
    'scheduled_time', value->'scheduled_time', 'population', value->'population',
    'prospect_ref', value->'prospect_ref'
  )), '[]'::jsonb) into v_core_rows from jsonb_array_elements(p_rows);

  update confirmar_citas.appointments a set source_missing = true
  where a.technician_id = v_actor and a.team_id = p_team_id and a.work_date = p_work_date;
  if jsonb_array_length(p_rows) > 0 then
    v_count := confirmar_citas.sync_appointments(p_team_id, v_core_rows);
    for v_item in select value from jsonb_array_elements(p_rows)
    loop
      v_source_key := (v_item->>'source_key')::uuid;
      select a.id into v_appointment_id from confirmar_citas.appointments a
      where a.technician_id = v_actor and a.source_key = v_source_key
        and a.work_date = p_work_date and a.team_id = p_team_id;
      if v_appointment_id is null then
        raise exception 'appointment sync failed' using errcode = '22023';
      end if;
      update confirmar_citas.appointments set source_missing = false where id = v_appointment_id;
      insert into confirmar_citas.appointment_private_data(
        appointment_id, technician_id, installation_type, phone, full_address, postal_code, private_note,
        cancellation_reason, updated_at
      ) values (
        v_appointment_id, v_actor, coalesce(v_item->>'type',''), coalesce(v_item->>'phone',''),
        coalesce(v_item->>'full_address',''), coalesce(v_item->>'postal_code',''),
        coalesce(v_item->>'private_note',''), coalesce(v_item->>'cancellation_reason',''), clock_timestamp()
      ) on conflict (appointment_id) do update set
        technician_id = excluded.technician_id, installation_type = excluded.installation_type,
        phone = excluded.phone,
        full_address = excluded.full_address, postal_code = excluded.postal_code,
        private_note = excluded.private_note, cancellation_reason = excluded.cancellation_reason,
        updated_at = excluded.updated_at;
      v_appointment_id := null;
    end loop;
  end if;
  return v_count;
end;
$$;

create function public.cc_set_appointment_status(p_appointment_id uuid, p_new_status text)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
begin
  if p_new_status not in ('pending','confirmed','cancelled') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  perform confirmar_citas.set_appointment_status(
    p_appointment_id, p_new_status::confirmar_citas.appointment_status
  );
end;
$$;

create function public.cc_record_whatsapp_open(p_appointment_id uuid)
returns timestamptz language sql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$ select confirmar_citas.record_whatsapp_open(p_appointment_id) $$;

create function public.cc_save_appointment_private(
  p_appointment_id uuid, p_phone text, p_full_address text, p_postal_code text,
  p_private_note text, p_cancellation_reason text
)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_date date;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if length(coalesce(p_phone,'')) > 40 or length(coalesce(p_full_address,'')) > 500
     or length(coalesce(p_postal_code,'')) > 20 or length(coalesce(p_private_note,'')) > 4000
     or length(coalesce(p_cancellation_reason,'')) > 2000 then
    raise exception 'invalid private field size' using errcode = '22023';
  end if;
  select a.work_date into v_date from confirmar_citas.appointments a
  where a.id=p_appointment_id and a.technician_id=v_actor for update;
  if not found or v_date < confirmar_citas.sync_cutoff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into confirmar_citas.appointment_private_data(
    appointment_id, technician_id, phone, full_address, postal_code,
    private_note, cancellation_reason, updated_at
  ) values (p_appointment_id,v_actor,coalesce(p_phone,''),coalesce(p_full_address,''),
    coalesce(p_postal_code,''),coalesce(p_private_note,''),coalesce(p_cancellation_reason,''),clock_timestamp())
  on conflict (appointment_id) do update set
    phone=excluded.phone, full_address=excluded.full_address, postal_code=excluded.postal_code,
    private_note=excluded.private_note, cancellation_reason=excluded.cancellation_reason,
    updated_at=excluded.updated_at;
end;
$$;

create function public.cc_edit_appointment_details(
  p_appointment_id uuid, p_scheduled_time text, p_population text,
  p_phone text, p_full_address text, p_postal_code text
)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_date date; v_time time without time zone;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if coalesce(p_scheduled_time,'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or length(btrim(coalesce(p_population,''))) not between 1 and 160
     or length(coalesce(p_phone,''))>40 or length(coalesce(p_full_address,''))>500
     or length(coalesce(p_postal_code,''))>20 then
    raise exception 'invalid appointment details' using errcode='22023';
  end if;
  v_time := p_scheduled_time::time;
  select work_date into v_date from confirmar_citas.appointments
  where id=p_appointment_id and technician_id=v_actor for update;
  if not found or v_date<confirmar_citas.sync_cutoff() then
    raise exception 'not authorized' using errcode='42501';
  end if;
  update confirmar_citas.appointments set scheduled_time=v_time,population=btrim(p_population),updated_at=clock_timestamp()
  where id=p_appointment_id and technician_id=v_actor;
  insert into confirmar_citas.appointment_private_data(
    appointment_id,technician_id,phone,full_address,postal_code
  ) values (p_appointment_id,v_actor,coalesce(p_phone,''),coalesce(p_full_address,''),coalesce(p_postal_code,''))
  on conflict(appointment_id) do update set
    phone=excluded.phone,full_address=excluded.full_address,postal_code=excluded.postal_code,
    updated_at=clock_timestamp();
end;
$$;

create function public.cc_cancel_appointment(p_appointment_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid();
begin
  if nullif(btrim(p_reason),'') is null or length(p_reason)>2000 then
    raise exception 'invalid cancellation reason' using errcode = '22023';
  end if;
  perform confirmar_citas.set_appointment_status(p_appointment_id, 'cancelled');
  update confirmar_citas.appointment_private_data set cancellation_reason=btrim(p_reason), updated_at=clock_timestamp()
  where appointment_id=p_appointment_id and technician_id=v_actor;
  if not found then
    insert into confirmar_citas.appointment_private_data(appointment_id,technician_id,cancellation_reason)
    values (p_appointment_id,v_actor,btrim(p_reason));
  end if;
end;
$$;

create function public.cc_delete_appointment(p_appointment_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_date date;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select work_date into v_date from confirmar_citas.appointments
  where id=p_appointment_id and technician_id=v_actor for update;
  if not found or v_date < confirmar_citas.sync_cutoff() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from confirmar_citas.appointments where id=p_appointment_id and technician_id=v_actor;
end;
$$;

create function public.cc_my_appointment_preferences()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  select jsonb_build_object(
    'installation_keywords', p.installation_keywords,
    'installation_template', p.installation_template,
    'maintenance_template', p.maintenance_template,
    'cancellation_template', p.cancellation_template,
    'cancellation_email_to', p.cancellation_email_to,
    'cancellation_email_cc', p.cancellation_email_cc,
    'cancellation_email_subject', p.cancellation_email_subject
  ) into v_result from confirmar_citas.user_preferences p where p.user_id=v_actor;
  return coalesce(v_result,jsonb_build_object(
    'installation_keywords', array['kit hogar','kit básico','kit basico','kit negocio','kit premium'],
    'installation_template',null,'maintenance_template',null,'cancellation_template',null,
    'cancellation_email_to',null,'cancellation_email_cc',null,'cancellation_email_subject',null));
end;
$$;

create function public.cc_save_my_appointment_preferences(
  p_installation_keywords text[], p_installation_template text,
  p_maintenance_template text, p_cancellation_template text,
  p_email_to text, p_email_cc text, p_email_subject text
)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if coalesce(array_length(p_installation_keywords,1),0)>40
     or length(coalesce(p_installation_template,''))>10000
     or length(coalesce(p_maintenance_template,''))>10000
     or length(coalesce(p_cancellation_template,''))>10000
     or length(coalesce(p_email_to,''))>320 or length(coalesce(p_email_cc,''))>1000
     or length(coalesce(p_email_subject,''))>500 then
    raise exception 'invalid preference size' using errcode='22023';
  end if;
  insert into confirmar_citas.user_preferences(
    user_id, installation_keywords, installation_template, maintenance_template,
    cancellation_template, cancellation_email_to, cancellation_email_cc,
    cancellation_email_subject, updated_at
  ) values (
    v_actor, coalesce(p_installation_keywords,array[]::text[]), p_installation_template,
    p_maintenance_template, p_cancellation_template, p_email_to, p_email_cc,
    p_email_subject, clock_timestamp()
  ) on conflict (user_id) do update set
    installation_keywords=excluded.installation_keywords,
    installation_template=excluded.installation_template,
    maintenance_template=excluded.maintenance_template,
    cancellation_template=excluded.cancellation_template,
    cancellation_email_to=excluded.cancellation_email_to,
    cancellation_email_cc=excluded.cancellation_email_cc,
    cancellation_email_subject=excluded.cancellation_email_subject,
    updated_at=excluded.updated_at;
end;
$$;

revoke all on function public.cc_my_appointments(date) from public, anon, authenticated, service_role;
revoke all on function public.cc_my_appointment_identity_index() from public, anon, authenticated, service_role;
revoke all on function public.cc_my_appointment_teams() from public, anon, authenticated, service_role;
revoke all on function public.cc_master_team_appointments(date) from public, anon, authenticated, service_role;
revoke all on function public.cc_sync_appointment_batch(uuid,date,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.cc_set_appointment_status(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.cc_record_whatsapp_open(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cc_save_appointment_private(uuid,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.cc_edit_appointment_details(uuid,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.cc_cancel_appointment(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.cc_delete_appointment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cc_my_appointment_preferences() from public, anon, authenticated, service_role;
revoke all on function public.cc_save_my_appointment_preferences(text[],text,text,text,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.cc_my_appointments(date) to authenticated;
grant execute on function public.cc_my_appointment_identity_index() to authenticated;
grant execute on function public.cc_my_appointment_teams() to authenticated;
grant execute on function public.cc_master_team_appointments(date) to authenticated;
grant execute on function public.cc_sync_appointment_batch(uuid,date,jsonb) to authenticated;
grant execute on function public.cc_set_appointment_status(uuid,text) to authenticated;
grant execute on function public.cc_record_whatsapp_open(uuid) to authenticated;
grant execute on function public.cc_save_appointment_private(uuid,text,text,text,text,text) to authenticated;
grant execute on function public.cc_edit_appointment_details(uuid,text,text,text,text,text) to authenticated;
grant execute on function public.cc_cancel_appointment(uuid,text) to authenticated;
grant execute on function public.cc_delete_appointment(uuid) to authenticated;
grant execute on function public.cc_my_appointment_preferences() to authenticated;
grant execute on function public.cc_save_my_appointment_preferences(text[],text,text,text,text,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
