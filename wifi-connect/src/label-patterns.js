/**
 * Formatos de etiqueta confirmados con fotos reales (CONFIRMAR_CITAS-040). El nombre de red solo se propone arreglado
 * (el valor leído se conserva) cuando el prefijo del fabricante se reconoce entero; en la clave solo se corrige un carácter confundible cuando el formato fija
 * el alfabeto y la sustitución es única. Longitud inesperada = dudosa. Un dato de QR no se toca.
 */
import {applyPasswordFormat} from './password-check.js?v=3wl3';

const SEP='[\\s._\\-–—:]*';
const toAlphabet=(text,alphabet)=>{const fixed=applyPasswordFormat(text,{alphabet});return fixed.decided?fixed.value:null;};
export const LABEL_PATTERNS=Object.freeze([
  {id:'adamo',ssid:new RegExp(`^(adamo)${SEP}([0-9OoIlSB]{4})$`,'i'),build:m=>{const d=toAlphabet(m[2],'digits');return d&&`${m[1]}-${d}`;},password:{length:14,alphabet:'upper-digits'}},
  {id:'vera',ssid:new RegExp(`^vera${SEP}([0-9A-FOoIl]{6})$`,'i'),build:m=>{const h=toAlphabet(m[1].toUpperCase(),'hex-upper');return h&&`Vera_${h}`;},password:{length:10,alphabet:'hex-lower'}},
  {id:'huawei',ssid:new RegExp(`^huawei${SEP}(2${SEP},?4|5)\\s*g${SEP}([a-z0-9]{4})$`,'i'),build:m=>`HUAWEI-${m[1].startsWith('2')?'2.4':'5'}G-${m[2]}`,password:{length:8}},
  {id:'livebox6',ssid:new RegExp(`^livebox\\s*6${SEP}([0-9A-FOo]{4})$`,'i'),build:m=>{const h=toAlphabet(m[1].toUpperCase(),'hex-upper');return h&&`Livebox6-${h}`;},password:{length:12}},
  {id:'digifibra',ssid:new RegExp(`^digifibra${SEP}(?:(plus)${SEP})?([a-z0-9]{4})$`,'i'),build:m=>`DIGIFIBRA-${m[1]?'PLUS-':''}${m[2]}`,password:{length:12}}
]);
export function matchSsidPattern(value){
  const text=String(value??'').trim();
  for(const pattern of LABEL_PATTERNS){const match=text.match(pattern.ssid),built=match&&pattern.build(match);if(built)return {pattern,value:built};}
  return null;
}
const addDoubt=(candidate,doubt)=>{candidate.needsReview=true;candidate.doubts=[...(candidate.doubts||[]).filter(item=>item.position!==doubt.position),doubt].sort((a,b)=>a.position-b.position);};
const differences=(before,after)=>[...after].map((to,index)=>({position:index+1,from:before[index]||'',to})).filter(item=>item.from!==item.to);

const shown=candidate=>candidate.proposedValue||candidate.value;
/** Red doble con el mismo sufijo (Huawei, Digi): si los sufijos discrepan, manda la lectura sin dudas; siempre se marca. */
function reconcilePairs(ssids){
  for(const id of ['huawei','digifibra']){
    const list=ssids.filter(item=>item.labelPattern===id&&!item.source?.startsWith('qr')&&item.score>=40&&matchSsidPattern(shown(item)));
    if(list.length<2)continue;
    const suffix=item=>shown(item).slice(-4),doubtful=(item,index)=>(item.doubts||[]).some(d=>d.position===shown(item).length-3+index);
    for(let index=0;index<4;index++){
      const chars=[...new Set(list.map(item=>suffix(item)[index]))];
      if(chars.length<2)continue;
      const sure=[...new Set(list.filter(item=>!doubtful(item,index)&&item.lineSupport>=4).map(item=>suffix(item)[index]))];
      for(const item of list){
        const position=shown(item).length-3+index;
        if(sure.length===1&&suffix(item)[index]!==sure[0]){const value=shown(item);item.proposedValue=value.slice(0,position-1)+sure[0]+value.slice(position);item.corrected=true;item.needsReview=true;}
        addDoubt(item,{position,char:shown(item)[position-1],alternatives:chars.filter(char=>char!==shown(item)[position-1])});
      }
    }
  }
}

export function applyLabelPatterns(parsed){
  const ssids=parsed?.ssidCandidates||[],passwords=parsed?.passwordCandidates||[];
  const selected=Object.fromEntries(['ssid','password'].map(field=>{
    const current=parsed?.[field],list=field==='ssid'?ssids:passwords;
    return [field,current?list.find(item=>item.value===current.value&&item.sourceLine===current.sourceLine)||null:null];
  }));
  for(const candidate of ssids){
    if(candidate.source?.startsWith('qr'))continue;
    const found=matchSsidPattern(shown(candidate));
    if(!found)continue;
    candidate.labelPattern=found.pattern.id;
    if(found.value===shown(candidate))continue;
    // Propuesta editable: el valor leído se conserva y la revisión es obligatoria.
    candidate.originalValue??=candidate.value;candidate.patternCorrections=differences(shown(candidate),found.value);
    candidate.proposedValue=found.value;candidate.corrected=true;candidate.correctionType='label-pattern';candidate.needsReview=true;
  }
  reconcilePairs(ssids);
  const ids=[...new Set(ssids.filter(item=>item.score>=40&&item.labelPattern).map(item=>item.labelPattern))];
  const format=ids.length===1?LABEL_PATTERNS.find(item=>item.id===ids[0]).password:null;
  if(format)for(const candidate of passwords){
    if(candidate.source?.startsWith('qr'))continue;
    candidate.expectedFormat=format;
    if(candidate.value.length!==format.length){candidate.needsReview=true;candidate.lengthMismatch=format.length;continue;}
    delete candidate.lengthMismatch;
    const fixed=applyPasswordFormat(candidate.value,format);
    if(!fixed.decided)continue;
    candidate.formatDecided=true;
    if(fixed.corrections.length){candidate.originalValue??=candidate.value;candidate.value=fixed.value;candidate.characterCorrections=fixed.corrections;candidate.needsReview=true;}
  }
  for(const field of ['ssid','password'])if(selected[field])parsed[field]={...selected[field],confidence:parsed[field].confidence};
  return parsed;
}
