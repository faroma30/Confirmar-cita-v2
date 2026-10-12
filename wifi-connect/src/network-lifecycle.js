export const RECENT_TTL_MS=48*60*60*1000;

export function migrateLegacyNetwork(network){
  if(network.type==='recent'||network.type==='saved')return network;
  return {...network,type:'saved'};
}

export function sameNetworkIdentity(a,b){
  return String(a?.ssid||'').trim()===String(b?.ssid||'').trim()
    &&String(a?.security||'WPA/WPA2')===String(b?.security||'WPA/WPA2');
}

export function isRecentExpired(network,now=Date.now()){
  return network?.type==='recent'&&(!Number.isFinite(Date.parse(network.expiresAt))||Date.parse(network.expiresAt)<=now);
}

export function createRecentRecord(network,{existing=null,now=Date.now()}={}){
  const lastUsedAt=new Date(now).toISOString();
  const id=existing?.id||network.id||globalThis.crypto?.randomUUID?.()||`wifi-${now.toString(36)}-${Math.random().toString(36).slice(2,10)}`;
  const record={...existing,...network,id,type:'recent',note:network.note||existing?.note||'',createdAt:existing?.createdAt||network.createdAt||lastUsedAt,lastUsedAt,expiresAt:new Date(now+RECENT_TTL_MS).toISOString()};
  delete record.updatedAt;
  return record;
}

export function renewRecentRecord(network,now=Date.now()){
  if(network?.type!=='recent')return network;
  return {...network,lastUsedAt:new Date(now).toISOString(),expiresAt:new Date(now+RECENT_TTL_MS).toISOString()};
}

export function promoteRecentRecord(recent,saved=null,{replaceExisting=false,now=Date.now()}={}){
  if(!saved)return {network:toSaved(recent,now),removeIds:[]};
  if(saved.password!==recent.password&&!replaceExisting)return {conflict:true,saved,recent};
  const network={...saved,...recent,id:saved.id,type:'saved',createdAt:saved.createdAt||recent.createdAt,updatedAt:new Date(now).toISOString(),note:recent.note||saved.note||''};
  return {network:toSaved(network,now),removeIds:[recent.id]};
}

export function toSaved(network,now=Date.now()){
  const saved={...network,type:'saved',updatedAt:network.updatedAt||new Date(now).toISOString()};
  delete saved.expiresAt;
  delete saved.lastUsedAt;
  return saved;
}

export function formatRecentExpiry(expiresAt,now=Date.now()){
  const remaining=Date.parse(expiresAt)-now;
  if(remaining<=0)return 'Caduca ahora';
  if(remaining<60*60*1000)return 'Caduca en menos de 1 h';
  const hours=Math.ceil(remaining/(60*60*1000));
  return `Caduca en ${hours} h`;
}
