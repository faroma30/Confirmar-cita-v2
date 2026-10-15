import jsQR from '../vendor/jsQR.js';

const escapeField = value => String(value || '').replace(/\\(.)/gs, '$1');

export function parseWifiQrPayload(payload) {
  const text = String(payload || '').trim();
  if (!/^WIFI:/i.test(text)) return null;
  const fields = {};
  let key = '', value = '', readingKey = true, escaped = false;
  const commit = () => {
    if (key) fields[key.toUpperCase()] = escapeField(value);
    key = ''; value = ''; readingKey = true;
  };
  for (let index = 5; index < text.length; index++) {
    const char = text[index];
    if (escaped) { (readingKey ? key += char : value += char); escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (readingKey && char === ':') { readingKey = false; continue; }
    if (char === ';') { commit(); if (text[index + 1] === ';') break; continue; }
    if (readingKey) key += char; else value += char;
  }
  if (key || value) commit();
  const ssid = fields.S || '', securityToken = String(fields.T || '').trim().toUpperCase();
  if (!ssid) return null;
  let security;
  if (!securityToken || /^(?:NOPASS|NONE|OPEN)$/.test(securityToken)) security = 'Sin contraseña';
  else if (/^(?:WPA|WPA2|WPA3|WPA\/WPA2|WPA\/WPA2\/WPA3|SAE)$/.test(securityToken)) security = securityToken === 'WPA3' || securityToken === 'SAE' ? 'WPA3' : 'WPA/WPA2';
  else if (securityToken === 'WEP') security = 'WEP';
  else return null;
  const password = fields.P || '';
  if (security !== 'Sin contraseña' && !password) return null;
  return { type: 'wifi', ssid, password, security, hidden: /^(?:true|1|yes)$/i.test(fields.H || '') };
}

async function imageFromBlob(blob) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try { return { image: await createImageBitmap(blob, { imageOrientation: 'from-image' }), close: true }; } catch {}
  }
  if (typeof globalThis.Image !== 'function' || !globalThis.URL?.createObjectURL) throw new Error('Image decoding is unavailable');
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url;
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    return { image, close: false };
  } finally { URL.revokeObjectURL(url); }
}

function validImage(blob) { return Boolean(blob && String(blob.type || '').startsWith('image/')); }
function checkAbort(signal) {
  if (signal?.aborted) { const error = new Error('Análisis cancelado.'); error.name = 'AbortError'; throw error; }
}
function dedupeNetworks(networks) {
  const found = new Set();
  return networks.filter(network => {
    const key = `${network.ssid}\u0000${network.password}\u0000${network.security}\u0000${network.hidden}`;
    if (found.has(key)) return false;
    found.add(key); return true;
  });
}
function addWifiPayload(networks, payload, source, location = null) {
  const wifi = parseWifiQrPayload(payload);
  if (!wifi) return false;
  networks.push({ ...wifi, source, location });
  return true;
}
function maskQr(pixels, width, height, location) {
  const points = location && ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner']
    .map(key => location[key]).filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (!points?.length) return false;
  const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y))));
  const right = Math.min(width, Math.ceil(Math.max(...points.map(point => point.x))));
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map(point => point.y))));
  const pad = Math.max(8, Math.ceil(Math.max(right - left, bottom - top) * 0.14));
  const x1 = Math.max(0, left - pad), y1 = Math.max(0, top - pad);
  const x2 = Math.min(width, right + pad), y2 = Math.min(height, bottom + pad);
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255;
    pixels[offset + 3] = 255;
  }
  return true;
}

function scanRegion(image, region, scale, canvasFactory, fallback, signal, networks, attempts, maxCodes) {
  let canvas;
  const sourceWidth=region.width,sourceHeight=region.height;
  const targetWidth=Math.max(1,Math.round(sourceWidth*scale)),targetHeight=Math.max(1,Math.round(sourceHeight*scale));
  try {
    checkAbort(signal);
    canvas=canvasFactory();canvas.width=targetWidth;canvas.height=targetHeight;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)return false;
    context.drawImage(image,region.x,region.y,sourceWidth,sourceHeight,0,0,targetWidth,targetHeight);
    const pixels=new Uint8ClampedArray(context.getImageData(0,0,targetWidth,targetHeight).data);
    for(let hitCount=0;hitCount<maxCodes;hitCount++){
      checkAbort(signal);
      const started=globalThis.performance?.now?.()??Date.now();
      const hit=fallback(pixels,targetWidth,targetHeight,{inversionAttempts:'attemptBoth'});
      const ended=globalThis.performance?.now?.()??Date.now();
      attempts.push({width:targetWidth,height:targetHeight,durationMs:Math.max(0,Math.round(ended-started)),found:Boolean(hit?.data),region:region.id});
      if(!hit?.data)break;
      addWifiPayload(networks,hit.data,'jsQR',hit.location||null);
      if(!maskQr(pixels,targetWidth,targetHeight,hit.location||null))break;
    }
    return true;
  } finally {
    if(canvas){canvas.width=0;canvas.height=0;}
  }
}

/**
 * Reads all Wi-Fi QR codes present in the image. Credentials remain in memory
 * only; callers must not log this result. Native BarcodeDetector is preferred,
 * while jsQR repeatedly masks each located code to reveal additional codes.
 */
export async function decodeWifiQrPayloadsFromImage(blob, {
  barcodeDetector = globalThis.BarcodeDetector,
  canvasFactory = () => document.createElement('canvas'),
  fallback = globalThis.jsQR || jsQR,
  signal,
  maxCodes = 6
} = {}) {
  if (!validImage(blob)) return { status: 'unavailable', reason: 'invalid-image', networks: [] };
  let decoded, canvas;
  const networks = [], attempts = [];
  let detectorCodeCount = 0, nativeUsed = false, fallbackUsed = false;
  try {
    checkAbort(signal);
    decoded = await imageFromBlob(blob);
    const image = decoded.image, width = image.width || image.naturalWidth, height = image.height || image.naturalHeight;
    if (!width || !height) return { status: 'unavailable', reason: 'invalid-dimensions', networks: [] };

    if (typeof barcodeDetector === 'function') {
      try {
        const detector = new barcodeDetector({ formats: ['qr_code'] });
        const hits = await detector.detect(image);
        detectorCodeCount = Array.isArray(hits) ? hits.length : 0;
        for (const hit of hits || []) {
          checkAbort(signal);
          if (typeof hit?.rawValue === 'string') addWifiPayload(networks, hit.rawValue, 'BarcodeDetector', hit.cornerPoints || hit.boundingBox || null);
        }
        nativeUsed = detectorCodeCount > 0;
      } catch (error) { if (error?.name === 'AbortError') throw error; }
    }

    // BarcodeDetector is not consistently available and may only report one
    // result. Run the local fallback unless it already found at least two codes.
    if (typeof fallback === 'function' && networks.length < 2) {
      fallbackUsed = true;
      const maxDimension = Math.max(width, height);
      const scales = [Math.min(1, 2400 / maxDimension), Math.min(1, 1500 / maxDimension), Math.min(1, 950 / maxDimension)];
      if (maxDimension < 1100) scales.push(Math.min(1.35, 1600 / maxDimension));
      const tried = new Set();
      for (const scale of scales) {
        checkAbort(signal);
        const targetWidth = Math.max(1, Math.round(width * scale)), targetHeight = Math.max(1, Math.round(height * scale));
        const scaleKey = `${targetWidth}x${targetHeight}`;
        if (tried.has(scaleKey)) continue;
        tried.add(scaleKey);
        canvas = canvasFactory(); canvas.width = targetWidth; canvas.height = targetHeight;
        try {
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) return { status: 'unavailable', reason: 'canvas-unavailable', networks: dedupeNetworks(networks), attempts };
          context.drawImage(image, 0, 0, targetWidth, targetHeight);
          const source = context.getImageData(0, 0, targetWidth, targetHeight).data;
          const pixels = new Uint8ClampedArray(source);
          let hitCount = 0;
          for (; hitCount < maxCodes; hitCount++) {
            checkAbort(signal);
            const started = globalThis.performance?.now?.() ?? Date.now();
            const hit = fallback(pixels, targetWidth, targetHeight, { inversionAttempts: 'attemptBoth' });
            const ended = globalThis.performance?.now?.() ?? Date.now();
            attempts.push({ width: targetWidth, height: targetHeight, durationMs: Math.max(0, Math.round(ended - started)), found: Boolean(hit?.data) });
            if (!hit?.data) break;
            const location = hit.location || null;
            addWifiPayload(networks, hit.data, 'jsQR', location);
            if (!maskQr(pixels, targetWidth, targetHeight, location)) break;
          }
          // A single found QR is not proof that there is only one. Try a second
          // scale to reveal a smaller code, but avoid a third full scan once two
          // different Wi-Fi networks or two physical codes have been detected.
          if (detectorCodeCount + hitCount >= 2 && dedupeNetworks(networks).length >= 2) break;
        } finally {
          canvas.width = 0; canvas.height = 0; canvas = null;
        }
      }

      // jsQR yields one code per scan and can miss every code when several
      // equally sized symbols share a very wide/tall frame. Overlapping strips
      // isolate symbols after the full-frame attempts without uploading pixels.
      if(dedupeNetworks(networks).length<2){
        const scale=Math.min(1,1800/Math.max(width,height));
        const regions=[
          {id:'left',x:0,y:0,width:Math.ceil(width*.6),height},
          {id:'right',x:Math.floor(width*.4),y:0,width:width-Math.floor(width*.4),height},
          {id:'top',x:0,y:0,width,height:Math.ceil(height*.6)},
          {id:'bottom',x:0,y:Math.floor(height*.4),width,height:height-Math.floor(height*.4)}
        ];
        for(const region of regions){
          if(dedupeNetworks(networks).length>=maxCodes)break;
          try{scanRegion(image,region,scale,canvasFactory,fallback,signal,networks,attempts,maxCodes-dedupeNetworks(networks).length);}
          catch(error){if(error?.name==='AbortError')throw error;}
        }
      }
    }

    const uniqueNetworks = dedupeNetworks(networks);
    if (uniqueNetworks.length) {
      const primary = uniqueNetworks[0];
      return { status: 'wifi', source: nativeUsed && fallbackUsed ? 'BarcodeDetector+jsQR' : nativeUsed ? 'BarcodeDetector' : 'jsQR', networks: uniqueNetworks, ...primary, attempts };
    }
    return { status: attempts.some(item => item.found) || detectorCodeCount ? 'ignored' : 'not-found', reason: detectorCodeCount || attempts.some(item => item.found) ? 'no-valid-wifi-qr' : undefined, source: nativeUsed && fallbackUsed ? 'BarcodeDetector+jsQR' : nativeUsed ? 'BarcodeDetector' : fallbackUsed ? 'jsQR' : undefined, networks: [], attempts };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const partialNetworks = dedupeNetworks(networks);
    if (partialNetworks.length) {
      const primary = partialNetworks[0];
      return { status: 'wifi', source: nativeUsed ? 'BarcodeDetector' : 'jsQR', networks: partialNetworks, ...primary, attempts };
    }
    return { status: 'unavailable', reason: 'decode-failed', networks: [], attempts };
  } finally {
    if (decoded?.close) try { decoded.image.close(); } catch {}
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/** Backwards-compatible single-result API; the full multi-QR result is retained. */
export async function decodeQrPayloadFromImage(blob, options = {}) {
  return decodeWifiQrPayloadsFromImage(blob, options);
}
