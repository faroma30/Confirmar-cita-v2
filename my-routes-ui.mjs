import { bindRouteAutocomplete } from "./my-routes-autocomplete.mjs?v=3routes16";
import { arrivalAfter, buildLegs, combineActivities, dayFreeTime, estimateLeg, formatMinutes, formatRouteLocation, freeTimeBetween, legSlack, mapsLink, mayArriveLate, recommendedDeparture, routeLocationFields, routeLocationKinds, sendableRouteLocation, validateRouteLocation, validateRouteLocations } from "./my-routes.mjs?v=3routes16";
import { canOfferPilotStop, describePilot, madridClock, stopConfirmation } from "./my-routes-pilot.mjs?v=3routes16";

export function mountMyRoutes({ panel, agenda, getActor, getDate, loadActivities, provider = null, autocomplete = null, preferencesStore = null, homeConsent = null, now = () => new Date(), confirmAction = null }) {
  const settings = preferencesStore;
  const find = id => panel.querySelector("#" + id);
  // CONFIRMAR_CITAS-015: «Usar mi domicilio…», desactivada por defecto y guardada en este dispositivo.
  const useHomeInput = find("myRoutesUseHome");
  const tab = find("myRoutesTab");
  const agendaTab = find("myRoutesAgendaTab");
  const view = find("myRoutesView");
  const form = find("myRoutesSettings");
  const date = find("myRoutesDate");
  const content = find("myRoutesContent");
  const settingsPanel = find("myRoutesSettingsPanel");
  const openSettings = find("myRoutesOpenSettings");
  const pilotControls = find("myRoutesPilotControls");
  const calculateButton = find("myRoutesCalculate");
  const pilotNotice = find("myRoutesPilotNotice");
  const calcNotice = find("myRoutesCalculationNotice");
  const calculateReason = find("myRoutesCalculateReason");
  const statusButton = find("myRoutesPilotStatus");
  const stopButton = find("myRoutesPilotStop");
  if (pilotControls) pilotControls.hidden = true;
  let pilotAction = 0;
  let pilotBusy = false;
  let stopped = false;
  let pilot = null;
  let renderedStopped = false;
  function setPilotLoading(loading) {
    if (statusButton) {
      statusButton.disabled = loading;
      statusButton.setAttribute("aria-busy", loading ? "true" : "false");
      statusButton.textContent = loading ? "Consultando…" : "Consultar consumo";
    }
    if (stopButton && loading) stopButton.disabled = true;
    if (stopButton && !loading) stopButton.disabled = false;
  }
  function showCalculateReason() {
    if (!calculateReason) return;
    calculateReason.textContent = stopped && pilot ? "No se puede calcular: " + pilot.short + "." : "";
    calculateReason.hidden = !calculateReason.textContent;
  }
  function resetPilot() {
    pilotAction++;
    stopped = false;
    pilot = null;
    renderedStopped = false;
    setPilotLoading(false);
    if (calculateButton) calculateButton.disabled = false;
    if (stopButton) stopButton.hidden = true;
    if (pilotNotice) pilotNotice.textContent = "";
    if (calcNotice) calcNotice.textContent = "";
    showCalculateReason();
    if (pilotControls) pilotControls.hidden = true;
  }
  async function updatePilot(operation) {
    const actor = technicianId();
    const action = ++pilotAction;
    if (!actor || !provider?.pilot || !pilotNotice) return;
    setPilotLoading(true);
    pilotNotice.textContent = operation === "stop" ? "Desactivando el piloto…" : "Consultando el estado del piloto…";
    let state = null;
    try { state = await provider.pilot(operation); } catch { state = null; }
    if (actor !== technicianId() || action !== pilotAction) return;
    setPilotLoading(false);
    const updated = madridClock(now());
    const stamp = updated ? ` Actualizado a las ${updated}.` : "";
    const described = describePilot(state, now());
    if (!described) {
      pilotNotice.textContent = "No se pudo comprobar el estado del piloto. Vuelve a intentarlo." + stamp;
      return;
    }
    pilot = described;
    if (pilotControls) pilotControls.hidden = false;
    stopped = !pilot.canCalculate;
    calculateButton.disabled = stopped || pilotBusy;
    showCalculateReason();
    // «Desactivar piloto» solo para el Administrador y solo si tiene efecto (CONFIRMAR_CITAS-007).
    if (stopButton) stopButton.hidden = !canOfferPilotStop(getActor(), pilot);
    pilotNotice.textContent = [pilot.message, ...pilot.lines,
      "El contador interno puede diferir del consumo de Geoapify."].join(" ") + stamp;
    if (operation === "stop" || (!view.hidden && stopped !== renderedStopped)) void refresh();
  }
  calculateButton?.addEventListener("click", async () => {
    if (!provider?.manual || stopped || pilotBusy) return;
    pilotBusy = true;
    if (calcNotice) calcNotice.textContent = "Calculando desplazamientos…";
    calculateButton.disabled = true;
    try { await refresh(true); }
    finally { pilotBusy = false; calculateButton.disabled = stopped; }
    await updatePilot("status");
  });
  statusButton?.addEventListener("click", () => void updatePilot("status"));
  stopButton?.addEventListener("click", () => {
    if (!canOfferPilotStop(getActor(), pilot)) return;
    if (confirmAction && !confirmAction(stopConfirmation)) return;
    void updatePilot("stop");
  });
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
  const activityEdits = new Map();
  const queries = new Map();
  if (autocomplete) {
    for (const kind of routeLocationKinds) {
      queries.set(kind, bindRouteAutocomplete({
        fields: locationFields[kind],
        search: (query, signal) => autocomplete(query, signal, kind),
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
      activityEdits.clear();
      provider?.clear?.();
      resetPilot();
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
  // CONFIRMAR_CITAS-016: una actividad «Desplazamiento» sin destino no se calcula ni gasta créditos.
  const noDestinationText = "Actividad de desplazamiento sin destino: no se calcula.";
  function label(stop) {
    return [stop.type, stop.time].filter(Boolean).join(" · ");
  }
  function editActivity(card, activity, save, failed = false) {
    const details = add(card, "details", "");
    details.className = "subpanel";
    // CONFIRMAR_CITAS-017: si Geoapify no encontró la dirección, también se puede corregir la de una instalación.
    add(details, "summary", activity.editableTravel || failed ? "Editar desplazamiento" : "Completar dirección");
    const form = add(details, "form", "");
    form.className = "dialog-form";
    let kind;
    if (activity.editableTravel) {
      const label = add(form, "label", "¿Requiere desplazamiento?");
      kind = add(label, "select", "");
      for (const [value, title] of [["", "Selecciona una opción"], ["travel", "Sí, con desplazamiento"], ["pause", "No, es una pausa"]]) {
        const option = add(kind, "option", title);
        option.value = value;
      }
      kind.value = activity.travel === "undecided" ? "" : activity.travel;
    }
    const group = add(form, "div", "");
    const fields = {};
    for (const [key, title] of [
      ["street", "Calle o vía"], ["number", "Portal (opcional)"], ["municipality", "Municipio"], ["postalCode", "Código postal (opcional)"],
    ]) {
      const label = add(group, "label", title);
      const input = add(label, "input", "");
      input.type = "text";
      input.maxLength = routeLocationFields[key];
      input.autocomplete = "off";
      if (key === "postalCode") input.inputMode = "numeric";
      input.value = activity.override?.location?.[key] ?? "";
      fields[key] = input;
    }
    if (activity.agendaAddress) add(group, "p", "Deja los campos vacíos para usar la ubicación de la agenda.");
    const updateFields = () => { group.hidden = kind?.value === "pause"; };
    kind?.addEventListener("change", updateFields);
    updateFields();

    const status = add(form, "p", "");
    status.setAttribute("role", "status");
    const button = add(form, "button", "Guardar para esta sesión");
    button.type = "submit";
    button.className = "button primary";
    if (activity.override) {
      const reset = add(form, "button", "Restaurar datos de la agenda");
      reset.type = "button";
      reset.className = "button secondary";
      reset.addEventListener("click", () => save(null));
    }
    form.addEventListener("submit", event => {
      event.preventDefault();
      const travel = kind?.value ?? "travel";
      if (!travel) { status.textContent = "Indica si esta actividad requiere desplazamiento."; return; }
      let location = null;
      if (travel === "travel") {
        const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()]));
        if (Object.values(values).some(Boolean)) {
          try { location = validateRouteLocation(values); }
          catch (error) { status.textContent = error.message; return; }
          if (!sendableRouteLocation(location)) {
            status.textContent = "Usa solo letras, números, espacios y . ' º ª / - en la calle y el portal, y solo letras en el municipio y la provincia.";
            return;
          }
        }
      }
      save(travel === activity.defaultTravel && !location ? null : { travel, location });
    });
  }

  async function refresh(explicit = false) {
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
      const edits = activityEdits.get(selectedDate) ?? new Map();
      const activities = combineActivities(appointments, ignored, preferences, edits);
      const legs = buildLegs(formatRouteLocation(preferences.home), activities);
      // Submit the agenda with the technician's edits. CONFIRMAR_CITAS-017: an address corrected in
      // «Editar desplazamiento» is sent too (same rules as the server), so the leg is recalculated with it.
      // Results are matched to displayed stops; no result is applied to a different leg.
      const safeEdits = [...edits].filter(([, edit]) => edit.location === null || sendableRouteLocation(edit.location));
      const canonical = buildLegs(formatRouteLocation(preferences.home),
        combineActivities(appointments, ignored, preferences, new Map(safeEdits)));
      const key = leg => JSON.stringify([leg.from.key, leg.to.key, leg.from.address, leg.to.address]);
      const positions = new Map(canonical.map((leg, index) => [key(leg), index]));
      const eligible = leg => leg.from.key && leg.to.key && leg.from.address && leg.to.address;
      const canEstimate = !provider?.manual || legs.some(leg => eligible(leg) && positions.has(key(leg)));
      const estimatesProvider = provider;
      // The home only takes part when it is saved and the technician turned the option on.
      const useHome = Boolean(preferences.home) && homeConsent?.read() === true;
      const batch = estimatesProvider?.estimateJourney && canEstimate
        ? await estimatesProvider.estimateJourney(canonical, { date: selectedDate, edits: safeEdits, ...(estimatesProvider.manual ? { cachedOnly: !explicit } : {}), ...(useHome ? { useHome: true } : {}) }) : null;
      const estimates = await Promise.all(legs.map(leg => estimateLeg(leg,
        estimatesProvider?.estimateJourney ? { estimate: () => batch?.[positions.get(key(leg))] } : estimatesProvider,
        { date: selectedDate })));
      if (!current()) return;
      renderedStopped = stopped;
      const computed = Array.isArray(batch) && batch.length > 0;
      const reasonText = {
        privacy: "tramo excluido por privacidad",
        incomplete: "la dirección no contiene una vía, portal y municipio utilizables",
        not_found: "Geoapify no encontró una coincidencia única para la dirección",
        no_route: "Geoapify no devolvió una ruta utilizable",
      };
      // Why a leg has no time or distance, in the technician's words.
      function whyUnavailable(leg) {
        const detail = detailText[detailOf(leg)];
        if (detail) return (/^Geoapify/.test(detail) ? detail : detail.charAt(0).toLowerCase() + detail.slice(1)).replace(/\.$/, "");
        const reason = reasonText[batch?.reasons?.[positions.get(key(leg))]];
        if (reason) return reason;
        if (estimatesProvider?.manual && stopped && pilot) return "el cálculo está detenido (" + pilot.short + ")";
        if (estimatesProvider?.manual && !canEstimate) return "se necesitan dos actividades consecutivas con dirección completa";
        if (estimatesProvider?.manual && !computed) return "aún no se han calculado; pulsa «Calcular desplazamientos»";
        return "la consulta no devolvió este tramo";
      }
      notice.textContent = !activities.length ? "No hay actividades para esta fecha."
        : legs.length && !preferences.home ? "Añade tu domicilio para completar la ida y el regreso." : "";
      if (!provider) add(list, "p", "Los tiempos de conducción están desactivados. Puedes abrir en Google Maps los tramos con ubicación completa.");

      // CONFIRMAR_CITAS-017: motivo concreto por tramo (`details`); con la función v10 se usan los `reasons` de siempre.
      const detailText = {
        privacy: "Tramo excluido por privacidad.",
        incomplete: "La dirección no tiene calle, portal y municipio utilizables.",
        missing_number: "Falta el número del portal.",
        street_not_found: "Geoapify no encuentra esta calle en ese municipio.",
        portal_not_found: "Geoapify encuentra la calle, pero no este número de portal.",
        ambiguous: "Hay varios sitios posibles con esta dirección.",
        other_end: "La otra dirección del tramo no se encontró.",
        other_end_incomplete: "A la otra dirección del tramo le falta calle, portal o municipio.",
        pilot_limit: "Tope diario del piloto alcanzado.",
        no_route: "Geoapify no devolvió una ruta utilizable para este tramo.",
      };
      // Which stop has to be corrected: the destination of the leg, or its origin ("other_end").
      const ownAddress = new Set(["incomplete", "missing_number", "street_not_found", "portal_not_found", "ambiguous"]);
      const otherAddress = new Set(["other_end", "other_end_incomplete"]);
      const detailOf = leg => batch?.details?.[positions.get(key(leg))] ?? null;
      // CONFIRMAR_CITAS-018: código de detalle de la dirección (campo opcional `diagnostics`) y dirección «S/N».
      const diagnosticOf = leg => batch?.diagnostics?.[positions.get(key(leg))] ?? null;
      const withoutNumber = address => /(?:^|[\s,])s\s*[/.]\s*n\.?(?=$|[\s,])/iu.test(address || "");
      const failedKeys = new Set();
      for (const [index, leg] of legs.entries()) {
        const detail = estimates[index] ? null : detailOf(leg);
        if (ownAddress.has(detail) && leg.to.key && leg.to.address) failedKeys.add(leg.to.key);
        if (otherAddress.has(detail) && leg.from.key && leg.from.address) failedKeys.add(leg.from.key);
      }
      const done = estimates.filter(Boolean).length;
      if (explicit && calcNotice) calcNotice.textContent = !canEstimate
        ? "No se envió la consulta. Se necesitan dos actividades consecutivas de Oracle con dirección completa."
        : done === legs.length
          ? "Desplazamientos calculados. Consulta los minutos y kilómetros de cada tramo."
          : done
            ? `Desplazamientos calculados en ${done} de ${legs.length} tramos. El motivo de los demás está junto a cada tramo.`
            : "La consulta no devolvió tramos válidos. Consulta el motivo junto a cada tramo.";
      if (activities.some(item => item.editableTravel || (item.travel === "travel" && !item.address))) {
        add(list, "p", "Los cambios de las actividades duran hasta cerrar sesión o recargar la aplicación.");
      }
      const departure = activities[0] === legs[0]?.to && estimates[0]
        && recommendedDeparture(legs[0].to.time, estimates[0].durationSeconds, preferences.margin);
      if (departure) add(list, "p", "Salida recomendada: " + departure.time + (departure.dayOffset < 0 ? " (día anterior)" : ""));
      else if (estimatesProvider && legs.length) {
        const first = legs[0];
        const why = batch?.reasons?.[0] === "privacy" ? "el domicilio queda fuera del piloto"
          : !preferences.home ? "añade tu domicilio en Ajustes"
          : activities[0] !== first.to ? "la jornada no empieza con un desplazamiento desde casa"
          : !first.to.time ? "la primera actividad no tiene hora"
          : "falta el primer tramo: " + whyUnavailable(first);
        add(list, "p", "Hora de salida no disponible: " + why + ".");
      }
      if (activities.some(activity => !activity.time)) add(list, "p", "Las actividades sin hora fiable aparecen al final.");

      function renderLeg(item, index) {
        const leg = legs[index];
        const url = mapsLink(leg);
        if (!url) {
          const missing = [leg.from, leg.to].filter(stop => !stop.address)
            .map(stop => stop.time ? `${stop.type} (${stop.time})` : stop.type);
          if (leg.to.noDestination || leg.from.noDestination) {
            add(item, "p", "Tramo pendiente. " + noDestinationText);
            return;
          }
          add(item, "p", missing.length ? `Tramo pendiente: revisa ${missing.join(" y ")}.`
            : "Tramo pendiente: revisa la decisión de desplazamiento.");
          return;
        }
        add(item, "p", label(leg.from) + " → " + label(leg.to));
        const estimate = estimates[index];
        if (estimate) {
          add(item, "p", Math.ceil(estimate.durationSeconds / 60) + " min · "
            + (estimate.distanceMeters / 1000).toLocaleString("es-ES") + " km");
          add(item, "p", "Estimación sin tráfico en tiempo real · " + new Date(estimate.calculatedAt).toLocaleString("es-ES"));
          if (mayArriveLate(leg, estimate)) add(item, "p", "Posible retraso: el trayecto supera el tiempo entre actividades.");
          const slack = legSlack(leg, estimate);
          if (slack?.reason === "no_end") add(item, "p", "Sin hora de fin: no se puede calcular si llegas a tiempo.");
          else if (slack && slack.reason === null) add(item, "p", slack.late
            ? `Llegarías ${slack.minutes} min tarde (tiempo libre menos desplazamiento).`
            : `Te sobran ${slack.minutes} min (tiempo libre menos desplazamiento).`);
          const arrival = index === 0
            ? departure && arrivalAfter(departure.time, estimate.durationSeconds)
            : arrivalAfter(leg.from.endTime, estimate.durationSeconds);
          if (arrival) {
            const offset = arrival.dayOffset + (index === 0 ? departure.dayOffset : 0);
            const day = offset ? (offset < 0 ? " (día anterior)" : " (día siguiente)") : "";
            add(item, "p", (index === legs.length - 1 ? "Llegada estimada a casa: " : "Llegada estimada: ") + arrival.time + day);
          } else {
            add(item, "p", "Llegada estimada no disponible.");
          }
        } else if (estimatesProvider) {
          const reason = batch?.reasons?.[positions.get(key(leg))];
          const detail = detailOf(leg);
          const explanation = detailText[detail] ?? {
            privacy: "Tramo excluido por privacidad.",
            incomplete: "La dirección no contiene una vía, portal y municipio utilizables.",
            not_found: "Geoapify no encontró una coincidencia única para la dirección.",
            no_route: "Geoapify no devolvió una ruta utilizable para este tramo.",
          }[reason];
          if (explanation) {
            add(item, "p", "Tiempo y distancia no disponibles.");
            const noNumber = detail === "missing_number" && withoutNumber(leg.to.address);
            add(item, "p", "Motivo: " + (noNumber ? "Dirección sin número: corrígela en «Editar desplazamiento»." : explanation));
            const diagnostic = diagnosticOf(leg);
            if (diagnostic) add(item, "p", "detalle: " + diagnostic).className = "fine";
            if (noNumber) {
              // El motivo ya dice dónde corregirla.
            } else if (ownAddress.has(detail) && failedKeys.has(leg.to.key)) {
              add(item, "p", "Corrígela en «Editar desplazamiento» de esta actividad y vuelve a calcular.");
            } else if (otherAddress.has(detail) && failedKeys.has(leg.from.key)) {
              add(item, "p", "Corrígela en «Editar desplazamiento» de " + label(leg.from) + " y vuelve a calcular.");
            }
          } else add(item, "p", "Tiempo y distancia no disponibles: " + whyUnavailable(leg) + ".");
        }
        const link = add(item, "a", "Abrir tramo en Google Maps");
        link.className = "button secondary";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }

      let legIndex = 0;
      for (const [index, activity] of activities.entries()) {
        const card = add(list, "article", "");
        card.className = "appointment-card";
        add(card, "h3", label(activity));
        if (index > 0) {
          const previous = activities[index - 1];
          const gap = freeTimeBetween(previous, activity);
          add(card, "p", gap.reason === "no_end"
            ? `Sin hora de fin: no se puede calcular el tiempo libre (falta el fin de ${label(previous)}).`
            : gap.reason === "no_start" ? "Sin hora de inicio: no se puede calcular el tiempo libre."
            : gap.minutes >= 0 ? `Tiempo libre: ${formatMinutes(gap.minutes)} desde el fin de ${label(previous)}.`
            : `Tiempo libre: 0 min. Se solapa ${formatMinutes(-gap.minutes)} con ${label(previous)}.`);
        }
        if (activity.travel === "pause") add(card, "p", "Pausa sin desplazamiento");
        else {
          if (activity.travel === "undecided") add(card, "p", "Pendiente de decidir si requiere desplazamiento");
          else if (activity.noDestination) add(card, "p", noDestinationText);
          else if (activity.address) {
            add(card, "p", "Con desplazamiento");
            add(card, "p", activity.address);
          } else add(card, "p", "Con desplazamiento · Falta dirección");
          renderLeg(card, legIndex++);
        }
        const failed = failedKeys.has(activity.key);
        if (activity.editableTravel || !activity.address || activity.override || failed) {
          editActivity(card, activity, change => {
            if (!current() || date.value !== selectedDate) return;
            if (change) {
              edits.set(activity.key, change);
              activityEdits.set(selectedDate, edits);
            } else {
              edits.delete(activity.key);
              if (!edits.size) activityEdits.delete(selectedDate);
            }
            void refresh();
          }, failed);
        }
      }
      if (legs.length) {
        const card = add(list, "article", "");
        card.className = "appointment-card";
        add(card, "h3", "Regreso a casa");
        renderLeg(card, legs.length - 1);
      }
      if (batch !== null && estimates.some(Boolean)) {
        const credit = add(list, "p", "Datos de rutas: ");
        const link = add(credit, "a", "Geoapify");
        link.href = "https://www.geoapify.com/";
        credit.append(" · ");
        const osm = add(credit, "a", "© OpenStreetMap contributors");
        osm.href = "https://www.openstreetmap.org/copyright";
      }
      if (estimatesProvider && legs.length) {
        const available = estimates.filter(Boolean);
        if (available.length) {
          const seconds = available.reduce((total, leg) => total + leg.durationSeconds, 0);
          const meters = available.reduce((total, leg) => total + leg.distanceMeters, 0);
          const partial = available.length !== legs.length;
          // CONFIRMAR_CITAS-017: los totales suman solo los tramos calculados.
          add(list, "p", (partial ? "Conducción total (" + available.length + " de " + legs.length + " tramos): " : "Conducción total: ")
            + Math.ceil(seconds / 60) + " min · " + (meters / 1000).toLocaleString("es-ES") + " km");
        } else {
          add(list, "p", "Conducción total no disponible.");
        }
      }
      const day = dayFreeTime(activities);
      if (day.pairs) add(list, "p", day.counted
        ? "Tiempo libre total: " + formatMinutes(day.minutes)
          + (day.counted < day.pairs ? ` (${day.counted} de ${day.pairs} huecos; al resto le faltan horas)` : "") + "."
        : "Tiempo libre total no disponible: faltan horas de fin en la agenda.");
      const slacks = legs.map((leg, index) => legSlack(leg, estimates[index])).filter(slack => slack && slack.reason === null);
      if (slacks.length) {
        const net = slacks.reduce((total, slack) => total + slack.signed, 0);
        add(list, "p", net >= 0
          ? `Tiempo libre tras los desplazamientos entre actividades: ${formatMinutes(Math.floor(net))} (${slacks.length} tramos).`
          : `Faltan ${formatMinutes(Math.ceil(-net))} en total para los desplazamientos entre actividades (${slacks.length} tramos).`);
      }
    } catch (error) {
      if (current()) {
        notice.textContent = error?.code === "route_request" ? "" : "No se pudo cargar la ruta. Vuelve a intentarlo.";
        if (explicit && calcNotice) calcNotice.textContent = error?.code === "route_request"
          ? error.message : "No se pudo calcular la ruta. Comprueba la conexión y vuelve a intentarlo.";
      }
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
    if (provider?.manual) void updatePilot("status");
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
      if (useHomeInput) useHomeInput.checked = homeConsent?.read() === true;
      form.hidden = false;
      settingsNotice.textContent = autocomplete ? "" : "El autocompletado está desactivado. Introduce las direcciones manualmente.";
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
      if (useHomeInput && homeConsent && isCurrentSettings(actorId, run)) homeConsent.write(useHomeInput.checked === true);
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
  return { sync, reset() { provider?.clear?.(); settings.clear(); activityEdits.clear(); owner = null; close(); tab.parentElement.hidden = true; } };
}
