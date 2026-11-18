-- Guard both singleton updates for the hosted REST connection's safe-update requirement.
begin;
create or replace function public.cc_route_budget_begin_operation(p_actor uuid, p_lease uuid, p_operation text)
returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  state confirmar_citas.route_budget_lock%rowtype;
  stamp timestamptz;
begin
  if p_actor is null or p_lease is null or p_operation is null
    or p_operation not in ('route','autocomplete') then return false; end if;
  select * into strict state from confirmar_citas.route_budget_lock for update;
  stamp := clock_timestamp();
  if (state.lease is not null and state.lease_until > stamp)
    or state.paused_until > stamp or state.last_charge > stamp - interval '300 milliseconds' then return false; end if;
  delete from confirmar_citas.route_budget_reservation where charged_at <= stamp - interval '24 hours';
  if (select coalesce(sum(credits), 0) from confirmar_citas.route_budget_reservation) >= 2500 then return false; end if;
  if p_operation = 'autocomplete' then
    delete from confirmar_citas.route_budget_autocomplete_cooldown where started_at <= stamp - interval '500 milliseconds';
    insert into confirmar_citas.route_budget_autocomplete_cooldown(actor, started_at) values (p_actor, stamp)
      on conflict do nothing;
  else
    delete from confirmar_citas.route_budget_cooldown where started_at <= stamp - interval '2 minutes';
    insert into confirmar_citas.route_budget_cooldown(actor, started_at) values (p_actor, stamp)
      on conflict do nothing;
  end if;
  if not found then return false; end if;
  update confirmar_citas.route_budget_lock set lease = p_lease,
    lease_until = stamp + case when p_operation = 'autocomplete' then interval '8 seconds' else interval '65 seconds' end
    where singleton is true;
  return true;
end;
$$;

create or replace function public.cc_route_budget_charge(p_lease uuid, p_credits integer)
returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  state confirmar_citas.route_budget_lock%rowtype;
  stamp timestamptz;
begin
  if p_lease is null or p_credits is null or p_credits not between 1 and 2 then return false; end if;
  select * into strict state from confirmar_citas.route_budget_lock for update;
  stamp := clock_timestamp();
  if state.lease is distinct from p_lease or state.lease_until <= stamp
    or state.last_charge > stamp - interval '275 milliseconds' then return false; end if;
  delete from confirmar_citas.route_budget_reservation where charged_at <= stamp - interval '24 hours';
  if (select coalesce(sum(credits), 0) from confirmar_citas.route_budget_reservation) + p_credits > 2500 then return false; end if;
  insert into confirmar_citas.route_budget_reservation(charged_at, credits) values (stamp, p_credits);
  update confirmar_citas.route_budget_lock set last_charge = stamp
    where singleton is true;
  return true;
end;
$$;

commit;
