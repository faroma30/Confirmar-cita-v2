export const WIFI_OCR_PROBLEMS = Object.freeze({
  label_not_recognized: "No reconoce la etiqueta",
  ssid_incorrect: "SSID incorrecto",
  password_incorrect: "Contraseña incorrecta",
  ssid_password_confused: "Confunde SSID y contraseña",
  missing_5ghz: "No detecta la red de 5 GHz",
  other: "Otro problema",
});

const FIELDS = new Set(["ssid", "password", "both", "ssid_5ghz", "label", "other", "unknown"]);
const cleanShort = (value, limit) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit) || null
  : null;

/** Whitelist only the diagnostic fields this report flow is allowed to transmit. */
export function buildWifiOcrReportPayload(input = {}, { shareSsid = false } = {}) {
  const problem = Object.hasOwn(WIFI_OCR_PROBLEMS, input.problem) ? input.problem : "other";
  const failedField = FIELDS.has(input.failedField) ? input.failedField : "unknown";
  const ssidCandidate = shareSsid ? cleanShort(input.ssidCandidate, 128) : null;
  return Object.freeze({
    problem,
    failedField,
    manufacturer: cleanShort(input.manufacturer, 80),
    model: cleanShort(input.model, 80),
    appVersion: cleanShort(input.appVersion, 32),
    ssidCandidate,
    shareSsid: Boolean(shareSsid && ssidCandidate),
  });
}

export function formatWifiOcrDescription(problem, description = "") {
  const label = WIFI_OCR_PROBLEMS[problem] ?? WIFI_OCR_PROBLEMS.other;
  const details = typeof description === "string" ? description.trim().slice(0, 1000) : "";
  return `Wifi Connect · Error OCR: ${label}${details ? `\n${details}` : ""}`;
}
