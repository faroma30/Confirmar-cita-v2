import { buildWifiOcrReportPayload } from "./wifi-ocr-report.mjs";

const PROBLEMS = new Set([
  "label_not_recognized", "ssid_incorrect", "password_incorrect",
  "ssid_password_confused", "missing_5ghz", "other",
]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function createWifiOcrReportSubmitter({
  rpc, isAuthorized, appVersion, fileAsBase64,
  createRequestId = () => crypto.randomUUID(),
}) {
  let requestId = null;
  let submitting = false;

  return async function submitWifiOcrReport({
    metadata = {}, problem = "other", description = "", photo = null,
    photoConsent = false, shareSsid = false,
  } = {}) {
    if (!isAuthorized()) throw new Error("not-authorized");
    if (submitting) throw new Error("already-submitting");
    const cleanDescription = String(description ?? "").trim();
    if (cleanDescription.length > 1000) throw new Error("invalid-description");
    if (!PROBLEMS.has(problem)) throw new Error("invalid-problem");
    if (photo && (!IMAGE_TYPES.has(photo.type) || photo.size < 16 || photo.size > MAX_IMAGE_BYTES)) {
      throw new Error("invalid-attachment");
    }
    if (photo && !photoConsent) throw new Error("photo-consent-required");

    submitting = true;
    requestId ??= createRequestId();
    try {
      const safe = buildWifiOcrReportPayload({ ...metadata, problem }, { shareSsid });
      const base64 = photo && photoConsent ? await fileAsBase64(photo) : null;
      const { data, error } = await rpc("cc_create_wifi_ocr_report", {
        p_problem: safe.problem,
        p_description: cleanDescription,
        p_request_id: requestId,
        p_photo_base64: base64,
        p_photo_mime: base64 ? photo.type : null,
        p_photo_consent: Boolean(base64),
        p_share_ssid: safe.shareSsid,
        p_ssid_candidate: safe.ssidCandidate,
        p_failed_field: safe.failedField,
        p_manufacturer: safe.manufacturer,
        p_model: safe.model,
        p_app_version: safe.appVersion || appVersion,
      });
      if (error || !data?.id) throw new Error("report-failed");
      requestId = null;
      return { id: data.id };
    } finally {
      submitting = false;
    }
  };
}
