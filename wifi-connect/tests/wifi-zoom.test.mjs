// CONFIRMAR_CITAS-038: etiquetas pequeñas, «Network:», separadores mal leídos y lectura ampliada. Valores ficticios.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRouterLabel} from '../src/router-parser.js';
import {buildScanPlan,createScannedNetwork} from '../src/scan-flow.js';
import {analyzeRouterImage} from '../src/router-image-analysis.js';

const KEY='Kx9mQ2vL8pZt';
const parse=text=>parseRouterLabel({rawText:text,normalizedText:text});
const photo=new Blob(['foto'],{type:'image/jpeg'});
const noQr=async()=>({status:'not-found'});
const reading=(text,extra={})=>({rawText:text,normalizedText:text,confidence:70,passes:[{id:'color',confidence:70,normalizedText:text}],...extra});

for(const separator of [':',';'])test(`«Network${separator}» junto a «WiFi-Key» es el nombre de red`,()=>{
  const result=parse(`Network${separator} REDDEMO-1234\nWiFi-Key: ${KEY}\nGUI: http://192.168.1.1/\nuser/pwd: user / Zz8kAdmin`);
  assert.equal(result.ssid?.value,'REDDEMO-1234');
  assert.deepEqual(result.passwordCandidates.map(item=>item.value),[KEY]);
  assert.equal(buildScanPlan(result).candidate?.value,'REDDEMO-1234');
});

test('«Network» sin separador o sin etiqueta Wi-Fi no inventa un nombre de red',()=>{
  assert.equal(parse(`Network operator\nWiFi-Key: ${KEY}`).ssidCandidates.some(item=>item.value==='operator'),false);
  assert.equal(parse('Network: Fibra\nModel: X1').ssidCandidates.length,0);
});

for(const label of ['user/pwd','useripwd','Username / Password'])test(`«${label}» es el acceso al router, nunca la clave Wi-Fi`,()=>{
  const result=parse(`SSID: RedDemo_01\n${label}: user / Zz8kAdmin`);
  assert.deepEqual(result.passwordCandidates,[]);
});

test('«SSID2- valor» (dos puntos leídos como guion) se lee y apoya la propuesta de banda de la otra red',()=>{
  const result=parse(`SSID1: DEMO-2 4G-ab12
SSID2- DEMO-5G-ab12
WLAN Key: ${KEY}`),plan=buildScanPlan(result);
  assert.deepEqual(plan.choices.map(choice=>createScannedNetwork(result,choice).ssid).sort(),['DEMO-2.4G-ab12','DEMO-5G-ab12']);
});

test('sin la pareja SSID1/SSID2 no se reconstruyen separadores',()=>{
  for(const name of ['Casa - Demo','DEMO- 5G- ab12','DEMO-2 4G-ab12']){
    const result=parse(`SSID: ${name}
WiFi Password: ${KEY}`);
    assert.equal(createScannedNetwork(result,buildScanPlan(result).choices[0]).ssid,name);
  }
});

test('nombre sin etiqueta antes de «Contrasenya WPA» con un signo suelto delante',()=>{
  const result=parse('-Demo_A1B2C3\ncontrasenya WPA\nab12cd34ef'),plan=buildScanPlan(result);
  assert.equal(plan.state,'review');
  assert.equal(createScannedNetwork(result,plan.choices[0]).ssid,'Demo_A1B2C3');
});

test('«2,46 SSID» (la G leída como 6) y «5G SSID» dan las dos bandas; «Login Password» queda fuera',()=>{
  const result=parse(`Username:user\nLogin Password:userdemo99\n2,46 SSID:\nFIBRADEMO-Ab1c\n5G SSID:\nFIBRADEMO-PLUS-Ab1c\nWi-Fi Password:\n${KEY}`);
  const plan=buildScanPlan(result);
  assert.equal(plan.state,'choose-band');
  assert.deepEqual(plan.choices.map(item=>item.band).sort(),['2.4 GHz','5 GHz']);
  assert.deepEqual(result.passwordCandidates.map(item=>item.value),[KEY]);
});

test('la zona de la etiqueta sale de las líneas con palabras de etiqueta',async()=>{
  const {findLabelRegion}=await import('../src/zoom-read.js');
  const block=lines=>[{paragraphs:[{lines}]}],line=(text,x0,y0,x1,y1)=>({text,bbox:{x0,y0,x1,y1}});
  assert.equal(findLabelRegion(block([line('Model: X1',100,100,300,130)]),2000,1000),null);
  const region=findLabelRegion(block([line('Network: x',800,600,1000,630),line('WiFi-Key: y',800,660,1100,690)]),2000,1000);
  assert.ok(region.x<.4&&region.y<.6&&region.x+region.width>.65&&region.y+region.height>.69&&region.width*region.height<.6);
});

function fakes(first,enlarged){
  const regions=[];
  return {regions,zoom:async(_blob,region)=>{regions.push(region);return new Blob([`zoom-${regions.length}`],{type:'image/jpeg'});},
    recognize:async(blob,options={})=>{if(blob===photo)return reading(first);assert.equal(options.singlePass,true);const text=await blob.text();return reading(text.startsWith('zoom-')?enlarged:'x');},
    rotate:async()=>photo};
}

test('etiqueta pequeña: sin nombre ni clave se relee ampliada y queda para revisar',async()=>{
  const fake=fakes('Model: X1\nS/N 0000',`Network: REDDEMO-1234\nWiFi-Key: ${KEY}`);
  const analysis=await analyzeRouterImage(photo,{decodeQr:noQr,...fake});
  const plan=buildScanPlan(analysis.parsed);
  assert.equal(plan.state,'review');
  assert.deepEqual({...createScannedNetwork(analysis.parsed,plan.choices[0])}.ssid,'REDDEMO-1234');
  assert.equal(analysis.parsed.password.value,KEY);
  assert.deepEqual({used:analysis.zoom.used,attempts:analysis.zoom.attempts},{used:true,attempts:1});
});

test('la lectura ampliada solo rellena lo que faltaba',async()=>{
  const fake=fakes(`SSID: RedBuena_01\nModel: X1`,`SSID: OtraLectura\nWiFi-Key: ${KEY}`);
  const analysis=await analyzeRouterImage(photo,{decodeQr:noQr,...fake});
  assert.equal(analysis.parsed.ssid.value,'RedBuena_01');
  assert.equal(analysis.parsed.password.value,KEY);
});

test('la lectura ampliada descarta trozos con signos raros, para a los tres intentos y respeta el tope',async()=>{
  const {readZoomedLabel,mergeZoomedCandidates}=await import('../src/zoom-read.js');
  const fake=fakes('x','WiFi-Key: 4? ¡2 ABC');
  const result=await readZoomedLabel(photo,{recognize:fake.recognize,parse:parseRouterLabel,zoom:fake.zoom,regions:[{x:0,y:0,width:.5,height:.5}]});
  assert.equal(result.best,null);assert.equal(result.attempts,3);assert.equal(mergeZoomedCandidates(parse('x'),result.best),false);
  let clock=0;const limited=await readZoomedLabel(photo,{recognize:fake.recognize,parse:parseRouterLabel,zoom:fake.zoom,budgetMs:15,now:()=>clock+=10});
  assert.equal(limited.attempts,1);
});

test('con nombre y clave ya leídos, o con un QR Wi-Fi, no se amplía',async()=>{
  const complete=fakes(`SSID: RedDemo_01\nWiFi Password: ${KEY}`,'x');
  await analyzeRouterImage(photo,{decodeQr:noQr,...complete});
  const qr={status:'wifi',networks:[{type:'wifi',ssid:'RedQr',password:KEY,security:'WPA/WPA2',hidden:false}],type:'wifi',ssid:'RedQr',password:KEY,security:'WPA/WPA2'};
  const withQr=fakes('x','x');
  await analyzeRouterImage(photo,{decodeQr:async()=>qr,...withQr});
  assert.deepEqual([complete.regions,withQr.regions],[[],[]]);
});

test('zoomImageBlob recorta la zona pedida y la amplía en un lienzo en memoria',async()=>{
  const {zoomImageBlob}=await import('../src/image-processing.js');
  const calls=[],saved=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>({width:1000,height:800,close(){}});
  const canvas={width:0,height:0,getContext(){return {drawImage:(_image,...args)=>calls.push(args)};},toBlob(callback){calls.push([this.width,this.height]);callback(new Blob(['z'],{type:'image/jpeg'}));}};
  try{await zoomImageBlob(photo,{x:.25,y:0,width:.5,height:1},{canvasFactory:()=>canvas});}finally{if(saved===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=saved;}
  assert.deepEqual(calls,[[250,0,500,800,0,0,1250,2000],[1250,2000]]);
  assert.equal(canvas.width,0);
});
