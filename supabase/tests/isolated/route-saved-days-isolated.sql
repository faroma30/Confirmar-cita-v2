-- Prueba SQL aislada de 20261128090000_route_saved_days.sql (CONFIRMAR_CITAS-031).
-- ESCRITA Y NO EJECUTADA. Nunca contra el proyecto real.
-- Requisitos: base local o desechable con el esquema de la V2, dos técnicos FICTICIOS activos y la
-- migración recién aplicada.
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f route-saved-days-isolated.sql
-- Todo ocurre dentro de una transacción que termina en ROLLBACK.

begin;

do $test$
declare
  uno uuid;
  otro uuid;
  hoy date := (statement_timestamp() at time zone 'Europe/Madrid')::date;
  tramo jsonb := jsonb_build_array(jsonb_build_object('a', repeat('a', 64), 's', repeat('b', 64),
    't', '2026-11-28T08:00:00.000Z', 'd', 600, 'm', 5000, 'src', jsonb_build_array('cartociudad', null)));
  entrar text := 'select set_config(''request.jwt.claim.sub'', %L, true), set_config(''request.jwt.claims'', %L, true)';
  rechazado boolean;
begin
  select (array_agg(p.user_id order by p.user_id))[1], (array_agg(p.user_id order by p.user_id))[2]
    into uno, otro
    from confirmar_citas.profiles p
    join confirmar_citas.team_members tm on tm.user_id = p.user_id and tm.member_role = 'technician' and tm.status = 'active'
    join confirmar_citas.teams t on t.id = tm.team_id and t.active
    where p.role = 'technician' and p.status = 'active' and not p.must_change_password;
  assert uno is not null and otro is not null and uno <> otro, 'hacen falta dos técnicos ficticios';

  execute format(entrar, uno, jsonb_build_object('sub', uno, 'role', 'authenticated',
    'iat', extract(epoch from statement_timestamp())::bigint)::text);
  assert public.cc_save_my_route_day(uno, hoy, tramo), 'guarda hoy';
  assert public.cc_save_my_route_day(uno, hoy + 1, tramo), 'guarda mañana';
  assert not public.cc_save_my_route_day(uno, hoy + 2, tramo), 'no guarda pasado mañana';
  assert not public.cc_save_my_route_day(uno, hoy - 1, tramo), 'no guarda ayer';
  assert public.cc_my_route_day(uno, hoy) = tramo, 'lee lo suyo';

  rechazado := false;
  begin
    perform public.cc_save_my_route_day(uno, hoy, jsonb_build_array((tramo -> 0) || '{"direccion":"Calle Ficticia 1"}'));
  exception when sqlstate '22023' then rechazado := true; end;
  assert rechazado, 'no admite campos de texto libre';

  insert into confirmar_citas.route_saved_day(technician_id, work_date, legs) values (uno, hoy - 1, tramo), (otro, hoy - 2, tramo);
  perform public.cc_my_route_day(uno, hoy);
  assert not exists (select 1 from confirmar_citas.route_saved_day d where d.technician_id = uno and d.work_date < hoy),
    'al leer borra lo anterior a hoy del técnico';
  perform public.cc_save_my_route_day(uno, hoy, tramo);
  assert not exists (select 1 from confirmar_citas.route_saved_day d where d.work_date < hoy), 'al guardar borra lo de todos';

  rechazado := false;
  begin perform public.cc_my_route_day(otro, hoy);
  exception when insufficient_privilege then rechazado := true; end;
  assert rechazado, 'no puede pedir lo de otro';

  execute format(entrar, otro, jsonb_build_object('sub', otro, 'role', 'authenticated',
    'iat', extract(epoch from statement_timestamp())::bigint)::text);
  assert public.cc_my_route_day(otro, hoy) = '[]'::jsonb, 'no ve lo de otro';

  assert not has_table_privilege('authenticated', 'confirmar_citas.route_saved_day', 'select'), 'sin acceso directo';
  assert not has_function_privilege('anon', 'public.cc_my_route_day(uuid,date)', 'execute'), 'anon no';
  assert (select c.relrowsecurity from pg_class c where c.oid = 'confirmar_citas.route_saved_day'::regclass), 'RLS';
end
$test$;

rollback;
