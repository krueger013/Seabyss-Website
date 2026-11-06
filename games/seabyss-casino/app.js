(() => {
  'use strict';
  const E = globalThis.SeabyssEngine;
  const art = globalThis.SeabyssSymbols;
  const $ = id => document.getElementById(id);
  const money = cents => (cents / 100).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  const moneyHTML = cents => money(cents).replace(' $', ' <small>$</small>');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const storageKey = 'seabyss-casino-session-v1';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const autoRun = globalThis.SeabyssAutoplay.createController();
  const soundBank = globalThis.SeabyssSounds;
  let autoTimer = null;
  let selectedAutoCount = 10;
  let showAutoStatus = false;
  let demoScatterCount = 3;
  const initialGrid = [
    ['compass', 'skull', 'rum'],
    ['chest', 'anchor', 'ten'],
    ['skull', 'scatter', 'compass'],
    ['anchor', 'chest', 'rum'],
    ['rum', 'skull', 'compass']
  ];
  let state = E.createState();
  let grid = initialGrid.map(column => [...column]);
  let busy = false;
  let rapid = false;
  let sound = false;
  let demoOriginal = null;
  let pendingDemo = false;
  let visualLocks = [];
  let audioContext;
  let summaryPending = false;
  let animationResult = null;
  let encounterActive = false;
  let skipEncounter = false;

  function persist() {
    if (demoOriginal) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ state, grid, rapid, sound })); } catch (_) { /* Private browsing can disable storage. */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved) return;
      E.startDemoBonus(saved.state); // Pure validation through the engine's public API.
      E.evaluateGrid(saved.grid, saved.state.bet);
      if (saved.state.freeSpins > 20) return;
      const legacyAward = saved.state.inBonus ? saved.state.freeSpins > 15 ? 20 : saved.state.freeSpins > 10 ? 15 : 10 : 0;
      state = { ...saved.state, bonusSpinsAwarded: saved.state.bonusSpinsAwarded ?? legacyAward, lockedReels: [...saved.state.lockedReels] };
      grid = saved.grid.map(column => [...column]);
      visualLocks = [...state.lockedReels];
      rapid = saved.rapid === true;
      sound = saved.sound === true;
    } catch (_) { /* An unreadable save starts a fresh local session. */ }
  }

  function symbolMarkup(id) {
    return art[id] || art.ten;
  }

  function drawColumn(reel, column, locks = visualLocks) {
    const element = $('reels').children[reel];
    element.classList.toggle('locked', locks.includes(reel));
    element.innerHTML = column.map((id, row) => `<div class="symbol-cell" data-symbol="${id}" data-row="${row}" role="img" aria-label="${E.SYMBOLS.find(symbol => symbol.id === id).name}">${symbolMarkup(id)}</div>`).join('') + (locks.includes(reel) ? '<span class="frozen-tag">FIGÉ</span>' : '');
  }

  function renderGrid(locks = visualLocks) {
    $('reels').innerHTML = Array.from({ length: 5 }, (_, reel) => `<div class="reel" aria-label="Rouleau ${reel + 1}"></div>`).join('');
    grid.forEach((column, reel) => drawColumn(reel, column, locks));
    [...$('reel-labels').children].forEach((label, reel) => label.classList.toggle('is-locked', locks.includes(reel)));
  }

  function updateUI() {
    const auto = autoRun.getState();
    const showingBonus = animationResult ? animationResult.wasBonus : state.inBonus;
    const shownLocks = animationResult ? animationResult.oldLocks : state.lockedReels;
    document.body.classList.toggle('in-bonus', showingBonus || (summaryPending && !animationResult));
    document.body.classList.toggle('is-spinning', busy);
    globalThis.SeabyssAtmosphere?.setAwake(showingBonus || encounterActive);
    $('balance').innerHTML = moneyHTML(state.balance - (animationResult ? animationResult.totalWin : 0));
    $('bet-value').textContent = money(state.inBonus ? state.bonusBet : state.bet);
    $('last-win').innerHTML = moneyHTML(showingBonus || summaryPending ? state.bonusWin : state.lastWin);
    if (animationResult) $('last-win').innerHTML = moneyHTML(animationResult.wasBonus ? state.bonusWin - animationResult.totalWin : 0);
    $('win-label').textContent = showingBonus || (summaryPending && !animationResult) ? 'GAINS DU BONUS' : 'DERNIER GAIN';
    const index = E.BETS.indexOf(state.bet);
    $('bet-down').disabled = auto.active || busy || state.inBonus || index === 0 || !!demoOriginal || summaryPending;
    $('bet-up').disabled = auto.active || busy || state.inBonus || index === E.BETS.length - 1 || !!demoOriginal || summaryPending;
    $('spin-button').disabled = auto.active || busy || summaryPending || (!state.inBonus && state.balance < state.bet);
    $('demo-button').disabled = auto.active || busy || state.inBonus || summaryPending;
    $('surprise-demo-button').disabled = auto.active || busy || state.inBonus || !!demoOriginal || summaryPending;
    $('exit-demo-button').hidden = !demoOriginal;
    $('exit-demo-button').disabled = busy || summaryPending;
    ['help-button', 'rules-nav', 'paytable-button'].forEach(id => { $(id).disabled = auto.active || busy || summaryPending; });
    $('reset-button').disabled = auto.active || busy || !!demoOriginal || summaryPending;
    $('turbo-button').setAttribute('aria-pressed', String(rapid));
    $('turbo-button').title = rapid ? 'Désactiver le mode rapide' : 'Activer le mode rapide';
    $('sound-button').setAttribute('aria-pressed', String(sound));
    $('sound-button').setAttribute('aria-label', sound ? 'Couper le son' : 'Activer le son');
    $('sound-button').title = sound ? 'Couper le son' : 'Activer le son';
    $('sound-button').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 5-5 4H3v6h3l5 4V5Z${sound ? 'm4 3c3 2 3 6 0 8m3-11c5 4 5 10 0 14' : 'm5 4 5 6m0-6-5 6'}"/></svg>`;
    $('spin-label').textContent = encounterActive ? 'LE PACTE…' : busy ? 'EN MER…' : state.inBonus ? 'TOUR GRATUIT' : 'LANCER';
    $('spin-label').classList.toggle('small-spin-label', state.inBonus);
    $('mode-label').textContent = demoOriginal ? 'DÉMONSTRATION DU BONUS' : showingBonus ? 'LA MALÉDICTION EST ACTIVE' : 'LA MALÉDICTION DU CAPITAINE';
    $('bonus-counter').hidden = !showingBonus;
    $('bonus-counter').querySelector('strong').textContent = animationResult ? animationResult.oldFreeSpins : state.freeSpins;
    $('demo-button').hidden = state.inBonus || !!demoOriginal || summaryPending;
    $('bonus-overline').textContent = demoOriginal ? 'DÉMO · SOLDE DE TEST' : showingBonus ? 'LES PROFONDEURS VOUS APPARTIENNENT' : 'LE BONUS DES PROFONDEURS';
    $('bonus-title').textContent = showingBonus ? (shownLocks.length ? `${shownLocks.length} rouleau${shownLocks.length > 1 ? 'x' : ''} figé${shownLocks.length > 1 ? 's' : ''}. La malédiction continue.` : 'Le prochain joker peut tout changer.') : 'Un joker apparaît. Un rouleau se fige.';
    $('bonus-description').textContent = showingBonus ? `Mise conservée : ${money(state.bonusBet ?? state.bet)} · Tours gratuits · Les rouleaux figés restent des jokers.` : 'En tours gratuits, les jokers des rouleaux 2, 3 et 4 s’étendent et restent jusqu’à la fin.';
    updateAutoUI();
  }

  function status(text) { $('status-text').textContent = text; }

  function updateAutoUI() {
    const run = autoRun.getState();
    $('auto-button').disabled = !run.active && (busy || state.inBonus || !!demoOriginal || summaryPending || state.balance < state.bet);
    $('auto-button').setAttribute('aria-pressed', String(run.active));
    $('auto-button').setAttribute('aria-label', run.active ? 'Arrêter les tours automatiques' : 'Tours automatiques');
    $('auto-button').title = run.active ? 'Arrêter après le tour en cours' : 'Choisir une série automatique';
    $('auto-button').querySelector('.auto-icon').textContent = run.active ? '■' : '↻';
    $('auto-button-label').textContent = run.active ? `${run.remaining}/${run.total}` : 'AUTO';
    $('keyboard-hint').innerHTML = `<kbd>ESPACE</kbd> pour ${run.active ? 'arrêter' : 'lancer'}`;
    $('auto-session-bar').hidden = !showAutoStatus;
    $('auto-session-bar').classList.toggle('running', run.active && !run.paused);
    $('auto-stop-button').hidden = !run.active;
    document.querySelectorAll('[data-stop-auto]').forEach(button => { button.hidden = !run.active; });
    $('auto-bonus-note').hidden = !run.active;
    const reasons = { complete: 'Série terminée', user: 'Série arrêtée', funds: 'Solde insuffisant', hidden: 'Série arrêtée : onglet quitté', error: 'Série interrompue' };
    const label = run.active ? run.paused ? (run.pauseReason === 'summary' ? 'Bilan du bonus' : 'En attente du bonus') : state.inBonus ? 'Tours gratuits en cours' : 'Pilote automatique' : reasons[run.lastStopReason] || 'Série arrêtée';
    $('auto-session-text').textContent = `${label} · ${run.completed} / ${run.total} tours payants lancés`;
  }

  function stopAuto(reason = 'user') {
    clearTimeout(autoTimer);
    autoTimer = null;
    if (autoRun.getState().active) autoRun.stop(reason);
    updateUI();
  }

  function queueAutoSpin() {
    clearTimeout(autoTimer);
    autoTimer = null;
    const run = autoRun.getState();
    if (!run.active || run.paused || busy || summaryPending || document.querySelector('dialog[open]')) return;
    if (!state.inBonus && run.remaining === 0) { stopAuto('complete'); return; }
    if (!state.inBonus && state.balance < state.bet) { stopAuto('funds'); return; }
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (autoRun.canSpin({ inBonus: state.inBonus, balance: state.balance, bet: state.bet })) spin({ automatic: true });
    }, reducedMotion ? 100 : rapid ? 280 : 700);
  }

  function updateAutoSelection() {
    document.querySelectorAll('[data-auto-count]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.autoCount) === selectedAutoCount)));
    $('auto-stake-value').textContent = money(state.bet);
    $('auto-budget-value').textContent = money(state.bet * selectedAutoCount);
    $('start-auto-button').innerHTML = `LANCER ${selectedAutoCount} TOURS <span>↻</span>`;
  }

  function openAuto() {
    if (autoRun.getState().active) { stopAuto('user'); return; }
    if (busy || state.inBonus || demoOriginal || summaryPending) return;
    updateAutoSelection();
    $('auto-dialog').showModal();
  }

  function playTone(frequency, duration = .09, type = 'sine', volume = .035, delay = 0) {
    if (!sound) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + delay;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + .008);
      gain.gain.exponentialRampToValueAtTime(.001, start + duration);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start + duration + .02);
    } catch (_) { /* Audio is optional; the game still works without it. */ }
  }

  function chime(kind) {
    if (soundBank.play(kind)) return;
    const notes = kind === 'freeze' ? [440, 660, 880] : kind === 'bonus' ? [294, 370, 440, 587, 740] : [392, 494, 587];
    notes.forEach((note, index) => playTone(note, .28, 'sine', .045, index * .10));
  }

  async function animateRoll(result, oldLocks) {
    const landingGrid = result.surpriseTriggered ? result.preInterventionGrid : result.grid;
    const columns = [...$('reels').children];
    const start = performance.now();
    const baseDuration = reducedMotion ? 70 : rapid ? 260 : 850;
    const stagger = reducedMotion ? 15 : rapid ? 70 : 190;
    const rollIds = ['skull', 'chest', 'compass', 'anchor', 'rum', 'ten', 'wild'];
    columns.forEach((column, reel) => {
      column.classList.remove('landing', 'new-lock');
      column.querySelectorAll('.winning').forEach(cell => cell.classList.remove('winning'));
      if (!oldLocks.includes(reel)) column.classList.add('spinning');
    });
    const interval = setInterval(() => {
      if (columns.some(column => column.classList.contains('spinning'))) soundBank.play('tick', { volume: .7, rate: rapid ? 1.2 : 1 });
      columns.forEach((column, reel) => {
        if (!column.classList.contains('spinning')) return;
        const shift = Math.floor((performance.now() - start) / 70) + reel;
        drawColumn(reel, Array.from({ length: 3 }, (_, row) => rollIds[(shift + row * 2) % rollIds.length]), oldLocks);
      });
    }, 80);
    try {
      await Promise.all(columns.map(async (column, reel) => {
        if (!oldLocks.includes(reel)) await wait(baseDuration + reel * stagger);
        column.classList.remove('spinning');
        drawColumn(reel, landingGrid[reel], result.lockedReels);
        if (!oldLocks.includes(reel)) {
          column.classList.add('landing');
          if (!soundBank.play('stop', { volume: rapid ? .8 : 1 })) playTone(95, .10, 'sine', .02);
        }
        if (result.newLocks.includes(reel)) {
          column.classList.add('new-lock');
          chime('freeze');
        }
      }));
    } finally { clearInterval(interval); }
    [...$('reel-labels').children].forEach((label, reel) => label.classList.toggle('is-locked', result.lockedReels.includes(reel)));
  }

  function swordSound() {
    if (!sound) return;
    if (soundBank.play('sword')) return;
    playTone(70, .35, 'triangle', .07);
    try {
      const length = Math.floor(audioContext.sampleRate * .25);
      const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / length);
      const noise = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      noise.buffer = buffer; filter.type = 'bandpass'; filter.Q.value = .6;
      filter.frequency.setValueAtTime(3000, audioContext.currentTime);
      filter.frequency.exponentialRampToValueAtTime(300, audioContext.currentTime + .25);
      gain.gain.value = .13;
      noise.connect(filter); filter.connect(gain); gain.connect(audioContext.destination);
      noise.start();
    } catch (_) { /* The visual strike does not depend on audio support. */ }
  }

  async function animateCaptain(result) {
    const scene = $('captain-event');
    const actor = $('captain-figure');
    const blade = $('sword-swipe');
    const sparks = $('strike-sparks');
    const workingGrid = result.preInterventionGrid.map(column => [...column]);
    skipEncounter = reducedMotion;
    encounterActive = true;
    $('slot-frame').scrollIntoView({ block: 'center', behavior: reducedMotion ? 'instant' : 'smooth' });
    scene.hidden = false;
    scene.classList.remove('departing');
    $('captain-caption').textContent = 'Le pacte du capitaine';
    $('captain-progress').textContent = 'Le capitaine a choisi votre navire.';
    // Start the entrance from a painted, off-screen pose.
    void scene.offsetWidth;
    document.body.classList.add('captain-boarding');
    updateUI();
    status('Le capitaine surgit des abysses…');
    soundBank.play('draw');
    playTone(55, .9, 'sine', .07);
    try {
      if (!skipEncounter) await wait(950);
      for (const [index, { reel, row }] of result.surprisePositions.entries()) {
        if (skipEncounter) break;
        const column = $('reels').children[reel];
        const target = column.querySelector(`[data-row="${row}"]`);
        const cellRect = target.getBoundingClientRect();
        const frameRect = $('slot-frame').getBoundingClientRect();
        for (const effect of [blade, sparks]) {
          effect.style.setProperty('--hit-x', `${cellRect.left - frameRect.left + cellRect.width / 2}px`);
          effect.style.setProperty('--hit-y', `${cellRect.top - frameRect.top + cellRect.height / 2}px`);
        }
        actor.classList.remove('attacking'); blade.classList.remove('striking'); sparks.classList.remove('burst');
        void blade.offsetWidth;
        actor.classList.add('attacking'); blade.classList.add('striking');
        globalThis.SeabyssAtmosphere?.strike(reel);
        swordSound();
        await wait(190);
        workingGrid[reel][row] = 'scatter';
        drawColumn(reel, workingGrid[reel], []);
        column.classList.add('captain-hit');
        column.querySelector(`[data-row="${row}"]`).classList.add('planted-scatter');
        sparks.classList.add('burst');
        $('captain-progress').textContent = `Rouleau ${reel + 1} frappé · Un Scatter apparaît !`;
        status(`Coup d’épée ${index + 1} sur ${result.surprisePositions.length} : le capitaine place un Scatter.`);
        playTone(420 + index * 130, .27, 'sine', .045);
        await wait(650);
        column.classList.remove('captain-hit');
      }
      result.grid.forEach((column, reel) => {
        drawColumn(reel, column, []);
        column.forEach((id, row) => { if (id === 'scatter') $('reels').children[reel].querySelector(`[data-row="${row}"]`).classList.add('planted-scatter'); });
      });
      $('captain-caption').textContent = 'Le pacte est scellé.';
      $('captain-progress').textContent = `${result.scatterCount} SCATTERS · ${result.awardedFreeSpins} TOURS GRATUITS`;
      status(`Le capitaine vous offre ${result.awardedFreeSpins} tours gratuits !`);
      chime('bonus');
      if (!skipEncounter) await wait(1050);
      else await wait(reducedMotion ? 150 : 100);
      scene.classList.add('departing');
      if (!skipEncounter) await wait(450);
    } finally {
      scene.hidden = true;
      scene.classList.remove('departing');
      actor.classList.remove('attacking'); blade.classList.remove('striking'); sparks.classList.remove('burst');
      document.body.classList.remove('captain-boarding');
      encounterActive = false;
      updateUI();
    }
  }

  function demoGrid() {
    // Explicit demo mode introduces a wild on each central reel over three tours.
    const result = E.generateGrid();
    const tour = (state.bonusSpinsAwarded || 10) - state.freeSpins;
    if ([0, 2, 4].includes(tour)) result[1 + tour / 2][1] = 'wild';
    return result;
  }

  async function spin(options = {}) {
    if (busy || summaryPending || document.querySelector('dialog[open]')) return;
    const automatic = options.automatic === true;
    if (autoRun.getState().active && !automatic) return;
    if (automatic && !autoRun.canSpin({ inBonus: state.inBonus, balance: state.balance, bet: state.bet })) return;
    if (!automatic) showAutoStatus = false;
    let result;
    const oldLocks = [...state.lockedReels];
    const wasBonus = state.inBonus;
    const oldFreeSpins = state.freeSpins;
    const engineOptions = options.surpriseDemo === true && demoOriginal?.kind === 'captain'
      ? { forcedGrid: initialGrid.map(column => column.map(id => id === 'scatter' ? 'compass' : id)), forceSurprise: true }
      : demoOriginal && wasBonus ? { forcedGrid: demoGrid() } : {};
    try {
      if (!demoOriginal) state.balance = globalThis.CasinoWallet.read();
      result = E.spin(state, engineOptions);
      if (!demoOriginal) result.state.balance = globalThis.CasinoWallet.adjust(result.state.balance - state.balance);
    }
    catch (error) {
      if (automatic) stopAuto(error.code === 'INSUFFICIENT_BALANCE' ? 'funds' : 'error');
      status(error.code === 'INSUFFICIENT_BALANCE' ? 'Solde insuffisant. Diminuez la mise ou commencez une nouvelle session.' : 'Ce tour n’a pas pu démarrer. Réessayez.');
      return;
    }
    if (automatic && !wasBonus) autoRun.consumePaidSpin();
    busy = true;
    animationResult = { totalWin: result.totalWin, wasBonus, oldLocks, oldFreeSpins };
    $('win-flash').classList.remove('visible');
    // Resolve and save the complete outcome before animation, including an earned bonus.
    state = result.state;
    grid = result.grid;
    visualLocks = result.lockedReels;
    summaryPending = result.bonusEnded;
    persist();
    updateUI();
    status(wasBonus ? 'Les profondeurs retiennent leur souffle…' : 'Cap sur les trésors engloutis…');
    playTone(80, .22, 'triangle', .055);
    await animateRoll(result, oldLocks);
    if (result.surpriseTriggered) await animateCaptain(result);
    animationResult = null;
    if (!demoOriginal) state.balance = globalThis.CasinoWallet.read();
    busy = result.bonusTriggered;
    updateUI();
    result.wins.forEach(win => win.positions.forEach(({ reel, row }) => $('reels').children[reel].querySelector(`[data-row="${row}"]`).classList.add('winning')));
    if (result.totalWin > 0) {
      chime('win');
      status(`${money(result.totalWin)} de butin · ${result.wins.length} ligne${result.wins.length > 1 ? 's gagnantes' : ' gagnante'}${result.newLocks.length ? ' · Nouveau rouleau figé !' : ''}`);
      if (result.totalWin >= result.bet * 5) {
        $('win-flash').querySelector('strong').textContent = money(result.totalWin);
        $('win-flash').classList.add('visible');
      }
    } else if (result.newLocks.length) {
      status(`Rouleau${result.newLocks.length > 1 ? 'x' : ''} ${result.newLocks.map(reel => reel + 1).join(' et ')} figé${result.newLocks.length > 1 ? 's' : ''} jusqu’à la fin du bonus.`);
    } else {
      status(wasBonus ? `${state.freeSpins} tour${state.freeSpins > 1 ? 's' : ''} gratuit${state.freeSpins > 1 ? 's' : ''} restant${state.freeSpins > 1 ? 's' : ''}. Les jokers figés vous accompagnent.` : 'Le trésor reste englouti. Prêt pour une nouvelle plongée ?');
    }
    if (result.bonusTriggered) {
      if (autoRun.getState().active) autoRun.pause('bonus');
      status(result.surpriseTriggered ? `Le capitaine vous offre ${result.awardedFreeSpins} tours gratuits !` : `${result.scatterCount} bateaux ! Vous remportez ${result.awardedFreeSpins} tours gratuits.`);
      chime('bonus');
      await wait(reducedMotion ? 50 : 650);
      openBonus(false, result.surpriseTriggered);
      busy = false;
      updateUI();
    } else if (result.bonusEnded) {
      if (autoRun.getState().active) autoRun.pause('summary');
      await wait(reducedMotion ? 50 : 850);
      $('summary-amount').textContent = money(state.bonusWin);
      $('summary-note').textContent = demoOriginal ? 'Fin de la démonstration. Votre solde initial sera restauré.' : 'Votre butin a été ajouté au solde. Les rouleaux figés sont libérés.';
      $('summary-dialog').showModal();
    } else if (!state.inBonus && state.balance < state.bet) {
      status(state.balance >= E.BETS[0] ? 'Solde inférieur à la mise. Diminuez-la pour poursuivre le voyage.' : 'Fin du voyage. « Nouvelle session » vous redonne 100,00 $ fictifs.');
    }
    updateAutoUI();
    queueAutoSpin();
  }

  function openBonus(isDemo, fromCaptain = false) {
    pendingDemo = isDemo;
    if (isDemo) demoScatterCount = 3;
    $('bonus-dialog-overline').textContent = fromCaptain ? 'LE CADEAU DU CAPITAINE' : isDemo ? 'DÉCOUVREZ LE BONUS · DÉMONSTRATION' : 'LA MALÉDICTION S’ÉVEILLE';
    $('demo-note').hidden = !(isDemo || demoOriginal);
    $('cancel-demo-button').hidden = !isDemo;
    $('bonus-dialog-art').innerHTML = art.scatter;
    $('demo-levels').hidden = !isDemo;
    $('auto-bonus-note').hidden = !autoRun.getState().active;
    updateBonusAward(isDemo ? E.getBonusSpins(demoScatterCount) : state.bonusSpinsAwarded || state.freeSpins);
    $('bonus-dialog').showModal();
  }

  function updateBonusAward(award) {
    $('awarded-free-spins').textContent = award;
    const count = award >= 20 ? 5 : award >= 15 ? 4 : 3;
    $('bonus-tier-note').textContent = `${count} SCATTERS${count === 4 ? ' · BONUS RARE' : count === 5 ? ' · BONUS LÉGENDAIRE' : ''}`;
    document.querySelectorAll('[data-demo-scatters]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.demoScatters) === count)));
  }

  function rememberDemo(kind) {
    persist();
    demoOriginal = { kind, state: { ...state, lockedReels: [...state.lockedReels] }, grid: grid.map(column => [...column]), visualLocks: [...visualLocks] };
  }

  function startCaptainDemo() {
    if (autoRun.getState().active || busy || state.inBonus || demoOriginal || summaryPending || document.querySelector('dialog[open]')) return;
    rememberDemo('captain');
    // A demo remains available even when the real local session has no funds.
    state = { ...state, balance: Math.max(state.balance, state.bet) };
    spin({ surpriseDemo: true });
  }

  function finishBonus() {
    $('summary-dialog').close();
    $('win-flash').classList.remove('visible');
    summaryPending = false;
    if (demoOriginal) {
      state = demoOriginal.state;
      grid = demoOriginal.grid;
      visualLocks = demoOriginal.visualLocks;
      demoOriginal = null;
      state.balance = globalThis.CasinoWallet.read();
      status('Démonstration terminée. Votre solde a été restauré. À vous de jouer !');
    } else {
      visualLocks = [];
      status(`La malédiction s’achève. Votre butin : ${money(state.bonusWin)}.`);
    }
    renderGrid();
    updateUI();
    persist();
    if (autoRun.getState().active) {
      autoRun.resume();
      updateUI();
      queueAutoSpin();
    } else $('spin-button').focus();
  }

  function selectRulesTab(tab) {
    const payouts = tab === 'payouts';
    $('rules-panel').hidden = payouts;
    $('payouts-panel').hidden = !payouts;
    $('rules-tab').setAttribute('aria-selected', String(!payouts));
    $('payouts-tab').setAttribute('aria-selected', String(payouts));
  }

  function openRules(tab = 'rules') {
    selectRulesTab(tab);
    $('rules-dialog').showModal();
  }

  function renderPaytable() {
    $('paytable').innerHTML = '<div class="paytable-row header"><span>SYMBOLE</span><span>3</span><span>4</span><span>5</span></div>' + E.SYMBOLS.filter(symbol => symbol.id !== 'scatter').map(symbol => `<div class="paytable-row"><span>${symbolMarkup(symbol.id)}${({ skull: 'Capitaine', chest: 'Trésor', compass: 'Boussole', anchor: 'Ancre', rum: 'Rhum', ten: 'Dix', wild: 'Joker' })[symbol.id]}</span><span>×${symbol.pays[3]}</span><span>×${symbol.pays[4]}</span><span>×${symbol.pays[5]}</span></div>`).join('');
    $('paylines-grid').innerHTML = E.PAYLINES.map((line, i) => `<div class="payline-mini"><svg viewBox="0 0 100 60" role="img" aria-label="Ligne ${i + 1}, rangées ${line.map(row => row + 1).join(', ')}">${[0, 1, 2].map(row => [0, 1, 2, 3, 4].map(reel => `<circle cx="${10 + reel * 20}" cy="${10 + row * 20}" r="2" fill="#37504c"/>`).join('')).join('')}<polyline points="${line.map((row, reel) => `${10 + reel * 20},${10 + row * 20}`).join(' ')}" fill="none" stroke="#d5b579" stroke-width="2"/></svg><span>${i + 1}</span></div>`).join('');
  }

  $('spin-button').addEventListener('click', spin);
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('button,a,input,select,textarea,summary,dialog')) return;
    event.preventDefault();
    if (autoRun.getState().active) stopAuto('user');
    else spin();
  });
  [-1, 1].forEach(direction => $(direction < 0 ? 'bet-down' : 'bet-up').addEventListener('click', () => {
    if (autoRun.getState().active || busy || state.inBonus || demoOriginal) return;
    const index = Math.max(0, Math.min(E.BETS.length - 1, E.BETS.indexOf(state.bet) + direction));
    state = { ...state, bet: E.BETS[index] };
    updateUI(); persist();
    status(`Mise : ${money(state.bet)} par tour · 20 lignes actives.`);
    if (!soundBank.play('click')) playTone(280, .06, 'sine', .02);
  }));
  $('turbo-button').addEventListener('click', () => { rapid = !rapid; updateUI(); persist(); });
  $('sound-button').addEventListener('click', () => { sound = !sound; soundBank.setEnabled(sound); updateUI(); persist(); if (sound) soundBank.play('click'); });
  $('help-button').addEventListener('click', () => openRules());
  $('rules-nav').addEventListener('click', () => openRules());
  $('paytable-button').addEventListener('click', () => openRules('payouts'));
  $('rules-tab').addEventListener('click', () => selectRulesTab('rules'));
  $('payouts-tab').addEventListener('click', () => selectRulesTab('payouts'));
  $('demo-button').addEventListener('click', () => { if (!busy && !state.inBonus) openBonus(true); });
  $('auto-button').addEventListener('click', openAuto);
  $('auto-stop-button').addEventListener('click', () => stopAuto('user'));
  document.querySelectorAll('[data-auto-count]').forEach(button => button.addEventListener('click', () => {
    selectedAutoCount = Number(button.dataset.autoCount);
    updateAutoSelection();
  }));
  $('start-auto-button').addEventListener('click', () => {
    if (busy || state.inBonus || demoOriginal || summaryPending || autoRun.getState().active) return;
    $('auto-dialog').close();
    autoRun.start(selectedAutoCount);
    soundBank.play('click');
    showAutoStatus = true;
    updateUI();
    queueAutoSpin();
  });
  document.querySelectorAll('[data-demo-scatters]').forEach(button => button.addEventListener('click', () => {
    if (!pendingDemo) return;
    demoScatterCount = Number(button.dataset.demoScatters);
    updateBonusAward(E.getBonusSpins(demoScatterCount));
  }));
  $('surprise-demo-button').addEventListener('click', startCaptainDemo);
  $('skip-encounter').addEventListener('click', () => { skipEncounter = true; });
  $('exit-demo-button').addEventListener('click', () => { if (demoOriginal && !busy && !summaryPending) finishBonus(); });
  $('cancel-demo-button').addEventListener('click', () => { pendingDemo = false; $('bonus-dialog').close(); });
  $('bonus-dialog').addEventListener('cancel', event => { if (!pendingDemo) event.preventDefault(); else pendingDemo = false; });
  $('enter-bonus-button').addEventListener('click', () => {
    if (pendingDemo) {
      rememberDemo('bonus');
      state = E.startDemoBonus(state, demoScatterCount);
      visualLocks = [];
    }
    pendingDemo = false;
    $('bonus-dialog').close();
    if (autoRun.getState().active) autoRun.resume();
    renderGrid(); updateUI();
    spin(autoRun.getState().active ? { automatic: true } : {});
  });
  $('finish-bonus-button').addEventListener('click', finishBonus);
  $('summary-dialog').addEventListener('cancel', event => { event.preventDefault(); finishBonus(); });
  $('reset-button').addEventListener('click', () => $('reset-dialog').showModal());
  $('confirm-reset').addEventListener('click', () => {
    if (busy) return;
    stopAuto('user');
    showAutoStatus = false;
    state = E.createState();
    state.balance = globalThis.CasinoWallet.reset();
    grid = initialGrid.map(column => [...column]);
    visualLocks = [];
    summaryPending = false;
    $('reset-dialog').close();
    $('win-flash').classList.remove('visible');
    renderGrid(); updateUI(); persist();
    status('Un nouveau voyage commence avec 100,00 $. Bonne traversée, capitaine.');
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  ['rules-dialog', 'reset-dialog', 'auto-dialog'].forEach(id => $(id).addEventListener('click', event => {
    if (event.target !== $(id)) return;
    const rect = $(id).getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close();
  }));
  document.addEventListener('visibilitychange', () => { if (document.hidden && autoRun.getState().active) stopAuto('hidden'); });
  window.addEventListener('pagehide', () => { clearTimeout(autoTimer); autoRun.stop('hidden'); });

  restore();
  state.balance = globalThis.CasinoWallet.read();
  const casinoLink = document.createElement('a');
  casinoLink.href = 'index.html';
  casinoLink.className = 'casino-return';
  casinoLink.textContent = '← LES MACHINES';
  document.querySelector('.site-header').append(casinoLink);
  const reconcileWallet = () => {
    if (!busy && !demoOriginal) { state.balance = globalThis.CasinoWallet.read(); updateUI(); }
  };
  window.addEventListener('focus', reconcileWallet);
  window.addEventListener('pageshow', reconcileWallet);
  window.addEventListener('storage', event => {
    if (event.key === globalThis.CasinoWallet.key && !busy && !demoOriginal) {
      state.balance = globalThis.CasinoWallet.read(); updateUI();
    }
  });
  soundBank.setEnabled(sound);
  for (const id of ['bonus-dialog', 'summary-dialog']) {
    const stopButton = document.createElement('button');
    stopButton.className = 'quiet-button';
    stopButton.dataset.stopAuto = '';
    stopButton.textContent = 'Arrêter la série automatique';
    stopButton.hidden = true;
    stopButton.addEventListener('click', () => stopAuto('user'));
    $(id).append(stopButton);
  }
  globalThis.SeabyssAtmosphere?.mount(document.querySelector('.game-area'));
  const captainRules = document.createElement('div');
  captainRules.className = 'rule-item';
  captainRules.innerHTML = '<span>04</span><div><h3>Le pacte du capitaine</h3><p>Après l’arrêt des rouleaux, le capitaine peut planter des bateaux sur les rouleaux centraux jusqu’à atteindre exactement 3 Scatters : 10 tours gratuits vous sont alors offerts. Probabilité de 4 % par tour payé admissible, dès le 4e tour et après au moins 4 tours payés entre deux interventions. Aucun déclenchement pendant un bonus, ni si 3 Scatters sont déjà présents. Les gains sont calculés sur la grille finale après les coups d’épée.</p></div>';
  $('rules-panel').insertBefore(captainRules, $('rules-panel').querySelector('.rules-note'));
  const scatterAwards = document.createElement('div');
  scatterAwards.className = 'scatter-awards';
  scatterAwards.innerHTML = '<div>3 SCATTERS<strong>10</strong>TOURS GRATUITS</div><div>4 SCATTERS<strong>15</strong>TOURS GRATUITS<small>RARE</small></div><div>5 SCATTERS<strong>20</strong>TOURS GRATUITS<small>LÉGENDAIRE</small></div>';
  $('payouts-panel').prepend(scatterAwards);
  const soundCredits = document.createElement('p');
  soundCredits.className = 'sound-credit';
  soundCredits.innerHTML = 'Effets sonores : <a href="https://kenney.nl/assets/interface-sounds" target="_blank" rel="noopener noreferrer">Interface Sounds</a>, <a href="https://kenney.nl/assets/rpg-audio" target="_blank" rel="noopener noreferrer">RPG Audio</a>, <a href="https://kenney.nl/assets/music-jingles" target="_blank" rel="noopener noreferrer">Music Jingles</a> et <a href="https://kenney.nl/assets/impact-sounds" target="_blank" rel="noopener noreferrer">Impact Sounds</a> par Kenney · Licence CC0.';
  $('rules-dialog').append(soundCredits);
  renderGrid();
  renderPaytable();
  updateUI();
  if (state.inBonus) status(`Voyage repris : ${state.freeSpins} tours gratuits restants, ${state.lockedReels.length} rouleau(x) figé(s).`);
  else if (state.balance < state.bet) status('Diminuez la mise ou commencez une nouvelle session pour jouer.');
})();
