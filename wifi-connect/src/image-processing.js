/** Browser-side, orientation-aware preprocessing for OCR. No filters are applied by default. */
export const MAX_OCR_DIMENSION=2800;
export const PREVIEW_MAX_DIMENSION=1200;
export function throwIfAborted(signal){if(signal?.aborted){const error=new Error('OCR cancelado.');error.name='AbortError';throw error;}}
function canvasToBlob(canvas,type='image/jpeg',quality=0.96){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo preparar la imagen para leerla.')),type,quality));}
async function decodeBlob(blob,urlApi,signal){
 throwIfAborted(signal);
 if(typeof globalThis.createImageBitmap==='function'){
  try{return {image:await globalThis.createImageBitmap(blob,{imageOrientation:'from-image'}),close:true};}
  catch(firstError){throwIfAborted(signal);try{return {image:await globalThis.createImageBitmap(blob),close:true};}catch{throw firstError;}}
 }
 if(typeof globalThis.Image!=='function')throw new Error('Este navegador no puede abrir la fotografía para analizarla.');
 const url=urlApi.createObjectURL(blob);const image=new Image();
 try{
  if(typeof image.decode==='function'){image.src=url;await image.decode();}
  else await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('No se pudo decodificar la fotografía.'));image.src=url;});
  throwIfAborted(signal);return {image,close:false};
 }finally{urlApi.revokeObjectURL(url);}
}
export async function prepareImageForOcr(blob,{signal,maxDimension=MAX_OCR_DIMENSION,previewMaxDimension=PREVIEW_MAX_DIMENSION,urlApi=globalThis.URL,canvasFactory=()=>document.createElement('canvas'),onStage=()=>{},variant='color'}={}){
 if(!blob||typeof blob.arrayBuffer!=='function'||!String(blob.type||'').startsWith('image/'))throw new TypeError('Se necesita una fotografía válida para analizar.');
 if(!blob.size)throw new TypeError('La fotografía está vacía.');
 throwIfAborted(signal);onStage('Preparando imagen');
 const decoded=await decodeBlob(blob,urlApi,signal);let canvas,previewCanvas;
 try{
  const sourceWidth=decoded.image.width||decoded.image.naturalWidth,sourceHeight=decoded.image.height||decoded.image.naturalHeight;
  if(!sourceWidth||!sourceHeight)throw new Error('No se pudieron leer las dimensiones de la fotografía.');
  const scale=variant==='grayscale'?Math.min(1.5,maxDimension/Math.max(sourceWidth,sourceHeight)):Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight));const width=Math.max(1,Math.round(sourceWidth*scale)),height=Math.max(1,Math.round(sourceHeight*scale));
  canvas=canvasFactory();canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('No se pudo procesar la fotografía en este dispositivo.');
  // ImageBitmap with imageOrientation=from-image (or browser-decoded <img> fallback) normalizes EXIF exactly once.
  context.drawImage(decoded.image,0,0,width,height);
  if(variant==='grayscale'){
   const pixels=context.getImageData(0,0,width,height),data=pixels.data;
   for(let index=0;index<data.length;index+=4){const luminance=.2126*data[index]+.7152*data[index+1]+.0722*data[index+2],contrasted=Math.max(0,Math.min(255,(luminance-128)*1.22+128));data[index]=data[index+1]=data[index+2]=contrasted;}
   context.putImageData(pixels,0,0);
  }
  throwIfAborted(signal);onStage('Imagen preparada');const processedBlob=await canvasToBlob(canvas,'image/jpeg',0.96);throwIfAborted(signal);
  const previewScale=Math.min(1,previewMaxDimension/Math.max(width,height));const previewWidth=Math.max(1,Math.round(width*previewScale)),previewHeight=Math.max(1,Math.round(height*previewScale));
  previewCanvas=canvasFactory();previewCanvas.width=previewWidth;previewCanvas.height=previewHeight;const previewContext=previewCanvas.getContext('2d',{alpha:false});if(!previewContext)throw new Error('No se pudo crear la vista comparativa.');
  previewContext.drawImage(canvas,0,0,previewWidth,previewHeight);const previewBlob=await canvasToBlob(previewCanvas,'image/jpeg',0.88);throwIfAborted(signal);
  return {blob:processedBlob,previewBlob,sourceWidth,sourceHeight,width,height,wasResized:scale<1,orientationNormalized:true,mimeType:'image/jpeg'};
 }finally{
  if(decoded.close)try{decoded.image.close();}catch{}
  for(const temporary of [canvas,previewCanvas])if(temporary){temporary.width=0;temporary.height=0;}
 }
}
