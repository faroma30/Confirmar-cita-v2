const VIEWS = new Set(["appointments", "summary", "routes", "technicians", "create"]);
const PREFIX = "confirmar-citas-v2-master-navigation:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeState(value) {
  const dayOffset = [-1, 0, 1].includes(value?.dayOffset) ? value.dayOffset : 1;
  return {
    view: VIEWS.has(value?.view) ? value.view : "appointments",
    technicianId: typeof value?.technicianId === "string" && UUID.test(value.technicianId)
      ? value.technicianId : "",
    dayOffset,
  };
}

/** Stores only non-sensitive Master navigation state, isolated by Supabase user id. */
export function createMasterNavigationStorage(storage) {
  const key = (userId) => `${PREFIX}${userId}`;
  return {
    read(userId) {
      if (!UUID.test(String(userId ?? ""))) return normalizeState({});
      try { return normalizeState(JSON.parse(storage.getItem(key(userId)) ?? "{}")); }
      catch { return normalizeState({}); }
    },
    save(userId, value) {
      if (!UUID.test(String(userId ?? ""))) return false;
      try { storage.setItem(key(userId), JSON.stringify(normalizeState(value))); return true; }
      catch { return false; }
    },
    clear(userId) {
      if (!UUID.test(String(userId ?? ""))) return;
      try { storage.removeItem(key(userId)); } catch { /* storage can be unavailable */ }
    },
  };
}


