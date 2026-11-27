// CONFIRMAR_CITAS-026: por qué se rechaza un cálculo (HTTP 429). Solo un código estable y, si es la espera
// entre cálculos del propio técnico, los segundos que faltan. Nunca cifras internas ni datos de otros técnicos.
// Solo lee: `cc_route_pilot_status` y `cc_route_budget_wait` (migración 20261127120000). No cambia topes,
// esperas ni el tratamiento de 401/403/429 de Geoapify. Sin la migración, la espera no se puede saber.

export const BLOCK_CODES = ["wait", "busy", "credits_limit", "routes_limit", "shared_limit", "external_limit",
  "provider_limited", "route_too_long", "pilot_stopped", "pilot_unverified", "budget_refused"];
const MAX_WAIT_SECONDS = 120;

async function read(backend, name, args) {
  try {
    const result = await backend.rpc(name, args);
    return !result.error && result.data && typeof result.data === "object" ? result.data : null;
  } catch { return null; }
}

const secondsOf = value => Number.isInteger(value) && value > 0 && value <= MAX_WAIT_SECONDS ? value : null;

/** Segundos que faltan para que el técnico pueda volver a calcular, o null (sin espera o sin la migración). */
export async function remainingWait(backend, actor) {
  return secondsOf((await read(backend, "cc_route_budget_wait", { p_actor: actor }))?.waitSeconds);
}

function statusCause(status, operation) {
  if (!status) return null;
  if (status.stopped === true) {
    return status.lastError === "provider_limited" ? "provider_limited"
      : status.lastError === "route_estimate_exceeded" ? "route_too_long" : "pilot_stopped";
  }
  if (status.active === false) return "pilot_unverified";
  const reached = (used, limit) => Number.isFinite(used) && Number.isFinite(limit) && used >= limit;
  if (reached(status.creditsReserved24h, status.creditsLimit24h)) return "credits_limit";
  if (operation === "route" && reached(status.routingRequests24h, status.routingRequestsLimit24h)) return "routes_limit";
  if (reached(status.externalUsageAtVerification + status.creditsReserved24h, 3000)) return "external_limit";
  return null;
}

/**
 * Causa de una reserva rechazada. `{}` si no se puede saber (la app muestra un texto genérico).
 * @returns {Promise<{code?: string, retryAfterSeconds?: number}>}
 */
export async function blockCause(backend, { actor, operation }) {
  const cause = statusCause(await read(backend, "cc_route_pilot_status"), operation);
  if (cause) return { code: cause };
  const budget = await read(backend, "cc_route_budget_wait", { p_actor: actor });
  if (!budget) return {};
  if (budget.sharedLimit === true) return { code: "shared_limit" };
  const wait = secondsOf(budget.waitSeconds);
  if (operation === "route" && wait) return { code: "wait", retryAfterSeconds: wait };
  if (budget.paused === true) return { code: "provider_limited" };
  if (budget.busy === true) return { code: "busy" };
  return {};
}

/**
 * Rechazo durante el cálculo, con la reserva ya liberada: Geoapify (401/403/429) o falta de margen propio.
 * @returns {Promise<{code?: string, retryAfterSeconds?: number}>}
 */
export async function chargeRefusal(backend, { actor, operation, providerLimited }) {
  if (providerLimited) return { code: "provider_limited" };
  const found = await blockCause(backend, { actor, operation });
  if (found.code && found.code !== "wait" && found.code !== "busy") return found;
  return { code: "budget_refused", ...(found.retryAfterSeconds ? { retryAfterSeconds: found.retryAfterSeconds } : {}) };
}
