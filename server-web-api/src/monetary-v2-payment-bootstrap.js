import fs from "node:fs";
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
    return Object.freeze({
        productionAuthorityConfigured: enabled && productionAuthority !== null,
        verifyAuthority: () => client.verifyProductionAuthority(),
        canCreateCheckout: () => productionAuthority === null && holdInbox?.canCreateCheckout() === true,
        attach({legacyProcessor,legacyReceiptProcessor,validateUser,starterPaidCoordinator}) {
            return createMonetaryV2XsollaComposition({client,fence,legacyProcessor,legacyReceiptProcessor,holdInbox,
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