const technicianUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unsafeText = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const phoneLike = /(?:\p{N}[ .()\p{Pd}]*){9,}/u;
const streetText = /^[\p{L}\p{N} .\u2019'ºª/-]+$/u;
const localityText = /^[\p{L} .\u2019'-]+$/u;
const numberText = /^[\p{L}\p{N} .\u2019'ºª/-]+$/u;
const locationFields = {
  street: { max: 200, pattern: streetText },
  number: { max: 30, pattern: numberText },
  municipality: { max: 100, pattern: localityText },
  postalCode: { max: 5, pattern: /^[0-9]{5}$/ },
  province: { max: 100, pattern: localityText },
};

function isRecord(value) {
  return value !== null && typeof value === "object"
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function routeAccess(raw, actorId) {
  if (typeof raw !== "string" || typeof actorId !== "string" || !technicianUuid.test(actorId)) return null;
  let config;
  try { config = JSON.parse(raw); }
  catch { return null; }
  if (!isRecord(config) || !Object.hasOwn(config, actorId)) return null;
  for (const [id, scope] of Object.entries(config)) {
    if (!technicianUuid.test(id) || (scope !== "activities" && scope !== "home-and-activities")) return null;
  }
  return { includeHome: config[actorId] === "home-and-activities" };
}

export function canAutocomplete(access, kind) {
  if (typeof access?.includeHome !== "boolean") return false;
  return kind === "keys" || kind === "tourline" || (kind === "home" && access.includeHome);
}

function invalidEdits() {
  return new TypeError("Invalid route activity edits");
}

function parseLocation(location) {
  if (!isRecord(location) || Object.keys(location).some(field => !Object.hasOwn(locationFields, field))) {
    throw invalidEdits();
  }
  const parsed = {};
  for (const [field, { max, pattern }] of Object.entries(locationFields)) {
    const raw = Object.hasOwn(location, field) ? location[field] : "";
    if (typeof raw !== "string" || unsafeText.test(raw) || phoneLike.test(raw)) throw invalidEdits();
    const value = raw.trim();
    if ([...value].length > max || (value && !pattern.test(value))) throw invalidEdits();
    if (value || field !== "province") parsed[field] = value;
  }
  if (!parsed.street || !parsed.municipality) throw invalidEdits();
  return parsed;
}

export function parseActivityEdits(value) {
  const edits = new Map();
  if (value === undefined) return edits;
  if (!Array.isArray(value) || value.length > 100) throw invalidEdits();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) throw invalidEdits();
    const [key, edit] = entry;
    if (typeof key !== "string" || !key.trim() || key.length > 2000 || unsafeText.test(key) || edits.has(key)) {
      throw invalidEdits();
    }
    if (!isRecord(edit) || Object.keys(edit).length !== 2
      || !Object.hasOwn(edit, "travel") || !Object.hasOwn(edit, "location")) throw invalidEdits();
    const { travel, location } = edit;
    if ((travel !== "travel" && travel !== "pause") || (travel === "pause" && location !== null)) {
      throw invalidEdits();
    }
    edits.set(key, { travel, location: location === null ? null : parseLocation(location) });
  }
  return edits;
}

