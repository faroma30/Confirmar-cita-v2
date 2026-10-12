import {operatorProfiles} from './operator-profiles/index.js';

const norm = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function detectOperator(input = {}) {
  const rawText = input?.rawText ?? '';
  const text = norm(input?.normalizedText !== undefined ? input.normalizedText : rawText);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const candidates = [];
  for (const profile of operatorProfiles) {
    const evidence = [];
    let score = 0;
    for (const identifier of profile.identifiers) {
      const matchingLine = lines.find(line => identifier.pattern.test(line));
      if (!matchingLine) continue;
      const exactStandalone = norm(matchingLine).trim().toLowerCase() === norm(identifier.signal).trim().toLowerCase() && !identifier.fuzzy;
      const delta = identifier.fuzzy ? 38 : exactStandalone ? 90 : 62;
      score = Math.max(score, delta);
      const why = identifier.fuzzy ? 'Coincidencia aproximada de marca compatible con confusión OCR' : exactStandalone ? `Marca explícita ${identifier.signal}` : `Señal de marca ${identifier.signal} en el texto`;
      if (!evidence.some(item => item.signal === identifier.signal)) evidence.push({signal:identifier.signal, reason:why, strength:delta});
    }
    if (score) candidates.push({id:profile.id,name:profile.name,family:profile.family,score,evidence});
  }
  candidates.sort((a,b)=>b.score-a.score);
  const tied = candidates.length > 1 && candidates[0].score === candidates[1].score;
  const strongAmbiguity = candidates.length > 1 && candidates[0].score - candidates[1].score < 20;
  const detected = candidates.length && candidates[0].score >= 50 && !tied && !strongAmbiguity ? candidates[0] : null;
  const confidence = !detected || detected.score < 50 ? 'low' : detected.score >= 85 ? 'high' : 'medium';
  return {
    detected: detected ? {id:detected.id,name:detected.name,family:detected.family} : null,
    confidence,
    evidence: detected ? detected.evidence.map(item=>item.reason) : [],
    candidates,
    ambiguous: Boolean(candidates.length > 1 && !detected),
    version: '1.0'
  };
}
