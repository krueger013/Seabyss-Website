export function wrapLedgeredReceiptProcessorWithFinancialShadow({
    processReceipt,
    producer = null
} = {}) {
    if (typeof processReceipt !== "function" ||
        (producer !== null && typeof producer?.projectTransaction !== "function")) {
        throw new TypeError("Ledgered receipt Shadow hook is not configured.");
    }
    return async function processAndProjectReceipt(receipt) {
        const result = await processReceipt(receipt);
        if (producer) {
            await producer.projectTransaction({ providerTransactionId: receipt?.transactionId });
        }
        return result;
    };
}
