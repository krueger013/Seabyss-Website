(function () {
    let cachedSession = null;

    function isLoggedIn(session) {
        return Boolean(session && session.loggedIn);
    }

    async function getSession() {
        try {
            cachedSession = await window.SeabyssApi.request("/auth/session");
            return cachedSession;
        } catch (error) {
            cachedSession = { loggedIn: false };
            return cachedSession;
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

    async function logout() {
        try {
            await window.SeabyssApi.request("/auth/logout", { method: "POST" });
        } finally {
            cachedSession = { loggedIn: false };
            window.location.href = "index.html";
        }
    }

    async function requireSession() {
        const session = cachedSession || await getSession();
        if (!isLoggedIn(session)) {
            const currentPage = window.location.pathname.split("/").pop() || "profile.html";
            const target = encodeURIComponent(currentPage === "login.html" ? "profile.html" : currentPage);
            window.location.href = `login.html?returnTo=${target}`;
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

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const email = String(form.email.value || "").trim();
            const password = String(form.password.value || "");

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
                form.password.value = "";
            }
        });
    }

    document.addEventListener("DOMContentLoaded", attachLoginForm);

    window.SeabyssAuth = {
        getSession,
        requireSession,
        login,
        logout,
        isLoggedIn
    };
})();
