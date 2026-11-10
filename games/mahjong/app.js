(() => {
  'use strict';
  const E = window.MahjongEngine;
  const $ = id => document.getElementById(id);
  const STORAGE = 'seabyss-mahjong-v1';
  const names = ['Ancre', 'Couronne', 'Épées', 'Tour', 'Heaume', 'Navire', 'Boussole', 'Crâne', 'Clé', 'Coffre', 'Lune', 'Calice'];
  const icons = ['anchor', 'crown', 'swords', 'tower', 'helm', 'ship', 'compass', 'skull', 'key', 'chest', 'moon', 'chalice'];
  const layoutInfo = { cove: ['anchor', '36 tuiles · Escale'], fortress: ['tower', '72 tuiles · Aventure'], kraken: ['skull', '108 tuiles · Légende'] };
  const clone = value => JSON.parse(JSON.stringify(value));
  const svg = icon => `<svg aria-hidden="true"><use href="#i-${icon}"/></svg>`;
  let game, selected = null, history = [], elapsed = 0, hints = 0, shuffles = 0, enlarged = false, sound = false, audio;
  let hinted = [], hintTimeout, returnFocus, storageAvailable = true;
  const board = $('board');
  const modal = $('modal');
  const formatTime = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

  function validTiles(tiles, count) {
    return Array.isArray(tiles) && tiles.length === count && new Set(tiles.map(t => t.id)).size === count && tiles.every(t =>
      typeof t.id === 'string' && /^t\d+$/.test(t.id) && Number.isInteger(t.type) && t.type >= 0 && t.type < 12 &&
      ['x', 'y', 'z'].every(k => Number.isFinite(t[k]) && t[k] >= 0 && t[k] <= 20) && typeof t.removed === 'boolean') &&
      tiles.filter(t => !t.removed).length % 2 === 0;
  }
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE));
      const layout = saved && E.layouts.find(l => l.id === saved.game?.layoutId);
      if (!layout || !validTiles(saved.game.tiles, layout.count)) return false;
      game = saved.game;
      elapsed = Number.isSafeInteger(saved.elapsed) && saved.elapsed >= 0 ? saved.elapsed : 0;
      hints = Number.isSafeInteger(saved.hints) && saved.hints >= 0 ? saved.hints : 0;
      shuffles = Number.isSafeInteger(saved.shuffles) && saved.shuffles >= 0 ? saved.shuffles : 0;
      selected = E.isFree(game.tiles, saved.selected) ? saved.selected : null;
      history = Array.isArray(saved.history) ? saved.history.filter(h => validTiles(h.tiles, layout.count)).slice(-60) : [];
      enlarged = saved.enlarged === true;
      return true;
    } catch (_) { return false; }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ game, selected, history, elapsed, hints, shuffles, enlarged }));
    } catch (_) {
      storageAvailable = false;
      $('save-note').textContent = 'Sauvegarde indisponible : gardez cet onglet ouvert pour conserver votre partie.';
    }
  }
  function say(message, tone = '') {
    $('selection').textContent = message;
    $('selection').dataset.tone = tone;
  }
  function celebratePair(points) {
    // Decorative feedback never postpones a move or captures touch input.
    points.forEach(point => {
      const burst = document.createElement('span');
      burst.className = 'match-burst';
      burst.setAttribute('aria-hidden', 'true');
      burst.textContent = '✦';
      burst.style.left = `${point.x}px`;
      burst.style.top = `${point.y}px`;
      board.appendChild(burst);
      setTimeout(() => burst.remove(), 650);
    });
  }
  function clearHint() { hinted = []; clearTimeout(hintTimeout); }
  function record() {
    history.push({ tiles: clone(game.tiles), selected, shuffles });
    if (history.length > 60) history.shift();
  }
  function playSound(matched) {
    if (!sound) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      audio ||= new Audio();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
      [matched ? 523.25 : 349.23, ...(matched ? [659.25, 783.99] : [])].forEach((frequency, index) => {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), time = audio.currentTime + index * .07;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(.045, time + .015); gain.gain.exponentialRampToValueAtTime(.001, time + .4);
        oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(time); oscillator.stop(time + .42);
      });
    } catch (_) { /* The game stays usable when audio is unavailable. */ }
  }
  function sizeBoard() {
    if (!game) return;
    const tiles = game.tiles;
    const cols = Math.max(...tiles.map(t => t.x)) + 1;
    const rows = Math.max(...tiles.map(t => t.y)) + 1;
    const scroll = $('board-scroll');
    const scrollStyle = getComputedStyle(scroll);
    const paddingX = parseFloat(scrollStyle.paddingLeft) + parseFloat(scrollStyle.paddingRight);
    const paddingY = parseFloat(scrollStyle.paddingTop) + parseFloat(scrollStyle.paddingBottom);
    const usable = scroll.clientWidth - paddingX;
    const outerHeight = element => {
      const style = getComputedStyle(element);
      return element.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    };
    // Use the actual UI above and below the board, independent of page scroll.
    // Leave larger layouts scrollable rather than shrinking their touch targets.
    const boardTop = scroll.getBoundingClientRect().top + window.scrollY;
    const controls = outerHeight($('selection')) + outerHeight(document.querySelector('.game-actions'));
    const heightCap = window.innerWidth > 760 && window.innerHeight >= 600
      ? Math.floor((window.innerHeight - boardTop - controls - paddingY - 26) / rows / 1.27)
      : 70;
    const width = enlarged ? 80 : Math.max(47, Math.min(70, heightCap, Math.floor((usable - 20) / cols)));
    const height = Math.round(width * 1.27);
    board.style.width = `${cols * width + 20}px`;
    board.style.height = `${rows * height + 24}px`;
    for (const tile of tiles) {
      const element = document.getElementById(`tile-${tile.id}`);
      if (!element) continue;
      element.style.width = `${width - 3}px`;
      element.style.height = `${height - 4}px`;
      element.style.left = `${tile.x * width + tile.z * 4 + 3}px`;
      element.style.top = `${tile.y * height + 12 - tile.z * 5}px`;
      element.style.zIndex = tile.z * 100 + Math.round(tile.y * 2);
    }
    $('scroll-tip').hidden = board.offsetWidth <= usable;
  }
  function render() {
    const oldFocus = document.activeElement?.id;
    const remaining = game.tiles.filter(t => !t.removed).length;
    const pairs = E.getPairs(game.tiles);
    const layout = E.layouts.find(l => l.id === game.layoutId);
    $('layout-title').textContent = layout.name;
    $('remaining').textContent = remaining;
    $('pairs').textContent = pairs.length;
    $('timer').textContent = formatTime(elapsed);
    $('undo').disabled = history.length === 0;
    $('hint').disabled = pairs.length === 0;
    $('shuffle').disabled = remaining === 0;
    const percent = Math.round((1 - remaining / game.tiles.length) * 100);
    $('progress').style.width = `${percent}%`;
    $('progress').parentElement.setAttribute('aria-valuenow', percent);
    if ($('cleared-count')) $('cleared-count').textContent = `${game.tiles.length - remaining} / ${game.tiles.length}`;
    if ($('progress-caption')) $('progress-caption').textContent = !remaining ? 'Trésor libéré' : percent >= 75 ? 'Le trésor approche' : percent > 0 ? 'La voie se dévoile' : 'L’aventure commence';
    if ($('layout-number')) $('layout-number').textContent = String(E.layouts.indexOf(layout) + 1).padStart(2, '0');
    $('zoom').setAttribute('aria-pressed', String(enlarged));
    $('zoom').textContent = enlarged ? '− Vue normale' : '＋ Vue confort';
    $('zoom').title = enlarged ? 'Retrouver la taille normale des tuiles' : 'Agrandir les tuiles ; le plateau reste défilable';
    board.innerHTML = game.tiles.filter(t => !t.removed).map(tile => {
      const free = E.isFree(game.tiles, tile.id);
      return `<button id="tile-${tile.id}" data-tile="${tile.id}" class="tile family-${Math.floor(tile.type / 4)}${free ? ' free' : ' blocked'}${selected === tile.id ? ' selected' : ''}${hinted.includes(tile.id) ? ' hinted' : ''}" aria-label="${names[tile.type]}, ${free ? 'libre' : 'bloquée'}" aria-pressed="${selected === tile.id}" aria-disabled="${!free}" tabindex="${free ? 0 : -1}">${svg(icons[tile.type])}<span class="tile-mark" aria-hidden="true">${['I', 'II', 'III'][Math.floor(tile.type / 4)]}</span></button>`;
    }).join('');
    document.querySelectorAll('[data-layout]').forEach(button => {
      const active = button.dataset.layout === game.layoutId;
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('.choice-dot').textContent = active ? 'En cours' : '';
    });
    sizeBoard();
    if (oldFocus?.startsWith('tile-')) {
      const replacement = document.getElementById(oldFocus) || board.querySelector('.free');
      replacement?.focus({ preventScroll: true });
    }
    if (!remaining) say('Le trésor est à vous. Toutes les reliques sont libérées !', 'positive');
    else if (!pairs.length) say('Aucune paire libre. Mélangez les tuiles ou annulez le dernier coup.', 'warning');
  }
  function selectTile(id) {
    const tile = game.tiles.find(t => t.id === id);
    if (!tile || tile.removed) return;
    if (!E.isFree(game.tiles, id)) {
      say(`${names[tile.type]} bloquée : libérez le dessus et au moins un côté.`, 'warning');
      return;
    }
    clearHint();
    if (selected === id) {
      selected = null; say('Choisissez deux reliques identiques et libres.');
    } else if (selected && game.tiles.find(t => t.id === selected)?.type === tile.type) {
      const points = [selected, id].map(tileId => {
        const element = document.getElementById(`tile-${tileId}`);
        return { x: element.offsetLeft + element.offsetWidth / 2, y: element.offsetTop + element.offsetHeight / 2 };
      });
      record();
      if (E.removePair(game.tiles, selected, id)) {
        selected = null; playSound(true); say(`${names[tile.type]} : une paire libérée.`, 'positive');
        render(); save();
        celebratePair(points);
        if (game.tiles.every(t => t.removed)) showVictory();
        return;
      }
    } else {
      const changed = selected !== null;
      selected = id; playSound(false);
      say(`${changed ? 'Symboles différents. ' : ''}${names[tile.type]} sélectionnée : trouvez son double libre.`, changed ? 'warning' : 'selected');
    }
    render(); save();
  }
  function start(layoutId) {
    game = E.createGame(layoutId); selected = null; history = []; elapsed = 0; hints = 0; shuffles = 0;
    clearHint(); render(); save(); say('Choisissez deux reliques identiques et libres.');
    $('board-scroll').scrollLeft = 0;
  }
  function openModal(title, html) {
    returnFocus = document.activeElement;
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    modal.showModal();
    $('close-modal').focus();
  }
  function closeModal() { modal.close(); }
  modal.addEventListener('close', () => {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  function confirmNew(layoutId) {
    openModal('Lever l’ancre ?', `<p>Commencez une nouvelle expédition dans <strong>${E.layouts.find(l => l.id === layoutId).name}</strong>. Votre partie actuelle sera remplacée.</p><div class="modal-actions"><button class="primary-button" id="confirm-new">Commencer l’expédition</button><button class="outline-button" id="keep-game">Continuer ma partie</button></div>`);
    $('confirm-new').onclick = () => { closeModal(); start(layoutId); document.querySelector('.game-panel').scrollIntoView({ block: 'start' }); };
    $('keep-game').onclick = closeModal;
  }
  function showHelp() {
    openModal('Le code des reliques', '<p>Un mahjong <strong>solitaire</strong>, sans adversaire et sans limite de temps. Votre objectif : retirer toutes les tuiles du plateau.</p><ol><li><strong>Repérez une tuile libre.</strong> Aucune tuile ne doit la recouvrir. Son côté gauche ou son côté droit doit être dégagé. Les tuiles bloquées sont assombries.</li><li><strong>Associez deux symboles identiques.</strong> Touchez la première tuile, puis son double libre. Les deux disparaissent.</li><li><strong>Débloquez les étages.</strong> Anticipez vos paires : un mauvais choix peut fermer une voie.</li></ol><p><strong>Besoin d’un coup de main ?</strong> Indice montre une paire disponible. Annuler rétablit le dernier coup, y compris un mélange. Mélanger redistribue les tuiles restantes et garantit un chemin vers la victoire ; leur disposition peut changer.</p><p><strong>Sur téléphone :</strong> jouez en portrait ou en paysage, agrandissez les tuiles et faites glisser le plateau pour atteindre les bords. Le zoom du navigateur reste disponible.</p><p><strong>Au clavier :</strong> Tab pour naviguer, Entrée ou Espace pour choisir une tuile, Échap pour fermer cette fenêtre. Le temps se met en pause lorsque l’onglet est masqué ou une fenêtre ouverte.</p><p>La partie et votre sélection sont enregistrées automatiquement dans ce navigateur, si le stockage local est autorisé.</p>');
  }
  function showVictory() {
    openModal('Le trésor est à vous.', `<p>Toutes les reliques ont retrouvé leur double. Les ombres du port vous laissent passer.</p><div class="modal-metrics"><div><strong>${formatTime(elapsed)}</strong><span>de voyage</span></div><div><strong>${hints}</strong><span>indices</span></div><div><strong>${shuffles}</strong><span>mélanges</span></div></div><div class="modal-actions"><button class="primary-button" id="sail-again">Repartir à l’aventure</button><button class="outline-button" id="view-board">Voir le plateau</button></div>`);
    $('sail-again').onclick = () => { closeModal(); start(game.layoutId); };
    $('view-board').onclick = closeModal;
  }
  $('layouts').innerHTML = E.layouts.map((l, index) => `<button class="layout-choice" data-layout="${l.id}" aria-pressed="false" title="Commencer une expédition de ${l.count} tuiles"><span class="layout-icon">${svg(layoutInfo[l.id][0])}</span><span class="layout-copy"><strong>${l.name}</strong><small>${layoutInfo[l.id][1]}</small></span><span class="choice-state" aria-hidden="true"><span class="layout-order">${String(index + 1).padStart(2, '0')}</span><span class="choice-dot"></span></span></button>`).join('');
  $('layouts').addEventListener('click', event => {
    const choice = event.target.closest('[data-layout]');
    if (choice) confirmNew(choice.dataset.layout);
  });
  board.addEventListener('click', event => { const tile = event.target.closest('[data-tile]'); if (tile) selectTile(tile.dataset.tile); });
  $('new-game').setAttribute('aria-label', 'Nouvelle partie');
  const tooltips = {
    'new-game': 'Commencer une nouvelle expédition sur ce plateau',
    hint: 'Illuminer une paire de tuiles disponible',
    undo: 'Annuler le dernier coup ou le dernier mélange',
    shuffle: 'Redistribuer les reliques restantes pour ouvrir une nouvelle voie',
    help: 'Consulter les règles du mahjong solitaire',
    sound: 'Activer les sons du jeu'
  };
  Object.entries(tooltips).forEach(([id, title]) => { $(id).title = title; });
  $('new-game').onclick = () => confirmNew(game.layoutId);
  $('hint').onclick = () => {
    const pair = E.getPairs(game.tiles)[0];
    if (!pair) return;
    clearHint(); hinted = pair; selected = null; hints++;
    say(`Indice : associez les deux tuiles « ${names[game.tiles.find(t => t.id === pair[0]).type]} » illuminées.`, 'selected');
    render(); save();
    document.getElementById(`tile-${pair[0]}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    hintTimeout = setTimeout(() => { hinted = []; render(); }, 6000);
  };
  $('undo').onclick = () => {
    const previous = history.pop();
    if (!previous) return;
    game.tiles = previous.tiles; selected = previous.selected; shuffles = previous.shuffles ?? shuffles;
    clearHint(); render(); save(); say('Dernière action annulée. À vous de choisir une nouvelle voie.');
  };
  $('shuffle').onclick = () => {
    openModal('Changer le destin ?', '<p>Les symboles restants seront redistribués pour ouvrir un chemin vers la victoire. Si nécessaire, les tuiles seront disposées à plat. Vous pourrez annuler ce mélange.</p><div class="modal-actions"><button class="primary-button" id="confirm-shuffle">Mélanger les reliques</button><button class="outline-button" id="cancel-shuffle">Garder le plateau</button></div>');
    $('confirm-shuffle').onclick = () => {
      record(); const solution = E.shuffle(game.tiles); shuffles++; selected = null; clearHint();
      closeModal(); render(); save();
      say(solution.reflowed ? 'Les reliques ont été redistribuées à plat. Une nouvelle voie est ouverte.' : 'Les symboles ont été mélangés. Une nouvelle voie est ouverte.');
    };
    $('cancel-shuffle').onclick = closeModal;
  };
  $('zoom').onclick = () => { enlarged = !enlarged; render(); save(); };
  $('help').onclick = showHelp; $('learn').onclick = showHelp; $('close-modal').onclick = closeModal;
  $('sound').onclick = () => {
    sound = !sound;
    $('sound').setAttribute('aria-pressed', String(sound));
    $('sound').setAttribute('aria-label', sound ? 'Désactiver le son' : 'Activer le son');
    $('sound').title = sound ? 'Désactiver les sons du jeu' : 'Activer les sons du jeu';
    playSound(true);
  };
  const restored = restore();
  if (!restored) start('cove');
  else if (game.tiles.every(t => t.removed)) { render(); showVictory(); }
  else { render(); say(selected ? `${names[game.tiles.find(t => t.id === selected).type]} sélectionnée. Votre voyage reprend.` : 'Votre voyage reprend là où vous l’aviez laissé.'); }
  if ('ResizeObserver' in window) new ResizeObserver(sizeBoard).observe($('board-scroll'));
  window.addEventListener('resize', sizeBoard);
  document.addEventListener('visibilitychange', save);
  window.addEventListener('pagehide', save);
  setInterval(() => {
    if (!document.hidden && !modal.open && game.tiles.some(t => !t.removed)) {
      elapsed++; $('timer').textContent = formatTime(elapsed);
      if (elapsed % 5 === 0 && storageAvailable) save();
    }
  }, 1000);
})();
