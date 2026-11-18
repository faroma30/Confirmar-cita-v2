import assert from "node:assert/strict";

const BASE = process.env.MY_ROUTES_LAB_URL;
const KEY = process.env.MY_ROUTES_LAB_PUBLISHABLE_KEY;
const SECRET = process.env.MY_ROUTES_LAB_FIXTURE_PASSWORD;
const production = "qbjydrltoxysydujtyns";
const fixture = suffix => "mis-rutas-" + suffix + "@example.test";

async function main() {
  if (process.env.MY_ROUTES_LAB_AUTHORIZED !== "yes" || !BASE || !KEY || !SECRET) throw Error("lab not authorized");
  const url = new URL(BASE);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol === "http:";
  const hosted = /^[a-z0-9]+\.supabase\.co$/.test(url.host) && url.protocol === "https:";
  if ((!local && !hosted) || url.hostname.startsWith(production + ".")
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw Error("invalid lab URL");
  if (/^sb_secret_/.test(KEY)) throw Error("publishable key required");
  if (!KEY.startsWith("sb_publishable_")) {
    const claims = JSON.parse(Buffer.from(KEY.split(".")[1], "base64url").toString("utf8"));
    if (claims.role !== "anon") throw Error("publishable key required");
  }

  async function call(path, body, token) {
    const headers = { apikey: KEY, "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const res = await fetch(new URL(path, url), {
      headers, method: "POST", body: JSON.stringify(body), redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  const opened = [];
  async function login(suffix) {
    const { status, data } = await call("/auth/v1/token?grant_type=password", { email: fixture(suffix), password: SECRET });
    assert.equal(status, 200);
    assert.ok(data?.user?.id && data.access_token && data.refresh_token);
    const session = { id: data.user.id, access: data.access_token, refresh: data.refresh_token };
    opened.push(session);
    return session;
  }
  async function read(session, actor = session.id) {
    return call("/rest/v1/rpc/cc_my_route_preferences", { p_expected_technician_id: actor }, session.access);
  }
  async function write(session, home, margin, actor = session.id) {
    return call("/rest/v1/rpc/cc_save_my_route_preferences", { p_expected_technician_id: actor, p_home: home, p_margin: margin }, session.access);
  }

  let a, wrote = false;
  try {
    a = await login("a");
    const b = await login("b");
    const master = await login("master");
    const inactive = await login("inactive");
    assert.equal(new Set([a.id, b.id, master.id, inactive.id]).size, 4);
    assert.deepEqual(await read(a), { status: 200, data: { home: "", margin: 10 } });
    assert.equal((await read(b)).status, 200);
    assert.equal((await read(a,b.id)).status, 403);
    assert.equal((await read(b,a.id)).status, 403);
    assert.equal((await write(b,"Cruce sintético",10,a.id)).status, 403);
    for (const denied of [master,inactive]) {
      assert.equal((await read(denied)).status, 403);
      assert.equal((await write(denied,"Prueba sintética",10)).status, 403);
    }
    const anonymous = await read({ id:a.id });
    assert.ok([401,403].includes(anonymous.status));
    const invalid = await read({ id:a.id, access:"invalid" });
    assert.ok([401,403].includes(invalid.status));
    const bBefore = (await read(b)).data;
    wrote = true;
    assert.equal((await write(a,"Domicilio sintético A",15)).status, 204);
    assert.deepEqual((await read(a)).data,{home:"Domicilio sintético A",margin:15});
    assert.deepEqual((await read(b)).data,bBefore);
    assert.equal((await write(a,"Domicilio sintético B",20)).status, 204);
    assert.equal((await call("/auth/v1/logout?scope=local",{},a.access)).status, 204);
    const refresh = await call("/auth/v1/token?grant_type=refresh_token",{refresh_token:a.refresh});
    assert.ok(refresh.status >= 400);
    a = await login("a");
    assert.deepEqual((await read(a)).data,{home:"Domicilio sintético B",margin:20});
    assert.equal((await write(a,null,10)).status, 204);
    assert.deepEqual((await read(a)).data,{home:"",margin:10});
    console.log("PASS: Auth real, aislamiento, persistencia y vuelta a iniciar sesión.");
  } finally {
    try {
      if (wrote) {
        const fresh = await login("a");
        const cleaned = await write(fresh,null,10);
        assert.equal(cleaned.status,204);
      }
    } finally {
      await Promise.allSettled(opened.map(session => call("/auth/v1/logout?scope=local",{},session.access)));
    }
  }
}

main().catch(() => {
  console.error("Prueba Auth no completada. Comprueba el laboratorio autorizado, los cuatro perfiles sintéticos y sus RPC.");
  process.exitCode = 1;
});
