import { buildSafeSsidReport, compareSsidPasses, explicitCandidatesFromPass } from "./ssid-diagnostic-report.js?v=3ce1";
const PASS_IDS = new Set(["color", "grayscale-contrast", "ssid-focus-1", "ssid-focus-2"]);
const STAGES = new Set(["file", "decode", "qr", "worker", "ocr", "parser", "review"]);
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
const FAILURE_CODES = ["FILE_MISSING", "FILE_TYPE", "FILE_SIZE", "IMAGE_DECODE", "OCR_ASSET_LOAD", "WORKER_INIT", "OCR_RUNTIME", "PARSER_FAILURE", "RENDER_FAILURE", "CANCELLED", "TIMEOUT", "UNKNOWN"];
const REJECTION_CATEGORIES = new Set(["password_like", "low_confidence", "cross_field", "invalid_candidate", "filtered"]);

export function classifyAdminOcrFailure(error, stage, timedOut = false) {
  if (timedOut) return "TIMEOUT";
  if (error?.name === "AbortError") return "CANCELLED";
  if (error?.name === "EncodingError" || stage === "decode") return "IMAGE_DECODE";
  if (error?.name === "NetworkError") return "OCR_ASSET_LOAD";
  if (stage === "worker") return "WORKER_INIT";
  if (stage === "parser") return "PARSER_FAILURE";
  return "OCR_RUNTIME";
}

export function validateAdminOcrFile(file) {
  if (!file) return "FILE_MISSING";
  const extension = String(file.name ?? "").toLowerCase().match(/\.(heic|heif|jpe?g|png|webp)$/)?.[1];
  const supportedType = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]).has(String(file.type ?? "").toLowerCase());
  if (!supportedType && !["heic", "heif", "jpg", "jpeg", "png", "webp"].includes(extension)) return "FILE_TYPE";
  if (!Number.isInteger(file.size) || file.size < 16 || file.size > 20 * 1024 * 1024) return "FILE_SIZE";
  return null;
}

export async function inspectAdminOcrImage(file, { timeoutMs = 5000 } = {}) {
  const types = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
  const type = types.has(file?.type?.toLowerCase()) ? file.type.toLowerCase() : "unknown";
  const meta = { type, sizeBytes: Number.isInteger(file?.size) ? file.size : null, width: null, height: null, decode: "not_attempted" };
  if (!file) return { ...meta, decode: "failed" };
  if (typeof createImageBitmap !== "function") return { ...meta, decode: "unsupported" };
  let bitmap, timeout, timedOut = false;
  try {
    const pending = createImageBitmap(file);
    pending.then(value => { if (timedOut) value.close?.(); }).catch(() => {});
    bitmap = await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => { timedOut = true; reject(new Error("decode-timeout")); }, Math.max(1, timeoutMs)); })]);
    return { ...meta, width: bitmap.width, height: bitmap.height, decode: "decoded" };
  } catch {
    return { ...meta, decode: timedOut ? "timeout" : "failed" };
  } finally {
    clearTimeout(timeout);
    bitmap?.close?.();
  }
}

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

function safeRejectionCategory(reason) {
  const text = String(reason ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/password|contras|clave|wlan key|wifi key/.test(text)) return "password_like";
  if (/score|confidence|confian|umbral|weak|low/.test(text)) return "low_confidence";
  if (/cross|contamin|campo|field/.test(text)) return "cross_field";
  if (/invalid|invalid|caracter|formato|length|longitud|unsafe/.test(text)) return "invalid_candidate";
  return "filtered";
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

export function buildAdminOcrDiagnostic(analysis, { stage = "review", elapsedMs = null, failureCode = null, image = null, workerState = null, passStates = null, qrSnapshot = null } = {}) {
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
  const passStateList = [...PASS_IDS].map(id => {
    const completed = passes.some(pass => pass.id === id);
    const override = passStates?.[id];
    const state = completed ? "completed" : ["not_started", "running", "failed"].includes(override?.state) ? override.state : "not_started";
    return { id, state, durationMs: completed ? passes.find(pass => pass.id === id)?.durationMs ?? null
      : Number.isFinite(override?.durationMs) ? Math.max(0, Math.min(600000, Math.round(override.durationMs))) : null };
  });
  for (const candidate of parsed.ssidCandidates ?? []) {
    const safe = candidateReport(candidate, [], passwordValues);
    if (safe) all.push(safe);
  }
  const candidates = dedupe(all);
  const detectedCount = Number(analysis?.diagnostics?.ssidCandidateCounts?.detected);
  const acceptedCount = Number(analysis?.diagnostics?.ssidCandidateCounts?.accepted);
  const rejectedCount = Number.isFinite(detectedCount) && Number.isFinite(acceptedCount)
    ? Math.max(0, Math.min(100, detectedCount - acceptedCount)) : (analysis?.parsed?.excludedCandidates ?? []).length;
  const rejectionCategories = [...new Set((analysis?.parsed?.excludedCandidates ?? []).map(item => safeRejectionCategory(item?.reason)))].filter(item => REJECTION_CATEGORIES.has(item));
  const wifiQrCount = (Array.isArray(analysis?.qr?.networks) ? analysis.qr.networks : analysis?.qr?.type === "wifi" ? [analysis.qr] : [])
    .filter(item => isSafeSsid(item?.ssid) && !passwordValues.has(item.ssid)).length;
  const safeQrSnapshot = qrSnapshot && typeof qrSnapshot === "object" ? {
    completed: Boolean(qrSnapshot.completed),
    outcome: ["wifi_found", "other_qr_found", "not_found", "unavailable", "timeout", "cancelled", "failed"].includes(qrSnapshot.outcome) ? qrSnapshot.outcome : "unavailable",
    validWifiQrCount: Number.isInteger(qrSnapshot.validWifiQrCount) ? Math.max(0, Math.min(20, qrSnapshot.validWifiQrCount)) : 0,
    durationMs: Number.isFinite(qrSnapshot.durationMs) ? Math.max(0, Math.min(600000, Math.round(qrSnapshot.durationMs))) : null,
    blockedStage: ["image-decode", "barcode-detect", "barcode-complete", "jsqr-full-frame", "jsqr-region", "worker-start"].includes(qrSnapshot.blockedStage) ? qrSnapshot.blockedStage : null,
    attempts: (Array.isArray(qrSnapshot.attempts) ? qrSnapshot.attempts : []).slice(0, 40).map(item => ({
      engine: item?.engine === "BarcodeDetector" ? "BarcodeDetector" : "jsQR",
      durationMs: Number.isFinite(item?.durationMs) ? Math.max(0, Math.min(600000, Math.round(item.durationMs))) : null,
      found: Boolean(item?.found), count: Number.isInteger(item?.count) ? Math.max(0, Math.min(20, item.count)) : null,
      width: Number.isInteger(item?.width) ? Math.max(0, Math.min(10000, item.width)) : null,
      height: Number.isInteger(item?.height) ? Math.max(0, Math.min(10000, item.height)) : null,
      region: ["left", "right", "top", "bottom"].includes(item?.region) ? item.region : null,
    })),
  } : null;
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
    format: "wifi-connect-admin-ocr-diagnostic/v4",
    pipeline: "production-router-image-analysis",
    status: analysis ? "completed" : "failed",
    lastStage: STAGES.has(stage) ? stage : "review",
    failureCode: FAILURE_CODES.includes(failureCode) ? failureCode : null,
    workerState: ["not_started", "initializing", "ready", "failed", "unknown"].includes(workerState) ? workerState
      : analysis ? "ready" : failureCode === "WORKER_INIT" || failureCode === "OCR_ASSET_LOAD" ? "failed" : ["FILE_MISSING", "FILE_TYPE", "FILE_SIZE"].includes(failureCode) ? "not_started" : "unknown",
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null,
    image: {
      selected: Boolean(image),
      type: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "unknown"].includes(image?.type) ? image.type : image ? "unknown" : null,
      sizeBytes: Number.isInteger(image?.sizeBytes) ? Math.max(0, Math.min(image.sizeBytes, 100 * 1024 * 1024)) : null,
      width: Number.isInteger(analysis?.ocr?.image?.sourceWidth) ? Math.max(0, Math.min(analysis.ocr.image.sourceWidth, 20000)) : Number.isInteger(image?.width) ? Math.max(0, Math.min(image.width, 20000)) : null,
      height: Number.isInteger(analysis?.ocr?.image?.sourceHeight) ? Math.max(0, Math.min(analysis.ocr.image.sourceHeight, 20000)) : Number.isInteger(image?.height) ? Math.max(0, Math.min(image.height, 20000)) : null,
      decode: analysis?.ocr?.image ? "decoded" : ["not_attempted", "decoded", "failed", "unsupported", "timeout"].includes(image?.decode) ? image.decode : "not_attempted",
    },
    qr: {
      completed: analysis?.qr ? !["timeout", "cancelled", "worker-error", "worker-unavailable", "decode-failed"].includes(analysis.qr.reason) : Boolean(safeQrSnapshot?.completed),
      outcome: analysis?.qr ? analysis.qr.status === "wifi" ? "wifi_found" : analysis.qr.status === "ignored" ? "other_qr_found" : analysis.qr.status === "not-found" ? "not_found" : analysis.qr.reason === "timeout" ? "timeout" : analysis.qr.reason === "cancelled" ? "cancelled" : ["worker-error", "worker-unavailable", "decode-failed", "decoder-error"].includes(analysis.qr.reason) ? "failed" : "unavailable" : safeQrSnapshot?.outcome ?? "not_run",
      validWifiQrCount: analysis?.qr ? wifiQrCount : safeQrSnapshot?.validWifiQrCount ?? 0,
      durationMs: Number.isFinite(analysis?.qrDurationMs) ? Math.max(0, Math.round(analysis.qrDurationMs)) : safeQrSnapshot?.durationMs ?? null,
      blockedStage: analysis?.qr ? ["image-decode", "barcode-detect", "barcode-complete", "jsqr-full-frame", "jsqr-region", "worker-start"].includes(analysis.qr.blockedStage) ? analysis.qr.blockedStage : null : safeQrSnapshot?.blockedStage ?? null,
      attempts: analysis?.qr ? (analysis.qr.attempts ?? []).slice(0, 40).map(item => ({
        engine: item.engine === "BarcodeDetector" ? "BarcodeDetector" : "jsQR",
        durationMs: Number.isFinite(item.durationMs) ? Math.max(0, Math.round(item.durationMs)) : null,
        found: Boolean(item.found),
        count: Number.isInteger(item.count) ? Math.max(0, Math.min(20, item.count)) : null,
        width: Number.isInteger(item.width) ? Math.max(0, Math.min(10000, item.width)) : null,
        height: Number.isInteger(item.height) ? Math.max(0, Math.min(10000, item.height)) : null,
        region: ["left", "right", "top", "bottom"].includes(item.region) ? item.region : null,
      })) : safeQrSnapshot?.attempts ?? [],
    },
    ocr: {
      completed: Boolean(analysis?.ocr && !analysis?.ocrError),
      passes,
      passStates: passStateList,
      ssidLabelDetected: passes.some(pass => pass.ssidLabelDetected),
      durationMs: Number.isFinite(analysis?.diagnostics?.ocrDurationMs) ? Math.max(0, Math.round(analysis.diagnostics.ocrDurationMs)) : Number.isFinite(analysis?.ocr?.durationMs) ? Math.max(0, Math.round(analysis.ocr.durationMs)) : null,
    },
    parser: {
      completed: Boolean(analysis?.parsed),
      candidates,
      passwordCandidateCount: Math.max(0, Math.min(100, (analysis?.parsed?.passwordCandidates ?? []).length)),
      rejectedCount: Math.max(0, Math.min(100, rejectedCount)),
      rejectionCategories,
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
  if (!exactKeys(report, [...root, "image", "workerState"]) || report.format !== "wifi-connect-admin-ocr-diagnostic/v4"
      || report.pipeline !== "production-router-image-analysis"
      || !["completed", "failed"].includes(report.status) || !STAGES.has(report.lastStage)) return false;
  if (report.failureCode !== null && !FAILURE_CODES.includes(report.failureCode)) return false;
  if (!["not_started", "initializing", "ready", "failed", "unknown"].includes(report.workerState)) return false;
  if (!exactKeys(report.image, ["selected", "type", "sizeBytes", "width", "height", "decode"])
      || typeof report.image.selected !== "boolean"
      || (report.image.type !== null && !["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "unknown"].includes(report.image.type))
      || ![report.image.sizeBytes, report.image.width, report.image.height].every(value => value === null || Number.isInteger(value) && value >= 0)
      || !["not_attempted", "decoded", "failed", "unsupported", "timeout"].includes(report.image.decode)) return false;
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
  if (!exactKeys(report.ocr, ["completed", "passes", "passStates", "ssidLabelDetected", "durationMs"]) || typeof report.ocr.completed !== "boolean"
      || !timeValid(report.ocr.durationMs)
      || typeof report.ocr.ssidLabelDetected !== "boolean" || !Array.isArray(report.ocr.passes) || report.ocr.passes.length > PASS_IDS.size) return false;
  if (!Array.isArray(report.ocr.passStates) || report.ocr.passStates.length !== PASS_IDS.size
      || !report.ocr.passStates.every(item => exactKeys(item, ["id", "state", "durationMs"]) && PASS_IDS.has(item.id)
        && ["not_started", "running", "completed", "failed"].includes(item.state) && timeValid(item.durationMs))) return false;
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
  if (!exactKeys(report.parser, ["completed", "candidates", "passwordCandidateCount", "rejectedCount", "rejectionCategories", "labelAssociations", "passComparison", "durationMs"])
      || typeof report.parser.completed !== "boolean" || !Array.isArray(report.parser.candidates)
      || !Number.isInteger(report.parser.passwordCandidateCount) || report.parser.passwordCandidateCount < 0 || report.parser.passwordCandidateCount > 100
      || !Number.isInteger(report.parser.rejectedCount) || report.parser.rejectedCount < 0 || report.parser.rejectedCount > 100
      || !Array.isArray(report.parser.rejectionCategories) || report.parser.rejectionCategories.length > REJECTION_CATEGORIES.size || !report.parser.rejectionCategories.every(item => REJECTION_CATEGORIES.has(item))
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
  // Deliberately rebuild a closed, metadata-only shape. Never serialize candidate values,
  // labels that may contain OCR text, or the original analysis object.
  const safe = {
    format: "wifi-connect-admin-ocr-diagnostic-safe/v1",
    pipeline: report.pipeline,
    status: report.status,
    lastStage: report.lastStage,
    failureCode: report.failureCode,
    elapsedMs: report.elapsedMs,
    image: report.image,
    workerState: report.workerState,
    qr: { completed: report.qr.completed, outcome: report.qr.outcome, validWifiQrCount: report.qr.validWifiQrCount, durationMs: report.qr.durationMs, attempts: report.qr.attempts.map(({ engine, durationMs, found, count, width, height, region }) => ({ engine, durationMs, found, count, width, height, region })) },
    ocr: { completed: report.ocr.completed, passCount: report.ocr.passes.length, passes: report.ocr.passStates, ssidLabelDetected: report.ocr.ssidLabelDetected, candidateCount: report.parser.candidates.filter(candidate => candidate.source === "OCR").length },
    parser: { completed: report.parser.completed, candidateCount: report.parser.candidates.length, passwordCandidateCount: report.parser.passwordCandidateCount, rejectedCount: report.parser.rejectedCount, rejectionCategories: report.parser.rejectionCategories, labelAssociationCount: report.parser.labelAssociations.length, passComparison: report.parser.passComparison, durationMs: report.parser.durationMs },
    review: report.review,
  };
  const text = JSON.stringify(safe, null, 2);
  if (text.length > 30000) throw new RangeError("Informe demasiado grande.");
  return text;
}

export function renderAdminOcrDiagnostic(report) {
  if (!validateAdminOcrDiagnostic(report)) return "<section class=\"screen\"><h1>Diagnóstico no disponible</h1><p>El informe no supera la validación de privacidad.</p></section>";
  const stageNames = { file: "Selección de imagen", decode: "Decodificación de imagen", qr: "Detección QR", worker: "Inicio del worker OCR", ocr: "Reconocimiento OCR", parser: "Asociación de campos", review: "Revisión" };
  const qrNames = { wifi_found: "QR Wi-Fi válido", other_qr_found: "QR no Wi-Fi detectado", not_found: "sin QR", unavailable: "no disponible", not_run: "no iniciada", timeout: "cancelada por límite de tiempo", cancelled: "cancelada", failed: "falló; continuó el OCR" };
  const qrStageNames = { "image-decode": "decodificación de imagen", "barcode-detect": "BarcodeDetector", "barcode-complete": "respuesta de BarcodeDetector", "jsqr-full-frame": "búsqueda completa jsQR", "jsqr-region": "búsqueda por regiones jsQR", "worker-start": "inicio del lector QR" };
  const reasons = report.review.reasons.map(reason => REASON_LABELS[reason]).filter(Boolean);
  const candidates = report.parser.candidates.map(item => `<li><strong>${escapeHtml(item.ssid)}</strong><br><small>${escapeHtml(item.source)} · etiqueta ${escapeHtml(item.label)} · ${item.relation === "next_line" ? "valor en línea siguiente" : item.relation === "same_line" ? "valor en la misma línea" : "valor asociado"} · confianza OCR ${item.confidencePct === null ? "no disponible" : `${item.confidencePct}%`} · asociación ${item.associationConfidence === "moderate" ? "moderada" : "directa"}${item.requiresReview ? " · requiere revisión" : ""}</small></li>`).join("");
  const qrAttempts = report.qr.attempts.map(item => `<li>${escapeHtml(item.engine)}${item.region ? ` · ${escapeHtml(item.region)}` : ""} · ${item.durationMs === null ? "sin tiempo" : `${item.durationMs} ms`} · ${item.found ? "código detectado" : "sin código"}${item.count === null ? "" : ` · ${item.count}`} </li>`).join("");
  const passRows = report.ocr.passStates.map(pass => `<li>${escapeHtml(pass.id)} · ${escapeHtml(pass.state)} · ${pass.durationMs === null ? "tiempo no disponible" : `${pass.durationMs} ms`}</li>`).join("");
  const comparisonText = {agreement:"coincidencia",disagreement:"discrepancia",insufficient:"evidencia insuficiente",no_candidate:"sin candidato"}[report.parser.passComparison];
  return `<section class="screen admin-ocr-screen"><div class="wifi-report-heading"><button class="wifi-report-back" type="button" data-action="admin-ocr-back">‹ <span>Volver a Wifi Connect</span></button><h1>Diagnóstico OCR</h1></div><p class="wifi-report-privacy">Análisis en el dispositivo. La copia incluye solo etapas, contadores y metadatos técnicos; no incluye SSID, contraseñas, foto, texto OCR ni ruta del archivo.</p><section class="wifi-report-card"><h2>Fuente de imagen</h2><label class="wifi-report-field"><span>Fotografía local</span><input type="file" accept="image/*,.heic,.heif" data-admin-ocr-file></label><div class="admin-ocr-report-picker"><button type="button" class="wifi-report-secondary" data-action="admin-ocr-load-reports">Cargar reportes con autorización de fotografía</button><select aria-label="Reporte autorizado" data-admin-ocr-report><option value="">Selecciona un reporte autorizado</option></select><button type="button" class="wifi-report-secondary" data-action="admin-ocr-use-report">Usar fotografía del reporte</button></div><button type="button" class="wifi-report-primary" data-action="admin-ocr-run">Analizar con el flujo de producción</button><button type="button" class="wifi-report-secondary" data-action="admin-ocr-cancel">Cancelar análisis</button></section><section class="wifi-report-card" aria-live="polite"><h2>Resultado</h2><p>Etapa: ${escapeHtml(stageNames[report.lastStage])}</p><p>${report.failureCode ? `Análisis detenido (${escapeHtml(report.failureCode)}).` : report.status === "completed" ? "Análisis completado." : "Causa no determinada; verificación disponible hasta la etapa indicada."}</p><p>Archivo: ${report.image.selected ? `${escapeHtml(report.image.type || "tipo desconocido")} · ${report.image.sizeBytes ?? "tamaño desconocido"} bytes · ${report.image.width ?? "?"} × ${report.image.height ?? "?"} · decodificación ${report.image.decode}` : "no seleccionado"}</p><p>Detección QR: ${escapeHtml(qrNames[report.qr.outcome])} · QR Wi-Fi válidos: ${report.qr.validWifiQrCount} · ${report.qr.durationMs === null ? "tiempo no disponible" : `${report.qr.durationMs} ms`}${report.qr.blockedStage ? ` · etapa: ${escapeHtml(qrStageNames[report.qr.blockedStage])}` : ""}</p>${qrAttempts ? `<ul>${qrAttempts}</ul>` : ""}<p>OCR: ${report.ocr.completed ? "completado" : "sin completar"} · etiquetas detectadas: ${report.ocr.ssidLabelDetected ? "sí" : "no"} · ${report.ocr.durationMs === null ? "tiempo no disponible" : `${report.ocr.durationMs} ms`} · candidatos SSID ${report.parser.candidates.length} · candidatos contraseña ${report.parser.passwordCandidateCount}</p><p>Parser: ${report.parser.completed ? "completado" : "sin completar"} · candidatos rechazados: ${report.parser.rejectedCount} · ${report.parser.durationMs === null ? "tiempo no disponible" : `${report.parser.durationMs} ms`} · comparación: ${escapeHtml(comparisonText)}</p><p>Tiempo total: ${report.elapsedMs === null ? "no disponible" : `${report.elapsedMs} ms`}</p><ul>${passRows}</ul><p>Revisión manual: ${report.review.requested ? "sí" : "no"}${reasons.length ? ` · ${reasons.map(escapeHtml).join("; ")}` : ""}</p><button type="button" class="wifi-report-secondary" data-action="admin-ocr-copy">Copiar diagnóstico seguro</button></section></section>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}
