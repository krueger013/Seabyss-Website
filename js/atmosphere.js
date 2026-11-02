(() => {
  "use strict";

  function initializeAtmosphere() {
    const body = document.body;
    if (!body) return;

    const toggle = document.getElementById("motion-toggle");
    const label = toggle?.querySelector("[data-motion-label]");
    const hero = document.querySelector(".hero");
    const gameDialog = document.getElementById("game-dialog");
    const storageKey = "seabyss.motion.v1";
    const reducedMotion = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    let enabled = true;
    let heroVisible = true;

    try {
      enabled = localStorage.getItem(storageKey) !== "off";
    } catch {
      // The setting remains available for this visit when storage is blocked.
    }

    function updateAtmosphere() {
      const reduced = reducedMotion?.matches === true;
      const active = enabled && !reduced;
      const gameOpen = gameDialog?.hasAttribute("open") === true;
      body.classList.toggle("motion-paused", !active);
      body.classList.toggle("motion-idle", document.hidden || !heroVisible || gameOpen);

      if (!toggle) return;
      toggle.setAttribute("aria-pressed", String(active));
      toggle.disabled = reduced;
      toggle.setAttribute("aria-label", reduced
        ? "Ambiance figée selon les préférences de mouvement de ton appareil"
        : active ? "Désactiver l’ambiance animée" : "Activer l’ambiance animée");
      if (reduced) toggle.title = "Les animations respectent la réduction des mouvements de ton appareil.";
      else toggle.removeAttribute("title");
      if (label) label.textContent = active ? "Ambiance animée" : "Ambiance figée";
    }

    toggle?.addEventListener("click", () => {
      if (reducedMotion?.matches) return;
      enabled = !enabled;
      try {
        localStorage.setItem(storageKey, enabled ? "on" : "off");
      } catch {
        // A blocked preference store does not prevent the toggle from working.
      }
      updateAtmosphere();
    });

    document.addEventListener("visibilitychange", updateAtmosphere);
    if (typeof reducedMotion?.addEventListener === "function") {
      reducedMotion.addEventListener("change", updateAtmosphere);
    } else if (typeof reducedMotion?.addListener === "function") {
      reducedMotion.addListener(updateAtmosphere);
    }

    if (hero && typeof window.IntersectionObserver === "function") {
      const heroObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === hero) heroVisible = entry.isIntersecting;
        }
        updateAtmosphere();
      }, { threshold: 0 });
      heroObserver.observe(hero);
    }

    if (gameDialog && typeof window.MutationObserver === "function") {
      const dialogObserver = new MutationObserver(updateAtmosphere);
      dialogObserver.observe(gameDialog, { attributes: true, attributeFilter: ["open"] });
    }

    updateAtmosphere();
    if (toggle) toggle.hidden = false;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAtmosphere, { once: true });
  } else {
    initializeAtmosphere();
  }
})();
