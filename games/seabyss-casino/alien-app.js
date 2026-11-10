(async () => {
  'use strict';
  const E = AlienEngine, wallet = CasinoWallet;
  const $ = id => document.getElementById(id), copy = value => JSON.parse(JSON.stringify(value));
  const money = cents => (cents/100).toLocaleString(window.SeabyssI18n?.locale || 'fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  const ids = ['alien','planet','rocket','moon','corn','tractor','cow','wild','scatter'];
  const symbols = Object.fromEntries(E.SYMBOLS.map(symbol => [symbol.id,symbol]));
  const initial = [['alien','planet','rocket'],['moon','alien','corn'],['rocket','alien','tractor'],['corn','moon','planet'],['tractor','planet','moon']];
  const key = 'seabyss-alien-session-v1', preferenceKey = 'seabyss-alien-preferences-v1';
  const auto = SeabyssAutoplay.createController(), audio = AlienAudio.create();
  let state = E.createState(), grid = copy(initial), locks = [], intro = false, summary = null, revision = -1;
  let busy = true, demo = null, rapid = false, sound = false, autoTimer = null, selectedCount = 10, displayedWins = [];
  try {const saved = JSON.parse(localStorage.getItem(preferenceKey));rapid = saved?.rapid === true;sound = saved?.sound === true;} catch (_) {}
  const pending = () => intro || !!summary;
  const art = id => `<span class="symbol-art" style="--sprite-x:${(ids.indexOf(id)%3)*50}%;--sprite-y:${Math.floor(ids.indexOf(id)/3)*50}%" aria-hidden="true"></span>`;
  const beam = '<svg class="tractor-beam" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M48 0 L95 96 Q50 110 5 96 L52 0 Z"/><path class="beam-core" d="M49 0 L72 97 Q50 104 28 97 L51 0 Z"/></svg>';
  const validGrid = value => Array.isArray(value) && value.length === 5 && value.every(col => Array.isArray(col) && col.length === 3 && col.every(id => ids.includes(id)));
  function savePreferences() {try {localStorage.setItem(preferenceKey,JSON.stringify({rapid,sound}));} catch (_) {}}
  function rememberLocal() {return copy({state,grid,locks,intro,summary,revision});}
  function restoreLocal(saved) {({state,grid,locks,intro,summary,revision} = saved);}
  function snapshot() {return {...rememberLocal(),revision:revision+1};}
  function commit(delta = 0) {state.balance = wallet.commitSession(key,snapshot(),delta,revision < 0 ? undefined : revision);revision++;}
  function resetLocal() {state = E.createState({balance:wallet.read()});grid = copy(initial);locks = [];intro = false;summary = null;}

  // The resolved grid, bonus and credit are saved together before the UFOs animate.
  function loadLatest() {
    const saved = wallet.readSession(key), previous = rememberLocal();
    const validRevision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0;
    if (validRevision && saved.revision === revision) {state.balance = wallet.read();return false;}
    try {
      if (!saved) {resetLocal();revision = 0;commit();return true;}
      revision = validRevision ? saved.revision : 0;
      let validState = true;try {E.validateState(saved.state);} catch (_) {validState = false;}
      const validBoard = validGrid(saved.grid);let repairedVisual = false;
      if (validState) {
        state = copy(saved.state);grid = validBoard ? copy(saved.grid) : copy(initial);
        const visualLocks = validBoard && Array.isArray(saved.locks) ? saved.locks.filter(col => Number.isInteger(col) && col >= 0 && col < 5) : [];
        for (const col of state.lockedReels) grid[col].fill('wild');
        locks = [...new Set([...state.lockedReels,...visualLocks.filter(col => grid[col].every(id => id === 'wild'))])].sort((a,b) => a-b);
        repairedVisual = JSON.stringify(grid) !== JSON.stringify(saved.grid) || JSON.stringify(locks) !== JSON.stringify(saved.locks);
        intro = !!saved.intro && state.inBonus;
        summary = !state.inBonus && saved.summary && Number.isSafeInteger(saved.summary.amount) && saved.summary.amount >= 0 ? {amount:state.bonusWin} : null;
      } else resetLocal();
      state.balance = wallet.read();
      if (!validRevision || !validState || !validBoard || repairedVisual) {state.balance = wallet.commitSession(key,snapshot(),0,validRevision ? revision : undefined);revision++;}
      return true;
    } catch (error) {restoreLocal(previous);revision = -1;throw error;}
  }
  function drawColumn(col,values,held = locks) {
    const reel = $('reels').children[col], sticky = state.lockedReels.includes(col) || !!summary && held.includes(col);
    reel.classList.toggle('held',held.includes(col));reel.classList.toggle('sticky',sticky);
    reel.innerHTML = values.map((id,row) => `<div class="alien-cell" data-row="${row}" role="img" aria-label="${symbols[id].name}${held.includes(col) ? sticky ? ', joker figé' : ', joker pour ce tour' : ''}">${art(id)}${id === 'wild' ? '<span class="symbol-tag">JOKER</span>' : id === 'scatter' ? '<span class="symbol-tag scatter-tag">BONUS</span>' : ''}</div>`).join('') + beam + (held.includes(col) ? `<span class="held-tag">${sticky ? 'FIGÉ · BONUS' : 'POUR CE TOUR'}</span>` : '');
  }
  function draw() {grid.forEach((column,index) => drawColumn(index,column));}
  function clearWins() {displayedWins = [];$('wins-list').innerHTML = '';}
  function shownUfos() {
    if (state.inBonus && !intro && state.ufoReels.length === 2) return [0,1,3,4];
    if (!state.inBonus && !summary && state.ufoReels.length === 4) return [0,4];
    return state.ufoReels;
  }
  function renderUfos() {
    const positions = shownUfos();
    [...$('ufo-track').children].forEach((actor,index) => {
      actor.hidden = index >= positions.length;
      if (!actor.hidden) {actor.style.setProperty('--reel',String(positions[index]));actor.dataset.reel = String(positions[index]);actor.setAttribute('aria-label',`Soucoupe ${index+1}, au-dessus du rouleau ${positions[index]+1}`);}
    });
  }
  function ui() {
    const run = auto.getState(), fixed = busy || !!demo || state.inBonus || pending() || run.active;
    CasinoRewards.setBusy(busy || !!demo || run.active);
    $('balance').textContent = money(state.balance);$('bet-value').textContent = money(state.inBonus ? state.bonusBet : state.bet);
    $('last-win').textContent = money(state.inBonus || summary ? state.bonusWin : state.lastWin);$('win-label').textContent = state.inBonus || summary ? 'BUTIN DE L’INVASION' : 'GAIN';
    $('spin-button').disabled = busy || pending() || run.active || (!state.inBonus && !!demo?.played) || (!state.inBonus && state.balance < state.bet);
    $('spin-label').textContent = busy ? 'EN COURS' : state.inBonus ? 'TOUR GRATUIT' : 'DÉCOLLER';
    $('bet-picker').disabled = fixed;$('bet-down').disabled = fixed || state.bet === E.BETS[0];$('bet-up').disabled = fixed || state.bet === E.BETS.at(-1);
    $('demo-button').disabled = fixed;$('rules-button').disabled = busy || run.active;$('paytable-button').disabled = busy || run.active;
    $('auto-button').disabled = !run.active && (busy || !!demo || pending() || (!state.inBonus && state.balance < state.bet));
    $('auto-button').setAttribute('aria-pressed',String(run.active));$('auto-label').textContent = run.active ? 'ARRÊTER' : 'AUTO';
    $('rapid-button').setAttribute('aria-pressed',String(rapid));$('sound-button').setAttribute('aria-pressed',String(sound));
    $('sound-button').setAttribute('aria-label',sound ? 'Couper le son' : 'Activer le son');$('sound-button').textContent = sound ? '♫' : '♪';
    $('demo-bar').hidden = !demo;$('exit-demo').disabled = busy;$('free-counter').hidden = !state.inBonus;$('free-count').textContent = state.freeSpins;
    $('mode-label').textContent = demo ? 'DÉMONSTRATION' : state.inBonus || summary ? 'QUATRE SOUCOUPES · LA GRANDE INVASION' : 'DEUX SOUCOUPES À L’AFFÛT';
    $('capture-note').textContent = summary ? `Invasion terminée · ${locks.length} / 5 rouleaux figés` : state.inBonus ? `${state.lockedReels.length} / 5 rouleaux figés · conservés jusqu’au dernier tour` : 'Une vache sous une soucoupe ? Tout son rouleau devient joker.';
    $('auto-progress').hidden = !run.active;$('auto-progress-text').textContent = `${run.completed} / ${run.total} tours payants${run.paused ? ' · en pause' : ''}`;
    document.body.classList.toggle('bonus-active',state.inBonus || !!summary);document.body.classList.toggle('is-rolling',busy);renderUfos();
  }
  function status(value) {$('status-text').textContent = value;}
  function showPending() {
    if (intro) {$('awarded-free-spins').textContent = state.bonusSpinsAwarded;$('cancel-demo-bonus').hidden = !demo;if (!$('bonus-dialog').open) $('bonus-dialog').showModal();}
    else if (summary) {$('summary-amount').textContent = money(summary.amount);$('summary-note').textContent = demo ? 'Démonstration : votre vrai portefeuille reste intact.' : 'Les gains de l’invasion sont déjà dans votre portefeuille.';if (!$('summary-dialog').open) $('summary-dialog').showModal();}
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
  function clearEffects() {
    for (const actor of $('ufo-track').children) actor.classList.remove('capturing');
    for (const reel of $('reels').children) {reel.classList.remove('beaming','rolling','landed','converted');for (const cell of reel.querySelectorAll('.alien-cell')) cell.classList.remove('abducting');}
  }
  async function abduct(result) {
    const captures = result.captures.filter(capture => result.ufoReels[capture.ufoIndex] === capture.reel)
      .map(capture => ({...capture,positions:capture.positions.filter(position => position.reel === capture.reel && result.baseGrid[position.reel]?.[position.row] === 'cow')}))
      .filter(capture => capture.positions.length);
    if (!captures.length) return;
    const duration = reduced ? 20 : rapid ? 520 : 1050, settleDuration = reduced ? 15 : rapid ? 100 : 190;
    const cowCount = captures.reduce((sum,capture) => sum+capture.positions.length,0);
    status(`Aspiration de ${cowCount} vache${cowCount>1?'s':''} sur ${captures.length} rouleau${captures.length>1?'x':''} !`);
    try {
      // Every beam and cow starts in the same frame; one barrier converts the whole group.
      for (const capture of captures) {
        const actor = $('ufo-track').children[capture.ufoIndex], reel = $('reels').children[capture.reel];
        const lowestRow = Math.max(...capture.positions.map(position => position.row));
        reel.style.setProperty('--beam-row',String(lowestRow));reel.style.setProperty('--beam-height',`${(lowestRow+.5)/3*100}%`);
        if (!reduced) {actor.classList.add('capturing');reel.classList.add('beaming');}
        for (const position of capture.positions) {
          const cell = reel.children[position.row];
          cell.style.setProperty('--abduct-distance',`calc(var(--cell-size) * -${position.row+.5} - 10px)`);
          cell.style.setProperty('--abduct-duration',`${duration}ms`);
          if (!reduced) cell.classList.add('abducting');
        }
      }
      audio.play('beam',captures.length);await sleep(duration);
      for (const capture of captures) {
        drawColumn(capture.reel,result.grid[capture.reel],result.lockedReels);audio.play('capture',capture.reel);
        if (!reduced) $('reels').children[capture.reel].classList.add('converted');
      }
      await sleep(settleDuration);
    } finally {
      for (const capture of captures) {
        $('ufo-track').children[capture.ufoIndex].classList.remove('capturing');
        const reel = $('reels').children[capture.reel];reel.classList.remove('beaming','converted');
        for (const cell of reel.querySelectorAll('.alien-cell')) cell.classList.remove('abducting');
      }
    }
  }
  async function roll(result,previousLocks) {
    renderUfos();audio.play('ufo',result.ufoReels.length);
    await Promise.all([...$('reels').children].map(async (reel,col) => {
      if (previousLocks.includes(col)) {drawColumn(col,result.baseGrid[col],previousLocks);audio.play('hold',col);return;}
      reel.classList.add('rolling');
      const interval = reduced ? null : setInterval(() => drawColumn(col,Array.from({length:3},() => ids[Math.floor(Math.random()*9)]),[]),90);
      try {await sleep(reduced ? 25 : (rapid ? 330 : 610)+col*(rapid ? 45 : 90));} finally {clearInterval(interval);}
      reel.classList.remove('rolling');drawColumn(col,result.baseGrid[col],previousLocks);reel.classList.add('landed');audio.play('stop',col);
    }));
    if (result.captures.length) await abduct(result);draw();clearEffects();
  }
  function demoOptions() {
    const value = copy(initial);
    if (!state.inBonus) {value[0][1] = 'cow';value[4][0] = 'cow';return {forcedGrid:value,forcedUfoReels:[0,4]};}
    if (state.freeSpins === 10) {value[0][0] = value[0][1] = value[3][1] = value[3][2] = value[2][1] = value[2][2] = 'cow';return {forcedGrid:value,forcedUfoReels:[0,1,3,4]};}
    if (state.freeSpins === 9) {value[1][0] = 'cow';value[1][2] = 'cow';return {forcedGrid:value,forcedUfoReels:[0,1,2,4]};}
    return {forcedGrid:value,forcedUfoReels:[0,1,2,3,4].filter(col => col !== state.freeSpins%5)};
  }
  async function spin(automatic = false,forced = null) {
    if (busy || CasinoRewards.isClaiming() || pending() || document.querySelector('dialog[open]')) return;
    if (auto.getState().active && !automatic) return;if (demo?.played && !state.inBonus) return;
    busy = true;ui();clearWins();let result,previousLocks,wasBonus = false;
    try {
      const settle = () => {
        if (!demo) {loadLatest();if (pending()) {auto.pause('bonus');return;}}if (automatic && !auto.getState().active) return;
        const previous = rememberLocal(),before = state.balance;wasBonus = state.inBonus;previousLocks = [...state.lockedReels];
        try {
          result = E.spin(state,forced || (demo ? demoOptions() : {}));state = result.state;grid = result.grid;locks = result.lockedReels;
          intro = result.bonusTriggered;summary = result.bonusEnded ? {amount:state.bonusWin} : null;
          if (!demo) commit(state.balance-before);else demo.played = true;
        } catch (error) {restoreLocal(previous);result = null;throw error;}
        if (automatic && !wasBonus) auto.consumePaidSpin();
      };
      if (demo) settle();else await wallet.runExclusive(settle);if (!result) return;
      if (pending()) auto.pause('bonus');audio.play('spin');status(wasBonus ? 'Les visiteurs poursuivent leur tournée…' : 'Décollage ! Les soucoupes choisissent leurs rouleaux…');
      await roll(result,previousLocks);displayedWins = result.wins;
      $('wins-list').innerHTML = result.wins.map((win,index) => `<button data-win="${index}">${art(win.symbol)}<span>Ligne ${win.line}</span><strong>+ ${money(win.amount)}</strong></button>`).join('');
      for (const win of result.wins) for (const position of win.positions) $('reels').children[position.reel].children[position.row].classList.add('winning');
      const captureText = result.captures.length ? `${result.capturedCows.length} vache${result.capturedCows.length>1?'s':''} aspirée${result.capturedCows.length>1?'s':''} sur ${result.captures.length} rouleau${result.captures.length>1?'x':''}` : '';
      if (result.totalWin) {audio.play('win',result.totalWin/result.bet);status(`${money(result.totalWin)} remportés${captureText ? ' · '+captureText : ' par les visiteurs'}.`);}
      else status(captureText ? `${captureText}. Les jokers ont été comptés.` : 'Les soucoupes repartent sans vache pour ce tour.');
      if (summary) audio.play('free-end');else if (intro) audio.play('bonus');
    } catch (error) {stopAuto('error');status(['INSUFFICIENT_BALANCE','INSUFFICIENT_FUNDS'].includes(error.code) ? 'Solde insuffisant. Diminuez la mise ou récupérez le cadeau disponible.' : 'Ce décollage ne peut pas commencer. Réessayez.');}
    finally {clearEffects();busy = false;if (!demo) state.balance = wallet.read();ui();showPending();queueAuto();}
  }
  async function editSession(action) {
    if (busy || CasinoRewards.isClaiming()) return false;busy = true;ui();let accepted = false;
    try {
      const settle = () => {if (!demo) loadLatest();const previous = rememberLocal();try {accepted = action() !== false;if (accepted && !demo) commit();else if (!accepted) restoreLocal(previous);} catch (error) {restoreLocal(previous);accepted = false;throw error;}};
      if (demo) settle();else await wallet.runExclusive(settle);
    } catch (_) {status('Votre session a changé. Réessayez.');}
    finally {busy = false;if (!demo) state.balance = wallet.read();draw();ui();showPending();}return accepted;
  }
  async function setBet(bet) {if (demo || !E.BETS.includes(bet) || state.inBonus || pending() || auto.getState().active) return;await editSession(() => {if (state.inBonus || pending() || auto.getState().active) return false;state.bet = bet;});}
  async function exitDemo() {
    if (!demo || busy) return;for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    demo = null;resetLocal();revision = -1;clearWins();clearEffects();audio.stop();await sync();draw();ui();status('Démonstration terminée. Votre portefeuille retrouve sa valeur réelle.');
  }
  async function beginDemo(kind) {
    if (busy || auto.getState().active || state.inBonus || pending()) return;$('demo-dialog').close();await sync();if (busy || state.inBonus || pending()) return;
    demo = {kind,played:false};state = E.createState({bet:state.bet});grid = copy(initial);locks = [];intro = false;summary = null;clearWins();
    if (kind === 'bonus') {state = E.startDemoBonus(state,3);intro = true;draw();ui();showPending();status('Démonstration : quatre soucoupes arrivent pour dix tours gratuits.');}
    else {draw();ui();$('reels').scrollIntoView?.({block:'center',behavior:reduced?'auto':'smooth'});await spin(false,demoOptions());}
  }
  for (let col=0;col<5;col++) {const reel = document.createElement('div');reel.className = 'alien-reel';reel.setAttribute('role','group');reel.setAttribute('aria-label',`Rouleau ${col+1}`);$('reels').append(reel);}
  $('paytable').innerHTML = `<table><thead><tr><th>SYMBOLE</th><th>3</th><th>4</th><th>5</th></tr></thead><tbody>${E.SYMBOLS.filter(symbol => symbol.pays[3]).map(symbol => `<tr><td>${art(symbol.id)}${symbol.name}</td>${[3,4,5].map(count => `<td>×${symbol.pays[count]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  $('bet-options').innerHTML = E.BETS.map(value => `<button data-bet="${value}">${money(value)}</button>`).join('');
  $('bet-options').addEventListener('click',event => {const button = event.target.closest('[data-bet]');if (button) {$('bet-dialog').close();return setBet(Number(button.dataset.bet));}});
  $('bet-picker').addEventListener('click',() => {$('bet-options').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.bet)===state.bet)));$('bet-dialog').showModal();});
  $('bet-down').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)-1]));$('bet-up').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)+1]));
  $('spin-button').addEventListener('click',() => spin());$('sound-button').addEventListener('click',() => {sound = !sound;audio.setEnabled(sound);if (sound) audio.play('stop');savePreferences();ui();});
  $('rapid-button').addEventListener('click',() => {rapid = !rapid;savePreferences();ui();});$('rules-button').addEventListener('click',() => $('rules-dialog').showModal());$('paytable-button').addEventListener('click',() => $('rules-dialog').showModal());
  $('demo-button').addEventListener('click',() => $('demo-dialog').showModal());$('demo-feature').addEventListener('click',() => beginDemo('feature'));$('demo-bonus').addEventListener('click',() => beginDemo('bonus'));$('exit-demo').addEventListener('click',exitDemo);$('cancel-demo-bonus').addEventListener('click',exitDemo);
  $('enter-bonus').addEventListener('click',async () => {if (busy) return;$('bonus-dialog').close();const accepted = await editSession(() => {if (!intro || !state.inBonus) return false;intro = false;});if (accepted) {audio.play('free-start');auto.resume();}ui();queueAuto();});
  $('finish-bonus').addEventListener('click',async () => {if (busy) return;$('summary-dialog').close();if (demo) {await exitDemo();return;}const accepted = await editSession(() => {if (!summary || state.inBonus) return false;summary = null;locks = [];});if (accepted) auto.resume();ui();queueAuto();});
  for (const id of ['bonus-dialog','summary-dialog']) $(id).addEventListener('cancel',event => {event.preventDefault();if (demo) exitDemo();});
  function autoBudget() {$('auto-budget').textContent = `${selectedCount} tours à ${money(state.bet)} · ${money(selectedCount*state.bet)} de mises au maximum. Les gratuits ne sont pas facturés ; confirmez leur introduction pour poursuivre.`;}
  $('auto-button').addEventListener('click',() => {if (auto.getState().active) {stopAuto();return;}autoBudget();$('auto-dialog').showModal();});
  $('auto-choices').addEventListener('click',event => {const button = event.target.closest('[data-count]');if (!button) return;selectedCount = Number(button.dataset.count);$('auto-choices').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed',String(item===button)));autoBudget();});
  $('start-auto').addEventListener('click',() => {if (busy || demo || pending()) return;$('auto-dialog').close();auto.start(selectedCount);ui();queueAuto();});$('stop-auto').addEventListener('click',() => stopAuto());
  $('wins-list').addEventListener('click',event => {const button = event.target.closest('[data-win]');if (!button || !displayedWins[Number(button.dataset.win)]) return;document.querySelectorAll('.alien-cell').forEach(cell => cell.classList.remove('winning'));for (const position of displayedWins[Number(button.dataset.win)].positions) $('reels').children[position.reel].children[position.row].classList.add('winning');});
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => button.closest('dialog').close()));
  document.addEventListener('keydown',event => {if (event.code==='Space' && !event.repeat && !document.querySelector('dialog[open]') && !/BUTTON|INPUT|TEXTAREA|SELECT|A/.test(event.target.tagName)) {event.preventDefault();if (auto.getState().active) stopAuto();else spin();}});
  document.addEventListener('visibilitychange',() => {if (document.hidden) {stopAuto('hidden');audio.stop();}else sync();});window.addEventListener('pagehide',() => {stopAuto('hidden');audio.stop();clearEffects();});
  ['focus','pageshow','casino-wallet-changed'].forEach(event => window.addEventListener(event,sync));window.addEventListener('storage',event => {if (event.key === wallet.key) sync();});
  try {await wallet.runExclusive(loadLatest);} catch (_) {state.balance = wallet.read();status('La sauvegarde est momentanément indisponible.');}
  busy = false;audio.setEnabled(sound);draw();ui();showPending();
window.addEventListener('seabyss:languagechange',()=>{if(!busy){ui();autoBudget();}});
})();
