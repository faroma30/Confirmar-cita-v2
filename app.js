import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import { captureSubmittedForm } from "./form-events.mjs";
import { cleanMapAddress, normalizePhoneForCall, normalizePhoneForWhatsApp, parseOracleInstallations, stableSourceKey } from "./agenda-parser.mjs";

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

const DEFAULT_INSTALLATION_TEMPLATE = `Buenas, soy {TECNICO}, el *técnico de la alarma de Verisure* para hacer la instalación de la alarma.\n\nMañana estaré en *{POBLACION}* a las *{HORA}*.\n\n📍 Dirección: *{DIRECCION}*\n\nPor favor, comprueba que la dirección es correcta.\n\nImportante que tenga el *DNI* (físico) y el *número de cuenta*.\n\nTe avisaré cuando esté de camino. Cualquier cosa, házmela saber.\n\n*Si necesitas CANCELAR la instalación avísame antes de las 00:00 de hoy para evitar penalizaciones.*`;
const DEFAULT_MAINTENANCE_TEMPLATE = `Buenas, soy {TECNICO}, el *técnico de la alarma de Verisure* para hacer el mantenimiento de la alarma.\n\nMañana estaré en *{POBLACION}* a las *{HORA}*.\n\n📍 Dirección: *{DIRECCION}*\n\nPor favor, comprueba que la dirección es correcta.`;
const DEFAULT_CANCELLATION_TEMPLATE = `Buenos días,\n\nEl cliente correspondiente al prospecto {PROSPECTO} solicita cancelar la cita prevista a las {HORA}.\n\nTipo de intervención: {TIPO}\nPoblación: {POBLACION}\nTeléfono: {TELEFONO}\nDirección: {DIRECCION}\n\nMotivo indicado por el cliente: {MOTIVO}\n\nUn saludo,\n{TECNICO}`;

function localDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function addBusinessDays(date, days) {
  const [year, month, day] = localDateString(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12));
}

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
    notify("La sesión no está disponible. Vuelve a iniciar sesión.", "error");
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
    notify("Esta identidad no tiene acceso al módulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (!activeProfile) {
    notify("Esta identidad no tiene acceso al módulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (activeProfile.status === "pending_activation" || activeProfile.must_change_password) {
    setVisible("activationPanel", true);
    setVisible("signOut", true);
    return;
  }
  if (!activeProfile.activation_verified_at) {
    notify("La cuenta aún no está habilitada para este módulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (activeProfile.status !== "active") {
    notify("La cuenta está desactivada. Contacta con el administrador.", "error");
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
    changeLoginLabel.firstChild.textContent = "Matrícula";
  }
  const rolePill = $("rolePill");
  rolePill.textContent = activeProfile.role === "admin" ? "Administrador" : activeProfile.role === "master" ? "Master" : "Técnico";
  rolePill.className = `pill ${activeProfile.role}`;
  $("roleDescription").textContent = activeProfile.role === "admin"
    ? "Panel de administración. Esta cuenta no abre agendas ni instalaciones."
    : activeProfile.role === "master"
      ? "Acceso a tus instalaciones y supervisión limitada a tus equipos."
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
      appointmentNotice("No se pudo cargar tu agenda o el equipo. Actualiza la página e inténtalo de nuevo.", "error");
    }
  } else {
    setVisible("appointmentsPanel", true);
    try {
      await Promise.all([loadAppointmentTeams(), loadAppointmentPreferences()]);
      await loadOwnAppointments(appointmentDate);
    } catch {
      appointmentNotice("No se pudo cargar la agenda. Actualiza la página e inténtalo de nuevo.", "error");
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
  const roleName = profile.role === "master" ? "Master" : profile.role === "admin" ? "Administrador" : profile.role === "technician" ? "Técnico" : "Equipo";
  const stateName = profile.status ?? profile.account_status ?? "";
  detail.textContent = `${roleName} · ${stateName}${profile.must_change_password ? " · activación pendiente" : ""}`;
  main.append(title, detail);
  if (teams.length) {
    const teamLine = document.createElement("p");
    teamLine.textContent = teams.join(" · ");
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
  installation_keywords: ["kit hogar", "kit básico", "kit basico", "kit negocio", "kit premium"],
  installation_template: DEFAULT_INSTALLATION_TEMPLATE,
  maintenance_template: DEFAULT_MAINTENANCE_TEMPLATE,
  cancellation_template: DEFAULT_CANCELLATION_TEMPLATE,
  cancellation_email_to: "",
  cancellation_email_cc: "",
  cancellation_email_subject: "Cliente cancela - Prospecto {PROSPECTO}",
});

async function loadAppointmentPreferences() {
  const { data, error } = await supabase.rpc("cc_my_appointment_preferences");
  if (error) throw new Error("preferences unavailable");
  appointmentPreferences = { ...defaultAppointmentPreferences(), ...(data ?? {}) };
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
  const [dayResult, indexResult] = await Promise.all([
    supabase.rpc("cc_my_appointments", { p_work_date: appointmentDate }),
    supabase.rpc("cc_my_appointment_identity_index"),
  ]);
  if (dayResult.error || indexResult.error || !Array.isArray(dayResult.data) || !Array.isArray(indexResult.data)) {
    appointmentNotice("No se pudo recuperar la agenda. Comprueba la conexión e inténtalo de nuevo.", "error");
    return false;
  }
  currentAppointments = dayResult.data;
  appointmentIdentityIndex = indexResult.data;
  renderAppointments();
  return true;
}

let appointmentIdentityIndex = [];

function setAgendaFilter(filter) {
  appointmentFilter = filter;
  renderAppointments();
}

function renderAppointments() {
  const rows = [...currentAppointments].sort((a, b) => String(a.scheduled_time).localeCompare(String(b.scheduled_time)));
  const visible = rows.filter((row) => appointmentFilter === "Todas"
    || (appointmentFilter === "Contactadas" ? Boolean(row.contacted_at) : row.status === appointmentFilter.toLowerCase()));
  const counts = {
    Instalaciones: rows.filter((row) => !row.source_missing).length,
    Contactadas: rows.filter((row) => row.contacted_at).length,
    Pendientes: rows.filter((row) => row.status === "pending").length,
    Confirmadas: rows.filter((row) => row.status === "confirmed").length,
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
  for (const label of ["Todas", "pending", "confirmed", "cancelled", "Contactadas"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${appointmentFilter === label ? "primary" : "secondary"}`;
    button.textContent = ({ pending: "Pendientes", confirmed: "Confirmadas", cancelled: "Canceladas" })[label] ?? label;
    button.addEventListener("click", () => setAgendaFilter(label));
    filters.append(button);
  }
  const ignoredTarget = $("appointmentIgnored");
  ignoredTarget.textContent = ignoredAppointments.length
    ? `Se omitieron ${ignoredAppointments.length} intervenciones que no son instalaciones.` : "";
  const list = $("appointmentList");
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "agenda-empty";
    empty.textContent = rows.length ? "No hay instalaciones en este filtro." : "No hay instalaciones guardadas para esta fecha.";
    list.append(empty);
    return;
  }
  for (const row of visible) list.append(renderAppointmentCard(row));
}

function humanStatus(status) {
  return ({ pending: "Pendiente", confirmed: "Confirmada", cancelled: "Cancelada" })[status] ?? "Pendiente";
}

function appointmentTemplateValues(row, reason = "") {
  return {
    TECNICO: activeProfile?.display_name ?? "el técnico",
    POBLACION: row.population ?? "",
    HORA: row.scheduled_time ?? "",
    DIRECCION: [row.full_address, row.postal_code].filter(Boolean).join(" "),
    TELEFONO: row.phone ?? "",
    PROSPECTO: row.prospect_ref ?? "Sin prospecto",
    MTO: row.prospect_ref ?? "Sin prospecto",
    TIPO: row.installation_type || "Instalación",
    MOTIVO: reason,
  };
}

function fillAppointmentTemplate(template, row, reason = "") {
  let result = String(template ?? "");
  for (const [key, value] of Object.entries(appointmentTemplateValues(row, reason))) {
    result = result.replaceAll(`{${key}}`, value || "");
  }
  return result;
}

function renderAppointmentCard(row) {
  const card = document.createElement("article");
  card.className = `appointment-card${row.source_missing ? " missing" : ""}`;
  const head = document.createElement("div");
  head.className = "appt-head";
  const title = document.createElement("h3");
  title.textContent = `${row.scheduled_time} · ${row.population || "Población pendiente"}`;
  const status = document.createElement("span");
  status.className = `state-badge ${row.status}`;
  status.textContent = humanStatus(row.status);
  head.append(title, status);
  card.append(head);
  const type = document.createElement("p");
  type.className = "appt-meta";
  type.textContent = `${row.installation_type || "Instalación"} · Prospecto: ${row.prospect_ref || "—"}`;
  card.append(type);
  const phone = document.createElement("p");
  phone.textContent = row.phone ? `Teléfono: ${row.phone}` : "Teléfono no detectado";
  const address = document.createElement("p");
  address.textContent = `📍 ${[row.full_address, row.postal_code].filter(Boolean).join(" ") || "Dirección no detectada"}`;
  card.append(phone, address);
  if (row.contacted_at) {
    const contact = document.createElement("div");
    contact.className = "contact-badge";
    contact.textContent = `WhatsApp abierto · ${new Date(row.contacted_at).toLocaleString("es-ES")}`;
    card.append(contact);
  }
  if (row.private_note) {
    const note = document.createElement("p");
    note.className = "private-note";
    note.textContent = `Nota privada: ${row.private_note}`;
    card.append(note);
  }
  if (row.source_missing) {
    const missing = document.createElement("p");
    missing.className = "fine";
    missing.textContent = "Esta cita ya no aparece en la última importación de Oracle.";
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
  if (row.source_missing) addAction("Eliminar", () => removeAppointment(row), "danger");
  card.append(actions);
  const updated = document.createElement("p");
  updated.className = "appt-meta";
  updated.textContent = `Actualizada: ${new Date(row.updated_at).toLocaleString("es-ES")}`;
  card.append(updated);
  return card;
}

async function openAppointmentWhatsApp(row, customMessage = "") {
  if (!row.phone) { appointmentNotice("No hay teléfono válido para abrir WhatsApp.", "error"); return; }
  const { data, error } = await supabase.rpc("cc_record_whatsapp_open", { p_appointment_id: row.id });
  if (error) { appointmentNotice("No se pudo registrar la apertura de WhatsApp. No se ha abierto la aplicación.", "error"); return; }
  row.contacted_at = data;
  renderAppointments();
  const template = appointmentPreferences.installation_template || DEFAULT_INSTALLATION_TEMPLATE;
  const message = customMessage || fillAppointmentTemplate(template, row);
  const phone = normalizePhoneForWhatsApp(row.phone);
  const intent = `intent://send?phone=${phone}&text=${encodeURIComponent(message)}#Intent;scheme=whatsapp;package=com.whatsapp;end`;
  window.location.assign(intent);
}

function callAppointment(row) {
  const phone = normalizePhoneForCall(row.phone);
  if (!phone) { appointmentNotice("No hay teléfono válido para llamar.", "error"); return; }
  window.location.href = `tel:${phone}`;
}

function openAppointmentMaps(row) {
  const query = [cleanMapAddress(row.full_address, row.population), row.postal_code].filter(Boolean).join(", ");
  if (!query.trim()) { appointmentNotice("No hay dirección para abrir Maps.", "error"); return; }
  const intent = `intent://maps.google.com/maps?q=${encodeURIComponent(query)}#Intent;scheme=https;package=com.google.android.apps.maps;end`;
  window.location.assign(intent);
}

function reviewWhatsApp(row) {
  const template = appointmentPreferences.installation_template || DEFAULT_INSTALLATION_TEMPLATE;
  const message = window.prompt("Revisa o modifica el mensaje de WhatsApp", fillAppointmentTemplate(template, row));
  if (message !== null) void openAppointmentWhatsApp(row, message);
}

async function editAppointment(row) {
  const time = window.prompt("Hora (HH:MM)", row.scheduled_time ?? ""); if (time === null) return;
  const population = window.prompt("Población", row.population ?? ""); if (population === null) return;
  const phone = window.prompt("Teléfono", row.phone ?? ""); if (phone === null) return;
  const address = window.prompt("Dirección", row.full_address ?? ""); if (address === null) return;
  const postal = window.prompt("Código postal", row.postal_code ?? ""); if (postal === null) return;
  const { error } = await supabase.rpc("cc_edit_appointment_details", {
    p_appointment_id: row.id, p_scheduled_time: time, p_population: population,
    p_phone: phone, p_full_address: address, p_postal_code: postal,
  });
  if (error) appointmentNotice("No se pudieron guardar los cambios privados.", "error");
  else { appointmentNotice("Información actualizada.", "success"); await loadOwnAppointments(appointmentDate); }
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

async function changeAppointmentStatus(row, status) {
  if (status === "cancelled") {
    const reason = window.prompt("Motivo comunicado por el cliente");
    if (reason === null) return;
    if (!reason.trim()) { appointmentNotice("Indica el motivo de cancelación.", "error"); return; }
    const { error } = await supabase.rpc("cc_cancel_appointment", { p_appointment_id: row.id, p_reason: reason.trim() });
    if (error) { appointmentNotice("No se pudo registrar la cancelación.", "error"); return; }
    row.cancellation_reason = reason.trim();
    const email = buildCancellationEmail(row, reason.trim());
    if (email) window.location.href = email;
  } else {
    const { error } = await supabase.rpc("cc_set_appointment_status", { p_appointment_id: row.id, p_new_status: status });
    if (error) { appointmentNotice("No se pudo cambiar el estado.", "error"); return; }
  }
  appointmentNotice(`Cita actualizada: ${humanStatus(status)}.`, "success");
  await loadOwnAppointments(appointmentDate);
}

function buildCancellationEmail(row, reason) {
  const template = appointmentPreferences.cancellation_template || DEFAULT_CANCELLATION_TEMPLATE;
  const subject = fillAppointmentTemplate(appointmentPreferences.cancellation_email_subject || "Cliente cancela - Prospecto {PROSPECTO}", row, reason);
  const body = fillAppointmentTemplate(template, row, reason);
  const to = appointmentPreferences.cancellation_email_to || "";
  if (!to) return "";
  const cc = appointmentPreferences.cancellation_email_cc || "";
  return `mailto:${encodeURIComponent(to)}?${cc ? `cc=${encodeURIComponent(cc)}&` : ""}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function removeAppointment(row) {
  if (!window.confirm("¿Eliminar esta cita de tu agenda?")) return;
  const { error } = await supabase.rpc("cc_delete_appointment", { p_appointment_id: row.id });
  if (error) appointmentNotice("No se pudo eliminar la cita.", "error");
  else { appointmentNotice("Cita eliminada.", "success"); await loadOwnAppointments(appointmentDate); }
}

async function makeStableSourceKey(row, occurrence = 0) {
  const identity = row.prospect_ref
    ? `prospect:${String(row.prospect_ref).trim().toUpperCase()}`
    : `fallback:${appointmentDate}:${row.time}:${row.population.toLocaleLowerCase("es-ES")}:${row.type.toLocaleLowerCase("es-ES")}:${occurrence}`;
  const bytes = new TextEncoder().encode(`${activeUser.id}:${identity}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  hex = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${(parseInt(hex[16], 16) & 3 | 8).toString(16)}${hex.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function matchesAppointment(existing, parsed) {
  if (parsed.prospect_ref && existing.prospect_ref) return parsed.prospect_ref === existing.prospect_ref;
  if (parsed.prospect_ref || existing.prospect_ref) return false;
  const samePrivateIdentity = parsed.phone && parsed.full_address
    && existing.phone === parsed.phone && existing.full_address === parsed.full_address
    && (existing.installation_type ?? "") === parsed.type;
  return samePrivateIdentity || (existing.work_date === appointmentDate
    && existing.scheduled_time === parsed.time && existing.population === parsed.population
    && (existing.installation_type ?? "") === parsed.type
    && (existing.phone ?? "") === parsed.phone && (existing.full_address ?? "") === parsed.full_address);
}

async function processOracleText() {
  const text = $("oracleText").value;
  if (!text.trim()) { appointmentNotice("Pega primero el texto de Oracle.", "error"); return; }
  if (!selectedAppointmentTeam || !appointmentTeams.some((team) => team.id === selectedAppointmentTeam)) {
    appointmentNotice("No hay un equipo autorizado para esta importación.", "error"); return;
  }
  const parsed = parseOracleInstallations(text, appointmentPreferences.installation_keywords);
  ignoredAppointments = parsed.ignored;
  const occurrences = new Map();
  const usedSources = new Set();
  const rows = [];
  for (const item of parsed.installations) {
    const old = appointmentIdentityIndex.find((candidate) => !usedSources.has(candidate.source_key) && matchesAppointment(candidate, item));
    if (old) usedSources.add(old.source_key);
    const base = item.prospect_ref ? `p:${item.prospect_ref}` : `n:${appointmentDate}|${item.time}|${item.population}|${item.type}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const sourceKey = old?.source_key ?? await stableSourceKey(activeUser.id, appointmentDate, item, occurrence);
    rows.push({
      source_key: sourceKey, work_date: appointmentDate, scheduled_time: item.time,
      population: item.population || "Población pendiente", prospect_ref: item.prospect_ref,
      kind: "installation", type: item.type, phone: item.phone,
      full_address: item.full_address, postal_code: item.postal_code,
      private_note: old?.private_note ?? "", cancellation_reason: old?.cancellation_reason ?? "",
    });
  }
  const duplicateProspects = rows.filter((row, index) => row.prospect_ref && rows.findIndex((other) => other.prospect_ref === row.prospect_ref) !== index);
  if (duplicateProspects.length) { appointmentNotice("Oracle contiene referencias de prospecto duplicadas; revisa el texto antes de importar.", "error"); return; }
  const { data, error } = await supabase.rpc("cc_sync_appointment_batch", {
    p_team_id: selectedAppointmentTeam, p_work_date: appointmentDate, p_rows: rows,
  });
  if (error) { appointmentNotice("La importación no se pudo guardar. Revisa el equipo y la fecha e inténtalo de nuevo.", "error"); return; }
  $("oracleText").value = "";
  await loadOwnAppointments(appointmentDate);
  appointmentNotice(`Importación guardada: ${Number(data) || 0} instalaciones. Se conservaron los estados y notas existentes.`, "success");
}

async function loadMasterAppointments() {
  const date = $("masterAppointmentDate").value || appointmentDate;
  $("masterAppointmentDate").value = date;
  const { data, error } = await supabase.rpc("cc_master_team_appointments", { p_work_date: date });
  const target = $("masterAppointmentList");
  target.replaceChildren();
  if (error || !Array.isArray(data)) { target.textContent = "No se pudo consultar la supervisión."; return false; }
  if (!data.length) { const empty = document.createElement("div"); empty.className = "agenda-empty"; empty.textContent = "No hay citas de equipo para esta fecha."; target.append(empty); return true; }
  for (const row of data) {
    const item = document.createElement("article"); item.className = "master-appointment-row";
    const content = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = `${row.scheduled_time} · ${row.population} · ${row.technician}`;
    const meta = document.createElement("span"); meta.textContent = `Prospecto: ${row.prospect_ref || "—"} · ${humanStatus(row.status)}`;
    content.append(title, meta);
    const side = document.createElement("div");
    if (row.contacted_at) { const contact = document.createElement("span"); contact.className = "contact-badge"; contact.textContent = `WhatsApp abierto · ${new Date(row.contacted_at).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`; side.append(contact); }
    const updated = document.createElement("span"); updated.textContent = `Actualizada ${new Date(row.last_updated_at).toLocaleString("es-ES")}`; side.append(updated);
    item.append(content, side); target.append(item);
  }
  return true;
}

async function saveAppointmentPreferences(event) {
  event.preventDefault();
  const keywords = $("installationKeywords").value.split(/\r?\n/).map((item) => item.trim().toLocaleLowerCase("es-ES")).filter(Boolean);
  const { error } = await supabase.rpc("cc_save_my_appointment_preferences", {
    p_installation_keywords: keywords,
    p_installation_template: $("installationTemplate").value,
    p_maintenance_template: $("maintenanceTemplate").value,
    p_cancellation_template: $("cancellationTemplate").value,
    p_email_to: $("cancelEmailTo").value.trim(),
    p_email_cc: $("cancelEmailCc").value.trim(),
    p_email_subject: $("cancelEmailSubject").value.trim(),
  });
  if (error) { appointmentNotice("No se pudieron guardar los ajustes.", "error"); return; }
  await loadAppointmentPreferences();
  appointmentNotice("Ajustes personales guardados.", "success");
}

async function invokeAdmin(body) {
  const { data, error } = await supabase.functions.invoke("admin-management", { body });
  if (error || data?.error) throw new Error("admin operation failed");
  return data;
}

async function resetAccountPassword(userId, displayName) {
  const { data, error } = await supabase.functions.invoke("reset-account-password", {
    body: { target_id: userId },
  });
  if (error || data?.error || !data?.temporary_password) throw new Error("reset failed");
  const password = data.temporary_password;
  data.temporary_password = "";
  window.alert(`Contraseña temporal para ${displayName}: ${password}\n\nEntrégala personalmente. La persona deberá cambiarla al iniciar sesión.`);
}

async function loadAdminPanel() {
  const [teamsResult, accountsResult, settingsResult] = await Promise.all([
    supabase.rpc("cc_admin_team_list"),
    supabase.rpc("cc_admin_user_directory"),
    supabase.rpc("cc_admin_global_settings"),
  ]);
  if (teamsResult.error || accountsResult.error || settingsResult.error) {
    notify("No se pudo cargar la información administrativa.", "error");
    return false;
  }
  teamsForActor = Array.isArray(teamsResult.data) ? teamsResult.data : [];
  const teamList = $("adminTeams");
  teamList.replaceChildren();
  for (const team of teamsForActor) {
    const active = team.active === true;
    teamList.append(makeAccountCard(
      { display_name: team.name, role: "team", status: active ? "Activo" : "Inactivo" },
      [],
      [
        {
          label: "Editar nombre",
          run: async () => {
            const name = window.prompt("Nombre del equipo", team.name);
            if (name === null || !name.trim() || name.trim() === team.name) return;
            try {
              await invokeAdmin({ action: "rename_team", team_id: team.id, name: name.trim() });
              notify("Nombre del equipo actualizado.", "success");
              await loadAdminPanel();
            } catch { notify("No se pudo cambiar el nombre del equipo.", "error"); }
          },
        },
        {
          label: active ? "Desactivar equipo" : "Activar equipo",
          run: () => invokeAdmin({ action: "set_team_status", team_id: team.id, active: !active })
            .then(loadAdminPanel).catch(() => notify("No se pudo cambiar el estado del equipo.", "error")),
        },
      ],
    ));
  }
  if (!teamsForActor.length) teamList.textContent = "Aún no hay equipos.";
  const choices = $("teamChoices");
  choices.replaceChildren();
  const legend = document.createElement("legend");
  legend.textContent = "Equipos";
  choices.append(legend);
  const choiceList = document.createElement("div");
  choiceList.className = "team-choices";
  for (const team of teamsForActor.filter((item) => item.active)) addTeamOption(choiceList, team);
  if (!choiceList.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Crea primero un equipo.";
    choiceList.append(empty);
  }
  choices.append(choiceList);
  if (settingsResult.data?.retention_days != null) {
    $("retentionDays").value = String(settingsResult.data.retention_days);
  }

  const target = $("adminAccounts");
  target.replaceChildren();
  const accounts = Array.isArray(accountsResult.data) ? accountsResult.data : [];
  for (const profile of accounts) {
    const memberships = Array.isArray(profile.teams) ? profile.teams : [];
    const names = memberships.map((membership) => `${membership.team_name} (${membership.membership_status})`);
    const actions = [];
    if (profile.role !== "admin") {
      const isDisabled = profile.status === "disabled";
      const canReactivate = isDisabled && !profile.must_change_password && Boolean(profile.activation_verified_at);
      if (!isDisabled || canReactivate) {
        actions.push({
          label: canReactivate ? "Reactivar cuenta" : "Desactivar cuenta",
          run: () => setAdminAccountStatus(profile.user_id, isDisabled ? "active" : "disabled"),
        });
      }
      if (!isDisabled && ["master", "technician"].includes(profile.role)) {
        actions.push({
          label: "Restablecer contraseña",
          run: () => resetAccountPassword(profile.user_id, profile.display_name)
            .then(() => loadAdminPanel())
            .catch(() => notify("No se pudo restablecer la contraseña.", "error")),
        });
      }
    }
    if (profile.role === "master" && profile.status === "active" && !profile.must_change_password) {
      for (const team of teamsForActor.filter((item) => item.active)) {
        const member = memberships.find((item) => item.team_id === team.id);
        const enabled = member?.membership_status === "active";
        actions.push({
          label: `${enabled ? "Quitar" : "Asignar"}: ${team.name}`,
          run: () => invokeAdmin({ action: "set_master_team", master_id: profile.user_id, team_id: team.id, active: !enabled })
            .then(loadAdminPanel).catch(() => notify("No se pudo cambiar la asignación del Master.", "error")),
        });
      }
    }
    if (profile.role === "technician" && profile.status !== "disabled") {
      for (const team of teamsForActor.filter((item) => item.active)) {
        const membership = memberships.find((item) => item.team_id === team.id);
        const enabled = membership?.membership_status === "active";
        actions.push({
          label: membership ? `${enabled ? "Quitar" : "Asignar"}: ${team.name}` : `Asignar: ${team.name}`,
          run: () => setAdminTechnicianTeam(team.id, profile.user_id, !enabled),
        });
      }
    }
    target.append(makeAccountCard(profile, names, actions));
  }
  if (!accounts.length) target.textContent = "Aún no hay cuentas de equipo.";
  return true;
}

async function setAdminAccountStatus(userId, status) {
  try {
    await invokeAdmin({ action: "set_account_status", target_id: userId, status });
    notify("Estado de la cuenta actualizado.", "success");
    await loadAdminPanel();
  } catch {
    notify("No se pudo cambiar el estado de la cuenta.", "error");
  }
}

async function setAdminTechnicianTeam(teamId, technicianId, active) {
  const { error } = await supabase.rpc("cc_manage_technician_membership", {
    p_team_id: teamId, p_technician_id: technicianId, p_active: active,
  });
  if (error) notify("No se pudo cambiar la asignación del técnico.", "error");
  else {
    notify("Asignación del técnico actualizada.", "success");
    await loadAdminPanel();
  }
}

async function loadMasterPanel() {
  const [teamsResult, accountsResult] = await Promise.all([
    supabase.rpc("cc_master_team_list"),
    supabase.rpc("cc_master_team_accounts"),
  ]);
  if (teamsResult.error || accountsResult.error) {
    notify("No se pudo cargar la información de tu equipo.", "error");
    return false;
  }
  teamsForActor = Array.isArray(teamsResult.data) ? teamsResult.data : [];
  const chips = $("masterTeams");
  chips.replaceChildren();
  for (const team of teamsForActor) {
    const chip = document.createElement("span");
    chip.className = "team-chip";
    chip.textContent = team.name;
    chips.append(chip);
  }
  const select = $("masterTeamSelect");
  select.replaceChildren();
  for (const team of teamsForActor) {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    select.append(option);
  }
  const accountTarget = $("masterAccounts");
  accountTarget.replaceChildren();
  const teamNames = new Map(teamsForActor.map((team) => [team.id, team.name]));
  for (const profile of (Array.isArray(accountsResult.data) ? accountsResult.data : [])) {
    const teamName = teamNames.get(profile.team_id) ?? "Equipo";
    const actions = [];
    if (profile.account_status !== "disabled") {
      const active = profile.membership_status === "active";
      actions.push({
        label: active ? "Desactivar en el equipo" : "Activar en el equipo",
        run: () => setMasterMembership(profile.team_id, profile.technician_id, !active),
      });
      if (profile.membership_status === "active") {
        actions.push({
          label: "Restablecer contraseña",
          run: () => resetAccountPassword(profile.technician_id, profile.display_name)
            .then(() => loadMasterPanel())
            .catch(() => notify("No se pudo restablecer la contraseña.", "error")),
        });
      }
    }
    accountTarget.append(makeAccountCard({
      display_name: profile.display_name,
      role: "technician",
      status: `${profile.account_status} · equipo ${profile.membership_status}`,
      must_change_password: profile.must_change_password,
    }, [teamName], actions));
  }
  if (!accountTarget.childElementCount) accountTarget.textContent = "No hay técnicos asignados todavía.";
  return true;
}

async function setMasterMembership(teamId, technicianId, active) {
  const { error } = await supabase.rpc("cc_manage_technician_membership", {
    p_team_id: teamId, p_technician_id: technicianId, p_active: active,
  });
  if (error) notify("No se pudo cambiar el acceso del técnico al equipo.", "error");
  else {
    notify("Acceso del técnico actualizado.", "success");
    await loadMasterPanel();
  }
}

async function createAccount(formData, role, teamIds) {
  const payload = {
    employee_id: formData.employee_id,
    display_name: formData.display_name,
    role,
    team_ids: teamIds,
  };
  const { data, error } = await supabase.functions.invoke("provision-account", { body: payload });
  if (error || data?.error) throw new Error("provision failed");
  return data;
}

function bindEvents() {
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearNotice();
    const employeeId = $("employeeId").value;
    const password = $("password").value;
    const { data, error } = await supabase.functions.invoke("login-by-matricula", {
      body: { login_id: employeeId, password },
    });
    $("password").value = "";
    if (error || data?.error || !data?.session) {
      notify("No se pudo iniciar sesión. Comprueba los datos o contacta con el administrador.", "error");
      return;
    }
    const { error: sessionError } = await supabase.auth.setSession(data.session);
    if (sessionError) notify("No se pudo iniciar sesión. Comprueba los datos o contacta con el administrador.", "error");
  });
  $("activationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const employeeId = $("activationEmployeeId").value;
    const password = $("activationPassword").value;
    if (password !== $("activationPassword2").value || !passwordOkay(password, employeeId)) {
      notify("Usa una contraseña personal de al menos 6 caracteres, distinta del usuario, y repítela correctamente.", "error");
      return;
    }
    const { data, error } = await supabase.functions.invoke("complete-account-activation", {
      body: { employee_id: employeeId, password },
    });
    $("activationPassword").value = "";
    $("activationPassword2").value = "";
    if (error || data?.error || !data?.activated) {
      notify("La cuenta sigue bloqueada. Comprueba la matrícula y vuelve a completar la activación.", "error");
      return;
    }
    if (data.session) await supabase.auth.setSession(data.session);
    else await supabase.auth.signOut();
    await routeSession();
    notify(data.requiresLogin ? "Contraseña actualizada. Inicia sesión de nuevo." : "Contraseña actualizada.", "success");
  });
  $("changePasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const employeeId = activeProfile?.role === "admin" ? "admin" : $("changeEmployeeId").value;
    const currentPassword = $("currentPassword").value;
    const newPassword = $("newPassword").value;
    if (newPassword !== $("newPassword2").value || !passwordOkay(newPassword, employeeId)) {
      notify("La contraseña nueva debe tener al menos 6 caracteres, ser distinta del usuario y coincidir en ambos campos.", "error");
      return;
    }
    const { data, error: updateError } = await supabase.functions.invoke("account-password", {
      body: {
        mode: "change", login_id: activeProfile?.role === "admin" ? "admin" : employeeId,
        current_password: currentPassword, new_password: newPassword,
      },
    });
    $("currentPassword").value = "";
    $("newPassword").value = "";
    $("newPassword2").value = "";
    if (updateError) notify("No se pudo actualizar la contraseña.", "error");
    else if (data?.session) {
      await supabase.auth.setSession(data.session);
      notify("Contraseña actualizada.", "success");
    } else {
      await supabase.auth.signOut();
      notify("Contraseña actualizada. Inicia sesión de nuevo.", "success");
    }
  });
  $("securityToggle").addEventListener("click", () => setVisible("securityPanel", $("securityPanel").classList.contains("hidden")));
  $("signOut").addEventListener("click", async () => {
    await supabase.auth.signOut();
    await routeSession();
  });
  $("masterOwnTab").addEventListener("click", () => setMasterView("appointments"));
  $("masterTeamTab").addEventListener("click", () => {
    setMasterView("team");
    void loadMasterAppointments();
  });
  $("appointmentDate").addEventListener("change", () => void loadOwnAppointments($("appointmentDate").value));
  $("appointmentTeam").addEventListener("change", () => { selectedAppointmentTeam = $("appointmentTeam").value; });
  $("reloadAppointments").addEventListener("click", () => void loadOwnAppointments($("appointmentDate").value));
  $("importClipboard").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { appointmentNotice("El portapapeles está vacío.", "error"); return; }
      $("oracleText").value = text;
      await processOracleText();
    } catch {
      setVisible("manualImport", true);
      appointmentNotice("El navegador no permitió leer el portapapeles. Pega el texto manualmente.", "error");
    }
  });
  $("manualToggle").addEventListener("click", () => setVisible("manualImport", $("manualImport").classList.contains("hidden")));
  $("processOracle").addEventListener("click", () => void processOracleText());
  $("preferencesToggle").addEventListener("click", () => setVisible("appointmentPreferences", $("appointmentPreferences").classList.contains("hidden")));
  $("appointmentPreferences").addEventListener("submit", saveAppointmentPreferences);
  $("masterAppointmentDate").value = appointmentDate;
  $("masterAppointmentDate").addEventListener("change", () => void loadMasterAppointments());
  $("loadMasterAppointments").addEventListener("click", () => void loadMasterAppointments());
  $("teamForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await invokeAdmin({ action: "create_team", name: $("teamName").value });
      $("teamName").value = "";
      notify("Equipo creado.", "success");
      await loadAdminPanel();
    } catch { notify("No se pudo crear el equipo.", "error"); }
  });
  $("accountForm").addEventListener("submit", async (event) => {
    const form = captureSubmittedForm(event);
    event.preventDefault();
    const formData = {
      display_name: $("newDisplayName").value,
      employee_id: $("newEmployeeId").value,
    };
    const teamIds = [...document.querySelectorAll('#teamChoices input[name="teamIds"]:checked')].map((input) => input.value);
    const role = $("newRole").value;
    if (teamIds.length < 1 || (role === "technician" && teamIds.length !== 1)) {
      notify(role === "technician"
        ? "Selecciona exactamente un equipo para el técnico."
        : "Selecciona al menos un equipo para el Master.", "error");
      return;
    }
    try {
      const result = await createAccount(formData, role, teamIds);
      form.reset();
      notify(result.message, "success");
      try {
        const refreshed = await loadAdminPanel();
        if (!refreshed) notify("La cuenta se creó, pero no se pudo actualizar el panel. Recarga la página; no repitas el alta.", "error");
      } catch {
        notify("La cuenta se creó, pero no se pudo actualizar el panel. Recarga la página; no repitas el alta.", "error");
      }
    } catch { notify("No se pudo crear la cuenta. Comprueba el rol, la matrícula y los permisos.", "error"); }
  });
  $("masterAccountForm").addEventListener("submit", async (event) => {
    const form = captureSubmittedForm(event);
    event.preventDefault();
    const teamId = $("masterTeamSelect").value;
    if (!teamId) { notify("No tienes un equipo activo para asignar.", "error"); return; }
    try {
      const result = await createAccount({
        display_name: $("masterDisplayName").value,
        employee_id: $("masterEmployeeId").value,
      }, "technician", [teamId]);
      form.reset();
      notify(result.message, "success");
      try {
        const refreshed = await loadMasterPanel();
        if (!refreshed) notify("La cuenta se creó, pero no se pudo actualizar el panel. Recarga la página; no repitas el alta.", "error");
      } catch {
        notify("La cuenta se creó, pero no se pudo actualizar el panel. Recarga la página; no repitas el alta.", "error");
      }
    } catch { notify("No se pudo crear la cuenta. Comprueba los datos y los permisos del equipo.", "error"); }
  });
  $("retentionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await invokeAdmin({ action: "set_retention_days", days: Number($("retentionDays").value) });
      notify("Retención actualizada.", "success");
    } catch { notify("No se pudo cambiar la retención.", "error"); }
  });
}

async function start() {
  hideWorkspacePanels();
  if (!configured) {
    setVisible("configWarning", true);
    return;
  }
  if (config.authEnabled !== true) {
    setVisible("authDisabled", true);
    return;
  }
  bindEvents();
  createSupabaseClient();
  supabase.auth.onAuthStateChange(() => {
    queueMicrotask(() => routeSession());
  });
  await routeSession();
}

start().catch(() => notify("No se pudo iniciar la aplicación.", "error"));
