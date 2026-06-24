(function () {
    const config = window.SEABYSS_CONFIG || {};

    function setAuthVisibility(session) {
        const loggedIn = window.SeabyssAuth && window.SeabyssAuth.isLoggedIn(session);
        document.querySelectorAll("[data-auth-show]").forEach((element) => {
            const mode = element.getAttribute("data-auth-show");
            const shouldShow = mode === "connected" ? loggedIn : !loggedIn;
            element.hidden = !shouldShow;
        });
    }

    function attachNavToggle() {
        const toggle = document.querySelector(".nav-toggle");
        const nav = document.getElementById("main-nav");
        if (!toggle || !nav) {
            return;
        }

        toggle.addEventListener("click", () => {
            const expanded = toggle.getAttribute("aria-expanded") === "true";
            toggle.setAttribute("aria-expanded", String(!expanded));
            nav.classList.toggle("is-open", !expanded);
        });
    }

    function attachLogoutButtons() {
        document.querySelectorAll("[data-logout]").forEach((button) => {
            button.addEventListener("click", () => {
                if (window.SeabyssAuth) {
                    window.SeabyssAuth.logout();
                }
            });
        });
    }

    async function loadSessionState() {
        if (!window.SeabyssAuth) {
            return;
        }

        const session = await window.SeabyssAuth.getSession();
        setAuthVisibility(session);

        if (document.body.dataset.requiresAuth === "true" && !window.SeabyssAuth.isLoggedIn(session)) {
            window.SeabyssAuth.requireSession();
        }
    }

    async function loadManifestState() {
        if (!window.SeabyssApi || !window.SeabyssApi.loadManifest) {
            return;
        }

        try {
            const manifest = await window.SeabyssApi.loadManifest();
            document.querySelectorAll("[data-manifest-version]").forEach((element) => {
                element.textContent = manifest.gameVersion || "Unknown";
            });
            document.querySelectorAll("[data-manifest-notes]").forEach((element) => {
                element.textContent = manifest.notes || "No patch notes available.";
            });
            document.querySelectorAll("[data-patch-title]").forEach((element) => {
                element.textContent = manifest.gameVersion ? `Current Beta ${manifest.gameVersion}` : "Current Beta";
            });
            document.querySelectorAll("[data-manifest-download]").forEach((element) => {
                if (manifest.downloadUrl) {
                    element.setAttribute("href", manifest.downloadUrl);
                }
            });
        } catch (error) {
            document.querySelectorAll("[data-manifest-version]").forEach((element) => {
                element.textContent = "Manifest unavailable";
            });
        }
    }

    function setEnvironmentText() {
        document.querySelectorAll("[data-site-environment]").forEach((element) => {
            element.textContent = config.environment === "live" ? "Official / Live" : "Beta";
        });
    }

    document.addEventListener("DOMContentLoaded", () => {
        attachNavToggle();
        attachLogoutButtons();
        setEnvironmentText();
        setAuthVisibility({ loggedIn: false });
        loadSessionState();
        loadManifestState();
    });
})();
