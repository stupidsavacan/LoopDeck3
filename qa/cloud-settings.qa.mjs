import {test,expect} from '@playwright/test';
test('cloud initial setup persists exclusions and never uploads unselected existing packs',async({page},info)=>{
 test.skip(!process.env.QA_BASE_URL,'Run against loopback HTTP preview; this test does not verify file:// CORS.');
 const errors=[],uploads=[];page.on('pageerror',e=>errors.push(e.message));
 const revision=id=>({packId:id,revision:1,title:'Cloud '+id,questions:1,size:100,sha256:'1'.repeat(64),contentFingerprint:'2'.repeat(64),committedAt:'2026-10-22T00:00:00Z'});
 await page.route('https://sync.qa.invalid/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':new URL(process.env.QA_BASE_URL).origin,'Access-Control-Allow-Headers':'Authorization,Content-Type,Idempotency-Key,X-Content-Fingerprint','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
  if(path==='/api/v1/auth/login'){await route.fulfill({status:200,headers,body:JSON.stringify({token:'a'.repeat(64),expiresAt:null})});return;}
  if(path==='/api/v1/packs'){await route.fulfill({status:200,headers,body:JSON.stringify({packs:[revision('old-local'),revision('cloud-only')],nextCursor:null,sequence:1})});return;}
  uploads.push(path);await route.fulfill({status:500,headers,body:'{"error":"unexpected_request"}'});
 });
 await page.goto(process.env.QA_BASE_URL);await expect(page.locator('.home-screen')).toBeVisible();
 await page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('loopdeck3-learning');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const pack={packVersion:1,packId:'old-local',title:'Existing local pack',folders:[{id:'old-f',title:'Folder'}],modules:[{id:'old-m',folderId:'old-f',title:'Module',subject:'demo',questionIds:['old-q']}],questions:[{id:'old-q',moduleId:'old-m',type:'input',prompt:'A?',answer:'A'}]};
  await new Promise((resolve,reject)=>{const tx=db.transaction('packs','readwrite');tx.objectStore('packs').put(pack);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
 });
 await page.locator('.cloud-sync-icon').click();await page.getByText('接続先を変更',{exact:true}).click();await page.getByLabel('API URL',{exact:true}).fill('https://sync.qa.invalid');await page.getByLabel('端末名',{exact:true}).fill('Browser QA');await page.getByLabel('合言葉',{exact:true}).fill('fixture');await page.getByRole('button',{name:'ログイン',exact:true}).click();
 await expect(page.getByRole('button',{name:'この設定で自動同期を開始'})).toBeVisible();
 const local=page.getByLabel(/共有する: Existing local pack/),excluded=page.getByLabel(/この端末への取り込みを除外: Cloud cloud-only/);await expect(local).not.toBeChecked();await excluded.check();
 await page.getByRole('button',{name:'この設定で自動同期を開始'}).click();await expect(page.getByRole('button',{name:'今すぐ再試行'})).toBeVisible();
 const snapshot=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('loopdeck3-learning');r.onsuccess=()=>resolve(r.result);});const tx=db.transaction(['cloudOutbox','packSync'],'readonly'),jobs=tx.objectStore('cloudOutbox').getAll(),states=tx.objectStore('packSync').getAll();await new Promise(resolve=>tx.oncomplete=resolve);db.close();return{jobs:jobs.result,states:states.result};});
 expect(snapshot.jobs).toHaveLength(0);expect(snapshot.states).toEqual(expect.arrayContaining([expect.objectContaining({packId:'old-local',mode:'localOnly'}),expect.objectContaining({packId:'cloud-only',mode:'localOnly'})]));expect(uploads).toEqual([]);expect(errors).toEqual([]);
 await page.screenshot({path:info.outputPath('cloud-settings.png'),fullPage:true});
});
