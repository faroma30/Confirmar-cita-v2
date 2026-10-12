const CATEGORIES = Object.freeze({
  agenda: "Agenda / Oracle", whatsapp: "WhatsApp / Mensajes",
  login: "Inicio de sesión", teams: "Master / Equipos",
  settings: "Ajustes", other: "Otro problema",
});
const STATUSES = Object.freeze({
  pending: "Pendiente", reviewing: "En revisión", resolved: "Resuelto",
});
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function validateIssueFile(file) {
  if (!file) return null;
  if (!MIME_TYPES.has(file.type) || file.size < 16 || file.size > MAX_IMAGE_BYTES) {
    return "Elige una captura PNG, JPG o WebP de 5 MB como máximo.";
  }
  return null;
}

function dateText(value) {
  return new Date(value).toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
}

function setText(node, value) { node.textContent = String(value ?? ""); }
function statusPill(status) {
  const span = document.createElement("span");
  span.className = `issue-status ${status}`;
  span.textContent = STATUSES[status] ?? "Estado desconocido";
  return span;
}
function paragraph(text) {
  const p = document.createElement("p");
  p.textContent = String(text ?? "");
  return p;
}
function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer la captura"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function createIssuesUI({ $, getSupabase, getProfile, navigation, notify, appVersion }) {
  let mineOffset = 0;
  let adminOffset = 0;
  let mode = "mine";
  let requestId = null;
  let previewUrl = null;
  let currentDetail = null;
  let generation = 0;
  const PAGE = 20;
  const active = () => Boolean(getProfile() && ["admin", "master", "technician"].includes(getProfile().role));
  const admin = () => active() && getProfile().role === "admin";
  const show = (id, visible) => $(id).classList.toggle("hidden", !visible);
  const rpc = (name, args = {}) => getSupabase().rpc(name, args);

  const badge = (id, count) => {
    const node = $(id);
    node.textContent = count > 0 ? String(count) : "";
    show(id, count > 0);
  };
  const resetPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $("issuePreviewImage").removeAttribute("src");
    $("issueImage").value = "";
    show("issuePreview", false);
  };
  const setMode = (next) => {
    mode = next === "admin" && admin() ? "admin" : "mine";
    setText($("issuesTitle"), mode === "admin" ? "Reportes de errores" : "Reportar error");
    show("issueCompose", mode === "mine");
    show("issueMine", mode === "mine");
    show("issueAdminInbox", mode === "admin");
    show("issueDetail", false);
  };
  const renderCard = (row, isAdmin) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "issue-card";
    const title = document.createElement("strong");
    title.textContent = `#${String(row.id).slice(0, 8)} · ${CATEGORIES[row.category] ?? "Otro problema"}`;
    const context = document.createElement("span");
    context.textContent = isAdmin
      ? `${row.worker} · ${row.role} · ${row.team ?? "Sin equipo"} · ${dateText(row.created_at)}`
      : dateText(row.created_at);
    const excerpt = document.createElement("span");
    excerpt.textContent = isAdmin ? row.excerpt : row.description;
    button.append(title, context, statusPill(row.status), excerpt);
    if (!isAdmin && row.unread) button.append(paragraph("Respuesta nueva"));
    else if (!isAdmin && row.latest_response) button.append(paragraph(`Última respuesta: ${row.latest_response}`));
    button.addEventListener("click", () => { void loadDetail(row.id); });
    return button;
  };

  async function loadMine() {
    if (!active()) return;
    const token = generation;
    const { data, error } = await rpc("cc_my_issue_reports", { p_limit: PAGE, p_offset: mineOffset });
    if (token !== generation || !active()) return;
    if (error || !data || !Array.isArray(data.items)) {
      setText($("issueMineList"), "No se pudieron cargar tus reportes.");
      return;
    }
    const target = $("issueMineList");
    target.replaceChildren(...data.items.map((row) => renderCard(row, false)));
    if (!data.items.length) setText(target, "Todavía no has enviado reportes.");
    const total = Number(data.total) || 0;
    setText($("issueMinePage"), `${total ? mineOffset + 1 : 0}–${Math.min(mineOffset + data.items.length, total)} de ${total}`);
    $("issueMinePrev").disabled = mineOffset === 0;
    $("issueMineNext").disabled = mineOffset + data.items.length >= total;
    badge("issueUnreadCount", Number(data.unread_count) || 0);
    if (!admin()) badge("reportUnreadBadge", Number(data.unread_count) || 0);
  }
  async function loadAdmin() {
    if (!admin()) return;
    const token = generation;
    const { data, error } = await rpc("cc_admin_issue_reports", {
      p_status: $("issueStatusFilter").value || null,
      p_category: $("issueCategoryFilter").value || null,
      p_search: $("issueSearch").value.trim() || null,
      p_limit: PAGE, p_offset: adminOffset,
    });
    if (token !== generation || !admin()) return;
    if (error || !data || !Array.isArray(data.items)) {
      setText($("issueAdminList"), "No se pudo cargar el buzón.");
      return;
    }
    const target = $("issueAdminList");
    target.replaceChildren(...data.items.map((row) => renderCard(row, true)));
    if (!data.items.length) setText(target, "No hay reportes con esos filtros.");
    const total = Number(data.total) || 0;
    setText($("issueAdminPage"), `${total ? adminOffset + 1 : 0}–${Math.min(adminOffset + data.items.length, total)} de ${total}`);
    $("issueAdminPrev").disabled = adminOffset === 0;
    $("issueAdminNext").disabled = adminOffset + data.items.length >= total;
    badge("adminPendingBadge", Number(data.pending_count) || 0);
  }
  async function loadDetail(id) {
    if (!active()) return;
    const token = generation;
    const { data, error } = await rpc("cc_issue_report_detail", { p_id: id });
    if (token !== generation || !active()) return;
    if (error || !data) { notify("No se pudo abrir el reporte.", "error"); return; }
    currentDetail = data;
    const content = $("issueDetailContent");
    content.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = `Reporte #${String(data.id).slice(0, 8)}`;
    content.append(heading, statusPill(data.status),
      paragraph(`${CATEGORIES[data.category] ?? "Otro problema"} · ${dateText(data.created_at)}`),
      paragraph(`Trabajador: ${data.worker} · ${data.role} · ${data.team ?? "Sin equipo"}`),
      paragraph(`Versión de la aplicación: ${data.app_version}`),
      paragraph(`Última actualización: ${dateText(data.updated_at)}`),
      paragraph(data.description));
    const timeline = $("issueTimeline");
    timeline.replaceChildren();
    for (const item of [...(data.responses ?? []).map((r) => ({
      date: r.created_at, text: `Respuesta del Administrador: ${r.body}`,
    })), ...(data.history ?? []).map((h) => ({
      date: h.changed_at, text: `Estado: ${STATUSES[h.old_status] ?? "Inicial"} → ${STATUSES[h.new_status]}`,
    }))].sort((a, b) => new Date(a.date) - new Date(b.date))) {
      const line = document.createElement("p");
      line.className = "issue-timeline-item";
      line.textContent = `${dateText(item.date)} · ${item.text}`;
      timeline.append(line);
    }
    show("issueLoadAttachment", Boolean(data.has_attachment));
    show("issueDetailImage", false);
    $("issueDetailImage").removeAttribute("src");
    show("issueAdminAction", admin());
    if (admin()) $("issueNewStatus").value = data.status;
    show("issueDetail", true);
    show("issueCompose", false); show("issueMine", false); show("issueAdminInbox", false);
    $("issueDetail").scrollIntoView({ block: "start" });
    if (!admin()) {
      const { error: readError } = await rpc("cc_mark_issue_read", { p_id: id });
      if (!readError) void loadMine();
    }
  }
  async function refreshIndicator() {
    if (!active()) return;
    if (admin()) await loadAdmin();
    else await loadMine();
  }
  function reset() {
    generation += 1;
    requestId = null; currentDetail = null; mineOffset = 0; adminOffset = 0;
    resetPreview();
    $("issueForm").reset(); $("issueAdminAction").reset();
    $("issueDetailImage").removeAttribute("src");
    setText($("issueFormStatus"), "");
    badge("reportUnreadBadge", 0); badge("adminPendingBadge", 0); badge("issueUnreadCount", 0);
    for (const id of ["issueMineList", "issueAdminList", "issueDetailContent", "issueTimeline"]) $(id).replaceChildren();
    navigation.abandon();
  }
  function bind() {
    $("reportError").addEventListener("click", () => { if (active()) { setMode("mine"); navigation.open(); void loadMine(); } });
    $("adminIssuesTab").addEventListener("click", () => { if (admin()) { setMode("admin"); navigation.open(); void loadAdmin(); } });
    $("issuesClose").addEventListener("click", navigation.close);
    $("issueDetailClose").addEventListener("click", () => {
      show("issueDetail", false); setMode(mode); void (mode === "admin" ? loadAdmin() : loadMine());
    });
    $("issueImage").addEventListener("change", () => {
      const file = $("issueImage").files?.[0];
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      $("issuePreviewImage").removeAttribute("src");
      show("issuePreview", false);
      if (!file) return;
      const problem = validateIssueFile(file);
      if (problem) { setText($("issueFormStatus"), problem); $("issueImage").value = ""; return; }
      previewUrl = URL.createObjectURL(file);
      $("issuePreviewImage").src = previewUrl;
      show("issuePreview", true);
      setText($("issueFormStatus"), "");
    });
    $("issueRemoveImage").addEventListener("click", resetPreview);
    $("issueForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!active()) return;
      const description = $("issueDescription").value.trim();
      const file = $("issueImage").files?.[0] ?? null;
      const problem = validateIssueFile(file);
      if (description.length < 20 || description.length > 4000 || problem) {
        setText($("issueFormStatus"), problem ?? "Explica el error con entre 20 y 4000 caracteres."); return;
      }
      requestId ??= crypto.randomUUID();
      $("issueSubmit").disabled = true;
      try {
        const base64 = file ? await fileAsBase64(file) : null;
        const { data, error } = await rpc("cc_create_issue_report", {
          p_category: $("issueCategory").value, p_description: description,
          p_request_id: requestId, p_image_base64: base64, p_image_mime: file?.type ?? null,
          p_app_version: appVersion,
        });
        if (error || !data?.id) throw new Error("report failed");
        requestId = null; $("issueForm").reset(); resetPreview();
        setText($("issueFormStatus"), "Reporte enviado correctamente. El Administrador podrá revisarlo desde su panel.");
        await loadMine();
      } catch {
        setText($("issueFormStatus"), "No se pudo enviar el reporte. Inténtalo de nuevo.");
      } finally { $("issueSubmit").disabled = false; }
    });
    $("issueLoadAttachment").addEventListener("click", async () => {
      if (!currentDetail) return;
      const { data, error } = await rpc("cc_issue_attachment", { p_id: currentDetail.id });
      if (error || !data || !MIME_TYPES.has(data.mime) || !data.base64) {
        notify("No se pudo abrir la captura.", "error"); return;
      }
      $("issueDetailImage").src = `data:${data.mime};base64,${data.base64}`;
      show("issueDetailImage", true);
    });
    $("issueAdminAction").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!admin() || !currentDetail) return;
      const status = $("issueNewStatus").value;
      const reply = $("issueReply").value.trim();
      if (status === currentDetail.status && !reply) return;
      const button = $("issueAdminAction").querySelector("button[type=submit]");
      button.disabled = true;
      const { error } = await rpc("cc_admin_issue_update", {
        p_id: currentDetail.id, p_status: status, p_response: reply || null,
      });
      button.disabled = false;
      if (error) { notify("No se pudo guardar la respuesta o el estado.", "error"); return; }
      $("issueReply").value = "";
      notify("Reporte actualizado.", "success");
      await loadDetail(currentDetail.id);
      void loadAdmin();
    });
    for (const id of ["issueStatusFilter", "issueCategoryFilter", "issueSearch"]) {
      $(id).addEventListener(id === "issueSearch" ? "input" : "change", () => {
        adminOffset = 0; void loadAdmin();
      });
    }
    for (const [id, delta, isAdmin] of [
      ["issueMinePrev", -PAGE, false], ["issueMineNext", PAGE, false],
      ["issueAdminPrev", -PAGE, true], ["issueAdminNext", PAGE, true],
    ]) {
      $(id).addEventListener("click", () => {
        if (isAdmin) { adminOffset = Math.max(0, adminOffset + delta); void loadAdmin(); }
        else { mineOffset = Math.max(0, mineOffset + delta); void loadMine(); }
      });
    }
  }
  return { bind, reset, refreshIndicator };
}
