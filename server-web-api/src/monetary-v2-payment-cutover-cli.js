// Explicit provisioning / operator client only. Importing starts no listener.
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createLocalPaymentHoldInbox} from "./monetary-v2-payment-hold-inbox.js";
import {createLocalFilePaymentAuthorityFence} from "./monetary-v2-xsolla-composition.js";
import {validatePaymentCutoverPrivatePath,paymentCutoverBinding,createPaymentCutoverState} from "./monetary-v2-payment-cutover-control.js";
export function provisionPaymentCutover(config){
    const fields=["schema","configurationSha256","planSha256","custodyFile","fenceFile","inventoryDirectory","stateFile"];
    if(!config||config.schema!==1||Object.keys(config).length!==fields.length||fields.some(k=>!Object.hasOwn(config,k)))throw Error("CUTOVER_PROVISION_CONFIG_INVALID");
    const files=[config.custodyFile,config.fenceFile,config.stateFile];
    if(new Set(files.map(p=>path.resolve(p).toLowerCase())).size!==3)throw Error("CUTOVER_SEPARATE_FILES_REQUIRED");
    for(const file of [...files,config.inventoryDirectory]){
        validatePaymentCutoverPrivatePath(file);
        if(!path.isAbsolute(file)||file.startsWith("\\\\"))throw Error("CUTOVER_PRIVATE_PATH_REQUIRED");
        for(let p=file;;p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error("CUTOVER_SYMLINK_REFUSED");if(path.dirname(p)===p)break;}
    }
    if(!fs.existsSync(config.inventoryDirectory))fs.mkdirSync(config.inventoryDirectory,{mode:0o700});
    const realm={environment:"production",titleId:"142853",productionAuthority:{providerMode:"disabled",configurationSha256:config.configurationSha256}};
    createLocalPaymentHoldInbox({...realm,filePath:config.custodyFile,initialize:true});
    createLocalFilePaymentAuthorityFence({...realm,filePath:config.fenceFile,initialize:true});
    const binding=paymentCutoverBinding(config);
    const state=createPaymentCutoverState({filePath:config.stateFile,binding,initialize:true});
    // fsync pre-existing files too; Linux parent directory flush covers first creation.
    for(const file of files){const fd=fs.openSync(file,"r+");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    if(process.platform==="linux")for(const directory of new Set([...files.map(p=>path.dirname(p)),config.inventoryDirectory,path.dirname(config.inventoryDirectory)])){
        const fd=fs.openSync(directory,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    return {schema:1,environment:"production",titleId:"142853",generation:state.read().generation,phase:state.read().phase,configurationSha256:config.configurationSha256,planSha256:config.planSha256};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
    try{
        if(process.argv.length!==4||process.argv[2]!=="provision"||!path.isAbsolute(process.argv[3]))throw Error("CUTOVER_USAGE_PROVISION_ABSOLUTE_CONFIG");
        const stat=fs.lstatSync(process.argv[3]);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw Error("CUTOVER_PROVISION_CONFIG_INVALID");
        console.log(JSON.stringify(provisionPaymentCutover(JSON.parse(fs.readFileSync(process.argv[3],"utf8")))));
    }catch(e){console.error(/^CUTOVER_[A-Z_]+$/.test(e?.message)?e.message:"CUTOVER_PROVISION_FAILED");process.exitCode=1;}
}
