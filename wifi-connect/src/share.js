import {makeWifiPayload} from './utils.js';
async function svgAsPng(svg){
 if(!svg||!('createImageBitmap'in window))return null;
 try{const source=new XMLSerializer().serializeToString(svg);const bitmap=await createImageBitmap(new Blob([source],{type:'image/svg+xml'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();return await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));}catch{return null;}
}
export async function shareNetwork(network,svg){
 const payload=makeWifiPayload(network);const text=`Red Wi-Fi: ${network.ssid}\nContraseña: ${network.password||'Sin contraseña'}\nDatos QR: ${payload}`;
 if(navigator.share){try{const png=await svgAsPng(svg);if(png&&typeof File!=='undefined'){const file=new File([png],`wifi-${network.ssid.replace(/[^\p{L}\p{N}-]/gu,'_')}.png`,{type:'image/png'});if(navigator.canShare?.({files:[file]})){await navigator.share({title:`Wi-Fi ${network.ssid}`,text,files:[file]});return 'QR compartido.';}}
 await navigator.share({title:`Wi-Fi ${network.ssid}`,text});return 'Datos compartidos.';}catch(e){if(e.name==='AbortError')return '';}}
 try{await navigator.clipboard.writeText(text);return 'Datos copiados. También puedes mantener pulsada la imagen QR para guardarla.';}catch{return 'No está disponible la función de compartir. Mantén pulsado el QR para guardarlo como imagen.';}
}
