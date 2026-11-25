import { buildLegs, combineActivities, formatRouteLocation } from "./route-agenda.mjs";
const ENDPOINT = "https://api-eu.geoapify.com/v1/";
const MAX_ACTIVITIES = 100;
const MAX_LEG_METERS = 500000;

const field = value => typeof value === "string" ? value.trim() : "";
const normalized = value => field(value).normalize("NFD").replace(/\p{Diacritic}/gu, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function journeyAddresses(preferences, appointments, ignored, edits = new Map()) {
  const home = formatRouteLocation(preferences.home);
  const agenda = combineActivities(appointments, ignored, preferences);
  if (edits.size) {
    const byKey = new Map(agenda.map(activity => [activity.key, activity]));
    for (const [key, edit] of edits) {
      const activity = byKey.get(key);
      if (!activity || (!activity.editableTravel && edit.travel !== "travel")) {
        throw new RouteFailure(400);
      }
    }
  }
  const stops = edits.size ? combineActivities(appointments, ignored, preferences, edits) : agenda;
  const legs = buildLegs(home, stops);
  return [home, ...(legs.length ? legs.map(leg => leg.to.address) : [home])];
}

export function providerAddresses(addresses, includeHome) {
  if (includeHome) return [...addresses];
  const home = streetFields(addresses[0]);
  return addresses.map((address, index) => {
    if (index === 0 || index === addresses.length - 1) return "";
    const candidate = home && streetFields(address);
    // A saved home can also appear as an agenda stop or a hand-entered location.
    if (candidate && sameStreet(home.street, candidate.street)
      && samePortal(home.housenumber, candidate.housenumber)
      && normalized(home.city) === normalized(candidate.city)) return "";
    return address;
  });
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
  // Oracle can append positional building details without comma separators.
  // Strip only the observed structured suffix; never geocode the interior.
  const exterior = parts[0].replace(/(\s+\d{1,5})\s+\d{1,2}\s+[\p{L}]{1,12}\s+\d{1,3}[\p{L}]{1,3}\s+[\p{L}]{1,12}\s+\d{1,3}[\p{L}]{1,3}$/iu, "$1");
  const street = HOUSE.exec(exterior);
  const locality = /^(?:(?<postcode>\d{5})\s+)?(?<city>[\p{L}][\p{L} .’'-]{1,99}?)(?: \((?<province>[\p{L}][\p{L} .’'-]{1,99})\))?$/u.exec(parts.at(-1));
  if (!street || !locality || /(?:\p{N}[ .()\p{Pd}]*){9,}/u.test(street.groups.street)) return null;
  const separatePostal = parts.length > 2 && /^\d{5}$/.test(parts.at(-2)) ? parts.at(-2) : "";
  const postcode = locality.groups.postcode || separatePostal;
  const { city, province } = locality.groups;
  return {
    ...street.groups, ...(postcode ? { postcode } : {}), city, ...(province ? { province } : {}),
    country: "España", filter: "countrycode:es", limit: "5",
  };
}

class RouteFailure extends Error {
  constructor(status, providerLimited = false, diagnostic = null) {
    super("Route service unavailable");
    this.status = status;
    this.providerLimited = providerLimited;
    this.diagnostic = diagnostic;
  }
}

function contextFor({ charge, apiKey, fetcher = fetch, signal, manualFreePilot }) {
  return { charge, apiKey, fetcher, signal, manualFreePilot, nextRequestAt: 0, deadline: Date.now() + 55000 };
}

async function readProvider(path, params, credits, context) {
  const wait = Math.max(0, context.nextRequestAt - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  if (context.signal?.aborted || Date.now() >= context.deadline) throw new RouteFailure(503);
  if (!await context.charge(credits, path === "routing")) throw new RouteFailure(429);
  if (context.signal?.aborted || Date.now() >= context.deadline) throw new RouteFailure(503);
  const url = new URL(path, ENDPOINT);
  url.search = new URLSearchParams({ ...params, apiKey: context.apiKey });
  const stage = path === "routing" ? "routing" : path === "geocode/autocomplete" ? "autocomplete" : "geocoding";
  const ambiguousCost = stage === "routing" && context.manualFreePilot === true;
  const diagnostic = (kind, http = null) => ({ stage, kind, http });
  let response;
  let timeout;
  try {
    context.nextRequestAt = Date.now() + 320;
    timeout = AbortSignal.timeout(Math.max(1, Math.min(stage === "geocoding" ? 8000 : 3500, context.deadline - Date.now())));
    const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
    response = await context.fetcher(url, { redirect: "error", signal });
  } catch {
    const kind = context.signal?.aborted ? "cancelled" : timeout?.aborted ? "timeout" : "network";
    throw new RouteFailure(503, ambiguousCost, diagnostic(kind));
  }
  if ([401, 403, 429].includes(response.status)) {
    throw new RouteFailure(429, true, diagnostic("provider_denied", response.status));
  }
  if (!response.ok) throw new RouteFailure(503, ambiguousCost, diagnostic("provider_http", response.status));
  try {
    return await response.json();
  } catch {
    throw new RouteFailure(503, ambiguousCost, diagnostic(timeout?.aborted ? "timeout" : "invalid_json", response.status));
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
  return query.length >= 4 && query.length <= 100 && STREET.test(query) && query.replace(/\D/g, "").length <= 7 ? query : "";
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
  // The bound must cover billable road distance, not waypoint separation.
  // Geoapify drive has no verified bound configured in the deployed handler.
  const { manualFreePilot } = options;
  // The Free pilot reserves two credits per leg conservatively. This is a
  // reservation, not a guarantee of the provider's final road-distance charge.
  const maxBillableRouteMeters = options.maxBillableRouteMeters ?? (manualFreePilot === true ? 999_999 : null);
  if (!Number.isSafeInteger(maxBillableRouteMeters) || maxBillableRouteMeters <= 0) {
    throw new RouteFailure(503);
  }
  const routeCredits = 1 + Math.floor(maxBillableRouteMeters / 500_000);
  if (routeCredits > 50) throw new RouteFailure(429);
  const context = contextFor(options);
  const points = new Map();
  const routed = new Map();
  const estimates = Array(addresses.length - 1).fill(null);
  const reasons = options.reasons;
  async function pointFor(address) {
    if (!points.has(address)) {
      const fields = streetFields(address);
      points.set(address, fields ? await geocode(fields, context) : null);
    }
    return points.get(address);
  }
  for (let index = 0; index < estimates.length; index++) {
    if (!streetFields(addresses[index]) || !streetFields(addresses[index + 1])) {
      if (reasons) reasons[index] ??= "incomplete";
      continue;
    }
    const from = await pointFor(addresses[index]);
    const to = await pointFor(addresses[index + 1]);
    if (!from || !to) { if (reasons) reasons[index] = "not_found"; continue; }
    // This service-area filter is separate from the billable-distance bound.
    if (Math.abs(from[0] - to[0]) > 1 || Math.abs(from[1] - to[1]) > 1) {
      if (reasons) reasons[index] = "no_route";
      continue;
    }
    const waypoints = from.join(",") + "|" + to.join(",");
    if (!routed.has(waypoints)) {
      const data = await readProvider("routing", {
        waypoints, mode: "drive", units: "metric", traffic: "free_flow",
      }, routeCredits, context);
      const route = data?.features?.[0]?.properties;
      if (!Number.isFinite(route?.distance) || route.distance < 0) {
        if (manualFreePilot) throw new RouteFailure(503, true, { stage: "routing", kind: "missing_distance", http: 200 });
      } else if (route.distance > maxBillableRouteMeters) {
        throw new RouteFailure(503, true, { stage: "routing", kind: "estimate_exceeded", http: 200 });
      }
      const estimate = Number.isFinite(route?.distance) && route.distance >= 0 && route.distance < MAX_LEG_METERS
        && Number.isFinite(route?.time) && route.time >= 0 && route.time < 28800
        ? { distanceMeters: route.distance, durationSeconds: route.time, calculatedAt: new Date().toISOString() } : null;
      routed.set(waypoints, estimate);
    }
    estimates[index] = routed.get(waypoints);
    if (reasons && !estimates[index]) reasons[index] = "no_route";
  }
  return estimates;
}
