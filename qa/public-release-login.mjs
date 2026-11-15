import {execFileSync, spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {mkdirSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';

const serial=process.env.P3_SERIAL;
assert.ok(serial, 'P3_SERIAL must select the authorized physical device.');
const pkg='com.loopdeck3.app',mode=process.argv[2]??'login';
assert.ok(['snapshot','login','verify'].includes(mode));
const adb=(...args)=>execFileSync(process.env.ADB??'adb',['-s',serial,...args],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']}).trim();
let phrase;
if(mode!=='snapshot'){
 assert.ok(process.stdin.isTTY,'Use a PTY for hidden passphrase input.');
 process.stdin.setRawMode(true);console.log('PRIVATE_INPUT_READY');
 const input=createInterface({input:process.stdin});
 for await(const line of input){phrase=JSON.parse(line).phrase;input.close();break;}
 process.stdin.pause();
}
let instrument,port,helperInstalled=false;
try{
 assert.equal(adb('get-state'),'device');
 assert.match(adb('install','-r','android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk'),/Success/);helperInstalled=true;
 const socketName='loopdeck-release-qa-'+randomUUID();let output='',error='',done=false,exitCode;
 instrument=spawn(process.env.ADB??'adb',['-s',serial,'shell','am','instrument','-w','-r','-e','ui','true','-e','socket',socketName,pkg+'.test/com.loopdeck3.app.ReleaseSmokeInstrumentation'],{stdio:['ignore','pipe','pipe']});
 instrument.stdout.on('data',b=>output+=b);instrument.stderr.on('data',b=>error+=b);instrument.on('exit',code=>{done=true;exitCode=code;});
 const until=async(check,timeout)=>{const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await delay(300);}throw Error('Public release UI check timed out.');};
 await until(()=>output.includes('qa=READY')||done,60000);assert.ok(!done,'Instrumentation did not start.');
 port=adb('forward','tcp:0','localabstract:'+socketName);
 await new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:Number(port)},()=>{const bytes=Buffer.from(JSON.stringify({phase:mode==='snapshot'?'snapshotOnly':'loginOnly',packId:'public-release-check',phrase})),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);socket.write(Buffer.concat([length,bytes]));});socket.on('close',resolve);socket.on('error',reject);});phrase=undefined;
 await until(()=>done,240000);assert.equal(exitCode,0);assert.ok(!error.trim());
 const result=JSON.parse(/INSTRUMENTATION_RESULT: qaResult=(\{.*\})/.exec(output)?.[1]??'{}');
 assert.equal(result.status,'PASS',JSON.stringify(result));
 if(mode!=='snapshot'){assert.equal(result.apiOrigin,'https://loopdeck3-sync-20261022.salmon1124.chatgpt.site');assert.ok(result.http.some(r=>r.path==='/api/v1/packs'&&r.status===200));}
 mkdirSync('qa-results',{recursive:true});writeFileSync(`qa-results/public-release-${mode}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 phrase=undefined;if(port)adb('forward','--remove','tcp:'+port);
 if(instrument&&!instrument.killed)instrument.kill();
 if(helperInstalled)adb('uninstall',pkg+'.test');
}
