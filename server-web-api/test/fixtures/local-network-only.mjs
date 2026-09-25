// Test-only transport isolation, loaded BEFORE server.js and all provider modules.
// No DNS name or external IP may be contacted, even if ambient environment leaks.
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import {syncBuiltinESMExports} from "node:module";
const allowed = host => ["127.0.0.1", "::1", "[::1]"].includes(host);
const blocked = () => { throw new Error("TEST_EXTERNAL_NETWORK_FORBIDDEN"); };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const target = typeof first === "object" && first !== null ? first :
        {port:first,host:typeof args[1] === "string" ? args[1] : "127.0.0.1"};
    if (target.path || !allowed(target.host ?? target.hostname ?? "127.0.0.1")) blocked();
    return originalConnect.apply(this,args);
};
const originalLookup = dns.lookup;
dns.lookup = function(host,...args) { if (!allowed(host)) blocked(); return originalLookup.call(this,host,...args); };
for (const key of Object.keys(dns)) if (key.startsWith("resolve") || key === "reverse") dns[key] = blocked;
for (const key of Object.keys(dns.promises)) if (key.startsWith("resolve") || key === "reverse" || key === "lookup") dns.promises[key] = blocked;
dgram.createSocket = blocked;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input,...args) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["http:","https:"].includes(url.protocol) || !allowed(url.hostname)) blocked();
    return originalFetch(input,...args);
};
syncBuiltinESMExports();
