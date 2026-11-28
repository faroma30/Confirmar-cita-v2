/**
 * Caracteres confundibles en claves leídas por OCR (CONFIRMAR_CITAS-036). Solo se corrige cuando el perfil del
 * operador fija el alfabeto (y, si la fija, la longitud); en otro caso solo se señala para que el técnico confirme.
 * Una clave procedente de un QR Wi-Fi no pasa por aquí.
 */
const GROUPS=[['0','O'],['0','o'],['O','Q'],['1','I','l'],['5','S'],['8','B'],['6','G'],['6','B'],['2','Z']];
export const PASSWORD_ALPHABETS=Object.freeze({
  digits:/^[0-9]$/,hex:/^[0-9A-Fa-f]$/,'hex-upper':/^[0-9A-F]$/,'upper-digits':/^[0-9A-Z]$/,'lower-digits':/^[0-9a-z]$/
});
const alternativesOf=char=>[...new Set(GROUPS.filter(group=>group.includes(char)).flat())].filter(other=>other!==char);

export function doubtfulCharacters(password){
  return [...String(password??'')].map((char,index)=>({position:index+1,char,alternatives:alternativesOf(char)})).filter(item=>item.alternatives.length);
}
/** Las parejas O/0 e I/l/1 no se distinguen en muchas etiquetas: obligan a confirmar. */
export const needsCharacterConfirmation=password=>/[O0Il1]/.test(String(password??''));

export function applyPasswordFormat(password,format){
  const value=String(password??''),alphabet=PASSWORD_ALPHABETS[format?.alphabet];
  const unchanged={value,corrections:[],decided:false};
  if(!alphabet||(Number.isInteger(format.length)&&value.length!==format.length))return unchanged;
  const corrections=[],chars=[...value];
  for(let index=0;index<chars.length;index++){
    if(alphabet.test(chars[index]))continue;
    const options=alternativesOf(chars[index]).filter(other=>alphabet.test(other));
    // Sin una única sustitución posible no se inventa nada.
    if(options.length!==1)return unchanged;
    corrections.push({position:index+1,from:chars[index],to:options[0]});chars[index]=options[0];
  }
  return {value:chars.join(''),corrections,decided:true};
}

/** Texto para la pantalla de revisión (se muestra solo en el dispositivo). */
export function passwordHintText({password='',corrections=[],decided=false}={}){
  if(corrections.length)return `Corregido según el formato del operador: ${corrections.map(item=>`carácter ${item.position} «${item.from}» → «${item.to}»`).join(', ')}. Confírmalo en la etiqueta.`;
  if(decided)return '';
  const doubts=doubtfulCharacters(password);
  if(!doubts.length)return '';
  return `Caracteres dudosos: ${doubts.slice(0,8).map(item=>`el ${item.position}.º «${item.char}» (¿${item.alternatives.join(' o ')}?)`).join(', ')}${doubts.length>8?'…':''}.`;
}
