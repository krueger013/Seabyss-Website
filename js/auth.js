(function () {
    let cachedSession = null;
    let sessionRequest = null;
    let loginRedirectPending = false;

    function isLoggedIn(session) {
        return Boolean(session && session.loggedIn);
    }

    async function getSession() {
        if (!sessionRequest) {
            sessionRequest = (async () => {
                try {
                    cachedSession = await window.SeabyssApi.request("/auth/session");
                    return cachedSession;
                } catch (error) {
                    cachedSession = { loggedIn: false };
                    return cachedSession;
                }
            })();
        }

        try {
            return await sessionRequest;
        } finally {
            sessionRequest = null;
        }
    }

    async function login(email, password) {
        const result = await window.SeabyssApi.request("/auth/login", {
            method: "POST",
            body: { email, password }
        });

        cachedSession = result;
        return result;
    }

    async function register(email, password, confirmPassword, displayName) {
        const result = await window.SeabyssApi.request("/register", {
            method: "POST",
            body: { email, password, confirmPassword, displayName }
        });

        cachedSession = result;
        return result;
    }

    async function logout() {
        await window.SeabyssApi.request("/auth/logout", { method: "POST" });
        cachedSession = { loggedIn: false };
        window.location.href = "index.html";
    }

    async function requireSession() {
        const session = cachedSession || await getSession();
        if (!isLoggedIn(session)) {
            if (!loginRedirectPending) {
                loginRedirectPending = true;
                const currentPage = window.location.pathname.split("/").pop() || "profile.html";
                const target = encodeURIComponent(currentPage === "login.html" ? "profile.html" : currentPage);
                window.location.href = `login.html?v=2&returnTo=${target}`;
            }
            return null;
        }
        return session;
    }

    function getSafeReturnTo() {
        const params = new URLSearchParams(window.location.search);
        const returnTo = params.get("returnTo") || "profile.html";
        if (!/^[a-z0-9_-]+\.html$/i.test(returnTo)) {
            return "profile.html";
        }
        return returnTo;
    }

    function attachLoginForm() {
        const form = document.getElementById("login-form");
        if (!form) {
            return;
        }

        const submit = document.getElementById("login-submit");
        const message = document.getElementById("login-message");
        const emailInput = document.getElementById("login-email");
        const passwordInput = document.getElementById("login-password");

        if (!submit || !message || !emailInput || !passwordInput) {
            return;
        }

        if (!window.SeabyssApi || !window.SeabyssApi.isConfigured()) {
            submit.disabled = true;
            message.textContent = "Configuration de connexion indisponible.";
            message.className = "form-message is-error";
            return;
        }

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const email = String(emailInput.value || "").trim();
            const password = String(passwordInput.value || "");

            if (!email || !password) {
                message.textContent = "Entrez votre email et votre mot de passe.";
                message.className = "form-message is-error";
                return;
            }

            submit.disabled = true;
            submit.textContent = "Connexion...";
            message.textContent = "";
            message.className = "form-message";

            try {
                await login(email, password);
                window.location.href = getSafeReturnTo();
            } catch (error) {
                message.textContent = "Email ou mot de passe invalide.";
                message.className = "form-message is-error";
            } finally {
                submit.disabled = false;
                submit.textContent = "Se connecter";
                passwordInput.value = "";
            }
        });
    }

    function attachRegisterForm() {
        const form = document.getElementById("register-form");
        if (!form) {
            return;
        }

        const submit = document.getElementById("register-submit");
        const message = document.getElementById("register-message");
        const emailInput = document.getElementById("register-email");
        const displayNameInput = document.getElementById("register-display-name");
        const passwordInput = document.getElementById("register-password");
        const confirmPasswordInput = document.getElementById("register-confirm-password");

        if (!submit || !message || !emailInput || !displayNameInput || !passwordInput || !confirmPasswordInput) {
            return;
        }

        if (!window.SeabyssApi || !window.SeabyssApi.isConfigured()) {
            submit.disabled = true;
            message.textContent = "Configuration de creation de compte indisponible.";
            message.className = "form-message is-error";
            return;
        }

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const email = String(emailInput.value || "").trim();
            const displayName = String(displayNameInput.value || "").trim();
            const password = String(passwordInput.value || "");
            const confirmPassword = String(confirmPasswordInput.value || "");

            if (!email || !password || !confirmPassword) {
                message.textContent = "Entrez votre email et votre mot de passe.";
                message.className = "form-message is-error";
                return;
            }

            if (password !== confirmPassword) {
                message.textContent = "Les mots de passe ne correspondent pas.";
                message.className = "form-message is-error";
                return;
            }

            submit.disabled = true;
            submit.textContent = "Creation...";
            message.textContent = "";
            message.className = "form-message";

            try {
                await register(email, password, confirmPassword, displayName);
                message.textContent = "Compte cree. Redirection vers votre profil...";
                message.className = "form-message is-success";
                window.location.href = "profile.html";
            } catch (error) {
                message.textContent = error.message || "Creation de compte impossible pour le moment.";
                message.className = "form-message is-error";
            } finally {
                submit.disabled = false;
                submit.textContent = "Creer mon compte";
                passwordInput.value = "";
                confirmPasswordInput.value = "";
            }
        });
    }

    document.addEventListener("DOMContentLoaded", () => {
        attachLoginForm();
        attachRegisterForm();
    });

    window.SeabyssAuth = {
        getSession,
        requireSession,
        login,
        register,
        logout,
        isLoggedIn
    };
})();
