const realFetch = globalThis.fetch;
const mockBaseUrl = process.env.PLAYFAB_MOCK_BASE_URL;

const isTestEnvironment = process.env.NODE_ENV === "test";
const isProductionCookieTest = process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRODUCTION_COOKIE_TEST === "1";

if (!isTestEnvironment && !isProductionCookieTest) {
    throw new Error("The PlayFab fetch mock may only run in an explicit local test mode.");
}

if (!mockBaseUrl) {
    throw new Error("PLAYFAB_MOCK_BASE_URL is required by the PlayFab fetch mock.");
}

const parsedMockBaseUrl = new URL(mockBaseUrl);
if (parsedMockBaseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsedMockBaseUrl.hostname)) {
    throw new Error("PLAYFAB_MOCK_BASE_URL must use HTTP on a loopback host.");
}

globalThis.fetch = function fetchWithLocalPlayFabMock(input, init) {
    const originalUrl = new URL(input instanceof Request ? input.url : String(input));
    if (originalUrl.hostname.endsWith(".playfabapi.com")) {
        const localUrl = new URL(`${originalUrl.pathname}${originalUrl.search}`, parsedMockBaseUrl);
        return realFetch(localUrl, init);
    }

    return realFetch(input, init);
};
