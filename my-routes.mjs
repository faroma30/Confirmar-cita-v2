const text = value => typeof value === "string" ? value.trim() : "";

function addressOf(row) {
  const street = text(row.full_address);
  return street ? [street, text(row.postal_code), text(row.population)].filter(Boolean).join(", ") : "";
}

export function combineActivities(appointments, ignored) {
  return [
    ...appointments.filter(row => !row.source_missing && row.status !== "cancelled")
      .map(row => ({ ...row, routeType: "Instalación", routeTime: row.scheduled_time })),
    ...ignored.filter(row => /mantenimiento|valoraci[oó]n/i.test(text(row.type)))
      .map(row => ({ ...row, routeType: row.type, routeTime: row.time })),
  ].map(row => {
    const endTime = row.scheduled_end_time ?? row.end_time;
    const start = clockMinutes(row.routeTime);
    const end = clockMinutes(endTime);
    return {
      type: row.routeType,
      time: start === null ? "" : row.routeTime.slice(0, 5),
      endTime: start !== null && end !== null && end >= start ? endTime : "",
      address: addressOf(row),
    };
  }).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
}

export function buildLegs(home, activities) {
  if (!activities.length) return [];
  const stops = [{ type: "Casa", address: home }, ...activities, { type: "Casa", address: home }];
  return stops.slice(1).map((to, index) => ({ from: stops[index], to }));
}

export function mapsLink({ from, to }) {
  if (!from.address || !to.address) return "";
  const params = new URLSearchParams({ api: "1", origin: from.address, destination: to.address, travelmode: "driving" });
  return "https://www.google.com/maps/dir/?" + params;
}

export async function estimateLeg(leg, provider, options) {
  if (!provider || !leg.from.address || !leg.to.address) return null;
  try {
    const result = await provider.estimate(leg, options);
    if (!Number.isFinite(result?.durationSeconds) || result.durationSeconds < 0
      || !Number.isFinite(result.distanceMeters) || result.distanceMeters < 0
      || typeof result.calculatedAt !== "string" || !Number.isFinite(Date.parse(result.calculatedAt))) return null;
    return { durationSeconds: result.durationSeconds, distanceMeters: result.distanceMeters, calculatedAt: result.calculatedAt };
  } catch { return null; }
}

export function recommendedDeparture(time, durationSeconds, marginMinutes) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isFinite(durationSeconds)
    || durationSeconds < 0 || !Number.isInteger(marginMinutes) || marginMinutes < 0) return null;
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes - Math.ceil(durationSeconds / 60) - marginMinutes;
  return { dayOffset: Math.floor(total / 1440), time: new Date(((total % 1440 + 1440) % 1440) * 60000).toISOString().slice(11, 16) };
}

function clockMinutes(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60 : null;
}

function formatClock(total) {
  const withinDay = (total % 1440 + 1440) % 1440;
  const hours = String(Math.floor(withinDay / 60)).padStart(2, "0");
  const minutes = String(withinDay % 60).padStart(2, "0");
  return { dayOffset: Math.floor(total / 1440), time: hours + ":" + minutes };
}

export function arrivalAfter(time, durationSeconds) {
  const start = clockMinutes(time);
  if (start === null || !Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  return formatClock(Math.ceil(start + durationSeconds / 60));
}

export function mayArriveLate(leg, estimate) {
  const end = clockMinutes(leg.from.endTime);
  const next = clockMinutes(leg.to.time);
  return end !== null && next !== null && estimate != null
    && end + estimate.durationSeconds / 60 > next;
}

function validatePreferences(value) {
  const { home, margin } = value ?? {};
  if (typeof home !== "string" || home.length > 500 || !Number.isInteger(margin) || margin < 0 || margin > 180) {
    throw new Error("Configuración de ruta no válida.");
  }
  return { home: home.trim(), margin };
}

// Inject only in environments where the private RPCs have been deployed and validated.
export function createRpcRoutePreferences({ rpc, getActor }) {
  let revision = 0;
  async function call(name, args = {}) {
    const actor = getActor();
    if (actor?.role !== "technician" || !actor.id) throw new Error("Preferencias de ruta no disponibles.");
    const started = revision;
    try {
      const response = await rpc(name, { ...args, p_expected_technician_id: actor.id });
      const current = getActor();
      if (response.error || started !== revision || current?.id !== actor.id || current.role !== "technician") {
        throw new Error();
      }
      return response.data;
    } catch {
      throw new Error("No se pudo acceder a las preferencias de ruta.");
    }
  }
  return {
    async read() { return validatePreferences(await call("cc_my_route_preferences")); },
    async write(value) {
      const { home, margin } = validatePreferences(value);
      await call("cc_save_my_route_preferences", { p_home: home || null, p_margin: margin });
    },
    clear() { revision++; },
  };
}

// Preview settings stay in memory when persistent storage is not configured.
export function createRoutePreferences(getActor) {
  let owner, saved;
  function authorize() {
    const actor = getActor();
    if (actor?.role !== "technician" || !actor.id) {
      owner = saved = undefined;
      throw new Error("Preferencias de ruta no disponibles.");
    }
    if (owner !== actor.id) { owner = actor.id; saved = undefined; }
  }
  return {
    async read() { authorize(); return { ...(saved ?? { home: "", margin: 10 }) }; },
    async write({ home, margin }) {
      authorize();
      saved = validatePreferences({ home, margin });
    },
    clear() { owner = saved = undefined; },
  };
}
