import {recognizeRouterLabel} from './ocr.js';
import {decodeQrPayloadFromImage} from './wifi-qr.js';
import {parseRouterLabel} from './router-parser.js';
import {detectCrossFieldContamination,fieldSource} from './scan-flow.js';

function passDiagnostics(ocr){
 return (ocr?.passes||[]).map(pass=>{
  const parsed=parseRouterLabel({rawText:pass.rawText,normalizedText:pass.normalizedText});
  const sourceLines=String(pass.normalizedText||'').split(/\r?\n/);
  return {id:pass.id,executed:true,confidence:pass.confidence??null,durationMs:pass.durationMs??null,
   ssidLabelDetected:sourceLines.some(line=>/\b(?:SSID(?:\s*[12])?|RED\s+WI[ -]?FI|NOMBRE\s+(?:DE\s+)?(?:WI[ -]?FI|RED)|NOM\s+(?:DE\s+)?(?:XARXA|WI[ -]?FI)|XARXA\s+WI[ -]?FI)\b/i.test(line)),
   passwordLabelDetected:sourceLines.some(line=>/\b(?:CLAVE\s+(?:DE\s+)?WI[ -]?FI|WI[ -]?FI\s*(?:KEY|PASSWORD)|WLAN\s*K(?:EY|EV|CY)|WPA\s*(?:KEY|PSK)|WIRELESS\s+(?:KEY|PASSWORD)|CONTRASE[NÑ][YVI]A(?:\s+(?:WPA[23]?|WI[ -]?FI|DE\s+XARXA))?|CLAU\s+(?:DE\s+)?(?:WI[ -]?FI|XARXA))\b/i.test(line)),
   ssidDetected:Boolean(parsed.ssidCandidates.length),passwordDetected:Boolean(parsed.passwordCandidates.length),
   passwordCandidateCount:parsed.passwordCandidates.length,passwordLength:Math.max(0,...parsed.passwordCandidates.map(item=>item.value.length))};
 });
}

/** The single camera, gallery, and fixture pipeline. Image and credentials stay in memory on-device. */
export async function analyzeRouterImage(blob,options={}){
 const signal=options.signal,onProgress=options.onProgress||(()=>{}),onStage=options.onStage||(()=>{}),onDiagnostics=options.onDiagnostics||(()=>{}),recognize=options.recognize||recognizeRouterLabel,decodeQr=options.decodeQr||decodeQrPayloadFromImage,parse=options.parse||parseRouterLabel;
 if(!blob||typeof blob.arrayBuffer!=='function'||!String(blob.type||'').startsWith('image/')||!blob.size)throw new TypeError('Selecciona una fotografía válida para analizar.');
 const started=performance.now();let qr={status:'unavailable'},qrDurationMs=0,ocr=null,ocrError=null;
 const emit=(stage,extra={})=>{try{onDiagnostics({stage,qrFound:qr.status==='wifi',qrWifiValid:qr.status==='wifi',qrHasSsid:Boolean(qr.ssid),qrHasPassword:Boolean(qr.password),qrSource:qr.source||null,qrDurationMs,durationMs:Math.round(performance.now()-started),blob:{type:blob.type,size:blob.size},...extra});}catch{}};
 onStage('Comprobando imagen');
 const qrStarted=performance.now();try{qr=await decodeQr(blob,{signal})||{status:'unavailable'};}catch(error){if(error?.name==='AbortError')throw error;qr={status:'unavailable',reason:'decoder-error'};}finally{qrDurationMs=Math.round(performance.now()-qrStarted);emit('qr-complete',{qrReason:qr.reason||null,qrAttempts:(qr.attempts||[]).map(({width,height,durationMs,found})=>({width,height,durationMs,found}))});}
 if(signal?.aborted){const error=new Error('Análisis cancelado.');error.name='AbortError';throw error;}
 onStage('Analizando router');emit('ocr-start');
 const attemptedPasses={color:false,grayscale:false};
 try{ocr=await recognize(blob,{signal,qrResult:qr,onProgress,onStage:stage=>{onStage(stage);if(stage==='Detectando texto'&&!attemptedPasses.color){attemptedPasses.color=true;emit('ocr-pass-start',{ocrPasses:[{id:'color',executed:true},{id:'grayscale-contrast',executed:false}]});}if(stage==='Mejorando lectura'){attemptedPasses.grayscale=true;emit('ocr-pass-start',{ocrPasses:[{id:'color',executed:attemptedPasses.color},{id:'grayscale-contrast',executed:true}]});}}});}
 catch(error){if(error?.name==='AbortError')throw error;ocrError=String(error?.message||'OCR unavailable');emit('ocr-failed',{ocrError:true,errorCode:error?.name==='EncodingError'?'IMAGE_DECODE':error?.name==='NetworkError'?'OCR_ASSET_LOAD':'OCR_RUNTIME',ocrPasses:[{id:'color',executed:attemptedPasses.color},{id:'grayscale-contrast',executed:attemptedPasses.grayscale}],finalPasswordAvailable:qr.status==='wifi'&&Boolean(qr.password),passwordSource:qr.status==='wifi'&&qr.password?'QR':'ninguno'});if(qr.status!=='wifi')throw error;ocr={rawText:'',normalizedText:'',confidence:null,durationMs:0,passes:[],languages:'spa+eng',error:ocrError};}
 if(signal?.aborted){const error=new Error('Análisis cancelado.');error.name='AbortError';throw error;}
 emit('ocr-complete',{ocrPassCount:ocr.passes?.length||0,ocrSsidDetected:Boolean(passDiagnostics(ocr).some(pass=>pass.ssidDetected)),ocrPasswordDetected:Boolean(passDiagnostics(ocr).some(pass=>pass.passwordDetected)),ocrDurationMs:ocr.durationMs??null});
 const parsed=parse({...ocr,qr:qr.status==='wifi'?qr:null});
 const qrHasPassword=Boolean(qr.status==='wifi'&&qr.password),password=parsed.password;
 const passwordSource=password?.source?.startsWith('qr')?(password.source==='qr+ocr'?'QR + OCR':'QR'):password?.sourcePasses?.length>1?'OCR A + B':password?.sourcePasses?.[0]?.pass==='grayscale-contrast'?'OCR B':password?.sourcePasses?.[0]?'OCR A':password?'OCR fusionado':'ninguno';
 const ocrPassDiagnostics=passDiagnostics(ocr),qrOcrConflict=Boolean(parsed.warnings?.some(item=>/QR Wi-Fi y el texto OCR no coinciden/i.test(item))),ocrSsidDetected=ocrPassDiagnostics.some(pass=>pass.ssidDetected),ocrPasswordDetected=ocrPassDiagnostics.some(pass=>pass.passwordDetected);
 const parserDiagnostics={warnings:[...(parsed.warnings||[])],ssidReasons:[...new Set((parsed.ssidCandidates||[]).map(candidate=>candidate.reason).filter(Boolean))],passwordReasons:[...new Set((parsed.passwordCandidates||[]).map(candidate=>candidate.reason).filter(Boolean))],excludedReasons:[...new Set((parsed.excludedCandidates||[]).map(candidate=>candidate.reason).filter(Boolean))]};
 const diagnostics={stage:'analysis-complete',durationMs:Math.round(performance.now()-started),qrFound:qr.status==='wifi',qrWifiValid:qr.status==='wifi',qrHasSsid:Boolean(qr.ssid),qrHasPassword:qrHasPassword,ocrSsidDetected,ocrPasswordDetected,finalPasswordAvailable:Boolean(password),passwordSource,ssidSource:fieldSource(parsed,'ssid'),passwordSource:fieldSource(parsed,'password'),crossFieldContaminationDetected:detectCrossFieldContamination(parsed),blob:{type:blob.type,size:blob.size},bandReconstructionApplied:(parsed.ssidCandidates||[]).some(candidate=>candidate.corrected&&candidate.correctionType==='wifi-band-context'),qr:{found:qr.status==='wifi',wifiPayloadValid:qr.status==='wifi',hasSsid:Boolean(qr.ssid),hasPassword:qrHasPassword,source:qr.source||null,durationMs:qrDurationMs,attempts:(qr.attempts||[]).map(({width,height,durationMs,found})=>({width,height,durationMs,found}))},ocrPasses:ocrPassDiagnostics,fusion:{passwordCandidateCount:parsed.passwordCandidates?.length||0,passwordDetected:Boolean(password),passwordSource,passwordLength:password?.value?.length||0,qrOcrConflict,ssidCandidateCount:parsed.ssidCandidates?.length||0},parser:parserDiagnostics,review:{requested:null,reason:'Pendiente de evaluar',fields:[]},image:ocr.image?{sourceWidth:ocr.image.sourceWidth??null,sourceHeight:ocr.image.sourceHeight??null,processedWidth:ocr.image.processedWidth??null,processedHeight:ocr.image.processedHeight??null,orientationNormalized:ocr.image.orientationNormalized??null}:null};
 emit('analysis-complete',{ocrPassCount:ocr.passes?.length||0,ocrSsidDetected:diagnostics.ocrPasses.some(pass=>pass.ssidDetected),ocrPasswordDetected:diagnostics.ocrPasses.some(pass=>pass.passwordDetected),finalPasswordAvailable:Boolean(password),ssidSource:diagnostics.ssidSource,passwordSource:diagnostics.passwordSource,crossFieldContaminationDetected:diagnostics.crossFieldContaminationDetected,qrOcrConflict:diagnostics.fusion.qrOcrConflict,parser:parserDiagnostics});
 return {qr,qrDurationMs,ocr,ocrError,parsed,diagnostics,durationMs:Math.round(performance.now()-started),source:qr.status==='wifi'?(parsed.qrAgreement?'qr+ocr':'qr'):'ocr'};
}


