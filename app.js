import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import { captureSubmittedForm } from "./form-events.mjs";
import { createSettingsNavigation } from "./settings-navigation.mjs";
import { createMasterNavigationStorage } from "./master-navigation.mjs?v=3at1";
import { cleanMapAddress, normalizePhoneForCall, normalizePhoneForWhatsApp, parseOracleInstallations, stableSourceKey } from "./agenda-parser.mjs";
import { derivePresentationName, fillAppointmentTemplate } from "./message-template.mjs";
import { appointmentDateLabels, buildMapsUrl, buildWhatsAppUrl, compareImportedAppointment, dateOffset, madridDate } from "./agenda-parity.mjs";

const $ = (id) => document.getElementById(id);
const SETTINGS_VIEW_IDS = ["workspaceWelcome", "adminPanel", "masterViewTabs", "appointmentsPanel", "masterPanel", "masterTechniciansPanel", "masterCreatePanel"];
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
let ownAppointmentsRequestSequence = 0;
let masterAppointmentsRequestSequence = 0;
let ignoredAppointments = [];
let appointmentFilter = "Todas";
let appointmentDate = addLocalDays(todayMadrid(), 1);
let appointmentDayOffset = 1;
let masterRouteDate = addLocalDays(todayMadrid(), 1);
let masterRouteDayOffset = 1;
let previousMadridDate = todayMadrid();
let activeEditAppointment = null;
let previewAppointment = null;
let appointmentPreferences = {};
let importChangesBySource = new Map();
let undoTimer = null;
let sharedTextConsumed = false;
let initializedWorkspaceUserId = null;
let initializedWorkspaceRole = null;
let masterSelectedTechnicianId = "";
let selectedMasterView = "appointments";
let activeLoginAttempt = null;
const masterNavigation = createMasterNavigationStorage(window.localStorage);
const APP_BUILD = "3at1";
const DEFAULT_CANCEL_TO = "toa.alianzas@verisure.es";
const DEFAULT_CANCEL_CC = "angel.garciaestevez@verisure.es";

const DEFAULT_INSTALLATION_TEMPLATE = `Buenas, soy {TECNICO}, el *técnico de la alarma de Verisure* para hacer la instalación de la alarma.\n\nMañana estaré en *{POBLACION}* a las *{HORA}*.\n\n📍 Dirección: *{DIRECCION}*\n\nPor favor, comprueba que la dirección es correcta.\n\nImportante que tenga el *DNI* (físico) y el *número de cuenta*.\n\nRecuerda que el inmueble debe tener:\n- Luz\n- No estar en obras\n- Internet (si se quiere instalar la cámara de vídeo)\n\nTe avisaré cuando esté de camino. Cualquier cosa, házmela saber.\n\n*Si necesitas CANCELAR la instalación avísame antes de las 00:00 de hoy para evitar penalizaciones.*`;
const DEFAULT_MAINTENANCE_TEMPLATE = `Buenas, soy {TECNICO}, el *técnico de la alarma de Verisure* para hacer el mantenimiento de la alarma.\n\nMañana estaré en *{POBLACION}* a las *{HORA}*.\n\n📍 Dirección: *{DIRECCION}*\n\nPor favor, comprueba que la dirección es correcta.\n\n*Si necesitas CANCELAR el mantenimiento avísame antes de las 00:00 de hoy para evitar penalizaciones.*`;
const DEFAULT_CANCELLATION_TEMPLATE = `Buenos días,\n\nEl cliente correspondiente al prospecto {MTO} solicita cancelar la cita prevista a las {HORA}.\n\nTipo de intervención: {TIPO}\nPoblación: {POBLACION}\nTeléfono: {TELEFONO}\nDirección: {DIRECCION}\n\nMotivo indicado por el cliente: {MOTIVO}\n\nUn saludo,\n{TECNICO}`;

const settingsNavigation = createSettingsNavigation({
  getElement: $,
  viewIds: SETTINGS_VIEW_IDS,
  settingsId: "personalSettingsPanel",
  titleId: "settingsTitle",
  window,
  history,
  location,
  document,
});

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
      // Supabase Auth owns this session storage. Application code never stores passwords.
      storage: window.localStorage,
      storageKey: "confirmar-citas-v2-auth-session",
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

function hideWorkspacePanels() {
  ["authPanel", "authDisabled", "activationPanel", "workspace", "adminPanel", "masterPanel",
    "masterTechniciansPanel", "masterCreatePanel", "appointmentsPanel", "masterViewTabs", "personalSettingsPanel", "workspaceLoading", "adminPanelLoading"].forEach((id) => setVisible(id, false));
  setVisible("signOut", false);
  setVisible("settingsToggle", false);
}

function finishStartup() {
  window.__CC_APP_READY__ = true;
  setVisible("startupStatus", false);
}

function publishLoginDiagnostic(diagnostic, roleDataMs = null, stageReached = roleDataMs == null ? "verified_shell" : "role_panel_ready") {
  if (!diagnostic) return;
  const now = performance.now();
  window.__CC_LOGIN_DIAGNOSTICS__ = Object.freeze({
    source: diagnostic.source,
    edgeRequestMs: diagnostic.edgeRequestMs,
    sessionInstallMs: diagnostic.sessionInstallMs,
    getSessionMs: diagnostic.getSessionMs ?? null,
    getUserMs: diagnostic.getUserMs ?? null,
    profileReadMs: diagnostic.profileReadMs ?? null,
    permissionValidationMs: diagnostic.permissionValidationMs ?? null,
    profileAuthorizationMs: diagnostic.profileAuthorizationMs ?? null,
    verifiedShellMs: diagnostic.verifiedShellMs ?? null,
    panelShellMs: diagnostic.panelShellMs ?? null,
    roleDataMs,
    totalMs: now - diagnostic.startedAt,
    stageReached,
  });
}

function finishWorkspaceLoading(diagnostic) {
  setVisible("workspaceLoading", false);
  setVisible("adminPanelLoading", false);
  setVisible("settingsToggle", ["admin", "master", "technician"].includes(activeProfile?.role));
  if (activeProfile?.role === "admin") setVisible("adminPanel", true);
  else if (activeProfile?.role === "master") {
    setVisible("masterViewTabs", true);
    setMasterView(selectedMasterView, { persist: false });
  } else if (activeProfile?.role === "technician") setVisible("appointmentsPanel", true);
  diagnostic.panelShellMs ??= performance.now() - diagnostic.startedAt;
  publishLoginDiagnostic(diagnostic, null, "panel_shell_ready");
}

function clearWorkspaceAgendaResults() {
  currentAppointments = [];
  appointmentIdentityIndex = [];
  ignoredAppointments = [];
  $("appointmentList").replaceChildren();
  $("appointmentStats").replaceChildren();
  $("appointmentFilters").replaceChildren();
  $("appointmentIgnored").textContent = "";
  $("masterAppointmentList").replaceChildren();
  setVisible("appointmentNotice", false);
}

function showWorkspaceLoadFailure(message) {
  setVisible("adminPanelLoading", false);
  setVisible("workspaceLoading", true);
  $("workspaceLoadingMessage").textContent = message;
  $("workspaceLoadingRetry").classList.remove("hidden");
}

async function fetchOwnProfile() {
  const { data, error } = await supabase.rpc("cc_my_profile");
  if (error) throw error;
  return data;
}

async function routeSession({ preserveWorkspace = false } = {}) {
  const routeStartedAt = performance.now();
  if (activeLoginAttempt?.sessionInstallStartedAt && activeLoginAttempt.sessionInstallMs == null) {
    activeLoginAttempt.sessionInstallMs = routeStartedAt - activeLoginAttempt.sessionInstallStartedAt;
  }
  const diagnostic = activeLoginAttempt ?? {
    source: "session_restore", startedAt: routeStartedAt, edgeRequestMs: null, sessionInstallMs: null,
  };
  activeLoginAttempt = null;
  const previousUserId = activeUser?.id ?? null;
  clearNotice();
  settingsNavigation.abandon();
  hideWorkspacePanels();
  const sessionReadStartedAt = performance.now();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  diagnostic.getSessionMs = performance.now() - sessionReadStartedAt;
  if (sessionError) {
    finishStartup();
    notify("La sesión no está disponible. Vuelve a iniciar sesión.", "error");
    setVisible("authPanel", true);
    return;
  }
  const session = sessionData.session;
  if (!session) {
    if (previousUserId) masterNavigation.clear(previousUserId);
    activeUser = null;
    activeProfile = null;
    initializedWorkspaceUserId = null;
    initializedWorkspaceRole = null;
    masterSelectedTechnicianId = "";
    selectedMasterView = "appointments";
    appointmentDayOffset = 1;
    masterRouteDayOffset = 1;
    finishStartup();
    setVisible("authPanel", true);
    return;
  }
  const identityCheckStartedAt = performance.now();
  const { data: verifiedUser, error: userError } = await supabase.auth.getUser();
  diagnostic.getUserMs = performance.now() - identityCheckStartedAt;
  if (userError || !verifiedUser?.user || verifiedUser.user.id !== session.user.id) {
    if (userError && (userError.name === "AuthRetryableFetchError" || userError.status === 0 || navigator.onLine === false)) {
      finishStartup();
      setVisible("startupError", true);
      return;
    }
    if (previousUserId) masterNavigation.clear(previousUserId);
    activeUser = null;
    activeProfile = null;
    initializedWorkspaceUserId = null;
    initializedWorkspaceRole = null;
    await supabase.auth.signOut({ scope: "local" });
    finishStartup();
    setVisible("authPanel", true);
    notify("La sesión ya no es válida. Inicia sesión de nuevo.", "error");
    return;
  }
  if (previousUserId && previousUserId !== verifiedUser.user.id) {
    masterNavigation.clear(previousUserId);
    initializedWorkspaceUserId = null;
    initializedWorkspaceRole = null;
  }
  activeUser = verifiedUser.user;
  const profileCheckStartedAt = performance.now();
  const profileReadStartedAt = performance.now();
  try {
    activeProfile = await fetchOwnProfile();
  } catch {
    finishStartup();
    notify("Esta identidad no tiene acceso al módulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  diagnostic.profileReadMs = performance.now() - profileReadStartedAt;
  const permissionValidationStartedAt = performance.now();
  if (!activeProfile) {
    finishStartup();
    notify("Esta identidad no tiene acceso al módulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (activeProfile.status === "pending_activation" || activeProfile.must_change_password) {
    initializedWorkspaceUserId = null;
    finishStartup();
    setVisible("activationPanel", true);
    setVisible("signOut", true);
    return;
  }
  if (!activeProfile.activation_verified_at) {
    initializedWorkspaceUserId = null;
    finishStartup();
    notify("La cuenta aún no está habilitada para este módulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (activeProfile.status !== "active") {
    masterNavigation.clear(activeUser.id);
    initializedWorkspaceUserId = null;
    finishStartup();
    notify("La cuenta está desactivada. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  diagnostic.permissionValidationMs = performance.now() - permissionValidationStartedAt;
  diagnostic.profileAuthorizationMs = performance.now() - profileCheckStartedAt;
  const resumeLoadedWorkspace = preserveWorkspace
    && initializedWorkspaceUserId === activeUser.id
    && initializedWorkspaceRole === activeProfile.role;
  setVisible("workspace", true);
  setVisible("signOut", true);
  if (!resumeLoadedWorkspace) clearWorkspaceAgendaResults();
  setVisible("workspaceLoading", true);
  $("workspaceLoadingMessage").textContent = "Tu acceso está verificado. Estamos preparando tu espacio.";
  $("workspaceLoadingRetry").classList.add("hidden");
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
  if ($("presentationName")) $("presentationName").value = activeProfile.presentation_name ?? derivePresentationName(activeProfile.display_name);
  const rolePill = $("rolePill");
  rolePill.textContent = activeProfile.role === "admin" ? "Administrador" : activeProfile.role === "master" ? "Master" : "Técnico";
  rolePill.className = `pill ${activeProfile.role}`;
  $("roleDescription").textContent = activeProfile.role === "admin"
    ? "Panel de administración. Esta cuenta no abre agendas ni instalaciones."
    : "";
  setVisible("roleDescription", activeProfile.role === "admin");
  diagnostic.verifiedShellMs = performance.now() - diagnostic.startedAt;
  finishStartup();
  const roleDataStartedAt = performance.now();
  if (activeProfile.role === "admin") {
    setVisible("agendaSettingsGroup", false);
    if (!resumeLoadedWorkspace) {
      setVisible("workspaceLoading", false);
      setVisible("adminPanelLoading", true);
      diagnostic.panelShellMs = performance.now() - diagnostic.startedAt;
      publishLoginDiagnostic(diagnostic, null, "panel_shell_ready");
      const loaded = await loadAdminPanel();
      if (!loaded) {
        showWorkspaceLoadFailure("No se pudo cargar el panel. Comprueba la conexión e inténtalo de nuevo.");
        publishLoginDiagnostic(diagnostic, performance.now() - roleDataStartedAt, "role_data_failed");
        return;
      }
      initializedWorkspaceUserId = activeUser.id;
      initializedWorkspaceRole = activeProfile.role;
    }
    finishWorkspaceLoading(diagnostic);
    publishLoginDiagnostic(diagnostic, performance.now() - roleDataStartedAt);
  } else if (activeProfile.role === "master") {
    const navigation = masterNavigation.read(activeUser.id);
    selectedMasterView = navigation.view;
    masterSelectedTechnicianId = navigation.technicianId;
    masterRouteDayOffset = navigation.dayOffset;
    masterRouteDate = addLocalDays(todayMadrid(), masterRouteDayOffset);
    setVisible("agendaSettingsGroup", true);
    appointmentDate = addLocalDays(todayMadrid(), appointmentDayOffset);
    renderAgendaDateNavigation();
    setVisible("appointmentsLoading", !resumeLoadedWorkspace);
    setVisible("masterAppointmentsLoading", !resumeLoadedWorkspace);
    if (resumeLoadedWorkspace) {
      finishWorkspaceLoading(diagnostic);
      publishLoginDiagnostic(diagnostic, 0);
      return;
    }
    try {
      const ownAppointmentsPromise = loadOwnAppointments(appointmentDate).catch(() => false);
      const [masterLoaded] = await Promise.all([
        loadMasterPanel(), loadAppointmentTeams(), loadAppointmentPreferences(),
      ]);
      if (!masterLoaded) throw new Error("workspace data unavailable");
      initializedWorkspaceUserId = activeUser.id;
      initializedWorkspaceRole = activeProfile.role;
      finishWorkspaceLoading(diagnostic);
      const [ownAppointmentsLoaded, masterAppointmentsLoaded] = await Promise.all([
        ownAppointmentsPromise, loadMasterAppointments(),
      ]);
      setVisible("appointmentsLoading", false);
      setVisible("masterAppointmentsLoading", false);
      if (!ownAppointmentsLoaded || !masterAppointmentsLoaded) throw new Error("appointment data unavailable");
      publishLoginDiagnostic(diagnostic, performance.now() - roleDataStartedAt);
    } catch {
      appointmentNotice("No se pudo cargar tu agenda o el equipo. Actualiza la página e inténtalo de nuevo.", "error");
      setVisible("appointmentsLoading", false);
      setVisible("masterAppointmentsLoading", false);
      if (!initializedWorkspaceUserId) showWorkspaceLoadFailure("No se pudo cargar el equipo. Vuelve a intentarlo.");
      publishLoginDiagnostic(diagnostic, performance.now() - roleDataStartedAt, "role_data_failed");
    }
  } else {
    setVisible("agendaSettingsGroup", true);
    setVisible("masterViewTabs", false);
    appointmentDate = addLocalDays(todayMadrid(), appointmentDayOffset);
    renderAgendaDateNavigation();
    setVisible("appointmentsLoading", !resumeLoadedWorkspace);
    if (resumeLoadedWorkspace) {
      finishWorkspaceLoading(diagnostic);
      publishLoginDiagnostic(diagnostic, 0);
      return;
    }
    try {
      const ownAppointmentsPromise = loadOwnAppointments(appointmentDate).catch(() => false);
      await Promise.all([loadAppointmentTeams(), loadAppointmentPreferences()]);
      initializedWorkspaceUserId = activeUser.id;
      initializedWorkspaceRole = activeProfile.role;
      finishWorkspaceLoading(diagnostic);
      const ownAppointmentsLoaded = await ownAppointmentsPromise;
      setVisible("appointmentsLoading", false);
      if (!ownAppointmentsLoaded) throw new Error("appointment data unavailable");
      publishLoginDiagnostic(diagnostic, performance.now() - roleDataStartedAt);
    } catch {
      appointmentNotice("No se pudo cargar la agenda. Actualiza la página e inténtalo de nuevo.", "error");
      setVisible("appointmentsLoading", false);
      if (!initializedWorkspaceUserId) showWorkspaceLoadFailure("No se pudo cargar el equipo. Vuelve a intentarlo.");
      publishLoginDiagnostic(diagnostic, performance.now() - roleDataStartedAt, "role_data_failed");
    }
  }
}

function persistMasterNavigation() {
  if (activeProfile?.role !== "master" || !activeUser?.id) return;
  masterNavigation.save(activeUser.id, {
    view: selectedMasterView,
    technicianId: $("masterTechnicianSelect")?.value || masterSelectedTechnicianId,
    dayOffset: masterRouteDayOffset,
  });
}

function setMasterView(view, { persist = true } = {}) {
  const panels = {
    appointments: "appointmentsPanel",
    routes: "masterPanel",
    technicians: "masterTechniciansPanel",
    create: "masterCreatePanel",
  };
  if (!Object.hasOwn(panels, view)) view = "appointments";
  selectedMasterView = view;
  for (const [key, id] of Object.entries(panels)) setVisible(id, key === view);
  for (const [key, id] of Object.entries({
    appointments: "masterOwnTab", routes: "masterRouteTab",
    technicians: "masterTechniciansTab", create: "masterCreateTab",
  })) {
    $(id).className = `button ${key === view ? "primary" : "secondary"}`;
    $(id).setAttribute("aria-current", key === view ? "page" : "false");
  }
  if (persist) persistMasterNavigation();
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
  if (profile.role === "technician" && Object.hasOwn(profile, "employee_id")) {
    const identifier = document.createElement("p");
    identifier.textContent = `Matrícula: ${profile.employee_id || "—"}`;
    main.append(identifier);
  }
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

function makeMasterTechnicianCard(profile, teamName, actions = []) {
  const card = document.createElement("article");
  card.className = "account-card master-technician-card";
  const details = document.createElement("div");
  const name = document.createElement("h4");
  name.textContent = profile.display_name;
  const employeeId = document.createElement("p");
  employeeId.textContent = `Matrícula: ${profile.employee_id || "—"}`;
  const team = document.createElement("p");
  team.textContent = `Equipo: ${teamName}`;
  details.append(name, employeeId, team);
  card.append(details);
  if (actions.length) {
    const menu = document.createElement("details");
    menu.className = "master-technician-actions";
    const summary = document.createElement("summary");
    summary.textContent = "Acciones";
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
    menu.append(summary, buttonBox);
    card.append(menu);
  }
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
  cancellation_email_to: DEFAULT_CANCEL_TO,
  cancellation_email_cc: DEFAULT_CANCEL_CC,
  cancellation_email_subject: "Cliente cancela - Prospecto {MTO}",
});

async function loadAppointmentPreferences() {
  const { data, error } = await supabase.rpc("cc_my_appointment_preferences");
  if (error) throw new Error("preferences unavailable");
  appointmentPreferences = { ...defaultAppointmentPreferences(), ...(data ?? {}) };
  for (const [field, fallback] of [["cancellation_email_to", DEFAULT_CANCEL_TO], ["cancellation_email_cc", DEFAULT_CANCEL_CC]]) {
    if (data?.[field] == null) appointmentPreferences[field] = fallback;
  }
  appointmentDate = addLocalDays(todayMadrid(), appointmentDayOffset);
  renderAgendaDateNavigation();
  $("installationKeywords").value = (appointmentPreferences.installation_keywords ?? []).join("\n");
  $("installationTemplate").value = appointmentPreferences.installation_template ?? DEFAULT_INSTALLATION_TEMPLATE;
  $("maintenanceTemplate").value = appointmentPreferences.maintenance_template ?? DEFAULT_MAINTENANCE_TEMPLATE;
  $("cancellationTemplate").value = appointmentPreferences.cancellation_template ?? DEFAULT_CANCELLATION_TEMPLATE;
  $("cancelEmailTo").value = appointmentPreferences.cancellation_email_to ?? "";
  $("cancelEmailCc").value = appointmentPreferences.cancellation_email_cc ?? "";
  $("cancelEmailSubject").value = appointmentPreferences.cancellation_email_subject ?? "";
}

async function loadOwnAppointments(date = appointmentDate) {
  const requestSequence = ++ownAppointmentsRequestSequence;
  appointmentDate = date || addLocalDays(todayMadrid(), 1);
  const [dayResult, indexResult, ignoredResult] = await Promise.all([
    supabase.rpc("cc_my_appointments", { p_work_date: appointmentDate }),
    supabase.rpc("cc_my_appointment_identity_index"),
    supabase.rpc("cc_my_ignored_interventions", { p_work_date: appointmentDate }),
  ]);
  if (dayResult.error || indexResult.error || ignoredResult.error || !Array.isArray(dayResult.data) || !Array.isArray(indexResult.data)) {
    if (requestSequence !== ownAppointmentsRequestSequence) return true;
    appointmentNotice("No se pudo recuperar la agenda. Comprueba la conexión e inténtalo de nuevo.", "error");
    return false;
  }
  if (requestSequence !== ownAppointmentsRequestSequence) return true;
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
  if (digits.length < 9 || digits.length > 15) issues.push("Teléfono no válido");
  if (!String(row.population ?? "").trim()) issues.push("Población no detectada");
  if (!String(row.full_address ?? "").trim()) issues.push("Dirección no detectada");
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
  appointmentNotice("Texto compartido cargado. Revísalo y pulsa Procesar instalaciones para importar.", "success");
  window.history.replaceState({}, "", window.location.pathname);
}

let appointmentIdentityIndex = [];

function setAgendaFilter(filter) {
  appointmentFilter = filter;
  renderAppointments();
}

function renderAgendaDateNavigation() {
  const target = $("agendaDateNav");
  renderThreeDaySelector(target, appointmentDate, appointmentDayOffset, (date, offset) => {
    appointmentDayOffset = offset;
    void selectAppointmentDate(date);
  });
  $("appointmentDateTitle").textContent = formatDateTitle(appointmentDate);
}

function renderThreeDaySelector(target, selectedDate, selectedOffset, onSelect) {
  target.replaceChildren();
  const today = todayMadrid();
  for (const { offset, label: dayLabel } of [
    { offset: -1, label: "Ayer" }, { offset: 0, label: "Hoy" }, { offset: 1, label: "Mañana" },
  ]) {
    const date = addLocalDays(today, offset);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button secondary datechip date-option${date === selectedDate ? " on" : ""}${offset === 0 ? " today" : ""}`;
    const label = document.createElement("span"); label.className = "date-option-label"; label.textContent = dayLabel;
    const value = document.createElement("span"); value.className = "date-option-value"; value.textContent = formatDateChip(date);
    button.append(label, value);
    button.setAttribute("aria-label", `${dayLabel}, ${formatDateTitle(date)}`);
    button.setAttribute("aria-pressed", String(offset === selectedOffset));
    button.addEventListener("click", () => onSelect(date, offset));
    target.append(button);
  }
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
  nextButton.textContent = next ? "📲 WhatsApp · siguiente pendiente" : "No hay pendientes disponibles";
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
      line.textContent = `${item.time} · ${item.type || "Tipo no detectado"}`;
      summary.append(line);
    }
    ignoredTarget.append(summary);
  }
  const list = $("appointmentList");
  list.replaceChildren();
  if (appointmentFilter === "Ignoradas") {
    if (!ignoredAppointments.length) {
      const empty = document.createElement("div"); empty.className = "agenda-empty";
      empty.textContent = "No hay intervenciones omitidas en la última importación."; list.append(empty);
    } else {
      for (const item of ignoredAppointments) {
        const line = document.createElement("article"); line.className = "appointment-card";
        line.textContent = `${item.time} · ${item.type || "Tipo no detectado"} · No importada (no es instalación)`;
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
    ready.textContent = "✓ Agenda preparada · no quedan citas pendientes"; list.append(ready);
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
    contact.textContent = `WhatsApp abierto · ${new Date(row.contacted_at).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}`;
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
    warning.textContent = `⚠ ${issue}`;
    card.append(warning);
  }
  if (row.last_changes?.length) {
    const change = document.createElement("div"); change.className = "notice changes";
    const text = document.createElement("span"); text.textContent = `Cambios detectados: ${row.last_changes.join(" · ")}`;
    const acknowledge = document.createElement("button"); acknowledge.className = "button secondary"; acknowledge.type = "button";
    acknowledge.textContent = "Entendido"; acknowledge.addEventListener("click", () => {
      importChangesBySource.delete(row.source_key); row.last_changes = []; renderAppointments();
    });
    change.append(text, acknowledge); card.append(change);
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
  addAction("WhatsApp", () => void openAppointmentWhatsApp(row), "primary");
  addAction("Llamar", () => callAppointment(row));
  addAction("Maps", () => openAppointmentMaps(row));
  addAction("Editar", () => editAppointment(row));
  addAction("Revisar mensaje", () => reviewWhatsApp(row));
  addAction("Pendiente", () => changeAppointmentStatus(row, "pending"));
  addAction("Confirmar", () => changeAppointmentStatus(row, "confirmed"), "primary");
  addAction("Cancelar", () => changeAppointmentStatus(row, "cancelled"), "danger");
  addAction("Nota", () => editAppointmentNote(row));
  addAction("Copiar dirección", () => copyAppointmentAddress(row));
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
  if (row.issues?.length) { appointmentNotice(`Revisa primero: ${row.issues.join(", ")}.`, "error"); return; }
  if (row.contacted_at) {
    const time = new Date(row.contacted_at).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
    if (!window.confirm(`Ya abriste WhatsApp para esta cita a las ${time}. ¿Abrirlo de nuevo?`)) return;
  }
  const template = appointmentPreferences.installation_template || DEFAULT_INSTALLATION_TEMPLATE;
  const message = customMessage || appointmentMessage(template, row);
  const phone = normalizePhoneForWhatsApp(row.phone);
  if (!phone) { appointmentNotice("No hay teléfono válido para abrir WhatsApp.", "error"); return; }
  let openedWindow;
  try {
    openedWindow = window.open(buildWhatsAppUrl(phone, message, navigator.userAgent), "_blank");
    if (openedWindow) openedWindow.opener = null;
  } catch {
    openedWindow = null;
  }
  if (!openedWindow) {
    appointmentNotice("El navegador bloqueó la apertura de WhatsApp. Permite las ventanas emergentes e inténtalo de nuevo.", "error");
    return;
  }
  const { data, error } = await supabase.rpc("cc_record_whatsapp_open", { p_appointment_id: row.id });
  if (error || !data) {
    appointmentNotice("WhatsApp se abrió, pero no se pudo guardar el contacto. El mensaje no consta como enviado.", "error");
    return;
  }
  row.contacted_at = data;
  renderAppointments();
  appointmentNotice("WhatsApp abierto. El registro no confirma que se haya enviado el mensaje.", "success");
}

function callAppointment(row) {
  const phone = normalizePhoneForCall(row.phone);
  if (!phone) { appointmentNotice("No hay teléfono válido para llamar.", "error"); return; }
  window.location.href = `tel:${phone}`;
}

function openAppointmentMaps(row) {
  const query = [cleanMapAddress(row.full_address, row.population), row.postal_code].filter(Boolean).join(", ");
  if (!query.trim()) { appointmentNotice("No hay dirección para abrir Maps.", "error"); return; }
  window.location.assign(buildMapsUrl(query, navigator.userAgent));
}

async function copyAppointmentAddress(row) {
  const address = [row.full_address, row.postal_code, row.population].filter(Boolean).join(", ");
  if (!address) { appointmentNotice("No hay dirección para copiar.", "error"); return; }
  try { await navigator.clipboard.writeText(address); appointmentNotice("Dirección copiada.", "success"); }
  catch { window.prompt("Copia la dirección:", address); }
}

function reviewWhatsApp(row) {
  const template = appointmentPreferences.installation_template || DEFAULT_INSTALLATION_TEMPLATE;
  previewAppointment = row;
  $("messagePreviewText").value = appointmentMessage(template, row);
  $("messagePreviewDialog").showModal();
}

async function editAppointment(row) {
  activeEditAppointment = row;
  $("editScheduledTime").value = String(row.scheduled_time ?? "").slice(0, 5);
  $("editPopulation").value = row.population ?? "";
  $("editPhone").value = row.phone ?? "";
  $("editAddress").value = row.full_address ?? "";
  $("editPostalCode").value = row.postal_code ?? "";
  $("editAppointmentDialog").showModal();
}

async function saveAppointmentDetails(event) {
  event.preventDefault();
  const row = activeEditAppointment;
  if (!row) return;
  const { error } = await supabase.rpc("cc_edit_appointment_details", {
    p_appointment_id: row.id, p_scheduled_time: $("editScheduledTime").value,
    p_population: $("editPopulation").value.trim(), p_phone: $("editPhone").value,
    p_full_address: $("editAddress").value, p_postal_code: $("editPostalCode").value,
  });
  if (error) { appointmentNotice("No se pudieron guardar los cambios privados.", "error"); return; }
  $("editAppointmentDialog").close();
  activeEditAppointment = null;
  appointmentNotice("Información actualizada.", "success");
  await loadOwnAppointments(appointmentDate);
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
  const oldStatus = row.status;
  const oldReason = row.cancellation_reason ?? "";
  let emailToOpen = "";
  if (oldStatus === status) return;
  if (status === "cancelled") {
    const reason = window.prompt("Motivo comunicado por el cliente");
    if (reason === null) return;
    if (!reason.trim()) { appointmentNotice("Indica el motivo de cancelación.", "error"); return; }
    const { error } = await supabase.rpc("cc_cancel_appointment", { p_appointment_id: row.id, p_reason: reason.trim() });
    if (error) { appointmentNotice("No se pudo registrar la cancelación.", "error"); return; }
    row.cancellation_reason = reason.trim();
    emailToOpen = buildCancellationEmail(row, reason.trim());
  } else {
    const { error } = await supabase.rpc("cc_set_appointment_status", { p_appointment_id: row.id, p_new_status: status });
    if (error) { appointmentNotice("No se pudo cambiar el estado.", "error"); return; }
  }
  appointmentNotice(`Cita actualizada: ${humanStatus(status)}.`, "success");
  await loadOwnAppointments(appointmentDate);
  showUndoToast(`Marcada como ${humanStatus(status).toLowerCase()}`, async () => {
    const restoreStatus = oldStatus;
    if (restoreStatus !== "cancelled") {
      const { error } = await supabase.rpc("cc_set_appointment_status", { p_appointment_id: row.id, p_new_status: restoreStatus });
      if (error) throw error;
    } else {
      const { error } = await supabase.rpc("cc_cancel_appointment", { p_appointment_id: row.id, p_reason: oldReason || "Motivo previamente registrado" });
      if (error) throw error;
    }
    const { error: privateError } = await supabase.rpc("cc_save_appointment_private", {
      p_appointment_id: row.id, p_phone: row.phone ?? "", p_full_address: row.full_address ?? "",
      p_postal_code: row.postal_code ?? "", p_private_note: row.private_note ?? "",
      p_cancellation_reason: oldReason,
    });
    if (privateError) throw privateError;
    await loadOwnAppointments(appointmentDate);
    appointmentNotice("Se deshizo el cambio de estado.", "success");
  });
  if (emailToOpen) window.location.href = emailToOpen;
}

function showUndoToast(message, undo) {
  document.getElementById("agendaUndoToast")?.remove();
  const toast = document.createElement("div"); toast.id = "agendaUndoToast"; toast.className = "undo-toast";
  const label = document.createElement("span"); label.textContent = message;
  const button = document.createElement("button"); button.className = "button secondary"; button.type = "button"; button.textContent = "DESHACER";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await undo(); toast.remove(); }
    catch { appointmentNotice("No se pudo deshacer el cambio; actualiza la agenda para comprobar su estado.", "error"); }
  });
  toast.append(label, button); document.body.append(toast);
  clearTimeout(undoTimer); undoTimer = setTimeout(() => toast.remove(), 6000);
}

function buildCancellationEmail(row, reason) {
  const template = appointmentPreferences.cancellation_template || DEFAULT_CANCELLATION_TEMPLATE;
  const subject = fillAppointmentTemplate(appointmentPreferences.cancellation_email_subject || "Cliente cancela - Prospecto {MTO}", row, activeProfile?.display_name, reason);
  const body = fillAppointmentTemplate(template, row, activeProfile?.display_name, reason);
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
    const changes = compareImportedAppointment(old, item);
    if (changes.length) importChangesBySource.set(sourceKey, changes);
    else importChangesBySource.delete(sourceKey);
    rows.push({
      source_key: sourceKey, work_date: appointmentDate, scheduled_time: item.time,
      population: item.population || "Población pendiente", prospect_ref: item.prospect_ref,
      kind: "installation", type: item.type, phone: item.phone,
      full_address: item.full_address, postal_code: item.postal_code,
      private_note: old?.private_note ?? "", cancellation_reason: old?.cancellation_reason ?? "",
    });
  }
  for (const old of appointmentIdentityIndex.filter((candidate) => candidate.work_date === appointmentDate && !usedSources.has(candidate.source_key))) {
    importChangesBySource.set(old.source_key, ["Una cita ya no aparece en Oracle"]);
  }
  const duplicateProspects = rows.filter((row, index) => row.prospect_ref && rows.findIndex((other) => other.prospect_ref === row.prospect_ref) !== index);
  if (duplicateProspects.length) { appointmentNotice("Oracle contiene referencias de prospecto duplicadas; revisa el texto antes de importar.", "error"); return; }
  const { data, error } = await supabase.rpc("cc_sync_appointment_batch", {
    p_team_id: selectedAppointmentTeam, p_work_date: appointmentDate, p_rows: rows,
  });
  if (error) { appointmentNotice("La importación no se pudo guardar. Revisa el equipo y la fecha e inténtalo de nuevo.", "error"); return; }
  const { error: ignoredError } = await supabase.rpc("cc_save_my_ignored_interventions", {
    p_work_date: appointmentDate, p_rows: ignoredAppointments,
  });
  $("oracleText").value = "";
  await loadOwnAppointments(appointmentDate);
  appointmentNotice(ignoredError
    ? `Importación guardada: ${Number(data) || 0} instalaciones, pero no se sincronizó la lista de intervenciones omitidas.`
    : `Importación guardada: ${Number(data) || 0} instalaciones. Se conservaron los estados y notas existentes.`, ignoredError ? "error" : "success");
}

async function loadMasterAppointments() {
  const requestSequence = ++masterAppointmentsRequestSequence;
  const date = masterRouteDate || addLocalDays(todayMadrid(), masterRouteDayOffset);
  masterRouteDate = date;
  renderThreeDaySelector($("masterDateNav"), date, masterRouteDayOffset, (selected, offset) => {
    masterRouteDayOffset = offset;
    masterRouteDate = selected;
    persistMasterNavigation();
    void loadMasterAppointments();
  });
  const technicianId = $("masterTechnicianSelect").value;
  masterSelectedTechnicianId = technicianId || "";
  persistMasterNavigation();
  const { data, error } = await supabase.rpc("cc_master_team_appointments", { p_work_date: date });
  if (requestSequence !== masterAppointmentsRequestSequence) return true;
  const target = $("masterAppointmentList");
  target.replaceChildren();
  if (error || !Array.isArray(data)) { target.textContent = "No se pudo consultar la supervisión."; return false; }
  const rows = data.filter((row) => technicianId && row.technician_id === technicianId);
  if (!rows.length) { const empty = document.createElement("div"); empty.className = "agenda-empty"; empty.textContent = technicianId ? "Este técnico no tiene citas para esta fecha." : "Selecciona un técnico de tus equipos para consultar su ruta."; target.append(empty); return true; }
  for (const row of rows) {
    const item = document.createElement("article"); item.className = "master-appointment-row";
    const content = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = `${row.scheduled_time} · ${row.population} · ${row.technician}`;
    const meta = document.createElement("span"); meta.textContent = "Fecha: " + formatDateTitle(row.work_date) + " · Prospecto: " + (row.prospect_ref || "—");
    const status = document.createElement("span");
    status.className = "state-badge master-route-status " + row.status;
    status.textContent = humanStatus(row.status);
    content.append(title, meta);
    const side = document.createElement("div");
    side.className = "master-route-indicators";
    side.append(status);
    const contact = document.createElement("span");
    contact.className = `contact-badge${row.contacted_at ? "" : " not-contacted"}`;
    contact.textContent = row.contacted_at
      ? `WhatsApp abierto · ${new Date(row.contacted_at).toLocaleString("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
      : "WhatsApp no abierto";
    side.append(contact);
    const updated = document.createElement("span"); updated.textContent = `Actualizada ${new Date(row.last_updated_at).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}`; side.append(updated);
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

function restoreV1Defaults() {
  if (!window.confirm("Se restaurarán la plantilla de instalación, la de mantenimiento y la de cancelación, además de los destinatarios y el asunto. ¿Continuar?")) return;
  $("installationTemplate").value = DEFAULT_INSTALLATION_TEMPLATE;
  $("maintenanceTemplate").value = DEFAULT_MAINTENANCE_TEMPLATE;
  $("cancellationTemplate").value = DEFAULT_CANCELLATION_TEMPLATE;
  $("cancelEmailTo").value = DEFAULT_CANCEL_TO;
  $("cancelEmailCc").value = DEFAULT_CANCEL_CC;
  $("cancelEmailSubject").value = "Cliente cancela - Prospecto {MTO}";
  $("appointmentPreferences").requestSubmit();
}

async function deleteAppointmentDay() {
  if (!window.confirm(`¿Borrar todo el historial de ${formatDateTitle(appointmentDate)}? Se eliminarán citas, estados, contactos, teléfonos, direcciones, notas y motivos de cancelación de ese día.`)) return;
  const { data, error } = await supabase.rpc("cc_delete_my_appointment_day", { p_work_date: appointmentDate });
  if (error) { appointmentNotice("No se pudo borrar la agenda de ese día.", "error"); return; }
  importChangesBySource.clear();
  appointmentNotice(`Se eliminaron ${Number(data) || 0} citas de tu agenda.`, "success");
  await loadOwnAppointments(appointmentDate);
}

async function savePresentationName(event) {
  event.preventDefault();
  const presentationName = $("presentationName").value.trim();
  if (!presentationName || presentationName.length > 120) {
    appointmentNotice("Escribe un nombre de presentación de 1 a 120 caracteres.", "error");
    return;
  }
  const { error } = await supabase.rpc("cc_set_my_presentation_name", { p_presentation_name: presentationName });
  if (error) { appointmentNotice("No se pudo guardar el nombre para los mensajes.", "error"); return; }
  activeProfile.presentation_name = presentationName;
  $("presentationName").value = presentationName;
  appointmentNotice("Nombre para los mensajes actualizado.", "success");
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
  const routeSelect = $("masterTechnicianSelect");
  const previousTechnician = routeSelect.value || masterSelectedTechnicianId;
  routeSelect.replaceChildren();
  const technicianProfiles = new Map();
  for (const profile of (Array.isArray(accountsResult.data) ? accountsResult.data : [])) {
    if (profile.account_status !== "active" || profile.membership_status !== "active" || profile.must_change_password) continue;
    if (!technicianProfiles.has(profile.technician_id)) technicianProfiles.set(profile.technician_id, profile.display_name);
  }
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Selecciona un técnico"; placeholder.disabled = true;
  routeSelect.append(placeholder);
  for (const [technicianId, name] of [...technicianProfiles].sort((a, b) => a[1].localeCompare(b[1], "es"))) {
    const option = document.createElement("option"); option.value = technicianId; option.textContent = name;
    routeSelect.append(option);
  }
  if ([...routeSelect.options].some((option) => option.value === previousTechnician && previousTechnician)) {
    routeSelect.value = previousTechnician;
    masterSelectedTechnicianId = previousTechnician;
  } else {
    routeSelect.value = "";
    masterSelectedTechnicianId = "";
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
    accountTarget.append(makeMasterTechnicianCard({
      display_name: profile.display_name,
      role: "technician",
      employee_id: profile.employee_id_display,
    }, teamName, actions));
  }
  if (!accountTarget.childElementCount) accountTarget.textContent = "No hay técnicos asignados todavía.";
  renderThreeDaySelector($("masterDateNav"), masterRouteDate, masterRouteDayOffset, (date, offset) => {
    masterRouteDate = date; masterRouteDayOffset = offset; void loadMasterAppointments();
  });
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
    presentation_name: formData.presentation_name,
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
    const attempt = {
      source: "interactive_login", startedAt: performance.now(), edgeRequestMs: null, sessionInstallMs: null,
    };
    activeLoginAttempt = attempt;
    const edgeRequestStartedAt = performance.now();
    const { data, error } = await supabase.functions.invoke("login-by-matricula", {
      body: { login_id: employeeId, password },
    });
    attempt.edgeRequestMs = performance.now() - edgeRequestStartedAt;
    $("password").value = "";
    if (error || data?.error || !data?.session) {
      activeLoginAttempt = null;
      publishLoginDiagnostic(attempt, null, "edge_request_failed");
      notify("No se pudo iniciar sesión. Comprueba los datos o contacta con el administrador.", "error");
      return;
    }
    attempt.sessionInstallStartedAt = performance.now();
    const { error: sessionError } = await supabase.auth.setSession(data.session);
    attempt.sessionInstallMs = performance.now() - attempt.sessionInstallStartedAt;
    delete attempt.sessionInstallStartedAt;
    if (sessionError) {
      activeLoginAttempt = null;
      publishLoginDiagnostic(attempt, null, "session_install_failed");
      notify("No se pudo iniciar sesión. Comprueba los datos o contacta con el administrador.", "error");
    }
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
  $("settingsToggle").addEventListener("click", settingsNavigation.open);
  $("settingsClose").addEventListener("click", settingsNavigation.close);
  $("workspaceLoadingRetry").addEventListener("click", () => {
    window.__CC_APP_READY__ = false;
    setVisible("startupStatus", true);
    void routeSession().catch(() => window.__CC_SHOW_INIT_ERROR__?.());
  });
  $("signOut").addEventListener("click", async () => {
    hideWorkspacePanels();
    setVisible("startupStatus", true);
    const { error } = await supabase.auth.signOut();
    if (error) await supabase.auth.signOut({ scope: "local" });
    await routeSession();
    if (error) notify("Sesión local cerrada. Comprueba la conexión para confirmar el cierre remoto.", "error");
  });
  $("masterOwnTab").addEventListener("click", () => setMasterView("appointments"));
  $("masterRouteTab").addEventListener("click", () => {
    setMasterView("routes");
    void loadMasterAppointments();
  });
  $("masterTechniciansTab").addEventListener("click", () => setMasterView("technicians"));
  $("masterCreateTab").addEventListener("click", () => setMasterView("create"));
  $("appointmentTeam").addEventListener("change", () => { selectedAppointmentTeam = $("appointmentTeam").value; });
  $("importClipboard").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setVisible("manualImport", true);
        appointmentNotice("El portapapeles está vacío. Pega el texto de Oracle en el cuadro inferior.", "error");
        $("oracleText").focus();
        return;
      }
      $("oracleText").value = text;
      await processOracleText();
    } catch {
      setVisible("manualImport", true);
      appointmentNotice("El navegador no permitió leer el portapapeles. Pega el texto manualmente.", "error");
      $("oracleText").focus();
    }
  });
  $("processOracle").addEventListener("click", () => void processOracleText());
  $("pasteOracle").addEventListener("click", async () => {
    try { $("oracleText").value = await navigator.clipboard.readText(); }
    catch { appointmentNotice("No se pudo leer el portapapeles. Mantén pulsado en el cuadro y elige Pegar.", "error"); }
  });
  $("appointmentPreferences").addEventListener("submit", saveAppointmentPreferences);
  $("restoreCancellationDefaults").addEventListener("click", restoreV1Defaults);
  $("deleteAgendaDay").addEventListener("click", () => void deleteAppointmentDay());
  $("presentationNameForm").addEventListener("submit", savePresentationName);
  $("editAppointmentForm").addEventListener("submit", saveAppointmentDetails);
  $("cancelEditAppointment").addEventListener("click", () => { $("editAppointmentDialog").close(); activeEditAppointment = null; });
  $("closePreviewDialog").addEventListener("click", () => { $("messagePreviewDialog").close(); previewAppointment = null; });
  $("copyPreviewMessage").addEventListener("click", async () => {
    const message = $("messagePreviewText").value;
    try { await navigator.clipboard.writeText(message); appointmentNotice("Mensaje copiado. WhatsApp no se ha abierto.", "success"); }
    catch { window.prompt("Copia el mensaje completo:", message); }
  });
  $("openPreviewWhatsApp").addEventListener("click", () => {
    if (!previewAppointment) return;
    const row = previewAppointment;
    const message = $("messagePreviewText").value;
    $("messagePreviewDialog").close(); previewAppointment = null;
    void openAppointmentWhatsApp(row, message);
  });
  $("messagePreviewDialog").addEventListener("click", (event) => {
    if (event.target === $("messagePreviewDialog")) $("messagePreviewDialog").close();
  });
  for (const [fullNameId, presentationNameId] of [["newDisplayName", "newPresentationName"], ["masterDisplayName", "masterPresentationName"]]) {
    const fullName = $(fullNameId);
    const presentationName = $(presentationNameId);
    let previousAutomatic = "";
    fullName.addEventListener("input", () => {
      const current = presentationName.value.trim();
      if (!current || current === previousAutomatic) {
        previousAutomatic = derivePresentationName(fullName.value);
        presentationName.value = previousAutomatic;
      }
    });
  }
  $("masterTechnicianSelect").addEventListener("change", () => {
    masterSelectedTechnicianId = $("masterTechnicianSelect").value;
    persistMasterNavigation();
    void loadMasterAppointments();
  });
  $("refreshMasterRoute").addEventListener("click", () => void loadMasterAppointments());
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
      presentation_name: $("newPresentationName").value,
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
        presentation_name: $("masterPresentationName").value,
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

function refreshMadridDates() {
  const today = todayMadrid();
  if (today === previousMadridDate) return;
  previousMadridDate = today;
  appointmentDate = addLocalDays(today, appointmentDayOffset);
  masterRouteDate = addLocalDays(today, masterRouteDayOffset);
  renderAgendaDateNavigation();
  renderThreeDaySelector($("masterDateNav"), masterRouteDate, masterRouteDayOffset, (date, offset) => {
    masterRouteDate = date; masterRouteDayOffset = offset; void loadMasterAppointments();
  });
  if (!activeProfile || activeProfile.role === "admin") return;
  if (activeProfile.role === "technician" || $("appointmentsPanel").classList.contains("hidden") === false) {
    importChangesBySource.clear(); ignoredAppointments = [];
    void loadOwnAppointments(appointmentDate);
  }
  if (activeProfile.role === "master" && !$("masterPanel").classList.contains("hidden")) void loadMasterAppointments();
}

async function start() {
  hideWorkspacePanels();
  if (!configured) {
    finishStartup();
    setVisible("configWarning", true);
    return;
  }
  if (config.authEnabled !== true) {
    finishStartup();
    setVisible("authDisabled", true);
    return;
  }
  bindEvents();
  createSupabaseClient();
  supabase.auth.onAuthStateChange((event) => {
    if (["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED", "PASSWORD_RECOVERY"].includes(event)) {
      if (event === "SIGNED_OUT") {
        if (activeUser?.id) masterNavigation.clear(activeUser.id);
        activeUser = null;
        activeProfile = null;
        initializedWorkspaceUserId = null;
        initializedWorkspaceRole = null;
        masterSelectedTechnicianId = "";
        selectedMasterView = "appointments";
        appointmentDayOffset = 1;
        masterRouteDayOffset = 1;
      }
      const preserveWorkspace = event !== "SIGNED_OUT"
        && Boolean(activeUser?.id
          && initializedWorkspaceUserId === activeUser.id
          && initializedWorkspaceRole === activeProfile?.role);
      queueMicrotask(() => { void routeSession({ preserveWorkspace }).catch(() => window.__CC_SHOW_INIT_ERROR__?.()); });
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    hideWorkspacePanels();
    setVisible("startupError", false);
    setVisible("startupStatus", true);
    window.__CC_APP_READY__ = false;
    const preserveWorkspace = Boolean(activeUser?.id
      && initializedWorkspaceUserId === activeUser.id
      && initializedWorkspaceRole === activeProfile?.role);
    void routeSession({ preserveWorkspace }).catch(() => window.__CC_SHOW_INIT_ERROR__?.());
  });
  window.addEventListener("pagehide", () => {
    // Hide authenticated DOM before a browser can freeze this document in its back/forward cache.
    hideWorkspacePanels();
    window.__CC_APP_READY__ = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshMadridDates();
  });
  window.setInterval(refreshMadridDates, 30_000);
  await routeSession();
}

start().catch(() => {
  if (typeof window.__CC_SHOW_INIT_ERROR__ === "function") window.__CC_SHOW_INIT_ERROR__();
  else {
    setVisible("startupStatus", false);
    setVisible("startupError", true);
    console.error("[Confirmar Citas] Error de inicialización (CC_INIT_FAILED)");
  }
});

