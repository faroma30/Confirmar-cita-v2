/**
 * Etiquetas de router (CONFIRMAR_CITAS-036): variantes habituales de «nombre de red» y «contraseña», errores
 * típicos del OCR y detección de texto de etiqueta que nunca debe tomarse como valor.
 */
const plain=value=>String(value??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

// Solo se corrigen palabras de etiqueta; los valores nunca pasan por aquí.
const OCR_WORDS=[
  [/(?<![a-z0-9])w[i1l|!]\s*[-–—_]?\s*f[i1l|!](?![a-z0-9])/g,'wifi'],
  [/(?<![a-z0-9])c[o0]ntrase(?:n|fi|fl|h|r)i?a(?![a-z0-9])/g,'contrasena'],
  [/(?<![a-z0-9])n[o0](?:m|rn)bre(?![a-z0-9])/g,'nombre'],
  [/(?<![a-z0-9])netw[o0]rk(?![a-z0-9])/g,'network'],
  [/(?<![a-z0-9])passw[o0]rd(?![a-z0-9])|(?<![a-z0-9])passvvord(?![a-z0-9])/g,'password'],
  [/(?<![a-z0-9])c[l1i]ave(?![a-z0-9])/g,'clave'],
  [/(?<![a-z0-9])s[e3]gur[i1l]dad(?![a-z0-9])/g,'seguridad'],
  [/gh[z27]|6hz|ghs/g,'ghz']
];
const QUALIFIER=/ssid|ghz|2\s*[.,]?\s*4|(?<![a-z0-9])5(?![a-z0-9])|(?<![a-z0-9])[25]g(?![a-z0-9])|wpa|wifi|(?<![a-z0-9])pin(?![a-z0-9])/;
const NAME_WORDS=/ssid|nombre|name|network|(?<![a-z])red(?![a-z])|xarxa|clave|contrasen|password|key|passphrase/;

/** Forma canónica de una etiqueta: sin acentos, sin «(2,4 GHz)», «(SSID)» ni «/PIN». */
export function canonicalLabel(label){
  let key=plain(label).replace(/[：＝]/g,':').replace(/\s+/g,' ').trim()
    .replace(/\s*[:=]\s*$/,'').replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g,'');
  for(const [pattern,word] of OCR_WORDS)key=key.replace(pattern,word);
  key=key.replace(/\s*[([{]([^()[\]{}]{0,24})(?:[)\]}]|$)/g,(whole,inner)=>QUALIFIER.test(inner)?' ':whole);
  key=key.replace(/\s*\/\s*(?:pin|passphrase|key|clave|password)(?![a-z])/g,'');
  const trimmed=key.replace(/(?:\s+(?:2\s*[.,]?\s*4|5)\s*(?:ghz|g))+\s*$/,'');
  if(trimmed!==key&&NAME_WORDS.test(trimmed))key=trimmed;
  return key.replace(/\s+/g,' ').trim();
}

const WIFI='(?:wifi|wi fi|wlan)';
const THE='(?:\\s+(?:de|del))?(?:\\s+(?:la|las|su))?';
export const EXTRA_SSID_LABELS=[
  [new RegExp(`^(?:nombre|nom)${THE}\\s+(?:red|xarxa)(?:\\s+(?:de\\s+)?(?:${WIFI}|inalambrica|sense fils))?$`),96,'Etiqueta de nombre de red'],
  [new RegExp(`^nombre${THE}\\s+(?:red\\s+)?${WIFI}$`),96,'Etiqueta Nombre Wi-Fi'],
  [new RegExp(`^(?:${WIFI}|wireless)\\s+(?:network(?:\\s+(?:name|ssid))?|name|ssid)$`),92,'Etiqueta de nombre de red'],
  [/^network\s+(?:name|ssid)(?:\s+ssid)?$/,90,'Etiqueta de nombre de red'],
  [/^(?:ssid\s+name|nombre\s+(?:del?\s+)?ssid)$/,96,'Etiqueta SSID'],
  [new RegExp(`^(?:${WIFI}|wireless)\\s*(?:network\\s*)?name$`),90,'Etiqueta de nombre de red'],
  // «Network:» a secas (Genexis y otros): el lector solo la admite con dos puntos y junto a una etiqueta Wi-Fi.
  [/^network$/,90,'Etiqueta de nombre de red'],
  // «2.4G SSID» / «5G SSID» (TP-Link y otros); el OCR suele leer la «G» como «6».
  [/^(?:2\s*[.,]?\s*4|5)\s*(?:ghz|g|6)?\s*ss[i1l]d$/,100,'Etiqueta SSID con banda']
];
export const EXTRA_PASSWORD_LABELS=[
  [new RegExp(`^(?:contrasena|clave)${THE}\\s+(?:red|redes)\\s+(?:de\\s+)?(?:${WIFI}|inalambrica)$`),100,'Etiqueta de contraseña Wi-Fi'],
  [new RegExp(`^(?:contrasena|clave)${THE}\\s+(?:red|redes)$`),96,'Etiqueta de contraseña de red'],
  [new RegExp(`^(?:contrasena|clave)${THE}\\s+${WIFI}$`),100,'Etiqueta de contraseña Wi-Fi'],
  [new RegExp(`^(?:clave|contrasena)\\s+de\\s+seguridad(?:(?:\\s+de)?(?:\\s+la)?(?:\\s+red)?\\s+${WIFI})$`),100,'Etiqueta de contraseña Wi-Fi'],
  [/^(?:clave|contrasena)\s+de\s+seguridad(?:(?:\s+de)?(?:\s+la)?\s+red)?$/,92,'Etiqueta de contraseña de red'],
  [new RegExp(`^${WIFI}\\s*[-–_]?\\s*(?:network\\s+)?(?:password|passphrase|passkey|key|kev|kcy|clave|contrasena)$`),100,'Etiqueta de contraseña Wi-Fi'],
  [/^(?:wireless|network)\s*[-–_]?\s*(?:network\s+)?(?:password|passphrase|passkey|key|security\s+key)$/,94,'Etiqueta de clave de red'],
  [/^(?:contrasenya|clau)(?:\s+de)?(?:\s+la)?(?:\s+(?:xarxa|seguretat))(?:\s+(?:wifi|sense fils))?$/,100,'Etiqueta catalana de contraseña Wi-Fi']
];

const ADMIN_LABEL=/^(?:(?:contrasena|clave|password|contrasenya|clau)(?:\s+(?:de|del|d'|para|per))?(?:\s+(?:la|el|l'))?\s*(?:(?:acceso|acces)(?:\s+(?:al|a|a la|a el|del|de la|de))?\s+)?(?:router|modem|equipo|web|administracion|administracio|administrador|admin|gestion|configuracion|login)(?:\s+(?:del?\s+)?(?:router|equipo|web|modem))?|(?:admin|administrator|router|web|login|device|access)(?:\s+(?:access|login|admin))?\s+(?:password|pass|key|passphrase))$/;
/** «Contraseña acceso router», «Admin password»… son del panel del router: nunca son la clave Wi-Fi. */
// «user/pwd», «Username / Password» (el OCR suele leer la barra como «i» o «l»): acceso al panel, no la Wi-Fi.
const ACCOUNT_LABEL=/^(?:user(?:name)?|usuario)\s*(?:[\/|\\]|i|l|y|and)\s*(?:pwd|pass(?:word)?|contrasena|clave)$/;
export const isRouterAccessLabel=label=>ADMIN_LABEL.test(canonicalLabel(label))||ACCOUNT_LABEL.test(plain(label).replace(/\s*[:=;]\s*$/,'').trim());

const LABEL_WORDS=new Set(['wifi','wlan','red','redes','de','del','la','las','el','nombre','contrasena','clave','seguridad','password','passphrase','passkey','key','ssid','network','name','wireless','pin','xarxa','nom','clau','contrasenya','seguretat','acceso','router','inalambrica','ghz']);
const FILLER=/^(?:2|4|5|24|[25]g|g|hz|y)$/;
/** true si el texto solo contiene palabras de etiqueta («WiFi (2,4 GHz)», «de red WiFi», «WiFi»). */
export function isLabelText(value){
  let text=plain(value);
  for(const [pattern,word] of OCR_WORDS)text=text.replace(pattern,word);
  const tokens=text.split(/[\s()[\]{}:;,./\\|=*'"`“”‘’–—-]+/).filter(Boolean);
  return tokens.length>0&&tokens.every(token=>LABEL_WORDS.has(token)||FILLER.test(token))&&tokens.some(token=>LABEL_WORDS.has(token));
}

const SUSPECT_WORDS=new Set(['wifi','wlan','red','nombre','contrasena','clave','ghz','key','password','ssid']);
/** Motivo por el que un valor leído por OCR no merece confianza alta (o cadena vacía). */
export function weakValueReason(value,kind){
  const text=String(value??'');
  if(kind==='password'?text.length<8:text.length<3)return 'Valor demasiado corto';
  if(plain(text).replace(/wi[ -]fi/g,'wifi').split(/[\s()[\]{}:;,]+/).some(token=>SUSPECT_WORDS.has(token)))return 'Contiene texto de etiqueta';
  return '';
}

/** Banda escrita en la etiqueta («(2,4 GHz)», «5G»), si solo hay una. */
export function labelBand(label){
  let text=plain(label);
  for(const [pattern,word] of OCR_WORDS)text=text.replace(pattern,word);
  text=text.replace(/(?<![a-z0-9])(2\s*[.,]?\s*4|5)\s*6(?=\s*ss[i1l]d)/g,'$1g');
  const two=/(?<![a-z0-9])2\s*[.,]?\s*4\s*g(?:hz)?(?![a-z0-9])/.test(text),five=/(?<![a-z0-9])5\s*g(?:hz)?(?![a-z0-9])/.test(text);
  return two===five?'':two?'2.4 GHz':'5 GHz';
}

/** Restos que el OCR lee junto a la etiqueta (bordes del QR, otra columna): no son un valor. */
export function isNoiseValue(value){
  const tokens=String(value??'').trim().split(/\s+/).filter(Boolean);
  if(tokens.length<2)return tokens.length===1&&!/[\p{L}\p{N}]/u.test(tokens[0]);
  // Una palabra larga al principio puede ser el valor seguido de restos.
  if(tokens[0].length>=6&&/\p{L}/u.test(tokens[0])&&/^[\p{L}\p{N}_.-]+$/u.test(tokens[0]))return false;
  const short=tokens.filter(token=>token.replace(/[^\p{L}\p{N}]/gu,'').length<=2).length;
  return short/tokens.length>=0.66||(tokens.length>=4&&short>=2);
}
/** «MiRed , o m» → «MiRed»: solo si tras un signo suelto no queda más que ruido. Es una propuesta a confirmar. */
export function withoutTrailingNoise(value){
  const match=String(value??'').match(/^(.*?[\p{L}\p{N}_])(?:\s+[\p{L}\p{N}](?=\s+[,;|—–.·:*~-]))?\s+[,;|—–.·:*~-]+((?:\s+\S{1,2})*)\s*$/u);
  return match?match[1]:'';
}
/** «MiRed_5G [21» tras una etiqueta con banda: nombre de una palabra seguido solo de restos cortos o con signos. */
export function firstTokenBeforeNoise(value){
  const [first,...rest]=String(value??'').trim().split(/\s+/);
  const junk=token=>token.replace(/[^\p{L}\p{N}]/gu,'').length<=2||/[[\]|{}<>—;=]/.test(token);
  return rest.length&&first.length>=6&&/\p{L}/u.test(first)&&/^[\p{L}\p{N}_.-]+$/u.test(first)&&rest.every(junk)?first:'';
}
