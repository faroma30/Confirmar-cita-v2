export async function routeFingerprint(legs) {
  const addresses = [legs[0].from.address, ...legs.map(leg => leg.to.address)];
  const bytes = new TextEncoder().encode(JSON.stringify(addresses));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

export function createCloudRoutes({ invoke, getActor }) {
  const pending = new Map();
  return {
    async estimateJourney(legs, { date }) {
      if (!legs.length || !legs.some(leg => leg.from.address && leg.to.address)) return [];
      const actor = getActor();
      if (!actor?.id || actor.role !== "technician") return [];
      const fingerprint = await routeFingerprint(legs);
      if (getActor()?.id !== actor.id || getActor()?.role !== "technician") return [];
      const key = JSON.stringify([actor.id, date, fingerprint]);
      if (pending.has(key)) return pending.get(key);
      const task = (async () => {
        try {
          const { data, error } = await invoke("my-routes-estimate", {
            body: { date, fingerprint, expectedActor: actor.id },
          });
          if (error || !Array.isArray(data?.estimates) || data.estimates.length !== legs.length
            || getActor()?.id !== actor.id || getActor()?.role !== "technician") return [];
          return data.estimates;
        } catch { return []; }
      })();
      pending.set(key, task);
      try { return await task; }
      finally { pending.delete(key); }
    },
  };
}
