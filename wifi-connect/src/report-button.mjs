const REPORTABLE_ROUTES = new Set([
  "home",
  "ocr-result",
  "parser-review",
  "ocr-error",
  "band-choice",
  "scan-review",
]);

export function ensureWifiReportButton(root, route, onReport, documentRef = globalThis.document) {
  if (typeof onReport !== "function" || !REPORTABLE_ROUTES.has(route)) return null;
  const screen = root.querySelector(".screen");
  if (!screen) return null;
  const existing = screen.querySelector('[data-action="report-wifi-ocr"]');
  if (existing) return existing;

  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = "soft-button ocr-report-button";
  button.dataset.action = "report-wifi-ocr";
  button.setAttribute("aria-label", "Reportar etiqueta WiFi con error de reconocimiento");
  button.textContent = "⚑  Reportar etiqueta";
  button.addEventListener("click", onReport);
  screen.append(button);
  return button;
}
