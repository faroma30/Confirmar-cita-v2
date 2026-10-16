import { decodeWifiQrPayloadsFromImageCore } from './wifi-qr-core.js?v=3bv1';

function transferableResult(result) {
  const attempts = (result?.attempts ?? []).slice(0, 40).map(item => ({
    engine: item.engine === 'BarcodeDetector' ? 'BarcodeDetector' : 'jsQR',
    durationMs: Number.isFinite(item.durationMs) ? Math.max(0, Math.round(item.durationMs)) : null,
    found: Boolean(item.found),
    ...(Number.isInteger(item.count) ? { count: Math.max(0, Math.min(20, item.count)) } : {}),
    ...(Number.isInteger(item.width) ? { width: Math.max(0, Math.min(10000, item.width)) } : {}),
    ...(Number.isInteger(item.height) ? { height: Math.max(0, Math.min(10000, item.height)) } : {}),
    ...(['left', 'right', 'top', 'bottom'].includes(item.region) ? { region: item.region } : {}),
  }));
  const networks = (result?.networks ?? []).slice(0, 6).map(item => ({
    type: 'wifi', ssid: String(item.ssid || ''), password: String(item.password || ''),
    security: String(item.security || ''), hidden: Boolean(item.hidden), source: String(item.source || result.source || ''),
  }));
  const primary = networks[0];
  return {
    status: ['wifi', 'ignored', 'not-found', 'unavailable'].includes(result?.status) ? result.status : 'unavailable',
    ...(typeof result?.reason === 'string' ? { reason: result.reason } : {}),
    ...(typeof result?.source === 'string' ? { source: result.source } : {}),
    networks, attempts,
    ...(primary ? { ...primary } : {}),
  };
}

self.onmessage = async event => {
  if (event?.data?.type !== 'decode') return;
  try {
    const result = await decodeWifiQrPayloadsFromImageCore(event.data.blob, {
      maxCodes: Number.isInteger(event.data.maxCodes) ? Math.min(6, Math.max(1, event.data.maxCodes)) : 6,
      canvasFactory: () => new OffscreenCanvas(1, 1),
      onStage: stage => self.postMessage({ type: 'stage', stage }),
    });
    self.postMessage({ type: 'result', result: transferableResult(result) });
  } catch {
    // Never send image text or QR payloads as worker error details.
    self.postMessage({ type: 'result', result: { status: 'unavailable', reason: 'worker-error', networks: [], attempts: [] } });
  }
};
