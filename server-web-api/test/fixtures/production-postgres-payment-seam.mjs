// Bounded offline seam: actual backend receipt custody and the owned local PG service.
// This runner accepts ONLY the disposable production-off fixture manifest, never live config.
import "./local-network-only.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {setTimeout as delay} from "node:timers/promises";
import {createHash} from "node:crypto";
import {configureLocalMonetaryV2Payments} from "../../src/monetary-v2-payment-bootstrap.js";
import {createLocalPaymentHoldInbox} from "../../src/monetary-v2-payment-hold-inbox.js";
import {createLocalFilePaymentAuthorityFence} from "../../src/monetary-v2-xsolla-composition.js";
import {createMonetaryV2PaymentClient} from "../../src/monetary-v2-payment-client.js";
import {createXsollaWebhookHandler,createMemoryXsollaEventStore} from "../../src/xsolla-webhook.js";
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const [manifestPath,reportPath]=process.argv.slice(2);
assert.ok(path.isAbsolute(manifestPath)&&path.isAbsolute(reportPath));
const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
const privateDir=path.dirname(manifestPath);
const serviceWorkspace=path.resolve(privateDir,"../../../..");
assert.equal(path.dirname(privateDir),path.join(serviceWorkspace,"Logs","MonetaryV2","private"));
assert.match(path.basename(privateDir),/^monetary_v2_phase2_production_off_[a-f0-9]{12}$/);
for(const key of ["runtimeConnectionFile","tokenFile","productionConfigFile","monitorFile"]){
    const relative=path.relative(privateDir,manifest[key]);
    assert.ok(path.isAbsolute(manifest[key])&&!relative.startsWith("..")&&!path.isAbsolute(relative));
    assert.ok(fs.lstatSync(manifest[key]).isFile()&&!fs.lstatSync(manifest[key]).isSymbolicLink());
}
const configurationBytes=fs.readFileSync(manifest.productionConfigFile),configuration=JSON.parse(configurationBytes);
assert.equal(sha(configurationBytes),manifest.productionAuthorityHash);
assert.equal(configuration.Environment,"production");assert.equal(configuration.TitleId,"142853");
assert.equal(configuration.Authority,"postgresql");assert.equal(configuration.ProviderMode,"disabled");assert.equal(configuration.AllowV1Fallback,false);
assert.equal(configuration.DatabaseHost,"127.0.0.1");assert.equal(configuration.DatabasePort,55459);
assert.equal(configuration.DatabaseName,path.basename(privateDir));assert.equal(configuration.AuthorityOrigin,manifest.origin);
assert.equal(manifest.recipient,"lab_provider_off_game");
const origin=new URL(manifest.origin);assert.equal(origin.hostname,"127.0.0.1");assert.equal(origin.protocol,"http:");
assert.ok(Number(origin.port)>=49152&&Number(origin.port)<=65535);
const token=fs.readFileSync(manifest.tokenFile,"utf8");assert.match(token,/^[!-~]{64,256}$/);
const authority={providerMode:"disabled",configurationSha256:manifest.productionAuthorityHash};
const realm={environment:"production",titleId:"142853",productionAuthority:authority};
const work=fs.mkdtempSync(path.join(privateDir,"backend-seam-"));
const holdFile=path.join(work,"hold.jsonl"),fenceFile=path.join(work,"fence.jsonl");
createLocalPaymentHoldInbox({...realm,filePath:holdFile,initialize:true});
createLocalFilePaymentAuthorityFence({...realm,filePath:fenceFile,initialize:true});
const env={SEABYSS_MONETARY_V2_PAYMENTS_ENABLED:"true",SEABYSS_MONETARY_V2_PAYMENT_ENVIRONMENT:"production",SEABYSS_MONETARY_V2_PAYMENT_FENCE_FILE:fenceFile,SEABYSS_MONETARY_V2_PAYMENT_HOLD_FILE:holdFile,SEABYSS_MONETARY_V2_PAYMENT_TOKEN_FILE:manifest.tokenFile,SEABYSS_MONETARY_V2_PAYMENT_ORIGIN:manifest.origin,SEABYSS_MONETARY_V2_PAYMENT_PRODUCTION_AUTHORITY:"durable-v2-provider-off",SEABYSS_MONETARY_V2_PROVIDER_DISPATCH_MODE:"OFF",SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256:manifest.productionAuthorityHash};
const config={nodeEnv:"production",xsollaCheckoutClosed:true,playFabTitleId:"142853",paymentWorkerEnabled:false,playFabFinancialAuthorityCutoverEnabled:false,purchasesGlobalEnabled:true,purchasesDiamondEnabled:true,purchasesStarterEnabled:true,purchasesPremiumEnabled:false,xsollaCheckoutAllowedSkus:["seabyss_diamond_pack_1","seabyss_starter_pack_1"]};
let service=null,route=null,before=null;
const cases=[],replyHashes=[];
async function check(name,action){await action();cases.push({name,result:"PASS"});}
async function request(relative,method="GET"){
    const response=await fetch(new URL(relative,origin),{method,headers:{"X-Seabyss-Monetary-Token":token},signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,200);return response.json();
}
// Ownership epoch changes when the payment runtime acquires/releases its offline lease.
// All economic proof dimensions remain exact; no money/ledger assertion is omitted.
async function monetarySnapshot(){
    const view=await request(`/v1/balances/${manifest.recipient}`);
    assert.equal(view.protocolVersion,1);assert.equal(view.accounts.length,1);
    const {account,sequence,headHash,gold,diamonds,reservedGold,reservedDiamonds}=view.accounts[0];
    return {account,sequence,headHash,gold,diamonds,reservedGold,reservedDiamonds};
}
async function ensureUnusedPort(){await new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:"127.0.0.1",port:Number(origin.port)});
    socket.once("connect",()=>{socket.destroy();reject(new Error("FIXTURE_SERVICE_ALREADY_RUNNING"));});
    socket.once("error",error=>{socket.destroy();if(error.code==="ECONNREFUSED")resolve();else reject(new Error("FIXTURE_PORT_CHECK_FAILED"));});
    socket.setTimeout(2000,()=>{socket.destroy();reject(new Error("FIXTURE_PORT_CHECK_TIMEOUT"));});
});}
async function start(){
    await ensureUnusedPort();
    const childEnv=Object.fromEntries(["PATH","SystemRoot","WINDIR","TEMP","TMP","DOTNET_ROOT","USERPROFILE","LOCALAPPDATA"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    childEnv.SEABYSS_MONETARY_V2_LOCAL_MONITOR_CONFIG=manifest.monitorFile;
    service=spawn("dotnet",[manifest.serviceDll,manifest.runtimeConnectionFile,manifest.tokenFile,"production",origin.port,"--provider-off","--enable-local-payments",`--production-authority=${manifest.productionConfigFile}`],{env:childEnv,cwd:serviceWorkspace,stdio:["ignore","pipe","pipe"],windowsHide:true});
    // Deliberately never print child output or private connection/token contents.
    service.stdout.resume();service.stderr.resume();
    for(let attempt=0;attempt<100;attempt++){
        if(service.exitCode!==null)throw new Error("FIXTURE_SERVICE_EXITED_BEFORE_READY");
        try{await request("/v1/health");return;}catch{}
        await delay(100);
    }
    throw new Error("FIXTURE_SERVICE_START_TIMEOUT");
}
async function stop(){
    if(!service)return;
    const child=service;service=null;
    if(child.exitCode!==null){assert.equal(child.exitCode,0);return;}
    const exited=once(child,"exit");await request("/v1/lab/stop","POST");
    let timer;try{const [code]=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("FIXTURE_SERVICE_STOP_TIMEOUT")),15000);})]);assert.equal(code,0);}
    finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
}
function compose(){
    const configured=configureLocalMonetaryV2Payments({env,config});
    route=configured.attach({legacyProcessor:async()=>{throw new Error("FORBIDDEN_LEGACY");},legacyReceiptProcessor:async()=>{throw new Error("FORBIDDEN_LEGACY");},validateUser:async id=>id===manifest.recipient,starterPaidCoordinator:{settlePaid:async()=>({status:"accepted"})}});
    return configured;
}
function paid(transactionId,sku="seabyss_diamond_pack_1"){
    return {notification_type:"payment",settings:{project_id:310966},user:{id:manifest.recipient},transaction:{id:transactionId,payment_date:"2026-09-25T04:00:00.000Z"},purchase:{total:{amount:"1.99",currency:"USD"},order:{lineitems:[{sku,quantity:1,price:{amount:"1.99",currency:"USD"}}]}}};
}
async function callback(payload){
    const secret="isolated-fixture-only",body=Buffer.from(JSON.stringify(payload)),signature=createHash("sha1").update(body).update(secret).digest("hex");
    const handler=createXsollaWebhookHandler({webhookSecret:secret,projectId:"310966",eventStore:createMemoryXsollaEventStore(),processEvent:route,logger:{info(){},warn(){},error(){}}});
    const response={code:0,status(c){this.code=c;return this;},json(){return this;},end(){return this;}};
    await handler({body,get:()=>`Signature ${signature}`},response);assert.equal(response.code,204);
}
const diamond=paid("900000000000011"),premium=paid("900000000000012","seabyss_premium_bronze");
let errorCode=null;
try{
    await check("real_production_configuration_service_and_closed_checkout",async()=>{await start();const configured=compose();await configured.verifyAuthority();assert.equal(configured.canCreateCheckout(),false);before=await monetarySnapshot();});
    for(const [family,payload] of [["Diamond",diamond],["Premium",premium]])await check(`verified_${family}_custody_before_real_PostgreSQL_manual_review_no_grant`,async()=>{
        const prior=route.quarantinePage().total;await callback(payload);const audit=route.quarantinePage();assert.equal(audit.total,prior+1);assert.equal(audit.entries.find(e=>e.transactionId===payload.transaction.id).reason,"production_payment_origin_unproven");
        assert.deepEqual(await monetarySnapshot(),before);
    });
    await check("callback_duplicates_and_backend_restart_preserve_exact_quarantine",async()=>{
        const prior=route.quarantinePage();await callback(diamond);await callback(premium);await route.stopRecovery();compose();await route.recoverPending();await callback(diamond);await callback(premium);assert.deepEqual(route.quarantinePage(),prior);assert.equal(route.recoveryHealth().pending,0);
    });
    await check("actual_service_restart_replays_unchanged_durable_manual_review",async()=>{
        const client=createMonetaryV2PaymentClient({enabled:true,...realm,origin:manifest.origin,token});
        const requests=fs.readFileSync(holdFile,"utf8").trimEnd().split("\n").slice(1).map(l=>JSON.parse(l)).filter(r=>r.kind==="admit").map(r=>r.data.request);
        assert.equal(requests.length,2);
        const replies=[];for(const p of requests){const reply=await client.submit(p);assert.equal(reply.status,"ManualReview");replies.push(reply);replyHashes.push(sha(JSON.stringify(reply)));}
        await stop();await start();
        for(let i=0;i<requests.length;i++)assert.deepEqual(await client.submit(requests[i]),replies[i]);
        assert.deepEqual(await monetarySnapshot(),before);
    });
    await check("preexisting_completed_V2_payment_replays_without_new_grant",async()=>{
        await callback(paid("900000000000002"));assert.equal(route.quarantinePage().total,2);assert.equal(route.recoveryHealth().pending,0);
        const rows=fs.readFileSync(holdFile,"utf8").trimEnd().split("\n").slice(1).map(l=>JSON.parse(l));assert.ok(rows.some(r=>r.kind==="handoff"&&r.data.status==="Completed"));
        assert.deepEqual(await monetarySnapshot(),before);
    });
    await check("provider_OFF_zero_calls_and_no_balance_sequence_change",async()=>{const h=await request("/v1/health");assert.equal(h.providerCalls,0);assert.equal(h.providerDispatchAllowed,false);assert.equal(h.unprovenPaymentPolicy,"quarantine");assert.deepEqual(await monetarySnapshot(),before);});
    await check("owned_process_graceful_shutdown",async()=>{await route.stopRecovery();route=null;await stop();});
}catch(error){errorCode=error?.code==="ERR_ASSERTION"?"ASSERTION_FAILED":/^[A-Z_]+$/.test(error?.message)?error.message:"BOUNDED_SEAM_FAILURE";cases.push({name:"seam_completion",result:"FAIL",error:errorCode});}
finally{try{await route?.stopRecovery();await stop();}catch{errorCode??="OWNED_PROCESS_CLEANUP_FAILED";}}
const report={scope:"actual backend signature/custody/private HTTP with isolated production142853 PostgreSQL service; synthetic receipts; no provider or live production",pass:cases.filter(c=>c.result==="PASS").length,fail:cases.filter(c=>c.result==="FAIL").length+(errorCode&&cases.every(c=>c.result!=="FAIL")?1:0),productionTouched:false,externalProviderCalls:0,serviceSha256:sha(fs.readFileSync(manifest.serviceDll)),productionAuthorityHash:manifest.productionAuthorityHash,custodySha256:sha(fs.readFileSync(holdFile)),monetarySnapshotSha256:before?sha(JSON.stringify(before)):null,manualReviewReplyHashes:replyHashes,cases};
fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
console.log(`BACKEND_POSTGRES_SEAM ${report.pass} PASS / ${report.fail} FAIL`);
process.exitCode=report.fail?1:0;
