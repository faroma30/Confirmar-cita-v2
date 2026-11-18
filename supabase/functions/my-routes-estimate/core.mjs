const ENDPOINT = "https://api-eu.geoapify.com/v1/";
const MAX_ACTIVITIES = 100;
const MAX_LEG_METERS = 500000;

const field = value => typeof value === "string" ? value.trim() : "";
const normalized = value => field(value).normalize("NFD").replace(/\p{Diacritic}/gu, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function addressOf(row) {
  const street = field(row.full_address);
  const missing = /^(?:s\/d|s\/n|sin (?:direccion|datos)|no (?:disponible|informada)|[-–—]+)$/i;
  return street && !missing.test(street.normalize("NFD").replace(/\p{Diacritic}/gu, ""))
    ? [street, field(row.postal_code), field(row.population)].filter(Boolean).join(", ") : "";
}

function formatLocation(location) {
  if (!location) return "";
  const locality = location.province ? `${location.municipality} (${location.province})` : location.municipality;
  return [[location.street, location.number].filter(Boolean).join(" "), location.postalCode, locality].filter(Boolean).join(", ");
}

function ignoredAddress(row, preferences) {
  const type = normalized(row.type);
  if (/^(?:recogida (?:de )?llaves|recoger (?:las )?llaves)(?: (?:en|del?|de la) .+)?$/.test(type)) {
    return formatLocation(preferences.keys) || addressOf(row);
  }
  if (/^(?:tour ?line(?: express)?(?: recogida(?: (?:de )?material(?:es)?)?)?|recogida (?:de )?material(?:es)?(?: tour ?line)?)$/.test(type)) {
    return formatLocation(preferences.tourline) || addressOf(row);
  }
  return addressOf(row);
}

// Keep in sync with combineActivities and buildLegs. Their parity is checked by the route tests.
export function journeyAddresses(preferences, appointments, ignored) {
  const home = formatLocation(preferences.home);
  const orderTime = time => /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time) ? time.slice(0, 5) : "99";
  return [home, ...[
    ...appointments.filter(row => !row.source_missing && row.status !== "cancelled")
      .map(row => ({ time: row.scheduled_time, address: addressOf(row) })),
    ...ignored.filter(row => field(row.type) && !/^(?:pausa(?: (?:para|de) (?:comida|descanso))?|descanso|almuerzo|comida)$/.test(normalized(row.type)))
      .map(row => ({ time: row.time, address: ignoredAddress(row, preferences) })),
  ].sort((a, b) => orderTime(a.time).localeCompare(orderTime(b.time))).map(row => row.address), home];
}

export async function journeyFingerprint(addresses) {
  const bytes = new TextEncoder().encode(JSON.stringify(addresses));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

const STREET = /^[\p{L}][\p{L}\p{N} .’'ºª/-]{1,119}$/u;
const LOCALITY = /^[\p{L}][\p{L} .’'-]{1,99}$/u;
const HOUSE = /^(?<street>[\p{L}][\p{L}\p{N} .’'ºª/-]{1,119})\s+(?<housenumber>\d{1,5}(?:\s?[A-Za-z]|\s*(?:bis|ter))?)$/iu;

const streetTypes = new Map([
  ["calle", "street"], ["carrer", "street"], ["rua", "street"], ["c", "street"],
  ["avenida", "avenue"], ["avinguda", "avenue"], ["av", "avenue"], ["avda", "avenue"],
  ["plaza", "square"], ["placa", "square"], ["passeig", "promenade"], ["paseo", "promenade"],
  ["via", "way"],
]);

function streetParts(value) {
  const name = normalized(value);
  const separator = name.indexOf(" ");
  const type = streetTypes.get(separator > 0 ? name.slice(0, separator) : "");
  return { type, name: type ? name.slice(separator + 1) : name };
}

function sameStreet(left, right) {
  const a = streetParts(left);
  const b = streetParts(right);
  if (a.type && b.type && a.type !== b.type) return false;
  if (a.name === b.name) return true;
  // Autocomplete and portal geocoding may include or omit the initial preposition.
  return Boolean(a.type && b.type) && a.name.replace(/^de /, "") === b.name.replace(/^de /, "");
}

function samePortal(left, right) {
  const portal = value => normalized(value).replace(/^(\d+) ([a-z]+)$/, "$1$2");
  return portal(left) === portal(right);
}

// Use only the street/house number and the last locality fields, never interior details.
export function streetFields(address) {
  const parts = field(address).split(",").map(field).filter(Boolean);
  if (parts.length < 2) return null;
  const street = HOUSE.exec(parts[0]);
  const locality = /^(?:(?<postcode>\d{5})\s+)?(?<city>[\p{L}][\p{L} .’'-]{1,99}?)(?: \((?<province>[\p{L}][\p{L} .’'-]{1,99})\))?$/u.exec(parts.at(-1));
  if (!street || !locality) return null;
  const separatePostal = parts.length > 2 && /^\d{5}$/.test(parts.at(-2)) ? parts.at(-2) : "";
  const postcode = locality.groups.postcode || separatePostal;
  const { city, province } = locality.groups;
  return {
    ...street.groups, ...(postcode ? { postcode } : {}), city, ...(province ? { province } : {}),
    country: "España", filter: "countrycode:es", limit: "5",
  };
}

class RouteFailure extends Error {
  constructor(status, providerLimited = false) {
    super("Route service unavailable");
    this.status = status;
    this.providerLimited = providerLimited;
  }
}

function contextFor({ charge, apiKey, fetcher = fetch, signal }) {
  return { charge, apiKey, fetcher, signal, nextRequestAt: 0, deadline: Date.now() + 55000 };
}

async function readProvider(path, params, credits, context) {
  const wait = Math.max(0, context.nextRequestAt - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  if (context.signal?.aborted || Date.now() >= context.deadline) throw new RouteFailure(503);
  if (!await context.charge(credits)) throw new RouteFailure(429);
  if (context.signal?.aborted || Date.now() >= context.deadline) throw new RouteFailure(503);
  const url = new URL(path, ENDPOINT);
  url.search = new URLSearchParams({ ...params, apiKey: context.apiKey });
  try {
    context.nextRequestAt = Date.now() + 320;
    const timeout = AbortSignal.timeout(3500);
    const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
    const response = await context.fetcher(url, { redirect: "error", signal });
    if (response.status === 429 || response.status === 403) throw new RouteFailure(429, true);
    if (!response.ok) throw new RouteFailure(503);
    return await response.json();
  } catch (error) {
    throw error instanceof RouteFailure ? error : new RouteFailure(503);
  }
}

function municipality(location) {
  return field(location?.city || location?.town || location?.village || location?.municipality);
}

function madridProvince(province) {
  return ["madrid", "provincia de madrid", "comunidad de madrid", "community of madrid"].includes(normalized(province));
}

function provinceOf(location) {
  const county = field(location?.county);
  if (madridProvince(county) || (!county && madridProvince(location?.state))) return "Madrid";
  return LOCALITY.test(county) ? county : "";
}

function coordinates(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lon)
    && Math.abs(location.lat) <= 90 && Math.abs(location.lon) <= 180 ? [location.lat, location.lon] : null;
}

async function geocode(fields, context) {
  const { province, ...params } = fields;
  const data = await readProvider("geocode/search", { ...params, format: "json" }, 1, context);
  const points = new Map();
  for (const location of Array.isArray(data?.results) ? data.results.slice(0, Number(params.limit)) : []) {
    const point = coordinates(location);
    const match = location?.rank?.match_type;
    if (!point || location?.country_code !== "es" || (fields.postcode && location.postcode !== fields.postcode)
      || (province && normalized(provinceOf(location)) !== (madridProvince(province) ? "madrid" : normalized(province)))
      || !sameStreet(location.street, fields.street)
      || normalized(municipality(location)) !== normalized(fields.city)
      || !samePortal(location.housenumber, fields.housenumber)
      || !["building", "amenity"].includes(location.result_type)
      || !["full_match", "match_by_building", "inner_part"].includes(match)) continue;
    // A venue inside a building can match the full portal even with an inner-part rank.
    const score = location.rank.confidence_building_level ?? (match === "full_match" ? location.rank.confidence : null);
    const key = point.join(",");
    const reliable = match === "inner_part"
      ? location.result_type === "amenity" && location.rank.confidence === 1 && score === 1
      : Number.isFinite(score) && score >= 0.9;
    points.set(key, { point, reliable: reliable || points.get(key)?.reliable });
  }
  if (points.size !== 1) return null;
  const [match] = points.values();
  return match.reliable ? match.point : null;
}

export function autocompleteQuery(value) {
  const query = field(value).replace(/ +/g, " ");
  // Street names can contain digits; phone numbers and markup do not belong in a street search.
  return query.length >= 4 && query.length <= 100 && STREET.test(query) && !/\d{6}/.test(query) ? query : "";
}

export async function autocompleteStreets(query, options) {
  const safe = autocompleteQuery(query);
  if (!safe) throw new RouteFailure(400);
  const context = contextFor(options);
  const data = await readProvider("geocode/autocomplete", {
    text: safe, type: "street", format: "json", filter: "countrycode:es", lang: "es", limit: "8",
  }, 1, context);
  const postcodes = [...new Set([...safe.matchAll(/(?:^| )(\d{5})(?= |$)/g)].map(match => match[1]))];
  const suggestions = new Map();
  for (const row of Array.isArray(data?.results) ? data.results.slice(0, 8) : []) {
    const street = field(row?.street);
    const town = municipality(row);
    if (row?.country_code !== "es" || row.result_type !== "street" || !STREET.test(street) || !LOCALITY.test(town)) continue;
    const province = provinceOf(row);
    const rowPostalCode = /^\d{5}$/.test(row.postcode ?? "") ? row.postcode : "";
    const key = JSON.stringify([normalized(street), normalized(town), normalized(province)]);
    const current = suggestions.get(key);
    // A street's suggested postcode is informative. Fill it only if the query specified it.
    const postalCode = current?.postalCode || (postcodes.length === 1 && rowPostalCode === postcodes[0] ? rowPostalCode : "");
    const displayPostalCode = current && current.displayPostalCode !== rowPostalCode ? "" : rowPostalCode;
    const label = [street, town, normalized(province) !== normalized(town) ? province : "", displayPostalCode]
      .filter(Boolean).join(" · ");
    suggestions.set(key, {
      street, municipality: town, ...(province ? { province } : {}), postalCode,
      ...(displayPostalCode ? { displayPostalCode } : {}), label,
    });
  }
  return [...suggestions.values()].slice(0, 6);
}

export async function calculateJourney(addresses, options) {
  if (addresses.length < 3 || addresses.length > MAX_ACTIVITIES + 2) throw new RouteFailure(422);
  const context = contextFor(options);
  const points = new Map();
  const routed = new Map();
  const estimates = Array(addresses.length - 1).fill(null);
  async function pointFor(address) {
    if (!points.has(address)) {
      const fields = streetFields(address);
      points.set(address, fields ? await geocode(fields, context) : null);
    }
    return points.get(address);
  }
  for (let index = 0; index < estimates.length; index++) {
    if (!streetFields(addresses[index]) || !streetFields(addresses[index + 1])) continue;
    const from = await pointFor(addresses[index]);
    const to = await pointFor(addresses[index + 1]);
    if (!from || !to) continue;
    // Reserve an extra credit for headroom. Never route distant or unknown locations.
    if (Math.abs(from[0] - to[0]) > 1 || Math.abs(from[1] - to[1]) > 1) continue;
    const waypoints = from.join(",") + "|" + to.join(",");
    if (!routed.has(waypoints)) {
      const data = await readProvider("routing", {
        waypoints, mode: "drive", units: "metric", traffic: "free_flow",
      }, 2, context);
      const route = data?.features?.[0]?.properties;
      const estimate = Number.isFinite(route?.distance) && route.distance >= 0 && route.distance < MAX_LEG_METERS
        && Number.isFinite(route?.time) && route.time >= 0 && route.time < 28800
        ? { distanceMeters: route.distance, durationSeconds: route.time, calculatedAt: new Date().toISOString() } : null;
      routed.set(waypoints, estimate);
    }
    estimates[index] = routed.get(waypoints);
  }
  return estimates;
}
