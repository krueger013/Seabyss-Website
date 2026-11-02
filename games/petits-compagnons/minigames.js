/* Petits Compagnons — mini-jeux sans dépendance. */
(function () {
  'use strict';

  const games = {
    catch: { icon: '🧺', title: 'La cueillette magique', tag: 'RÉFLEXES & PETITS FRUITS', text: 'Attrape les fraises et les étoiles pendant 30 secondes. Évite les nuages de pluie !', hint: 'Déplace le panier avec la souris, ton doigt ou les flèches ← →.', reward: 'Les fraises valent 1 point, les étoiles 3. Un nuage enlève 2 points.' },
    memory: { icon: '🌸', title: 'Les jolies paires', tag: 'MÉMOIRE & DOUCEUR', text: 'Retourne les cartes et retrouve les 6 paires cachées dans le jardin.', hint: 'Clique ou touche deux cartes. Tu peux aussi utiliser Tab et Entrée.', reward: 'Prends ton temps : chaque paire retrouvée rapproche ton compagnon de sa récompense.' },
    rhythm: { icon: '✨', title: 'La danse des lucioles', tag: 'RYTHME & PRÉCISION', text: 'Attrape le bon tempo : appuie quand la luciole traverse la zone verte.', hint: 'Clique sur « Hop ! », touche le bouton ou utilise la barre d’espace.', reward: '8 essais. Au centre : 3 points. Dans la zone verte : 2 points.' }
  };

  let current = null;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function button(label, className, action) {
    const el = node('button', className, label);
    el.type = 'button';
    if (action) el.dataset.mgAction = action;
    return el;
  }

  function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  function open(type, options) {
    if (!games[type]) return null;
    if (current) current.close();
    options = options || {};
    const info = games[type];
    const previousFocus = document.activeElement;
    const controller = new AbortController();
    const signal = controller.signal;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const overlay = node('div', 'mg-overlay');
    overlay.id = 'minigame-overlay';
    const dialog = node('section', 'mg-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'mg-title');
    dialog.setAttribute('aria-describedby', 'mg-subtitle');
    const header = node('header', 'mg-header');
    const headingWrap = node('div');
    headingWrap.append(node('p', 'mg-eyebrow', info.tag));
    const title = node('h2', 'mg-title', info.title);
    title.id = 'mg-title';
    headingWrap.append(title);
    const closeButton = button('✕', 'mg-close', 'close');
    closeButton.setAttribute('aria-label', 'Fermer le mini-jeu');
    header.append(headingWrap, closeButton);
    const body = node('div', 'mg-body');
    const live = node('div', 'mg-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    const pause = node('div', 'mg-pause', '☁ Jeu en pause — reviens quand tu veux');
    pause.hidden = true;
    dialog.append(header, body, pause, live);
    overlay.append(dialog);
    document.body.append(overlay);

    let closed = false;
    let phase = 'ready';
    let state = {};
    let frame = 0;
    let last = 0;
    let paid = false;
    const keys = new Set();

    function sound(kind) {
      if (typeof options.sound === 'function') {
        try { options.sound(kind); } catch (_) { /* Sound is optional. */ }
      }
    }

    function announce(message) { live.textContent = message; }

    function close() {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(frame);
      controller.abort();
      keys.clear();
      overlay.remove();
      document.body.style.overflow = previousOverflow;
      if (current && current.close === close) current = null;
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      if (typeof options.onClose === 'function') {
        try { options.onClose(); } catch (error) { console.error('Fermeture du mini-jeu :', error); }
      }
    }

    function ready() {
      phase = 'ready';
      body.replaceChildren();
      const hero = node('div', 'mg-ready-icon', info.icon);
      hero.setAttribute('aria-hidden', 'true');
      const description = node('p', 'mg-description', info.text);
      description.id = 'mg-subtitle';
      const hint = node('p', 'mg-hint', info.hint);
      const reward = node('p', 'mg-reward-hint', info.reward);
      const start = button('C’est parti !  →', 'mg-button mg-primary', 'start');
      body.append(hero, description, hint, reward, start);
      start.focus();
    }

    function stat(label, value) {
      const wrap = node('div', 'mg-stat');
      wrap.append(node('span', '', label));
      const display = node('strong', '', String(value));
      wrap.append(display);
      return { wrap, display };
    }

    function start() {
      if (closed) return;
      cancelAnimationFrame(frame);
      phase = 'playing';
      paid = false;
      keys.clear();
      state = { elapsed: 0, score: 0 };
      body.replaceChildren();
      body.classList.add('mg-playing');
      const subtitle = node('p', 'mg-instructions', info.hint);
      subtitle.id = 'mg-subtitle';
      body.append(subtitle);
      if (type === 'catch') setupCatch();
      if (type === 'memory') setupMemory();
      if (type === 'rhythm') setupRhythm();
      sound('start');
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }

    function finish(score, extra) {
      if (closed || phase !== 'playing' || paid) return;
      phase = 'result';
      paid = true;
      cancelAnimationFrame(frame);
      keys.clear();
      const rewards = type === 'catch'
        ? { coins: 12 + Math.min(40, score * 2), happiness: 16 + Math.min(14, score), xp: 12 + Math.min(20, score) }
        : type === 'memory'
          ? { coins: 20 + Math.max(0, 24 - state.moves), happiness: 25, xp: 20 }
          : { coins: 12 + score, happiness: 18 + Math.round(score / 2), xp: 12 + Math.round(score / 2) };
      rewards.score = score;
      if (typeof options.onReward === 'function') {
        try { options.onReward(rewards); } catch (error) { console.error('Récompense du mini-jeu :', error); }
      }
      sound('win');
      body.classList.remove('mg-playing');
      body.replaceChildren();
      const picture = node('div', 'mg-result-icon', '🏆');
      picture.setAttribute('aria-hidden', 'true');
      const resultTitle = node('h3', 'mg-result-title', type === 'memory' ? 'Toutes les paires réunies !' : score > 0 ? 'Bien joué, petit champion !' : 'Chaque essai fait progresser !');
      const resultText = node('p', 'mg-description', extra || (score + (score === 1 ? ' point récolté' : ' points récoltés')));
      resultText.id = 'mg-subtitle';
      const rewardRow = node('div', 'mg-rewards');
      rewardRow.append(node('span', '', '✦ ' + rewards.coins + ' étoiles'), node('span', '', '♥ +' + rewards.happiness + ' bonheur'), node('span', '', '🌱 +' + rewards.xp + ' amitié'));
      const actions = node('div', 'mg-result-actions');
      actions.append(button('Rejouer', 'mg-button mg-secondary', 'start'), button('Retrouver mon compagnon', 'mg-button mg-primary', 'close'));
      body.append(picture, resultTitle, resultText, rewardRow, actions);
      announce('Partie terminée. ' + rewards.coins + ' étoiles gagnées.');
      actions.lastElementChild.focus();
    }

    function setupCatch() {
      const stats = node('div', 'mg-stats');
      const clock = stat('TEMPS', '30 s');
      const points = stat('RÉCOLTE', 0);
      stats.append(clock.wrap, points.wrap);
      const field = node('div', 'mg-catch-field');
      field.tabIndex = 0;
      field.setAttribute('role', 'application');
      field.setAttribute('aria-label', 'Cueillette : déplace le panier avec les flèches gauche et droite.');
      const sun = node('span', 'mg-field-sun', '☀');
      const scenery = node('span', 'mg-field-scenery', '🌷  🌼  🌿  🌸  🌱  🌼  🌷');
      sun.setAttribute('aria-hidden', 'true');
      scenery.setAttribute('aria-hidden', 'true');
      const basket = node('div', 'mg-basket', '🧺');
      basket.setAttribute('aria-hidden', 'true');
      field.append(sun, scenery, basket);
      const note = node('p', 'mg-catch-note', '🍓 +1     ⭐ +3     🌧 −2');
      body.append(stats, field, note);
      Object.assign(state, { field, basket, clock: clock.display, points: points.display, x: 50, drops: [], nextDrop: 0.15, flash: 0 });
      basket.style.left = '50%';
      field.focus();
    }

    function moveBasket(event) {
      if (phase !== 'playing' || type !== 'catch') return;
      if (!state.field.contains(event.target)) return;
      if (event.type === 'pointerdown') {
        state.field.focus();
        if (state.field.setPointerCapture) state.field.setPointerCapture(event.pointerId);
      }
      const rect = state.field.getBoundingClientRect();
      state.x = Math.max(7, Math.min(93, ((event.clientX - rect.left) / rect.width) * 100));
    }

    function tickCatch(dt) {
      state.clock.textContent = Math.max(0, Math.ceil(30 - state.elapsed)) + ' s';
      if (state.elapsed >= 30) { finish(state.score); return; }
      if (keys.has('ArrowLeft') || keys.has('a') || keys.has('q')) state.x -= dt * 78;
      if (keys.has('ArrowRight') || keys.has('d')) state.x += dt * 78;
      state.x = Math.max(7, Math.min(93, state.x));
      state.basket.style.left = state.x + '%';
      state.nextDrop -= dt;
      if (state.nextDrop <= 0) {
        const chance = Math.random();
        const item = chance < 0.17 ? 'cloud' : chance > 0.79 ? 'star' : 'berry';
        const el = node('span', 'mg-drop', item === 'cloud' ? '🌧' : item === 'star' ? '⭐' : '🍓');
        el.setAttribute('aria-hidden', 'true');
        const x = 8 + Math.random() * 84;
        el.style.left = x + '%';
        state.field.append(el);
        state.drops.push({ el, x, y: -8, speed: 24 + Math.random() * 11 + state.elapsed * 0.35, item });
        state.nextDrop = 0.45 + Math.random() * 0.23;
      }
      for (let i = state.drops.length - 1; i >= 0; i--) {
        const drop = state.drops[i];
        drop.y += dt * drop.speed;
        drop.el.style.top = drop.y + '%';
        if (drop.y >= 80 && drop.y <= 94 && Math.abs(drop.x - state.x) < 9) {
          const delta = drop.item === 'cloud' ? -2 : drop.item === 'star' ? 3 : 1;
          state.score = Math.max(0, state.score + delta);
          state.points.textContent = state.score;
          state.basket.classList.toggle('mg-oops', delta < 0);
          state.basket.classList.toggle('mg-yay', delta > 0);
          state.flash = 0.22;
          sound(delta > 0 ? 'collect' : 'miss');
          drop.el.remove();
          state.drops.splice(i, 1);
        } else if (drop.y > 108) {
          drop.el.remove();
          state.drops.splice(i, 1);
        }
      }
      if (state.flash > 0) {
        state.flash -= dt;
        if (state.flash <= 0) state.basket.classList.remove('mg-oops', 'mg-yay');
      }
    }

    function setupMemory() {
      const stats = node('div', 'mg-stats');
      const moves = stat('ESSAIS', 0);
      const pairs = stat('PAIRES', '0 / 6');
      stats.append(moves.wrap, pairs.wrap);
      const grid = node('div', 'mg-memory-grid');
      grid.setAttribute('aria-label', 'Les douze cartes du jardin');
      const cards = shuffle(['🍓', '🌸', '🍄', '🦋', '🍯', '🌻'].flatMap(value => [value, value]));
      Object.assign(state, { cards, revealed: [], matched: new Set(), moves: 0, pairs: 0, flipAt: 0, movesNode: moves.display, pairsNode: pairs.display, grid });
      cards.forEach((value, index) => {
        const card = button('✿', 'mg-card', 'card');
        card.dataset.index = String(index);
        card.setAttribute('aria-label', 'Carte ' + (index + 1) + ', face cachée');
        grid.append(card);
      });
      body.append(stats, grid, node('p', 'mg-catch-note', 'Six petites paires. Un grand moment de complicité.'));
      grid.firstElementChild.focus();
    }

    function flip(index) {
      if (state.revealed.length >= 2 || state.matched.has(index) || state.revealed.includes(index)) return;
      const card = state.grid.children[index];
      card.textContent = state.cards[index];
      card.classList.add('mg-flipped');
      card.setAttribute('aria-label', 'Carte ' + (index + 1) + ' : ' + state.cards[index]);
      state.revealed.push(index);
      sound('tap');
      if (state.revealed.length !== 2) return;
      state.moves++;
      state.movesNode.textContent = state.moves;
      const [a, b] = state.revealed;
      if (state.cards[a] === state.cards[b]) {
        state.matched.add(a);
        state.matched.add(b);
        [a, b].forEach(i => {
          state.grid.children[i].classList.add('mg-matched');
          state.grid.children[i].disabled = true;
          state.grid.children[i].setAttribute('aria-label', 'Paire trouvée : ' + state.cards[i]);
        });
        state.pairs++;
        state.pairsNode.textContent = state.pairs + ' / 6';
        state.revealed = [];
        sound('collect');
        announce('Une paire trouvée ! ' + state.pairs + ' sur 6.');
        if (state.pairs === 6) state.completeAt = state.elapsed + 0.6;
        else {
          const next = Array.from(state.grid.children).find(el => !el.disabled);
          if (next && document.activeElement === card) next.focus();
        }
      } else state.flipAt = state.elapsed + 0.95;
    }

    function tickMemory() {
      if (state.completeAt && state.elapsed >= state.completeAt) {
        finish(Math.max(6, 42 - state.moves), '6 paires retrouvées en ' + state.moves + ' essais.');
        return;
      }
      if (state.flipAt && state.elapsed >= state.flipAt) {
        state.revealed.forEach(index => {
          const card = state.grid.children[index];
          card.textContent = '✿';
          card.classList.remove('mg-flipped');
          card.setAttribute('aria-label', 'Carte ' + (index + 1) + ', face cachée');
        });
        state.revealed = [];
        state.flipAt = 0;
      }
    }

    function setupRhythm() {
      const stats = node('div', 'mg-stats');
      const round = stat('ESSAI', '1 / 8');
      const points = stat('POINTS', 0);
      stats.append(round.wrap, points.wrap);
      const area = node('div', 'mg-rhythm-area');
      const mascot = node('div', 'mg-rhythm-mascot', '✨');
      mascot.setAttribute('aria-hidden', 'true');
      const feedback = node('p', 'mg-rhythm-feedback', 'À toi de jouer !');
      const track = node('div', 'mg-rhythm-track');
      track.setAttribute('aria-label', 'Appuie quand la luciole atteint le centre.');
      const target = node('div', 'mg-rhythm-target');
      target.append(node('span', '', '✓'));
      const marker = node('div', 'mg-rhythm-marker', '✦');
      marker.setAttribute('aria-hidden', 'true');
      track.append(target, marker);
      const timer = node('div', 'mg-rhythm-timer');
      const timerFill = node('div');
      timer.append(timerFill);
      const pips = node('div', 'mg-rhythm-pips');
      for (let i = 0; i < 8; i++) pips.append(node('span', '', '·'));
      const hop = button('Hop !', 'mg-button mg-primary mg-hop', 'hop');
      area.append(mascot, feedback, track, timer, pips, hop);
      body.append(stats, area, node('p', 'mg-catch-note', 'Au centre = parfait ✦     Dans le vert = bien joué'));
      Object.assign(state, { round: 0, roundTime: 0, x: 0, wait: 0, roundNode: round.display, points: points.display, marker, feedback, pips, hop, timerFill });
      hop.focus();
    }

    function hit(forced) {
      if (state.wait > 0 || state.round >= 8) return;
      const distance = Math.abs(state.x - 50);
      const points = forced ? 0 : distance <= 6 ? 3 : distance <= 12 ? 2 : 0;
      state.score += points;
      state.points.textContent = state.score;
      state.feedback.textContent = points === 3 ? 'Parfait ! +3 points' : points === 2 ? 'Bien joué ! +2 points' : forced ? 'La luciole est passée !' : 'Presque ! Réessaie au prochain passage.';
      state.feedback.classList.toggle('mg-perfect', points > 0);
      state.pips.children[state.round].textContent = points > 0 ? '★' : '·';
      state.pips.children[state.round].className = points > 0 ? 'mg-pip-won' : 'mg-pip-miss';
      state.round++;
      state.wait = 0.75;
      state.hop.disabled = true;
      sound(points > 0 ? 'collect' : 'miss');
      announce(state.feedback.textContent);
    }

    function tickRhythm(dt) {
      if (state.wait > 0) {
        state.wait -= dt;
        if (state.wait <= 0) {
          if (state.round === 8) { finish(state.score, state.score + ' points sur 24. Un joli moment en rythme !'); return; }
          state.roundTime = 0;
          state.roundNode.textContent = (state.round + 1) + ' / 8';
          state.feedback.textContent = 'Vise le cœur de la zone verte…';
          state.feedback.classList.remove('mg-perfect');
          state.hop.disabled = false;
          state.hop.focus({ preventScroll: true });
        }
        return;
      }
      state.roundTime += dt;
      const speed = 0.65 + state.round * 0.055;
      const position = (state.roundTime * speed) % 2;
      state.x = (position <= 1 ? position : 2 - position) * 100;
      state.marker.style.left = state.x + '%';
      state.timerFill.style.width = Math.max(0, 100 * (1 - state.roundTime / 4.8)) + '%';
      if (state.roundTime >= 4.8) hit(true);
    }

    function tick(now) {
      if (closed || phase !== 'playing') return;
      const dt = document.hidden ? 0 : Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      state.elapsed += dt;
      if (type === 'catch') tickCatch(dt);
      if (type === 'memory') tickMemory();
      if (type === 'rhythm') tickRhythm(dt);
      if (!closed && phase === 'playing') frame = requestAnimationFrame(tick);
    }

    overlay.addEventListener('click', event => {
      const target = event.target.closest('[data-mg-action]');
      if (!target || !overlay.contains(target)) return;
      const action = target.dataset.mgAction;
      if (action === 'close') close();
      if (action === 'start' && phase !== 'playing') start();
      if (action === 'hop' && phase === 'playing' && type === 'rhythm') hit(false);
      if (action === 'card' && phase === 'playing' && type === 'memory') flip(Number(target.dataset.index));
    }, { signal });
    overlay.addEventListener('pointermove', moveBasket, { signal });
    overlay.addEventListener('pointerdown', moveBasket, { signal });

    document.addEventListener('keydown', event => {
      if (closed) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (event.key === 'Tab') {
        const focusables = Array.from(dialog.querySelectorAll('button:not([disabled]), [tabindex="0"]'));
        const first = focusables[0];
        const final = focusables[focusables.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault(); final.focus();
        } else if (!event.shiftKey && (document.activeElement === final || !dialog.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
      if (phase !== 'playing') return;
      if (type === 'catch' && ['ArrowLeft', 'ArrowRight', 'a', 'q', 'd'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); keys.add(event.key);
      }
      if (type === 'rhythm' && event.code === 'Space' && event.target !== closeButton) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) hit(false);
      }
    }, { signal, capture: true });
    document.addEventListener('keyup', event => keys.delete(event.key), { signal });
    document.addEventListener('visibilitychange', () => {
      last = performance.now();
      keys.clear();
      pause.hidden = !document.hidden;
    }, { signal });
    window.addEventListener('blur', () => keys.clear(), { signal });
    current = { close };
    ready();
    return current;
  }

  window.PetMiniGames = { open, close: function () { if (current) current.close(); } };
}());
