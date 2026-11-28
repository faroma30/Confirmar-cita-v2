// CONFIRMAR_CITAS-040: lectura exacta (votación, perspectiva y giro, dos apariciones, formatos) y captura con
// calidad mínima. Todos los valores son ficticios. Los módulos nuevos se cargan dentro de cada prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRouterLabel} from '../src/router-parser.js';
import {buildScanPlan,createScannedNetwork} from '../src/scan-flow.js';
import {analyzeRouterImage} from '../src/router-image-analysis.js';
import {createLiveScanner,createVideoFrameSource,LIVE_MESSAGES} from '../src/live-scan.js';
import {passwordHintText} from '../src/password-check.js';
import {renderScanReviewScreen} from '../src/scan-review-screen.mjs';

const consensus=()=>import('../src/consensus.js');
const geometry=()=>import('../src/geometry.js');
const patterns=()=>import('../src/label-patterns.js');
const lineRead=()=>import('../src/line-read.js');
const quality=()=>import('../src/capture-quality.js');

const KEY='Kx7mQ4vT8pHt';
const parse=text=>parseRouterLabel({rawText:text,normalizedText:text});
const photo=new Blob(['foto'],{type:'image/jpeg'});
const noQr=async()=>({status:'not-found'});
const qrSource={source:'qr',sourceLabel:'QR Wi-Fi',sourceLine:'QR Wi-Fi'};

/* A · votación carácter a carácter */
test('votación: una mayoría amplia sin confusión posible corrige el carácter y lo deja señalado',async()=>{
  const {voteCharacters}=await consensus();
  const result=voteCharacters('Kx7mQ4vT8pHt',Array(6).fill('Clave: Kx7mQ4vT8pMt'));
  assert.equal(result.value,'Kx7mQ4vT8pMt');
  assert.deepEqual(result.changes.map(item=>item.position),[11]);
  assert.deepEqual(result.doubts.map(item=>item.position),[11]);
});
test('votación: con confusión I/1/3 repartida no se decide, se marca',async()=>{
  const {voteCharacters}=await consensus();
  const result=voteCharacters('AB3CD7EF',['AB3CD7EF','AB3CD7EF','ABICD7EF','ABICD7EF','ABICD7EF','AB3CD7EF']);
  assert.equal(result.value,'AB3CD7EF');
  assert.deepEqual(result.doubts.map(item=>item.position),[3]);
  assert.ok(result.doubts[0].alternatives.includes('I'));
});
test('votación: lecturas coincidentes no dejan dudas; pocas lecturas no confirman nada',async()=>{
  const {voteCharacters}=await consensus();
  const sure=voteCharacters('AB4CD7EF',Array(5).fill('AB4CD7EF'));
  assert.deepEqual(sure.doubts,[]);assert.equal(sure.weak,false);
  assert.equal(voteCharacters('AB4CD7EF',['AB4CD7EF']).weak,true);
  assert.equal(voteCharacters('AB4CD7EF',['zzzz qqqq']).support,0);
});
test('votación: con la longitud del formato se toma la lectura repetida que sí la tiene, a confirmar',async()=>{
  const {voteCharacters}=await consensus();
  const result=voteCharacters('AB4CD7E',['Key AB4CD7EF','Key AB4CD7EF','Key AB4CD7EF','Key AB4CD7EF'],{length:8});
  assert.equal(result.value,'AB4CD7EF');assert.equal(result.rebased,true);assert.ok(result.doubts.length>=1);
});

/* A · perspectiva y giro */
const gray=(width,height,paint)=>{const data=new Uint8ClampedArray(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const v=paint(x,y),o=(y*width+x)*4;data[o]=data[o+1]=data[o+2]=v;data[o+3]=255;}return {data,width,height};};
test('giro: la inclinación sale de las líneas largas y se ignoran las casi verticales',async()=>{
  const {textAngle}=await geometry();
  assert.equal(textAngle([{text:'Network Name',angle:6},{text:'WiFi Password',angle:7},{text:'WLAN Key demo',angle:8},{text:'vertical largo',angle:80},{text:'ab',angle:-20}]),7);
});
test('perspectiva: la homografía lleva las esquinas del rectángulo a las del cuadrilátero y endereza los píxeles',async()=>{
  const {homography,project,warpQuad}=await geometry();
  const quad=[[20,10],[80,22],[74,70],[14,58]],matrix=homography(quad,60,48);
  [[0,0],[60,0],[60,48],[0,48]].forEach(([x,y],i)=>project(matrix,x,y).forEach((value,axis)=>assert.ok(Math.abs(value-quad[i][axis])<1e-6)));
  // Mitad izquierda oscura en un cuadrado girado 45°: al enderezar queda a la izquierda.
  const image=gray(100,100,(x,y)=>(x-50)+(y-50)<0?30:220),straight=warpQuad(image,[[10,50],[50,10],[90,50],[50,90]],40,40);
  const at=(x,y)=>straight.data[(y*40+x)*4];
  assert.ok(at(20,3)<80||at(3,20)<80);assert.ok(at(37,36)>160);
});
test('perspectiva: encuentra las esquinas de una etiqueta clara inclinada y no inventa una en un fondo uniforme',async()=>{
  const {findLabelQuad}=await geometry();
  const angle=8*Math.PI/180,inside=(x,y)=>{const dx=x-100,dy=y-75,u=dx*Math.cos(angle)+dy*Math.sin(angle),v=-dx*Math.sin(angle)+dy*Math.cos(angle);return Math.abs(u)<60&&Math.abs(v)<35;};
  const quad=findLabelQuad(gray(200,150,(x,y)=>inside(x,y)?230:40),[[100,75]]);
  assert.equal(quad.length,4);
  const width=Math.hypot(quad[1][0]-quad[0][0],quad[1][1]-quad[0][1]);
  assert.ok(Math.abs(width-120)<8,`ancho ${width}`);assert.ok(quad[1][1]>quad[0][1]+8);
  assert.equal(findLabelQuad(gray(200,150,()=>200),[[100,75]]),null);
});

/* A · dos apariciones del mismo dato */
const line=(words,y,angle=0)=>({text:words.join(' '),angle,aspect:1,box:{x0:.1,y0:y,x1:.8,y1:y+.05},words:words.map((text,i)=>({text,box:{x0:.1+i*.2,y0:y,x1:.28+i*.2,y1:y+.05}}))});
test('dos apariciones: se localizan las dos cajas y sus lecturas votan juntas',async()=>{
  const {findValueBoxes,lineTargets,readValueLines,applyLineReads}=await lineRead();
  const lines=[line(['WiFi-Key:','QW4RT7YP2HJK'],.2),line(['Password','QW4RT7YP2HMK'],.6)];
  assert.equal(findValueBoxes('QW4RT7YP2HJK',lines).length,2);
  const parsed=parse('SSID: RedDemo_01\nWiFi-Key: QW4RT7YP2HJK'),targets=lineTargets(parsed,lines);
  const target=targets.find(item=>item.field==='password');
  assert.equal(target.boxes.length,2);
  // La primera aparición se lee mal una vez; la segunda confirma el carácter correcto.
  await readValueLines(photo,{targets:[target],crop:async(_b,place)=>place,recognizeLine:async place=>place.box.y0<.4?'WiFi-Key: QW4RT7YP2HMK':'Password QW4RT7YP2HMK',budgetMs:10000});
  assert.equal(applyLineReads(parsed,[target]),1);
  assert.equal(parsed.password.value,'QW4RT7YP2HMK');
  assert.equal(parsed.password.appearances,2);assert.equal(parsed.password.needsReview,true);
});
test('relectura: respeta el tope de tiempo y para tras dos fallos',async()=>{
  const {readValueLines}=await lineRead();
  const targets=()=>[{field:'password',boxes:[{box:{x0:0,y0:0,x1:1,y1:1}}],reads:[]}];
  let clock=0;
  const timed=await readValueLines(photo,{targets:targets(),crop:async()=>photo,recognizeLine:async()=>{clock+=400;return 'abc';},budgetMs:1000,now:()=>clock});
  assert.equal(timed.reads,3);
  const broken=await readValueLines(photo,{targets:targets(),crop:async()=>{throw new Error('x');},recognizeLine:async()=>'',budgetMs:1000});
  assert.equal(broken.reads,0);
});

/* B · formatos de operador */
test('formato: «ADAMO 4821» pasa a «ADAMO-4821» y queda a revisar',async()=>{
  await patterns();
  const result=parse(`Network: ADAMO 4821\nWiFi-Key: QW4RT7YP2HMKZX`);
  const plan=buildScanPlan(result);
  assert.equal(plan.state,'review');assert.ok(plan.fields.includes('ssid'));
  assert.equal(createScannedNetwork(result,plan.candidate).ssid,'ADAMO-4821');
  assert.equal(result.ssid.value,'ADAMO 4821','el valor leído se conserva');
  assert.match(renderScanReviewScreen({network:createScannedNetwork(result,plan.candidate),fields:plan.fields,candidate:plan.candidate,qualityHint:true}),/formato habitual de este router[\s\S]*repite la foto más cerca[\s\S]*value="ADAMO-4821"/);
});
test('formato: corrige solo el carácter confundible que el alfabeto decide y lo anota',async()=>{
  await patterns();
  const result=parse('SSID: Vera A1B2C3\nWiFi Password: ab12cd34eO');
  assert.equal(createScannedNetwork(result,buildScanPlan(result).candidate).ssid,'Vera_A1B2C3');
  assert.equal(result.password.value,'ab12cd34e0');
  assert.deepEqual(result.password.characterCorrections.map(item=>item.position),[10]);
});
test('formato: longitud inesperada se marca y no se cambia',async()=>{
  await patterns();
  const result=parse('SSID: ADAMO-4821\nWiFi Password: QW4RT7YP2HM');
  assert.equal(result.password.value,'QW4RT7YP2HM');assert.equal(result.password.lengthMismatch,14);
  assert.ok(buildScanPlan(result).fields.includes('password'));
  assert.match(passwordHintText({password:result.password.value,lengthMismatch:14}),/14 caracteres/);
});
test('formato: un nombre sin patrón conocido y un dato de QR no se tocan',async()=>{
  const {applyLabelPatterns}=await patterns();
  const free=parse(`SSID: Casa Demo 4821\nWiFi Password: ${KEY}`);
  assert.equal(free.ssid.value,'Casa Demo 4821');assert.equal(free.password.value,KEY);assert.equal(free.password.lengthMismatch,undefined);
  const qr={value:'ADAMO 4821',...qrSource,score:110},parsed=applyLabelPatterns({ssidCandidates:[qr],passwordCandidates:[],ssid:null,password:null});
  assert.equal(parsed.ssidCandidates[0].value,'ADAMO 4821');
});

/* nada dudoso sin revisión */
const strong=(extra={})=>({ssid:{value:'RedDemo_01'},password:{value:KEY,fieldType:'password',source:'ocr',sourceLabel:'WiFi Password',sourceLine:'p',score:100,ocrConfidence:96,reason:'Etiqueta de contraseña Wi-Fi',...extra},
  ssidCandidates:[{value:'RedDemo_01',fieldType:'ssid',source:'ocr',sourceLabel:'SSID',sourceLine:'s',score:100,ocrConfidence:96}],passwordCandidates:[],security:{value:'WPA/WPA2'}});
test('revisión: una clave con dudas o una foto de poca calidad nunca se da por lista',()=>{
  assert.equal(buildScanPlan(strong()).state,'ready');
  assert.deepEqual(buildScanPlan(strong({doubts:[{position:2,char:'x',alternatives:[]}]})).fields,['password']);
  const low={...strong(),lowQuality:true};
  assert.deepEqual(buildScanPlan(low).fields,['ssid','password']);
});
const ocrOf=(text,extra={})=>({rawText:text,normalizedText:text,confidence:96,passes:[],labelRegions:[],image:{sourceWidth:1000,sourceHeight:1000},...extra});
test('foto manual de poca calidad: se acepta, todo queda dudoso',async()=>{
  const text=`SSID: RedDemo_01\nWiFi Password: ${KEY}`;
  const result=await analyzeRouterImage(photo,{decodeQr:noQr,recognize:async()=>ocrOf(text),measure:async()=>({sharpness:2,contrast:120})});
  assert.equal(result.parsed.lowQuality,true);assert.equal(result.quality.advice,'Mantén quieto el móvil');
  assert.equal(result.parsed.password.value,KEY);
  assert.ok(buildScanPlan(result.parsed).fields.includes('password'));
  const good=await analyzeRouterImage(photo,{decodeQr:noQr,recognize:async()=>ocrOf(text),measure:async()=>({sharpness:40,contrast:120})});
  assert.notEqual(good.parsed.lowQuality,true);
});
test('análisis: la relectura por líneas vota la clave y la deja a revisar',async()=>{
  const lines=[line(['WiFi','Password:','QW4RT7YP2HJK'],.3)];
  const result=await analyzeRouterImage(photo,{decodeQr:noQr,recognize:async()=>ocrOf('SSID: RedDemo_01\nWiFi Password: QW4RT7YP2HJK',{lines}),
    cropLine:async()=>photo,recognizeLine:async()=>'WiFi Password: QW4RT7YP2HMK',measure:async()=>({sharpness:40,contrast:120})});
  assert.equal(result.parsed.password.value,'QW4RT7YP2HMK');assert.ok(result.lineRead.reads>=4);
  assert.ok(buildScanPlan(result.parsed).fields.includes('password'));
});

/* C · calidad mínima */
const checker=cell=>gray(64,64,(x,y)=>(Math.floor(x/cell)+Math.floor(y/cell))%2?210:40);
test('nitidez: un borde nítido supera el umbral y un degradado no',async()=>{
  const {imageStats,qualityVerdict,QUALITY}=await quality();
  const sharp=imageStats(checker(4)),soft=imageStats(gray(64,64,x=>40+x*2.6));
  assert.ok(sharp.sharpness>QUALITY.minSharpness);assert.ok(soft.sharpness<QUALITY.minSharpness);
  assert.equal(qualityVerdict(sharp).ok,true);
  assert.deepEqual(qualityVerdict(soft).reasons,['blur']);
});
test('umbrales: tamaño, movimiento, reflejos e inclinación tienen su consejo concreto',async()=>{
  const {qualityVerdict,QUALITY}=await quality();
  assert.equal(qualityVerdict({textPx:QUALITY.minTextPx-1}).advice,LIVE_MESSAGES.closer);
  assert.equal(qualityVerdict({textPx:QUALITY.minTextPx}).ok,true);
  assert.equal(qualityVerdict({motion:40}).advice,LIVE_MESSAGES.still);
  assert.equal(qualityVerdict({glare:.5}).advice,LIVE_MESSAGES.glare);
  assert.equal(qualityVerdict({tilt:-30}).advice,LIVE_MESSAGES.rotate);
});
test('tamaño de letra: sale de las líneas con palabras de etiqueta y no de líneas verticales',async()=>{
  const {textMetrics}=await quality();
  assert.equal(Math.round(textMetrics([{text:'WiFi Password demo',angle:0,box:{x0:0,y0:.1,x1:.5,y1:.13}},{text:'otra cosa',angle:0,box:{x0:0,y0:.5,x1:.5,y1:.9}}],1000).textPx),30);
  assert.equal(textMetrics([{text:'WiFi Password demo',angle:88,box:{x0:0,y0:.1,x1:.05,y1:.9}}],1000).textPx,null);
});
test('cámara en vivo: mientras falte calidad no captura y repite el consejo; después exige dos lecturas iguales',async()=>{
  const queue=[],statuses=[],delivered=[];
  const readings=[{key:'a',blob:photo,pass:{}},{advice:LIVE_MESSAGES.still},{key:'a',blob:photo,pass:{}},{key:'b',blob:photo,pass:{}},{key:'b',blob:photo,pass:{}}];
  let reads=0;
  const scanner=createLiveScanner({readQr:async()=>({networks:[]}),readText:async()=>readings[reads++],onQr:()=>{},onText:value=>delivered.push(value),onStatus:s=>statuses.push(s),
    timing:{qrIntervalMs:1e9,firstTextDelayMs:1,textIntervalMs:1,helpAfterMs:1e9,textLimitMs:1e9},setTimer:(fn,ms)=>{if(ms<1000)queue.push(fn);return queue.length;},clearTimer:()=>{},now:()=>0});
  scanner.start();
  while(queue.length){queue.shift()();await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(reads,5);assert.equal(delivered.length,1);assert.ok(statuses.includes(LIVE_MESSAGES.still));
});
const frameSource=(paint,recognize)=>createVideoFrameSource({videoWidth:1000,videoHeight:1000},{barcodeDetector:null,recognize,
  canvasFactory:()=>({width:0,height:0,getContext(){const canvas=this;return {drawImage(){},getImageData:()=>gray(canvas.width,canvas.height,paint)};},toBlob(callback){callback(photo);}})});
test('cámara en vivo: un fotograma borroso no gasta lectura y una letra pequeña pide acercarse',async()=>{
  let calls=0;
  const text=`SSID: RedDemo_01\nWiFi Password: ${KEY}`;
  const recognize=async()=>{calls++;return ocrOf(text,{lines:[{text:'WiFi Password demo',angle:0,aspect:1,box:{x0:0,y0:.1,x1:.4,y1:.108},words:[]}]});};
  const blurred=await frameSource(x=>40+(x%640)*.3,recognize).readText();
  assert.equal(blurred.advice,LIVE_MESSAGES.still);assert.equal(calls,0);
  const small=await frameSource((x,y)=>(Math.floor(x/4)+Math.floor(y/4))%2?210:40,recognize).readText();
  assert.equal(small.advice,LIVE_MESSAGES.closer);assert.equal(calls,1);
});
