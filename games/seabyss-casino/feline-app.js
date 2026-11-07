(async () => {
  'use strict';
  const E = FelineEngine, wallet = CasinoWallet;
  const $ = id => document.getElementById(id), copy = value => JSON.parse(JSON.stringify(value));
  const money = cents => (cents / 100).toLocaleString('fr-CA', {minimumFractionDigits:2,maximumFractionDigits:2}) + ' $';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ids = ['lion','tiger','leopard','panther','cheetah','ruby','flower','wild','scatter'];
  const symbols = Object.fromEntries(E.SYMBOLS.map(symbol => [symbol.id, symbol]));
  const initial = [['lion','scatter','ruby'],['flower','tiger','leopard'],['cheetah','panther','flower'],['ruby','cheetah','panther'],['leopard','lion','scatter']];
  const key = 'seabyss-feline-session-v1', preferenceKey = 'seabyss-feline-preferences-v1';
  const auto = SeabyssAutoplay.createController(), audio = FelineAudio.create();
  let state = E.createState(), grid = copy(initial), locks = [], intro = false, summary = null, wheelReveal = null;
  let revision = -1, busy = true, demo = null, rapid = false, sound = false, wheelRotation = 0;
  let autoTimer = null, selectedCount = 10, displayedWins = [];
  try {const saved = JSON.parse(localStorage.getItem(preferenceKey)); rapid = saved?.rapid === true; sound = saved?.sound === true;} catch (_) {}
  const hasLocks = () => state.reelLocks.some(turns => turns > 0);
  const pending = () => !!state.pendingWheel || !!wheelReveal || intro || !!summary;
  function savePreferences() {try {localStorage.setItem(preferenceKey, JSON.stringify({rapid,sound}));} catch (_) {}}
  function validGrid(value) {return Array.isArray(value) && value.length === 5 && value.every(col => Array.isArray(col) && col.length === 3 && col.every(id => Object.hasOwn(symbols,id)));}
  function rememberLocal() {return copy({state,grid,locks,intro,summary,wheelReveal,revision});}
  function restoreLocal(saved) {({state,grid,locks,intro,summary,wheelReveal,revision} = saved);}
  function snapshot() {return {...rememberLocal(),revision:revision + 1};}
  function commit(delta = 0) {state.balance = wallet.commitSession(key,snapshot(),delta,revision < 0 ? undefined : revision);revision++;}
  function resetLocal() {state = E.createState({balance:wallet.read()});grid = copy(initial);locks = [];intro = false;summary = null;wheelReveal = null;}

  // Shared credit and the whole result are committed together before any effect plays.
  function loadLatest() {
    const saved = wallet.readSession(key), previous = rememberLocal();
    const validRevision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0;
    if (validRevision && saved.revision === revision) {state.balance = wallet.read();return false;}
    try {
      if (!saved) {resetLocal();revision = 0;commit();return true;}
      revision = validRevision ? saved.revision : 0;
      let valid = validRevision && validGrid(saved.grid);
      try {E.validateState(saved.state);} catch (_) {valid = false;}
      if (!valid) {
        resetLocal();state.balance = wallet.commitSession(key,snapshot(),0,validRevision ? revision : undefined);revision++;
      } else {
        state = copy(saved.state);grid = copy(saved.grid);
        locks = Array.isArray(saved.locks) ? [...new Set(saved.locks.filter(n => Number.isInteger(n) && n >= 0 && n < 5))] : [];
        intro = !!saved.intro && state.inBonus;
        summary = !state.inBonus && saved.summary && Number.isSafeInteger(saved.summary.amount) && saved.summary.amount >= 0 ? copy(saved.summary) : null;
        wheelReveal = saved.wheelReveal && state.lastWheel && saved.wheelReveal.index === state.lastWheel.index && !state.pendingWheel ? copy(state.lastWheel) : null;
      }
      state.balance = wallet.read();return true;
    } catch (error) {restoreLocal(previous);revision = -1;throw error;}
  }
  const art = id => `<span class="symbol-art" style="--sprite-x:${(ids.indexOf(id)%3)*50}%;--sprite-y:${Math.floor(ids.indexOf(id)/3)*50}%" aria-hidden="true"></span>`;
  const scratch = '<svg class="claw-scratch" viewBox="0 0 100 300" preserveAspectRatio="none" aria-hidden="true"><path d="M18 15 Q35 150 24 285"/><path d="M48 8 Q65 145 54 292"/><path d="M78 18 Q94 150 84 282"/></svg>';
  function drawColumn(col, values, held = locks) {
    const reel = $('reels').children[col];reel.classList.toggle('held',held.includes(col));
    reel.innerHTML = values.map((id,row) => `<div class="feline-cell" data-row="${row}" role="img" aria-label="${symbols[id].name}${held.includes(col) ? ', rouleau joker' : ''}">${art(id)}${id==='wild' ? '<span class="symbol-tag">JOKER</span>' : id==='scatter' ? '<span class="symbol-tag scatter-tag">ROUE</span>' : ''}</div>`).join('') + scratch + (held.includes(col) ? `<span class="held-tag">${state.reelLocks[col] ? 'ENCORE 1 TOUR' : 'DERNIER TOUR'}</span>` : '');
  }
  function draw() {grid.forEach((col,index) => drawColumn(index,col));}
  function clearWins() {displayedWins = [];$('wins-list').innerHTML = '';}
  function renderGuardians() {
    [...$('guardians').children].forEach((guardian,col) => {
      guardian.classList.toggle('guarding',state.reelLocks[col] > 0);
      guardian.setAttribute('aria-label',`${symbols[ids[col]].name}${state.reelLocks[col] ? ' : encore un tour joker' : ''}`);
      const label = guardian.querySelector('.guardian-turns');if (label) label.textContent = state.reelLocks[col] ? 'ENCORE 1 TOUR' : '';
    });
    $('lock-note').textContent = hasLocks() ? 'Griffure active · encore 1 tour · mise conservée' : 'Chaque félin veille sur son rouleau';
  }
  function ui() {
    const run = auto.getState(), fixed = busy || !!demo || state.inBonus || hasLocks() || run.active || pending();
    CasinoRewards.setBusy(busy || !!demo || run.active);
    $('balance').textContent = money(state.balance);$('bet-value').textContent = money(state.inBonus ? state.bonusBet : state.lockBet || state.bet);
    $('last-win').textContent = money(state.inBonus || summary ? state.bonusWin : state.lastWin || 0);
    $('win-label').textContent = state.inBonus || summary ? 'GAINS DES TOURS GRATUITS' : 'GAIN';
    const demoDone = demo && !state.inBonus && demo.turns >= (demo.kind === 'feature' ? 2 : 1);
    $('spin-button').disabled = busy || pending() || run.active || demoDone || (!state.inBonus && state.balance < state.bet);
    $('spin-label').textContent = busy ? 'EN COURS' : state.inBonus ? 'TOUR GRATUIT' : 'LANCER';
    $('spin-button').setAttribute('aria-label',state.inBonus ? 'Lancer un tour gratuit' : 'Lancer les rouleaux');
    $('bet-picker').disabled = fixed;$('bet-down').disabled = fixed || state.bet === E.BETS[0];$('bet-up').disabled = fixed || state.bet === E.BETS.at(-1);
    $('demo-button').disabled = fixed;$('rules-button').disabled = busy || run.active;$('paytable-button').disabled = busy || run.active;
    $('auto-button').disabled = !run.active && (busy || !!demo || pending() || (!state.inBonus && state.balance < state.bet));
    $('auto-button').setAttribute('aria-pressed',String(run.active));$('auto-label').textContent = run.active ? 'ARRÊTER' : 'AUTO';
    $('rapid-button').setAttribute('aria-pressed',String(rapid));$('sound-button').setAttribute('aria-pressed',String(sound));
    $('sound-button').setAttribute('aria-label',sound ? 'Couper le son' : 'Activer le son');$('sound-button').textContent = sound ? '♫' : '♪';
    $('demo-bar').hidden = !demo;$('exit-demo').disabled = busy;$('free-counter').hidden = !state.inBonus;$('free-count').textContent = state.freeSpins;
    $('mode-label').textContent = demo ? 'DÉMONSTRATION' : state.inBonus ? 'LA CHASSE AUX TRÉSORS' : '20 LIGNES · DE GAUCHE À DROITE';
    $('auto-progress').hidden = !run.active;$('auto-progress-text').textContent = `${run.completed} / ${run.total} tours payants${run.paused ? ' · en pause' : ''}`;
    $('spin-wheel').disabled = busy || !state.pendingWheel;$('continue-wheel').disabled = busy || !wheelReveal;
    document.body.classList.toggle('bonus-active',state.inBonus);document.body.classList.toggle('is-rolling',busy);renderGuardians();
  }
  function status(value) {$('status-text').textContent = value;}
  function wheelText(receipt) {return receipt.type === 'free' ? '10 TOURS GRATUITS' : `${symbols[receipt.symbol].name} · ${money(receipt.amount)}`;}
  function pointWheel(index) {wheelRotation = (360 - index * 36) % 360;$('wheel-disc').style.transition = 'none';$('wheel-disc').style.transform = `rotate(${wheelRotation}deg)`;}
  function showPending() {
    if (state.pendingWheel || wheelReveal) {
      $('spin-wheel').hidden = !!wheelReveal;$('continue-wheel').hidden = !wheelReveal;
      $('wheel-result').textContent = wheelReveal ? wheelText(wheelReveal) : 'La roue choisit votre trésor.';
      if (wheelReveal) pointWheel(wheelReveal.index);
      if (!$('wheel-dialog').open) $('wheel-dialog').showModal();
    } else if (intro) {
      $('awarded-free-spins').textContent = state.bonusSpinsAwarded;$('cancel-demo-bonus').hidden = !demo;
      if (!$('bonus-dialog').open) $('bonus-dialog').showModal();
    } else if (summary) {
      $('summary-amount').textContent = money(summary.amount);$('summary-note').textContent = demo ? 'Démonstration : votre vrai solde reste intact.' : 'Les gains sont déjà dans votre portefeuille.';
      if (!$('summary-dialog').open) $('summary-dialog').showModal();
    }
  }
  function stopAuto(reason = 'user') {clearTimeout(autoTimer);autoTimer = null;auto.stop(reason);ui();}
  function queueAuto() {
    clearTimeout(autoTimer);autoTimer = null;const run = auto.getState();
    if (!run.active || run.paused || busy || pending()) return;
    if (!state.inBonus && (run.remaining === 0 || wallet.read() < state.bet)) {stopAuto();status(run.remaining === 0 ? 'Série automatique terminée.' : 'Série arrêtée : solde insuffisant.');return;}
    autoTimer = setTimeout(() => {autoTimer = null;if (auto.getState().active) spin(true);},rapid ? 260 : 800);
  }
  async function sync() {
    if (busy || demo) return;busy = true;ui();let changed = false;
    try {await wallet.runExclusive(() => {changed = loadLatest();});} catch (_) {status('La synchronisation est momentanément indisponible.');}
    busy = false;state.balance = wallet.read();
    if (changed) {stopAuto('session');clearWins();for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();draw();showPending();}
    ui();queueAuto();
  }
  function clearClaws() {
    for (const guardian of $('guardians').children) guardian.classList.remove('swiping');
    for (const reel of $('reels').children) reel.classList.remove('scratching','rolling','landed');
  }
  async function claw(result) {
    for (const col of result.feature.reels) {
      const guardian = $('guardians').children[col], reel = $('reels').children[col];
      guardian.classList.add('swiping');if (!reduced) reel.classList.add('scratching');audio.play('claw',col);
      status(`${symbols[ids[col]].name} transforme son rouleau pour deux tours !`);
      try {
        for (let row = 0; row < 3; row++) {await sleep(reduced ? 12 : rapid ? 100 : 170);const cell = reel.children[row];cell.innerHTML = art('wild')+'<span class="symbol-tag">JOKER</span>';cell.classList.add('clawed');}
        drawColumn(col,result.grid[col],result.lockedReels);await sleep(reduced ? 10 : 170);
      } finally {guardian.classList.remove('swiping');reel.classList.remove('scratching');}
    }
  }
  async function roll(result, previousLocks) {
    await Promise.all([...$('reels').children].map(async (reel,col) => {
      if (previousLocks[col]) {drawColumn(col,result.baseGrid[col],result.lockedReels);audio.play('hold',col);return;}
      reel.classList.add('rolling');
      const interval = reduced ? null : setInterval(() => drawColumn(col,Array.from({length:3},() => ids[Math.floor(Math.random()*9)]),[]),90);
      try {await sleep(reduced ? 25 : (rapid ? 330 : 610) + col*(rapid ? 45 : 90));} finally {clearInterval(interval);}
      reel.classList.remove('rolling');drawColumn(col,result.baseGrid[col],[]);reel.classList.add('landed');audio.play('stop',col);
    }));
    if (result.scatterCount >= 2) audio.play('scatter',result.scatterCount);
    if (result.feature?.reels?.length) await claw(result);
    draw();clearClaws();
    if (previousLocks.some(Boolean) && !state.reelLocks.some(Boolean) && !result.feature) audio.play('release');
  }
  function demoGrid(scatter = false) {
    const value = [['lion','ruby','flower'],['tiger','lion','leopard'],['cheetah','lion','panther'],['flower','cheetah','tiger'],['leopard','tiger','ruby']];
    if (scatter) for (const col of [0,2,4]) value[col][0] = 'scatter';return value;
  }
  async function spin(automatic = false, forced = null) {
    if (busy || CasinoRewards.isClaiming() || pending() || document.querySelector('dialog[open]')) return;
    if (auto.getState().active && !automatic) return;
    if (demo && !state.inBonus && demo.turns >= (demo.kind === 'feature' ? 2 : 1)) return;
    busy = true;ui();clearWins();let result, wasBonus = false, previousLocks;
    try {
      const settle = () => {
        if (!demo) {loadLatest();if (pending()) return;}if (automatic && !auto.getState().active) return;
        wasBonus = state.inBonus;previousLocks = [...state.reelLocks];const before = state.balance, previous = rememberLocal();
        const options = forced || (demo ? {forcedGrid:demoGrid(),forceFeature:false} : {});
        try {
          result = E.spin(state,options);state = result.state;grid = result.grid;locks = result.lockedReels;
          summary = result.bonusEnded ? {amount:state.bonusWin} : null;
          if (!demo) commit(state.balance-before);else demo.turns++;
        } catch (error) {restoreLocal(previous);result = null;throw error;}
        if (automatic && !wasBonus) auto.consumePaidSpin();
      };
      if (demo) settle();else await wallet.runExclusive(settle);
      if (!result) return;
      if (state.pendingWheel) stopAuto('wheel');else if (summary) auto.pause('bonus');
      audio.play('spin');status(wasBonus ? 'La chasse aux trésors continue…' : 'Les gardiens veillent…');
      await roll(result,previousLocks);displayedWins = result.wins;
      $('wins-list').innerHTML = result.wins.map((win,index) => `<button data-win="${index}">${art(win.symbol)}<span>Ligne ${win.line}</span><strong>+ ${money(win.amount)}</strong></button>`).join('');
      for (const win of result.wins) for (const pos of win.positions) $('reels').children[pos.reel].children[pos.row].classList.add('winning');
      if (result.totalWin) {audio.play('win',result.totalWin/result.bet);status(`${money(result.totalWin)} remportés.`);}
      else status(hasLocks() ? 'Le rouleau joker reste actif au prochain tour.' : 'Les félins gardent leur trésor pour ce tour.');
      if (summary) audio.play('free-end');else if (state.pendingWheel) audio.play('bonus');
    } catch (error) {stopAuto('error');status(error.code === 'INSUFFICIENT_BALANCE' ? 'Solde insuffisant. Diminuez la mise ou récupérez le cadeau disponible.' : 'Ce tour ne peut pas démarrer. Réessayez.');}
    finally {clearClaws();busy = false;if (!demo) state.balance = wallet.read();ui();showPending();queueAuto();}
  }

  // A persisted wheel receipt is shown after reload; CONTINUER never pays a prize.
  async function spinWheel() {
    if (busy || CasinoRewards.isClaiming() || !state.pendingWheel || wheelReveal) return;
    busy = true;stopAuto('wheel');ui();let result;
    try {
      const settle = () => {
        if (!demo) loadLatest();if (!state.pendingWheel || wheelReveal) return;
        const previous = rememberLocal(), before = state.balance;
        try {
          result = E.resolveWheel(state,demo ? {forcedIndex:demo.kind === 'free' ? 1 : 4} : {});
          state = result.state;wheelReveal = copy(state.lastWheel);intro = result.awardedFreeSpins > 0;
          if (!demo) commit(state.balance-before);
        } catch (error) {restoreLocal(previous);result = null;throw error;}
      };
      if (demo) settle();else await wallet.runExclusive(settle);
      if (!result) return;
      $('wheel-result').textContent = 'La roue tourne…';audio.play('wheel');
      const target = (360 - result.index * 36) % 360;
      wheelRotation += (reduced ? 0 : 1800) + ((target - wheelRotation % 360 + 360) % 360);
      const duration = reduced ? 25 : rapid ? 1900 : 3600;
      $('wheel-disc').style.transition = reduced ? 'none' : `transform ${duration}ms cubic-bezier(.12,.68,.12,1)`;
      $('wheel-disc').style.transform = `rotate(${wheelRotation}deg)`;
      await sleep(duration);audio.play(result.awardedFreeSpins ? 'bonus' : 'prize',result.amount/result.bet);
    } catch (_) {status('La roue attend votre retour. Réessayez.');}
    finally {busy = false;if (!demo) state.balance = wallet.read();ui();showPending();}
  }
  async function editSession(action) {
    if (busy || CasinoRewards.isClaiming()) return false;busy = true;ui();let accepted = false;
    try {
      const settle = () => {if (!demo) loadLatest();const previous = rememberLocal();try {accepted = action() !== false;if (accepted && !demo) commit();else if (!accepted) restoreLocal(previous);} catch (error) {restoreLocal(previous);accepted = false;throw error;}};
      if (demo) settle();else await wallet.runExclusive(settle);
    } catch (_) {status('Votre session a changé. Réessayez.');}
    finally {busy = false;if (!demo) state.balance = wallet.read();draw();ui();showPending();}return accepted;
  }
  async function setBet(bet) {
    if (demo || !E.BETS.includes(bet) || state.inBonus || hasLocks() || pending() || auto.getState().active) return;
    await editSession(() => {if (state.inBonus || hasLocks() || pending() || auto.getState().active) return false;state.bet = bet;});
  }
  async function exitDemo() {
    if (!demo || busy) return;for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    demo = null;resetLocal();revision = -1;clearWins();clearClaws();audio.stop();await sync();draw();ui();status('Démonstration terminée. Votre portefeuille retrouve sa valeur réelle.');
  }
  async function beginDemo(kind) {
    if (busy || auto.getState().active || state.inBonus || hasLocks() || pending()) return;
    $('demo-dialog').close();await sync();if (busy || state.inBonus || hasLocks() || pending()) return;
    demo = {kind,turns:0};state = E.createState({bet:state.bet});grid = copy(initial);locks = [];intro = false;summary = null;wheelReveal = null;clearWins();draw();ui();
    $('reels').scrollIntoView?.({block:'center',behavior:reduced?'auto':'smooth'});
    await spin(false,{forcedGrid:demoGrid(kind !== 'feature'),forceFeature:kind === 'feature' ? {reels:[1,3]} : false});
  }
  for (let col = 0; col < 5; col++) {const reel = document.createElement('div');reel.className = 'feline-reel';reel.setAttribute('role','group');reel.setAttribute('aria-label',`Rouleau ${col+1}`);$('reels').append(reel);}
  $('paytable').innerHTML = `<table><thead><tr><th>SYMBOLE</th><th>3</th><th>4</th><th>5</th></tr></thead><tbody>${E.SYMBOLS.filter(s => s.pays[3]).map(s => `<tr><td>${art(s.id)}${s.name}</td>${[3,4,5].map(n => `<td>×${s.pays[n]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const percent = probability => (probability*100).toLocaleString('fr-CA',{maximumFractionDigits:2}) + ' %';
  const freeChance = E.WHEEL_SEGMENTS.filter(segment => segment.type === 'free').reduce((sum,segment) => sum+segment.probability,0);
  $('wheel-prizes').innerHTML = E.WHEEL_SEGMENTS.filter(segment => segment.type === 'cash').map(segment => `<div data-wheel-prize="${segment.index}">${art(segment.symbol)}<strong>${symbols[segment.symbol].name}</strong><br>×${segment.multiplier} la mise · ${percent(segment.probability)}</div>`).join('') + `<div data-wheel-prize="free"><strong>10 tours gratuits</strong><br>${percent(freeChance)} au total</div>`;
  $('wheel-disc').innerHTML = E.WHEEL_SEGMENTS.map((segment,index) => {
    const angle = index*36, rad = angle*Math.PI/180;
    return `<div class="wheel-sector ${segment.type}" data-index="${index}" style="--sector-angle:${angle}deg;left:${50+Math.sin(rad)*34}%;top:${50-Math.cos(rad)*34}%" aria-label="${segment.label}">${segment.type === 'cash' ? art(segment.symbol)+`<strong>×${segment.multiplier}</strong>` : '<strong>10</strong><small>TOURS<br>GRATUITS</small>'}</div>`;
  }).join('');
  $('bet-options').innerHTML = E.BETS.map(value => `<button data-bet="${value}">${money(value)}</button>`).join('');
  $('bet-options').addEventListener('click',event => {const button = event.target.closest('[data-bet]');if (button) {$('bet-dialog').close();return setBet(Number(button.dataset.bet));}});
  $('bet-picker').addEventListener('click',() => {$('bet-options').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.bet)===state.bet)));$('bet-dialog').showModal();});
  $('bet-down').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)-1]));$('bet-up').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)+1]));
  $('spin-button').addEventListener('click',() => spin());$('spin-wheel').addEventListener('click',spinWheel);
  $('continue-wheel').addEventListener('click',async () => {if (busy || !wheelReveal) return;$('wheel-dialog').close();await editSession(() => {if (!wheelReveal) return false;wheelReveal = null;});});
  $('sound-button').addEventListener('click',() => {sound = !sound;audio.setEnabled(sound);if (sound) audio.play('stop');savePreferences();ui();});
  $('rapid-button').addEventListener('click',() => {rapid = !rapid;savePreferences();ui();});$('rules-button').addEventListener('click',() => $('rules-dialog').showModal());$('paytable-button').addEventListener('click',() => $('rules-dialog').showModal());
  $('demo-button').addEventListener('click',() => $('demo-dialog').showModal());
  for (const kind of ['feature','wheel','free']) $('demo-'+kind).addEventListener('click',() => beginDemo(kind));
  $('exit-demo').addEventListener('click',exitDemo);$('cancel-demo-bonus').addEventListener('click',exitDemo);
  $('enter-bonus').addEventListener('click',async () => {if (busy) return;$('bonus-dialog').close();const accepted = await editSession(() => {if (!intro || !state.inBonus || state.pendingWheel || wheelReveal) return false;intro = false;});if (accepted) audio.play('free-start');auto.resume();ui();queueAuto();});
  $('finish-bonus').addEventListener('click',async () => {if (busy) return;$('summary-dialog').close();if (demo) {await exitDemo();return;}await editSession(() => {summary = null;});auto.resume();ui();queueAuto();});
  for (const id of ['wheel-dialog','bonus-dialog','summary-dialog']) $(id).addEventListener('cancel',event => {event.preventDefault();if (demo) exitDemo();});
  function autoBudget() {$('auto-budget').textContent = `${selectedCount} tours à ${money(state.bet)} · ${money(selectedCount*state.bet)} de mises au maximum. Les tours gratuits ne sont pas facturés.`;}
  $('auto-button').addEventListener('click',() => {if (auto.getState().active) {stopAuto();return;}autoBudget();$('auto-dialog').showModal();});
  $('auto-choices').addEventListener('click',event => {const button = event.target.closest('[data-count]');if (!button) return;selectedCount = Number(button.dataset.count);$('auto-choices').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed',String(item===button)));autoBudget();});
  $('start-auto').addEventListener('click',() => {if (busy || demo || pending()) return;$('auto-dialog').close();auto.start(selectedCount);ui();queueAuto();});$('stop-auto').addEventListener('click',() => stopAuto());
  $('wins-list').addEventListener('click',event => {const button = event.target.closest('[data-win]');if (!button || !displayedWins[Number(button.dataset.win)]) return;document.querySelectorAll('.feline-cell').forEach(cell => cell.classList.remove('winning'));for (const pos of displayedWins[Number(button.dataset.win)].positions) $('reels').children[pos.reel].children[pos.row].classList.add('winning');});
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => button.closest('dialog').close()));
  document.addEventListener('keydown',event => {if (event.code==='Space' && !event.repeat && !document.querySelector('dialog[open]') && !/BUTTON|INPUT|TEXTAREA|SELECT|A/.test(event.target.tagName)) {event.preventDefault();if (auto.getState().active) stopAuto();else spin();}});
  document.addEventListener('visibilitychange',() => {if (document.hidden) {stopAuto('hidden');audio.stop();}else sync();});
  window.addEventListener('pagehide',() => {clearTimeout(autoTimer);audio.stop();clearClaws();});
  ['focus','pageshow','casino-wallet-changed'].forEach(event => window.addEventListener(event,sync));window.addEventListener('storage',event => {if (event.key===wallet.key) sync();});
  try {await wallet.runExclusive(loadLatest);} catch (_) {state.balance = wallet.read();status('La sauvegarde est momentanément indisponible.');}
  busy = false;audio.setEnabled(sound);draw();ui();showPending();
})();
