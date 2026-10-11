(() => {
  window.__CC_APP_READY__ = false;
  let reported = false;

  function showInitializationError() {
    if (window.__CC_APP_READY__) return;
    document.getElementById("startupStatus")?.classList.add("hidden");
    ["authDisabled", "authPanel", "activationPanel", "workspace", "adminPanel", "masterPanel", "appointmentsPanel"]
      .forEach((id) => document.getElementById(id)?.classList.add("hidden"));
    document.getElementById("startupError")?.classList.remove("hidden");
    if (!reported) {
      reported = true;
      console.error("[Confirmar Citas] Error de inicialización (CC_INIT_FAILED)");
    }
  }

  window.__CC_SHOW_INIT_ERROR__ = showInitializationError;
  window.addEventListener("error", (event) => {
    const target = event.target;
    const scriptLoadFailure = target instanceof HTMLScriptElement;
    const runtimeFailure = event instanceof ErrorEvent && Boolean(event.message);
    if (scriptLoadFailure || runtimeFailure) showInitializationError();
  }, true);
  window.addEventListener("unhandledrejection", () => showInitializationError());
  document.getElementById("retryStartup")?.addEventListener("click", () => window.location.reload());
})();
