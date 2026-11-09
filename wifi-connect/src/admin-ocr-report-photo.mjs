const PHOTO_MESSAGES = Object.freeze({
  PHOTO_NOT_FOUND: "Este reporte no tiene una fotografía adjunta. Selecciona otro reporte o carga una fotografía manual.",
  CONSENT_INVALID: "El consentimiento para usar esta fotografía no está vigente. No se descargó la imagen.",
  ACCESS_DENIED: "El servidor denegó el acceso a la fotografía. Comprueba tu sesión o tus permisos.",
  NETWORK_ERROR: "No se pudo conectar con el servidor. Comprueba la conexión y pulsa «Usar fotografía del reporte» para reintentar.",
  RESPONSE_EMPTY: "El servidor no devolvió la fotografía. Pulsa «Usar fotografía del reporte» para reintentar.",
  FORMAT_UNSUPPORTED: "La fotografía recibida tiene un formato no compatible o está dañada.",
  CONVERSION_FAILED: "No se pudo convertir la fotografía para analizarla. Puedes reintentar o cargar una imagen manual.",
  PHOTO_TOO_LARGE: "La fotografía supera el tamaño máximo permitido.",
  METADATA_LOAD_FAILED: "No se pudieron comprobar los metadatos del reporte. Pulsa «Usar fotografía del reporte» para reintentar.",
  ATTACHMENT_LOAD_FAILED: "No se pudo descargar la fotografía. Comprueba la conexión y pulsa «Usar fotografía del reporte» para reintentar.",
  REPORT_LIST_FAILED: "No se pudieron consultar los reportes autorizados. Comprueba la conexión e inténtalo de nuevo."
});

export function adminOcrPhotoErrorMessage(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return PHOTO_MESSAGES[code] || "No se pudo preparar la fotografía autorizada. Puedes reintentar la carga o elegir una fotografía manual.";
}

export function updateAdminOcrPhotoStatus(element, status, image) {
  if (!element) return;
  element.textContent = status || (image ? "Fotografía preparada en memoria." : "Selecciona una fotografía para analizar.");
}

export function createAdminOcrReportPhotoLoader({ loadPhoto, isCurrent, onImage, onStatus }) {
  let generation = 0;
  let pending = null;
  let currentReportId = "";
  let currentImage = null;

  function publishImage(image) {
    currentImage = image;
    onImage(image);
  }

  function invalidate(status = "") {
    generation += 1;
    pending = null;
    currentReportId = "";
    publishImage(null);
    onStatus(status);
  }

  function load(reportId) {
    if (!reportId || !isCurrent(reportId)) {
      invalidate("Selecciona un reporte con fotografía autorizada.");
      return Promise.resolve(false);
    }
    if (typeof loadPhoto !== "function") {
      invalidate("La carga de fotografías autorizadas no está disponible para esta cuenta.");
      return Promise.resolve(false);
    }
    if (pending?.reportId === reportId && pending.generation === generation) return pending.promise;

    const request = ++generation;
    currentReportId = reportId;
    publishImage(null);
    onStatus("Cargando fotografía autorizada…");
    const promise = Promise.resolve()
      .then(() => loadPhoto(reportId))
      .then(image => {
        if (request !== generation || currentReportId !== reportId || !isCurrent(reportId)) return false;
        if (!image) {
          publishImage(null);
          onStatus(PHOTO_MESSAGES.RESPONSE_EMPTY);
          return false;
        }
        publishImage(image);
        onStatus("");
        return true;
      })
      .catch(error => {
        if (request !== generation || currentReportId !== reportId || !isCurrent(reportId)) return false;
        publishImage(null);
        onStatus(adminOcrPhotoErrorMessage(error));
        return false;
      })
      .finally(() => {
        if (pending?.generation === request) pending = null;
      });
    pending = { reportId, generation: request, promise };
    return promise;
  }

  function setManual(image) {
    generation += 1;
    pending = null;
    currentReportId = "";
    publishImage(image || null);
    onStatus(image ? "Fotografía manual preparada en memoria." : "Selecciona una fotografía para analizar.");
  }

  async function waitForSelectedPhoto(reportId) {
    if (!reportId) return currentReportId === "" ? currentImage : null;
    if (!isCurrent(reportId)) return null;
    const ok = currentReportId === reportId && currentImage ? true : await load(reportId);
    if (!ok || currentReportId !== reportId || !isCurrent(reportId)) return null;
    return currentImage;
  }

  return { load, invalidate, setManual, waitForSelectedPhoto };
}
