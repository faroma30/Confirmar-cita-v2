import { buildLegs, combineActivities, formatRouteLocation } from "./route-agenda.mjs";
const ENDPOINT = "https://api-eu.geoapify.com/v1/";
const MAX_ACTIVITIES = 100;
const MAX_LEG_METERS = 500000;

const field = value => typeof value === "string" ? value.trim() : "";
// The acute accent used as an apostrophe («D´EN») separates words, like «'» (CONFIRMAR_CITAS-017).
const normalized = value => field(value).replace(/[´`‘’ʼ′]/gu, " ").normalize("NFD").replace(/\p{Diacritic}/gu, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// CONFIRMAR_CITAS-015: Oracle writes addresses in capitals, with duplicated street types
// ("CALLE CARRER DE ...") and acute accents used as apostrophes ("L´ESTACIÓ").
const APOSTROPHES = /[´`‘’ʼ′]/gu;
const ABBREVIATED_TYPE = /^(c|cl|av|avda|pza|pl|ps|pg|ctra)\s*[/.]\s*/iu;
const EXPANDED_TYPE = {
  c: "Calle", cl: "Calle", av: "Avenida", avda: "Avenida", pza: "Plaza", pl: "Plaza", ps: "Paseo", pg: "Paseo", ctra: "Carretera",
};
const GENERIC_TYPES = new Set(["calle", "cl", "c", "avenida", "av", "avda", "plaza", "pza", "pl", "paseo", "ps", "pg",
  "camino", "carretera", "ctra"]);
const PARTICLES = new Set(["de", "del", "la", "las", "los", "el", "y", "i", "en", "les", "dels", "els", "al", "a", "da", "do", "das", "dos"]);
const capitalize = word => word.replace(/(^|-)(\p{L})/gu, (_, start, letter) => start + letter.toUpperCase());

function titleCase(value) {
  return value.split(" ").map((word, index) => word.toLowerCase().split("'").map((part, position, all) => {
    if (!part) return part;
    const first = index === 0 && position === 0;
    // Elided articles keep their lower case: l'Estació, d'Espanya.
    if (position < all.length - 1 && [...part].length <= 2) return first ? capitalize(part) : part;
    return !first && PARTICLES.has(part) ? part : capitalize(part);
  }).join("'")).join(" ");
}

export function cleanOracleText(value) {
  let text = field(value).replace(APOSTROPHES, "'").replace(/\s*'\s*/gu, "'").replace(/\s+/gu, " ").trim();
  const capitals = /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text);
  text = text.replace(ABBREVIATED_TYPE, (_, type) => EXPANDED_TYPE[type.toLowerCase()] + " ");
  const words = text.split(" ");
  // "CALLE CARRER DE ..." keeps the specific type ("Carrer de ...").
  while (words.length > 2 && GENERIC_TYPES.has(normalized(words[0])) && streetTypes.has(normalized(words[1]))) words.shift();
  text = words.join(" ");
  return capitals ? titleCase(text) : text;
}

// Province of a Spanish postcode: its first two digits (01-52).
const PROVINCES = ["Álava", "Albacete", "Alicante", "Almería", "Ávila", "Badajoz", "Illes Balears", "Barcelona", "Burgos",
  "Cáceres", "Cádiz", "Castellón", "Ciudad Real", "Córdoba", "A Coruña", "Cuenca", "Girona", "Granada", "Guadalajara",
  "Gipuzkoa", "Huelva", "Huesca", "Jaén", "León", "Lleida", "La Rioja", "Lugo", "Madrid", "Málaga", "Murcia", "Navarra",
  "Ourense", "Asturias", "Palencia", "Las Palmas", "Pontevedra", "Salamanca", "Santa Cruz de Tenerife", "Cantabria",
  "Segovia", "Sevilla", "Soria", "Tarragona", "Teruel", "Toledo", "Valencia", "Valladolid", "Bizkaia", "Zamora",
  "Zaragoza", "Ceuta", "Melilla"];
const PROVINCE_ALIASES = {
  "Álava": ["Araba", "Araba/Álava", "Álava/Araba"], "Alicante": ["Alacant", "Alicante/Alacant"],
  "Illes Balears": ["Baleares", "Islas Baleares", "Balears", "Balearic Islands"], "Castellón": ["Castelló", "Castellón/Castelló"],
  "A Coruña": ["La Coruña", "Coruña"], "Girona": ["Gerona"], "Gipuzkoa": ["Guipúzcoa"], "Lleida": ["Lérida"],
  "La Rioja": ["Rioja"], "Madrid": ["Comunidad de Madrid", "Community of Madrid", "Provincia de Madrid"],
  "Murcia": ["Región de Murcia", "Region of Murcia"], "Navarra": ["Nafarroa", "Comunidad Foral de Navarra"],
  "Ourense": ["Orense"], "Asturias": ["Principado de Asturias"], "Valencia": ["València", "Valencia/València"],
  "Bizkaia": ["Vizcaya", "Biscay"],
};

export function provinceFromPostcode(postcode) {
  const prefix = /^(\d{2})\d{3}$/u.exec(field(postcode));
  const number = prefix ? Number(prefix[1]) : 0;
  return number >= 1 && number <= PROVINCES.length ? PROVINCES[number - 1] : "";
}

function sameProvince(province, location) {
  const names = new Set([province, ...(PROVINCE_ALIASES[province] ?? [])].map(normalized));
  return [location?.county, location?.state].some(value => names.has(normalized(value)));
}

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
      && sameMunicipality(home.city, candidate.city)) return "";
    return address;
  });
}

// CONFIRMAR_CITAS-015: the saved home reaches Geoapify only when the technician turned on
// «Usar mi domicilio» (explicit useHome in the request). Otherwise both home legs stay "privacy".
export function providerPlan(addresses, includeHome) {
  const allowed = providerAddresses(addresses, includeHome === true);
  const reasons = addresses.slice(1).map((address, i) =>
    (address && !allowed[i + 1]) || (addresses[i] && !allowed[i]) || (includeHome !== true && (i === 0 || i === addresses.length - 2))
      ? "privacy" : null);
  return { addresses: allowed, reasons };
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
  ["via", "way"], ["cl", "street"], ["pza", "square"], ["pl", "square"], ["ps", "promenade"],
  ["ronda", "ronda"], ["rambla", "rambla"], ["camino", "path"], ["cami", "path"],
  ["travesia", "crossing"], ["travessera", "crossing"], ["carretera", "road"], ["ctra", "road"],
  ["pg", "promenade"], ["pca", "square"],
]);

// CONFIRMAR_CITAS-017: Catalan and Spanish articles and prepositions that Oracle, autocomplete and
// Geoapify write differently ("Carrer d'en Prova" / "CARRER PROVA", "de les", "dels", "de la", "del").
const ARTICLES = new Set(["de", "del", "dels", "d", "la", "las", "los", "l", "el", "els", "les", "en", "na", "n"]);
const withoutArticles = name => name.split(" ").filter(word => word && !ARTICLES.has(word)).join(" ");

function streetParts(value) {
  const words = normalized(value).split(" ").filter(Boolean);
  let type;
  // A duplicated or translated type ("Calle Carrer de ...") counts once.
  while (words.length > 1 && streetTypes.has(words[0]) && (!type || streetTypes.get(words[0]) === type)) {
    type = streetTypes.get(words.shift());
  }
  return { type, name: words.join(" ") };
}

export function sameStreet(left, right) {
  const a = streetParts(left);
  const b = streetParts(right);
  // Equivalent types (Calle/Carrer/C., Avenida/Avinguda/Av., ...) share a class; different classes never match.
  if (a.type && b.type && a.type !== b.type) return false;
  if (a.name === b.name) return a.name !== "";
  const bare = withoutArticles(a.name);
  return bare !== "" && bare === withoutArticles(b.name);
}

// Municipality equal without accents, apostrophes or leading articles ("Campdevanol" / "Campdevànol").
export function sameMunicipality(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  if (!a || !b) return false;
  return a === b || (withoutArticles(a) !== "" && withoutArticles(a) === withoutArticles(b));
}

function samePortal(left, right) {
  const portal = value => normalized(value).replace(/^(\d+) ([a-z]+)$/, "$1$2");
  return portal(left) === portal(right);
}

// Use only the street/house number and the last locality fields, never interior details.
export function streetFields(address) {
  const parts = field(address).split(",").map(cleanOracleText).filter(Boolean);
  if (parts.length < 2) return null;
  // "CALLE X, 8, 17001, GIRONA": the portal can come in its own comma-separated part.
  if (parts.length > 2 && !HOUSE.test(parts[0]) && /^\d{1,4}(?:\s?[A-Za-z]|\s*(?:bis|ter))?$/iu.test(parts[1])) {
    parts.splice(0, 2, parts[0] + " " + parts[1]);
  }
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

// One Geoapify result checked against the separated Oracle fields (null if it does not fit).
function candidate(location, fields, province) {
  const point = coordinates(location);
  const match = location?.rank?.match_type;
  if (!point || location?.country_code !== "es"
    || (fields.province && normalized(provinceOf(location)) !== (madridProvince(fields.province) ? "madrid" : normalized(fields.province)))
    || !sameStreet(location.street, fields.street)
    || !samePortal(location.housenumber, fields.housenumber)
    || !["building", "amenity"].includes(location.result_type)
    || !["full_match", "match_by_building", "inner_part"].includes(match)) return null;
  const postcodeMatch = Boolean(fields.postcode) && location.postcode === fields.postcode;
  const cityMatch = [location.city, location.town, location.village, location.municipality]
    .some(name => sameMunicipality(field(name), fields.city));
  // A postcode that differs (or is missing) is accepted only in the same municipality, ranked lower.
  if (!postcodeMatch && !cityMatch) return null;
  // A venue inside a building can match the full portal even with an inner-part rank.
  const score = location.rank.confidence_building_level ?? (match === "full_match" ? location.rank.confidence : null);
  const both = postcodeMatch && cityMatch;
  const reliable = match === "inner_part"
    ? location.result_type === "amenity" && location.rank.confidence === 1 && score === 1
    : Number.isFinite(score) && (score >= 0.9 || (both && score >= 0.8));
  const fit = (postcodeMatch ? 2 : 0) + (cityMatch ? 1 : 0) + (province && sameProvince(province, location) ? 0.5 : 0);
  return { point, reliable, fit, score: Number.isFinite(score) ? score : 0 };
}

// Prefer the result that matches postcode and municipality with the highest confidence.
// Several results only block the leg when none of them clearly stands out.
export function chooseCandidate(results, fields, limit = 5) {
  const province = fields.province || provinceFromPostcode(fields.postcode);
  const points = new Map();
  for (const location of Array.isArray(results) ? results.slice(0, limit) : []) {
    const found = candidate(location, fields, province);
    if (!found) continue;
    const key = found.point.map(value => value.toFixed(5)).join(",");
    const current = points.get(key);
    points.set(key, !current ? found : {
      point: current.point, reliable: current.reliable || found.reliable,
      fit: Math.max(current.fit, found.fit), score: Math.max(current.score, found.score),
    });
  }
  const ranked = [...points.values()].sort((a, b) => b.fit - a.fit || b.score - a.score);
  const [best, second] = ranked;
  if (!best?.reliable) return { point: null, outcome: ranked.some(item => item.reliable) ? "ambiguous" : "none" };
  const clear = !second || best.fit > second.fit || best.score - second.score >= 0.15;
  return clear ? { point: best.point, outcome: "found" } : { point: null, outcome: "ambiguous" };
}

export function freeTextQuery(fields) {
  const province = fields.province || provinceFromPostcode(fields.postcode);
  return [[fields.street, fields.housenumber].join(" "), [fields.postcode, fields.city].filter(Boolean).join(" "),
    normalized(province) !== normalized(fields.city) ? province : "", "España"].filter(Boolean).join(", ");
}

// CONFIRMAR_CITAS-017: why nothing fitted, as a stable code. Only the Geoapify fields are compared
// in memory; neither the provider response nor any coordinate is returned or logged.
export function missReason(results, fields, limit = 5) {
  const rows = Array.isArray(results) ? results.slice(0, limit) : [];
  const sameArea = location => location?.country_code === "es"
    && ((Boolean(fields.postcode) && location.postcode === fields.postcode)
      || [location.city, location.town, location.village, location.municipality].some(name => sameMunicipality(field(name), fields.city)));
  return rows.some(location => sameArea(location) && sameStreet(location.street, fields.street))
    ? "portal_not_found" : "street_not_found";
}

// At most two provider calls per address: one structured search and, only if it finds
// nothing usable, one free-text search. A real ambiguity is reported as before.
async function geocode(fields, context) {
  const { province, ...params } = fields;
  const structured = await readProvider("geocode/search", { ...params, format: "json" }, 1, context);
  const first = chooseCandidate(structured?.results, fields, Number(params.limit));
  if (first.outcome === "found") return { point: first.point, code: null };
  if (first.outcome === "ambiguous") return { point: null, code: "ambiguous" };
  const firstMiss = missReason(structured?.results, fields, Number(params.limit));
  const text = await readProvider("geocode/search", {
    text: freeTextQuery(fields), filter: params.filter, limit: params.limit, format: "json",
  }, 1, context);
  const second = chooseCandidate(text?.results, fields, Number(params.limit));
  if (second.outcome === "found") return { point: second.point, code: null };
  if (second.outcome === "ambiguous") return { point: null, code: "ambiguous" };
  const secondMiss = missReason(text?.results, fields, Number(params.limit));
  return { point: null, code: firstMiss === "portal_not_found" || secondMiss === "portal_not_found" ? "portal_not_found" : "street_not_found" };
}

// An address that cannot be searched: without a portal number, or without street and municipality.
export function incompleteReason(address) {
  const parts = field(address).split(",").map(cleanOracleText).filter(Boolean);
  if (parts.length < 2) return "incomplete";
  const street = parts[0].replace(/\s+s\s*\/?\s*n$/iu, "").trim();
  const hasLocality = /\p{L}/u.test(parts.at(-1)) && !/^\d+$/u.test(parts.at(-1));
  return hasLocality && STREET.test(street) && !/\d\s*$/u.test(street) && !/(?:\p{N}[ .()\p{Pd}]*){9,}/u.test(street)
    ? "missing_number" : "incomplete";
}

// Per-leg detail codes (CONFIRMAR_CITAS-017). `reasons` keeps the vocabulary that 3routes14 understands.
export const LEG_DETAILS = ["privacy", "incomplete", "missing_number", "street_not_found", "portal_not_found", "ambiguous",
  "other_end", "other_end_incomplete", "pilot_limit", "no_route"];
const LEGACY_REASON = {
  privacy: "privacy", incomplete: "incomplete", missing_number: "incomplete", other_end_incomplete: "incomplete",
  street_not_found: "not_found", portal_not_found: "not_found", ambiguous: "not_found", other_end: "not_found",
  no_route: "no_route", pilot_limit: null,
};
export const legacyReason = detail => LEGACY_REASON[detail] ?? null;

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
  // CONFIRMAR_CITAS-017: one detail code per leg. A failed address only blocks the legs that touch it.
  const details = options.details ?? [];
  const settle = (index, detail) => {
    details[index] ??= reasons?.[index] === "privacy" ? "privacy" : detail;
    if (reasons) reasons[index] ??= legacyReason(details[index]);
  };
  async function outcomeFor(address) {
    if (!points.has(address)) {
      const fields = streetFields(address);
      points.set(address, fields ? await geocode(fields, context) : { point: null, code: incompleteReason(address) });
    }
    return points.get(address);
  }
  async function leg(index) {
    const fromFields = streetFields(addresses[index]);
    const toFields = streetFields(addresses[index + 1]);
    if (!fromFields || !toFields) {
      // Unusable text is never searched; an empty (privacy or missing) stop keeps its earlier reason.
      const to = addresses[index + 1];
      settle(index, !toFields ? (to ? incompleteReason(to) : "incomplete")
        : addresses[index] ? "other_end_incomplete" : "incomplete");
      return;
    }
    const from = await outcomeFor(addresses[index]);
    const to = await outcomeFor(addresses[index + 1]);
    // No routing call for a leg with an unresolved end.
    if (!to.point) { if (reasons) reasons[index] = "not_found"; settle(index, to.code); return; }
    if (!from.point) { if (reasons) reasons[index] = "not_found"; settle(index, "other_end"); return; }
    // This service-area filter is separate from the billable-distance bound.
    if (Math.abs(from.point[0] - to.point[0]) > 1 || Math.abs(from.point[1] - to.point[1]) > 1) {
      if (reasons) reasons[index] = "no_route";
      settle(index, "no_route");
      return;
    }
    const waypoints = from.point.join(",") + "|" + to.point.join(",");
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
    if (!estimates[index]) {
      if (reasons) reasons[index] = "no_route";
      settle(index, "no_route");
    } else details[index] = null;
  }
  for (let index = 0; index < estimates.length; index++) {
    try {
      await leg(index);
    } catch (error) {
      // The pilot's own budget refused a call (not a provider 401/403/429): keep the legs already
      // calculated and mark the rest. With nothing calculated yet, the 429 is returned as before.
      if (!(error instanceof RouteFailure) || error.status !== 429 || error.providerLimited || !estimates.some(Boolean)) throw error;
      for (let rest = index; rest < estimates.length; rest++) {
        if (details[rest] === "privacy") continue;
        details[rest] = "pilot_limit";
        if (reasons && reasons[rest] !== "privacy") reasons[rest] = null;
      }
      options.onPilotLimit?.();
      break;
    }
  }
  for (let index = 0; index < estimates.length; index++) if (estimates[index]) details[index] = null;
  details.length = estimates.length;
  return estimates;
}
