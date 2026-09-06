export const DIAMONDS_CANARY_SANDBOX_TITLE_ID = "1D0C16";
export const DIAMONDS_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID = "142853";

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function exactSinglePlayFabId(environment, { required }) {
    const singular = environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID;
    const compatibility = environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS;
    const values = [singular, compatibility].filter((value) => value !== undefined && value !== null);
    // Disabled Legacy mode documents empty allowlists; these do not configure a Canary.
    if (!required && values.length > 0 && values.every((value) => value === "")) return null;
    if (values.length === 0) {
        if (!required) return null;
        throw coded("DIAMONDS_CANARY_ID_REQUIRED", "One exact Diamonds Canary PlayFabId is required.");
    }
    for (const value of values) {
        if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
            value.includes(",") || value.includes("*") || /\s/u.test(value) ||
            !/^[A-F0-9]{16}$/u.test(value)) {
            throw coded("DIAMONDS_CANARY_ID_INVALID",
                "Diamonds Canary requires one exact uppercase legacy PlayFabId; wildcard/multiple values are forbidden.");
        }
    }
    if (values.length === 2 && values[0] !== values[1]) {
        throw coded("DIAMONDS_CANARY_ID_CONFLICT", "Diamonds Canary identity settings disagree.");
    }
    return values[0];
}

export function readDiamondsCanaryIdentity(environment = process.env, { required = true } = {}) {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
        throw new TypeError("Diamonds Canary environment is invalid.");
    }
    const playFabId = exactSinglePlayFabId(environment, { required });
    const titleId = environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID ?? null;
    if (playFabId === null && !required) {
        if (titleId === DIAMONDS_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID) {
            throw coded("DIAMONDS_CANARY_PRODUCTION_FORBIDDEN", "Production Title is forbidden for Diamonds Canary.");
        }
        return Object.freeze({ titleId: null, playFabId: null, configured: false });
    }
    if (typeof titleId !== "string" || titleId !== DIAMONDS_CANARY_SANDBOX_TITLE_ID ||
        titleId === DIAMONDS_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID) {
        throw coded("DIAMONDS_CANARY_SANDBOX_TITLE_MISMATCH",
            "Diamonds Canary is restricted to the isolated PlayFab Sandbox Title 1D0C16.");
    }
    return Object.freeze({ titleId, playFabId, configured: true });
}

export function readConfiguredDiamondsCanaryPlayFabId(environment = process.env) {
    return readDiamondsCanaryIdentity(environment, { required: false }).playFabId;
}
