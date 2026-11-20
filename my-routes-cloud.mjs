export async function routeFingerprint(legs) {
  const addresses = [legs[0].from.address, ...legs.map(leg => leg.to.address)];
  const bytes = new TextEncoder().encode(JSON.stringify(addresses));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

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
      if (!actor?.id || actor.role !== "technician") return null;
      try {
        const { data, error } = await invoke("my-routes-estimate", {
          body: { operation, expectedActor: actor.id },
        });
        if (getActor()?.id !== actor.id || error || !data) return null;
        if (operation === "stop") clear();
        return data;
      } catch { return null; }
    },
    async estimateJourney(legs, { date, edits = [], cachedOnly = false }) {
      if (!legs.length || !legs.some(leg => leg.from.address && leg.to.address)) return [];
      const actor = getActor();
      if (!actor?.id || actor.role !== "technician") return [];
      const fingerprint = await routeFingerprint(legs);
      if (getActor()?.id !== actor.id || getActor()?.role !== "technician") return [];
      if (owner !== actor.id) { clear(); owner = actor.id; }
      const generation = revision;
      const key = JSON.stringify([actor.id, date, fingerprint, edits]);
      const cached = cache.get(key);
      if (cached?.until > Date.now()) return cached.estimates;
      cache.delete(key);
      if (cachedOnly) return [];
      if (pending.has(key)) return pending.get(key);
      const task = (async () => {
        try {
          const { data, error } = await invoke("my-routes-estimate", {
            body: { date, fingerprint, expectedActor: actor.id, ...(edits.length ? { edits } : {}) },
          });
          if (error || !Array.isArray(data?.estimates) || data.estimates.length !== legs.length
            || getActor()?.id !== actor.id || getActor()?.role !== "technician" || generation !== revision) return [];
          if (data.estimates.some(Boolean)) {
            if (cache.size >= 8) cache.delete(cache.keys().next().value);
            cache.set(key, { estimates: data.estimates, until: Date.now() + 300_000 });
          }
          return data.estimates;
        } catch { return []; }
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
