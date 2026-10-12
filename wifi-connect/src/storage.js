import {RECENT_TTL_MS,createRecentRecord,isRecentExpired,migrateLegacyNetwork,promoteRecentRecord,renewRecentRecord,sameNetworkIdentity,toSaved} from './network-lifecycle.js';

const DB_VERSION=2;
let dbPromise;
let dbName=null;
let generation=0;
export function scopedDatabaseName(userId){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(userId||'')))throw new Error('Identidad local no válida.');
  return `wifi-connect-v2-${userId.toLowerCase()}`;
}
export function setStorageUser(userId){
  const next=scopedDatabaseName(userId);
  if(dbName===next)return;
  generation++;
  const previous=dbPromise;
  dbPromise=null;
  dbName=next;
  previous?.then(db=>db.close()).catch(()=>{});
}
export function closeStorage(){generation++;const previous=dbPromise;dbPromise=null;dbName=null;previous?.then(db=>db.close()).catch(()=>{});}
function openDB(){
  if(!dbName)return Promise.reject(new Error('Identidad local no configurada.'));
  if(dbPromise)return dbPromise;
  const expectedGeneration=generation;
  dbPromise=new Promise((resolve,reject)=>{
    if(!('indexedDB' in window)){reject(new Error('IndexedDB no está disponible en este navegador.'));return;}
    const req=indexedDB.open(dbName,DB_VERSION);
    req.onupgradeneeded=event=>{
      const db=req.result,tx=req.transaction;
      const store=db.objectStoreNames.contains('networks')?tx.objectStore('networks'):db.createObjectStore('networks',{keyPath:'id'});
      if(!store.indexNames.contains('createdAt'))store.createIndex('createdAt','createdAt');
      if(event.oldVersion>0){const cursor=store.openCursor();cursor.onsuccess=()=>{const entry=cursor.result;if(!entry)return;const migrated=migrateLegacyNetwork(entry.value);if(migrated!==entry.value)entry.update(migrated);entry.continue();};}
    };
    req.onsuccess=()=>{if(expectedGeneration!==generation){req.result.close();reject(new Error('Sesión local cambiada.'));return;}resolve(req.result);};req.onerror=()=>{dbPromise=null;reject(req.error);};
  });
  return dbPromise;
}
function transaction(mode,operation){const expectedGeneration=generation;return openDB().then(db=>new Promise((resolve,reject)=>{if(expectedGeneration!==generation){reject(new Error('Sesión local cambiada.'));return;}const tx=db.transaction('networks',mode),store=tx.objectStore('networks');let result;try{result=operation(store,tx);}catch(e){reject(e);return;}tx.oncomplete=()=>expectedGeneration===generation?resolve(result?.result??result):reject(new Error('Sesión local cambiada.'));tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Operación cancelada'));}));}
const getAllRaw=()=>transaction('readonly',s=>{const req=s.getAll();return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))));req.onerror=()=>reject(req.error);});});
const getRaw=id=>transaction('readonly',s=>{const req=s.get(id);return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});});

export async function cleanupExpiredRecents({now=Date.now()}={}){
  const all=await getAllRaw(),expired=all.filter(n=>isRecentExpired(n,now));
  if(expired.length)await transaction('readwrite',s=>expired.forEach(n=>s.delete(n.id)));
  return expired.length;
}
export async function getAllNetworks({now=Date.now()}={}){await cleanupExpiredRecents({now});return getAllRaw();}
export async function getNetwork(id,{now=Date.now()}={}){await cleanupExpiredRecents({now});return getRaw(id);}
export const saveNetwork=data=>transaction('readwrite',s=>s.put(data));
export const deleteNetwork=id=>transaction('readwrite',s=>s.delete(id));
export async function clearNetworks(){const all=await getAllRaw();if(all.length)await transaction('readwrite',s=>s.clear());}

export async function listRecentNetworks({now=Date.now()}={}){await cleanupExpiredRecents({now});return (await getAllRaw()).filter(n=>n.type==='recent');}
export async function listSavedNetworks({now=Date.now()}={}){await cleanupExpiredRecents({now});return (await getAllRaw()).filter(n=>n.type!=='recent');}
export async function saveRecentNetwork(network,{now=Date.now()}={}){
  await cleanupExpiredRecents({now});
  const all=await getAllRaw();
  const saved=all.find(n=>n.type!=='recent'&&sameNetworkIdentity(n,network));
  if(saved&&saved.password===network.password)return saved;
  const existing=all.find(n=>n.type==='recent'&&n.id===network.id)||all.find(n=>n.type==='recent'&&sameNetworkIdentity(n,network));
  const record=createRecentRecord(network,{existing,now});
  await saveNetwork(record);
  const duplicates=all.filter(n=>n.type==='recent'&&sameNetworkIdentity(n,network)&&n.id!==record.id);
  if(duplicates.length)await transaction('readwrite',s=>duplicates.forEach(n=>s.delete(n.id)));
  return record;
}
export async function touchRecentNetwork(id,{now=Date.now()}={}){
  await cleanupExpiredRecents({now});
  const network=await getRaw(id);
  if(!network||network.type!=='recent')return network;
  const renewed=renewRecentRecord(network,now);await saveNetwork(renewed);return renewed;
}
export async function savePermanentNetwork(network,{now=Date.now()}={}){
  const saved=toSaved(network,now);await saveNetwork(saved);return saved;
}
export async function promoteRecentToSaved(id,{replaceExisting=false,now=Date.now()}={}){
  await cleanupExpiredRecents({now});
  const all=await getAllRaw(),recent=all.find(n=>n.id===id);
  if(!recent)return {network:null,removeIds:[]};
  if(recent.type!=='recent')return {network:recent,removeIds:[]};
  const existingSaved=all.find(n=>n.type!=='recent'&&n.id!==id&&sameNetworkIdentity(n,recent));
  const result=promoteRecentRecord(recent,existingSaved,{replaceExisting,now});
  if(result.conflict)return result;
  await transaction('readwrite',s=>{for(const removeId of result.removeIds)s.delete(removeId);s.put(result.network);});
  return result;
}
async function clearByType(type){const all=await getAllRaw(),matches=all.filter(n=>type==='saved'?n.type!=='recent':n.type==='recent');if(matches.length)await transaction('readwrite',s=>matches.forEach(n=>s.delete(n.id)));return matches.length;}
export const clearRecentNetworks=()=>clearByType('recent');
export const clearSavedNetworks=()=>clearByType('saved');
export {RECENT_TTL_MS};
