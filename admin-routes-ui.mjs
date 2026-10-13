import { dateOffset, madridDate } from "./agenda-parity.mjs";
import { appendCancellationReason } from "./cancellation-reason.mjs?v=3bi1";

const STATUS = { pending: "Pendiente", confirmed: "Confirmada", cancelled: "Cancelada" };
const timeText = (value) => value ? new Date(value).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }) : "—";
const el = (tag, value, className = "") => {
  const node = document.createElement(tag);
  node.textContent = String(value ?? "");
  if (className) node.className = className;
  return node;
};

export function createAdminRoutesUI({ $, rpc, getProfile, getUser, notify }) {
  let teams = [];
  let accounts = [];
  let selected = null;
  let generation = 0;
  let dayOffset = 0;
  const admin = () => getProfile()?.role === "admin" && getUser()?.id;
  const visible = (id, show) => $(id).classList.toggle("hidden", !show);
  const storageKey = () => `cc-admin-routes-${getUser()?.id}`;
  const currentDate = () => dateOffset(madridDate(new Date()), dayOffset);

  function restore() {
    if (!admin()) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey()) || "{}");
      if ([-1, 0, 1].includes(saved.dayOffset)) dayOffset = saved.dayOffset;
      if (teams.some((t) => t.id === saved.teamId)) $("adminRouteTeam").value = saved.teamId;
      renderTechnicians();
      if ([...$("adminRouteTechnician").options].some((o) => o.value === saved.technicianId)) {
        $("adminRouteTechnician").value = saved.technicianId;
      }
    } catch { /* A malformed local selection cannot grant access. */ }
    renderDays();
  }
  function persist() {
    if (!admin()) return;
    try { sessionStorage.setItem(storageKey(), JSON.stringify({
      teamId: $("adminRouteTeam").value,
      technicianId: $("adminRouteTechnician").value,
      dayOffset,
    })); } catch { /* Selection persistence is optional. */ }
  }
  function setDirectory(teamRows, accountRows) {
    teams = [...teamRows]; accounts = [...accountRows];
    $("adminRouteTeam").replaceChildren(new Option("Todos los equipos", ""),
      ...teams.map((t) => new Option(t.name, t.id)));
    restore();
  }
  function renderTechnicians() {
    const teamId = $("adminRouteTeam").value;
    const options = accounts.filter((a) => a.role === "technician"
      && (!teamId || (a.teams ?? []).some((m) => m.team_id === teamId)));
    $("adminRouteTechnician").replaceChildren(new Option("Todos los técnicos", ""),
      ...options.map((a) => new Option(a.display_name, a.user_id)));
  }
  function renderDays() {
    const target = $("adminRouteDateNav"); target.replaceChildren();
    for (const [offset, label] of [[-1,"Ayer"],[0,"Hoy"],[1,"Mañana"]]) {
      const button = el("button", label, `button ${dayOffset === offset ? "primary" : "secondary"}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String(dayOffset === offset));
      button.addEventListener("click", () => { dayOffset = offset; renderDays(); persist(); void load(); });
      target.append(button);
    }
  }
  async function load() {
    if (!admin()) return;
    const request = ++generation;
    const list = $("adminRouteList");
    list.textContent = "Cargando rutas…";
    const { data, error } = await rpc("cc_admin_routes", {
      p_work_date: currentDate(),
      p_team_id: $("adminRouteTeam").value || null,
      p_technician_id: $("adminRouteTechnician").value || null,
    });
    if (request !== generation || !admin()) return;
    if (error || !Array.isArray(data)) { list.textContent = "No se pudieron cargar las rutas."; return; }
    const counts = { pending: 0, contacted: 0, confirmed: 0, cancelled: 0 };
    data.forEach((a) => { counts[a.status] += 1; if (a.contacted_at) counts.contacted += 1; });
    const summary = $("adminRouteSummary"); summary.replaceChildren();
    for (const [label, count] of [["Pendientes",counts.pending],["Contactadas",counts.contacted],
      ["Confirmadas",counts.confirmed],["Canceladas",counts.cancelled]]) {
      const card = el("div", "", "dashboard-stat");
      card.append(el("strong", count), el("span", label)); summary.append(card);
    }
    list.replaceChildren();
    if (!data.length) { list.textContent = "No hay instalaciones para esta selección."; return; }
    for (const a of data) {
      const card = el("article", "", "admin-route-card");
      card.append(el("strong", `${a.scheduled_time} · ${a.population}`),
        el("span", `${a.technician} · ${a.team ?? "Sin equipo"}`),
        el("span", `Prospecto: ${a.prospect_ref ?? "—"}`),
        el("span", `Estado: ${STATUS[a.status] ?? a.status}`),
        el("span", `WhatsApp abierto: ${timeText(a.contacted_at)}`),
        el("span", `Actualizada: ${timeText(a.updated_at)}`));
      appendCancellationReason(card, a.status, a.cancellation_reason, "admin-cancellation-reason");
      const button = el("button", "Abrir detalle y corregir", "button secondary"); button.type = "button";
      button.addEventListener("click", () => { void openDetail(a.id); });
      card.append(button); list.append(card);
    }
  }
  async function openDetail(id) {
    if (!admin()) return;
    const { data, error } = await rpc("cc_admin_route_detail", { p_id: id });
    if (error || !data || !admin()) { notify("No se pudo abrir la instalación.", "error"); return; }
    selected = data;
    $("adminRouteDetailTitle").textContent = `${data.scheduled_time} · ${data.population} · ${data.technician}`;
    $("adminRouteCurrent").replaceChildren(
      el("p", `Equipo: ${data.team ?? "—"} · Prospecto: ${data.prospect_ref ?? "—"}`),
      el("p", `Estado: ${STATUS[data.status] ?? data.status} · WhatsApp abierto: ${timeText(data.contacted_at)}`),
      el("p", `Hora: ${data.scheduled_time} · Población: ${data.population}`),
      el("p", `Dirección: ${data.full_address || "—"} · Teléfono: ${data.phone || "—"}`),
      el("p", `Última actualización: ${timeText(data.updated_at)}`));
    $("adminEditTime").value = data.scheduled_time;
    $("adminEditPopulation").value = data.population;
    $("adminEditAddress").value = data.full_address ?? "";
    $("adminEditPhone").value = data.phone ?? "";
    $("adminEditStatus").value = data.status;
    $("adminEditReason").value = "";
    const history = $("adminRouteHistory"); history.replaceChildren();
    for (const correction of data.history ?? []) {
      const card = el("article", "", "admin-route-history-item");
      card.append(el("strong", `${timeText(correction.changed_at)} · ${correction.actor}`),
        el("p", `Motivo: ${correction.reason}`));
      for (const field of correction.changed_fields ?? []) {
        const oldValue = correction.old_values?.[field] ?? "";
        const newValue = correction.new_values?.[field] ?? "";
        card.append(el("p", `${field}: ${oldValue || "—"} → ${newValue || "—"}`));
      }
      history.append(card);
    }
    if (!history.childNodes.length) history.textContent = "Sin correcciones administrativas.";
    $("adminRouteDetail").showModal();
  }
  function bind() {
    $("adminRouteTeam").addEventListener("change", () => {
      renderTechnicians(); persist(); void load();
    });
    $("adminRouteTechnician").addEventListener("change", () => { persist(); void load(); });
    $("adminRouteRefresh").addEventListener("click", () => { void load(); });
    $("adminRouteClose").addEventListener("click", () => $("adminRouteDetail").close());
    $("adminRouteEditForm").addEventListener("submit", async (event) => {
      event.preventDefault(); if (!admin() || !selected) return;
      const next = {
        p_id: selected.id, p_expected_updated_at: selected.updated_at,
        p_scheduled_time: $("adminEditTime").value,
        p_population: $("adminEditPopulation").value.trim(),
        p_phone: $("adminEditPhone").value.trim(),
        p_full_address: $("adminEditAddress").value.trim(),
        p_status: $("adminEditStatus").value,
        p_reason: $("adminEditReason").value.trim(),
      };
      if (next.p_reason.length < 10 || next.p_reason.length > 1000 ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.p_scheduled_time) ||
          !next.p_population || next.p_population.length > 160 ||
          next.p_phone.length > 40 || next.p_full_address.length > 500) {
        notify("Revisa los campos y escribe un motivo de al menos 10 caracteres.", "error"); return;
      }
      const confirmation = `Vas a corregir la instalación de ${selected.technician}.\n\n` +
        `Antes: ${selected.scheduled_time}, ${selected.population}, ${STATUS[selected.status]}.\n` +
        `Después: ${next.p_scheduled_time}, ${next.p_population}, ${STATUS[next.p_status]}.\n\n` +
        `Dirección y teléfono: compara los valores del detalle con los del formulario.\nMotivo: ${next.p_reason}\n\n¿Guardar la corrección?`;
      if (!window.confirm(confirmation)) return;
      $("adminRouteSave").disabled = true;
      const { error } = await rpc("cc_admin_correct_appointment", next);
      $("adminRouteSave").disabled = false;
      if (error) {
        if (error.code === "40001") {
          notify("El técnico modificó la instalación. Revisa los valores actuales antes de volver a guardar.", "error");
          $("adminRouteDetail").close(); await openDetail(selected.id); void load();
        } else notify("No se pudo guardar la corrección.", "error");
        return;
      }
      const id = selected.id; $("adminRouteDetail").close();
      notify("Corrección guardada. El técnico la verá al actualizar su agenda.", "success");
      await load(); await openDetail(id);
    });
  }
  function reset() {
    generation += 1; selected = null;
    if ($("adminRouteDetail").open) $("adminRouteDetail").close();
    $("adminRouteList").replaceChildren(); $("adminRouteSummary").replaceChildren();
    $("adminRouteCurrent").replaceChildren(); $("adminRouteHistory").replaceChildren();
    $("adminRouteEditForm").reset();
  }
  return { bind, load, reset, setDirectory, renderDays };
}
