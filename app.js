import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import { captureSubmittedForm } from "./form-events.mjs";
import { cleanMapAddress, normalizePhoneForCall, normalizePhoneForWhatsApp, parseOracleInstallations, stableSourceKey } from "./agenda-parser.mjs";
import { derivePresentationName, fillAppointmentTemplate } from "./message-template.mjs";
import { appointmentDateLabels, buildMapsUrl, buildWhatsAppUrl, compareImportedAppointment, dateOffset, madridDate } from "./agenda-parity.mjs";

const $ = (id) => document.getElementById(id);
const config = window.CONFIRMAR_CITAS_CONFIG ?? {};
const configured = typeof config.url === "string"
  && config.url.startsWith("https://")
  && typeof config.publishableKey === "string"
  && config.publishableKey.length > 20
  && !config.publishableKey.startsWith("REEMPLAZAR_");

let supabase = null;
let activeUser = null;
let activeProfile = null;
let teamsForActor = [];
let appointmentTeams = [];
let selectedAppointmentTeam = "";
let currentAppointments = [];
let ignoredAppointments = [];
let appointmentFilter = "Todas";
let appointmentDate = addBusinessDays(new Date(), 1);
let appointmentPreferences = {};
let importChangesBySource = new Map();
let undoTimer = null;
let sharedTextConsumed = false;
const APP_BUILD = "3ap1";
const DEFAULT_CANCEL_TO = "toa.alianzas@verisure.es";
const DEFAULT_CANCEL_CC = "angel.garciaestevez@verisure.es";

const DEFAULT_INSTALLATION_TEMPLATE = `Buenas, soy {TECNICO}, el *tÃ©cnico de la alarma de Verisure* para hacer la instalaciÃ³n de la alarma.\n\nMaÃ±ana estarÃ© en *{POBLACION}* a las *{HORA}*.\n\nðŸ“ DirecciÃ³n: *{DIRECCION}*\n\nPor favor, comprueba que la direcciÃ³n es correcta.\n\nImportante que tenga el *DNI* (fÃ­sico) y el *nÃºmero de cuenta*.\n\nRecuerda que el inmueble debe tener:\n- Luz\n- No estar en obras\n- Internet (si se quiere instalar la cÃ¡mara de vÃ­deo)\n\nTe avisarÃ© cuando estÃ© de camino. Cualquier cosa, hÃ¡zmela saber.\n\n*Si necesitas CANCELAR la instalaciÃ³n avÃ­same antes de las 00:00 de hoy para evitar penalizaciones.*`;
const DEFAULT_MAINTENANCE_TEMPLATE = `Buenas, soy {TECNICO}, el *tÃ©cnico de la alarma de Verisure* para hacer el mantenimiento de la alarma.\n\nMaÃ±ana estarÃ© en *{POBLACION}* a las *{HORA}*.\n\nðŸ“ DirecciÃ³n: *{DIRECCION}*\n\nPor favor, comprueba que la direcciÃ³n es correcta.\n\n*Si necesitas CANCELAR el mantenimiento avÃ­same antes de las 00:00 de hoy para evitar penalizaciones.*`;
const DEFAULT_CANCELLATION_TEMPLATE = `Buenos dÃ­as,\n\nEl cliente correspondiente al prospecto {MTO} solicita cancelar la cita prevista a las {HORA}.\n\nTipo de intervenciÃ³n: {TIPO}\nPoblaciÃ³n: {POBLACION}\nTelÃ©fono: {TELEFONO}\nDirecciÃ³n: {DIRECCION}\n\nMotivo indicado por el cliente: {MOTIVO}\n\nUn saludo,\n{TECNICO}`;

function localDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function addBusinessDays(date, days) {
  const [year, month, day] = localDateString(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12));
}
function addLocalDays(date, days) {
  return dateOffset(date, days);
}
function todayMadrid() { return madridDate(new Date()); }
function formatDateTitle(date) { return appointmentDateLabels(date).title; }
function formatDateChip(date) { return appointmentDateLabels(date).chip; }

function notify(message, type = "") {
  const node = $("notice");
  node.textContent = message;
  node.className = `notice${type ? ` ${type}` : ""}`;
  node.classList.remove("hidden");
}

function clearNotice() { $("notice").classList.add("hidden"); }
function setVisible(id, visible) { $(id).classList.toggle("hidden", !visible); }
function normalizeEmployeeId(value) {
  return String(value ?? "").normalize("NFKC").trim().toUpperCase().replace(/[\s-]/g, "");
}
function normalizeLoginId(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().toUpperCase().replace(/[\s-]/g, "");
  return normalized === "ADMIN" ? "ADMIN" : normalizeEmployeeId(normalized);
}
function passwordOkay(password, employeeId) {
  return password.length >= 6 && password.length <= 128
    && normalizeLoginId(password) !== normalizeLoginId(employeeId);
}

function createSupabaseClient() {
  supabase = createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      storage: window.sessionStorage,
      storageKey: "confirmar-citas-v2-auth-session",
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

function hideWorkspacePanels() {
  ["authPanel", "authDisabled", "activationPanel", "workspace", "securityPanel",
    "adminPanel", "masterPanel", "appointmentsPanel", "masterViewTabs"].forEach((id) => setVisible(id, false));
  setVisible("signOut", false);
}

async function fetchOwnProfile() {
  const { data, error } = await supabase.rpc("cc_my_profile");
  if (error) throw error;
  return data;
}

async function routeSession() {
  clearNotice();
  hideWorkspacePanels();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    notify("La sesiÃ³n no estÃ¡ disponible. Vuelve a iniciar sesiÃ³n.", "error");
    setVisible("authPanel", true);
    return;
  }
  const session = sessionData.session;
  if (!session) {
    activeUser = null;
    activeProfile = null;
    setVisible("authPanel", true);
    return;
  }
  activeUser = session.user;
  try {
    activeProfile = await fetchOwnProfile();
  } catch {
    notify("Esta identidad no tiene acceso al mÃ³dulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (!activeProfile) {
    notify("Esta identidad no tiene acceso al mÃ³dulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (activeProfile.status === "pending_activation" || activeProfile.must_change_password) {
    setVisible("activationPanel", true);
    setVisible("signOut", true);
    return;
  }
  if (!activeProfile.activation_verified_at) {
    notify("La cuenta aÃºn no estÃ¡ habilitada para este mÃ³dulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (activeProfile.status !== "active") {
    notify("La cuenta estÃ¡ desactivada. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  setVisible("workspace", true);
  setVisible("signOut", true);
  $("welcomeName").textContent = activeProfile.display_name;
  const changeLogin = $("changeEmployeeId");
  const changeLoginLabel = changeLogin.closest("label");
  if (activeProfile.role === "admin") {
    changeLogin.value = "admin";
    changeLogin.readOnly = true;
    changeLoginLabel.firstChild.textContent = "Usuario";
  } else {
    changeLogin.value = "";
    changeLogin.readOnly = false;
    changeLoginLabel.firstChild.textContent = "MatrÃ­cula";
  }
  if ($("presentationName")) $("presentationName").value = activeProfile.presentation_name ?? derivePresentationName(activeProfile.display_name);
  const rolePill = $("rolePill");
  rolePill.textContent = activeProfile.role === "admin" ? "Administrador" : activeProfile.role === "master" ? "Master" : "TÃ©cnico";
  rolePill.className = `pill ${activeProfile.role}`;
  $("roleDescription").textContent = activeProfile.role === "admin"
    ? "Panel de administraciÃ³n. Esta cuenta no abre agendas ni instalaciones."
    : activeProfile.role === "master"
      ? "Acceso a tus instalaciones y supervisiÃ³n limitada a tus equipos."
      : "Acceso limitado a tus instalaciones y ajustes personales.";
  if (activeProfile.role === "admin") {
    setVisible("adminPanel", true);
    await loadAdminPanel();
  } else if (activeProfile.role === "master") {
    setVisible("masterViewTabs", true);
    setVisible("appointmentsPanel", true);
    setVisible("masterPanel", false);
    setMasterView("appointments");
    try {
      await Promise.all([loadMasterPanel(), loadAppointmentTeams(), loadAppointmentPreferences()]);
      await Promise.all([loadOwnAppointments(appointmentDate), loadMasterAppointments()]);
    } catch {
      appointmentNotice("No se pudo cargar tu agenda o el equipo. Actualiza la pÃ¡gina e intÃ©ntalo de nuevo.", "error");
    }
  } else {
    setVisible("appointmentsPanel", true);
    try {
      await Promise.all([loadAppointmentTeams(), loadAppointmentPreferences()]);
      await loadOwnAppointments(appointmentDate);
    } catch {
      appointmentNotice("No se pudo cargar la agenda. Actualiza la pÃ¡gina e intÃ©ntalo de nuevo.", "error");
    }
  }
}

function setMasterView(view) {
  const own = view === "appointments";
  setVisible("appointmentsPanel", own);
  setVisible("masterPanel", !own);
  $("masterOwnTab").className = `button ${own ? "primary" : "secondary"}`;
  $("masterTeamTab").className = `button ${own ? "secondary" : "primary"}`;
}

function addTeamOption(container, team, checked = false, radio = false) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = radio ? "radio" : "checkbox";
  input.name = radio ? "masterTeam" : "teamIds";
  input.value = team.id;
  input.checked = checked;
  const text = document.createElement("span");
  text.textContent = team.name;
  label.append(input, text);
  container.append(label);
}

function makeAccountCard(profile, teams = [], actions = []) {
  const card = document.createElement("article");
  card.className = "account-card";
  const main = document.createElement("div");
  const title = document.createElement("h4");
  title.textContent = profile.display_name;
  const detail = document.createElement("p");
  const roleName = profile.role === "master" ? "Master" : profile.role === "admin" ? "Administrador" : profile.role === "technician" ? "TÃ©cnico" : "Equipo";
  const stateName = profile.status ?? profile.account_status ?? "";
  detail.textContent = `${roleName} Â· ${stateName}${profile.must_change_password ? " Â· activaciÃ³n pendiente" : ""}`;
  main.append(title, detail);
  if (teams.length) {
    const teamLine = document.createElement("p");
    teamLine.textContent = teams.join(" Â· ");
    main.append(teamLine);
  }
  const buttonBox = document.createElement("div");
  buttonBox.className = "account-actions";
  for (const action of actions) {
    const button = document.createElement("button");
    button.className = "button secondary";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    buttonBox.append(button);
  }
  card.append(main, buttonBox);
  return card;
}

function appointmentNotice(message, type = "") {
  const node = $("appointmentNotice");
  node.textContent = message;
  node.className = `notice${type ? ` ${type}` : ""}`;
  node.classList.remove("hidden");
}

async function loadAppointmentTeams() {
  const { data, error } = await supabase.rpc("cc_my_appointment_teams");
  if (error || !Array.isArray(data)) throw new Error("team list unavailable");
  appointmentTeams = data;
  const select = $("appointmentTeam");
  select.replaceChildren();
  for (const team of appointmentTeams) {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    select.append(option);
  }
  const current = appointmentTeams.some((team) => team.id === selectedAppointmentTeam)
    ? selectedAppointmentTeam : appointmentTeams[0]?.id ?? "";
  selectedAppointmentTeam = current;
  select.value = current;
  $("appointmentTeamLabel").classList.toggle("hidden", appointmentTeams.length < 2);
  select.classList.toggle("hidden", appointmentTeams.length < 2);
  if (!appointmentTeams.length) appointmentNotice("No tienes un equipo activo para importar agendas.", "error");
}

const defaultAppointmentPreferences = () => ({
  installation_keywords: ["kit hogar", "kit bÃ¡sico", "kit basico", "kit negocio", "kit premium"],
  installation_template: DEFAULT_INSTALLATION_TEMPLATE,
  maintenance_template: DEFAULT_MAINTENANCE_TEMPLATE,
  cancellation_template: DEFAULT_CANCELLATION_TEMPLATE,
  cancellation_email_to: DEFAULT_CANCEL_TO,
  cancellation_email_cc: DEFAULT_CANCEL_CC,
  cancellation_email_subject: "Cliente cancela - Prospecto {MTO}",
});

async function loadAppointmentPreferences() {
  const [{ data, error }, activeDateResult] = await Promise.all([
    supabase.rpc("cc_my_appointment_preferences"),
    supabase.rpc("cc_my_active_work_date"),
  ]);
  if (error || activeDateResult.error) throw new Error("preferences unavailable");
  appointmentPreferences = { ...defaultAppointmentPreferences(), ...(data ?? {}) };
  for (const [field, fallback] of [["cancellation_email_to", DEFAULT_CANCEL_TO], ["cancellation_email_cc", DEFAULT_CANCEL_CC]]) {
    if (data?.[field] == null) appointmentPreferences[field] = fallback;
  }
  const today = todayMadrid();
  const cutoff = addLocalDays(today, -2);
  if (activeDateResult.data && activeDateResult.data >= cutoff) appointmentDate = activeDateResult.data;
  else appointmentDate = addLocalDays(today, 1);
  $("appointmentDate").value = appointmentDate;
  $("installationKeywords").value = (appointmentPreferences.installation_keywords ?? []).join("\n");
  $("installationTemplate").value = appointmentPreferences.installation_template ?? DEFAULT_INSTALLATION_TEMPLATE;
  $("maintenanceTemplate").value = appointmentPreferences.maintenance_template ?? DEFAULT_MAINTENANCE_TEMPLATE;
  $("cancellationTemplate").value = appointmentPreferences.cancellation_template ?? DEFAULT_CANCELLATION_TEMPLATE;
  $("cancelEmailTo").value = appointmentPreferences.cancellation_email_to ?? "";
  $("cancelEmailCc").value = appointmentPreferences.cancellation_email_cc ?? "";
  $("cancelEmailSubject").value = appointmentPreferences.cancellation_email_subject ?? "";
}

async function loadOwnAppointments(date = appointmentDate) {
  appointmentDate = date || localDateString(addLocalDays(new Date(), 1));
  $("appointmentDate").value = appointmentDate;
  const [dayResult, indexResult, ignoredResult] = await Promise.all([
    supabase.rpc("cc_my_appointments", { p_work_date: appointmentDate }),
    supabase.rpc("cc_my_appointment_identity_index"),
    supabase.rpc("cc_my_ignored_interventions", { p_work_date: appointmentDate }),
  ]);
  if (dayResult.error || indexResult.error || ignoredResult.error || !Array.isArray(dayResult.data) || !Array.isArray(indexResult.data)) {
    appointmentNotice("No se pudo recuperar la agenda. Comprueba la conexiÃ³n e intÃ©ntalo de nuevo.", "error");
    return false;
  }
  const dateResult = await supabase.rpc("cc_set_my_active_work_date", { p_work_date: appointmentDate });
  if (dateResult.error) {
    appointmentNotice("La agenda se cargÃ³, pero no se pudo sincronizar la fecha seleccionada.", "error");
  }
  currentAppointments = dayResult.data.map((row) => ({
    ...row,
    last_changes: importChangesBySource.get(row.source_key) ?? [],
    issues: validateParsedRow(row),
  }));
  appointmentIdentityIndex = indexResult.data;
  ignoredAppointments = Array.isArray(ignoredResult.data) ? ignoredResult.data : [];
  renderAppointments();
  consumeSharedAppointmentText();
  return true;
}

function validateParsedRow(row) {
  const issues = [];
  const digits = String(row.phone ?? "").replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) issues.push("TelÃ©fono no vÃ¡lido");
  if (!String(row.population ?? "").trim()) issues.push("PoblaciÃ³n no detectada");
  if (!String(row.full_address ?? "").trim()) issues.push("DirecciÃ³n no detectada");
  return issues;
}

function consumeSharedAppointmentText() {
  if (sharedTextConsumed) return;
  const query = new URLSearchParams(window.location.search);
  const shared = query.get("text") || [query.get("title"), query.get("url")].filter(Boolean).join("\n");
  if (!shared) return;
  sharedTextConsumed = true;
  $("oracleText").value = shared;
  setVisible("manualImport", true);
  appointmentNotice("Texto compartido cargado. RevÃ­salo y pulsa Procesar instalaciones para importar.", "success");
  window.history.replaceState({}, "", window.location.pathname);
}

let appointmentIdentityIndex = [];

function setAgendaFilter(filter) {
  appointmentFilter = filter;
  renderAppointments();
}

function renderAgendaDateNavigation() {
  const target = $("agendaDateNav");
  target.replaceChildren();
  const today = todayMadrid();
  const earliest = addLocalDays(today, -2);
  const dates = new Set([
    addLocalDays(today, -1), today, addLocalDays(today, 1), appointmentDate,
    ...appointmentIdentityIndex.map((row) => row.work_date).filter((date) => date >= earliest),
  ]);
  const ordered = [...dates].filter((date) => date >= earliest).sort();
  $("appointmentDateTitle").textContent = formatDateTitle(appointmentDate);
  for (const date of ordered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button secondary datechip${date === appointmentDate ? " on" : ""}${date === today ? " today" : ""}`;
    button.textContent = date === today ? "HOY" : date === addLocalDays(today, 1) ? "MAÃ‘ANA" : formatDateChip(date);
    button.setAttribute("aria-pressed", String(date === appointmentDate));
    button.addEventListener("click", () => void selectAppointmentDate(date));
    target.append(button);
  }
  const newDate = document.createElement("button");
  newDate.className = "button secondary datechip addDate";
  newDate.type = "button";
  newDate.textContent = "ï¼‹";
  newDate.setAttribute("aria-label", "Abrir otra fecha");
  newDate.addEventListener("click", () => {
    const picker = $("appointmentDate");
    if (typeof picker.showPicker === "function") picker.showPicker();
    else { picker.focus(); picker.click(); }
  });
  target.append(newDate);
}

async function selectAppointmentDate(date) {
  if (!date) return;
  if (appointmentDate !== date) { importChangesBySource.clear(); ignoredAppointments = []; }
  await loadOwnAppointments(date);
}

function renderAppointments() {
  renderAgendaDateNavigation();
  const rows = [...currentAppointments].sort((a, b) => String(a.scheduled_time).localeCompare(String(b.scheduled_time)));
  const next = rows.find((row) => row.status === "pending" && !(row.issues ?? []).length && !row.source_missing && !row.contacted_at);
  const nextButton = $("nextAppointment");
  nextButton.disabled = !next;
  nextButton.textContent = next ? "ðŸ“² Confirmar siguiente pendiente" : "No hay pendientes disponibles";
  nextButton.onclick = () => { if (next) void openAppointmentWhatsApp(next); };
  const visible = rows.filter((row) => appointmentFilter === "Todas"
    || (appointmentFilter === "Contactadas" ? Boolean(row.contacted_at)
      : appointmentFilter === "Ignoradas" ? false : row.status === appointmentFilter.toLowerCase()));
  const counts = {
    Instalaciones: rows.filter((row) => !row.source_missing).length,
    Contactadas: rows.filter((row) => row.contacted_at).length,
    Pendientes: rows.filter((row) => row.status === "pending").length,
    Confirmadas: rows.filter((row) => row.status === "confirmed").length,
    Canceladas: rows.filter((row) => row.status === "cancelled").length,
  };
  const statTarget = $("appointmentStats");
  statTarget.replaceChildren();
  for (const [label, count] of Object.entries(counts)) {
    const stat = document.createElement("div");
    stat.className = "agenda-stat";
    const number = document.createElement("strong");
    number.textContent = String(count);
    const caption = document.createElement("span");
    caption.textContent = label;
    stat.append(number, caption);
    statTarget.append(stat);
  }
  const filters = $("appointmentFilters");
  filters.replaceChildren();
  for (const label of ["Todas", "pending", "confirmed", "cancelled", "Contactadas", "Ignoradas"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${appointmentFilter === label ? "primary" : "secondary"}`;
    button.textContent = ({ pending: "Pendientes", confirmed: "Confirmadas", cancelled: "Canceladas" })[label] ?? label;
    button.addEventListener("click", () => setAgendaFilter(label));
    filters.append(button);
  }
  const ignoredTarget = $("appointmentIgnored");
  ignoredTarget.replaceChildren();
  if (ignoredAppointments.length) {
    const summary = document.createElement("details");
    const heading = document.createElement("summary");
    heading.textContent = `Se omitieron ${ignoredAppointments.length} intervenciones que no son instalaciones`;
    summary.append(heading);
    for (const item of ignoredAppointments) {
      const line = document.createElement("p");
      line.className = "fine";
      line.textContent = `${item.time} Â· ${item.type || "Tipo no detectado"}`;
      summary.append(line);
    }
    ignoredTarget.append(summary);
  }
  const list = $("appointmentList");
  list.replaceChildren();
  if (appointmentFilter === "Ignoradas") {
    if (!ignoredAppointments.length) {
      const empty = document.createElement("div"); empty.className = "agenda-empty";
      empty.textContent = "No hay intervenciones omitidas en la Ãºltima importaciÃ³n."; list.append(empty);
    } else {
      for (const item of ignoredAppointments) {
        const line = document.createElement("article"); line.className = "appointment-card";
        line.textContent = `${item.time} Â· ${item.type || "Tipo no detectado"} Â· No importada (no es instalaciÃ³n)`;
        list.append(line);
      }
    }
    return;
  }
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "agenda-empty";
    empty.textContent = rows.length ? "No hay instalaciones en este filtro." : "No hay instalaciones guardadas para esta fecha.";
    list.append(empty);
    return;
  }
  const actionable = visible.filter((row) => !row.source_missing);
  if (actionable.length && actionable.every((row) => row.status !== "pending")) {
    const ready = document.createElement("div"); ready.className = "notice success";
    ready.textContent = "âœ“ Agenda preparada Â· no quedan citas pendientes"; list.append(ready);
  }
  for (const row of visible) list.append(renderAppointmentCard(row));
}

function humanStatus(status) {
  return ({ pending: "Pendiente", confirmed: "Confirmada", cancelled: "Cancelada" })[status] ?? "Pendiente";
}

function appointmentMessage(template, row, reason = "") {
  const presentationName = activeProfile?.presentation_name || derivePresentationName(activeProfile?.display_name);
  return fillAppointmentTemplate(template, row, presentationName, reason);
}

function renderAppointmentCard(row) {
  const card = document.createElement("article");
  card.className = `appointment-card${row.source_missing ? " missing" : ""}`;
  const head = document.createElement("div");
  head.className = "appt-head";
  const title = document.createElement("h3");
  title.textContent = `${row.scheduled_time} Â· ${row.population || "PoblaciÃ³n pendiente"}`;
  const status = document.createElement("span");
  status.className = `state-badge ${row.status}`;
  status.textContent = humanStatus(row.status);
  head.append(title, status);
  card.append(head);
  const type = document.createElement("p");
  type.className = "appt-meta";
  type.textContent = `${row.installation_type || "InstalaciÃ³n"} Â· Prospecto: ${row.prospect_ref || "â€”"}`;
  card.append(type);
  const phone = document.createElement("p");
  phone.textContent = row.phone ? `TelÃ©fono: ${row.phone}` : "TelÃ©fono no detectado";
  const address = document.createElement("p");
  address.textContent = `ðŸ“ ${[row.full_address, row.postal_code].filter(Boolean).join(" ") || "DirecciÃ³n no detectada"}`;
  card.append(phone, address);
  if (row.contacted_at) {
    const contact = document.createElement("div");
    contact.className = "contact-badge";
    contact.textContent = `WhatsApp abierto Â· ${new Date(row.contacted_at).toLocaleString("es-ES")}`;
    card.append(contact);
  }
  if (row.private_note) {
    const note = document.createElement("p");
    note.className = "private-note";
    note.textContent = `Nota privada: ${row.private_note}`;
    card.append(note);
  }
  for (const issue of row.issues ?? []) {
    const warning = document.createElement("p");
    warning.className = "fine validation-warning";
    warning.textContent = `âš  ${issue}`;
    card.append(warning);
  }
  if (row.last_changes?.length) {
    const change = document.createElement("div"); change.className = "notice changes";
    const text = document.createElement("span"); text.textContent = `Cambios detectados: ${row.last_changes.join(" Â· ")}`;
    const acknowledge = document.createElement("button"); acknowledge.className = "button secondary"; acknowledge.type = "button";
    acknowledge.textContent = "Entendido"; acknowledge.addEventListener("click", () => {
      importChangesBySource.delete(row.source_key); row.last_changes = []; renderAppointments();
    });
    change.append(text, acknowledge); card.append(change);
  }
  if (row.source_missing) {
    const missing = document.createElement("p");
    missing.className = "fine";
    missing.textContent = "Esta cita ya no aparece en la Ãºltima importaciÃ³n de Oracle.";
    card.append(missing);
  }
  const actions = document.createElement("div");
  actions.className = "appointment-actions";
  const addAction = (label, handler, style = "secondary") => {
    const button = document.createElement("button");
    button.className = `button ${style}`;
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", handler);
    actions.append(button);
  };
  addAction("WhatsApp", () => openAppointmentWhatsApp(row), "primary");
  addAction("Llamar", () => callAppointment(row));
  addAction("Maps", () => openAppointmentMaps(row));
  addAction("Editar", () => editAppointment(row));
  addAction("Revisar mensaje", () => reviewWhatsApp(row));
  addAction("Pendiente", () => changeAppointmentStatus(row, "pending"));
  addAction("Confirmar", () => changeAppointmentStatus(row, "confirmed"), "primary");
  addAction("Cancelar", () => changeAppointmentStatus(row, "cancelled"), "danger");
  addAction("Nota", () => editAppointmentNote(row));
  addAction("Copiar direcciÃ³n", () => copyAppointmentAddress(row));
  if (row.source_missing) addAction("Eliminar", () => removeAppointment(row), "danger");
  card.append(actions);
  const updated = document.createElement("p");
  updated.className = "appt-meta";
  updated.textContent = `Actualizada: ${new Date(row.updated_at).toLocaleString("es-ES")}`;
  card.append(updated);
  return card;
}

async function openAppointmentWhatsApp(row, customMessage = "") {
  if (!row.phone) { appointmentNotice("No hay telÃ©fono vÃ¡lido para abrir WhatsApp.", "error"); return; }
  if (row.issues?.length) { appointmentNotice(`Revisa primero: ${row.issues.join(", ")}.`, "error"); return; }
  if (row.contacted_at && !customMessage) {
    const time = new Date(row.contacted_at).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    if (!window.confirm(`Ya abriste WhatsApp para esta cita a las ${time}. Â¿Abrirlo de nuevo?`)) return;
  }
  const { data, error } = await supabase.rpc("cc_record_whatsapp_open", { p_appointment_id: row.id });
  if (error) { appointmentNotice("No se pudo registrar la apertura de WhatsApp. No se ha abierto la aplicaciÃ³n.", "error"); return; }
  row.contacted_at = data;
  renderAppointments();
  const template = appointmentPreferences.installation_template || DEFAULT_INSTALLATION_TEMPLATE;
  const message = customMessage || appointmentMessage(template, row);
  const phone = normalizePhoneForWhatsApp(row.phone);
  window.location.assign(buildWhatsAppUrl(phone, message, navigator.userAgent));
}

function callAppointment(row) {
  const phone = normalizePhoneForCall(row.phone);
  if (!phone) { appointmentNotice("No hay telÃ©fono vÃ¡lido para llamar.", "error"); return; }
  window.location.href = `tel:${phone}`;
}

function openAppointmentMaps(row) {
  const query = [cleanMapAddress(row.full_address, row.population), row.postal_code].filter(Boolean).join(", ");
  if (!query.trim()) { appointmentNotice("No hay direcciÃ³n para abrir Maps.", "error"); return; }
  window.location.assign(buildMapsUrl(query, navigator.userAgent));
}

async function copyAppointmentAddress(row) {
  const address = [row.full_address, row.postal_code, row.population].filter(Boolean).join(", ");
  if (!address) { appointmentNotice("No hay direcciÃ³n para copiar.", "error"); return; }
  try { await navigator.clipboard.writeText(address); appointmentNotice("DirecciÃ³n copiada.", "success"); }
  catch { window.prompt("Copia la direcciÃ³n:", address); }
}

function reviewWhatsApp(row) {
  const template = appointmentPreferences.installation_template || DEFAULT_INSTALLATION_TEMPLATE;
  const message = window.prompt("Revisa o modifica el mensaje de WhatsApp", appointmentMessage(template, row));
  if (message !== null) void openAppointmentWhatsApp(row, message);
}

async function editAppointment(row) {
  const time = window.prompt("Hora (HH:MM)", row.scheduled_time ?? ""); if (time === null) return;
  const population = window.prompt("PoblaciÃ³n", row.population ?? ""); if (population === null) return;
  const phone = window.prompt("TelÃ©fono", row.phone ?? ""); if (phone === null) return;
  const address = window.prompt("DirecciÃ³n", row.full_address ?? ""); if (address === null) return;
  const postal = window.prompt("CÃ³digo postal", row.postal_code ?? ""); if (postal === null) return;
  const { error } = await supabase.rpc("cc_edit_appointment_details", {
    p_appointment_id: row.id, p_scheduled_time: time, p_population: population,
    p_phone: phone, p_full_address: address, p_postal_code: postal,
  });
  if (error) appointmentNotice("No se pudieron guardar los cambios privados.", "error");
  else { appointmentNotice("InformaciÃ³n actualizada.", "success"); await loadOwnAppointments(appointmentDate); }
}

async function editAppointmentNote(row) {
  const note = window.prompt("Nota privada (solo visible para ti)", row.private_note ?? "");
  if (note === null) return;
  const { error } = await supabase.rpc("cc_save_appointment_private", {
    p_appointment_id: row.id, p_phone: row.phone ?? "", p_full_address: row.full_address ?? "",
    p_postal_code: row.postal_code ?? "", p_private_note: note,
    p_cancellation_reason: row.cancellation_reason ?? "",
  });
  if (error) appointmentNotice("No se pudo guardar la nota privada.", "error");
  else { appointmentNotice("Nota guardada.", "success"); await loadOwnAppointments(appointmentDate); }
}

async function changeAppointmentStaw}|¶‰žËkºwµçAÁ½¥¹Ñµ•¹Ñ9½Ñ¥”¡¥Ñ„…ÑÕ…±¥é…‘„è€‘í¡Õµ…¹MÑ…ÑÕÌ¡ÍÑ…ÑÕÌ¥ô¹€°€‰ÍÕ•ÍÌˆ¤ì(€…Ý…¥Ð±½…‘=Ý¹ÁÁ½¥¹Ñµ•¹ÑÌ¡…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”¤ì(€Í¡½ÝU¹‘½Q½…ÍÐ¡5…É…‘„½µ¼€‘í¡Õµ…¹MÑ…ÑÕÌ¡ÍÑ…ÑÕÌ¤¹Ñ½1½Ý•É…Í” ¥õ€°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•ÍÑ½É•MÑ…ÑÕÌ€ô½±‘MÑ…ÑÕÌì(€€€¥˜€¡É•ÍÑ½É•MÑ…ÑÕÌ€„ôô€‰…¹•±±•ˆ¤ì(€€€€€½¹ÍÐì•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}Í•Ñ}…ÁÁ½¥¹Ñµ•¹Ñ}ÍÑ…ÑÕÌˆ°ìÁ}…ÁÁ½¥¹Ñµ•¹Ñ}¥èÉ½Ü¹¥°Á}¹•Ý}ÍÑ…ÑÕÌèÉ•ÍÑ½É•MÑ…ÑÕÌô¤ì(€€€€€¥˜€¡•ÉÉ½È¤Ñ¡É½Ü•ÉÉ½Èì(€€€ô•±Í”ì(€€€€€½¹ÍÐì•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}…¹•±}…ÁÁ½¥¹Ñµ•¹Ðˆ°ìÁ}…ÁÁ½¥¹Ñµ•¹Ñ}¥èÉ½Ü¹¥°Á}É•…Í½¸è½±‘I•…Í½¸ñð€‰5½Ñ¥Ù¼ÁÉ•Ù¥…µ•¹Ñ”É•¥ÍÑÉ…‘¼ˆô¤ì(€€€€€¥˜€¡•ÉÉ½È¤Ñ¡É½Ü•ÉÉ½Èì(€€€ô(€€€½¹ÍÐì•ÉÉ½ÈèÁÉ¥Ù…Ñ•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}Í…Ù•}…ÁÁ½¥¹Ñµ•¹Ñ}ÁÉ¥Ù…Ñ”ˆ°ì(€€€€€Á}…ÁÁ½¥¹Ñµ•¹Ñ}¥èÉ½Ü¹¥°Á}Á¡½¹”èÉ½Ü¹Á¡½¹”€üü€ˆˆ°Á}™Õ±±}…‘‘É•ÍÌèÉ½Ü¹™Õ±±}…‘‘É•ÍÌ€üü€ˆˆ°(€€€€€Á}Á½ÍÑ…±}½‘”èÉ½Ü¹Á½ÍÑ…±}½‘”€üü€ˆˆ°Á}ÁÉ¥Ù…Ñ•}¹½Ñ”èÉ½Ü¹ÁÉ¥Ù…Ñ•}¹½Ñ”€üü€ˆˆ°(€€€€€Á}…¹•±±…Ñ¥½¹}É•…Í½¸è½±‘I•…Í½¸°(€€€ô¤ì(€€€¥˜€¡ÁÉ¥Ù…Ñ•ÉÉ½È¤Ñ¡É½ÜÁÉ¥Ù…Ñ•ÉÉ½Èì(€€€…Ý…¥Ð±½…‘=Ý¹ÁÁ½¥¹Ñµ•¹ÑÌ¡…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”¤ì(€€€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰M”‘•Í¡¥é¼•°…µ‰¥¼‘”•ÍÑ…‘¼¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€ô¤ì(€¥˜€¡•µ…¥±Q½=Á•¸¤Ý¥¹‘½Ü¹±½…Ñ¥½¸¹¡É•˜€ô•µ…¥±Q½=Á•¸ì)ô()™Õ¹Ñ¥½¸Í¡½ÝU¹‘½Q½…ÍÐ¡µ•ÍÍ…”°Õ¹‘¼¤ì(€‘½Õµ•¹Ð¹•Ñ±•µ•¹Ñ	å% ‰…•¹‘…U¹‘½Q½…ÍÐˆ¤ü¹É•µ½Ù” ¤ì(€½¹ÍÐÑ½…ÍÐ€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰‘¥Øˆ¤ìÑ½…ÍÐ¹¥€ô€‰…•¹‘…U¹‘½Q½…ÍÐˆìÑ½…ÍÐ¹±…ÍÍ9…µ”€ô€‰Õ¹‘¼µÑ½…ÍÐˆì(€½¹ÍÐ±…‰•°€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰ÍÁ…¸ˆ¤ì±…‰•°¹Ñ•áÑ½¹Ñ•¹Ð€ôµ•ÍÍ…”ì(€½¹ÍÐ‰ÕÑÑ½¸€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰‰ÕÑÑ½¸ˆ¤ì‰ÕÑÑ½¸¹±…ÍÍ9…µ”€ô€‰‰ÕÑÑ½¸Í•½¹‘…Éäˆì‰ÕÑÑ½¸¹ÑåÁ”€ô€‰‰ÕÑÑ½¸ˆì‰ÕÑÑ½¸¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰M!Hˆì(€‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì(€€€‰ÕÑÑ½¸¹‘¥Í…‰±•€ôÑÉÕ”ì(€€€ÑÉäì…Ý…¥ÐÕ¹‘¼ ¤ìÑ½…ÍÐ¹É•µ½Ù” ¤ìô(€€€…Ñ ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼Í”ÁÕ‘¼‘•Í¡…•È•°…µ‰¥¼ì…ÑÕ…±¥é„±„…•¹‘„Á…É„½µÁÉ½‰…ÈÍÔ•ÍÑ…‘¼¸ˆ°€‰•ÉÉ½Èˆ¤ìô(€ô¤ì(€Ñ½…ÍÐ¹…ÁÁ•¹¡±…‰•°°‰ÕÑÑ½¸¤ì‘½Õµ•¹Ð¹‰½‘ä¹…ÁÁ•¹¡Ñ½…ÍÐ¤ì(€±•…ÉQ¥µ•½ÕÐ¡Õ¹‘½Q¥µ•È¤ìÕ¹‘½Q¥µ•È€ôÍ•ÑQ¥µ•½ÕÐ  ¤€ôøÑ½…ÍÐ¹É•µ½Ù” ¤°€ØÀÀÀ¤ì)ô()™Õ¹Ñ¥½¸‰Õ¥±‘…¹•±±…Ñ¥½¹µ…¥°¡É½Ü°É•…Í½¸¤ì(€½¹ÍÐÑ•µÁ±…Ñ”€ô…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì¹…¹•±±…Ñ¥½¹}Ñ•µÁ±…Ñ”ñðU1Q}911Q%=9}Q5A1Qì(€½¹ÍÐÍÕ‰©•Ð€ô™¥±±ÁÁ½¥¹Ñµ•¹ÑQ•µÁ±…Ñ”¡…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì¹…¹•±±…Ñ¥½¹}•µ…¥±}ÍÕ‰©•Ðñð€‰±¥•¹Ñ”…¹•±„€´AÉ½ÍÁ•Ñ¼í5Q=ôˆ°É½Ü°…Ñ¥Ù•AÉ½™¥±”ü¹‘¥ÍÁ±…å}¹…µ”°É•…Í½¸¤ì(€½¹ÍÐ‰½‘ä€ô™¥±±ÁÁ½¥¹Ñµ•¹ÑQ•µÁ±…Ñ”¡Ñ•µÁ±…Ñ”°É½Ü°…Ñ¥Ù•AÉ½™¥±”ü¹‘¥ÍÁ±…å}¹…µ”°É•…Í½¸¤ì(€½¹ÍÐÑ¼€ô…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì¹…¹•±±…Ñ¥½¹}•µ…¥±}Ñ¼ñð€ˆˆì(€¥˜€ …Ñ¼¤É•ÑÕÉ¸€ˆˆì(€½¹ÍÐŒ€ô…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì¹…¹•±±…Ñ¥½¹}•µ…¥±}Œñð€ˆˆì(€É•ÑÕÉ¸µ…¥±Ñ¼è‘í•¹½‘•UI%½µÁ½¹•¹Ð¡Ñ¼¥ôü‘íŒ€üŒô‘í•¹½‘•UI%½µÁ½¹•¹Ð¡Œ¥ô™€€è€ˆ‰õÍÕ‰©•Ðô‘í•¹½‘•UI%½µÁ½¹•¹Ð¡ÍÕ‰©•Ð¥ô™‰½‘äô‘í•¹½‘•UI%½µÁ½¹•¹Ð¡‰½‘ä¥õ€ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•µ½Ù•ÁÁ½¥¹Ñµ•¹Ð¡É½Ü¤ì(€¥˜€ …Ý¥¹‘½Ü¹½¹™¥É´ ‹
ý±¥µ¥¹…È•ÍÑ„¥Ñ„‘”ÑÔ…•¹‘„üˆ¤¤É•ÑÕÉ¸ì(€½¹ÍÐì•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}‘•±•Ñ•}…ÁÁ½¥¹Ñµ•¹Ðˆ°ìÁ}…ÁÁ½¥¹Ñµ•¹Ñ}¥èÉ½Ü¹¥ô¤ì(€¥˜€¡•ÉÉ½È¤…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼Í”ÁÕ‘¼•±¥µ¥¹…È±„¥Ñ„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€•±Í”ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰¥Ñ„•±¥µ¥¹…‘„¸ˆ°€‰ÍÕ•ÍÌˆ¤ì…Ý…¥Ð±½…‘=Ý¹ÁÁ½¥¹Ñµ•¹ÑÌ¡…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”¤ìô)ô()…Íå¹Œ™Õ¹Ñ¥½¸µ…­•MÑ…‰±•M½ÕÉ•-•ä¡É½Ü°½ÕÉÉ•¹”€ô€À¤ì(€½¹ÍÐ¥‘•¹Ñ¥Ñä€ôÉ½Ü¹ÁÉ½ÍÁ•Ñ}É•˜(€€€€üÁÉ½ÍÁ•Ðè‘íMÑÉ¥¹œ¡É½Ü¹ÁÉ½ÍÁ•Ñ}É•˜¤¹ÑÉ¥´ ¤¹Ñ½UÁÁ•É…Í” ¥õ€(€€€€è™…±±‰…¬è‘í…ÁÁ½¥¹Ñµ•¹Ñ…Ñ•ôè‘íÉ½Ü¹Ñ¥µ•ôè‘íÉ½Ü¹Á½ÁÕ±…Ñ¥½¸¹Ñ½1½…±•1½Ý•É…Í” ‰•ÌµLˆ¥ôè‘íÉ½Ü¹ÑåÁ”¹Ñ½1½…±•1½Ý•É…Í” ‰•ÌµLˆ¥ôè‘í½ÕÉÉ•¹•õ€ì(€½¹ÍÐ‰åÑ•Ì€ô¹•ÜQ•áÑ¹½‘•È ¤¹•¹½‘”¡€‘í…Ñ¥Ù•UÍ•È¹¥‘ôè‘í¥‘•¹Ñ¥Ñåõ€¤ì(€½¹ÍÐ‘¥•ÍÐ€ô¹•ÜU¥¹ÐáÉÉ…ä¡…Ý…¥ÐÉåÁÑ¼¹ÍÕ‰Ñ±”¹‘¥•ÍÐ ‰M!´ÈÔØˆ°‰åÑ•Ì¤¤ì(€±•Ð¡•à€ôl¸¸¹‘¥•ÍÐ¹Í±¥” À°€ÄØ¥t¹µ…À ¡‰åÑ”¤€ôø‰åÑ”¹Ñ½MÑÉ¥¹œ ÄØ¤¹Á…‘MÑ…ÉÐ È°€ˆÀˆ¤¤¹©½¥¸ ˆˆ¤ì(€¡•à€ô€‘í¡•à¹Í±¥” À°€ÄÈ¥ôÔ‘í¡•à¹Í±¥” ÄÌ°€ÄØ¥ô‘ì¡Á…ÉÍ•%¹Ð¡¡•álÄÙt°€ÄØ¤€˜€Ìð€à¤¹Ñ½MÑÉ¥¹œ ÄØ¥ô‘í¡•à¹Í±¥” ÄÜ¥õ€ì(€É•ÑÕÉ¸€‘í¡•à¹Í±¥” À°€à¥ô´‘í¡•à¹Í±¥” à°€ÄÈ¥ô´‘í¡•à¹Í±¥” ÄÈ°€ÄØ¥ô´‘í¡•à¹Í±¥” ÄØ°€ÈÀ¥ô´‘í¡•à¹Í±¥” ÈÀ°€ÌÈ¥õ€ì)ô()™Õ¹Ñ¥½¸µ…Ñ¡•ÍÁÁ½¥¹Ñµ•¹Ð¡•á¥ÍÑ¥¹œ°Á…ÉÍ•¤ì(€¥˜€¡Á…ÉÍ•¹ÁÉ½ÍÁ•Ñ}É•˜€˜˜•á¥ÍÑ¥¹œ¹ÁÉ½ÍÁ•Ñ}É•˜¤É•ÑÕÉ¸Á…ÉÍ•¹ÁÉ½ÍÁ•Ñ}É•˜€ôôô•á¥ÍÑ¥¹œ¹ÁÉ½ÍÁ•Ñ}É•˜ì(€¥˜€¡Á…ÉÍ•¹ÁÉ½ÍÁ•Ñ}É•˜ñð•á¥ÍÑ¥¹œ¹ÁÉ½ÍÁ•Ñ}É•˜¤É•ÑÕÉ¸™…±Í”ì(€½¹ÍÐÍ…µ•AÉ¥Ù…Ñ•%‘•¹Ñ¥Ñä€ôÁ…ÉÍ•¹Á¡½¹”€˜˜Á…ÉÍ•¹™Õ±±}…‘‘É•ÍÌ(€€€€˜˜•á¥ÍÑ¥¹œ¹Á¡½¹”€ôôôÁ…ÉÍ•¹Á¡½¹”€˜˜•á¥ÍÑ¥¹œ¹™Õ±±}…‘‘É•ÍÌ€ôôôÁ…ÉÍ•¹™Õ±±}…‘‘É•ÍÌ(€€€€˜˜€¡•á¥ÍÑ¥¹œ¹¥¹ÍÑ…±±…Ñ¥½¹}ÑåÁ”€üü€ˆˆ¤€ôôôÁ…ÉÍ•¹ÑåÁ”ì(€É•ÑÕÉ¸Í…µ•AÉ¥Ù…Ñ•%‘•¹Ñ¥Ñäñð€¡•á¥ÍÑ¥¹œ¹Ý½É­}‘…Ñ”€ôôô…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”(€€€€˜˜•á¥ÍÑ¥¹œ¹Í¡•‘Õ±•‘}Ñ¥µ”€ôôôÁ…ÉÍ•¹Ñ¥µ”€˜˜•á¥ÍÑ¥¹œ¹Á½ÁÕ±…Ñ¥½¸€ôôôÁ…ÉÍ•¹Á½ÁÕ±…Ñ¥½¸(€€€€˜˜€¡•á¥ÍÑ¥¹œ¹¥¹ÍÑ…±±…Ñ¥½¹}ÑåÁ”€üü€ˆˆ¤€ôôôÁ…ÉÍ•¹ÑåÁ”(€€€€˜˜€¡•á¥ÍÑ¥¹œ¹Á¡½¹”€üü€ˆˆ¤€ôôôÁ…ÉÍ•¹Á¡½¹”€˜˜€¡•á¥ÍÑ¥¹œ¹™Õ±±}…‘‘É•ÍÌ€üü€ˆˆ¤€ôôôÁ…ÉÍ•¹™Õ±±}…‘‘É•ÍÌ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÁÉ½•ÍÍ=É…±•Q•áÐ ¤ì(€½¹ÍÐÑ•áÐ€ô€ ‰½É…±•Q•áÐˆ¤¹Ù…±Õ”ì(€¥˜€ …Ñ•áÐ¹ÑÉ¥´ ¤¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰A•„ÁÉ¥µ•É¼•°Ñ•áÑ¼‘”=É…±”¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€¥˜€ …Í•±•Ñ•‘ÁÁ½¥¹Ñµ•¹ÑQ•…´ñð€……ÁÁ½¥¹Ñµ•¹ÑQ•…µÌ¹Í½µ” ¡Ñ•…´¤€ôøÑ•…´¹¥€ôôôÍ•±•Ñ•‘ÁÁ½¥¹Ñµ•¹ÑQ•…´¤¤ì(€€€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼¡…äÕ¸•ÅÕ¥Á¼…ÕÑ½É¥é…‘¼Á…É„•ÍÑ„¥µÁ½ÉÑ…§Í¸¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ì(€ô(€½¹ÍÐÁ…ÉÍ•€ôÁ…ÉÍ•=É…±•%¹ÍÑ…±±…Ñ¥½¹Ì¡Ñ•áÐ°…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì¹¥¹ÍÑ…±±…Ñ¥½¹}­•åÝ½É‘Ì¤ì(€¥¹½É•‘ÁÁ½¥¹Ñµ•¹ÑÌ€ôÁ…ÉÍ•¹¥¹½É•ì(€½¹ÍÐ½ÕÉÉ•¹•Ì€ô¹•Ü5…À ¤ì(€½¹ÍÐÕÍ•‘M½ÕÉ•Ì€ô¹•ÜM•Ð ¤ì(€½¹ÍÐÉ½ÝÌ€ômtì(€™½È€¡½¹ÍÐ¥Ñ•´½˜Á…ÉÍ•¹¥¹ÍÑ…±±…Ñ¥½¹Ì¤ì(€€€½¹ÍÐ½±€ô…ÁÁ½¥¹Ñµ•¹Ñ%‘•¹Ñ¥Ñå%¹‘•à¹™¥¹ ¡…¹‘¥‘…Ñ”¤€ôø€…ÕÍ•‘M½ÕÉ•Ì¹¡…Ì¡…¹‘¥‘…Ñ”¹Í½ÕÉ•}­•ä¤€˜˜µ…Ñ¡•ÍÁÁ½¥¹Ñµ•¹Ð¡…¹‘¥‘…Ñ”°¥Ñ•´¤¤ì(€€€¥˜€¡½±¤ÕÍ•‘M½ÕÉ•Ì¹…‘¡½±¹Í½ÕÉ•}­•ä¤ì(€€€½¹ÍÐ‰…Í”€ô¥Ñ•´¹ÁÉ½ÍÁ•Ñ}É•˜€üÀè‘í¥Ñ•´¹ÁÉ½ÍÁ•Ñ}É•™õ€€è¸è‘í…ÁÁ½¥¹Ñµ•¹Ñ…Ñ•õð‘í¥Ñ•´¹Ñ¥µ•õð‘í¥Ñ•´¹Á½ÁÕ±…Ñ¥½¹õð‘í¥Ñ•´¹ÑåÁ•õ€ì(€€€½¹ÍÐ½ÕÉÉ•¹”€ô½ÕÉÉ•¹•Ì¹•Ð¡‰…Í”¤€üü€Àì(€€€½ÕÉÉ•¹•Ì¹Í•Ð¡‰…Í”°½ÕÉÉ•¹”€¬€Ä¤ì(€€€½¹ÍÐÍ½ÕÉ•-•ä€ô½±ü¹Í½ÕÉ•}­•ä€üü…Ý…¥ÐÍÑ…‰±•M½ÕÉ•-•ä¡…Ñ¥Ù•UÍ•È¹¥°…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”°¥Ñ•´°½ÕÉÉ•¹”¤ì(€€€½¹ÍÐ¡…¹•Ì€ô½µÁ…É•%µÁ½ÉÑ•‘ÁÁ½¥¹Ñµ•¹Ð¡½±°¥Ñ•´¤ì(€€€¥˜€¡¡…¹•Ì¹±•¹Ñ ¤¥µÁ½ÉÑ¡…¹•Í	åM½ÕÉ”¹Í•Ð¡Í½ÕÉ•-•ä°¡…¹•Ì¤ì(€€€•±Í”¥µÁ½ÉÑ¡…¹•Í	åM½ÕÉ”¹‘•±•Ñ”¡Í½ÕÉ•-•ä¤ì(€€€É½ÝÌ¹ÁÕÍ ¡ì(€€€€€Í½ÕÉ•}­•äèÍ½ÕÉ•-•ä°Ý½É­}‘…Ñ”è…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”°Í¡•‘Õ±•‘}Ñ¥µ”è¥Ñ•´¹Ñ¥µ”°(€€€€€Á½ÁÕ±…Ñ¥½¸è¥Ñ•´¹Á½ÁÕ±…Ñ¥½¸ñð€‰A½‰±…§Í¸Á•¹‘¥•¹Ñ”ˆ°ÁÉ½ÍÁ•Ñ}É•˜è¥Ñ•´¹ÁÉ½ÍÁ•Ñ}É•˜°(€€€€€­¥¹è€‰¥¹ÍÑ…±±…Ñ¥½¸ˆ°ÑåÁ”è¥Ñ•´¹ÑåÁ”°Á¡½¹”è¥Ñ•´¹Á¡½¹”°(€€€€€™Õ±±}…‘‘É•ÍÌè¥Ñ•´¹™Õ±±}…‘‘É•ÍÌ°Á½ÍÑ…±}½‘”è¥Ñ•´¹Á½ÍÑ…±}½‘”°(€€€€€ÁÉ¥Ù…Ñ•}¹½Ñ”è½±ü¹ÁÉ¥Ù…Ñ•}¹½Ñ”€üü€ˆˆ°…¹•±±…Ñ¥½¹}É•…Í½¸è½±ü¹…¹•±±…Ñ¥½¹}É•…Í½¸€üü€ˆˆ°(€€€ô¤ì(€ô(€™½È€¡½¹ÍÐ½±½˜…ÁÁ½¥¹Ñµ•¹Ñ%‘•¹Ñ¥Ñå%¹‘•à¹™¥±Ñ•È ¡…¹‘¥‘…Ñ”¤€ôø…¹‘¥‘…Ñ”¹Ý½É­}‘…Ñ”€ôôô…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”€˜˜€…ÕÍ•‘M½ÕÉ•Ì¹¡…Ì¡…¹‘¥‘…Ñ”¹Í½ÕÉ•}­•ä¤¤¤ì(€€€¥µÁ½ÉÑ¡…¹•Í	åM½ÕÉ”¹Í•Ð¡½±¹Í½ÕÉ•}­•ä°l‰U¹„¥Ñ„å„¹¼…Á…É•”•¸=É…±”‰t¤ì(€ô(€½¹ÍÐ‘ÕÁ±¥…Ñ•AÉ½ÍÁ•ÑÌ€ôÉ½ÝÌ¹™¥±Ñ•È ¡É½Ü°¥¹‘•à¤€ôøÉ½Ü¹ÁÉ½ÍÁ•Ñ}É•˜€˜˜É½ÝÌ¹™¥¹‘%¹‘•à ¡½Ñ¡•È¤€ôø½Ñ¡•È¹ÁÉ½ÍÁ•Ñ}É•˜€ôôôÉ½Ü¹ÁÉ½ÍÁ•Ñ}É•˜¤€„ôô¥¹‘•à¤ì(€¥˜€¡‘ÕÁ±¥…Ñ•AÉ½ÍÁ•ÑÌ¹±•¹Ñ ¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰=É…±”½¹Ñ¥•¹”É•™•É•¹¥…Ì‘”ÁÉ½ÍÁ•Ñ¼‘ÕÁ±¥…‘…ÌìÉ•Ù¥Í„•°Ñ•áÑ¼…¹Ñ•Ì‘”¥µÁ½ÉÑ…È¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}Íå¹}…ÁÁ½¥¹Ñµ•¹Ñ}‰…Ñ ˆ°ì(€€€Á}Ñ•…µ}¥èÍ•±•Ñ•‘ÁÁ½¥¹Ñµ•¹ÑQ•…´°Á}Ý½É­}‘…Ñ”è…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”°Á}É½ÝÌèÉ½ÝÌ°(€ô¤ì(€¥˜€¡•ÉÉ½È¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰1„¥µÁ½ÉÑ…§Í¸¹¼Í”ÁÕ‘¼Õ…É‘…È¸I•Ù¥Í„•°•ÅÕ¥Á¼ä±„™•¡„”¥¹Ó¥¹Ñ…±¼‘”¹Õ•Ù¼¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€½¹ÍÐì•ÉÉ½Èè¥¹½É•‘ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}Í…Ù•}µå}¥¹½É•‘}¥¹Ñ•ÉÙ•¹Ñ¥½¹Ìˆ°ì(€€€Á}Ý½É­}‘…Ñ”è…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”°Á}É½ÝÌè¥¹½É•‘ÁÁ½¥¹Ñµ•¹ÑÌ°(€ô¤ì(€€ ‰½É…±•Q•áÐˆ¤¹Ù…±Õ”€ô€ˆˆì(€…Ý…¥Ð±½…‘=Ý¹ÁÁ½¥¹Ñµ•¹ÑÌ¡…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”¤ì(€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥”¡¥¹½É•‘ÉÉ½È(€€€€ü%µÁ½ÉÑ…§Í¸Õ…É‘…‘„è€‘í9Õµ‰•È¡‘…Ñ„¤ñð€Áô¥¹ÍÑ…±…¥½¹•Ì°Á•É¼¹¼Í”Í¥¹É½¹¥ëÌ±„±¥ÍÑ„‘”¥¹Ñ•ÉÙ•¹¥½¹•Ì½µ¥Ñ¥‘…Ì¹€(€€€€è%µÁ½ÉÑ…§Í¸Õ…É‘…‘„è€‘í9Õµ‰•È¡‘…Ñ„¤ñð€Áô¥¹ÍÑ…±…¥½¹•Ì¸M”½¹Í•ÉÙ…É½¸±½Ì•ÍÑ…‘½Ìä¹½Ñ…Ì•á¥ÍÑ•¹Ñ•Ì¹€°¥¹½É•‘ÉÉ½È€ü€‰•ÉÉ½Èˆ€è€‰ÍÕ•ÍÌˆ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸±½…‘5…ÍÑ•ÉÁÁ½¥¹Ñµ•¹ÑÌ ¤ì(€½¹ÍÐ‘…Ñ”€ô€ ‰µ…ÍÑ•ÉÁÁ½¥¹Ñµ•¹Ñ…Ñ”ˆ¤¹Ù…±Õ”ñð…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”ì(€€ ‰µ…ÍÑ•ÉÁÁ½¥¹Ñµ•¹Ñ…Ñ”ˆ¤¹Ù…±Õ”€ô‘…Ñ”ì(€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}µ…ÍÑ•É}Ñ•…µ}…ÁÁ½¥¹Ñµ•¹ÑÌˆ°ìÁ}Ý½É­}‘…Ñ”è‘…Ñ”ô¤ì(€½¹ÍÐÑ…É•Ð€ô€ ‰µ…ÍÑ•ÉÁÁ½¥¹Ñµ•¹Ñ1¥ÍÐˆ¤ì(€Ñ…É•Ð¹É•Á±…•¡¥±‘É•¸ ¤ì(€¥˜€¡•ÉÉ½Èñð€…ÉÉ…ä¹¥ÍÉÉ…ä¡‘…Ñ„¤¤ìÑ…É•Ð¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰9¼Í”ÁÕ‘¼½¹ÍÕ±Ñ…È±„ÍÕÁ•ÉÙ¥Í§Í¸¸ˆìÉ•ÑÕÉ¸™…±Í”ìô(€¥˜€ …‘…Ñ„¹±•¹Ñ ¤ì½¹ÍÐ•µÁÑä€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰‘¥Øˆ¤ì•µÁÑä¹±…ÍÍ9…µ”€ô€‰…•¹‘„µ•µÁÑäˆì•µÁÑä¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰9¼¡…ä¥Ñ…Ì‘”•ÅÕ¥Á¼Á…É„•ÍÑ„™•¡„¸ˆìÑ…É•Ð¹…ÁÁ•¹¡•µÁÑä¤ìÉ•ÑÕÉ¸ÑÉÕ”ìô(€™½È€¡½¹ÍÐÉ½Ü½˜‘…Ñ„¤ì(€€€½¹ÍÐ¥Ñ•´€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰…ÉÑ¥±”ˆ¤ì¥Ñ•´¹±…ÍÍ9…µ”€ô€‰µ…ÍÑ•Èµ…ÁÁ½¥¹Ñµ•¹ÐµÉ½Üˆì(€€€½¹ÍÐ½¹Ñ•¹Ð€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰‘¥Øˆ¤ì(€€€½¹ÍÐÑ¥Ñ±”€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰ÍÑÉ½¹œˆ¤ìÑ¥Ñ±”¹Ñ•áÑ½¹Ñ•¹Ð€ô€‘íÉ½Ü¹Í¡•‘Õ±•‘}Ñ¥µ•ôƒ
Ü€‘íÉ½Ü¹Á½ÁÕ±…Ñ¥½¹ôƒ
Ü€‘íÉ½Ü¹Ñ•¡¹¥¥…¹õ€ì(€€€½¹ÍÐµ•Ñ„€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰ÍÁ…¸ˆ¤ìµ•Ñ„¹Ñ•áÑ½¹Ñ•¹Ð€ôAÉ½ÍÁ•Ñ¼è€‘íÉ½Ü¹ÁÉ½ÍÁ•Ñ}É•˜ñð€‹ŠP‰ôƒ
Ü€‘í¡Õµ…¹MÑ…ÑÕÌ¡É½Ü¹ÍÑ…ÑÕÌ¥õ€ì(€€€½¹Ñ•¹Ð¹…ÁÁ•¹¡Ñ¥Ñ±”°µ•Ñ„¤ì(€€€½¹ÍÐÍ¥‘”€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰‘¥Øˆ¤ì(€€€¥˜€¡É½Ü¹½¹Ñ…Ñ•‘}…Ð¤ì½¹ÍÐ½¹Ñ…Ð€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰ÍÁ…¸ˆ¤ì½¹Ñ…Ð¹±…ÍÍ9…µ”€ô€‰½¹Ñ…Ðµ‰…‘”ˆì½¹Ñ…Ð¹Ñ•áÑ½¹Ñ•¹Ð€ô]¡…ÑÍÁÀ…‰¥•ÉÑ¼ƒ
Ü€‘í¹•Ü…Ñ”¡É½Ü¹½¹Ñ…Ñ•‘}…Ð¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰•ÌµLˆ°ì¡½ÕÈè€ˆÈµ‘¥¥Ðˆ°µ¥¹ÕÑ”è€ˆÈµ‘¥¥Ðˆô¥õ€ìÍ¥‘”¹…ÁÁ•¹¡½¹Ñ…Ð¤ìô(€€€½¹ÍÐÕÁ‘…Ñ•€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰ÍÁ…¸ˆ¤ìÕÁ‘…Ñ•¹Ñ•áÑ½¹Ñ•¹Ð€ôÑÕ…±¥é…‘„€‘í¹•Ü…Ñ”¡É½Ü¹±…ÍÑ}ÕÁ‘…Ñ•‘}…Ð¤¹Ñ½1½…±•MÑÉ¥¹œ ‰•ÌµLˆ¥õ€ìÍ¥‘”¹…ÁÁ•¹¡ÕÁ‘…Ñ•¤ì(€€€¥Ñ•´¹…ÁÁ•¹¡½¹Ñ•¹Ð°Í¥‘”¤ìÑ…É•Ð¹…ÁÁ•¹¡¥Ñ•´¤ì(€ô(€É•ÑÕÉ¸ÑÉÕ”ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù•ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì¡•Ù•¹Ð¤ì(€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€½¹ÍÐ­•åÝ½É‘Ì€ô€ ‰¥¹ÍÑ…±±…Ñ¥½¹-•åÝ½É‘Ìˆ¤¹Ù…±Õ”¹ÍÁ±¥Ð ½qÈýq¸¼¤¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹ÑÉ¥´ ¤¹Ñ½1½…±•1½Ý•É…Í” ‰•ÌµLˆ¤¤¹™¥±Ñ•È¡	½½±•…¸¤ì(€½¹ÍÐì•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}Í…Ù•}µå}…ÁÁ½¥¹Ñµ•¹Ñ}ÁÉ•™•É•¹•Ìˆ°ì(€€€Á}¥¹ÍÑ…±±…Ñ¥½¹}­•åÝ½É‘Ìè­•åÝ½É‘Ì°(€€€Á}¥¹ÍÑ…±±…Ñ¥½¹}Ñ•µÁ±…Ñ”è€ ‰¥¹ÍÑ…±±…Ñ¥½¹Q•µÁ±…Ñ”ˆ¤¹Ù…±Õ”°(€€€Á}µ…¥¹Ñ•¹…¹•}Ñ•µÁ±…Ñ”è€ ‰µ…¥¹Ñ•¹…¹•Q•µÁ±…Ñ”ˆ¤¹Ù…±Õ”°(€€€Á}…¹•±±…Ñ¥½¹}Ñ•µÁ±…Ñ”è€ ‰…¹•±±…Ñ¥½¹Q•µÁ±…Ñ”ˆ¤¹Ù…±Õ”°(€€€Á}•µ…¥±}Ñ¼è€ ‰…¹•±µ…¥±Q¼ˆ¤¹Ù…±Õ”¹ÑÉ¥´ ¤°(€€€Á}•µ…¥±}Œè€ ‰…¹•±µ…¥±Œˆ¤¹Ù…±Õ”¹ÑÉ¥´ ¤°(€€€Á}•µ…¥±}ÍÕ‰©•Ðè€ ‰…¹•±µ…¥±MÕ‰©•Ðˆ¤¹Ù…±Õ”¹ÑÉ¥´ ¤°(€ô¤ì(€¥˜€¡•ÉÉ½È¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼Í”ÁÕ‘¥•É½¸Õ…É‘…È±½Ì…©ÕÍÑ•Ì¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€…Ý…¥Ð±½…‘ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì ¤ì(€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰©ÕÍÑ•ÌÁ•ÉÍ½¹…±•ÌÕ…É‘…‘½Ì¸ˆ°€‰ÍÕ•ÍÌˆ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸¡•­UÁ‘…Ñ” ¤ì(€ÑÉäì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð™•Ñ ¡€¸½¥¹‘•à¹¡Ñµ°ý¡•¬ô‘í…Ñ”¹¹½Ü ¥õ€°ì…¡”è€‰¹¼µÍÑ½É”ˆô¤ì(€€€¥˜€ …É•ÍÁ½¹Í”¹½¬¤Ñ¡É½Ü¹•ÜÉÉ½È ‰Ù•ÉÍ¥½¸¡•¬™…¥±•ˆ¤ì(€€€½¹ÍÐ¡Ñµ°€ô…Ý…¥ÐÉ•ÍÁ½¹Í”¹Ñ•áÐ ¤ì(€€€½¹ÍÐÁÕ‰±¥Í¡•€ô¡Ñµ°¹µ…Ñ  ¼ñµ•Ñ…qÌ­¹…µ”õlˆu…ÁÀµ‰Õ¥±‘lˆuqÌ­½¹Ñ•¹Ðõlˆt¡mxˆt¬¥lˆt½¤¤ü¹lÅt€üü€‰Í¥¸¥‘•¹Ñ¥™¥…Èˆì(€€€Ý¥¹‘½Ü¹…±•ÉÐ¡	Õ¥±ÁÕ‰±¥…‘„è€‘íÁÕ‰±¥Í¡•‘õq¹QÔ‰Õ¥±…ÑÕ…°è€‘íAA}	U%1õ€¤ì(€ô…Ñ ìÝ¥¹‘½Ü¹…±•ÉÐ ‰9¼Í”ÁÕ‘¼½µÁÉ½‰…È±„…ÑÕ…±¥é…§Í¸¸ˆ¤ìô)ô()™Õ¹Ñ¥½¸É•ÍÑ½É•XÅ•™…Õ±ÑÌ ¤ì(€€ ‰¥¹ÍÑ…±±…Ñ¥½¹Q•µÁ±…Ñ”ˆ¤¹Ù…±Õ”€ôU1Q}%9MQ11Q%=9}Q5A1Qì(€€ ‰µ…¥¹Ñ•¹…¹•Q•µÁ±…Ñ”ˆ¤¹Ù…±Õ”€ôU1Q}5%9Q99}Q5A1Qì(€€ ‰…¹•±±…Ñ¥½¹Q•µÁ±…Ñ”ˆ¤¹Ù…±Õ”€ôU1Q}911Q%=9}Q5A1Qì(€€ ‰…¹•±µ…¥±Q¼ˆ¤¹Ù…±Õ”€ôU1Q}91}Q<ì(€€ ‰…¹•±µ…¥±Œˆ¤¹Ù…±Õ”€ôU1Q}91}ì(€€ ‰…¹•±µ…¥±MÕ‰©•Ðˆ¤¹Ù…±Õ”€ô€‰±¥•¹Ñ”…¹•±„€´AÉ½ÍÁ•Ñ¼í5Q=ôˆì)ô()…Íå¹Œ™Õ¹Ñ¥½¸‘•±•Ñ•ÁÁ½¥¹Ñµ•¹Ñ…ä ¤ì(€¥˜€ …Ý¥¹‘½Ü¹½¹™¥É´¡ƒ
ý	½ÉÉ…ÈÑ½‘¼•°¡¥ÍÑ½É¥…°‘”€‘í™½Éµ…Ñ…Ñ•Q¥Ñ±”¡…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”¥ôüM”•±¥µ¥¹…Ë…¸¥Ñ…Ì°•ÍÑ…‘½Ì°½¹Ñ…Ñ½Ì°Ñ•³¥™½¹½Ì°‘¥É•¥½¹•Ì°¹½Ñ…Ìäµ½Ñ¥Ù½Ì‘”…¹•±…§Í¸‘”•Í”“µ„¹€¤¤É•ÑÕÉ¸ì(€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}‘•±•Ñ•}µå}…ÁÁ½¥¹Ñµ•¹Ñ}‘…äˆ°ìÁ}Ý½É­}‘…Ñ”è…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”ô¤ì(€¥˜€¡•ÉÉ½È¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼Í”ÁÕ‘¼‰½ÉÉ…È±„…•¹‘„‘”•Í”“µ„¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€¥µÁ½ÉÑ¡…¹•Í	åM½ÕÉ”¹±•…È ¤ì(€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥”¡M”•±¥µ¥¹…É½¸€‘í9Õµ‰•È¡‘…Ñ„¤ñð€Áô¥Ñ…Ì‘”ÑÔ…•¹‘„¹€°€‰ÍÕ•ÍÌˆ¤ì(€…Ý…¥Ð±½…‘=Ý¹ÁÁ½¥¹Ñµ•¹ÑÌ¡…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÁÕÉ•=±‘ÁÁ½¥¹Ñµ•¹ÑÌ ¤ì(€¥˜€ …Ý¥¹‘½Ü¹½¹™¥É´ ‹
ý	½ÉÉ…ÈÑ½‘…ÌÑÕÌ…•¹‘…Ì…¹Ñ•É¥½É•Ì„¡½äüÍÑ„…§Í¸•±¥µ¥¹„¥Ñ…Ì°•ÍÑ…‘½Ì°½¹Ñ…Ñ½Ì°Ñ•³¥™½¹½Ì°‘¥É•¥½¹•Ì°¹½Ñ…Ìäµ½Ñ¥Ù½Ì‘”…¹•±…§Í¸ä¹¼Í”ÁÕ•‘”‘•Í¡…•È¸ˆ¤¤É•ÑÕÉ¸ì(€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}ÁÕÉ•}µå}…ÁÁ½¥¹Ñµ•¹ÑÍ}‰•™½É•}Ñ½‘…äˆ¤ì(€¥˜€¡•ÉÉ½È¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼Í”ÁÕ‘¥•É½¸‰½ÉÉ…È±…Ì…•¹‘…Ì…¹Ñ•É¥½É•Ì¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€¥µÁ½ÉÑ¡…¹•Í	åM½ÕÉ”¹±•…È ¤ì(€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥”¡M”•±¥µ¥¹…É½¸€‘í9Õµ‰•È¡‘…Ñ„¤ñð€Áô¥Ñ…Ì…¹Ñ•É¥½É•Ì„¡½ä¹€°€‰ÍÕ•ÍÌˆ¤ì(€…Ý…¥Ð±½…‘=Ý¹ÁÁ½¥¹Ñµ•¹ÑÌ¡…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù•AÉ•Í•¹Ñ…Ñ¥½¹9…µ”¡•Ù•¹Ð¤ì(€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€½¹ÍÐÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”€ô€ ‰ÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”ˆ¤¹Ù…±Õ”¹ÑÉ¥´ ¤ì(€¥˜€ …ÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”ñðÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”¹±•¹Ñ €ø€ÄÈÀ¤ì(€€€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰ÍÉ¥‰”Õ¸¹½µ‰É”‘”ÁÉ•Í•¹Ñ…§Í¸‘”€Ä„€ÄÈÀ…É…Ñ•É•Ì¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€É•ÑÕÉ¸ì(€ô(€½¹ÍÐì•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}Í•Ñ}µå}ÁÉ•Í•¹Ñ…Ñ¥½¹}¹…µ”ˆ°ìÁ}ÁÉ•Í•¹Ñ…Ñ¥½¹}¹…µ”èÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”ô¤ì(€¥˜€¡•ÉÉ½È¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼Í”ÁÕ‘¼Õ…É‘…È•°¹½µ‰É”Á…É„±½Ìµ•¹Í…©•Ì¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€…Ñ¥Ù•AÉ½™¥±”¹ÁÉ•Í•¹Ñ…Ñ¥½¹}¹…µ”€ôÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”ì(€€ ‰ÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”ˆ¤¹Ù…±Õ”€ôÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”ì(€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9½µ‰É”Á…É„±½Ìµ•¹Í…©•Ì…ÑÕ…±¥é…‘¼¸ˆ°€‰ÍÕ•ÍÌˆ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸¥¹Ù½­•‘µ¥¸¡‰½‘ä¤ì(€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹™Õ¹Ñ¥½¹Ì¹¥¹Ù½­” ‰…‘µ¥¸µµ…¹…•µ•¹Ðˆ°ì‰½‘äô¤ì(€¥˜€¡•ÉÉ½Èñð‘…Ñ„ü¹•ÉÉ½È¤Ñ¡É½Ü¹•ÜÉÉ½È ‰…‘µ¥¸½Á•É…Ñ¥½¸™…¥±•ˆ¤ì(€É•ÑÕÉ¸‘…Ñ„ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•Í•Ñ½Õ¹ÑA…ÍÍÝ½É¡ÕÍ•É%°‘¥ÍÁ±…å9…µ”¤ì(€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹™Õ¹Ñ¥½¹Ì¹¥¹Ù½­” ‰É•Í•Ðµ…½Õ¹ÐµÁ…ÍÍÝ½Éˆ°ì(€€€‰½‘äèìÑ…É•Ñ}¥èÕÍ•É%ô°(€ô¤ì(€¥˜€¡•ÉÉ½Èñð‘…Ñ„ü¹•ÉÉ½Èñð€…‘…Ñ„ü¹Ñ•µÁ½É…Éå}Á…ÍÍÝ½É¤Ñ¡É½Ü¹•ÜÉÉ½È ‰É•Í•Ð™…¥±•ˆ¤ì(€½¹ÍÐÁ…ÍÍÝ½É€ô‘…Ñ„¹Ñ•µÁ½É…Éå}Á…ÍÍÝ½Éì(€‘…Ñ„¹Ñ•µÁ½É…Éå}Á…ÍÍÝ½É€ô€ˆˆì(€Ý¥¹‘½Ü¹…±•ÉÐ¡½¹ÑÉ…Í—Å„Ñ•µÁ½É…°Á…É„€‘í‘¥ÍÁ±…å9…µ•ôè€‘íÁ…ÍÍÝ½É‘õq¹q¹¹ÑË¥…±„Á•ÉÍ½¹…±µ•¹Ñ”¸1„Á•ÉÍ½¹„‘•‰•Ë„…µ‰¥…É±„…°¥¹¥¥…ÈÍ•Í§Í¸¹€¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸±½…‘‘µ¥¹A…¹•° ¤ì(€½¹ÍÐmÑ•…µÍI•ÍÕ±Ð°…½Õ¹ÑÍI•ÍÕ±Ð°Í•ÑÑ¥¹ÍI•ÍÕ±Ñt€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l(€€€ÍÕÁ…‰…Í”¹ÉÁŒ ‰}…‘µ¥¹}Ñ•…µ}±¥ÍÐˆ¤°(€€€ÍÕÁ…‰…Í”¹ÉÁŒ ‰}…‘µ¥¹}ÕÍ•É}‘¥É•Ñ½Éäˆ¤°(€€€ÍÕÁ…‰…Í”¹ÉÁŒ ‰}…‘µ¥¹}±½‰…±}Í•ÑÑ¥¹Ìˆ¤°(€t¤ì(€¥˜€¡Ñ•…µÍI•ÍÕ±Ð¹•ÉÉ½Èñð…½Õ¹ÑÍI•ÍÕ±Ð¹•ÉÉ½ÈñðÍ•ÑÑ¥¹ÍI•ÍÕ±Ð¹•ÉÉ½È¤ì(€€€¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…É…È±„¥¹™½Éµ…§Í¸…‘µ¥¹¥ÍÑÉ…Ñ¥Ù„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€É•ÑÕÉ¸™…±Í”ì(€ô(€Ñ•…µÍ½ÉÑ½È€ôÉÉ…ä¹¥ÍÉÉ…ä¡Ñ•…µÍI•ÍÕ±Ð¹‘…Ñ„¤€üÑ•…µÍI•ÍÕ±Ð¹‘…Ñ„€èmtì(€½¹ÍÐÑ•…µ1¥ÍÐ€ô€ ‰…‘µ¥¹Q•…µÌˆ¤ì(€Ñ•…µ1¥ÍÐ¹É•Á±…•¡¥±‘É•¸ ¤ì(€™½È€¡½¹ÍÐÑ•…´½˜Ñ•…µÍ½ÉÑ½È¤ì(€€€½¹ÍÐ…Ñ¥Ù”€ôÑ•…´¹…Ñ¥Ù”€ôôôÑÉÕ”ì(€€€Ñ•…µ1¥ÍÐ¹…ÁÁ•¹¡µ…­•½Õ¹Ñ…É (€€€€€ì‘¥ÍÁ±…å}¹…µ”èÑ•…´¹¹…µ”°É½±”è€‰Ñ•…´ˆ°ÍÑ…ÑÕÌè…Ñ¥Ù”€ü€‰Ñ¥Ù¼ˆ€è€‰%¹…Ñ¥Ù¼ˆô°(€€€€€mt°(€€€€€l(€€€€€€€ì(€€€€€€€€€±…‰•°è€‰‘¥Ñ…È¹½µ‰É”ˆ°(€€€€€€€€€ÉÕ¸è…Íå¹Œ€ ¤€ôøì(€€€€€€€€€€€½¹ÍÐ¹…µ”€ôÝ¥¹‘½Ü¹ÁÉ½µÁÐ ‰9½µ‰É”‘•°•ÅÕ¥Á¼ˆ°Ñ•…´¹¹…µ”¤ì(€€€€€€€€€€€¥˜€¡¹…µ”€ôôô¹Õ±°ñð€…¹…µ”¹ÑÉ¥´ ¤ñð¹…µ”¹ÑÉ¥´ ¤€ôôôÑ•…´¹¹…µ”¤É•ÑÕÉ¸ì(€€€€€€€€€€€ÑÉäì(€€€€€€€€€€€€€…Ý…¥Ð¥¹Ù½­•‘µ¥¸¡ì…Ñ¥½¸è€‰É•¹…µ•}Ñ•…´ˆ°Ñ•…µ}¥èÑ•…´¹¥°¹…µ”è¹…µ”¹ÑÉ¥´ ¤ô¤ì(€€€€€€€€€€€€€¹½Ñ¥™ä ‰9½µ‰É”‘•°•ÅÕ¥Á¼…ÑÕ…±¥é…‘¼¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€€€€€€€€€€€…Ý…¥Ð±½…‘‘µ¥¹A…¹•° ¤ì(€€€€€€€€€€€ô…Ñ ì¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…µ‰¥…È•°¹½µ‰É”‘•°•ÅÕ¥Á¼¸ˆ°€‰•ÉÉ½Èˆ¤ìô(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€€€ì(€€€€€€€€€±…‰•°è…Ñ¥Ù”€ü€‰•Í…Ñ¥Ù…È•ÅÕ¥Á¼ˆ€è€‰Ñ¥Ù…È•ÅÕ¥Á¼ˆ°(€€€€€€€€€ÉÕ¸è€ ¤€ôø¥¹Ù½­•‘µ¥¸¡ì…Ñ¥½¸è€‰Í•Ñ}Ñ•…µ}ÍÑ…ÑÕÌˆ°Ñ•…µ}¥èÑ•…´¹¥°…Ñ¥Ù”è€……Ñ¥Ù”ô¤(€€€€€€€€€€€€¹Ñ¡•¸¡±½…‘‘µ¥¹A…¹•°¤¹…Ñ   ¤€ôø¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…µ‰¥…È•°•ÍÑ…‘¼‘•°•ÅÕ¥Á¼¸ˆ°€‰•ÉÉ½Èˆ¤¤°(€€€€€€€ô°(€€€€€t°(€€€€¤¤ì(€ô(€¥˜€ …Ñ•…µÍ½ÉÑ½È¹±•¹Ñ ¤Ñ•…µ1¥ÍÐ¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰é¸¹¼¡…ä•ÅÕ¥Á½Ì¸ˆì(€½¹ÍÐ¡½¥•Ì€ô€ ‰Ñ•…µ¡½¥•Ìˆ¤ì(€¡½¥•Ì¹É•Á±…•¡¥±‘É•¸ ¤ì(€½¹ÍÐ±••¹€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰±••¹ˆ¤ì(€±••¹¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰ÅÕ¥Á½Ìˆì(€¡½¥•Ì¹…ÁÁ•¹¡±••¹¤ì(€½¹ÍÐ¡½¥•1¥ÍÐ€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰‘¥Øˆ¤ì(€¡½¥•1¥ÍÐ¹±…ÍÍ9…µ”€ô€‰Ñ•…´µ¡½¥•Ìˆì(€™½È€¡½¹ÍÐÑ•…´½˜Ñ•…µÍ½ÉÑ½È¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹…Ñ¥Ù”¤¤…‘‘Q•…µ=ÁÑ¥½¸¡¡½¥•1¥ÍÐ°Ñ•…´¤ì(€¥˜€ …¡½¥•1¥ÍÐ¹¡¥±‘±•µ•¹Ñ½Õ¹Ð¤ì(€€€½¹ÍÐ•µÁÑä€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰Àˆ¤ì(€€€•µÁÑä¹±…ÍÍ9…µ”€ô€‰µÕÑ•ˆì(€€€•µÁÑä¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰É•„ÁÉ¥µ•É¼Õ¸•ÅÕ¥Á¼¸ˆì(€€€¡½¥•1¥ÍÐ¹…ÁÁ•¹¡•µÁÑä¤ì(€ô(€¡½¥•Ì¹…ÁÁ•¹¡¡½¥•1¥ÍÐ¤ì(€¥˜€¡Í•ÑÑ¥¹ÍI•ÍÕ±Ð¹‘…Ñ„ü¹É•Ñ•¹Ñ¥½¹}‘…åÌ€„ô¹Õ±°¤ì(€€€€ ‰É•Ñ•¹Ñ¥½¹…åÌˆ¤¹Ù…±Õ”€ôMÑÉ¥¹œ¡Í•ÑÑ¥¹ÍI•ÍÕ±Ð¹‘…Ñ„¹É•Ñ•¹Ñ¥½¹}‘…åÌ¤ì(€ô((€½¹ÍÐÑ…É•Ð€ô€ ‰…‘µ¥¹½Õ¹ÑÌˆ¤ì(€Ñ…É•Ð¹É•Á±…•¡¥±‘É•¸ ¤ì(€½¹ÍÐ…½Õ¹ÑÌ€ôÉÉ…ä¹¥ÍÉÉ…ä¡…½Õ¹ÑÍI•ÍÕ±Ð¹‘…Ñ„¤€ü…½Õ¹ÑÍI•ÍÕ±Ð¹‘…Ñ„€èmtì(€™½È€¡½¹ÍÐÁÉ½™¥±”½˜…½Õ¹ÑÌ¤ì(€€€½¹ÍÐµ•µ‰•ÉÍ¡¥ÁÌ€ôÉÉ…ä¹¥ÍÉÉ…ä¡ÁÉ½™¥±”¹Ñ•…µÌ¤€üÁÉ½™¥±”¹Ñ•…µÌ€èmtì(€€€½¹ÍÐ¹…µ•Ì€ôµ•µ‰•ÉÍ¡¥ÁÌ¹µ…À ¡µ•µ‰•ÉÍ¡¥À¤€ôø€‘íµ•µ‰•ÉÍ¡¥À¹Ñ•…µ}¹…µ•ô€ ‘íµ•µ‰•ÉÍ¡¥À¹µ•µ‰•ÉÍ¡¥Á}ÍÑ…ÑÕÍô¥€¤ì(€€€½¹ÍÐ…Ñ¥½¹Ì€ômtì(€€€¥˜€¡ÁÉ½™¥±”¹É½±”€„ôô€‰…‘µ¥¸ˆ¤ì(€€€€€½¹ÍÐ¥Í¥Í…‰±•€ôÁÉ½™¥±”¹ÍÑ…ÑÕÌ€ôôô€‰‘¥Í…‰±•ˆì(€€€€€½¹ÍÐ…¹I•…Ñ¥Ù…Ñ”€ô¥Í¥Í…‰±•€˜˜€…ÁÉ½™¥±”¹µÕÍÑ}¡…¹•}Á…ÍÍÝ½É€˜˜	½½±•…¸¡ÁÉ½™¥±”¹…Ñ¥Ù…Ñ¥½¹}Ù•É¥™¥•‘}…Ð¤ì(€€€€€¥˜€ …¥Í¥Í…‰±•ñð…¹I•…Ñ¥Ù…Ñ”¤ì(€€€€€€€…Ñ¥½¹Ì¹ÁÕÍ ¡ì(€€€€€€€€€±…‰•°è…¹I•…Ñ¥Ù…Ñ”€ü€‰I•…Ñ¥Ù…ÈÕ•¹Ñ„ˆ€è€‰•Í…Ñ¥Ù…ÈÕ•¹Ñ„ˆ°(€€€€€€€€€ÉÕ¸è€ ¤€ôøÍ•Ñ‘µ¥¹½Õ¹ÑMÑ…ÑÕÌ¡ÁÉ½™¥±”¹ÕÍ•É}¥°¥Í¥Í…‰±•€ü€‰…Ñ¥Ù”ˆ€è€‰‘¥Í…‰±•ˆ¤°(€€€€€€€ô¤ì(€€€€€ô(€€€€€¥˜€ …¥Í¥Í…‰±•€˜˜l‰µ…ÍÑ•Èˆ°€‰Ñ•¡¹¥¥…¸‰t¹¥¹±Õ‘•Ì¡ÁÉ½™¥±”¹É½±”¤¤ì(€€€€€€€…Ñ¥½¹Ì¹ÁÕÍ ¡ì(€€€€€€€€€±…‰•°è€‰I•ÍÑ…‰±••È½¹ÑÉ…Í—Å„ˆ°(€€€€€€€€€ÉÕ¸è€ ¤€ôøÉ•Í•Ñ½Õ¹ÑA…ÍÍÝ½É¡ÁÉ½™¥±”¹ÕÍ•É}¥°ÁÉ½™¥±”¹‘¥ÍÁ±…å}¹…µ”¤(€€€€€€€€€€€€¹Ñ¡•¸  ¤€ôø±½…‘‘µ¥¹A…¹•° ¤¤(€€€€€€€€€€€€¹…Ñ   ¤€ôø¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼É•ÍÑ…‰±••È±„½¹ÑÉ…Í—Å„¸ˆ°€‰•ÉÉ½Èˆ¤¤°(€€€€€€€ô¤ì(€€€€€ô(€€€ô(€€€¥˜€¡ÁÉ½™¥±”¹É½±”€ôôô€‰µ…ÍÑ•Èˆ€˜˜ÁÉ½™¥±”¹ÍÑ…ÑÕÌ€ôôô€‰…Ñ¥Ù”ˆ€˜˜€…ÁÉ½™¥±”¹µÕÍÑ}¡…¹•}Á…ÍÍÝ½É¤ì(€€€€€™½È€¡½¹ÍÐÑ•…´½˜Ñ•…µÍ½ÉÑ½È¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹…Ñ¥Ù”¤¤ì(€€€€€€€½¹ÍÐµ•µ‰•È€ôµ•µ‰•ÉÍ¡¥ÁÌ¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹Ñ•…µ}¥€ôôôÑ•…´¹¥¤ì(€€€€€€€½¹ÍÐ•¹…‰±•€ôµ•µ‰•Èü¹µ•µ‰•ÉÍ¡¥Á}ÍÑ…ÑÕÌ€ôôô€‰…Ñ¥Ù”ˆì(€€€€€€€…Ñ¥½¹Ì¹ÁÕÍ ¡ì(€€€€€€€€€±…‰•°è€‘í•¹…‰±•€ü€‰EÕ¥Ñ…Èˆ€è€‰Í¥¹…È‰ôè€‘íÑ•…´¹¹…µ•õ€°(€€€€€€€€€ÉÕ¸è€ ¤€ôø¥¹Ù½­•‘µ¥¸¡ì…Ñ¥½¸è€‰Í•Ñ}µ…ÍÑ•É}Ñ•…´ˆ°µ…ÍÑ•É}¥èÁÉ½™¥±”¹ÕÍ•É}¥°Ñ•…µ}¥èÑ•…´¹¥°…Ñ¥Ù”è€…•¹…‰±•ô¤(€€€€€€€€€€€€¹Ñ¡•¸¡±½…‘‘µ¥¹A…¹•°¤¹…Ñ   ¤€ôø¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…µ‰¥…È±„…Í¥¹…§Í¸‘•°5…ÍÑ•È¸ˆ°€‰•ÉÉ½Èˆ¤¤°(€€€€€€€ô¤ì(€€€€€ô(€€€ô(€€€¥˜€¡ÁÉ½™¥±”¹É½±”€ôôô€‰Ñ•¡¹¥¥…¸ˆ€˜˜ÁÉ½™¥±”¹ÍÑ…ÑÕÌ€„ôô€‰‘¥Í…‰±•ˆ¤ì(€€€€€™½È€¡½¹ÍÐÑ•…´½˜Ñ•…µÍ½ÉÑ½È¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹…Ñ¥Ù”¤¤ì(€€€€€€€½¹ÍÐµ•µ‰•ÉÍ¡¥À€ôµ•µ‰•ÉÍ¡¥ÁÌ¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹Ñ•…µ}¥€ôôôÑ•…´¹¥¤ì(€€€€€€€½¹ÍÐ•¹…‰±•€ôµ•µ‰•ÉÍ¡¥Àü¹µ•µ‰•ÉÍ¡¥Á}ÍÑ…ÑÕÌ€ôôô€‰…Ñ¥Ù”ˆì(€€€€€€€…Ñ¥½¹Ì¹ÁÕÍ ¡ì(€€€€€€€€€±…‰•°èµ•µ‰•ÉÍ¡¥À€ü€‘í•¹…‰±•€ü€‰EÕ¥Ñ…Èˆ€è€‰Í¥¹…È‰ôè€‘íÑ•…´¹¹…µ•õ€€èÍ¥¹…Èè€‘íÑ•…´¹¹…µ•õ€°(€€€€€€€€€ÉÕ¸è€ ¤€ôøÍ•Ñ‘µ¥¹Q•¡¹¥¥…¹Q•…´¡Ñ•…´¹¥°ÁÉ½™¥±”¹ÕÍ•É}¥°€…•¹…‰±•¤°(€€€€€€€ô¤ì(€€€€€ô(€€€ô(€€€Ñ…É•Ð¹…ÁÁ•¹¡µ…­•½Õ¹Ñ…É¡ÁÉ½™¥±”°¹…µ•Ì°…Ñ¥½¹Ì¤¤ì(€ô(€¥˜€ ……½Õ¹ÑÌ¹±•¹Ñ ¤Ñ…É•Ð¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰é¸¹¼¡…äÕ•¹Ñ…Ì‘”•ÅÕ¥Á¼¸ˆì(€É•ÑÕÉ¸ÑÉÕ”ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•Ñ‘µ¥¹½Õ¹ÑMÑ…ÑÕÌ¡ÕÍ•É%°ÍÑ…ÑÕÌ¤ì(€ÑÉäì(€€€…Ý…¥Ð¥¹Ù½­•‘µ¥¸¡ì…Ñ¥½¸è€‰Í•Ñ}…½Õ¹Ñ}ÍÑ…ÑÕÌˆ°Ñ…É•Ñ}¥èÕÍ•É%°ÍÑ…ÑÕÌô¤ì(€€€¹½Ñ¥™ä ‰ÍÑ…‘¼‘”±„Õ•¹Ñ„…ÑÕ…±¥é…‘¼¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€…Ý…¥Ð±½…‘‘µ¥¹A…¹•° ¤ì(€ô…Ñ ì(€€€¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…µ‰¥…È•°•ÍÑ…‘¼‘”±„Õ•¹Ñ„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•Ñ‘µ¥¹Q•¡¹¥¥…¹Q•…´¡Ñ•…µ%°Ñ•¡¹¥¥…¹%°…Ñ¥Ù”¤ì(€½¹ÍÐì•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}µ…¹…•}Ñ•¡¹¥¥…¹}µ•µ‰•ÉÍ¡¥Àˆ°ì(€€€Á}Ñ•…µ}¥èÑ•…µ%°Á}Ñ•¡¹¥¥…¹}¥èÑ•¡¹¥¥…¹%°Á}…Ñ¥Ù”è…Ñ¥Ù”°(€ô¤ì(€¥˜€¡•ÉÉ½È¤¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…µ‰¥…È±„…Í¥¹…§Í¸‘•°Ó¥¹¥¼¸ˆ°€‰•ÉÉ½Èˆ¤ì(€•±Í”ì(€€€¹½Ñ¥™ä ‰Í¥¹…§Í¸‘•°Ó¥¹¥¼…ÑÕ…±¥é…‘„¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€…Ý…¥Ð±½…‘‘µ¥¹A…¹•° ¤ì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸±½…‘5…ÍÑ•ÉA…¹•° ¤ì(€½¹ÍÐmÑ•…µÍI•ÍÕ±Ð°…½Õ¹ÑÍI•ÍÕ±Ñt€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l(€€€ÍÕÁ…‰…Í”¹ÉÁŒ ‰}µ…ÍÑ•É}Ñ•…µ}±¥ÍÐˆ¤°(€€€ÍÕÁ…‰…Í”¹ÉÁŒ ‰}µ…ÍÑ•É}Ñ•…µ}…½Õ¹ÑÌˆ¤°(€t¤ì(€¥˜€¡Ñ•…µÍI•ÍÕ±Ð¹•ÉÉ½Èñð…½Õ¹ÑÍI•ÍÕ±Ð¹•ÉÉ½È¤ì(€€€¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…É…È±„¥¹™½Éµ…§Í¸‘”ÑÔ•ÅÕ¥Á¼¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€É•ÑÕÉ¸™…±Í”ì(€ô(€Ñ•…µÍ½ÉÑ½È€ôÉÉ…ä¹¥ÍÉÉ…ä¡Ñ•…µÍI•ÍÕ±Ð¹‘…Ñ„¤€üÑ•…µÍI•ÍÕ±Ð¹‘…Ñ„€èmtì(€½¹ÍÐ¡¥ÁÌ€ô€ ‰µ…ÍÑ•ÉQ•…µÌˆ¤ì(€¡¥ÁÌ¹É•Á±…•¡¥±‘É•¸ ¤ì(€™½È€¡½¹ÍÐÑ•…´½˜Ñ•…µÍ½ÉÑ½È¤ì(€€€½¹ÍÐ¡¥À€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰ÍÁ…¸ˆ¤ì(€€€¡¥À¹±…ÍÍ9…µ”€ô€‰Ñ•…´µ¡¥Àˆì(€€€¡¥À¹Ñ•áÑ½¹Ñ•¹Ð€ôÑ•…´¹¹…µ”ì(€€€¡¥ÁÌ¹…ÁÁ•¹¡¡¥À¤ì(€ô(€½¹ÍÐÍ•±•Ð€ô€ ‰µ…ÍÑ•ÉQ•…µM•±•Ðˆ¤ì(€Í•±•Ð¹É•Á±…•¡¥±‘É•¸ ¤ì(€™½È€¡½¹ÍÐÑ•…´½˜Ñ•…µÍ½ÉÑ½È¤ì(€€€½¹ÍÐ½ÁÑ¥½¸€ô‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‰½ÁÑ¥½¸ˆ¤ì(€€€½ÁÑ¥½¸¹Ù…±Õ”€ôÑ•…´¹¥ì(€€€½ÁÑ¥½¸¹Ñ•áÑ½¹Ñ•¹Ð€ôÑ•…´¹¹…µ”ì(€€€Í•±•Ð¹…ÁÁ•¹¡½ÁÑ¥½¸¤ì(€ô(€½¹ÍÐ…½Õ¹ÑQ…É•Ð€ô€ ‰µ…ÍÑ•É½Õ¹ÑÌˆ¤ì(€…½Õ¹ÑQ…É•Ð¹É•Á±…•¡¥±‘É•¸ ¤ì(€½¹ÍÐÑ•…µ9…µ•Ì€ô¹•Ü5…À¡Ñ•…µÍ½ÉÑ½È¹µ…À ¡Ñ•…´¤€ôømÑ•…´¹¥°Ñ•…´¹¹…µ•t¤¤ì(€™½È€¡½¹ÍÐÁÉ½™¥±”½˜€¡ÉÉ…ä¹¥ÍÉÉ…ä¡…½Õ¹ÑÍI•ÍÕ±Ð¹‘…Ñ„¤€ü…½Õ¹ÑÍI•ÍÕ±Ð¹‘…Ñ„€èmt¤¤ì(€€€½¹ÍÐÑ•…µ9…µ”€ôÑ•…µ9…µ•Ì¹•Ð¡ÁÉ½™¥±”¹Ñ•…µ}¥¤€üü€‰ÅÕ¥Á¼ˆì(€€€½¹ÍÐ…Ñ¥½¹Ì€ômtì(€€€¥˜€¡ÁÉ½™¥±”¹…½Õ¹Ñ}ÍÑ…ÑÕÌ€„ôô€‰‘¥Í…‰±•ˆ¤ì(€€€€€½¹ÍÐ…Ñ¥Ù”€ôÁÉ½™¥±”¹µ•µ‰•ÉÍ¡¥Á}ÍÑ…ÑÕÌ€ôôô€‰…Ñ¥Ù”ˆì(€€€€€…Ñ¥½¹Ì¹ÁÕÍ ¡ì(€€€€€€€±…‰•°è…Ñ¥Ù”€ü€‰•Í…Ñ¥Ù…È•¸•°•ÅÕ¥Á¼ˆ€è€‰Ñ¥Ù…È•¸•°•ÅÕ¥Á¼ˆ°(€€€€€€€ÉÕ¸è€ ¤€ôøÍ•Ñ5…ÍÑ•É5•µ‰•ÉÍ¡¥À¡ÁÉ½™¥±”¹Ñ•…µ}¥°ÁÉ½™¥±”¹Ñ•¡¹¥¥…¹}¥°€……Ñ¥Ù”¤°(€€€€€ô¤ì(€€€€€¥˜€¡ÁÉ½™¥±”¹µ•µ‰•ÉÍ¡¥Á}ÍÑ…ÑÕÌ€ôôô€‰…Ñ¥Ù”ˆ¤ì(€€€€€€€…Ñ¥½¹Ì¹ÁÕÍ ¡ì(€€€€€€€€€±…‰•°è€‰I•ÍÑ…‰±••È½¹ÑÉ…Í—Å„ˆ°(€€€€€€€€€ÉÕ¸è€ ¤€ôøÉ•Í•Ñ½Õ¹ÑA…ÍÍÝ½É¡ÁÉ½™¥±”¹Ñ•¡¹¥¥…¹}¥°ÁÉ½™¥±”¹‘¥ÍÁ±…å}¹…µ”¤(€€€€€€€€€€€€¹Ñ¡•¸  ¤€ôø±½…‘5…ÍÑ•ÉA…¹•° ¤¤(€€€€€€€€€€€€¹…Ñ   ¤€ôø¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼É•ÍÑ…‰±••È±„½¹ÑÉ…Í—Å„¸ˆ°€‰•ÉÉ½Èˆ¤¤°(€€€€€€€ô¤ì(€€€€€ô(€€€ô(€€€…½Õ¹ÑQ…É•Ð¹…ÁÁ•¹¡µ…­•½Õ¹Ñ…É¡ì(€€€€€‘¥ÍÁ±…å}¹…µ”èÁÉ½™¥±”¹‘¥ÍÁ±…å}¹…µ”°(€€€€€É½±”è€‰Ñ•¡¹¥¥…¸ˆ°(€€€€€ÍÑ…ÑÕÌè€‘íÁÉ½™¥±”¹…½Õ¹Ñ}ÍÑ…ÑÕÍôƒ
Ü•ÅÕ¥Á¼€‘íÁÉ½™¥±”¹µ•µ‰•ÉÍ¡¥Á}ÍÑ…ÑÕÍõ€°(€€€€€µÕÍÑ}¡…¹•}Á…ÍÍÝ½ÉèÁÉ½™¥±”¹µÕÍÑ}¡…¹•}Á…ÍÍÝ½É°(€€€ô°mÑ•…µ9…µ•t°…Ñ¥½¹Ì¤¤ì(€ô(€¥˜€ ……½Õ¹ÑQ…É•Ð¹¡¥±‘±•µ•¹Ñ½Õ¹Ð¤…½Õ¹ÑQ…É•Ð¹Ñ•áÑ½¹Ñ•¹Ð€ô€‰9¼¡…äÓ¥¹¥½Ì…Í¥¹…‘½ÌÑ½‘…Ûµ„¸ˆì(€É•ÑÕÉ¸ÑÉÕ”ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í•Ñ5…ÍÑ•É5•µ‰•ÉÍ¡¥À¡Ñ•…µ%°Ñ•¡¹¥¥…¹%°…Ñ¥Ù”¤ì(€½¹ÍÐì•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹ÉÁŒ ‰}µ…¹…•}Ñ•¡¹¥¥…¹}µ•µ‰•ÉÍ¡¥Àˆ°ì(€€€Á}Ñ•…µ}¥èÑ•…µ%°Á}Ñ•¡¹¥¥…¹}¥èÑ•¡¹¥¥…¹%°Á}…Ñ¥Ù”è…Ñ¥Ù”°(€ô¤ì(€¥˜€¡•ÉÉ½È¤¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…µ‰¥…È•°…•Í¼‘•°Ó¥¹¥¼…°•ÅÕ¥Á¼¸ˆ°€‰•ÉÉ½Èˆ¤ì(€•±Í”ì(€€€¹½Ñ¥™ä ‰•Í¼‘•°Ó¥¹¥¼…ÑÕ…±¥é…‘¼¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€…Ý…¥Ð±½…‘5…ÍÑ•ÉA…¹•° ¤ì(€ô)ô()…Íå¹Œ™Õ¹Ñ¥½¸É•…Ñ•½Õ¹Ð¡™½Éµ…Ñ„°É½±”°Ñ•…µ%‘Ì¤ì(€½¹ÍÐÁ…å±½…€ôì(€€€•µÁ±½å••}¥è™½Éµ…Ñ„¹•µÁ±½å••}¥°(€€€‘¥ÍÁ±…å}¹…µ”è™½Éµ…Ñ„¹‘¥ÍÁ±…å}¹…µ”°(€€€ÁÉ•Í•¹Ñ…Ñ¥½¹}¹…µ”è™½Éµ…Ñ„¹ÁÉ•Í•¹Ñ…Ñ¥½¹}¹…µ”°(€€€É½±”°(€€€Ñ•…µ}¥‘ÌèÑ•…µ%‘Ì°(€ôì(€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹™Õ¹Ñ¥½¹Ì¹¥¹Ù½­” ‰ÁÉ½Ù¥Í¥½¸µ…½Õ¹Ðˆ°ì‰½‘äèÁ…å±½…ô¤ì(€¥˜€¡•ÉÉ½Èñð‘…Ñ„ü¹•ÉÉ½È¤Ñ¡É½Ü¹•ÜÉÉ½È ‰ÁÉ½Ù¥Í¥½¸™…¥±•ˆ¤ì(€É•ÑÕÉ¸‘…Ñ„ì)ô()™Õ¹Ñ¥½¸‰¥¹‘Ù•¹ÑÌ ¤ì(€€ ‰±½¥¹½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€±•…É9½Ñ¥” ¤ì(€€€½¹ÍÐ•µÁ±½å••%€ô€ ‰•µÁ±½å••%ˆ¤¹Ù…±Õ”ì(€€€½¹ÍÐÁ…ÍÍÝ½É€ô€ ‰Á…ÍÍÝ½Éˆ¤¹Ù…±Õ”ì(€€€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹™Õ¹Ñ¥½¹Ì¹¥¹Ù½­” ‰±½¥¸µ‰äµµ…ÑÉ¥Õ±„ˆ°ì(€€€€€‰½‘äèì±½¥¹}¥è•µÁ±½å••%°Á…ÍÍÝ½Éô°(€€€ô¤ì(€€€€ ‰Á…ÍÍÝ½Éˆ¤¹Ù…±Õ”€ô€ˆˆì(€€€¥˜€¡•ÉÉ½Èñð‘…Ñ„ü¹•ÉÉ½Èñð€…‘…Ñ„ü¹Í•ÍÍ¥½¸¤ì(€€€€€¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼¥¹¥¥…ÈÍ•Í§Í¸¸½µÁÉÕ•‰„±½Ì‘…Ñ½Ì¼½¹Ñ…Ñ„½¸•°…‘µ¥¹¥ÍÑÉ…‘½È¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€½¹ÍÐì•ÉÉ½ÈèÍ•ÍÍ¥½¹ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹…ÕÑ ¹Í•ÑM•ÍÍ¥½¸¡‘…Ñ„¹Í•ÍÍ¥½¸¤ì(€€€¥˜€¡Í•ÍÍ¥½¹ÉÉ½È¤¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼¥¹¥¥…ÈÍ•Í§Í¸¸½µÁÉÕ•‰„±½Ì‘…Ñ½Ì¼½¹Ñ…Ñ„½¸•°…‘µ¥¹¥ÍÑÉ…‘½È¸ˆ°€‰•ÉÉ½Èˆ¤ì(€ô¤ì(€€ ‰…Ñ¥Ù…Ñ¥½¹½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€½¹ÍÐ•µÁ±½å••%€ô€ ‰…Ñ¥Ù…Ñ¥½¹µÁ±½å••%ˆ¤¹Ù…±Õ”ì(€€€½¹ÍÐÁ…ÍÍÝ½É€ô€ ‰…Ñ¥Ù…Ñ¥½¹A…ÍÍÝ½Éˆ¤¹Ù…±Õ”ì(€€€¥˜€¡Á…ÍÍÝ½É€„ôô€ ‰…Ñ¥Ù…Ñ¥½¹A…ÍÍÝ½ÉÈˆ¤¹Ù…±Õ”ñð€…Á…ÍÍÝ½É‘=­…ä¡Á…ÍÍÝ½É°•µÁ±½å••%¤¤ì(€€€€€¹½Ñ¥™ä ‰UÍ„Õ¹„½¹ÑÉ…Í—Å„Á•ÉÍ½¹…°‘”…°µ•¹½Ì€Ø…É…Ñ•É•Ì°‘¥ÍÑ¥¹Ñ„‘•°ÕÍÕ…É¥¼°äÉ•ÃµÑ•±„½ÉÉ•Ñ…µ•¹Ñ”¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€½¹ÍÐì‘…Ñ„°•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹™Õ¹Ñ¥½¹Ì¹¥¹Ù½­” ‰½µÁ±•Ñ”µ…½Õ¹Ðµ…Ñ¥Ù…Ñ¥½¸ˆ°ì(€€€€€‰½‘äèì•µÁ±½å••}¥è•µÁ±½å••%°Á…ÍÍÝ½Éô°(€€€ô¤ì(€€€€ ‰…Ñ¥Ù…Ñ¥½¹A…ÍÍÝ½Éˆ¤¹Ù…±Õ”€ô€ˆˆì(€€€€ ‰…Ñ¥Ù…Ñ¥½¹A…ÍÍÝ½ÉÈˆ¤¹Ù…±Õ”€ô€ˆˆì(€€€¥˜€¡•ÉÉ½Èñð‘…Ñ„ü¹•ÉÉ½Èñð€…‘…Ñ„ü¹…Ñ¥Ù…Ñ•¤ì(€€€€€¹½Ñ¥™ä ‰1„Õ•¹Ñ„Í¥Õ”‰±½ÅÕ•…‘„¸½µÁÉÕ•‰„±„µ…ÑËµÕ±„äÙÕ•±Ù”„½µÁ±•Ñ…È±„…Ñ¥Ù…§Í¸¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€¥˜€¡‘…Ñ„¹Í•ÍÍ¥½¸¤…Ý…¥ÐÍÕÁ…‰…Í”¹…ÕÑ ¹Í•ÑM•ÍÍ¥½¸¡‘…Ñ„¹Í•ÍÍ¥½¸¤ì(€€€•±Í”…Ý…¥ÐÍÕÁ…‰…Í”¹…ÕÑ ¹Í¥¹=ÕÐ ¤ì(€€€…Ý…¥ÐÉ½ÕÑ•M•ÍÍ¥½¸ ¤ì(€€€¹½Ñ¥™ä¡‘…Ñ„¹É•ÅÕ¥É•Í1½¥¸€ü€‰½¹ÑÉ…Í—Å„…ÑÕ…±¥é…‘„¸%¹¥¥„Í•Í§Í¸‘”¹Õ•Ù¼¸ˆ€è€‰½¹ÑÉ…Í—Å„…ÑÕ…±¥é…‘„¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€ô¤ì(€€ ‰¡…¹•A…ÍÍÝ½É‘½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€½¹ÍÐ•µÁ±½å••%€ô…Ñ¥Ù•AÉ½™¥±”ü¹É½±”€ôôô€‰…‘µ¥¸ˆ€ü€‰…‘µ¥¸ˆ€è€ ‰¡…¹•µÁ±½å••%ˆ¤¹Ù…±Õ”ì(€€€½¹ÍÐÕÉÉ•¹ÑA…ÍÍÝ½É€ô€ ‰ÕÉÉ•¹ÑA…ÍÍÝ½Éˆ¤¹Ù…±Õ”ì(€€€½¹ÍÐ¹•ÝA…ÍÍÝ½É€ô€ ‰¹•ÝA…ÍÍÝ½Éˆ¤¹Ù…±Õ”ì(€€€¥˜€¡¹•ÝA…ÍÍÝ½É€„ôô€ ‰¹•ÝA…ÍÍÝ½ÉÈˆ¤¹Ù…±Õ”ñð€…Á…ÍÍÝ½É‘=­…ä¡¹•ÝA…ÍÍÝ½É°•µÁ±½å••%¤¤ì(€€€€€¹½Ñ¥™ä ‰1„½¹ÑÉ…Í—Å„¹Õ•Ù„‘•‰”Ñ•¹•È…°µ•¹½Ì€Ø…É…Ñ•É•Ì°Í•È‘¥ÍÑ¥¹Ñ„‘•°ÕÍÕ…É¥¼ä½¥¹¥‘¥È•¸…µ‰½Ì…µÁ½Ì¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€½¹ÍÐì‘…Ñ„°•ÉÉ½ÈèÕÁ‘…Ñ•ÉÉ½Èô€ô…Ý…¥ÐÍÕÁ…‰…Í”¹™Õ¹Ñ¥½¹Ì¹¥¹Ù½­” ‰…½Õ¹ÐµÁ…ÍÍÝ½Éˆ°ì(€€€€€‰½‘äèì(€€€€€€€µ½‘”è€‰¡…¹”ˆ°±½¥¹}¥è…Ñ¥Ù•AÉ½™¥±”ü¹É½±”€ôôô€‰…‘µ¥¸ˆ€ü€‰…‘µ¥¸ˆ€è•µÁ±½å••%°(€€€€€€€ÕÉÉ•¹Ñ}Á…ÍÍÝ½ÉèÕÉÉ•¹ÑA…ÍÍÝ½É°¹•Ý}Á…ÍÍÝ½Éè¹•ÝA…ÍÍÝ½É°(€€€€€ô°(€€€ô¤ì(€€€€ ‰ÕÉÉ•¹ÑA…ÍÍÝ½Éˆ¤¹Ù…±Õ”€ô€ˆˆì(€€€€ ‰¹•ÝA…ÍÍÝ½Éˆ¤¹Ù…±Õ”€ô€ˆˆì(€€€€ ‰¹•ÝA…ÍÍÝ½ÉÈˆ¤¹Ù…±Õ”€ô€ˆˆì(€€€¥˜€¡ÕÁ‘…Ñ•ÉÉ½È¤¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…ÑÕ…±¥é…È±„½¹ÑÉ…Í—Å„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€•±Í”¥˜€¡‘…Ñ„ü¹Í•ÍÍ¥½¸¤ì(€€€€€…Ý…¥ÐÍÕÁ…‰…Í”¹…ÕÑ ¹Í•ÑM•ÍÍ¥½¸¡‘…Ñ„¹Í•ÍÍ¥½¸¤ì(€€€€€¹½Ñ¥™ä ‰½¹ÑÉ…Í—Å„…ÑÕ…±¥é…‘„¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€ô•±Í”ì(€€€€€…Ý…¥ÐÍÕÁ…‰…Í”¹…ÕÑ ¹Í¥¹=ÕÐ ¤ì(€€€€€¹½Ñ¥™ä ‰½¹ÑÉ…Í—Å„…ÑÕ…±¥é…‘„¸%¹¥¥„Í•Í§Í¸‘”¹Õ•Ù¼¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€ô(€ô¤ì(€€ ‰Í•ÕÉ¥ÑåQ½±”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ•ÑY¥Í¥‰±” ‰Í•ÕÉ¥ÑåA…¹•°ˆ°€ ‰Í•ÕÉ¥ÑåA…¹•°ˆ¤¹±…ÍÍ1¥ÍÐ¹½¹Ñ…¥¹Ì ‰¡¥‘‘•¸ˆ¤¤¤ì(€€ ‰Í¥¹=ÕÐˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì(€€€…Ý…¥ÐÍÕÁ…‰…Í”¹…ÕÑ ¹Í¥¹=ÕÐ ¤ì(€€€…Ý…¥ÐÉ½ÕÑ•M•ÍÍ¥½¸ ¤ì(€ô¤ì(€€ ‰µ…ÍÑ•É=Ý¹Q…ˆˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ•Ñ5…ÍÑ•ÉY¥•Ü ‰…ÁÁ½¥¹Ñµ•¹ÑÌˆ¤¤ì(€€ ‰µ…ÍÑ•ÉQ•…µQ…ˆˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøì(€€€Í•Ñ5…ÍÑ•ÉY¥•Ü ‰Ñ•…´ˆ¤ì(€€€Ù½¥±½…‘5…ÍÑ•ÉÁÁ½¥¹Ñµ•¹ÑÌ ¤ì(€ô¤ì(€€ ‰…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°€ ¤€ôøÙ½¥Í•±•ÑÁÁ½¥¹Ñµ•¹Ñ…Ñ”  ‰…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”ˆ¤¹Ù…±Õ”¤¤ì(€€ ‰…ÁÁ½¥¹Ñµ•¹ÑQ•…´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°€ ¤€ôøìÍ•±•Ñ•‘ÁÁ½¥¹Ñµ•¹ÑQ•…´€ô€ ‰…ÁÁ½¥¹Ñµ•¹ÑQ•…´ˆ¤¹Ù…±Õ”ìô¤ì(€€ ‰É•±½…‘ÁÁ½¥¹Ñµ•¹ÑÌˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÙ½¥±½…‘=Ý¹ÁÁ½¥¹Ñµ•¹ÑÌ  ‰…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”ˆ¤¹Ù…±Õ”¤¤ì(€€ ‰¥µÁ½ÉÑ±¥Á‰½…Éˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì(€€€ÑÉäì(€€€€€½¹ÍÐÑ•áÐ€ô…Ý…¥Ð¹…Ù¥…Ñ½È¹±¥Á‰½…É¹É•…‘Q•áÐ ¤ì(€€€€€¥˜€ …Ñ•áÐ¹ÑÉ¥´ ¤¤ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰°Á½ÉÑ…Á…Á•±•Ì•ÍÓ„Ù…µ¼¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€€€€€€ ‰½É…±•Q•áÐˆ¤¹Ù…±Õ”€ôÑ•áÐì(€€€€€…Ý…¥ÐÁÉ½•ÍÍ=É…±•Q•áÐ ¤ì(€€€ô…Ñ ì(€€€€€Í•ÑY¥Í¥‰±” ‰µ…¹Õ…±%µÁ½ÉÐˆ°ÑÉÕ”¤ì(€€€€€…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰°¹…Ù•…‘½È¹¼Á•Éµ¥Ñ§Ì±••È•°Á½ÉÑ…Á…Á•±•Ì¸A•„•°Ñ•áÑ¼µ…¹Õ…±µ•¹Ñ”¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€ô(€ô¤ì(€€ ‰µ…¹Õ…±Q½±”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ•ÑY¥Í¥‰±” ‰µ…¹Õ…±%µÁ½ÉÐˆ°€ ‰µ…¹Õ…±%µÁ½ÉÐˆ¤¹±…ÍÍ1¥ÍÐ¹½¹Ñ…¥¹Ì ‰¡¥‘‘•¸ˆ¤¤¤ì(€€ ‰ÁÉ½•ÍÍ=É…±”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÙ½¥ÁÉ½•ÍÍ=É…±•Q•áÐ ¤¤ì(€€ ‰Á…ÍÑ•=É…±”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì(€€€ÑÉäì€ ‰½É…±•Q•áÐˆ¤¹Ù…±Õ”€ô…Ý…¥Ð¹…Ù¥…Ñ½È¹±¥Á‰½…É¹É•…‘Q•áÐ ¤ìô(€€€…Ñ ì…ÁÁ½¥¹Ñµ•¹Ñ9½Ñ¥” ‰9¼Í”ÁÕ‘¼±••È•°Á½ÉÑ…Á…Á•±•Ì¸5…¹Ó¥¸ÁÕ±Í…‘¼•¸•°Õ…‘É¼ä•±¥”A•…È¸ˆ°€‰•ÉÉ½Èˆ¤ìô(€ô¤ì(€€ ‰ÁÉ•™•É•¹•ÍQ½±”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ•ÑY¥Í¥‰±” ‰…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ìˆ°€ ‰…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ìˆ¤¹±…ÍÍ1¥ÍÐ¹½¹Ñ…¥¹Ì ‰¡¥‘‘•¸ˆ¤¤¤ì(€€ ‰…ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ìˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°Í…Ù•ÁÁ½¥¹Ñµ•¹ÑAÉ•™•É•¹•Ì¤ì(€€ ‰É•ÍÑ½É•%¹ÍÑ…±±…Ñ¥½¹Q•µÁ±…Ñ”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøì€ ‰¥¹ÍÑ…±±…Ñ¥½¹Q•µÁ±…Ñ”ˆ¤¹Ù…±Õ”€ôU1Q}%9MQ11Q%=9}Q5A1Qìô¤ì(€€ ‰É•ÍÑ½É•…¹•±±…Ñ¥½¹•™…Õ±ÑÌˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°É•ÍÑ½É•XÅ•™…Õ±ÑÌ¤ì(€€ ‰¡•­UÁ‘…Ñ”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°¡•­UÁ‘…Ñ”¤ì(€€ ‰‘•±•Ñ••¹‘……äˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÙ½¥‘•±•Ñ•ÁÁ½¥¹Ñµ•¹Ñ…ä ¤¤ì(€€ ‰ÁÕÉ•=±‘•¹‘…Ìˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÙ½¥ÁÕÉ•=±‘ÁÁ½¥¹Ñµ•¹ÑÌ ¤¤ì(€€ ‰ÁÉ•Í•¹Ñ…Ñ¥½¹9…µ•½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°Í…Ù•AÉ•Í•¹Ñ…Ñ¥½¹9…µ”¤ì(€™½È€¡½¹ÍÐm™Õ±±9…µ•%°ÁÉ•Í•¹Ñ…Ñ¥½¹9…µ•%‘t½˜ml‰¹•Ý¥ÍÁ±…å9…µ”ˆ°€‰¹•ÝAÉ•Í•¹Ñ…Ñ¥½¹9…µ”‰t°l‰µ…ÍÑ•É¥ÍÁ±…å9…µ”ˆ°€‰µ…ÍÑ•ÉAÉ•Í•¹Ñ…Ñ¥½¹9…µ”‰ut¤ì(€€€½¹ÍÐ™Õ±±9…µ”€ô€¡™Õ±±9…µ•%¤ì(€€€½¹ÍÐÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”€ô€¡ÁÉ•Í•¹Ñ…Ñ¥½¹9…µ•%¤ì(€€€±•ÐÁÉ•Ù¥½ÕÍÕÑ½µ…Ñ¥Œ€ô€ˆˆì(€€€™Õ±±9…µ”¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¥¹ÁÕÐˆ°€ ¤€ôøì(€€€€€½¹ÍÐÕÉÉ•¹Ð€ôÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”¹Ù…±Õ”¹ÑÉ¥´ ¤ì(€€€€€¥˜€ …ÕÉÉ•¹ÐñðÕÉÉ•¹Ð€ôôôÁÉ•Ù¥½ÕÍÕÑ½µ…Ñ¥Œ¤ì(€€€€€€€ÁÉ•Ù¥½ÕÍÕÑ½µ…Ñ¥Œ€ô‘•É¥Ù•AÉ•Í•¹Ñ…Ñ¥½¹9…µ”¡™Õ±±9…µ”¹Ù…±Õ”¤ì(€€€€€€€ÁÉ•Í•¹Ñ…Ñ¥½¹9…µ”¹Ù…±Õ”€ôÁÉ•Ù¥½ÕÍÕÑ½µ…Ñ¥Œì(€€€€€ô(€€€ô¤ì(€ô(€€ ‰µ…ÍÑ•ÉÁÁ½¥¹Ñµ•¹Ñ…Ñ”ˆ¤¹Ù…±Õ”€ô…ÁÁ½¥¹Ñµ•¹Ñ…Ñ”ì(€€ ‰µ…ÍÑ•ÉÁÁ½¥¹Ñµ•¹Ñ…Ñ”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°€ ¤€ôøÙ½¥±½…‘5…ÍÑ•ÉÁÁ½¥¹Ñµ•¹ÑÌ ¤¤ì(€€ ‰±½…‘5…ÍÑ•ÉÁÁ½¥¹Ñµ•¹ÑÌˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÙ½¥±½…‘5…ÍÑ•ÉÁÁ½¥¹Ñµ•¹ÑÌ ¤¤ì(€€ ‰Ñ•…µ½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€ÑÉäì(€€€€€…Ý…¥Ð¥¹Ù½­•‘µ¥¸¡ì…Ñ¥½¸è€‰É•…Ñ•}Ñ•…´ˆ°¹…µ”è€ ‰Ñ•…µ9…µ”ˆ¤¹Ù…±Õ”ô¤ì(€€€€€€ ‰Ñ•…µ9…µ”ˆ¤¹Ù…±Õ”€ô€ˆˆì(€€€€€¹½Ñ¥™ä ‰ÅÕ¥Á¼É•…‘¼¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€€€…Ý…¥Ð±½…‘‘µ¥¹A…¹•° ¤ì(€€€ô…Ñ ì¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼É•…È•°•ÅÕ¥Á¼¸ˆ°€‰•ÉÉ½Èˆ¤ìô(€ô¤ì(€€ ‰…½Õ¹Ñ½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€½¹ÍÐ™½É´€ô…ÁÑÕÉ•MÕ‰µ¥ÑÑ•‘½É´¡•Ù•¹Ð¤ì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€½¹ÍÐ™½Éµ…Ñ„€ôì(€€€€€‘¥ÍÁ±…å}¹…µ”è€ ‰¹•Ý¥ÍÁ±…å9…µ”ˆ¤¹Ù…±Õ”°(€€€€€ÁÉ•Í•¹Ñ…Ñ¥½¹}¹…µ”è€ ‰¹•ÝAÉ•Í•¹Ñ…Ñ¥½¹9…µ”ˆ¤¹Ù…±Õ”°(€€€€€•µÁ±½å••}¥è€ ‰¹•ÝµÁ±½å••%ˆ¤¹Ù…±Õ”°(€€€ôì(€€€½¹ÍÐÑ•…µ%‘Ì€ôl¸¸¹‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° œÑ•…µ¡½¥•Ì¥¹ÁÕÑm¹…µ”ô‰Ñ•…µ%‘Ì‰té¡•­•œ¥t¹µ…À ¡¥¹ÁÕÐ¤€ôø¥¹ÁÕÐ¹Ù…±Õ”¤ì(€€€½¹ÍÐÉ½±”€ô€ ‰¹•ÝI½±”ˆ¤¹Ù…±Õ”ì(€€€¥˜€¡Ñ•…µ%‘Ì¹±•¹Ñ €ð€Äñð€¡É½±”€ôôô€‰Ñ•¡¹¥¥…¸ˆ€˜˜Ñ•…µ%‘Ì¹±•¹Ñ €„ôô€Ä¤¤ì(€€€€€¹½Ñ¥™ä¡É½±”€ôôô€‰Ñ•¡¹¥¥…¸ˆ(€€€€€€€€ü€‰M•±•¥½¹„•á…Ñ…µ•¹Ñ”Õ¸•ÅÕ¥Á¼Á…É„•°Ó¥¹¥¼¸ˆ(€€€€€€€€è€‰M•±•¥½¹„…°µ•¹½ÌÕ¸•ÅÕ¥Á¼Á…É„•°5…ÍÑ•È¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€ÑÉäì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÉ•…Ñ•½Õ¹Ð¡™½Éµ…Ñ„°É½±”°Ñ•…µ%‘Ì¤ì(€€€€€™½É´¹É•Í•Ð ¤ì(€€€€€¹½Ñ¥™ä¡É•ÍÕ±Ð¹µ•ÍÍ…”°€‰ÍÕ•ÍÌˆ¤ì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÉ•™É•Í¡•€ô…Ý…¥Ð±½…‘‘µ¥¹A…¹•° ¤ì(€€€€€€€¥˜€ …É•™É•Í¡•¤¹½Ñ¥™ä ‰1„Õ•¹Ñ„Í”É—Ì°Á•É¼¹¼Í”ÁÕ‘¼…ÑÕ…±¥é…È•°Á…¹•°¸I•…É„±„Ã…¥¹„ì¹¼É•Á¥Ñ…Ì•°…±Ñ„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€ô…Ñ ì(€€€€€€€¹½Ñ¥™ä ‰1„Õ•¹Ñ„Í”É—Ì°Á•É¼¹¼Í”ÁÕ‘¼…ÑÕ…±¥é…È•°Á…¹•°¸I•…É„±„Ã…¥¹„ì¹¼É•Á¥Ñ…Ì•°…±Ñ„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€ô(€€€ô…Ñ ì¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼É•…È±„Õ•¹Ñ„¸½µÁÉÕ•‰„•°É½°°±„µ…ÑËµÕ±„ä±½ÌÁ•Éµ¥Í½Ì¸ˆ°€‰•ÉÉ½Èˆ¤ìô(€ô¤ì(€€ ‰µ…ÍÑ•É½Õ¹Ñ½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€½¹ÍÐ™½É´€ô…ÁÑÕÉ•MÕ‰µ¥ÑÑ•‘½É´¡•Ù•¹Ð¤ì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€½¹ÍÐÑ•…µ%€ô€ ‰µ…ÍÑ•ÉQ•…µM•±•Ðˆ¤¹Ù…±Õ”ì(€€€¥˜€ …Ñ•…µ%¤ì¹½Ñ¥™ä ‰9¼Ñ¥•¹•ÌÕ¸•ÅÕ¥Á¼…Ñ¥Ù¼Á…É„…Í¥¹…È¸ˆ°€‰•ÉÉ½Èˆ¤ìÉ•ÑÕÉ¸ìô(€€€ÑÉäì(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÉ•…Ñ•½Õ¹Ð¡ì(€€€€€€€‘¥ÍÁ±…å}¹…µ”è€ ‰µ…ÍÑ•É¥ÍÁ±…å9…µ”ˆ¤¹Ù…±Õ”°(€€€€€€€ÁÉ•Í•¹Ñ…Ñ¥½¹}¹…µ”è€ ‰µ…ÍÑ•ÉAÉ•Í•¹Ñ…Ñ¥½¹9…µ”ˆ¤¹Ù…±Õ”°(€€€€€€€•µÁ±½å••}¥è€ ‰µ…ÍÑ•ÉµÁ±½å••%ˆ¤¹Ù…±Õ”°(€€€€€ô°€‰Ñ•¡¹¥¥…¸ˆ°mÑ•…µ%‘t¤ì(€€€€€™½É´¹É•Í•Ð ¤ì(€€€€€¹½Ñ¥™ä¡É•ÍÕ±Ð¹µ•ÍÍ…”°€‰ÍÕ•ÍÌˆ¤ì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÉ•™É•Í¡•€ô…Ý…¥Ð±½…‘5…ÍÑ•ÉA…¹•° ¤ì(€€€€€€€¥˜€ …É•™É•Í¡•¤¹½Ñ¥™ä ‰1„Õ•¹Ñ„Í”É—Ì°Á•É¼¹¼Í”ÁÕ‘¼…ÑÕ…±¥é…È•°Á…¹•°¸I•…É„±„Ã…¥¹„ì¹¼É•Á¥Ñ…Ì•°…±Ñ„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€ô…Ñ ì(€€€€€€€¹½Ñ¥™ä ‰1„Õ•¹Ñ„Í”É—Ì°Á•É¼¹¼Í”ÁÕ‘¼…ÑÕ…±¥é…È•°Á…¹•°¸I•…É„±„Ã…¥¹„ì¹¼É•Á¥Ñ…Ì•°…±Ñ„¸ˆ°€‰•ÉÉ½Èˆ¤ì(€€€€€ô(€€€ô…Ñ ì¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼É•…È±„Õ•¹Ñ„¸½µÁÉÕ•‰„±½Ì‘…Ñ½Ìä±½ÌÁ•Éµ¥Í½Ì‘•°•ÅÕ¥Á¼¸ˆ°€‰•ÉÉ½Èˆ¤ìô(€ô¤ì(€€ ‰É•Ñ•¹Ñ¥½¹½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€ÑÉäì(€€€€€…Ý…¥Ð¥¹Ù½­•‘µ¥¸¡ì…Ñ¥½¸è€‰Í•Ñ}É•Ñ•¹Ñ¥½¹}‘…åÌˆ°‘…åÌè9Õµ‰•È  ‰É•Ñ•¹Ñ¥½¹…åÌˆ¤¹Ù…±Õ”¤ô¤ì(€€€€€¹½Ñ¥™ä ‰I•Ñ•¹§Í¸…ÑÕ…±¥é…‘„¸ˆ°€‰ÍÕ•ÍÌˆ¤ì(€€€ô…Ñ ì¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼…µ‰¥…È±„É•Ñ•¹§Í¸¸ˆ°€‰•ÉÉ½Èˆ¤ìô(€ô¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÍÑ…ÉÐ ¤ì(€¡¥‘•]½É­ÍÁ…•A…¹•±Ì ¤ì(€¥˜€ …½¹™¥ÕÉ•¤ì(€€€Í•ÑY¥Í¥‰±” ‰½¹™¥]…É¹¥¹œˆ°ÑÉÕ”¤ì(€€€É•ÑÕÉ¸ì(€ô(€¥˜€¡½¹™¥œ¹…ÕÑ¡¹…‰±•€„ôôÑÉÕ”¤ì(€€€Í•ÑY¥Í¥‰±” ‰…ÕÑ¡¥Í…‰±•ˆ°ÑÉÕ”¤ì(€€€É•ÑÕÉ¸ì(€ô(€‰¥¹‘Ù•¹ÑÌ ¤ì(€É•…Ñ•MÕÁ…‰…Í•±¥•¹Ð ¤ì(€ÍÕÁ…‰…Í”¹…ÕÑ ¹½¹ÕÑ¡MÑ…Ñ•¡…¹”  ¤€ôøì(€€€ÅÕ•Õ•5¥É½Ñ…Í¬  ¤€ôøÉ½ÕÑ•M•ÍÍ¥½¸ ¤¤ì(€ô¤ì(€…Ý…¥ÐÉ½ÕÑ•M•ÍÍ¥½¸ ¤ì)ô()ÍÑ…ÉÐ ¤¹…Ñ   ¤€ôø¹½Ñ¥™ä ‰9¼Í”ÁÕ‘¼¥¹¥¥…È±„…Á±¥…§Í¸¸ˆ°€‰•ÉÉ½Èˆ¤¤ì(