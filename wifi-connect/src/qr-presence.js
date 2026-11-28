/**
 * Detección ligera de «hay un QR aunque no se pueda leer» (CONFIRMAR_CITAS-036): busca los tres patrones de
 * posición (proporción 1:1:3:1:1 en horizontal y vertical) formando un triángulo rectángulo. No lee datos.
 */
const near=(value,expected,unit)=>Math.abs(value-expected)<=unit*Math.max(0.5,expected*0.35);
function finderRatio(runs){
  const total=runs.reduce((sum,run)=>sum+run,0),unit=total/7;
  return unit>=1.5&&near(runs[0],unit,unit)&&near(runs[1],unit,unit)&&near(runs[2],unit*3,unit)&&near(runs[3],unit,unit)&&near(runs[4],unit,unit)?unit:0;
}
function darkMap(data,width,height){
  const gray=new Uint8Array(width*height),block=Math.max(16,Math.round(Math.min(width,height)/24));
  const columns=Math.ceil(width/block),rows=Math.ceil(height/block),sum=new Float64Array(columns*rows),count=new Uint32Array(columns*rows);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const offset=(y*width+x)*4,value=(data[offset]*54+data[offset+1]*183+data[offset+2]*19)>>8,cell=Math.floor(y/block)*columns+Math.floor(x/block);
    gray[y*width+x]=value;sum[cell]+=value;count[cell]++;
  }
  const dark=new Uint8Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const cx=Math.floor(x/block),cy=Math.floor(y/block);let total=0,pixels=0;
    for(let j=Math.max(0,cy-1);j<=Math.min(rows-1,cy+1);j++)for(let i=Math.max(0,cx-1);i<=Math.min(columns-1,cx+1);i++){total+=sum[j*columns+i];pixels+=count[j*columns+i];}
    dark[y*width+x]=gray[y*width+x]<total/pixels-12?1:0;
  }
  return dark;
}
function verticalRun(dark,width,height,x,y){
  const at=row=>row>=0&&row<height&&dark[row*width+x];
  if(!at(y))return null;
  const runs=[0,0,0,0,0];let top=y;
  while(top>=0&&at(top)){runs[2]++;top--;}
  while(top>=0&&!at(top)){runs[1]++;top--;}
  while(top>=0&&at(top)){runs[0]++;top--;}
  let bottom=y+1;
  while(bottom<height&&at(bottom)){runs[2]++;bottom++;}
  const centerEnd=bottom;
  while(bottom<height&&!at(bottom)){runs[3]++;bottom++;}
  while(bottom<height&&at(bottom)){runs[4]++;bottom++;}
  const unit=finderRatio(runs);
  return unit?{unit,center:centerEnd-runs[2]/2}:null;
}
/** Comprueba el cuadrado 7×7 completo (anillo oscuro, anillo claro, centro oscuro) para descartar ruido. */
function squareMatches(dark,width,height,{x,y,unit}){
  let good=0;
  for(let row=-3;row<=3;row++)for(let column=-3;column<=3;column++){
    const px=Math.round(x+column*unit),py=Math.round(y+row*unit),ring=Math.max(Math.abs(row),Math.abs(column));
    if(px>=0&&py>=0&&px<width&&py<height&&Boolean(dark[py*width+px])===(ring!==2))good++;
  }
  return good>=44;
}
/** Devuelve null o {side, share}: lado aproximado del código en píxeles y su proporción respecto al lado corto. */
export function findQrPresence({data,width,height}={}){
  if(!data||width<40||height<40||data.length<width*height*4)return null;
  const dark=darkMap(data,width,height),hits=[];
  for(let y=1;y<height;y+=2){
    const runs=[];let current=dark[y*width],length=0,start=0;
    for(let x=0;x<=width;x++){
      const value=x<width?dark[y*width+x]:-1;
      if(value===current){length++;continue;}
      runs.push({dark:current,length,start});current=value;length=1;start=x;
    }
    for(let index=0;index+4<runs.length;index++){
      if(!runs[index].dark)continue;
      const unit=finderRatio(runs.slice(index,index+5).map(run=>run.length));if(!unit)continue;
      const middle=runs[index+2],x=Math.floor(middle.start+middle.length/2),vertical=verticalRun(dark,width,height,x,y);
      if(!vertical||Math.abs(vertical.unit-unit)>unit*0.5)continue;
      if(!squareMatches(dark,width,height,{x,y:vertical.center-0.5,unit:(unit+vertical.unit)/2}))continue;
      const found=hits.find(hit=>Math.abs(hit.x-x)<unit*3&&Math.abs(hit.y-vertical.center)<unit*3);
      if(found){found.x=(found.x*found.count+x)/(found.count+1);found.y=(found.y*found.count+vertical.center)/(found.count+1);found.count++;}
      else hits.push({x,y:vertical.center,unit,count:1});
    }
  }
  const solid=hits.filter(hit=>hit.count>=2).sort((a,b)=>b.count-a.count).slice(0,12);
  for(const corner of solid)for(let i=0;i<solid.length;i++)for(let j=i+1;j<solid.length;j++){
    const a=solid[i],b=solid[j];if(a===corner||b===corner)continue;
    if(Math.max(a.unit,b.unit,corner.unit)>Math.min(a.unit,b.unit,corner.unit)*1.5)continue;
    const ax=a.x-corner.x,ay=a.y-corner.y,bx=b.x-corner.x,by=b.y-corner.y,la=Math.hypot(ax,ay),lb=Math.hypot(bx,by);
    if(la<corner.unit*10||Math.abs(la-lb)>Math.max(la,lb)*0.18||Math.abs((ax*bx+ay*by)/(la*lb))>0.22)continue;
    if(la>corner.unit*180)continue;
    const side=Math.round((la+lb)/2+corner.unit*7);
    return {side,share:side/Math.min(width,height)};
  }
  return null;
}
