// CONFIRMAR_CITAS-031: cálculo ya hecho de Mis rutas, tramo a tramo. Se conserva en memoria durante la sesión
// y, solo para hoy y mañana (Europe/Madrid), en la base (migración 20261128090000). En la base no entra
// ninguna dirección, nombre ni teléfono: huellas SHA-256 de cada tramo, números, horas y códigos.
const HEX = /^[a-f0-9]{64}$/;
const CODE = /^[a-z_]{1,40}$/;
const SOURCES = new Set(["cartociudad", "geoapify"]);
// Fallos que dependen de la dirección: repetir la consulta sin corregirla daría lo mismo y gastaría créditos.
const KEPT_REASONS = new Set(["privacy", "incomplete", "not_found", "no_route"]);

const madridFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });
export const madridDay = now => madridFormat.format(now);
export function savableDate(date, now) {
  const today = madridDay(now);
  const next = new Date(today + "T00:00:00Z");
  next.setUTCDate(next.getUTCDate() + 1);
  return date === today || date === next.toISOString().slice(0, 10);
}

async function digest(parts) {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
const agendaPoint = stop => !stop.key ? stop.address || ""
  : stop.agendaAddress || "sin dirección " + stop.type + " " + stop.time;

// Huella de un tramo. `a`: según la agenda y Ajustes (sin correcciones); `s`: con las direcciones usadas ahora.
const signatureParts = (actorId, leg) => [
  ["agenda", actorId, agendaPoint(leg.from), agendaPoint(leg.to)],
  ["usada", actorId, leg.from.address || "", leg.to.address || ""],
];
export async function legSignatures(actorId, leg) {
  const [a, s] = await Promise.all(signatureParts(actorId, leg).map(digest));
  return { a, s };
}
// Sin base donde guardar, basta con comparar en memoria (sin huellas).
export function memorySignatures(actorId, leg) {
  const [a, s] = signatureParts(actorId, leg).map(parts => JSON.stringify(parts));
  return { a, s };
}

// Registro de un tramo a partir de una respuesta del cálculo; null si la respuesta no dice nada de ese tramo.
export function recordFrom(batch, index, estimate, signature, now) {
  const detail = batch?.details?.[index] ?? null;
  const reason = batch?.reasons?.[index] ?? null;
  if (!estimate && !detail && !reason) return null;
  const record = { ...signature, t: new Date(estimate ? estimate.calculatedAt : now).toISOString() };
  if (estimate) {
    record.d = estimate.durationSeconds;
    record.m = estimate.distanceMeters;
    if (batch?.approx?.[index] === true) record.ap = true;
  } else {
    if (reason) record.r = reason;
    if (detail) record.dt = detail;
  }
  if (batch?.diagnostics?.[index]) record.dg = batch.diagnostics[index];
  const pair = list => Array.isArray(list) && (list[index] || list[index + 1]) ? [list[index] ?? null, list[index + 1] ?? null] : null;
  const src = pair(batch?.sources);
  if (src) record.src = src;
  // Solo en memoria: la calle oficial y las sugerencias son texto de dirección y no se guardan.
  const officials = pair(batch?.officials);
  if (officials) record.officials = officials;
  const suggestions = pair(batch?.suggestions);
  if (suggestions) record.suggestions = suggestions;
  return record;
}

// Resultado recién calculado: sustituye al anterior, salvo que un fallo sin corrección en memoria (la de la
// agenda, tras perderse la corrección) fuera a borrar un tiempo ya calculado con otra dirección.
export function keepRecord(records, next, edited = false) {
  const previous = records.get(next.a);
  if (!edited && previous && previous.d !== undefined && next.d === undefined && previous.s !== next.s) return;
  records.set(next.a, next);
}

// Resultado leído de la base: entra si no hay nada o si es más reciente que lo de este dispositivo.
export function absorbRecord(records, saved) {
  const previous = records.get(saved.a);
  if (!previous || Date.parse(saved.t) > Date.parse(previous.t)) records.set(saved.a, saved);
}

// Qué se muestra en un tramo. `edited`: en esta sesión hay una corrección en alguno de sus dos extremos.
export function lookupRecord(records, signature, edited) {
  const record = records.get(signature.a);
  if (!record) return null;
  if (record.s === signature.s) return record;
  // Calculado con una dirección corregida que ya no está en memoria (app reabierta u otro dispositivo).
  return !edited && record.d !== undefined ? { ...record, corrected: true } : null;
}

// Tramo «sin calcular» que merece pedirse: nunca calculado o cortado por el tope.
export function pendingRecord(record) {
  if (!record) return true;
  if (record.d !== undefined) return false;
  return record.dt ? record.dt === "pilot_limit" : !KEPT_REASONS.has(record.r);
}

// Solo los campos que admite la base, con su formato; null si el registro no es válido.
export function persistableRecord(record) {
  if (!record || !HEX.test(record.a) || !HEX.test(record.s) || !Number.isFinite(Date.parse(record.t))) return null;
  const clean = { a: record.a, s: record.s, t: new Date(record.t).toISOString() };
  const amount = value => Number.isFinite(value) && value >= 0 && value <= 10000000;
  if (record.d !== undefined || record.m !== undefined) {
    if (!amount(record.d) || !amount(record.m)) return null;
    clean.d = record.d;
    clean.m = record.m;
  }
  for (const field of ["r", "dt", "dg"]) if (typeof record[field] === "string" && CODE.test(record[field])) clean[field] = record[field];
  if (record.ap === true) clean.ap = true;
  if (Array.isArray(record.src) && record.src.length === 2) clean.src = record.src.map(value => SOURCES.has(value) ? value : null);
  return clean;
}

// Acceso a la base. Cualquier fallo (por ejemplo, sin la migración) se ignora: la app sigue como antes.
export function createRpcRouteDays({ rpc, getActor }) {
  async function call(name, args) {
    const actor = getActor();
    if (actor?.role !== "technician" || !actor.id) return null;
    try {
      const response = await rpc(name, { ...args, p_expected_technician_id: actor.id });
      const current = getActor();
      if (response?.error || current?.id !== actor.id || current.role !== "technician") return null;
      return response.data;
    } catch { return null; }
  }
  return {
    async read(date) {
      const data = await call("cc_my_route_day", { p_work_date: date });
      return Array.isArray(data) ? data.slice(0, 101).map(persistableRecord).filter(Boolean) : [];
    },
    async save(date, records) {
      const legs = records.slice(0, 101).map(persistableRecord).filter(Boolean);
      return await call("cc_save_my_route_day", { p_work_date: date, p_legs: legs }) === true;
    },
  };
}
