/** Locate only named network lines for an optional, bounded OCR retry. */
export function findSsidFocusRegions(blocks,width,height,candidates=[]){
 if(!Array.isArray(blocks)||!Number.isFinite(width)||!Number.isFinite(height))return [];
 const found=[];
 for(const block of blocks)for(const paragraph of block?.paragraphs||[])for(const line of paragraph?.lines||[]){
  const text=String(line?.text||'').trim().replace(/^[^\p{L}\p{N}]+/u,'');
  const label=text.match(/^(?:SS[i1l]D\s*([12il])|(?:WI[ -]?FI|WLAN|NETWORK|WIRELESS)\s+NAME|NOMBRE\s+(?:DE\s+)?(?:WI[ -]?FI|RED)|RED\s+WI[ -]?FI)\b/i);
  const normalized=text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const matched=!label&&!/\b(?:password|key|clave|contrase[nñ]a|admin|username)\b/i.test(text)?candidates.find(candidate=>{
   const prefix=String(candidate.value||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'').slice(0,9);
   return prefix.length>=8&&normalized.includes(prefix);
  }):null;
  const box=line?.bbox;
  if(!(label||matched)||!box||![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite))continue;
  const lineHeight=box.y1-box.y0,lineWidth=box.x1-box.x0;
  if(lineHeight<4||lineWidth<20)continue;
  const left=Math.max(0,Math.floor(box.x0-lineHeight));
  const top=Math.max(0,Math.floor(box.y0-lineHeight*.45));
  const right=Math.min(width,Math.ceil(box.x1+Math.max(lineHeight*3,lineWidth*.2)));
  const bottom=Math.min(height,Math.ceil(box.y1+lineHeight*.45));
  if(right-left<20||bottom-top<5)continue;
  const band=(label?.[1]||String(matched?.sourceLine||'').match(/SS[i1l]D\s*([12il])\b/i)?.[1])?.toLowerCase().replace(/[il]/,'1')||null;
  if(found.some(item=>item.band===band&&Math.abs(item.region.top-top)<lineHeight))continue;
  found.push({band,region:{left,top,width:right-left,height:bottom-top}});
  if(found.length===2)return found;
 }
 return found;
}
