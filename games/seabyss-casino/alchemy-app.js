(async () => {
  'use strict';
  const E = AlchemyEngine, wallet = CasinoWallet;
  const $ = id => document.getElementById(id), copy = value => JSON.parse(JSON.stringify(value));
  const money = cents => (cents/100).toLocaleString(window.SeabyssI18n?.locale || 'fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  const ids = ['ruby','emerald','sapphire','mushroom','flower','moon','bottle','cauldron','star'];
  const symbols = Object.fromEntries(E.SYMBOLS.map(symbol => [symbol.id,symbol]));
  const initial = Array.from({length:5},(_,col) => Array.from({length:5},(_,row) => ids[(col*5+row)%7]));
  const key = 'seabyss-alchemy-session-v1', preferenceKey = 'seabyss-alchemy-preferences-v1';
  const auto = SeabyssAutoplay.createController(), audio = AlchemyAudio.create();
  let state = E.createState(), grid = copy(initial), chainTotal = 0, multiplier = 1, brewReveal = null, revision = -1;
  let busy = true, demo = null, rapid = false, sound = false, autoTimer = null, selectedCount = 10, displayedWins = [];
  try {const saved = JSON.parse(localStorage.getItem(preferenceKey));rapid = saved?.rapid === true;sound = saved?.sound === true;} catch (_) {}
  const pending = () => state.inBonus || !!brewReveal;
  const art = id => `<span class="symbol-art" style="--sprite-x:${(ids.indexOf(id)%3)*50}%;--sprite-y:${Math.floor(ids.indexOf(id)/3)*50}%" aria-hidden="true"></span>`;
  const validMoney = value => Number.isSafeInteger(value) && value >= 0;
  const validGrid = value => Array.isArray(value) && value.length === 5 && value.every(col => Array.isArray(col) && col.length === 5 && col.every(id => ids.includes(id) && id !== 'star'));
  function savePreferences() {try {localStorage.setItem(preferenceKey,JSON.stringify({rapid,sound}));} catch (_) {}}
  function rememberLocal() {return copy({state,grid,chainTotal,multiplier,brewReveal,revision});}
  function restoreLocal(saved) {({state,grid,chainTotal,multiplier,brewReveal,revision} = saved);}
  function snapshot() {return {...rememberLocal(),revision:revision+1};}
  function commit(delta = 0) {state.balance = wallet.commitSession(key,snapshot(),delta,revision < 0 ? undefined : revision);revision++;}
  function resetLocal() {state = E.createState({balance:wallet.read()});grid = copy(initial);chainTotal = 0;multiplier = 1;brewReveal = null;}

  // One wallet record owns both the credit and the completed reaction or choice.
  function loadLatest() {
    const saved = wallet.readSession(key), previous = rememberLocal();
    const validRevision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0;
    if (validRevision && saved.revision === revision) {state.balance = wallet.read();return false;}
    try {
      if (!saved) {resetLocal();revision = 0;commit();return true;}
      revision = validRevision ? saved.revision : 0;
      let validState = true;try {E.validateState(saved.state);} catch (_) {validState = false;}
      const validBoard = validGrid(saved.grid), validTotal = validMoney(saved.chainTotal), validMultiplier = Number.isInteger(saved.multiplier) && saved.multiplier >= 1 && saved.multiplier <= 6;
      if (validState) {
        state = copy(saved.state);grid = validBoard ? copy(saved.grid) : copy(initial);
        chainTotal = validTotal ? saved.chainTotal : state.lastWin;multiplier = validMultiplier ? saved.multiplier : 1;
        brewReveal = saved.brewReveal && state.lastBonus && !state.inBonus ? copy(state.lastBonus) : null;
      } else resetLocal();
      state.balance = wallet.read();
      if (!validRevision || !validState || !validBoard || !validTotal || !validMultiplier) {
        state.balance = wallet.commitSession(key,snapshot(),0,validRevision ? revision : undefined);revision++;
      }
      return true;
    } catch (error) {restoreLocal(previous);revision = -1;throw error;}
  }
  function drawGrid(value = grid) {
    value.forEach((column,col) => {
      $('alchemy-grid').children[col].innerHTML = column.map((id,row) => `<div class="alchemy-cell${id === 'cauldron' ? ' cauldron-cell' : ''}" data-row="${row}" role="img" aria-label="${symbols[id].name}">${art(id)}${id === 'cauldron' ? '<span class="symbol-tag">POTION</span>' : ''}</div>`).join('');
    });
  }
  function renderMeter(value = multiplier,total = chainTotal) {
    [...$('reaction-meter').children].forEach((step,index) => {step.classList.toggle('active',index+1 === value);step.classList.toggle('complete',index+1 < value);step.setAttribute('aria-current',index+1 === value ? 'step' : 'false');});
    $('reaction-total').textContent = money(total);$('cascade-label').textContent = total ? `Réaction ×${value}` : 'Prêt pour l’expérience';
  }
  function draw() {drawGrid();renderMeter();}
  function clearWins() {displayedWins = [];$('wins-list').innerHTML = '';}
  function chosenIngredient(index) {return brewReveal ? brewReveal.ingredients.find(item => item.index === index) : state.bonus?.ingredients[index];}
  function renderBrew() {
    const active = pending(), selected = brewReveal?.selected || state.bonus?.selected || [];
    $('brew-panel').hidden = !active;$('lab-idle').hidden = active;
    $('lab-title').innerHTML = active ? brewReveal ? 'Votre grand œuvre<br>est accompli.' : 'Composez votre<br>potion secrète.' : 'Votre chaudron<br>garde un secret.';
    $('lab-note').textContent = active ? brewReveal ? 'La réaction a révélé votre trésor.' : 'Trois ingrédients parmi six. À vous de choisir.' : 'Trois chaudrons sur une grille ouvrent la préparation d’une potion.';
    $('cauldron').classList.toggle('brewing',state.inBonus);$('cauldron').classList.toggle('ready',!!brewReveal);
    $('catalyst-reveal').hidden = !brewReveal;
    $('catalyst-reveal').innerHTML = brewReveal ? art('star')+`<span>×${brewReveal.catalyst}</span>` : '';
    $('catalyst-reveal').setAttribute('aria-label',brewReveal ? `Catalyseur : la potion est multipliée par ${brewReveal.catalyst}` : 'Catalyseur de la potion');
    $('brew-count').textContent = `${selected.length} / 3 INGRÉDIENTS`;
    $('brew-result').textContent = brewReveal ? `${money(brewReveal.baseAmount)} ×${brewReveal.catalyst} = ${money(brewReveal.amount)}` : selected.length ? `Mélange : ${money(state.bonus.sum)} avant catalyseur` : 'Choisissez votre premier ingrédient.';
    $('finish-brew').hidden = !brewReveal;$('finish-brew').disabled = busy || !brewReveal;
    $('brew-note').textContent = brewReveal ? demo ? 'Démonstration : votre vrai solde reste intact.' : 'Le trésor de cette potion est déjà dans votre portefeuille.' : 'Votre choix est conservé. Le troisième ingrédient révèle le catalyseur.';
    $('ingredient-options').innerHTML = ids.slice(0,6).map((id,index) => {
      const chosen = selected.includes(index), item = chosen ? chosenIngredient(index) : null;
      return `<button class="ingredient-button${chosen ? ' chosen' : ''}" data-ingredient="${index}"${busy || !state.inBonus || chosen ? ' disabled' : ''} aria-label="${symbols[id].name}${chosen ? ', déjà choisi : '+money(item.amount) : ', choisir cet ingrédient'}">${art(id)}<span>${symbols[id].name}</span><strong>${chosen ? money(item.amount) : '?'}</strong></button>`;
    }).join('');
    $('recipe-tray').innerHTML = selected.map(index => `<span class="recipe-item">${art(ids[index])}<strong>${money(chosenIngredient(index).amount)}</strong></span>`).join('');
  }
  function ui() {
    const run = auto.getState(), fixed = busy || !!demo || pending() || run.active;
    CasinoRewards.setBusy(busy || !!demo || run.active);
    $('balance').textContent = money(state.balance);$('bet-value').textContent = money(state.bonus?.bet || brewReveal?.bet || state.bet);
    $('last-win').textContent = money(brewReveal?.amount ?? state.lastWin);$('win-label').textContent = brewReveal ? 'POTION' : 'GAIN';
    $('spin-button').disabled = busy || pending() || run.active || !!demo?.played || state.balance < state.bet;
    $('spin-label').textContent = busy ? 'EN COURS' : 'TRANSMUTER';
    $('bet-picker').disabled = fixed;$('bet-down').disabled = fixed || state.bet === E.BETS[0];$('bet-up').disabled = fixed || state.bet === E.BETS.at(-1);
    $('demo-button').disabled = fixed;$('rules-button').disabled = busy || run.active;$('paytable-button').disabled = busy || run.active;
    $('auto-button').disabled = !run.active && (busy || !!demo || pending() || state.balance < state.bet);
    $('auto-button').setAttribute('aria-pressed',String(run.active));$('auto-label').textContent = run.active ? 'ARRÊTER' : 'AUTO';
    $('rapid-button').setAttribute('aria-pressed',String(rapid));$('sound-button').setAttribute('aria-pressed',String(sound));
    $('sound-button').setAttribute('aria-label',sound ? 'Couper le son' : 'Activer le son');$('sound-button').textContent = sound ? '♫' : '♪';
    $('demo-bar').hidden = !demo;$('exit-demo').disabled = busy;
    $('mode-label').textContent = demo ? 'DÉMONSTRATION' : pending() ? 'LA POTION SECRÈTE VOUS ATTEND' : '25 SYMBOLES · 8 IDENTIQUES POUR GAGNER';
    $('auto-progress').hidden = !run.active;$('auto-progress-text').textContent = `${run.completed} / ${run.total} expériences`;
    document.body.classList.toggle('bonus-active',pending());document.body.classList.toggle('is-rolling',busy);renderBrew();
  }
  function status(value) {$('status-text').textContent = value;}
  function showPending(scroll = false) {if (pending() && scroll) $('alchemy-lab').scrollIntoView?.({block:'center',behavior:reduced ? 'auto' : 'smooth'});}
  function stopAuto(reason = 'user') {clearTimeout(autoTimer);autoTimer = null;auto.stop(reason);ui();}
  function queueAuto() {
    clearTimeout(autoTimer);autoTimer = null;const run = auto.getState();
    if (!run.active || busy || pending()) return;
    if (run.remaining === 0 || wallet.read() < state.bet) {stopAuto();status(run.remaining === 0 ? 'Série d’expériences terminée.' : 'Série arrêtée : solde insuffisant.');return;}
    autoTimer = setTimeout(() => {autoTimer = null;if (auto.getState().active) spin(true);},rapid ? 260 : 800);
  }
  async function sync() {
    if (busy || demo) return;busy = true;ui();let changed = false;
    try {await wallet.runExclusive(() => {changed = loadLatest();});} catch (_) {status('La synchronisation est momentanément indisponible.');}
    busy = false;state.balance = wallet.read();
    if (changed) {stopAuto('session');clearWins();for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();draw();}
    ui();queueAuto();
  }
  function eachCell(callback) {for (const column of $('alchemy-grid').children) for (const cell of column.children) callback(cell);}
  function mark(positions,className) {for (const pos of positions) $('alchemy-grid').children[pos.reel].children[pos.row].classList.add(className);}
  function clearEffects() {eachCell(cell => cell.classList.remove('reacting','vanishing','falling'));$('cauldron').classList.remove('pouring');$('pouring-ingredient').innerHTML = '';}
  async function animateReactions(result) {
    drawGrid(result.initialGrid);renderMeter(1,0);eachCell(cell => {if (!reduced) cell.classList.add('falling');});
    await sleep(reduced ? 20 : rapid ? 180 : 360);eachCell(cell => cell.classList.remove('falling'));audio.play('stop');
    let total = 0;
    for (const reaction of result.cascades) {
      drawGrid(reaction.grid);
      if (!reaction.wins.length) break;
      total += reaction.totalWin;renderMeter(reaction.multiplier,total);mark(reaction.removedPositions,'reacting');audio.play('react',reaction.multiplier);
      status(`${reaction.removedPositions.length} symboles réagissent · ×${reaction.multiplier} · ${money(reaction.totalWin)}.`);
      await sleep(reduced ? 20 : rapid ? 260 : 560);
      if (reaction.nextGrid) {
        if (!reduced) mark(reaction.removedPositions,'vanishing');await sleep(reduced ? 10 : rapid ? 100 : 190);
        drawGrid(reaction.nextGrid);eachCell(cell => {if (!reduced) cell.classList.add('falling');});audio.play('cascade',reaction.multiplier+1);
        await sleep(reduced ? 15 : rapid ? 140 : 260);eachCell(cell => cell.classList.remove('falling'));
      }
    }
    draw();clearEffects();
  }
  function showWins(result) {
    displayedWins = result.cascades.flatMap(reaction => reaction.wins.map(win => ({...win,reaction:reaction.multiplier})));
    $('wins-list').innerHTML = displayedWins.map((win,index) => `<button data-win="${index}">${art(win.symbol)}<span>${win.count} symboles · ×${win.reaction}</span><strong>+ ${money(win.amount)}</strong></button>`).join('');
  }
  async function spin(automatic = false,forced = null) {
    if (busy || CasinoRewards.isClaiming() || pending() || document.querySelector('dialog[open]') || demo?.played) return;
    if (auto.getState().active && !automatic) return;
    busy = true;ui();clearWins();let result;
    try {
      const settle = () => {
        if (!demo) {loadLatest();if (pending()) {stopAuto('bonus');return;}}if (automatic && !auto.getState().active) return;
        const previous = rememberLocal(), before = state.balance;
        try {
          result = E.spin(state,forced || {});state = result.state;grid = result.grid;chainTotal = result.totalWin;
          multiplier = result.cascades.filter(reaction => reaction.wins.length).at(-1)?.multiplier || 1;brewReveal = null;
          if (!demo) commit(state.balance-before);else demo.played = true;
        } catch (error) {restoreLocal(previous);result = null;throw error;}
        if (automatic) auto.consumePaidSpin();
      };
      if (demo) settle();else await wallet.runExclusive(settle);
      if (!result) return;
      if (state.inBonus) stopAuto('bonus');audio.play('spin');status('La transmutation commence…');
      await animateReactions(result);showWins(result);
      if (result.totalWin) {audio.play('win',result.totalWin/result.bet);status(`${money(result.totalWin)} produits par la réaction.`);}
      else status('La formule reste secrète pour cette expérience.');
      if (state.inBonus) {audio.play('bonus');status('Le chaudron s’éveille. Choisissez trois ingrédients.');}
    } catch (error) {stopAuto('error');status(['INSUFFICIENT_BALANCE','INSUFFICIENT_FUNDS'].includes(error.code) ? 'Solde insuffisant. Diminuez la mise ou récupérez le cadeau disponible.' : 'L’expérience ne peut pas démarrer. Réessayez.');}
    finally {clearEffects();busy = false;if (!demo) state.balance = wallet.read();draw();ui();showPending(!!result?.bonusTriggered);queueAuto();}
  }

  // Choices and the final receipt are saved before pouring, including the one-time credit.
  async function pickIngredient(index) {
    if (busy || CasinoRewards.isClaiming() || !state.inBonus || !Number.isInteger(index) || index < 0 || index > 5) return;
    busy = true;ui();let result;
    try {
      const settle = () => {
        if (!demo) loadLatest();if (!state.inBonus || state.bonus.selected.includes(index)) return;
        const previous = rememberLocal(), before = state.balance;
        try {
          result = E.pickIngredient(state,index);state = result.state;brewReveal = result.bonusEnded ? copy(state.lastBonus) : null;
          if (!demo) commit(state.balance-before);
        } catch (error) {restoreLocal(previous);result = null;throw error;}
      };
      if (demo) settle();else await wallet.runExclusive(settle);
      if (!result) return;
      $('pouring-ingredient').innerHTML = art(ids[index]);if (!reduced) $('cauldron').classList.add('pouring');audio.play('pour',index);
      await sleep(reduced ? 25 : rapid ? 420 : 850);audio.play('pick',index);
      if (result.bonusEnded) {audio.play('complete',result.catalyst);status(`${money(result.totalWin)} révélés par votre potion.`);}
      else status(`${3-result.picksLeft} ingrédient${result.picksLeft === 2 ? '' : 's'} choisi${result.picksLeft === 2 ? '' : 's'}. La préparation est conservée.`);
    } catch (_) {status('Cet ingrédient n’a pas pu être ajouté. Réessayez.');}
    finally {clearEffects();busy = false;if (!demo) state.balance = wallet.read();ui();}
  }
  async function editSession(action) {
    if (busy || CasinoRewards.isClaiming()) return false;busy = true;ui();let accepted = false;
    try {
      const settle = () => {if (!demo) loadLatest();const previous = rememberLocal();try {accepted = action() !== false;if (accepted && !demo) commit();else if (!accepted) restoreLocal(previous);} catch (error) {restoreLocal(previous);accepted = false;throw error;}};
      if (demo) settle();else await wallet.runExclusive(settle);
    } catch (_) {status('Votre session a changé. Réessayez.');}
    finally {busy = false;if (!demo) state.balance = wallet.read();draw();ui();}return accepted;
  }
  async function setBet(bet) {if (demo || !E.BETS.includes(bet) || pending() || auto.getState().active) return;await editSession(() => {if (pending() || auto.getState().active) return false;state.bet = bet;});}
  async function exitDemo() {
    if (!demo || busy) return;for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    demo = null;resetLocal();revision = -1;clearWins();clearEffects();audio.stop();await sync();draw();ui();status('Démonstration terminée. Votre portefeuille retrouve sa valeur réelle.');
  }
  function demoCascade() {
    const paying = ids.slice(0,6);
    const value = Array.from({length:5},(_,col) => Array.from({length:5},(_,row) => col*5+row < 8 ? 'bottle' : paying[(col*5+row)%6]));
    return {forcedGrid:value,forcedRefills:[Array(8).fill('bottle'),Array(8).fill('bottle'),Array.from({length:8},(_,index) => paying[index%6])]};
  }
  async function beginDemo(kind) {
    if (busy || auto.getState().active || pending()) return;$('demo-dialog').close();await sync();if (busy || pending()) return;
    demo = {kind,played:false};state = E.createState({bet:state.bet});grid = copy(initial);chainTotal = 0;multiplier = 1;brewReveal = null;clearWins();
    if (kind === 'bonus') {state = E.startDemoBonus(state,{forcedIngredients:E.INGREDIENTS.slice(0,6).map(ingredient => ingredient.multiplier),forcedCatalyst:2});demo.played = true;draw();ui();showPending(true);status('Démonstration : choisissez trois ingrédients pour préparer votre potion.');audio.play('bonus');}
    else {draw();ui();$('alchemy-grid').scrollIntoView?.({block:'center',behavior:reduced?'auto':'smooth'});await spin(false,demoCascade());}
  }
  for (let col=0;col<5;col++) {const column = document.createElement('div');column.className = 'alchemy-column';column.setAttribute('role','group');column.setAttribute('aria-label',`Colonne ${col+1}`);$('alchemy-grid').append(column);}
  $('reaction-meter').innerHTML = Array.from({length:6},(_,index) => `<span class="reaction-step">×${index+1}</span>`).join('');
  function renderTables() {
  const number = value => value.toLocaleString(window.SeabyssI18n?.locale || 'fr-CA',{maximumFractionDigits:2});
  $('paytable').innerHTML = `<table><thead><tr><th>SYMBOLE</th>${E.PAY_THRESHOLDS.map((count,index) => `<th>${count}–${(E.PAY_THRESHOLDS[index+1] || 26)-1}</th>`).join('')}</tr></thead><tbody>${E.SYMBOLS.filter(symbol => symbol.pays[8]).map(symbol => `<tr><td>${art(symbol.id)}${symbol.name}</td>${E.PAY_THRESHOLDS.map(count => `<td>×${number(symbol.pays[count])}</td>`).join('')}</tr>`).join('')}</tbody></table><p>Multiplicateurs de la mise totale, avant le multiplicateur de réaction ×1 à ×6.</p>`;
  const ingredientWeight = E.INGREDIENTS.reduce((sum,item) => sum+item.weight,0), catalystWeight = E.CATALYSTS.reduce((sum,item) => sum+item.weight,0);
  $('ingredient-rules').innerHTML = `<p>Valeur de chaque ingrédient : ${E.INGREDIENTS.map(item => `×${number(item.multiplier)} la mise (${number(item.weight/ingredientWeight*100)} %)` ).join(' ; ')}.</p><p>Les trois valeurs choisies sont additionnées. Catalyseur final : ${E.CATALYSTS.map(item => `×${item.multiplier} (${number(item.weight/catalystWeight*100)} %)` ).join(' ; ')}.</p>`;
  $('bet-options').innerHTML = E.BETS.map(value => `<button data-bet="${value}">${money(value)}</button>`).join('');
  }
  renderTables();
  $('bet-options').addEventListener('click',event => {const button = event.target.closest('[data-bet]');if (button) {$('bet-dialog').close();return setBet(Number(button.dataset.bet));}});
  $('bet-picker').addEventListener('click',() => {$('bet-options').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.bet)===state.bet)));$('bet-dialog').showModal();});
  $('bet-down').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)-1]));$('bet-up').addEventListener('click',() => setBet(E.BETS[E.BETS.indexOf(state.bet)+1]));
  $('spin-button').addEventListener('click',() => spin());
  $('ingredient-options').addEventListener('click',event => {const button = event.target.closest('[data-ingredient]');if (button && !button.disabled) return pickIngredient(Number(button.dataset.ingredient));});
  $('finish-brew').addEventListener('click',async () => {if (busy || !brewReveal) return;if (demo) {await exitDemo();return;}await editSession(() => {if (!brewReveal || state.inBonus) return false;brewReveal = null;});});
  $('sound-button').addEventListener('click',() => {sound = !sound;audio.setEnabled(sound);if (sound) audio.play('stop');savePreferences();ui();});$('rapid-button').addEventListener('click',() => {rapid = !rapid;savePreferences();ui();});
  $('rules-button').addEventListener('click',() => $('rules-dialog').showModal());$('paytable-button').addEventListener('click',() => $('rules-dialog').showModal());
  $('demo-button').addEventListener('click',() => $('demo-dialog').showModal());$('demo-cascade').addEventListener('click',() => beginDemo('cascade'));$('demo-bonus').addEventListener('click',() => beginDemo('bonus'));$('exit-demo').addEventListener('click',exitDemo);
  function autoBudget() {$('auto-budget').textContent = `${selectedCount} expériences à ${money(state.bet)} · ${money(selectedCount*state.bet)} de mises au maximum. La série s’arrête si le chaudron s’ouvre.`;}
  $('auto-button').addEventListener('click',() => {if (auto.getState().active) {stopAuto();return;}autoBudget();$('auto-dialog').showModal();});
  $('auto-choices').addEventListener('click',event => {const button = event.target.closest('[data-count]');if (!button) return;selectedCount = Number(button.dataset.count);$('auto-choices').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed',String(item===button)));autoBudget();});
  $('start-auto').addEventListener('click',() => {if (busy || demo || pending()) return;$('auto-dialog').close();auto.start(selectedCount);ui();queueAuto();});$('stop-auto').addEventListener('click',() => stopAuto());
  $('wins-list').addEventListener('click',event => {const button = event.target.closest('[data-win]');if (!button || !displayedWins[Number(button.dataset.win)]) return;const win = displayedWins[Number(button.dataset.win)];status(`${symbols[win.symbol].name} · ${win.count} symboles · réaction ×${win.reaction} · ${money(win.amount)}.`);});
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => button.closest('dialog').close()));
  document.addEventListener('keydown',event => {if (event.code==='Space' && !event.repeat && !document.querySelector('dialog[open]') && !/BUTTON|INPUT|TEXTAREA|SELECT|A/.test(event.target.tagName)) {event.preventDefault();if (auto.getState().active) stopAuto();else spin();}});
  document.addEventListener('visibilitychange',() => {if (document.hidden) {stopAuto('hidden');audio.stop();}else sync();});window.addEventListener('pagehide',() => {clearTimeout(autoTimer);audio.stop();clearEffects();});
  ['focus','pageshow','casino-wallet-changed'].forEach(event => window.addEventListener(event,sync));window.addEventListener('storage',event => {if (event.key === wallet.key) sync();});
  try {await wallet.runExclusive(loadLatest);} catch (_) {state.balance = wallet.read();status('La sauvegarde est momentanément indisponible.');}
  busy = false;audio.setEnabled(sound);draw();ui();showPending(true);
window.addEventListener('seabyss:languagechange',()=>{renderTables();if(!busy){ui();renderMeter();autoBudget();}});
})();
