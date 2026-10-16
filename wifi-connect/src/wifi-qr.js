import { decodeWifiQrPayloadsFromImageCore } from './wifi-qr-core.js?v=3bv1';
export { parseWifiQrPayload } from './wifi-qr-core.js?v=3bv1';

export const QR_STAGE_TIMEOUT_MS = 15000;
const QR_WORKER_STAGES = new Set(['image-decode', 'barcode-detect', 'barcode-complete', 'jsqr-full-frame', 'jsqr-region']);

function abortError() {
  const error = new Error('Análisis cancelado.');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs the whole QR pipeline in a disposable worker. A stuck native detector or
 * CPU-bound jsQR pass can then be terminated before OCR starts.
 */
export async function decodeWifiQrPayloadsFromImage(blob, {
  signal,
  timeoutMs = QR_STAGE_TIMEOUT_MS,
  workerFactory = () => new Worker(new URL('./wifi-qr-worker.js?v=3bv1', import.meta.url), { type: 'module' }),
  // Dependency injection keeps deterministic parser/pixel tests on the same
  // decoder implementation without requiring browser workers in Node.
  barcodeDetector,
  canvasFactory,
  fallback,
  maxCodes,
  onStage,
} = {}) {
  if (barcodeDetector !== undefined || canvasFactory !== undefined || fallback !== undefined || maxCodes !== undefined) {
    return decodeWifiQrPayloadsFromImageCore(blob, { signal, barcodeDetector, canvasFactory, fallback, maxCodes, onStage });
  }
  if (!blob || !String(blob.type || '').startsWith('image/') || !blob.size) {
    return { status: 'unavailable', reason: 'invalid-image', networks: [], elapsedMs: 0 };
  }
  if (signal?.aborted) throw abortError();
  let worker;
  const started = globalThis.performance?.now?.() ?? Date.now();
  try {
    worker = workerFactory();
  } catch {
    return { status: 'unavailable', reason: 'worker-unavailable', networks: [], elapsedMs: 0 };
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    let workerStage = 'worker-start';
    const finish = (result, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { worker.terminate(); } catch { /* terminate best effort */ }
      if (error) reject(error);
      else resolve({ ...result, elapsedMs: Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - started)) });
    };
    const onAbort = () => finish(null, abortError());
    const timer = setTimeout(() => finish({ status: 'unavailable', reason: 'timeout', blockedStage: workerStage, networks: [] }), Math.max(1, timeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = event => {
      const data = event?.data;
      if (data?.type === 'stage' && QR_WORKER_STAGES.has(data.stage)) { workerStage = data.stage; return; }
      if (data?.type === 'result' && data.result && typeof data.result === 'object') finish(data.result);
      else finish({ status: 'unavailable', reason: 'worker-error', networks: [] });
    };
    worker.onerror = () => finish({ status: 'unavailable', reason: 'worker-error', networks: [] });
    worker.onmessageerror = () => finish({ status: 'unavailable', reason: 'worker-error', networks: [] });
    try { worker.postMessage({ type: 'decode', blob, maxCodes: Number.isInteger(maxCodes) ? maxCodes : 6 }); }
    catch { finish({ status: 'unavailable', reason: 'worker-error', networks: [] }); }
  });
}

export async function decodeQrPayloadFromImage(blob, options = {}) {
  return decodeWifiQrPayloadsFromImage(blob, options);
}
