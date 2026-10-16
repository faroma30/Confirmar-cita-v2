Warning: truncated output (original token count: 27937)
Total output lines: 2266

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import { captureSubmittedForm } from "./form-events.mjs";
import { createSettingsNavigation } from "./settings-navigation.mjs";
import { createIssuesUI } from "./issues-ui.mjs?v=3cd1";
import { isActiveAdminProfile } from "./admin-wifi-ocr-source.mjs";
import { checkKpiAvailability, resolveKpiDashboardUrl } from "./kpi-access.mjs?v=3bu1";
import { createAdminRoutesUI } from "./admin-routes-ui.mjs?v=3bu1";
import { createMasterNavigationStorage } from "./master-navigation.mjs?v=3cd1";
import { appendCancellationReason } from "./cancellation-reason.mjs?v=3bu1";
import { adminCounts, filterAdminAccounts, masterTeamSummary } from "./dashboard-insights.mjs";
import { cleanMapAddress, normalizePhoneForCall, normalizePhoneForWhatsApp, parseOracleInstallations, stableSourceKey } from "./agenda-parser.mjs";
import { derivePresentationName, fillAppointmentTemplate } from "./message-template.mjs";
import { appointmentDateLabels, buildMapsUrl, buildWhatsAppUrl, compareImportedAppointment, dateOffset, madridDate } from "./agenda-parity.mjs";

const $ = (id) => document.getElementById(id);
// Keep the existing V2 workspace DOM intact while switching the two top-level tools.
const confirmarToolContent = $("confirmarToolContent");
for (const child of [...$("workspace").children]) {
  if (!["toolCategories", "wifiConnectPanel", "confirmarToolContent"].includes(child.id)) confirmarToolContent.append(child);
}
const SETTINGS_VIEW_IDS = ["workspaceWelcome", "adminViewTabs", "adminPanel", "adminRoutesPanel", "masterViewTabs", "appointmentsPanel", "masterSummaryPanel", "masterPanel", "masterTechniciansPanel", "masterCreatePanel", "issuesPanel"];
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
let adminAccounts = [];
let adminActivityOffset = 0;
const ADMIN_ACTIVITY_PAGE_SIZE = 20;
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
let masterTeamTechnicians = new Map();
let selectedMasterView = "appointments";
let activeLoginAttempt = null;
let kpiAvailableUserId = null;
let kpiAvailabilityRequest = 0;
const masterNavigation = createMasterNavigationStorage(window.localStorage);
const APP_BUILD = "3ce1";
let selectedTool = "confirmar";
let wifiInstance = null;
let wifiLoadPromise = null;
let wifiMountGeneration = 0;
let wifiMountQueue = Promise.resolve();
const toolScroll = { confirmar: 0, wifi: 0 };
const toolStorageKey = (userId) => `cc-v2-tool-${userId}`;

function toolOverlayOpen() { return settingsNavigation.isOpen() || issuesNavigation.isOpen(); }
function updateToolVisibility() {
  const allowed = Boolean(activeUser?.id && activeProfile?.status === "active" && activeProfile?.activation_verified_at && !activeProfile?.must_change_password);
  const overlay = toolOverlayOpen();
  const kpiAvailable = allowed && kpiAvailableUserId === activeUser.id;
  setVisible("toolCategories", allowed && !overlay);
  setVisible("kpiToolTab", kpiAvailable && !overlay);
  $("toolCategories").classList.toggle("has-kpi", kpiAvailable);
  if (!kpiAvailable || overlay) setVisible("kpiPopupFallback", false);
  $("workspace").classList.toggle("wifi-active", allowed && !overlay && selectedTool === "wifi");
  setVisible("wifiConnectPanel", allowed && !overlay && selectedTool === "wifi");
  $("confirmarToolTab").setAttribute("aria-pressed", String(selectedTool === "confirmar"));
  $("wifiToolTab").setAttribute("aria-pressed", String(selectedTool === "wifi"));
  if (!allowed || overlay || selectedTool !== "wifi") wifiInstance?.suspend();
}

async function openKpiDashboard() {
  const allowed = Boolean(activeUser?.id && activeProfile?.status === "active"
    && activeProfile?.activation_verified_at && !activeProfile?.must_change_password);
  const requestedUserId = activeUser?.id;
  if (!allowed || kpiAvailableUserId !== requestedUserId) {
    setVisible("kpiPopupFallback", false);
    return;
  }
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    setVisible("kpiPopupFallback", true);
    return;
  }
  popup.opener = null;
  try {
    const url = await resolveKpiDashboardUrl(supabase);
    if (!url || activeUser?.id !== requestedUserId || activeProfile?.status !== "active") {
      popup.close();
      setVisible("kpiPopupFallback", false);
      notify("No se pudo autorizar el acceso al KPI.", "error");
      return;
    }
    popup.location.replace(url);
    setVisible("kpiPopupFallback", false);
  } catch {
    popup.close();
    setVisible("kpiPopupFallback", false);
    notify("No se pudo autorizar el acceso al KPI.", "error");
  }
}

async function refreshKpiAvailability(userId) {
  const requestId = ++kpiAvailabilityRequest;
  kpiAvailableUserId = null;
  updateToolVisibility();
  if (!userId || activeUser?.id !== userId || activeProfile?.role !== "technician"
      || activeProfile?.status !== "active" || !activeProfile?.activation_verified_at
      || activeProfile?.must_change_password) return;
  try {
    const available = await checkKpiAvailability(supabase);
    if (requestId !== kpiAvailabilityRequest || activeUser?.id !== userId) return;
    kpiAvailableUserId = available ? userId : null;
  } catch {
    if (requestId !== kpiAvailabilityRequest || activeUser?.id !== userId) return;
    kpiAvailableUserId = null;
  }
  updateToolVisibility();
}

async function selectTool(tool, { push = true } = {}) {
  if (!activeUser?.id || activeProfile?.status !== "active" || !activeProfile.activation_verified_at || activeProfile.must_change_password) return;
  if (tool !== "confirmar" && tool !== "wifi") return;
  if (tool === "wifi" && !wifiInstance) {
    const userId = activeUser.id;
    const generation = wifiMountGeneration;
    $("wifiConnectPanel").textContent = "Preparando Wifi Connect…";
    try {
      if (!wifiLoadPromise) {
        const mount = wifiMountQueue.then(async () => {
          if (generation !== wifiMountGeneration || activeUser?.id !== userId) throw new Error("La sesión ha cambiado.");
          const module = await import("./wifi-connect/entry.mjs?v=3ce1");
          if (generation !== wifiMountGeneration || activeUser?.id !== userId) throw new Error("La sesión ha cambiado.");
          const instance = await module.mountWifiConnect($("wifiConnectPanel"), userId, {
            submitReport: (payload) => issuesUI.submitWifiOcrReport(payload),
            canRunAdminOcrDiagnostics: isActiveAdminProfile(activeProfile),
            listAdminWifiOcrPhotos: () => issuesUI.listAdminWifiOcrPhotos(),
            loadAdminWifiOcrPhoto: (id) => issuesUI.loadAdminWifiOcrPhoto(id),
          });
          if (generation !== wifiMountGeneration || activeUser?.id !== userId) { instance.dispose(); throw new Error("La sesión ha cambiado."); }
          return instance;
        });
        wifiMountQueue = mount.catch(() => {});
        wifiLoadPromise = mount;
      }
      const instance = await wifiLoadPromise;
      if (generation !== wifiMountGeneration || activeUser?.id !== userId || activeProfile?.status !== "active") { instance.dispose(); wifiLoadPromise = null; return; }
      if (wifiInstance === instance && selectedTool === "wifi") return;
      wifiInstance = instance;
    } catch {
      if (generation !== wifiMountGeneration) return;
      wifiLoadPromise = null;
      $("wifiConnectPanel").textContent = "No se pudo cargar Wifi Connect. Vuelve a intentarlo.";
      selectedTool = "confirmar";
      updateToolVisibility();
      notify("No se pudo cargar Wifi Connect. Comprueba la conexión y vuelve a intentarlo.", "error");
      return;
    }
  }
  const previousTool = selectedTool;
  if (previousTool !== tool) toolScroll[previousTool] = window.scrollY;
  if (selectedTool === "wifi" && tool !== "wifi") wifiInstance?.suspend();
  selectedTool = tool;
  if (tool === "wifi") wifiInstance?.resume();
  try { localStorage.setItem(toolStorageKey(activeUser.id), tool); } catch {}
  if (push) {
    try { history.pushState({ ...(history.state ?? {}), ccTool: tool }, "", location.href); } catch {}
  } else {
    try { history.replaceState({ ...(history.state ?? {}), ccTool: tool }, "", location.href); } catch {}
  }
  updateToolVisibility();
  if (previousTool !== tool) requestAnimationFrame(() => window.scrollTo({ top: toolScroll[tool], behavior: "auto" }));
}

function restoreToolSelection() {
  let saved = "confirmar";
  try { saved = localStorage.getItem(toolStorageKey(activeUser.id)) || "confirmar"; } catch {}
  void selectTool(saved === "wifi" ? "wifi" : "confirmar", { push: false });
}

function disposeWifiAccess(userId, { clearChoice = false } = {}) {
  wifiMountGeneration++;
  wifiInstance?.dispose(); wifiInstance = null; wifiLoadPromise = null;
  selectedTool = "confirmar";
  toolScroll.confirmar = 0; toolScroll.wifi = 0;
  if (clearChoice && userId) { try { localStorage.removeItem(toolStorageKey(userId)); } catch {} }
  updateToolVisibility();
}
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
const issuesNavigation = createSettingsNavigation({
  getElement: $, viewIds: [...SETTINGS_VIEW_IDS.filter((id) => id !== "issuesPanel"), "personalSettingsPanel"],
  settingsId: "issuesPanel", titleId: "issuesTitle", historyStateKey: "ccIssuesKey",
  triggerId: "reportError", window, history, location, document,
});
const issuesUI = createIssuesUI({
  $, getSupabase: () => supabase, getProfile: () => activeProfile,
  navigation: issuesNavigation, notify, appVersion: APP_BUILD,
});
const adminRoutesUI = createAdminRoutesUI({
  $, rpc: (name, args) => supabase.rpc(name, args),
  getProfile: () => activeProfile, getUser: () => activeUser, notify,
});
let selectedAdminView = "management";
function setAdminView(view) {
  if (activeProfile?.role !== "admin") return;
  selectedAdminView = view === "routes" ? "routes" : "management";
  setVisible("adminPanel", selectedAdminView === "management");
  setVisible("adminRoutesPanel", selectedAdminView === "routes");
  $("adminManagementTab").className = `button ${selectedAdminView === "management" ? "primary" : "secondary"}`;
  $("adminRoutesTab").className = `button ${selectedAdminView === "routes" ? "primary" : "secondary"}`;
  if (selectedAdminView === "routes") void adminRoutesUI.load();
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
      // Supabase Auth owns this session storage. Application code never stores passwords.
      storage: window.localStorage,
      storageKey: "confirmar-citas-v2-auth-session",
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

function hideWorkspacePanels() {
  wifiInstance?.suspend();
  $("workspace").classList.remove("wifi-active");
  setVisible("wifiConnectPanel", false);
  setVisible("toolCategories", false);
  ["authPanel", "authDisabled", "activationPanel", "workspace", "adminPanel", "masterPanel",
    "masterSummaryPanel", "masterTechniciansPanel", "masterCreatePanel", "appointmentsPanel", "masterViewTabs", "personalSettingsPanel", "issuesPanel", "adminViewTabs", "adminRoutesPanel", "workspaceLoading", "adminPanelLoading"].forEach((id) => setVisible(id, false));
  setVisible("signOut", false);
  setVisible("settingsToggle", false);
  setVisible("reportError", false);
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
  setVisible("reportError", ["admin", "master", "technician"].includes(activeProfile?.role));
  if (activeProfile?.role === "admin") {
    setVisible("adminViewTabs", true);
    setAdminView(selectedAdminView);
  }
  else if (activeProfile?.role === "master") {
    setVisible("masterViewTabs", true);
    setMasterView(selectedMasterView, { persist: false });
  } else if (activeProfile?.role === "technician") setVisible("appointmentsPanel", true);
  diagnostic.panelShellMs ??= performance.now() - diagnostic.startedAt;
  publishLoginDiagnostic(diagnostic, null, "panel_shell_ready");
  void issuesUI.refreshIndicator();
  restoreToolSelection();
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
  $("masterSummaryTotals").replaceChildren();
  $("masterSummaryTechnicians").replaceChildren();
  setVisible("appointmentNotice", false);
}

function clearRolePanelResults() {
  adminAccounts = [];
  adminActivityOffset = 0;
  masterTeamTechnicians = new Map();
  for (const id of ["adminSummary", "adminTeams", "adminAccounts", "adminActivity",
    "masterSummaryTotals", "masterSummaryTechnicians"]) {
    $(id).replaceChildren();
  }
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
  kpiAvailabilityRequest += 1;
  kpiAvailableUserId = null;
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
  issuesNavigation.abandon();
  hideWorkspacePanels();
  const sessionReadStartedAt = performance.now();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  diagnostic.getSessionMs = performance.now() - sessionReadStartedAt;
  if (sessionError) {
    issuesUI.reset(); adminRoutesUI.reset();
    finishStartup();
    notify("La sesión no está disponible. Vuelve a iniciar sesión.", "error");
    setVisible("authPanel", true);
    return;
  }
  const session = sessionData.session;
  if (!session) {
    disposeWifiAccess(previousUserId, { clearChoice: true });
    issuesUI.reset(); adminRoutesUI.reset();
    selectedAdminView = "management";
    if (previousUserId) masterNavigation.clear(previousUserId);
    activeUser = null;
    activeProfile = null;
    clearRolePanelResults();
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
    disposeWifiAccess(previousUserId, { clearChoice: true });
    issuesUI.reset(); adminRoutesUI.reset();
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
    disposeWifiAccess(previousUserId, { clearChoice: true });
    issuesUI.reset(); adminRoutesUI.reset();
    masterNavigation.clear(previousUserId);
    clearRolePanelResults();
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
    disposeWifiAccess(activeUser.id);
    initializedWorkspaceUserId = null;
    finishStartup();
    setVisible("activationPanel", true);
    setVisible("signOut", true);
    return;
  }
  if (!activeProfile.activation_verified_at) {
    disposeWifiAccess(activeUser.id);
    initializedWorkspaceUserId = null;
    finishStartup();
    notify("La cuenta aún no está habilitada para este módulo. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  if (activeProfile.status !== "active") {
    disposeWifiAccess(activeUser.id);
    masterNavigation.clear(activeUser.id);
    initializedWorkspaceUserId = null;
    finishStartup();
    notify("La cuenta está desactivada. Contacta con el administrador.", "error");
    setVisible("signOut", true);
    return;
  }
  void refreshKpiAvailability(activeUser.id);
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
    adminRoutesUI.setDirectory(teamsForActor, adminAccounts);
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
    technicianI…12937 tokens truncated…l de ${profile.display_name}. No se puede recuperar desde su hash.`);
          if (employeeId === null || !employeeId.trim()) return;
          try {
            await invokeAdmin({ action: "regularize_technician_identifier", target_id: profile.user_id, employee_id: employeeId });
            notify("Matrícula regularizada.", "success");
            await loadAdminPanel();
          } catch { notify("No se pudo regularizar la matrícula. Comprueba que coincide con la cuenta.", "error"); }
        },
      });
    }
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
    (profile.role === "admin" ? adminRows : workerRows).append(makeAdminAccountRow(profile, names, actions));
  }
  for (const [label, rows] of [["Cuenta Administrador", adminRows], ["Masters y técnicos", workerRows]]) {
    if (!rows.childElementCount) continue;
    const group = document.createElement("section");
    group.className = "admin-account-group";
    const heading = document.createElement("h4");
    heading.textContent = label;
    group.append(heading, rows);
    target.append(group);
  }
  if (!accounts.length) target.textContent = adminAccounts.length
    ? "No hay cuentas que coincidan con los filtros." : "Aún no hay cuentas de equipo.";
}

const ADMIN_AUDIT_LABELS = Object.freeze({
  account_created: "Cuenta creada", account_status_changed: "Estado de cuenta cambiado",
  credential_reset_started: "Restablecimiento iniciado",
  credential_reset_completed: "Restablecimiento completado",
  team_created: "Equipo creado", team_renamed: "Equipo renombrado",
  team_activated: "Equipo activado", team_deactivated: "Equipo desactivado",
  master_team_assigned: "Master asignado", master_team_removed: "Master retirado",
  technician_team_activated: "Técnico activado en equipo",
  technician_team_deactivated: "Técnico desactivado en equipo",
});

async function loadAdminActivity() {
  const target = $("adminActivity");
  target.textContent = "Cargando actividad…";
  const { data, error } = await supabase.rpc("cc_admin_audit_page", {
    p_limit: ADMIN_ACTIVITY_PAGE_SIZE, p_offset: adminActivityOffset,
  });
  if (activeProfile?.role !== "admin") return;
  target.replaceChildren();
  if (error || !data || !Array.isArray(data.items)) {
    target.textContent = "No se pudo cargar el historial de actividad.";
    $("adminActivityPage").textContent = "";
    $("adminActivityPrevious").disabled = true;
    $("adminActivityNext").disabled = true;
    return;
  }
  const total = Math.max(0, Number(data.total) || 0);
  for (const row of data.items) {
    const card = document.createElement("article"); card.className = "dashboard-activity";
    const heading = document.createElement("strong");
    heading.textContent = ADMIN_AUDIT_LABELS[row.action] ?? "Operación administrativa";
    const detail = document.createElement("span");
    detail.textContent = [row.actor ? `Responsable: ${row.actor}` : "",
      row.target ? `Objetivo: ${row.target}` : "",
      row.team ? `Equipo: ${row.team}` : ""].filter(Boolean).join(" · ");
    const date = document.createElement("time");
    date.textContent = new Date(row.created_at).toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
    card.append(heading, detail, date); target.append(card);
  }
  if (!target.childElementCount) target.textContent = "No hay actividad administrativa registrada.";
  $("adminActivityPage").textContent = total
    ? `${adminActivityOffset + 1}–${Math.min(adminActivityOffset + data.items.length, total)} de ${total}`
    : "0 registros";
  $("adminActivityPrevious").disabled = adminActivityOffset === 0;
  $("adminActivityNext").disabled = adminActivityOffset + data.items.length >= total;
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
  masterTeamTechnicians = new Map([...technicianProfiles].sort((a, b) => a[1].localeCompare(b[1], "es")));
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
    const membershipActive = profile.membership_status === "active";
    const accountDisabled = profile.account_status === "disabled";
    const effectiveStatus = accountDisabled
      ? "Cuenta desactivada por Administración"
      : membershipActive
        ? (profile.must_change_password ? "Pendiente de cambio de contraseña" : "Activo")
        : "Desactivado en este equipo";
    if (profile.account_status !== "disabled") {
      actions.push({
        label: membershipActive ? "Desactivar en el equipo" : "Activar en el equipo",
        run: () => setMasterMembership(profile.team_id, profile.technician_id, !membershipActive),
      });
      if (membershipActive && profile.employee_id_display) {
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
      account_status: effectiveStatus,
    }, teamName, actions));
  }
  if (!accountTarget.childElementCount) accountTarget.textContent = "No hay técnicos asignados todavía.";
  renderThreeDaySelector($("masterDateNav"), masterRouteDate, masterRouteDayOffset, (date, offset) => {
    masterRouteDate = date; masterRouteDayOffset = offset; void loadMasterAppointments();
  });
  renderThreeDaySelector($("masterSummaryDateNav"), masterRouteDate, masterRouteDayOffset, (date, offset) => {
    masterRouteDate = date; masterRouteDayOffset = offset;
    persistMasterNavigation();
    void loadMasterAppointments();
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
  issuesUI.bind(); adminRoutesUI.bind();
  $("adminManagementTab").addEventListener("click", () => setAdminView("management"));
  $("adminRoutesTab").addEventListener("click", () => setAdminView("routes"));
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
  $("settingsToggle").addEventListener("click", () => { settingsNavigation.open(); updateToolVisibility(); });
  $("settingsClose").addEventListener("click", () => { settingsNavigation.close(); queueMicrotask(updateToolVisibility); });
  $("reportError").addEventListener("click", () => queueMicrotask(updateToolVisibility));
  $("issuesClose").addEventListener("click", () => queueMicrotask(updateToolVisibility));
  $("confirmarToolTab").addEventListener("click", () => { void selectTool("confirmar"); });
  $("wifiToolTab").addEventListener("click", () => { void selectTool("wifi"); });
  $("kpiToolTab").addEventListener("click", openKpiDashboard);
  $("kpiFallbackOpen").addEventListener("click", openKpiDashboard);
  window.addEventListener("popstate", (event) => {
    queueMicrotask(() => {
      if (toolOverlayOpen()) { updateToolVisibility(); return; }
      if (!activeUser?.id || activeProfile?.status !== "active") return;
      void selectTool(event.state?.ccTool === "wifi" ? "wifi" : "confirmar", { push: false });
    });
  });
  $("workspaceLoadingRetry").addEventListener("click", () => {
    window.__CC_APP_READY__ = false;
    setVisible("startupStatus", true);
    void routeSession().catch(() => window.__CC_SHOW_INIT_ERROR__?.());
  });
  $("signOut").addEventListener("click", async () => {
    disposeWifiAccess(activeUser?.id, { clearChoice: true });
    hideWorkspacePanels();
    issuesUI.reset(); adminRoutesUI.reset();
    clearRolePanelResults();
    setVisible("startupStatus", true);
    const { error } = await supabase.auth.signOut();
    if (error) await supabase.auth.signOut({ scope: "local" });
    await routeSession();
    if (error) notify("Sesión local cerrada. Comprueba la conexión para confirmar el cierre remoto.", "error");
  });
  $("masterOwnTab").addEventListener("click", () => setMasterView("appointments"));
  $("masterSummaryTab").addEventListener("click", () => {
    setMasterView("summary");
    void loadMasterAppointments();
  });
  $("masterRouteTab").addEventListener("click", () => {
    setMasterView("routes");
    void loadMasterAppointments();
  });
  $("masterTechniciansTab").addEventListener("click", () => setMasterView("technicians"));
  $("masterCreateTab").addEventListener("click", () => setMasterView("create"));
  for (const id of ["adminAccountSearch", "adminAccountRole", "adminAccountTeam", "adminAccountStatus"]) {
    $(id).addEventListener(id === "adminAccountSearch" ? "input" : "change", renderAdminAccounts);
  }
  document.addEventListener("click", (event) => {
    for (const menu of document.querySelectorAll("#adminAccounts .admin-account-menu[open]")) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  $("clearAdminAccountFilters").addEventListener("click", () => {
    for (const id of ["adminAccountSearch", "adminAccountRole", "adminAccountTeam", "adminAccountStatus"]) $(id).value = "";
    renderAdminAccounts();
  });
  $("adminActivityPrevious").addEventListener("click", () => {
    adminActivityOffset = Math.max(0, adminActivityOffset - ADMIN_ACTIVITY_PAGE_SIZE);
    void loadAdminActivity();
  });
  $("adminActivityNext").addEventListener("click", () => {
    adminActivityOffset += ADMIN_ACTIVITY_PAGE_SIZE;
    void loadAdminActivity();
  });
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
  renderThreeDaySelector($("masterSummaryDateNav"), masterRouteDate, masterRouteDayOffset, (date, offset) => {
    masterRouteDate = date; masterRouteDayOffset = offset;
    persistMasterNavigation();
    void loadMasterAppointments();
  });
  if (!activeProfile || activeProfile.role === "admin") return;
  if (activeProfile.role === "technician" || $("appointmentsPanel").classList.contains("hidden") === false) {
    importChangesBySource.clear(); ignoredAppointments = [];
    void loadOwnAppointments(appointmentDate);
  }
  if (activeProfile.role === "master" &&
      (!$("masterPanel").classList.contains("hidden") || !$("masterSummaryPanel").classList.contains("hidden"))) void loadMasterAppointments();
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
        issuesUI.reset(); adminRoutesUI.reset();
        if (activeUser?.id) masterNavigation.clear(activeUser.id);
        activeUser = null;
        activeProfile = null;
        kpiAvailableUserId = null;
        kpiAvailabilityRequest += 1;
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

