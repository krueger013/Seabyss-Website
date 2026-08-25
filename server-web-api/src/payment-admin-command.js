function canonical(value, name, maximumLength = 500, allowSpaces = false) {
    const invalid = allowSpaces ? /[\r\n\t\u0000-\u001f\u007f]/u : /\s/u;
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || invalid.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function parseFlags(args) {
    if (!Array.isArray(args) || args.length > 16 || args.length % 2 !== 0) {
        throw new TypeError("Payment admin command arguments are invalid.");
    }
    const flags = {};
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (typeof flag !== "string" || !/^--[a-z-]+$/u.test(flag) ||
            Object.hasOwn(flags, flag)) {
            throw new TypeError("Payment admin command contains an invalid or duplicate flag.");
        }
        flags[flag] = canonical(value, flag, 500, flag === "--reason");
    }
    return flags;
}

function noUnknownFlags(flags, allowed) {
    const unknown = Object.keys(flags).filter((flag) => !allowed.has(flag));
    if (unknown.length > 0) {
        throw new TypeError(`Unsupported payment admin flag: ${unknown[0]}`);
    }
}

export function createPaymentAdminCommand({ reconciliation } = {}) {
    if (!reconciliation || typeof reconciliation.lookup !== "function" ||
        typeof reconciliation.safeRetry !== "function") {
        throw new TypeError("Payment admin command is not configured.");
    }

    async function execute(argv, { operator, reason } = {}) {
        if (!Array.isArray(argv) || argv.length === 0 || argv.length > 17) {
            throw new TypeError("Payment admin command is invalid.");
        }
        const actor = canonical(operator, "authenticated operator", 160);
        const auditReason = canonical(reason, "operator reason", 500, true);
        const [command, ...rest] = argv;
        const flags = parseFlags(rest);
        if (command === "lookup") {
            noUnknownFlags(flags, new Set([
                "--provider",
                "--transaction",
                "--order",
                "--receipt",
                "--user",
                "--sku",
                "--cursor",
                "--limit"
            ]));
            const indexed = [
                ["providerTransactionId", flags["--transaction"]],
                ["orderId", flags["--order"]],
                ["receiptId", flags["--receipt"]],
                ["playFabId", flags["--user"]],
                ["sku", flags["--sku"]]
            ].filter(([, value]) => value !== undefined);
            if (indexed.length !== 1 ||
                (indexed[0][0] === "providerTransactionId" && !flags["--provider"])) {
                throw new TypeError("Lookup requires exactly one index and provider for transaction IDs.");
            }
            const query = {
                ...(flags["--provider"] ? { provider: flags["--provider"] } : {}),
                [indexed[0][0]]: indexed[0][1]
            };
            return reconciliation.lookup({
                operator: actor,
                reason: auditReason,
                query,
                cursor: flags["--cursor"] || "0",
                limit: flags["--limit"] === undefined ? 50 : Number(flags["--limit"])
            });
        }
        if (command === "retry") {
            noUnknownFlags(flags, new Set(["--provider", "--transaction"]));
            if (!flags["--provider"] || !flags["--transaction"]) {
                throw new TypeError("Retry requires provider and transaction ID.");
            }
            return reconciliation.safeRetry({
                operator: actor,
                reason: auditReason,
                provider: flags["--provider"],
                providerTransactionId: flags["--transaction"]
            });
        }
        throw new TypeError("Unsupported payment admin command.");
    }

    return Object.freeze({ execute });
}
