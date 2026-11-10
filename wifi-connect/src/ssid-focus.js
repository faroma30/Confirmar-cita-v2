/** Locate only named network lines for an optional, bounded OCR retry. */
export function findSsidFocusRegions(blocks,width,height,candidates=[]){
 if(!Array.isArray(blocks)||!Number.isFinite(width)||!Number.isFinite(height))return [];
 const found=[];
 for(const block of blocks)for(const paragraph of block?.paragraphs||[])for(const [lineIndex,line] of (paragraph?.lines||[]).entries()){
  const text=String(line?.text||'').trim().replace(/^[^\p{L}\p{N}]+/u,'');
  // The plain "SSID" label is common on router stickers (including labels
  // where the value is printed on the following line). Accept it as a focus
  // target too; the old expression only recognized SSID1/SSID2.
  const label=text.match(/^(?:SS[i1l]D(?:(?:\s+(2\s*[.,]?\s*4|5)\s*(?:GHz|G)?\b)|(?:\s*([12il]))?)?(?=$|[\s:=\-])|(?:WI[ -]?FI|WLAN|NETWORK|WIRELESS)\s+NAME\b|NOMBRE\s+(?:DE\s+)?(?:WI[ -]?FI|RED)\b|RED\s+WI[ -]?FI\b)/i);
  const normalized=text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const matched=!label&&!/\b(?:password|key|clave|contrase[nñ]a|admin|username)\b/i.test(text)?candidates.find(candidate=>{
   const prefix=String(candidate.value||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'').slice(0,9);
   return prefix.length>=8&&normalized.includes(prefix);
  }):null;
  const box=line?.bbox;
  if(!(label||matched)||!box||![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite))continue;
  const lineHeight=box.y1-box.y0,lineWidth=box.x1-box.x0;
  if(lineHeight<4||lineWidth<20)continue;
  const labelTail=text.slice(label?.[0]?.length||0).trim().replace(/^[:=]\s*/, '');
  const nextLine=label&&!labelTail?paragraph.lines?.[lineIndex+1]:null;
  const nextBox=nextLine?.bbox;
  const safeNextLine=nextLine&&nextBox&&!/\b(?:password|pass(?:word)?|key|clave|contrase[nñ]a|contrasenya|admin|username|wps|serial|mac|gateway|ip)\b/i.test(String(nextLine.text||''))&&[nextBox.x0,nextBox.y0,nextBox.x1,nextBox.y1].every(Number.isFinite)&&nextBox.y1>box.y1&&nextBox.y0-box.y1<lineHeight*3;
  const contentLeft=safeNextLine?Math.min(box.x0,nextBox.x0):box.x0;
  const contentRight=safeNextLine?Math.max(box.x1,nextBox.x1):box.x1;
  const left=Math.max(0,Math.floor(contentLeft-lineHeight));
  const top=Math.max(0,Math.floor(box.y0-lineHeight*.45));
  const right=Math.min(width,Math.ceil(contentRight+Math.max(lineHeight*3,lineWidth*.2)));
  // Include the value immediately below a standalone SSID label, but stop
  // before a subsequent password line so the focused pass stays narrow.
  const bottom=Math.min(height,Math.ceil((safeNextLine?nextBox.y1:box.y1)+lineHeight*.2));
  if(right-left<20||bottom-top<5)continue;
  const focusBand=label?.[1]?(/^2/.test(label[1])?'1':'2'):label?.[2];
  const band=(focusBand||String(matched?.sourceLine||'').match(/SS[i1l]D\s*([12il])\b/i)?.[1])?.toLowerCase().replace(/[il]/,'1')||null;
  if(found.some(item=>item.band===band&&Math.abs(item.region.top-top)<lineHeight))continue;
  found.push({band,region:{left,top,width:right-left,height:bottom-top}});
  if(found.length===2)return found;
 }
 return found;
}

/**
 * Bounded recovery for labels/values that OCR text found but the parser could
 * not associate. Returned objects contain geometry and fixed reason codes only;
 * OCR text is never copied into diagnostics.
 */
export function findSsidRecoveryRegions(blocks, width, height, { limit = 2 } = {}) {
 if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return [];
 const rows = [];
 for (const block of Array.isArray(blocks) ? blocks : []) {
  for (const paragraph of block?.paragraphs || []) {
   for (const line of paragraph?.lines || []) {
    const text = String(line?.text || "").trim();
    const box = line?.bbox;
    if (!text || !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) continue;
    const h = box.y1 - box.y0, w = box.x1 - box.x0;
    if (h < 4 || w < 16 || h > height * .2) continue;
    if (/\b(?:admin(?:istration)?|password|pass(?:word)?|key|clave|contrase[nñ]a|wps|serial|s\/?n|mac|bssid|imei|pin|gateway|barcode|ip)\b/i.test(text)) continue;
    const relevance = /\b(?:ssid|wi[ -]?fi|wlan|network|wireless|red|nombre|2[.,]?4|5g|6g)\b/i.test(text) ? 100 : 0;
    const usefulLength = Math.min(32, (text.match(/[\p{L}\p{N}]/gu) || []).length);
    rows.push({ box, h, w, score: relevance + usefulLength, centerY: (box.y0 + box.y1) / 2 });
   }
  }
 }
 rows.sort((a, b) => b.score - a.score || b.w - a.w);
 const found = [];
 for (const row of rows) {
  const padX = Math.max(row.h * 2, row.w * .08);
  const top = Math.max(0, Math.floor(row.box.y0 - row.h * 1.1));
  const bottom = Math.min(height, Math.ceil(row.box.y1 + row.h * 1.5));
  const left = Math.max(0, Math.floor(row.box.x0 - padX));
  const right = Math.min(width, Math.ceil(row.box.x1 + padX));
  if (right - left < 24 || bottom - top < 8) continue;
  if (found.some(item => Math.abs(item.region.top + item.region.height / 2 - row.centerY) < row.h * 2)) continue;
  found.push({ band: null, source: "ocr_region", psm: "6", region: { left, top, width: right - left, height: bottom - top } });
  if (found.length >= Math.max(1, Math.min(2, limit))) return found;
 }
 if (found.length) return found;
 const cropW = Math.max(1, Math.floor(width * .78)), cropH = Math.max(1, Math.floor(height * .78));
 return [{
  band: null, source: "center_crop", psm: "11",
  region: { left: Math.floor((width - cropW) / 2), top: Math.floor((height - cropH) / 2), width: cropW, height: cropH }
 }];
}
