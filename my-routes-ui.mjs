import { editableAddress } from "./my-routes-address.mjs?v=3routes30";
import { bindAddressAssistant } from "./my-routes-autocomplete.mjs?v=3routes30";
import { arrivalAfter, buildLegs, combineActivities, dayFreeTime, estimateLeg, formatMinutes, formatRouteLocation, freeTimeBetween, homeArrival, legSlack, mapsLink, mayArriveLate, recommendedDeparture, routeLocationFields, routeLocationKinds, sendableRouteLocation, shortAddress, validateRouteLocation, validateRouteLocations } from "./my-routes.mjs?v=3routes30";
import { canOfferPilotStop, countdownClock, describePilot, madridClock, stopConfirmation, waitMessage } from "./my-routes-pilot.mjs?v=3routes30";
import { absorbRecord, agendaVersion, createAutoAttempts, keepRecord, legSignatures, lookupRecord, madridDay, memorySignatures, pendingRecord, recordFrom, savableDate } from "./my-routes-saved.mjs?v=3routes30";

// CONFIRMAR_CITAS-027: ubicación de una corrección (calle tal como se escribe, con su tipo de vía), o null si
// tiene caracteres que no se pueden enviar. Mismas reglas que «Editar» y que el servidor.
export function correctedLocation(base, street, number, municipality) {
  const plain = value => String(value ?? "").replace(/[´`‘ʼ′]/g, "'").replace(/\s+/g, " ").trim();
  const postalCode = /^\d{5}$/.test(base?.postalCode ?? "") ? base.postalCode : "";
  const location = { street: plain(street), number: plain(number), municipality: plain(municipality), postalCode,
    province: plain(base?.province) };
  try {
    const valid = validateRouteLocation(location);
    return sendableRouteLocation(valid) ? valid : null;
  } catch { return null; }
}

export function mountMyRoutes({ panel, agenda, getActor, getDate, loadActivities, provider = null, autocomplete = null, preferencesStore = null, homeConsent = null, now = () => new Date(), confirmAction = null, savedDays = null, autoCalculation = false, autoStorage = null,
  timers = { set: (task, ms) => setTimeout(task, ms), clear: id => clearTimeout(id) } }) {
  const settings = preferencesStore;
  const find = id => panel.querySelector("#" + id);
  // CONFIRMAR_CITAS-022: el domicilio guardado se usa siempre (sin casilla); `homeConsent` ya no se usa.
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
  // CONFIRMAR_CITAS-026: espera entre cálculos (la marca el servidor). El botón cuenta atrás y, si se eligió
  // una calle durante la espera, se recalcula solo al terminar.
  const calculateLabel = "Calcular desplazamientos";
  const queuedText = " La corrección queda aplicada y se recalculará sola al terminar la espera.";
  let waitUntil = 0;
  let waitTimer = null;
  let waitNotice = "";
  let queued = null;
  // CONFIRMAR_CITAS-035: cálculo automático de hoy y mañana (al importar y al abrir Mis rutas). Uno cada vez.
  const attempts = createAutoAttempts(autoStorage);
  const autoQueue = new Set();
  const autoNotices = new Map();
  const autoRetries = new Map();
  let autoChain = Promise.resolve();
  let autoRunning = false;
  const waitLeft = () => waitUntil ? Math.max(0, Math.ceil((waitUntil - now().getTime()) / 1000)) : 0;
  function syncCalculate() {
    if (!calculateButton) return;
    const left = waitLeft();
    calculateButton.disabled = stopped || pilotBusy || left > 0;
    calculateButton.textContent = left > 0 ? "Espera " + countdownClock(left) : calculateLabel;
  }
  function showWaitNotice(text) {
    waitNotice = text;
    if (calcNotice) calcNotice.textContent = text;
  }
  function stopWaitTimer() {
    if (waitTimer !== null) timers.clear(waitTimer);
    waitTimer = null;
  }
  function tickWait() {
    stopWaitTimer();
    if (waitLeft() > 0) {
      syncCalculate();
      waitTimer = timers.set(tickWait, 1000);
      return;
    }
    waitUntil = 0;
    const pending = queued;
    queued = null;
    if (calcNotice && waitNotice && calcNotice.textContent === waitNotice) calcNotice.textContent = "";
    waitNotice = "";
    syncCalculate();
    if (pending && pending.actor === technicianId() && !view.hidden && settingsPanel.hidden
      && date.value === pending.date && !stopped && !pilotBusy) void calculate(pending);
    else resumeAuto();
  }
  function startWait(seconds) {
    waitUntil = Math.max(waitUntil, now().getTime() + seconds * 1000);
    tickWait();
  }
  function clearWait() {
    stopWaitTimer();
    waitUntil = 0;
    waitNotice = "";
    queued = null;
  }
  function resetAuto() {
    autoQueue.clear();
    autoNotices.clear();
    autoRetries.clear();
  }
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
    clearWait();
    syncCalculate();
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
    syncCalculate();
    showCalculateReason();
    // «Desactivar piloto» solo para el Administrador y solo si tiene efecto (CONFIRMAR_CITAS-007).
    if (stopButton) stopButton.hidden = !canOfferPilotStop(getActor(), pilot);
    pilotNotice.textContent = [pilot.message, ...pilot.lines,
      "El contador interno puede diferir del consumo de Geoapify."].join(" ") + stamp;
    if (operation === "stop" || (!view.hidden && stopped !== renderedStopped)) void refresh();
  }
  // `correction` ({ date, keys }): cálculo pedido al corregir una dirección (CONFIRMAR_CITAS-031): solo los
  // tramos de esas actividades y los que sigan sin calcular. Sin ella, toda la ruta.
  async function calculate(correction = null) {
    if (!provider?.manual || stopped || pilotBusy) return;
    const left = waitLeft();
    if (left > 0) { showWaitNotice(waitMessage(left)); return; }
    autoNotices.delete(date.value);
    pilotBusy = true;
    if (calcNotice) calcNotice.textContent = "Calculando desplazamientos…";
    syncCalculate();
    const actor = technicianId();
    let failure = null;
    try { failure = await refresh(true, correction?.date === date.value ? correction.keys : null); }
    finally { pilotBusy = false; syncCalculate(); }
    if (failure && actor === technicianId()) {
      // Las tarjetas siguen a la vista: se repintan sin calcular ni gastar nada.
      if (!view.hidden) await refresh();
      if (actor !== technicianId()) return;
      if (failure.retryAfterSeconds) {
        if (correction && correction.date === date.value) queued = { actor, date: correction.date, keys: correction.keys };
        startWait(failure.retryAfterSeconds);
        showWaitNotice(failure.message + (queued ? queuedText : ""));
      }
    }
    await updatePilot("status");
    resumeAuto();
  }
  function resumeAuto() {
    const waiting = [...autoQueue];
    autoQueue.clear();
    for (const day of waiting) void requestAuto(day);
  }
  // Nunca interrumpe a quien lo pide (importar o abrir Mis rutas): se encadena y sus fallos no salen de aquí.
  function requestAuto(day) {
    if (!autoCalculation || !provider?.manual || !provider.estimateJourney) return Promise.resolve();
    autoChain = autoChain.then(() => runAuto(day)).catch(() => {});
    return autoChain;
  }
  const showing = day => !view.hidden && settingsPanel.hidden && date.value === day;
  function showAutoNotice(day) {
    const text = autoNotices.get(day);
    if (text && calcNotice && !pilotBusy && waitLeft() === 0 && showing(day)) calcNotice.textContent = text;
  }
  const autoFailureText = "No se pudo calcular la ruta. Comprueba la conexión y vuelve a intentarlo.";
  async function runAuto(day) {
    const actorId = technicianId();
    const alive = () => Boolean(actorId) && technicianId() === actorId;
    if (!alive() || !savableDate(day, now())) return;
    const preferences = await settings.read();
    if (!alive()) return;
    const plan = await prepareRoute(actorId, day, preferences, alive);
    if (!plan || !plan.canEstimate) return;
    // Solo los tramos sin calcular o que han cambiado: con la misma agenda ya calculada no se pide nada.
    if (!plan.requested(new Set()).length) { autoNotices.delete(day); return; }
    const attempt = day + "|" + await agendaVersion(plan.signatures);
    const today = madridDay(now());
    if (!alive() || stopped) return;
    if (attempts.has(actorId, today, attempt)) { showAutoNotice(day); return; }
    // Hay otro cálculo o la espera entre cálculos: queda pendiente y se hace solo al terminar.
    if (pilotBusy || waitLeft() > 0) { autoQueue.add(day); return; }
    attempts.add(actorId, today, attempt);
    autoNotices.delete(day);
    pilotBusy = true;
    autoRunning = true;
    if (calcNotice && showing(day)) calcNotice.textContent = "Calculando desplazamientos…";
    syncCalculate();
    let failure = null;
    try {
      const { batch } = await plan.ask(true, new Set(), seconds => { if (alive()) startWait(seconds); });
      const estimates = await plan.estimate(batch);
      // Lo recién calculado se conserva: los créditos están gastados.
      if (alive()) await plan.store(batch, estimates);
      autoNotices.set(day, batch?.length
        ? calculationText(estimates.filter(Boolean).length, plan.legs.length) : autoFailureText);
    } catch (error) {
      failure = error;
      autoNotices.set(day, error?.code === "route_request" ? error.message : autoFailureText);
    } finally {
      autoRunning = false;
      pilotBusy = false;
      syncCalculate();
    }
    if (!alive()) { autoNotices.delete(day); return; }
    if (failure?.retryAfterSeconds) {
      // La espera del servidor no cuenta como intento: se repite sola al terminar (como mucho 3 veces).
      const retries = autoRetries.get(attempt) ?? 0;
      if (failure.block === "wait" && retries < 3) {
        autoRetries.set(attempt, retries + 1);
        attempts.remove(actorId, today, attempt);
        autoQueue.add(day);
      }
      startWait(failure.retryAfterSeconds);
    }
    if (showing(day)) {
      if (calcNotice) calcNotice.textContent = "";
      await refresh();
      if (!alive()) return;
      if (failure?.retryAfterSeconds && waitLeft() > 0) showWaitNotice(failure.message);
      else showAutoNotice(day);
      void updatePilot("status");
    }
    // Una corrección hecha mientras se calculaba solo: se pide ahora (si hay espera, al terminarla).
    const pending = queued;
    if (pending && waitLeft() === 0 && pending.actor === actorId && showing(pending.date) && !stopped) {
      queued = null;
      void calculate(pending);
    }
  }
  calculateButton?.addEventListener("click", () => calculate());
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
  let editForms = 0;
  const activityEdits = new Map();
  // CONFIRMAR_CITAS-031: tramos ya calculados por fecha (los de hoy y mañana, además, en la base).
  const days = new Map();
  function dayEntry(day) {
    if (!days.has(day)) days.set(day, { records: new Map(), stored: false });
    return days.get(day);
  }
  const storedRecords = (entry, signatures) => [...new Set(signatures.map(signature => entry.records.get(signature.a)).filter(Boolean))];
  const queries = new Map();
  // CONFIRMAR_CITAS-022: asistente de direcciones (CartoCiudad) en el domicilio, la recogida de llaves y
  // Tourline / Recogida de material. `autocomplete` es la búsqueda del modo `suggest` (nunca Geoapify).
  if (autocomplete) {
    for (const kind of routeLocationKinds) {
      queries.set(kind, bindAddressAssistant({
        fields: locationFields[kind],
        search: (query, signal) => autocomplete(query, signal),
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
    queued = null;
  }
  const calculationText = (done, total) => done === total
    ? "Desplazamientos calculados. Consulta los minutos y kilómetros de cada tramo."
    : done
      ? `Desplazamientos calculados en ${done} de ${total} tramos. El motivo de los demás está junto a cada tramo.`
      : "La consulta no devolvió tramos válidos. Consulta el motivo junto a cada tramo.";
  function sync() {
    const id = technicianId();
    if (id !== owner || !id) {
      settings.clear();
      activityEdits.clear();
      days.clear();
      provider?.clear?.();
      resetPilot();
      resetAuto();
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
    // CONFIRMAR_CITAS-017: si no se encontró la dirección, también se puede corregir la de una instalación.
    const editing = activity.editableTravel || failed;
    const summary = add(details, "summary", editing ? "Editar" : "Completar dirección");
    summary.setAttribute("aria-label", (editing ? "Editar desplazamiento de " : "Completar dirección de ") + label(activity));
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
    const labels = {};
    const formId = "myRoutesEdit-" + (++editForms);
    // CONFIRMAR_CITAS-022: también la provincia (el esquema de `edits` ya la admite).
    for (const [key, title] of [
      ["street", "Calle o vía"], ["number", "Portal (opcional)"], ["municipality", "Municipio"],
      ["province", "Provincia (opcional)"], ["postalCode", "Código postal (opcional)"],
    ]) {
      const label = add(group, "label", title);
      const input = add(label, "input", "");
      input.type = "text";
      input.id = formId + "-" + key;
      input.maxLength = routeLocationFields[key];
      input.autocomplete = "off";
      if (key === "postalCode") input.inputMode = "numeric";
      input.value = activity.override?.location?.[key] ?? "";
      fields[key] = input;
      labels[key] = label;
    }
    if (autocomplete) {
      // El asistente va justo debajo de «Calle o vía».
      const clearAssistant = bindAddressAssistant({
        fields, search: (query, signal) => autocomplete(query, signal),
        eligible: () => Boolean(technicianId() && !view.hidden && !group.hidden),
        document: panel.ownerDocument,
        place: results => {
          if (typeof labels.street.after === "function") labels.street.after(results);
          else group.children.splice(group.children.indexOf(labels.street) + 1, 0, results);
        },
      });
      details.addEventListener("toggle", () => { if (!details.open) clearAssistant(); });
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

  // CONFIRMAR_CITAS-035: lo común entre pintar la ruta (`refresh`) y el cálculo automático (`runAuto`).
  // Devuelve null si `alive` deja de cumplirse (cambio de usuario o de pantalla).
  async function prepareRoute(actorId, selectedDate, preferences, alive) {
    const { appointments, ignored } = await loadActivities(selectedDate);
    if (!alive()) return null;
    const edits = activityEdits.get(selectedDate) ?? new Map();
    const activities = combineActivities(appointments, ignored, preferences, edits);
    const legs = buildLegs(formatRouteLocation(preferences.home), activities);
    // Submit the agenda with the technician's edits. CONFIRMAR_CITAS-017: an address corrected in
    // «Editar desplazamiento» is sent too (same rules as the server), so the leg is recalculated with it.
    // Results are matched to displayed stops; no result is applied to a different leg.
    const safeEdits = [...edits].filter(([, edit]) => edit.location === null || sendableRouteLocation(edit.location));
    let canonical = buildLegs(formatRouteLocation(preferences.home),
      combineActivities(appointments, ignored, preferences, new Map(safeEdits)));
    const key = leg => JSON.stringify([leg.from.key, leg.to.key, leg.from.address, leg.to.address]);
    let positions = new Map(canonical.map((leg, index) => [key(leg), index]));
    const eligible = leg => leg.from.key && leg.to.key && leg.from.address && leg.to.address;
    const canEstimate = !provider?.manual || legs.some(leg => eligible(leg) && positions.has(key(leg)));
    const estimatesProvider = provider;
    // CONFIRMAR_CITAS-022: the saved home always takes part (`useHome: true` keeps the v13 function working).
    const useHome = Boolean(preferences.home);
    // CONFIRMAR_CITAS-031: lo ya calculado se muestra sin consultar nada ni gastar créditos.
    const journey = Boolean(estimatesProvider?.estimateJourney);
    const today = madridDay(now());
    for (const [day, kept] of days) if (kept.stored && day < today) days.delete(day);
    const entry = journey ? dayEntry(selectedDate) : null;
    const signatures = !journey ? [] : savedDays ? await Promise.all(legs.map(leg => legSignatures(actorId, leg)))
      : legs.map(leg => memorySignatures(actorId, leg));
    const savable = Boolean(journey && savedDays && savableDate(selectedDate, now()));
    if (savable) {
      const saved = await savedDays.read(selectedDate);
      if (!alive()) return null;
      for (const record of saved) absorbRecord(entry.records, record);
      if (saved.length) entry.stored = true;
    }
    if (!alive()) return null;
    const edited = leg => edits.has(leg.from.key) || edits.has(leg.to.key);
    const shownRecord = index => journey ? lookupRecord(entry.records, signatures[index], edited(legs[index])) : null;
    // Tramos que se piden tras una corrección (o solos): los de esas actividades y los que sigan sin calcular.
    const requested = correctedKeys => legs.flatMap((leg, index) => {
      // También los tramos desde y hacia casa: basta con que tengan las dos direcciones.
      if (!leg.from.address || !leg.to.address || !positions.has(key(leg))) return [];
      const record = shownRecord(index);
      const done = record?.d !== undefined && record.s === signatures[index].s;
      const touched = correctedKeys.has(leg.from.key) || correctedKeys.has(leg.to.key);
      return pendingRecord(record) || (touched && !done) ? [positions.get(key(leg))] : [];
    });
    async function ask(explicit, correctedKeys, onWait) {
      let only = null;
      const send = () => {
        const wanted = explicit && correctedKeys && journey ? requested(correctedKeys) : null;
        if (wanted && !wanted.length) { only = []; return []; }
        only = wanted && wanted.length < canonical.length ? wanted : null;
        return estimatesProvider.estimateJourney(canonical, { date: selectedDate, edits: safeEdits, ...(estimatesProvider.manual ? { cachedOnly: !explicit, ...(explicit ? { onWait } : {}) } : {}), ...(only ? { only } : {}), ...(useHome ? { useHome: true } : {}) });
      };
      let batch;
      try { batch = await send(); }
      catch (error) {
        // La función anterior mantiene en la ruta las actividades excluidas y responde 409 (sin gastar
        // nada): se repite con la cadena anterior.
        const legacy = buildLegs(formatRouteLocation(preferences.home),
          combineActivities(appointments, ignored, preferences, new Map(safeEdits), { legacyTransit: true }));
        const addresses = chain => JSON.stringify(chain.map(leg => [leg.from.address, leg.to.address]));
        if (!explicit || error?.status !== 409 || addresses(legacy) === addresses(canonical) || technicianId() !== actorId) throw error;
        canonical = legacy;
        positions = new Map(canonical.map((leg, index) => [key(leg), index]));
        batch = await send();
      }
      return { batch, only };
    }
    const estimate = batch => Promise.all(legs.map(leg => estimateLeg(leg,
      journey ? { estimate: () => batch?.[positions.get(key(leg))] } : estimatesProvider,
      { date: selectedDate })));
    async function store(batch, estimates) {
      if (!batch?.length) return;
      for (const [index, leg] of legs.entries()) {
        const position = positions.get(key(leg));
        if (position === undefined) continue;
        // De un tramo no pedido la respuesta no dice nada (la función v18, en cambio, los devuelve todos).
        const record = recordFrom(batch, position, estimates[index], signatures[index], now());
        if (record) keepRecord(entry.records, record, edited(leg));
      }
      const keep = savable ? storedRecords(entry, signatures) : [];
      if (keep.length) {
        entry.stored = true;
        await savedDays.save(selectedDate, keep);
      }
    }
    return { activities, edits, legs, canEstimate, estimatesProvider, journey, entry, signatures, savable,
      key, edited, shownRecord, requested, ask, estimate, store, positions: () => positions };
  }

  async function refresh(explicit = false, correctedKeys = null) {
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
      const plan = await prepareRoute(actorId, selectedDate, preferences, current);
      if (!plan) return;
      const { activities, edits, legs, canEstimate, estimatesProvider, journey, entry, signatures, savable,
        key, edited, shownRecord } = plan;
      const onWait = seconds => { if (technicianId() === actorId) startWait(seconds); };
      let batch = null;
      let only = null;
      if (journey && canEstimate) ({ batch, only } = await plan.ask(explicit, correctedKeys, onWait));
      // Se lee después de pedir: el reintento por 409 cambia la cadena enviada.
      const positions = plan.positions();
      const estimates = await plan.estimate(batch);
      // Lo recién calculado se conserva aunque ya se haya cambiado de pantalla: los créditos están gastados.
      if (journey && batch?.length && (explicit || !estimatesProvider.manual) && technicianId() === actorId) {
        await plan.store(batch, estimates);
      }
      if (!current()) return;
      renderedStopped = stopped;
      const rows = legs.map((_, index) => shownRecord(index));
      for (const [index, row] of rows.entries()) {
        if (row) estimates[index] = row.d === undefined ? null
          : { durationSeconds: row.d, distanceMeters: row.m, calculatedAt: row.t };
      }
      const rowOf = leg => rows[legs.indexOf(leg)] ?? null;
      const fromBatch = (leg, field) => batch?.[field]?.[positions.get(key(leg))] ?? null;
      const reasonOf = leg => rowOf(leg) ? rowOf(leg).r ?? null : fromBatch(leg, "reasons");
      // Un tramo está «intentado» si tiene registro o si acaba de pedirse.
      const computedLeg = leg => Boolean(rowOf(leg)
        || (batch?.length && (!only || only.includes(positions.get(key(leg))))));
      const reasonText = {
        privacy: "tramo excluido por privacidad",
        incomplete: "la dirección no contiene una vía, portal y municipio utilizables",
        not_found: "no se encontró una coincidencia única para la dirección",
        no_route: "Geoapify no devolvió una ruta utilizable",
      };
      // Why a leg has no time or distance, in the technician's words.
      function whyUnavailable(leg) {
        const detail = detailText[detailOf(leg)];
        if (detail) return (/^Geoapify/.test(detail) ? detail : detail.charAt(0).toLowerCase() + detail.slice(1)).replace(/\.$/, "");
        const reason = reasonText[reasonOf(leg)];
        if (reason) return reason;
        if (estimatesProvider?.manual && stopped && pilot) return "el cálculo está detenido (" + pilot.short + ")";
        if (estimatesProvider?.manual && !canEstimate) return "se necesitan dos actividades consecutivas con dirección completa";
        if (estimatesProvider?.manual && !computedLeg(leg)) return "aún no se han calculado; pulsa «Calcular desplazamientos»";
        return "la consulta no devolvió este tramo";
      }
      notice.textContent = !activities.length ? "No hay actividades para esta fecha."
        : legs.length && !preferences.home ? "Guarda tu domicilio en Ajustes para calcular la salida." : "";
      // CONFIRMAR_CITAS-017: motivo concreto por tramo (`details`); con la función v10 se usan los `reasons` de siempre.
      const detailText = {
        privacy: "Tramo excluido por privacidad.",
        incomplete: "La dirección no tiene calle, portal y municipio utilizables.",
        missing_number: "Falta el número del portal.",
        // CONFIRMAR_CITAS-022: motivos neutros (la búsqueda empieza por CartoCiudad).
        street_not_found: "No se encuentra esta calle en ese municipio.",
        portal_not_found: "Se encuentra la calle, pero no este número de portal.",
        ambiguous: "Hay varios sitios posibles con esta dirección.",
        other_end: "La otra dirección del tramo no se encontró.",
        other_end_incomplete: "A la otra dirección del tramo le falta calle, portal o municipio.",
        pilot_limit: "Tope diario del piloto alcanzado.",
        no_route: "Geoapify no devolvió una ruta utilizable para este tramo.",
      };
      // Which stop has to be corrected: the destination of the leg, or its origin ("other_end").
      const ownAddress = new Set(["incomplete", "missing_number", "street_not_found", "portal_not_found", "ambiguous"]);
      const otherAddress = new Set(["other_end", "other_end_incomplete"]);
      const detailOf = leg => rowOf(leg) ? rowOf(leg).dt ?? null : fromBatch(leg, "details");
      // CONFIRMAR_CITAS-018: código de detalle de la dirección (campo opcional `diagnostics`) y dirección «S/N».
      const diagnosticOf = leg => rowOf(leg) ? rowOf(leg).dg ?? null : fromBatch(leg, "diagnostics");
      // CONFIRMAR_CITAS-020: campos opcionales `approx` (tramo) y `sources` (dirección) de la función nueva.
      const approxOf = leg => rowOf(leg) ? rowOf(leg).ap === true : fromBatch(leg, "approx") === true;
      const sourcesOf = leg => {
        const index = positions.get(key(leg));
        const pair = rowOf(leg) ? rowOf(leg).src ?? []
          : Array.isArray(batch?.sources) && index !== undefined ? [batch.sources[index], batch.sources[index + 1]] : [];
        return pair.some(Boolean) ? pair.map(source => source ?? "—").join(" → ") : "";
      };
      // CONFIRMAR_CITAS-022: calle oficial usada y sugerencias por dirección (campos opcionales de la función nueva).
      const addressIndex = (leg, end) => {
        const index = positions.get(key(leg));
        return index === undefined ? undefined : index + (end === "to" ? 1 : 0);
      };
      const ofAddress = (leg, end, field) => rowOf(leg) ? rowOf(leg)[field]?.[end === "to" ? 1 : 0] ?? null
        : batch?.[field]?.[addressIndex(leg, end)] ?? null;
      const officialOf = (leg, end) => ofAddress(leg, end, "officials");
      const suggestionsOf = (leg, end) => ofAddress(leg, end, "suggestions");
      const applySuggestion = (stop, location) => {
        if (!current() || date.value !== selectedDate || !stop.key) return;
        edits.set(stop.key, { travel: "travel", location });
        activityEdits.set(selectedDate, edits);
        // Un toque aplica la calle oficial como `edits` y se recalculan sus tramos (si el piloto lo permite).
        if (!provider?.manual || stopped || (pilotBusy && !autoRunning)) { void refresh(); return; }
        const left = waitLeft();
        const earlier = queued?.actor === actorId && queued.date === selectedDate ? queued.keys : [];
        const correction = { actor: actorId, date: selectedDate, keys: new Set([...earlier, stop.key]) };
        if (autoRunning) { queued = correction; void refresh(); return; }
        if (!left) { queued = null; void calculate(correction); return; }
        // CONFIRMAR_CITAS-026: durante la espera la corrección queda aplicada y se recalcula al terminar.
        queued = correction;
        showWaitNotice(waitMessage(left) + queuedText);
        void refresh();
      };
      // CONFIRMAR_CITAS-023: el bloque de una dirección sale una sola vez; en el tramo siguiente basta el motivo.
      // CONFIRMAR_CITAS-027: todo tramo sin calcular por una dirección ofrece «Corregir a mano»; la primera vez,
      // con «¿Querías decir…?», «Dejarla como está» y el campo «Escribir la calle» ya relleno.
      const offered = new Map();
      // Detalles en los que el campo sale ya abierto: la dirección se buscó y no se encontró.
      const openFix = new Set(["street_not_found", "portal_not_found", "ambiguous", "other_end"]);
      const streetNotFoundText = "No encuentro esa calle en este pueblo. Prueba a escribirla de otra forma o deja la dirección vacía en Editar para usar la de la agenda.";
      function fixButton(item, stop, action) {
        const button = add(item, "button", "Corregir a mano");
        button.type = "button";
        button.className = "button secondary route-fix";
        button.setAttribute("aria-label", "Corregir a mano la dirección de " + (stop.key ? label(stop) : "casa"));
        button.addEventListener("click", action);
      }
      function offerFix(item, stop, list, detail) {
        const same = (stop.key || "") + "|" + (stop.address || "");
        if (offered.has(same)) { fixButton(item, stop, offered.get(same)); return; }
        const oracle = editableAddress(stop.agendaAddress || stop.address);
        if (list?.length) {
          add(item, "p", "¿Querías decir…?");
          const box = add(item, "div", "");
          box.className = "route-address-options";
          box.setAttribute("role", "group");
          box.setAttribute("aria-label", "Calles oficiales del mismo municipio");
          for (const location of list) {
            if (stop.key) {
              const button = add(box, "button", location.street);
              button.type = "button";
              button.className = "button secondary";
              button.addEventListener("click", () => applySuggestion(stop, location));
            } else add(box, "p", location.street);
          }
        }
        // El domicilio no es una actividad: se corrige en «Ajustes».
        if (!stop.key) {
          if (list?.length) add(item, "p", "Corrige tu domicilio en Ajustes y vuelve a calcular.");
          offered.set(same, () => void showSettings());
          fixButton(item, stop, offered.get(same));
          return;
        }
        const keep = correctedLocation(oracle, oracle.street, oracle.number, oracle.municipality);
        if (keep && oracle.number) {
          const box = add(item, "div", "");
          box.className = "route-address-keep";
          const button = add(box, "button", "Dejarla como está: " + keep.street);
          button.type = "button";
          button.className = "button secondary";
          button.addEventListener("click", () => applySuggestion(stop, keep));
        }
        if (stop.override?.location && detail === "street_not_found") add(item, "p", streetNotFoundText).className = "route-fix-message";
        let editor = null;
        const open = () => {
          editor.form.hidden = false;
          editor.input.focus();
          editor.input.scrollIntoView?.({ block: "center" });
        };
        fixButton(item, stop, () => open());
        editor = streetEditor(item, stop, oracle);
        editor.form.hidden = !openFix.has(detail);
        offered.set(same, open);
      }
      // Campo «Escribir la calle» (con el portal) relleno con la dirección legible; «Probar» la aplica.
      function streetEditor(item, stop, oracle) {
        const written = stop.override?.location;
        const form = add(item, "form", "");
        form.className = "dialog-form route-street-form";
        form.noValidate = true;
        const field = (title, value, max) => {
          const wrapper = add(form, "label", title);
          const input = add(wrapper, "input", "");
          input.type = "text";
          input.inputMode = "text";
          input.autocomplete = "off";
          input.spellcheck = false;
          input.maxLength = max;
          input.value = value;
          return input;
        };
        const input = field("Escribir la calle", written?.street ?? oracle.street, routeLocationFields.street);
        input.enterKeyHint = "go";
        const number = field("Número", written?.number ?? oracle.number, routeLocationFields.number);
        const town = written?.municipality || oracle.municipality;
        const municipality = town ? null : field("Municipio", "", routeLocationFields.municipality);
        const status = add(form, "p", "");
        status.setAttribute("role", "status");
        const button = add(form, "button", "Probar");
        button.type = "submit";
        button.className = "button primary";
        form.addEventListener("submit", event => {
          event.preventDefault();
          const street = input.value.trim();
          const portal = number.value.trim();
          const place = (municipality ? municipality.value : town).trim();
          if (!street) { status.textContent = "Escribe la calle."; return; }
          if (!portal && !/\d/.test(street)) { status.textContent = "Escribe también el número del portal."; return; }
          if (!place) { status.textContent = "Escribe el municipio."; return; }
          const location = correctedLocation({ ...oracle, ...(written ?? {}) }, street, portal, place);
          if (!location) { status.textContent = "Usa solo letras, números, espacios y . ' º ª / - en la calle y el número."; return; }
          status.textContent = "";
          applySuggestion(stop, location);
        });
        return { form, input };
      }
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
        : calculationText(done, legs.length);
      // CONFIRMAR_CITAS-026: tarjetas simples (actividad, dirección y desplazamiento). Lo técnico y el tiempo
      // libre no se borran: quedan en «Más detalles», cerrado por defecto.
      // CONFIRMAR_CITAS-031: las actividades excluidas del cálculo no cuentan como inicio de la jornada.
      const firstStop = activities.find(item => !item.skipped);
      const departure = firstStop === legs[0]?.to && estimates[0]
        && recommendedDeparture(legs[0].to.time, estimates[0].durationSeconds, preferences.margin);
      const heading = stop => [stop.time, stop.type].filter(Boolean).join(" · ");
      const kilometres = meters => (meters / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 });
      // CONFIRMAR_CITAS-035: hora de vuelta a casa (null sin regreso calculado o sin fin de la última actividad).
      const homecoming = legs.length ? homeArrival(activities, estimates[legs.length - 1]) : null;
      const homeClock = homecoming && homecoming.time + (homecoming.dayOffset > 0 ? " (día siguiente)" : "");
      const moreDetails = (card, notes) => {
        if (!notes.length) return;
        const details = add(card, "details", "");
        details.className = "route-more";
        add(details, "summary", "Más detalles");
        for (const note of notes) add(details, "p", note).className = "fine";
      };

      function renderSummary() {
        const card = add(list, "article", "");
        card.className = "appointment-card route-summary";
        add(card, "h3", departure
          ? "Sal de casa a las " + departure.time + (departure.dayOffset < 0 ? " (día anterior)" : "")
          : "Resumen de la ruta");
        if (homeClock) add(card, "h3", "Vuelves a casa hacia las " + homeClock);
        const notes = [];
        if (!provider) add(card, "p", "Los tiempos de conducción están desactivados. Puedes abrir en Google Maps los tramos con ubicación completa.");
        if (!departure && estimatesProvider && legs.length) {
          add(card, "p", "Hora de salida: sin calcular");
          const first = legs[0];
          const why = reasonOf(first) === "privacy" ? "el domicilio queda fuera del piloto"
            : !preferences.home ? "guarda tu domicilio en Ajustes para calcular la salida"
            : firstStop !== first.to ? "la jornada no empieza con un desplazamiento desde casa"
            : !first.to.time ? "la primera actividad no tiene hora"
            : "falta el primer tramo: " + whyUnavailable(first);
          notes.push("Hora de salida no disponible: " + why + ".");
        }
        if (estimatesProvider && legs.length) {
          const available = estimates.filter(Boolean);
          // CONFIRMAR_CITAS-017: los totales suman solo los tramos calculados.
          const seconds = available.reduce((total, leg) => total + leg.durationSeconds, 0);
          const meters = available.reduce((total, leg) => total + leg.distanceMeters, 0);
          add(card, "p", available.length
            ? "Conducción total: " + Math.ceil(seconds / 60) + " min · " + kilometres(meters) + " km"
            : "Conducción total: sin calcular").className = "route-travel";
          if (available.length !== legs.length) add(card, "p", `${available.length} de ${legs.length} desplazamientos calculados`);
        }
        // CONFIRMAR_CITAS-031: hora del último cálculo de lo que se ve (solo hoy y mañana, que se guardan).
        const latest = savable ? Math.max(0, ...rows.filter(Boolean).map(row => Date.parse(row.t))) : 0;
        if (latest) add(card, "p", "Actualizado a las " + madridClock(new Date(latest)));
        if (activities.some(item => item.editableTravel || (item.travel === "travel" && !item.address))) {
          notes.push("Los cambios de las actividades duran hasta cerrar sesión o recargar la aplicación.");
        }
        if (activities.some(activity => !activity.time)) notes.push("Las actividades sin hora fiable aparecen al final.");
        const day = dayFreeTime(activities);
        if (day.pairs) notes.push(day.counted
          ? "Tiempo libre total: " + formatMinutes(day.minutes)
            + (day.counted < day.pairs ? ` (${day.counted} de ${day.pairs} huecos; al resto le faltan horas)` : "") + "."
          : "Tiempo libre total no disponible: faltan horas de fin en la agenda.");
        const slacks = legs.map((leg, index) => legSlack(leg, estimates[index])).filter(slack => slack && slack.reason === null);
        if (slacks.length) {
          const net = slacks.reduce((total, slack) => total + slack.signed, 0);
          notes.push(net >= 0
            ? `Tiempo libre tras los desplazamientos entre actividades: ${formatMinutes(Math.floor(net))} (${slacks.length} tramos).`
            : `Faltan ${formatMinutes(Math.ceil(-net))} en total para los desplazamientos entre actividades (${slacks.length} tramos).`);
        }
        moreDetails(card, notes);
      }

      // Motivo en una frase corta y sin códigos (el largo y el código quedan en «Más detalles»).
      function shortReason(leg) {
        const detail = detailOf(leg);
        const reason = reasonOf(leg);
        const other = leg.from.key ? "la otra dirección" : "tu domicilio";
        const phrases = {
          privacy: "Dirección excluida por privacidad",
          incomplete: "La dirección está incompleta",
          missing_number: withoutNumber(leg.to.address) ? "Dirección sin número" : "Falta el número del portal",
          street_not_found: "No encuentro la calle",
          portal_not_found: "No encuentro ese número",
          ambiguous: "Hay varios sitios con esa dirección",
          other_end: "No encuentro " + other,
          other_end_incomplete: leg.from.key ? "La otra dirección está incompleta" : "Tu domicilio está incompleto",
          pilot_limit: "Se ha llegado al límite de cálculos",
          no_route: "No hay ruta en coche",
          not_found: "No encuentro la dirección",
        };
        return phrases[detail] ?? phrases[reason] ?? (computedLeg(leg) ? "No se ha podido calcular" : "Sin calcular");
      }

      // Pinta el desplazamiento de un tramo, sus sugerencias y el botón de Maps; devuelve sus notas técnicas.
      function renderLeg(item, index) {
        const leg = legs[index];
        const notes = [];
        const travel = text => { add(item, "p", text).className = "route-travel"; };
        const url = mapsLink(leg);
        // Un tiempo guardado se muestra aunque la dirección (corregida antes de cerrar) ya no esté.
        if (!url && !estimates[index]) {
          const missing = [leg.from, leg.to].filter(stop => !stop.address)
            .map(stop => stop.time ? `${stop.type} (${stop.time})` : stop.type);
          if (leg.to.noDestination || leg.from.noDestination) {
            travel(leg.to.noDestination ? "Sin destino: no se calcula" : "Falta el destino de la otra actividad");
            notes.push("Tramo pendiente. " + noDestinationText);
            return notes;
          }
          travel(!leg.to.address ? (leg.to.key ? "Falta la dirección" : "No hay domicilio guardado")
            : leg.from.key ? "Falta la dirección de la otra actividad" : "No hay domicilio guardado");
          notes.push(missing.length ? `Tramo pendiente: revisa ${missing.join(" y ")}.`
            : "Tramo pendiente: revisa la decisión de desplazamiento.");
          return notes;
        }
        notes.push(label(leg.from) + " → " + label(leg.to));
        const estimate = estimates[index];
        if (estimate) {
          travel("🚗 " + Math.ceil(estimate.durationSeconds / 60) + " min · " + kilometres(estimate.distanceMeters)
            + " km" + (approxOf(leg) ? " (aprox.)" : "")
            + (index < legs.length - 1 ? " desde " + (leg.from.key ? "la cita anterior" : "casa")
              : homeClock ? " · Llegas a casa hacia las " + homeClock : ""));
          notes.push("Estimación sin tráfico en tiempo real · " + new Date(estimate.calculatedAt).toLocaleString("es-ES"));
          if (rowOf(leg)?.corrected) add(item, "p", "Calculado con la dirección que corregiste.").className = "fine";
          if (mayArriveLate(leg, estimate)) notes.push("Posible retraso: el trayecto supera el tiempo entre actividades.");
          // CONFIRMAR_CITAS-020: posición de la calle (la base oficial no tiene ese portal) y origen de las direcciones.
          if (approxOf(leg)) {
            notes.push("aprox.: la base oficial no tiene ese portal; se usa la calle.");
            const diagnostic = diagnosticOf(leg);
            if (diagnostic) notes.push("detalle: " + diagnostic);
          }
          for (const name of new Set([officialOf(leg, "from"), officialOf(leg, "to")].filter(Boolean))) {
            notes.push("calle oficial: " + name);
          }
          const origin = sourcesOf(leg);
          if (origin) notes.push("origen: " + origin);
          const slack = legSlack(leg, estimate);
          if (slack?.reason === "no_end") notes.push("Sin hora de fin: no se puede calcular si llegas a tiempo.");
          else if (slack && slack.reason === null) notes.push(slack.late
            ? `Llegarías ${slack.minutes} min tarde (tiempo libre menos desplazamiento).`
            : `Te sobran ${slack.minutes} min (tiempo libre menos desplazamiento).`);
          const arrival = index === legs.length - 1 ? homecoming : index === 0
            ? departure && arrivalAfter(departure.time, estimate.durationSeconds)
            : arrivalAfter(leg.from.endTime, estimate.durationSeconds);
          if (arrival) {
            const offset = arrival.dayOffset + (index === 0 ? departure.dayOffset : 0);
            const day = offset ? (offset < 0 ? " (día anterior)" : " (día siguiente)") : "";
            notes.push((index === legs.length - 1 ? "Llegada estimada a casa: " : "Llegada estimada: ") + arrival.time + day);
          } else {
            notes.push("Llegada estimada no disponible.");
          }
        } else {
          travel(estimatesProvider ? shortReason(leg) : "Sin calcular");
          const reason = reasonOf(leg);
          const detail = detailOf(leg);
          const explanation = detailText[detail] ?? {
            privacy: "Tramo excluido por privacidad.",
            incomplete: "La dirección no contiene una vía, portal y municipio utilizables.",
            not_found: "No se encontró una coincidencia única para la dirección.",
            no_route: "Geoapify no devolvió una ruta utilizable para este tramo.",
          }[reason];
          if (explanation) {
            const noNumber = detail === "missing_number" && withoutNumber(leg.to.address);
            notes.push("Motivo: " + (noNumber ? "Dirección sin número: corrígela en «Editar»." : explanation));
            const diagnostic = diagnosticOf(leg);
            if (diagnostic) notes.push("detalle: " + diagnostic);
            if (noNumber) {
              // El motivo ya dice dónde corregirla.
            } else if (ownAddress.has(detail) && failedKeys.has(leg.to.key)) {
              notes.push("Corrígela en «Editar» de esta actividad y vuelve a calcular.");
            } else if (otherAddress.has(detail) && failedKeys.has(leg.from.key)) {
              notes.push("Corrígela en «Editar» de " + label(leg.from) + " y vuelve a calcular.");
            }
            if (ownAddress.has(detail)) offerFix(item, leg.to, suggestionsOf(leg, "to"), detail);
            else if (otherAddress.has(detail)) offerFix(item, leg.from, suggestionsOf(leg, "from"), detail);
          } else if (estimatesProvider && (computedLeg(leg) || (estimatesProvider.manual && (stopped || !canEstimate)))) {
            notes.push("Motivo: " + whyUnavailable(leg) + ".");
          }
        }
        if (!url) return notes;
        const link = add(item, "a", "Abrir en Google Maps");
        link.className = "button secondary route-maps";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        return notes;
      }

      if (activities.length) renderSummary();
      let legIndex = 0;
      for (const [index, activity] of activities.entries()) {
        const card = add(list, "article", "");
        card.className = "appointment-card route-card";
        add(card, "h3", heading(activity));
        const notes = [];
        if (index > 0) {
          const previous = activities[index - 1];
          const gap = freeTimeBetween(previous, activity);
          notes.push(gap.reason === "no_end"
            ? `Sin hora de fin: no se puede calcular el tiempo libre (falta el fin de ${label(previous)}).`
            : gap.reason === "no_start" ? "Sin hora de inicio: no se puede calcular el tiempo libre."
            : gap.minutes >= 0 ? `Tiempo libre: ${formatMinutes(gap.minutes)} desde el fin de ${label(previous)}.`
            : `Tiempo libre: 0 min. Se solapa ${formatMinutes(-gap.minutes)} con ${label(previous)}.`);
        }
        if (activity.travel === "pause") add(card, "p", "Sin desplazamiento").className = "route-travel";
        else {
          const short = shortAddress(activity.address);
          add(card, "p", short || "Sin dirección").className = "route-address";
          if (short && short !== activity.address) notes.push("Dirección completa: " + activity.address);
          if (activity.travel === "undecided") add(card, "p", "Pendiente de decidir si requiere desplazamiento");
          // CONFIRMAR_CITAS-027: con una dirección corregida, la de la agenda (con su piso y puerta) se sigue viendo.
          if (activity.override?.location && activity.agendaAddress) {
            if (editableAddress(activity.agendaAddress).complement) add(card, "p", "En la agenda: " + shortAddress(activity.agendaAddress)).className = "fine";
            else notes.push("Dirección de la agenda: " + activity.agendaAddress);
          }
          notes.push(...renderLeg(card, legIndex++));
        }
        const failed = failedKeys.has(activity.key);
        if (activity.editableTravel || !activity.address || activity.override || failed) {
          editActivity(card, activity, async change => {
            if (!current() || date.value !== selectedDate) return;
            // CONFIRMAR_CITAS-031: al restaurar la agenda se descarta lo calculado con la corrección.
            const restored = !change && journey && activity.override?.location;
            if (change) {
              edits.set(activity.key, change);
              activityEdits.set(selectedDate, edits);
            } else {
              edits.delete(activity.key);
              if (!edits.size) activityEdits.delete(selectedDate);
            }
            if (restored) {
              for (const [index, leg] of legs.entries()) {
                if (leg.from.key === activity.key || leg.to.key === activity.key) entry.records.delete(signatures[index].a);
              }
              if (savable) await savedDays.save(selectedDate, storedRecords(entry, signatures));
            }
            void refresh();
          }, failed);
        }
        moreDetails(card, notes);
      }
      if (legs.length) {
        const card = add(list, "article", "");
        card.className = "appointment-card route-card";
        add(card, "h3", "Regreso a casa");
        moreDetails(card, renderLeg(card, legs.length - 1));
      }
      if ((batch !== null || rows.some(Boolean)) && estimates.some(Boolean)) {
        const credit = add(list, "p", "Datos de rutas: ");
        credit.className = "fine";
        const link = add(credit, "a", "Geoapify");
        link.href = "https://www.geoapify.com/";
        credit.append(" · ");
        const osm = add(credit, "a", "© OpenStreetMap contributors");
        osm.href = "https://www.openstreetmap.org/copyright";
      }
    } catch (error) {
      if (current()) {
        notice.textContent = error?.code === "route_request" ? "" : "No se pudo cargar la ruta. Vuelve a intentarlo.";
        if (explicit && calcNotice) calcNotice.textContent = error?.code === "route_request"
          ? error.message : "No se pudo calcular la ruta. Comprueba la conexión y vuelve a intentarlo.";
      }
      // CONFIRMAR_CITAS-026: `calculate` repinta las tarjetas y, si hay espera, arranca la cuenta atrás.
      return explicit && error?.code === "route_request" ? error : null;
    }
    return null;
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
    openRoute(date.value);
  });
  agendaTab.addEventListener("click", close);
  date.addEventListener("change", () => { queued = null; openRoute(date.value); });
  // CONFIRMAR_CITAS-035: al abrir hoy o mañana se pinta lo que hay y, si faltan tramos, se calcula solo una vez.
  function openRoute(day) {
    if (autoCalculation && calcNotice && !pilotBusy && waitLeft() === 0) calcNotice.textContent = "";
    const painted = refresh();
    if (autoCalculation) void painted.then(async () => { await requestAuto(day); showAutoNotice(day); });
  }
  function isCurrentSettings(actorId, run) {
    return actorId && technicianId() === actorId && run === settingsRequest && !view.hidden && !settingsPanel.hidden;
  }
  async function showSettings() {
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
      settingsNotice.textContent = autocomplete ? "" : "El autocompletado está desactivado. Introduce las direcciones manualmente.";
    } catch {
      if (isCurrentSettings(actorId, run)) settingsNotice.textContent = "No se pudieron cargar los ajustes. Vuelve a intentarlo.";
    }
  }
  openSettings.addEventListener("click", showSettings);
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
  // CONFIRMAR_CITAS-035: se acaba de importar la agenda de `day`. Solo el propio técnico y solo hoy o mañana
  // (con cualquier otro papel `technicianId()` es null y no se llama a nada).
  function imported(day) {
    sync();
    return technicianId() ? requestAuto(day) : Promise.resolve();
  }
  return { sync, imported, reset() { provider?.clear?.(); settings.clear(); activityEdits.clear(); days.clear(); resetAuto(); owner = null; close(); tab.parentElement.hidden = true; } };
}
