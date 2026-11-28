// CONFIRMAR_CITAS-036: prioridad del QR, lectura en vivo, giro, captura y claves. Imágenes y valores sintéticos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createLiveScanner,readQrFrame,readingFromOcr,guideRegion,usableQrNetwork,createVideoFrameSource,LIVE_MESSAGES} from '../src/live-scan.js';
import {analyzeRouterImage,analysisFromLiveQr,readRotatedLabel} from '../src/router-image-analysis.js';
import {rotateImageBlob} from '../src/image-processing.js';
import {createOcrService} from '../src/ocr.js';
import {decodeWifiQrPayloadsFromImage} from '../src/wifi-qr.js';
import {findQrPresence} from '../src/qr-presence.js';
import {parseRouterLabel} from '../src/router-parser.js';
import {buildScanPlan,createScannedNetwork} from '../src/scan-flow.js';
import {applyPasswordFormat,doubtfulCharacters,passwordHintText} from '../src/password-check.js';
import {createCameraSession,CAMERA_STATES} from '../src/camera.js';
import {renderScanReviewScreen} from '../src/scan-review-screen.mjs';

const source=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
const generator={};vm.runInNewContext(source('../vendor/qrcode-generator.js'),generator);
const WIFI24='WIFI:T:WPA;S:RedPrueba_7A;P:Kx9mQ2vL8pZt;;',WIFI5='WIFI:T:WPA;S:RedPrueba_7A_5G;P:Hn4wRt7yGq2a;;',ADMIN_URL='http://192.168.0.1/admin';

/** Imagen RGBA sintética con uno o varios QR en fila; `damage` borra datos pero deja los tres patrones. */
function qrImage(payloads,{scale=6,damage=false}={}){
  const quiet=6,matrices=payloads.map(payload=>{const qr=generator.qrcode(0,'M');qr.addData(payload,'Byte');qr.make();return qr;});
  const cells=matrices.map(qr=>qr.getModuleCount()+quiet*2),width=cells.reduce((a,b)=>a+b,0)*scale,height=Math.max(...cells)*scale;
  const data=new Uint8ClampedArray(width*height*4).fill(255);let left=0,seed=7;
  matrices.forEach((qr,index)=>{
    const count=qr.getModuleCount();
    for(let y=0;y<count;y++)for(let x=0;x<count;x++){
      const finder=(x<8&&y<8)||(x>=count-8&&y<8)||(x<8&&y>=count-8);
      let dark=qr.isDark(y,x);
      if(damage&&!finder){seed=(seed*1103515245+12345)%2147483648;dark=(seed>>16)%2===0;}
      if(!dark)continue;
      for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const o=(((quiet+y)*scale+dy)*width+(left+quiet+x)*scale+dx)*4;data[o]=data[o+1]=data[o+2]=0;}
    }
    left+=cells[index];
  });
  return {data,width,height};
}
const decodeImage=image=>decodeWifiQrPayloadsFromImage(new Blob(['x'],{type:'image/jpeg'}),{
  barcodeDetector:null,
  canvasFactory:()=>({width:0,height:0,getContext(){const canvas=this;return {drawImage(...args){canvas.region=args.length===9?args.slice(1,5):null;},
    getImageData(){const {width,height}=canvas,[sx,sy,sw,sh]=canvas.region||[0,0,image.width,image.height],data=new Uint8ClampedArray(width*height*4);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){const from=(Math.min(image.height-1,sy+Math.floor(y*sh/height))*image.width+Math.min(image.width-1,sx+Math.floor(x*sw/width)))*4;data.set(image.data.subarray(from,from+4),(y*width+x)*4);}
      return {data,width,height};}};}})
});
async function decodeSynthetic(image){const saved=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:image.width,height:image.height,close(){}});try{return await decodeImage(image);}finally{if(saved===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=saved;}}
const photo=new Blob(['foto sintética'],{type:'image/jpeg'});
const ocrOf=text=>async()=>({rawText:text,normalizedText:text,confidence:80,passes:[{id:'color',confidence:80,normalizedText:text}]});

test('el QR de conexión válido manda sobre el texto',async()=>{
  const text='SSID: RedPrueba_7A\nWiFi Password: Kx9mQ2vL8pZ1';
  const analysis=await analyzeRouterImage(photo,{decodeQr:async()=>decodeSynthetic(qrImage([WIFI24])),recognize:ocrOf(text)});
  const plan=buildScanPlan(analysis.parsed);
  assert.equal(plan.state,'ready');
  assert.equal(createScannedNetwork(analysis.parsed,plan.candidate).password,'Kx9mQ2vL8pZt','la clave del QR no se modifica ni se sustituye');
});
test('un QR de administración se ignora y se usan los datos del texto',async()=>{
  const qr=await decodeSynthetic(qrImage([ADMIN_URL]));
  assert.equal(qr.status,'ignored');assert.deepEqual(qr.networks,[]);
  const analysis=await analyzeRouterImage(photo,{decodeQr:async()=>qr,recognize:ocrOf('SSID: RedTexto_3B\nWiFi Password: Pq7rTv9wXz4m')});
  assert.equal(analysis.parsed.ssid.value,'RedTexto_3B');assert.equal(analysis.parsed.password.value,'Pq7rTv9wXz4m');
  assert.ok(!JSON.stringify(analysis.parsed.passwordCandidates).includes('192.168'));
});
test('dos QR conservan cada red con su clave',async()=>{
  const analysis=await analyzeRouterImage(photo,{decodeQr:async()=>decodeSynthetic(qrImage([WIFI24,WIFI5])),recognize:ocrOf('')});
  const plan=buildScanPlan(analysis.parsed);
  assert.equal(plan.state,'choose-band');
  assert.deepEqual(plan.choices.map(choice=>[createScannedNetwork(analysis.parsed,choice).ssid,createScannedNetwork(analysis.parsed,choice).password]).sort(),
    [['RedPrueba_7A','Kx9mQ2vL8pZt'],['RedPrueba_7A_5G','Hn4wRt7yGq2a']]);
});

function ocrService(texts){
  let calls=0;
  const service=createOcrService({paths:()=>({}),preprocess:async(_blob,{variant})=>({blob:new Blob([variant]),previewBlob:null,sourceWidth:800,sourceHeight:600,width:800,height:600}),
    loadEngine:async()=>({createWorker:async()=>({async recognize(){const text=texts[Math.min(calls,texts.length-1)];calls++;return {data:{text,confidence:80}};},async terminate(){}})})});
  return {service,calls:()=>calls};
}
const qrResult={status:'wifi',type:'wifi',ssid:'RedPrueba_7A',password:'Kx9mQ2vL8pZt',security:'WPA/WPA2'};
test('con QR completo y texto sin discrepancias hay una sola pasada de OCR',async()=>{
  const {service,calls}=ocrService(['Router de prueba']);await service(photo,{qrResult});assert.equal(calls(),1);await service.dispose();
});
test('si el texto discrepa del QR se repite la lectura y se pide revisión',async()=>{
  const {service,calls}=ocrService(['SSID: RedPrueba_7A\nWiFi Password: OtraClave99x']);
  const analysis=await analyzeRouterImage(photo,{decodeQr:async()=>qrResult,recognize:service});
  assert.equal(calls(),2);assert.equal(analysis.parsed.qrConflicts.password,true);assert.ok(buildScanPlan(analysis.parsed).fields.includes('password'));await service.dispose();
});
test('singlePass hace una única lectura aunque sea débil',async()=>{
  const {service,calls}=ocrService(['SSID: RedPrueba_7A']);await service(photo,{singlePass:true});assert.equal(calls(),1);await service.dispose();
});

test('un QR presente que no se puede leer se avisa; sin código no se inventa',async()=>{
  const damaged=qrImage([WIFI24],{damage:true});
  assert.ok(findQrPresence(damaged),'patrones de posición');
  const result=await decodeSynthetic(damaged);assert.equal(result.status,'not-found');assert.equal(result.unreadableQr,true);
  const blank={width:300,height:200,data:new Uint8ClampedArray(300*200*4).fill(255)};
  assert.equal(findQrPresence(blank),null);
  let seed=3;for(let o=0;o<blank.data.length;o+=4){seed=(seed*1103515245+12345)%2147483648;blank.data[o]=blank.data[o+1]=blank.data[o+2]=(seed>>16)%2?0:255;}
  assert.equal(findQrPresence(blank),null,'ruido');
  assert.equal((await decodeSynthetic(blank)).unreadableQr,undefined);
});

// ---------------------------------------------------------------- giro
test('foto girada: se prueba a 90 grados y se detiene al encontrar nombre y clave',async()=>{
  const turns=[],rotate=async(_blob,degrees)=>{turns.push(degrees);return new Blob([`giro-${degrees}`],{type:'image/jpeg'});};
  const recognize=async(blob,options={})=>{const upright=await blob.text()==='giro-90';const text=upright?'SSID: RedGirada_2C\nWiFi Password: Lm3nPq5rSt7u':'x';
    if(blob!==photo)assert.equal(options.singlePass,true);return {rawText:text,normalizedText:text,confidence:90,passes:[{id:'color',confidence:90,normalizedText:text}]};};
  const analysis=await analyzeRouterImage(photo,{decodeQr:async()=>({status:'not-found'}),recognize,rotate});
  assert.deepEqual(turns,[90]);assert.equal(analysis.rotation.degrees,90);assert.equal(analysis.parsed.ssid.value,'RedGirada_2C');
  assert.equal(buildScanPlan(analysis.parsed).state,'review','una lectura girada se confirma siempre');
});
test('el giro se intenta una vez por ángulo, respeta el tope y no se usa si ya hay lectura o QR',async()=>{
  const turns=[],rotate=async(_blob,degrees)=>{turns.push(degrees);return photo;},nothing=async()=>({rawText:'x',normalizedText:'x',passes:[]});
  await analyzeRouterImage(photo,{decodeQr:async()=>({status:'not-found'}),recognize:nothing,rotate});assert.deepEqual(turns,[90,270,180]);
  turns.length=0;let clock=0;await readRotatedLabel(photo,{recognize:nothing,parse:parseRouterLabel,rotate,budgetMs:15,now:()=>clock+=10});assert.equal(turns.length,1);
  turns.length=0;await analyzeRouterImage(photo,{decodeQr:async()=>({status:'not-found'}),recognize:ocrOf('SSID: RedPrueba_7A'),rotate});
  await analyzeRouterImage(photo,{decodeQr:async()=>qrResult,recognize:nothing,rotate});assert.deepEqual(turns,[]);
});
test('rotateImageBlob gira la imagen en un lienzo en memoria',async()=>{
  const calls=[],saved=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:400,height:200,close(){}});
  const canvas={width:0,height:0,getContext(){return {translate:(...a)=>calls.push(['translate',...a]),rotate:a=>calls.push(['rotate',a]),drawImage:(_i,...a)=>calls.push(['draw',...a])};},toBlob(callback){calls.push(['size',this.width,this.height]);callback(new Blob(['girada'],{type:'image/jpeg'}));}};
  try{await rotateImageBlob(photo,90,{canvasFactory:()=>canvas});}finally{if(saved===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=saved;}
  assert.deepEqual(calls,[['translate',100,200],['rotate',Math.PI/2],['draw',-200,-100,400,200],['size',200,400]]);
  assert.equal(canvas.width,0);
});

// ---------------------------------------------------------------- lectura en vivo
function clock(){
  let time=0,id=0;const queue=new Map();
  return {now:()=>time,setTimer:(fn,ms)=>{queue.set(++id,{fn,at:time+ms});return id;},clearTimer:key=>queue.delete(key),pending:()=>queue.size,
    async advance(ms){const end=time+ms;for(;;){const next=[...queue.entries()].filter(([,item])=>item.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;queue.delete(next[0]);time=next[1].at;next[1].fn();for(let i=0;i<12;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));}time=end;}};
}
function harness({frames=[],texts=[],withText=true}={}){
  const time=clock(),log={qr:[],text:[],status:[],closed:0};let frame=0,textFrame=0;
  const camera={stop:()=>log.closed++};
  const scanner=createLiveScanner({...time,readQr:async()=>frames[Math.min(frame++,frames.length-1)]||{networks:[]},
    readText:withText?async()=>texts[textFrame++]||null:null,
    onQr:async value=>{camera.stop();log.qr.push(value);},onText:async value=>{camera.stop();log.text.push(value);},onStatus:message=>log.status.push(message)});
  return {scanner,time,log,frames:()=>frame};
}
const wifiFrame=async()=>readQrFrame({pixels:qrImage([WIFI24],{scale:4})});

test('QR válido en vivo: una sola entrega, cámara cerrada y sin más lecturas',async()=>{
  const {scanner,time,log,frames}=harness({frames:[{networks:[]},await wifiFrame()]});
  scanner.start();await time.advance(5000);
  assert.equal(log.qr.length,1);assert.equal(log.closed,1);assert.equal(frames(),2);assert.equal(time.pending(),0);assert.equal(scanner.isRunning(),false);
  assert.equal(log.qr[0].networks[0].password,'Kx9mQ2vL8pZt');assert.equal(log.status.at(-1),LIVE_MESSAGES.found);
  scanner.start();await time.advance(2000);assert.equal(log.qr.length,1,'no se lee dos veces');
  const analysis=analysisFromLiveQr(log.qr[0].networks);
  assert.equal(buildScanPlan(analysis.parsed).state,'ready');
});
test('QR de administración en vivo: se ignora y sigue buscando',async()=>{
  const admin=await readQrFrame({pixels:qrImage([ADMIN_URL],{scale:4})});
  assert.deepEqual(admin.networks,[]);assert.equal(admin.other,true);
  const {scanner,time,log,frames}=harness({frames:[admin]});
  scanner.start();await time.advance(3000);
  assert.equal(log.qr.length,0);assert.equal(log.closed,0);assert.ok(frames()>8);assert.ok(scanner.isRunning());
  assert.ok(frames()<=14,'unas 4 o 5 lecturas por segundo como mucho');scanner.stop();assert.equal(time.pending(),0);
});
test('dos QR en el mismo fotograma se entregan juntos',async()=>{
  const both=await readQrFrame({pixels:qrImage([WIFI24,WIFI5],{scale:4})});
  assert.equal(both.networks.length,2);
});
test('no se abre un resultado con nombre o clave vacíos o con texto de etiqueta',()=>{
  assert.equal(usableQrNetwork({type:'wifi',ssid:'WiFi',password:'Kx9mQ2vL8pZt',security:'WPA/WPA2'}),false);
  assert.equal(usableQrNetwork({type:'wifi',ssid:'RedPrueba_7A',password:'',security:'WPA/WPA2'}),false);
  assert.equal(usableQrNetwork({type:'wifi',ssid:' ',password:'Kx9mQ2vL8pZt'}),false);
  assert.equal(usableQrNetwork({type:'wifi',ssid:'Invitados_9',password:'',security:'Sin contraseña'}),true);
});
const reading=(key='Kx9mQ2vL8pZt')=>{const read=readingFromOcr({rawText:`SSID: RedPrueba_7A\nWiFi Password: ${key}`,normalizedText:`SSID: RedPrueba_7A\nWiFi Password: ${key}`,confidence:82});return {...read,blob:photo};};
test('sin QR: captura automática solo con dos fotogramas seguidos coherentes',async()=>{
  const {scanner,time,log}=harness({texts:[reading(),reading('Kx9mQ2vL8pZ1'),null,reading(),reading()]});
  scanner.start();await time.advance(2500+1500*3);
  assert.equal(log.text.length,0,'lecturas distintas o interrumpidas no bastan');
  await time.advance(1600);assert.equal(log.text.length,1);assert.equal(log.closed,1);assert.equal(log.text[0].blob,photo);assert.equal(time.pending(),0);
});
test('una lectura de texto sin nombre, sin clave o dudosa no cuenta',()=>{
  for(const text of ['SSID: RedPrueba_7A','WiFi Password: Kx9mQ2vL8pZt','Nombre de red WiFi (2,4 GHz)\nContraseña de red WiFi','SSID: RedPrueba_7A\nWiFi Password: ab1'])
    assert.equal(readingFromOcr({rawText:text,normalizedText:text,confidence:90}),null,text);
  assert.equal(readingFromOcr({rawText:'SSID: RedPrueba_7A\nWiFi Password: Kx9mQ2vL8pZt',normalizedText:'SSID: RedPrueba_7A\nWiFi Password: Kx9mQ2vL8pZt',confidence:20}),null);
});
test('a los 20 s sin lectura aparece la ayuda sin cerrar la cámara; el texto deja de intentarse al minuto',async()=>{
  let texts=0;const time=clock(),status=[];
  const scanner=createLiveScanner({...time,readQr:async()=>({networks:[]}),readText:async()=>{texts++;return null;},onQr(){assert.fail();},onText(){assert.fail();},onStatus:message=>status.push(message)});
  scanner.start();await time.advance(19900);assert.ok(!status.includes(LIVE_MESSAGES.help));
  await time.advance(200);assert.equal(status.at(-1),LIVE_MESSAGES.help);assert.ok(scanner.isRunning());
  await time.advance(45000);const total=texts;await time.advance(10000);assert.equal(texts,total);assert.ok(total<=40);scanner.stop();
});
test('QR pequeño e ilegible repetido: «Acércate un poco más»',async()=>{
  const {scanner,time,log}=harness({frames:[{networks:[],small:true}],withText:false});
  scanner.start();await time.advance(1200);assert.equal(log.status.at(-1),LIVE_MESSAGES.closer);scanner.stop();
});
test('si falla el modo automático queda el flujo manual',async()=>{
  const time=clock(),status=[];let texts=0;
  const scanner=createLiveScanner({...time,readQr:async()=>({networks:[{type:'wifi',ssid:'RedPrueba_7A',password:'Kx9mQ2vL8pZt'}]}),readText:async()=>{texts++;throw new Error('ocr');},
    onQr:async()=>{throw new Error('pantalla');},onText(){},onStatus:message=>status.push(message)});
  scanner.start();await time.advance(500);assert.equal(status.at(-1),LIVE_MESSAGES.manual);assert.equal(time.pending(),0);
  const second=createLiveScanner({...time,readQr:async()=>{throw new Error('qr');},readText:async()=>{texts++;throw new Error('ocr');},onQr(){},onText(){}});
  second.start();await time.advance(15000);assert.equal(texts,2,'tras dos fallos de OCR no insiste');second.stop();
});
test('lo leído antes por texto se compara con el QR y la discrepancia pide revisión',()=>{
  const pass={id:'color',normalizedText:'SSID: RedPrueba_7A\nWiFi Password: OtraClave99x',confidence:80};
  const analysis=analysisFromLiveQr([{type:'wifi',ssid:'RedPrueba_7A',password:'Kx9mQ2vL8pZt',security:'WPA/WPA2'}],{passes:[pass,{...pass,id:'color-2'}]});
  assert.equal(analysis.parsed.qrConflicts.password,true);
});
test('el recorte sigue al marco y los lienzos se liberan',async()=>{
  const rect={left:0,top:0,width:400,height:600},guide={left:50,top:200,width:300,height:200};
  const area=guideRegion({videoWidth:800,videoHeight:1200,videoRect:rect,guideRect:guide,margin:0});
  assert.deepEqual(area,{x:100,y:400,width:600,height:400});
  assert.deepEqual(guideRegion({videoWidth:800,videoHeight:600}),{x:0,y:0,width:800,height:600});
  const canvases=[],video={videoWidth:800,videoHeight:1200,getBoundingClientRect:()=>rect};
  const frames=createVideoFrameSource(video,{barcodeDetector:null,guide:{getBoundingClientRect:()=>guide},
    canvasFactory:()=>{const canvas={width:0,height:0,getContext:()=>({drawImage(){},getImageData:(_x,_y,width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4).fill(255)})}),toBlob(callback){callback(new Blob(['f'],{type:'image/jpeg'}));}};canvases.push(canvas);return canvas;},
    recognize:async(_blob,options)=>{assert.equal(options.singlePass,true);return {rawText:'',normalizedText:'',confidence:90};}});
  assert.deepEqual((await frames.readQr()).networks,[]);assert.equal(await frames.readText(),null);
  frames.release();assert.ok(canvases.every(canvas=>canvas.width===0&&canvas.height===0));assert.equal(await frames.readQr(),null);
});

// ---------------------------------------------------------------- cámara, linterna y claves
function cameraWith(capabilities){
  const applied=[],track={readyState:'live',getCapabilities:()=>capabilities,applyConstraints:async value=>applied.push(value),stop(){this.readyState='ended';}};
  let asked;const session=createCameraSession({secureContext:true,urlApi:{createObjectURL:()=>'blob:x',revokeObjectURL(){}},mediaDevices:{getUserMedia:async constraints=>{asked=constraints;return {getTracks:()=>[track],getVideoTracks:()=>[track]};}}});
  return {session,applied,track,asked:()=>asked};
}
const video=()=>({videoWidth:1920,videoHeight:1080,setAttribute(){},async play(){},pause(){}});
test('cámara: alta resolución, enfoque continuo y linterna solo con soporte',async()=>{
  const full=cameraWith({focusMode:['continuous','manual'],torch:true});await full.session.open(video());
  assert.ok(full.asked().video.width.ideal>=1920&&full.asked().video.height.ideal>=1080);assert.equal(full.asked().video.facingMode.ideal,'environment');
  assert.deepEqual(full.applied,[{advanced:[{focusMode:'continuous'}]}]);assert.equal(full.session.supportsTorch(),true);
  assert.equal(await full.session.toggleTorch(),true);full.session.stop();assert.equal(full.track.readyState,'ended');assert.equal(full.session.supportsTorch(),false,'se apaga al cerrar');
  const plain=cameraWith({});await plain.session.open(video());assert.deepEqual(plain.applied,[]);assert.equal(plain.session.supportsTorch(),false);plain.session.dispose();
});
test('el fotograma leído se adopta como foto y la cámara queda cerrada',async()=>{
  const item=cameraWith({});await item.session.open(video());
  const image=item.session.adoptFrame(photo,{width:10,height:5});
  assert.equal(item.track.readyState,'ended');assert.equal(image.source,'camera');assert.equal(item.session.getState(),CAMERA_STATES.REVIEW);assert.equal(item.session.confirmImage().blob,photo);item.session.dispose();
});

const fictitious={id:'digi',name:'Perfil ficticio',scoringRules:[],passwordFormat:{alphabet:'hex-upper',length:10}};
test('claves: con alfabeto fijado se corrige y se anota; sin él se marca; nunca se inventa',()=>{
  assert.equal(applyPasswordFormat('O1B2C3D4Ex',{alphabet:'hex-upper',length:10}).value,'O1B2C3D4Ex','con un carácter sin opción válida no se toca nada');
  assert.equal(applyPasswordFormat('OAB2C3D4SE',{alphabet:'hex-upper',length:10}).value,'0AB2C3D45E');
  assert.equal(applyPasswordFormat('12O45l',{alphabet:'digits'}).value,'120451');
  assert.equal(applyPasswordFormat('12O45',{alphabet:'digits',length:8}).decided,false);
  assert.equal(applyPasswordFormat('12O45',null).value,'12O45');
  assert.deepEqual(doubtfulCharacters('aO7').map(item=>[item.position,item.char]),[[2,'O']]);
  assert.match(passwordHintText({password:'aO7l'}),/2\.º «O».*4\.º «l»/);
  const text='DIGI\nSSID: RedPrueba_7A\nWiFi Password: OAB2C3D4SE';
  const fixed=parseRouterLabel({normalizedText:text},{resolveProfile:()=>fictitious});
  assert.equal(fixed.password.value,'0AB2C3D45E');assert.equal(fixed.password.originalValue,'OAB2C3D4SE');assert.equal(fixed.password.characterCorrections.length,2);
  const untouched=parseRouterLabel({normalizedText:text});assert.equal(untouched.password.value,'OAB2C3D4SE');
});
test('una clave de QR no se modifica aunque el perfil fije el alfabeto',()=>{
  const parsed=parseRouterLabel({normalizedText:'DIGI',qr:{type:'wifi',ssid:'RedPrueba_7A',password:'OAB2C3D4SE',security:'WPA/WPA2'}},{resolveProfile:()=>fictitious});
  assert.equal(parsed.password.value,'OAB2C3D4SE');assert.equal(parsed.password.characterCorrections,undefined);
});
test('O/0 o I/l/1 leídos por OCR piden confirmación aunque la confianza sea alta',()=>{
  const text='SSID: RedPrueba_7A\nWiFi Password: Kx9mO2vL8pZt';
  const passes=[{id:'color',confidence:96,normalizedText:text},{id:'grayscale-contrast',confidence:95,normalizedText:text}];
  const plan=buildScanPlan(parseRouterLabel({normalizedText:text,passes}));
  assert.equal(plan.state,'review');assert.deepEqual(plan.fields,['password']);
  const clean=text.replace('mO2vL','mQ2vL'),ready=buildScanPlan(parseRouterLabel({normalizedText:clean,passes:passes.map(pass=>({...pass,normalizedText:clean}))}));
  assert.equal(ready.state,'ready');
  const html=renderScanReviewScreen({network:{ssid:'a',password:'aO'},fields:['password'],passwordHint:passwordHintText({password:'aO'}),qrHint:true});
  assert.match(html,/class="password-hint"/);assert.match(html,/acércate a la etiqueta/);
});

// ---------------------------------------------------------------- contrato de interfaz
test('contrato de la cámara: marco con texto, estado, disparador, galería y linterna oculta sin soporte',()=>{
  const app=source('../src/app.js'),css=source('../css/screens.css');
  const screen=app.match(/function cameraScreen\(\)\{[\s\S]*?\n/)[0];
  assert.match(screen,/<div class="camera-guide"><span>Pon la etiqueta dentro del marco, bien de frente y sin reflejos<\/span><\/div>/);
  assert.match(screen,/id="camera-live-status" role="status" hidden/);
  assert.match(screen,/data-action="capture"/);assert.match(screen,/id="gallery-input" type="file" accept="image\/\*"/);
  assert.match(screen,/data-action="toggle-torch" hidden/);assert.match(app,/torchButton\.hidden=!camera\.supportsTorch\(\);startLiveScan\(video\)/);
  assert.match(css,/\.camera-guide span\{[^}]*\}/);assert.doesNotMatch(css.match(/\.camera-guide span\{[^}]*\}/)[0],/nowrap/);
});
test('contrato de la lectura automática: cierra la cámara y entrega sin pulsar nada',()=>{
  const app=source('../src/app.js'),live=source('../src/live-scan.js');
  assert.match(app,/function finishLiveQr[^\n]*camera\.stop\(\)[^\n]*presentScanResult\(analysis\)/);
  assert.match(app,/function finishLiveText[^\n]*camera\.adoptFrame\(blob\)[^\n]*beginOcr\(\)/);
  assert.match(app,/camera\.subscribe\(\(\{state\}\)=>\{if\(state!=='live'\)stopLiveScan\(\);\}\)/);
  assert.match(app,/async function render\(\)\{stopLiveScan\(\);/);
  assert.match(app,/if\(action==='capture'\)\{button\.disabled=true;try\{await camera\.capture\(\)/,'el disparador manual sigue');
  assert.doesNotMatch(live,/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB/,'nada se guarda ni se envía');
});
