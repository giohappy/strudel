import{P as w}from"./index.ec9f9930.js";var i,f=!1;async function b(a=38400){if(!f){if(f=!0,i)return i;if("serial"in navigator){const r=await navigator.serial.requestPort();await r.open({baudRate:a});const o=new TextEncoderStream;o.readable.pipeTo(r.writable);const s=o.writable.getWriter();i=function(e){s.write(e)}}else throw"Webserial is not available in this browser."}}const g=.1;w.prototype.serial=function(...a){return this._withHap(r=>{i||b(...a);const o=(s,e,u)=>{var t="";if(typeof e.value=="object")if("action"in e.value){t+=e.value.action+"(";var c=!0;for(const[n,l]of Object.entries(e.value))n!=="action"&&(c?c=!1:t+=",",t+=`${n}:${l}`);t+=")"}else for(const[n,l]of Object.entries(e.value))t+=`${n}:${l};`;else t=e.value;const v=(s-u+g)*1e3;window.setTimeout(i,v,t)};return r.setContext({...r.context,onTrigger:o})})};export{b as getWriter};