// Estado del piloto de Mis rutas explicado al técnico (CONFIRMAR_CITAS-006).
// Solo interpreta la respuesta de `operation: "status"`; no cambia permisos ni el servidor.

const madridParts = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function parts(value) {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  const out = Object.fromEntries(madridParts.formatToParts(date).map(({ type, value }) => [type, value]));
  for (const key of ["day", "month", "hour", "minute"]) out[key] = String(out[key] ?? "").padStart(2, "0");
  return out;
}

/** "HH:MM" en hora de Madrid, o "" si la fecha no es válida. */
export function madridClock(value) {
  const p = parts(value);
  return p ? p.hour + ":" + p.minute : "";
}

/** "DD/MM a las HH:MM" en hora de Madrid, o "" si la fecha no es válida. */
export function madridDayTime(value) {
  const p = parts(value);
  return p ? `${p.day}/${p.month} a las ${p.hour}:${p.minute}` : "";
}

export const pilotErrorNames = {
  quota: "cuota alcanzada",
  provider_limited: "Geoapify rechazó la consulta",
  provider_unavailable: "Geoapify no estaba disponible",
  route_estimate_exceeded: "un tramo superó la distancia reservada",
  timeout: "tiempo de espera agotado",
};

const count = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
const limit = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;

/**
 * Traduce el estado del piloto a lo que ve el técnico.
 * @returns {null | { canCalculate: boolean, canStop: boolean, cause: string|null, short: string, message: string, lines: string[] }}
 */
export function describePilot(state, now = new Date()) {
  if (!state || typeof state !== "object") return null;
  const credits = count(state.creditsReserved24h);
  const routes = count(state.routingRequests24h);
  const creditLimit = limit(state.creditsLimit24h, 50);
  const routeLimit = limit(state.routingRequestsLimit24h, 10);
  const errorAt = madridDayTime(state.lastErrorAt);
  const at = errorAt ? " el " + errorAt : "";
  const verifiedAt = madridDayTime(state.quotaVerifiedAt);
  const verifiedMs = Date.parse(state.quotaVerifiedAt ?? "");
  const verificationExpired = !Number.isFinite(verifiedMs) || verifiedMs <= now.getTime() - 24 * 3600_000;
  let cause = null, short = "", message = "";
  if (!state.enabled) {
    cause = "not_approved";
    short = "el cálculo no está aprobado en el servidor";
    message = "No aprobado: el servidor no tiene habilitado el cálculo con Geoapify. Avisa al administrador.";
  } else if (state.stopped) {
    if (state.lastError === "provider_limited") {
      cause = "provider_limited";
      short = "piloto parado por un rechazo de Geoapify";
      message = `Piloto parado: Geoapify rechazó la consulta${at}. Avisa al administrador.`;
    } else if (state.lastError === "route_estimate_exceeded") {
      cause = "route_estimate_exceeded";
      short = "piloto parado por un tramo demasiado largo";
      message = `Piloto parado: un tramo superó la distancia reservada${at}. Avisa al administrador.`;
    } else {
      cause = "stopped";
      short = "piloto parado";
      message = "Piloto parado: se desactivó desde la aplicación o lo paró el administrador. Avisa al administrador para reactivarlo.";
    }
  } else if (!state.active) {
    cause = "verification_expired";
    short = verifiedAt ? "verificación de consumo caducada" : "consumo de Geoapify sin verificar";
    message = verifiedAt
      ? `Verificación de consumo caducada (última: ${verifiedAt}). El administrador debe renovarla cada 24 h.`
      : "Consumo de Geoapify sin verificar. El administrador debe verificarlo antes de calcular.";
  } else if (credits >= creditLimit) {
    cause = "credits_limit";
    short = "tope diario de créditos alcanzado";
    message = `Tope diario alcanzado: ${credits}/${creditLimit} créditos en las últimas 24 h. Vuelve a intentarlo más tarde.`;
  } else if (routes >= routeLimit) {
    cause = "routes_limit";
    short = "tope diario de consultas de ruta alcanzado";
    message = `Tope diario alcanzado: ${routes}/${routeLimit} consultas de ruta en las últimas 24 h. Vuelve a intentarlo más tarde.`;
  }
  const canCalculate = cause === null;
  const lines = [];
  if (canCalculate) message = "Piloto disponible.";
  if (state.stopped && state.enabled && verificationExpired) {
    lines.push(verifiedAt ? `Además, la verificación de consumo caducó (última: ${verifiedAt}).`
      : "Además, el consumo de Geoapify está sin verificar.");
  }
  const named = pilotErrorNames[state.lastError];
  if (named && !["provider_limited", "route_estimate_exceeded"].includes(cause)) {
    lines.push(`Último error: ${named}${at}.`);
  }
  lines.push(canCalculate
    ? `Quedan ${creditLimit - credits} créditos internos y ${Math.max(0, routeLimit - routes)} consultas de ruta (últimas 24 h: ${credits}/${creditLimit} créditos, ${routes}/${routeLimit} consultas).`
    : `Consumo de las últimas 24 h: ${credits}/${creditLimit} créditos, ${routes}/${routeLimit} consultas de ruta.`);
  return { canCalculate, canStop: Boolean(state.enabled) && !state.stopped, cause, short, message, lines };
}

export const stopConfirmation = "Desactivar el piloto detiene el cálculo de desplazamientos para todos los técnicos y solo el administrador puede reactivarlo. ¿Quieres continuar?";
