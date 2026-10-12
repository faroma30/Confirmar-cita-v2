import {detectOperator} from './operator-detector.js';
import {getOperatorProfile} from './operator-profiles/index.js';

const SSID_LABELS = [
  [/^(?:ssid|ss[i1l]d)(?:\s*(?:[12]|[il])|\s+(?:2[.,]?4\s*(?:ghz|g)?|5\s*(?:ghz|g)?))?$/, 100, 'Etiqueta SSID'],
  [/^(?:red\s+)?wi[ -]?f[i1l](?:\s+red)?$/, 100, 'Etiqueta RED Wi-Fi'],
  [/^nombre\s+(?:de\s+)?wi[ -]?f[i1l]$/, 100, 'Etiqueta Nombre Wi-Fi'],
  [/^(?:nom\s+(?:de\s+)?(?:xarxa|wi[ -]?f[i1l])|xarxa\s+wi[ -]?f[i1l])$/, 100, 'Etiqueta catalana de nombre de red'],
  [/^(?:wi[ -]?fi|wlan)\s*(?:name|nombre)$/, 92, 'Etiqueta de nombre Wi-Fi'],
  [/^(?:wi[ -]?fi|wlan)$/, 78, 'Etiqueta Wi-Fi/WLAN'],
  [/^(?:wireless|network)\s+name$/, 88, 'Etiqueta de nombre de red'],
  [/^(?:nombre\s+(?:de\s+)?(?:wi[ -]?fi|red)|red\s+(?:wi[ -]?fi|wlan))$/, 90, 'Etiqueta de nombre de red']
];
const PASSWORD_LABELS = [
  [/^(?:contrase[nñ][yvi]a\s+(?:wpa[23]?|wi[ -]?f[i1l]|de\s+xarxa)|clau\s+(?:(?:de\s+)?(?:wi[ -]?f[i1l]|xarxa)))$/, 100, 'Etiqueta catalana de contraseña Wi-Fi'],
  [/^contrasenya$/, 52, 'Etiqueta genérica catalana de contraseña'],
  [/^(?:clave|cl[vw]ave)\s+(?:de\s+)?wi[ -]?f[i1l]$/, 100, 'Etiqueta CLAVE Wi-Fi'],
  [/^(?:wi[ -]?fi|wlan)\s*(?:password|passvvord|passw[o0]rd|key|kev|kcy|clave|contrase[nñ]a)$/, 100, 'Etiqueta de contraseña Wi-Fi'],
  [/^(?:wpa\s*[- ]?psk|wpa[23]?\s*[- ]?(?:key|clave)|pre[ -]?shared\s+key|psk)$/, 98, 'Etiqueta de clave WPA/PSK'],
  [/^(?:wireless|network)\s+(?:key|password|clave|contrase[nñ]a)$/, 94, 'Etiqueta de clave de red'],
  [/^(?:clave\s+(?:de\s+)?(?:wi[ -]?fi|wlan|red)|contrase[nñ]a\s+(?:de\s+)?(?:wi[ -]?fi|wlan|red))$/, 98, 'Etiqueta de contraseña de red'],
  [/^(?:password|passvvord|passw[o0]rd|contrase[nñ]a|clave)$/, 52, 'Etiqueta genérica de contraseña'],
  [/^key$/, 58, 'Etiqueta genérica Key con contexto Wi-Fi']
];

const normalizeLabel = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[：＝]/g, ':').replace(/\s+/g, ' ').trim().replace(/\s*[:=]\s*$/, '').trim();
const cleanCandidate = value => String(value || '').replace(/^\s*[:=\-–—]\s*/, '').replace(/\s+$/, '').trim();
const isMac = value => /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value.replace(/\s/g, '')) || /^(?:[0-9a-f]{4}[.]){2}[0-9a-f]{4}$/i.test(value);
const isIpOrNumericPin = value => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || /^\d{4,10}$/.test(value);
const isSerialContext = label => /^(?:s\/?n|sn|serial(?:\s+number)?|serial number)$/i.test(label);
const isAdminContext = (label, lines, index) => {
 if ((/\b(?:admin|administrator|web|router|login)\b/.test(label) && /\b(?:password|pass|key|credential|contrase[nñ]a|clave|pin)\b/.test(label)) || /^(?:admin|administrator|web|login)$/i.test(label)) return true;
 if (!/^(?:password|passvvord|passw[o0]rd|contrase[nñ]a|contrasenya|clave)$/i.test(label)) return false;
 const context=lines.slice(Math.max(0,index-4),index).join(' ');
 const userContext=/^(?:username|user name|user|login|account|usuario)\s*[:=]/i.test(lines[index-1]||'')||/\b(?:username|user\s*name|1semame|usename|root|admin|login)\b/i.test(context);
 const managementIp=/\bIP\b[^\n]{0,48}\b192[. ]+168[. ]+100[. ]+1\b/i.test(context);
 return userContext || (managementIp && /\badmin/i.test(splitLabel(lines[index])[1]||''));
};
const isWpsContext = label => /\bwps\b/.test(label);
const plausible = (value, allowNumericPin = false) => value.length > 0 && value.length <= 2048 && !isMac(value) && (!isIpOrNumericPin(value) || (allowNumericPin && /^\d{4,10}$/.test(value))) && !/^https?:\/\//i.test(value);

function findLabel(label, table) {
  const key = normalizeLabel(label);
  return table.find(([pattern]) => pattern.test(key));
}
function splitLabel(line) {
  const match = line.match(/^\s*(.{1,64}?)\s*[:=：＝]\s*(.*?)\s*$/);
  if (!match) {
    const text=String(line||'').trim();
    if(findLabel(text,SSID_LABELS)||findLabel(text,PASSWORD_LABELS))return {label:text,value:''};
    const boundaries=[...text.matchAll(/\s+/g)].map(item=>item.index).reverse();
    for(const boundary of boundaries){
      const label=text.slice(0,boundary).trim(),value=text.slice(boundary).trim();
      if(value&&(findLabel(label,SSID_LABELS)||findLabel(label,PASSWORD_LABELS)))return {label,value};
    }
    return {label:text,value:''};
  }
  return { label: match[1].trim(), value: match[2].trim() };
}
function embeddedWlanKey(line){
 if(String(line).length>180)return null;
 const match=String(line).match(/(?:^|[^\p{L}\p{N}])WLAN\s*K(?:ey|ev|cy)\s*(?::|=|：|＝|[’'`])\s*(.*?)\s*$/iu);
 if(!match)return null;
 return {label:'WLAN Key',value:match[1].trim(),delimiter:/[:=：＝]/.test(match[0])};
}
function ssidBand(sourceLine){const match=String(sourceLine).match(/(?:^|[^\p{L}\p{N}])SS[i1l]D\s*([12]|[il])\b/i);return match?String(match[1]).toLowerCase().replace(/[il]/,'1'):null;}
function bandToken(value){
 const text=String(value||'');
 const five=text.match(/(^|[-_ ])(5\s*(?:\.\s*0|,\s*0)?\s*G(?:Hz)?)(?=$|[-_ ])/i);
 if(five)return {band:'5 GHz',start:five.index+five[1].length,end:five.index+five[1].length+five[2].length,raw:five[2],standard:'5G',strength:3};
 const four=text.match(/(^|[-_ ])(2\s*(?:[.,]\s*|\s+)4\s*G(?:Hz)?|24\s*G(?:Hz)?)(?=$|[-_ ])/i);
 if(four)return {band:'2.4 GHz',start:four.index+four[1].length,end:four.index+four[1].length+four[2].length,raw:four[2],standard:'2.4G',strength:/^2\s*[.,]/i.test(four[2])?3:2};
 return null;
}
function annotateSsidBands(candidates){
 for(const candidate of candidates){const token=bandToken(candidate.value);if(token)candidate.band=token.band;}
 for(const candidate of candidates){
  const token=bandToken(candidate.value);if(!token||token.band!=='2.4 GHz')continue;
  const peers=candidates.filter(other=>other!==candidate&&ssidBand(other.sourceLine)&&bandToken(other.value)?.band==='5 GHz');
  let best=null;
  for(const peer of peers){
   const peerToken=bandToken(peer.value);const left=candidate.value.slice(0,token.start),right=candidate.value.slice(token.end),rightForMatch=right.replace(/\s+[-–—]+\s*$/,'').replace(/\s+\d\s*$/,''),peerLeft=peer.value.slice(0,peerToken.start),peerRight=peer.value.slice(peerToken.end);
   let prefix=0;while(prefix<left.length&&prefix<peerLeft.length&&left[prefix].toLowerCase()===peerLeft[prefix].toLowerCase())prefix++;
   let suffix=0;while(suffix<rightForMatch.length&&suffix<peerRight.length&&rightForMatch[rightForMatch.length-1-suffix].toLowerCase()===peerRight[peerRight.length-1-suffix].toLowerCase())suffix++;
   const prefixText=left.slice(0,prefix),suffixText=rightForMatch.slice(rightForMatch.length-suffix);
    const compatible=prefixText.replace(/[^\p{L}\p{N}]/gu,'').length>=3&&suffixText.replace(/[^\p{L}\p{N}]/gu,'').length>=2;
   const contextualScore=(token.strength===2?1:2)+(peer.score>=80?2:1)+(compatible?4:0)+(ssidBand(candidate.sourceLine)?1:0);
   if(compatible&&contextualScore>=7&&(!best||contextualScore>best.score)){
    const proposedValue=`${prefixText}2.4G${suffixText}`.replace(/\s+$/,'');
    best={score:contextualScore,peer,proposedValue,prefixText,suffixText,tokenText:token.raw};
   }
  }
  if(best){candidate.proposedValue=best.proposedValue;candidate.corrected=true;candidate.correctionType='wifi-band-context';candidate.correctionConfidence='high';candidate.correctionScore=best.score;candidate.correctionReason=`SSID emparejada con ${best.peer.value}, que indica 5 GHz y comparte prefijo y sufijo`;candidate.proposedFrom=candidate.value;candidate.correctionDiff=`${best.tokenText} → 2.4G`;candidate.needsReview=true;}
  else if(/^\s*SS[i1l]D\s*[:=]/i.test(candidate.sourceLine)){candidate.bandConfidence=token.strength===2?'low':'medium';candidate.possibleBand='2.4 GHz';}
 }
}
function scoreValue(value, base, kind) {
  let score = base;
  if (!value) return score;
  if (value.length >= 8 && value.length <= 63) score += kind === 'password' ? 8 : 4;
  else if (value.length <= 3) score -= 18;
  else if (value.length > 63) score -= 16;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) score += 3;
  if (/[\s]/.test(value) && kind === 'ssid') score += 2;
  return Math.max(0, Math.min(100, score));
}
function addCandidate(list, value, score, reason, sourceLine, kind, sourceLabel = '') {
  const candidateValue = cleanCandidate(value);
  const explicitPassword = kind === 'password' && /Etiqueta|contexto Wi-Fi|QR Wi-Fi/.test(reason);
  if (!plausible(candidateValue, explicitPassword)) return;
  const old = list.find(item => item.value === candidateValue);
  const candidateScore=scoreValue(candidateValue,score,kind);
  const candidate = { value: candidateValue, fieldType: kind, sourceLabel, sourceLine, sourcePasses:[], ocrPasses:[], ocrConfidence:null, score:candidateScore, confidence:Math.min(1,candidateScore/100), reason };
  if (old) {
    if (candidate.score > old.score) Object.assign(old, candidate);
    return;
  }
  list.push(candidate);
}
function editDistanceAtMostTwo(left,right){
 const a=String(left||''),b=String(right||'');if(a===b)return 0;if(Math.abs(a.length-b.length)>2)return 3;
 let previous=Array.from({length:b.length+1},(_,index)=>index);
 for(let row=1;row<=a.length;row++){const current=[row];let min=row;for(let col=1;col<=b.length;col++){const value=Math.min(current[col-1]+1,previous[col]+1,previous[col-1]+(a[row-1]===b[col-1]?0:1));current.push(value);min=Math.min(min,value);}if(min>2)return 3;previous=current;}
 return previous[b.length];
}
function compareCredentialAcrossPasses(candidate,field,passes){
 if(!passes.length||candidate?.source?.startsWith('qr'))return;
 let exactPassCount=0,mismatchedPassCount=0,missingPassCount=0;
 for(const pass of passes){
  const passText=String(pass.normalizedText||pass.rawText||'');
  const passParsed=parseRouterLabel({rawText:pass.rawText??passText,normalizedText:passText,passes:[]});
  const passCandidates=field==='ssid'?passParsed.ssidCandidates:passParsed.passwordCandidates;
  const exact=passCandidates.some(item=>item.value===candidate.value);
  if(exact){exactPassCount++;continue;}
  const nearCandidate=passCandidates.some(item=>editDistanceAtMostTwo(item.value,candidate.value)<=2);
  // SSIDs can be present as unlabelled lines and missed by a parser pass (for example when
  // OCR adds punctuation or replaces an underscore with a space). Nearness is only evidence
  // of uncertainty; it never rewrites the detected value.
  const nearSsidLine=field==='ssid'&&passText.split(/\r?\n/).some(line=>{
   const value=line.trim();if(value.length<4||value.length>64||/\b(?:ssid|contrasenya|password|clave|wpa|mac|serial|username|admin|wps)\b/i.test(value))return false;
   const candidateLike=/[\p{L}\p{N}]/u.test(value)&&/[\p{L}\p{N}_-]/u.test(value);
   const compared=value.replace(/^[^\p{L}\p{N}]+/u,'');
   return candidateLike&&compared!==candidate.value&&editDistanceAtMostTwo(compared,candidate.value)<=2;
  });
  if(nearCandidate||nearSsidLine)mismatchedPassCount++;else missingPassCount++;
 }
 const exactAgreement=passes.length>=2&&exactPassCount===passes.length;
 candidate.ocrVerification={passCount:passes.length,exactPassCount,mismatchedPassCount,missingPassCount,exactAgreement};
 if(!exactAgreement)candidate.needsReview=true;
}
const stopLine = line => {
  const { label } = splitLabel(line);
  return Boolean(findLabel(label, SSID_LABELS) || findLabel(label, PASSWORD_LABELS) || /^(?:security|encryption|wpa[23]?|wep|mac(?: address)?|wps(?: pin)?|s\/?n|sn|serial(?: number)?|pin|ip|gateway|username)$/i.test(normalizeLabel(label)));
};

export function parseRouterLabel(input = {}, {operatorProfiles: profilesEnabled = true} = {}) {
  const rawText = input?.rawText ?? '';
  const text = String(input?.normalizedText !== undefined ? input.normalizedText : rawText);
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const ssidCandidates = [];
  const passwordCandidates = [];
  const excluded = [];
  const excludedValueLines = new Set();

  // Values immediately following a password label belong only to that field,
  // even when their shape resembles an SSID.
  const passwordValueLines = new Set();
  lines.forEach((line,index)=>{
    const embedded=embeddedWlanKey(line),split=splitLabel(line),{label,value}=embedded||split;
    if(findLabel(label,PASSWORD_LABELS)&&!value&&lines[index+1]&&!stopLine(lines[index+1]))passwordValueLines.add(index+1);
  });

  lines.forEach((line, index) => {
    if (excludedValueLines.has(index)) { excluded.push({ value: line, sourceLine: lines[index - 1] || line, reason: 'Valor de identificador/credencial excluida' }); return; }
    const embeddedKey=embeddedWlanKey(line);
    const split=splitLabel(line);
    const { label, value } = embeddedKey||split;
    const normalizedLabel = normalizeLabel(label);
    const ssidLabel = findLabel(label, SSID_LABELS);
    let passwordLabel = findLabel(label, PASSWORD_LABELS);
    if(embeddedKey&&passwordLabel&&!embeddedKey.delimiter)passwordLabel=[passwordLabel[0],Math.min(passwordLabel[1],50),passwordLabel[2]];

    if (isSerialContext(normalizedLabel) || /^mac(?:\s+address)?$/i.test(normalizedLabel) || isWpsContext(normalizedLabel) || isAdminContext(normalizedLabel, lines, index)) {
      if (value) excluded.push({ value, sourceLine: line, reason: isWpsContext(normalizedLabel) ? 'WPS PIN excluido' : isAdminContext(normalizedLabel, lines, index) ? 'Credencial administrativa excluida' : 'Identificador excluido' });
      else if (lines[index + 1]) excludedValueLines.add(index + 1);
      return;
    }

    if (ssidLabel) {
      if (value) addCandidate(ssidCandidates, value, ssidLabel[1], `${ssidLabel[2]}: valor en la misma línea`, line, 'ssid',label);
      else {
        const next = lines[index + 1];
        if (next && !stopLine(next)) addCandidate(ssidCandidates, next, Math.max(68, ssidLabel[1] - 28), `${ssidLabel[2]}: valor en la línea siguiente`, line, 'ssid',label);
      }
    }

    if (passwordLabel) {
      if (value) addCandidate(passwordCandidates, value, passwordLabel[1], `${passwordLabel[2]}: valor en la misma línea`, line, 'password',label);
      else {
        const next = lines[index + 1];
        if (next && !stopLine(next)) addCandidate(passwordCandidates, next, Math.max(62, passwordLabel[1] - 28), `${passwordLabel[2]}: valor en la línea siguiente`, line, 'password',label);
      }
    }

    // A standalone “Key” is weak evidence; accept only when the document also has Wi-Fi context.
    if (normalizeLabel(label) === 'key' && value && /\b(?:wi[ -]?fi|wlan|ssid|wpa)\b/i.test(text)) {
      addCandidate(passwordCandidates, value, 58, 'Key con contexto Wi-Fi', line, 'password',label);
    }

    // Preserve plausible unlabelled SSID-like values as low-score diagnostic candidates.
    if (!ssidLabel && !passwordLabel && !value && !passwordValueLines.has(index) && /^[\p{L}\p{N}][\p{L}\p{N}_ .-]{2,63}$/u.test(line) && !stopLine(line) && !/\b(?:router|model|gateway|internet|security|encryption|wifi|wi-fi|wlan|ssid|password|serial|mac|pin|contrasenya|clave|contraseña|clau)\b/i.test(line)) {
      const nextLines=lines.slice(index+1,index+3);
      const adjacentWifiPassword=nextLines.some(nextLine=>{const {label:nextLabel}=splitLabel(nextLine);const match=findLabel(nextLabel,PASSWORD_LABELS);return Boolean(match&&/Wi-Fi|catalana|WPA/i.test(match[2]));});
      const networkShaped=/[_-].*\d|\d.*[_-]/u.test(line);
      if(adjacentWifiPassword&&(networkShaped||(/[\p{L}]/u.test(line)&&/\d/u.test(line)&&line.trim().length>=6))) {
        addCandidate(ssidCandidates,line,82,'Nombre de red probable antes de etiqueta de contraseña Wi-Fi',line,'ssid','Proximidad a etiqueta de contraseña Wi-Fi');
        const candidate=ssidCandidates.find(item=>item.value===cleanCandidate(line));if(candidate)candidate.needsReview=true;
      } else addCandidate(ssidCandidates, line, 22, 'Cadena plausible sin etiqueta', line, 'ssid','');
    }
  });

  const explicitWlanKey=passwordCandidates.find(candidate=>/\bWLAN\s*K(?:ey|ev|cy)\b/i.test(candidate.sourceLine));
  if(explicitWlanKey){
    for(let index=passwordCandidates.length-1;index>=0;index--){
      const candidate=passwordCandidates[index];
      if(/^\s*(?:password|passvvord|passw[o0]rd)\s*[:=]/i.test(candidate.sourceLine)){
        excluded.push({value:candidate.value,sourceLine:candidate.sourceLine,reason:'Contraseña genérica no propuesta porque se detectó una WLAN Key explícita'});
        passwordCandidates.splice(index,1);
      }
    }
  }

  const qr=input?.qr?.type==='wifi'&&input.qr.ssid?input.qr:null;
  let qrSsidCandidate=null,qrPasswordCandidate=null,qrConflict=false,qrAgreement=false,qrSecurityConflict=false,qrSsidConflict=false,qrPasswordConflict=false;
  if(qr){
    const ocrSsid=ssidCandidates.filter(candidate=>candidate.score>=40);
    const ocrPasswords=passwordCandidates.filter(candidate=>candidate.score>=40);
    const ocrSecurity=detectSecurity(lines);
    const ssidMatch=ocrSsid.find(candidate=>candidate.value===qr.ssid);
    // OCR often continues an SSID line into adjacent serial/barcode text. When
    // the exact QR SSID is intact at the start and followed by a separator,
    // treat it as partial corroboration rather than a competing network.
    const ssidPartialMatch=ocrSsid.find(candidate=>candidate.value.slice(0,qr.ssid.length).toLowerCase()===qr.ssid.toLowerCase()&&/^[\s:|,;—–-]/.test(candidate.value.slice(qr.ssid.length)));
    const ssidCorroborated=Boolean(ssidMatch||ssidPartialMatch);
    const passwordMatch=qr.password?ocrPasswords.find(candidate=>candidate.value===qr.password):null;
    const passRecords=Array.isArray(input?.passes)?input.passes:[];
    const corroboratedDisagreement=(candidate,fieldValue)=>candidate.value!==fieldValue&&candidate.score>=70&&passRecords.filter(pass=>String(pass.normalizedText||'').split(/\r?\n/).some(source=>source.trim()===candidate.sourceLine)).length>1;
    // A single OCR disagreement is often label/barcode noise. Keep a QR
    // credential authoritative unless the same competing OCR line survives
    // both independent passes with a strong score.
    qrSsidConflict=ocrSsid.some(candidate=>candidate.value!==qr.ssid&&candidate!==ssidPartialMatch&&corroboratedDisagreement(candidate,qr.ssid));
    qrPasswordConflict=Boolean(qr.password&&ocrPasswords.some(candidate=>candidate.value!==qr.password&&corroboratedDisagreement(candidate,qr.password)));
    qrSecurityConflict=Boolean(qr.security&&!ocrSecurity.inferred&&qr.security!==ocrSecurity.value);
    qrConflict=Boolean(qrSsidConflict||qrPasswordConflict||qrSecurityConflict);
    qrAgreement=Boolean(ssidCorroborated&&(!qr.password||passwordMatch)&&!qrSecurityConflict);
    addCandidate(ssidCandidates,qr.ssid,qrSsidConflict?96:110,'QR Wi-Fi válido','QR Wi-Fi: SSID','ssid','QR Wi-Fi');
    qrSsidCandidate=ssidCandidates.find(candidate=>candidate.value===qr.ssid);
    if(qrSsidCandidate){qrSsidCandidate.source=ssidCorroborated?'qr+ocr':'qr';qrSsidCandidate.qrAgreement=ssidCorroborated;qrSsidCandidate.needsReview=Boolean(qrSsidConflict);}
    if(qr.password){addCandidate(passwordCandidates,qr.password,qrPasswordConflict?96:110,'QR Wi-Fi válido','QR Wi-Fi: contraseña','password','QR Wi-Fi');qrPasswordCandidate=passwordCandidates.find(candidate=>candidate.value===qr.password);if(qrPasswordCandidate){qrPasswordCandidate.source=passwordMatch?'qr+ocr':'qr';qrPasswordCandidate.qrAgreement=Boolean(passwordMatch);qrPasswordCandidate.needsReview=Boolean(qrPasswordConflict);}}
    if(qrSsidConflict)for(const candidate of ocrSsid)if(candidate.value!==qr.ssid&&candidate.score>=70)candidate.needsReview=true;
    if(qrPasswordConflict)for(const candidate of ocrPasswords)if(candidate.value!==qr.password&&candidate.score>=70)candidate.needsReview=true;
  }

  const operator = profilesEnabled ? detectOperator({rawText, normalizedText:text}) : null;
  const appliedProfiles = [];
  const profileDiagnostics = [];
  const selectedOperator = operator?.detected;
  const profile = selectedOperator && operator.confidence !== 'low' ? getOperatorProfile(selectedOperator.id) : null;
  if (profile) {
    appliedProfiles.push(profile.id);
    for (const [field, list] of [['ssid',ssidCandidates],['password',passwordCandidates]]) {
      for (const candidate of list) {
        for (const rule of profile.scoringRules.filter(item=>item.field===field && item.label.test(`${candidate.sourceLine} ${candidate.reason}`))) {
          const scoreBefore = candidate.score;
          candidate.score += rule.delta;
          candidate.scoreBeforeProfile ??= scoreBefore;
          candidate.profileReasons ??= [];
          candidate.profileReasons.push(rule.reason);
          candidate.reason += `; perfil ${profile.name}: +${rule.delta} (${rule.id})`;
          profileDiagnostics.push({profileId:profile.id,field,ruleId:rule.id,delta:rule.delta,scoreBefore,scoreAfter:candidate.score,reason:rule.reason});
        }
      }
    }
  }
  for(const candidate of [...ssidCandidates,...passwordCandidates])candidate.confidence=Math.min(1,candidate.score/100);
  ssidCandidates.sort((a, b) => Number(Boolean(b.source?.startsWith('qr')&&!qrSsidConflict))-Number(Boolean(a.source?.startsWith('qr')&&!qrSsidConflict))||b.score-a.score||Number(Boolean(b.qrAgreement))-Number(Boolean(a.qrAgreement)));
  passwordCandidates.sort((a, b) => Number(Boolean(b.source?.startsWith('qr')&&!qrPasswordConflict))-Number(Boolean(a.source?.startsWith('qr')&&!qrPasswordConflict))||b.score-a.score);
  ssidCandidates.forEach((candidate,index)=>{candidate.selectionReason=index===0?'Candidato mejor puntuado del campo SSID':'Alternativa de menor puntuación del campo SSID';});
  passwordCandidates.forEach((candidate,index)=>{candidate.selectionReason=index===0?'Candidato mejor puntuado del campo contraseña':'Alternativa de menor puntuación del campo contraseña';});
  let security = detectSecurity(lines);
  if(qrSecurityConflict)security.needsReview=true;
  if(qr?.security&&security.inferred)security={value:qr.security,detected:qr.security,inferred:false,confidence:qrAgreement?0.98:0.9,source:'qr',fieldType:'security',sourceLabel:'QR Wi-Fi',sourceLine:'QR Wi-Fi: seguridad',reason:'Seguridad explícita en QR Wi-Fi'};
  const ssid = ssidCandidates[0] ? { ...ssidCandidates[0], confidence: Math.min(1, ssidCandidates[0].score / 100) } : null;
  const password = passwordCandidates[0] ? { ...passwordCandidates[0], confidence: Math.min(1, passwordCandidates[0].score / 100) } : null;
  const warnings = [];
  const passRecords=Array.isArray(input?.passes)?input.passes:[];
  for(const candidate of ssidCandidates)compareCredentialAcrossPasses(candidate,'ssid',passRecords);
  for(const candidate of passwordCandidates)compareCredentialAcrossPasses(candidate,'password',passRecords);
  if(ssidCandidates.some(candidate=>candidate.ocrVerification&&!candidate.ocrVerification.exactAgreement))warnings.push('El SSID no coincide exactamente entre pases OCR; requiere revisión.');
  if(passwordCandidates.some(candidate=>candidate.ocrVerification&&!candidate.ocrVerification.exactAgreement))warnings.push('La contraseña no coincide exactamente entre pases OCR; requiere revisión.');
  for(const candidate of [...ssidCandidates,...passwordCandidates]){
    const sources=passRecords.filter(pass=>String(pass.normalizedText||'').split(/\r?\n/).some(source=>source.trim()===candidate.sourceLine)).map(pass=>({pass:pass.id,text:candidate.sourceLine,score:Number.isFinite(pass.confidence)?pass.confidence:null}));
    if(sources.length){candidate.sourcePasses=sources;candidate.ocrPasses=sources.map(item=>item.pass);candidate.ocrConfidence=Math.max(...sources.map(item=>item.score??0));candidate.ocrScore=candidate.ocrConfidence;candidate.sourceText=candidate.sourceLine;if(candidate.ocrScore<72)candidate.needsReview=true;}
  }
  if(ssid&&ssidCandidates[0])Object.assign(ssid,ssidCandidates[0],{confidence:Math.min(1,ssidCandidates[0].score/100)});
  if(password&&passwordCandidates[0])Object.assign(password,passwordCandidates[0],{confidence:Math.min(1,passwordCandidates[0].score/100)});
  const bandCandidates=new Map();
  for(const candidate of ssidCandidates){const band=ssidBand(candidate.sourceLine);if(band){const items=bandCandidates.get(band)||[];items.push(candidate);bandCandidates.set(band,items);}}
  for(const candidates of bandCandidates.values())if(new Set(candidates.map(candidate=>candidate.value)).size>1)for(const candidate of candidates)candidate.needsReview=true;
  annotateSsidBands(ssidCandidates);
  if (ssidCandidates.filter(c => c.score >= 70).length > 1) warnings.push('Se han encontrado varios SSID; selecciona el correcto.');
  if (!ssid) warnings.push('No se ha podido identificar el nombre Wi-Fi.');
  if (!password && security.value !== 'Sin contraseña') warnings.push('No se ha podido identificar la contraseña Wi-Fi.');
  if (security.inferred) warnings.push('La seguridad no aparece en el texto; se propone WPA/WPA2 por defecto.');
  if(qrAgreement)warnings.push('Los datos del QR Wi-Fi coinciden con el texto de la etiqueta.');
  if(qr&&!qrAgreement&&!qrConflict)warnings.push('Se detectó un QR Wi-Fi; revisa los datos antes de guardarlos.');
  if(qrConflict)warnings.push('El QR Wi-Fi y el texto OCR no coinciden; revisa ambos candidatos antes de continuar.');
  return { ssid, password, security, ssidCandidates, passwordCandidates, securityCandidates:[security], excludedCandidates: excluded, warnings, qrConflicts:{ssid:qrSsidConflict,password:qrPasswordConflict,security:qrSecurityConflict}, operator, appliedProfiles, profileDiagnostics, parserVersion: '2.1-generic+profiles' };
}

function detectSecurity(lines) {
  const joined = lines.join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const openPattern=/(?:SECURITY|ENCRYPTION|SEGURIDAD|CIFRADO)\s*[:=]?\s*(?:OPEN|NONE|NO|NONE\b|OPEN\b)|\bOPEN NETWORK\b|\bSIN CONTRASENA\b|\bNO PASSWORD\b/;
  const open = openPattern.test(joined);
  if (open) return { value: 'Sin contraseña', detected: 'Open', inferred: false, confidence: 0.95, fieldType:'security', sourceLabel:'Seguridad explícita', sourceLine:lines.find(line=>openPattern.test(line))||'', reason: 'Indicación explícita de red abierta' };
  const wpa3 = /WPA\s*[- ]?3|WPA3|SAE/.test(joined);
  if (wpa3) return { value: 'WPA3', detected: 'WPA3/SAE', inferred: false, confidence: 0.9, fieldType:'security', sourceLabel:'WPA3/SAE', sourceLine:lines.find(line=>/WPA\s*[- ]?3|WPA3|SAE/i.test(line))||'', reason: 'Texto WPA3 o SAE detectado' };
  const wep = /\bWEP\b/.test(joined);
  if (wep) return { value: 'WEP', detected: 'WEP', inferred: false, confidence: 0.9, fieldType:'security', sourceLabel:'WEP', sourceLine:lines.find(line=>/\bWEP\b/i.test(line))||'', reason: 'WEP' };
  const wpa2 = /WPA\s*[- ]?2|WPA2/.test(joined);
  const wpa = /\bWPA\b/.test(joined);
  if (wpa2 || wpa) return { value: 'WPA/WPA2', detected: wpa2 ? 'WPA2' : 'WPA', inferred: false, confidence: 0.86, fieldType:'security', sourceLabel:'WPA/WPA2', sourceLine:lines.find(line=>/\bWPA\s*[- ]?2|WPA2|\bWPA\b/i.test(line))||'', reason: 'Texto WPA detectado' };
  return { value: 'WPA/WPA2', detected: null, inferred: true, confidence: 0.4, fieldType:'security', sourceLabel:'', sourceLine:'', reason: 'Seguridad predeterminada; no detectada' };
}
