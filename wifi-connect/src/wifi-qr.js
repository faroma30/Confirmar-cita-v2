import jsQR from '../vendor/jsQR.js';
const escapeField=value=>String(value||'').replace(/\\(.)/gs,'$1');

export function parseWifiQrPayload(payload){
 const text=String(payload||'').trim();
 if(!/^WIFI:/i.test(text))return null;
 const fields={};let key='',value='',readingKey=true,escaped=false;
 const commit=()=>{if(key)fields[key.toUpperCase()]=escapeField(value);key='';value='';readingKey=true;};
 for(let index=5;index<text.length;index++){
  const char=text[index];
  if(escaped){(readingKey?key+=char:value+=char);escaped=false;continue;}
  if(char==='\\'){escaped=true;continue;}
  if(readingKey&&char===':'){readingKey=false;continue;}
  if(char===';'){commit();if(text[index+1]===';')break;continue;}
  if(readingKey)key+=char;else value+=char;
 }
 if(key||value)commit();
 const ssid=fields.S||'',securityToken=String(fields.T||'').trim().toUpperCase();
 if(!ssid)return null;
 let security;
 if(!securityToken||/^(?:NOPASS|NONE|OPEN)$/.test(securityToken))security='Sin contraseña';
 else if(/^(?:WPA|WPA2|WPA3|WPA\/WPA2|WPA\/WPA2\/WPA3|SAE)$/.test(securityToken))security=securityToken==='WPA3'||securityToken==='SAE'?'WPA3':'WPA/WPA2';
 else if(securityToken==='WEP')security='WEP';
 else return null;
 const password=fields.P||'';
 if(security!=='Sin contraseña'&&!password)return null;
 return {type:'wifi',ssid,password,security,hidden:/^(?:true|1|yes)$/i.test(fields.H||'')};
}

async function imageFromBlob(blob){
 if(typeof globalThis.createImageBitmap==='function')try{return {image:await createImageBitmap(blob,{imageOrientation:'from-image'}),close:true};}catch{}
 if(typeof globalThis.Image!=='function'||!globalThis.URL?.createObjectURL)throw new Error('Image decoding is unavailable');
 const url=URL.createObjectURL(blob);try{const image=new Image();image.src=url;if(typeof image.decode==='function')await image.decode();else await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;});return {image,close:false};}finally{URL.revokeObjectURL(url);}
}

export async function decodeQrPayloadFromImage(blob,{barcodeDetector=globalThis.BarcodeDetector,canvasFactory=()=>document.createElement('canvas'),fallback=globalThis.jsQR||jsQR}={}){
 if(!blob||!String(blob.type||'').startsWith('image/'))return {status:'unavailable',reason:'invalid-image'};
 let decoded,canvas;
 try{
  decoded=await imageFromBlob(blob);const image=decoded.image,width=image.width||image.naturalWidth,height=image.height||image.naturalHeight;
  if(!width||!height)return {status:'unavailable',reason:'invalid-dimensions'};
  if(typeof barcodeDetector==='function')try{const detector=new barcodeDetector({formats:['qr_code']});const hits=await detector.detect(image);const payload=hits?.[0]?.rawValue;if(payload){const wifi=parseWifiQrPayload(payload);if(wifi)return {status:'wifi',source:'BarcodeDetector',...wifi};}}catch{}
  if(typeof fallback!=='function')return {status:'unavailable',reason:'decoder-unavailable'};
  const maxDimension=Math.max(width,height),scales=[Math.min(1,2400/maxDimension),Math.min(1,1600/maxDimension),Math.min(1,1000/maxDimension)];if(maxDimension<1200)scales.push(Math.min(1.5,1800/maxDimension));const tried=new Set(),attempts=[];
  for(const scale of scales){const targetWidth=Math.max(1,Math.round(width*scale)),targetHeight=Math.max(1,Math.round(height*scale)),key=`${targetWidth}x${targetHeight}`;if(tried.has(key))continue;tried.add(key);canvas=canvasFactory();canvas.width=targetWidth;canvas.height=targetHeight;try{const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return {status:'unavailable',reason:'canvas-unavailable',attempts};context.drawImage(image,0,0,targetWidth,targetHeight);const pixels=context.getImageData(0,0,targetWidth,targetHeight),started=performance.now(),hit=fallback(pixels.data,targetWidth,targetHeight,{inversionAttempts:'attemptBoth'});attempts.push({width:targetWidth,height:targetHeight,durationMs:Math.round(performance.now()-started),found:Boolean(hit?.data)});if(hit?.data){const wifi=parseWifiQrPayload(hit.data);return wifi?{status:'wifi',source:'jsQR',attempts,...wifi}:{status:'ignored',reason:'not-wifi-qr',attempts};}}finally{canvas.width=0;canvas.height=0;canvas=null;}}
  return {status:'not-found',attempts};
 }catch{return {status:'unavailable',reason:'decode-failed'};}finally{if(decoded?.close)try{decoded.image.close();}catch{}if(canvas){canvas.width=0;canvas.height=0;}}
}
