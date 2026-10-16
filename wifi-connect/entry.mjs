let qrScriptPromise;
async function ensureQrGenerator() {
  if (typeof window.qrcode === "function") return;
  qrScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("./vendor/qrcode-generator.js?v=3cb1", import.meta.url).href;
    script.onload = () => typeof window.qrcode === "function" ? resolve() : reject(new Error("QR no disponible"));
    script.onerror = () => reject(new Error("No se pudo cargar el generador QR"));
    document.head.append(script);
  });
  return qrScriptPromise;
}

export async function mountWifiConnect(host, userId, options = {}) {
  await ensureQrGenerator();
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const { mountWifiConnect: mountOriginal } = await import("./src/app.js?v=3cb1");
  return mountOriginal(shadowRoot, userId, options);
}

