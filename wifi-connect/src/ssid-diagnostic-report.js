import {parseRouterLabel} from './router-parser.js?v=3by1';
import {buildScanPlan, detectCrossFieldContamination} from './scan-flow.js?v=3by1';

const LABELS = new Map([
  ['ssid', 'SSID'], ['ssid 1', 'SSID1'], ['ssid1', 'SSID1'], ['ssid 2', 'SSID2'], ['ssid2', 'SSID2'],
  ['ssid 2.4 ghz', 'SSID (2.4 GHz)'], ['ssid 2 4 ghz', 'SSID (2.4 GHz)'],
  ['ssid 5 ghz', 'SSID (5 GHz)'], ['wifi name', 'Wi-Fi Name'], ['wi fi name', 'Wi-Fi Name'],
  ['wlan name', 'WLAN Name'], ['network name', 'Network Name'],
  ['nombre de wi fi', 'Nombre Wi-Fi'], ['nombre wi fi', 'Nombre Wi-Fi'],
  ['nombre de red', 'Nombre de red'], ['red wi fi', 'Red Wi-Fi'],
  ['nom de xarxa', 'Nom de xarxa'], ['xarxa wi fi', 'Xarxa Wi-Fi']
]);
const PASS_IDS = new Set(['color', 'grayscale-contrast', 'ssid-focus-1', 'ssid-focus-2']);
const REVIEW_REASONS = new Set([
  'no_explicit_ssid_candidate', 'multiple_ssid_candidates', 'below_auto_confidence_threshold',
  'ocr_pass_disagreement', 'candidate_requires_review', 'wifi_band_conflict',
  'qr_ssid_conflict', 'field_contamination', 'review_required_by_flow'
]);
const normalizeLabel = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[：＝]/g, ':').replace(/\s+/g, ' ').trim().replace(/\s*[:=]\s*$/, '').trim();
const canonicalLabel = value => LABELS.get(normalizeLabel(value)) || null;

function safeSsidValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  if ([...value].some(char => {
    const code = char.codePointAt(0);
    return code < 0x20 || code === 0x7f || code >= 0x80 && code <= 0x9f;
  })) return false;
  return new TextEncoder().encode(value).length <= 32;
}

export function candidateForReport(candidate, passwordValues = new Set(), passConfidenceById = new Map()) {
  const label = canonicalLabel(candidate?.sourceLabel);
  if (candidate?.fieldType !== 'ssid' || !label || candidate?.source?.startsWith('qr')) return null;
  if (!safeSsidValue(candidate.value) || passwordValues.has(candidate.value)) return null;
  const reason = String(candidate.reason || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const relation = reason.includes('linea siguiente') ? 'next_line' : reason.includes('misma linea') ? 'same_line' : 'labelled';
  const sourcePasses = Array.isArray(candidate.sourcePasses) ? candidate.sourcePasses : [];
  const passIds = [...new Set(sourcePasses.map(item => item?.pass).filter(id => PASS_IDS.has(id)))];
  const passConfidences = sourcePasses.map(item => Number.isFinite(item?.score) ? item.score : passConfidenceById.get(item?.pass))
    .filter(Number.isFinite);
  const ocrConfidence = passConfidences.length ? Math.min(...passConfidences)
    : Number.isFinite(candidate.ocrConfidence) ? candidate.ocrConfidence : null;
  const associationConfidence = relation === 'next_line' ? 'moderate' : 'high';
  return {
    ssid: candidate.value,
    label,
    relation,
    // Parser score measures ranking/label evidence; it is not OCR confidence.
    confidencePct: ocrConfidence === null ? null : Math.max(0, Math.min(100, Math.round(ocrConfidence))),
    associationConfidence,
    passIds,
    needsReview: Boolean(candidate.needsReview) || ocrConfidence === null || ocrConfidence < 90
  };
}

function collectCandidates(candidates, passwordValues, passConfidenceById) {
  const unique = new Map();
  for (const item of candidates || []) {
    const safe = candidateForReport(item, passwordValues, passConfidenceById);
    if (!safe) continue;
    const key = `${safe.ssid}\u0000${safe.label}\u0000${safe.relation}`;
    const old = unique.get(key);
    if (!old) unique.set(key, safe);
    else {
      old.confidencePct = old.confidencePct === null || safe.confidencePct === null ? null : Math.min(old.confidencePct, safe.confidencePct);
      if (safe.associationConfidence === 'moderate') old.associationConfidence = 'moderate';
      old.needsReview ||= safe.needsReview;
      old.passIds = [...new Set([...old.passIds, ...safe.passIds])];
    }
  }
  return [...unique.values()];
}

function mergeSafeCandidates(candidates) {
  const unique = new Map();
  for (const item of candidates || []) {
    if (!validateCandidate(item)) continue;
    const key = `${item.ssid}\u0000${item.label}\u0000${item.relation}`;
    const old = unique.get(key);
    if (!old) unique.set(key, {...item, passIds: [...item.passIds]});
    else {
      old.confidencePct = old.confidencePct === null || item.confidencePct === null ? null : Math.min(old.confidencePct, item.confidencePct);
      if (item.associationConfidence === 'moderate') old.associationConfidence = 'moderate';
      old.needsReview ||= item.needsReview;
      old.passIds = [...new Set([...old.passIds, ...item.passIds])];
    }
  }
  return [...unique.values()];
}

export function explicitCandidatesFromPass(pass, passwordValues = new Set()) {
  const lines = String(pass?.normalizedText || '').normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const passParsed = parseRouterLabel({normalizedText: String(pass?.normalizedText || '')});
  const sensitiveValues = new Set(passwordValues);
  for (const candidate of [...(passParsed.passwordCandidates || []), ...(passParsed.excludedCandidates || [])]) {
    if (typeof candidate?.value === 'string') sensitiveValues.add(candidate.value);
  }
  const extracted = [];
  const passId = PASS_IDS.has(pass?.id) ? pass.id : null;
  const probe = 'WifiConnectDiagnosticProbe7';
  const labelKind = line => {
    // Ask the production parser to classify this isolated label using a fixed,
    // synthetic value. The probe can never enter the returned report.
    const label = String(line).replace(/\s*[:=：＝]\s*$/, '').trim();
    const parsed = parseRouterLabel({normalizedText: `${label}: ${probe}`});
    if ((parsed.ssidCandidates || []).some(item => item.value === probe && canonicalLabel(item.sourceLabel))) return 'ssid';
    if ((parsed.passwordCandidates || []).some(item => item.value === probe)) return 'password';
    return null;
  };
  const withPass = candidate => ({...candidate, reason: candidate.reason, sourcePasses: passId ? [{pass: passId, score:Number.isFinite(pass?.confidence)?pass.confidence:null}] : []});
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index];
    const currentParsed = parseRouterLabel({normalizedText: current});
    extracted.push(...collectCandidates((currentParsed.ssidCandidates || []).map(withPass), sensitiveValues));
    const next = lines[index + 1];
    if (!next) continue;
    // A next-line value is associated only when the production parser recognizes
    // the preceding line as an explicit SSID label. Credential labels are rejected
    // by field type before their following values can become candidates.
    const currentKind = labelKind(current), nextKind = labelKind(next);
    if (currentKind !== 'ssid' || nextKind === 'password') continue;
    const pairParsed = parseRouterLabel({normalizedText: `${current}\n${next}`});
    const nextLineCandidates = (pairParsed.ssidCandidates || [])
      .filter(item => canonicalLabel(item.sourceLabel) && item.value === next)
      .map(item => ({...withPass(item), reason: `${item.sourceLabel}: valor en la línea siguiente`}));
    extracted.push(...collectCandidates(nextLineCandidates, sensitiveValues));
  }
  return mergeSafeCandidates(extracted);
}

/** Compare only like-labelled candidates across independent passes. SSID1 and
 * SSID2 are separate networks; a missing reading is not a disagreement. */
export function compareSsidPasses(passReports = []) {
  const groups = new Map();
  for (const pass of passReports) {
    const occurrenceByLabel = new Map();
    for (const candidate of pass.candidates || []) {
      const label = candidate.label;
      const occurrence = occurrenceByLabel.get(label) || 0;
      occurrenceByLabel.set(label, occurrence + 1);
      const key = `${label}\u0000${occurrence}`;
      const group = groups.get(key) || {label, occurrence, valuesByPass: new Map()};
      group.valuesByPass.set(pass.id, String(candidate.ssid).normalize('NFC'));
      groups.set(key, group);
    }
  }
  const statuses = new Map();
  for (const [key, group] of groups) {
    const values = new Set(group.valuesByPass.values());
    const status = values.size > 1 ? 'disagreement' : group.valuesByPass.size > 1 ? 'agreement' : 'insufficient';
    statuses.set(key, status);
  }
  const status = !groups.size ? 'no_candidate'
    : [...statuses.values()].includes('disagreement') ? 'disagreement'
      : [...statuses.values()].includes('insufficient') ? 'insufficient' : 'agreement';
  return {status, groups, statuses};
}

function safeReasons(analysis, candidates, plan, passComparison) {
  const reasons = new Set();
  const parsed = analysis?.parsed || {};
  if (!candidates.length) reasons.add('no_explicit_ssid_candidate');
  if (candidates.length > 1) reasons.add('multiple_ssid_candidates');
  if (candidates.some(item => item.confidencePct === null || item.confidencePct < 90)) reasons.add('below_auto_confidence_threshold');
  if (passComparison.status === 'disagreement' || (parsed.ssidCandidates || []).some(item => item.ocrVerification?.status === 'disagreement' || item.ocrVerification?.mismatchedPassCount > 0)) reasons.add('ocr_pass_disagreement');
  if (candidates.some(item => item.needsReview) || (parsed.ssidCandidates || []).some(item => item.needsReview && !item.ocrVerification?.status)) reasons.add('candidate_requires_review');
  if ((parsed.ssidCandidates || []).some(item => item.bandPeerConflict)) reasons.add('wifi_band_conflict');
  if (parsed.qrConflicts?.ssid) reasons.add('qr_ssid_conflict');
  const chosen = (parsed.ssidCandidates || []).find(item => item.fieldType === 'ssid' && canonicalLabel(item.sourceLabel));
  if (chosen && detectCrossFieldContamination(parsed, chosen)) reasons.add('field_contamination');
  if (!reasons.size && (plan?.fields || []).includes('ssid')) reasons.add('review_required_by_flow');
  return [...reasons].filter(reason => REVIEW_REASONS.has(reason));
}

export function buildSafeSsidReport(analysis) {
  const parsed = analysis?.parsed || {};
  const passwordValues = new Set([
    ...(parsed.passwordCandidates || []).map(item => item?.value),
    ...(parsed.excludedCandidates || []).map(item => item?.value),
    parsed.password?.value,
    analysis?.qr?.password,
    analysis?.qr?.passwordCandidate?.value
  ].filter(value => typeof value === 'string'));
  const passReports = [];
  const sourcePasses = (analysis?.ocr?.passes || []).filter(pass => PASS_IDS.has(pass?.id));
  const passConfidenceById = new Map(sourcePasses.map(pass => [pass.id, Number.isFinite(pass.confidence) ? pass.confidence : null]));
  const passes = sourcePasses.map(pass => {
    const passParsed = parseRouterLabel({normalizedText: String(pass.normalizedText || '')});
    // Parsing each label/value window separately preserves explicit SSID provenance
    // even if the full-document parser later merges it with a weaker nearby guess.
    const passCandidates = explicitCandidatesFromPass(pass, passwordValues);
    passReports.push({id:pass.id,candidates:passCandidates});
    const unlabelled = (passParsed.ssidCandidates || []).filter(item => item?.fieldType === 'ssid' && !canonicalLabel(item.sourceLabel)).length;
    const confidence = Number(pass.confidence);
    return {
      id: pass.id,
      confidencePct: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : null,
      candidates: passCandidates,
      unlabelledCandidateCount: Math.min(100, unlabelled)
    };
  });
  // Keep the report grounded in label-scoped production-parser results from
  // individual OCR passes. Full-document proximity guesses are never exported.
  const fullCandidates = (parsed.ssidCandidates || []).filter(item => item?.fieldType === 'ssid' && canonicalLabel(item.sourceLabel));
  const passComparison = compareSsidPasses(passReports);
  for (const [key, status] of passComparison.statuses) {
    if (status !== 'disagreement') continue;
    for (const pass of passReports) {
      const occurrenceByLabel = new Map();
      for (const item of pass.candidates) {
        const occurrence = occurrenceByLabel.get(item.label) || 0;
        occurrenceByLabel.set(item.label, occurrence + 1);
        if (`${item.label}\u0000${occurrence}` === key) item.needsReview = true;
      }
    }
  }
  const observedPassCandidates = passReports.flatMap(pass => pass.candidates);
  const mergedCandidates = observedPassCandidates.map(item => {
    const corroborating = fullCandidates.find(candidate => candidate.value === item.ssid && canonicalLabel(candidate.sourceLabel));
    return {...item, needsReview: item.needsReview || Boolean(corroborating?.needsReview || corroborating?.ocrVerification?.status === 'disagreement' || corroborating?.ocrVerification?.mismatchedPassCount>0)};
  });
  const candidates = mergeSafeCandidates(mergedCandidates);
  const plan = buildScanPlan(parsed);
  const requested = Boolean((plan?.fields || []).includes('ssid'));
  const reasons = safeReasons(analysis, candidates, plan, passComparison);
  return {
    format: 'wifi-connect-ssid-diagnostic/v2',
    engine: 'Tesseract.js 7.0.0 / Wifi Connect producción',
    passes,
    candidates,
    passComparison: passComparison.status,
    manualReview: {requested:requested || reasons.length>0, reasons}
  };
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === allowed.length
    && Object.keys(value).every(key => allowed.includes(key));
}

function validateCandidate(item) {
  const keys = ['ssid', 'label', 'relation', 'confidencePct', 'associationConfidence', 'passIds', 'needsReview'];
  if (!exactKeys(item, keys) || !safeSsidValue(item.ssid) || ![...LABELS.values()].includes(item.label)) return false;
  if (!['same_line', 'next_line', 'labelled'].includes(item.relation)) return false;
  if (item.confidencePct !== null && (!Number.isInteger(item.confidencePct) || item.confidencePct < 0 || item.confidencePct > 100)) return false;
  if (!['high','moderate'].includes(item.associationConfidence) || typeof item.needsReview !== 'boolean') return false;
  return Array.isArray(item.passIds) && item.passIds.length <= PASS_IDS.size && item.passIds.every(id => PASS_IDS.has(id));
}

export function validateSafeSsidReport(report) {
  if (!exactKeys(report, ['format', 'engine', 'passes', 'candidates', 'passComparison', 'manualReview'])) return false;
  if (report.format !== 'wifi-connect-ssid-diagnostic/v2' || report.engine !== 'Tesseract.js 7.0.0 / Wifi Connect producción') return false;
  if (!['agreement','disagreement','insufficient','no_candidate'].includes(report.passComparison)) return false;
  if (!Array.isArray(report.candidates) || report.candidates.length > 100 || !report.candidates.every(validateCandidate)) return false;
  if (!Array.isArray(report.passes) || report.passes.length > PASS_IDS.size) return false;
  for (const pass of report.passes) {
    if (!exactKeys(pass, ['id', 'confidencePct', 'candidates', 'unlabelledCandidateCount']) || !PASS_IDS.has(pass.id)) return false;
    if (pass.confidencePct !== null && (!Number.isInteger(pass.confidencePct) || pass.confidencePct < 0 || pass.confidencePct > 100)) return false;
    if (!Number.isInteger(pass.unlabelledCandidateCount) || pass.unlabelledCandidateCount < 0 || pass.unlabelledCandidateCount > 100) return false;
    if (!Array.isArray(pass.candidates) || pass.candidates.length > 100 || !pass.candidates.every(validateCandidate)) return false;
  }
  const review = report.manualReview;
  if (!exactKeys(review, ['requested', 'reasons']) || typeof review.requested !== 'boolean') return false;
  if (!Array.isArray(review.reasons) || review.reasons.length > REVIEW_REASONS.size || !review.reasons.every(reason => REVIEW_REASONS.has(reason))) return false;
  return true;
}

export function serializeSafeSsidReport(report) {
  if (!validateSafeSsidReport(report)) throw new TypeError('El informe no cumple el esquema SSID permitido.');
  const serialized = JSON.stringify(report, null, 2);
  if (serialized.length > 20000) throw new RangeError('El informe supera el límite seguro.');
  return serialized;
}
