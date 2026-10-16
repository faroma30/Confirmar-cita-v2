import {validateSafeSsidReport} from './ssid-diagnostic-report.js?v=3ca1';

const REASONS={
  no_explicit_ssid_candidate:'No se encontró un valor asociado a una etiqueta SSID.',
  multiple_ssid_candidates:'Se detectó más de un candidato SSID.',
  below_auto_confidence_threshold:'La confianza del candidato es inferior al umbral automático.',
  ocr_pass_disagreement:'Las pasadas OCR discrepan en el SSID.',
  candidate_requires_review:'El candidato está marcado para revisión.',
  wifi_band_conflict:'Existe conflicto entre bandas Wi-Fi.',
  qr_ssid_conflict:'El QR y el texto de etiqueta discrepan en el SSID.',
  field_contamination:'Se detectó posible mezcla entre campos.',
  review_required_by_flow:'El flujo solicita revisión manual.'
};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function renderSsidDiagnosticScreen(report){
  if(!validateSafeSsidReport(report))return '<section class="screen"><h1>Diagnóstico SSID no disponible</h1><p>El informe no supera la validación de privacidad.</p><button class="primary full" data-action="ssid-diagnostic-repeat">Repetir fotografía</button></section>';
  const passes=report.passes.map(pass=>`<article class="card"><h2>${escapeHtml(pass.id)} · confianza de pasada ${pass.confidencePct===null?'no disponible':`${pass.confidencePct}%`}</h2>${pass.candidates.length?`<ul>${pass.candidates.map(item=>`<li><strong>${escapeHtml(item.ssid)}</strong><br><small>Etiqueta ${escapeHtml(item.label)} · ${item.relation==='next_line'?'valor en línea siguiente':item.relation==='same_line'?'valor en misma línea':'valor etiquetado'} · OCR ${item.confidencePct===null?'no disponible':`${item.confidencePct}%`} · asociación ${item.associationConfidence==='moderate'?'moderada':'directa'}${item.needsReview?' · requiere revisión':''}</small></li>`).join('')}</ul>`:'<p class="muted">Sin candidato SSID asociado a etiqueta en esta pasada.</p>'}</article>`).join('');
  const reasons=report.manualReview.reasons.map(reason=>REASONS[reason]).filter(Boolean);
  const comparison={agreement:'Acuerdo: varias pasadas reconocen el mismo SSID.',disagreement:'Desacuerdo: pasadas con la misma etiqueta reconocen valores incompatibles.',insufficient:'Evidencia insuficiente: no hay dos lecturas comparables para confirmar el candidato.',no_candidate:'Sin candidato SSID etiquetado.'}[report.passComparison];
  return `<section class="screen"><div class="eyebrow">Diagnóstico local · solo SSID</div><h1 class="page-heading">Lecturas de nombre Wi-Fi</h1><p class="muted">Se muestran únicamente valores asociados a etiquetas SSID. No se incluye fotografía, texto OCR ni ningún campo de contraseña.</p>${passes||'<p class="muted">No se generaron pasadas OCR.</p>'}<section class="card"><h2>Comparación</h2><p>${comparison}</p><p><strong>Revisión manual:</strong> ${report.manualReview.requested?'Sí':'No'}</p>${reasons.length?`<ul>${reasons.map(reason=>`<li>${escapeHtml(reason)}</li>`).join('')}</ul>`:'<p class="muted">No se registró motivo adicional de revisión.</p>'}</section><div class="button-row"><button class="secondary" data-action="ssid-diagnostic-copy">Copiar informe SSID</button><button class="soft-button" data-action="ssid-diagnostic-repeat">Repetir fotografía</button></div><button class="primary full" data-action="ssid-diagnostic-finish">Finalizar diagnóstico</button></section>`;
}
