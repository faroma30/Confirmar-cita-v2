// CONFIRMAR_CITAS-024: renovación automática diaria del piloto de Mis rutas (decisión del Director, 26/11/2026 21:17).
// Sin migración y sin tarea programada: la caducidad de 24 h sigue en la base (cc_route_pilot_begin/charge/status)
// y la función la renueva al consultar, solo si el piloto sigue ACTIVADO (`stopped = false`).
// - Mismo límite: no toca los topes (los fija la base por 24 h, ventana móvil; 1.000 créditos y 200 consultas desde 20261127090000)
//   ni el consumo externo declarado (`external_usage` se mantiene tal cual; la base exige ≤ 2950 para reactivar).
// - Nunca renueva un piloto desactivado por el Administrador ni parado por un error de Geoapify (401/403,
//   distancia excedida): en los dos casos la base deja `stopped = true` y aquí no se escribe nada.
// - Nunca renueva un piloto que nadie verificó (`quotaVerifiedAt` vacío) ni con el cálculo no aprobado.
// - Desactivar sigue siendo solo del Administrador (pilot-control.mjs); este módulo no ofrece ninguna opción
//   al técnico: solo prolonga 24 h, con los mismos datos, lo que el Administrador dejó activado.

export const PILOT_WINDOW_MS = 24 * 3600_000;
/** Si entre leer el estado y escribir pasa más de esto, no se renueva (protege «Desactivar» del Administrador). */
export const RENEW_MAX_STALE_MS = 1000;
/** Tras desactivar, el Administrador vuelve a comprobar pasado este tiempo (ver `confirmPilotStopped`). */
export const STOP_RECHECK_MS = 2500;

const timeOf = value => typeof value === "string" ? Date.parse(value) : NaN;

/** Próxima renovación automática (ISO), o null si el piloto no se renovará solo. */
export function nextRenewalAt(status) {
  if (!status || typeof status !== "object" || status.stopped !== false) return null;
  const verified = timeOf(status.quotaVerifiedAt);
  return Number.isFinite(verified) ? new Date(verified + PILOT_WINDOW_MS).toISOString() : null;
}

/**
 * ¿Hay que renovar? Solo si está activado (no parado), se verificó alguna vez, ya pasaron las 24 h
 * y el consumo externo guardado cabe en lo que la base acepta para reactivar (0–2950).
 */
export function shouldRenew(status, nowMs = Date.now()) {
  if (!status || typeof status !== "object") return false;
  if (status.stopped !== false || status.active === true) return false;
  const verified = timeOf(status.quotaVerifiedAt);
  if (!Number.isFinite(verified) || verified > nowMs - PILOT_WINDOW_MS) return false;
  const usage = status.externalUsageAtVerification;
  return Number.isInteger(usage) && usage >= 0 && usage <= 2950;
}

/**
 * Lee el estado y, si toca, renueva el piloto con `cc_route_pilot_configure(<mismo consumo externo>, false)`.
 * @param {{ rpc: (name: string, args?: object) => Promise<{data: unknown, error: unknown}> }} backend cliente service_role
 * @returns {Promise<{ status: object|null, renewed: boolean }>} estado final (o null si no se pudo leer)
 */
export async function ensurePilotRenewed(backend, { now = () => Date.now(), enabled = true } = {}) {
  const read = async () => {
    const result = await backend.rpc("cc_route_pilot_status");
    return result.error || !result.data || typeof result.data !== "object" ? null : result.data;
  };
  const readAt = now();
  const status = await read();
  if (!status || !enabled || !shouldRenew(status, readAt)) return { status, renewed: false };
  // Lectura demasiado antigua: el Administrador podría haber desactivado entretanto. No se arriesga.
  if (now() - readAt > RENEW_MAX_STALE_MS) return { status, renewed: false };
  const renewed = await backend.rpc("cc_route_pilot_configure", {
    p_external_usage: status.externalUsageAtVerification, p_stop: false,
  });
  if (renewed.error || renewed.data !== true) return { status, renewed: false };
  console.warn(JSON.stringify({ event: "route_pilot_renewed" }));
  return { status: (await read()) ?? status, renewed: true };
}

/**
 * Tras «Desactivar piloto» del Administrador: si una renovación que leyó el estado justo antes llegó a escribir
 * después, el piloto volvería a quedar activado. Se espera ese margen y, si no está parado, se vuelve a parar.
 */
export async function confirmPilotStopped(backend, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  await wait(STOP_RECHECK_MS);
  const status = await backend.rpc("cc_route_pilot_status");
  if (!status.error && status.data && status.data.stopped === true) return true;
  const again = await backend.rpc("cc_route_pilot_configure", { p_external_usage: null, p_stop: true });
  return !again.error && again.data === true;
}

/** Campos añadidos a la respuesta de `status`/`stop` (la app 3routes19 los ignora). */
export function renewalFields(status) {
  return { autoRenew: true, nextRenewalAt: nextRenewalAt(status) };
}
