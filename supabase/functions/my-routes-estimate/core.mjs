const ENDPOINT = "https://api-eu.geoapify.com/v1/";
const MAX_ACTIVITIES = 20;
const MAX_LEG_METERS = 500000;

function addressOf(row) {
  const field = value => typeof value === "string" ? value.trim() : "";
  const street = field(row.full_address);
  return street ? [street, field(row.postal_code), field(row.population)].filter(Boolean).join(", ") : "";
}

// The client uses the same sort and filtering to place estimates on the displayed legs.
export function journeyAddresses(home, appointments, ignored) {
  const orderTime = time => /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time) ? time.slice(0, 5) : "99";
  return [home, ...[
    ...appointments.filter(row => !row.source_missing && row.status !== "cancelled")
      .map(row => ({ time: row.scheduled_time, address: addressOf(row) })),
    ...ignored.filter(row => /mantenimiento|valoraci[oó]n/i.test(row.type ?? ""))
      .map(row => ({ time: row.time, address: addressOf(row) })),
  ].sort((a, b) => orderTime(a.time).localeCompare(orderTime(b.time))).map(row => row.address), home];
}

export async function journeyFingerprint(addresses) {
  const bytes = new TextEncoder().encode(JSON.stringify(addresses));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

// Strict subset of structured Spanish addresses. Unknown formats stay unavailable.
// Never send notes, apartment/door information, names or full free-form strings.
export function streetFields(address) {
  const parts = address.split(",").map(value => value.trim()).filter(Boolean);
  const street = /^(?<street>[\p{L}][\p{L} .’'-]{2,80})\s+(?<housenumber>\d{1,4}[A-Za-z]?)$/u.exec(parts[0] ?? "");
  const locality = /^(?<postcode>\d{5})\s+(?<city>[\p{L}][\p{L} .’'-]{1,70})$/u.exec(parts.slice(1).slice(-2).join(" "));
  if (!street || !locality || parts.length < 2) return null;
  return { ...street.groups, ...locality.groups, country: "España", filter: "countrycode:es", limit: "1" };
}

class RouteFailure extends Error {
  constructor(status, providerLimited = false) {
    super("Route service unavailable");
    this.status = status;
    this.providerLimited = providerLimited;
  }
}

async function readProvider(path, params, credits, context) {
  // Leave enough time between charges even if a provider response is immediate.
  const wait = Math.max(0, context.nextRequestAt - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  if (Date.now() >= context.deadline) throw new RouteFailure(503);
  if (!await context.charge(credits)) throw new RouteFailure(429);
  if (Date.now() >= context.deadline) throw new RouteFailure(503);
  const url = new URL(path, ENDPOINT);
  url.search = new URLSearchParams({ ...params, apiKey: context.apiKey });
  let response;
  try {
    context.nextRequestAt = Date.now() + 300;
    response = await context.fetcher(url, { redirect: "error", signal: AbortSignal.timeout(3500) });
    if (response.status === 429 || response.status === 403) throw new RouteFailure(429, true);
    if (!response.ok) throw new RouteFailure(503);
    return await response.json();
  } catch (error) {
    throw error instanceof RouteFailure ? error : new RouteFailure(503);
  }
}

async function geocode(fields, context) {
  const data = await readProvider("geocode/search", { ...fields, format: "json" }, 1, context);
  const location = data?.results?.[0];
  if (location?.country_code !== "es" || location.postcode !== fields.postcode
    || String(location.housenumber).toLowerCase() !== fields.housenumber.toLowerCase()
    || location.rank?.confidence_building_level < 0.9 || !Number.isFinite(location.rank?.confidence_building_level)
    || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)
    || Math.abs(location.lat) > 90 || Math.abs(location.lon) > 180) return null;
  return [location.lat, location.lon];
}

export async function calculateJourney(addresses, { charge, apiKey, fetcher = fetch }) {
  if (addresses.length < 3 || addresses.length > MAX_ACTIVITIES + 2) throw new RouteFailure(422);
  const context = { charge, apiKey, fetcher, nextRequestAt: 0, deadline: Date.now() + 55000 };
  // This map lasts only for the current request and avoids an extra lookup for home.
  const points = new Map();
  for (const address of new Set(addresses)) {
    const fields = streetFields(address);
    if (fields) points.set(address, await geocode(fields, context));
  }
  const estimates = Array(addresses.length - 1).fill(null);
  for (let index = 0; index < estimates.length; index++) {
    const from = points.get(addresses[index]), to = points.get(addresses[index + 1]);
    if (!from || !to) continue;
    // Skip long-distance queries and reserve a baseline credit plus headroom.
    if (Math.abs(from[0] - to[0]) > 1 || Math.abs(from[1] - to[1]) > 1) continue;
    const data = await readProvider("routing", {
      waypoints: from.join(",") + "|" + to.join(","), mode: "drive", units: "metric", traffic: "free_flow",
    }, 2, context);
    const route = data?.features?.[0]?.properties;
    if (!Number.isFinite(route?.distance) || route.distance < 0 || route.distance >= MAX_LEG_METERS
      || !Number.isFinite(route?.time) || route.time < 0 || route.time >= 28800) continue;
    estimates[index] = { distanceMeters: route.distance, durationSeconds: route.time, calculatedAt: new Date().toISOString() };
  }
  return estimates;
}
