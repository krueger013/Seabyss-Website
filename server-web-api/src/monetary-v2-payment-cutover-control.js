import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {createHash,timingSafeEqual} from "node:crypto";

const sha=value=>createHash("sha256").update(value).digest("hex");
const digest=value=>/^[a-f0-9]{64}$/.test(value??"");
const exact=(x,keys)=>x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const phases=new Set(["HOLDING","READY_FOR_MIGRATION","V2_ACTIVE"]);
export function validateCutoverPrivateStat(st,effectiveUid){
    if(st.uid!==0&&st.uid!==effectiveUid)throw Error("CUTOVER_PRIVATE_OWNER_REQUIRED");
    if(st.isDirectory()){
        // Root-owned sticky /tmp is safe for an exclusively owned private child.
        if((st.mode&0o022)!==0&&!(st.uid===0&&(st.mode&0o1000)!==0))throw Error("CUTOVER_PRIVATE_DIRECTORY_REQUIRED");
    }else if(st.isFile()){
        if((st.mode&0o027)!==0||st.nlink!==1)throw Error("CUTOVER_PRIVATE_FILE_REQUIRED");
    }else throw Error("CUTOVER_PRIVATE_TYPE_REQUIRED");
}
export function validatePaymentCutoverPrivatePath(file){
    if(typeof file!=="string"||!path.isAbsolute(file)||file.startsWith("\\\\"))throw Error("CUTOVER_PRIVATE_PATH_REQUIRED");
    for(let p=file;;p=path.dirname(p)){
        if(fs.existsSync(p)){const st=fs.lstatSync(p);if(st.isSymbolicLink())throw Error("CUTOVER_SYMLINK_REFUSED");
            if(process.platform==="linux")validateCutoverPrivateStat(st,process.geteuid());}
        if(path.dirname(p)===p)break;
    }
    return file;
}
function validateProof(s){
    if((s.migrationPlanSha256===null)!==(s.bindRootFenceReceiptSha256===null)||
        (s.migrationPlanSha256!==null&&(!digest(s.migrationPlanSha256)||!digest(s.bindRootFenceReceiptSha256))))throw Error("CUTOVER_FINAL_BINDING_INVALID");
    if(s.phase!=="HOLDING"&&(!digest(s.migrationPlanSha256)||s.rootFenceReceiptSha256!==s.bindRootFenceReceiptSha256))throw Error("CUTOVER_FINAL_BINDING_REQUIRED");
    if(!phases.has(s.phase)||(s.phase==="HOLDING"?[s.inventorySha256,s.inventoryContentSha256,s.inventoryFile,s.rootFenceReceiptSha256].some(x=>x!==null):
        !digest(s.inventorySha256)||!digest(s.inventoryContentSha256)||!digest(s.rootFenceReceiptSha256)||s.inventoryFile!==`legacy-inventory-${s.inventorySha256}.json`))throw Error("CUTOVER_STATE_PROOF_INVALID");
}
const localFile=validatePaymentCutoverPrivatePath;
function fsyncDirectory(directory){if(process.platform==="linux"){const fd=fs.openSync(directory,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}}
function writeNew(file,bytes){const fd=fs.openSync(file,"wx",0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fsyncDirectory(path.dirname(file));}
export function paymentCutoverBinding({configurationSha256,planSha256,custodyFile,inventoryDirectory}){
    if(!digest(configurationSha256)||!digest(planSha256))throw Error("CUTOVER_EXACT_BINDING_REQUIRED");
    localFile(custodyFile);localFile(inventoryDirectory);
    const custody=fs.realpathSync.native(custodyFile);
    return {schema:1,environment:"production",titleId:"142853",configurationSha256,planSha256,
        custodyPathSha256:sha(process.platform==="win32"?custody.toLowerCase():custody),
        inventoryDirectorySha256:sha(path.resolve(inventoryDirectory))};
}
// Provision once before starting the backend. Never truncate/reset an existing generation.
export function createPaymentCutoverState({filePath,binding,initialize=false,ownsCustody=()=>false,boundary=()=>{}}){
    localFile(filePath);const header=JSON.stringify(binding);
    if(initialize&&!fs.existsSync(filePath))writeNew(filePath,header+"\n");
    function read(){
        localFile(filePath);
        const st=fs.lstatSync(filePath);if(!st.isFile()||st.isSymbolicLink()||st.size>2097152)throw Error("CUTOVER_STATE_INVALID");
        const raw=fs.readFileSync(filePath),lines=new TextDecoder("utf-8",{fatal:true}).decode(raw).split("\n");
        if(lines.shift()!==header||lines.pop()!=="")throw Error("CUTOVER_BINDING_OR_TAIL_INVALID");
        let generation=0,head=sha(header),state={phase:"HOLDING",inventorySha256:null,inventoryContentSha256:null,inventoryFile:null,rootFenceReceiptSha256:null,migrationPlanSha256:null,bindRootFenceReceiptSha256:null};
        for(const line of lines){
            const row=JSON.parse(line);
            if(!exact(row,["generation","previous","state","sha256"])||row.generation!==generation+1||row.previous!==head||
                row.sha256!==sha(JSON.stringify([row.generation,row.previous,row.state]))||
                !exact(row.state,["phase","inventorySha256","inventoryContentSha256","inventoryFile","rootFenceReceiptSha256","migrationPlanSha256","bindRootFenceReceiptSha256"])||!phases.has(row.state.phase))throw Error("CUTOVER_STATE_CHAIN_INVALID");
            const s=row.state;
            validateProof(s);
            if(state.migrationPlanSha256!==null&&(s.migrationPlanSha256!==state.migrationPlanSha256||s.bindRootFenceReceiptSha256!==state.bindRootFenceReceiptSha256))throw Error("CUTOVER_FINAL_BINDING_IMMUTABLE");
            if(state.migrationPlanSha256===null&&s.migrationPlanSha256!==null&&(state.phase!=="HOLDING"||s.phase!=="HOLDING"))throw Error("CUTOVER_FINAL_BINDING_REQUIRES_HOLD");
            if(s.phase==="V2_ACTIVE"&&state.phase!=="READY_FOR_MIGRATION")throw Error("CUTOVER_TRANSITION_INVALID");
            if(s.phase==="READY_FOR_MIGRATION"&&state.phase!=="HOLDING")throw Error("CUTOVER_TRANSITION_INVALID");
            generation=row.generation;head=row.sha256;state=s;
        }
        if(generation>1024)throw Error("CUTOVER_GENERATION_LIMIT");
        return {...binding,...state,generation,stateSha256:head};
    }
    read();
    return Object.freeze({read,transition(expectedGeneration,next){
        if(!ownsCustody())throw Error("CUTOVER_CUSTODY_OWNERSHIP_REQUIRED");
        const current=read();if(expectedGeneration!==current.generation)throw Error("CUTOVER_GENERATION_CONFLICT");
        if(current.generation>=1024)throw Error("CUTOVER_GENERATION_LIMIT");
        const state={phase:next.phase,inventorySha256:next.inventorySha256??null,inventoryContentSha256:next.inventoryContentSha256??null,inventoryFile:next.inventoryFile??null,rootFenceReceiptSha256:next.rootFenceReceiptSha256??null,migrationPlanSha256:next.migrationPlanSha256??current.migrationPlanSha256,bindRootFenceReceiptSha256:next.bindRootFenceReceiptSha256??current.bindRootFenceReceiptSha256};
        if(!phases.has(state.phase)||(state.phase==="READY_FOR_MIGRATION"&&current.phase!=="HOLDING")||(state.phase==="V2_ACTIVE"&&current.phase!=="READY_FOR_MIGRATION"))throw Error("CUTOVER_TRANSITION_INVALID");
        validateProof(state);
        if(current.migrationPlanSha256!==null&&(state.migrationPlanSha256!==current.migrationPlanSha256||state.bindRootFenceReceiptSha256!==current.bindRootFenceReceiptSha256))throw Error("CUTOVER_FINAL_BINDING_IMMUTABLE");
        if(current.migrationPlanSha256===null&&state.migrationPlanSha256!==null&&(current.phase!=="HOLDING"||state.phase!=="HOLDING"))throw Error("CUTOVER_FINAL_BINDING_REQUIRES_HOLD");
        const row={generation:current.generation+1,previous:current.stateSha256,state};row.sha256=sha(JSON.stringify([row.generation,row.previous,row.state]));
        const line=JSON.stringify(row)+"\n";if(fs.statSync(filePath).size+Buffer.byteLength(line)>2097152)throw Error("CUTOVER_STATE_CAPACITY");
        boundary("cutover.before_persist",state.phase);const fd=fs.openSync(filePath,"a");try{fs.writeFileSync(fd,line);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}boundary("cutover.after_persist",state.phase);
        return read();
    }});
}
// Exact read-only Redis inventory. No Lua, SET, grant, retry or state transition.
// Preserve raw wrappers/indexes/leases. Every non-Completed accepted receipt is an
// explicit unresolved obligation, never inferred absent, failed, fulfilled or waived.
export function createLegacyPaymentInventory({redis,directory,maximumBytes=33554432,maximumKeys=20000}){
    localFile(directory);if(!fs.statSync(directory).isDirectory())throw Error("CUTOVER_INVENTORY_DIRECTORY_REQUIRED");
    if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1024||maximumBytes>33554432||!Number.isSafeInteger(maximumKeys)||maximumKeys<1||maximumKeys>20000)throw Error("CUTOVER_INVENTORY_BOUND_INVALID");
    const prefix="seabyss:payments:ledger:v1:";
    async function collect(){
        localFile(directory);
        const keys=[];for await(const key of redis.scanIterator({MATCH:prefix+"*",COUNT:200})){
            if(typeof key!=="string"||!key.startsWith(prefix)||keys.includes(key)||keys.length>=maximumKeys)throw Error("CUTOVER_REDIS_SCAN_INVALID");keys.push(key);
        }
        keys.sort();const rows=[];let bytes=0;const obligations=[],counts={};
        for(const key of keys){
            const type=await redis.type(key);let value;
            if(type==="string")value=await redis.get(key);
            else if(type==="zset")value=await redis.sendCommand(["ZRANGE",key,"0","-1","WITHSCORES"]);
            else throw Error("CUTOVER_REDIS_TYPE_OR_DISAPPEARANCE_INVALID");
            if(value===null||(type==="string"?typeof value!=="string":!Array.isArray(value)||value.length%2!==0||value.some(x=>typeof x!=="string")))throw Error("CUTOVER_REDIS_VALUE_INVALID");
            const row={key,type,value};bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>maximumBytes)throw Error("CUTOVER_INVENTORY_CAPACITY");rows.push(row);
            if(key.startsWith(prefix+"tx:")){
                if(type!=="string")throw Error("CUTOVER_REDIS_RECEIPT_INVALID");const wrapper=JSON.parse(value),r=wrapper.record;
                if(!r||r.provider!=="xsolla"||typeof r.providerTransactionId!=="string"||typeof r.state!=="string"||!digest(wrapper.immutableHash)||
                    key!==prefix+"tx:"+createHash("sha256").update("xsolla\0"+r.providerTransactionId,"utf8").digest("base64url"))throw Error("CUTOVER_REDIS_RECEIPT_INVALID");
                counts[r.state]=(counts[r.state]??0)+1;
                if(r.state!=="Completed")obligations.push({transactionKey:key,originalState:r.state,rawSha256:sha(value),state:"OPEN_MANUAL_RECONCILIATION",replayAllowed:false,paymentWaiver:false});
            }
        }
        for(const [kind,index] of [["tx:","idx:tx:all"],["reversal:","idx:reversal:all"]]){
            const records=rows.filter(r=>r.key.startsWith(prefix+kind)).map(r=>r.key),idx=rows.find(r=>r.key===prefix+index);
            if(!idx&&records.length)throw Error("CUTOVER_REDIS_INDEX_MISSING");
            const members=idx?idx.value.filter((_,i)=>i%2===0):[];
            if(idx?.type!==undefined&&idx.type!=="zset"||new Set(members).size!==members.length||records.length!==members.length||records.some(k=>!members.includes(k)))throw Error("CUTOVER_REDIS_INDEX_CONFLICT");
        }
        return {schema:1,namespace:prefix,verification:"exact-raw-preservation-only",completionAuthority:false,rows,counts,obligations,providerMutations:0};
    }
    async function stable(){const first=await collect(),second=await collect();if(JSON.stringify(first)!==JSON.stringify(second))throw Error("CUTOVER_REDIS_INVENTORY_CHANGED");return second;}
    return Object.freeze({async capture(){
        const payload=await stable(),bytes=JSON.stringify(payload),hash=sha(bytes),name=`legacy-inventory-${hash}.json`,file=path.join(directory,name);
        localFile(file);if(Buffer.byteLength(bytes)>maximumBytes)throw Error("CUTOVER_INVENTORY_CAPACITY");
        const existing=fs.readdirSync(directory).filter(x=>/^legacy-inventory-[a-f0-9]{64}\.json$/.test(x));
        if(!fs.existsSync(file)){
            const used=existing.reduce((n,x)=>n+fs.statSync(path.join(directory,x)).size,0);
            if(existing.length>=64||used+Buffer.byteLength(bytes)>134217728)throw Error("CUTOVER_INVENTORY_ARCHIVE_CAPACITY");writeNew(file,bytes);
        }
        if(sha(fs.readFileSync(file))!==hash)throw Error("CUTOVER_INVENTORY_FILE_CONFLICT");
        return {inventorySha256:hash,inventoryContentSha256:hash,inventoryFile:name,counts:payload.counts,unresolved:payload.obligations.length};
    },async verify(state){
        if(!/^legacy-inventory-[a-f0-9]{64}\.json$/.test(state.inventoryFile??""))return false;
        const file=localFile(path.join(directory,state.inventoryFile));if(!fs.lstatSync(file).isFile()||sha(fs.readFileSync(file))!==state.inventorySha256)return false;
        return sha(JSON.stringify(await stable()))===state.inventoryContentSha256;
    }});
}
export function createPaymentCutoverController({state,inventory,custodyStatus,inFlight,drain,verifyAuthority,legacyWorkerRunning=()=>false}){
    let queue=Promise.resolve();
    const serialized=action=>{const next=queue.then(action);queue=next.catch(()=>{});return next;};
    async function status(){
        const s=state.read(),custody=custodyStatus();
        const current=s.phase==="HOLDING"?null:await inventory.verify(s);
        if(state.read().stateSha256!==s.stateSha256)throw Error("CUTOVER_STATUS_CHANGED_RETRY");
        return {schema:1,environment:"production",titleId:"142853",configurationSha256:s.configurationSha256,maintenancePlanSha256:s.planSha256,planSha256:s.migrationPlanSha256,migrationPlanBound:s.migrationPlanSha256!==null,bindRootFenceReceiptSha256:s.bindRootFenceReceiptSha256,
            generation:s.generation,stateSha256:s.stateSha256,phase:s.phase,checkoutClosed:true,
            legacyWorkerRunning:legacyWorkerRunning()===true,inFlight:inFlight(),custodyOwned:custody.owned===true,custodyHealthy:true,
            inventorySha256:s.inventorySha256,inventoryContentSha256:s.inventoryContentSha256,legacyInventoryCurrent:current,
            rootFenceReceiptSha256:s.rootFenceReceiptSha256,readyForMigration:s.phase==="READY_FOR_MIGRATION"&&current===true&&custody.owned===true&&!legacyWorkerRunning()&&inFlight()===0,
            custody:{receipts:custody.receipts,pending:custody.pending,quarantined:custody.quarantined,bytes:custody.bytes,maximumBytes:custody.maximumBytes}};
    }
    function generation(request,fields){if(!exact(request,fields)||!Number.isSafeInteger(request.expectedGeneration)||request.expectedGeneration<0||state.read().generation!==request.expectedGeneration)throw Error("CUTOVER_GENERATION_OR_REQUEST_INVALID");}
    function safe(){if(!custodyStatus().owned||legacyWorkerRunning()||inFlight()!==0)throw Error("CUTOVER_NOT_DRAINED_OR_OWNED");}
    return Object.freeze({status,
        bind:request=>serialized(async()=>{
            generation(request,["expectedGeneration","maintenancePlanSha256","planSha256","rootFenceReceiptSha256"]);
            const s=state.read();
            if(s.phase!=="HOLDING"||request.maintenancePlanSha256!==s.planSha256||!digest(request.planSha256)||!digest(request.rootFenceReceiptSha256))throw Error("CUTOVER_MAINTENANCE_AND_FINAL_BINDING_REQUIRED");
            await drain();safe();
            if(s.migrationPlanSha256!==null){
                if(s.migrationPlanSha256!==request.planSha256||s.bindRootFenceReceiptSha256!==request.rootFenceReceiptSha256)throw Error("CUTOVER_FINAL_BINDING_IMMUTABLE");
            }else state.transition(request.expectedGeneration,{phase:"HOLDING",migrationPlanSha256:request.planSha256,bindRootFenceReceiptSha256:request.rootFenceReceiptSha256});
            return status();
        }),
        hold:request=>serialized(async()=>{generation(request,["expectedGeneration"]);state.transition(request.expectedGeneration,{phase:"HOLDING"});await drain();safe();return status();}),
        prepare:request=>serialized(async()=>{
            generation(request,["expectedGeneration","planSha256","rootFenceReceiptSha256"]);
            if(state.read().phase!=="HOLDING"||request.planSha256!==state.read().migrationPlanSha256||request.rootFenceReceiptSha256!==state.read().bindRootFenceReceiptSha256||!digest(request.rootFenceReceiptSha256))throw Error("CUTOVER_HELD_PLAN_AND_ROOT_BINDING_REQUIRED");
            await drain();safe();const snapshot=await inventory.capture();safe();
            state.transition(request.expectedGeneration,{phase:"READY_FOR_MIGRATION",...snapshot,rootFenceReceiptSha256:request.rootFenceReceiptSha256});return status();
        }),
        activate:request=>serialized(async()=>{
            generation(request,["expectedGeneration","planSha256"]);const s=state.read();
            if(s.phase!=="READY_FOR_MIGRATION"||s.migrationPlanSha256!==request.planSha256||!await inventory.verify(s))throw Error("CUTOVER_READY_PROOF_REQUIRED");
            safe();await verifyAuthority();safe();state.transition(request.expectedGeneration,{...s,phase:"V2_ACTIVE"});return status();
        })
    });
}
export async function listenPaymentCutoverControl({origin,token,controller}){
    const url=new URL(origin);
    if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||Number(url.port)<49152||Number(url.port)>65535||url.pathname!=="/"||url.username||url.password||url.search||url.hash||!/^[!-~]{64,256}$/.test(token))throw Error("CUTOVER_PRIVATE_LISTENER_REQUIRED");
    const expected=createHash("sha256").update(token).digest();
    const server=http.createServer(async(req,res)=>{
        res.setHeader("Content-Type","application/json");
        try{
            const supplied=String(req.headers["x-seabyss-cutover-token"]??"");
            if(!["127.0.0.1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress)||supplied.length>256||!timingSafeEqual(expected,createHash("sha256").update(supplied).digest())){res.statusCode=403;res.end('{"error":"CUTOVER_AUTH_REQUIRED"}');return;}
            if(req.method==="GET"&&req.url==="/v1/payment-cutover/status"){res.end(JSON.stringify(await controller.status()));return;}
            const actions={"/v1/payment-cutover/bind":"bind","/v1/payment-cutover/hold":"hold","/v1/payment-cutover/prepare":"prepare","/v1/payment-cutover/activate":"activate"};
            if(req.method!=="POST"||!Object.hasOwn(actions,req.url)){res.statusCode=404;res.end('{"error":"NOT_FOUND"}');return;}
            let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw Error("CUTOVER_REQUEST_TOO_LARGE");chunks.push(chunk);}
            const request=JSON.parse(Buffer.concat(chunks).toString("utf8"));res.end(JSON.stringify(await controller[actions[req.url]](request)));
        }catch(error){res.statusCode=409;res.end(JSON.stringify({error:/^CUTOVER_[A-Z_]+$/.test(error?.message)?error.message:"CUTOVER_UNAVAILABLE"}));}
    });
    server.requestTimeout=35000;server.headersTimeout=10000;
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(Number(url.port),"127.0.0.1",resolve);});
    return Object.freeze({async close(){await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}});
}
