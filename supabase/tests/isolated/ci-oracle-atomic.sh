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
sed -i '/^\[db.seed\]/,/^\[/s/^enabled = true/enabled = false/' supabase/config.toml
if ! supabase start -x studio,imgproxy,storage-api,realtime,logflare,vector,postgres-meta,supavisor,edge-runtime >"$lab/start.log" 2>&1; then
  echo 'FAIL: isolated Supabase stack did not start (logs withheld).'
  exit 1
fi
supabase status -o json >"$lab/status.json" 2>"$lab/status.err"
export ORACLE_LAB="$lab"
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const directory = process.env.ORACLE_LAB;
const state = JSON.parse(readFileSync(directory + "/status.json", "utf8"));
const api = new URL(state.API_URL);
const db = new URL(state.DB_URL);
for (const url of [api, db]) assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.equal(api.protocol, "http:");
assert.ok(["postgres:", "postgresql:"].includes(db.protocol));

const secret = state.SERVICE_ROLE_KEY;
const publicKey = state.ANON_KEY || state.PUBLISHABLE_KEY;
assert.ok(secret && publicKey);
const password = randomBytes(24).toString("hex");
const identities = [];
for (const name of ["tech", "other", "inactive"]) {
  const response = await fetch(new URL("/auth/v1/admin/users", api), {
    method: "POST",
    redirect: "error",
    headers: { apikey: secret, authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({ email: "oracle-" + name + "@example.test", password, email_confirm: true }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const user = await response.json();
  assert.match(user.id ?? "", /^[a-f0-9-]{36}$/);
  identities.push(user.id);
}

const teams = ["99100000-0000-4000-8000-000000000001", "99100000-0000-4000-8000-000000000002"];
const [a, b, inactive] = identities;
writeFileSync(directory + "/users.sql", [
  "insert into confirmar_citas.teams(id,name) values ('" + teams[0] + "','Fictional A'),('" + teams[1] + "','Fictional B');",
  "insert into confirmar_citas.profiles(user_id,display_name,role,status,must_change_password,activation_verified_at) values "
    + "('" + a + "','Fixture A','technician','active',false,now()),"
    + "('" + b + "','Fixture B','technician','active',false,now()),"
    + "('" + inactive + "','Fixture disabled','technician','disabled',false,now());",
  "insert into confirmar_citas.team_members(team_id,user_id,member_role,status) values "
    + "('" + teams[0] + "','" + a + "','technician','active'),"
    + "('" + teams[1] + "','" + b + "','technician','active');",
  "insert into confirmar_citas.appointments(id,technician_id,team_id,work_date,scheduled_time,population,prospect_ref,source_key,status) values "
    + "('99300000-0000-4000-8000-000000000001','" + a + "','" + teams[0] + "',confirmar_citas.sync_cutoff()-1,'07:00','Historical Town','SYN-ORACLE-A','99200000-0000-4000-8000-000000000001','confirmed'),"
    + "('99300000-0000-4000-8000-000000000002','" + b + "','" + teams[1] + "',confirmar_citas.sync_cutoff()-1,'07:00','Other Historical Town','SYN-ORACLE-A','99200000-0000-4000-8000-000000000001','confirmed'),"
    + "('99300000-0000-4000-8000-000000000003','" + a + "','" + teams[1] + "',confirmar_citas.sync_cutoff()-1,'08:00','Other Team Town','SYN-ORACLE-TEAM','99200000-0000-4000-8000-000000000003','pending');",
  "insert into confirmar_citas.appointment_private_data(appointment_id,technician_id,private_note) values "
    + "('99300000-0000-4000-8000-000000000001','" + a + "','Historical fixture sample'),"
    + "('99300000-0000-4000-8000-000000000002','" + b + "','Historical fixture sample');",
].join("\n"));
writeFileSync(directory + "/test-settings.json", JSON.stringify({ api: api.origin, publicKey, password, teams }), { mode: 0o600 });
for (const [key,value] of Object.entries({ PGHOST: db.hostname, PGPORT: db.port,
  PGUSER: decodeURIComponent(db.username), PGPASSWORD: decodeURIComponent(db.password),
  PGDATABASE: db.pathname.slice(1) })) {
  assert.match(value, /^[A-Za-z0-9._-]+$/);
  writeFileSync(directory + "/pg.env", key + "=" + value + "\n", { flag: "a", mode: 0o600 });
}
JS
set -a
source "$lab/pg.env"
set +a
migrations="$src/supabase/migrations"
# Extract only the two current role checks, since the complete migration also
# changes credential management that this lab does not exercise.
{
  echo 'alter table confirmar_citas.profiles add column sessions_invalid_before bigint;'
  sed -n '/^create or replace function confirmar_citas.current_app_role()/,/^-- A technician/{/^-- A technician/d;p;}' \
    "$migrations/20261011090000_master_technician_access_reset.sql"
} >"$lab/roles.sql"
grep -q 'create or replace function confirmar_citas.is_active_account()' "$lab/roles.sql"
psql -Xq -v ON_ERROR_STOP=1 \
  -f "$migrations/20261009000100_multiusuario_core.sql" \
  -f "$migrations/20261011050000_appointment_workspace.sql" \
  -f "$migrations/20261011070000_v1_functional_parity.sql" \
  -f "$migrations/20261020100000_ignored_intervention_contact_actions.sql" \
  -f "$lab/roles.sql" -f "$lab/users.sql" \
  -f "$migrations/20261119120000_atomic_oracle_agenda.sql" \
  -c "notify pgrst, 'reload schema';"
psql -XAtq -v ON_ERROR_STOP=1 -c "select ((clock_timestamp() at time zone 'Europe/Madrid')::date+1)::text;" >"$lab/work-date"
sleep 2
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const directory = process.env.ORACLE_LAB;
const { api, publicKey, password, teams } = JSON.parse(readFileSync(directory + "/test-settings.json", "utf8"));
const date = readFileSync(directory + "/work-date", "utf8").trim();
const headers = { apikey: publicKey, "content-type": "application/json" };
let stage = "auth";

async function call(path, body, token) {
  const response = await fetch(new URL(path, api), {
    method: "POST", headers: token ? { ...headers, authorization: "Bearer " + token } : headers,
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function login(name) {
  const response = await call("/auth/v1/token?grant_type=password",
    { email: "oracle-" + name + "@example.test", password });
  assert.equal(response.status, 200);
  assert.ok(response.data?.access_token);
  return response.data.access_token;
}

const a = { source_key: "99200000-0000-4000-8000-000000000001", work_date: date, scheduled_time: "10:00",
  end_time: "11:00", population: "Fictional Town", prospect_ref: "SYN-ORACLE-A", kind: "installation",
  type: "Kit Hogar", phone: "", full_address: "", postal_code: "", private_note: "", cancellation_reason: "" };
const b = { ...a, source_key: "99200000-0000-4000-8000-000000000002", scheduled_time: "15:00",
  end_time: "16:00", prospect_ref: "SYN-ORACLE-B", type: "Kit Premium" };
const ignored = [
  { time: "08:00", end_time: "09:00", type: "Tourline", full_address: "Fictional depot" },
  { time: "11:00", end_time: "12:00", type: "ValoraciÃ³n" },
  { time: "13:00", end_time: "14:00", type: "Comida" },
  { time: "16:00", end_time: "17:00", type: "Mantenimiento Kit Hogar" },
];
const read = (fn, token) => call("/rest/v1/rpc/" + fn, { p_work_date: date }, token);
const importAgenda = (token, rows, omissions, team = teams[0]) => call("/rest/v1/rpc/cc_import_oracle_agenda",
  { p_team_id: team, p_work_date: date, p_installations: rows, p_ignored: omissions }, token);

try {
  const [owner, other, inactive] = await Promise.all([login("tech"), login("other"), login("inactive")]);
  stage = "old maintenance classification rejection";
  const oldMaintenance = { ...b, type: "Mantenimiento Kit Hogar" };
  const stripEnd = ({ end_time, ...row }) => row;
  const invalidOld = await call("/rest/v1/rpc/cc_sync_appointment_batch",
    { p_team_id: teams[0], p_work_date: date, p_rows: [a,b,oldMaintenance].map(stripEnd) }, owner);
  assert.equal(invalidOld.status, 400);
  assert.equal(invalidOld.data?.code, "22023");
  assert.equal(invalidOld.data?.message, "invalid installation import");

  stage = "old source key collides with an expired record";
  const expiredOld = await call("/rest/v1/rpc/cc_sync_appointment_batch",
    { p_team_id: teams[0], p_work_date: date, p_rows: [a].map(stripEnd) }, owner);
  assert.equal(expiredOld.status, 400);
  assert.equal(expiredOld.data?.code, "22023");
  assert.equal(expiredOld.data?.message, "expired appointment");

  stage = "six activities, recovery of the expired key and repeat import";
  assert.deepEqual(await importAgenda(owner, [a,b], ignored), { status: 200, data: 2 });
  const firstImport = await read("cc_my_appointments", owner);
  assert.equal(firstImport.status, 200);
  assert.equal(firstImport.data.length, 2);
  const recovered = firstImport.data.find(row => row.prospect_ref === a.prospect_ref);
  assert.ok(recovered);
  assert.notEqual(recovered.id, "99300000-0000-4000-8000-000000000001");
  assert.equal(recovered.source_key, a.source_key);
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.private_note, "");
  assert.deepEqual(await importAgenda(owner, [a,b], ignored), { status: 200, data: 2 });
  const appointments = await read("cc_my_appointments", owner);
  assert.equal(appointments.status, 200);
  assert.deepEqual(appointments.data.map(row => [row.id,row.source_key]),
    firstImport.data.map(row => [row.id,row.source_key]));
  assert.deepEqual(appointments.data.map(row => row.scheduled_end_time), ["11:00", "16:00"]);
  assert.deepEqual(await read("cc_my_ignored_interventions", owner), { status: 200, data: ignored });

  stage = "rollback on invalid ignored payload";
  const failed = await importAgenda(owner, [{ ...a, scheduled_time: "10:10" }],
    [{ time: "08:00", end_time: "07:59", type: "Tourline" }]);
  assert.equal(failed.status, 400);
  assert.equal(failed.data?.code, "22023");
  assert.deepEqual(await read("cc_my_appointments", owner), appointments);
  assert.deepEqual(await read("cc_my_ignored_interventions", owner), { status: 200, data: ignored });

  stage = "ownership and denied roles";
  assert.deepEqual(await read("cc_my_appointments", other), { status: 200, data: [] });
  assert.deepEqual(await read("cc_my_ignored_interventions", other), { status: 200, data: [] });
  const otherTeamSource = { ...a, source_key: "99200000-0000-4000-8000-000000000003", prospect_ref: "SYN-ORACLE-TEAM" };
  assert.equal((await importAgenda(owner, [otherTeamSource], ignored)).status, 403);
  assert.deepEqual(await read("cc_my_appointments", owner), appointments);
  assert.equal((await importAgenda(other, [a,b], ignored)).status, 403);
  assert.equal((await importAgenda(inactive, [a,b], ignored)).status, 403);
  assert.ok([401,403].includes((await importAgenda(undefined, [a,b], ignored)).status));
  assert.ok([401,403].includes((await importAgenda("invalid", [a,b], ignored)).status));
  console.log("PASS: authentic JWT, six Oracle activities, deduplication, end times, rollback and ownership.");
} catch {
  console.error("FAIL at synthetic Oracle stage: " + stage);
  process.exitCode = 1;
}
JS

cd "$src"
CHROME_PATH="$(command -v google-chrome)" node oracle-chrome-lab.mjs
psql -Xq -v ON_ERROR_STOP=1 <<'SQL'
do $fixture$
begin
  if (select count(*)
      from confirmar_citas.appointments a
      join confirmar_citas.appointment_private_data d on d.appointment_id = a.id
      where a.id in ('99300000-0000-4000-8000-000000000001','99300000-0000-4000-8000-000000000002')
        and a.work_date < confirmar_citas.sync_cutoff()
        and a.status = 'confirmed'
        and a.prospect_ref = 'SYN-ORACLE-A'
        and (
          (a.id = '99300000-0000-4000-8000-000000000001'
            and a.team_id = '99100000-0000-4000-8000-000000000001'
            and a.source_key <> '99200000-0000-4000-8000-000000000001'
            and a.oracle_released_source_key = '99200000-0000-4000-8000-000000000001')
          or (a.id = '99300000-0000-4000-8000-000000000002'
            and a.team_id = '99100000-0000-4000-8000-000000000002'
            and a.source_key = '99200000-0000-4000-8000-000000000001'
            and a.oracle_released_source_key is null)
        )
        and d.private_note = 'Historical fixture sample') <> 2 then
    raise exception 'Original expired records changed or disappeared';
  end if;
  if not exists (select from confirmar_citas.appointments a
    where a.id = '99300000-0000-4000-8000-000000000003'
      and a.team_id = '99100000-0000-4000-8000-000000000002'
      and a.work_date < confirmar_citas.sync_cutoff()
      and a.prospect_ref = 'SYN-ORACLE-TEAM'
      and a.source_key = '99200000-0000-4000-8000-000000000003'
      and a.oracle_released_source_key is null) then
    raise exception 'An expired record in another team was modified';
  end if;
end $fixture$;
SQL
echo 'PASS: expired identity released, historical records retained, unrelated users and teams unchanged.'
