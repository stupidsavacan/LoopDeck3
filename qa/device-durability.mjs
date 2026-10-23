import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const pkg='com.loopdeck3.app.syncpreview.debug',serial='ZY22GSDPFW',adb=(...a)=>execFileSync('adb',['-s',serial,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let browser,port,page;const result=[];
async function attach(){const pid=adb('shell','pidof',pkg);port=adb('forward','tcp:0','localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('https://appassets.androidplatform.net/assets/loopdeck/index.html'));}
await attach();
try{for(const durability of ['relaxed','relaxed','strict','strict']){
 const key=Date.now().toString();await page.evaluate(async({durability,key})=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('loopdeck3-durability-probe',1);r.onupgradeneeded=()=>r.result.createObjectStore('probe');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});globalThis.durabilityProbe=db;const tx=db.transaction('probe','readwrite',{durability});tx.objectStore('probe').put(new Uint8Array(1024*1024).fill(123),key);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});},{durability,key});
 adb('shell','am','force-stop',pkg);await browser.close().catch(()=>{});adb('forward','--remove','tcp:'+port);adb('shell','am','start','-n',pkg+'/com.loopdeck3.app.MainActivity');await new Promise(resolve=>setTimeout(resolve,700));await attach();
 const size=await page.evaluate(async key=>{const db=await new Promise(resolve=>{const r=indexedDB.open('loopdeck3-durability-probe');r.onsuccess=()=>resolve(r.result);});const r=db.transaction('probe').objectStore('probe').get(key);const value=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result));db.close();return value?.length??0;},key);result.push({durability,key,expectedBytes:1024*1024,actualBytes:size,status:size===1024*1024?'PASS':'FAIL'});console.log(JSON.stringify(result.at(-1)));
}}finally{if(browser)await browser.close();if(port)adb('forward','--remove','tcp:'+port);writeFileSync('qa-results/public/durability-results.json',JSON.stringify({environment:'separate diagnostic IndexedDB; never touches user stores',tests:result},null,2));}
