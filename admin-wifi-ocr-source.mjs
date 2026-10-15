const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

export function isActiveAdminProfile(profile) {
  return profile?.role === "admin" && profile?.status === "active" && !profile?.must_change_password;
}

function decodeAttachment(data) {
  const mime = String(data?.mime ?? "").toLowerCase();
  const base64 = data?.base64;
  if (!MIME.has(mime) || typeof base64 !== "string" || base64.length > 7_000_000
      || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("El adjunto no tiene un formato permitido.");
  }
  const binary = atob(base64);
  if (binary.length < 16 || binary.length > MAX_BYTES) throw new Error("El adjunto supera el tamaño permitido.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

/** Uses only the existing server-authorized mailbox RPCs. Photos stay in memory. */
export function createAdminWifiOcrSource({ rpc, getProfile }) {
  const detailWithConsentedPhoto = async id => {
    if (!isActiveAdminProfile(getProfile()) || !UUID.test(String(id ?? ""))) throw new Error("Acceso no autorizado.");
    const { data, error } = await rpc("cc_issue_report_detail", { p_id: id });
    if (error || !isActiveAdminProfile(getProfile()) || data?.category !== "wifi_ocr"
        || data?.metadata?.photo_shared !== true || data?.has_attachment !== true) {
      throw new Error("No hay una fotografía autorizada disponible para este reporte.");
    }
    return data;
  };

  async function list() {
    if (!isActiveAdminProfile(getProfile())) throw new Error("Acceso no autorizado.");
    const { data, error } = await rpc("cc_admin_wifi_ocr_reports", {
      p_status: null, p_search: null, p_limit: 50, p_offset: 0,
    });
    if (error || !isActiveAdminProfile(getProfile()) || !Array.isArray(data?.items)) throw new Error("No se pudieron consultar los reportes autorizados.");
    const authorizedItems = [];
    for (const item of data.items) {
      if (!UUID.test(String(item?.id ?? ""))) continue;
      try {
        const detail = await detailWithConsentedPhoto(item.id);
        authorizedItems.push({ id: item.id, createdAt: item.created_at, worker: item.worker, status: item.status });
        void detail;
      } catch {
        // Reports without explicit photo consent are intentionally omitted.
      }
      if (!isActiveAdminProfile(getProfile())) throw new Error("La autorización ha cambiado.");
    }
    return authorizedItems;
  }

  async function loadPhoto(id) {
    await detailWithConsentedPhoto(id);
    const { data, error } = await rpc("cc_issue_attachment", { p_id: id });
    if (error || !isActiveAdminProfile(getProfile())) throw new Error("No se pudo cargar la fotografía autorizada.");
    return decodeAttachment(data);
  }

  return Object.freeze({ list, loadPhoto });
}
