import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const pkg='com.loopdeck3.app.syncpreview.debug',serial='ZY22GSDPFW',base='https://loopdeck3-sync-20261022.salmon1124.chatgpt.site',out='qa-results/public';mkdirSync(out,{recursive:true});
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8',timeout:30000}).trim();
if(process.stdin.isTTY)process.stdin.setRawMode(true);console.log('READY_SECRET_STDIN');
let phrase;const rl=createInterface({input:process.stdin});for await(const line of rl){phrase=JSON.parse(line).passphrase;rl.close();break;}
const pid=adb('shell','pidof',pkg),port=adb('forward','tcp:0','localabstract:webview_devtools_remote_'+pid);
const result={package:pkg,serial,android:adb('shell','getprop','ro.build.version.release'),checks:[],http:[]};const save=()=>writeFileSync(out+'/device-results.json',JSON.stringify(result,null,2));
const record=(name,detail)=>{result.checks.push({name,status:'PASS',detail});console.log('PASS',name);save();};let browser;
try{
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);const pages=browser.contexts().flatMap(c=>c.pages());const page=pages.find(p=>p.url().split('#')[0]==='https://appassets.androidplatform.net/assets/loopdeck/index.html');assert.ok(page,'exact app asset WebView: '+pages.map(p=>p.url()).join(','));
 result.origin=await page.evaluate(()=>location.origin);result.userAgent=await page.evaluate(()=>navigator.userAgent);
 page.on('response',r=>{if(r.url().startsWith(base+'/api/v1/')){result.http.push({method:r.request().method(),path:new URL(r.url()).pathname,status:r.status()});save();}});
 await page.locator('.cloud-sync-icon').click();if(await page.getByLabel('合言葉',{exact:true}).count()){await page.getByLabel('端末名',{exact:true}).fill('Physical moto g13');await page.getByLabel('合言葉',{exact:true}).fill(phrase);phrase=undefined;await page.getByRole('button',{name:'ログイン',exact:true}).click();
 await page.getByRole('button',{name:'この設定で自動同期を開始'}).waitFor({timeout:60000});record('real WebView HTTPS login with pinned origin',{origin:result.origin});
 for(const c of await page.locator('.cloud-sync-dialog input[type=checkbox]').all())await c.check();
 await page.getByRole('button',{name:'この設定で自動同期を開始'}).click();}await page.getByRole('button',{name:'今すぐ再試行'}).waitFor({timeout:60000});await page.getByRole('button',{name:'閉じる',exact:true}).click();
 const states=async()=>page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('loopdeck3-learning');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const names=['packs','packAssets','cloudOutbox','packSync','attempts','bookmarks','reviewCards','reviewLogs','cloudConfig'];const tx=db.transaction(names,'readonly'),requests=Object.fromEntries(names.map(n=>[n,tx.objectStore(n).getAll()]));await new Promise(resolve=>tx.oncomplete=resolve);db.close();return Object.fromEntries(names.map(n=>[n,requests[n].result]));});
 const before=await states();assert.ok(before.cloudConfig.find(x=>x.key==='settings').token==='@android-keystore');record('token persisted only as Keystore reference',{reference:'@android-keystore'});
 const pack={packVersion:1,packId:'physical-android-auto',title:'Physical Android dummy',folders:[{id:'device-f',title:'Folder'}],modules:[{id:'device-m',folderId:'device-f',title:'Module',subject:'dummy',questionIds:['device-q']}],questions:[{id:'device-q',moduleId:'device-m',type:'input',prompt:'2+2?',answer:'4'}]};
 page.on('dialog',d=>d.accept());if(!before.packs.some(p=>p.packId===pack.packId)){await page.evaluate(()=>location.hash='import');await page.locator('.import-screen').waitFor();await page.locator('input[type=file]').evaluate((input,p)=>{const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(p)],'physical-dummy.loopdeck.json',{type:'application/json'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));},pack);await page.getByRole('button',{name:'この教材を取り込む',exact:true}).click();await page.locator('.home-screen').waitFor();}else{await page.evaluate(()=>location.hash='home');await page.locator('.home-screen').waitFor();}
 await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.getAttribute('data-status')==='ready',null,{timeout:90000});
 let state=await states();assert.equal(state.cloudOutbox.length,0);assert.ok(state.packSync.find(x=>x.packId===pack.packId)?.remoteRevision);record('UI import automatically uploads and acknowledges durable outbox',{state:state.packSync.find(x=>x.packId===pack.packId)});
 // Explicitly authorized public builtin material passes through the normal importer UI.
 await page.evaluate(()=>location.hash='import');await page.locator('.import-screen').waitFor();const bytes=readFileSync('../../outputs/phase2/pc-builtin-roundtrip.loopdeck.zip').toString('base64');await page.locator('input[type=file]').evaluate((input,b64)=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],'public-builtin.loopdeck.zip',{type:'application/zip'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));},bytes);
 await page.getByRole('button',{name:/^別パックとして取り込む/}).click();await page.locator('.home-screen').waitFor();await page.waitForFunction(()=>document.querySelector('.cloud-sync-icon')?.dataset.status==='ready',null,{timeout:90000});
 state=await states();const builtin=state.packs.find(p=>p.packId==='loopdeck-builtin-v1');assert.equal(builtin?.questions.length,1112);assert.equal(state.cloudOutbox.length,0);record('authorized builtin ZIP normal importer and automatic upload',{questions:builtin.questions.length,images:state.packAssets.filter(a=>a.packId===builtin.packId).length,sync:state.packSync.find(x=>x.packId===builtin.packId)});
 for(const name of ['attempts','bookmarks','reviewCards','reviewLogs'])assert.deepEqual(state[name],before[name]);record('learning stores unchanged by import and sync',{stores:['attempts','bookmarks','reviewCards','reviewLogs']});
 const blocked=await page.evaluate(async()=>{const rows=[];for(const url of ['https://example.org/','https://loopdeck3-sync-20261022.salmon1124.chatgpt.site/','https://loopdeck3-sync-20261022.salmon1124.chatgpt.site/api/v1/unauthorized']){try{const r=await fetch(url);rows.push({url,blocked:!r.ok,status:r.status});}catch{rows.push({url,blocked:true});}}return rows;});assert.ok(blocked.every(x=>x.blocked));record('unapproved hosts/resources stay blocked',blocked);
 await page.screenshot({path:out+'/device-public-sync.png',fullPage:true});
}catch(e){result.checks.push({name:'device QA exception',status:'FAIL',error:e.message});console.log('FAIL',e.message);process.exitCode=1;}
finally{phrase=undefined;if(browser)await browser.close();adb('forward','--remove','tcp:'+port);save();}
