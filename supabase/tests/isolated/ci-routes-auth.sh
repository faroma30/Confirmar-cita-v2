#!/usr/bin/env bash
set -euo pipefail
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD
src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
lab="$(mktemp -d)"
cleanup() {
  (cd "$lab" && supabase stop --no-backup >/dev/null 2>&1) || true
  case "$lab" in "${TMPDIR:-/tmp}"/tmp.*) rm -rf -- "$lab" ;; esac
}
trap cleanup EXIT
cd "$lab"
supabase init >/dev/null
# Standard isolated runner; no cloud login, project link, data seed or production configuration.
sed -i '/^\[db.seed\]/,/^\[/s/^enabled = true/enabled = false/' supabase/config.toml
mkdir -p supabase/functions
cp -R "$src/supabase/functions/my-routes-estimate" "$src/supabase/functions/_shared" supabase/functions/
cat >> supabase/config.toml <<'CONFIG'

[functions.my-routes-estimate]
verify_jwt = false
CONFIG
if ! supabase start -x studio,imgproxy,storage-api,realtime,logflare,vector,postgres-meta,supavisor >"$lab/start.log" 2>&1; then
  echo 'FAIL: Supabase CLI could not start the isolated stack (logs withheld).'
  exit 1
fi
supabase status -o json >"$lab/status.json" 2>"$lab/status.err"
export LAB_STATE="$lab/status.json"
export LAB_DIR="$lab"
export LAB_SOURCE="$src"
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
const cfg=JSON.parse(readFileSync(process.env.LAB_STATE,'utf8'));
const api=new URL(cfg.API_URL);
const db=new URL(cfg.DB_URL);
for (const url of [api,db]) {
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Error('non-loopback laboratory refused');
}
if(api.protocol!=='http:'||!['postgres:','postgresql:'].includes(db.protocol)) throw Error('unexpected local protocols');
const owner=cfg.SERVICE_ROLE_KEY;
const anon=cfg.ANON_KEY||cfg.PUBLISHABLE_KEY;
if(!owner||!anon) throw Error('local keys missing');
const password=randomBytes(24).toString('hex');
const rows=[];
for (const [name,role,status] of [['a','technician','active'],['b','technician','active'],['master','master','active'],['inactive','technician','inactive']]) {
  const reply=await fetch(new URL('/auth/v1/admin/users',api),{
    method:'POST',redirect:'error',headers:{apikey:owner,authorization:'Bearer '+owner,'content-type':'application/json'},
    body:JSON.stringify({email:'mis-rutas-'+name+'@example.test',password,email_confirm:true}),
  });
  if(!reply.ok) throw Error('synthetic user creation failed: '+reply.status);
  const user=await reply.json();
  if(!/^[a-f0-9-]{36}$/.test(user.id||'')) throw Error('invalid fixture user id');
  rows.push("('"+user.id+"','"+role+"','"+status+"')");
}
const fixture=readFileSync(process.env.LAB_SOURCE+'/supabase/tests/isolated/my-route-preferences-isolated.sql','utf8');
const objects=fixture.slice(fixture.indexOf('create type confirmar_citas.app_role'),fixture.indexOf('\\ir ../../sql_editor'));
if(!objects.includes('current_app_role()')) throw Error('fixture schema missing');
writeFileSync(process.env.LAB_DIR+'/fixture.sql','create schema confirmar_citas;\n'+objects+
  '\ninsert into confirmar_citas.profiles(user_id,role,status) values '+rows.join(',')+';\n'+
  "insert into confirmar_citas.teams values(1,true);\n"+
  "insert into confirmar_citas.team_members select 1,user_id,role,'active' from confirmar_citas.profiles where role='technician';\n");
for(const [k,v] of Object.entries({MY_ROUTES_LAB_URL:api.origin,MY_ROUTES_LAB_AUTHORIZED:'yes',
  MY_ROUTES_LAB_PUBLISHABLE_KEY:anon,MY_ROUTES_LAB_FIXTURE_PASSWORD:password,
  PGHOST:db.hostname,PGPORT:db.port,PGUSER:decodeURIComponent(db.username),
  PGPASSWORD:decodeURIComponent(db.password),PGDATABASE:db.pathname.slice(1)})){
  if(!/^[A-Za-z0-9.:/_-]+$/.test(v)) throw Error('invalid local configuration format');
  writeFileSync(process.env.LAB_DIR+'/lab.env',k+'='+v+'\n',{flag:'a',mode:0o600});
}
JS
set -a
source "$lab/lab.env"
set +a
psql -Xq -v ON_ERROR_STOP=1 -f "$lab/fixture.sql" \
  -f "$src/supabase/migrations/20261118090000_route_locations.sql" \
  -f "$src/supabase/sql_editor/DRAFT_my_route_budget.sql"
psql -Xq -v ON_ERROR_STOP=1 -c "notify pgrst, 'reload schema';"
sleep 2
node "$src/supabase/tests/isolated/my-route-locations-auth-lab.mjs"
# No Geoapify secret or activation flag exists. Request must fail closed.
node --input-type=module <<'JS'
const response=await fetch(new URL('/functions/v1/my-routes-estimate',process.env.MY_ROUTES_LAB_URL),
  {method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'error'});
if(response.status!==503) throw Error('disabled Edge response: '+response.status);
console.log('PASS: Edge refuses requests while Geoapify is disabled');
JS
psql -XAtq -v ON_ERROR_STOP=1 -c "
select
  not has_function_privilege('authenticated','public.cc_route_budget_charge(uuid,integer)','EXECUTE')
  and not has_table_privilege('authenticated','confirmar_citas.technician_route_preferences','SELECT')
  and (select relrowsecurity from pg_class where oid='confirmar_citas.technician_route_preferences'::regclass)
  and has_function_privilege('service_role','public.cc_route_budget_charge(uuid,integer)','EXECUTE');
" | grep -qx t
for actor in 1 2; do
  id="00000000-0000-4000-8000-00000000000${actor}"
  psql -XAtq -v ON_ERROR_STOP=1 -c "set role service_role; select public.cc_route_budget_begin('$id',current_date,'$id');" >"$lab/race-${actor}" &
  pids[${actor}]=$!
done
wait "${pids[1]}"
wait "${pids[2]}"
test "$(sort "$lab/race-1" "$lab/race-2" | tr -d '\n')" = ft
echo 'PASS: RLS, grants, global admission under parallel connections'
cd "$src"
node --test supabase/functions/my-routes-estimate/core.test.mjs

