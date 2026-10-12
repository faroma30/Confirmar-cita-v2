import {prepareImageForOcr,throwIfAborted,MAX_OCR_DIMENSION} from './image-processing.js';
import {parseRouterLabel} from './router-parser.js';

export const OCR_LANGUAGES='spa+eng';
export const OCR_ENGINE_VERSION='tesseract.js 7.0.0 / tesseract.js-core 7.0.0';
export function normalizeOcrText(text=''){
 return String(text).normalize('NFC').replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/[\t\u00a0 ]{2,}/g,' ').trim()).join('\n').trim();
}
function abortError(){const error=new Error('OCR cancelado.');error.name='AbortError';return error;}
function waitFor(promise,signal){if(!signal)return promise;if(signal.aborted)return Promise.reject(abortError());return new Promise((resolve,reject)=>{const onAbort=()=>reject(abortError());signal.addEventListener('abort',onAbort,{once:true});promise.then(value=>{signal.removeEventListener('abort',onAbort);resolve(value);},error=>{signal.removeEventListener('abort',onAbort);reject(error);});});}
const defaultPaths=()=>({workerPath:new URL('../vendor/tesseract/core/worker.min.js',import.meta.url).href,corePath:new URL('../vendor/tesseract/core/',import.meta.url).href,langPath:new URL('../vendor/tesseract/lang',import.meta.url).href});
export function createOcrService({loadEngine=()=>import('../vendor/tesseract/tesseract.esm.min.js'),preprocess=prepareImageForOcr,paths=defaultPaths}={}){
 return async function recognizeRouterLabel(blob,{signal,onProgress=()=>{},onStage=()=>{},qrResult=null}={}){
  if(!blob||typeof blob.arrayBuffer!=='function'||!String(blob.type||'').startsWith('image/')||!blob.size)throw new TypeError('Selecciona una fotografía válida para analizar.');
  const started=performance.now();let worker=null,workerPromise=null,terminated=false,prepared=null,alternatePrepared=null,abortHandler=null;
  const terminate=async target=>{if(!target||terminated)return;terminated=true;try{await target.terminate();}catch{}};
  try{
   throwIfAborted(signal);onStage('Preparando imagen');const firstPassStarted=performance.now();prepared=await preprocess(blob,{signal,onStage,variant:'color'});throwIfAborted(signal);
   onStage('Cargando reconocimiento');const loadedEngine=await waitFor(loadEngine(),signal);const engine=loadedEngine?.createWorker?loadedEngine:loadedEngine?.default;throwIfAborted(signal);
   const p=paths();const logger=message=>{if(message?.status){onStage(mapStatus(message.status));}if(Number.isFinite(message?.progress)&&message.progress>=0&&message.progress<=1)onProgress({status:mapStatus(message.status||'Procesando'),progress:message.progress});};
   workerPromise=engine.createWorker(OCR_LANGUAGES,engine.OEM?.LSTM_ONLY??1,{...p,workerBlobURL:false,gzip:true,cacheMethod:'write',logger,errorHandler:error=>console.error('[WiFi Connect OCR] Error del worker:',error?.message||error)},{tessedit_pageseg_mode:engine.PSM?.AUTO??'3'});
   // createWorker resolves after worker initialization. If canceled during setup, terminate immediately when it becomes available.
   workerPromise=workerPromise.then(instance=>{worker=instance;if(signal?.aborted)void terminate(instance);return instance;});
   if(signal){abortHandler=()=>{if(worker)void terminate(worker);else if(workerPromise)void workerPromise.then(terminate).catch(()=>{});};signal.addEventListener('abort',abortHandler,{once:true});}
   worker=await waitFor(workerPromise,signal);throwIfAborted(signal);
   const passes=[];let alternatePassError=null;
   onStage('Detectando texto');const first=await waitFor(worker.recognize(prepared.blob),signal);throwIfAborted(signal);
   const firstRaw=String(first?.data?.text??''),firstNormalized=normalizeOcrText(firstRaw),firstConfidence=Number.isFinite(first?.data?.confidence)?first.data.confidence:null;
   passes.push({id:'color',rawText:firstRaw,normalizedText:firstNormalized,confidence:firstConfidence,durationMs:Math.round(performance.now()-firstPassStarted),image:{width:prepared.width,height:prepared.height,bytes:prepared.blob.size}});
   const initialParse=parseRouterLabel({rawText:firstRaw,normalizedText:firstNormalized});
   const expectedBands=new Set([...firstNormalized.matchAll(/(?:^|[^\p{L}\p{N}])SS[i1l]D\s*([12]|[il])\b/giu)].map(match=>String(match[1]).toLowerCase().replace(/[il]/,'1')));
   const parsedBands=new Set(initialParse.ssidCandidates.map(candidate=>String(candidate.sourceLine).match(/(?:^|[^\p{L}\p{N}])SS[i1l]D\s*([12]|[il])\b/i)?.[1]?.toLowerCase().replace(/[il]/,'1')).filter(Boolean));
   const missingExpectedBand=[...expectedBands].some(band=>!parsedBands.has(band));
   // A matching QR may let the app proceed without OCR corroboration, but it must
   // never suppress the alternate OCR pass when the label password is missing.
   const hasPasswordCandidate=initialParse.passwordCandidates.some(candidate=>candidate.score>=60);
   const qrCoversWifi=qrResult?.status==='wifi'&&Boolean(qrResult.ssid)&&(qrResult.security==='Sin contraseña'||Boolean(qrResult.password));
   const firstMatchesQr=qrCoversWifi&&initialParse.ssidCandidates.some(candidate=>candidate.value===qrResult.ssid);
   const firstMatchesQrPassword=qrCoversWifi&&(!qrResult.password||initialParse.passwordCandidates.some(candidate=>candidate.value===qrResult.password));
   const hasBandLabels=expectedBands.size>0;
   const qrPasswordDisagrees=qrCoversWifi&&Boolean(qrResult.password)&&hasPasswordCandidate&&!firstMatchesQrPassword;
   const qrCanSkipAlternate=hasPasswordCandidate&&qrCoversWifi&&firstMatchesQr&&firstMatchesQrPassword&&!hasBandLabels;
   // OCR page confidence cannot verify exact credential characters. If OCR (rather than a valid
   // Wi-Fi QR) is the source of any usable credential, always run the independent grayscale pass.
   const needsCredentialCorroboration=!qrCoversWifi&&(Boolean(initialParse.ssidCandidates.some(candidate=>candidate.score>=40))||hasPasswordCandidate);
   const weak=!qrCanSkipAlternate&&(firstConfidence===null||firstConfidence<72||!initialParse.ssidCandidates.some(candidate=>candidate.score>=60)||!hasPasswordCandidate||missingExpectedBand||qrPasswordDisagrees||needsCredentialCorroboration);
   if(weak){
    throwIfAborted(signal);onStage('Mejorando lectura');const alternateStarted=performance.now();
    try{
     alternatePrepared=await preprocess(blob,{signal,onStage,variant:'grayscale'});throwIfAborted(signal);
     const alternate=await waitFor(worker.recognize(alternatePrepared.blob),signal);throwIfAborted(signal);
     const alternateRaw=String(alternate?.data?.text??''),alternateNormalized=normalizeOcrText(alternateRaw),alternateConfidence=Number.isFinite(alternate?.data?.confidence)?alternate.data.confidence:null;
     passes.push({id:'grayscale-contrast',rawText:alternateRaw,normalizedText:alternateNormalized,confidence:alternateConfidence,durationMs:Math.round(performance.now()-alternateStarted),image:{width:alternatePrepared.width,height:alternatePrepared.height,bytes:alternatePrepared.blob.size}});
    }catch(error){if(error?.name==='AbortError')throw error;alternatePassError=String(error?.message||'El pase alternativo no está disponible.');}
   }
   onStage('Finalizando');
   const mergedLines=[],seenLines=new Set();
   for(const pass of passes)for(const line of pass.normalizedText.split('\n')){const key=line.trim();if(key&&!seenLines.has(key)){seenLines.add(key);mergedLines.push(key);}}
   const rawText=passes.length===1?passes[0].rawText:passes.map(pass=>`[OCR ${pass.id}]\n${pass.rawText}`).join('\n\n');const normalizedText=mergedLines.join('\n');
   const confidence=passes.length===1?passes[0].confidence:Math.round(passes.reduce((total,pass)=>total+(pass.confidence??0),0)/passes.length*10)/10;
   const result={rawText,normalizedText,confidence,durationMs:Math.round(performance.now()-started),languages:OCR_LANGUAGES,engine:OCR_ENGINE_VERSION,passes,alternatePassError,image:{originalBytes:blob.size,sourceWidth:prepared.sourceWidth,sourceHeight:prepared.sourceHeight,processedWidth:prepared.width,processedHeight:prepared.height,processedBytes:prepared.blob.size,wasResized:prepared.wasResized,maxDimension:MAX_OCR_DIMENSION},processedPreviewBlob:prepared.previewBlob};
   return result;
  }catch(error){if(error?.name!=='AbortError')console.error('[WiFi Connect OCR] No se pudo reconocer la etiqueta:',error?.message||error);throw error;}
  finally{
   if(signal&&abortHandler)signal.removeEventListener('abort',abortHandler);
   if(worker)await terminate(worker);else if(workerPromise)void workerPromise.then(terminate).catch(()=>{});
   // Drop references to the full processed bitmap/blob. The returned preview is deliberately small.
   prepared=null;alternatePrepared=null;
  }
 };
}
export const recognizeRouterLabel=createOcrService();
function mapStatus(status){const value=String(status).toLowerCase();if(value.includes('core')||value.includes('worker'))return 'Cargando reconocimiento';if(value.includes('language')||value.includes('traineddata')||value.includes('initializ'))return 'Cargando idiomas';if(value.includes('recogniz'))return 'Detectando texto';if(value.includes('load'))return 'Cargando reconocimiento';return 'Procesando resultado';}
