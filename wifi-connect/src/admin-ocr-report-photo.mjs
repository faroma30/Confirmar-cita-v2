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
      invalidate("La carga de fotografías autorizadas no está disponible para esta cuenta. Comprueba el consentimiento y tus permisos.");
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
          onStatus("El reporte no tiene una fotografía autorizada disponible.");
          return false;
        }
        publishImage(image);
        onStatus("");
        return true;
      })
      .catch(() => {
        if (request !== generation || currentReportId !== reportId || !isCurrent(reportId)) return false;
        publishImage(null);
        onStatus("No se pudo preparar la fotografía autorizada. Comprueba el consentimiento y tus permisos.");
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
    let ok = false;
    if (currentReportId === reportId && currentImage) {
      ok = true;
    } else {
      ok = await load(reportId);
    }
    if (!ok || currentReportId !== reportId || !isCurrent(reportId)) return null;
    return currentImage;
  }

  return { load, invalidate, setManual, waitForSelectedPhoto };
}
