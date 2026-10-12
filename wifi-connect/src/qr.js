import {makeWifiPayload} from './utils.js';
export function renderQR(container,network,size=280){
 container.replaceChildren();const qr=window.qrcode(0,'M');qr.addData(makeWifiPayload(network),'Byte');qr.make();
 const holder=document.createElement('div');holder.innerHTML=qr.createSvgTag(6,4,'Código QR Wi-Fi',`Conectar a ${network.ssid}`);const svg=holder.firstElementChild;svg.setAttribute('role','img');svg.setAttribute('aria-label',`Código QR para conectarse a ${network.ssid}`);svg.style.width=`${size}px`;svg.style.height=`${size}px`;svg.style.maxWidth='100%';svg.style.display='block';container.append(svg);return svg;
}
export function svgToDataUrl(svg){return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;}
