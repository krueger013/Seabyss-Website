(function () {
    const missing = "Not available yet";
    const statLabels = {
        playerKills: "Player kills",
        npcKills: "NPC kills",
        boardingCount: "Boardings",
        combatPoints: "Combat points"
    };

    function isMissing(value) {
        return value === null || value === undefined || value === "";
    }

    function formatNumber(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return null;
        }

        return new Intl.NumberFormat("en-US").format(value);
    }

    function getValue(profile, key) {
        const value = profile && profile[key];
        if (isMissing(value)) {
            return missing;
        }
        if (Array.isArray(value)) {
            return value.length ? value.join(", ") : missing;
        }
        const formattedNumber = formatNumber(value);
        if (formattedNumber !== null) {
            return formattedNumber;
        }
        return String(value);
    }

    function setField(key, value) {
        document.querySelectorAll(`[data-profile-field="${key}"]`).forEach((element) => {
            element.textContent = isMissing(value) ? missing : String(value);
        });
    }

    function renderStats(stats) {
        const container = document.getElementById("profile-stats");
        if (!container) {
            return;
        }

        const entries = stats && typeof stats === "object" ? Object.entries(stats) : [];
        if (!entries.length) {
            container.innerHTML = "<div><span>Important stats</span><strong>Not available yet</strong></div>";
            return;
        }

        container.innerHTML = "";
        entries.forEach(([label, value]) => {
            const row = document.createElement("div");
            const name = document.createElement("span");
            const statValue = document.createElement("strong");
            name.textContent = statLabels[label] || label;
            statValue.textContent = isMissing(value) ? missing : (formatNumber(value) || String(value));
            row.append(name, statValue);
            container.appendChild(row);
        });
    }

    function renderProfile(profile) {
        setField("displayName", getValue(profile, "displayName"));
        setField("environment", getValue(profile, "environment"));
        setField("email", getValue(profile, "email"));
        setField("playFabId", getValue(profile, "playFabId"));
        setField("createdAt", getValue(profile, "createdAt"));
        setField("lastLoginAt", getValue(profile, "lastLoginAt"));
        setField("level", getValue(profile, "level"));
        setField("xp", getValue(profile, "xp"));
        setField("gold", getValue(profile, "gold"));
        setField("diamonds", getValue(profile, "diamonds"));
        setField("sirenTears", getValue(profile, "sirenTears"));
        setField("combatGrade", getValue(profile, "combatGrade"));
        setField("elitePoints", getValue(profile, "elitePoints"));
        setField("equippedShip", getValue(profile, "equippedShip"));
        setField("equippedCannons", getValue(profile, "equippedCannons"));
        renderStats(profile && profile.stats);
    }

    async function loadProfile() {
        const message = document.getElementById("profile-message");
        if (message) {
            message.textContent = "Loading profile...";
            message.className = "form-message";
        }

        try {
            await window.SeabyssAuth.requireSession();
            const profile = await window.SeabyssApi.request("/me");
            renderProfile(profile);
            if (message) {
                message.textContent = "Profile loaded.";
                message.className = "form-message is-success";
            }
        } catch (error) {
            if (message) {
                message.textContent = "Profile unavailable. Please login again or try later.";
                message.className = "form-message is-error";
            }
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        const refresh = document.getElementById("refresh-profile");
        if (refresh) {
            refresh.addEventListener("click", loadProfile);
        }
        loadProfile();
    });
})();
