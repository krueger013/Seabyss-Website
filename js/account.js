(function () {
    document.addEventListener("DOMContentLoaded", async function () {
        const session = await window.SeabyssAuth.getSession();
        window.location.href = window.SeabyssAuth.isLoggedIn(session) ? "profile.html" : "login.html?v=2";
    });
})();
