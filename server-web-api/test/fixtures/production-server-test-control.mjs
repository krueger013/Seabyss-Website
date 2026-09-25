import "./local-network-only.mjs";
// Test-only IPC delivery invokes the same registered SIGTERM coordinator on Windows.
process.on("message",message=>{if(message==="local-test-graceful-stop")process.emit("SIGTERM");});
