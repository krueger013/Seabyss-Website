import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fork} from "node:child_process";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {createLocalPaymentHoldInbox} from "../src/monetary-v2-payment-hold-inbox.js";
import {createLocalFilePaymentAuthorityFence,createMonetaryV2XsollaComposition} from "../src/monetary-v2-xsolla-composition.js";
import {createMonetaryV2PaymentClient,monetaryV2PaymentOperationId} from "../src/monetary-v2-payment-client.js";
import {createXsollaWebhookHandler,createMemoryXsollaEventStore} from "../src/xsolla-webhook.js";
import {createXsollaCheckoutService} from "../src/xsolla-checkout-service.js";
const recipient="ABC123",sku="seabyss_diamond_pack_1";
const options={enabled:true,environment:"sandbox",titleId:"1D0C16",origin:"http://127.0.0.1:55160/",token:"T".repeat(64)};
const receipt=(id="9223372036854775807")=>({provider:"xsolla",providerTransactionId:id,transactionId:id,userId:recipient,playFabId:recipient,environment:"sandbox",source:"xsolla_sandbox",productId:"diamond_pack_1",xsollaSku:sku,productType:"diamond_pack",productPlanVersion:2,currency:"USD",unitAmountMinor:199,totalAmountMinor:199,quantity:1,promotionPolicy:"disabled"});
const proof=mode=>({environment:"sandbox",titleId:"1D0C16",recipient,mode,epoch:1,sourceHash:"b".repeat(64)});
function payload(id="9223372036854775807") {return {notification_type:"payment",settings:{project_id:310966},user:{id:recipient},transaction:{id,dry_run:1,payment_date:"2026-09-24T00:00:00.000Z"},purchase:{total:{amount:"1.99",currency:"USD"},order:{lineitems:[{sku,quantity:1,price:{amount:"1.99",currency:"USD"}}]}}};}
const event=p=>({payload:p,notificationType:p.notification_type,userId:p.user.id});
function response(p,status="Completed") {return {status:status==="Pending"?202:200,body:JSON.stringify({status,operationId:monetaryV2PaymentOperationId(p),canonicalPayloadSha256:p.canonicalPayloadSha256,committed:status==="Completed"?{operationId:monetaryV2PaymentOperationId(p),payloadHash:"c".repeat(64),accounts:[{account:recipient,sequence:1,headHash:"a".repeat(64),gold:0,diamonds:1000,ownerEpoch:1}]}:null,reviewReason:null})};}
function fixture(extra={}) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"seabyss-cutover-"));
    const settings={filePath:path.join(directory,"hold.jsonl"),environment:"sandbox",titleId:"1D0C16",...extra};
    const inbox=createLocalPaymentHoldInbox({...settings,initialize:true});
    const fence=createLocalFilePaymentAuthorityFence({filePath:path.join(directory,"fence.jsonl"),environment:"sandbox",titleId:"1D0C16",initialize:true});
    return {directory,settings,inbox,fence,async close(){await inbox.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
function compose(f,{mode="V2",authorityError=false,submit=null,legacyReceiptProcessor=null,client=null}={}) {
    const state={mode,authorityError,queries:0,submits:0,grants:new Map()};
    const transport=async q=> {
        if(q.body===null) {
            state.queries++;assert.ok(f.inbox.health().pending>0,"receipt must precede authority lookup");
            if(state.authorityError)throw Error("authority unavailable");
            return {status:200,body:JSON.stringify(proof(state.mode))};
        }
        state.submits++;const request=JSON.parse(q.body);
        const id=monetaryV2PaymentOperationId(request), prior=state.grants.get(id);
        if(prior)assert.deepEqual(request,prior);else state.grants.set(id,request);
        return submit ? submit(request,state) : response(request);
    };
    const route=createMonetaryV2XsollaComposition({client:client??createMonetaryV2PaymentClient({...options,transport}),fence:f.fence,holdInbox:f.inbox,
        legacyProcessor:async()=>{throw Error("unexpected legacy raw callback fallback");},legacyReceiptProcessor,
        hardenedOptions:{allowDiamondSandboxGrants:true,diamondSandboxTestPlayFabIds:[recipient],validateUser:async()=>true},
        gateOptions:{globalEnabled:true,familyGates:{diamond_pack:true},allowedSkus:[sku]}});
    return {route,state};
}
async function callback(route,p=payload(),signatureValid=true) {
    const secret="offline-only",body=Buffer.from(JSON.stringify(p)),signature=createHash("sha1").update(body).update(secret).digest("hex");
    const handler=createXsollaWebhookHandler({webhookSecret:secret,projectId:"310966",eventStore:createMemoryXsollaEventStore(),processEvent:route,logger:{info(){},warn(){},error(){}}});
    const res={code:0,status(c){this.code=c;return this;},json(){return this;},end(){return this;}};
    await handler({body,get:()=>"Signature "+(signatureValid?signature:"0".repeat(40))},res);return res.code;
}
for(const mode of ["Migrating","Blocked"])test(`verified ${mode} receipt persists before authority, duplicate and restart grant once`,async()=>{
    const f=fixture();try {
        const {route,state}=compose(f,{mode});assert.equal(await callback(route),204);
        assert.equal(f.inbox.health().pending,1);assert.equal(state.submits,0);
        assert.equal(await callback(route),204);assert.equal(f.inbox.health().receipts,1);
        await route.stopRecovery();const restarted=createLocalPaymentHoldInbox(f.settings);f.inbox=restarted;
        const second=compose(f);await second.route.recoverPending();assert.equal(second.state.grants.size,1);
        assert.equal(restarted.health().pending,0);assert.equal(await callback(second.route),204);
        await second.route.recoverPending();assert.equal(second.state.submits,1);await second.route.stopRecovery();
    }finally{await f.close();}
});
test("authority unavailable acknowledges durable custody and later resumes once",async()=>{
    const f=fixture();try{const {route,state}=compose(f,{authorityError:true});assert.equal(await callback(route),204);assert.equal(state.submits,0);state.authorityError=false;await route.recoverPending();await route.recoverPending();assert.equal(state.submits,1);assert.equal(f.inbox.health().pending,0);await route.stopRecovery();}finally{await f.close();}
});
for(const phase of ["before_persist","after_persist"])test(`${phase} admission error never acknowledges and retry recovers one identity`,async()=>{
    let fail=true;const f=fixture({boundary(name,kind){if(fail&&kind==="admit"&&name===phase){fail=false;throw Error("NAMED_CRASH");}}});
    try{const {route,state}=compose(f);assert.equal(await callback(route),500);assert.equal(state.queries,0);assert.equal(f.inbox.health().pending,phase==="after_persist"?1:0);assert.equal(await callback(route),204);assert.equal(state.grants.size,1);assert.equal(f.inbox.health().receipts,1);await route.stopRecovery();}finally{await f.close();}
});
test("lost V2 response after application replays same canonical body and only one fake durable effect",async()=>{
    const f=fixture();try{const {route,state}=compose(f,{submit(p,s){if(s.submits===1)throw Error("lost response after application");return response(p);}});assert.equal(await callback(route),204);assert.equal(f.inbox.health().pending,1);await route.recoverPending();assert.equal(state.submits,2);assert.equal(state.grants.size,1);assert.equal(f.inbox.health().pending,0);await route.stopRecovery();}finally{await f.close();}
});
test("malformed service Pending cannot discharge the holding inbox",async()=>{
    const f=fixture();try{const {route,state}=compose(f,{submit(){return {status:202,body:JSON.stringify({status:"Pending",operationId:"forged"})};}});assert.equal(await callback(route),204);assert.equal(f.inbox.health().pending,1);assert.equal(state.submits,1);await route.stopRecovery();}finally{await f.close();}
});
test("V1 durable receipt handoff before cutover prevents a post-cutover second grant",async()=>{
    let legacy=0;const f=fixture();try{const {route,state}=compose(f,{mode:"V1",async legacyReceiptProcessor(r){legacy++;const e=f.inbox.pending()[0];return {status:"checkpoints_pending",transaction:{providerTransactionId:r.transactionId,playFabId:r.playFabId,planHash:e.request.productPlanHash}};}});
        assert.equal(await callback(route),204);assert.equal(legacy,1);assert.equal(f.inbox.health().pending,0);state.mode="V2";
        assert.equal(await callback(route),204);await route.recoverPending();assert.equal(legacy,1);assert.equal(state.submits,0);await route.stopRecovery();
    }finally{await f.close();}
});
test("V1 response lost before handoff never guesses receipt import after V2 cutover",async()=>{
    let legacy=0;const f=fixture();try{const {route,state}=compose(f,{mode:"V1",async legacyReceiptProcessor(){legacy++;throw Error("lost after legacy acceptance");}});
        assert.equal(await callback(route),204);assert.equal(f.inbox.pending()[0].legacyAttempt,true);
        state.mode="V2";await route.recoverPending();assert.equal(legacy,1);assert.equal(state.submits,0);assert.equal(f.inbox.health().pending,1);
        assert.equal(route.recoveryHealth().lastError,"PAYMENT_LEGACY_HANDOFF_REQUIRES_RECONCILIATION");await route.stopRecovery();
    }finally{await f.close();}
});
test("remembered migration fence blocks a stale V1 proof without losing custody",async()=>{
    const f=fixture();try{let legacy=0;await f.fence.remember(proof("Migrating"));const {route,state}=compose(f,{mode:"V1",legacyReceiptProcessor:async()=>legacy++});assert.equal(await callback(route),204);assert.equal(f.inbox.health().pending,1);assert.equal(state.submits,0);assert.equal(legacy,0);await route.stopRecovery();}finally{await f.close();}
});
test("invalid signatures have no durable receipt or authority query",async()=>{
    const f=fixture();try{const {route,state}=compose(f);assert.notEqual(await callback(route,payload(),false),204);assert.equal(f.inbox.health().receipts,0);assert.equal(state.queries,0);await route.stopRecovery();}finally{await f.close();}
});
test("conflicting duplicate fails before authority and preserves original canonical receipt",async()=>{
    const f=fixture();try{const {route,state}=compose(f,{mode:"Migrating"});assert.equal(await callback(route),204);const p=payload();p.custom_parameters={seabyss_product_plan_version:"1"};assert.equal(await callback(route,p),500);assert.equal(state.queries,1);assert.equal(f.inbox.health().receipts,1);assert.equal(f.inbox.pending()[0].request.productPlanVersion,2);await route.stopRecovery();}finally{await f.close();}
});
test("late old checkout token preserves its immutable historical plan",async()=>{
    const f=fixture();try{const {route,state}=compose(f);const p=payload();p.custom_parameters={seabyss_product_plan_version:"1"};assert.equal(await callback(route,p),204);assert.equal([...state.grants.values()][0].productPlanVersion,1);await route.stopRecovery();}finally{await f.close();}
});
for(const version of ["999999","01",null,2])test(`invalid original plan version ${version} cannot enter custody`,async()=>{
    const f=fixture();try{const {route,state}=compose(f);const p=payload();p.custom_parameters={seabyss_product_plan_version:version};assert.equal(await callback(route,p),500);assert.equal(f.inbox.health().receipts,0);assert.equal(state.queries,0);await route.stopRecovery();}finally{await f.close();}
});
test("checkout closure refuses only new tokens; earlier token callback is still accepted",async()=>{
    const f=fixture();try{let tokens=0,open=true;const {route,state}=compose(f,{mode:"Migrating"});await f.inbox.acquireOwnership();const settings={enabled:true,allowSandbox:true,allowedSkus:[sku],familyGates:{diamond_pack:true},canCreateCheckout:()=>open&&f.inbox.canCreateCheckout(),async createProviderToken(){tokens++;return {token:"earlier-local-token"};}};
        const checkout=createXsollaCheckoutService(settings);const input={session:{player:{playFabId:recipient}},request:{sku}};
        assert.equal((await checkout(input)).checkout.token,"earlier-local-token");open=false;
        await assert.rejects(()=>checkout(input),e=>e.code==="CHECKOUT_CLOSED");assert.equal(tokens,1);
        const closed=createXsollaCheckoutService({...settings,checkoutClosed:true});await assert.rejects(()=>closed(input),e=>e.code==="CHECKOUT_CLOSED");
        assert.equal(await callback(route),204);assert.equal(f.inbox.health().pending,1);state.mode="V2";await route.recoverPending();assert.equal(state.grants.size,1);await route.stopRecovery();
    }finally{await f.close();}
});
test("bounded inbox closes new checkout with room for late tokens, never evicts identities",async()=>{
    const f=fixture({maximumReceipts:4,maximumPending:4});try{await f.inbox.acquireOwnership();assert.equal(f.inbox.canCreateCheckout(),true);for(let i=1;i<=3;i++)f.inbox.admit(receipt(String(i)));assert.equal(f.inbox.canCreateCheckout(),false);const entry=f.inbox.admit(receipt("4"));assert.throws(()=>f.inbox.admit(receipt("5")),/CAPACITY/);f.inbox.handoff(entry.operationId,entry.request.canonicalPayloadSha256,"V2","Pending");assert.equal(f.inbox.health().receipts,4);assert.equal(f.inbox.health().pending,3);assert.equal(f.inbox.admit(receipt("4")).handoff.status,"Pending");assert.equal(f.inbox.canCreateCheckout(),false);}finally{await f.close();}
});
for(const mutation of ["partial-tail","duplicate","reordered","hash"] )test(`holding inbox ${mutation} corruption fails closed`,async()=>{
    const f=fixture();try{await f.inbox.acquireOwnership();f.inbox.admit(receipt("1"));f.inbox.admit(receipt("2"));await f.inbox.close();const lines=fs.readFileSync(f.settings.filePath,"utf8").split("\n");
        if(mutation==="partial-tail")lines[lines.length-1]='{"sequence":';
        if(mutation==="duplicate")lines.splice(2,0,lines[1]);
        if(mutation==="reordered")[lines[1],lines[2]]=[lines[2],lines[1]];
        if(mutation==="hash")lines[1]=lines[1].replace('"quantity":1','"quantity":2');
        fs.writeFileSync(f.settings.filePath,lines.join("\n"));assert.throws(()=>createLocalPaymentHoldInbox(f.settings));
    }finally{await f.close();}
});
function child(filePath,phase){return fork(new URL("fixtures/monetary-v2-hold-crash-child.mjs",import.meta.url),[filePath,phase,JSON.stringify(receipt())],{stdio:["ignore","ignore","ignore","ipc"]});}
async function boundary(proc,expected){const timeout=setTimeout(()=>proc.kill(),5000);try{const [m]=await once(proc,"message");assert.equal(m.boundary,expected);}finally{clearTimeout(timeout);}}
async function kill(proc){const exit=once(proc,"exit");proc.kill();await exit;}
test("kernel ownership excludes a second process and releases automatically on owner crash",async()=>{
    const f=fixture();const owner=child(f.settings.filePath,"owned");try{await boundary(owner,"owned");await assert.rejects(()=>f.inbox.acquireOwnership(),/ALREADY_OWNED/);assert.throws(()=>f.inbox.admit(receipt()),/OWNERSHIP/);await kill(owner);await f.inbox.acquireOwnership();f.inbox.admit(receipt());assert.equal(f.inbox.health().receipts,1);}finally{if(owner.exitCode===null&&!owner.killed)await kill(owner);await f.close();}
});
for(const phase of ["before_persist","after_persist"])test(`actual process kill at ${phase} resumes without duplicate custody`,async()=>{
    const f=fixture();const proc=child(f.settings.filePath,phase);try{await boundary(proc,phase);await kill(proc);await f.inbox.acquireOwnership();assert.equal(f.inbox.health().pending,phase==="after_persist"?1:0);f.inbox.admit(receipt());f.inbox.admit(receipt());assert.equal(f.inbox.health().receipts,1);assert.equal(f.inbox.health().pending,1);}finally{if(proc.exitCode===null&&!proc.killed)await kill(proc);await f.close();}
});

for (const terminal of [false,true]) test(`stale recovery batch cannot bypass concurrently persisted V1 ${terminal ? "handoff" : "attempt"}`,async()=>{
    const f=fixture();try {
        await f.inbox.acquireOwnership();f.inbox.admit(receipt("1"));f.inbox.admit(receipt("2"));
        let unblockFirst,signalFirst,queries=0,mode="V1",legacy=0;
        const gate=new Promise(resolve=>{unblockFirst=resolve;});
        const entered=new Promise(resolve=>{signalFirst=resolve;});
        const submitted=[];
        const client=createMonetaryV2PaymentClient({...options,transport:async q=>{
            if(q.body===null){queries++;if(queries===1){signalFirst();await gate;}return {status:200,body:JSON.stringify(proof(mode))};}
            const p=JSON.parse(q.body);submitted.push(p.transactionId);return response(p);
        }});
        const {route}=compose(f,{client,legacyReceiptProcessor:async r=>{
            legacy++;assert.equal(r.transactionId,"2");
            if(!terminal)throw Error("LOST_AFTER_LEGACY_ADMISSION");
            const held=f.inbox.pending().find(e=>e.request.transactionId==="2");
            return {status:"checkpoints_pending",transaction:{providerTransactionId:r.transactionId,playFabId:r.playFabId,planHash:held.request.productPlanHash}};
        }});
        const scanning=route.recoverPending();await entered;
        assert.equal(await callback(route,payload("2")),204);
        mode="V2";unblockFirst();await scanning;
        assert.deepEqual(submitted,["1"]);assert.equal(legacy,1);
        assert.equal(f.inbox.health().pending,terminal?0:1);
        if(!terminal)assert.equal(route.recoveryHealth().lastError,"PAYMENT_LEGACY_HANDOFF_REQUIRES_RECONCILIATION");
        await route.stopRecovery();
    } finally {await f.close();}
});

test("durable quarantine is auditable after restart and does not block another accepted purchase",async()=>{
    const f=fixture();try {
        const {route,state}=compose(f,{mode:"V1",legacyReceiptProcessor:async()=>{throw Error("RESPONSE_LOST");}});
        assert.equal(await callback(route,payload("71")),204);state.mode="V2";await route.recoverPending();
        const before=route.quarantinePage();assert.equal(before.total,1);assert.equal(before.entries[0].transactionId,"71");
        assert.equal(before.entries[0].reason,"LEGACY_RECEIPT_OUTCOME_UNKNOWN");assert.equal(before.entries[0].recipient,recipient);
        assert.equal(f.inbox.health().pending,1);assert.equal(f.inbox.health().retryable,0);assert.equal(f.inbox.health().quarantined,1);
        assert.equal(await callback(route,payload("72")),204);assert.equal(state.grants.size,1);assert.equal(state.submits,1);
        assert.equal(await callback(route,payload("71")),204);assert.equal(state.submits,1);
        await route.stopRecovery();const reopened=createLocalPaymentHoldInbox(f.settings);f.inbox=reopened;
        assert.deepEqual(reopened.quarantinePage(),before);const again=compose(f);await again.route.recoverPending();
        assert.equal(again.state.submits,0);assert.equal(await callback(again.route,payload("71")),204);assert.equal(again.state.queries,0);
        const original=reopened.get(before.entries[0].operationId);assert.equal(original.receipt.transactionId,"71");assert.equal(original.legacyAttempt,true);
        assert.throws(()=>reopened.handoff(original.operationId,original.request.canonicalPayloadSha256,"V2","Completed"),/HANDOFF_CONFLICT/);
        await again.route.stopRecovery();
    }finally{await f.close();}
});
for(const phase of ["before_persist","after_persist"])test(`quarantine ${phase} failure retains original and never submits uncertain legacy payment`,async()=>{
    let fail=true;const f=fixture({boundary(name,kind){if(fail&&kind==="quarantine"&&name===phase){fail=false;throw Error("QUARANTINE_CRASH");}}});
    try{const {route,state}=compose(f,{mode:"V1",legacyReceiptProcessor:async()=>{throw Error("LEGACY_RESPONSE_LOST");}});
        assert.equal(await callback(route),204);state.mode="V2";await route.recoverPending();assert.equal(state.submits,0);
        await route.stopRecovery();const restarted=createLocalPaymentHoldInbox(f.settings);f.inbox=restarted;
        const after=compose(f);await after.route.recoverPending();assert.equal(after.state.submits,0);assert.equal(restarted.quarantinePage().total,1);
        assert.equal(restarted.health().receipts,1);assert.equal(restarted.health().retryable,0);await after.route.stopRecovery();
    }finally{await f.close();}
});
test("quarantine diagnostic pagination is exact, bounded and has no mutation operation",async()=>{
    const f=fixture();try{await f.inbox.acquireOwnership();for(const id of ["81","82","83"]){const e=f.inbox.admit(receipt(id));f.inbox.markLegacyAttempt(e.operationId,e.request.canonicalPayloadSha256);f.inbox.quarantineLegacyAttempt(e.operationId,proof("V2"),"2026-09-25T04:00:00.000Z");}
        const a=f.inbox.quarantinePage(2);assert.equal(a.total,3);assert.equal(a.entries.length,2);assert.ok(a.next);
        const b=f.inbox.quarantinePage(2,a.next);assert.equal(b.entries.length,1);assert.equal(b.next,null);
        assert.deepEqual([...a.entries,...b.entries].map(e=>e.transactionId),["81","82","83"]);
        assert.throws(()=>f.inbox.quarantinePage(101),/AUDIT_PAGE/);assert.throws(()=>f.inbox.quarantinePage(1,"missing"),/AUDIT_CURSOR/);
        assert.equal(f.inbox.pending().length,0);assert.equal(f.inbox.health().pending,3);assert.equal(f.inbox.health().receipts,3);
    }finally{await f.close();}
});
