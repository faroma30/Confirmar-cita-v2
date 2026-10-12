import {isDebugAccessAllowed} from './config.js';
export const isLabMode=(locationLike,allowedHosts)=>isDebugAccessAllowed(locationLike,allowedHosts);

export function characterDifferences(actual = '', expected = '') {
  const a = Array.from(String(actual));
  const e = Array.from(String(expected));
  const rows = [];
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) rows.push({ position: i + 1, actual: a[i] ?? '', expected: e[i] ?? '' });
  }
  return rows;
}

function sameText(a, b) { return String(a ?? '').normalize('NFC') === String(b ?? '').normalize('NFC'); }
export function compareLabValues({ detected = {}, expected = {} } = {}) {
  const compare = (a, b) => b == null || b === '' ? { detected: a ?? null, expected: b ?? null, matches: null, differences: [] } : {
    detected: a ?? null, expected: b, matches: sameText(a, b), differences: characterDifferences(a ?? '', b),
  };
  return {
    ssid: compare(detected.ssid, expected.ssid), password: compare(detected.password, expected.password),
    security: compare(detected.security, expected.security), operator: compare(detected.operator, expected.operator),
  };
}

function simpleCandidate(candidate) {
  return { value: candidate.value, score: candidate.score, reason: candidate.reason, sourceLine: candidate.sourceLine };
}
function redactText(text, secrets) {
  let output = String(text ?? '');
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

export function buildLabDiagnostic({ ocr = {}, operatorDetection = {}, parser = {}, expected = {}, classification = '', observations = '', hidePassword = false, failureCategories = [], timestamp = new Date().toISOString() } = {}) {
  const ssid = parser.ssidCandidates || [];
  const passwords = parser.passwordCandidates || [];
  const detected = {
    ssid: ssid[0]?.value ?? null,
    password: passwords[0]?.value ?? null,
    security: parser.security?.value ?? null,
    operator: operatorDetection.detected?.id ?? null,
  };
  const secrets = hidePassword ? [expected.password, detected.password, ...passwords.map(item => item.value)] : [];
  const chosenExpected = { ...expected };
  if (hidePassword && chosenExpected.password) chosenExpected.password = '[REDACTED]';
  const cleanCandidates = items => items.map(item => ({ ...simpleCandidate(item), value: hidePassword && item.value ? '[REDACTED]' : item.value, reason: redactText(item.reason, secrets), sourceLine: redactText(item.sourceLine, secrets) }));
  const parserOut = {
    ssidCandidates: cleanCandidates(ssid), passwordCandidates: cleanCandidates(passwords),
    security: parser.security ? { value: parser.security.value, inferred: !!parser.security.inferred, evidence: parser.security.reason ?? parser.security.evidence ?? null } : null,
    appliedProfiles: parser.appliedProfiles ?? [], profileDiagnostics: parser.profileDiagnostics ?? [],
    inputText: redactText(parser.inputText ?? ocr.normalizedText ?? '', secrets),
  };
  const cleanOperator = operatorDetection.detected ? { id: operatorDetection.detected.id, name: operatorDetection.detected.name, family: operatorDetection.detected.family ?? null, confidence: operatorDetection.confidence ?? null, evidence: operatorDetection.evidence ?? operatorDetection.detected.evidence ?? [] } : { detected: null, confidence: operatorDetection.confidence ?? null, evidence: operatorDetection.evidence ?? [], candidates: operatorDetection.candidates ?? [] };
  const rawText = redactText(ocr.rawText, secrets);
  const normalizedText = redactText(ocr.normalizedText, secrets);
  const expectedOut = { ...chosenExpected };
  const comparison = compareLabValues({ detected: { ...detected, password: hidePassword && detected.password ? '[REDACTED]' : detected.password }, expected: expectedOut });
  if (hidePassword && expected.password) comparison.password = { detected: '[REDACTED]', expected: '[REDACTED]', matches: sameText(detected.password, expected.password), differences: [] };
  return {
    version: 1, timestamp,
    image: { width: ocr.image?.sourceWidth ?? ocr.image?.width ?? null, height: ocr.image?.sourceHeight ?? ocr.image?.height ?? null, processedWidth: ocr.image?.processedWidth ?? ocr.image?.width ?? null, processedHeight: ocr.image?.processedHeight ?? ocr.image?.height ?? null, orientationNormalized: ocr.image?.orientationNormalized ?? null, originalBytes: ocr.image?.originalBytes ?? null, processedBytes: ocr.image?.processedBytes ?? null },
    ocr: { engine: ocr.engine ?? 'Tesseract.js', languages: ocr.languages ?? [], durationMs: ocr.durationMs ?? null, confidence: ocr.confidence ?? null, rawText, normalizedText },
    operatorDetection: cleanOperator,
    parser: parserOut,
    expected: expectedOut,
    comparison,
    classification: classification || null, failureCategories: [...failureCategories], observations: observations || '',
  };
}

export function buildLabText(diagnostic) {
  const c = diagnostic.comparison || {};
  const mark = value => value?.matches == null ? 'sin comparar' : value.matches ? 'sí' : 'no';
  const op = diagnostic.operatorDetection?.detected?.name || diagnostic.operatorDetection?.detected?.id || 'No identificado';
  const ssids = diagnostic.parser?.ssidCandidates || [], passwords = diagnostic.parser?.passwordCandidates || [];
  return [
    'WIFI CONNECT · DIAGNÓSTICO DE ETIQUETA', `Fecha: ${diagnostic.timestamp}`,
    `Operador detectado: ${op}`, `Operador correcto: ${diagnostic.expected?.operator || '—'} · coincide: ${mark(c.operator)}`,
    '', 'OCR', diagnostic.ocr?.rawText || '(sin texto)', '',
    `SSID detectado: ${ssids[0]?.value ?? '—'}`, `SSID correcto: ${diagnostic.expected?.ssid || '—'} · coincide: ${mark(c.ssid)}`,
    `Contraseña detectada: ${passwords[0]?.value ?? '—'}`, `Contraseña correcta: ${diagnostic.expected?.password || '—'} · coincide: ${mark(c.password)}`,
    `Seguridad detectada: ${diagnostic.parser?.security?.value ?? '—'}`, `Seguridad correcta: ${diagnostic.expected?.security || '—'} · coincide: ${mark(c.security)}`,
    '', 'CANDIDATOS SSID', ...ssids.map(x => `- ${x.value} · score ${x.score} · ${x.reason} · ${x.sourceLine}`),
    'CANDIDATOS CONTRASEÑA', ...passwords.map(x => `- ${x.value} · score ${x.score} · ${x.reason} · ${x.sourceLine}`),
    '', `Resultado: ${diagnostic.classification || '—'}`, `Observaciones: ${diagnostic.observations || '—'}`,
  ].join('\n');
}
