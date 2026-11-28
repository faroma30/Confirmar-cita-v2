/**
 * Votación carácter a carácter entre varias lecturas de una misma línea (CONFIRMAR_CITAS-040). Un carácter solo se
 * cambia con una mayoría amplia y sin confusión posible; cualquier empate, confusión o falta de apoyo queda dudoso
 * para que lo confirme el técnico. Funciones puras: los valores no salen de la memoria.
 */
const CONFUSABLE=['0OoDQ','1Il|!i','3I','38B','5S$s','6GEb','69B','8B&','2Zz','4A','ec','aqg9','uvy','UV','cC','oO','sS','vV','wW','xX','zZ','-_–—. '];
export const confusable=(a,b)=>a!==b&&CONFUSABLE.some(group=>group.includes(a)&&group.includes(b));
export const CONSENSUS=Object.freeze({minSimilarity:.65,minReads:4,changeShare:.75,agreeShare:.75,confusableShare:.2});

/** Alinea el valor dentro de una lectura (los extremos de la lectura, etiqueta incluida, no cuentan). */
export function alignRead(base,read){
  const a=[...String(base)],b=[...String(read)],n=a.length,m=b.length;
  if(!n||!m)return null;
  const score=Array.from({length:n+1},()=>new Float64Array(m+1)),from=Array.from({length:n+1},()=>new Uint8Array(m+1));
  for(let i=1;i<=n;i++){score[i][0]=-i;from[i][0]=2;}
  for(let i=1;i<=n;i++)for(let j=1;j<=m;j++){
    const same=a[i-1]===b[j-1],diagonal=score[i-1][j-1]+(same?2:confusable(a[i-1],b[j-1])?.5:-1),up=score[i-1][j]-1,left=score[i][j-1]-1;
    const best=Math.max(diagonal,up,left);score[i][j]=best;from[i][j]=best===diagonal?1:best===up?2:3;
  }
  let end=0;for(let j=1;j<=m;j++)if(score[n][j]>score[n][end])end=j;
  const chars=new Array(n).fill('');let i=n,j=end,matches=0,inserted=0;
  while(i>0){
    const step=from[i][j];
    if(step===1){chars[i-1]=b[j-1];matches+=a[i-1]===b[j-1]?1:confusable(a[i-1],b[j-1])?.6:0;i--;j--;}
    else if(step===2)i--;
    else{j--;inserted++;}
  }
  return {chars,similarity:Math.max(0,matches-inserted*.5)/n};
}

const tokensOf=(read,length)=>String(read).split(/\s+/).map(token=>token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,'')).filter(token=>token.length===length);

/**
 * `reads` son textos de lecturas de la línea (de una o varias apariciones del dato). `format` puede fijar
 * `length` y `alphabet` (expresión para un carácter). Devuelve el valor, las posiciones dudosas y los cambios.
 */
export function voteCharacters(base,reads,{length=null,alphabet=null,options={}}={}){
  const settings={...CONSENSUS,...options};
  let value=String(base??''),rebased=null;
  const lines=(reads||[]).map(read=>String(read??'').trim()).filter(Boolean);
  // El valor de partida no tiene la longitud del formato: se toma la lectura repetida que sí la tiene.
  if(Number.isInteger(length)&&value.length!==length){
    const counts=new Map();
    for(const line of lines)for(const token of tokensOf(line,length))if((alignRead(value,token)?.similarity||0)>=.5)counts.set(token,(counts.get(token)||0)+1);
    const best=[...counts].sort((a,b)=>b[1]-a[1])[0];
    if(best&&best[1]>=2){rebased=value;value=best[0];}
  }
  const aligned=lines.map(line=>alignRead(value,line)).filter(item=>item&&item.similarity>=settings.minSimilarity);
  const chars=[...value],doubts=[],changes=[];
  if(!aligned.length)return {value,doubts,changes,support:0,rebased:rebased!==null,weak:true};
  for(let index=0;index<chars.length;index++){
    const current=chars[index],tally=new Map();
    for(const item of aligned){const char=item.chars[index];if(char&&char!==' ')tally.set(char,(tally.get(char)||0)+1);}
    const total=aligned.length,ranked=[...tally].sort((a,b)=>b[1]-a[1]);
    const share=char=>(tally.get(char)||0)/total,[top]=ranked[0]||[''];
    const rival=ranked.some(([char])=>char!==current&&confusable(char,current)&&share(char)>=settings.confusableShare);
    let doubt=false;
    if(top&&top!==current){
      const forced=alphabet&&!alphabet.test(current)&&alphabet.test(top);
      const clear=total>=settings.minReads&&share(top)>=settings.changeShare&&!confusable(top,current)&&(!alphabet||alphabet.test(top));
      if(forced||clear){chars[index]=top;changes.push({position:index+1,from:current,to:top});doubt=true;}
      else doubt=rival||share(top)>share(current)||share(current)<settings.agreeShare;
    }else doubt=rival||share(current)<settings.agreeShare;
    if(rebased!==null&&current!==rebased[index])doubt=true;
    if(doubt){
      const shown=chars[index],alternatives=[...new Set([current,...ranked.map(([char])=>char)])].filter(char=>char!==shown&&(!alphabet||alphabet.test(char))).slice(0,3);
      doubts.push({position:index+1,char:shown,alternatives});
    }
  }
  // Con pocas lecturas no hay mayoría que valga: nada se da por confirmado.
  return {value:chars.join(''),doubts,changes,support:aligned.length,rebased:rebased!==null,weak:aligned.length<settings.minReads};
}
