import { esc } from "./utils.js";

const PROBLEMS = [
  ["label_not_recognized", "No reconoce la etiqueta"],
  ["ssid_incorrect", "SSID incorrecto"],
  ["password_incorrect", "Contraseña incorrecta"],
  ["ssid_password_confused", "Confunde SSID y contraseña"],
  ["missing_5ghz", "No detecta la red de 5 GHz"],
  ["other", "Otro problema"],
];

export function renderWifiReportScreen({
  problem = "other", description = "", status = "", photoUrl = "",
  hasPhoto = false, hasSsid = false, ssidCandidate = "", success = false,
  photoConsent = false, shareSsid = false, submitting = false,
} = {}) {
  const heading = '<div class="wifi-report-heading"><button class="wifi-report-back" type="button" data-action="wifi-report-back">‹ <span>Volver al escáner</span></button><h1>Reportar etiqueta WiFi</h1></div>';
  if (success) return '<section class="screen wifi-report-screen" data-screen="wifi-report">' + heading
    + '<div class="wifi-report-card wifi-report-success" role="status"><span class="wifi-report-success-mark" aria-hidden="true">✓</span><p>Etiqueta reportada correctamente. El Administrador podrá revisarla.</p><button class="wifi-report-primary" type="button" data-action="wifi-report-back">Volver al escáner</button></div></section>';
  const options = PROBLEMS.map(([value, label]) => '<option value="' + value + '"' + (problem === value ? " selected" : "") + '>' + label + '</option>').join("");
  const photoMarkup = hasPhoto && photoUrl
    ? '<div class="wifi-report-preview"><img src="' + esc(photoUrl) + '" alt="Vista previa de la etiqueta seleccionada"><button type="button" data-action="wifi-report-remove-photo">Quitar fotografía</button></div><label class="wifi-report-consent"><input name="photoConsent" type="checkbox"' + (photoConsent ? " checked" : "") + '><span>Autorizo compartir esta fotografía con el Administrador. La imagen puede incluir datos de acceso del router.</span></label>'
    : "";
  const ssidMarkup = hasSsid
    ? '<label class="wifi-report-consent wifi-report-ssid-consent"><input name="shareSsid" type="checkbox"' + (shareSsid ? " checked" : "") + '><span>Autorizo compartir el SSID reconocido <code>' + esc(ssidCandidate) + '</code> con el Administrador.</span></label>'
    : "";
  return '<section class="screen wifi-report-screen" data-screen="wifi-report">' + heading
    + '<form id="wifi-report-form" class="wifi-report-card">'
    + '<label class="wifi-report-field"><span>Tipo de problema</span><select name="problem">' + options + '</select></label>'
    + '<label class="wifi-report-field"><span>Descripción <small>(opcional)</small></span><textarea name="description" maxlength="1000" rows="4" placeholder="Describe qué dato se reconoció incorrectamente. No escribas contraseñas.">' + esc(description) + '</textarea></label>'
    + '<div class="wifi-report-field"><span>Fotografía <small>(opcional)</small></span><label class="wifi-report-file">Elegir fotografía<input name="photo" type="file" accept="image/png,image/jpeg,image/webp"></label>' + photoMarkup + '</div>'
    + ssidMarkup
    + '<p class="wifi-report-privacy">No se adjunta el texto OCR completo ni contraseñas WiFi o administrativas.</p>'
    + '<p class="wifi-report-status" role="status" aria-live="polite">' + esc(status) + '</p>'
    + '<div class="wifi-report-actions"><button class="wifi-report-primary" type="submit"' + (submitting ? " disabled" : "") + '>' + (submitting ? "Enviando…" : "Enviar reporte") + '</button><button class="wifi-report-secondary" type="button" data-action="wifi-report-back">Cancelar</button></div></form></section>';
}
