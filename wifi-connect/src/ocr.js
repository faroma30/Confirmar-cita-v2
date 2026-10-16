import {prepareImageForOcr,throwIfAborted,MAX_OCR_DIMENSION} from './image-processing.js?v=3cj1';
import {parseRouterLabel} from './router-parser.js?v=3cj1';
import {findSsidFocusRegions} from './ssid-focus.js?v=3bn2';

export const OCR_LANGUAGES='spa+eng';
export const OCR_ENGINE_VERSION='tesseract.js 7.0.0 / tesseract.js-core 7.0.0';
function sourceRegion(target,prepared){
 const x=prepared.sourceWidth/prepared.width,y=prepared.sourceHeight/prepared.height;
 return {...target,region:{left:Math.floor(target.region.left*x),top:Math.floor(target.region.top*y),width:Math.ceil(target.region.width*x),height:Math.ceil(target.region.height*y)}};
}
export function normalizeOcrText(text=''){
 return String(text).normalize('NFC').replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/[\t\u00a0 ]{2,}/g,' ').trim()).join('\n').trim();
}
function abortError(){const error=new Error('OCR cancelado.');error.name='AbortError';return error;}
function waitFor(promise,signal,timeoutMs=null,onTimeout=()=>{}){if(signal?.aborted)return Promise.reject(abortError());return new Promise((resolve,reject)=>{let settled=false;let timer=null;const finish=(callback,value)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);signal?.removeEventListener('abort',onAbort);callback(value);};const onAbort=()=>finish(reject,abortError());signal?.addEventListener('abort',onAbort,{once:true});if(Number.isFinite(timeoutMs)&&timeoutMs>0)timer=setTimeout(()=>{const error=new Error('OCR operation timed out.');error.name='TimeoutError';onTimeout(error);finish(reject,error);},timeoutMs);Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));});}
const defaultPaths=()=>({workerPath:new URL('../vendor/tesseract/core/worker.min.js',import.meta.url).href,corePath:new URL('../vendor/tesseract/core/',import.meta.url).href,langPath:new URL('../vendor/tesseract/lang',import.meta.url).href});
export function createOcrService({loadEngine=()=>import('../vendor/tesseract/tesseract.esm.min.js'),preprocess=prepareImageForOcr,paths=defaultPaths,initializationTimeoutMs=45000,recognitionTimeoutMs=30000,idleTimeoutMs=45000}={}){
 let queue=Promise.resolve(),enginePromise=null,engine=null,workerPromise=null,worker=null,workerGeneration=0,idleTimer=null,activeProgress=()=>{},activeStage=()=>{};
 const clearIdle=()=>{if(idleTimer){clearTimeout(idleTimer);idleTimer=null;}};
 const terminateWorker=async()=>{clearIdle();workerGeneration++;const current=worker;worker=null;workerPromise=null;if(current)try{await current.terminate();}catch{}};
 const dispose=()=>terminateWorker();
 const recognizeRouterLabel=(blob,options={})=>{const task=queue.then(()=>recognizeOne(blob,options));queue=task.catch(()=>{});return task;};
 recognizeRouterLabel.dispose=dispose;
 return recognizeRouterLabel;
 async function getWorker(loadedEngine,signal,onProgress,onStage){
  activeProgress=onProgress;activeStage=onStage;clearIdle();if(worker)return {instance:worker,reused:true};
  if(!workerPromise){const generation=++workerGeneration,p=paths(),engine=loadedEngine;const creation=engine.createWorker(OCR_LANGUAGES,engine.OEM?.LSTM_ONLY??1,{...p,workerBlobURL:false,gzip:true,cacheMethod:'write',logger:message=>{if(message?.status)activeStage(mapStatus(message.status));if(Number.isFinite(message?.progress)&&message.progress>=0&&message.progress<=1)activeProgress({status:mapStatus(message.status||'Procesando'),progress:message.progress});},errorHandler:error=>console.error('[WiFi Connect OCR] Error del worker:',error?.name||'WorkerError')},{tessedit_pageseg_mode:engine.PSM?.AUTO??'3'});
   workerPromise=Promise.resolve(creation).then(async instance=>{if(generation!==workerGeneration||signal?.aborted){if(generation===workerGeneration){workerGeneration++;workerPromise=null;}try{await instance.terminate();}catch{}throw abortError();}worker=instance;return instance;}).catch(error=>{if(generation===workerGeneration){workerPromise=null;worker=null;}throw error;});}
  const pending=workerPromise;
  try{const instance=await waitFor(pending,signal,initializationTimeoutMs,()=>{workerGeneration++;worker=null;workerPromise=null;void pending.then(value=>value.terminate()).catch(()=>{});});return {instance,reused:false};}
  catch(error){if(signal?.aborted&&workerPromise===pending){workerGeneration++;worker=null;workerPromise=null;void pending.then(value=>value.terminate()).catch(()=>{});}throw error;}
 }
 async function recognizeWithTimeout(instance,image,signal){
  try{return await waitFor(instance.recognize(image,{}, {text:true,blocks:true}),signal,recognitionTimeoutMs,()=>{void terminateWorker();});}
  catch(error){if(error?.name==='TimeoutError'||signal?.aborted)await terminateWorker();throw error;}
 }
 async function recognizeOne(blob,{signal,onProgress=()=>{},onStage=()=>{},qrResult=null}={}){
  if(!blob||typeof blob.arrayBuffer!=='function'||!String(blob.type||'').startsWith('image/')||!blob.size)throw new TypeError('Selecciona una fotografía válida para analizar.');
  const started=performance.now();let prepared=null,alternatePrepared=null,focusedPrepared=null;const timing={imagePreparationMs:0,engineLoadMs:0,workerInitializationMs:0,recognitionMs:0,alternatePreparationMs:0,focusedPreparationMs:0};
  try{
   throwIfAborted(signal);onStage('Preparando imagen');let prepStarted=performance.now();prepared=await preprocess(blob,{signal,onStage,variant:'color',includePreview:true});timing.imagePreparationMs=Math.round(performance.now()-prepStarted);throwIfAborted(signal);
   onStage('Cargando reconocimiento');prepStarted=performance.now();if(!enginePromise)enginePromise=Promise.resolve().then(loadEngine).then(loaded=>{const resolved=loaded?.createWorker?loaded:loaded?.default;if(!resolved?.createWorker)throw new TypeError('OCR engine unavailable.');engine=resolved;return resolved;}).catch(error=>{enginePromise=null;throw error;});
   const loadedEngine=await waitFor(enginePromise,signal,15000);timing.engineLoadMs=Math.round(performance.now()-prepStarted);throwIfAborted(signal);
   onStage('Cargando idiomas');prepStarted=performance.now();const lease=await getWorker(loadedEngine,signal,onProgress,onStage);worker=lease.instance;timing.workerInitializationMs=lease.reused?0:Math.round(performance.now()-prepStarted);throwIfAborted(signal);
   const passes=[];let alternatePassError=null;const focusTargets=[],focusErrors=[],focusLengths=[];let focusAttemptCount=0;
   onStage('Detectando texto');let recognizeStarted=performance.now();const first=await recognizeWithTimeout(worker,prepared.blob,signal);timing.recognitionMs+=Math.round(performance.now()-recognizeStarted);throwIfAborted(signal);
   const firstRaw=String(first?.data?.text??''),firstNormalized=normalizeOcrText(firstRaw),firstConfidence=Number.isFinite(first?.data?.confidence)?first.data.confidence:null;
   passes.push({id:'color',rawText:firstRaw,normalizedText:firstNormalized,confidence:firstConfidence,blockCount:first?.data?.blocks?.length||0,durationMs:Math.round(performance.now()-recognizeStarted),image:{width:prepared.width,height:prepared.height,bytes:prepared.blob.size}});
   const initialParse=parseRouterLabel({rawText:firstRaw,normalizedText:firstNormalized});
   for(const target of findSsidFocusRegions(first?.data?.blocks,prepared.width,prepared.height,initialParse.ssidCandidates))focusTargets.push({...sourceRegion(target,prepared),blob});
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
     prepStarted=performance.now();alternatePrepared=await preprocess(blob,{signal,onStage,variant:'grayscale',includePreview:false});timing.alternatePreparationMs=Math.round(performance.now()-prepStarted);throwIfAborted(signal);
     recognizeStarted=performance.now();const alternate=await recognizeWithTimeout(worker,alternatePrepared.blob,signal);timing.recognitionMs+=Math.round(performance.now()-recognizeStarted);throwIfAborted(signal);
     const alternateRaw=String(alternate?.data?.text??''),alternateNormalized=normalizeOcrText(alternateRaw),alternateConfidence=Number.isFinite(alternate?.data?.confidence)?alternate.data.confidence:null;
     passes.push({id:'grayscale-contrast',rawText:alternateRaw,normalizedText:alternateNormalized,confidence:alternateConfidence,blockCount:alternate?.data?.blocks?.length||0,durationMs:Math.round(performance.now()-alternateStarted),image:{width:alternatePrepared.width,height:alternatePrepared.height,bytes:alternatePrepared.blob.size}});
     const alternateParse=parseRouterLabel({rawText:alternateRaw,normalizedText:alternateNormalized});
     for(const target of findSsidFocusRegions(alternate?.data?.blocks,alternatePrepared.width,alternatePrepared.height,alternateParse.ssidCandidates))if(!focusTargets.some(item=>item.band===target.band))focusTargets.push({...sourceRegion(target,alternatePrepared),blob});
    }catch(error){if(error?.name==='AbortError'||error?.name==='TimeoutError')throw error;alternatePassError=error?.name||'OCR_ERROR';}
   }
   const beforeFocus=parseRouterLabel({normalizedText:passes.map(pass=>pass.normalizedText).join('\n')});
   const namedSsidDisagreement=[...new Map(beforeFocus.ssidCandidates.filter(candidate=>candidate.score>=40&&candidate.sourceLabel&&!candidate.sourceLabel.startsWith('Proximidad')).map(candidate=>[candidate.sourceLabel,beforeFocus.ssidCandidates.filter(other=>other.score>=40&&other.sourceLabel===candidate.sourceLabel).map(other=>other.value)])).values()].some(values=>new Set(values).size>1);
   const uncertainBands=new Set(beforeFocus.ssidCandidates.filter(candidate=>candidate.score>=40&&(candidate.needsReview||candidate.bandPeerConflict||candidate.bandConfidence==='low')).map(candidate=>candidate.band==='2.4 GHz'?'1':candidate.band==='5 GHz'?'2':String(candidate.sourceLine||'').match(/SSID\s*([12il])/i)?.[1]?.toLowerCase().replace(/[il]/,'1')).filter(Boolean));
   const prioritized=focusTargets.filter(item=>!item.band||uncertainBands.has(String(item.band))||namedSsidDisagreement).filter((item,index,list)=>!list.slice(0,index).some(previous=>previous.band===item.band&&Math.abs(previous.region.top-item.region.top)<Math.max(24,item.region.height)));
   if(prioritized.length){
    for(const [index,target] of prioritized.slice(0,2).entries()){
     throwIfAborted(signal);focusAttemptCount++;const focusStarted=performance.now();onStage('Verificando nombre Wi-Fi');
     try{
      prepStarted=performance.now();focusedPrepared=await preprocess(target.blob,{signal,onStage,variant:'ssid-focus',region:target.region,includePreview:false});timing.focusedPreparationMs+=Math.round(performance.now()-prepStarted);throwIfAborted(signal);
      recognizeStarted=performance.now();const focused=await recognizeWithTimeout(worker,focusedPrepared.blob,signal);timing.recognitionMs+=Math.round(performance.now()-recognizeStarted);throwIfAborted(signal);
      const focusedRaw=String(focused?.data?.text??'');let focusedNormalized=normalizeOcrText(focusedRaw);
      focusLengths.push(focusedNormalized.length);
      // The crop position was obtained from an OCR line explicitly labelled as an SSID.
      // Restore only that field label when the tight crop loses it; preserve every
      // character of the recognized value and leave any disagreement for review.
      if(focusedNormalized&&!focusedNormalized.includes('\n')&&!/^(?:SS[i1l]D\s*[12il]?|WI[ -]?FI|WLAN|NETWORK|NOMBRE|RED|PASSWORD|KEY|CLAVE)\b/i.test(focusedNormalized)&&/^[\p{L}\p{N}][\p{L}\p{N}_ .-]{3,63}$/u.test(focusedNormalized))focusedNormalized=`SSID${target.band||''}: ${focusedNormalized}`;
      // Preserve the value printed on the line immediately below a standalone
      // SSID label. The previous filter kept only the label, so this focused
      // pass could never corroborate that common two-line sticker layout.
      focusedNormalized=focusedSsidText(focusedNormalized);
      if(focusedNormalized)passes.push({id:`ssid-focus-${index+1}`,focusBand:target.band,rawText:focusedRaw,normalizedText:focusedNormalized,confidence:Number.isFinite(focused?.data?.confidence)?focused.data.confidence:null,durationMs:Math.round(performance.now()-focusStarted),image:{width:focusedPrepared.width,height:focusedPrepared.height,bytes:focusedPrepared.blob.size}});
     }catch(error){if(error?.name==='AbortError')throw error;focusErrors.push(error?.name||'Error');}
     finally{focusedPrepared=null;}
    }
   }
   onStage('Finalizando');
   const mergedLines=[],seenLines=new Set();
   const isStandaloneSsidLabel=line=>/^\s*(?:SS[i1l]D(?:(?:\s+(?:2\s*[.,]?\s*4|5)\s*(?:GHz|G)?\b)|(?:\s*[12il]))?|(?:WI[ -]?FI|WLAN|NETWORK|WIRELESS)\s+NAME|NOMBRE\s+(?:DE\s+)?(?:WI[ -]?FI|RED)|RED\s+WI[ -]?FI)\s*[:=：＝]?\s*$/i.test(line);
   for(const pass of passes)for(const line of pass.normalizedText.split('\n')){const key=line.trim();if(key&&(!seenLines.has(key)||isStandaloneSsidLabel(key))){seenLines.add(key);mergedLines.push(key);}}
   const rawText=passes.length===1?passes[0].rawText:passes.map(pass=>`[OCR ${pass.id}]\n${pass.rawText}`).join('\n\n');const normalizedText=mergedLines.join('\n');
   const pagePasses=passes.filter(pass=>!pass.id.startsWith('ssid-focus-'));
   const confidence=pagePasses.length===1?pagePasses[0].confidence:Math.round(pagePasses.reduce((total,pass)=>total+(pass.confidence??0),0)/pagePasses.length*10)/10;
   const result={rawText,normalizedText,confidence,durationMs:Math.round(performance.now()-started),timing,workerReused:lease.reused,languages:OCR_LANGUAGES,engine:OCR_ENGINE_VERSION,passes,alternatePassError,focusRegionCount:focusTargets.length,focusAttemptCount,focusErrors,focusLengths,focusRegions:focusTargets.map(item=>({band:item.band,region:item.region})),image:{originalBytes:blob.size,sourceWidth:prepared.sourceWidth,sourceHeight:prepared.sourceHeight,processedWidth:prepared.width,processedHeight:prepared.height,processedBytes:prepared.blob.size,wasResized:prepared.wasResized,maxDimension:MAX_OCR_DIMENSION},processedPreviewBlob:prepared.previewBlob};
   return result;
  }catch(error){if(error?.name!=='AbortError')console.error('[WiFi Connect OCR] No se pudo reconocer la etiqueta:',error?.name||'Error');throw error;}
  finally{
   // Reuse a healthy worker briefly for another scan, then release mobile memory.
   if(worker&&!signal?.aborted){clearIdle();idleTimer=setTimeout(()=>{void terminateWorker();},idleTimeoutMs);idleTimer.unref?.();}
   // Drop references to the full processed bitmap/blob. The returned preview is deliberately small.
   prepared=null;alternatePrepared=null;focusedPrepared=null;
  }
 }
}
export const recognizeRouterLabel=createOcrService();
export function disposeRecognizeRouterLabel(){recognizeRouterLabel.dispose?.();}
function mapStatus(status){const value=String(status).toLowerCase();if(value.includes('core')||value.includes('worker'))return 'Cargando reconocimiento';if(value.includes('language')||value.includes('traineddata')||value.includes('initializ'))return 'Cargando idiomas';if(value.includes('recogniz'))return 'Detectando texto';if(value.includes('load'))return 'Cargando reconocimiento';return 'Procesando resultado';}
const ssidFocusLabel=/^\s*(?:SS[i1l]D(?:(?:\s+(?:2\s*[.,]?\s*4|5)\s*(?:GHz|G)?\b)|(?:\s*[12il]))?(?=$|[\s:=\-])|(?:WI[ -]?FI|WLAN|NETWORK|WIRELESS)\s+NAME\b|NOMBRE\s+(?:DE\s+)?(?:WI[ -]?FI|RED)\b|RED\s+WI[ -]?FI\b)/i;
const credentialOrAdminLabel=/^\s*(?:WPA|WPS|(?:WI[ -]?FI|WLAN|WIRELESS|NETWORK)\s*(?:KEY|PASSWORD|PASS|CLAVE)|(?:CONTRASE[NÑ]A|CONTRASENYA|CLAVE|PASSWORD|USERNAME|ADMIN|SERIAL|MAC|GATEWAY|IP)\b)/i;
function focusedSsidText(text){
 const lines=normalizeOcrText(text).split('\n'),kept=[];
 for(let index=0;index<lines.length;index++){
  const line=lines[index];if(!ssidFocusLabel.test(line))continue;
  kept.push(line);
  const tail=line.replace(ssidFocusLabel,'').replace(/^\s*[:=]\s*/, '').trim();
  const next=lines[index+1];
  if(!tail&&next&&next.length<=64&&!credentialOrAdminLabel.test(next))kept.push(next);
 }
 return kept.join('\n');
}
