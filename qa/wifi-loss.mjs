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
const result={environment:'USB-connected physical SIM phone; native 32 MiB download, destroyed WebView, actual Wi-Fi loss with cellular available',checks:[]};
const record=(name,detail)=>{result.checks.push({name,status:'PASS',detail});console.log('PASS '+name);writeFileSync('qa-results/public/wifi-loss-results.json',JSON.stringify(result,null,2));};
async function until(name,f,timeout=180000){const end=Date.now()+timeout;let next=Date.now()+20000;while(Date.now()<end){const value=await f();if(value)return value;if(Date.now()>next){console.log('WAIT '+name);next=Date.now()+20000;}await delay(200);}throw Error(name+' timed out');}
let browser,page,port,token,before,wifiOff=false;
async function attach(){const pid=adb('shell','pidof',pkg);port=adb('forward','tcp:0','localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().split('#')[0]==='https://appassets.androidplatform.net/assets/loopdeck/index.html');assert.ok(page);}
async function disconnect(){if(browser)await browser.close().catch(()=>{});browser=undefined;page=undefined;if(port)adb('forward','--remove','tcp:'+port);port=undefined;}
async function snapshot(){return page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('loopdeck3-learning');r.onsuccess=()=>resolve(r.result);});const names=['packs','attempts','bookmarks','reviewCards','reviewLogs','cloudOutbox'],tx=db.transaction(names),req=Object.fromEntries(names.map(n=>[n,tx.objectStore(n).getAll()]));await new Promise(resolve=>tx.oncomplete=resolve);db.close();const hashes={};for(const n of names)hashes[n]={count:req[n].result.length,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(req[n].result))))].map(b=>b.toString(16).padStart(2,'0')).join('')};return hashes;});}
try{
 assert.equal(transport().transport,'WIFI');await attach();await page.evaluate(()=>{document.querySelector('.cloud-sync-dialog')?.close();location.hash='home';});await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.dataset.status==='ready',null,{timeout:120000});before=await snapshot();assert.equal(before.cloudOutbox.count,0);
 token=await page.evaluate(()=>LoopDeckCloud.token());assert.ok(token);const r=await fetch(base+'/api/v1/packs',{headers:{Authorization:'Bearer '+token},redirect:'error'});assert.equal(r.status,200);const heads=(await r.json()).packs,head=heads.find(h=>h.packId==='public-boundary-32');assert.equal(head?.size,32*1024*1024);
 const key='remote-'+createHash('sha256').update(head.packId).digest('hex')+'-'+head.revision;
 const states=Object.fromEntries(heads.map(h=>[h.packId,{packId:h.packId,mode:'localOnly',generation:0,dirty:false}]));states[head.packId]={packId:head.packId,mode:'enabled',generation:0,dirty:false};
 await page.evaluate(()=>{const last=setInterval(()=>{},1000);for(let n=1;n<=last;n++)clearInterval(n);});
 // Remove any older native staging of this test pack before requesting it again.
 const excluded={...states,[head.packId]:{packId:head.packId,mode:'localOnly',generation:0,dirty:false}};assert.ok(await page.evaluate(s=>LoopDeckCloud.mirror(JSON.stringify({setupComplete:true,states:s,jobs:{}})),excluded));assert.ok(!exists(key+'.zip'));assert.ok(!exists(key+'.zip.part'));
 assert.ok(await page.evaluate(s=>LoopDeckCloud.mirror(JSON.stringify({setupComplete:true,states:s,jobs:{}})),states));
 const blocks=adb('shell','am','stack','list').split(/(?=RootTask id=)/).filter(b=>b.includes(pkg+'/com.loopdeck3.app.MainActivity'));assert.equal(blocks.length,1);assert.ok([...blocks[0].matchAll(/taskId=\d+: ([^\s]+)/g)].every(m=>m[1].startsWith(pkg+'/')));adb('shell','am','stack','remove',/RootTask id=(\d+)/.exec(blocks[0])[1]);await until('WebView destruction',()=>page.isClosed(),10000);await disconnect();
 const interruptedBytes=await until('partial native 32 MiB ZIP',()=>{const n=size(key+'.zip.part');return n>0&&n<head.size/2?n:undefined;});assert.equal(transport().transport,'WIFI');
 adb('shell','svc','wifi','disable');wifiOff=true;await until('cellular default route',()=>transport().transport==='CELLULAR',60000);
 record('Wi-Fi disconnected during a real native download',{packId:head.packId,revision:head.revision,expectedBytes:head.size,bytesObservedBeforeCut:interruptedBytes,networkAfterCut:transport(),webViewDestroyed:true});
 await until('partial ZIP discarded after connection loss',()=>!exists(key+'.zip.part'),90000);
 for(let n=0;n<30;n++){assert.equal(transport().transport,'CELLULAR');assert.ok(!exists(key+'.zip'),'Large download must not finish over cellular');assert.ok(!exists(key+'.remote.json'));await delay(1000);}
 record('large transfer aborts and remains deferred on cellular',{observationSeconds:30,completeZipAbsent:true,stagedMetadataAbsent:true,partialZipRemoved:true,network:transport()});
 adb('shell','svc','wifi','enable');wifiOff=false;await until('Wi-Fi recovery',()=>transport().transport==='WIFI',120000);
 await until('natural retry completes native download',()=>exists(key+'.remote.json'),300000);assert.equal(size(key+'.zip'),head.size);assert.equal(adb('shell','run-as',pkg,'sha256sum','no_backup/cloud-sync/'+key+'.zip').split(/\s/)[0],head.sha256);
 record('native retry completes on Wi-Fi with exact SHA-256',{bytes:head.size,sha256:head.sha256,network:transport(),forcedJobSchedulerRun:false});
}catch(e){result.checks.push({name:'Wi-Fi loss QA exception',status:'FAIL',error:e.message});console.log('FAIL '+e.message);process.exitCode=1;}
finally{
 try{if(wifiOff){adb('shell','svc','wifi','enable');await until('restore Wi-Fi',()=>transport().transport==='WIFI',120000);}await disconnect();adb('shell','am','start','-n',pkg+'/com.loopdeck3.app.MainActivity');await delay(1000);await attach();await page.evaluate(()=>{document.querySelector('.cloud-sync-dialog')?.close();location.hash='home';dispatchEvent(new Event('online'));});await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.dataset.status==='ready',null,{timeout:120000});const after=await snapshot();if(before){assert.deepEqual(after,before);record('Wi-Fi, native mirror and all existing study data restored',{snapshot:after});}}catch(e){result.restoreError=e.message;process.exitCode=1;console.log('FAIL restore: '+e.message);}await disconnect();token=undefined;writeFileSync('qa-results/public/wifi-loss-results.json',JSON.stringify(result,null,2));
}
