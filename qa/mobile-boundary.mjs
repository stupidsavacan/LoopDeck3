import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import {contentFingerprint} from '../server/generated/pack-protocol.mjs';
import {pollPage} from './async-poll.mjs';

const serial=process.env.P3_SERIAL??'ZY22GSDPFW',pkg='com.loopdeck3.app.syncpreview.debug';
assert.ok(!serial.includes(':')&&!serial.includes('_adb-'),'USB transport required for Wi-Fi switching');
const base='https://loopdeck3-sync-20261022.salmon1124.chatgpt.site',out='qa-results/public';mkdirSync(out,{recursive:true});
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
const exists=name=>{try{adb('shell','run-as',pkg,'test','-f','no_backup/cloud-sync/'+name);return true;}catch{return false;}};
const nativeJson=name=>JSON.parse(adb('shell','run-as',pkg,'cat','no_backup/cloud-sync/'+name));
function transport(){const raw=adb('shell','dumpsys','connectivity'),active=/Active default network:\s*(\d+)/.exec(raw)?.[1];const row=raw.split('\n').find(l=>l.includes('NetworkAgentInfo{network{'+active+'}'));return{networkId:active??null,transport:/\bWIFI\b/.test(row??'')?'WIFI':/\b(MOBILE|CELLULAR)\b/.test(row??'')?'CELLULAR':'OTHER'};}
const result={environment:'USB-connected physical Android, actual SIM cellular and Wi-Fi; native fixture jobs; Activity/WebView destroyed during transfers',serial,checks:[]};
function record(name,detail){result.checks.push({name,status:'PASS',detail});console.log('PASS '+name);writeFileSync(out+'/mobile-boundary-results.json',JSON.stringify(result,null,2));}
async function until(name,fn,timeout=180000){const end=Date.now()+timeout;let nextLog=Date.now()+20000;while(Date.now()<end){const value=await fn();if(value)return value;if(Date.now()>nextLog){console.log('WAIT '+name);nextLog=Date.now()+20000;}await delay(1000);}throw Error(name+' timed out');}
async function make(id,size){const p={packVersion:1,packId:id,title:'Mobile boundary dummy '+id,folders:[{id:id+'-f',title:'Folder'}],modules:[{id:id+'-m',folderId:id+'-f',title:'Module',subject:'dummy',questionIds:[id+'-q']}],questions:[{id:id+'-q',moduleId:id+'-m',type:'input',prompt:'Boundary?',answer:'yes'}]},z=new JSZip(),{modules,questions,...manifest}=p;for(const[k,v]of Object.entries({manifest,modules,questions}))z.file(k+'.json',JSON.stringify(v));z.file('padding.bin',new Uint8Array(0));const overhead=(await z.generateAsync({type:'uint8array',compression:'STORE'})).length;z.file('padding.bin',new Uint8Array(size-overhead));const bytes=await z.generateAsync({type:'uint8array',compression:'STORE'});assert.equal(bytes.length,size);return{p,bytes,size,sha:createHash('sha256').update(bytes).digest('hex'),fp:await contentFingerprint(p,[]),op:randomUUID()};}
let browser,page,port,token,wifiChanged=false,before,initialWifi;
async function attach(){const pid=adb('shell','pidof',pkg);assert.match(pid,/^\d+$/);port=adb('forward','tcp:0','localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().split('#')[0]==='https://appassets.androidplatform.net/assets/loopdeck/index.html');assert.ok(page);}
async function disconnect(){if(browser)await browser.close().catch(()=>{});browser=undefined;page=undefined;if(port)adb('forward','--remove','tcp:'+port);port=undefined;}
async function snapshot(){return page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('loopdeck3-learning');r.onsuccess=()=>resolve(r.result);});const names=['packs','cloudOutbox','attempts','bookmarks','reviewCards','reviewLogs'],tx=db.transaction(names),req=Object.fromEntries(names.map(n=>[n,tx.objectStore(n).getAll()]));await new Promise(resolve=>tx.oncomplete=resolve);db.close();const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))].map(b=>b.toString(16).padStart(2,'0')).join('');const learning={};for(const n of names.slice(2))learning[n]={count:req[n].result.length,sha256:await digest(req[n].result)};const packs={};for(const p of req.packs.result)packs[p.packId]=await digest(p);return{learning,packs,outboxCount:req.cloudOutbox.result.length};});}
try{
 result.android=adb('shell','getprop','ro.build.version.release');assert.ok(adb('shell','getprop','gsm.sim.state').includes('LOADED'));
 initialWifi=/Wi-?Fi is enabled/i.test(adb('shell','cmd','wifi','status'));
 await attach();await page.evaluate(()=>{document.querySelector('.cloud-sync-dialog')?.close();location.hash='home';});
 token=await page.evaluate(()=>LoopDeckCloud.token());assert.ok(token,'Existing preview session needed; login through UI first');
 const http=(path,options={})=>fetch(base+'/api/v1'+path,{...options,headers:{...options.headers,Authorization:'Bearer '+token},redirect:'error'});
 assert.equal((await http('/auth/me')).status,200);
 await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.dataset.status==='ready',null,{timeout:120000});before=await snapshot();assert.equal(before.outboxCount,0,'Preserve pre-existing queued work');
 record('USB device has SIM and authenticated preview session',{android:result.android,network:transport(),learning:before.learning});
 adb('shell','svc','wifi','disable');wifiChanged=true;
 await until('cellular default route',()=>transport().transport==='CELLULAR',60000);await delay(2000);
 await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.dataset.status==='ready',null,{timeout:120000});
 await page.evaluate(()=>{const last=setInterval(()=>{},1000);for(let n=1;n<=last;n++)clearInterval(n);});
 record('Wi-Fi disabled; actual default network is cellular',transport());
 const run=Date.now(),small=await make('mobile-tx-5m-'+run,5*1024*1024),large=await make('mobile-tx-plus-'+run,5*1024*1024+1),receive=await make('mobile-rx-plus-'+run,5*1024*1024+1);
 const response=await http('/packs/'+receive.p.packId+'/revisions',{method:'POST',headers:{'Content-Type':'application/zip','Idempotency-Key':receive.op},body:receive.bytes});assert.equal(response.status,201);const receiveHead=await response.json();
 const heads=(await(await http('/packs')).json()).packs;
 const states=Object.fromEntries(heads.map(h=>[h.packId,{packId:h.packId,mode:'localOnly',generation:0,dirty:false}]));
 states[receive.p.packId]={packId:receive.p.packId,mode:'enabled',generation:0,dirty:false};
 const jobs={};for(const [i,f]of [small,large].entries()){states[f.p.packId]={packId:f.p.packId,mode:'enabled',generation:1,dirty:true};jobs[f.op]={packId:f.p.packId,generation:1};f.job={opId:f.op,packId:f.p.packId,generation:1,size:f.size,sha256:f.sha,fingerprint:f.fp,createdAt:Date.now()+i};}
 // Native mirror is isolated for this test; the user's IndexedDB is untouched.
 assert.ok(await page.evaluate(state=>LoopDeckCloud.mirror(JSON.stringify(state)),{setupComplete:true,states,jobs}));
 for(const f of [small,large]){assert.ok(await page.evaluate(j=>LoopDeckCloud.begin(JSON.stringify(j)),f.job));for(let offset=0;offset<f.size;offset+=49152)assert.ok(await page.evaluate(({op,offset,b64})=>LoopDeckCloud.append(op,offset,b64),{op:f.op,offset,b64:Buffer.from(f.bytes.slice(offset,offset+49152)).toString('base64')}));}
 for(const f of [small,large])assert.ok(await page.evaluate(op=>LoopDeckCloud.finish(op),f.op));
 const block=adb('shell','am','stack','list').split(/(?=RootTask id=)/).filter(b=>b.includes('taskId=')&&b.includes(pkg+'/com.loopdeck3.app.MainActivity'));assert.equal(block.length,1);assert.ok([...block[0].matchAll(/taskId=\d+: ([^\s]+)/g)].every(m=>m[1].startsWith(pkg+'/')),'Only remove the preview task');const root=/RootTask id=(\d+)/.exec(block[0])[1];adb('shell','am','stack','remove',root);result.webViewClosedAt=new Date().toISOString();
 await until('preview WebView destruction',()=>page.isClosed(),10000);assert.ok(!adb('shell','am','stack','list').includes(pkg+'/com.loopdeck3.app.MainActivity'));await disconnect();
 record('MainActivity task removed and WebView actually destroyed',{rootTaskId:root,closedAt:result.webViewClosedAt});
 const smallAck=await until('cellular 5 MiB native ACK',()=>exists(small.op+'.ack.json')?nativeJson(small.op+'.ack.json'):undefined);assert.equal(smallAck.sha256,small.sha);assert.ok(Date.parse(smallAck.committedAt)>=Date.parse(result.webViewClosedAt));
 const smallKey='remote-'+createHash('sha256').update(small.p.packId).digest('hex')+'-'+smallAck.revision;
 await until('cellular 5 MiB native download',()=>exists(smallKey+'.remote.json'));
 assert.equal(adb('shell','run-as',pkg,'sha256sum','no_backup/cloud-sync/'+smallKey+'.zip').split(/\s/)[0],small.sha);
 assert.equal(transport().transport,'CELLULAR');record('exactly 5 MiB uploads and downloads over cellular after WebView destruction',{packId:small.p.packId,size:small.size,revision:smallAck.revision,sha256:small.sha,network:transport()});
 const receiveKey='remote-'+createHash('sha256').update(receive.p.packId).digest('hex')+'-'+receiveHead.revision;
 for(let n=0;n<30;n++){assert.equal(transport().transport,'CELLULAR');assert.ok(!exists(large.op+'.ack.json'));assert.ok(!exists(receiveKey+'.zip'));await delay(1000);}
 const held=nativeJson(large.op+'.job.json');assert.equal(held.attempts??0,0);assert.ok(!(await(await http('/packs')).json()).packs.some(h=>h.packId===large.p.packId));
 record('5 MiB plus one byte deferred for upload and download on cellular',{observationSeconds:30,size:large.size,uploadPackId:large.p.packId,downloadPackId:receive.p.packId,uploadHttpAttempts:held.attempts??0,network:transport()});
 adb('shell','svc','wifi','enable');await until('Wi-Fi default route',()=>transport().transport==='WIFI',120000);record('Wi-Fi connectivity restored',transport());
 const largeAck=await until('natural WorkManager retry on Wi-Fi',()=>exists(large.op+'.ack.json')?nativeJson(large.op+'.ack.json'):undefined,240000);assert.equal(largeAck.sha256,large.sha);
 await until('Wi-Fi deferred native download',()=>exists(receiveKey+'.remote.json'),180000);assert.equal(adb('shell','run-as',pkg,'sha256sum','no_backup/cloud-sync/'+receiveKey+'.zip').split(/\s/)[0],receive.sha);
 const downloaded=await http(`/packs/${large.p.packId}/revisions/${largeAck.revision}/download`);assert.equal(downloaded.status,200);assert.equal(createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex'),large.sha);
 record('deferred upload/download resumes via normal WorkManager retry on Wi-Fi',{size:large.size,uploadRevision:largeAck.revision,uploadSha256:large.sha,downloadRevision:receiveHead.revision,downloadSha256:receive.sha,network:transport(),forcedJobSchedulerRun:false});
}catch(e){result.checks.push({name:'mobile boundary QA exception',status:'FAIL',error:e.message});console.log('FAIL '+e.message);process.exitCode=1;}
finally{
 if(wifiChanged&&initialWifi)try{adb('shell','svc','wifi','enable');await until('restore original Wi-Fi route',()=>transport().transport==='WIFI',120000);}catch(e){result.restoreError=e.message;}
 try{await disconnect();adb('shell','am','start','-n',pkg+'/com.loopdeck3.app.MainActivity');await delay(1000);await attach();await page.evaluate(()=>{document.querySelector('.cloud-sync-dialog')?.close();location.hash='home';dispatchEvent(new Event('online'));});await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.dataset.status==='ready',null,{timeout:120000});const after=await snapshot();if(before){assert.deepEqual(after.learning,before.learning);for(const[id,hash]of Object.entries(before.packs))assert.equal(after.packs[id],hash,'Existing pack changed: '+id);record('learning and existing local packs unchanged; native mirror restored from IndexedDB',{learning:after.learning,originalPackCount:Object.keys(before.packs).length,newPackCount:Object.keys(after.packs).length});}}catch(e){result.restorationCheckError=e.message;process.exitCode=1;console.log('FAIL restoration check: '+e.message);}
 await disconnect();token=undefined;writeFileSync(out+'/mobile-boundary-results.json',JSON.stringify(result,null,2));
}
