(function () {
    const config = window.SEABYSS_CONFIG;
    const defaultTimeoutMs = 10000;
    const expectedApiOrigin = "https://api.seabyss.com";
    let apiBaseUrl = null;

    try {
        const candidate = new URL(config && config.apiBaseUrl);
        if (
            candidate.origin !== expectedApiOrigin ||
            candidate.pathname !== "/" ||
            candidate.search ||
            candidate.hash ||
            candidate.username ||
            candidate.password
        ) {
            throw new Error("Unexpected API origin.");
        }
        apiBaseUrl = candidate.origin;
    } catch (error) {
        apiBaseUrl = null;
    }

    function isConfigured() {
        return apiBaseUrl !== null;
    }

    function resolveApiUrl(path) {
        if (!isConfigured()) {
            throw new Error("API configuration unavailable.");
        }

        if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
            throw new Error("Invalid API path.");
        }

        const url = new URL(path, `${apiBaseUrl}/`);
        if (url.origin !== apiBaseUrl) {
            throw new Error("Invalid API origin.");
        }
        return url.href;
    }

    async function request(path, options) {
        const settings = options || {};
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), settings.timeoutMs || defaultTimeoutMs);

        const headers = new Headers(settings.headers || {});
        if (settings.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }

        try {
            const response = await fetch(resolveApiUrl(path), {
                method: settings.method || "GET",
                credentials: "include",
                cache: "no-store",
                redirect: "error",
                referrerPolicy: "no-referrer",
                headers,
                body: settings.body ? JSON.stringify(settings.body) : undefined,
                signal: controller.signal
            });

            const contentType = response.headers.get("Content-Type") || "";
            const payload = contentType.includes("application/json") ? await response.json() : {};

            if (!response.ok) {
                const message = payload && payload.message ? payload.message : "Request failed. Please try again.";
                const error = new Error(message);
                error.status = response.status;
                throw error;
            }

            return payload;
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error("Request timed out. Please try again.");
            }
            throw error;
        } finally {
            window.clearTimeout(timeout);
        }
    }

    function resolveManifestUrl() {
        if (!config || typeof config.manifestUrl !== "string") {
            throw new Error("Manifest configuration unavailable.");
        }

        const url = new URL(config.manifestUrl, window.location.href);
        if (
            url.origin !== window.location.origin ||
            url.pathname !== "/launcher/seabyss_manifest.json" ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
        ) {
            throw new Error("Invalid manifest URL.");
        }
        return url.href;
    }

    function validateManifest(manifest) {
        if (
            !manifest ||
            typeof manifest !== "object" ||
            Array.isArray(manifest) ||
            typeof manifest.gameVersion !== "string" ||
            typeof manifest.downloadUrl !== "string" ||
            typeof manifest.notes !== "string" ||
            !/^[a-f0-9]{64}$/i.test(manifest.sha256 || "") ||
            !Number.isSafeInteger(manifest.size) ||
            manifest.size <= 0
        ) {
            throw new Error("Invalid manifest.");
        }
        return manifest;
    }

    async function loadManifest() {
        const response = await fetch(resolveManifestUrl(), {
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            referrerPolicy: "no-referrer"
        });
        if (!response.ok) {
            throw new Error("Manifest unavailable.");
        }
        return validateManifest(await response.json());
    }

    window.SeabyssApi = Object.freeze({
        request,
        loadManifest,
        isConfigured
    });
})();
