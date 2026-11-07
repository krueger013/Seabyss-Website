(() => {
  'use strict';
  const E = MoonEngine, wallet = CasinoWallet, bank = SeabyssSounds;
  const $ = id => document.getElementById(id);
  const money = cents => (cents / 100).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const copy = value => JSON.parse(JSON.stringify(value));
  const cellKey = ({ reel, row }) => reel * 3 + row;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveKey = 'seabyss-moon-session-v1';
  const auto = SeabyssAutoplay.createController();
  const initialGrid = [['vampire', 'moon', 'ring'], ['potion', 'wolf', 'grimoire'], ['moon', 'scatter', 'vampire'], ['wolf', 'grimoire', 'potion'], ['ring', 'vampire', 'moon']];
  const demoGrid = [['vampire', 'wolf', 'potion'], ['ring', 'moon', 'vampire'], ['moon', 'vampire', 'grimoire'], ['vampire', 'potion', 'ring'], ['moon', 'vampire', 'vampire']];
  let state = E.createState(), grid = copy(initialGrid), visualFrozen = [];
  let busy = false, rapid = false, sound = false, animation = null, summaryPending = false;
  let demoOriginal = null, timer = null, selectedCount = 10, showAutoStatus = false;
  const magic = { spell: new Audio('assets/moon/spell.wav'), freeze: new Audio('assets/moon/freeze.wav') };
  const voices = new Set();
  function magicSound(name, volume = 1) {
    if (!sound) return;
    const clip = magic[name].cloneNode(); clip.volume = (name === 'spell' ? .32 : .27) * volume;
    if (voices.size >= 8) { const oldest = voices.values().next().value; oldest.pause(); voices.delete(oldest); }
    voices.add(clip);
    const release = () => voices.delete(clip);
    clip.addEventListener('ended', release, { once: true }); clip.addEventListener('error', release, { once: true });
    try { clip.play()?.catch(release); } catch (_) { release(); }
  }
  function silenceMagic() { for (const clip of voices) clip.pause(); voices.clear(); }
  function persist() {
    if (demoOriginal) return;
    try { localStorage.setItem(saveKey, JSON.stringify({ state, grid, visualFrozen, rapid, sound })); } catch (_) {}
  }
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(saveKey));
      if (!saved) return;
      E.startDemoBonus(saved.state); E.evaluateGrid(saved.grid, saved.state.bet);
      E.applyFrozenCells(saved.grid, saved.visualFrozen || saved.state.frozenCells);
      state = saved.state; grid = saved.grid; visualFrozen = saved.visualFrozen || state.frozenCells;
      rapid = saved.rapid === true; sound = saved.sound === true;
    } catch (_) { /* Ignore corrupt local saves. */ }
  }
  function imageMarkup(id) { return `<img src="assets/moon/${id}.webp" alt="" draggable="false">`; }
  function cell(reel, row) { return $('reels').children[reel].children[row]; }
  function drawCell(reel, row, id, frozen = false) {
    const element = cell(reel, row);
    element.dataset.symbol = id;
    element.setAttribute('aria-label', `${E.SYMBOLS.find(symbol => symbol.id === id).name}${frozen ? ', case figée' : ''}`);
    element.innerHTML = imageMarkup(id);
    element.classList.toggle('frozen', frozen);
  }
  function drawGrid(targetGrid = grid, locks = visualFrozen) {
    const keys = new Set(locks.map(cellKey));
    targetGrid.forEach((column, reel) => column.forEach((id, row) => drawCell(reel, row, id, keys.has(reel * 3 + row))));
  }
  function status(text) { $('status-text').textContent = text; }
  function ui() {
    CasinoRewards.setBusy(busy || !!demoOriginal || auto.getState().active);
    const run = auto.getState();
    const bonus = animation ? animation.wasBonus : state.inBonus || summaryPending;
    const locks = animation ? animation.oldFrozen : visualFrozen;
    document.body.classList.toggle('in-bonus', bonus);
    $('balance').textContent = money(state.balance - (animation?.totalWin || 0));
    $('bet-value').textContent = money(state.inBonus ? state.bonusBet : state.bet);
    $('last-win').textContent = money(animation ? (animation.wasBonus ? state.bonusWin - animation.totalWin : 0) : bonus ? state.bonusWin : state.lastWin);
    $('win-label').textContent = bonus ? 'GAINS DU BONUS' : 'DERNIER GAIN';
    $('spin-button').disabled = busy || summaryPending || run.active || (demoOriginal?.kind !== 'bonus' && !!demoOriginal) || (!state.inBonus && state.balance < state.bet);
    $('spin-label').textContent = busy ? 'ENVOÛTÉ…' : state.inBonus ? 'TOUR GRATUIT' : 'LANCER';
    const fixed = busy || state.inBonus || summaryPending || run.active || !!demoOriginal;
    $('bet-down').disabled = fixed || E.BETS.indexOf(state.bet) === 0;
    $('bet-up').disabled = fixed || E.BETS.indexOf(state.bet) === E.BETS.length - 1;
    $('demo-button').disabled = fixed;
    $('demo-button').hidden = state.inBonus || summaryPending || !!demoOriginal;
    ['rules-button', 'paytable-button'].forEach(id => { $(id).disabled = busy || run.active || summaryPending; });
    $('reset-button').disabled = busy || run.active || !!demoOriginal || summaryPending;
    $('rapid-button').setAttribute('aria-pressed', String(rapid));
    $('rapid-button').title = rapid ? 'Désactiver le mode rapide' : 'Activer le mode rapide';
    $('sound-button').setAttribute('aria-pressed', String(sound));
    $('sound-button').setAttribute('aria-label', sound ? 'Couper le son' : 'Activer le son');
    $('sound-button').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 5-5 4H3v6h3l5 4V5Z${sound ? 'm4 3c3 2 3 6 0 8m3-11c5 4 5 10 0 14' : 'm5 4 5 6m0-6-5 6'}"/></svg>`;
    $('mode-label').textContent = demoOriginal ? 'DÉMONSTRATION DES SORTS' : bonus ? 'LE PACTE EST ACTIF' : 'SOUS LE SIGNE DE LA LUNE';
    $('bonus-count').hidden = !bonus;
    $('free-spins').textContent = animation ? animation.oldFreeSpins : state.freeSpins;
    $('frozen-count').textContent = `${locks.length} CASE${locks.length > 1 ? 'S' : ''} FIGÉE${locks.length > 1 ? 'S' : ''}`;
    $('strip-eyebrow').textContent = bonus ? 'LE GIVRE PERSISTANT DE MINUIT' : 'LES DEUX VISAGES DE LA SORCIÈRE';
    $('strip-title').textContent = bonus ? (locks.length ? `${locks.length} case${locks.length > 1 ? 's' : ''} figée${locks.length > 1 ? 's' : ''}. La magie grandit.` : 'Chaque sort peut changer la nuit.') : 'Un coup de baguette. Le destin bascule.';
    $('strip-description').textContent = bonus ? 'Les cases ensorcelées restent des jokers jusqu’à la fin du bonus.' : 'Des jokers gelés pour ce tour, ou 3 scatters pour entrer dans le bonus.';
    $('witch-mood').textContent = bonus ? 'Le pacte est scellé.' : visualFrozen.length ? 'Le givre vous accompagne.' : 'La magie veille.';
    $('demo-bar').hidden = !demoOriginal;
    $('exit-demo').disabled = busy;
    $('auto-button').disabled = !run.active && (fixed || state.balance < state.bet);
    $('auto-button').setAttribute('aria-pressed', String(run.active));
    $('auto-button').setAttribute('aria-label', run.active ? 'Arrêter les tours automatiques' : 'Tours automatiques');
    $('auto-icon').textContent = run.active ? '■' : '↻';
    $('auto-label').textContent = run.active ? `${run.remaining}/${run.total}` : 'AUTO';
    $('auto-status').hidden = !showAutoStatus;
    $('stop-auto').hidden = !run.active;
    document.querySelectorAll('[data-stop-auto]').forEach(button => { button.hidden = !run.active; });
    const reasons = { user: 'Série arrêtée', complete: 'Série terminée', funds: 'Solde insuffisant', hidden: 'Série arrêtée : onglet quitté', error: 'Série interrompue' };
    const label = run.active ? run.paused ? 'En attente du bonus' : state.inBonus ? 'Tours gratuits en cours' : 'Pilote automatique' : reasons[run.lastStopReason] || 'Série arrêtée';
    $('auto-status-text').textContent = `${label} · ${run.completed} / ${run.total} tours payants lancés`;
    $('keyboard-hint').innerHTML = `<kbd>ESPACE</kbd> pour ${run.active ? 'arrêter' : 'lancer'}`;
  }
  function stopAuto(reason = 'user') {
    clearTimeout(timer); timer = null;
    if (auto.getState().active) auto.stop(reason);
    ui();
  }
  function queueAuto() {
    clearTimeout(timer); timer = null;
    const run = auto.getState();
    if (!run.active || run.paused || busy || summaryPending || document.querySelector('dialog[open]')) return;
    if (!state.inBonus && run.remaining === 0) return stopAuto('complete');
    if (!state.inBonus && wallet.read() < state.bet) return stopAuto('funds');
    timer = setTimeout(() => { timer = null; spin(true); }, reduced ? 90 : rapid ? 300 : 750);
  }
  async function roll(result, oldFrozen) {
    const keys = new Set(oldFrozen.map(cellKey));
    const landing = result.surpriseTriggered ? result.preInterventionGrid : result.freezeTriggered ? result.preFreezeGrid : result.grid;
    const ids = ['vampire', 'wolf', 'grimoire', 'potion', 'moon', 'ring', 'wild'];
    const rolling = [true, true, true, true, true];
    let step = 0;
    for (const element of $('reels').children) element.classList.add('spinning');
    document.querySelectorAll('.moon-cell').forEach(element => element.classList.remove('winning', 'new-freeze', 'scatter-land', 'landing'));
    drawGrid(landing, oldFrozen);
    for (let reel = 0; reel < 5; reel++) for (let row = 0; row < 3; row++) {
      if (!keys.has(reel * 3 + row)) drawCell(reel, row, ids[(reel + row * 2) % ids.length]);
    }
    const interval = setInterval(() => {
      step++;
      if (!reduced) bank.play('tick', { volume: .35 });
      for (let reel = 0; reel < 5; reel++) if (rolling[reel]) for (let row = 0; row < 3; row++) {
        if (!keys.has(reel * 3 + row)) drawCell(reel, row, ids[(step + reel + row * 2) % ids.length]);
      }
    }, 100);
    try {
      await Promise.all(rolling.map(async (_, reel) => {
        await wait(reduced ? 60 + reel * 12 : (rapid ? 280 : 780) + reel * (rapid ? 65 : 155));
        rolling[reel] = false; $('reels').children[reel].classList.remove('spinning');
        let moving = false;
        for (let row = 0; row < 3; row++) {
          const frozen = keys.has(reel * 3 + row);
          drawCell(reel, row, landing[reel][row], frozen);
          if (!frozen) { cell(reel, row).classList.add('landing'); moving = true; }
        }
        if (moving) bank.play('stop', { volume: rapid ? .65 : .85 });
      }));
    } finally { clearInterval(interval); }
  }
  async function cast(result) {
    const scatter = result.surpriseTriggered;
    const positions = scatter ? result.surprisePositions : result.newFrozenCells;
    if (!positions.length) return;
    $('witch-guardian').classList.add('casting');
    $('spell-caption').hidden = false;
    $('spell-title').textContent = scatter ? 'Le pacte des trois sceaux' : `${positions.length} case${positions.length > 1 ? 's' : ''} ensorcelée${positions.length > 1 ? 's' : ''}`;
    status(scatter ? 'Nyx invoque les sceaux du bonus…' : 'Nyx transforme les cases en cristaux de givre…');
    magicSound('spell');
    try {
      await wait(reduced ? 20 : rapid ? 230 : 550);
      for (const { reel, row } of positions) {
        const target = cell(reel, row);
        if (!reduced) {
          const origin = $('wand-origin').getBoundingClientRect(), rect = target.getBoundingClientRect(), stage = document.querySelector('.moon-stage').getBoundingClientRect();
          const dx = rect.left + rect.width / 2 - origin.left, dy = rect.top + rect.height / 2 - origin.top;
          const beam = document.createElement('i'); beam.className = 'spell-beam';
          beam.style.cssText = `left:${origin.left - stage.left}px;top:${origin.top - stage.top}px;width:${Math.hypot(dx,dy)}px;transform:rotate(${Math.atan2(dy,dx)}rad)`;
          document.querySelector('.moon-stage').append(beam);
          setTimeout(() => beam.remove(), 500);
          await wait(rapid ? 140 : 240);
        }
        drawCell(reel, row, scatter ? 'scatter' : 'wild', !scatter);
        target.classList.add(scatter ? 'scatter-land' : 'new-freeze');
        magicSound('freeze', rapid ? .6 : .85);
        await wait(reduced ? 20 : rapid ? 100 : 230);
      }
      await wait(reduced ? 10 : rapid ? 200 : 470);
    } finally { $('witch-guardian').classList.remove('casting'); $('spell-caption').hidden = true; }
  }
  function demoOptions() {
    const turn = state.bonusSpinsAwarded - state.freeSpins;
    const targets = turn === 0 ? [{ reel: 1, row: 0 }] : turn === 2 ? [{ reel: 3, row: 1 }, { reel: 0, row: 2 }] : turn === 5 ? [{ reel: 4, row: 0 }] : [];
    return { forcedGrid: copy(demoGrid), forceFreezeCells: targets, forceSurprise: false };
  }
  async function spin(automatic = false, forcedOptions = null) {
    if (busy || CasinoRewards.isClaiming() || summaryPending || document.querySelector('dialog[open]')) return;
    const run = auto.getState();
    if (run.active && !automatic) return;
    if (automatic && !auto.canSpin({ inBonus: state.inBonus, balance: wallet.read(), bet: state.bet })) {
      if (run.active && !state.inBonus && wallet.read() < state.bet) stopAuto('funds');
      return;
    }
    if (demoOriginal && demoOriginal.kind !== 'bonus' && !forcedOptions) return;
    if (!automatic) showAutoStatus = false;
    const wasBonus = state.inBonus, oldFrozen = copy(state.frozenCells), oldFreeSpins = state.freeSpins;
    let result;
    busy = true; ui();
    try {
      const settle = () => {
        if (!demoOriginal) state.balance = wallet.read();
        result = E.spin(state, forcedOptions || (demoOriginal && wasBonus ? demoOptions() : {}));
        if (!demoOriginal) result.state.balance = wallet.adjust(result.state.balance - state.balance);
      };
      if (demoOriginal) settle(); else await wallet.runExclusive(settle);
    } catch (error) {
      busy = false;
      if (automatic) stopAuto(error.code === 'INSUFFICIENT_BALANCE' ? 'funds' : 'error');
      status(error.code === 'INSUFFICIENT_BALANCE' ? 'Solde insuffisant. Diminuez la mise pour continuer.' : 'Le tour ne peut pas démarrer. Réessayez.'); ui(); return;
    }
    if (automatic && !wasBonus) auto.consumePaidSpin();
    busy = true; animation = { wasBonus, oldFrozen, oldFreeSpins, totalWin: result.totalWin };
    state = result.state; grid = result.grid; visualFrozen = result.frozenCells; summaryPending = result.bonusEnded;
    persist(); $('wins-list').innerHTML = ''; ui();
    status(wasBonus ? 'La lune nourrit la magie du pacte…' : 'Les créatures de la nuit s’éveillent…');
    await roll(result, oldFrozen);
    if (result.surpriseTriggered || result.freezeTriggered) await cast(result);
    animation = null; drawGrid();
    if (!demoOriginal) state.balance = wallet.read();
    for (const win of result.wins) for (const { reel, row } of win.positions) cell(reel, row).classList.add('winning');
    $('wins-list').innerHTML = result.wins.map(win => `<span class="win-chip" title="Suite depuis le premier rouleau, rangées libres">${imageMarkup(win.symbol)}<span>${win.reelCount} rouleaux · ${win.ways} chemin${win.ways > 1 ? 's' : ''}</span><strong>+ ${money(win.amount)}</strong></span>`).join('');
    const freezeCount = result.newFrozenCells.length;
    const frozenText = `${freezeCount} case${freezeCount > 1 ? 's' : ''} figée${freezeCount > 1 ? 's' : ''}`;
    const freezeNote = result.freezeTriggered ? ` · ${frozenText} ${wasBonus ? 'jusqu’à la fin du bonus' : 'pour ce tour'}` : '';
    if (result.totalWin > 0) {
      bank.play('win', { volume: .8 });
      const paths = result.wins.reduce((total, win) => total + win.ways, 0);
      status(`${money(result.totalWin)} · ${paths} chemin${paths > 1 ? 's' : ''} gagnant${paths > 1 ? 's' : ''}${freezeNote}`);
    }
    else status(result.freezeTriggered ? `${frozenText} ${wasBonus ? 'jusqu’à la fin du bonus.' : 'pour ce tour.'}` : wasBonus ? `${state.freeSpins} tours gratuits restants. Le givre reste en place.` : 'La nuit garde encore ses secrets.');
    if (result.bonusTriggered) {
      if (auto.getState().active) auto.pause('bonus');
      bank.play('bonus', { volume: .65 });
      status(`${result.scatterCount} sceaux : ${result.awardedFreeSpins} tours gratuits vous attendent !`);
      await wait(reduced ? 30 : 500); showBonus(false);
    } else if (result.bonusEnded) {
      if (auto.getState().active) auto.pause('summary');
      await wait(reduced ? 30 : 650);
      $('summary-amount').textContent = money(state.bonusWin);
      $('summary-note').textContent = demoOriginal ? 'Démonstration terminée. Votre solde initial sera restauré.' : 'Vos gains ont été ajoutés au solde. Les cases figées sont libérées.';
      $('summary-dialog').showModal();
    }
    busy = false; ui(); queueAuto();
  }
  function showBonus(resume = false) {
    $('bonus-overline').textContent = demoOriginal ? 'DÉMONSTRATION DU PACTE' : resume ? 'LA NUIT VOUS ATTENDAIT' : 'LE PACTE EST SCELLÉ';
    $('bonus-award').textContent = state.freeSpins;
    $('bonus-award-label').textContent = resume ? 'TOURS RESTANTS' : 'TOURS GRATUITS';
    const scatters = state.bonusSpinsAwarded >= 20 ? 5 : state.bonusSpinsAwarded >= 15 ? 4 : 3;
    $('bonus-tier').textContent = `${scatters} SCATTERS${scatters === 4 ? ' · BONUS RARE' : scatters === 5 ? ' · BONUS LÉGENDAIRE' : ''}`;
    $('bonus-auto-note').hidden = !auto.getState().active;
    $('cancel-demo-bonus').hidden = !demoOriginal;
    $('bonus-dialog').showModal();
  }
  function finishBonus() {
    $('summary-dialog').close(); summaryPending = false;
    if (demoOriginal) return finishDemo();
    visualFrozen = []; state.balance = wallet.read(); drawGrid();
    status(`Le pacte s’achève. Gains du bonus : ${money(state.bonusWin)}.`); persist(); ui();
    if (auto.getState().active) { auto.resume(); ui(); queueAuto(); } else $('spin-button').focus();
  }
  function beginDemo(kind) {
    if (busy || state.inBonus || demoOriginal || auto.getState().active) return;
    $('demo-dialog').close(); persist();
    demoOriginal = { kind: kind === 'bonus' ? 'bonus' : 'freeze', state: copy(state), grid: copy(grid), visualFrozen: copy(visualFrozen) };
    state.balance = Math.max(state.balance, state.bet); visualFrozen = [];
    const targets = kind === 'one' ? [{ reel: 1, row: 0 }] : [{ reel: 0, row: 2 }, { reel: 2, row: 1 }, { reel: 4, row: 0 }];
    spin(false, kind === 'bonus' ? { forcedGrid: copy(demoGrid), forceSurprise: true } : { forcedGrid: copy(demoGrid), forceFreezeCells: targets, forceSurprise: false });
  }
  function finishDemo() {
    if (!demoOriginal || busy) return;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    state = demoOriginal.state; grid = demoOriginal.grid; visualFrozen = demoOriginal.visualFrozen; demoOriginal = null;
    state.balance = wallet.read(); summaryPending = false; $('wins-list').innerHTML = '';
    document.querySelectorAll('.moon-cell').forEach(element => element.classList.remove('winning', 'new-freeze', 'scatter-land'));
    drawGrid(); status('Démonstration terminée. Votre solde est intact.'); persist(); ui();
  }
  function autoSelection() {
    document.querySelectorAll('[data-auto-count]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.autoCount) === selectedCount)));
    $('auto-bet').textContent = money(state.bet); $('auto-total').textContent = money(state.bet * selectedCount);
    $('start-auto').textContent = `LANCER ${selectedCount} TOURS ↻`;
  }
  function openRules(payouts) { $('rules-dialog').showModal(); if (payouts) $('payout-title').scrollIntoView({ block: 'start' }); else $('rules-dialog').scrollTop = 0; }
  $('reels').innerHTML = Array.from({ length: 5 }, (_, reel) => `<div class="moon-reel" role="group" aria-label="Rouleau ${reel + 1}">${Array.from({ length: 3 }, (_, row) => `<div class="moon-cell" role="img" data-row="${row}"></div>`).join('')}</div>`).join('');
  $('spin-button').addEventListener('click', () => spin());
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target.closest('button,a,input,select,textarea,dialog')) return;
    event.preventDefault(); if (auto.getState().active) stopAuto(); else spin();
  });
  for (const direction of [-1, 1]) $(direction < 0 ? 'bet-down' : 'bet-up').addEventListener('click', () => {
    if (busy || state.inBonus || demoOriginal || auto.getState().active || summaryPending) return;
    state.bet = E.BETS[Math.max(0, Math.min(E.BETS.length - 1, E.BETS.indexOf(state.bet) + direction))];
    bank.play('click', { volume: .65 }); ui(); persist();
  });
  $('rapid-button').addEventListener('click', () => { rapid = !rapid; ui(); persist(); });
  $('sound-button').addEventListener('click', () => { sound = !sound; bank.setEnabled(sound); if (!sound) silenceMagic(); else bank.play('click', { volume: .6 }); ui(); persist(); });
  $('rules-button').addEventListener('click', () => openRules(false));
  $('paytable-button').addEventListener('click', () => openRules(true));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('demo-button').addEventListener('click', () => $('demo-dialog').showModal());
  document.querySelectorAll('[data-demo]').forEach(button => button.addEventListener('click', () => beginDemo(button.dataset.demo)));
  $('exit-demo').addEventListener('click', finishDemo); $('cancel-demo-bonus').addEventListener('click', finishDemo);
  $('auto-button').addEventListener('click', () => { if (auto.getState().active) return stopAuto(); autoSelection(); $('auto-dialog').showModal(); });
  document.querySelectorAll('[data-auto-count]').forEach(button => button.addEventListener('click', () => { selectedCount = Number(button.dataset.autoCount); autoSelection(); }));
  $('start-auto').addEventListener('click', () => {
    if (busy || state.inBonus || demoOriginal || auto.getState().active) return;
    $('auto-dialog').close(); auto.start(selectedCount); showAutoStatus = true; ui(); queueAuto();
  });
  $('stop-auto').addEventListener('click', () => stopAuto());
  document.querySelectorAll('[data-stop-auto]').forEach(button => button.addEventListener('click', () => stopAuto()));
  $('enter-bonus').addEventListener('click', () => { $('bonus-dialog').close(); if (auto.getState().active) auto.resume(); ui(); spin(auto.getState().active); });
  $('bonus-dialog').addEventListener('cancel', event => { event.preventDefault(); if (auto.getState().active) stopAuto(); });
  $('finish-bonus').addEventListener('click', finishBonus);
  $('summary-dialog').addEventListener('cancel', event => { event.preventDefault(); finishBonus(); });
  $('reset-button').addEventListener('click', () => $('reset-dialog').showModal());
  $('confirm-reset').addEventListener('click', async () => {
    if (busy || CasinoRewards.isClaiming()) return;
    busy = true; ui(); stopAuto(); showAutoStatus = false; $('reset-dialog').close();
    try { await wallet.runExclusive(() => { state = E.createState(); state.balance = wallet.reset(); }); }
    catch (_) { busy = false; ui(); status("La session ne peut pas être réinitialisée. Réessayez."); return; }
    busy = false; grid = copy(initialGrid); visualFrozen = []; summaryPending = false;
    $('wins-list').innerHTML = ''; drawGrid(); status('Une nouvelle nuit commence avec 100,00 $ fictifs.'); persist(); ui();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (auto.getState().active) stopAuto('hidden'); silenceMagic(); } });
  window.addEventListener('pagehide', () => { clearTimeout(timer); auto.stop('hidden'); silenceMagic(); });
  function reconcile() { if (!busy && !demoOriginal) { state.balance = wallet.read(); ui(); } }
  window.addEventListener('casino-wallet-changed', reconcile);
  window.addEventListener('focus', reconcile); window.addEventListener('pageshow', reconcile); window.addEventListener('storage', event => { if (event.key === wallet.key) reconcile(); });
  const columns = [3, 4, 5];
  $('paytable').innerHTML = `<table><thead><tr><th>SYMBOLE</th>${columns.map(count => `<th>${count}<small>ROULEAUX</small></th>`).join('')}</tr></thead><tbody>${E.SYMBOLS.filter(symbol => symbol.pays[3]).map(symbol => `<tr><td>${imageMarkup(symbol.id)}${({ vampire: 'Vampire', wolf: 'Loup-garou', grimoire: 'Grimoire', potion: 'Potion', moon: 'Lune', ring: 'Anneau' })[symbol.id]}</td>${columns.map(count => `<td>×${String(symbol.pays[count]).replace('.', ',')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  restore(); state.balance = wallet.read(); bank.setEnabled(sound); drawGrid(); ui();
  if (state.inBonus) showBonus(true);
})();
