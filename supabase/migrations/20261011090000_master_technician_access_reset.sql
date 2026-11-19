-- Enforce effective technician membership access, show and regularize the
-- normalized login identifier, and reset credentials without crossing teams.
-- Additive forward migration. It preserves existing accounts and appointments.
begin;

create or replace function confirmar_citas.current_app_role()
returns confirmar_citas.app_role
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
  select p.role
  from confirmar_citas.profiles p
  where p.user_id = auth.uid()
    and p.status = 'active'
    and not p.must_change_password
    and (p.sessions_invalid_before is null or
         coalesce((auth.jwt() ->> 'iat')::bigint, 0) >= p.sessions_invalid_before)
    and (p.role <> 'technician' or exists (
      select 1
      from confirmar_citas.team_members tm
      join confirmar_citas.teams t on t.id = tm.team_id and t.active
      where tm.user_id = p.user_id and tm.member_role = 'technician' and tm.status = 'active'
    ))
$$;

create or replace function confirmar_citas.is_active_account()
returns boolean
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
  select exists (
    select 1 from confirmar_citas.profiles p
    where p.user_id = auth.uid()
      and p.status = 'active'
      and p.must_change_password = false
      and (p.sessions_invalid_before is null or
           coalesce((auth.jwt() ->> 'iat')::bigint, 0) >= p.sessions_invalid_before)
      and (p.role <> 'technician' or exists (
        select 1
        from confirmar_citas.team_members tm
        join confirmar_citas.teams t on t.id = tm.team_id and t.active
        where tm.user_id = p.user_id and tm.member_role = 'technician' and tm.status = 'active'
      ))
  )
$$;

-- A technician with no active team is presented as unavailable to the client
-- even when an already-issued JWT restores the session. The profile row itself
-- is not changed by a Master removing one team membership.
create or replace view confirmar_citas.my_profile
with (security_barrier = true, security_invoker = false)
as
select p.user_id, p.display_name, p.role,
       case when p.role = 'technician' and not exists (
         select 1 from confirmar_citas.team_members tm
         join confirmar_citas.teams t on t.id = tm.team_id and t.active
         where tm.user_id = p.user_id and tm.member_role = 'technician' and tm.status = 'active'
       ) then 'disabled'::confirmar_citas.account_status else p.status end as status,
       p.must_change_password, p.activation_verified_at, p.created_at, p.updated_at,
       p.sessions_invalid_before, p.presentation_name
from confirmar_citas.profiles p
where p.user_id = auth.uid();

create or replace function confirmar_citas.resolve_active_login_user(p_employee_digest_hex text)
returns uuid
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
  select li.user_id
  from confirmar_citas.login_identifiers li
  join confirmar_citas.profiles p on p.user_id = li.user_id
  where p_employee_digest_hex ~ '^[0-9a-fA-F]{64}$'
    and li.employee_id_hmac = decode(p_employee_digest_hex, 'hex')
    and li.hmac_key_version = 1
    and (
      (p.status = 'active' and not p.must_change_password and p.activation_verified_at is not null)
      or (p.status = 'pending_activation' and p.must_change_password and p.activation_verified_at is null)
    )
    and (p.role <> 'technician' or exists (
      select 1 from confirmar_citas.team_members tm
      join confirmar_citas.teams t on t.id = tm.team_id and t.active
      where tm.user_id = p.user_id and tm.member_role = 'technician' and tm.status = 'active'
    ))
  limit 1
$$;

-- Team membership removal is deliberately scoped. It does not disable a
-- multi-team account globally. Existing sessions lose access to that team's
-- appointments immediately; a technician with another active team keeps only
-- that other team's access. The last active membership blocks all module use.
create or replace function confirmar_citas.manage_technician_membership(
  p_team_id uuid,
  p_technician_id uuid,
  p_active boolean
)
returns void
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
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
    where p.user_id = p_technician_id and p.role = 'technician' and p.status <> 'disabled'
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Master may deactivate only their own membership, but cannot attach or
  -- reactivate a technician already active in another team. Admin controls
  -- cross-team assignments; this prevents a Master from expanding their scope.
  if p_active and v_actor_role = 'master'
     and exists (select 1 from confirmar_citas.team_members other_membership
       where other_membership.user_id = p_technician_id
         and other_membership.team_id <> p_team_id
         and other_membership.member_role = 'technician'
         and other_membership.status = 'active') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into confirmar_citas.team_members (team_id, user_id, member_role, status, created_by)
  values (p_team_id, p_technician_id, 'technician',
          case when p_active then 'active'::confirmar_citas.membership_status
               else 'inactive'::confirmar_citas.membership_status end, v_actor)
  on conflict (team_id, user_id) do update set status = excluded.status;
  insert into confirmar_citas.audit_logs (actor_id, actor_role, action, target_type, target_id, team_id)
  values (v_actor, v_actor_role,
          case when p_active then 'technician_team_activated' else 'technician_team_deactivated' end,
          'team_membership', p_technician_id, p_team_id);
end;
$$;

create or replace function confirmar_citas.can_read_own_appointment_activity(p_appointment_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
  select confirmar_citas.is_active_account()
     and confirmar_citas.current_app_role() in ('master', 'technician')
     and exists (
       select 1 from confirmar_citas.appointments a
       where a.id = p_appointment_id
         and a.technician_id = auth.uid()
         and a.team_id is not null
         and confirmar_citas.is_team_member(a.team_id)
         and a.work_date >= confirmar_citas.sync_cutoff()
     )
$$;

drop policy if exists appointments_read on confirmar_citas.appointments;
create policy appointments_read on confirmar_citas.appointments for select to authenticated
using (
  confirmar_citas.is_active_account()
  and work_date >= confirmar_citas.sync_cutoff()
  and (
    (technician_id = auth.uid() and team_id is not null and confirmar_citas.is_team_member(team_id))
    or (team_id is not null
        and confirmar_citas.is_team_master(team_id)
        and confirmar_citas.is_technician_in_my_team(technician_id, team_id))
  )
);

-- Include the existing, already-verified display value in the Admin-only
-- directory. Master output continues to use its independently scoped view.
create or replace view confirmar_citas.admin_user_directory
with (security_barrier = true, security_invoker = false)
as
select p.user_id, p.display_name, p.role, p.status, p.must_change_password,
       p.activation_verified_at, p.created_at,
       coalesce((select jsonb_agg(jsonb_build_object(
           'team_id', tm.team_id, 'team_name', t.name, 'membership_status', tm.status
         ) order by t.name)
         from confirmar_citas.team_members tm
         join confirmar_citas.teams t on t.id = tm.team_id
         where tm.user_id = p.user_id), '[]'::jsonb) as teams,
       p.employee_id_display
from confirmar_citas.profiles p
where confirmar_citas.is_active_account()
  and confirmar_citas.current_app_role() = 'admin';

create or replace function confirmar_citas.regularize_login_identifier_display(
  p_actor_id uuid, p_user_id uuid, p_employee_id text, p_employee_digest_hex text
)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare v_stored boolean;
begin
  if not exists (select 1 from confirmar_citas.profiles p
      where p.user_id = p_actor_id and p.role = 'admin' and p.status = 'active'
        and not p.must_change_password and p.activation_verified_at is not null)
     or not exists (select 1 from confirmar_citas.profiles p
      where p.user_id = p_user_id and p.role = 'technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select confirmar_citas.store_login_identifier_display(
    p_user_id, p_employee_id, p_employee_digest_hex
  ) into v_stored;
  if v_stored then
    insert into confirmar_citas.audit_logs (actor_id, actor_role, action, target_type, target_id)
    values (p_actor_id, 'admin', 'technician_login_label_regularized', 'profile', p_user_id);
  end if;
  return coalesce(v_stored, false);
end;
$$;
revoke all on function confirmar_citas.regularize_login_identifier_display(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function confirmar_citas.regularize_login_identifier_display(uuid,uuid,text,text)
  to service_role;

create or replace function public.cc_regularize_login_identifier_display(
  p_actor_id uuid, p_user_id uuid, p_employee_id text, p_employee_digest_hex text
)
returns boolean language sql security invoker set search_path = pg_catalog
as $$
  select confirmar_citas.regularize_login_identifier_display(
    p_actor_id, p_user_id, p_employee_id, p_employee_digest_hex
  )
$$;
revoke all on function public.cc_regularize_login_identifier_display(uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.cc_regularize_login_identifier_display(uuid,uuid,text,text)
  to service_role;

-- Prepare a reset only after the target's canonical normalized ID is available.
-- Master resets are restricted to a technician with exactly one active team
-- membership, preventing a team-scoped Master from globally changing a
-- multi-team account's credentials. Admin may handle those global resets.
create or replace function confirmar_citas.prepare_account_password_reset(p_actor_id uuid, p_target_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, pg_temp
as $$
declare
  v_actor_role confirmar_citas.app_role;
  v_target_role confirmar_citas.app_role;
  v_employee_id text;
  v_team_id uuid;
  v_active_team_count integer;
begin
  select role into v_actor_role from confirmar_citas.profiles
  where user_id = p_actor_id and status = 'active'
    and must_change_password = false and activation_verified_at is not null;
  if v_actor_role is null or v_actor_role not in ('admin','master')
     or p_target_id is null or p_actor_id = p_target_id then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select role, employee_id_display into v_target_role, v_employee_id
  from confirmar_citas.profiles where user_id = p_target_id
    and status in ('active','pending_activation') for update;
  if v_target_role is null or v_target_role not in ('master','technician')
     or (v_actor_role = 'master' and v_target_role <> 'technician') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_employee_id is null or v_employee_id !~ '^[A-Z0-9]{6,20}$' then
    return jsonb_build_object('ready', false, 'reason', 'identifier_regularization_required');
  end if;
  if v_target_role = 'technician' then
    select count(*)::integer into v_active_team_count
    from confirmar_citas.team_members tm join confirmar_citas.teams t
      on t.id = tm.team_id and t.active
    where tm.user_id = p_target_id and tm.member_role = 'technician' and tm.status = 'active';
  else
    v_active_team_count := 1;
  end if;
  if v_actor_role = 'master' then
    select mine.team_id into v_team_id
    from confirmar_citas.team_members mine
    join confirmar_citas.teams t on t.id = mine.team_id and t.active
    join confirmar_citas.team_members target
      on target.team_id = mine.team_id and target.user_id = p_target_id
    where mine.user_id = p_actor_id and mine.member_role = 'master' and mine.status = 'active'
      and target.member_role = 'technician' and target.status = 'active'
    order by mine.team_id limit 1;
    if v_team_id is null or v_active_team_count <> 1 then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  else
    select team_id into v_team_id from confirmar_citas.team_members
    where user_id = p_target_id and member_role = 'technician' and status = 'active'
    order by team_id limit 1;
  end if;
  update confirmar_citas.profiles
  set status = 'pending_activation', must_change_password = true,
      activation_verified_at = null,
      sessions_invalid_before = floor(extract(epoch from clock_timestamp()))::bigint + 1,
      updated_at = clock_timestamp()
  where user_id = p_target_id;
  insert into confirmar_citas.audit_logs (actor_id, actor_role, action, target_type, target_id, team_id)
  values (p_actor_id, v_actor_role, 'credential_reset_started', 'profile', p_target_id, v_team_id);
  return jsonb_build_object('ready', true, 'employee_id', v_employee_id, 'team_id', v_team_id);
end;
$$;
revoke all on function confirmar_citas.prepare_account_password_reset(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function confirmar_citas.prepare_account_password_reset(uuid,uuid)
  to service_role;

create or replace function public.cc_prepare_account_password_reset(p_actor_id uuid, p_target_id uuid)
returns jsonb language sql security invoker set search_path = pg_catalog
as $$ select confirmar_citas.prepare_account_password_reset(p_actor_id,p_target_id) $$;
revoke all on function public.cc_prepare_account_password_reset(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cc_prepare_account_password_reset(uuid,uuid) to service_role;

-- Respect membership per appointment for every own-data operation. Existing
-- inactive-team appointments are retained and become accessible only if an
-- authorized active membership is restored by Admin.
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
    'scheduled_time',to_char(a.scheduled_time,'HH24:MI'),'population',a.population,
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

create or replace function public.cc_my_appointment_identity_index()
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
  ) order by a.work_date,a.scheduled_time),'[]'::jsonb) into v_result
  from confirmar_citas.appointments a
  left join confirmar_citas.appointment_private_data d
    on d.appointment_id=a.id and d.technician_id=v_actor
  where a.technician_id=v_actor and a.work_date>=confirmar_citas.sync_cutoff()
    and a.team_id is not null and confirmar_citas.is_team_member(a.team_id);
  return v_result;
end;
$$;

-- Add membership guard to core state/contact mutations by replacing their
-- authorization predicates in their own row-locking implementations.
create or replace function confirmar_citas.set_appointment_status(
  p_appointment_id uuid, p_new_status confirmar_citas.appointment_status
)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_old_status confirmar_citas.appointment_status;
  v_work_date date; v_team_id uuid;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  select a.status,a.work_date,a.team_id into v_old_status,v_work_date,v_team_id
  from confirmar_citas.appointments a
  where a.id=p_appointment_id and a.technician_id=v_actor for update;
  if not found or v_team_id is null or not confirmar_citas.is_team_member(v_team_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if v_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'expired appointment' using errcode='22023';
  end if;
  if v_old_status is distinct from p_new_status then
    update confirmar_citas.appointments set status=p_new_status,updated_at=clock_timestamp()
    where id=p_appointment_id and technician_id=v_actor and team_id=v_team_id
      and work_date>=confirmar_citas.sync_cutoff();
    if not found then raise exception 'expired appointment' using errcode='22023'; end if;
    insert into confirmar_citas.appointment_status_events(appointment_id,actor_id,previous_status,new_status)
    values(p_appointment_id,v_actor,v_old_status,p_new_status);
  end if;
end;
$$;

create or replace function confirmar_citas.record_whatsapp_open(p_appointment_id uuid)
returns timestamptz language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_opened_at timestamptz; v_work_date date; v_team_id uuid;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  select a.work_date,a.team_id into v_work_date,v_team_id
  from confirmar_citas.appointments a
  where a.id=p_appointment_id and a.technician_id=v_actor for update;
  if not found or v_team_id is null or not confirmar_citas.is_team_member(v_team_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if v_work_date < confirmar_citas.sync_cutoff() then
    raise exception 'expired appointment' using errcode='22023';
  end if;
  v_opened_at:=clock_timestamp();
  update confirmar_citas.appointments set contacted_at=v_opened_at,updated_at=v_opened_at
  where id=p_appointment_id and technician_id=v_actor and team_id=v_team_id
    and work_date>=confirmar_citas.sync_cutoff();
  if not found then raise exception 'expired appointment' using errcode='22023'; end if;
  insert into confirmar_citas.whatsapp_open_events(appointment_id,actor_id,opened_at)
  values(p_appointment_id,v_actor,v_opened_at);
  return v_opened_at;
end;
$$;

create or replace function public.cc_save_appointment_private(
  p_appointment_id uuid,p_phone text,p_full_address text,p_postal_code text,
  p_private_note text,p_cancellation_reason text
)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
declare v_actor uuid:=auth.uid(); v_date date; v_team_id uuid;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  if length(coalesce(p_phone,''))>40 or length(coalesce(p_full_address,''))>500
     or length(coalesce(p_postal_code,''))>20 or length(coalesce(p_private_note,''))>4000
     or length(coalesce(p_cancellation_reason,''))>2000 then
    raise exception 'invalid private field size' using errcode='22023';
  end if;
  select a.work_date,a.team_id into v_date,v_team_id from confirmar_citas.appointments a
  where a.id=p_appointment_id and a.technician_id=v_actor for update;
  if not found or v_date<confirmar_citas.sync_cutoff() or v_team_id is null
     or not confirmar_citas.is_team_member(v_team_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  insert into confirmar_citas.appointment_private_data(appointment_id,technician_id,phone,full_address,postal_code,private_note,cancellation_reason,updated_at)
  values(p_appointment_id,v_actor,coalesce(p_phone,''),coalesce(p_full_address,''),coalesce(p_postal_code,''),coalesce(p_private_note,''),coalesce(p_cancellation_reason,''),clock_timestamp())
  on conflict(appointment_id) do update set phone=excluded.phone,full_address=excluded.full_address,
    postal_code=excluded.postal_code,private_note=excluded.private_note,
    cancellation_reason=excluded.cancellation_reason,updated_at=excluded.updated_at;
end;
$$;

create or replace function public.cc_edit_appointment_details(
  p_appointment_id uuid,p_scheduled_time text,p_population text,p_phone text,p_full_address text,p_postal_code text
)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
declare v_actor uuid:=auth.uid(); v_date date; v_team_id uuid; v_time time without time zone;
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
  v_time:=p_scheduled_time::time;
  select a.work_date,a.team_id into v_date,v_team_id from confirmar_citas.appointments a
  where a.id=p_appointment_id and a.technician_id=v_actor for update;
  if not found or v_date<confirmar_citas.sync_cutoff() or v_team_id is null
     or not confirmar_citas.is_team_member(v_team_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  update confirmar_citas.appointments set scheduled_time=v_time,population=btrim(p_population),updated_at=clock_timestamp()
  where id=p_appointment_id and technician_id=v_actor and team_id=v_team_id;
  insert into confirmar_citas.appointment_private_data(appointment_id,technician_id,phone,full_address,postal_code)
  values(p_appointment_id,v_actor,coalesce(p_phone,''),coalesce(p_full_address,''),coalesce(p_postal_code,''))
  on conflict(appointment_id) do update set phone=excluded.phone,full_address=excluded.full_address,
    postal_code=excluded.postal_code,updated_at=clock_timestamp();
end;
$$;

create or replace function public.cc_delete_appointment(p_appointment_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
declare v_actor uuid:=auth.uid(); v_date date; v_team_id uuid;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  select a.work_date,a.team_id into v_date,v_team_id from confirmar_citas.appointments a
  where a.id=p_appointment_id and a.technician_id=v_actor for update;
  if not found or v_date<confirmar_citas.sync_cutoff() or v_team_id is null
     or not confirmar_citas.is_team_member(v_team_id) then
    raise exception 'not authorized' using errcode='42501';
  end if;
  delete from confirmar_citas.appointments where id=p_appointment_id and technician_id=v_actor and team_id=v_team_id;
end;
$$;

-- Retention/clean-up remains user triggered, but can only affect appointments
-- associated with teams in which the caller still has active membership.
create or replace function public.cc_delete_my_appointment_day(p_work_date date)
returns integer language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
declare v_actor uuid:=auth.uid(); v_count integer;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') or p_work_date is null then
    raise exception 'not authorized' using errcode='42501';
  end if;
  update confirmar_citas.user_preferences set ignored_by_work_date=coalesce(ignored_by_work_date,'{}'::jsonb)-p_work_date::text,
    updated_at=clock_timestamp() where user_id=v_actor;
  delete from confirmar_citas.appointments a where a.technician_id=v_actor and a.work_date=p_work_date
    and a.team_id is not null and confirmar_citas.is_team_member(a.team_id);
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

create or replace function public.cc_purge_my_appointments_before_today()
returns integer language plpgsql security definer
set search_path = pg_catalog, confirmar_citas, auth, pg_temp
as $$
declare v_actor uuid:=auth.uid(); v_count integer;
begin
  if v_actor is null or not confirmar_citas.is_active_account()
     or confirmar_citas.current_app_role() not in ('master','technician') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  delete from confirmar_citas.appointments a
  where a.technician_id=v_actor and a.work_date<(clock_timestamp() at time zone 'Europe/Madrid')::date
    and a.team_id is not null and confirmar_citas.is_team_member(a.team_id);
  get diagnostics v_count=row_count;
  update confirmar_citas.user_preferences p set
    ignored_by_work_date=coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(p.ignored_by_work_date) e
      where e.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and e.key>=((clock_timestamp() at time zone 'Europe/Madrid')::date)::text),'{}'::jsonb),
    updated_at=clock_timestamp() where p.user_id=v_actor;
  return v_count;
end;
$$;

notify pgrst, 'reload schema';
commit;
