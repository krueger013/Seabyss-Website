import "./fixtures/local-network-only.mjs";
import assert from "node:assert/strict";
import {test} from "node:test";
import {createServer} from "node:http";
import {once} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fork} from "node:child_process";
import {fileURLToPath} from "node:url";
import net from "node:net";
import {privateLoopbackPort} from "./fixtures/private-loopback-port.mjs";
import {setTimeout as delay} from "node:timers/promises";
import {startEmptyRespFixture} from "./fixtures/empty-resp-startup-server.mjs";
import {createHash} from "node:crypto";
import {configureLocalMonetaryV2Payments} from "../src/monetary-v2-payment-bootstrap.js";
import {createLocalPaymentHoldInbox} from "../src/monetary-v2-payment-hold-inbox.js";
import {createLocalFilePaymentAuthorityFence} from "../src/monetary-v2-xsolla-composition.js";
import {createMonetaryV2PaymentClient,createVerifiedMonetaryV2Payment,monetaryV2PaymentOperationId} from "../src/monetary-v2-payment-client.js";
import {createXsollaWebhookHandler,createMemoryXsollaEventStore} from "../src/xsolla-webhook.js";
import {readPaymentQuarantine} from "../src/monetary-v2-payment-quarantine-cli.js";
const recipient="LOCAL_QUAL_PAYMENT_1",authorityHash="a".repeat(64);
const authority={providerMode:"disabled",configurationSha256:authorityHash};
const realm={environment:"production",titleId:"142853",productionAuthority:authority};
const baseConfig={xsollaPremiumPlanId:"fixture-old-premium-plan",xsollaPremiumPlanExternalId:"fixture-old-premium-external",nodeEnv:"production",xsollaCheckoutClosed:true,playFabTitleId:"142853",paymentWorkerEnabled:false,playFabFinancialAuthorityCutoverEnabled:false,purchasesGlobalEnabled:true,purchasesDiamondEnabled:true,purchasesStarterEnabled:true,xsollaCheckoutAllowedSkus:["seabyss_diamond_pack_1","seabyss_starter_pack_1"]};
function paid(id="91001",starter=false){const sku=starter?"seabyss_starter_pack_1":"seabyss_diamond_pack_1",price=starter?"3.99":"1.99";return {notification_type:"payment",settings:{project_id:310966},user:{id:recipient},transaction:{id,payment_date:"2026-09-25T04:00:00.000Z"},purchase:{total:{amount:price,currency:"USD"},order:{lineitems:[{sku,quantity:1,price:{amount:price,currency:"USD"}}]}}};}
async function callback(route,p=paid(),signatureOverride=null){
    const secret="offline-fixture",body=Buffer.from(JSON.stringify(p)),sig=createHash("sha1").update(body).update(secret).digest("hex");
    const h=createXsollaWebhookHandler({webhookSecret:secret,projectId:"310966",eventStore:createMemoryXsollaEventStore(),processEvent:route,logger:{info(){},warn(){},error(){}}});
    const res={code:0,status(c){this.code=c;return this;},json(){return this;},end(){return this;}};
    await h({body,get:()=>`Signature ${signatureOverride ?? sig}`},res);return res.code;
}
async function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"production-payment-fixture-")),token="F".repeat(64),routes=[];
    const holdFile=path.join(dir,"hold.jsonl"),fenceFile=path.join(dir,"fence.jsonl"),tokenFile=path.join(dir,"private-token");
    createLocalPaymentHoldInbox({...realm,filePath:holdFile,initialize:true});createLocalFilePaymentAuthorityFence({...realm,filePath:fenceFile,initialize:true});fs.writeFileSync(tokenFile,token,{mode:0o600});
    const state={mode:"V2",lost:false,knownAccepted:new Set(["91001"]),requests:[],grants:new Map(),reviews:new Map(),mutateHealth:p=>p};
    const service=createServer(async(req,res)=>{
        try {
            assert.equal(req.headers["x-seabyss-monetary-token"],token);state.requests.push(req.url);
            res.setHeader("Content-Type","application/json");
            if(req.url==="/v1/health"){res.end(JSON.stringify(state.mutateHealth({protocolVersion:1,environment:"production",titleId:"142853",authority:"postgresql",providerMode:"disabled",providerDispatchAllowed:false,allowV1Fallback:false,unprovenPaymentPolicy:"quarantine",productionAuthorityHash:authorityHash})));return;}
            if(req.url.startsWith("/v2/payments/authority/")){res.end(JSON.stringify({environment:"production",titleId:"142853",recipient,mode:state.mode,epoch:1,sourceHash:"b".repeat(64)}));return;}
            assert.equal(req.url,"/v2/payments/verified");let raw="";for await(const chunk of req)raw+=chunk;const p=JSON.parse(raw),id=monetaryV2PaymentOperationId(p);
            assert.equal(p.environment,"production");assert.equal(p.titleId,"142853");
            // These IDs model an already durable service receipt. Other first identities are unproven.
            if(!state.knownAccepted.has(p.transactionId)){
                const old=state.reviews.get(id);if(old)assert.deepEqual(old,p);else state.reviews.set(id,p);
                res.end(JSON.stringify({status:"ManualReview",operationId:id,canonicalPayloadSha256:p.canonicalPayloadSha256,committed:null,reviewReason:"production_payment_origin_unproven"}));return;
            }
            const prior=state.grants.get(id);if(prior)assert.deepEqual(prior,p);else state.grants.set(id,p);
            if(state.lost){state.lost=false;req.socket.destroy();return;}
            res.end(JSON.stringify({status:"Completed",operationId:id,canonicalPayloadSha256:p.canonicalPayloadSha256,committed:{operationId:id,payloadHash:"c".repeat(64),accounts:[{account:recipient,sequence:1,headHash:"d".repeat(64),gold:0,diamonds:1000,ownerEpoch:1}]},reviewReason:null}));
        }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
    });
    service.listen(0,"127.0.0.1");await once(service,"listening");const origin=`http://127.0.0.1:${service.address().port}/`;
    const env={SEABYSS_MONETARY_V2_PAYMENTS_ENABLED:"true",SEABYSS_MONETARY_V2_PAYMENT_ENVIRONMENT:"production",SEABYSS_MONETARY_V2_PAYMENT_FENCE_FILE:fenceFile,SEABYSS_MONETARY_V2_PAYMENT_HOLD_FILE:holdFile,SEABYSS_MONETARY_V2_PAYMENT_TOKEN_FILE:tokenFile,SEABYSS_MONETARY_V2_PAYMENT_ORIGIN:origin,SEABYSS_MONETARY_V2_PAYMENT_PRODUCTION_AUTHORITY:"durable-v2-provider-off",SEABYSS_MONETARY_V2_PROVIDER_DISPATCH_MODE:"OFF",SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256:authorityHash};
    function compose(){const configured=configureLocalMonetaryV2Payments({env,config:baseConfig});const route=configured.attach({legacyProcessor:async()=>{throw Error("NO_LEGACY");},legacyReceiptProcessor:async()=>{throw Error("NO_LEGACY_RECEIPTS");},validateUser:async id=>id===recipient,starterPaidCoordinator:{settlePaid:async()=>({status:"accepted"})}});routes.push(route);return {configured,route};}
    t.after(async()=>{for(const r of routes)await r.stopRecovery();await new Promise(resolve=>service.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
    return {dir,env,state,compose,origin,token,holdFile,fenceFile};
}
for(const starter of [false,true])test(`known durable production realm ${starter?"Starter":"Diamond"} HTTP custody, duplicate and restart preserve one effect`,async t=>{
    const f=await fixture(t),{configured,route}=f.compose();assert.equal(configured.productionAuthorityConfigured,true);await configured.verifyAuthority();await route.startRecovery();
    assert.equal(await callback(route,paid("91001",starter)),204);assert.equal(await callback(route,paid("91001",starter)),204);assert.equal(f.state.grants.size,1);assert.equal(route.recoveryHealth().pending,0);
    const held=JSON.parse(fs.readFileSync(f.holdFile,"utf8").split("\n")[1]).data;assert.equal(held.receipt.source,"xsolla_production");assert.equal(held.request.environment,"production");assert.equal(held.request.titleId,"142853");
    await route.stopRecovery();const restarted=f.compose();await restarted.route.startRecovery();assert.equal(await callback(restarted.route,paid("91001",starter)),204);assert.equal(f.state.grants.size,1);
    assert.equal(f.state.requests.filter(p=>p==="/v2/payments/verified").length,1);
});
for(const mode of ["Migrating","Blocked","V1"])test(`production ${mode} waits durably without V1 fallback then processes after cutover`,async t=>{
    const f=await fixture(t);f.state.mode=mode;const {route}=f.compose();assert.equal(await callback(route),204);assert.equal(route.recoveryHealth().pending,1);assert.equal(f.state.grants.size,0);
    f.state.mode="V2";await route.recoverPending();assert.equal(f.state.grants.size,1);assert.equal(route.recoveryHealth().pending,0);
});
test("production lost-response retry across backend restart uses original operation and receipt",async t=>{
    const f=await fixture(t);f.state.lost=true;const {route}=f.compose();assert.equal(await callback(route),204);assert.equal(f.state.grants.size,1);assert.equal(route.recoveryHealth().pending,1);await route.stopRecovery();const r=f.compose().route;await r.recoverPending();assert.equal(f.state.grants.size,1);assert.equal(r.recoveryHealth().pending,0);
});
for(const change of [{productionAuthorityHash:"e".repeat(64)},{providerMode:"active"},{providerDispatchAllowed:true},{allowV1Fallback:true},{titleId:"1D0C16"},{authority:"playfab"},{unprovenPaymentPolicy:"grant_on_absence"}])test(`production authority mismatch ${Object.keys(change)[0]} never routes or grants but retains verified custody`,async t=>{
    const f=await fixture(t);f.state.mutateHealth=p=>({...p,...change});const {configured,route}=f.compose();await assert.rejects(()=>configured.verifyAuthority(),/AUTHORITY_MISMATCH/);
    assert.equal(await callback(route),204);assert.equal(route.recoveryHealth().pending,1);assert.equal(f.state.grants.size,0);assert.ok(f.state.requests.every(p=>p==="/v1/health"));
});
test("production exact config rejects missing opt-in, changed DB hash and mixed legacy writers before network",async t=>{
    const f=await fixture(t);
    for(const key of ["SEABYSS_MONETARY_V2_PAYMENT_PRODUCTION_AUTHORITY","SEABYSS_MONETARY_V2_PROVIDER_DISPATCH_MODE","SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256"]){const env={...f.env};delete env[key];assert.throws(()=>configureLocalMonetaryV2Payments({env,config:baseConfig}));}
    for(const patch of [{paymentWorkerEnabled:true},{playFabFinancialAuthorityCutoverEnabled:true},{nodeEnv:"test"},{playFabTitleId:"1D0C16"},{xsollaCheckoutClosed:false}])assert.throws(()=>configureLocalMonetaryV2Payments({env:f.env,config:{...baseConfig,...patch}}));
    assert.throws(()=>configureLocalMonetaryV2Payments({env:{...f.env,SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256:"e".repeat(64)},config:baseConfig}));assert.equal(f.state.requests.length,0);
});
test("production execution cannot use sandbox proof, arbitrary title or remote endpoint",async t=>{
    const f=await fixture(t);const {route}=f.compose();const p=paid();p.transaction.dry_run=1;assert.equal(await callback(route,p),500);assert.equal(route.recoveryHealth().receipts,0);
    for(const patch of [{titleId:"1D0C16"},{origin:"https://142853.playfabapi.com"},{productionAuthority:null},{productionAuthority:{providerMode:"active",configurationSha256:authorityHash}}])assert.throws(()=>createMonetaryV2PaymentClient({enabled:true,...realm,origin:f.origin,token:f.token,...patch}));assert.equal(f.state.requests.length,0);
});
test("read-only production quarantine audit binds original hash and preserves production title",async t=>{
    const f=await fixture(t);const inbox=createLocalPaymentHoldInbox({...realm,filePath:f.holdFile});await inbox.acquireOwnership();
    const receipt={provider:"xsolla",providerTransactionId:"99101",transactionId:"99101",userId:recipient,playFabId:recipient,environment:"production",source:"xsolla_production",productId:"diamond_pack_1",xsollaSku:"seabyss_diamond_pack_1",productType:"diamond_pack",productPlanVersion:2,currency:"USD",unitAmountMinor:199,totalAmountMinor:199,quantity:1,promotionPolicy:"disabled"};
    const admitted=inbox.admit(receipt);inbox.markLegacyAttempt(admitted.operationId,admitted.request.canonicalPayloadSha256);inbox.quarantineLegacyAttempt(admitted.operationId,{...realm,recipient,mode:"V2",epoch:1,sourceHash:"b".repeat(64)});await inbox.close();
    const before=fs.readFileSync(f.holdFile);const report=readPaymentQuarantine({...realm,filePath:f.holdFile});assert.equal(report.total,1);assert.equal(report.titleId,"142853");assert.equal(report.entries[0].canonicalPayloadSha256,createVerifiedMonetaryV2Payment(receipt,realm).canonicalPayloadSha256);assert.deepEqual(fs.readFileSync(f.holdFile),before);
    const {route}=f.compose();await route.startRecovery();assert.equal(route.recoveryHealth().state,"RECONCILING");assert.equal(f.state.grants.size,0);assert.equal(await callback(route),204);assert.equal(f.state.grants.size,1);
});

async function startBackend(f,redis,overrides={}){
    const reservation=net.createServer();reservation.listen(0,"127.0.0.1");await once(reservation,"listening");const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,...f.env,
        DOTENV_CONFIG_PATH:fileURLToPath(new URL("./fixtures/empty-test-env.txt",import.meta.url)),NODE_ENV:"production",HOST:"127.0.0.1",PORT:String(port),
        SESSION_SECRET:"local-test-secret-".repeat(8),PLAYFAB_TITLE_ID:"142853",PLAYFAB_SECRET_KEY:"FAKE_LOCAL_TEST_KEY",REDIS_URL:redis.url,
        SEABYSS_ENV:"beta59-local-qualification",PUBLIC_SITE_ORIGIN:"http://127.0.0.1",UPSTREAM_TIMEOUT_MS:"1000",
        PURCHASES_GLOBAL_ENABLED:"true",PURCHASES_DIAMOND_ENABLED:"true",PURCHASES_STARTER_ENABLED:"true",PURCHASES_PREMIUM_ENABLED:"false",PURCHASES_DOUBLER_ENABLED:"false",
        PAYMENT_WORKER_ENABLED:"false",PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED:"false",PLAYFAB_FINANCIAL_PROFILE_ENABLED:"false",XSOLLA_HARDENED_CATALOG_ENABLED:"true",
        XSOLLA_CHECKOUT_CLOSED:"true",XSOLLA_CHECKOUT_MODE:"production",XSOLLA_CHECKOUT_PRODUCTION_ENABLED:"true",XSOLLA_CHECKOUT_ALLOWED_SKUS:baseConfig.xsollaCheckoutAllowedSkus.join(","),
        XSOLLA_WEBHOOK_SECRET:"fake-local-webhook",XSOLLA_PROJECT_ID:"310966",XSOLLA_PREMIUM_PLAN_ID:"fixture-unused-premium",...overrides};
    const child=fork(new URL("../src/server.js",import.meta.url),[],{env,cwd:fileURLToPath(new URL("..",import.meta.url)),execArgv:["--import",new URL("./fixtures/production-server-test-control.mjs",import.meta.url).href],stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});
    let logs="";child.stdout.on("data",b=>{logs+=b;});child.stderr.on("data",b=>{logs+=b;});
    async function stop(){if(child.exitCode!==null)return;const exited=once(child,"exit");child.send("local-test-graceful-stop");const timer=setTimeout(()=>child.kill(),10000);try{const [code]=await exited;assert.equal(code,0,logs);assert.match(logs,/web API stopped/);}finally{clearTimeout(timer);}}
    try{for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{const r=await fetch(`http://127.0.0.1:${port}/health/live`);if(r.ok)return {child,origin:`http://127.0.0.1:${port}`,stop};}catch{}await delay(25);}throw Error("LOCAL_BACKEND_READINESS_TIMEOUT "+logs);}
    catch(error){if(child.exitCode===null){const exited=once(child,"exit");child.kill();await exited;}throw error;}
}
test("real server.js production shape starts, is ready with independent quarantine, shuts down and restarts",async t=>{
    const f=await fixture(t),redis=await startEmptyRespFixture();t.after(()=>redis.close());
    const hold=createLocalPaymentHoldInbox({...realm,filePath:f.holdFile});await hold.acquireOwnership();
    const r={provider:"xsolla",providerTransactionId:"99901",transactionId:"99901",userId:recipient,playFabId:recipient,environment:"production",source:"xsolla_production",productId:"diamond_pack_1",xsollaSku:"seabyss_diamond_pack_1",productType:"diamond_pack",productPlanVersion:2,currency:"USD",unitAmountMinor:199,totalAmountMinor:199,quantity:1,promotionPolicy:"disabled"};
    const e=hold.admit(r);hold.markLegacyAttempt(e.operationId,e.request.canonicalPayloadSha256);hold.quarantineLegacyAttempt(e.operationId,{...realm,recipient,mode:"V2",epoch:1,sourceHash:"b".repeat(64)});await hold.close();
    const before=fs.readFileSync(f.holdFile);
    for(let iteration=0;iteration<2;iteration++){
        const backend=await startBackend(f,redis);try{
            const response=await fetch(backend.origin+"/health/ready"),health=await response.json();assert.equal(response.status,200,JSON.stringify(health));
            const monetary=health.checks.find(c=>c.component==="monetary_v2_durable_authority");assert.equal(monetary.ok,true);assert.equal(monetary.details.quarantined,1);assert.equal(monetary.details.state,"RECONCILING");
            const live=await(await fetch(backend.origin+"/health")).json();assert.equal(live.payments.activationReady,true);assert.equal(live.payments.custody.quarantined,1);
        } finally {await backend.stop();}
    }
    assert.deepEqual(fs.readFileSync(f.holdFile),before);assert.equal(f.state.grants.size,0);
    assert.ok(redis.commands.includes("PING"));assert.ok(redis.commands.includes("ZRANGE"));assert.ok(redis.commands.every(c=>["CLIENT","PING","ZRANGE","GET","QUIT"].includes(c)));
});

test("real server startup still rejects unsafe opt-in, mixed V1 and unbound production authority",async t=>{
    const f=await fixture(t),redis=await startEmptyRespFixture();t.after(()=>redis.close());
    for(const overrides of [{SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256:""},{PAYMENT_WORKER_ENABLED:"true"},{SEABYSS_MONETARY_V2_PAYMENT_ORIGIN:"https://142853.playfabapi.com/"}]){
        await assert.rejects(()=>startBackend(f,redis,overrides));
    }
    await assert.rejects(()=>startBackend(f,redis,{SEABYSS_MONETARY_V2_PAYMENTS_ENABLED:"false",SEABYSS_MONETARY_V2_PAYMENT_FENCE_FILE:""}),/PLAYFAB_FINANCIAL_PROFILE_ENABLED=true/);
    assert.equal(redis.commands.length,0);assert.equal(f.state.requests.length,0);
    f.state.mutateHealth=p=>({...p,productionAuthorityHash:"e".repeat(64)});await assert.rejects(()=>startBackend(f,redis),/PRODUCTION_AUTHORITY_MISMATCH/);assert.equal(redis.commands.length,0);
});

test("first old production callback after cutover with absent profile receipt is durably quarantined, never a new grant",async t=>{
    const f=await fixture(t),{configured,route}=f.compose();assert.equal(configured.canCreateCheckout(),false);
    assert.equal(await callback(route,paid("97001")),204);assert.equal(f.state.reviews.size,1);assert.equal(f.state.grants.size,0);
    assert.equal(route.recoveryHealth().serviceQuarantined,1);assert.equal(route.recoveryHealth().state,"RECONCILING");
    const audit=route.quarantinePage();assert.equal(audit.total,1);assert.equal(audit.entries[0].transactionId,"97001");assert.equal(audit.entries[0].reason,"production_payment_origin_unproven");
    await route.stopRecovery();const r=f.compose().route;await r.recoverPending();assert.equal(await callback(r,paid("97001")),204);assert.equal(f.state.reviews.size,1);assert.equal(f.state.grants.size,0);assert.deepEqual(r.quarantinePage(),audit);
    assert.equal(await callback(r,paid("91001")),204);assert.equal(f.state.grants.size,1);assert.equal(r.recoveryHealth().serviceQuarantined,1);
});

for (const [tier, price] of [["bronze", "1.99"], ["silver", "3.99"], ["gold", "7.99"]])
test(`old verified Premium ${tier} callback survives closed new sales as durable quarantine across duplicate and restart`, async t => {
    const f=await fixture(t),{configured,route}=f.compose();
    const p=paid("98001");p.purchase.total.amount=price;
    p.purchase.order.lineitems=[{sku:`seabyss_premium_${tier}`,quantity:1,price:{amount:price,currency:"USD"}}];
    assert.equal(configured.canCreateCheckout(),false);
    assert.equal(baseConfig.purchasesPremiumEnabled,undefined);
    assert.ok(!baseConfig.xsollaCheckoutAllowedSkus.includes(p.purchase.order.lineitems[0].sku));
    assert.equal(await callback(route,p),204);
    const row=JSON.parse(fs.readFileSync(f.holdFile,"utf8").split("\n")[1]).data;
    assert.equal(row.receipt.productType,"premium");assert.equal(row.receipt.source,"xsolla_production");
    assert.equal(row.request.receiptAlias,"xsp2");assert.equal(row.request.sku,p.purchase.order.lineitems[0].sku);
    assert.equal(row.request.amountMinor,Math.round(Number(price)*100));
    assert.equal(route.quarantinePage().entries[0].reason,"production_payment_origin_unproven");
    assert.equal(route.recoveryHealth().serviceQuarantined,1);assert.equal(f.state.grants.size,0);
    assert.equal(await callback(route,p),204);await route.stopRecovery();
    const restarted=f.compose().route;await restarted.recoverPending();assert.equal(await callback(restarted,p),204);
    assert.equal(restarted.quarantinePage().total,1);assert.equal(f.state.reviews.size,1);assert.equal(f.state.grants.size,0);
    assert.equal(f.state.requests.filter(x=>x==="/v2/payments/verified").length,1);
});
test("unverified Premium price or quantity cannot enter durable custody through old-callback capture",async t=>{
    const f=await fixture(t),{route}=f.compose();
    for(const [amount,quantity] of [["0.01",1],["1.99",2]]){
        const p=paid("98002");p.purchase.total.amount=amount;p.purchase.order.lineitems=[{sku:"seabyss_premium_bronze",quantity,price:{amount,currency:"USD"}}];
        assert.equal(await callback(route,p),500);assert.equal(route.recoveryHealth().receipts,0);
    }
    assert.equal(f.state.requests.length,0);assert.equal(f.state.grants.size,0);
});
test("invalid signed Premium callback cannot enter durable custody",async t=>{
    const f=await fixture(t),{route}=f.compose(),p=paid("98003");p.purchase.order.lineitems[0].sku="seabyss_premium_bronze";
    assert.equal(await callback(route,p,"0".repeat(40)),400);assert.equal(route.recoveryHealth().receipts,0);
    assert.equal(f.state.requests.length,0);assert.equal(f.state.grants.size,0);
});

function oldSubscription(id="99001"){
    return {notification_type:"payment",settings:{project_id:310966},user:{id:recipient},
        transaction:{id,payment_date:"2026-08-25T04:00:00.000Z"},
        purchase:{subscription:{plan_id:baseConfig.xsollaPremiumPlanId,external_id:baseConfig.xsollaPremiumPlanExternalId,date_next_charge:"2026-09-25T04:00:00.000Z"}}};
}
test("old subscription Premium verified by original validator is retained without invented SKU or grant despite closed sales",async t=>{
    const f=await fixture(t),{configured,route}=f.compose(),p=oldSubscription();
    assert.equal(configured.canCreateCheckout(),false);assert.equal(await callback(route,p),204);
    const audit=route.quarantinePage();assert.equal(audit.total,1);assert.equal(audit.entries[0].reason,"LEGACY_SUBSCRIPTION_REQUIRES_RECONCILIATION");
    assert.equal(audit.entries[0].productPlanVersion,null);assert.equal(route.recoveryHealth().retryable,0);
    const row=JSON.parse(fs.readFileSync(f.holdFile,"utf8").split("\n")[1]);assert.equal(row.kind,"legacy_subscription");
    assert.deepEqual(JSON.parse(row.data.payloadJson),p);assert.equal(row.data.receipt.expiresAtUtcIso8601,p.purchase.subscription.date_next_charge);
    assert.ok(!Object.hasOwn(row.data.receipt,"amountMinor"));assert.ok(!Object.hasOwn(row.data.receipt,"sku"));
    const original=fs.readFileSync(f.holdFile);assert.equal(await callback(route,p),204);await route.stopRecovery();
    const restarted=f.compose().route;await restarted.recoverPending();assert.equal(await callback(restarted,p),204);
    assert.deepEqual(fs.readFileSync(f.holdFile),original);assert.deepEqual(restarted.quarantinePage(),audit);assert.equal(f.state.requests.length,0);
});
test("old subscription Premium conflicting duplicate cannot replace retained original or cross into a catalog grant",async t=>{
    const f=await fixture(t),{route}=f.compose(),p=oldSubscription("99002");assert.equal(await callback(route,p),204);
    const original=fs.readFileSync(f.holdFile),changed=structuredClone(p);changed.purchase.subscription.date_next_charge="2026-10-25T04:00:00.000Z";
    assert.equal(await callback(route,changed),500);assert.equal(await callback(route,paid("99002")),500);
    assert.deepEqual(fs.readFileSync(f.holdFile),original);assert.equal(f.state.requests.length,0);
});
test("old subscription Premium invalid plan period sandbox identity and signature never enter custody",async t=>{
    const f=await fixture(t),{route}=f.compose();
    for(const [mutate,expectedStatus] of [[p=>p.purchase.subscription.external_id="other-plan",500],[p=>p.purchase.subscription.date_next_charge="invalid",500],[p=>p.transaction.dry_run=1,500],[p=>p.user.id="OTHER_USER",400]]){
        const p=oldSubscription("99003");mutate(p);assert.equal(await callback(route,p),expectedStatus);assert.equal(route.recoveryHealth().receipts,0);
    }
    assert.equal(await callback(route,oldSubscription("99003"),"0".repeat(40)),400);assert.equal(route.recoveryHealth().receipts,0);assert.equal(f.state.requests.length,0);
});
for(const point of ["before_persist","after_persist"])test(`old subscription Premium ${point} failure retries exactly once after restart without acknowledgment loss`,async t=>{
    const f=await fixture(t),p=oldSubscription("99004"),receipt={playFabId:recipient,transactionId:"99004",activatedAtUtcIso8601:p.transaction.payment_date,expiresAtUtcIso8601:p.purchase.subscription.date_next_charge};
    const inbox=createLocalPaymentHoldInbox({...realm,filePath:f.holdFile,boundary:(name,kind)=>{if(name===point&&kind==="legacy_subscription")throw Error("NAMED_FAILURE");}});
    await inbox.acquireOwnership();assert.throws(()=>inbox.admitLegacySubscription(receipt,p,baseConfig.xsollaPremiumPlanId,baseConfig.xsollaPremiumPlanExternalId,"2026-09-25T04:00:00.000Z"),/NAMED_FAILURE/);await inbox.close();
    const {route}=f.compose();assert.equal(route.recoveryHealth().receipts,point==="after_persist"?1:0);
    assert.equal(await callback(route,p),204);assert.equal(await callback(route,p),204);assert.equal(route.quarantinePage().total,1);assert.equal(route.recoveryHealth().receipts,1);assert.equal(f.state.requests.length,0);
});

async function setupCutover(f){
    const {provisionPaymentCutover}=await import("../src/monetary-v2-payment-cutover-cli.js");
    const settings={schema:1,configurationSha256:authorityHash,planSha256:"b".repeat(64),custodyFile:f.holdFile,fenceFile:f.fenceFile,inventoryDirectory:path.join(f.dir,"inventory"),stateFile:path.join(f.dir,"cutover.jsonl")};
    provisionPaymentCutover(settings);
    const port=await privateLoopbackPort();
    const controlTokenFile=path.join(f.dir,"cutover-token");fs.writeFileSync(controlTokenFile,"Q".repeat(64),{mode:0o600});
    const env={SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_STATE_FILE:settings.stateFile,SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_PLAN_SHA256:settings.planSha256,
        SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_INVENTORY_DIRECTORY:settings.inventoryDirectory,SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_CONTROL_ORIGIN:`http://127.0.0.1:${port}/`,SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_CONTROL_TOKEN_FILE:controlTokenFile};
    return {settings,env,headers:{"X-Seabyss-Cutover-Token":"Q".repeat(64),"Content-Type":"application/json"}};
}
test("real server custody-only cutover boots and restarts READY with PG unavailable and zero private authority calls",async t=>{
    const f=await fixture(t),c=await setupCutover(f),redis=await startEmptyRespFixture();t.after(()=>redis.close());
    f.state.mutateHealth=()=>{throw Error("PG_OFFLINE_FIXTURE");};
    for(let iteration=0;iteration<2;iteration++){
        const backend=await startBackend(f,redis,c.env);try{
            const r=await fetch(backend.origin+"/health/ready"),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));assert.equal(body.checks.find(x=>x.component==="monetary_v2_durable_authority").reason,"custody_only_no_monetary_dispatch");
            const origin=c.env.SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_CONTROL_ORIGIN;
            let status=await(await fetch(origin+"v1/payment-cutover/status",{headers:c.headers})).json();assert.equal(status.phase,iteration===0?"HOLDING":"READY_FOR_MIGRATION");assert.equal(status.inFlight,0);assert.equal(status.legacyWorkerRunning,false);assert.equal(status.custodyOwned,true);
            if(iteration===0){
                const bound=await fetch(origin+"v1/payment-cutover/bind",{method:"POST",headers:c.headers,body:JSON.stringify({expectedGeneration:0,maintenancePlanSha256:"b".repeat(64),planSha256:"d".repeat(64),rootFenceReceiptSha256:"c".repeat(64)})});assert.equal(bound.status,200);
                const response=await fetch(origin+"v1/payment-cutover/prepare",{method:"POST",headers:c.headers,body:JSON.stringify({expectedGeneration:1,planSha256:"d".repeat(64),rootFenceReceiptSha256:"c".repeat(64)})});assert.equal(response.status,200);status=await response.json();assert.equal(status.readyForMigration,true);assert.equal(status.generation,2);}
            assert.equal(f.state.requests.length,0);assert.equal((await(await fetch(backend.origin+"/health")).json()).payments.activationReady,false);
        }finally{await backend.stop();}
    }
    assert.ok(redis.commands.includes("SCAN"));assert.ok(redis.commands.every(c=>["CLIENT","PING","ZRANGE","GET","QUIT","SCAN"].includes(c)));assert.equal(f.state.requests.length,0);
});
test("cutover bootstrap requires every exact binding, separate token/origin and no legacy background writers",async t=>{
    const f=await fixture(t),c=await setupCutover(f),env={...f.env,...c.env};
    for(const key of Object.keys(c.env)){const missing={...env};delete missing[key];assert.throws(()=>configureLocalMonetaryV2Payments({env:missing,config:baseConfig}));}
    for(const overrides of [{SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_PLAN_SHA256:"d".repeat(64)},{SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_CONTROL_TOKEN_FILE:f.env.SEABYSS_MONETARY_V2_PAYMENT_TOKEN_FILE},{SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_CONTROL_ORIGIN:f.origin}])assert.throws(()=>configureLocalMonetaryV2Payments({env:{...env,...overrides},config:baseConfig}));
    for(const config of [{...baseConfig,financialShadowModeEnabled:true},{...baseConfig,playFabFinancialRefreshEnabled:true}])assert.throws(()=>configureLocalMonetaryV2Payments({env,config}));assert.equal(f.state.requests.length,0);
});
