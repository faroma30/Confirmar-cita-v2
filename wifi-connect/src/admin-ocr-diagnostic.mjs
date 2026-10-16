import { buildSafeSsidReport, compareSsidPasses, explicitCandidatesFromPass } from "./ssid-diagnostic-report.js?v=3ca1";
const PASS_IDS = new Set(["color", "grayscale-contrast", "ssid-focus-1", "ssid-focus-2"]);
const STAGES = new Set(["qr", "ocr", "parser", "review"]);
const REASONS = new Set([
  "no_explicit_ssid_candidate", "multiple_ssid_candidates", "below_auto_confidence_threshold",
  "ocr_pass_disagreement", "candidate_requires_review", "wifi_band_conflict",
  "qr_ssid_conflict", "field_contamination", "review_required_by_flow",
]);
const LABELS = new Map([
  ["qr wifi", "QR Wi-Fi"], ["etiqueta ssid", "SSID"], ["etiqueta ssid1", "SSID1"],
  ["etiqueta ssid2", "SSID2"], ["etiqueta red wi-fi", "Red Wi-Fi"],
  ["etiqueta nombre wi-fi", "Nombre Wi-Fi"], ["etiqueta wlan name", "WLAN Name"],
  ["etiqueta de nombre de red", "Network Name"], ["etiqueta de nombre wi-fi", "Wi-Fi Name"],
  ["etiqueta catalana de nombre de red", "Nombre de red"],
]);
const REASON_LABELS = Object.freeze({
  no_explicit_ssid_candidate: "No se encontró un valor asociado a una etiqueta SSID.",
  multiple_ssid_candidates: "Se detectaron varios candidatos SSID.",
  below_auto_confidence_threshold: "La confianza del candidato está por debajo del umbral automático.",
  ocr_pass_disagreement: "Las pasadas OCR discrepan.",
  candidate_requires_review: "El candidato requiere revisión.",
  wifi_band_conflict: "Existe un conflicto entre bandas.",
  qr_ssid_conflict: "El QR y el texto discrepan en el SSID.",
  field_contamination: "Se detectó posible mezcla entre campos.",
  review_required_by_flow: "El flujo solicita revisión manual.",
});

function isSafeSsid(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && new TextEncoder().encode(value).length <= 32
    && ![...value].some(char => {
      const point = char.codePointAt(0);
      return point < 0x20 || point === 0x7f || (point >= 0x80 && point <= 0x9f);
    });
}

function normalizedLabel(candidate) {
  const source = String(candidate?.sourceLabel ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (candidate?.source?.startsWith("qr") && source.includes("qr")) return "QR Wi-Fi";
  if (source === "etiqueta ssid" || source === "etiqueta ssid1" || source === "etiqueta ssid2"
      || source === "etiqueta red wi-fi" || source === "etiqueta nombre wi-fi"
      || source === "etiqueta wlan name" || source === "etiqueta de nombre de red"
      || source === "etiqueta de nombre wi-fi" || source === "etiqueta catalana de nombre de red") {
    return LABELS.get(source) ?? null;
  }
  return null;
}

function candidateReport(candidate, passIds, passwordValues) {
  const value = candidate?.value ?? candidate?.ssid;
  if ((candidate?.fieldType && candidate.fieldType !== "ssid") || !isSafeSsid(value) || passwordValues.has(value)) return null;
  const label = candidate?.label ?? normalizedLabel(candidate);
  if (![...LABELS.values(), "SSID", "SSID1", "SSID2", "SSID (2.4 GHz)", "SSID (5 GHz)", "Wi-Fi Name", "WLAN Name", "Network Name", "Nombre Wi-Fi", "Nombre de red", "Red Wi-Fi", "Nom de xarxa", "Xarxa Wi-Fi"].includes(label)) return null;
  const source = candidate?.source?.startsWith("qr") || label === "QR Wi-Fi" ? "QR Wi-Fi" : "OCR";
  const reason = String(candidate.reason ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const relation = ["labelled", "same_line", "next_line"].includes(candidate.relation)
    ? candidate.relation : /linea siguiente/.test(reason) ? "next_line" : /misma linea/.test(reason) ? "same_line" : "labelled";
  const rawConfidence = source === "QR Wi-Fi" ? 100
    : Number.isFinite(candidate.confidencePct) ? candidate.confidencePct
      : Number.isFinite(candidate.ocrConfidence) ? candidate.ocrConfidence
      : Number.isFinite(candidate.passConfidencePct) ? candidate.passConfidencePct : null;
  const confidencePct = rawConfidence === null ? null : Math.max(0, Math.min(100, Math.round(rawConfidence)));
  const candidatePasses = Array.isArray(candidate.passIds) ? candidate.passIds.filter(id => PASS_IDS.has(id))
    : Array.isArray(candidate.sourcePasses) ? candidate.sourcePasses.map(item => item?.pass).filter(id => PASS_IDS.has(id)) : [];
  return {
    ssid: value, label, source, relation, confidencePct,
    associationConfidence: candidate.associationConfidence || (relation === "next_line" ? "moderate" : "high"),
    passIds: [...new Set([...passIds, ...candidatePasses])],
    requiresReview: Boolean(candidate.needsReview) || source === "OCR" && (confidencePct === null || confidencePct < 90),
  };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

export function buildAdminOcrDiagnostic(analysis, { stage = "review", elapsedMs = null, failureCode = null } = {}) {
  const parsed = analysis?.parsed ?? {};
  const passwordValues = new Set([
    ...(parsed.passwordCandidates ?? []).map(item => item?.value),
    ...(parsed.excludedCandidates ?? []).map(item => item?.value),
    parsed.password?.value, analysis?.qr?.password,
    ...(analysis?.qr?.networks ?? []).map(item => item?.password),
  ].filter(value => typeof value === "string"));
  const all = [];
  const passes = [];
  for (const pass of analysis?.ocr?.passes ?? []) {
    if (!PASS_IDS.has(pass?.id)) continue;
    const passCandidates = explicitCandidatesFromPass(pass, passwordValues);
    const candidates = passCandidates.map(candidate => candidateReport(candidate, [pass.id], passwordValues)).filter(Boolean);
    all.push(...candidates);
    const confidence = Number(pass.confidence);
    passes.push({
      id: pass.id,
      completed: true,
      confidencePct: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : null,
      durationMs: Number.isFinite(pass.durationMs) ? Math.max(0, Math.round(pass.durationMs)) : null,
      ssidLabelDetected: candidates.length > 0,
      candidates,
    });
  }
  for (const candidate of parsed.ssidCandidates ?? []) {
    const safe = candidateReport(candidate, [], passwordValues);
    if (safe) all.push(safe);
  }
  const candidates = dedupe(all);
  const wifiQrCount = (Array.isArray(analysis?.qr?.networks) ? analysis.qr.networks : analysis?.qr?.type === "wifi" ? [analysis.qr] : [])
    .filter(item => isSafeSsid(item?.ssid) && !passwordValues.has(item.ssid)).length;
  const safeReview = analysis ? buildSafeSsidReport(analysis).manualReview : null;
  const passComparison = compareSsidPasses(passes);
  const disputedLabels = new Set([...passComparison.groups.entries()]
    .filter(([key]) => passComparison.statuses.get(key) === "disagreement")
    .map(([, group]) => group.label));
  for (const candidate of candidates) {
    if (disputedLabels.has(candidate.label)) candidate.requiresReview = true;
    if (candidate.source === "OCR" && (candidate.confidencePct === null || candidate.confidencePct < 90)) candidate.requiresReview = true;
  }
  const reasons = new Set((safeReview?.reasons ?? []).filter(reason => REASONS.has(reason)));
  if (passComparison.status === "disagreement") reasons.add("ocr_pass_disagreement");
  if (candidates.some(candidate => candidate.requiresReview)) reasons.add("candidate_requires_review");
  if (candidates.some(candidate => candidate.source === "OCR" && (candidate.confidencePct === null || candidate.confidencePct < 90))) reasons.add("below_auto_confidence_threshold");
  const requested = Boolean(safeReview?.requested || reasons.size || candidates.some(item => item.requiresReview));
  // Keep the summary internally consistent: a requested review must always
  // carry an explicit, safe reason instead of being reported as undetermined.
  if (requested && !reasons.size) reasons.add("review_required_by_flow");
  return {
    format: "wifi-connect-admin-ocr-diagnostic/v3",
    pipeline: "production-router-image-analysis",
    status: analysis ? "completed" : "failed",
    lastStage: STAGES.has(stage) ? stage : "review",
    failureCode: ["IMAGE_DECODE", "OCR_ASSET_LOAD", "OCR_RUNTIME", "PARSER_FAILURE", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(failureCode) ? failureCode : null,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null,
    qr: {
      completed: Boolean(analysis?.qr && !["timeout", "cancelled", "worker-error", "worker-unavailable", "decode-failed"].includes(analysis.qr.reason)),
      outcome: analysis?.qr?.status === "wifi" ? "wifi_found" : analysis?.qr?.status === "ignored" ? "other_qr_found" : analysis?.qr?.status === "not-found" ? "not_found" : analysis?.qr?.reason === "timeout" ? "timeout" : analysis?.qr?.reason === "cancelled" ? "cancelled" : ["worker-error", "worker-unavailable", "decode-failed", "decoder-error"].includes(analysis?.qr?.reason) ? "failed" : analysis?.qr ? "unavailable" : "not_run",
      validWifiQrCount: wifiQrCount,
      durationMs: Number.isFinite(analysis?.qrDurationMs) ? Math.max(0, Math.round(analysis.qrDurationMs)) : null,
      blockedStage: ["image-decode", "barcode-detect", "barcode-complete", "jsqr-full-frame", "jsqr-region", "worker-start"].includes(analysis?.qr?.blockedStage) ? analysis.qr.blockedStage : null,
      attempts: (analysis?.qr?.attempts ?? []).slice(0, 40).map(item => ({
        engine: item.engine === "BarcodeDetector" ? "BarcodeDetector" : "jsQR",
        durationMs: Number.isFinite(item.durationMs) ? Math.max(0, Math.round(item.durationMs)) : null,
        found: Boolean(item.found),
        count: Number.isInteger(item.count) ? Math.max(0, Math.min(20, item.count)) : null,
        width: Number.isInteger(item.width) ? Math.max(0, Math.min(10000, item.width)) : null,
        height: Number.isInteger(item.height) ? Math.max(0, Math.min(10000, item.height)) : null,
        region: ["left", "right", "top", "bottom"].includes(item.region) ? item.region : null,
      })),
    },
    ocr: {
      completed: Boolean(analysis?.ocr && !analysis?.ocrError),
      passes,
      ssidLabelDetected: passes.some(pass => pass.ssidLabelDetected),
      durationMs: Number.isFinite(analysis?.diagnostics?.ocrDurationMs) ? Math.max(0, Math.round(analysis.diagnostics.ocrDurationMs)) : Number.isFinite(analysis?.ocr?.durationMs) ? Math.max(0, Math.round(analysis.ocr.durationMs)) : null,
    },
    parser: {
      completed: Boolean(analysis?.parsed),
      candidates,
      labelAssociations: dedupeAssociations(candidates),
      passComparison: passComparison.status,
      durationMs: Number.isFinite(analysis?.diagnostics?.parserDurationMs) ? Math.max(0, Math.round(analysis.diagnostics.parserDurationMs)) : null,
    },
    review: {
      requested,
      reasons: [...reasons],
      cause: reasons.size ? "identified" : analysis ? "undetermined" : "not_reached",
      verifiedThrough: STAGES.has(stage) ? stage : "review",
    },
  };
}

function dedupe(items) {
  const found = new Map();
  for (const item of items) {
    const key = `${item.ssid}\u0000${item.label}\u0000${item.source}\u0000${item.relation}`;
    const old = found.get(key);
    if (!old) found.set(key, item);
    else {
      old.confidencePct = old.confidencePct === null || item.confidencePct === null ? null : Math.min(old.confidencePct, item.confidencePct);
      if (item.associationConfidence === "moderate") old.associationConfidence = "moderate";
      old.requiresReview ||= item.requiresReview;
      old.passIds = [...new Set([...old.passIds, ...item.passIds])];
    }
  }
  return [...found.values()];
}

function dedupeAssociations(items) {
  const seen = new Set();
  return items.flatMap(item => {
    const key = `${item.label}\u0000${item.relation}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ label: item.label, relation: item.relation }];
  });
}

export function validateAdminOcrDiagnostic(report) {
  const root = ["format", "pipeline", "status", "lastStage", "failureCode", "elapsedMs", "qr", "ocr", "parser", "review"];
  if (!exactKeys(report, root) || report.format !== "wifi-connect-admin-ocr-diagnostic/v3"
      || report.pipeline !== "production-router-image-analysis"
      || !["completed", "failed"].includes(report.status) || !STAGES.has(report.lastStage)) return false;
  if (report.failureCode !== null && !["IMAGE_DECODE", "OCR_ASSET_LOAD", "OCR_RUNTIME", "PARSER_FAILURE", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(report.failureCode)) return false;
  if (report.elapsedMs !== null && (!Number.isInteger(report.elapsedMs) || report.elapsedMs < 0 || report.elapsedMs > 600000)) return false;
  const timeValid = value => value === null || Number.isInteger(value) && value >= 0 && value <= 600000;
  if (!exactKeys(report.qr, ["completed", "outcome", "validWifiQrCount", "durationMs", "blockedStage", "attempts"]) || typeof report.qr.completed !== "boolean"
      || !["wifi_found", "other_qr_found", "not_found", "unavailable", "not_run", "timeout", "cancelled", "failed"].includes(report.qr.outcome)
      || !Number.isInteger(report.qr.validWifiQrCount) || report.qr.validWifiQrCount < 0 || report.qr.validWifiQrCount > 20
      || !timeValid(report.qr.durationMs) || (report.qr.blockedStage !== null && !["image-decode", "barcode-detect", "barcode-complete", "jsqr-full-frame", "jsqr-region", "worker-start"].includes(report.qr.blockedStage)) || !Array.isArray(report.qr.attempts) || report.qr.attempts.length > 40
      || !report.qr.attempts.every(item => exactKeys(item, ["engine", "durationMs", "found", "count", "width", "height", "region"])
        && ["BarcodeDetector", "jsQR"].includes(item.engine) && timeValid(item.durationMs) && typeof item.found === "boolean"
        && (item.count === null || Number.isInteger(item.count) && item.count >= 0 && item.count <= 20)
        && [item.width, item.height].every(value => value === null || Number.isInteger(value) && value >= 0 && value <= 10000)
        && (item.region === null || ["left", "right", "top", "bottom"].includes(item.region)))) return false;
  if (!exactKeys(report.ocr, ["completed", "passes", "ssidLabelDetected", "durationMs"]) || typeof report.ocr.completed !== "boolean"
      || !timeValid(report.ocr.durationMs)
      || typeof report.ocr.ssidLabelDetected !== "boolean" || !Array.isArray(report.ocr.passes) || report.ocr.passes.length > PASS_IDS.size) return false;
  const candidateValid = item => exactKeys(item, ["ssid", "label", "source", "relation", "confidencePct", "associationConfidence", "passIds", "requiresReview"])
    && isSafeSsid(item.ssid) && [...LABELS.values(), "SSID"].includes(item.label)
    && ["OCR", "QR Wi-Fi"].includes(item.source) && ["labelled", "same_line", "next_line"].includes(item.relation)
    && (item.confidencePct === null || Number.isInteger(item.confidencePct) && item.confidencePct >= 0 && item.confidencePct <= 100)
    && ["high", "moderate"].includes(item.associationConfidence)
    && Array.isArray(item.passIds) && item.passIds.length <= PASS_IDS.size && item.passIds.every(id => PASS_IDS.has(id))
    && typeof item.requiresReview === "boolean";
  for (const pass of report.ocr.passes) {
    if (!exactKeys(pass, ["id", "completed", "confidencePct", "durationMs", "ssidLabelDetected", "candidates"])
        || !PASS_IDS.has(pass.id) || typeof pass.completed !== "boolean" || typeof pass.ssidLabelDetected !== "boolean"
        || (pass.confidencePct !== null && (!Number.isInteger(pass.confidencePct) || pass.confidencePct < 0 || pass.confidencePct > 100))
        || (pass.durationMs !== null && (!Number.isInteger(pass.durationMs) || pass.durationMs < 0 || pass.durationMs > 600000))
        || !Array.isArray(pass.candidates) || !pass.candidates.every(candidateValid)) return false;
  }
  if (!exactKeys(report.parser, ["completed", "candidates", "labelAssociations", "passComparison", "durationMs"])
      || typeof report.parser.completed !== "boolean" || !Array.isArray(report.parser.candidates)
      || !timeValid(report.parser.durationMs)
      || report.parser.candidates.length > 100 || !report.parser.candidates.every(candidateValid)
      || !Array.isArray(report.parser.labelAssociations) || report.parser.labelAssociations.length > 100
      || !report.parser.labelAssociations.every(value => exactKeys(value, ["label", "relation"])
        && [...LABELS.values(), "SSID", "SSID1", "SSID2", "SSID (2.4 GHz)", "SSID (5 GHz)", "Wi-Fi Name", "WLAN Name", "Network Name", "Nombre Wi-Fi", "Nombre de red", "Red Wi-Fi", "Nom de xarxa", "Xarxa Wi-Fi"].includes(value.label)
        && ["labelled", "same_line", "next_line"].includes(value.relation))
      || !["agreement", "disagreement", "insufficient", "no_candidate"].includes(report.parser.passComparison)) return false;
  if (!exactKeys(report.review, ["requested", "reasons", "cause", "verifiedThrough"])
      || typeof report.review.requested !== "boolean" || !Array.isArray(report.review.reasons)
      || report.review.reasons.length > REASONS.size || !report.review.reasons.every(reason => REASONS.has(reason))
      || !["identified", "undetermined", "not_reached"].includes(report.review.cause)
      || !STAGES.has(report.review.verifiedThrough)) return false;
  return true;
}

export function serializeAdminOcrDiagnostic(report) {
  if (!validateAdminOcrDiagnostic(report)) throw new TypeError("El informe no supera la validación segura.");
  const text = JSON.stringify(report, null, 2);
  if (text.length > 30000) throw new RangeError("Informe demasiado grande.");
  return text;
}

export function renderAdminOcrDiagnostic(report) {
  if (!validateAdminOcrDiagnostic(report)) return "<section class=\"screen\"><h1>Diagnóstico no disponible</h1><p>El informe no supera la validación de privacidad.</p></section>";
  const stageNames = { qr: "Detección QR", ocr: "Reconocimiento OCR", parser: "Asociación de campos", review: "Revisión" };
  const qrNames = { wifi_found: "QR Wi-Fi válido", other_qr_found: "QR no Wi-Fi detectado", not_found: "sin QR", unavailable: "no disponible", not_run: "no iniciada", timeout: "cancelada por límite de tiempo", cancelled: "cancelada", failed: "falló; continuó el OCR" };
  const qrStageNames = { "image-decode": "decodificación de imagen", "barcode-detect": "BarcodeDetector", "barcode-complete": "respuesta de BarcodeDetector", "jsqr-full-frame": "búsqueda completa jsQR", "jsqr-region": "búsqueda por regiones jsQR", "worker-start": "inicio del lector QR" };
  const reasons = report.review.reasons.map(reason => REASON_LABELS[reason]).filter(Boolean);
  const candidates = report.parser.candidates.map(item => `<li><strong>${escapeHtml(item.ssid)}</strong><br><small>${escapeHtml(item.source)} · etiqueta ${escapeHtml(item.label)} · ${item.relation === "next_line" ? "valor en línea siguiente" : item.relation === "same_line" ? "valor en la misma línea" : "valor asociado"} · confianza OCR ${item.confidencePct === null ? "no disponible" : `${item.confidencePct}%`} · asociación ${item.associationConfidence === "moderate" ? "moderada" : "directa"}${item.requiresReview ? " · requiere revisión" : ""}</small></li>`).join("");
  const qrAttempts = report.qr.attempts.map(item => `<li>${escapeHtml(item.engine)}${item.region ? ` · ${escapeHtml(item.region)}` : ""} · ${item.durationMs === null ? "sin tiempo" : `${item.durationMs} ms`} · ${item.found ? "código detectado" : "sin código"}${item.count === null ? "" : ` · ${item.count}`} </li>`).join("");
  const passRows = report.ocr.passes.map(pass => `<li>${escapeHtml(pass.id)} · ${pass.completed ? "completada" : "no completada"} · ${pass.confidencePct === null ? "confianza no disponible" : `${pass.confidencePct}%`}</li>`).join("");
  const comparisonText = {agreement:"coincidencia",disagreement:"discrepancia",insufficient:"evidencia insuficiente",no_candidate:"sin candidato"}[report.parser.passComparison];
  return `<section class="screen admin-ocr-screen"><div class="wifi-report-heading"><button class="wifi-report-back" type="button" data-action="admin-ocr-back">‹ <span>Volver a Wifi Connect</span></button><h1>Diagnóstico OCR</h1></div><p class="wifi-report-privacy">Análisis en el dispositivo. El informe contiene únicamente candidatos SSID y metadatos técnicos permitidos. No incluye fotografía, texto OCR ni contraseñas.</p><section class="wifi-report-card"><h2>Fuente de imagen</h2><label class="wifi-report-field"><span>Fotografía local</span><input type="file" accept="image/png,image/jpeg,image/webp" data-admin-ocr-file></label><div class="admin-ocr-report-picker"><button type="button" class="wifi-report-secondary" data-action="admin-ocr-load-reports">Cargar reportes con autorización de fotografía</button><select aria-label="Reporte autorizado" data-admin-ocr-report><option value="">Selecciona un reporte autorizado</option></select><button type="button" class="wifi-report-secondary" data-action="admin-ocr-use-report">Usar fotografía del reporte</button></div><button type="button" class="wifi-report-primary" data-action="admin-ocr-run" ${report.status === "completed" ? "disabled" : ""}>Analizar con el flujo de producción</button><button type="button" class="wifi-report-secondary" data-action="admin-ocr-cancel">Cancelar análisis</button></section><section class="wifi-report-card" aria-live="polite"><h2>Resultado</h2><p>Etapa verificada: ${escapeHtml(stageNames[report.lastStage])}</p><p>${report.failureCode ? `Análisis detenido (${escapeHtml(report.failureCode)}).` : report.status === "completed" ? "Análisis completado." : "Causa no determinada; verificación disponible hasta la etapa indicada."}</p><p>Detección QR: ${escapeHtml(qrNames[report.qr.outcome])} · QR Wi-Fi válidos: ${report.qr.validWifiQrCount} · ${report.qr.durationMs === null ? "tiempo no disponible" : `${report.qr.durationMs} ms`}${report.qr.blockedStage ? ` · etapa: ${escapeHtml(qrStageNames[report.qr.blockedStage])}` : ""}</p>${qrAttempts ? `<ul>${qrAttempts}</ul>` : ""}<p>OCR: ${report.ocr.completed ? "completado" : "sin completar"} · etiquetas SSID: ${report.ocr.ssidLabelDetected ? "detectadas" : "no detectadas"} · ${report.ocr.durationMs === null ? "tiempo no disponible" : `${report.ocr.durationMs} ms`}</p><p>Parser: ${report.parser.completed ? "completado" : "sin completar"} · ${report.parser.durationMs === null ? "tiempo no disponible" : `${report.parser.durationMs} ms`} · comparación: ${escapeHtml(comparisonText)}</p><p>Tiempo total: ${report.elapsedMs === null ? "no disponible" : `${report.elapsedMs} ms`}</p><ul>${passRows}</ul><h3>Candidatos SSID</h3>${candidates ? `<ul>${candidates}</ul>` : "<p>No se obtuvo un candidato SSID seguro.</p>"}<p>Revisión manual: ${report.review.requested ? "sí" : "no"}${reasons.length ? ` · ${reasons.map(escapeHtml).join("; ")}` : ""}</p><button type="button" class="wifi-report-secondary" data-action="admin-ocr-copy">Copiar informe sanitizado</button></section></section>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}
