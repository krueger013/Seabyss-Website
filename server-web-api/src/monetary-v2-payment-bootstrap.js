import fs from "node:fs";
import {validatePaymentCutoverPrivatePath,paymentCutoverBinding,createPaymentCutoverState,createLegacyPaymentInventory,createPaymentCutoverController,listenPaymentCutoverControl} from "./monetary-v2-payment-cutover-control.js";
import { createLocalPaymentHoldInbox } from "./monetary-v2-payment-hold-inbox.js";
import { createMonetaryV2PaymentClient } from "./monetary-v2-payment-client.js";
import { createLocalFilePaymentAuthorityFence,createMonetaryV2XsollaComposition } from "./monetary-v2-xsolla-composition.js";

// Pure opt-in composition; importing this file reads no environment, secret, or network.
export function configureLocalMonetaryV2Payments({env={},config={},transport}={}) {
    const flag=env.SEABYSS_MONETARY_V2_PAYMENTS_ENABLED;
    if(flag!==undefined&&flag!=="true"&&flag!=="false")throw new Error("Explicit V2 payment enable flag required.");
    const enabled=flag==="true",filePath=env.SEABYSS_MONETARY_V2_PAYMENT_FENCE_FILE;
    if(!enabled&&!filePath)return null;
    const environment=env.SEABYSS_MONETARY_V2_PAYMENT_ENVIRONMENT;
    const titleId=config.playFabTitleId;
    const productionAuthority = environment === "production" && titleId === "142853" &&
        env.SEABYSS_MONETARY_V2_PAYMENT_PRODUCTION_AUTHORITY === "durable-v2-provider-off" &&
        env.SEABYSS_MONETARY_V2_PROVIDER_DISPATCH_MODE === "OFF" &&
        /^[a-f0-9]{64}$/.test(env.SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256 ?? "")
        ? {providerMode:"disabled",configurationSha256:env.SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256} : null;
    if((productionAuthority ? config.nodeEnv!=="production" : config.nodeEnv==="production"||environment!=="sandbox"||titleId!=="1D0C16")||!filePath||
        config.paymentWorkerEnabled===true||config.playFabFinancialAuthorityCutoverEnabled===true)
        throw new Error("V2 payments require explicit durable authority, matching realm and disabled legacy grant workers.");
    if (productionAuthority && config.xsollaCheckoutClosed !== true) throw new Error("PRODUCTION_CHECKOUT_MUST_REMAIN_CLOSED_UNTIL_DURABLE_ADMISSION_QUALIFIED");
    let token="";
    if(enabled){const tokenFile=env.SEABYSS_MONETARY_V2_PAYMENT_TOKEN_FILE;if(typeof tokenFile!=="string"||!tokenFile)throw new Error("Private token file required.");const stat=fs.lstatSync(tokenFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256)throw new Error("Private token file invalid.");token=fs.readFileSync(tokenFile,"utf8");}
    const fence=createLocalFilePaymentAuthorityFence({filePath,environment,titleId,productionAuthority,initialize:false});
    const holdFile=env.SEABYSS_MONETARY_V2_PAYMENT_HOLD_FILE;
    const holdInbox=holdFile ? createLocalPaymentHoldInbox({filePath:holdFile,environment,titleId,productionAuthority,initialize:false}) : null;
    if(enabled&&!holdInbox)throw new Error("Existing durable payment holding inbox required.");
    const client=createMonetaryV2PaymentClient({enabled,environment,titleId,productionAuthority,origin:env.SEABYSS_MONETARY_V2_PAYMENT_ORIGIN,token,...(transport?{transport}:{})});
    const cutoverKeys=["STATE_FILE","PLAN_SHA256","INVENTORY_DIRECTORY","CONTROL_ORIGIN","CONTROL_TOKEN_FILE"];
    const cutoverValues=Object.fromEntries(cutoverKeys.map(key=>[key,env["SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_"+key]]));
    const cutoverEnabled=cutoverKeys.some(key=>cutoverValues[key]!==undefined);
    let cutover=null,controlToken=null,controlListener=null;
    if(cutoverEnabled){
        if(!enabled||!productionAuthority||cutoverKeys.some(key=>typeof cutoverValues[key]!=="string"||!cutoverValues[key])||
            config.financialShadowModeEnabled===true||config.playFabFinancialRefreshEnabled===true)
            throw new Error("CUTOVER_EXPLICIT_PRODUCTION_CUSTODY_REQUIRED");
        const binding=paymentCutoverBinding({configurationSha256:productionAuthority.configurationSha256,
            planSha256:cutoverValues.PLAN_SHA256,custodyFile:holdFile,inventoryDirectory:cutoverValues.INVENTORY_DIRECTORY});
        cutover=createPaymentCutoverState({filePath:cutoverValues.STATE_FILE,binding,ownsCustody:()=>holdInbox.health().owned});
        for(const file of [filePath,holdFile,env.SEABYSS_MONETARY_V2_PAYMENT_TOKEN_FILE,cutoverValues.CONTROL_TOKEN_FILE])validatePaymentCutoverPrivatePath(file);
        const st=fs.lstatSync(cutoverValues.CONTROL_TOKEN_FILE);
        if(!st.isFile()||st.isSymbolicLink()||st.size>256)throw new Error("CUTOVER_PRIVATE_TOKEN_REQUIRED");
        controlToken=fs.readFileSync(cutoverValues.CONTROL_TOKEN_FILE,"utf8");
        if(!/^[!-~]{64,256}$/.test(controlToken)||controlToken===token)throw new Error("CUTOVER_SEPARATE_TOKEN_REQUIRED");
        const origin=new URL(cutoverValues.CONTROL_ORIGIN);
        if(origin.protocol!=="http:"||origin.hostname!=="127.0.0.1"||Number(origin.port)<49152||Number(origin.port)>65535||origin.pathname!=="/"||origin.username||origin.password||origin.search||origin.hash||origin.origin===new URL(env.SEABYSS_MONETARY_V2_PAYMENT_ORIGIN).origin)
            throw new Error("CUTOVER_PRIVATE_LISTENER_REQUIRED");
    }
    return Object.freeze({
        productionAuthorityConfigured: enabled && productionAuthority !== null,
        verifyAuthority: () => client.verifyProductionAuthority(),
        isCustodyOnly: () => cutover!==null&&cutover.read().phase!=="V2_ACTIVE",
        cutoverConfigured: cutover!==null,
        cutoverPhase: () => cutover?.read().phase ?? null,
        async startCutoverControl({redis,route,legacyWorkerRunning=()=>false}){
            if(!cutover)return;
            if(controlListener)throw new Error("CUTOVER_ALREADY_LISTENING");
            const controller=createPaymentCutoverController({state:cutover,
                inventory:createLegacyPaymentInventory({redis,directory:cutoverValues.INVENTORY_DIRECTORY}),
                custodyStatus:()=>route.recoveryHealth(),inFlight:()=>route.monetaryInFlight(),
                drain:()=>route.drainMonetaryDispatch(),verifyAuthority:()=>client.verifyProductionAuthority(),legacyWorkerRunning});
            controlListener=await listenPaymentCutoverControl({origin:cutoverValues.CONTROL_ORIGIN,token:controlToken,controller});
        },
        async stopCutoverControl(){await controlListener?.close();controlListener=null;},
        canCreateCheckout: () => productionAuthority === null && holdInbox?.canCreateCheckout() === true,
        attach({legacyProcessor,legacyReceiptProcessor,validateUser,starterPaidCoordinator}) {
            return createMonetaryV2XsollaComposition({client,fence,legacyProcessor,legacyReceiptProcessor,holdInbox,
                deliveryAllowed:()=>cutover===null||cutover.read().phase==="V2_ACTIVE",
                legacyPremiumOptions:{premiumPlanId:config.xsollaPremiumPlanId,premiumPlanExternalId:config.xsollaPremiumPlanExternalId},
                hardenedOptions:{allowDiamondSandboxGrants:config.xsollaAllowSandboxGrants,
                    diamondSandboxTestPlayFabIds:config.xsollaSandboxTestPlayFabIds,
                    allowStarterSandboxGrants:config.xsollaAllowStarterSandboxGrants,
                    starterSandboxTestPlayFabIds:config.xsollaStarterSandboxTestPlayFabIds,
                    validateUser,starterPaidCoordinator},
                gateOptions:{globalEnabled:config.purchasesGlobalEnabled,
                    familyGates:{starter_pack:config.purchasesStarterEnabled,diamond_pack:config.purchasesDiamondEnabled},
                    allowedSkus:config.xsollaCheckoutAllowedSkus}});
        }
    });
}