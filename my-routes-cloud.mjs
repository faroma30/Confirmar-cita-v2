import { describeRouteBlock, waitSeconds } from "./my-routes-pilot.mjs?v=3routes24";

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
// Origen de cada dirección (CONFIRMAR_CITAS-020; campo opcional `sources`).
export const routeSources = new Set(["cartociudad", "geoapify"]);

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
    // CONFIRMAR_CITAS-026: `onWait(segundos)` avisa, tras un cálculo, de la espera hasta el siguiente.
    // CONFIRMAR_CITAS-031: `only` = índices de los tramos pedidos tras una corrección (opcional).
    async estimateJourney(legs, { date, edits = [], cachedOnly = false, useHome = false, onWait = null, only = null }) {
      if (!legs.length || !legs.some(leg => leg.from.address && leg.to.address)) return [];
      const actor = getActor();
      if (!actor?.id || actor.role !== "technician") return [];
      const fingerprint = await routeFingerprint(legs);
      if (getActor()?.id !== actor.id || getActor()?.role !== "technician") return [];
      if (owner !== actor.id) { clear(); owner = actor.id; }
      const generation = revision;
      const withHome = useHome === true;
      const key = JSON.stringify([actor.id, date, fingerprint, edits, withHome, ...(only ? [only] : [])]);
      const cached = cache.get(key);
      if (cached?.until > Date.now()) return cached.estimates;
      cache.delete(key);
      if (cachedOnly) return [];
      if (pending.has(key)) return pending.get(key);
      const task = (async () => {
        try {
          // CONFIRMAR_CITAS-022: con domicilio guardado `useHome: true` viaja siempre (la v13 lo necesita; la función nueva ya no).
          const body = { date, fingerprint, expectedActor: actor.id, ...(edits.length ? { edits } : {}), ...(withHome ? { useHome: true } : {}) };
          let { data, error } = await invoke("my-routes-estimate", { body: only ? { ...body, only } : body });
          // La función v18 y anteriores rechazan `only` (400, antes de reservar ni cobrar): se pide la ruta entera.
          if (only && error && (error.context?.status ?? error.status) === 400 && getActor()?.id === actor.id) {
            ({ data, error } = await invoke("my-routes-estimate", { body }));
          }
          if (error) {
            const status = error.context?.status ?? error.status;
            const messages = {
              401: "La sesión ha caducado. Vuelve a iniciar sesión.",
              403: "Esta cuenta no tiene acceso al piloto.",
              409: "La agenda cambió. Actualiza Mis rutas e inténtalo de nuevo.",
              500: "El servidor no pudo completar el cálculo de rutas.",
              502: "El proveedor de rutas devolvió un error.",
              503: "El servicio de rutas o el piloto está temporalmente desactivado.",
            };
            let body;
            try { body = await error.context?.clone?.().json(); } catch { /* Safe generic fallback. */ }
            const fault = body?.code;
            // CONFIRMAR_CITAS-026: cada causa de 429 tiene su texto; la v16 no envía código (texto genérico).
            if (status === 429) {
              const block = describeRouteBlock(body);
              throw Object.assign(new Error(block.message), { code: "route_request", block: block.code,
                retryAfterSeconds: block.retryAfterSeconds });
            }
            const providerMessage = {
              geocoding_timeout: "Geoapify tardó demasiado en buscar la dirección. No se calculó ningún desplazamiento.",
              geocoding_unavailable: "Geoapify no pudo buscar la dirección. No se calculó ningún desplazamiento.",
            }[fault];
            throw Object.assign(new Error(providerMessage ?? messages[status] ?? "No se pudo conectar con el servicio de rutas."), { code: "route_request", status });
          }
          const wait = waitSeconds(data?.retryAfterSeconds);
          if (wait && getActor()?.id === actor.id) onWait?.(wait);
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
          // CONFIRMAR_CITAS-020: tramo «aprox.» (calle sin ese portal en CartoCiudad) y origen por dirección
          // (campos opcionales; la función v12 no los envía).
          const approx = Array.isArray(data.approx) && data.approx.length === legs.length
            ? data.approx.map((value, index) => value === true && Boolean(data.estimates[index])) : null;
          if (approx) Object.defineProperty(data.estimates, "approx", { value: approx });
          if (Array.isArray(data.sources) && data.sources.length === legs.length + 1) {
            Object.defineProperty(data.estimates, "sources", {
              value: data.sources.map(source => routeSources.has(source) ? source : null),
            });
          }
          // CONFIRMAR_CITAS-022: calle oficial usada y sugerencias «¿Querías decir…?» por dirección (opcionales).
          const official = officialAddressData(data, legs.length + 1);
          if (official.officials) Object.defineProperty(data.estimates, "officials", { value: official.officials });
          if (official.suggestions) Object.defineProperty(data.estimates, "suggestions", { value: official.suggestions });
          // CONFIRMAR_CITAS-018: código de detalle por tramo (opcional; la función v11 no lo envía).
          // Desde el 020 también en los tramos «aprox.».
          if (Array.isArray(data.diagnostics) && data.diagnostics.length === legs.length) {
            Object.defineProperty(data.estimates, "diagnostics", {
              value: data.diagnostics.map((code, index) => (!data.estimates[index] || approx?.[index]) && addressDiagnostics.has(code) ? code : null),
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

// CONFIRMAR_CITAS-022: sugerencias del asistente de direcciones (modo `suggest` de my-routes-estimate:
// CartoCiudad desde el servidor, sin créditos del piloto ni Geoapify). Con la función v13 (sin este modo)
// la respuesta es un error y el asistente deja escribir a mano.
const suggestionText = /^[\p{L}\p{N}][\p{L}\p{N} .\u2019'ºª/-]*$/u;
const suggestionTown = /^[\p{L}][\p{L} .\u2019'-]*$/u;
export function createCloudAddressSuggest({ invoke, getActor }) {
  return async ({ query, municipality = "", postalCode = "" }, signal) => {
    const actor = getActor();
    if (signal?.aborted || !actor?.id || actor.role !== "technician") return [];
    const body = { operation: "suggest", query, expectedActor: actor.id,
      ...(municipality ? { municipality } : {}), ...(/^\d{5}$/.test(postalCode) ? { postalCode } : {}) };
    const { data, error } = await invoke("my-routes-estimate", { body, signal });
    const current = getActor();
    if (signal?.aborted || current?.id !== actor.id || current.role !== "technician") return [];
    if (error || !Array.isArray(data?.suggestions)) throw new Error("No se pudieron cargar sugerencias.");
    return data.suggestions.slice(0, 6).filter(item =>
      typeof item?.street === "string" && item.street.length <= 200 && suggestionText.test(item.street)
      && typeof item.municipality === "string" && item.municipality.length <= 100 && suggestionTown.test(item.municipality)
      && (item.number === undefined || (typeof item.number === "string" && item.number.length <= 30 && (!item.number || suggestionText.test(item.number))))
      && (item.postalCode === undefined || (typeof item.postalCode === "string" && /^(?:\d{5})?$/.test(item.postalCode)))
    ).map(item => {
      const province = typeof item.province === "string" && item.province.length <= 100 && suggestionTown.test(item.province) ? item.province : "";
      const number = item.number ?? "";
      const postal = item.postalCode ?? "";
      const label = [item.street + (number ? " " + number : ""),
        item.municipality + (province && province !== item.municipality ? " (" + province + ")" : "") + (postal ? " " + postal : "")].join(" · ");
      return { street: item.street, number, municipality: item.municipality, ...(province ? { province } : {}), postalCode: postal, label };
    });
  };
}

// CONFIRMAR_CITAS-022: calle oficial usada y sugerencias por dirección (campos opcionales; la v13 no los envía).
export function officialAddressData(data, length) {
  const officials = Array.isArray(data?.officials) && data.officials.length === length
    ? data.officials.map(name => typeof name === "string" && name.length <= 200 && suggestionText.test(name) ? name : null) : null;
  const valid = location => location && typeof location === "object" && typeof location.street === "string"
    && location.street.length <= 200 && suggestionText.test(location.street)
    && typeof location.municipality === "string" && location.municipality.length <= 100 && suggestionTown.test(location.municipality)
    && typeof location.number === "string" && location.number.length <= 30 && (!location.number || suggestionText.test(location.number))
    && typeof location.postalCode === "string" && /^(?:\d{5})?$/.test(location.postalCode)
    && (location.province === undefined || (typeof location.province === "string" && location.province.length <= 100 && suggestionTown.test(location.province)));
  const suggestions = Array.isArray(data?.suggestions) && data.suggestions.length === length
    ? data.suggestions.map(list => Array.isArray(list) ? list.filter(valid).slice(0, 5).map(location => ({
      street: location.street, number: location.number, municipality: location.municipality, postalCode: location.postalCode,
      ...(location.province ? { province: location.province } : {}),
    })) : []).map(list => list.length ? list : null) : null;
  return { officials, suggestions };
}
