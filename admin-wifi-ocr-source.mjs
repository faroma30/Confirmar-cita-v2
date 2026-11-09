const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;

export function isActiveAdminProfile(profile) {
  return profile?.role === "admin" && profile?.status === "active" && !profile?.must_change_password;
}

function photoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function classifyRpcError(error, fallback) {
  if (error instanceof TypeError || error?.name === "NetworkError" || error?.status === 0) return photoError("NETWORK_ERROR");
  if ([401, 403].includes(Number(error?.status)) || ["42501", "PGRST301", "ACCESS_DENIED"].includes(String(error?.code ?? "").toUpperCase())) {
    return photoError("ACCESS_DENIED");
  }
  return photoError(fallback);
}

function decodeAttachment(data) {
  if (data == null || typeof data !== "object") throw photoError("RESPONSE_EMPTY");
  const mime = String(data.mime ?? "").trim().toLowerCase();
  if (!MIME.has(mime)) throw photoError("FORMAT_UNSUPPORTED");
  if (typeof data.base64 !== "string" || !data.base64.trim()) throw photoError("RESPONSE_EMPTY");

  // PostgreSQL encode(bytea, 'base64') inserts LF after 76 characters.
  const raw = data.base64;
  if (raw.length > MAX_BASE64_CHARS + Math.ceil(MAX_BASE64_CHARS / 76) + 8) throw photoError("PHOTO_TOO_LARGE");
  const base64 = raw.replace(/[\r\n\t ]/g, "");
  if (base64.length > MAX_BASE64_CHARS) throw photoError("PHOTO_TOO_LARGE");
  if (!base64 || base64.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw photoError("FORMAT_UNSUPPORTED");
  }

  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw photoError("CONVERSION_FAILED");
  }
  if (binary.length < 16) throw photoError("FORMAT_UNSUPPORTED");
  if (binary.length > MAX_BYTES) throw photoError("PHOTO_TOO_LARGE");
  try {
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  } catch {
    throw photoError("CONVERSION_FAILED");
  }
}

/** Uses only the existing server-authorized mailbox RPCs. Photos stay in memory. */
export function createAdminWifiOcrSource({ rpc, getProfile }) {
  const detailWithConsentedPhoto = async id => {
    if (!isActiveAdminProfile(getProfile())) throw photoError("ACCESS_DENIED");
    if (!UUID.test(String(id ?? ""))) throw photoError("PHOTO_NOT_FOUND");
    let result;
    try {
      result = await rpc("cc_issue_report_detail", { p_id: id });
    } catch (error) {
      throw classifyRpcError(error, "METADATA_LOAD_FAILED");
    }
    if (result?.error) throw classifyRpcError(result.error, "METADATA_LOAD_FAILED");
    if (!isActiveAdminProfile(getProfile())) throw photoError("ACCESS_DENIED");
    const data = result?.data;
    if (data == null) throw photoError("RESPONSE_EMPTY");
    if (data.category !== "wifi_ocr" || data.has_attachment !== true) throw photoError("PHOTO_NOT_FOUND");
    if (data.metadata?.photo_shared !== true) throw photoError("CONSENT_INVALID");
    return data;
  };

  async function list() {
    if (!isActiveAdminProfile(getProfile())) throw photoError("ACCESS_DENIED");
    let result;
    try {
      result = await rpc("cc_admin_wifi_ocr_reports", { p_status: null, p_search: null, p_limit: 50, p_offset: 0 });
    } catch (error) {
      throw classifyRpcError(error, "REPORT_LIST_FAILED");
    }
    if (result?.error) throw classifyRpcError(result.error, "REPORT_LIST_FAILED");
    if (!isActiveAdminProfile(getProfile())) throw photoError("ACCESS_DENIED");
    if (result?.data == null) throw photoError("RESPONSE_EMPTY");
    if (!Array.isArray(result.data?.items)) throw photoError("RESPONSE_EMPTY");

    const authorizedItems = [];
    for (const item of result.data.items) {
      if (!UUID.test(String(item?.id ?? ""))) continue;
      try {
        await detailWithConsentedPhoto(item.id);
        authorizedItems.push({ id: item.id, createdAt: item.created_at, worker: item.worker, status: item.status });
      } catch (error) {
        if (error?.code === "ACCESS_DENIED" || error?.code === "NETWORK_ERROR" || error?.code === "METADATA_LOAD_FAILED") throw error;
        // Missing attachment and absent consent stay omitted from the picker.
      }
      if (!isActiveAdminProfile(getProfile())) throw photoError("ACCESS_DENIED");
    }
    return authorizedItems;
  }

  async function loadPhoto(id) {
    await detailWithConsentedPhoto(id);
    if (!isActiveAdminProfile(getProfile())) throw photoError("ACCESS_DENIED");
    let result;
    try {
      result = await rpc("cc_issue_attachment", { p_id: id });
    } catch (error) {
      throw classifyRpcError(error, "ATTACHMENT_LOAD_FAILED");
    }
    if (result?.error) throw classifyRpcError(result.error, "ATTACHMENT_LOAD_FAILED");
    if (!isActiveAdminProfile(getProfile())) throw photoError("ACCESS_DENIED");
    if (result?.data == null) throw photoError("RESPONSE_EMPTY");
    return decodeAttachment(result.data);
  }

  return Object.freeze({ list, loadPhoto });
}
