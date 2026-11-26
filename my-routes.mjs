const text = value => typeof value === "string" ? value.trim() : "";

function addressOf(row) {
  const street = text(row.full_address);
  const missing = /^(?:s\/d|s\/n|sin (?:direccion|datos)|no (?:disponible|informada)|[-–—]+)$/i;
  return street && !missing.test(street.normalize("NFD").replace(/\p{Diacritic}/gu, ""))
    ? [street, text(row.postal_code), text(row.population)].filter(Boolean).join(", ") : "";
}

export const routeLocationFields = { street: 200, number: 30, municipality: 100, postalCode: 5, province: 100 };
export const routeLocationKinds = ["home", "keys", "tourline"];

export function formatRouteLocation(location) {
  if (!location) return "";
  return [[location.street, location.number].filter(Boolean).join(" "), location.postalCode, location.province ? location.municipality + " (" + location.province + ")" : location.municipality].filter(Boolean).join(", ");
}

function activityName(value) {
  return text(value).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function configuredAddress(type, preferences) {
  const name = activityName(type);
  if (/^(?:recogida (?:de )?llaves|recoger (?:las )?llaves)(?: (?:en|del?|de la) .+)?$/.test(name)) {
    return formatRouteLocation(preferences.keys);
  }
  if (/^(?:tour ?line(?: express| alianzas)?(?: recogida(?: (?:de )?material(?:es)?)?)?|recogida (?:de )?material(?:es)?(?: tour ?line(?: express| alianzas)?)?)$/.test(name)) {
    return formatRouteLocation(preferences.tourline);
  }
  return "";
}

// CONFIRMAR_CITAS-016 (opción A): toda actividad cuyo nombre empiece por Comida, Almuerzo, Pausa o Descanso
// es por defecto una pausa sin desplazamiento; el técnico puede cambiarlo en la tarjeta (edits).
const defaultPause = /^(?:pausa|descanso|almuerzo|comida)s?(?: |$)/;
// Actividad «Desplazamiento» de la agenda sin destino: tramo pendiente que no se calcula (no se pregunta).
const transitActivity = /^desplazamiento(?: |$)/;

export function combineActivities(appointments, ignored, preferences = {}, overrides = new Map()) {
  const occurrences = new Map();
  return [
    ...appointments.filter(row => !row.source_missing && row.status !== "cancelled")
      .map(row => ({ row, type: "Instalación", time: row.scheduled_time, editableTravel: false })),
    ...ignored.filter(row => text(row.type))
      .map(row => ({ row, type: row.type, time: row.time, editableTravel: true })),
  ].map(({ row, type, time, editableTravel }) => {
    const endTime = row.scheduled_end_time ?? row.end_time;
    const start = clockMinutes(time);
    const end = clockMinutes(endTime);
    const originalAddress = addressOf(row);
    const identity = !editableTravel && row.id
      ? JSON.stringify(["installation", row.id])
      : JSON.stringify([editableTravel, type, time, endTime, originalAddress]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const key = JSON.stringify([identity, occurrence]);
    const name = activityName(type);
    const defaultTravel = editableTravel && defaultPause.test(name) ? "pause" : "travel";
    const override = overrides.get(key);
    const travel = override?.travel ?? defaultTravel;
    const agendaAddress = originalAddress || (editableTravel ? configuredAddress(type, preferences) : "");
    const address = travel === "travel"
      ? formatRouteLocation(override?.location) || agendaAddress
      : "";
    const noDestination = editableTravel && travel === "travel" && !address && transitActivity.test(name);
    return {
      key, type, time: start === null ? "" : time.slice(0, 5),
      endTime: start !== null && end !== null && end >= start ? endTime : "",
      address, agendaAddress, travel, defaultTravel, editableTravel, override, noDestination,
    };
  }).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
}

export function buildLegs(home, activities) {
  const house = { type: "Casa", address: home };
  const legs = [];
  let from = house;
  for (const activity of activities) {
    if (activity.travel === "pause") {
      // A pause stays at the last stop. Any later ETA needs a known finish for both activities.
      if (legs.length) {
        const previous = clockMinutes(from.endTime);
        const pauseEnd = clockMinutes(activity.endTime);
        from = { ...from, endTime: previous === null || pauseEnd === null
          ? "" : pauseEnd > previous ? activity.endTime : from.endTime };
      }
      continue;
    }
    legs.push({ from, to: activity });
    from = activity;
  }
  if (legs.length) legs.push({ from, to: house });
  return legs;
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

// Tiempo entre actividades (CONFIRMAR_CITAS-006). Solo usa las horas de la agenda; funciona sin Geoapify.
export function freeTimeBetween(previous, next) {
  const start = clockMinutes(next?.time ?? "");
  if (start === null) return { minutes: null, reason: "no_start" };
  const end = clockMinutes(previous?.endTime ?? "");
  if (end === null) return { minutes: null, reason: "no_end" };
  return { minutes: Math.round(start - end), reason: null };
}

// Tiempo libre de un tramo entre dos actividades menos el desplazamiento estimado.
// `leg.from.endTime` ya incluye las pausas intermedias (buildLegs). Los tramos desde o hacia casa no cuentan.
export function legSlack(leg, estimate) {
  if (!leg?.from?.key || !leg?.to?.key || !Number.isFinite(estimate?.durationSeconds)) return null;
  const next = clockMinutes(leg.to.time ?? "");
  if (next === null) return { minutes: null, late: false, reason: "no_start" };
  const end = clockMinutes(leg.from.endTime ?? "");
  if (end === null) return { minutes: null, late: false, reason: "no_end" };
  const slack = next - end - estimate.durationSeconds / 60;
  return slack >= 0
    ? { minutes: Math.floor(slack), late: false, reason: null, signed: slack }
    : { minutes: Math.ceil(-slack), late: true, reason: null, signed: slack };
}

export function dayFreeTime(activities) {
  let minutes = 0, counted = 0;
  const pairs = Math.max(0, activities.length - 1);
  for (let index = 1; index < activities.length; index++) {
    const gap = freeTimeBetween(activities[index - 1], activities[index]);
    if (gap.minutes === null) continue;
    counted++;
    minutes += Math.max(0, gap.minutes);
  }
  return { minutes, counted, pairs };
}

export function formatMinutes(total) {
  const value = Math.max(0, Math.round(total));
  if (value < 60) return value + " min";
  const hours = Math.floor(value / 60), rest = value % 60;
  return value + " min (" + hours + " h" + (rest ? " " + rest + " min" : "") + ")";
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

function routePreferencesRpc({ rpc, getActor }) {
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
  return { call, clear() { revision++; } };
}

export function createRpcRoutePreferences(options) {
  const { call, clear } = routePreferencesRpc(options);
  return {
    async read() { return validatePreferences(await call("cc_my_route_preferences")); },
    async write(value) {
      const { home, margin } = validatePreferences(value);
      await call("cc_save_my_route_preferences", { p_home: home || null, p_margin: margin });
    },
    clear,
  };
}

export function validateRouteLocation(location) {
  if (location === null) return null;
  if (!location || typeof location !== "object" ||
    Object.keys(location).some(field => !Object.hasOwn(routeLocationFields, field))) {
    throw new Error("La ubicación no es válida.");
  }
  const trimmed = {};
  for (const [field, length] of Object.entries(routeLocationFields)) {
    const raw = Object.hasOwn(location, field) ? location[field] : "";
    if (typeof raw !== "string" || /[\u0000-\u001f\u007f]/.test(raw) || [...raw.trim()].length > length) {
      throw new Error("La ubicación no es válida.");
    }
    trimmed[field] = raw.trim();
  }
  if (!trimmed.street || !trimmed.municipality ||
    (trimmed.postalCode && !/^\d{5}$/.test(trimmed.postalCode))) {
    throw new Error("Completa la calle y la población. Para el código postal, usa cinco dígitos.");
  }
  if (trimmed.province && !/^[\p{L}][\p{L} .\u2019\x27-]*$/u.test(trimmed.province)) {
    throw new Error("La provincia no es válida.");
  }
  if (!trimmed.province) delete trimmed.province;
  return trimmed;
}

export function validateRouteLocations(value) {
  if (!Number.isInteger(value?.margin) || value.margin < 0 || value.margin > 180) {
    throw new Error("El margen debe estar entre 0 y 180 minutos.");
  }
  const result = { margin: value.margin };
  for (const kind of routeLocationKinds) {
    const location = value[kind];
    result[kind] = validateRouteLocation(location);
  }
  return result;
}

export function createRpcRouteLocations(options) {
  const { call, clear } = routePreferencesRpc(options);
  return {
    async read() { return validateRouteLocations(await call("cc_my_route_locations_v2")); },
    async write(value) {
      const { home, keys, tourline, margin } = validateRouteLocations(value);
      await call("cc_save_my_route_locations", { p_home: home, p_keys: keys, p_tourline: tourline, p_margin: margin });
    },
    clear,
  };
}

// CONFIRMAR_CITAS-015: «Usar mi domicilio» se guarda solo en este dispositivo, por técnico,
// y está desactivado por defecto. Sin esta opción el domicilio nunca se envía a Geoapify.
export const homeConsentLabel = "Usar mi domicilio para calcular el primer y el último tramo y la hora de salida (se envía a Geoapify)";
export function createHomeConsent({ storage, getActor }) {
  const key = () => {
    const actor = getActor();
    return actor?.role === "technician" && actor.id ? "myRoutes.useHome." + actor.id : null;
  };
  return {
    read() {
      const name = key();
      if (!name) return false;
      try { return storage?.getItem(name) === "yes"; } catch { return false; }
    },
    write(value) {
      const name = key();
      if (!name || !storage) return false;
      try {
        if (value === true) storage.setItem(name, "yes");
        else storage.removeItem(name);
        return true;
      } catch { return false; }
    },
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
