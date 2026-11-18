import { bindRouteAutocomplete } from "./my-routes-autocomplete.mjs?v=3routes4";
import { arrivalAfter, buildLegs, combineActivities, estimateLeg, formatRouteLocation, mapsLink, mayArriveLate, recommendedDeparture, routeLocationFields, routeLocationKinds, validateRouteLocations } from "./my-routes.mjs?v=3routes4";

export function mountMyRoutes({ panel, agenda, getActor, getDate, loadActivities, provider = null, autocomplete = null, preferencesStore = null }) {
  const settings = preferencesStore;
  const find = id => panel.querySelector("#" + id);
  const tab = find("myRoutesTab");
  const agendaTab = find("myRoutesAgendaTab");
  const view = find("myRoutesView");
  const form = find("myRoutesSettings");
  const date = find("myRoutesDate");
  const content = find("myRoutesContent");
  const settingsPanel = find("myRoutesSettingsPanel");
  const openSettings = find("myRoutesOpenSettings");
  const back = find("myRoutesBack");
  const saveButton = find("myRoutesSave");
  const settingsNotice = find("myRoutesSettingsNotice");
  const locationFields = Object.fromEntries(routeLocationKinds.map(kind => [kind,
    Object.fromEntries(Object.keys(routeLocationFields).map(field => [field, find("myRoutes-" + kind + "-" + field)])),
  ]));
  const margin = find("myRoutesMargin");
  const notice = find("myRoutesNotice");
  const list = find("myRoutesList");
  let request = 0;
  let owner = null;
  let settingsRequest = 0;
  let saving = false;
  const queries = new Map();
  if (autocomplete) {
    for (const kind of routeLocationKinds) {
      queries.set(kind, bindRouteAutocomplete({
        fields: locationFields[kind],
        search: autocomplete,
        eligible: () => Boolean(technicianId() && !settingsPanel.hidden && !form.hidden && !saving),
        cancelOthers: () => {
          for (const [other, clear] of queries) if (other !== kind) clear();
        },
        document: panel.ownerDocument,
      }));
    }
  }


  function technicianId() {
    const actor = getActor();
    return actor?.role === "technician" ? actor.id : null;
  }
  function fillLocation(kind, location) {
    for (const [field, input] of Object.entries(locationFields[kind])) input.value = location?.[field] ?? "";
  }
  function resetSettings() {
    settingsRequest++;
    for (const clear of queries.values()) clear();
    saving = false;
    saveButton.disabled = false;
    back.disabled = false;
    content.hidden = false;
    settingsPanel.hidden = true;
    form.hidden = true;
    form.reset();
    for (const kind of routeLocationKinds) fillLocation(kind, null);
    settingsNotice.textContent = "";
  }
  function close() {
    request++;
    view.hidden = true;
    agenda.hidden = false;
    tab.setAttribute("aria-pressed", "false");
    agendaTab.setAttribute("aria-pressed", "true");
    tab.className = "button secondary"; agendaTab.className = "button primary";
    list.replaceChildren();
    notice.textContent = "";
    resetSettings();
    date.value = "";
  }
  function sync() {
    const id = technicianId();
    if (id !== owner || !id) {
      settings.clear();
      close();
      owner = id;
    }
    tab.parentElement.hidden = !id;
  }
  function add(parent, tag, content) {
    const node = panel.ownerDocument.createElement(tag);
    node.textContent = content;
    parent.append(node);
    return node;
  }
  function label(stop) {
    return [stop.type, stop.time].filter(Boolean).join(" · ");
  }
  async function refresh() {
    const run = ++request;
    const actorId = technicianId();
    const current = () => actorId && technicianId() === actorId && request === run && !view.hidden;
    list.replaceChildren();
    if (!current()) return;
    notice.textContent = "Cargando la ruta…";
    try {
      const preferences = await settings.read();
      if (!current()) return;
      const selectedDate = date.value;
      if (!selectedDate) { notice.textContent = "Selecciona una fecha."; return; }
      const { appointments, ignored } = await loadActivities(selectedDate);
      if (!current()) return;
      const activities = combineActivities(appointments, ignored, preferences);
      const legs = buildLegs(formatRouteLocation(preferences.home), activities);
      const batch = provider?.estimateJourney
        ? await provider.estimateJourney(legs, { date: selectedDate }) : null;
      const estimates = await Promise.all(legs.map((leg, index) => estimateLeg(leg,
        batch === null ? provider : { estimate: () => batch[index] }, { date: selectedDate })));
      if (!current()) return;
      notice.textContent = !activities.length ? "No hay actividades de desplazamiento para esta fecha."
        : !preferences.home ? "Añade tu domicilio para completar la ida y el regreso." : "";
      const departure = estimates[0] && recommendedDeparture(activities[0].time, estimates[0].durationSeconds, preferences.margin);
      if (departure) add(list, "p", "Salida recomendada: " + departure.time + (departure.dayOffset < 0 ? " (día anterior)" : ""));
      else if (activities.length) add(list, "p", "Hora de salida no disponible.");
      if (activities.some(activity => !activity.time)) add(list, "p", "Las actividades sin hora fiable aparecen al final.");
      for (const [index, leg] of legs.entries()) {
        const item = add(list, "article", "");
        item.className = "appointment-card";
        add(item, "h3", label(leg.from) + " → " + label(leg.to));
        if (leg.to.type !== "Casa" && leg.to.address) add(item, "p", leg.to.address);
        const estimate = estimates[index];
        add(item, "p", estimate
          ? Math.ceil(estimate.durationSeconds / 60) + " min · " + (estimate.distanceMeters / 1000).toLocaleString("es-ES") + " km"
          : "Tiempo no disponible · Distancia no disponible");
        if (!estimate && batch?.length === legs.length && leg.from.address && leg.to.address) {
          add(item, "p", "No se pudo verificar el tramo con precisión. Revisa el portal y el municipio.");
        }
        if (estimate) {
          add(item, "p", "Estimación sin tráfico en tiempo real · " + new Date(estimate.calculatedAt).toLocaleString("es-ES"));
          if (mayArriveLate(leg, estimate)) add(item, "p", "Posible retraso: el trayecto supera el tiempo entre actividades.");
          const arrival = index === 0
            ? departure && arrivalAfter(departure.time, estimate.durationSeconds)
            : arrivalAfter(leg.from.endTime, estimate.durationSeconds);
          const returnLeg = index === legs.length - 1;
          if (arrival) {
            const offset = arrival.dayOffset + (index === 0 ? departure.dayOffset : 0);
            const day = offset ? (offset < 0 ? " (día anterior)" : " (día siguiente)") : "";
            add(item, "p", (returnLeg ? "Llegada estimada a casa: " : "Llegada estimada: ") + arrival.time + day);
          } else {
            add(item, "p", index === 0
              ? "Llegada no disponible: falta la hora de la primera actividad."
              : "Llegada no disponible: falta la hora de fin de la actividad anterior.");
          }
        }
        const url = mapsLink(leg);
        if (!url) {
          add(item, "p", "Falta la dirección de uno o ambos puntos.");
          continue;
        }
        const link = add(item, "a", "Abrir tramo en Google Maps");
        link.className = "button secondary";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      if (batch !== null && estimates.some(Boolean)) {
        const credit = add(list, "p", "Datos de rutas: ");
        const link = add(credit, "a", "Geoapify");
        link.href = "https://www.geoapify.com/";
        credit.append(" · ");
        const osm = add(credit, "a", "© OpenStreetMap contributors");
        osm.href = "https://www.openstreetmap.org/copyright";
      }
      if (legs.length) add(list, "p", estimates.every(Boolean)
        ? "Conducción total: " + Math.ceil(estimates.reduce((total, leg) => total + leg.durationSeconds, 0) / 60) + " min"
        : "Conducción total no disponible.");
    } catch {
      if (current()) notice.textContent = "No se pudo cargar la ruta. Vuelve a intentarlo.";
    }
  }
  tab.addEventListener("click", () => {
    sync();
    if (!owner || !view.hidden) return;
    view.hidden = false;
    agenda.hidden = true;
    tab.setAttribute("aria-pressed", "true");
    agendaTab.setAttribute("aria-pressed", "false");
    tab.className = "button primary"; agendaTab.className = "button secondary";
    date.value = getDate();
    void refresh();
  });
  agendaTab.addEventListener("click", close);
  date.addEventListener("change", () => void refresh());
  function isCurrentSettings(actorId, run) {
    return actorId && technicianId() === actorId && run === settingsRequest && !view.hidden && !settingsPanel.hidden;
  }
  openSettings.addEventListener("click", async () => {
    const actorId = technicianId();
    if (!actorId || view.hidden || !settingsPanel.hidden) return;
    const run = ++settingsRequest;
    content.hidden = true;
    settingsPanel.hidden = false;
    form.hidden = true;
    settingsNotice.textContent = "Cargando ajustes…";
    back.focus();
    try {
      const prefs = await settings.read();
      if (!isCurrentSettings(actorId, run)) return;
      for (const kind of routeLocationKinds) fillLocation(kind, prefs[kind]);
      margin.value = prefs.margin;
      form.hidden = false;
      settingsNotice.textContent = "";
    } catch {
      if (isCurrentSettings(actorId, run)) settingsNotice.textContent = "No se pudieron cargar los ajustes. Vuelve a intentarlo.";
    }
  });
  function returnToRoute({ refreshRoute = false } = {}) {
    resetSettings();
    openSettings.focus();
    if (refreshRoute) void refresh();
  }
  back.addEventListener("click", () => returnToRoute());
  for (const kind of routeLocationKinds) {
    find("myRoutesClear-" + kind).addEventListener("click", () => {
      if (saving) return;
      queries.get(kind)?.();
      fillLocation(kind, null);
      settingsNotice.textContent = "Guarda los cambios para eliminar esta ubicación.";
    });
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const actorId = technicianId();
    const run = settingsRequest;
    if (saving || form.hidden || !isCurrentSettings(actorId, run)) return;
    const data = { margin: margin.valueAsNumber };
    for (const [kind, fields] of Object.entries(locationFields)) {
      const location = Object.fromEntries(Object.entries(fields).map(([field, input]) => [field, input.value.trim()]));
      data[kind] = Object.values(location).some(Boolean) ? location : null;
    }
    let prefs;
    try { prefs = validateRouteLocations(data); }
    catch (error) { settingsNotice.textContent = error.message; return; }
    for (const clear of queries.values()) clear();
    saving = true;
    saveButton.disabled = true;
    back.disabled = true;
    settingsNotice.textContent = "Guardando ajustes…";
    try {
      await settings.write(prefs);
      if (isCurrentSettings(actorId, run)) returnToRoute({ refreshRoute: true });
    } catch {
      if (isCurrentSettings(actorId, run)) settingsNotice.textContent = "No se pudieron guardar los ajustes. Vuelve a intentarlo.";
    } finally {
      if (isCurrentSettings(actorId, run)) {
        saving = false;
        saveButton.disabled = false;
        back.disabled = false;
      }
    }
  });
  return { sync, reset() { settings.clear(); owner = null; close(); tab.parentElement.hidden = true; } };
}
