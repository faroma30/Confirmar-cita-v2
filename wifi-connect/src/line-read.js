/**
 * Relectura línea a línea de nombre y clave (CONFIRMAR_CITAS-040): localiza cada aparición del dato en lo que vio el
 * OCR, recorta la línea enderezada y ampliada, la lee varias veces y vota carácter a carácter. Todo en el
 * dispositivo, con tope de lecturas y de tiempo. Lo leído así queda siempre para revisar.
 */
import {alignRead,voteCharacters} from './consensus.js?v=3wl3';
import {PASSWORD_ALPHABETS} from './password-check.js?v=3wl3';
import {isRouterAccessLabel} from './label-rules.js?v=3wl3';

export const LINE_VARIANTS=Object.freeze([
  {height:56,stretch:1,mode:'color'},{height:56,stretch:1,mode:'sharp'},{height:40,stretch:1,mode:'gray'},
  {height:90,stretch:1,mode:'color'},{height:56,stretch:1.3,mode:'gray'},{height:90,stretch:1.3,mode:'sharp'},
  {height:40,stretch:1.3,mode:'color'},{height:70,stretch:1,mode:'gray'},{height:70,stretch:1.3,mode:'sharp'}
].map(Object.freeze));
export const LINE_BUDGET_MS=8000;
export const MAX_TARGETS=5;

const overlap=(a,b)=>{const w=Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0),h=Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0);if(w<=0||h<=0)return 0;return w*h/Math.min((a.x1-a.x0)*(a.y1-a.y0),(b.x1-b.x0)*(b.y1-b.y0));};
const union=boxes=>({x0:Math.min(...boxes.map(b=>b.x0)),y0:Math.min(...boxes.map(b=>b.y0)),x1:Math.max(...boxes.map(b=>b.x1)),y1:Math.max(...boxes.map(b=>b.y1))});

/** Cajas de las palabras que se parecen al valor: una por cada aparición distinta en la foto. */
export function findValueBoxes(value,lines,{minSimilarity=.6,max=3}={}){
  const wanted=String(value??'').replace(/\s+/g,'');if(wanted.length<4)return [];
  const found=[];
  for(const line of lines||[]){
    const words=(line.words||[]).filter(word=>word?.box&&String(word.text||'').trim());let best=null;
    for(let start=0;start<words.length;start++){
      let text='';
      for(let end=start;end<words.length&&end<start+4;end++){
        text+=words[end].text.trim();
        if(text.length<wanted.length*.6)continue;
        if(text.length>wanted.length*1.5+6)break;
        const forward=alignRead(wanted,text),back=alignRead(text,wanted);
        // Penaliza las palabras vecinas (la etiqueta) que no forman parte del valor.
        const similarity=Math.min(forward?.similarity||0,(back?.similarity||0)+.2);
        if(similarity>=minSimilarity&&(!best||similarity>best.similarity))best={similarity,box:union(words.slice(start,end+1).map(w=>w.box)),angle:line.angle||0,aspect:line.aspect||1};
      }
    }
    if(best)found.push(best);
  }
  found.sort((a,b)=>b.similarity-a.similarity);
  const distinct=[];for(const item of found)if(!distinct.some(other=>overlap(other.box,item.box)>.4))distinct.push(item);
  return distinct.slice(0,max);
}

const BAND_LABEL=/^\W*(2\s*[.,]?\s*4|5)\s*(?:ghz|g|6)?\s*ss[i1l]d\s*[:;]?\s*(.*)$/i;
/** Líneas «2.4G SSID» / «5G SSID» con el nombre debajo, aunque el OCR de la foto entera no lo haya entendido. */
export function findBandValueLines(lines){
  const found=[];
  for(const line of lines||[]){
    const match=String(line.text||'').trim().match(BAND_LABEL);
    if(!match||match[2].trim()||!line.box)continue;
    const height=line.box.y1-line.box.y0,aspect=line.aspect||1,band=match[1].startsWith('2')?'2.4 GHz':'5 GHz';
    if(found.some(item=>item.band===band))continue;
    const below=(lines||[]).filter(other=>other!==line&&other.box&&other.box.y0>line.box.y0+height*.4&&other.box.y0<line.box.y1+height*1.6&&Math.abs(other.box.x0-line.box.x0)<height*4/aspect)
      .sort((a,b)=>a.box.y0-b.box.y0)[0];
    const text=String(below?.text||'').trim();
    if(below&&text.length>=4&&!/pass|key|clave|contrase|ssid|user|login/i.test(text))found.push({band,box:below.box,angle:below.angle||0,aspect:below.aspect||1,text});
  }
  return found;
}

const usable=candidate=>Boolean(candidate&&!candidate.source?.startsWith('qr')&&candidate.score>=40&&!isRouterAccessLabel(candidate.sourceLabel||'')&&typeof candidate.value==='string');
/** Datos a releer: la clave y los nombres propuestos (uno por banda), con todas sus apariciones. */
export function lineTargets(parsed,lines,{max=MAX_TARGETS}={}){
  const targets=[];
  const add=(field,candidate)=>{
    if(!usable(candidate)||targets.some(item=>item.field===field&&item.value===candidate.value))return;
    const boxes=findValueBoxes(candidate.originalValue||candidate.value,lines);
    if(boxes.length)targets.push({field,value:candidate.value,candidate,boxes,reads:[]});
  };
  const password=parsed?.password;
  add('password',(parsed?.passwordCandidates||[]).find(item=>item.value===password?.value&&item.sourceLine===password?.sourceLine));
  const bands=new Set();
  for(const candidate of (parsed?.ssidCandidates||[]).filter(usable).slice(0,4)){
    const band=candidate.band||'';if(bands.has(band))continue;bands.add(band);add('ssid',candidate);
    if(bands.size>=2)break;
  }
  // Nombre con banda que la foto entera no dio: se propone solo si las relecturas coinciden.
  for(const line of findBandValueLines(lines)){
    if(targets.some(item=>item.field==='ssid'&&item.boxes.some(box=>overlap(box.box,line.box)>.4)))continue;
    targets.push({field:'ssid',value:'',band:line.band,candidate:null,boxes:[{box:line.box,angle:line.angle,aspect:line.aspect}],reads:[]});
  }
  return targets.slice(0,max);
}

const cleanLine=text=>String(text??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).sort((a,b)=>b.length-a.length)[0]||'';
function newBandCandidate(target){
  const counts=new Map();
  for(const read of target.reads){const token=read.split(/\s+/).sort((a,b)=>b.length-a.length)[0]||'';if(/^[\p{L}\p{N}][\p{L}\p{N}_.-]{5,31}$/u.test(token))counts.set(token,(counts.get(token)||0)+1);}
  const best=[...counts].sort((a,b)=>b[1]-a[1])[0];
  if(!best||best[1]<3)return null;
  const label=`SSID ${target.band==='2.4 GHz'?'2.4 GHz':'5 GHz'}`;
  return {value:best[0],fieldType:'ssid',source:'ocr',sourceLabel:label,sourceLine:`${label}: ${best[0]}`,sourcePasses:[],ocrPasses:[],ocrConfidence:null,score:70,confidence:.7,band:target.band,needsReview:true,reason:'Nombre leído línea a línea bajo su etiqueta de banda'};
}

/** Aplica la votación a los candidatos; devuelve cuántos datos se han podido contrastar. */
export function applyLineReads(parsed,targets){
  let applied=0;
  for(const target of targets){
    if(!target.reads.length)continue;
    const listName=target.field==='ssid'?'ssidCandidates':'passwordCandidates';
    let candidate=target.candidate;
    if(!candidate){
      candidate=newBandCandidate(target);
      // No se sustituye un nombre de esa banda ya bien leído y contrastado.
      if(!candidate||parsed.ssidCandidates.some(item=>item.band===candidate.band&&item.score>=60&&item.lineSupport>=4))continue;
      const sameBand=!parsed.ssid||parsed.ssid.band===candidate.band;
      parsed.ssidCandidates=[candidate,...parsed.ssidCandidates.filter(item=>item.value!==candidate.value&&item.band!==candidate.band)];
      if(sameBand)parsed.ssid={...candidate};
    }
    const format=target.field==='password'?candidate.expectedFormat:null;
    const result=voteCharacters(candidate.value,target.reads,{length:format?.length??null,alphabet:PASSWORD_ALPHABETS[format?.alphabet]||null});
    if(!result.support)continue;
    const before=candidate.value,selected=parsed[target.field]?.value===before;
    if(result.value!==before){candidate.originalValue??=before;candidate.value=result.value;delete candidate.proposedValue;}
    candidate.doubts=result.doubts;candidate.lineSupport=result.support;candidate.appearances=target.boxes.length;
    if(result.doubts.length||result.changes.length||result.weak||result.rebased)candidate.needsReview=true;
    parsed[listName]=parsed[listName].filter(item=>item===candidate||item.value!==candidate.value||item.band!==candidate.band);
    if(selected)parsed[target.field]={...candidate};
    applied++;
  }
  return applied;
}

export async function readValueLines(blob,{targets,signal,recognizeLine,crop,variants=LINE_VARIANTS,budgetMs=LINE_BUDGET_MS,onStage=()=>{},now=()=>performance.now()}){
  const started=now();let reads=0,failures=0;
  // Una variante para cada dato antes de pasar a la siguiente: si se acaba el tiempo, todos tienen lecturas.
  rounds:for(const variant of variants)for(const target of targets)for(const place of target.boxes){
    if(signal?.aborted){const error=new Error('Análisis cancelado.');error.name='AbortError';throw error;}
    if(now()-started>=budgetMs)break rounds;
    try{
      onStage('Comprobando carácter a carácter');
      const image=await crop(blob,place,variant,{signal});
      const text=cleanLine(await recognizeLine(image,{signal}));reads++;
      if(text)target.reads.push(text);
    }catch(error){if(error?.name==='AbortError')throw error;if(++failures>=2)break rounds;}
  }
  return {reads,durationMs:Math.max(0,Math.round(now()-started))};
}
