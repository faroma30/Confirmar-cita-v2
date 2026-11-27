-- =====================================================================================
-- PENDIENTE DE APLICAR (CONFIRMAR_CITAS-026). Escrita y NO ejecutada. Solo Supabase de la V2
-- (no es el de Controla). Aplicar únicamente con autorización registrada del Director.
-- =====================================================================================
-- Decisión del Director (27/11/2026 08:13): decir por qué se bloquea el cálculo y, si es la espera,
-- cuántos segundos faltan. La espera entre cálculos y el presupuesto compartido están en tablas que
-- la función (service_role) no puede leer. Esta migración AÑADE una función de solo lectura.
-- No cambia ninguna función, tabla, tope, espera ni permiso existente.
-- Devuelve solo: los segundos de espera del técnico pedido (0-120) y tres sí/no globales, sin cifras,
-- identificadores ni datos de otros técnicos. Solo la puede ejecutar service_role.
-- Prueba aislada (escrita, no ejecutada): supabase/tests/isolated/route-budget-wait-isolated.sql
-- =====================================================================================
begin;

do $guard$
begin
  if to_regprocedure('public.cc_route_budget_wait(uuid)') is not null then
    raise exception 'CONFIRMAR_CITAS-026: public.cc_route_budget_wait ya existe; no se cambia nada';
  end if;
  if position($needle$interval '2 minutes'$needle$ in pg_get_functiondef('public.cc_route_budget_begin_operation(uuid,uuid,text)'::regprocedure)) = 0
    or position($needle$>= 2500$needle$ in pg_get_functiondef('public.cc_route_budget_begin_operation(uuid,uuid,text)'::regprocedure)) = 0 then
    raise exception 'CONFIRMAR_CITAS-026: la definicion de public.cc_route_budget_begin_operation no es la esperada; no se cambia nada';
  end if;
end
$guard$;

create function public.cc_route_budget_wait(p_actor uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select jsonb_build_object(
    'waitSeconds', coalesce((
      select greatest(0, ceil(extract(epoch from c.started_at + interval '2 minutes' - statement_timestamp())))::integer
      from confirmar_citas.route_budget_cooldown c where c.actor = p_actor), 0),
    'busy', exists (
      select 1 from confirmar_citas.route_budget_lock l
      where l.lease is not null and l.lease_until > statement_timestamp()),
    'paused', exists (
      select 1 from confirmar_citas.route_budget_lock l where l.paused_until > statement_timestamp()),
    'sharedLimit', (
      select coalesce(sum(r.credits), 0) >= 2500 from confirmar_citas.route_budget_reservation r
      where r.charged_at > statement_timestamp() - interval '24 hours')
  );
$function$;

revoke all on function public.cc_route_budget_wait(uuid) from public, anon, authenticated;
grant execute on function public.cc_route_budget_wait(uuid) to service_role;

commit;
