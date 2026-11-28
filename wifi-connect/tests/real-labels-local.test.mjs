// CONFIRMAR_CITAS-036: comparación LOCAL con fotos reales autorizadas. Las fotos y sus valores nunca están en el
// repositorio. Solo se ejecuta si FOTOS_PRUEBA_WIFI apunta a la carpeta local con `esperado.json` y
// `resultado_lector.json` (este lo genera el lector en un navegador); en cualquier otro equipo se salta.
// Los fallos solo nombran el campo: nunca se imprime un valor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';

const folder=process.env.FOTOS_PRUEBA_WIFI||'';
const files=folder?['esperado.json','resultado_lector.json'].map(name=>path.join(folder,name)):[];
const available=files.length>0&&files.every(file=>existsSync(file));

test('fotos reales locales: nombre de red y clave coinciden con lo esperado',{skip:available?false:'sin carpeta local de fotos de prueba'},()=>{
  const [expected,result]=files.map(file=>JSON.parse(readFileSync(file,'utf8')));
  const wrong=[];
  for(const [photo,values] of Object.entries(expected))for(const field of ['ssid','ssid_2_4','ssid_5','clave_wifi']){
    if(!values[field])continue;
    const ok=result[photo]?.[field]===values[field];
    console.log(`${photo} · ${field}: ${ok?'OK':'MAL'}`);if(!ok)wrong.push(`${photo} · ${field}`);
  }
  assert.equal(wrong.length,0,`campos que no coinciden: ${wrong.join(', ')}`);
});
