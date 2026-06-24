(function () {
    const config = window.SEABYSS_CONFIG || {};
    const defaultTimeoutMs = 10000;

    function joinUrl(baseUrl, path) {
        const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
        const cleanPath = String(path || "").replace(/^\/+/, "");
        return `${cleanBase}/${cleanPath}`;
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
            const response = await fetch(joinUrl(config.apiBaseUrl, path), {
                method: settings.method || "GET",
                credentials: "include",
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

    async function loadManifest() {
        const response = await fetch(config.manifestUrl, { cache: "no-store" });
        if (!response.ok) {
            throw new Error("Manifest unavailable.");
        }
        return response.json();
    }

    window.SeabyssApi = {
        request,
        loadManifest
    };
})();
