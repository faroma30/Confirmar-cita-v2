export async function pasteClipboardText({clipboard,target,onSuccess=()=>{},onFailure=()=>{}}){
 try{
  if(typeof clipboard?.readText!=='function')throw new Error('Clipboard API unavailable');
  target.value=await clipboard.readText();
  onSuccess();
  return true;
 }catch{
  target?.focus();
  onFailure();
  return false;
 }
}
