/**
 * Local camera/image pipeline for the upcoming OCR phase.
 * Image files and MediaStreams never leave this browser context.
 */
export const CAMERA_STATES=Object.freeze({IDLE:'idle',OPENING:'opening',LIVE:'live',REVIEW:'review',CONFIRMED:'confirmed',ERROR:'error',DISPOSED:'disposed'});
export function classifyCameraError(error,{secureContext=globalThis.isSecureContext}={}){
 if(secureContext===false||error?.name==='SecurityError')return {kind:'insecure',message:'La cámara necesita una conexión segura (HTTPS o localhost). Puedes seleccionar una foto existente.'};
 if(['NotAllowedError','PermissionDeniedError'].includes(error?.name))return {kind:'permission',message:'Permite el acceso a la cámara en los ajustes de tu navegador para fotografiar la etiqueta del router.'};
 if(['NotFoundError','DevicesNotFoundError','OverconstrainedError','ConstraintNotSatisfiedError','NotReadableError','TrackStartError'].includes(error?.name))return {kind:'unavailable',message:'No se ha podido abrir la cámara. Puedes seleccionar una fotografía existente.'};
 if(!globalThis.navigator?.mediaDevices?.getUserMedia)return {kind:'unavailable',message:'Este navegador no ofrece acceso a la cámara. Puedes seleccionar una fotografía existente.'};
 return {kind:'unavailable',message:'No se ha podido abrir la cámara. Puedes seleccionar una fotografía existente.'};
}
export function createCameraSession({mediaDevices=globalThis.navigator?.mediaDevices,urlApi=globalThis.URL,secureContext=globalThis.isSecureContext,canvasFactory=()=>globalThis.document.createElement('canvas')}={}){
 let stream=null,opening=null,sequence=0,candidate=null,confirmed=null,torchEnabled=false,videoTarget=null,state=CAMERA_STATES.IDLE;
 const listeners=new Set();
 const emit=(next,detail={})=>{state=next;for(const listener of listeners)listener({state,detail});};
 const revoke=image=>{if(image?.url){try{urlApi.revokeObjectURL(image.url);}catch{}}};
 const stopTracks=active=>{active?.getTracks?.().forEach(track=>{try{track.stop();}catch{}});};
 function stop(){sequence++;opening=null;if(stream){stopTracks(stream);stream=null;}if(videoTarget){try{videoTarget.pause?.();}catch{}try{videoTarget.srcObject=null;}catch{}videoTarget=null;}torchEnabled=false;if(state===CAMERA_STATES.LIVE||state===CAMERA_STATES.OPENING)emit(CAMERA_STATES.IDLE);}
 function clearReview(){if(candidate&&candidate!==confirmed)revoke(candidate);candidate=null;if(state===CAMERA_STATES.REVIEW)emit(CAMERA_STATES.IDLE);}
 function clearConfirmedImage(){if(confirmed)revoke(confirmed);if(candidate&&candidate!==confirmed)revoke(candidate);confirmed=null;candidate=null;if(state===CAMERA_STATES.CONFIRMED||state===CAMERA_STATES.REVIEW)emit(CAMERA_STATES.IDLE);}
 async function open(video){
  if(state===CAMERA_STATES.DISPOSED)return {ok:false,kind:'unavailable',message:'La cámara ya se ha cerrado.'};
  if(state===CAMERA_STATES.LIVE&&stream&&videoTarget===video)return {ok:true};
  if(opening)return opening;
  if(secureContext===false){const result=classifyCameraError(new Error('secure context required'),{secureContext});emit(CAMERA_STATES.ERROR,result);return {ok:false,...result};}
  if(!mediaDevices?.getUserMedia){const result={kind:'unavailable',message:'Este navegador no ofrece acceso a la cámara. Puedes seleccionar una fotografía existente.'};emit(CAMERA_STATES.ERROR,result);return {ok:false,...result};}
  stop();const mySequence=sequence;videoTarget=video;emit(CAMERA_STATES.OPENING);
  opening=(async()=>{
   let acquired;
   try{
    const preferred={audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:30}}};
    try{acquired=await mediaDevices.getUserMedia(preferred);}catch(error){
     if(['NotAllowedError','PermissionDeniedError','SecurityError','NotReadableError'].includes(error?.name))throw error;
     // Older Safari/devices may reject a facingMode or resolution constraint. Retry with browser defaults.
     acquired=await mediaDevices.getUserMedia({audio:false,video:true});
    }
    if(mySequence!==sequence||state===CAMERA_STATES.DISPOSED){stopTracks(acquired);return {ok:false,kind:'cancelled',message:'La cámara se ha cerrado.'};}
    stream=acquired;video.srcObject=stream;video.muted=true;video.playsInline=true;video.setAttribute?.('playsinline','');video.setAttribute?.('muted','');
    await video.play?.();
    if(!video.videoWidth&&video.addEventListener)await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);video.removeEventListener?.('loadedmetadata',finish);video.removeEventListener?.('loadeddata',finish);resolve();};const timer=setTimeout(finish,1800);video.addEventListener('loadedmetadata',finish,{once:true});video.addEventListener('loadeddata',finish,{once:true});});
    if(mySequence!==sequence){stopTracks(acquired);return {ok:false,kind:'cancelled',message:'La cámara se ha cerrado.'};}
    emit(CAMERA_STATES.LIVE);return {ok:true};
   }catch(error){if(acquired)stopTracks(acquired);if(stream===acquired)stream=null;if(mySequence!==sequence)return {ok:false,kind:'cancelled',message:'La cámara se ha cerrado.'};const result=classifyCameraError(error,{secureContext});if(videoTarget){try{videoTarget.srcObject=null;}catch{}}videoTarget=null;emit(CAMERA_STATES.ERROR,result);return {ok:false,...result};}
   finally{if(mySequence===sequence)opening=null;}
  })();
  return opening;
 }
 async function capture(video=videoTarget){
  if(!stream||!video||state!==CAMERA_STATES.LIVE)throw new Error('La cámara no está activa.');
  const width=video.videoWidth,height=video.videoHeight;if(!width||!height)throw new Error('La cámara todavía no ha preparado la imagen. Espera un momento y vuelve a intentarlo.');
  const canvas=canvasFactory();canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{alpha:false});if(!context){canvas.width=canvas.height=0;throw new Error('No se pudo preparar la fotografía en este dispositivo.');}
  context.drawImage(video,0,0,width,height);
  let blob;try{blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('No se pudo crear la fotografía.')),'image/jpeg',0.94));}finally{canvas.width=canvas.height=0;}
  clearReview();const url=urlApi.createObjectURL(blob);candidate={blob,url,mimeType:blob.type||'image/jpeg',width,height,source:'camera',createdAt:new Date().toISOString()};stop();emit(CAMERA_STATES.REVIEW);return publicImage(candidate);
 }
 async function selectImage(file){
  if(!file||!file.type?.startsWith('image/'))throw new Error('Selecciona un archivo de imagen.');
  clearReview();if(confirmed){clearConfirmedImage();}
  stop();const url=urlApi.createObjectURL(file);candidate={blob:file,url,mimeType:file.type,width:null,height:null,source:'gallery',createdAt:new Date().toISOString()};
  // Read dimensions for UI and future OCR metadata; the original image Blob is retained without Base64 conversion.
  if(typeof globalThis.Image==='function')try{const img=new Image();if(typeof img.decode==='function'){img.src=url;await img.decode();}else await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});candidate.width=img.naturalWidth||null;candidate.height=img.naturalHeight||null;}catch{}
  emit(CAMERA_STATES.REVIEW);return publicImage(candidate);
 }
 function publicImage(image){return image?{blob:image.blob,url:image.url,mimeType:image.mimeType,width:image.width,height:image.height,source:image.source,createdAt:image.createdAt}:null;}
 function confirmImage(){if(!candidate)throw new Error('No hay ninguna fotografía para confirmar.');confirmed=candidate;candidate=null;emit(CAMERA_STATES.CONFIRMED);return publicImage(confirmed);}
 function discardReview(){clearReview();if(state!==CAMERA_STATES.DISPOSED)emit(CAMERA_STATES.IDLE);}
 function getConfirmedImage(){return publicImage(confirmed);}
 function getPreviewImage(){return publicImage(candidate);}
 function supportsTorch(){const track=stream?.getVideoTracks?.()[0];try{return !!track?.getCapabilities?.().torch&&typeof track.applyConstraints==='function';}catch{return false;}}
 async function toggleTorch(){if(!supportsTorch())return false;const track=stream.getVideoTracks()[0];torchEnabled=!torchEnabled;try{await track.applyConstraints({advanced:[{torch:torchEnabled}]});return torchEnabled;}catch{torchEnabled=!torchEnabled;return false;}}
 function subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}
 function dispose(){stop();clearConfirmedImage();emit(CAMERA_STATES.DISPOSED);listeners.clear();}
 return {open,stop,capture,selectImage,confirmImage,discardReview,clearConfirmedImage,getConfirmedImage,getPreviewImage,supportsTorch,toggleTorch,subscribe,dispose,getState:()=>state,getStream:()=>stream};
}
