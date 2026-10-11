import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import { captureSubmittedForm } from "./form-events.mjs";

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
    "adminPanel", "masterPanel", "technicianPanel", "masterOwnPanel"].forEach((id) => setVisible(id, false));
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
    setVisible("masterPanel", true);
    setVisible("masterOwnPanel", true);
    await loadMasterPanel();
  } else {
    setVisible("technicianPanel", true);
  }
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

