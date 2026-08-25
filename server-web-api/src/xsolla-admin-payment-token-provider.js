import { randomUUID } from "node:crypto";

const exactRequestFields = new Set([
    "identity",
    "item",
    "economicContract",
    "customParameters"
]);
const exactIdentityFields = new Set(["playFabId"]);
const exactItemFields = new Set(["sku", "quantity"]);
const exactEconomicFields = new Set([
    "productPlanVersion",
    "currency",
    "unitAmountMinor",
    "totalAmountMinor",
    "promotionPolicy"
]);
const allowedCustomParameters = new Set([
    "seabyss_checkout_id",
    "seabyss_reservation_id",
    "seabyss_product_plan_version"
]);

function exactObjectFields(value, expected) {
    return value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === expected.size &&
        Object.keys(value).every((key) => expected.has(key));
}

function canonicalSecret(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
        value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : null;
}

function canonicalProjectId(value) {
    const normalized = typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : value;
    return typeof normalized === "string" && /^[1-9][0-9]{0,18}$/.test(normalized)
        ? normalized
        : null;
}

function canonicalToken(value, maximumLength = 255) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim() && !/\s/.test(value)
        ? value
        : null;
}

function canonicalCurrency(value) {
    return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

function canonicalOrderId(value) {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        return null;
    }
    try {
        return BigInt(value) <= 9223372036854775807n ? value : null;
    } catch {
        return null;
    }
}

function canonicalCustomParameters(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const keys = Object.keys(value);
    if (keys.some((key) => !allowedCustomParameters.has(key))) {
        return null;
    }
    const result = {};
    for (const key of keys.sort()) {
        const normalized = canonicalToken(value[key], 256);
        if (!normalized) {
            return null;
        }
        result[key] = normalized;
    }
    return result;
}

function validateProviderRequest(request, currency) {
    if (!exactObjectFields(request, exactRequestFields) ||
        !exactObjectFields(request.identity, exactIdentityFields) ||
        !exactObjectFields(request.item, exactItemFields) ||
        !exactObjectFields(request.economicContract, exactEconomicFields)) {
        return null;
    }
    const playFabId = canonicalToken(request.identity.playFabId, 160);
    const sku = canonicalToken(request.item.sku, 255);
    const contract = request.economicContract;
    const customParameters = canonicalCustomParameters(request.customParameters);
    if (!playFabId || !sku || request.item.quantity !== 1 ||
        !Number.isSafeInteger(contract.productPlanVersion) ||
        contract.productPlanVersion <= 0 || contract.currency !== currency ||
        !Number.isSafeInteger(contract.unitAmountMinor) ||
        contract.unitAmountMinor <= 0 ||
        contract.totalAmountMinor !== contract.unitAmountMinor ||
        contract.promotionPolicy !== "disabled" || !customParameters) {
        return null;
    }
    return Object.freeze({ playFabId, sku, customParameters });
}

async function readBoundedJson(response, maximumBytes) {
    const contentLength = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
        throw new Error();
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
        throw new Error();
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error();
    }
}

export class XsollaPaymentTokenProviderError extends Error {
    constructor(message = "Xsolla payment token service is unavailable.") {
        super(message);
        this.name = "XsollaPaymentTokenProviderError";
        this.code = "XSOLLA_PAYMENT_TOKEN_UNAVAILABLE";
    }
}

export function buildXsollaCheckoutUrl(mode, token) {
    const paymentToken = canonicalToken(token, 8192);
    if ((mode !== "sandbox" && mode !== "production") || !paymentToken) {
        throw new TypeError("A configured checkout mode and payment token are required.");
    }
    const host = mode === "sandbox"
        ? "sandbox-secure.xsolla.com"
        : "secure.xsolla.com";
    const url = new URL(`https://${host}/paystation4/`);
    url.searchParams.set("token", paymentToken);
    return url.toString();
}

/**
 * Calls Xsolla's server-side admin payment-token endpoint. Mode, currency,
 * quantity, user identity, project and external order id are all server-owned.
 * The API key is used only in the Authorization header and is never returned.
 */
export function createXsollaAdminPaymentTokenProvider({
    projectId,
    apiKey,
    mode,
    currency = "USD",
    timeoutMs = 8000,
    maximumResponseBytes = 64 * 1024,
    createExternalId = randomUUID,
    fetchImpl = globalThis.fetch
} = {}) {
    const configuredProjectId = canonicalProjectId(projectId);
    const configuredApiKey = canonicalSecret(apiKey);
    const configuredCurrency = canonicalCurrency(currency);
    const configuredMode = mode === "sandbox" || mode === "production" ? mode : null;
    const configured = configuredProjectId && configuredApiKey && configuredCurrency &&
        configuredMode && Number.isInteger(timeoutMs) && timeoutMs > 0 &&
        Number.isInteger(maximumResponseBytes) && maximumResponseBytes >= 1024 &&
        typeof createExternalId === "function" && typeof fetchImpl === "function";

    return async function createXsollaAdminPaymentToken(request) {
        if (!configured) {
            throw new XsollaPaymentTokenProviderError();
        }
        const input = validateProviderRequest(request, configuredCurrency);
        if (!input) {
            throw new TypeError("Xsolla payment token request contract is invalid.");
        }
        const externalId = canonicalToken(createExternalId(), 255);
        if (!externalId) {
            throw new XsollaPaymentTokenProviderError();
        }

        const body = {
            user: { id: { value: input.playFabId } },
            purchase: { items: [{ sku: input.sku, quantity: 1 }] },
            settings: {
                currency: configuredCurrency,
                external_id: externalId,
                sandbox: configuredMode === "sandbox"
            },
            custom_parameters: input.customParameters
        };
        const authorization = "Basic " + Buffer
            .from(`${configuredProjectId}:${configuredApiKey}`, "utf8")
            .toString("base64");

        let response;
        let payload;
        try {
            response = await fetchImpl(
                `https://store.xsolla.com/api/v3/project/${configuredProjectId}/admin/payment/token`,
                {
                    method: "POST",
                    redirect: "error",
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: {
                        "Authorization": authorization,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(body)
                }
            );
            payload = await readBoundedJson(response, maximumResponseBytes);
        } catch {
            throw new XsollaPaymentTokenProviderError();
        }

        const token = canonicalToken(payload?.token, 8192);
        const orderId = canonicalOrderId(payload?.order_id);
        if (response.status !== 201 || !response.ok || !token || !orderId) {
            throw new XsollaPaymentTokenProviderError();
        }
        return Object.freeze({
            token,
            orderId,
            externalId,
            checkoutUrl: buildXsollaCheckoutUrl(configuredMode, token)
        });
    };
}
