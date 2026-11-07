(async () => {
  'use strict';
  const E = MedievalEngine, wallet = CasinoWallet;
  const $ = id => document.getElementById(id), copy = value => JSON.parse(JSON.stringify(value));
  const money = cents => (cents / 100).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' $';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ids = ['king','queen','knight','castle','chalice','shield','sword','wild','scatter'];
  const symbols = Object.fromEntries(E.SYMBOLS.map(symbol => [symbol.id, symbol]));
  const initial = [['king','scatter','castle'],['chalice','queen','knight'],['shield','sword','chalice'],['castle','shield','sword'],['knight','king','scatter']];
  const key = 'seabyss-medieval-session-v1', preferenceKey = 'seabyss-medieval-preferences-v1';
  const auto = SeabyssAutoplay.createController(), audio = MedievalAudio.create();
  let state = E.createState(), grid = copy(initial), locks = [], siegeKeys = 0, gatesOpened = 0;
  let revision = 0, busy = true, intro = false, summary = null, demo = null, rapid = false, sound = false;
  let autoTimer = null, selectedCount = 10, displayedWins = [], activeFireReel = null;
  try {const saved = JSON.parse(localStorage.getItem(preferenceKey)); rapid = saved?.rapid === true; sound = saved?.sound === true;} catch (_) {}
  function savePreferences() {try {localStorage.setItem(preferenceKey,JSON.stringify({rapid,sound}));} catch (_) {}}
  function validGrid(value) {return Array.isArray(value) && value.length === 5 && value.every(col => Array.isArray(col) && col.length === 3 && col.every(id => symbols[id]));}
  function rememberLocal() {return copy({state,grid,locks,siegeKeys,gatesOpened,intro,summary,revision});}
  function restoreLocal(saved) {({state,grid,locks,siegeKeys,gatesOpened,intro,summary,revision} = saved);}
  function snapshot() {return {...rememberLocal(),revision:revision + 1};}
  function commit(delta = 0) {state.balance = wallet.commitSession(key,snapshot(),delta,revision);revision++;}
  function loadLatest() {
    const saved = wallet.readSession(key);
    if (!saved) {state = E.createState({balance:wallet.read()});grid = copy(initial);locks = [];siegeKeys = 0;gatesOpened = 0;intro = false;summary = null;revision = 0;commit();return true;}
    const validRevision = Number.isSafeInteger(saved.revision) && saved.revision >= 0;
    if (validRevision && saved.revision === revision) {state.balance = wallet.read();return false;}
    revision = validRevision ? saved.revision : 0;
    try {
      E.validateState(saved.state);
      if (!validRevision || !validGrid(saved.grid) || !Number.isInteger(saved.siegeKeys) || saved.siegeKeys < 0 || saved.siegeKeys > 9 || saved.gatesOpened !== Math.floor(saved.siegeKeys/3)) throw new Error('Invalid session');
      state = copy(saved.state);grid = copy(saved.grid);locks = Array.isArray(saved.locks) ? [...new Set(saved.locks.filter(n => Number.isInteger(n) && n >= 0 && n < 5))].slice(0,2) : [];
      siegeKeys = saved.siegeKeys;gatesOpened = saved.gatesOpened;intro = !!saved.intro && state.inBonus;
      summary = saved.summary && Number.isSafeInteger(saved.summary.amount) && saved.summary.amount >= 0 && Number.isInteger(saved.summary.gates) && saved.summary.gates >= 0 && saved.summary.gates <= 3 ? saved.summary : null;
    } catch (_) {
      state = E.createState({balance:wallet.read()});grid = copy(initial);locks = [];siegeKeys = 0;gatesOpened = 0;intro = false;summary = null;
      state.balance = wallet.commitSession(key,snapshot(),0,validRevision ? revision : undefined);revision++;
    }
    state.balance = wallet.read();return true;
  }
  const art = id => `<span class="symbol-art" style="--sprite-x:${(ids.indexOf(id)%3)*50}%;--sprite-y:${Math.floor(ids.indexOf(id)/3)*50}%" aria-hidden="true"></span>`;
  function drawColumn(col, values, held = locks) {
    const reel = $('reels').children[col];reel.classList.toggle('held',held.includes(col));
    reel.innerHTML = values.map((id,row) => `<div class="royal-cell" data-row="${row}" role="img" aria-label="${symbols[id].name}${held.includes(col) ? ', rouleau embrasé' : ''}">${art(id)}${id==='wild' ? '<span class="symbol-tag">JOKER</span>' : id==='scatter' ? '<span class="symbol-tag scatter-tag">COFFRE</span>' : ''}</div>`).join('') + (held.includes(col) ? '<span class="held-tag">EMBRASÉ</span>' : '');
  }
  function draw() {grid.forEach((col,index) => drawColumn(index,col));}
  function clearWins() {displayedWins = [];$('wins-list').innerHTML = '';}
  function renderGates() {
    [...$('gates').children].forEach((gate,index) => {
      gate.classList.toggle('opened',index < gatesOpened);
      gate.setAttribute('aria-label',`${['Le Rempart','Le Donjon','Le Trésor'][index]} : ${index < gatesOpened ? 'ouvert' : Math.max(0,Math.min(3,siegeKeys-index*3))+' clé(s) sur 3'}`);
      [...gate.querySelectorAll('.gate-keys i')].forEach((pip,at) => pip.classList.toggle('collected',siegeKeys > index*3+at));
    });
    $('siege-description').textContent = state.inBonus || summary ? `${siegeKeys} / 9 clés · ${gatesOpened} / 3 portes ouvertes` : '3 coffres ouvrent le siège';
  }
  function ui() {
    const run = auto.getState(), fixed = busy || !!demo || state.inBonus || run.active || intro || !!summary;
    CasinoRewards.setBusy(busy || !!demo || run.active);
    $('balance').textContent = money(state.balance);$('bet-value').textContent = money(state.inBonus ? state.bonusBet : state.bet);
    $('last-win').textContent = money(state.inBonus || summary ? state.bonusWin : state.lastWin || 0);
    $('win-label').textContent = state.inBonus || summary ? 'BUTIN DU SIÈGE' : 'GAIN';
    $('spin-button').disabled = busy || intro || !!summary || run.active || (!state.inBonus && !!demo) || (!state.inBonus && state.balance < state.bet);
    $('spin-label').textContent = busy ? 'EN COURS' : state.inBonus ? 'ASSAUT' : 'LANCER';
    $('spin-button').setAttribute('aria-label',state.inBonus ? 'Lancer un assaut gratuit' : 'Lancer les rouleaux');
    $('bet-picker').disabled = fixed;$('bet-down').disabled = fixed || state.bet === E.BETS[0];$('bet-up').disabled = fixed || state.bet === E.BETS.at(-1);
    $('demo-button').disabled = fixed;$('rules-button').disabled = busy || run.active;$('paytable-button').disabled = busy || run.active;
    $('auto-button').disabled = !run.active && (busy || !!demo || intro || !!summary || (!state.inBonus && state.balance < state.bet));
    $('auto-button').setAttribute('aria-pressed',String(run.active));$('auto-label').textContent = run.active ? 'ARRÊTER' : 'AUTO';
    $('rapid-button').setAttribute('aria-pressed',String(rapid));$('sound-button').setAttribute('aria-pressed',String(sound));
    $('sound-button').setAttribute('aria-label',sound ? 'Couper le son' : 'Activer le son');$('sound-button').textContent = sound ? '♫' : '♪';
    $('demo-bar').hidden = !demo;$('exit-demo').disabled = busy;$('free-counter').hidden = !state.inBonus;$('free-count').textContent = state.freeSpins;
    $('mode-label').textContent = demo ? 'DÉMONSTRATION' : state.inBonus ? 'LE SIÈGE DES TROIS PORTES' : '20 LIGNES · DE GAUCHE À DROITE';
    $('auto-progress').hidden = !run.active;$('auto-progress-text').textContent = `${run.completed} / ${run.total} tours payants${run.paused ? ' · en pause' : ''}`;
    document.body.classList.toggle('bonus-active',state.inBonus);document.body.classList.toggle('is-rolling',busy);renderGates();
  }
  function status(value) {$('status-text').textContent = value;}
  function showPending() {
    if (intro) {$('awarded-free-spins').textContent = state.bonusSpinsAwarded;$('cancel-demo-bonus').hidden = !demo;if (!$('bonus-dialog').open) $('bonus-dialog').showModal();}
    else if (summary) {$('summary-amount').textContent = money(summary.amount);$('summary-gates').textContent = `${summary.gates} / 3 portes ouvertes`;$('summary-note').textContent = demo ? 'Démonstration : votre vrai solde reste intact.' : 'Les gains des lignes et les trésors des portes sont déjà dans votre portefeuille.';if (!$('summary-dialog').open) $('summary-dialog').showModal();}
  }
  function stopAuto() {clearTimeout(autoTimer);autoTimer = null;auto.stop('user');ui();}
  function queueAuto() {
    clearTimeout(autoTimer);autoTimer = null;const run = auto.getState();
    if (!run.active || run.paused || busy || intro || summary) return;
    if (!state.inBonus && (run.remaining === 0 || wallet.read() < state.bet)) {stopAuto();status(run.remaining === 0 ? 'Série automatique terminée.' : 'Série arrêtée : solde insuffisant.');return;}
    autoTimer = setTimeout(() => {autoTimer = null;if (auto.getState().active) spin(true);},rapid ? 260 : 800);
  }
  async function sync() {
    if (busy || demo) return;busy = true;ui();let changed = false;
    try {await wallet.runExclusive(() => {changed = loadLatest();});} catch (_) {status('La synchronisation est momentanément indisponible.');}
    busy = false;state.balance = wallet.read();
    if (changed) {stopAuto();clearWins();for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();draw();showPending();}
    ui();queueAuto();
  }
  function positionFire() {
    if (activeFireReel === null) return;
    const frame = $('castle-frame').getBoundingClientRect(), origin = document.querySelector('.dragon-breath-origin').getBoundingClientRect(), reel = $('reels').children[activeFireReel].getBoundingClientRect();
    const sx = origin.left - frame.left, sy = origin.top - frame.top, tx = reel.left - frame.left + reel.width / 2, ty = reel.top - frame.top + reel.height * .3;
    const path = `M${sx},${sy} Q${(sx+tx)/2},${Math.min(sy,ty)-15} ${tx},${ty} L${tx},${reel.bottom-frame.top-12}`;
    $('dragon-fire').setAttribute('viewBox',`0 0 ${frame.width} ${frame.height}`);
    const mx=(sx+tx)/2, my=(sy+ty)/2;
    const tongues=`M${sx},${sy} Q${mx},${my-25} ${tx+29},${ty-12} L${tx+13},${ty-16} L${tx+32},${ty+19} L${tx+7},${ty+3} L${tx-8},${ty+35} L${tx-15},${ty+6} L${tx-31},${ty+20} Q${mx},${my+7} ${sx},${sy} Z`;
    for (const item of $('dragon-fire').querySelectorAll('path')) item.setAttribute('d',item.classList.contains('fire-tongues')?tongues:path);
  }
  function clearDragon() {activeFireReel = null;$('dragon-fire').classList.remove('breathing');$('dragon-actor').classList.remove('arrived','breathing');}
  async function breathe(result) {
    const actor = $('dragon-actor'), fire = $('dragon-fire');
    actor.classList.add('arrived');audio.play('dragon');status('Le dragon embrase les rouleaux !');
    try {
      await sleep(reduced ? 20 : 340);
      for (const col of result.feature.reels) {
        activeFireReel = col;positionFire();actor.classList.add('breathing');if (!reduced) fire.classList.add('breathing');
        for (let row = 0; row < 3; row++) {await sleep(reduced ? 12 : rapid ? 110 : 180);const cell = $('reels').children[col].children[row];cell.innerHTML = art('wild')+'<span class="symbol-tag">JOKER</span>';cell.classList.add('igniting');}
        drawColumn(col,result.grid[col],result.feature.reels);fire.classList.remove('breathing');actor.classList.remove('breathing');await sleep(reduced ? 10 : 90);
      }
      await sleep(reduced ? 10 : 200);
    } finally {clearDragon();}
  }
  async function roll(result) {
    const reels = [...$('reels').children];
    await Promise.all(reels.map(async (reel,col) => {
      reel.classList.add('rolling');
      const interval = reduced ? null : setInterval(() => drawColumn(col,Array.from({length:3},() => ids[Math.floor(Math.random()*9)]),[]),90);
      try {await sleep(reduced ? 25 : (rapid ? 330 : 610) + col*(rapid ? 45 : 90));} finally {clearInterval(interval);}
      reel.classList.remove('rolling');drawColumn(col,result.baseGrid[col],[]);reel.classList.add('landed');audio.play('stop',col);
    }));
    if (result.collectedKeys) {
      audio.play('key');
      for (const pos of result.collectedKeyPositions) $('reels').children[pos.reel].children[pos.row].insertAdjacentHTML('beforeend','<span class="key-collect">+1 CLÉ</span>');
      status(`${result.collectedKeys} clé${result.collectedKeys>1?'s':''} collectée${result.collectedKeys>1?'s':''}.`);
      await sleep(reduced ? 25 : 520);renderGates();
    }
    if (result.feature?.type === 'dragon') await breathe(result);
    draw();
    for (const opened of result.openedGates) {
      $('gates').children[opened.gate-1].classList.add('opening');audio.play('gate',opened.gate);
      $('siege-announcement').textContent = `${['Le Rempart','Le Donjon','Le Trésor'][opened.gate-1]} ouvert · + ${money(opened.amount)}`;$('siege-announcement').hidden = false;
      await sleep(reduced ? 60 : rapid ? 650 : 1000);$('siege-announcement').hidden = true;$('gates').children[opened.gate-1].classList.remove('opening');
    }
    reels.forEach(reel => reel.classList.remove('landed'));renderGates();
  }
  function demoGrid(siege = false) {
    const result = [['king','chalice','castle'],['queen','king','knight'],['shield','king','sword'],['castle','shield','queen'],['knight','queen','chalice']];
    if (siege) {result[0][0] = 'scatter';result[4][2] = 'scatter';}
    return result;
  }
  async function spin(automatic = false, forced = null) {
    if (busy || CasinoRewards.isClaiming() || intro || summary || document.querySelector('dialog[open]')) return;
    if (auto.getState().active && !automatic) return;if (demo && !state.inBonus && demo.played) return;
    busy = true;ui();clearWins();let result, wasBonus = false;
    try {
      const settle = () => {
        if (!demo) {loadLatest();if (intro || summary) return;}if (automatic && !auto.getState().active) return;
        wasBonus = state.inBonus;const before = state.balance, previous = rememberLocal();
        const options = forced || (demo && state.inBonus ? {forcedGrid:demoGrid(true),forceFeature:state.freeSpins % 2 === 0 ? {reels:[1]} : false} : {});
        try {
          result = E.spin(state,options);state = result.state;grid = result.grid;locks = result.lockedReels;siegeKeys = result.siegeKeys;gatesOpened = result.gatesOpened;
          intro = result.bonusTriggered;summary = result.bonusEnded ? {amount:state.bonusWin,gates:result.gatesOpened,keys:result.siegeKeys} : null;
          if (!demo) commit(state.balance-before);else demo.played = true;
        } catch (error) {restoreLocal(previous);result = null;throw error;}
        if (automatic && !wasBonus) auto.consumePaidSpin();
      };
      if (demo) settle();else await wallet.runExclusive(settle);
      if (!result) {busy = false;ui();showPending();return;}
      if (intro || summary) auto.pause('bonus');audio.play('spin');status(wasBonus ? 'L’assaut commence…' : 'Les rouleaux révèlent leur destin…');
      await roll(result);displayedWins = result.wins;
      $('wins-list').innerHTML = result.wins.map((win,index) => `<button data-win="${index}">${art(win.symbol)}<span>Ligne ${win.line}</span><strong>+ ${money(win.amount)}</strong></button>`).join('') + result.openedGates.map(gate => `<span class="gate-win-chip">${['Rempart','Donjon','Trésor'][gate.gate-1]} · + ${money(gate.amount)}</span>`).join('');
      for (const win of result.wins) for (const pos of win.positions) $('reels').children[pos.reel].children[pos.row].classList.add('winning');
      if (result.totalWin) {audio.play('win',result.totalWin/result.bet);status(`${money(result.totalWin)} remportés${result.gateWin ? ' · trésor des portes inclus' : ''}.`);}
      else status(result.feature ? 'Le souffle a transformé les rouleaux. Le royaume garde son trésor.' : wasBonus ? `${result.collectedKeys ? result.collectedKeys+' clé(s) ajoutée(s). ' : ''}Le siège continue.` : 'Le royaume garde son trésor pour ce tour.');
      if (intro || summary) audio.play('bonus');
    } catch (error) {stopAuto();status(error.code === 'INSUFFICIENT_BALANCE' ? 'Solde insuffisant. Diminuez la mise ou récupérez le cadeau disponible.' : 'Ce tour ne peut pas démarrer. Réessayez.');}
    finally {clearDragon();$('siege-announcement').hidden = true;busy = false;if (!demo) state.balance = wallet.read();ui();showPending();queueAuto();}
  }
  async function editSession(action) {
    if (busy || CasinoRewards.isClaiming() || demo) return false;busy = true;ui();let accepted = false;
    try {await wallet.runExclusive(() => {loadLatest();const previous = rememberLocal();try {accepted = action() !== false;if (accepted) commit();else restoreLocal(previous);} catch (error) {restoreLocal(previous);accepted = false;throw error;}});}
    catch (_) {status('Votre session a changé. Réessayez.');}
    finally {busy = false;state.balance = wallet.read();draw();ui();showPending();}return accepted;
  }
  async function setBet(bet) {if (!E.BETS.includes(bet) || state.inBonus || auto.getState().active) return;await editSession(() => {if (state.inBonus || intro || summary || auto.getState().active) return false;state.bet = bet;});}
  async function exitDemo() {
    if (!demo || busy) return;for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();demo = null;state = E.createState();grid = copy(initial);locks = [];siegeKeys = 0;gatesOpened = 0;revision = -1;intro = false;summary = null;clearWins();await sync();draw();ui();status('Démonstration terminée. Votre portefeuille retrouve sa valeur réelle.');
  }
  async function beginDemo(type) {
    if (busy || auto.getState().active || state.inBonus || intro || summary) return;$('demo-dialog').close();await sync();if (busy || state.inBonus || intro || summary) return;
    demo = {played:false};state = E.createState({bet:state.bet});grid = copy(initial);locks = [];siegeKeys = 0;gatesOpened = 0;clearWins();
    if (type === 'bonus') {state = E.startDemoBonus(state,3);intro = true;draw();ui();showPending();}
    else {draw();ui();$('reels').scrollIntoView?.({block:'center',behavior:reduced?'auto':'smooth'});await spin(false,{forcedGrid:demoGrid(),forceFeature:{reels:[1,3]}});}
  }
  for (let col = 0; col < 5; col++) {const reel = document.createElement('div');reel.className = 'royal-reel';reel.setAttribute('role','group');reel.setAttribute('aria-label',`Rouleau ${col+1}`);$('reels').append(reel);}
  $('paytable').innerHTML = `<table><thead><tr><th>SYMBOLE</th><th>3</th><th>4</th><th>5</th></tr></thead><tbody>${E.SYMBOLS.filter(s => s.pays[3]).map(s => `<tr><td>${art(s.id)}${s.name}</td>${[3,4,5].map(n => `<td>×${s.pays[n]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  E.GATE_MULTIPLIERS.forEach((value,index) => {$('gate-prize-'+(index+1)).textContent = '×'+value;});$('gate-rules-prizes').textContent = E.GATE_MULTIPLIERS.map(value => '×'+value).join(', ');
  $('bet-options').innerHTML = E.BETS.map(value => `<button data-bet="${value}">${money(value)}</button>`).join('');
  $('bet-options').addEventListener('click',event => {const button = event.target.closest('[data-bet]');if (button) {$('bet-dialog').close();setBet(Number(button.dataset.bet));}});
  $('bet-picker').addEventListener('click',() => {$('bet-options').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.bet)===state.bet)));$('bet-dialog').showModal();});
  $('bet-down').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)-1]));$('bet-up').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)+1]));
  $('spin-button').addEventListener('click',() => spin());$('sound-button').addEventListener('click',() => {sound = !sound;audio.setEnabled(sound);if (sound) audio.play('stop');savePreferences();ui();});
  $('rapid-button').addEventListener('click',() => {rapid = !rapid;savePreferences();ui();});$('rules-button').addEventListener('click',() => $('rules-dialog').showModal());$('paytable-button').addEventListener('click',() => $('rules-dialog').showModal());
  $('demo-button').addEventListener('click',() => $('demo-dialog').showModal());$('demo-feature').addEventListener('click',() => beginDemo('feature'));$('demo-bonus').addEventListener('click',() => beginDemo('bonus'));$('exit-demo').addEventListener('click',exitDemo);$('cancel-demo-bonus').addEventListener('click',exitDemo);
  $('enter-bonus').addEventListener('click',async () => {if (busy) return;$('bonus-dialog').close();if (demo) {intro = false;ui();}else await editSession(() => {intro = false;});auto.resume();ui();queueAuto();});
  $('finish-bonus').addEventListener('click',async () => {if (busy) return;$('summary-dialog').close();if (demo) {await exitDemo();return;}await editSession(() => {summary = null;siegeKeys = 0;gatesOpened = 0;});auto.resume();ui();queueAuto();});
  for (const id of ['bonus-dialog','summary-dialog']) $(id).addEventListener('cancel',event => {event.preventDefault();if (demo) exitDemo();});
  function autoBudget() {$('auto-budget').textContent = `${selectedCount} tours à ${money(state.bet)} · ${money(selectedCount*state.bet)} de mises au maximum. Les assauts gratuits ne sont pas facturés.`;}
  $('auto-button').addEventListener('click',() => {if (auto.getState().active) {stopAuto();return;}autoBudget();$('auto-dialog').showModal();});
  $('auto-choices').addEventListener('click',event => {const button = event.target.closest('[data-count]');if (!button) return;selectedCount = Number(button.dataset.count);$('auto-choices').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed',String(item===button)));autoBudget();});
  $('start-auto').addEventListener('click',() => {if (busy || demo || intro || summary) return;$('auto-dialog').close();auto.start(selectedCount);ui();queueAuto();});$('stop-auto').addEventListener('click',stopAuto);
  $('wins-list').addEventListener('click',event => {const button = event.target.closest('[data-win]');if (!button || !displayedWins[Number(button.dataset.win)]) return;document.querySelectorAll('.royal-cell').forEach(cell => cell.classList.remove('winning'));for (const pos of displayedWins[Number(button.dataset.win)].positions) $('reels').children[pos.reel].children[pos.row].classList.add('winning');});
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => button.closest('dialog').close()));
  document.addEventListener('keydown',event => {if (event.code==='Space' && !event.repeat && !document.querySelector('dialog[open]') && !/BUTTON|INPUT|TEXTAREA|SELECT|A/.test(event.target.tagName)) {event.preventDefault();if (auto.getState().active) stopAuto();else spin();}});
  document.addEventListener('visibilitychange',() => {if (document.hidden) {stopAuto();audio.stop();}else sync();});
  window.addEventListener('pagehide',() => {clearTimeout(autoTimer);audio.stop();clearDragon();});window.addEventListener('resize',positionFire);
  ['focus','pageshow','casino-wallet-changed'].forEach(event => window.addEventListener(event,sync));window.addEventListener('storage',event => {if (event.key===wallet.key) sync();});
  try {await wallet.runExclusive(() => {const saved = wallet.readSession(key);if (saved) {revision = -1;loadLatest();}else {state.balance = wallet.read();commit();}});} catch (_) {state.balance = wallet.read();}
  busy = false;audio.setEnabled(sound);draw();ui();showPending();
})();
