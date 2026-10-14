/** Locate only named network lines for an optional, bounded OCR retry. */
export function findSsidFocusRegions(blocks,width,height,candidates=[]){
 if(!Array.isArray(blocks)||!Number.isFinite(width)||!Number.isFinite(height))return [];
 const found=[];
 for(const block of blocks)for(const paragraph of block?.paragraphs||[])for(const [lineIndex,line] of (paragraph?.lines||[]).entries()){
  const text=String(line?.text||'').trim().replace(/^[^\p{L}\p{N}]+/u,'');
  // Plain SSID labels are common on stickers where the value is printed below.
  const label=text.match(/^(?:SS[i1l]D(?:(?:\s+(2\s*[.,]?\s*4|5)\s*(?:GHz|G)?\b)|(?:\s*([12il]))?(?=$|[\s:=\-])|(?:WI[ -]?FI|WLAN|NETWORK|WIRELESS)\s+NAME\b|NOMBRE\s+(?:DE\s+)?(?:WI[ -]?FI|RED)\b|RED\s+WI[ -]?FI\b)/i);
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
  // Bound the crop to the SSID value row, stopping before a later password row.
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
