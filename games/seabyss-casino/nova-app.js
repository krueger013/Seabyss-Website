(async () => {
  'use strict';
  const E = NovaEngine, wallet = CasinoWallet, bank = SeabyssSounds, FX = NovaEffects;
  const $ = id => document.getElementById(id);
  const copy = value => JSON.parse(JSON.stringify(value));
  const money = cents => (cents / 100).toLocaleString(globalThis.SeabyssI18n?.locale || 'fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const key = cell => cell.reel * E.ROWS + cell.row;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveKey = 'seabyss-nova-session-v1';
  const auto = SeabyssAutoplay.createController();
  const ids = E.SYMBOLS.filter(symbol => symbol.id !== 'orb').map(symbol => symbol.id);
  const symbols = Object.fromEntries(E.SYMBOLS.map(symbol => [symbol.id, symbol]));
  const initialGrid = [['rocket','planet','robot','crystal'],['planet','rocket','comet','star'],['robot','crystal','planet','orb'],['comet','star','rocket','robot'],['star','planet','orb','comet'],['crystal','robot','comet','rocket']];
  let state = E.createState(), grid = copy(initialGrid), visualOrbs = [];
  let busy = false, rapid = false, sound = false, animation = null, introPending = false, summaryPending = null;
  let demoOriginal = null, demoStep = 0, timer = null, selectedCount = 10, showAutoStatus = false, revision = 0;
  let visibleWins = [], repairedSave = false, repairPending = false, repairRevision;
  const tracks = Object.fromEntries(['charge','lock','jackpot','spin'].map(name => [name, new Audio(`assets/nova/nova-${name}.wav`)]));
  const voices = new Set();
  function play(name, level = 1) {
    if (!sound) return;
    const audio = tracks[name].cloneNode(); audio.volume = .32 * level;
    if (voices.size >= 8) { const oldest = voices.values().next().value; oldest.pause(); voices.delete(oldest); }
    voices.add(audio);
    const release = () => voices.delete(audio);
    audio.addEventListener('ended', release, { once: true }); audio.addEventListener('error', release, { once: true });
    try { audio.play()?.catch(release); } catch (_) { release(); }
  }
  function silence() { bank.stopAll(); for (const audio of voices) audio.pause(); voices.clear(); }
  function orbGrid(orbs) {
    const result = Array.from({ length: E.REELS }, () => Array(E.ROWS).fill(E.EMPTY));
    for (const { reel, row } of orbs) result[reel][row] = 'orb';
    return result;
  }
  function validGrid(value) {
    return Array.isArray(value) && value.length === E.REELS && value.every(column => Array.isArray(column) && column.length === E.ROWS && column.every(id => id === E.EMPTY || symbols[id]?.id === id));
  }
  function payload(nextState = state, nextGrid = grid, nextOrbs = visualOrbs, nextIntro = introPending, nextSummary = summaryPending) {
    return { state:nextState, grid:nextGrid, visualOrbs:nextOrbs, rapid, sound, introPending:nextIntro, summaryPending:nextSummary, revision:revision+1 };
  }
  async function persist(allowBusy = false) {
    if (demoOriginal || (busy && !allowBusy)) return true;
    try {
      // Even a zero-delta save rewrites the shared wallet, so preferences and
      // progress use the same lock as spins, resets and hourly gifts.
      await wallet.runExclusive(() => {
        if (demoOriginal || (busy && !allowBusy)) return;
        repairSavedSession();
        state.balance = wallet.commitSession(saveKey, payload(), 0, revision);
        revision++;
      });
      if (!busy && !demoOriginal) ui();
      return true;
    } catch (error) {
      if (error.code === 'STALE_SESSION' && !busy) await reconcile();
      return false;
    }
  }
  function restore(source) {
    repairPending = false;
    let saved = null;
    try {
      saved = source || wallet.readSession(saveKey) || JSON.parse(localStorage.getItem(saveKey));
      if (!saved) return;
      revision = Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0;
      E.getJackpots(saved.state);
      if (!validGrid(saved.grid)) throw new Error('INVALID_GRID');
      state = saved.state; grid = saved.grid;
      revision = Number.isSafeInteger(saved.revision) ? saved.revision : 0;
      rapid = saved.rapid === true; sound = saved.sound === true;
      introPending = saved.introPending === true && state.inBonus;
      summaryPending = null;
      if (!state.inBonus && saved.summaryPending && Number.isSafeInteger(saved.summaryPending.amount) && saved.summaryPending.amount >= 0 && Number.isInteger(saved.summaryPending.count) && saved.summaryPending.count >= 6 && saved.summaryPending.count <= 24) {
        summaryPending = { amount: saved.summaryPending.amount, count: saved.summaryPending.count, grand: saved.summaryPending.grand === true, grandAmount: Number.isSafeInteger(saved.summaryPending.grandAmount) ? saved.summaryPending.grandAmount : 0 };
      }
      visualOrbs = state.inBonus ? copy(state.bonusCells) : [];
      if (state.inBonus) grid = orbGrid(visualOrbs);
      else if (Array.isArray(saved.visualOrbs)) {
        const seen = new Set();
        visualOrbs = saved.visualOrbs.filter(orb => {
          const valid = orb && Number.isInteger(orb.reel) && orb.reel >= 0 && orb.reel < 6 && Number.isInteger(orb.row) && orb.row >= 0 && orb.row < 4 && Number.isSafeInteger(orb.amount) && orb.amount >= 0 && ['cash','mini','minor','major'].includes(orb.kind) && !seen.has(key(orb));
          if (valid) seen.add(key(orb));
          return valid;
        });
      }
    } catch (_) {
      // Repair display/session data together while retaining the shared balance.
      state = E.createState({balance:wallet.read()}); grid=copy(initialGrid); visualOrbs=[];
      introPending=false; summaryPending=null; repairedSave=true;
      repairRevision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0 ? saved.revision : undefined;
      repairPending = true;
    }
  }
  // Call only inside the caller's existing wallet transaction. Restoration
  // itself never opens a nested lock or writes an unprotected repair.
  function repairSavedSession() {
    if (!repairPending) return;
    state.balance = wallet.commitSession(saveKey, payload(), 0, repairRevision);
    revision++;
    repairPending = false;
  }
  const imageMarkup = id => `<img src="assets/nova/${id}.webp" alt="" draggable="false">`;
  const cell = (reel, row) => $('reels').children[reel].children[row];
  function drawCell(reel, row, id, orb = null) {
    const element = cell(reel, row);
    element.dataset.symbol = id;
    element.classList.toggle('locked', !!orb);
    element.classList.toggle('special', !!orb && orb.kind !== 'cash');
    const label = id === E.EMPTY ? 'Case libre' : symbols[id].name;
    element.setAttribute('aria-label', `${label}${orb ? ` verrouillé, ${orb.kind === 'cash' ? '' : orb.kind.toUpperCase() + ', '}${money(orb.amount)}` : ''}`);
    element.innerHTML = id === E.EMPTY ? '<span class="empty-mark" aria-hidden="true">+</span>' : imageMarkup(id);
    if (orb) {
      const value = document.createElement('span'); value.className = 'orb-value' + (orb.kind !== 'cash' ? ' orb-tier' : ''); value.setAttribute('aria-hidden','true');
      value.classList.toggle('compact-value',money(orb.amount).length>7);
      if (orb.kind === 'cash') value.textContent=money(orb.amount);
      else { const label=document.createElement('b'), amount=document.createElement('small'); label.textContent=orb.kind.toUpperCase(); amount.textContent=money(orb.amount); value.append(label,amount); }
      element.append(value);
      element.insertAdjacentHTML('beforeend','<svg class="orb-lock" viewBox="0 0 12 15" aria-hidden="true"><rect x="2" y="6" width="8" height="7" rx="1.5"/><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2M6 9v2"/></svg>');
      element.title = `${orb.kind === 'cash' ? 'Orbe' : orb.kind.toUpperCase()} : ${money(orb.amount)}`;
    } else element.removeAttribute('title');
  }
  function drawGrid(target = grid, orbs = visualOrbs) {
    const byCell = new Map(orbs.map(orb => [key(orb), orb]));
    target.forEach((column, reel) => column.forEach((id, row) => drawCell(reel, row, id, byCell.get(reel * E.ROWS + row))));
  }
  function status(text) { $('status-text').textContent = text; }
  function ui() {
    CasinoRewards.setBusy(busy || !!demoOriginal || auto.getState().active);
    const run = auto.getState(), display = animation?.before || state;
    const bonus = display.inBonus || (!animation && !!summaryPending);
    const displayedOrbs = animation ? animation.oldOrbs : visualOrbs;
    const jackpots = E.getJackpots(display);
    document.body.classList.toggle('in-bonus', bonus);
    document.body.classList.toggle('is-rolling', busy);
    for (const tier of ['mini','minor','major','grand']) {
      const label=$(`jackpot-${tier}`), text=money(jackpots[tier]);
      label.textContent=text; label.dataset.compact=String(text.length>8);
    }
    $('grand-reserve').textContent=`RÉSERVE +${money(Math.floor(display.reserveUnits/100))}`;
    $('balance').textContent = money(animation ? animation.balance : state.balance);
    $('bet-value').textContent = money(state.inBonus ? state.bonusBet : state.bet);
    $('last-win').textContent = money(animation ? 0 : state.lastWin);
    for (const id of ['balance','last-win']) $(id).dataset.compact=String($(id).textContent.length>9);
    $('win-label').textContent = bonus ? 'GAIN CRÉDITÉ' : 'DERNIER GAIN';
    const fixed = busy || state.inBonus || !!summaryPending || run.active || !!demoOriginal;
    $('spin-button').disabled = busy || introPending || !!summaryPending || run.active || (!state.inBonus && (state.balance < state.bet || !!demoOriginal));
    $('spin-label').textContent = busy ? 'EN ORBITE…' : state.inBonus ? 'RELANCE GRATUITE' : 'LANCER';
    $('bet-down').disabled = fixed || E.BETS.indexOf(state.bet) === 0;
    $('bet-up').disabled = fixed || E.BETS.indexOf(state.bet) === E.BETS.length - 1;
    $('bet-picker').disabled=fixed;
    $('demo-button').disabled = fixed;
    $('demo-button').hidden = bonus || !!demoOriginal;
    $('reset-button').disabled = fixed;
    $('rules-button').disabled = busy || run.active || !!summaryPending;
    $('paytable-button').disabled = busy || run.active || !!summaryPending;
    $('rapid-button').setAttribute('aria-pressed', String(rapid));
    $('sound-button').setAttribute('aria-pressed', String(sound));
    $('sound-button').setAttribute('aria-label', sound ? 'Couper le son' : 'Activer le son');
    $('sound-button').innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 5-5 4H3v6h3l5 4V5Z${sound?'m4 3c3 2 3 6 0 8m3-11c5 4 5 10 0 14':'m5 4 5 6m0-6-5 6'}"/></svg>`;
    $('mode-label').textContent = demoOriginal ? 'SIMULATEUR DE VOL' : bonus ? 'BONUS ORBITAL ACTIF' : 'SYSTÈME EN LIGNE';
    $('grid-caption').textContent = bonus ? `${display.respins} RELANCE${display.respins > 1 ? 'S' : ''} · ${displayedOrbs.length} / 24 ORBES` : '24 CASES / GROUPES DE 5+';
    $('board-bank').hidden=!bonus; $('board-bank').textContent=`COLLECTE ${money(display.bonusTotal)}`;
    $('respin-pips').hidden=!bonus;
    Array.from($('respin-pips').children).forEach((pip,index)=>pip.classList.toggle('active',index<display.respins));
    $('cancel-demo').hidden=!demoOriginal;
    $('mission-eyebrow').textContent = bonus ? 'RELANCES RESTANTES' : 'LE SIGNAL À CAPTER';
    $('respins').hidden = !bonus; $('respins').textContent = display.respins;
    $('mission-title').textContent = bonus ? 'Chaque orbe relance le compteur.' : '6 orbes. Une nouvelle dimension.';
    $('mission-description').textContent = bonus ? 'Nouvel orbe : retour à 3. Une relance vide : −1. Remplissez les 24 cases pour le GRAND.' : 'Sur un même tour, collectez 6 orbes pour verrouiller leurs valeurs et ouvrir le bonus.';
    const count = bonus ? displayedOrbs.length : (animation?.oldGrid || grid).flat().filter(id => id === 'orb').length;
    const max = bonus ? E.CELL_COUNT : E.BONUS_TRIGGER_ORBS;
    $('meter-label').textContent = bonus ? 'CASES VERROUILLÉES' : 'ORBES DÉTECTÉS';
    $('orb-count').textContent = `${Math.min(count, max)} / ${max}`;
    $('orb-progress').setAttribute('aria-valuemax', max); $('orb-progress').setAttribute('aria-valuenow', Math.min(count,max));
    Array.from($('orb-progress').children).forEach((bar, index) => bar.classList.toggle('active', (count / max) * 6 > index));
    $('bonus-bank').hidden = !bonus;
    $('collect-value').textContent = money(display.bonusTotal);
    $('panel-foot-text').textContent = bonus ? 'COLLECTE UNIQUE À LA FIN DU BONUS' : '3 RELANCES · CHAQUE ORBE RELANCE LE COMPTEUR';
    $('demo-bar').hidden = !demoOriginal; $('exit-demo').disabled = busy;
    $('auto-button').disabled = !run.active && (busy || !!summaryPending || !!demoOriginal || (!state.inBonus && state.balance < state.bet));
    $('auto-button').setAttribute('aria-pressed', String(run.active));
    $('auto-button').setAttribute('aria-label', run.active ? 'Arrêter les tours automatiques' : 'Tours automatiques');
    $('auto-icon').textContent = run.active ? '■' : '↻'; $('auto-label').textContent = run.active ? `${run.remaining}/${run.total}` : 'AUTO';
    $('auto-status').hidden = !showAutoStatus; $('stop-auto').hidden = !run.active;
    document.querySelectorAll('[data-stop-auto]').forEach(button => { button.hidden = !run.active; });
    const reasons = { user:'Série arrêtée', complete:'Série terminée', funds:'Solde insuffisant', hidden:'Série arrêtée : onglet quitté', error:'Série interrompue' };
    const label = run.active ? run.paused ? 'Série en pause pour le bonus' : state.inBonus ? 'Relances gratuites en cours' : 'Pilote automatique' : reasons[run.lastStopReason] || 'Série arrêtée';
    $('auto-status-text').textContent = `${label} · ${run.completed} / ${run.total} tours payants lancés`;
  }
  function stopAuto(reason = 'user') { clearTimeout(timer); timer = null; if (auto.getState().active) auto.stop(reason); ui(); }
  function queueAuto() {
    clearTimeout(timer); timer = null;
    const run = auto.getState();
    if (!run.active || run.paused || busy || introPending || summaryPending || document.querySelector('dialog[open]')) return;
    if (!state.inBonus && run.remaining === 0) return stopAuto('complete');
    if (!state.inBonus && wallet.read() < state.bet) return stopAuto('funds');
    timer = setTimeout(() => { timer = null; spin(true); }, reduced ? 70 : rapid ? 260 : 650);
  }
  async function roll(result, oldOrbs, wasBonus) {
    const held = new Map(oldOrbs.map(orb => [key(orb), orb]));
    const landed = new Map(result.lockedOrbs.map(orb => [key(orb), orb]));
    const newKeys = new Set(result.newOrbs.map(key));
    const rolling = Array(E.REELS).fill(true);
    let step = 0;
    document.querySelectorAll('.nova-cell').forEach(element => element.classList.remove('winning','new-orb','landing'));
    for (const reel of $('reels').children) reel.classList.add('spinning');
    function cycle() {
      for (let reel = 0; reel < E.REELS; reel++) if (rolling[reel]) for (let row = 0; row < E.ROWS; row++) {
        if (held.has(reel * E.ROWS + row)) continue;
        const id = wasBonus ? (step + reel + row) % 4 === 0 ? 'orb' : E.EMPTY : ids[(step + reel + row * 2) % ids.length];
        drawCell(reel,row,id);
      }
      step++;
    }
    cycle(); play('spin', .7);
    const interval = setInterval(cycle, 100);
    try {
      await Promise.all(rolling.map(async (_, reel) => {
        await wait(reduced ? 50 + reel * 8 : (rapid ? 270 : 660) + reel * (rapid ? 55 : 115));
        rolling[reel] = false; $('reels').children[reel].classList.remove('spinning');
        let moving = false, orbLanded = false;
        for (let row = 0; row < E.ROWS; row++) {
          const index = reel * E.ROWS + row;
          drawCell(reel,row,result.grid[reel][row],landed.get(index));
          if (!held.has(index)) { moving = true; cell(reel,row).classList.add(newKeys.has(index) ? 'new-orb' : 'landing'); }
          if (newKeys.has(index)) orbLanded = true;
        }
        if (orbLanded) play('lock', rapid ? .65 : .9);
        else if (moving) bank.play('stop', { volume: rapid ? .5 : .7 });
      }));
    } finally { clearInterval(interval); }
  }
  function demoOptions() {
    if (demoOriginal.kind==='groups') {
      demoStep++;
      const target=Array.from({length:6},(_,r)=>Array.from({length:4},(_,y)=>ids[(r+y)%ids.length]));
      for (const [r,y] of [[0,0],[0,1],[1,0],[1,1],[2,1]]) target[r][y]='rocket';
      for (const [r,y] of [[4,0],[4,1],[4,2],[5,0],[5,1],[5,2]]) target[r][y]='star';
      target[3][2]='planet';
      return {forcedGrid:target,forceOrbs:[]};
    }
    if (demoOriginal.kind === 'grand') return { forceOrbs: [{ reel: 5, row: 3, kind:'cash', multiplier:1 }] };
    const orbs = demoStep === 0 ? [{ reel:0,row:1,kind:'mini' },{ reel:1,row:2,kind:'cash',multiplier:2 }] : demoStep === 2 ? [{ reel:4,row:2,kind:'cash',multiplier:3 }] : [];
    demoStep++; return { forceOrbs:orbs };
  }
  function showBonus() { if (!$('bonus-dialog').open) $('bonus-dialog').showModal(); }
  function showSummary() {
    if (!summaryPending) return;
    $('summary-dialog').classList.toggle('grand-win', summaryPending.grand);
    $('summary-eyebrow').textContent = summaryPending.grand ? '24 CASES / CAGNOTTE GRAND REMPORTÉE' : 'COLLECTE ORBITALE TERMINÉE';
    $('summary-title').textContent = summaryPending.grand ? 'SUPERNOVA !' : 'Mission accomplie.';
    $('summary-amount').textContent = money(summaryPending.amount);
    $('summary-orbs').textContent=`${summaryPending.count} / 24`;
    const special=visualOrbs.filter(orb=>orb.kind!=='cash').reduce((sum,orb)=>sum+orb.amount,0);
    $('summary-detail-label').textContent=summaryPending.grand?'CAGNOTTE GRAND':special?'CAGNOTTES INCLUSES':'MISE DU BONUS';
    $('summary-detail-value').textContent=money(summaryPending.grand?summaryPending.grandAmount:special||state.bet);
    $('summary-description').textContent = `${summaryPending.count} orbes collectés${summaryPending.grand ? `, plus le GRAND de ${money(summaryPending.grandAmount)}` : ''}. ${demoOriginal ? 'Démonstration : votre portefeuille reste intact.' : 'Ce gain a été ajouté à votre portefeuille.'}`;
    if (!$('summary-dialog').open) $('summary-dialog').showModal();
    FX.count($('summary-amount'),summaryPending.amount,rapid?350:650);
  }
  async function spin(automatic = false) {
    if (busy || CasinoRewards.isClaiming() || introPending || summaryPending || document.querySelector('dialog[open]')) return;
    const run = auto.getState();
    if (run.active && !automatic) return;
    if (automatic && !auto.canSpin({ inBonus:state.inBonus, balance:wallet.read(), bet:state.bet })) {
      if (run.active && !state.inBonus && wallet.read() < state.bet) stopAuto('funds');
      return;
    }
    if (demoOriginal && !state.inBonus && (demoOriginal.kind!=='groups' || demoStep>0)) return;
    if (!automatic) showAutoStatus = false;
    let result, before;
    FX.reset(); visibleWins=[]; busy = true; ui();
    try {
      const settle = () => {
        if (automatic && !auto.getState().active) return;
        if (!demoOriginal) {
          const latest = wallet.readSession(saveKey);
          if (latest && latest.revision !== revision) restore(latest);
          repairSavedSession();
          state.balance = wallet.read();
          if (introPending || summaryPending) return;
        }
        before = copy(state);
        result = E.spin(state, demoOriginal ? demoOptions() : {});
        if (!demoOriginal) {
          const nextIntro = result.bonusTriggered && !result.bonusEnded;
          const nextSummary = result.bonusEnded ? { amount:result.bonusAward, count:result.lockedOrbs.length, grand:result.grandAwarded, grandAmount:result.grandAmount } : null;
          result.state.balance = wallet.commitSession(saveKey, payload(result.state,result.grid,result.lockedOrbs,nextIntro,nextSummary), result.state.balance - state.balance, revision);
          revision++;
        }
        if (automatic && !before.inBonus) auto.consumePaidSpin();
      };
      if (!demoOriginal) await wallet.runExclusive(settle);
      else settle();
    } catch (error) {
      busy = false;
      if (error.code === 'STALE_SESSION') { await reconcile(); status('Session mise à jour depuis un autre onglet.'); return; }
      if (automatic) stopAuto(error.code === 'INSUFFICIENT_BALANCE' ? 'funds' : 'error');
      status(error.code === 'INSUFFICIENT_BALANCE' ? 'Solde insuffisant. Diminuez votre mise pour continuer.' : 'Le tour ne peut pas démarrer. Réessayez.'); ui(); return;
    }
    if (!result) {
      busy = false; auto.pause('bonus'); drawGrid(); ui();
      if (summaryPending) showSummary(); else if (introPending) showBonus();
      return;
    }
    animation = { before, oldOrbs:before.inBonus ? copy(before.bonusCells) : [], oldGrid:copy(grid), balance:result.state.balance - result.totalWin };
    busy = true; state = result.state; grid = result.grid; visualOrbs = result.lockedOrbs;
    introPending = result.bonusTriggered && !result.bonusEnded;
    summaryPending = result.bonusEnded ? { amount:result.bonusAward, count:result.lockedOrbs.length, grand:result.grandAwarded, grandAmount:result.grandAmount } : null;
    if (introPending || summaryPending) auto.pause('bonus');
    $('wins-list').innerHTML = ''; ui();
    status(before.inBonus ? 'Le radar explore les cases libres…' : 'Transmission en cours…');
    let saved = true;
    try {
      await roll(result, animation.oldOrbs, before.inBonus);
      for (const win of result.wins) for (const { reel,row } of win.positions) cell(reel,row).classList.add('winning');
      visibleWins=result.wins;
      $('wins-list').innerHTML = result.wins.map((win,index) => `<button class="win-chip" data-win-index="${index}" aria-pressed="false" title="Mettre ce groupe en lumière">${imageMarkup(win.symbol)}<span>${win.count} connectés</span><strong>+ ${money(win.amount)}</strong></button>`).join('');
      if (result.newOrbs.length) await FX.collect(result.newOrbs,rapid);
      if (result.baseWin) { bank.play('win',{volume:.6}); await FX.win(result.wins,result.baseWin,result.bet,rapid); }
      if (result.grandAwarded) {
        $('grid-flash').hidden = false; play('jackpot');
        await wait(reduced ? 0 : rapid ? 850 : 1400); $('grid-flash').hidden = true;
      } else if (result.bonusEnded) play('jackpot', .8);
      else if (result.bonusTriggered) play('charge');
      else if (result.newOrbs.some(orb => orb.kind !== 'cash')) play('charge', .7);
    } finally {
      animation = null;
      saved = await persist(true);
      busy = false;
      if (!demoOriginal) state.balance = wallet.read();
      drawGrid(); ui();
      if (!saved) await reconcile();
    }
    if (before.inBonus) FX.bumpRespins(before.respins,state.respins,result.newOrbs.length>0);
    if (!saved) return;
    if (summaryPending) { status(`${money(result.bonusAward)} collectés. Mission terminée.`); showSummary(); }
    else if (introPending) { status(`${result.orbCount} orbes détectés. Le bonus orbital est ouvert !`); showBonus(); }
    else if (before.inBonus) status(result.newOrbs.length ? `${result.newOrbs.length} ${result.newOrbs.length > 1 ? 'nouveaux orbes' : 'nouvel orbe'} · compteur rechargé à 3 · ${money(state.bonusTotal)} à collecter` : `Aucun nouvel orbe · ${state.respins} relance${state.respins > 1 ? 's' : ''} restante${state.respins > 1 ? 's' : ''}`);
    else status(result.totalWin ? `${money(result.totalWin)} · ${result.wins.length} groupe${result.wins.length > 1 ? 's' : ''} connecté${result.wins.length > 1 ? 's' : ''}` : `${result.orbCount} orbe${result.orbCount > 1 ? 's' : ''} sur 6 · aucun groupe gagnant sur ce tour`);
    queueAuto();
  }
  function beginDemo(kind) {
    if (busy || state.inBonus || auto.getState().active || summaryPending) return;
    $('demo-dialog').close();
    FX.reset(); visibleWins=[];
    demoOriginal = { state:copy(state), grid:copy(grid), visualOrbs:copy(visualOrbs), kind };
    demoStep = 0; showAutoStatus = false;
    state = E.createState({ balance:10000, bet:state.bet, reserveUnits:state.reserveUnits });
    if (kind==='groups') {
      visualOrbs=[]; grid=copy(initialGrid); introPending=false; summaryPending=null;
      $('wins-list').innerHTML=''; drawGrid(); ui(); spin(); return;
    }
    state=E.startDemoBonus(state);
    if (kind === 'grand') {
      state.bonusCells = Array.from({ length:23 }, (_, i) => ({ reel:Math.floor(i / 4), row:i % 4, kind:'cash', multiplier:1, amount:state.bet }));
      state.bonusTotal = state.bonusCells.reduce((sum, orb) => sum + orb.amount, 0);
    }
    visualOrbs = copy(state.bonusCells); grid = orbGrid(visualOrbs); introPending = true; summaryPending = null;
    $('wins-list').innerHTML = ''; document.querySelectorAll('.nova-cell').forEach(element => element.classList.remove('winning','new-orb','landing')); drawGrid(); ui(); status('Simulateur de vol actif. Votre portefeuille et votre cagnotte sont protégés.'); showBonus();
  }
  async function exitDemo() {
    if (!demoOriginal || busy) return;
    FX.reset(); visibleWins=[];
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    state = demoOriginal.state; grid = demoOriginal.grid; visualOrbs = demoOriginal.visualOrbs;
    demoOriginal = null; introPending = false; summaryPending = null; state.balance = wallet.read();
    $('wins-list').innerHTML = ''; document.querySelectorAll('.nova-cell').forEach(element => element.classList.remove('winning','new-orb','landing'));
    await reconcile(); drawGrid(); ui(); await persist(); status('Simulation terminée. Votre portefeuille et votre réserve sont intacts.');
  }
  function showRules() { if (!busy && !auto.getState().active && !summaryPending) $('rules-dialog').showModal(); }
  function autoBudget() { $('auto-budget').textContent = `${selectedCount} tours à ${money(state.bet)} · mises prévues : ${money(selectedCount * state.bet)}. Arrêt si le solde devient insuffisant.`; }
  async function reconcile() {
    if (busy || demoOriginal) return;
    let changed = false;
    busy = true; ui();
    try {
      await wallet.runExclusive(() => {
        const latest = wallet.readSession(saveKey);
        if (latest && latest.revision !== revision) {
          clearTimeout(timer); timer = null;
          if (auto.getState().active) auto.stop('user');
          restore(latest); changed = true;
        }
        repairSavedSession();
        state.balance = wallet.read();
      });
    } catch (_) {
      status('Le portefeuille ne peut pas être synchronisé. Réessayez.');
    } finally { busy = false; }
    if (changed) {
      FX.reset(); visibleWins=[];
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      $('wins-list').innerHTML = '';
      document.querySelectorAll('.nova-cell').forEach(element => element.classList.remove('winning','new-orb','landing'));
      drawGrid(); bank.setEnabled(sound);
      if (summaryPending) showSummary(); else if (introPending) showBonus();
      status('Session synchronisée. Votre progression est conservée.');
    }
    state.balance = wallet.read(); ui(); queueAuto();
  }
  try {
    await wallet.runExclusive(() => { restore(); repairSavedSession(); state.balance = wallet.read(); });
  } catch (_) {
    // A temporarily unavailable lock leaves play recoverable; the next spin
    // retries the pending repair inside its own transaction.
    restore(); state.balance = wallet.read();
  }
  state.balance = wallet.read();
  for (let reel=0; reel<E.REELS; reel++) {
    const column = document.createElement('div'); column.className='nova-reel'; column.setAttribute('role','group'); column.setAttribute('aria-label',`Rouleau ${reel+1}`);
    for (let row=0; row<E.ROWS; row++) { const element=document.createElement('div'); element.className='nova-cell'; element.setAttribute('role','img'); column.append(element); }
    $('reels').append(column);
  }
  $('paytable').innerHTML = `<table><thead><tr><th>SYMBOLE</th>${E.CLUSTER_TIERS.map(tier => `<th>${tier.label}</th>`).join('')}</tr></thead><tbody>${E.SYMBOLS.filter(symbol => symbol.id !== 'orb').map(symbol => `<tr><td>${imageMarkup(symbol.id)}${symbol.name}</td>${E.CLUSTER_TIERS.map(tier => `<td>×${String(symbol.pays[tier.min]).replace('.',',')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  $('spin-button').addEventListener('click', () => spin());
  $('wins-list').addEventListener('click', event=>{
    const button=event.target.closest('[data-win-index]');
    if (!button || busy) return;
    const win=visibleWins[Number(button.dataset.winIndex)]; if (!win) return;
    const selected=button.getAttribute('aria-pressed')!=='true';
    $('wins-list').querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button&&selected)));
    FX.focus(selected?win.positions:[]);
  });
  $('bet-options').innerHTML=E.BETS.map(bet=>`<button data-bet="${bet}" aria-pressed="false">${money(bet)}</button>`).join('');
  $('bet-picker').addEventListener('click',()=>{
    if (busy || state.inBonus || auto.getState().active || demoOriginal || summaryPending) return;
    $('bet-options').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.bet)===state.bet)));
    $('bet-dialog').showModal();
  });
  $('bet-options').addEventListener('click',event=>{
    const bet=Number(event.target.closest('[data-bet]')?.dataset.bet);
    if (!E.BETS.includes(bet) || busy || state.inBonus || auto.getState().active || demoOriginal || summaryPending) return;
    state.bet=bet; $('bet-dialog').close(); persist(); ui(); bank.play('click',{volume:.55});
  });
  for (const [id, step] of [['bet-down',-1],['bet-up',1]]) $(id).addEventListener('click', () => {
    if (busy || state.inBonus || auto.getState().active || demoOriginal || summaryPending) return;
    const next = E.BETS[E.BETS.indexOf(state.bet)+step]; if (!next) return;
    state.bet = next; persist(); ui(); bank.play('click',{volume:.55});
  });
  $('rapid-button').addEventListener('click', () => { rapid=!rapid; persist(); ui(); });
  $('sound-button').addEventListener('click', () => { sound=!sound; bank.setEnabled(sound); if (sound) bank.play('click',{volume:.6}); else silence(); persist(); ui(); });
  $('rules-button').addEventListener('click', showRules); $('paytable-button').addEventListener('click', showRules);
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  for (const id of ['bonus-dialog','summary-dialog']) $(id).addEventListener('cancel', event => { event.preventDefault(); if (demoOriginal) exitDemo(); });
  $('cancel-demo').addEventListener('click',exitDemo);
  $('begin-bonus').addEventListener('click', () => { $('bonus-dialog').close(); introPending=false; grid=orbGrid(state.bonusCells); visualOrbs=copy(state.bonusCells); drawGrid(); auto.resume(); ui(); persist(); status('3 relances offertes. Chaque nouvel orbe remet le compteur à 3.'); queueAuto(); });
  $('close-summary').addEventListener('click', () => {
    $('summary-dialog').close();
    FX.reset();
    if (demoOriginal) return exitDemo();
    summaryPending=null; auto.resume(); ui(); persist(); queueAuto();
  });
  $('demo-button').addEventListener('click', () => { if (!busy && !state.inBonus && !auto.getState().active && !summaryPending) $('demo-dialog').showModal(); });
  $('demo-bonus').addEventListener('click', () => beginDemo('bonus')); $('demo-grand').addEventListener('click', () => beginDemo('grand'));
  $('demo-groups').addEventListener('click',()=>beginDemo('groups'));
  $('exit-demo').addEventListener('click', exitDemo);
  $('auto-button').addEventListener('click', () => {
    if (auto.getState().active) return stopAuto();
    if (busy || summaryPending || demoOriginal) return;
    autoBudget(); $('auto-dialog').showModal();
  });
  document.querySelectorAll('[data-auto-count]').forEach(button => button.addEventListener('click', () => {
    selectedCount=Number(button.dataset.autoCount); document.querySelectorAll('[data-auto-count]').forEach(choice => choice.setAttribute('aria-pressed', String(choice===button))); autoBudget();
  }));
  $('start-auto').addEventListener('click', () => {
    if (busy || demoOriginal || summaryPending || auto.getState().active) return;
    $('auto-dialog').close(); auto.start(selectedCount); showAutoStatus=true; ui(); queueAuto();
  });
  $('stop-auto').addEventListener('click', () => stopAuto()); document.querySelectorAll('[data-stop-auto]').forEach(button => button.addEventListener('click', () => stopAuto()));
  $('reset-button').addEventListener('click', () => { if (!busy && !state.inBonus && !demoOriginal && !auto.getState().active && !summaryPending) $('reset-dialog').showModal(); });
  $('confirm-reset').addEventListener('click', async () => {
    if (busy || CasinoRewards.isClaiming()) return;
    $('reset-dialog').close(); await reconcile();
    if (state.inBonus || summaryPending) return;
    busy = true; ui();
    let didReset = false;
    try { didReset = await wallet.runExclusive(() => {
      const latest = wallet.readSession(saveKey);
      if (latest && latest.revision !== revision) restore(latest);
      repairSavedSession();
      if (state.inBonus || summaryPending) return false;
      const previousBalance = wallet.read();
      FX.reset(); visibleWins=[];
      state=E.createState(); grid=copy(initialGrid); visualOrbs=[]; introPending=false; summaryPending=null; showAutoStatus=false;
      state.balance=wallet.commitSession(saveKey,payload(),10000-previousBalance,revision); revision++;
      return true;
    }); }
    catch (_) { busy = false; await reconcile(); status('La session ne peut pas être réinitialisée. Réessayez.'); return; }
    busy = false;
    state.balance = wallet.read();
    if (!didReset) {
      drawGrid(); ui();
      if (summaryPending) showSummary(); else if (introPending) showBonus();
      status('Bonus retrouvé dans un autre onglet. Votre progression est conservée.');
      return;
    }
    $('wins-list').innerHTML=''; document.querySelectorAll('.nova-cell').forEach(element => element.classList.remove('winning','new-orb','landing')); drawGrid(); ui(); status('Nouvelle mission. Votre portefeuille partagé repart à 100 $.');
  });
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT|BUTTON|A/.test(event.target.tagName)) return;
    event.preventDefault(); if (auto.getState().active) stopAuto(); else spin();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopAuto('hidden'); silence(); } else reconcile(); });
  window.addEventListener('casino-wallet-changed', reconcile);
  window.addEventListener('focus', reconcile); window.addEventListener('pageshow', reconcile); window.addEventListener('storage', reconcile);
  drawGrid(); bank.setEnabled(sound); ui();
  if (summaryPending) showSummary(); else if (introPending) showBonus(); else if (state.inBonus) status('Bonus retrouvé. Vos orbes sont conservés ; poursuivez les relances gratuites.');
  else if (state.totalSpins > 0) status(state.lastWin ? `Dernier gain : ${money(state.lastWin)}. Prêt pour une nouvelle mission.` : 'Session retrouvée. Prêt pour une nouvelle mission.');
  if (repairedSave) status('Sauvegarde réparée. Votre solde partagé est conservé.');

  // Locale-only refresh: keep the same wagers, saved session and wallet values.
  window.addEventListener('seabyss:languagechange', () => {
    if (busy) return;
    ui(); autoBudget();
    document.querySelectorAll('#bet-options [data-bet]').forEach(button => { button.textContent = money(Number(button.dataset.bet)); });
  });
})();
