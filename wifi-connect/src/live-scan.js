/**
 * Lectura automática en vivo (CONFIRMAR_CITAS-036). Con un QR Wi-Fi válido se entrega al primer acierto; sin él,
 * intentos espaciados de texto que solo se aceptan con la misma lectura en dos fotogramas seguidos. Todo queda en
 * memoria: aquí no se guarda ni se envía nada. El disparador manual no depende de este módulo.
 */
import jsQR from '../vendor/jsQR.js';
import {parseWifiQrPayload} from './wifi-qr-core.js?v=3wl2';
import {findQrPresence} from './qr-presence.js?v=3wl2';
import {parseRouterLabel} from './router-parser.js?v=3wl2';
import {isSafeSsidCandidate,isSafePasswordCandidate} from './scan-flow.js?v=3wl2';
import {isLabelText} from './label-rules.js?v=3wl2';

export const LIVE_TIMING=Object.freeze({qrIntervalMs:220,slowQrIntervalMs:500,firstTextDelayMs:2500,textIntervalMs:1500,helpAfterMs:20000,textLimitMs:60000});
export const LIVE_MESSAGES=Object.freeze({
  searching:'Buscando etiqueta…',
  found:'Etiqueta leída',
  closer:'Acércate un poco más',
  help:'Acércate, ponla de frente, sin reflejos y espera a que enfoque. También puedes pulsar el disparador.',
  manual:'Pulsa el disparador para hacer la foto.'
});
const MIN_TEXT_SCORE=62,SMALL_QR_SHARE=0.16;

export const usableQrNetwork=network=>Boolean(network?.type==='wifi'&&network.ssid?.trim()&&(network.security==='Sin contraseña'||network.password?.trim())&&!isLabelText(network.ssid)&&!(network.password&&isLabelText(network.password)));

/** Lectura de texto aprovechable de un fotograma, o null si falta nombre o clave fiables. */
export function readingFromOcr(ocr,{parse=parseRouterLabel,minConfidence=55}={}){
  if(!ocr||(Number.isFinite(ocr.confidence)&&ocr.confidence<minConfidence))return null;
  const parsed=parse({rawText:ocr.rawText||'',normalizedText:ocr.normalizedText||''});
  const good=item=>item.score>=MIN_TEXT_SCORE&&!item.weakValue&&!isLabelText(item.value);
  const ssids=[...new Set(parsed.ssidCandidates.filter(item=>isSafeSsidCandidate(item)&&good(item)).map(item=>item.value))].sort();
  const password=isSafePasswordCandidate(parsed.password)&&good(parsed.password)?parsed.password.value:'';
  if(!ssids.length||!password)return null;
  return {key:JSON.stringify([ssids,password]),pass:{id:'color',rawText:ocr.rawText||'',normalizedText:ocr.normalizedText||'',confidence:ocr.confidence??null}};
}

/**
 * Lee los QR de un fotograma (BarcodeDetector del navegador y jsQR). `presence` solo se rellena cuando se ve un
 * código pequeño que no se puede leer.
 */
export async function readQrFrame({video=null,pixels=null,detector=null,decode=jsQR,presence=findQrPresence}={}){
  const networks=[];let other=false;
  const add=payload=>{const network=parseWifiQrPayload(payload);if(!network){other=true;return;}if(!networks.some(item=>item.ssid===network.ssid&&item.password===network.password))networks.push(network);};
  if(detector&&video){try{for(const hit of await detector.detect(video)||[])if(typeof hit?.rawValue==='string'&&hit.rawValue)add(hit.rawValue);}catch{}}
  if(!networks.length&&pixels){
    const data=new Uint8ClampedArray(pixels.data);
    for(let attempt=0;attempt<3;attempt++){
      const hit=decode(data,pixels.width,pixels.height,{inversionAttempts:'dontInvert'});
      if(!hit?.data)break;
      add(hit.data);
      // Tapa el código leído para encontrar una segunda red en el mismo fotograma.
      const points=['topLeftCorner','topRightCorner','bottomRightCorner','bottomLeftCorner'].map(key=>hit.location?.[key]).filter(Boolean);
      if(!points.length)break;
      const xs=points.map(point=>point.x),ys=points.map(point=>point.y),pad=8;
      for(let y=Math.max(0,Math.floor(Math.min(...ys))-pad);y<Math.min(pixels.height,Math.ceil(Math.max(...ys))+pad);y++)
        for(let x=Math.max(0,Math.floor(Math.min(...xs))-pad);x<Math.min(pixels.width,Math.ceil(Math.max(...xs))+pad);x++){const o=(y*pixels.width+x)*4;data[o]=data[o+1]=data[o+2]=255;}
    }
  }
  let small=false;
  if(!networks.length&&!other&&pixels&&presence){const found=presence(pixels);small=Boolean(found&&found.share<SMALL_QR_SHARE);}
  return {networks,other,small};
}

/** Parte del fotograma que corresponde al marco de encuadre (vídeo con object-fit: contain), con margen. */
export function guideRegion({videoWidth,videoHeight,videoRect,guideRect,margin=0.12}){
  const full={x:0,y:0,width:videoWidth,height:videoHeight};
  if(!videoWidth||!videoHeight||!videoRect?.width||!videoRect?.height||!guideRect?.width||!guideRect?.height)return full;
  const scale=Math.min(videoRect.width/videoWidth,videoRect.height/videoHeight);
  const left=videoRect.left+(videoRect.width-videoWidth*scale)/2,top=videoRect.top+(videoRect.height-videoHeight*scale)/2;
  const mx=guideRect.width*margin,my=guideRect.height*margin;
  const x=Math.max(0,Math.floor((guideRect.left-mx-left)/scale)),y=Math.max(0,Math.floor((guideRect.top-my-top)/scale));
  const right=Math.min(videoWidth,Math.ceil((guideRect.left+guideRect.width+mx-left)/scale)),bottom=Math.min(videoHeight,Math.ceil((guideRect.top+guideRect.height+my-top)/scale));
  return right-x<64||bottom-y<64?full:{x,y,width:right-x,height:bottom-y};
}

/**
 * Bucle del visor. `readQr` y `readText` leen el fotograma actual; `onQr` y `onText` se llaman como mucho una vez
 * en total. Cualquier fallo deja intacto el flujo manual.
 */
export function createLiveScanner({readQr,readText=null,onQr,onText,onStatus=()=>{},timing=LIVE_TIMING,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),now=()=>Date.now()}){
  const options={...LIVE_TIMING,...timing},timers=new Set();
  let running=false,delivered=false,started=0,previous=null,failures=0,closerStreak=0,helpShown=false,status='';
  const say=message=>{if(message!==status){status=message;onStatus(message);}};
  const later=(fn,ms)=>{const id=setTimer(()=>{timers.delete(id);if(running)fn();},ms);timers.add(id);};
  function stop(){running=false;previous=null;for(const id of timers)clearTimer(id);timers.clear();}
  async function deliver(callback,payload){
    if(!running||delivered)return;
    delivered=true;stop();say(LIVE_MESSAGES.found);
    try{await callback(payload);}catch{say(LIVE_MESSAGES.manual);}
  }
  async function qrTick(){
    try{
      const result=await readQr();
      if(!running)return;
      const networks=(result?.networks||[]).filter(usableQrNetwork);
      if(networks.length){await deliver(onQr,{networks,passes:previous?[previous.pass]:[]});return;}
      closerStreak=result?.small?closerStreak+1:0;
      if(!helpShown)say(closerStreak>=3?LIVE_MESSAGES.closer:LIVE_MESSAGES.searching);
    }catch{}
    later(qrTick,now()-started>options.textLimitMs?options.slowQrIntervalMs:options.qrIntervalMs);
  }
  async function textTick(){
    if(now()-started>options.textLimitMs)return;
    try{
      const reading=await readText();
      if(!running)return;
      failures=0;
      if(reading&&previous&&reading.key===previous.key){await deliver(onText,{blob:reading.blob,passes:[previous.pass,reading.pass]});return;}
      previous=reading||null;
    }catch{previous=null;if(++failures>=2)return;}
    if(running)later(textTick,options.textIntervalMs);
  }
  function start(){
    if(running||delivered)return;
    running=true;started=now();say(LIVE_MESSAGES.searching);
    later(()=>{helpShown=true;say(LIVE_MESSAGES.help);},options.helpAfterMs);
    later(qrTick,options.qrIntervalMs);
    if(readText)later(textTick,options.firstTextDelayMs);
  }
  return {start,stop,isRunning:()=>running,hasDelivered:()=>delivered};
}

/** Une el bucle con el vídeo real: lienzos en memoria que se vacían al terminar. */
export function createVideoFrameSource(video,{guide=null,recognize,canvasFactory=()=>document.createElement('canvas'),barcodeDetector=globalThis.BarcodeDetector,signal}={}){
  let canvas=canvasFactory(),textCanvas=canvasFactory(),tick=0,detector=null;
  if(typeof barcodeDetector==='function'){try{detector=new barcodeDetector({formats:['qr_code']});}catch{}}
  const region=()=>guideRegion({videoWidth:video.videoWidth,videoHeight:video.videoHeight,videoRect:video.getBoundingClientRect?.(),guideRect:guide?.getBoundingClientRect?.()});
  async function readQr(){
    if(!canvas||!video.videoWidth)return null;
    const index=tick++;
    // Con detector nativo, jsQR solo de apoyo; alterna fotograma completo reducido y recorte del marco sin reducir.
    if(detector){const native=await readQrFrame({video,detector,pixels:null});if(native.networks.length||index%3!==2)return native;}
    const area=index%2?region():{x:0,y:0,width:video.videoWidth,height:video.videoHeight},scale=Math.min(1,960/Math.max(area.width,area.height));
    canvas.width=Math.max(1,Math.round(area.width*scale));canvas.height=Math.max(1,Math.round(area.height*scale));
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return null;
    context.drawImage(video,area.x,area.y,area.width,area.height,0,0,canvas.width,canvas.height);
    return readQrFrame({pixels:context.getImageData(0,0,canvas.width,canvas.height),presence:index%3===0?findQrPresence:null});
  }
  async function readText(){
    if(!textCanvas||!video.videoWidth)return null;
    const area=region();textCanvas.width=area.width;textCanvas.height=area.height;
    const context=textCanvas.getContext('2d',{alpha:false});if(!context)return null;
    context.drawImage(video,area.x,area.y,area.width,area.height,0,0,area.width,area.height);
    const blob=await new Promise((resolve,reject)=>textCanvas.toBlob(value=>value?resolve(value):reject(new Error('frame')),'image/jpeg',0.94));
    const size={width:area.width,height:area.height};
    const reading=readingFromOcr(await recognize(blob,{signal,singlePass:true}));
    return reading?{...reading,blob,...size}:null;
  }
  function release(){for(const item of [canvas,textCanvas])if(item){item.width=0;item.height=0;}canvas=null;textCanvas=null;}
  return {readQr,readText,release};
}
