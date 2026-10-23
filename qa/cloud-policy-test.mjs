import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
mkdirSync('qa-results',{recursive:true});
const dir=mkdtempSync(resolve('qa-results','cloud-policy-'));
const harness=`import com.loopdeck3.app.CloudPolicy;
public class CloudPolicyTest {
 static int cases=0;static void check(boolean value){cases++;if(!value)throw new AssertionError("case "+cases);}
 public static void main(String[] args){String host="https://sync.owner.chatgpt.site";
 String[] gets={"/api/v1/health","/api/v1/auth/me","/api/v1/packs","/api/v1/packs?after=a%2Fb","/api/v1/packs/a/revisions","/api/v1/packs/a/revisions/2/download"};
 for(String path:gets){check(CloudPolicy.permits(host,host+path,"GET"));check(CloudPolicy.permits(host,host+path,"OPTIONS"));}
 String[] posts={"/api/v1/auth/login","/api/v1/auth/logout","/api/v1/auth/logout-all","/api/v1/packs/a/revisions","/api/v1/packs/a/restore"};
 for(String path:posts)check(CloudPolicy.permits(host,host+path,"POST"));
 String[] denied={"http://sync.owner.chatgpt.site/api/v1/auth/me","https://evil.test/api/v1/auth/me","https://sync.owner.chatgpt.site.evil.test/api/v1/auth/me","https://sync.owner.chatgpt.site:444/api/v1/auth/me","https://u@sync.owner.chatgpt.site/api/v1/auth/me",host+"/api/v1/auth/me#x",host+"/api/v1/auth/me?redirect=x",host+"/api/v1/packs?after=a&extra=x",host+"/api/health",host+"/api/v1/admin",host+"/assets/index.html",host+"/api/v1/packs/a/revisions/1/download/evil"};
 for(String url:denied)check(!CloudPolicy.permits(host,url,"GET"));
 check(!CloudPolicy.permits("",host+"/api/v1/auth/me","GET"));check(!CloudPolicy.permits(host,host+"/api/v1/auth/login","DELETE"));
 check(!CloudPolicy.needsWifi(5L*1024*1024));check(CloudPolicy.needsWifi(5L*1024*1024+1));check(CloudPolicy.needsWifi(32L*1024*1024));
 System.out.println("PASS "+cases+" policy/boundary cases");}}
`;
mkdirSync(join(dir,'classes'));writeFileSync(join(dir,'CloudPolicyTest.java'),harness);
const bin=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin'):'',suffix=process.platform==='win32'?'.exe':'';
execFileSync(bin?join(bin,'javac'+suffix):'javac',['-d',join(dir,'classes'),resolve('android/app/src/main/java/com/loopdeck3/app/CloudPolicy.java'),join(dir,'CloudPolicyTest.java')],{stdio:'inherit'});
execFileSync(bin?join(bin,'java'+suffix):'java',['-cp',join(dir,'classes'),'CloudPolicyTest'],{stdio:'inherit'});
