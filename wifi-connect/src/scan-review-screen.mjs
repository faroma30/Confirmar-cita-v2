const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** Production review screen shared with integration tests. */
export function renderScanReviewScreen(review){
 const value=review||{};
 const ssid=value.fields?.includes('ssid'),password=value.fields?.includes('password'),ssidOnly=ssid&&!password;
 const proposal=value.candidate?.corrected?'<p class="confidence-warning" role="status">El SSID es una propuesta basada en las etiquetas de banda. Comprueba o corrige el nombre antes de continuar.</p>':'';
 return `<section class="screen scan-review-screen"><h1>${ssidOnly?'Revisa el nombre Wi-Fi':'Revisa un dato'}</h1>${proposal}<form id="scan-review-form" class="card scan-review-card"><input type="hidden" name="ssid" value="${esc(value.network?.ssid||'')}"><input type="hidden" name="password" value="${esc(value.network?.password||'')}">${ssid?`<label class="field"><span>${ssidOnly?'Nombre de red':`Red ${esc(value.network?.band||'Wi-Fi')}`}${value.candidate?.corrected?' · Propuesta':''}</span><input name="ssidReview" maxlength="64" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(value.network?.ssid||'')}"><small>Comprueba que coincide con la etiqueta.</small></label>`:''}${password?`<label class="field"><span>Contraseña</span><input name="passwordReview" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(value.network?.password||'')}"><small>Comprueba que coincide con la etiqueta.</small></label>`:''}<button class="primary full" type="submit">Confirmar</button></form><button class="soft-button full" data-action="repeat-photo">Repetir foto</button></section>`;
}
