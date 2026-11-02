/* Les Heures Perdues — self-contained investigation mini-games. */
(() => {
  'use strict';

  const catalog = Object.freeze([
    { id: 'seals', chapter: 0, unlockAt: 4, title: 'La mémoire des sceaux', subtitle: 'Les doubles empreintes du cabinet', rewardText: 'Clairvoyance et fragment de témoignage' },
    { id: 'channels', chapter: 1, unlockAt: 4, title: 'Les canaux de rosée', subtitle: 'Rétablissez le circuit de l’alambic', rewardText: 'Clairvoyance et fragment de témoignage' },
    { id: 'chart', chapter: 2, unlockAt: 4, title: 'Les fragments de la tour', subtitle: 'Reconstituez une gravure de l’observatoire', rewardText: 'Clairvoyance et fragment de témoignage' },
    { id: 'cipher', chapter: null, unlockAt: 0, title: 'Le dernier sceau', subtitle: 'Le secret laissé entre les lignes', rewardText: 'Le secret d’Aurèle et une distinction' }
  ].map(Object.freeze));

  const symbolData = Object.freeze([
    { id: 'moon', name: 'Lune', path: '<path d="M19.6 14A8 8 0 0 1 10 4.4 8 8 0 1 0 19.6 14Z"/>' },
    { id: 'leaf', name: 'Feuille', path: '<path d="M5 19C-1 7 11 3 20 4c1 11-5 19-15 15Z"/><path d="m4 21 12-12M9 16l-1-5m4 2 5 1"/>' },
    { id: 'star', name: 'Étoile', path: '<path d="m12 2 2.7 6.6 7.1.6-5.4 4.6 1.7 7-6.1-3.7-6.1 3.7 1.7-7L2.2 9.2l7.1-.6Z"/>' },
    { id: 'sun', name: 'Soleil', path: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' },
    { id: 'key', name: 'Clef', path: '<circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9m-4-4 3-3m-1 5 3-3"/>' },
    { id: 'hourglass', name: 'Sablier', path: '<path d="M5 2h14M5 22h14M7 2v5l5 5-5 5v5m10-20v5l-5 5 5 5v5M8 5h8M8 19h8"/>' }
  ]);
  const symbolsById = Object.fromEntries(symbolData.map(s => [s.id, s]));
  const cipherSolution = ['moon', 'leaf', 'star', 'sun'];
  // Directions: north, east, south, west. The intended circuit is 3→0→1→2→5.
  const pipeTypes = [[0, 1], [0, 2], [0, 1], [0, 1], [0, 2], [0, 1], [0, 1], [0, 2], [0, 1]];
  let active = null;

  function seal(id) {
    const symbol = symbolsById[id];
    return `<svg class="mini-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${symbol.path}</svg>`;
  }
  function shuffled(items) {
    const list = items.slice();
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  const validIndex = (x, size) => Number.isInteger(x) && x >= 0 && x < size;
  const movesOf = raw => Number.isInteger(raw?.moves) ? Math.min(1000000, Math.max(0, raw.moves)) : 0;
  const unique = values => new Set(values).size === values.length;

  function connectors(index, rotation) { return pipeTypes[index].map(d => (d + rotation) % 4); }
  function connectedTiles(rotations) {
    if (!connectors(3, rotations[3]).includes(3)) return [];
    const visited = new Set([3]), queue = [3];
    while (queue.length) {
      const tile = queue.shift();
      for (const direction of connectors(tile, rotations[tile])) {
        const row = Math.floor(tile / 3), column = tile % 3;
        const nextRow = row + [-1, 0, 1, 0][direction];
        const nextColumn = column + [0, 1, 0, -1][direction];
        if (nextRow < 0 || nextRow > 2 || nextColumn < 0 || nextColumn > 2) continue;
        const next = nextRow * 3 + nextColumn;
        if (!visited.has(next) && connectors(next, rotations[next]).includes((direction + 2) % 4)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return [...visited];
  }
  function channelsSolved(rotations) {
    return connectedTiles(rotations).includes(5) && connectors(5, rotations[5]).includes(1);
  }

  function newProgress(id) {
    const common = { moves: 0, assisted: false };
    if (id === 'seals') return { ...common, deck: shuffled([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]), matched: [], open: [] };
    if (id === 'channels') {
      let rotations;
      do { rotations = Array.from({ length: 9 }, () => Math.floor(Math.random() * 4)); } while (channelsSolved(rotations));
      return { ...common, rotations };
    }
    if (id === 'chart') {
      let tiles;
      do { tiles = shuffled([0, 1, 2, 3, 4, 5, 6, 7, 8]); } while (tiles.filter((tile, i) => tile !== i).length < 6);
      return { ...common, tiles, selected: null, showGuides: false };
    }
    return { ...common, input: [], verified: false };
  }

  function validateProgress(id, raw) {
    if (!catalog.some(game => game.id === id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const common = { moves: movesOf(raw), assisted: raw.assisted === true };
    if (id === 'seals') {
      if (!Array.isArray(raw.deck) || raw.deck.length !== 12 || !raw.deck.every(x => validIndex(x, 6))) return null;
      if (![0, 1, 2, 3, 4, 5].every(x => raw.deck.filter(v => v === x).length === 2)) return null;
      if (!Array.isArray(raw.matched) || !raw.matched.every(x => validIndex(x, 12)) || !unique(raw.matched)) return null;
      if (![0, 1, 2, 3, 4, 5].every(x => [0, 2].includes(raw.matched.filter(i => raw.deck[i] === x).length))) return null;
      const open = Array.isArray(raw.open) ? raw.open.filter(i => validIndex(i, 12) && !raw.matched.includes(i)) : [];
      // A mismatch was already counted before saving. On resume, those two cards are face down again.
      return { ...common, deck: raw.deck.slice(), matched: raw.matched.slice(), open: open.length === 1 ? open : [] };
    }
    if (id === 'channels') {
      if (!Array.isArray(raw.rotations) || raw.rotations.length !== 9 || !raw.rotations.every(x => validIndex(x, 4))) return null;
      return { ...common, rotations: raw.rotations.slice() };
    }
    if (id === 'chart') {
      if (!Array.isArray(raw.tiles) || raw.tiles.length !== 9 || !raw.tiles.every(x => validIndex(x, 9)) || !unique(raw.tiles)) return null;
      const showGuides = raw.showGuides === true;
      return { ...common, assisted: common.assisted || showGuides, tiles: raw.tiles.slice(), selected: validIndex(raw.selected, 9) ? raw.selected : null, showGuides };
    }
    if (!Array.isArray(raw.input) || raw.input.length > 4 || !raw.input.every(x => Object.hasOwn(symbolsById, x))) return null;
    return { ...common, input: raw.input.slice(), verified: raw.verified === true && raw.input.join(',') === cipherSolution.join(',') };
  }

  function dispose() {
    if (!active) return;
    active.alive = false;
    for (const timer of active.timers) clearTimeout(timer);
    active.container.removeEventListener('click', active.listener);
    active = null;
  }

  function mount(id, container, options = {}) {
    if (!catalog.some(game => game.id === id)) throw new Error('Mini-jeu inconnu.');
    if (!container || typeof container.addEventListener !== 'function') throw new Error('Zone de mini-jeu absente.');
    dispose();
    const ctx = {
      id, container, options, progress: validateProgress(id, options.saved) || newProgress(id),
      alive: true, notified: false, timers: new Set(), busy: false, preview: false,
      message: '', helpVisible: false, listener: null
    };
    active = ctx;
    const current = () => ctx.alive && active === ctx;
    const persist = () => { if (current()) options.onChange?.(clone(ctx.progress)); };
    const later = (callback, ms) => {
      const timer = setTimeout(() => { ctx.timers.delete(timer); if (current()) callback(); }, ms);
      ctx.timers.add(timer);
    };
    const isSolved = () => id === 'seals' ? ctx.progress.matched.length === 12
      : id === 'channels' ? channelsSolved(ctx.progress.rotations)
      : id === 'chart' ? ctx.progress.tiles.every((tile, i) => tile === i)
      : ctx.progress.verified;
    const finish = () => {
      if (!current() || ctx.notified || !isSolved()) return;
      ctx.notified = true;
      options.onWin?.({ moves: ctx.progress.moves, assisted: ctx.progress.assisted });
    };
    const button = (action, text, disabled = false, className = 'secondary') =>
      `<button type="button" class="${className}" data-mini-action="${action}" ${disabled ? 'disabled' : ''}>${text}</button>`;
    const tips = {
      seals: 'Retournez les cartes dans un ordre régulier. Retenez le symbole et la position de chaque sceau : chacun possède exactement un double.',
      channels: 'Un circuit possible remonte depuis l’arrivée à gauche, traverse toute la rangée supérieure, puis redescend vers la sortie à droite. Les deux extrémités de deux canaux voisins doivent se faire face.',
      chart: 'Les repères 1 à 9 indiquent la place de chaque fragment, de gauche à droite puis de haut en bas. Sélectionnez deux fragments pour échanger leurs positions.',
      cipher: 'La nuit évoque la Lune, la sauge la Feuille, le ciel l’Étoile et l’aube le Soleil. Respectez l’ordre du témoignage.'
    };
    const instructions = {
      seals: 'Retrouvez les six paires de sceaux. Retournez deux cartes à la fois ; une paire identique reste visible.',
      channels: 'Faites pivoter les neuf canaux pour relier l’arrivée, à gauche, à la sortie, à droite. Seul un chemin continu est nécessaire : les autres canaux peuvent rester inutilisés.',
      chart: 'Reconstituez la gravure de l’observatoire. Sélectionnez deux fragments pour les échanger. Vous pouvez consulter le modèle aussi souvent que nécessaire.',
      cipher: 'Aurèle a caché quatre signes dans son dernier témoignage. Choisissez les quatre sceaux dans le bon ordre, puis ouvrez le médaillon.'
    };

    function render() {
      if (!current()) return;
      const s = ctx.progress, solved = isSolved();
      let board = '', status = '';
      if (id === 'seals') {
        status = `${s.matched.length / 2} / 6 paires retrouvées · ${s.moves} tentative${s.moves > 1 ? 's' : ''}`;
        board = `<div class="memory-grid">${s.deck.map((symbolIndex, index) => {
          const symbol = symbolData[symbolIndex], matched = s.matched.includes(index), opened = matched || s.open.includes(index);
          return `<button type="button" class="memory-card${opened ? ' is-open' : ''}${matched ? ' is-matched' : ''}" data-card="${index}" aria-label="${opened ? symbol.name + (matched ? ', paire retrouvée' : '') : 'Carte ' + (index + 1)}" aria-pressed="${opened}" ${matched || ctx.busy || solved ? 'disabled' : ''}>${opened ? `<span class="seal-face">${seal(symbol.id)}<span class="symbol-name">${symbol.name}</span></span>` : `<span class="seal-back" aria-hidden="true">${options.icon?.('compass') || seal('star')}</span>`}</button>`;
        }).join('')}</div>`;
      } else if (id === 'channels') {
        const connected = connectedTiles(s.rotations);
        status = solved ? 'La rosée atteint enfin le réceptacle.' : `${s.moves} rotation${s.moves > 1 ? 's' : ''} · Les canaux alimentés deviennent lumineux`;
        board = `<div class="pipe-board"><span class="pipe-source">Arrivée de rosée →</span><div class="pipe-grid">${s.rotations.map((rotation, index) => {
          const ports = connectors(index, rotation), points = [[50, 0], [100, 50], [50, 100], [0, 50]];
          const path = ports.map(d => `M50 50 L${points[d][0]} ${points[d][1]}`).join(' ');
          const portNames = ports.map(d => ['haut', 'droite', 'bas', 'gauche'][d]).join(' et ');
          return `<button type="button" class="pipe-tile${connected.includes(index) ? ' connected' : ''}" data-pipe="${index}" aria-label="Canal ${index + 1}, ouvert vers ${portNames}. Tourner d’un quart de tour." ${solved ? 'disabled' : ''}><svg viewBox="0 0 100 100" fill="none" aria-hidden="true" focusable="false"><path class="pipe-shadow" d="${path}" stroke="#071612" stroke-width="23" stroke-linecap="round"/><path class="pipe-metal" d="${path}" stroke="currentColor" stroke-width="16" stroke-linecap="round"/><path class="pipe-inner" d="${path}" stroke="#dae5bc" stroke-opacity=".3" stroke-width="4" stroke-linecap="round"/><circle cx="50" cy="50" r="9" fill="currentColor"/><circle cx="50" cy="50" r="3" fill="#10231c"/></svg></button>`;
        }).join('')}</div><span class="pipe-sink">→ Réceptacle</span></div>`;
      } else if (id === 'chart') {
        const placed = s.tiles.filter((tile, index) => tile === index).length;
        status = `${placed} / 9 fragments à leur place · ${s.moves} échange${s.moves > 1 ? 's' : ''}`;
        board = `${ctx.preview ? '<img class="mosaic-reference" src="assets/observatory.jpg" alt="Gravure complète de l’observatoire à reconstituer">' : ''}<div class="mosaic-grid">${s.tiles.map((tile, index) => `<button type="button" class="mosaic-tile${s.selected === index ? ' selected' : ''}" data-tile="${index}" aria-label="${s.showGuides ? 'Fragment ' + (tile + 1) + ', ' : ''}position ${index + 1}${s.selected === index ? ', sélectionné' : ''}" aria-pressed="${s.selected === index}" style="background-image:url('assets/observatory.jpg');background-size:300% 300%;background-position:${(tile % 3) * 50}% ${Math.floor(tile / 3) * 50}%" ${solved ? 'disabled' : ''}><span class="tile-number" ${s.showGuides ? '' : 'hidden'}>${tile + 1}</span></button>`).join('')}</div><div class="mini-toolbar mini-toolbar-secondary">${button('preview', ctx.preview ? 'Masquer le modèle' : 'Voir le modèle', false, 'quiet')}${button('guides', s.showGuides ? 'Masquer les repères' : 'Repères numérotés · aide', solved, 'quiet')}</div>`;
      } else {
        status = `${s.input.length} / 4 sceaux choisis${s.moves ? ` · ${s.moves} essai${s.moves > 1 ? 's' : ''}` : ''}`;
        board = `<blockquote class="cipher-letter">« À la tombée de la nuit, je cueillis la sauge ; les étoiles me guidèrent jusqu’à l’aube. »<cite>— Le dernier témoignage d’Aurèle</cite></blockquote><div class="cipher-answer" aria-label="Sceaux sélectionnés">${[0, 1, 2, 3].map(i => `<span class="cipher-slot${s.input[i] ? ' filled' : ''}" aria-label="${s.input[i] ? symbolsById[s.input[i]].name : 'Emplacement ' + (i + 1) + ', vide'}">${s.input[i] ? seal(s.input[i]) : `<small>${i + 1}</small>`}</span>`).join('')}</div><div class="cipher-symbols">${symbolData.map(symbol => `<button type="button" class="cipher-symbol" data-symbol="${symbol.id}" ${s.input.length === 4 || solved ? 'disabled' : ''}>${seal(symbol.id)}<span>${symbol.name}</span></button>`).join('')}</div><div class="mini-toolbar mini-toolbar-secondary">${button('backspace', 'Retirer le dernier sceau', !s.input.length || solved, 'quiet')}${button('verify', 'Ouvrir le médaillon', s.input.length !== 4 || solved)}</div>`;
      }
      container.innerHTML = `<section class="mini-game" data-game="${id}"><p class="mini-instructions">${instructions[id]}</p><div class="mini-status" role="status" aria-live="polite">${ctx.message || status}</div>${board}${ctx.helpVisible ? `<p class="mini-help">${tips[id]} <span>Cette tentative sera notée « avec aide ».</span></p>` : ''}${solved ? '<div class="mini-success" role="status">Mystère élucidé. Votre découverte a été enregistrée.</div>' : ''}<div class="mini-toolbar">${button('exit', 'Retour aux mystères', false, 'quiet')}${button('help', 'Un conseil', solved, 'quiet')}${button('restart', 'Recommencer', solved, 'quiet')}</div></section>`;
    }

    function update(checkVictory = true) {
      persist();
      if (!current()) return;
      render();
      if (checkVictory) finish();
    }

    function selectCard(index) {
      const s = ctx.progress;
      if (ctx.busy || s.matched.includes(index) || s.open.includes(index)) return;
      s.open.push(index);
      ctx.message = '';
      if (s.open.length === 1) {
        update(false);
        if (current()) container.querySelector(`[data-card="${index}"]`)?.focus({ preventScroll: true });
        return;
      }
      s.moves++;
      const [first, second] = s.open;
      if (s.deck[first] === s.deck[second]) {
        s.matched.push(first, second);
        s.open = [];
        ctx.message = `La paire « ${symbolData[s.deck[first]].name} » est réunie.`;
        update();
        if (current() && !isSolved()) container.querySelector('[data-card]:not(:disabled)')?.focus({ preventScroll: true });
      } else {
        ctx.busy = true;
        ctx.message = 'Deux sceaux différents… Retenez leur position.';
        update(false);
        later(() => {
          s.open = []; ctx.busy = false; ctx.message = ''; update(false);
          if (current()) container.querySelector(`[data-card="${second}"]`)?.focus({ preventScroll: true });
        }, 650);
      }
    }

    ctx.listener = event => {
      const target = event.target.closest('button');
      if (!target || !container.contains(target) || target.disabled || !current()) return;
      event.stopPropagation();
      const s = ctx.progress, action = target.dataset.miniAction;
      if (action === 'exit') { dispose(); options.onExit?.(); return; }
      if (isSolved()) return;
      if (action === 'restart') {
        for (const timer of ctx.timers) clearTimeout(timer);
        ctx.timers.clear();
        ctx.progress = { ...newProgress(id), assisted: s.assisted };
        if (id === 'chart' && s.showGuides) ctx.progress.showGuides = true;
        ctx.busy = false; ctx.message = ''; ctx.preview = false;
        update(false); return;
      }
      if (action === 'help') {
        s.assisted = true; ctx.helpVisible = true;
        if (id === 'chart') s.showGuides = true;
        update(false); return;
      }
      if (id === 'seals' && target.hasAttribute('data-card')) {
        const index = Number(target.dataset.card);
        if (validIndex(index, 12)) selectCard(index);
      } else if (id === 'channels' && target.hasAttribute('data-pipe')) {
        const index = Number(target.dataset.pipe);
        if (!validIndex(index, 9)) return;
        s.rotations[index] = (s.rotations[index] + 1) % 4;
        s.moves++; ctx.message = '';
        update();
        if (current() && !isSolved()) container.querySelector(`[data-pipe="${index}"]`)?.focus({ preventScroll: true });
      } else if (id === 'chart') {
        if (action === 'preview') { ctx.preview = !ctx.preview; render(); return; }
        if (action === 'guides') { s.showGuides = !s.showGuides; if (s.showGuides) s.assisted = true; update(false); return; }
        if (!target.hasAttribute('data-tile')) return;
        const index = Number(target.dataset.tile);
        if (!validIndex(index, 9)) return;
        ctx.message = '';
        if (s.selected === null) { s.selected = index; update(false); }
        else if (s.selected === index) { s.selected = null; update(false); }
        else { [s.tiles[s.selected], s.tiles[index]] = [s.tiles[index], s.tiles[s.selected]]; s.selected = null; s.moves++; update(); }
        if (current() && !isSolved()) container.querySelector(`[data-tile="${index}"]`)?.focus({ preventScroll: true });
      } else if (id === 'cipher') {
        if (target.hasAttribute('data-symbol') && s.input.length < 4 && Object.hasOwn(symbolsById, target.dataset.symbol)) {
          s.input.push(target.dataset.symbol); ctx.message = ''; update(false);
        } else if (action === 'backspace') { s.input.pop(); ctx.message = ''; update(false); }
        else if (action === 'verify' && s.input.length === 4) {
          s.moves++;
          s.verified = s.input.join(',') === cipherSolution.join(',');
          ctx.message = s.verified ? 'Les quatre sceaux répondent. Le secret est à vous.' : 'Le médaillon reste fermé. Retirez un sceau ou recommencez en suivant le témoignage.';
          update();
        }
      }
    };
    container.addEventListener('click', ctx.listener);
    update(false);
    // Repair a completion saved immediately before its reward callback was interrupted.
    if (isSolved()) later(finish, 0);
    return { dispose: () => { if (current()) dispose(); } };
  }

  window.MiniGames = Object.freeze({ catalog, mount, dispose, validateProgress });
})();
