/** Select the smallest safe next step for the production scan UX. */
const passwordOrigin=/^(?:wlan\s*k|wi[\s-]?fi\s*(?:password|key)|(?:contrasenya|contrase[nñ]a|clau|clave|password|passvvord)\b)/iu;
const isFieldCandidate=(candidate,field)=>candidate?.fieldType===field&&!(field==='ssid'&&passwordOrigin.test(String(candidate.sourceLabel||'')));
export function buildScanPlan(parsed,{selectedCandidate=null}={}){
 const candidates=(parsed?.ssidCandidates||[]).filter(candidate=>isFieldCandidate(candidate,'ssid')&&candidate.score>=60&&candidate.source!=='password');
 const password=isFieldCandidate(parsed?.password,'password')?parsed.password:null;
 const bands=new Map();
 for(const candidate of candidates){if(!candidate.band)continue;const list=bands.get(candidate.band)||[];list.push(candidate);bands.set(candidate.band,list);}
 const choices=[...bands.entries()].filter(([,items])=>items.length).map(([band,items])=>({...items.sort((a,b)=>Number(Boolean(b.corrected))-Number(Boolean(a.corrected))||Number(Boolean(b.qrAgreement))-Number(Boolean(a.qrAgreement))||b.score-a.score)[0],band}));
 if(choices.length>1&&!isFieldCandidate(selectedCandidate,'ssid'))return {state:'choose-band',choices};
 const primary=isFieldCandidate(selectedCandidate,'ssid')?selectedCandidate:candidates.find(candidate=>candidate.value===parsed?.ssid?.value)||candidates[0]||null;
 if(!primary){if(!password&&parsed?.security?.value!=='Sin contraseña')return {state:'error',choices:[]};return {state:'review',choices:[],candidate:null,fields:['ssid']};}
 const selected={...primary,selectionReason:primary.source?.startsWith('qr')?'Credencial SSID de QR Wi-Fi':`Mejor candidato tipado SSID: ${primary.reason||'sin motivo adicional'}`};
 const ssidConflict=Boolean(parsed?.qrConflicts?.ssid),passwordConflict=Boolean(parsed?.qrConflicts?.password);
 const qrTrusted=candidate=>candidate?.source?.startsWith('qr');
 const taggedOcrCandidate=(candidate,field)=>candidate?.score>=90&&candidate?.source!=='qr'&&new RegExp(`Etiqueta ${field==='ssid'?'SSID':'de contraseña Wi-Fi'}`,'i').test(candidate?.reason||'');
 const highConfidenceTaggedOcr=taggedOcrCandidate(primary,'ssid')||primary?.corrected&&primary.correctionConfidence==='high'&&Number(primary.correctionScore)>=7;
 const highConfidencePassword=taggedOcrCandidate(password,'password');
 const trustedProposal=primary.corrected&&primary.correctionConfidence==='high'&&Number(primary.correctionScore)>=7;
 const ssidUnverified=Boolean(primary.ocrVerification&&!primary.ocrVerification.exactAgreement&&!qrTrusted(primary));
 const passwordUnverified=Boolean(password?.ocrVerification&&!password.ocrVerification.exactAgreement&&!qrTrusted(password));
 const crossFieldContamination=detectCrossFieldContamination(parsed,primary);
 const ssidNeedsReview=Boolean(crossFieldContamination||ssidConflict||ssidUnverified||primary.needsReview&&!primary.qrAgreement&&!qrTrusted(primary)&&!highConfidenceTaggedOcr&&!trustedProposal);
 const passwordNeedsReview=parsed?.security?.value!=='Sin contraseña'&&(!password||passwordConflict||passwordUnverified||password.needsReview&&!password.qrAgreement&&!qrTrusted(password)&&!highConfidencePassword);
 const fields=[...(ssidNeedsReview?['ssid']:[]),...(passwordNeedsReview?['password']:[])];
 if(fields.length)return {state:'review',choices:[selected],candidate:selected,fields};
 return {state:'ready',choices:[selected],candidate:selected,fields:[]};
}

export function detectCrossFieldContamination(parsed,selectedSsid=null){
 const ssid=selectedSsid||parsed?.ssid,password=parsed?.password;
 if(!ssid||!password)return Boolean(ssid&&ssid.fieldType!=='ssid'||password&&password.fieldType!=='password');
 const sameSource=Boolean(ssid.sourceLine&&password.sourceLine&&ssid.sourceLine===password.sourceLine&&ssid.sourceLabel===password.sourceLabel);
 return ssid===password||!isFieldCandidate(ssid,'ssid')||!isFieldCandidate(password,'password')||ssid.value===password.value&&sameSource;
}

export function fieldSource(parsed,field){
 const candidate=parsed?.[field];if(!candidate)return 'none';
 if(candidate.source?.startsWith('qr'))return candidate.source==='qr+ocr'?'qr+ocr':'qr';
 const passes=candidate.ocrPasses||candidate.sourcePasses?.map(item=>item.pass)||[];
 if(passes.length>1)return 'ocr-a+b';
 if(passes[0])return passes[0]==='grayscale-contrast'?'ocr-b':'ocr-a';
 return candidate.sourceLabel&&!candidate.sourceLabel.startsWith('Proximidad')?'ocr-labeled':'ocr-context';
}

export function createScannedNetwork(parsed,candidate,qr={}){
 const safeSsid=isFieldCandidate(candidate,'ssid')&&candidate?.source!=='password'?candidate:null;
 const safePassword=isFieldCandidate(parsed?.password,'password')?parsed.password:null;
 const sameSource=Boolean(safeSsid?.sourceLine&&safePassword?.sourceLine&&safeSsid.sourceLine===safePassword.sourceLine&&safeSsid.sourceLabel===safePassword.sourceLabel);
 const contaminated=Boolean(safeSsid&&safePassword&&safeSsid.value===safePassword.value&&sameSource);
 return {ssid:contaminated?'':safeSsid?.proposedValue||safeSsid?.value||'',password:safePassword?.value||'',security:parsed?.security?.value||'WPA/WPA2',hidden:Boolean(qr.hidden),note:'',source:'router_scan',origin:'router_scan',band:safeSsid?.band||''};
}

/** Keep the recent write ahead of the Red lista render. */
export async function persistRecentBeforeReady(network,{saveRecent,showReady}){
 const recent=await saveRecent(network);
 await showReady(recent);
 return recent;
}
