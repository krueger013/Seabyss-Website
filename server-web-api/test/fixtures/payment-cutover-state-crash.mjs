import "./local-network-only.mjs";
import {createLocalPaymentHoldInbox} from "../../src/monetary-v2-payment-hold-inbox.js";
import {paymentCutoverBinding,createPaymentCutoverState} from "../../src/monetary-v2-payment-cutover-control.js";
const [stateFile,custodyFile,inventoryDirectory,point]=process.argv.slice(2),configurationSha256="a".repeat(64),planSha256="b".repeat(64);
const inbox=createLocalPaymentHoldInbox({filePath:custodyFile,environment:"production",titleId:"142853",productionAuthority:{providerMode:"disabled",configurationSha256}});await inbox.acquireOwnership();
const state=createPaymentCutoverState({filePath:stateFile,binding:paymentCutoverBinding({configurationSha256,planSha256,custodyFile,inventoryDirectory}),ownsCustody:()=>inbox.health().owned,boundary:name=>{if(name===point)process.exit(73);}});
state.transition(0,{phase:"HOLDING"});throw Error("BOUNDARY_NOT_REACHED");
