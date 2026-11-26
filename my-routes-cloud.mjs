export async function routeFingerprint(legs) {
  const addresses = [legs[0].from.address, ...legs.map(leg => leg.to.address)];
  const bytes = new TextEncoder().encode(JSON.stringify(addresses));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

// Códigos estables de motivo por tramo que devuelve my-routes-estimate desde CONFIRMAR_CITAS-017.
export const legDetails = new Set(["privacy", "incomplete", "missing_number", "street_not_found", "portal_not_found",
  "ambiguous", "other_end", "other_end_incomplete", "pilot_limit", "no_route"]);
// Códigos de detalle de la dirección que bloquea el tramo (CONFIRMAR_CITAS-018; campo opcional `diagnostics`).
export const addressDiagnostics = new Set(["no_results", "street_mismatch", "municipality_mismatch", "postcode_mismatch",
  "number_mismatch", "ambiguous", "missing_number", "missing_street"]);

export function createCloudRoutes({ invoke, getActor }) {
  const pending = new Map();
  const cache = new Map();
  let owner;
  let revision = 0;
  function clear() { revision++; pending.clear(); cache.clear(); }
  return {
    manual: true,
    clear,
    async pilot(operation = "status") {
      if (!["status", "stop"].includes(operation)) return null;
      const actor = getActor();
      // CONFIRMAR_CITAS-007: "stop" solo lo pide el Administrador (el servidor responde 403 a los demás).
      if (!actor?.id || actor.role !== (operation === "stop" ? "admin" : "technician")) return null;
      try {
        const { data, error } = await invoke("my-routes-estimate", {
          body: { operation, expectedActor: actor.id },
        });
        if (getActor()?.id !== actor.id || error || !data) return null;
        if (operation === "stop") clear();
        return data;
      } catch { return null; }
    },
    async estimateJourney(legs, { date, edits = [], cachedOnly = false, useHome = false }) {
      if (!legs.length || !legs.some(leg => leg.from.address && leg.to.address)) return [];
      const actor = getActor();
      if (!actor?.id || actor.role !== "technician") return [];
      const fingerprint = await routeFingerprint(legs);
      if (getActor()?.id !== actor.id || getActor()?.role !== "technician") return [];
      if (owner !== actor.id) { clear(); owner = actor.id; }
      const generation = revision;
      const withHome = useHome === true;
      const key = JSON.stringify([actor.id, date, fingerprint, edits, withHome]);
      const cached = cache.get(key);
      if (cached?.until > Date.now()) return cached.estimates;
      cache.delete(key);
      if (cachedOnly) return [];
      if (pending.has(key)) return pending.get(key);
      const task = (async () => {
        try {
          const { data, error } = await invoke("my-routes-estimate", {
            // CONFIRMAR_CITAS-015: `useHome` solo viaja si el técnico activó «Usar mi domicilio».
            body: { date, fingerprint, expectedActor: actor.id, ...(edits.length ? { edits } : {}), ...(withHome ? { useHome: true } : {}) },
          });
          if (error) {
            const status = error.context?.status ?? error.status;
            const messages = {
              401: "La sesión ha caducado. Vuelve a iniciar sesión.",
              403: "Esta cuenta no tiene acceso al piloto.",
              409: "La agenda cambió. Actualiza Mis rutas e inténtalo de nuevo.",
              429: "Se alcanzó el límite de consultas o la cuota del piloto.",
              500: "El servidor no pudo completar el cálculo de rutas.",
              502: "El proveedor de rutas devolvió un error.",
              503: "El servicio de rutas o el piloto está temporalmente desactivado.",
            };
            let fault;
            try { fault = (await error.context?.clone?.().json())?.code; } catch { /* Safe generic fallback. */ }
            const providerMessage = {
              geocoding_timeout: "Geoapify tardó demasiado en buscar la dirección. No se calculó ningún desplazamiento.",
              geocoding_unavailable: "Geoapify no pudo buscar la dirección. No se calculó ningún desplazamiento.",
            }[fault];
            throw Object.assign(new Error(providerMessage ?? messages[status] ?? "No se pudo conectar con el servicio de rutas."), { code: "route_request" });
          }
          if (!Array.isArray(data?.estimates) || data.estimates.length !== legs.length
            || getActor()?.id !== actor.id || getActor()?.role !== "technician" || generation !== revision) return [];
          if (Array.isArray(data.reasons) && data.reasons.length === legs.length) {
            const allowed = new Set(["privacy", "incomplete", "not_found", "no_route"]);
            Object.defineProperty(data.estimates, "reasons", { value: data.reasons.map(reason => allowed.has(reason) ? reason : null) });
          }
          // CONFIRMAR_CITAS-017: motivo concreto por tramo (campo opcional; la función v10 no lo envía).
          if (Array.isArray(data.details) && data.details.length === legs.length) {
            Object.defineProperty(data.estimates, "details", {
              value: data.details.map((detail, index) => !data.estimates[index] && legDetails.has(detail) ? detail : null),
            });
          }
          // CONFIRMAR_CITAS-018: código de detalle por tramo (opcional; la función v11 no lo envía).
          if (Array.isArray(data.diagnostics) && data.diagnostics.length === legs.length) {
            Object.defineProperty(data.estimates, "diagnostics", {
              value: data.diagnostics.map((code, index) => !data.estimates[index] && addressDiagnostics.has(code) ? code : null),
            });
          }
          if (data.estimates.some(Boolean)) {
            if (cache.size >= 8) cache.delete(cache.keys().next().value);
            cache.set(key, { estimates: data.estimates, until: Date.now() + 300_000 });
          }
          return data.estimates;
        } catch (error) {
          if (error?.code === "route_request") throw error;
          throw Object.assign(new Error("No se pudo conectar con el servicio de rutas."), { code: "route_request" });
        }
      })();
      pending.set(key, task);
      try { return await task; }
      finally { if (pending.get(key) === task) pending.delete(key); }
    },
  };
}


export function createCloudRouteAutocomplete({ invoke, getActor }) {
  return async (query, signal, kind) => {
    const actor = getActor();
    if (signal.aborted || !actor?.id || actor.role !== "technician") return [];
    const { data, error } = await invoke("my-routes-estimate", {
      body: { operation: "autocomplete", query, expectedActor: actor.id, kind }, signal,
    });
    const current = getActor();
    if (signal.aborted || current?.id !== actor.id || current.role !== "technician") return [];
    if (error || !Array.isArray(data?.suggestions)) throw new Error("No se pudieron cargar sugerencias.");
    return data.suggestions.slice(0, 5).filter(item =>
      typeof item?.street === "string" && item.street.trim() && item.street.length <= 200 &&
      typeof item.municipality === "string" && item.municipality.trim() && item.municipality.length <= 100 &&
      typeof item.postalCode === "string" && /^(?:[0-9]{5})?$/.test(item.postalCode) &&
      !/[\u0000-\u001f\u007f]/.test(item.street + item.municipality)
    ).map(({ street, municipality, postalCode, province, displayPostalCode }) => ({
      street, municipality, postalCode,
      ...(typeof province === "string" && province.length <= 100 && /^[\p{L}][\p{L} .\u2019\x27-]*$/u.test(province) ? { province } : {}),
      ...(typeof displayPostalCode === "string" && /^\d{5}$/.test(displayPostalCode) ? { displayPostalCode } : {}),
    }));
  };
}
