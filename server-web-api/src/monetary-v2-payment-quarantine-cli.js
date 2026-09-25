// Read-only local custody audit. No provider/client transport, unlock, grant or repair.
import {pathToFileURL} from "node:url";
import {createLocalPaymentHoldInbox} from "./monetary-v2-payment-hold-inbox.js";
export function readPaymentQuarantine({filePath,environment,titleId,limit=50,after="",productionAuthority=null}) {
    const inbox=createLocalPaymentHoldInbox({filePath,environment,titleId,productionAuthority,initialize:false});
    return {schemaVersion:1,environment,titleId,health:inbox.health(),...inbox.quarantinePage(limit,after)};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
    try {
        const [filePath,environment,titleId,limit="50",after="",authorityHash] = process.argv.slice(2);
        const productionAuthority=authorityHash ? {providerMode:"disabled",configurationSha256:authorityHash} : null;
        process.stdout.write(JSON.stringify(readPaymentQuarantine({filePath,environment,titleId,limit:Number(limit),after,productionAuthority}),null,2)+"\n");
    } catch { process.stderr.write("PAYMENT_QUARANTINE_AUDIT_FAILED\n");process.exitCode=1; }
}
