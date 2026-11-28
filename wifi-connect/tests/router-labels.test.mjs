// CONFIRMAR_CITAS-036: formatos de etiqueta de la auditoría y reporte #da905659. Todos los valores son ficticios.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRouterLabel} from '../src/router-parser.js';
import {buildScanPlan,createScannedNetwork} from '../src/scan-flow.js';

const SSID='RedPrueba_7A',KEY='Kx9mQ2vL8pZt';
const parse=text=>parseRouterLabel({rawText:text,normalizedText:text});
const both=(text,ssid=SSID,key=KEY)=>{const result=parse(text);assert.equal(result.ssid?.value,ssid,'nombre de red');assert.equal(result.password?.value,key,'contraseña');return result;};

const ssidFormats=[
  `Nombre de red WiFi (2,4 GHz): ${SSID}`,
  `Nombre de la red (SSID): ${SSID}`,
  `Network Name (SSID): ${SSID}`,
  `Nombre de red WiFi (2,4 GHz):\n${SSID}`,
  `Nombre de red 2.4G: ${SSID}`,
  `WiFi Network: ${SSID}`,
  `Nombre de red WiFi (5 GHz) ${SSID}`,
  `N0mbre de red WlFi (2,4 GH2): ${SSID}`,
  `Nombre de la red WiFi:\n${SSID}`
];
for(const format of ssidFormats)test(`nombre de red: ${format.replace('\n',' / ')}`,()=>{
  const result=both(`${format}\nWiFi Password: ${KEY}`);
  assert.equal(buildScanPlan(result).candidate?.value,SSID,'el flujo acepta la etiqueta');
});

const keyFormats=[
  `Contraseña de red WiFi: ${KEY}`,
  `Contraseña de la red: ${KEY}`,
  `Clave de seguridad Wi-Fi: ${KEY}`,
  `Clave de seguridad: ${KEY}`,
  `Wireless Password/PIN: ${KEY}`,
  `Wireless Password/PIN ${KEY}`,
  `WiFi-Key: ${KEY}`,
  `WLAN-Key: ${KEY}`,
  `Contraseña de redes WiFi:\n${KEY}`,
  `Contrasefia de red WiFi\n${KEY}`
];
for(const format of keyFormats)test(`contraseña: ${format.replace('\n',' / ')}`,()=>{both(`SSID: ${SSID}\n${format}`);});

test('formatos que ya salían bien (Movistar, O2, Digi, Huawei y líneas separadas)',()=>{
  both(`Movistar\nNombre de red WiFi\n${SSID}\nContraseña WiFi\n${KEY}`);
  both(`O2\nSSID: ${SSID}\nClave WiFi: ${KEY}`);
  both(`DIGI\nSSID: ${SSID}\nWiFi Password: ${KEY}`);
  both(`SSID1: ${SSID}\nWLAN Key: ${KEY}`);
  both(`SSID\n${SSID}\nPassword\n${KEY}`);
});

const SERCOMM=['SERCOMM Router WiFi','Nombre de red WiFi (2,4 GHz):','SercommDEMO','Nombre de red WiFi (5 GHz):','SercommDEMO_5G',
  'Contraseña de redes WiFi:',KEY,'URL: http://192.168.0.1 Usuario: demo','Contraseña acceso router:','Zz8kAdminDemo'].join('\n');

for(const [name,text] of [['con dos puntos',SERCOMM],['sin dos puntos',SERCOMM.replace(/(GHz\)|redes WiFi|acceso router):/g,'$1')],
  ['«Contraseña de red WiFi» sin dos puntos',SERCOMM.replace('redes WiFi:','red WiFi')]])test(`reporte #da905659 (texto ficticio, ${name})`,()=>{
  const result=parse(text),ssids=result.ssidCandidates.map(item=>item.value),keys=result.passwordCandidates.map(item=>item.value);
  assert.deepEqual(ssids.sort(),['SercommDEMO','SercommDEMO_5G']);
  assert.deepEqual(keys,[KEY],'ni «WiFi» ni la clave de acceso al router');
  const plan=buildScanPlan(result);
  assert.equal(plan.state,'choose-band');
  assert.deepEqual(plan.choices.map(item=>item.band).sort(),['2.4 GHz','5 GHz']);
  assert.equal(createScannedNetwork(result,plan.choices[0]).password,KEY);
});

test('un fragmento de etiqueta nunca es nombre de red ni contraseña',()=>{
  for(const text of ['Nombre de red WiFi (2,4 GHz)','Contraseña de red WiFi','SSID: WiFi (2,4 GHz)','WiFi Password: WiFi','Nombre de red: de red WiFi','Clave de seguridad: Wi-Fi']){
    const result=parse(text);
    assert.deepEqual(result.ssidCandidates.map(item=>item.value),[],text);
    assert.deepEqual(result.passwordCandidates.map(item=>item.value),[],text);
  }
});

test('la clave de acceso al router nunca es la clave Wi-Fi',()=>{
  for(const label of ['Contraseña acceso router','Contraseña de acceso al router','Admin password','Contraseña de administrador','Router Password','Clave del router']){
    for(const text of [`SSID: ${SSID}\n${label}: Zz8kAdminDemo`,`SSID: ${SSID}\n${label}\nZz8kAdminDemo`,`SSID: ${SSID}\n${label} Zz8kAdminDemo`]){
      const result=parse(text);
      assert.deepEqual(result.passwordCandidates.map(item=>item.value),[],text.replace('\n',' / '));
    }
  }
});

test('confianza honesta: valor corto o con texto de etiqueta pide revisión',()=>{
  const short=parse(`SSID: ${SSID}\nWiFi Password: ab1`);
  assert.ok(short.password.score<=60&&short.password.needsReview);
  const labelled=parse(`SSID: Red WiFi Casa\nWiFi Password: ${KEY}`);
  assert.ok(labelled.ssid.score<=60&&labelled.ssid.needsReview);
  assert.ok(buildScanPlan(labelled).fields.includes('ssid'));
});

test('restos del QR junto a la etiqueta: no son el nombre y se propone el valor limpio, a revisar',()=>{
  const color=['Nombre de red WiFi (2,4 GH7) o ea a','e y Z).','SercommDEMO , o cm n m','Nombre de red WiFi (5 GHz): Ee','SercommDEMO_5G','Contraseña de redes WiFi:',KEY].join('\n');
  const gray=['Nombre de red WiFi (2,4 GHz):','SercommDEMO 5 AE','Nombre de red WiFi (5 GHz):','SercommDEMO_5G [2172','Contraseña de redes WiFi:',KEY,'Usuario: demo |'].join('\n');
  const passes=[{id:'color',confidence:72,normalizedText:color},{id:'grayscale-contrast',confidence:76,normalizedText:gray}];
  const result=parseRouterLabel({normalizedText:[...new Set(`${color}\n${gray}`.split('\n'))].join('\n'),passes});
  const plan=buildScanPlan(result);
  const offered=plan.choices.map(choice=>createScannedNetwork(result,choice).ssid).sort();
  assert.deepEqual(offered,['SercommDEMO','SercommDEMO_5G']);
  assert.ok(result.ssidCandidates.every(item=>!/^(o ea a|Usuario)/.test(item.value)));
  assert.ok(result.ssidCandidates.filter(item=>item.value==='Ee').every(item=>item.score<=55&&item.needsReview));
  for(const choice of plan.choices)assert.ok(buildScanPlan(result,{selectedCandidate:choice}).fields.includes('password'),'siempre a revisar');
});
