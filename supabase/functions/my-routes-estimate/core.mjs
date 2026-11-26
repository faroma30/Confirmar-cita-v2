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
// CONFIRMAR_CITAS-018: Catalan and Spanish street-type abbreviations, with or without a dot or a slash
// ("PTGE X", "Ptge. X", "C/X", "AVGDA X"), expanded before searching and comparing. `null` marks an
// ambiguous abbreviation (PSG: passeig or passatge; CR: carrer or carretera): it is dropped and the street
// is searched by its name only, like a street that Oracle writes without a type.
const TYPE_ABBREVIATIONS = {
  c: "Calle", cl: "Calle", cll: "Calle",
  av: "Avenida", avd: "Avenida", avda: "Avenida", avgda: "Avinguda", avg: "Avinguda",
  pza: "Plaza", pz: "Plaza", plz: "Plaza", pl: "Plaza", "pça": "Plaça", pca: "Plaça", "plça": "Plaça",
  ps: "Paseo", pso: "Paseo", "pº": "Paseo", pg: "Passeig",
  ptge: "Passatge", ptg: "Passatge", pje: "Pasaje", psje: "Pasaje", pj: "Pasaje",
  ctra: "Carretera", crta: "Carretera",
  rda: "Ronda", rbla: "Rambla",
  trav: "Travessera", trv: "Travesía", tv: "Travesía",
  cm: "Camino", cno: "Camino", cmno: "Camino",
  urb: "Urbanización", urbz: "Urbanización",
  pol: "Polígono", polig: "Polígono",
  bda: "Barriada",
  psg: null, cr: null,
};
const LEADING_TYPE = /^(\p{L}{1,5}º?)(?:\s*[./]+\s*|\s+)(?=\S)/u;
function expandType(text) {
  const match = LEADING_TYPE.exec(text);
  const key = match?.[1].toLowerCase();
  if (!match || !Object.hasOwn(TYPE_ABBREVIATIONS, key)) return text;
  const rest = text.slice(match[0].length);
  return TYPE_ABBREVIATIONS[key] ? TYPE_ABBREVIATIONS[key] + " " + rest : rest;
}
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
  text = expandType(text);
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

const streetTypes = new Map([
  ["calle", "street"], ["carrer", "street"], ["rua", "street"], ["c", "street"],
  ["avenida", "avenue"], ["avinguda", "avenue"], ["av", "avenue"], ["avda", "avenue"],
  ["plaza", "square"], ["placa", "square"], ["passeig", "promenade"], ["paseo", "promenade"],
  ["via", "way"], ["cl", "street"], ["pza", "square"], ["pl", "square"], ["ps", "promenade"],
  ["ronda", "ronda"], ["rambla", "rambla"], ["camino", "path"], ["cami", "path"],
  ["travesia", "crossing"], ["travessera", "crossing"], ["carretera", "road"], ["ctra", "road"],
  ["pg", "promenade"], ["pca", "square"],
  // CONFIRMAR_CITAS-018: the rest of the Catalan and Spanish types and their abbreviations (same classes).
  ["cll", "street"], ["avd", "avenue"], ["avg", "avenue"], ["avgda", "avenue"], ["pz", "square"], ["plz", "square"],
  ["plca", "square"], ["placeta", "square"], ["pso", "promenade"], ["pº", "promenade"],
  ["passatge", "passage"], ["pasaje", "passage"], ["ptge", "passage"], ["ptg", "passage"], ["pje", "passage"],
  ["psje", "passage"], ["pj", "passage"], ["crta", "road"], ["rda", "ronda"], ["rbla", "rambla"],
  ["travessia", "crossing"], ["trav", "crossing"], ["trv", "crossing"], ["tv", "crossing"],
  ["cm", "path"], ["cno", "path"], ["cmno", "path"],
  ["urbanitzacio", "urbanization"], ["urbanizacion", "urbanization"], ["urb", "urbanization"], ["urbz", "urbanization"],
  ["poligon", "industrial"], ["poligono", "industrial"], ["pol", "industrial"], ["polig", "industrial"],
  ["barriada", "district"], ["bda", "district"],
]);

// CONFIRMAR_CITAS-018: what follows the portal number in Oracle ("9 A 2º 2º", "9 BJ", "9 ESC A", "9 PTA 3",
// "1º 2ª") is the floor, door, staircase or ground floor. It is dropped and never sent to Geoapify.
const INTERIOR_WORDS = new Set(["bj", "bjo", "bjos", "baj", "bajo", "bajos", "bx", "bxs", "baix", "baixos", "entlo", "entl",
  "entresuelo", "entresol", "atico", "atic", "sobreatico", "sobreatic", "sotano", "soterrani", "pral", "principal",
  "dcha", "dch", "dra", "derecha", "dreta", "izq", "izqda", "izda", "izquierda", "esq", "esquerra", "ext", "int",
  "exterior", "interior", "duplex", "tienda", "botiga", "local"]);
const INTERIOR_KEYS = new Set(["esc", "escalera", "escala", "pta", "puerta", "porta", "pis", "piso", "planta", "pl", "plt",
  "local", "loc", "bloque", "bloc", "blq", "bl", "edificio", "edif", "nave", "apto", "apt", "apartamento", "portal", "casa"]);
const ORDINAL = /^\d{1,3}(?:[ºª°]|r|n|t|er|on)?(?:[-/]\d{1,3}[ºª°]?)?$/u;
const NUMBER_MARK = /^(?:nº|n°|n\.º|num|núm|numero|número|nro)\.?$/u;
const PORTAL = /^(\d{1,5})([a-z])?(?:[-/](\d{1,5})[a-z]?)?$/u;
const bare = word => word.toLowerCase().replace(/\.+$/u, "");
const ordinalInterior = word => ORDINAL.test(word) && /[ºª°]|\d(?:r|n|t|er|on)$/u.test(word);
// "2n 1a", "2º 1a": a Catalan feminine ordinal (the door) only right after a floor.
const doorAfterFloor = (word, previous) => /^\d{1,2}a$/u.test(word) && (ordinalInterior(previous) || INTERIOR_WORDS.has(previous));

// Street name and portal of the first comma part. `noNumber` marks an explicit "S/N" (sin número).
export function exteriorStreet(value) {
  const text = field(value).replace(/(?:^|\s)s\s*[/.]\s*n\.?(?=\s|$)/giu, " s/n").replace(/(\d)\s*-\s*(\d)/gu, "$1-$2")
    .replace(/\b(nº|n°|n\.º|núm\.?|num\.?)(?=\d)/giu, "$1 ").replace(/\s+/gu, " ").trim();
  const words = text.split(" ").filter(Boolean);
  const hasNumberBefore = end => words.slice(1, end).some(word => /^\d/u.test(word) && !ordinalInterior(bare(word)));
  // Drop interior details from the end, but only while a portal number remains before them.
  for (let changed = true; changed && words.length > 2;) {
    changed = false;
    const last = bare(words.at(-1));
    const previous = bare(words.at(-2));
    if (INTERIOR_KEYS.has(previous) && /^[\p{L}\p{N}]{1,3}[ºª°]?$/u.test(last) && hasNumberBefore(words.length - 2)) {
      words.splice(-2, 2);
      changed = true;
    } else if ((INTERIOR_WORDS.has(last) || ordinalInterior(last) || doorAfterFloor(last, previous))
      && hasNumberBefore(words.length - 1)) {
      words.pop();
      changed = true;
    }
  }
  const noNumber = words.some(word => bare(word) === "s/n");
  if (noNumber) return { name: words.filter(word => bare(word) !== "s/n").join(" "), portal: "", noNumber };
  let end = words.length;
  let suffix = "";
  const last = bare(words.at(-1) ?? "");
  if (end > 2 && (/^[a-z]$/u.test(last) || /^(?:bis|ter)$/u.test(last)) && PORTAL.test(bare(words.at(-2)))) {
    suffix = last;
    end--;
  }
  const number = PORTAL.exec(bare(words[end - 1] ?? ""));
  if (end < 2 || !number || (suffix.length === 1 && number[2])) return { name: words.join(" "), portal: "", noNumber: false };
  let nameEnd = end - 1;
  if (nameEnd > 1 && NUMBER_MARK.test(bare(words[nameEnd - 1]))) nameEnd--;
  // A range ("9-11") is searched by its first number.
  const portal = number[3] ? number[1]
    : number[1] + (number[2] ?? (suffix.length === 1 ? suffix : "")).toUpperCase() + (suffix.length > 1 ? " " + suffix : "");
  return { name: words.slice(0, nameEnd).join(" "), portal, noNumber: false };
}

// Portal without its letter or "bis" (also the first number of a range): the second search form.
const basePortal = portal => /^\d{1,5}/u.exec(field(portal))?.[0] ?? field(portal);

// CONFIRMAR_CITAS-018: a municipality with capital articles («Ribes De Freser») → «Ribes de Freser».
export function municipalityName(value) {
  return field(value).split(" ").map((word, index) => {
    if (!index) return word;
    const lower = word.toLowerCase();
    if (PARTICLES.has(lower)) return lower;
    const elided = /^([dl])'(.+)$/iu.exec(word);
    if (!elided) return word;
    return elided[1].toLowerCase() + "'" + (PARTICLES.has(elided[2].toLowerCase()) ? elided[2].toLowerCase() : elided[2]);
  }).join(" ");
}

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

// CONFIRMAR_CITAS-018: Geoapify's portal fits the requested one when it is the same, when it is the bare
// number of a portal with a letter or "bis" ("9" for "9A"), or when it is a range that contains it ("9-11").
function portalFit(found, wanted) {
  if (samePortal(found, wanted)) return 2;
  const number = Number(basePortal(wanted));
  if (!/^\d{1,5}$/u.test(basePortal(wanted))) return 0;
  const text = normalized(found);
  if (text === String(number) && normalized(wanted) !== text) return 1;
  const range = /^(\d{1,5}) (\d{1,5})$/u.exec(text);
  return range && Number(range[1]) <= number && number <= Number(range[2]) ? 1 : 0;
}

// Comma parts with the portal joined to its street ("CALLE X, 8, ..." or "CALLE X, 9 A 2º, ...").
function addressParts(address) {
  const parts = field(address).split(",").map(cleanOracleText).filter(Boolean);
  if (parts.length > 2 && !exteriorStreet(parts[0]).portal && !exteriorStreet(parts[0]).noNumber
    && /^(?:\d|s\s*[/.]\s*n\b)/iu.test(parts[1]) && !/^\d{5}$/u.test(parts[1])) {
    parts.splice(0, 2, parts[0] + " " + parts[1]);
  }
  return parts;
}

// Use only the street/house number and the last locality fields, never interior details.
export function streetFields(address) {
  const parts = addressParts(address);
  if (parts.length < 2) return null;
  // Oracle can append positional building details without comma separators.
  // Strip only the observed structured suffix; never geocode the interior.
  const exterior = parts[0].replace(/(\s+\d{1,5})\s+\d{1,2}\s+[\p{L}]{1,12}\s+\d{1,3}[\p{L}]{1,3}\s+[\p{L}]{1,12}\s+\d{1,3}[\p{L}]{1,3}$/iu, "$1");
  // CONFIRMAR_CITAS-018: the portal may carry a letter, a range, «Nº» or the floor and door, which are dropped.
  const street = exteriorStreet(exterior);
  const locality = /^(?:(?<postcode>\d{5})\s+)?(?<city>[\p{L}][\p{L} .’'-]{1,99}?)(?: \((?<province>[\p{L}][\p{L} .’'-]{1,99})\))?$/u.exec(parts.at(-1));
  if (!street.portal || !STREET.test(street.name) || !locality || /(?:\p{N}[ .()\p{Pd}]*){9,}/u.test(exterior)) return null;
  const separatePostal = parts.length > 2 && /^\d{5}$/.test(parts.at(-2)) ? parts.at(-2) : "";
  const postcode = locality.groups.postcode || separatePostal;
  const { city, province } = locality.groups;
  return {
    street: street.name, housenumber: street.portal, ...(postcode ? { postcode } : {}), city: municipalityName(city),
    ...(province ? { province } : {}), country: "España", filter: "countrycode:es", limit: "5",
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

function contextFor({ charge, apiKey, fetcher = fetch, signal, manualFreePilot, cartociudad = null }) {
  // CONFIRMAR_CITAS-020: CartoCiudad only when the caller turns it on (the handler does; older tests do not).
  // `timeoutMs` can only lower the 5 s limit per call (the tests use it to simulate a slow service).
  const carto = cartociudad ? {
    fetcher: cartociudad.fetcher ?? fetch, onFailure: cartociudad.onFailure, off: false, calls: 0,
    timeoutMs: Math.min(CARTOCIUDAD_TIMEOUT_MS, Math.max(1, Number(cartociudad.timeoutMs) || CARTOCIUDAD_TIMEOUT_MS)),
  } : null;
  return { charge, apiKey, fetcher, signal, manualFreePilot, carto, nextRequestAt: 0, deadline: Date.now() + 55000 };
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
    || !portalFit(location.housenumber, fields.housenumber)
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
  // The exact portal ranks above its bare number or a range (CONFIRMAR_CITAS-018).
  const fit = (postcodeMatch ? 2 : 0) + (cityMatch ? 1 : 0) + (province && sameProvince(province, location) ? 0.5 : 0)
    + (portalFit(location.housenumber, fields.housenumber) === 2 ? 0.25 : 0);
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

// CONFIRMAR_CITAS-018: diagnostic code of a failed address, without personal data. Only the
// Geoapify fields are compared in memory; neither the response, the address text nor any coordinate
// is returned or logged.
export const ADDRESS_DIAGNOSTICS = ["no_results", "street_mismatch", "municipality_mismatch", "postcode_mismatch",
  "number_mismatch", "ambiguous", "missing_number", "missing_street"];

// How far the closest result got: 0 nothing, 1 another street, 2 the street in another area, 3 the street
// in the area but not this portal (or not confirmed with enough confidence).
export function addressDiagnostic(results, fields, limit = 5) {
  const rows = (Array.isArray(results) ? results.slice(0, limit) : []).filter(row => row && typeof row === "object");
  let found = { stage: 0, code: "no_results" };
  const reach = (stage, code) => { if (stage > found.stage) found = { stage, code }; };
  for (const location of rows) {
    if (location.country_code !== "es" || !sameStreet(location.street, fields.street)) { reach(1, "street_mismatch"); continue; }
    const names = [location.city, location.town, location.village, location.municipality].map(field).filter(Boolean);
    const cityMatch = names.some(name => sameMunicipality(name, fields.city));
    const postcodeMatch = Boolean(fields.postcode) && location.postcode === fields.postcode;
    const provinceMatch = !fields.province
      || normalized(provinceOf(location)) === (madridProvince(fields.province) ? "madrid" : normalized(fields.province));
    if (!provinceMatch || (!cityMatch && !postcodeMatch)) {
      // Without any municipality in the result only the postcode could be compared.
      reach(2, !names.length && fields.postcode && location.postcode ? "postcode_mismatch" : "municipality_mismatch");
      continue;
    }
    reach(3, "number_mismatch");
  }
  return found;
}

const unusableDiagnostic = address => address ? (incompleteReason(address) === "missing_number" ? "missing_number" : "missing_street") : null;

// CONFIRMAR_CITAS-020: CartoCiudad (IGN-CNIG, CC BY 4.0) is searched first, with at most two calls per
// address (`findJsonp` and, if needed, `candidates` with `cod_postal_filter`). Only the street name, the
// portal number, the postcode and the municipality are sent: never the floor, door, staircase, names or
// phones. Its failures never stop the pilot, never charge Geoapify credits and never set `provider_limited`:
// the address simply goes on to Geoapify as before. Neither the response nor the address is logged.
const CARTOCIUDAD = "https://www.cartociudad.es/geocoder/api/geocoder/";
export const CARTOCIUDAD_TIMEOUT_MS = 5000;
// Time kept for Geoapify within the 55 s budget of the request.
const CARTOCIUDAD_RESERVE_MS = 10000;

// Fase A (2.ª ronda): CartoCiudad finds the portal with the bare street name (without its type or leading
// articles: «Plaça de l'Ajuntament» → «Ajuntament»), the number and the municipality.
export function cartoStreetName(street) {
  const words = field(street).replace(/['’´`"]/gu, " ").split(/\s+/u).filter(Boolean);
  while (words.length > 1 && streetTypes.has(normalized(words[0]))) words.shift();
  while (words.length > 1 && ARTICLES.has(normalized(words[0]))) words.shift();
  return words.join(" ");
}

export function cartoQueries(fields) {
  const name = cartoStreetName(fields?.street);
  const number = basePortal(fields?.housenumber);
  const city = field(fields?.city);
  if (!name || !/^\d{1,5}$/u.test(number) || !city) return null;
  const postcode = /^\d{5}$/u.test(field(fields.postcode)) ? field(fields.postcode) : "";
  return {
    find: { q: `${name} ${number}, ${city}` },
    candidates: postcode ? { q: `${name} ${number}`, limit: "5", cod_postal_filter: postcode }
      : { q: `${name} ${number}, ${city}`, limit: "5" },
  };
}

// The response may come in ISO-8859-1 / windows-1252 (the Fase A fixtures show broken accents in UTF-8).
export function decodeCarto(bytes, contentType = "") {
  const charset = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1]?.toLowerCase();
  if (charset && !["utf-8", "utf8"].includes(charset)) {
    try { return new TextDecoder(charset).decode(bytes); } catch { /* Unknown label: try UTF-8 below. */ }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("windows-1252").decode(bytes); }
}

export function parseCarto(text) {
  const body = field(text);
  const jsonp = /^[A-Za-z_$][\w$.]*\(([\s\S]*)\)\s*;?$/u.exec(body);
  return JSON.parse(jsonp ? jsonp[1] : body);
}

async function readCarto(path, params, context) {
  const carto = context.carto;
  if (!carto || carto.off || context.signal?.aborted) return null;
  const left = context.deadline - Date.now() - CARTOCIUDAD_RESERVE_MS;
  const fail = (kind, http = null) => {
    // Slow or failing: the rest of the journey goes straight to Geoapify (no more waiting).
    carto.off = true;
    if (!context.signal?.aborted) carto.onFailure?.({ stage: "cartociudad", kind, http });
    return null;
  };
  if (left < 1000) return fail("no_time");
  const url = new URL(path, CARTOCIUDAD);
  url.search = new URLSearchParams(params);
  carto.calls = (carto.calls ?? 0) + 1;
  const timeout = AbortSignal.timeout(Math.min(carto.timeoutMs, left));
  const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
  let response;
  try {
    response = await carto.fetcher(url, { redirect: "error", signal });
  } catch {
    return context.signal?.aborted ? null : fail(timeout.aborted ? "timeout" : "network");
  }
  if (!response || response.status !== 200) return fail("provider_http", response?.status ?? null);
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return parseCarto(decodeCarto(bytes, response.headers?.get?.("content-type") ?? ""));
  } catch {
    return context.signal?.aborted ? null : fail(timeout.aborted ? "timeout" : "invalid_json", response.status);
  }
}

const cartoRows = data => (Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [])
  .filter(row => row && typeof row === "object").slice(0, 5);

// Street of a CartoCiudad row: `tip_via` + `address` without the portal and the municipality
// («PLAÇA L"AJUNTAMENT 3, Ripoll» → «PLAÇA L"AJUNTAMENT»). A broken type (with U+FFFD) is left out.
function cartoStreet(row) {
  const type = field(row.tip_via);
  let name = field(row.address);
  if (name.includes(",")) name = name.slice(0, name.lastIndexOf(",")).trim();
  if (row.type === "portal") name = name.replace(/\s+\d{1,5}(?:\s*[\p{L}]{1,3})?$/u, "").trim();
  const words = name.split(/\s+/u);
  if (type && normalized(words[0]) === normalized(type)) words.shift();
  const knownType = type && !type.includes(String.fromCharCode(0xfffd)) ? type : "";
  return [knownType, ...words].filter(Boolean).join(" ");
}

function cartoPoint(row) {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 27 && lat <= 44.5 && lng >= -18.5 && lng <= 4.6
    ? [lat, lng] : null;
}

// Letter or «bis» of the portal («9A» → «a»), from `extension` or the end of `address` («MAYOR 1 C»).
function cartoExtension(row) {
  const extension = normalized(row.extension ?? "");
  if (extension) return extension.replace(/\s+/gu, "");
  const text = field(row.address).split(",")[0];
  return normalized(/\d{1,5}\s*([\p{L}]{1,3})$/u.exec(text)?.[1] ?? "");
}

// Accepted: a portal with the same number and the same postcode or municipality (and the same street).
// A street («callejero») with coordinates is kept only as an approximate position: the official base
// has no portal there (Director's decision for this case only).
export function chooseCarto(data, fields) {
  const wanted = Number(basePortal(fields.housenumber));
  const letter = normalized(field(fields.housenumber).replace(/^\d{1,5}/u, "")).replace(/\s+/gu, "");
  const province = fields.province || provinceFromPostcode(fields.postcode);
  const exact = new Map();
  const streets = new Map();
  for (const row of cartoRows(data)) {
    const point = cartoPoint(row);
    if (!point || !["portal", "callejero"].includes(row.type) || !sameStreet(cartoStreet(row), fields.street)) continue;
    const postcodeMatch = Boolean(fields.postcode) && field(row.postalCode).split(/\s+/u).includes(fields.postcode);
    const cityMatch = sameMunicipality(field(row.muni), fields.city) || sameMunicipality(field(row.poblacion), fields.city);
    if (!postcodeMatch && !cityMatch) continue;
    if (province && field(row.province) && !sameProvince(province, { county: row.province }) && !(postcodeMatch && cityMatch)) continue;
    let fit = (postcodeMatch ? 2 : 0) + (cityMatch ? 1 : 0);
    const target = row.type === "portal" ? exact : streets;
    if (row.type === "portal") {
      if (Number(row.portalNumber) !== wanted) continue;
      const extension = cartoExtension(row);
      if (extension === letter) fit += 0.25;
      // Asked «9A» and found «9»: accepted below the exact portal. Asked «9» and found «9A»: never.
      else if (extension || !letter) continue;
    }
    const key = point.map(value => value.toFixed(5)).join(",");
    target.set(key, { point, fit: Math.max(fit, target.get(key)?.fit ?? 0) });
  }
  const unique = map => {
    const [best, second] = [...map.values()].sort((a, b) => b.fit - a.fit);
    return best && (!second || best.fit > second.fit) ? best.point : null;
  };
  return { point: unique(exact), approx: unique(streets) };
}

// CONFIRMAR_CITAS-022: the official street most similar to the Oracle name. Oracle may write the street
// differently from the official street map (articles, one letter, «PTGE»…). The streets of the same
// municipality and postcode are compared by their bare name (without type, articles, accents or capitals).
export const OFFICIAL_THRESHOLD = 0.85;
export const OFFICIAL_MARGIN = 0.1;
const SUGGESTION_MIN = 0.5;

// Bare name of a street: without its type, articles, accents or capitals («Carrer dels Clavataires» → «clavataires»).
export function streetKey(value) {
  return withoutArticles(streetParts(value).name);
}

// Normalized Levenshtein similarity (1 = equal, 0 = nothing in common).
export function similarity(left, right) {
  const a = [...field(left)];
  const b = [...field(right)];
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

const brokenText = value => value.includes(String.fromCharCode(0xfffd));

// Official street of a CartoCiudad row, as it is written in the street map:
// «PLAÇA AJUNTAMENT (DE L'), Ribes de Freser» → «Plaça de l'Ajuntament»; «MAS LA FARGA (Ripoll)» → «Mas la Farga»;
// «PLAÇA L"AJUNTAMENT 3, Ripoll» (portal) → «Plaça l'Ajuntament». Empty if it is not a street or a portal.
export function officialStreetName(row) {
  if (!row || typeof row !== "object" || !["callejero", "portal"].includes(row.type)) return "";
  const municipalities = [row.muni, row.poblacion].map(field).filter(Boolean);
  const parts = field(row.address).replace(/["´`’]/gu, "'").split(",").map(part => part.trim()).filter(Boolean);
  if (parts.length > 1 && municipalities.some(name => sameMunicipality(parts.at(-1).replace(/\s*\(.*\)$/u, ""), name))) parts.pop();
  let name = parts.shift() ?? "";
  let particle = parts.filter(part => part.split(/[\s']+/u).filter(Boolean).every(word => ARTICLES.has(normalized(word)))).join(" ");
  // Trailing groups in brackets: the article («(DE L')») goes before the name; the municipality is dropped.
  for (let group; (group = /\s*\(([^()]*)\)$/u.exec(name));) {
    const inside = group[1].trim();
    name = name.slice(0, group.index).trim();
    if (inside && inside.split(/[\s']+/u).filter(Boolean).every(word => ARTICLES.has(normalized(word)))) particle = inside + (particle ? " " + particle : "");
    else if (!municipalities.some(municipality => sameMunicipality(inside, municipality))) return "";
  }
  if (row.type === "portal") name = name.replace(/\s+\d{1,5}(?:\s*[\p{L}]{1,3})?$/u, "").trim();
  const type = field(row.tip_via);
  const words = name.split(/\s+/u).filter(Boolean);
  if (type && words.length > 1 && normalized(words[0]) === normalized(type)) words.shift();
  const knownType = type && !brokenText(type) && !streetTypes.has(normalized(words[0] ?? "")) ? type : "";
  const glue = particle.endsWith("'") ? "" : " ";
  const body = words.join(" ");
  const text = [knownType, particle ? particle + glue + body : body].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  if (!text || brokenText(text)) return "";
  const result = cleanOracleText(text);
  return STREET.test(result) ? result : "";
}

const inArea = (row, fields) => {
  const postcodeMatch = Boolean(fields.postcode) && field(row.postalCode).split(/\s+/u).includes(fields.postcode);
  const cityMatch = sameMunicipality(field(row.muni), fields.city) || sameMunicipality(field(row.poblacion), fields.city);
  return postcodeMatch || cityMatch;
};

// The street of the request is already in the official base (same name, same municipality or postcode).
function streetKnown(data, fields) {
  return cartoRows(data).some(row => ["portal", "callejero"].includes(row.type) && inArea(row, fields)
    && sameStreet(officialStreetName(row) || cartoStreet(row), fields.street));
}

const sameTypeClass = (left, right) => {
  const a = streetParts(left).type;
  const b = streetParts(right).type;
  return !a || !b || a === b;
};

// Decides on one official street only when it is clearly the most similar one (≥ 0.85 and 0.1 above the
// second, same class of street). With doubts it returns up to 3 official names of the same municipality.
export function chooseOfficialStreet(data, fields) {
  const wanted = streetKey(fields?.street);
  const streets = new Map();
  for (const row of (Array.isArray(data) ? data : cartoRows(data)).slice(0, 10)) {
    if (!row || typeof row !== "object" || !inArea(row, fields)) continue;
    const name = officialStreetName(row);
    const key = name && streetKey(name);
    if (!key || streets.has(key)) continue;
    if (sameStreet(name, fields.street)) return { same: true, street: null, suggestions: [] };
    const words = new Set(key.split(" "));
    const contains = wanted.split(" ").every(word => words.has(word)) || [...words].every(word => wanted.split(" ").includes(word));
    streets.set(key, { name, score: similarity(wanted, key), contains });
  }
  const ranked = [...streets.values()].sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (best && wanted && best.score >= OFFICIAL_THRESHOLD && (!second || best.score - second.score >= OFFICIAL_MARGIN)
    && sameTypeClass(best.name, fields.street)) {
    return { same: false, street: best.name, suggestions: [] };
  }
  const suggestions = ranked.filter(item => item.score >= SUGGESTION_MIN || item.contains).slice(0, 3).map(item => item.name);
  return { same: false, street: null, suggestions };
}

// Streets of the municipality without the portal number (the third CartoCiudad call, CONFIRMAR_CITAS-022).
export function cartoStreetQuery(fields) {
  const name = cartoStreetName(fields?.street);
  const city = field(fields?.city);
  if (!name || !city) return null;
  const postcode = /^\d{5}$/u.test(field(fields.postcode)) ? field(fields.postcode) : "";
  return postcode ? { q: name, limit: "10", cod_postal_filter: postcode } : { q: `${name}, ${city}`, limit: "10" };
}

// At most 3 CartoCiudad calls per address: `findJsonp`; if the street is not known there, the streets of the
// municipality (without number) to find the official name; then the portal in the official street (`findJsonp`)
// or, as before, `candidates` with the number and the postcode. Nothing is charged to the pilot.
async function geocodeCarto(fields, context) {
  const queries = cartoQueries(fields);
  if (!queries || !context.carto) return null;
  let approx = null;
  let suggestions = [];
  const attempt = async (path, params, target = fields) => {
    const data = await readCarto(path, params, context);
    if (data === null) return null;
    const choice = chooseCarto(data, target);
    if (!approx && choice.approx) approx = { point: choice.approx, official: target === fields ? null : target.street };
    return { data, point: choice.point };
  };
  const first = await attempt("findJsonp", queries.find);
  if (!first) return null;
  if (first.point) return { point: first.point, approx: false };
  let last;
  if (streetKnown(first.data, fields)) {
    last = await attempt("candidates", queries.candidates);
  } else {
    const list = await attempt("candidates", cartoStreetQuery(fields));
    if (list?.point) return { point: list.point, approx: false };
    if (list && cartoRows(list.data).length) {
      const official = chooseOfficialStreet(list.data, fields);
      if (official.street) {
        const target = { ...fields, street: official.street };
        last = await attempt("findJsonp", cartoQueries(target)?.find ?? queries.find, target);
        if (last?.point) return { point: last.point, approx: false, official: official.street };
        suggestions = [official.street];
      } else {
        // The same street (or no clear winner): the portal with the number and the postcode, as before.
        suggestions = official.suggestions;
        last = await attempt("candidates", queries.candidates);
      }
    }
  }
  if (last?.point) return { point: last.point, approx: false };
  if (approx) return { point: approx.point, approx: true, ...(approx.official ? { official: approx.official } : {}) };
  return { point: null, suggestions };
}

async function geocode(fields, context) {
  const carto = await geocodeCarto(fields, context);
  // The approximate street position keeps its detail code (the portal is not in the official base).
  if (carto?.point) return {
    point: carto.point, code: null, diagnostic: carto.approx ? "number_mismatch" : null, approx: carto.approx,
    source: "cartociudad", official: carto.official ?? null,
  };
  const found = await geocodeGeoapify(fields, context);
  return { ...found, approx: false, source: found.point ? "geoapify" : null, suggestions: found.point ? [] : carto?.suggestions ?? [] };
}

// A suggestion applied with one tap as `edits`: the official street with the portal, municipality and
// postcode of the same address (the technician's own agenda; never another person's data).
function suggestionLocation(street, fields) {
  const location = { street, number: field(fields.housenumber), municipality: field(fields.city) };
  location.postalCode = /^\d{5}$/u.test(field(fields.postcode)) ? field(fields.postcode) : "";
  if (fields.province && LOCALITY.test(fields.province)) location.province = fields.province;
  return location;
}

// ---- CONFIRMAR_CITAS-022: address assistant (`suggest`): CartoCiudad `candidates`, free, never Geoapify.
const SUGGEST_TEXT = /^[\p{L}\p{N}][\p{L}\p{N} .’'ºª/-]{2,99}$/u;
export function suggestQuery(input) {
  const text = field(input?.query).replace(/\s+/gu, " ");
  const municipality = field(input?.municipality).replace(/\s+/gu, " ");
  const postcode = field(input?.postalCode);
  if (!SUGGEST_TEXT.test(text) || text.replace(/\D/gu, "").length > 5) return null;
  if (municipality && (!LOCALITY.test(municipality) || municipality.length > 100)) return null;
  if (postcode && !/^\d{5}$/u.test(postcode)) return null;
  const name = cartoStreetName(cleanOracleText(text));
  if ([...name.replace(/[^\p{L}]/gu, "")].length < 3) return null;
  return {
    q: municipality ? `${name}, ${municipality}` : name, limit: "10",
    ...(postcode ? { cod_postal_filter: postcode } : {}),
  };
}

// Suggestions shown as «Calle Número · Pueblo (Provincia) CP». Only street map rows (streets and portals).
export function suggestionRows(data, input = {}) {
  const municipality = field(input.municipality);
  const postcode = field(input.postalCode);
  const items = new Map();
  for (const row of (Array.isArray(data) ? data : cartoRows(data)).slice(0, 10)) {
    const street = officialStreetName(row);
    const town = municipalityName(field(row.muni) || field(row.poblacion));
    if (!street || !LOCALITY.test(town) || brokenText(town)) continue;
    if (municipality && !sameMunicipality(town, municipality) && !sameMunicipality(field(row.poblacion), municipality)) continue;
    const codes = field(row.postalCode).split(/\s+/u).filter(code => /^\d{5}$/u.test(code));
    const postalCode = codes.length === 1 ? codes[0] : postcode && codes.includes(postcode) ? postcode : "";
    const number = row.type === "portal" && Number.isInteger(Number(row.portalNumber)) && Number(row.portalNumber) > 0
      ? String(Number(row.portalNumber)) + (cartoExtension(row) ? cartoExtension(row).toUpperCase() : "") : "";
    const named = field(row.province);
    const province = named && !brokenText(named) && LOCALITY.test(named) ? named : provinceFromPostcode(postalCode);
    const label = [street + (number ? " " + number : ""), town + (province && normalized(province) !== normalized(town) ? ` (${province})` : "")
      + (postalCode ? " " + postalCode : "")].join(" · ");
    if (items.has(label)) continue;
    items.set(label, { street, number, municipality: town, ...(province ? { province } : {}), postalCode, label });
  }
  return [...items.values()].slice(0, 6);
}

export async function suggestAddresses(input, { fetcher = fetch, timeoutMs, signal } = {}) {
  const params = suggestQuery(input);
  if (!params) throw new RouteFailure(400);
  const context = contextFor({ charge: async () => false, apiKey: "", signal, cartociudad: { fetcher, timeoutMs } });
  const data = await readCarto("candidates", params, context);
  if (data === null) throw new RouteFailure(503);
  return suggestionRows(data, input);
}

// At most two provider calls per address: one structured search and, only if it finds
// nothing usable, one free-text search. A real ambiguity is reported as before.
// CONFIRMAR_CITAS-018: the free-text search uses the bare portal number ("9" for "9A", "9 bis"),
// so both forms are tried within the same two calls. Floor and door never reach Geoapify.
async function geocodeGeoapify(fields, context) {
  const { province, ...params } = fields;
  const limit = Number(params.limit);
  const structured = await readProvider("geocode/search", { ...params, format: "json" }, 1, context);
  const first = chooseCandidate(structured?.results, fields, limit);
  if (first.outcome === "found") return { point: first.point, code: null, diagnostic: null };
  if (first.outcome === "ambiguous") return { point: null, code: "ambiguous", diagnostic: "ambiguous" };
  const firstMiss = missReason(structured?.results, fields, limit);
  const firstStage = addressDiagnostic(structured?.results, fields, limit);
  const text = await readProvider("geocode/search", {
    text: freeTextQuery({ ...fields, housenumber: basePortal(fields.housenumber) }), filter: params.filter, limit: params.limit,
    format: "json",
  }, 1, context);
  const second = chooseCandidate(text?.results, fields, limit);
  if (second.outcome === "found") return { point: second.point, code: null, diagnostic: null };
  if (second.outcome === "ambiguous") return { point: null, code: "ambiguous", diagnostic: "ambiguous" };
  const secondMiss = missReason(text?.results, fields, limit);
  const secondStage = addressDiagnostic(text?.results, fields, limit);
  return {
    point: null, code: firstMiss === "portal_not_found" || secondMiss === "portal_not_found" ? "portal_not_found" : "street_not_found",
    diagnostic: (secondStage.stage > firstStage.stage ? secondStage : firstStage).code,
  };
}

// An address that cannot be searched: without a portal number, or without street and municipality.
export function incompleteReason(address) {
  const parts = addressParts(address);
  if (parts.length < 2) return "incomplete";
  const exterior = exteriorStreet(parts[0]);
  if (exterior.portal) return "incomplete";
  const street = exterior.name;
  const hasLocality = /\p{L}/u.test(parts.at(-1)) && !/^\d+$/u.test(parts.at(-1));
  return hasLocality && STREET.test(street) && !/\d\s*$/u.test(street) && !/(?:\p{N}[ .()\p{Pd}]*){9,}/u.test(parts[0])
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
  // CONFIRMAR_CITAS-018: optional diagnostic code of the address that blocks each leg (ADDRESS_DIAGNOSTICS).
  const diagnostics = options.diagnostics ?? [];
  // CONFIRMAR_CITAS-020: optional per-leg «aprox.» mark and per-address origin ("cartociudad" / "geoapify").
  const approx = options.approx ?? [];
  const sources = options.sources ?? [];
  const settle = (index, detail, diagnostic = null) => {
    details[index] ??= reasons?.[index] === "privacy" ? "privacy" : detail;
    if (reasons) reasons[index] ??= legacyReason(details[index]);
    if (details[index] === detail && detail !== "privacy") diagnostics[index] ??= diagnostic;
  };
  async function outcomeFor(address) {
    if (!points.has(address)) {
      const fields = streetFields(address);
      points.set(address, fields ? await geocode(fields, context)
        : { point: null, code: incompleteReason(address), diagnostic: unusableDiagnostic(address) });
    }
    return points.get(address);
  }
  async function leg(index) {
    const fromFields = streetFields(addresses[index]);
    const toFields = streetFields(addresses[index + 1]);
    if (!fromFields || !toFields) {
      // Unusable text is never searched; an empty (privacy or missing) stop keeps its earlier reason.
      const to = addresses[index + 1];
      if (!toFields) settle(index, to ? incompleteReason(to) : "incomplete", unusableDiagnostic(to));
      else settle(index, addresses[index] ? "other_end_incomplete" : "incomplete", unusableDiagnostic(addresses[index]));
      return;
    }
    const from = await outcomeFor(addresses[index]);
    const to = await outcomeFor(addresses[index + 1]);
    // No routing call for a leg with an unresolved end.
    if (!to.point) { if (reasons) reasons[index] = "not_found"; settle(index, to.code, to.diagnostic); return; }
    if (!from.point) { if (reasons) reasons[index] = "not_found"; settle(index, "other_end", from.diagnostic); return; }
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
    } else {
      details[index] = null;
      // A street position (no portal in the official base): the leg is approximate and keeps its code.
      if (from.approx || to.approx) {
        approx[index] = true;
        diagnostics[index] = (to.approx ? to : from).diagnostic;
      }
    }
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
        diagnostics[rest] = null;
        if (reasons && reasons[rest] !== "privacy") reasons[rest] = null;
      }
      options.onPilotLimit?.();
      break;
    }
  }
  for (let index = 0; index < estimates.length; index++) {
    if (estimates[index]) details[index] = null;
    approx[index] = Boolean(estimates[index]) && approx[index] === true;
    if ((estimates[index] && !approx[index]) || !ADDRESS_DIAGNOSTICS.includes(diagnostics[index])) diagnostics[index] = null;
  }
  details.length = estimates.length;
  diagnostics.length = estimates.length;
  approx.length = estimates.length;
  // Only the provider name per address; never the address or its coordinates.
  for (let index = 0; index < addresses.length; index++) sources[index] = points.get(addresses[index])?.source ?? null;
  sources.length = addresses.length;
  // CONFIRMAR_CITAS-022 (optional): per address, the official street used and, for an address not found,
  // up to 3 official streets of the same municipality to apply with one tap (never coordinates).
  const officials = options.officials ?? [];
  const suggestions = options.suggestions ?? [];
  for (let index = 0; index < addresses.length; index++) {
    const outcome = points.get(addresses[index]);
    const fields = outcome && streetFields(addresses[index]);
    officials[index] = outcome?.point && outcome.official ? outcome.official : null;
    suggestions[index] = !outcome?.point && fields && outcome?.suggestions?.length
      ? outcome.suggestions.slice(0, 3).map(street => suggestionLocation(street, fields)) : null;
  }
  officials.length = addresses.length;
  suggestions.length = addresses.length;
  return estimates;
}
