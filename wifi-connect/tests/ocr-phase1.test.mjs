import test from 'node:test';
import assert from 'node:assert/strict';
import {findSsidRecoveryRegions} from '../src/ssid-focus.js?v=3co3';
import {parseRouterLabel} from '../src/router-parser.js?v=3co3';
import {createOcrService} from '../src/ocr.js?v=3co3';

test('bounded OCR recovery targets SSID rows and excludes credential/identifier rows',()=>{
 const lines=[
  {text:'SSID',bbox:{x0:40,y0:40,x1:240,y1:60}},
  {text:'WLAN Key: p4ssword',bbox:{x0:40,y0:80,x1:230,y1:100}},
  {text:'MAC Address: 00:11:22:33:44:55',bbox:{x0:40,y0:120,x1:240,y1:140}},
  {text:'Serial Number: ABC12345',bbox:{x0:40,y0:160,x1:240,y1:180}}
 ];
 const found=findSsidRecoveryRegions([{paragraphs:[{lines}]}],400,300,{limit:2});
 assert.equal(found.length,1); assert.equal(found[0].source,'ocr_region');
 assert.ok(found[0].region.left+found[0].region.width<=400);
});
test('sparse OCR falls back to one bounded center crop with sparse-text segmentation',()=>{
 const found=findSsidRecoveryRegions([],1000,1200);
 assert.equal(found.length,1); assert.equal(found[0].source,'center_crop'); assert.equal(found[0].psm,'11');
 assert.ok(found[0].region.width<=780&&found[0].region.height<=936);
});
test('generic Spanish and English labels keep multiple networks and explicit 6 GHz band',()=>{
 const parsed=parseRouterLabel({normalizedText:['Wireless Network: Casa_24G','Red inalámbrica: Oficina','WiFi 6G: Casa_6G','Wireless Key: aB#12345678'].join('\n')});
 for(const name of ['Casa_24G','Oficina','Casa_6G']) assert.ok(parsed.ssidCandidates.some(item=>item.value===name),name);
 assert.equal(parsed.ssidCandidates.find(item=>item.value==='Casa_6G')?.band,'6 GHz');
 assert.ok(parsed.passwordCandidates.some(item=>item.value==='aB#12345678'));
});
test('admin, WPS, serial, MAC and numeric PIN fields are not promoted to SSIDs',()=>{
 const parsed=parseRouterLabel({normalizedText:['Admin Password: admin-secret','WPS PIN: 12345678','SN: ABCD123456789','MAC Address: 00:11:22:33:44:55'].join('\n')});
 assert.equal(parsed.ssidCandidates.length,0);
});
test('zero-candidate color and contrast scans trigger one bounded recovery and recover its result',async()=>{
 let calls=0; const segmentation=[];
 const service=createOcrService({
  paths:()=>({}),
  preprocess:async(_blob,{variant})=>({blob:new Blob([variant],{type:'image/jpeg'}),previewBlob:null,sourceWidth:400,sourceHeight:600,width:400,height:600}),
  loadEngine:async()=>({PSM:{AUTO:'3'},createWorker:async()=>({
   setParameters:async value=>segmentation.push(value.tessedit_pageseg_mode),
   recognize:async()=>{calls++;return {data:{text:calls<3?'Router label':'SSID: RecoveredNet',confidence:calls<3?40:95,blocks:[]}};},
   terminate:async()=>{}
  })})
 });
 const result=await service(new Blob(['synthetic'],{type:'image/jpeg'}));
 assert.equal(calls,3); assert.match(result.normalizedText,/RecoveredNet/);
 assert.equal(result.focusAttemptCount,1); assert.deepEqual(segmentation,['11','3']);
 await service.dispose();
});