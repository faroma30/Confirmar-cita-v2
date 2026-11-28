/**
 * Etiqueta pequeña o lejana (CONFIRMAR_CITAS-038): si faltan el nombre o la clave, se vuelve a leer ampliada la zona
 * donde el OCR vio palabras de etiqueta y, después, la franja y el centro de la foto. Todo en el dispositivo, con tope
 * de intentos y de tiempo. Lo leído así queda siempre para revisar.
 */
export const ZOOM_BUDGET_MS=15000;
export const ZOOM_MAX_ATTEMPTS=3;
export const ZOOM_FALLBACK_REGIONS=Object.freeze([
 Object.freeze({x:.25,y:0,width:.5,height:1}),
 Object.freeze({x:.2,y:.2,width:.6,height:.6})
]);
const LABEL_WORD=/(?:ssid|ss[i1l]d|net\s*w[o0]rk|w[i1l]\s*-?\s*f[i1l][\s-]*(?:key|pass)|wlan|pass\s*w[o0]rd|contrase|contrasenya|(?<![a-z])clave(?![a-z])|(?<![a-z])key(?![a-z]))/i;
const clamp=value=>Math.min(1,Math.max(0,value));
/** Rectángulo (en fracciones de la foto) que rodea las líneas con palabras de etiqueta, con margen para sus valores. */
export function findLabelRegion(blocks,width,height){
 if(!Array.isArray(blocks)||!(width>0)||!(height>0))return null;
 const boxes=[];
 for(const block of blocks)for(const paragraph of block?.paragraphs||[])for(const line of paragraph?.lines||[]){
  const box=line?.bbox;
  if(!LABEL_WORD.test(String(line?.text||''))||!box||![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite))continue;
  if(box.y1-box.y0>=4&&box.x1-box.x0>=12)boxes.push(box);
 }
 if(!boxes.length)return null;
 const heights=boxes.map(box=>box.y1-box.y0).sort((a,b)=>a-b),line=heights[Math.floor(heights.length/2)];
 const x0=Math.min(...boxes.map(box=>box.x0)),y0=Math.min(...boxes.map(box=>box.y0)),x1=Math.max(...boxes.map(box=>box.x1)),y1=Math.max(...boxes.map(box=>box.y1));
 // A la derecha y por debajo suele estar el valor: más margen en esos dos lados.
 const left=clamp((x0-line*3)/width),top=clamp((y0-line*4)/height),right=clamp(Math.max(x1+line*6,x0+line*18)/width),bottom=clamp((y1+line*4)/height);
 const region={x:left,y:top,width:right-left,height:bottom-top};
 // Si ya es casi toda la foto, ampliarla no aporta nada.
 return region.width>0&&region.height>0&&region.width*region.height<.6?region:null;
}
/** Valores que una lectura ampliada puede proponer: sin símbolos raros ni trozos sueltos. */
export const isZoomValue=candidate=>{
 const value=String(candidate?.proposedValue||candidate?.value||'');
 return candidate?.fieldType==='password'?/^[\x21-\x7e]{8,63}$/.test(value):/^[\x20-\x7e]{3,32}$/.test(value);
};
const usable=list=>(list||[]).filter(candidate=>candidate.score>=60&&isZoomValue(candidate));

/** Lecturas ampliadas; se detiene en cuanto una misma lectura trae nombre y contraseña. */
export async function readZoomedLabel(blob,{regions=[],signal,recognize,parse,zoom,budgetMs=ZOOM_BUDGET_MS,maxAttempts=ZOOM_MAX_ATTEMPTS,rectify=null,onStage=()=>{},now=()=>performance.now()}){
 const started=now();let best=null,attempts=0;const lines=[];
 const queue=[...regions.filter(Boolean).slice(0,1),...ZOOM_FALLBACK_REGIONS];
 for(const region of queue){
  if(signal?.aborted){const error=new Error('Análisis cancelado.');error.name='AbortError';throw error;}
  if(attempts>=maxAttempts||now()-started>=budgetMs)break;
  try{
   onStage('Ampliando la etiqueta');
   const straight=Boolean(rectify&&attempts===0&&region===regions[0]);
   const enlarged=straight?await rectify(blob,region,{signal}):await zoom(blob,region,{signal});
   const ocr=await recognize(enlarged,{signal,singlePass:true,onStage});attempts++;
   // Las cajas de un recorte recto vuelven a la foto; las de una etiqueta enderezada no tienen vuelta directa.
   if(!straight)for(const line of ocr.lines||[]){
    const back=box=>({x0:region.x+box.x0*region.width,y0:region.y+box.y0*region.height,x1:region.x+box.x1*region.width,y1:region.y+box.y1*region.height});
    lines.push({...line,box:back(line.box),aspect:(line.aspect||1)*region.height/region.width,words:(line.words||[]).map(word=>({...word,box:back(word.box)}))});
   }
   const parsed=parse({...ocr,qr:null,passes:[]});
   const ssid=usable(parsed.ssidCandidates),password=usable(parsed.passwordCandidates),weight=Number(ssid.length>0)+Number(password.length>0);
   if(weight&&(!best||weight>best.weight))best={region,ssid,password,weight};
   if(weight===2)break;
  }catch(error){if(error?.name==='AbortError')throw error;break;}
 }
 return {best,attempts,lines,durationMs:Math.max(0,Math.round(now()-started))};
}

/**
 * Suma lo leído ampliado solo en los campos que no tenían un valor útil; lo anterior queda como alternativa.
 * Todo lo añadido queda para revisar.
 */
export function mergeZoomedCandidates(parsed,best){
 if(!best)return false;
 let used=false;
 for(const [field,listName] of [['ssid','ssidCandidates'],['password','passwordCandidates']]){
  const found=best[field],current=parsed[listName]||[];
  if(!found?.length||current.some(candidate=>candidate.score>=60&&isZoomValue(candidate)))continue;
  const added=found.map(candidate=>({...candidate,needsReview:true,zoomed:true,ocrConfidence:null,sourcePasses:[],ocrPasses:[]}));
  parsed[listName]=[...added,...current.filter(candidate=>!added.some(item=>item.value===candidate.value||item.band&&item.band===candidate.band))];
  parsed[field]={...parsed[listName][0]};used=true;
 }
 return used;
}
