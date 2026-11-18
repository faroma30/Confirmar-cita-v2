import assert from "node:assert/strict";

const { MY_ROUTES_LAB_URL: endpoint, MY_ROUTES_LAB_PUBLISHABLE_KEY: key,
  MY_ROUTES_LAB_FIXTURE_PASSWORD: password, MY_ROUTES_LAB_AUTHORIZED: authorized } = process.env;
const fixture = suffix => "mis-rutas-" + suffix + "@example.test";
const defaults = { home: null, keys: null, tourline: null, margin: 10 };
const home = { street: "Vía ficticia A", number: "S/N", municipality: "Municipio sintético A", postalCode: "" };
const keys = { street: "Vía ficticia B", number: "2 bis", municipality: "Municipio sintético B", postalCode: "08001" };
const tourline = { street: "Vía ficticia C", number: "", municipality: "Municipio sintético C", postalCode: "" };
const updatedKeys = { ...keys, number: "4" };
let stage = "configuration";

async function main() {
  assert.ok(authorized === "yes" && endpoint && key && password);
  const url = new URL(endpoint);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash);
  if (!key.startsWith("sb_publishable_")) {
    assert.equal(JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")).role, "anon");
  }

  async function call(path, body, token) {
    const headers = { apikey: key, "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const res = await fetch(new URL(path, url), { headers, method: "POST", body: JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(10000) });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  const sessions = [];
  async function login(suffix) {
    const { status, data } = await call("/auth/v1/token?grant_type=password", { email: fixture(suffix), password });
    assert.equal(status, 200);
    assert.ok(data?.user?.id && data.access_token && data.refresh_token);
    const session = { id: data.user.id, token: data.access_token, refresh: data.refresh_token };
    sessions.push(session);
    return session;
  }
  const logout = session => call("/auth/v1/logout?scope=local", {}, session.token);
  const read = (session, actor = session.id) => call("/rest/v1/rpc/cc_my_route_locations",
    { p_expected_technician_id: actor }, session.token);
  const readV2 = (session, actor = session.id) => call("/rest/v1/rpc/cc_my_route_locations_v2",
    { p_expected_technician_id: actor }, session.token);
  const save = (session, prefs, actor = session.id) => call("/rest/v1/rpc/cc_save_my_route_locations",
    { p_expected_technician_id: actor, p_home: prefs.home, p_keys: prefs.keys,
      p_tourline: prefs.tourline, p_margin: prefs.margin }, session.token);

  let a, b;
  try {
    stage = "synthetic sign-in and defaults";
    a = await login("a");
    b = await login("b");
    const master = await login("master");
    const inactive = await login("inactive");
    assert.equal(new Set([a.id,b.id,master.id,inactive.id]).size, 4);
    assert.deepEqual(await read(a), { status: 200, data: defaults });
    assert.deepEqual(await read(b), { status: 200, data: defaults });

    stage = "role, identity and session isolation";
    for (const [actor, other] of [[a,b], [b,a]]) {
      assert.equal((await read(actor, other.id)).status, 403);
      assert.equal((await save(actor, { ...defaults, home }, other.id)).status, 403);
    }
    for (const actor of [master,inactive]) {
      assert.equal((await read(actor)).status, 403);
      assert.equal((await save(actor, { ...defaults, home })).status, 403);
      assert.equal((await read(actor, a.id)).status, 403);
    }
    for (const session of [{ id: a.id }, { id: a.id, token: "invalid" }]) {
      assert.ok([401,403].includes((await read(session)).status));
      assert.ok([401,403].includes((await save(session, defaults)).status));
    }

    stage = "canonical addresses and independent writes";
    const tourlineWithoutNumberOrPostcode = { street: tourline.street, municipality: tourline.municipality };
    const selected = { home, keys, tourline, margin: 15 };
    const untrimmed = { ...selected, home: { ...home, street: "  " + home.street + " " }, tourline: tourlineWithoutNumberOrPostcode };
    assert.equal((await save(a, untrimmed)).status, 204);
    assert.deepEqual((await read(a)).data, selected);
    assert.deepEqual((await read(b)).data, defaults);
    const second = { ...defaults, home: keys };
    assert.equal((await save(b, second)).status, 204);
    assert.deepEqual((await read(b)).data, second);
    assert.deepEqual((await read(a)).data, selected);

    stage = "versioned province visibility and isolation";
    const precise = { ...selected, home: { ...home, province: "Madrid" } };
    assert.equal((await save(a, precise)).status, 204);
    assert.deepEqual((await readV2(a)).data, precise);
    assert.deepEqual((await read(a)).data, selected);
    assert.equal((await readV2(b, a.id)).status, 403);
    assert.equal((await readV2(master)).status, 403);
    assert.equal((await readV2(inactive)).status, 403);
    assert.ok([401,403].includes((await readV2({ id:a.id })).status));
    assert.equal((await save(a, selected)).status, 204);

    stage = "invalid shapes and rollback";
    const invalid = [
      { ...home, number: 3 },
      { ...home, number: "1".repeat(31) },
      { ...home, municipality: " " },
      { ...home, postalCode: "abcd" },
      { ...home, street: "control\ncarriage" },
      { ...home, extra: "private" },
      ["street", "number"],
    ];
    for (const home of invalid) assert.equal((await save(a, { ...selected, home })).status, 400);
    assert.equal((await save(a, { ...selected, margin: 181 })).status, 400);
    assert.deepEqual((await read(a)).data, selected);

    stage = "edit, remove and restore after login";
    const updated = { ...selected, home: null, keys: updatedKeys };
    assert.equal((await save(a, updated)).status, 204);
    assert.equal((await logout(a)).status, 204);
    const refresh = await call("/auth/v1/token?grant_type=refresh_token", { refresh_token: a.refresh });
    assert.ok(refresh.status >= 400);
    a = await login("a");
    assert.deepEqual((await read(a)).data, updated);
    assert.equal((await save(a, defaults)).status, 204);
    assert.deepEqual((await read(a)).data, defaults);
    assert.deepEqual((await read(b)).data, second);
    console.log("PASS: structured route locations, authentic JWT, roles, validation and persistence.");
  } finally {
    await Promise.allSettled(sessions.map(logout));
  }
}

main().catch(() => {
  console.error("FAIL: structured route locations at " + stage);
  process.exitCode = 1;
});

