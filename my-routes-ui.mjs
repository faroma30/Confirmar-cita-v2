import { arrivalAfter, buildLegs, combineActivities, createRoutePreferences, estimateLeg, mapsLink, mayArriveLate, recommendedDeparture } from "./my-routes.mjs";

export function mountMyRoutes({ panel, agenda, getActor, getDate, loadActivities, provider = null, preferencesStore = null }) {
  const settings = preferencesStore ?? createRoutePreferences(getActor);
  const find = id => panel.querySelector("#" + id);
  const tab = find("myRoutesTab");
  const agendaTab = find("myRoutesAgendaTab");
  const view = find("myRoutesView");
  const form = find("myRoutesSettings");
  const date = find("myRoutesDate");
  const home = find("myRoutesHome");
  const margin = find("myRoutesMargin");
  const notice = find("myRoutesNotice");
  const list = find("myRoutesList");
  let request = 0;
  let owner = null;
  let savedMargin = 10;

  function technicianId() {
    const actor = getActor();
    return actor?.role === "technician" ? actor.id : null;
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
    form.reset();
    savedMargin = 10;
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
  async function refresh({ fill = false } = {}) {
    const run = ++request;
    const actorId = technicianId();
    const current = () => actorId && technicianId() === actorId && request === run && !view.hidden;
    list.replaceChildren();
    if (!current()) return;
    notice.textContent = "Cargando la ruta…";
    try {
      const preferences = await settings.read();
      if (!current()) return;
      savedMargin = preferences.margin;
      if (fill) { home.value = preferences.home; margin.value = preferences.margin; }
      const selectedDate = date.value;
      if (!selectedDate) { notice.textContent = "Selecciona una fecha."; return; }
      const { appointments, ignored } = await loadActivities(selectedDate);
      if (!current()) return;
      const activities = combineActivities(appointments, ignored);
      const legs = buildLegs(preferences.home, activities);
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
    void refresh({ fill: true });
  });
  agendaTab.addEventListener("click", close);
  date.addEventListener("change", () => void refresh());
  async function save(values) {
    const actorId = technicianId();
    try {
      await settings.write(values);
      if (actorId === technicianId() && !view.hidden) await refresh({ fill: true });
    } catch {
      if (actorId === technicianId() && !view.hidden) notice.textContent = "No se pudo guardar la configuración.";
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    void save({ home: home.value, margin: margin.valueAsNumber });
  });
  find("myRoutesRemoveHome").addEventListener("click", () => void save({ home: "", margin: savedMargin }));
  return { sync, reset() { settings.clear(); owner = null; close(); tab.parentElement.hidden = true; } };
}
