import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
const serial=process.env.P3_SERIAL??'ZY22GSDPFW',pkg='com.loopdeck3.app.syncpreview.debug',base='https://loopdeck3-sync-20261022.salmon1124.chatgpt.site';assert.ok(!serial.includes('_adb-')&&!serial.includes(':'),'USB required');
const adb=(...a)=>execFileSync('adb',['-s',serial,...a],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
function transport(){const raw=adb('shell','dumpsys','connectivity'),id=/Active default network:\s*(\d+)/.exec(raw)?.[1],row=raw.split('\n').find(l=>l.includes('NetworkAgentInfo{network{'+id+'}'));return{networkId:id??null,transport:/\bWIFI\b/.test(row??'')?'WIFI':/\b(MOBILE|CELLULAR)\b/.test(row??'')?'CELLULAR':'OTHER'};}
const exists=n=>{try{adb('shell','run-as',pkg,'test','-f','no_backup/cloud-sync/'+n);return true;}catch{return false;}};
const size=n=>{try{return Number(adb('shell','run-as',pkg,'stat','-c','%s','no_backup/cloud-sync/'+n));}catch{return 0;}};
const result={environment:'Recovery after reboot QA interrupted by USB disconnect; automatic boot transfer is NOT verified',checks:[]};
const record=(name,detail)=>{result.checks.push({name,status:'PASS',detail});console.log('PASS '+name);writeFileSync('qa-results/public/reboot-recovery-results.json',JSON.stringify(result,null,2));};
async function until(name,f,timeout=180000){const end=Date.now()+timeout;let next=Date.now()+20000;while(Date.now()<end){const value=await f();if(value)return value;if(Date.now()>next){console.log('WAIT '+name);next=Date.now()+20000;}await delay(200);}throw Error(name+' timed out');}
let browser,page,port,token,before,wifiOff=false;
async function attach(){const pid=adb('shell','pidof',pkg);port=adb('forward','tcp:0','localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().split('#')[0]==='https://appassets.androidplatform.net/assets/loopdeck/index.html');assert.ok(page);}
async function disconnect(){if(browser)await browser.close().catch(()=>{});browser=undefined;page=undefined;if(port)adb('forward','--remove','tcp:'+port);port=undefined;}
async function snapshot(){return page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('loopdeck3-learning');r.onsuccess=()=>resolve(r.result);});const names=['packs','attempts','bookmarks','reviewCards','reviewLogs','cloudOutbox'],tx=db.transaction(names),req=Object.fromEntries(names.map(n=>[n,tx.objectStore(n).getAll()]));await new Promise(resolve=>tx.oncomplete=resolve);db.close();const hashes={};for(const n of names)hashes[n]={count:req[n].result.length,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(req[n].result))))].map(b=>b.toString(16).padStart(2,'0')).join('')};return hashes;});}
try{
 await until('stable WebView attachment',async()=>{try{await attach();return true;}catch{await disconnect();return false;}},60000);
 await page.evaluate(()=>{document.querySelector('.cloud-sync-dialog')?.close();location.hash='home';dispatchEvent(new Event('online'));});
 await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.dataset.status==='ready',null,{timeout:120000});
 const baseline=JSON.parse((await import('node:fs')).readFileSync('qa-results/public/wifi-loss-results.json','utf8')).checks.at(-1).detail.snapshot;
 const after=await snapshot();for(const n of Object.keys(baseline).filter(n=>n!=='packs'))assert.deepEqual(after[n],baseline[n]);
 const packEvidence=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('loopdeck3-learning');r.onsuccess=()=>resolve(r.result);});const rows=await new Promise(resolve=>{const r=db.transaction('packs').objectStore('packs').getAll();r.onsuccess=()=>resolve(r.result);});db.close();const original=rows.filter(p=>!p.packId.startsWith('os-reboot-'));return{packIds:rows.map(p=>p.packId),originalCount:original.length,originalSha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(original))))].map(b=>b.toString(16).padStart(2,'0')).join('')};});assert.equal(packEvidence.originalCount,baseline.packs.count);assert.equal(packEvidence.originalSha256,baseline.packs.sha256);result.packEvidence=packEvidence;
 record('original packs, learning stores and empty outbox unchanged after OS reboot',{snapshot:after,network:transport()});
 const token=await page.evaluate(()=>LoopDeckCloud.token());const r=await fetch(base+'/api/v1/auth/me',{headers:{Authorization:'Bearer '+token},redirect:'error'});assert.equal(r.status,200);
 record('Keystore session usable after OS reboot',{httpStatus:r.status});
 const headsResponse=await fetch(base+'/api/v1/packs',{headers:{Authorization:'Bearer '+token},redirect:'error'});assert.equal(headsResponse.status,200);const heads=(await headsResponse.json()).packs;
 const reboot=JSON.parse((await import('node:fs')).readFileSync('qa-results/public/reboot-results.json','utf8'));
 const id=reboot.checks[0].detail.packId;result.rebootPackPublished=heads.some(h=>h.packId===id);result.automaticBootResume='UNVERIFIED: USB disconnected; cleanup launched Activity before observation completed';
 record('normal preview restored',{syncStatus:'ready',nativeFiles:adb('shell','run-as',pkg,'ls','no_backup/cloud-sync').split('\n').filter(Boolean)});
}catch(e){result.checks.push({name:'recovery exception',status:'FAIL',error:e.message});process.exitCode=1;console.log('FAIL '+e.message);}
finally{await disconnect();writeFileSync('qa-results/public/reboot-recovery-results.json',JSON.stringify(result,null,2));}
