export function availableBuild(document, base) {
  const build = document.querySelector('meta[name="app-build"]')?.content;
  if (!/^[a-z0-9]{1,32}$/.test(build ?? "")) return null;
  const entry = document.querySelector('script[type="module"][src^="./app.js"]')?.getAttribute("src");
  if (!entry) return null;
  const url = new URL(entry, base);
  return url.pathname === new URL("./app.js", base).pathname
    && url.origin === new URL(base).origin && url.searchParams.get("v") === build ? build : null;
}

export function setupReleaseUpdate(build, document, window) {
  const badge = document.getElementById("runningBuild");
  const button = document.getElementById("applyReleaseUpdate");
  const status = document.getElementById("releaseUpdateStatus");
  const panel = document.getElementById("releaseUpdater");
  const base = window.location.href;
  const matched = availableBuild(document, base) === build;
  if (matched) badge.textContent = " · v" + build;
  let target;
  let checkedAt = -Infinity;
  let pending;
  async function check() {
    if (pending || Date.now() - checkedAt < 60_000) return;
    checkedAt = Date.now();
    pending = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const index = new URL("./index.html", base);
      index.searchParams.set("_cc_check", String(checkedAt));
      const response = await window.fetch(index, { cache: "no-store", signal: controller.signal });
      if (!response.ok) return;
      const remote = availableBuild(new DOMParser().parseFromString(await response.text(), "text/html"), base);
      if (remote && (!matched || remote !== build)) {
        target = remote;
        panel.hidden = false;
        button.hidden = false;
        status.textContent = "Hay una versión disponible. Guarda los cambios abiertos antes de actualizar.";
      } else if (remote) {
        target = null;
        panel.hidden = true;
        button.hidden = true;
        status.textContent = "";
      }
    } catch { /* An unavailable update check must never affect the PWA. */ }
    finally { window.clearTimeout(timeout); pending = false; }
  }

  button.addEventListener("click", () => {
    if (!target || !window.confirm("La aplicación se recargará. Guarda cualquier formulario abierto antes de continuar.")) return;
    const url = new URL(window.location.href);
    url.searchParams.set("v", target);
    url.searchParams.set("_cc_reload", Date.now().toString());
    window.location.replace(url.href);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  window.addEventListener("pageshow", () => void check());
  void check();
  return matched;
}
