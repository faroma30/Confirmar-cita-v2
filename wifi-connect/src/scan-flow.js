/** Select the smallest safe next step for the production scan UX. */
const passwordOrigin=/\b(?:password|passvvord|contrase[nñ]a|contrasenya|clau|clave|wlan\s*k(?:ey|ev|cy)?|wi[\s-]?fi\s*(?:key|password)|wireless\s*(?:key|password)|network\s*(?:key|password)|admin|administrator|router|login|access|wps|serial|s\/?n|mac|bssid|imei|model|gateway|barcode|bar\s+code|pin)\b/iu;
const explicitSsidOrigin=/^(?:ssid(?:\s*(?:[12]|[il])|\s+(?:2\s*[.,]?\s*4\s*(?:ghz|g)?|5\s*(?:ghz|g)?))?|(?:red\s+)?wi[ -]?f[i1l](?:\s+red)?|nombre\s+(?:de\s+)?wi[ -]?f[i1l]|(?:nom\s+(?:de\s+)?(?:xarxa|wi[ -]?f[i1l])|xarxa\s+wi[ -]?f[i1l])|(?:wi[ -]?fi|wlan)\s*(?:name|nombre)|(?:wireless|network)\s+name|nombre\s+(?:de\s+)?(?:wi[ -]?fi|red)|red\s+(?:wi[ -]?fi|wlan))$/iu;
const proximityOrigin='Proximidad a etiqueta de contrasena Wi-Fi';
export function isSafeSsidCandidate(candidate){
 if(candidate?.fieldType!=='ssid'||candidate?.source==='password'||typeof candidate.value!=='string'||!candidate.value.trim()||candidate.value.length>64)return false;
 const label=String(candidate.sourceLabel||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
 if(label===proximityOrigin)return candidate.needsReview===true&&/contraseña wi-fi/i.test(candidate.reason||'');
 if(candidate.source?.startsWith('qr'))return label==='QR Wi-Fi'&&Boolean(candidate.value);
 if(passwordOrigin.test(label))return false;
 return explicitSsidOrigin.test(label);
}
export function isSafePasswordCandidate(candidate){
 if(candidate?.fieldType!=='password'||candidate?.source==='ssid'||typeof candidate.value!=='string'||!candidate.value.trim())return false;
 return !/^(?:admin|administrator|router|login|access)(?:\s+login)?\s+(?:password|pass|key|credential|contrase[nñ]a|clave|pin)$/iu.test(String(candidate.sourceLabel||'').trim());
}
const isFieldCandidate=(candidate,field)=>field==='ssid'?isSafeSsidCandidate(candidate):field==='password'?isSafePasswordCandidate(candidate):candidate?.fieldType===field;
export function buildScanPlan(parsed,{selectedCandidate=null}={}){
 // Keep plausible but weak OCR candidates available for human review. The
 // former >=60 gate could discard every SSID while the diagnostic still had
 // candidates, turning a recoverable scan into the generic "could not read"
 // screen. Scores below 60 may never be used without an explicit review.
 const candidates=(parsed?.ssidCandidates||[]).filter(candidate=>isFieldCandidate(candidate,'ssid')&&candidate.score>=40&&candidate.source!=='password');
 const password=isFieldCandidate(parsed?.password,'password')?parsed.password:null;
 const qrNetworks=[];const seenQr=new Set();
 for(const candidate of candidates){if(!candidate.qrNetworkId||!candidate.qrNetwork)continue;if(seenQr.has(candidate.qrNetworkId))continue;seenQr.add(candidate.qrNetworkId);qrNetworks.push(candidate);}
 if(qrNetworks.length>1&&!isFieldCandidate(selectedCandidate,'ssid'))return {state:'choose-band',choices:qrNetworks.map((candidate,index)=>({...candidate,selectionLabel:candidate.band||`Red detectada ${index+1}`})),fields:[]};
 const activeCandidate=isFieldCandidate(selectedCandidate,'ssid')?selectedCandidate:candidates.find(candidate=>candidate.value===parsed?.ssid?.value)||candidates[0]||null;
 const selectedQr=activeCandidate?.qrNetwork||null;
 const activePassword=selectedQr?(selectedQr.password?{value:selectedQr.password,fieldType:'password',source:'qr',sourceLabel:'QR Wi-Fi',sourceLine:'QR Wi-Fi emparejado',score:110,confidence:1,qrNetworkId:activeCandidate.qrNetworkId}:null):password;
 const activeSecurity=selectedQr?.security||parsed?.security?.value;
 const bands=new Map();
 for(const candidate of candidates){if(!candidate.band)continue;const list=bands.get(candidate.band)||[];list.push(candidate);bands.set(candidate.band,list);}
 const choices=[...bands.entries()].filter(([,items])=>items.length).map(([band,items])=>({...items.sort((a,b)=>Number(Boolean(b.corrected))-Number(Boolean(a.corrected))||Number(Boolean(b.qrAgreement))-Number(Boolean(a.qrAgreement))||b.score-a.score)[0],band}));
 if(choices.length>1&&!isFieldCandidate(selectedCandidate,'ssid'))return {state:'choose-band',choices};
 const primary=activeCandidate;
 if(!primary){if(!activePassword&&activeSecurity!=='Sin contraseña')return {state:'error',choices:[]};return {state:'review',choices:[],candidate:null,fields:['ssid']};}
 const selected={...primary,selectionReason:primary.source?.startsWith('qr')?'Credencial SSID de QR Wi-Fi':`Mejor candidato tipado SSID: ${primary.reason||'sin motivo adicional'}`};
 const ssidConflict=Boolean(parsed?.qrConflicts?.ssid),passwordConflict=Boolean(parsed?.qrConflicts?.password);
 const qrTrusted=candidate=>candidate?.source?.startsWith('qr');
 // `score` is parser/ranking evidence, not an OCR confidence. Only the OCR
 // engine's pass confidence may satisfy this automatic-use threshold.
 // Preserve the existing password-review threshold; this phase changes SSID
 // review coherence only. Password payloads are never part of diagnostics.
 const highConfidencePassword=Number(password?.score)>=90&&password?.source!=='qr'&&/Etiqueta de contraseña Wi-Fi/i.test(password?.reason||'');
 // Matching OCR strings are useful comparison data, but repeated page passes
 // alone are correlated evidence and must not bypass the confidence threshold.
 const ocrConfidenceNeedsReview=candidate=>Boolean(candidate&& !candidate.source?.startsWith('qr')&&(!Number.isFinite(candidate.ocrConfidence)||candidate.ocrConfidence<90));
 const passwordOcrConfidenceNeedsReview=candidate=>Boolean(candidate&&!qrTrusted(candidate)&&(!Number.isFinite(candidate.ocrConfidence)||candidate.ocrConfidence<90));
 const passStatus=candidate=>candidate?.ocrVerification?.status||(candidate?.ocrVerification?.mismatchedPassCount>0?'disagreement':candidate?.ocrVerification?.exactAgreement?'agreement':'insufficient');
 const ssidUnverified=Boolean(primary.ocrVerification&&passStatus(primary)==='disagreement'&&!qrTrusted(primary));
 const passwordUnverified=Boolean(activePassword?.ocrVerification&&passStatus(activePassword)==='disagreement'&&!qrTrusted(activePassword));
 const crossFieldContamination=detectCrossFieldContamination(parsed,primary);
 const ssidNeedsReview=Boolean(primary.score<60||crossFieldContamination||ssidConflict||ssidUnverified||primary.bandPeerConflict||ocrConfidenceNeedsReview(primary)||primary.needsReview&&!primary.qrAgreement&&!qrTrusted(primary));
 const passwordNeedsReview=activeSecurity!=='Sin contraseña'&&(!activePassword||passwordConflict||passwordUnverified||passwordOcrConfidenceNeedsReview(activePassword)||activePassword.needsReview&&!activePassword.qrAgreement&&!qrTrusted(activePassword)&&!highConfidencePassword);
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
 if(safeSsid?.qrNetwork){const network=safeSsid.qrNetwork;return {ssid:network.ssid,password:network.password||'',security:network.security||'WPA/WPA2',hidden:Boolean(network.hidden),note:'',source:'router_scan',origin:'router_scan',band:safeSsid.band||''};}
 const safePassword=isFieldCandidate(parsed?.password,'password')?parsed.password:null;
 const sameSource=Boolean(safeSsid?.sourceLine&&safePassword?.sourceLine&&safeSsid.sourceLine===safePassword.sourceLine&&safeSsid.sourceLabel===safePassword.sourceLabel);
 const contaminated=Boolean(safeSsid&&safePassword&&safeSsid.value===safePassword.value&&sameSource);
 // Structural OCR proposals are useful defaults for an editable review, but
 // are never promoted to verified data: buildScanPlan forces review first.
 return {ssid:contaminated?'':safeSsid?.proposedValue||safeSsid?.value||'',password:safePassword?.value||'',security:parsed?.security?.value||'WPA/WPA2',hidden:Boolean(qr.hidden),note:'',source:'router_scan',origin:'router_scan',band:safeSsid?.band||''};
}

/** Build a safe review fallback if analysis completed but normal presentation failed. */
export function buildRecoverableScanReview(parsed){
 const candidates=(parsed?.ssidCandidates||[]).filter(item=>isFieldCandidate(item,'ssid')&&typeof item.value==='string'&&item.value.trim().length>0&&item.value.length<=64&&Number(item.score)>=40);
 const candidate=candidates.find(item=>item.value===parsed?.ssid?.value)||candidates[0];
 if(!candidate)return null;
 const network=createScannedNetwork(parsed,candidate);
 const fields=['ssid'];
 const password=parsed?.password;
 const passwordNeedsReview=parsed?.security?.value!=='Sin contraseña'&&(
  !isFieldCandidate(password,'password')
  ||password.source!=='qr'&&(
    Number(password.score)<60
    || (!Number.isFinite(password.ocrConfidence)||password.ocrConfidence<90)
   ||password.needsReview
   ||password.ocrVerification?.status==='disagreement'
  )
 );
 if(passwordNeedsReview)fields.push('password');
 return {network,fields,candidate,reason:'El análisis produjo un candidato SSID; se requiere revisión antes de continuar.'};
}

/** Keep the recent write ahead of the Red lista render. */
export async function persistRecentBeforeReady(network,{saveRecent,showReady}){
 const recent=await saveRecent(network);
 await showReady(recent);
 return recent;
}
