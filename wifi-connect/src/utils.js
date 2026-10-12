export const escapeWifi=value=>String(value).replace(/[\\;,:\"]/g,(ch)=>`\\${ch}`);
export function makeWifiPayload({ssid,password='',security='WPA/WPA2',hidden=false}){
 const type=security==='Sin contraseña'?'nopass':security==='WEP'?'WEP':'WPA';
 return `WIFI:T:${type};S:${escapeWifi(ssid)};${type==='nopass'?'':`P:${escapeWifi(password)};`}${hidden?'H:true;':''};`;
}
export function validateNetwork(data){
 const bytes=s=>new TextEncoder().encode(s).length;
 if(!data.ssid.trim())return 'Escribe el nombre de la red (SSID).';
 if(bytes(data.ssid)>32)return 'El SSID supera el máximo de 32 bytes.';
 if(data.security==='Sin contraseña')return '';
 const p=data.password;
 if(data.security==='WEP'){
   if(!((bytes(p)===5||bytes(p)===13)||(p.length===10||p.length===26)&&/^[a-f\d]+$/i.test(p)))return 'WEP suele requerir 5 o 13 caracteres, o 10/26 dígitos hexadecimales.';
 }else if(!((bytes(p)>=8&&bytes(p)<=63)||(p.length===64&&/^[a-f\d]+$/i.test(p))))return 'La contraseña WPA/WPA2/WPA3 debe tener 8–63 bytes o ser una clave hexadecimal de 64 caracteres.';
 return '';
}
export function makeId(){return globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;}
export function formatDate(value){const d=new Date(value),now=new Date();const same=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();const time=new Intl.DateTimeFormat('es-ES',{hour:'2-digit',minute:'2-digit'}).format(d);if(same(d,now))return `Hoy · ${time}`;const y=new Date(now);y.setDate(y.getDate()-1);if(same(d,y))return `Ayer · ${time}`;return `${new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'2-digit'}).format(d)} · ${time}`;}
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
