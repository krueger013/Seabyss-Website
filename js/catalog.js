(() => {
  "use strict";

  const scriptUrl = document.currentScript?.src || new URL("js/catalog.js", document.baseURI).href;
  const dataUrl = new URL("../data/games.json", scriptUrl);
  const genres = {
    action: "Action",
    adventure: "Aventure",
    arcade: "Arcade",
    puzzle: "Réflexion",
    strategy: "Stratégie",
    simulation: "Simulation",
    casino: "Casino fictif",
  };
  const storageKey = "seabyss.favoriteGames.v1";
  const $ = (id) => document.getElementById(id);
  const grid = $("game-grid");
  if (!grid) return;

  const search = $("search-games");
  const sort = $("sort-games");
  const dialog = $("game-dialog");
  const frame = $("game-frame");
  const startButton = $("start-game");
  const fullscreenButton = $("fullscreen-game");
  const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
  const state = { games: [], category: "all", view: "all", query: "", sort: sort?.value || "featured", failed: false };
  let activeGame = null;
  let previousFocus = null;
  let favoriteIds;

  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
    favoriteIds = new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
  } catch {
    favoriteIds = new Set();
  }

  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const raw = value.trim();
    try {
      const parsed = new URL(raw, document.baseURI);
      if (parsed.username || parsed.password) return null;
      if (/^https:\/\//i.test(raw)) return parsed.protocol === "https:" ? parsed.href : null;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return null;
      return parsed.origin === location.origin && ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function normalizeGames(payload) {
    if (!Array.isArray(payload)) throw new Error("Le catalogue doit contenir une liste de jeux.");
    const ids = new Set();
    return payload.flatMap((item) => {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.title !== "string") return [];
      const id = item.id.trim();
      const title = item.title.trim();
      const url = safeUrl(item.url);
      if (!id || !title || !url || ids.has(id)) return [];
      ids.add(id);
      const timestamp = typeof item.releaseDate === "string" ? Date.parse(item.releaseDate) : NaN;
      return [{
        id,
        title,
        url,
        description: typeof item.description === "string" ? item.description.trim() : "",
        genre: Object.hasOwn(genres, item.genre) ? item.genre : "arcade",
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [],
        thumbnail: safeUrl(item.thumbnail),
        controls: Array.isArray(item.controls) ? item.controls.filter((control) => typeof control === "string").join(" · ") : typeof item.controls === "string" ? item.controls.trim() : "",
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        featured: item.featured === true,
        embed: item.embed !== false,
      }];
    });
  }

  const normalizedText = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
  const makeElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  function setStatus(message) {
    const status = $("catalog-status");
    if (status) {
      status.textContent = message;
      status.hidden = !message;
    }
  }

  function cardFor(game) {
    const card = makeElement("article", "game-card");
    const art = makeElement("button", "game-art");
    art.type = "button";
    art.dataset.play = game.id;
    art.setAttribute("aria-label", `Découvrir ${game.title}`);
    if (game.thumbnail) {
      const image = makeElement("img", "game-thumbnail");
      image.src = game.thumbnail;
      image.alt = game.title;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => {
        image.remove();
        art.append(makeElement("span", "game-monogram", game.title.slice(0, 2).toLocaleUpperCase("fr")));
      }, { once: true });
      art.append(image);
    } else {
      art.append(makeElement("span", "game-monogram", game.title.slice(0, 2).toLocaleUpperCase("fr")));
    }
    const info = makeElement("div", "game-info");
    const tag = makeElement("span", "game-tag", genres[game.genre]);
    const title = makeElement("h3", "game-title", game.title);
    const description = makeElement("p", "game-description", game.description);
    const actions = makeElement("div", "game-actions");
    const play = makeElement("button", "game-play", "Jouer →");
    play.type = "button";
    play.dataset.play = game.id;
    play.setAttribute("aria-label", `Jouer à ${game.title}`);
    const favorite = makeElement("button", "favorite-button", favoriteIds.has(game.id) ? "★" : "☆");
    favorite.type = "button";
    favorite.dataset.favorite = game.id;
    favorite.setAttribute("aria-pressed", String(favoriteIds.has(game.id)));
    favorite.setAttribute("aria-label", `${favoriteIds.has(game.id) ? "Retirer" : "Ajouter"} ${game.title} ${favoriteIds.has(game.id) ? "des" : "aux"} favoris`);
    actions.append(play, favorite);
    info.append(tag, title, description, actions);
    card.append(art, info);
    return card;
  }

  function updateControls() {
    document.querySelectorAll("[data-view]").forEach((button) => {
      const selected = button.dataset.view === state.view;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("category-filters")?.querySelectorAll("[data-category]").forEach((button) => {
      const selected = button.dataset.category === state.category;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll("[data-game-count]").forEach((element) => { element.textContent = String(state.games.length); });
    const favoriteCount = state.games.filter((game) => favoriteIds.has(game.id)).length;
    document.querySelectorAll("[data-bookmark-count]").forEach((element) => { element.textContent = String(favoriteCount); });
  }

  function render() {
    const query = normalizedText(state.query.trim());
    const visible = state.games.filter((game) =>
      (state.category === "all" || game.genre === state.category)
      && (state.view !== "favorites" || favoriteIds.has(game.id))
      && (!query || normalizedText([game.title, game.description, ...game.tags].join(" ")).includes(query))
    );
    const sortMode = state.view === "recent" ? "newest" : state.sort;
    visible.sort((a, b) => sortMode === "title"
      ? collator.compare(a.title, b.title)
      : (sortMode === "featured" ? Number(b.featured) - Number(a.featured) : 0) || b.timestamp - a.timestamp || collator.compare(a.title, b.title));
    grid.replaceChildren(...visible.map(cardFor));
    grid.hidden = visible.length === 0;
    if ($("results-count")) $("results-count").textContent = `${visible.length} jeu${visible.length === 1 ? "" : "x"}`;
    const empty = $("empty-state");
    if (empty) empty.hidden = visible.length > 0;
    if ($("reset-filters")) $("reset-filters").hidden = state.games.length === 0;
    if (visible.length === 0) {
      const emptyTitle = $("empty-title");
      const emptyCopy = $("empty-copy");
      if (state.failed) {
        if (emptyTitle) emptyTitle.textContent = "Le catalogue fait une pause.";
        if (emptyCopy) emptyCopy.textContent = "Impossible de charger les jeux pour le moment. Recharge la page pour réessayer.";
      } else if (state.games.length === 0) {
        if (emptyTitle) emptyTitle.textContent = "La prochaine partie se prépare.";
        if (emptyCopy) emptyCopy.textContent = "Les jeux du studio arriveront ici. Reviens découvrir les premières sorties Seabyss.";
      } else if (state.view === "favorites" && !state.query.trim() && state.category === "all") {
        if (emptyTitle) emptyTitle.textContent = "Ta sélection commence ici.";
        if (emptyCopy) emptyCopy.textContent = "Ajoute un jeu à tes favoris avec l’étoile pour le retrouver ici.";
      } else {
        if (emptyTitle) emptyTitle.textContent = "Aucun jeu dans cette sélection.";
        if (emptyCopy) emptyCopy.textContent = "Essaie une autre recherche ou explore toutes les catégories.";
      }
    }
    updateControls();
  }

  function resetFilters() {
    state.category = "all";
    state.view = "all";
    state.query = "";
    state.sort = "featured";
    if (search) search.value = "";
    if (sort) sort.value = "featured";
    render();
  }

  function stopFrame() {
    frame?.removeAttribute("src");
    if (frame) frame.hidden = true;
    if (fullscreenButton) fullscreenButton.hidden = true;
    if ($("player-stage")) $("player-stage").classList.remove("is-playing");
  }

  function openPlayer(game) {
    if (!dialog || typeof dialog.showModal !== "function") {
      window.open(game.url, "_blank", "noopener,noreferrer");
      return;
    }
    stopFrame();
    activeGame = game;
    previousFocus = document.activeElement;
    if ($("player-title")) $("player-title").textContent = game.title;
    if ($("player-description")) $("player-description").textContent = game.description;
    if ($("player-controls")) $("player-controls").textContent = game.controls || "Les commandes sont indiquées dans le jeu.";
    if ($("player-note")) $("player-note").textContent = game.embed
      ? "Si le jeu ne s’affiche pas, utilise le lien pour l’ouvrir dans un nouvel onglet."
      : "Ce jeu s’ouvre dans un nouvel onglet.";
    if ($("open-game")) {
      $("open-game").href = game.url;
      $("open-game").target = "_blank";
      $("open-game").rel = "noopener noreferrer";
    }
    if (startButton) {
      startButton.hidden = !game.embed;
      startButton.disabled = false;
    }
    if (frame) {
      frame.title = `Jouer à ${game.title}`;
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-pointer-lock allow-forms");
      frame.setAttribute("allow", "fullscreen; gamepad");
      frame.setAttribute("allowfullscreen", "");
      frame.referrerPolicy = "no-referrer";
    }
    document.body.classList.add("player-open");
    dialog.showModal();
    dialog.scrollTop = 0;
  }

  search?.addEventListener("input", () => {
    state.query = search.value;
    render();
  });
  sort?.addEventListener("change", () => {
    state.sort = sort.value;
    if (state.view === "recent" && sort.value !== "newest") state.view = "all";
    render();
  });
  $("category-filters")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-category]");
    if (!button) return;
    const category = button.dataset.category;
    if (category !== "all" && !Object.hasOwn(genres, category)) return;
    state.category = category;
    render();
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!["all", "recent", "favorites"].includes(button.dataset.view)) return;
      state.view = button.dataset.view;
      if (state.view === "recent" && sort) sort.value = "newest";
      else if (sort) sort.value = state.sort;
      render();
    });
  });
  $("reset-filters")?.addEventListener("click", resetFilters);
  grid.addEventListener("click", (event) => {
    const play = event.target.closest("button[data-play]");
    if (play) {
      const game = state.games.find((item) => item.id === play.dataset.play);
      if (game) openPlayer(game);
      return;
    }
    const favorite = event.target.closest("button[data-favorite]");
    if (!favorite) return;
    const id = favorite.dataset.favorite;
    if (!state.games.some((game) => game.id === id)) return;
    if (favoriteIds.has(id)) favoriteIds.delete(id);
    else favoriteIds.add(id);
    try { localStorage.setItem(storageKey, JSON.stringify([...favoriteIds])); } catch { /* Favorites still work for this visit. */ }
    render();
    const replacement = [...grid.querySelectorAll("[data-favorite]")].find((button) => button.dataset.favorite === id);
    if (replacement) replacement.focus();
    else $("reset-filters")?.focus();
  });
  startButton?.addEventListener("click", () => {
    if (!activeGame || !activeGame.embed || !frame) return;
    frame.src = activeGame.url;
    frame.hidden = false;
    startButton.hidden = true;
    $("player-stage")?.classList.add("is-playing");
    if (fullscreenButton) fullscreenButton.hidden = !$("player-stage")?.requestFullscreen;
    frame.focus({ preventScroll: true });
  });
  $("close-player")?.addEventListener("click", () => dialog?.close());
  dialog?.addEventListener("close", () => {
    stopFrame();
    document.body.classList.remove("player-open");
    activeGame = null;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  });
  dialog?.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  fullscreenButton?.addEventListener("click", async () => {
    const stage = $("player-stage");
    if (!stage?.requestFullscreen) return;
    try {
      await stage.requestFullscreen();
    } catch {
      if ($("player-note")) $("player-note").textContent = "Le plein écran n’est pas disponible. Tu peux ouvrir le jeu dans un nouvel onglet.";
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey) return;
    try {
      const stored = JSON.parse(event.newValue || "[]");
      favoriteIds = new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
      render();
    } catch { /* Ignore malformed data from another tab. */ }
  });

  grid.setAttribute("aria-busy", "true");
  setStatus("Chargement du catalogue…");
  fetch(dataUrl, { headers: { Accept: "application/json" }, cache: "no-cache" })
    .then((response) => {
      if (!response.ok) throw new Error("Catalogue indisponible.");
      return response.json();
    })
    .then((payload) => {
      state.games = normalizeGames(payload);
      setStatus("");
    })
    .catch(() => {
      state.failed = true;
      setStatus("Le catalogue est temporairement indisponible.");
    })
    .finally(() => {
      grid.setAttribute("aria-busy", "false");
      render();
    });
})();
