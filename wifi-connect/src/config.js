/**
 * Development-only UI host allowlists. Remote validation also requires an exact
 * pathname entry so a GitHub Pages hostname cannot authorize other repositories.
 */
export const DEV_ACCESS={
  validationHosts:['localhost','127.0.0.1','::1','faroma30.github.io'],
  debugHosts:['localhost','127.0.0.1','::1'],
  validationPaths:{'faroma30.github.io':'/Netlixy/'},
};
const normalizeHost=hostname=>String(hostname||'').toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
const LOCAL_HOSTS=new Set(['localhost','127.0.0.1','::1']);
export function isAllowedDevelopmentHost(hostname,allowedHosts=[]){
  const normalized=normalizeHost(hostname);
  return allowedHosts.some(host=>normalizeHost(host)===normalized);
}
export function hasAuthorizedMode(locationLike,parameter,allowedHosts){
  if(!locationLike||new URLSearchParams(locationLike.search||'').get(parameter)!=='1')return false;
  if(!isAllowedDevelopmentHost(locationLike.hostname,allowedHosts))return false;
  // Local development can use HTTP. Any explicitly allowed remote host must use HTTPS.
  return LOCAL_HOSTS.has(normalizeHost(locationLike.hostname))||locationLike.protocol==='https:';
}
function pathIsWithinBase(pathname,basePath){
  const base=String(basePath||'').trim();
  if(!base.startsWith('/'))return false;
  const root=base.replace(/\/+$/,'')||'/';
  const path=String(pathname||'/');
  return path===root||path.startsWith(`${root}/`);
}
export function isValidationAccessAllowed(locationLike,allowedHosts=DEV_ACCESS.validationHosts,validationPaths=DEV_ACCESS.validationPaths){
  if(!hasAuthorizedMode(locationLike,'validation',allowedHosts))return false;
  const host=normalizeHost(locationLike.hostname);
  if(LOCAL_HOSTS.has(host))return true;
  return pathIsWithinBase(locationLike.pathname,validationPaths?.[host]);
}
export const isDebugAccessAllowed=(locationLike,allowedHosts=DEV_ACCESS.debugHosts)=>hasAuthorizedMode(locationLike,'debug',allowedHosts);
