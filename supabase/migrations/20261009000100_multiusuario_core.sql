-- Confirmar Citas multiusuario: esquema local/dev. No contiene cuentas ni datos reales.
begin;

create schema confirmar_citas;


revoke all on schema confirmar_citas from public, anon, authenticated, service_role;


create type confirmar_citas.app_role as enum ('admin', 'master', 'technician');
create type confirmar_citas.account_status as enum ('pending_activation', 'active', 'disabled');
create type confirmar_citas.team_member_role as enum ('master', 'technician');
create type confirmar_citas.membership_status as enum ('active', 'inactive');
create type confirmar_citas.appointment_status as enum ('pending', 'confirmed', 'cancelled');

create table confirmar_citas.global_settings (
  singleton boolean primary key default true check (singleton),
  retention_days integer not null default 3 check (retention_days between 1 and 30),
  business_timezone text not null default 'Europe/Madrid'
    check (business_timezone = 'Europe/Madrid'),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
-- Fail closed from the moment the settings table exists. The admin read policy
-- is installed in the retention migration; until then authenticated has no rows.
alter table confirmar_citas.global_settings enable row level security;

insert into confirmar_citas.global_settings (singleton, retention_days, business_timezone)
values (true, 3, 'Europe/Madrid');

create table confirmar_citas.profiles (
  user_id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  role confirmar_citas.app_role not null,
  status confirmar_citas.account_status not null default 'pending_activation',
  must_change_password boolean not null default true,
  activation_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint active_profile_is_activated check (
    status <> 'active' or (must_change_password = false and activation_verified_at is not null)
  )
);

create table confirmar_citas.login_identifiers (
  user_id uuid primary key references confirmar_citas.profiles(user_id) on delete restrict,
  employee_id_hmac bytea not null unique,
  hmac_key_version smallint not null check (hmac_key_version > 0),
  created_at timestamptz not null default now()
);

create table confirmar_citas.teams (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  active boolean not null default true,
  created_by uuid references confirmar_citas.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table confirmar_citas.team_members (
  team_id uuid not null references confirmar_citas.teams(id) on delete restrict,
  user_id uuid not null references confirmar_citas.profiles(user_id) on delete restrict,
  member_role confirmar_citas.team_member_role not null,
  status confirmar_citas.membership_status not null default 'active',
  created_by uuid references confirmar_citas.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index team_members_user_idx on confirmar_citas.team_members (user_id, status);
create index team_members_team_role_idx on confirmar_citas.team_members (team_id, member_role, status);
-- Enforce one active team per technician under concurrent membership RPCs.
create unique index team_members_one_active_team_per_technician_idx
  on confirmar_citas.team_members (user_id)
  where status = 'active' and member_role = 'technician';

create or replace function confirmar_citas.sync_cutoff()
returns date
language sql volatile security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select (clock_timestamp() at time zone 'Europe/Madrid')::date
       - (g.retention_days - 1)
  from confirmar_citas.global_settings as g where g.singleton
$$;
revoke all on function confirmar_citas.sync_cutoff() from public, anon;
grant execute on function confirmar_citas.sync_cutoff() to authenticated;

create table confirmar_citas.appointments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  technician_id uuid not null references confirmar_citas.profiles(user_id) on delete restrict,
  team_id uuid references confirmar_citas.teams(id) on delete restrict,
  work_date date not null,
  scheduled_time time without time zone not null,
  population text not null check (length(trim(population)) between 1 and 160),
  prospect_ref text check (prospect_ref is null or length(trim(prospect_ref)) between 1 and 80),
  -- UUID estable del cliente local; se conserva al reimportar. Para prospectos sin
  -- referencia se genera una vez y se enlaza localmente mediante una huella privada.
  source_key uuid not null,
  status confirmar_citas.appointment_status not null default 'pending',
  contacted_at timestamptz,
  last_synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (technician_id, source_key)
);

create unique index appointments_prospect_unique_idx
  on confirmar_citas.appointments (technician_id, prospect_ref)
  where prospect_ref is not null;
create index appointments_team_date_idx on confirmar_citas.appointments (team_id, work_date);
create index appointments_owner_date_idx on confirmar_citas.appointments (technician_id, work_date);

-- Los datos de cliente no se sincronizan ni se almacenan en Postgres. Teléfono,
-- dirección completa y notas se conservan solo localmente con la retención descrita.
create table confirmar_citas.appointment_status_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  appointment_id uuid not null references confirmar_citas.appointments(id) on delete cascade,
  actor_id uuid not null references confirmar_citas.profiles(user_id) on delete restrict,
  previous_status confirmar_citas.appointment_status,
  new_status confirmar_citas.appointment_status not null,
  occurred_at timestamptz not null default now(),
  check (previous_status is distinct from new_status)
);
create index appointment_status_events_appointment_idx
  on confirmar_citas.appointment_status_events (appointment_id, occurred_at desc);

-- La apertura de WhatsApp es un hecho distinto al estado de la cita.
create table confirmar_citas.whatsapp_open_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  appointment_id uuid not null references confirmar_citas.appointments(id) on delete cascade,
  actor_id uuid not null references confirmar_citas.profiles(user_id) on delete restrict,
  opened_at timestamptz not null default now()
);
create index whatsapp_open_events_appointment_idx
  on confirmar_citas.whatsapp_open_events (appointment_id, opened_at desc);

create table confirmar_citas.user_preferences (
  user_id uuid primary key references confirmar_citas.profiles(user_id) on delete restrict,
  installation_template text,
  maintenance_template text,
  cancellation_template text,
  updated_at timestamptz not null default now()
);

create or replace function confirmar_citas.guard_user_preferences_mutation()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
begin
  if auth.uid() is null or auth.role() <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.user_id <> auth.uid() or not confirmar_citas.is_active_account() then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    return old;
  end if;
  if not confirmar_citas.is_active_account()
     or (tg_op = 'UPDATE' and (old.user_id <> auth.uid()
                               or new.user_id is distinct from old.user_id))
     or (tg_op = 'INSERT' and new.user_id <> auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger user_preferences_guard_mutations before insert or update or delete
on confirmar_citas.user_preferences for each row execute function confirmar_citas.guard_user_preferences_mutation();
revoke all on function confirmar_citas.guard_user_preferences_mutation() from public, anon, authenticated;

create table confirmar_citas.audit_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  actor_id uuid references confirmar_citas.profiles(user_id) on delete set null,
  actor_role confirmar_citas.app_role,
  action text not null check (length(action) between 1 and 80),
  target_type text not null check (length(target_type) between 1 and 80),
  target_id uuid,
  team_id uuid references confirmar_citas.teams(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (pg_column_size(metadata) <= 4096)
);
create index audit_logs_created_idx on confirmar_citas.audit_logs (created_at desc);
create index audit_logs_team_created_idx on confirmar_citas.audit_logs (team_id, created_at desc);

create or replace function confirmar_citas.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger profiles_touch before update on confirmar_citas.profiles
for each row execute function confirmar_citas.touch_updated_at();
create trigger teams_touch before update on confirmar_citas.teams
for each row execute function confirmar_citas.touch_updated_at();
create trigger team_members_touch before update on confirmar_citas.team_members
for each row execute function confirmar_citas.touch_updated_at();
create trigger appointments_touch before update on confirmar_citas.appointments
for each row execute function confirmar_citas.touch_updated_at();
create trigger user_preferences_touch before update on confirmar_citas.user_preferences
for each row execute function confirmar_citas.touch_updated_at();

create or replace function confirmar_citas.current_app_role()
returns confirmar_citas.app_role
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select p.role
  from confirmar_citas.profiles as p
  where p.user_id = auth.uid()
    and p.status = 'active'
    and p.must_change_password = false
$$;

create or replace function confirmar_citas.is_active_account()
returns boolean
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select exists (
    select 1 from confirmar_citas.profiles as p
    where p.user_id = auth.uid()
      and p.status = 'active'
      and p.must_change_password = false
  )
$$;

create or replace function confirmar_citas.is_team_member(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select exists (
    select 1
    from confirmar_citas.team_members as tm
    join confirmar_citas.teams as t on t.id = tm.team_id and t.active
    where tm.team_id = p_team_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and confirmar_citas.is_active_account()
  )
$$;

create or replace function confirmar_citas.is_team_master(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select confirmar_citas.current_app_role() = 'master'
    and exists (
      select 1
      from confirmar_citas.team_members as tm
      join confirmar_citas.teams as t on t.id = tm.team_id and t.active
      where tm.team_id = p_team_id
        and tm.user_id = auth.uid()
        and tm.member_role = 'master'
        and tm.status = 'active'
    )
$$;

create or replace function confirmar_citas.is_technician_in_my_team(
  p_technician_id uuid,
  p_team_id uuid default null
)
returns boolean
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select confirmar_citas.current_app_role() = 'master'
    and exists (
      select 1
      from confirmar_citas.team_members as mine
      join confirmar_citas.team_members as target
        on target.team_id = mine.team_id
       and target.member_role = 'technician'
       and target.status = 'active'
       and (p_team_id is null or target.team_id = p_team_id)
      join confirmar_citas.profiles as technician
        on technician.user_id = target.user_id
       and technician.role = 'technician'
       and technician.status = 'active'
       and technician.must_change_password = false
      join confirmar_citas.teams as t on t.id = mine.team_id and t.active
      where mine.user_id = auth.uid()
        and mine.member_role = 'master'
        and mine.status = 'active'
        and (p_team_id is null or mine.team_id = p_team_id)
        and target.user_id = p_technician_id
    )
$$;

create or replace function confirmar_citas.is_active_technician(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select exists (
    select 1 from confirmar_citas.profiles as p
    where p.user_id = p_user_id
      and p.role = 'technician'
      and p.status = 'active'
      and p.must_change_password = false
  )
$$;

create or replace function confirmar_citas.assert_can_provision_user(
  p_target_role confirmar_citas.app_role,
  p_team_id uuid default null
)
returns void
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_role confirmar_citas.app_role;
begin
  if not confirmar_citas.is_active_account() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_role := confirmar_citas.current_app_role();
  if v_role = 'admin' and p_target_role in ('master', 'technician') then
    return;
  end if;
  if v_role = 'master'
     and p_target_role = 'technician'
     and p_team_id is not null
     and confirmar_citas.is_team_master(p_team_id) then
    return;
  end if;
  -- Admin bootstrap only: nunca se crea otro admin desde una llamada normal.
  raise exception 'not authorized' using errcode = '42501';
end;
$$;

create or replace function confirmar_citas.guard_admin_audit_log()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception 'audit log is append-only' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger audit_logs_append_only before insert or update or delete
on confirmar_citas.audit_logs for each row execute function confirmar_citas.guard_admin_audit_log();
revoke all on function confirmar_citas.guard_admin_audit_log() from public, anon, authenticated;


create or replace function confirmar_citas.manage_technician_membership(
  p_team_id uuid,
  p_technician_id uuid,
  p_active boolean
)
returns void
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role confirmar_citas.app_role;
begin
  if not confirmar_citas.is_active_account() or v_actor is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_actor_role := confirmar_citas.current_app_role();
  if not (v_actor_role = 'admin' or confirmar_citas.is_team_master(p_team_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from confirmar_citas.profiles p
    where p.user_id = p_technician_id
      and p.role = 'technician'
      and p.status <> 'disabled'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_active and v_actor_role = 'master'
     and exists (
       select 1 from confirmar_citas.team_members
       where user_id = p_technician_id and team_id <> p_team_id and status = 'active'
     ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into confirmar_citas.team_members (team_id, user_id, member_role, status, created_by)
  values (p_team_id, p_technician_id, 'technician',
          case when p_active then 'active'::confirmar_citas.membership_status
               else 'inactive'::confirmar_citas.membership_status end,
          v_actor)
  on conflict (team_id, user_id) do update
    set status = excluded.status;
  insert into confirmar_citas.audit_logs (actor_id, actor_role, action, target_type, target_id, team_id)
  values (v_actor, v_actor_role, case when p_active then 'technician_team_activated'
                                      else 'technician_team_deactivated' end,
          'team_membership', p_technician_id, p_team_id);
end;
$$;

create or replace function confirmar_citas.sync_appointments(
  p_team_id uuid,
  p_rows jsonb
)
returns integer
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role confirmar_citas.app_role;
  v_row jsonb;
  v_count integer := 0;
  v_work_date date;
  v_source_key uuid;
  v_time time without time zone;
  v_population text;
  v_prospect text;
  v_now timestamptz;
  v_cutoff date;
  v_existing_date date;
  v_existing_prospect text;
  v_saved_id uuid;
begin
  if v_actor is null or not confirmar_citas.is_active_account() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_role := confirmar_citas.current_app_role();
  if v_role not in ('master', 'technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if (v_role = 'technician' and not confirmar_citas.is_team_member(p_team_id))
     or (v_role = 'master' and not confirmar_citas.is_team_master(p_team_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'invalid import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 or octet_length(p_rows::text) > 1048576 then
    raise exception 'invalid import size' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as batch(row_value)
    where jsonb_typeof(row_value) = 'object'
      and jsonb_typeof(row_value->'source_key') = 'string'
    group by lower(row_value->>'source_key') having count(*) > 1
  ) then
    raise exception 'duplicate source_key in import' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as batch(row_value)
    where jsonb_typeof(row_value) = 'object'
      and jsonb_typeof(row_value->'prospect_ref') = 'string'
      and nullif(btrim(row_value->>'prospect_ref'), '') is not null
    group by btrim(row_value->>'prospect_ref') having count(*) > 1
  ) then
    raise exception 'duplicate prospect_ref in import' using errcode = '22023';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row) is distinct from 'object'
       or (v_row - array['source_key','work_date','scheduled_time','population','prospect_ref']::text[]) <> '{}'::jsonb then
      raise exception 'invalid import fields' using errcode = '22023';
    end if;
    if jsonb_typeof(v_row->'source_key') is distinct from 'string'
       or (v_row->>'source_key') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_row->'work_date') is distinct from 'string'
       or jsonb_typeof(v_row->'scheduled_time') is distinct from 'string'
       or jsonb_typeof(v_row->'population') is distinct from 'string'
       or (v_row ? 'prospect_ref' and jsonb_typeof(v_row->'prospect_ref') not in ('string','null')) then
      raise exception 'invalid import field types' using errcode = '22023';
    end if;
    if (v_row->>'work_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or (v_row->>'scheduled_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
      raise exception 'invalid import date or time format' using errcode = '22023';
    end if;
    v_source_key := (v_row->>'source_key')::uuid;
    v_work_date := (v_row->>'work_date')::date;
    v_time := (v_row->>'scheduled_time')::time;
    v_population := trim(v_row->>'population');
    v_prospect := nullif(trim(v_row->>'prospect_ref'), '');
    v_cutoff := confirmar_citas.sync_cutoff();
    if v_work_date < v_cutoff then
      raise exception 'expired appointment' using errcode = '22023';
    end if;
    if v_source_key is null or v_time is null
       or v_population is null or length(v_population) not between 1 and 160
       or (v_prospect is not null and length(v_prospect) > 80) then
      raise exception 'invalid import' using errcode = '22023';
    end if;
    v_now := clock_timestamp();
    insert into confirmar_citas.appointments (
      technician_id, team_id, work_date, scheduled_time, population,
      prospect_ref, source_key, last_synced_at, created_at, updated_at
    ) select
      v_actor, p_team_id, v_work_date, v_time, v_population,
      v_prospect, v_source_key, v_now, v_now, v_now
    where v_work_date >= confirmar_citas.sync_cutoff()
    on conflict (technician_id, source_key) do update
      set team_id = excluded.team_id,
          work_date = excluded.work_date,
          scheduled_time = excluded.scheduled_time,
          population = excluded.population,
          prospect_ref = coalesce(excluded.prospect_ref, appointments.prospect_ref),
          last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at
      where appointments.work_date >= confirmar_citas.sync_cutoff()
        and (appointments.prospect_ref is null
             or excluded.prospect_ref is null
             or appointments.prospect_ref = excluded.prospect_ref)
    returning id into v_saved_id;
    if not found then
      select a.work_date, a.prospect_ref
        into v_existing_date, v_existing_prospect
      from confirmar_citas.appointments as a
      where a.technician_id = v_actor and a.source_key = v_source_key
      for update;
      if found then
        if v_existing_date < confirmar_citas.sync_cutoff() then
          raise exception 'expired appointment' using errcode = '22023';
        end if;
        if v_existing_prospect is not null and v_prospect is not null
           and v_existing_prospect is distinct from v_prospect then
          raise exception 'source key reuse' using errcode = '22023';
        end if;
      end if;
      raise exception 'expired appointment' using errcode = '22023';
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function confirmar_citas.set_appointment_status(
  p_appointment_id uuid,
  p_new_status confirmar_citas.appointment_status
)
returns void
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_old_status confirmar_citas.appointment_status;
  v_work_date date;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master', 'technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select a.status, a.work_date into v_old_status, v_work_date
  from confirmar_citas.appointments as a
  where a.id = p_appointment_id and a.technician_id = v_actor
  for update;
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'expired appointment' using errcode = '22023';
  end if;
  if v_old_status is distinct from p_new_status then
    update confirmar_citas.appointments
      set status = p_new_status, updated_at = clock_timestamp()
      where id = p_appointment_id and technician_id = v_actor
        and work_date >= confirmar_citas.sync_cutoff();
    if not found then
      raise exception 'expired appointment' using errcode = '22023';
    end if;
    insert into confirmar_citas.appointment_status_events
      (appointment_id, actor_id, previous_status, new_status)
    values (p_appointment_id, v_actor, v_old_status, p_new_status);
  end if;
end;
$$;

create or replace function confirmar_citas.record_whatsapp_open(p_appointment_id uuid)
returns timestamptz
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_opened_at timestamptz;
  v_work_date date;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master', 'technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select a.work_date into v_work_date
  from confirmar_citas.appointments as a
  where a.id = p_appointment_id and a.technician_id = v_actor
  for update;
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'expired appointment' using errcode = '22023';
  end if;
  v_opened_at := clock_timestamp();
  update confirmar_citas.appointments
    set contacted_at = v_opened_at, updated_at = v_opened_at
    where id = p_appointment_id and technician_id = v_actor
      and work_date >= confirmar_citas.sync_cutoff();
  if not found then
    raise exception 'expired appointment' using errcode = '22023';
  end if;
  insert into confirmar_citas.whatsapp_open_events (appointment_id, actor_id, opened_at)
  values (p_appointment_id, v_actor, v_opened_at);
  return v_opened_at;
end;
$$;

create or replace function confirmar_citas.validate_team_member_role()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_role confirmar_citas.app_role;
begin
  select p.role into v_role from confirmar_citas.profiles as p where p.user_id = new.user_id;
  if v_role is null or v_role::text <> new.member_role::text then
    raise exception 'team membership role mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger team_member_role_check before insert or update of user_id, member_role
on confirmar_citas.team_members for each row execute function confirmar_citas.validate_team_member_role();
revoke all on function confirmar_citas.validate_team_member_role() from public, anon, authenticated;

alter table confirmar_citas.profiles enable row level security;
alter table confirmar_citas.teams enable row level security;
alter table confirmar_citas.team_members enable row level security;
alter table confirmar_citas.appointments enable row level security;
alter table confirmar_citas.appointment_status_events enable row level security;
alter table confirmar_citas.whatsapp_open_events enable row level security;
alter table confirmar_citas.user_preferences enable row level security;
alter table confirmar_citas.audit_logs enable row level security;
alter table confirmar_citas.login_identifiers enable row level security;

create policy profiles_read on confirmar_citas.profiles for select to authenticated
using (
  user_id = auth.uid()
  or (confirmar_citas.is_active_account() and confirmar_citas.current_app_role() = 'admin')
  or (role = 'technician' and confirmar_citas.is_technician_in_my_team(user_id))
);

create policy teams_read on confirmar_citas.teams for select to authenticated
using (
  (confirmar_citas.is_active_account() and confirmar_citas.current_app_role() = 'admin')
  or confirmar_citas.is_team_member(id)
);

create policy team_members_read on confirmar_citas.team_members for select to authenticated
using (
  (confirmar_citas.is_active_account() and confirmar_citas.current_app_role() = 'admin')
  or user_id = auth.uid()
  or (member_role = 'technician' and confirmar_citas.is_team_master(team_id))
);

create policy appointments_read on confirmar_citas.appointments for select to authenticated
using (
  confirmar_citas.is_active_account()
  and work_date >= confirmar_citas.sync_cutoff()
  and (
    technician_id = auth.uid()
    or (team_id is not null
        and confirmar_citas.is_team_master(team_id)
        and confirmar_citas.is_technician_in_my_team(technician_id, team_id))
  )
);

create policy appointment_status_events_read on confirmar_citas.appointment_status_events
for select to authenticated using (
  confirmar_citas.is_active_account()
  and exists (select 1 from confirmar_citas.appointments eligible
              where eligible.id = appointment_id
                and eligible.work_date >= confirmar_citas.sync_cutoff())
  and exists (select 1 from confirmar_citas.appointments a
              where a.id = appointment_id and a.technician_id = auth.uid())
);

create policy whatsapp_open_events_read on confirmar_citas.whatsapp_open_events
for select to authenticated using (
  confirmar_citas.is_active_account()
  and exists (select 1 from confirmar_citas.appointments eligible
              where eligible.id = appointment_id
                and eligible.work_date >= confirmar_citas.sync_cutoff())
  and exists (select 1 from confirmar_citas.appointments a
              where a.id = appointment_id and a.technician_id = auth.uid())
);

create policy user_preferences_owner on confirmar_citas.user_preferences for all to authenticated
using (confirmar_citas.is_active_account()
       and confirmar_citas.current_app_role() in ('master', 'technician')
       and user_id = auth.uid())
with check (confirmar_citas.is_active_account()
            and confirmar_citas.current_app_role() in ('master', 'technician')
            and user_id = auth.uid());

create policy audit_logs_admin_read on confirmar_citas.audit_logs for select to authenticated
using (confirmar_citas.is_active_account() and confirmar_citas.current_app_role() = 'admin');

create policy login_identifiers_no_client_access on confirmar_citas.login_identifiers
for all to authenticated using (false) with check (false);

-- Owner-rights views are the client read surface; each predicate applies the
-- module identity and scope before returning data. Base-table SELECT is revoked.
create view confirmar_citas.my_profile
with (security_barrier = true, security_invoker = false)
as
select p.user_id, p.display_name, p.role, p.status, p.must_change_password,
       p.activation_verified_at, p.created_at, p.updated_at
from confirmar_citas.profiles p where p.user_id = auth.uid();

create view confirmar_citas.admin_profiles
with (security_barrier = true, security_invoker = false)
as
select p.user_id, p.display_name, p.role, p.status, p.must_change_password,
       p.activation_verified_at, p.created_at, p.updated_at
from confirmar_citas.profiles p
where confirmar_citas.is_active_account() and confirmar_citas.current_app_role() = 'admin';

create view confirmar_citas.master_team_technicians
with (security_barrier = true, security_invoker = false)
as
select tm.team_id, p.user_id as technician_id, p.display_name, tm.status as membership_status
from confirmar_citas.team_members tm
join confirmar_citas.teams t on t.id = tm.team_id and t.active
join confirmar_citas.profiles p on p.user_id = tm.user_id
where confirmar_citas.is_active_account()
  and confirmar_citas.current_app_role() = 'master'
  and confirmar_citas.is_team_master(tm.team_id)
  and tm.member_role = 'technician' and p.role = 'technician';

create view confirmar_citas.my_appointments
with (security_barrier = true, security_invoker = false)
as
select a.id, a.work_date, a.scheduled_time, a.population, a.prospect_ref,
       a.status, a.contacted_at, a.last_synced_at, a.updated_at
from confirmar_citas.appointments a
where confirmar_citas.is_active_account()
  and confirmar_citas.current_app_role() in ('master','technician')
  and a.technician_id = auth.uid()
  and a.work_date >= confirmar_citas.sync_cutoff();

create view confirmar_citas.master_appointment_summary
with (security_barrier = true, security_invoker = false)
as
select a.technician_id, p.display_name as technician, a.work_date, a.scheduled_time,
       a.population, a.prospect_ref, a.status, a.contacted_at,
       a.updated_at as last_updated_at
from confirmar_citas.appointments a
join confirmar_citas.profiles p on p.user_id = a.technician_id
where confirmar_citas.is_active_account()
  and confirmar_citas.current_app_role() = 'master'
  and a.work_date >= confirmar_citas.sync_cutoff()
  and a.team_id is not null
  and confirmar_citas.is_team_master(a.team_id)
  and confirmar_citas.is_technician_in_my_team(a.technician_id, a.team_id);

revoke all on confirmar_citas.profiles, confirmar_citas.teams, confirmar_citas.team_members, confirmar_citas.appointments,
  confirmar_citas.appointment_status_events, confirmar_citas.whatsapp_open_events,
  confirmar_citas.user_preferences, confirmar_citas.audit_logs from public, anon, authenticated, service_role;
revoke all on confirmar_citas.my_profile, confirmar_citas.admin_profiles,
  confirmar_citas.master_team_technicians, confirmar_citas.my_appointments,
  confirmar_citas.master_appointment_summary from public, anon, authenticated, service_role;
grant select on confirmar_citas.teams, confirmar_citas.team_members,
  confirmar_citas.appointment_status_events, confirmar_citas.whatsapp_open_events,
  confirmar_citas.audit_logs to authenticated;
grant select, insert, update on confirmar_citas.user_preferences to authenticated;
grant select on confirmar_citas.my_profile, confirmar_citas.admin_profiles,
  confirmar_citas.master_team_technicians, confirmar_citas.my_appointments,
  confirmar_citas.master_appointment_summary to authenticated;

-- Client DML is revoked below; trusted SECURITY DEFINER RPCs perform checked writes.

revoke all on schema confirmar_citas from service_role;

revoke all on confirmar_citas.login_identifiers from public, anon, authenticated, service_role;
revoke all on confirmar_citas.global_settings from public, anon, authenticated, service_role;
grant select on confirmar_citas.global_settings to authenticated;
revoke all on function confirmar_citas.sync_cutoff() from public, anon, service_role;
grant execute on function confirmar_citas.sync_cutoff() to authenticated;
revoke all on function confirmar_citas.current_app_role() from public, anon, service_role;
revoke all on function confirmar_citas.is_active_account() from public, anon, service_role;
revoke all on function confirmar_citas.is_team_member(uuid) from public, anon, service_role;
revoke all on function confirmar_citas.is_team_master(uuid) from public, anon, service_role;
revoke all on function confirmar_citas.is_technician_in_my_team(uuid, uuid) from public, anon, service_role;
revoke all on function confirmar_citas.is_active_technician(uuid) from public, anon, authenticated, service_role;
grant execute on function confirmar_citas.current_app_role() to authenticated;
grant execute on function confirmar_citas.is_active_account() to authenticated;
grant execute on function confirmar_citas.is_team_member(uuid) to authenticated;
grant execute on function confirmar_citas.is_team_master(uuid) to authenticated;
grant execute on function confirmar_citas.is_technician_in_my_team(uuid, uuid) to authenticated;
grant usage on schema confirmar_citas to postgres;
grant usage on schema confirmar_citas to authenticated;
grant select on confirmar_citas.global_settings to postgres;
revoke all on function confirmar_citas.touch_updated_at() from public, anon, authenticated, service_role;
revoke all on function confirmar_citas.guard_user_preferences_mutation() from service_role;
revoke all on function confirmar_citas.guard_admin_audit_log() from service_role;
revoke all on function confirmar_citas.validate_team_member_role() from service_role;

revoke all on function confirmar_citas.assert_can_provision_user(confirmar_citas.app_role, uuid) from public, anon;
revoke all on function confirmar_citas.assert_can_provision_user(confirmar_citas.app_role, uuid) from service_role;
revoke all on function confirmar_citas.manage_technician_membership(uuid, uuid, boolean) from public, anon, service_role;
revoke all on function confirmar_citas.sync_appointments(uuid, jsonb) from public, anon, service_role;
revoke all on function confirmar_citas.set_appointment_status(uuid, confirmar_citas.appointment_status) from public, anon, service_role;
revoke all on function confirmar_citas.record_whatsapp_open(uuid) from public, anon, service_role;
grant execute on function confirmar_citas.assert_can_provision_user(confirmar_citas.app_role, uuid) to authenticated;
grant execute on function confirmar_citas.manage_technician_membership(uuid, uuid, boolean) to authenticated;
grant execute on function confirmar_citas.sync_appointments(uuid, jsonb) to authenticated;
grant execute on function confirmar_citas.set_appointment_status(uuid, confirmar_citas.appointment_status) to authenticated;
grant execute on function confirmar_citas.record_whatsapp_open(uuid) to authenticated;

commit;
