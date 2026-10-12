const styles = ["base", "components", "screens", "theme", "visual-system", "home", "navigation"];

export function renderWifiShell(shadowRoot) {
  const links = styles.map(name => `<link rel="stylesheet" href="${new URL(`../css/${name}.css?v=3bd2`, import.meta.url)}">`).join("");
  shadowRoot.innerHTML = `${links}<link rel="stylesheet" href="${new URL("../css/embedded.css?v=3bd2", import.meta.url)}">
    <div class="app-shell">
      <main id="app" tabindex="-1" aria-live="polite"></main>
      <nav class="bottom-nav" aria-label="Navegación Wifi Connect">
        <button data-tab="home" class="active"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3.5 10 8.5-7 8.5 7v10.5h-6v-6h-5v6h-6Z"/></svg></span><small>Inicio</small></button>
        <button data-tab="scan" class="nav-scan" aria-label="Escanear router"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M8 12h8"/></svg></span></button>
        <button data-tab="recent"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9a14 14 0 0 1 18 0M6.5 12.5a8.5 8.5 0 0 1 11 0M10 16a3.2 3.2 0 0 1 4 0M12 20h.01"/></svg></span><small>Redes</small></button>
        <button data-tab="settings"><span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 2.9-.2-.1a1.7 1.7 0 0 0-1.8.3l-.1.1h-3.4l-.1-.2a1.7 1.7 0 0 0-1.5-1.1h-.2l-2.9-1.7.1-.2a1.7 1.7 0 0 0-.3-1.8l-.1-.1v-3.4l.2-.1a1.7 1.7 0 0 0 1.1-1.5v-.2l1.7-2.9.2.1a1.7 1.7 0 0 0 1.8-.3l.1-.1h3.4l.1.2a1.7 1.7 0 0 0 1.5 1.1h.2l2.9 1.7-.1.2a1.7 1.7 0 0 0 .3 1.8l.1.1V15z"/></svg></span><small>Ajustes</small></button>
      </nav>
      <div class="privacy-pill">🔒 Tus datos permanecen en este dispositivo</div>
    </div>
    <dialog id="modal" class="modal"></dialog><div id="toast" class="toast" role="status"></div>`;
}
