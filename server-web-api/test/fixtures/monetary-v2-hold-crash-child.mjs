import {createLocalPaymentHoldInbox} from "../../src/monetary-v2-payment-hold-inbox.js";
const [filePath, phase, receiptJson] = process.argv.slice(2);
const inbox=createLocalPaymentHoldInbox({filePath,environment:"sandbox",titleId:"1D0C16",boundary(name,kind){
    if(kind==="admit"&&name===phase){process.send({boundary:name});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
}});
try {
    await inbox.acquireOwnership();
    if(phase==="owned") {process.send({boundary:"owned"});setInterval(()=>{},1000);}
    else {inbox.admit(JSON.parse(receiptJson));process.send({boundary:"finished"});setInterval(()=>{},1000);}
} catch { process.send({boundary:"rejected"});process.exitCode=1; }
