/** Giro e inclinación de la etiqueta (CONFIRMAR_CITAS-040). Cálculo puro sobre píxeles y cajas, en memoria. */
const median=list=>{const sorted=[...list].sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:0;};

/** Inclinación (grados, positiva si el texto baja hacia la derecha) de las líneas largas leídas por el OCR. */
export function textAngle(lines){
  return median((lines||[]).filter(line=>Number.isFinite(line?.angle)&&Math.abs(line.angle)<=30&&String(line.text||'').trim().length>=6).map(line=>line.angle));
}

/** Matriz 3×3 que lleva el rectángulo destino (ancho×alto) al cuadrilátero de origen [arriba-izq, arriba-der, abajo-der, abajo-izq]. */
export function homography(quad,width,height){
  const target=[[0,0],[width,0],[width,height],[0,height]],rows=[];
  for(let i=0;i<4;i++){const [x,y]=target[i],[u,v]=quad[i];rows.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);}
  for(let col=0;col<8;col++){
    let pivot=col;for(let row=col+1;row<8;row++)if(Math.abs(rows[row][col])>Math.abs(rows[pivot][col]))pivot=row;
    if(Math.abs(rows[pivot][col])<1e-9)return null;
    [rows[col],rows[pivot]]=[rows[pivot],rows[col]];
    for(let row=0;row<8;row++){if(row===col)continue;const factor=rows[row][col]/rows[col][col];for(let k=col;k<9;k++)rows[row][k]-=factor*rows[col][k];}
  }
  return [...rows.map((row,i)=>row[8]/row[i]),1];
}
export const project=(matrix,x,y)=>{const w=matrix[6]*x+matrix[7]*y+matrix[8];return [(matrix[0]*x+matrix[1]*y+matrix[2])/w,(matrix[3]*x+matrix[4]*y+matrix[5])/w];};

/** Endereza el cuadrilátero a un rectángulo (interpolación bilineal). `image` y el resultado son RGBA. */
export function warpQuad(image,quad,width,height){
  const matrix=homography(quad,width,height);if(!matrix)return null;
  const data=new Uint8ClampedArray(width*height*4),{width:sw,height:sh}=image,source=image.data;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let [u,v]=project(matrix,x+.5,y+.5);u=Math.min(sw-1,Math.max(0,u-.5));v=Math.min(sh-1,Math.max(0,v-.5));
    const x0=Math.floor(u),y0=Math.floor(v),x1=Math.min(sw-1,x0+1),y1=Math.min(sh-1,y0+1),fx=u-x0,fy=v-y0,o=(y*width+x)*4;
    for(let c=0;c<3;c++)data[o+c]=(source[(y0*sw+x0)*4+c]*(1-fx)+source[(y0*sw+x1)*4+c]*fx)*(1-fy)+(source[(y1*sw+x0)*4+c]*(1-fx)+source[(y1*sw+x1)*4+c]*fx)*fy;
    data[o+3]=255;
  }
  return {data,width,height};
}

/**
 * Esquinas de la etiqueta: la mancha clara que contiene los puntos de texto indicados. Devuelve null si no es un
 * cuadrilátero creíble (casi toda la imagen, muy pequeño o muy irregular).
 */
export function findLabelQuad(image,seeds,{tolerance=.72}={}){
  const {width,height,data}=image||{};if(!seeds?.length||!width||!height)return null;
  const gray=new Float32Array(width*height);for(let i=0;i<gray.length;i++)gray[i]=.299*data[i*4]+.587*data[i*4+1]+.114*data[i*4+2];
  const samples=[];
  for(const [sx,sy] of seeds)for(let dy=-6;dy<=6;dy+=2)for(let dx=-6;dx<=6;dx+=2){const x=Math.round(sx)+dx,y=Math.round(sy)+dy;if(x>=0&&y>=0&&x<width&&y<height)samples.push(gray[y*width+x]);}
  if(!samples.length)return null;
  samples.sort((a,b)=>a-b);const limit=samples[Math.floor(samples.length*.8)]*tolerance;
  const seen=new Uint8Array(width*height),stack=[];
  for(const [sx,sy] of seeds){for(let r=0;r<12&&!stack.length;r++){const x=Math.round(sx),y=Math.round(sy)-r;if(x>=0&&y>=0&&x<width&&y<height&&gray[y*width+x]>=limit)stack.push(y*width+x);}if(stack.length)break;}
  if(!stack.length)return null;
  seen[stack[0]]=1;let count=0;const corners=[null,null,null,null],keys=[Infinity,-Infinity,-Infinity,Infinity];
  while(stack.length){
    const index=stack.pop(),x=index%width,y=(index-x)/width;count++;
    // Esquinas: menor x+y, mayor x−y, mayor x+y y menor x−y.
    const values=[x+y,x-y,x+y,x-y];
    for(let k=0;k<4;k++)if(k===0||k===3?values[k]<keys[k]:values[k]>keys[k]){keys[k]=values[k];corners[k]=[x,y];}
    for(const next of [x>0?index-1:-1,x<width-1?index+1:-1,y>0?index-width:-1,y<height-1?index+width:-1])if(next>=0&&!seen[next]&&gray[next]>=limit){seen[next]=1;stack.push(next);}
  }
  let area=0;for(let i=0;i<4;i++){const [ax,ay]=corners[i],[bx,by]=corners[(i+1)%4];area+=ax*by-bx*ay;}area=Math.abs(area)/2;
  const total=width*height;
  if(area<total*.03||area>total*.85||count<area*.6||count>area*1.2)return null;
  return corners;
}
