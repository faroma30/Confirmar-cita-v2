/** Browser-side, orientation-aware preprocessing for OCR. No filters are applied by default. */
import {findLabelQuad,warpQuad} from './geometry.js?v=3wl3';
export const MAX_OCR_DIMENSION=2800;
export const PREVIEW_MAX_DIMENSION=1200;
export function throwIfAborted(signal){if(signal?.aborted){const error=new Error('OCR cancelado.');error.name='AbortError';throw error;}}
function canvasToBlob(canvas,type='image/jpeg',quality=0.96){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo preparar la imagen para leerla.')),type,quality));}
const PREPARATION_OPERATIONS=new Set(['decode_image','read_dimensions','create_ocr_canvas','get_ocr_context','draw_ocr_image','read_image_data','write_image_data','encode_ocr_image','create_preview_canvas','get_preview_context','draw_preview_image','encode_preview_image','complete']);
function safeErrorKind(error){const name=String(error?.name||'');return ['EncodingError','SecurityError','InvalidStateError','IndexSizeError','NotSupportedError','QuotaExceededError','AbortError','TypeError','RangeError'].includes(name)?name:name==='Error'?'Error':'UnknownError';}
function reportPreparation(onDiagnostic,operation,state,details={},error=null){
 if(!PREPARATION_OPERATIONS.has(operation)||!['running','completed','failed'].includes(state))return;
 const report={operation,state,errorKind:error?safeErrorKind(error):null,canvasAvailable:details.canvasAvailable??null,contextAvailable:details.contextAvailable??null,width:Number.isInteger(details.width)?details.width:null,height:Number.isInteger(details.height)?details.height:null};
 try{onDiagnostic(report);}catch{}
}
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
/** Copia girada (90, 180 o 270 grados) de la fotografía, en memoria; para etiquetas fotografiadas de lado. */
export async function rotateImageBlob(blob,degrees,{signal,maxDimension=MAX_OCR_DIMENSION,urlApi=globalThis.URL,canvasFactory=()=>document.createElement('canvas')}={}){
 if(![90,180,270].includes(degrees))throw new RangeError('Giro no admitido.');
 let decoded,canvas;
 try{
  decoded=await decodeBlob(blob,urlApi,signal);
  const sourceWidth=decoded.image.width||decoded.image.naturalWidth,sourceHeight=decoded.image.height||decoded.image.naturalHeight;
  if(!sourceWidth||!sourceHeight)throw new Error('No se pudieron leer las dimensiones de la fotografía.');
  const scale=Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight)),width=Math.max(1,Math.round(sourceWidth*scale)),height=Math.max(1,Math.round(sourceHeight*scale));
  canvas=canvasFactory();canvas.width=degrees===180?width:height;canvas.height=degrees===180?height:width;
  const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('No se pudo girar la fotografía en este dispositivo.');
  context.translate(canvas.width/2,canvas.height/2);context.rotate(degrees*Math.PI/180);context.drawImage(decoded.image,-width/2,-height/2,width,height);
  const rotated=await canvasToBlob(canvas,'image/jpeg',0.95);throwIfAborted(signal);return rotated;
 }finally{if(decoded?.close)try{decoded.image.close();}catch{}if(canvas){canvas.width=0;canvas.height=0;}}
}
/** Recorte ampliado (región en fracciones de la foto ya orientada), en memoria; para etiquetas pequeñas. */
export const ZOOM_TARGET_DIMENSION=2000;
export async function zoomImageBlob(blob,region,{signal,targetDimension=ZOOM_TARGET_DIMENSION,maxScale=4,urlApi=globalThis.URL,canvasFactory=()=>document.createElement('canvas')}={}){
 if(!region||![region.x,region.y,region.width,region.height].every(Number.isFinite)||region.width<=0||region.height<=0)throw new RangeError('Región no válida.');
 let decoded,canvas;
 try{
  decoded=await decodeBlob(blob,urlApi,signal);
  const sourceWidth=decoded.image.width||decoded.image.naturalWidth,sourceHeight=decoded.image.height||decoded.image.naturalHeight;
  if(!sourceWidth||!sourceHeight)throw new Error('No se pudieron leer las dimensiones de la fotografía.');
  const left=Math.max(0,Math.floor(region.x*sourceWidth)),top=Math.max(0,Math.floor(region.y*sourceHeight));
  const cropWidth=Math.max(1,Math.min(sourceWidth-left,Math.round(region.width*sourceWidth))),cropHeight=Math.max(1,Math.min(sourceHeight-top,Math.round(region.height*sourceHeight)));
  const scale=Math.min(maxScale,targetDimension/Math.max(cropWidth,cropHeight));
  canvas=canvasFactory();canvas.width=Math.max(1,Math.round(cropWidth*scale));canvas.height=Math.max(1,Math.round(cropHeight*scale));
  const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('No se pudo ampliar la fotografía en este dispositivo.');
  context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
  context.drawImage(decoded.image,left,top,cropWidth,cropHeight,0,0,canvas.width,canvas.height);
  const enlarged=await canvasToBlob(canvas,'image/jpeg',0.95);throwIfAborted(signal);return enlarged;
 }finally{if(decoded?.close)try{decoded.image.close();}catch{}if(canvas){canvas.width=0;canvas.height=0;}}
}
export async function prepareImageForOcr(blob,{signal,maxDimension=MAX_OCR_DIMENSION,previewMaxDimension=PREVIEW_MAX_DIMENSION,urlApi=globalThis.URL,canvasFactory=()=>document.createElement('canvas'),onStage=()=>{},onDiagnostic=()=>{},variant='color',region=null,includePreview=variant==='color'}={}){
 if(!blob||typeof blob.arrayBuffer!=='function'||!String(blob.type||'').startsWith('image/'))throw new TypeError('Se necesita una fotografía válida para analizar.');
 if(!blob.size)throw new TypeError('La fotografía está vacía.');
 throwIfAborted(signal);onStage('Preparando imagen');
 let decoded,canvas,previewCanvas,currentOperation='decode_image',sourceWidth=null,sourceHeight=null,width=null,height=null,contextAvailable=null;
 try{
  reportPreparation(onDiagnostic,currentOperation,'running');decoded=await decodeBlob(blob,urlApi,signal);reportPreparation(onDiagnostic,currentOperation,'completed');
  currentOperation='read_dimensions';reportPreparation(onDiagnostic,currentOperation,'running');
  sourceWidth=decoded.image.width||decoded.image.naturalWidth;sourceHeight=decoded.image.height||decoded.image.naturalHeight;
  if(!sourceWidth||!sourceHeight)throw new Error('No se pudieron leer las dimensiones de la fotografía.');
  reportPreparation(onDiagnostic,currentOperation,'completed',{width:sourceWidth,height:sourceHeight});
  const crop=region?{left:Math.max(0,Math.floor(region.left)),top:Math.max(0,Math.floor(region.top)),width:Math.max(1,Math.floor(region.width)),height:Math.max(1,Math.floor(region.height))}:{left:0,top:0,width:sourceWidth,height:sourceHeight};
  crop.width=Math.min(crop.width,sourceWidth-crop.left);crop.height=Math.min(crop.height,sourceHeight-crop.top);
  if(crop.width<1||crop.height<1)throw new Error('La región de texto no está dentro de la fotografía.');
  const scale=variant==='ssid-focus'?Math.min(2.5,maxDimension/Math.max(crop.width,crop.height)):variant==='grayscale'?Math.min(1.5,maxDimension/Math.max(crop.width,crop.height)):Math.min(1,maxDimension/Math.max(crop.width,crop.height));width=Math.max(1,Math.round(crop.width*scale));height=Math.max(1,Math.round(crop.height*scale));
  currentOperation='create_ocr_canvas';reportPreparation(onDiagnostic,currentOperation,'running',{width,height});canvas=canvasFactory();canvas.width=width;canvas.height=height;reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,width,height});
  currentOperation='get_ocr_context';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:Boolean(canvas),width,height});const context=canvas.getContext('2d',{alpha:false});contextAvailable=Boolean(context);if(!context)throw new Error('No se pudo procesar la fotografía en este dispositivo.');reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable:true,width,height});
  // ImageBitmap with imageOrientation=from-image (or browser-decoded <img> fallback) normalizes EXIF exactly once.
  currentOperation='draw_ocr_image';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:Boolean(canvas),contextAvailable,width,height});
  if(region)context.drawImage(decoded.image,crop.left,crop.top,crop.width,crop.height,0,0,width,height);
  else context.drawImage(decoded.image,0,0,width,height);
  reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable:true,width,height});
  if(variant==='grayscale'){
   currentOperation='read_image_data';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:true,contextAvailable:true,width,height});
   const pixels=context.getImageData(0,0,width,height),data=pixels.data;
   reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable:true,width,height});
   for(let index=0;index<data.length;index+=4){const luminance=.2126*data[index]+.7152*data[index+1]+.0722*data[index+2],contrasted=Math.max(0,Math.min(255,(luminance-128)*1.22+128));data[index]=data[index+1]=data[index+2]=contrasted;}
   currentOperation='write_image_data';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:true,contextAvailable:true,width,height});
   context.putImageData(pixels,0,0);
   reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable:true,width,height});
  }
  throwIfAborted(signal);onStage('Imagen preparada');const outputType=variant==='ssid-focus'?'image/png':'image/jpeg';currentOperation='encode_ocr_image';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:Boolean(canvas),contextAvailable,width,height});const processedBlob=await canvasToBlob(canvas,outputType,0.96);reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable,width,height});throwIfAborted(signal);
  let previewBlob=null;
  if(includePreview){const previewScale=Math.min(1,previewMaxDimension/Math.max(width,height));const previewWidth=Math.max(1,Math.round(width*previewScale)),previewHeight=Math.max(1,Math.round(height*previewScale));
   currentOperation='create_preview_canvas';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:true,width:previewWidth,height:previewHeight});previewCanvas=canvasFactory();previewCanvas.width=previewWidth;previewCanvas.height=previewHeight;reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,width:previewWidth,height:previewHeight});
   currentOperation='get_preview_context';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:Boolean(previewCanvas),width:previewWidth,height:previewHeight});const previewContext=previewCanvas.getContext('2d',{alpha:false});if(!previewContext)throw new Error('No se pudo crear la vista comparativa.');reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable:true,width:previewWidth,height:previewHeight});
   currentOperation='draw_preview_image';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:true,contextAvailable:true,width:previewWidth,height:previewHeight});previewContext.drawImage(canvas,0,0,previewWidth,previewHeight);reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable:true,width:previewWidth,height:previewHeight});
   currentOperation='encode_preview_image';reportPreparation(onDiagnostic,currentOperation,'running',{canvasAvailable:true,contextAvailable:true,width:previewWidth,height:previewHeight});previewBlob=await canvasToBlob(previewCanvas,'image/jpeg',0.88);reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:true,contextAvailable:true,width:previewWidth,height:previewHeight});throwIfAborted(signal);}
  currentOperation='complete';reportPreparation(onDiagnostic,currentOperation,'completed',{canvasAvailable:Boolean(canvas),contextAvailable,width,height});
  return {blob:processedBlob,previewBlob,sourceWidth,sourceHeight,width,height,wasResized:scale<1,orientationNormalized:true,mimeType:outputType};
 }catch(error){reportPreparation(onDiagnostic,currentOperation,'failed',{canvasAvailable:canvas?true:null,contextAvailable,width:width||sourceWidth,height:height||sourceHeight},error);throw error;
 }finally{
  if(decoded?.close)try{decoded.image.close();}catch{}
  for(const temporary of [canvas,previewCanvas])if(temporary){temporary.width=0;temporary.height=0;}
 }
}

/** Realza bordes y estira el contraste de una imagen RGBA (en el propio búfer), en gris. */
export function enhanceGray(image,{sharpen=false,radius=2}={}){
 const {data,width,height}=image,gray=new Float32Array(width*height),histogram=new Uint32Array(256);
 for(let i=0;i<gray.length;i++){gray[i]=.299*data[i*4]+.587*data[i*4+1]+.114*data[i*4+2];histogram[Math.min(255,gray[i]|0)]++;}
 const percentile=share=>{let sum=0;for(let i=0;i<256;i++){sum+=histogram[i];if(sum>=gray.length*share)return i;}return 255;};
 const low=percentile(.02),range=Math.max(1,percentile(.95)-low);
 for(let i=0;i<gray.length;i++)gray[i]=Math.max(0,Math.min(255,(gray[i]-low)*255/range));
 let output=gray;
 if(sharpen){
  const sums=new Float64Array((width+1)*(height+1));
  for(let y=0;y<height;y++){let row=0;for(let x=0;x<width;x++){row+=gray[y*width+x];sums[(y+1)*(width+1)+x+1]=sums[y*(width+1)+x+1]+row;}}
  output=new Float32Array(gray.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const x0=Math.max(0,x-radius),x1=Math.min(width,x+radius+1),y0=Math.max(0,y-radius),y1=Math.min(height,y+radius+1);
   const mean=(sums[y1*(width+1)+x1]-sums[y0*(width+1)+x1]-sums[y1*(width+1)+x0]+sums[y0*(width+1)+x0])/((x1-x0)*(y1-y0));
   output[y*width+x]=gray[y*width+x]+1.5*(gray[y*width+x]-mean);
  }
 }
 for(let i=0;i<output.length;i++){data[i*4]=data[i*4+1]=data[i*4+2]=Math.max(0,Math.min(255,output[i]));data[i*4+3]=255;}
 return image;
}

/** Medidas en píxeles del recorte de una línea: caja en fracciones, inclinación y variante de lectura. */
export function lineCropPlan({box,angle=0},variant,sourceWidth,sourceHeight){
 const width=(box.x1-box.x0)*sourceWidth,height=(box.y1-box.y0)*sourceHeight,slope=Math.abs(Math.tan(angle*Math.PI/180));
 // La caja del OCR rodea la línea inclinada: el alto real de la letra es menor.
 const letter=Math.max(height*.4,height-width*slope),cropWidth=width+letter*1.4,cropHeight=letter*1.6;
 const scale=Math.min(6,variant.height/cropHeight,2400/(cropWidth*variant.stretch)),margin=20;
 return {centerX:(box.x0+box.x1)/2*sourceWidth,centerY:(box.y0+box.y1)/2*sourceHeight,cropWidth,cropHeight,scale,margin,
  outputWidth:Math.max(1,Math.round(cropWidth*scale*variant.stretch))+margin*2,outputHeight:Math.max(1,Math.round(cropHeight*scale))+margin*2};
}
/** Recorte de una línea, enderezado y ampliado, en memoria. */
export async function cropLineBlob(blob,place,variant,{signal,urlApi=globalThis.URL,canvasFactory=()=>document.createElement('canvas')}={}){
 let decoded,canvas;
 try{
  decoded=await decodeBlob(blob,urlApi,signal);
  const sourceWidth=decoded.image.width||decoded.image.naturalWidth,sourceHeight=decoded.image.height||decoded.image.naturalHeight;
  if(!sourceWidth||!sourceHeight)throw new Error('No se pudieron leer las dimensiones de la fotografía.');
  const plan=lineCropPlan(place,variant,sourceWidth,sourceHeight);
  canvas=canvasFactory();canvas.width=plan.outputWidth;canvas.height=plan.outputHeight;
  const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});if(!context)throw new Error('No se pudo recortar la fotografía en este dispositivo.');
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  context.save();context.beginPath();context.rect(plan.margin,plan.margin,canvas.width-plan.margin*2,canvas.height-plan.margin*2);context.clip();
  context.translate(canvas.width/2,canvas.height/2);context.scale(variant.stretch,1);context.rotate(-(place.angle||0)*Math.PI/180);context.scale(plan.scale,plan.scale);
  context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.translate(-plan.centerX,-plan.centerY);context.drawImage(decoded.image,0,0);context.restore();
  if(variant.mode!=='color'){
   const width=canvas.width-plan.margin*2,height=canvas.height-plan.margin*2;
   context.putImageData(enhanceGray(context.getImageData(plan.margin,plan.margin,width,height),{sharpen:variant.mode==='sharp',radius:Math.max(1,Math.round(variant.height/30))}),plan.margin,plan.margin);
  }
  const cropped=await canvasToBlob(canvas,'image/png');throwIfAborted(signal);return cropped;
 }finally{if(decoded?.close)try{decoded.image.close();}catch{}if(canvas){canvas.width=0;canvas.height=0;}}
}
/** Etiqueta recortada, enderezada (perspectiva si se ven sus esquinas; solo giro si no) y ampliada. */
export async function rectifyLabelBlob(blob,region,{angle=0,seeds=[],signal,targetDimension=ZOOM_TARGET_DIMENSION,urlApi=globalThis.URL,canvasFactory=()=>document.createElement('canvas')}={}){
 let decoded,canvas,work;
 try{
  decoded=await decodeBlob(blob,urlApi,signal);
  const sourceWidth=decoded.image.width||decoded.image.naturalWidth,sourceHeight=decoded.image.height||decoded.image.naturalHeight;
  if(!sourceWidth||!sourceHeight)throw new Error('No se pudieron leer las dimensiones de la fotografía.');
  const scale=Math.min(1,900/Math.max(sourceWidth,sourceHeight));
  work=canvasFactory();work.width=Math.max(1,Math.round(sourceWidth*scale));work.height=Math.max(1,Math.round(sourceHeight*scale));
  const context=work.getContext('2d',{alpha:false,willReadFrequently:true});context.drawImage(decoded.image,0,0,work.width,work.height);
  const points=seeds.map(([x,y])=>[x*work.width,y*work.height]),quad=findLabelQuad(context.getImageData(0,0,work.width,work.height),points);
  // Solo vale si la mancha encontrada abarca todas las líneas de etiqueta.
  const inside=Boolean(quad)&&[0,1].every(axis=>{const values=quad.map(p=>p[axis]);return points.every(p=>p[axis]>=Math.min(...values)&&p[axis]<=Math.max(...values));});
  canvas=canvasFactory();let straight=false;
  if(inside){
   const corners=quad.map(([x,y])=>[x/scale,y/scale]),length=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
   const width=(length(corners[0],corners[1])+length(corners[3],corners[2]))/2,height=(length(corners[0],corners[3])+length(corners[1],corners[2]))/2;
   const grow=Math.min(4,targetDimension/Math.max(width,height,1));
   const left=Math.max(0,Math.floor(Math.min(...corners.map(p=>p[0])))),top=Math.max(0,Math.floor(Math.min(...corners.map(p=>p[1]))));
   work.width=Math.max(1,Math.min(sourceWidth,Math.ceil(Math.max(...corners.map(p=>p[0]))))-left);work.height=Math.max(1,Math.min(sourceHeight,Math.ceil(Math.max(...corners.map(p=>p[1]))))-top);
   context.drawImage(decoded.image,left,top,work.width,work.height,0,0,work.width,work.height);
   const warped=warpQuad(context.getImageData(0,0,work.width,work.height),corners.map(([x,y])=>[x-left,y-top]),Math.max(1,Math.round(width*grow)),Math.max(1,Math.round(height*grow)));
   if(warped){canvas.width=warped.width;canvas.height=warped.height;const output=canvas.getContext('2d',{alpha:false}),pixels=output.createImageData(warped.width,warped.height);pixels.data.set(warped.data);output.putImageData(pixels,0,0);straight=true;}
  }
  if(!straight){
   const width=region.width*sourceWidth,height=region.height*sourceHeight,grow=Math.min(4,targetDimension/Math.max(width,height,1));
   canvas.width=Math.max(1,Math.round(width*grow));canvas.height=Math.max(1,Math.round(height*grow));
   const output=canvas.getContext('2d',{alpha:false});output.fillStyle='#fff';output.fillRect(0,0,canvas.width,canvas.height);
   output.translate(canvas.width/2,canvas.height/2);output.rotate(-angle*Math.PI/180);output.scale(grow,grow);output.imageSmoothingEnabled=true;output.imageSmoothingQuality='high';
   output.translate(-(region.x*sourceWidth+width/2),-(region.y*sourceHeight+height/2));output.drawImage(decoded.image,0,0);
  }
  const result=await canvasToBlob(canvas,'image/jpeg',0.95);throwIfAborted(signal);return result;
 }finally{if(decoded?.close)try{decoded.image.close();}catch{}for(const item of [canvas,work])if(item){item.width=0;item.height=0;}}
}
