import "./fixtures/local-network-only.mjs";
import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {privateLoopbackPort} from "./fixtures/private-loopback-port.mjs";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {validateCutoverPrivateStat,paymentCutoverBinding,createPaymentCutoverState,createLegacyPaymentInventory,createPaymentCutoverController,listenPaymentCutoverControl} from "../src/monetary-v2-payment-cutover-control.js";
import {provisionPaymentCutover} from "../src/monetary-v2-payment-cutover-cli.js";
import {createLocalPaymentHoldInbox} from "../src/monetary-v2-payment-hold-inbox.js";
import {createLocalFilePaymentAuthorityFence,createMonetaryV2XsollaComposition} from "../src/monetary-v2-xsolla-composition.js";
import {configureLocalMonetaryV2Payments} from "../src/monetary-v2-payment-bootstrap.js";
const sha=v=>createHash("sha256").update(v).digest("hex"),H="a".repeat(64),P="b".repeat(64),R="c".repeat(64);
const realm={environment:"production",titleId:"142853",productionAuthority:{providerMode:"disabled",configurationSha256:H}};
const prefix="seabyss:payments:ledger:v1:";
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function redisFixture(states=["Completed","Received","Processing","Unknown"]){
    const values=new Map(),reads=[];
    const txs=states.map((state,i)=>{const id=String(99000+i),key=prefix+"tx:"+createHash("sha256").update("xsolla\0"+id).digest("base64url");values.set(key,{type:"string",value:JSON.stringify({immutableHash:H,record:{provider:"xsolla",providerTransactionId:id,state,checkpoints:{gold:{original:"retained"}},audit:[{source:"offline"}]}})});return key;});
    if(txs.length)values.set(prefix+"idx:tx:all",{type:"zset",value:txs.flatMap((k,i)=>[k,String(i)])});
    return {values,reads,async *scanIterator(){reads.push("SCAN");yield*values.keys();},async type(k){reads.push("TYPE");return values.get(k)?.type??"none";},async get(k){reads.push("GET");return values.get(k)?.value??null;},async sendCommand(args){assert.equal(args[0],"ZRANGE");reads.push("ZRANGE");return values.get(args[1])?.value;}};
}
async function fixture(t,{states,owned=true}={}){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cutover-control-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const config={schema:1,configurationSha256:H,planSha256:P,custodyFile:path.join(dir,"custody.jsonl"),fenceFile:path.join(dir,"fence.jsonl"),inventoryDirectory:path.join(dir,"inventory"),stateFile:path.join(dir,"control.jsonl")};
    provisionPaymentCutover(config);const inbox=createLocalPaymentHoldInbox({...realm,filePath:config.custodyFile});
    if(owned)await inbox.acquireOwnership();t.after(()=>inbox.close());
    const binding=paymentCutoverBinding(config),state=createPaymentCutoverState({filePath:config.stateFile,binding,ownsCustody:()=>inbox.health().owned});
    const redis=redisFixture(states),inventory=createLegacyPaymentInventory({redis,directory:config.inventoryDirectory});
    const live={inFlight:0,worker:false,verifications:0,drain:async()=>{},verify:async()=>{}};
    const controller=createPaymentCutoverController({state,inventory,custodyStatus:()=>inbox.health(),inFlight:()=>live.inFlight,drain:()=>live.drain(),legacyWorkerRunning:()=>live.worker,verifyAuthority:async()=>{live.verifications++;await live.verify();}});
    return {dir,config,inbox,binding,state,redis,inventory,live,controller};
}
const bind=f=>f.controller.bind({expectedGeneration:f.state.read().generation,maintenancePlanSha256:P,planSha256:P,rootFenceReceiptSha256:R});
const ready=async f=>{if(f.state.read().migrationPlanSha256===null)await bind(f);return f.controller.prepare({expectedGeneration:f.state.read().generation,planSha256:P,rootFenceReceiptSha256:R});};
test("initial custody HOLDING readiness is independent of PostgreSQL and checkout stays closed",async t=>{
    const f=await fixture(t);f.live.verify=async()=>{throw Error("PG_OFFLINE");};const s=await f.controller.status();
    assert.equal(s.phase,"HOLDING");assert.equal(s.custodyOwned,true);assert.equal(s.custodyHealthy,true);assert.equal(s.checkoutClosed,true);assert.equal(s.readyForMigration,false);assert.equal(f.live.verifications,0);
    const r=await ready(f);assert.equal(r.phase,"READY_FOR_MIGRATION");assert.equal(r.generation,2);assert.equal(r.readyForMigration,true);assert.equal(f.live.verifications,0);
    await assert.rejects(()=>f.controller.activate({expectedGeneration:2,planSha256:P}),/PG_OFFLINE/);assert.equal(f.state.read().phase,"READY_FOR_MIGRATION");assert.equal(f.state.read().generation,2);
});
test("exact legacy receipt raw wrappers and indices are immutable, unknowns retained with no replay or waiver",async t=>{
    const f=await fixture(t),original=JSON.stringify([...f.redis.values]);const s=await ready(f),file=path.join(f.config.inventoryDirectory,f.state.read().inventoryFile),raw=fs.readFileSync(file),snapshot=JSON.parse(raw);
    assert.equal(sha(raw),s.inventorySha256);assert.equal(snapshot.rows.length,5);assert.equal(snapshot.counts.Completed,1);assert.equal(snapshot.obligations.length,3);
    for(const o of snapshot.obligations){assert.equal(o.rawSha256,sha(f.redis.values.get(o.transactionKey).value));assert.equal(o.replayAllowed,false);assert.equal(o.paymentWaiver,false);assert.equal(o.state,"OPEN_MANUAL_RECONCILIATION");}
    assert.equal(JSON.stringify([...f.redis.values]),original);assert.equal(snapshot.providerMutations,0);assert.ok(f.redis.reads.every(x=>["SCAN","TYPE","GET","ZRANGE"].includes(x)));
    await f.controller.activate({expectedGeneration:2,planSha256:P});assert.equal(f.state.read().phase,"V2_ACTIVE");assert.equal(f.live.verifications,1);assert.equal((await f.controller.status()).checkoutClosed,true);
    provisionPaymentCutover(f.config);assert.equal(f.state.read().generation,3);assert.deepEqual(fs.readFileSync(file),raw);
});
for(const flaw of ["missing-index","missing-row","wrong-type","bad-wrapper","changed-second-scan"])
    test(`inventory refuses ${flaw} without changing phase or receipt data`,async t=>{
        const f=await fixture(t),key=[...f.redis.values.keys()][0];
        if(flaw==="missing-index")f.redis.values.delete(prefix+"idx:tx:all");
        if(flaw==="missing-row")f.redis.values.delete(key);
        if(flaw==="wrong-type")f.redis.values.get(key).type="hash";
        if(flaw==="bad-wrapper")f.redis.values.get(key).value="{}";
        if(flaw==="changed-second-scan"){let scans=0;const original=f.redis.scanIterator;f.redis.scanIterator=async function*(){if(++scans===2)f.redis.values.get(key).value+=' ';yield* original.call(this);};}
        await bind(f);const before=fs.readFileSync(f.config.stateFile);await assert.rejects(()=>ready(f));assert.deepEqual(fs.readFileSync(f.config.stateFile),before);
    });
test("post-inventory Redis mutation blocks activation and readiness without repairing or dropping money",async t=>{
    const f=await fixture(t);await ready(f);const key=[...f.redis.values.keys()][0];f.redis.values.get(key).value+=' ';
    assert.equal((await f.controller.status()).readyForMigration,false);await assert.rejects(()=>f.controller.activate({expectedGeneration:2,planSha256:P}),/READY_PROOF/);assert.equal(f.live.verifications,0);
});
test("control refuses unowned custody, live writer or in-flight dispatch; caller cannot set fenced flag",async t=>{
    const f=await fixture(t,{owned:false});await assert.rejects(()=>ready(f),/NOT_DRAINED/);await f.inbox.acquireOwnership();
    f.live.worker=true;await assert.rejects(()=>ready(f),/NOT_DRAINED/);f.live.worker=false;f.live.inFlight=1;await assert.rejects(()=>ready(f),/NOT_DRAINED/);f.live.inFlight=0;
    await assert.rejects(()=>f.controller.prepare({expectedGeneration:0,planSha256:P,rootFenceReceiptSha256:R,LegacyWriterFenced:true}),/REQUEST/);assert.equal(f.state.read().generation,0);
});
test("concurrent prepare CAS has exactly one winner and stale generations do not mutate",async t=>{
    const f=await fixture(t),results=await Promise.allSettled([ready(f),ready(f)]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(f.state.read().generation,2);
    await assert.rejects(()=>f.controller.hold({expectedGeneration:0}));assert.equal(f.state.read().phase,"READY_FOR_MIGRATION");
    await f.controller.hold({expectedGeneration:2});assert.equal(f.state.read().phase,"HOLDING");assert.equal(f.state.read().generation,3);
});
test("HOLD persists before waiting for already accepted dispatch; busy status is observable",async t=>{
    const f=await fixture(t);await ready(f);await f.controller.activate({expectedGeneration:2,planSha256:P});const gate=deferred();f.live.inFlight=1;f.live.drain=()=>gate.promise;
    const pending=f.controller.hold({expectedGeneration:3});await Promise.resolve();await Promise.resolve();assert.equal(f.state.read().phase,"HOLDING");assert.equal((await f.controller.status()).inFlight,1);
    f.live.inFlight=0;gate.resolve();assert.equal((await pending).generation,4);
});
test("invalid proofs, plan mismatch and direct ACTIVE cannot poison the durable state",async t=>{
    const f=await fixture(t),before=fs.readFileSync(f.config.stateFile);
    for(const next of [{phase:"READY_FOR_MIGRATION"},{phase:"V2_ACTIVE"},{phase:"HOLDING",inventorySha256:H}])assert.throws(()=>f.state.transition(0,next));
    await assert.rejects(()=>f.controller.prepare({expectedGeneration:0,planSha256:H,rootFenceReceiptSha256:R}));assert.deepEqual(fs.readFileSync(f.config.stateFile),before);
    assert.throws(()=>createPaymentCutoverState({filePath:f.config.stateFile,binding:{...f.binding,planSha256:H}}));
});
for(const corruption of ["partial-tail","modified-row","wrong-custody"])
    test(`restart fails closed on ${corruption}`,async t=>{
        const f=await fixture(t);await ready(f);let binding=f.binding;
        if(corruption==="partial-tail")fs.appendFileSync(f.config.stateFile,'{"generation":2');
        if(corruption==="modified-row")fs.writeFileSync(f.config.stateFile,fs.readFileSync(f.config.stateFile,"utf8").replace('"generation":1','"generation":9'));
        if(corruption==="wrong-custody")binding={...binding,custodyPathSha256:H};
        assert.throws(()=>createPaymentCutoverState({filePath:f.config.stateFile,binding}));
    });
test("bounded raw inventory refuses capacity and retains source unchanged",async t=>{
    const f=await fixture(t),original=JSON.stringify([...f.redis.values]),inventory=createLegacyPaymentInventory({redis:f.redis,directory:f.config.inventoryDirectory,maximumBytes:1024});await assert.rejects(()=>inventory.capture(),/CAPACITY/);assert.equal(JSON.stringify([...f.redis.values]),original);assert.equal(fs.readdirSync(f.config.inventoryDirectory).length,0);
});

test("separate private HTTP controller requires token and strict requests without exposing receipt identities",async t=>{
    const f=await fixture(t),origin=`http://127.0.0.1:${await privateLoopbackPort()}/`,token="Q".repeat(64),listener=await listenPaymentCutoverControl({origin,token,controller:f.controller});t.after(()=>listener.close());
    assert.equal((await fetch(origin+"v1/payment-cutover/status")).status,403);
    const headers={"X-Seabyss-Cutover-Token":token,"Content-Type":"application/json"};let response=await fetch(origin+"v1/payment-cutover/status",{headers});assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes("99000"));assert.ok(!text.includes(token));
    await bind(f);
    response=await fetch(origin+"v1/payment-cutover/prepare",{method:"POST",headers,body:JSON.stringify({expectedGeneration:1,planSha256:P,rootFenceReceiptSha256:R})});assert.equal(response.status,200);assert.equal((await response.json()).readyForMigration,true);
    response=await fetch(origin+"v1/payment-cutover/activate",{method:"POST",headers,body:JSON.stringify({expectedGeneration:0,planSha256:P})});assert.equal(response.status,409);
});
for(const point of ["cutover.before_persist","cutover.after_persist"])
    test(`actual process death ${point} restarts at durable generation without PID unlock`,async t=>{
        const f=await fixture(t);await f.inbox.close();const child=spawn(process.execPath,["--import","./test/fixtures/local-network-only.mjs",path.resolve("test/fixtures/payment-cutover-state-crash.mjs"),f.config.stateFile,f.config.custodyFile,f.config.inventoryDirectory,point],{env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,DOTENV_CONFIG_PATH:path.resolve("test/fixtures/empty-test-env.txt")},stdio:["ignore","pipe","pipe"]});
        let output="";child.stderr.on("data",x=>output+=x);const [exit]=await once(child,"exit");assert.equal(exit,73,output);
        const reopened=createLocalPaymentHoldInbox({...realm,filePath:f.config.custodyFile});await reopened.acquireOwnership();t.after(()=>reopened.close());assert.equal(f.state.read().generation,point.endsWith("after_persist")?1:0);assert.equal(f.state.read().phase,"HOLDING");
    });
function event(id="99001"){return {notificationType:"payment",userId:"CUTOVER_FIXTURE",payload:{notification_type:"payment",settings:{project_id:310966},user:{id:"CUTOVER_FIXTURE"},transaction:{id,payment_date:"2026-09-25T04:00:00Z"},purchase:{total:{amount:"1.99",currency:"USD"},order:{lineitems:[{sku:"seabyss_diamond_pack_1",quantity:1,price:{amount:"1.99",currency:"USD"}}]}}}};}
async function routed(t){
    const f=await fixture(t,{states:[]}),calls={authority:0,submit:0,review:0,authorityWait:null,submitWait:null};
    const client={...realm,enabled:true,async authority(recipient){calls.authority++;if(calls.authorityWait)await calls.authorityWait.promise;return {environment:"production",titleId:"142853",recipient,mode:"V2",epoch:1,sourceHash:R};},async submit(request){calls.submit++;if(calls.submitWait)await calls.submitWait.promise;return {status:"ManualReview",operationId:request.operationId,canonicalPayloadSha256:request.canonicalPayloadSha256,reviewReason:"production_payment_origin_unproven"};},async review(){calls.review++;}};
    // Reuse the real canonical operationId rather than inventing a grant result.
    const {monetaryV2PaymentOperationId}=await import("../src/monetary-v2-payment-client.js");const submit=client.submit;client.submit=async r=>({...await submit(r),operationId:monetaryV2PaymentOperationId(r)});
    const route=createMonetaryV2XsollaComposition({client,fence:createLocalFilePaymentAuthorityFence({...realm,filePath:f.config.fenceFile}),holdInbox:f.inbox,legacyProcessor:async()=>{throw Error("NO_V1");},deliveryAllowed:()=>f.state.read().phase==="V2_ACTIVE",hardenedOptions:{validateUser:async()=>true,starterPaidCoordinator:{settlePaid:async()=>{throw Error("FORBIDDEN_LEGACY_RESERVATION_WRITE");}}},gateOptions:{globalEnabled:true,familyGates:{diamond_pack:true,starter_pack:true},allowedSkus:["seabyss_diamond_pack_1","seabyss_starter_pack_1"]}});t.after(()=>route.stopRecovery());
    return {...f,calls,route};
}
test("held paid callback persists before PG routing; restart, READY and duplicate retain identity, ACTIVE hands off once",async t=>{
    const f=await routed(t);assert.equal(await f.route(event()),"monetary_v2_durably_queued");assert.equal(f.inbox.health().receipts,1);assert.equal(f.calls.authority,0);await f.route.recoverPending();assert.equal(f.calls.authority,0);
    await ready(f);assert.equal(await f.route(event()),"monetary_v2_durably_queued");assert.equal(f.calls.submit,0);
    await f.controller.activate({expectedGeneration:2,planSha256:P});await f.route.recoverPending();assert.equal(f.calls.submit,1);assert.equal(await f.route(event()),"monetary_v2_manual_review");assert.equal(f.calls.submit,1);assert.equal(f.inbox.health().serviceQuarantined,1);
});
test("HOLD while authority awaited forbids subsequent submit and leaves receipt durably queued",async t=>{
    const f=await routed(t);await ready(f);await f.controller.activate({expectedGeneration:2,planSha256:P});f.calls.authorityWait=deferred();const callback=f.route(event());
    while(f.calls.authority===0)await new Promise(r=>setImmediate(r));assert.equal(f.route.monetaryInFlight(),1);f.state.transition(3,{phase:"HOLDING"});const drain=f.route.drainMonetaryDispatch();f.calls.authorityWait.resolve();assert.equal(await callback,"monetary_v2_durably_queued");await drain;assert.equal(f.calls.submit,0);assert.equal(f.route.monetaryInFlight(),0);
});
test("HOLD drains an already submitted operation without accepting another or losing late response",async t=>{
    const f=await routed(t);await ready(f);await f.controller.activate({expectedGeneration:2,planSha256:P});f.calls.submitWait=deferred();const callback=f.route(event());while(f.calls.submit===0)await new Promise(r=>setImmediate(r));
    f.state.transition(3,{phase:"HOLDING"});assert.equal(await f.route(event("99002")),"monetary_v2_durably_queued");assert.equal(f.calls.authority,1);assert.equal(f.route.monetaryInFlight(),1);let drained=false;const drain=f.route.drainMonetaryDispatch().then(()=>drained=true);await Promise.resolve();assert.equal(drained,false);
    f.calls.submitWait.resolve();await callback;await drain;assert.equal(f.calls.submit,1);assert.equal(f.inbox.health().receipts,2);assert.equal(f.inbox.health().serviceQuarantined,1);assert.equal(f.inbox.health().pending,1);
});
test("held reversal is not acknowledged as successful or sent to a provider",async t=>{
    const f=await routed(t);await assert.rejects(()=>f.route({notificationType:"refund",userId:"CUTOVER_FIXTURE"}),/HOLDING/);assert.equal(f.calls.authority,0);assert.equal(f.calls.review,0);
});

test("late Starter is fully validated and held without legacy reservation or PlayFab reconciliation writes",async t=>{
    const f=await routed(t),e=event();e.payload.purchase.total.amount="3.99";e.payload.purchase.order.lineitems[0]={sku:"seabyss_starter_pack_1",quantity:1,price:{amount:"3.99",currency:"USD"}};
    assert.equal(await f.route(e),"monetary_v2_durably_queued");assert.equal(f.inbox.health().receipts,1);assert.equal(f.calls.authority,0);
    const changed=structuredClone(e);changed.payload.transaction.id="99999";changed.payload.purchase.total.amount="0.01";await assert.rejects(()=>f.route(changed));assert.equal(f.inbox.health().receipts,1);
});

test("Linux private metadata rejects other owners, writable shared parents, exposed files and hard links",()=>{
    const file={uid:2000,mode:0o600,nlink:1,isFile:()=>true,isDirectory:()=>false};
    validateCutoverPrivateStat(file,2000);validateCutoverPrivateStat({...file,uid:0,mode:0o640},2000);
    for(const patch of [{uid:2001},{mode:0o666},{mode:0o644},{nlink:2}])assert.throws(()=>validateCutoverPrivateStat({...file,...patch},2000));
    const directory={uid:0,mode:0o755,nlink:1,isFile:()=>false,isDirectory:()=>true};validateCutoverPrivateStat(directory,2000);validateCutoverPrivateStat({...directory,mode:0o1777},2000);
    assert.throws(()=>validateCutoverPrivateStat({...directory,mode:0o777},2000));assert.throws(()=>validateCutoverPrivateStat({...directory,uid:2001,mode:0o700},2000));
});

test("final plan binds once after freeze while custody stays held; old-plan prepare and rebind are rejected",async t=>{
    const f=await routed(t),final="d".repeat(64);assert.equal((await f.controller.status()).planSha256,null);
    await f.route(event());const custody=fs.readFileSync(f.config.custodyFile);
    await assert.rejects(()=>f.controller.prepare({expectedGeneration:0,planSha256:P,rootFenceReceiptSha256:R}));
    const body={expectedGeneration:0,maintenancePlanSha256:P,planSha256:final,rootFenceReceiptSha256:R};
    const s=await f.controller.bind(body);assert.equal(s.phase,"HOLDING");assert.equal(s.generation,1);assert.equal(s.maintenancePlanSha256,P);assert.equal(s.planSha256,final);assert.equal(s.migrationPlanBound,true);
    assert.equal((await f.controller.bind({...body,expectedGeneration:1})).generation,1);
    await assert.rejects(()=>f.controller.bind({...body,expectedGeneration:1,planSha256:H}),/IMMUTABLE/);
    await assert.rejects(()=>f.controller.prepare({expectedGeneration:1,planSha256:P,rootFenceReceiptSha256:R}));
    await assert.rejects(()=>f.controller.prepare({expectedGeneration:1,planSha256:final,rootFenceReceiptSha256:H}));
    assert.deepEqual(fs.readFileSync(f.config.custodyFile),custody);assert.equal(f.calls.authority,0);assert.equal(f.calls.submit,0);
    const reread=createPaymentCutoverState({filePath:f.config.stateFile,binding:f.binding});assert.equal(reread.read().migrationPlanSha256,final);
    assert.equal((await f.controller.prepare({expectedGeneration:1,planSha256:final,rootFenceReceiptSha256:R})).readyForMigration,true);assert.equal(f.calls.authority,0);
});

test("legacy inventory keys match the existing Redis payment store, including base64url identity encoding",async t=>{
    const f=await fixture(t),{createRedisPaymentLedgerStore}=await import("../src/payment-ledger-redis-store.js");
    const store=createRedisPaymentLedgerStore({...f.redis,eval:async()=>{throw Error("NO_REDIS_WRITE");},zRange:async()=>[],mGet:async()=>[],ping:async()=>"PONG"});
    const record=await store.getTransaction({provider:"xsolla",providerTransactionId:"99000"});assert.equal(record.providerTransactionId,"99000");
    const snapshot=await f.inventory.capture();assert.equal(await f.inventory.verify(snapshot),true);
});
