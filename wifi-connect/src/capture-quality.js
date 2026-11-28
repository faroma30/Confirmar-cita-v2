/**
 * Calidad mínima de una foto o fotograma (CONFIRMAR_CITAS-040): nitidez (varianza del Laplaciano relativa al
 * contraste), reflejos, movimiento y tamaño e inclinación de las letras. Cálculo barato y solo en memoria.
 */
export const QUALITY=Object.freeze({minTextPx:18,minSharpness:12,minContrast:30,maxGlare:.12,maxMotion:14,maxTilt:15,sampleWidth:640});
export const QUALITY_ADVICE=Object.freeze({size:'Acércate un poco más',blur:'Mantén quieto el móvil',motion:'Mantén quieto el móvil',glare:'Mejor sin reflejos',tilt:'Gira la etiqueta'});

/** Medidas de una imagen RGBA. La nitidez se expresa en tanto por mil del contraste al cuadrado. */
export function imageStats({data,width,height}){
  const gray=new Float32Array(width*height),histogram=new Uint32Array(256);
  for(let i=0;i<gray.length;i++){const value=.299*data[i*4]+.587*data[i*4+1]+.114*data[i*4+2];gray[i]=value;histogram[Math.min(255,value|0)]++;}
  const percentile=share=>{let sum=0;for(let i=0;i<256;i++){sum+=histogram[i];if(sum>=gray.length*share)return i;}return 255;};
  let sum=0,square=0,count=0;
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const i=y*width+x,value=4*gray[i]-gray[i-1]-gray[i+1]-gray[i-width]-gray[i+width];sum+=value;square+=value*value;count++;}
  const variance=count?square/count-(sum/count)**2:0,contrast=percentile(.98)-percentile(.02);
  let glare=0;for(let i=253;i<256;i++)glare+=histogram[i];
  return {sharpness:contrast>0?variance/(contrast*contrast)*1000:0,contrast,glare:gray.length?glare/gray.length:0};
}
export function frameMotion(previous,current){
  if(!previous||!current||previous.length!==current.length)return 0;
  let total=0;for(let i=0;i<current.length;i+=4)total+=Math.abs(current[i+1]-previous[i+1]);
  return total/(current.length/4);
}
const median=list=>{const sorted=[...list].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:null;};
const LABEL=/(?:ssid|net\s*w[o0]rk|wi[\s-]?fi|wlan|pass\s*w[o0]rd|contrase|clave|(?<![a-z])key(?![a-z])|nombre)/i;
/** Alto (píxeles de la imagen) e inclinación de las líneas con palabras de etiqueta. */
export function textMetrics(lines,imageHeight){
  if(!(imageHeight>0))return {textPx:null,tilt:null};
  const useful=(lines||[]).filter(line=>LABEL.test(String(line?.text||''))&&line.box);
  // La caja de una línea inclinada es más alta que sus letras.
  // El alto de una línea casi vertical (foto girada) no mide las letras.
  const heights=useful.filter(line=>Math.abs(line.angle||0)<=30).map(line=>{const h=(line.box.y1-line.box.y0)*imageHeight,w=(line.box.x1-line.box.x0)*(line.aspect||1)*imageHeight;return Math.max(h*.4,h-w*Math.abs(Math.tan((line.angle||0)*Math.PI/180)));});
  return {textPx:median(heights),tilt:median(useful.map(line=>line.angle||0))};
}
/** Motivos por los que no se puede dar por buena la imagen; el primero es el consejo que se muestra. */
export function qualityVerdict({sharpness=null,contrast=null,glare=null,motion=null,textPx=null,tilt=null}={},limits=QUALITY){
  const reasons=[];
  if(Number.isFinite(motion)&&motion>limits.maxMotion)reasons.push('motion');
  if(Number.isFinite(glare)&&glare>limits.maxGlare)reasons.push('glare');
  if(Number.isFinite(tilt)&&Math.abs(tilt)>limits.maxTilt)reasons.push('tilt');
  if(Number.isFinite(textPx)&&textPx<limits.minTextPx)reasons.push('size');
  if(Number.isFinite(sharpness)&&Number.isFinite(contrast)&&contrast>=limits.minContrast&&sharpness<limits.minSharpness)reasons.push('blur');
  return {ok:!reasons.length,reasons,advice:reasons.length?QUALITY_ADVICE[reasons[0]]:''};
}
/** Mide una foto ya hecha, reducida a un ancho fijo y, si se indica, solo en la zona de la etiqueta. */
export async function measurePhoto(blob,{region=null,canvasFactory=()=>document.createElement('canvas'),bitmapFactory=globalThis.createImageBitmap}={}){
  if(typeof bitmapFactory!=='function')return null;
  let bitmap,canvas;
  try{
    bitmap=await bitmapFactory(blob,{imageOrientation:'from-image'});
    const area=region||{x:.15,y:.15,width:.7,height:.7};
    const sw=Math.max(1,Math.round(area.width*bitmap.width)),sh=Math.max(1,Math.round(area.height*bitmap.height)),scale=Math.min(1,QUALITY.sampleWidth/Math.max(sw,sh));
    canvas=canvasFactory();canvas.width=Math.max(3,Math.round(sw*scale));canvas.height=Math.max(3,Math.round(sh*scale));
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return null;
    context.drawImage(bitmap,Math.round(area.x*bitmap.width),Math.round(area.y*bitmap.height),sw,sh,0,0,canvas.width,canvas.height);
    return {...imageStats(context.getImageData(0,0,canvas.width,canvas.height)),width:bitmap.width,height:bitmap.height};
  }catch{return null;}
  finally{bitmap?.close?.();if(canvas){canvas.width=0;canvas.height=0;}}
}
