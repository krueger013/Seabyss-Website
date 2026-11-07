(async () => {
  'use strict';
  const kind = document.body.dataset.machine, flower = kind === 'flowers';
  const E = flower ? FlowerEngine : MonsterEngine, wallet = CasinoWallet;
  const $ = id => document.getElementById(id), copy = value => JSON.parse(JSON.stringify(value));
  const money = cents => (cents/100).toLocaleString('fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
  const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ids = flower ? ['rose','orchid','peony','tulip','daisy','sunflower','wild','scatter'] : ['mochi','puff','bubbles','sprout','zippy','luna','wild','scatter'];
  const symbols = Object.fromEntries(E.SYMBOLS.map(s=>[s.id,s]));
  const initial = Array.from({length:5},(_,col)=>Array.from({length:3},(_,row)=>ids[(col*2+row)%6]));
  const key = `seabyss-${kind}-session-v1`, preferenceKey = `seabyss-${kind}-preferences-v1`;
  const auto = SeabyssAutoplay.createController(), audio = MeadowAudio.create(kind);
  let state = E.createState(), grid = copy(initial), locks = [], multiplier = 1;
  let revision = 0, busy = true, intro = false, summary = null, demo = null, rapid = false, sound = false;
  let autoTimer = null, selectedCount = 10, displayedWins = [];
  let effectVersion = 0;
  const effectTimers = new Set(), effectNodes = new Set(), reactingCells = new Set();
  const reactions = ['monster-hop-win','monster-wiggle-win','monster-jelly-win','monster-dance-win'];
  try { const p=JSON.parse(localStorage.getItem(preferenceKey));rapid=p?.rapid===true;sound=p?.sound===true; } catch (_) {}
  function savePreferences() { try {localStorage.setItem(preferenceKey,JSON.stringify({rapid,sound}));}catch(_){} }
  function playSound(name,detail) {if(!document.hidden)audio.play(name,detail);}
  function validGrid(g) { return Array.isArray(g)&&g.length===5&&g.every(c=>Array.isArray(c)&&c.length===3&&c.every(id=>symbols[id])); }
  function snapshot() { return {state,grid,locks,multiplier,intro,summary,revision:revision+1}; }
  function commit(delta=0) { state.balance=wallet.commitSession(key,snapshot(),delta,revision);revision++; }
  function rememberLocal() { return copy({state,grid,locks,multiplier,intro,summary,revision}); }
  function restoreLocal(saved) { ({state,grid,locks,multiplier,intro,summary,revision}=saved); }
  function loadLatest() {
    const saved=wallet.readSession(key);
    if (!saved) {
      state=E.createState();state.balance=wallet.read();grid=copy(initial);locks=[];multiplier=1;intro=false;summary=null;revision=0;commit();return true;
    }
    if (Number.isSafeInteger(saved.revision)&&saved.revision>=0&&saved.revision===revision) {state.balance=wallet.read();return false;}
    const validRevision=Number.isSafeInteger(saved.revision)&&saved.revision>=0;
    revision=validRevision?saved.revision:0;
    try {
      E.validateState(saved.state);if(!validRevision||!validGrid(saved.grid))throw new Error('grid');
      state=copy(saved.state);grid=copy(saved.grid);locks=Array.isArray(saved.locks)?saved.locks.filter(n=>Number.isInteger(n)&&n>=0&&n<5):[];
      multiplier=[1,2,3].includes(saved.multiplier)?saved.multiplier:1;
      intro=!!saved.intro&&state.inBonus;summary=saved.summary&&Number.isSafeInteger(saved.summary.amount)&&saved.summary.amount>=0?saved.summary:null;
    } catch (_) {state=E.createState({balance:wallet.read()});grid=copy(initial);locks=[];multiplier=1;intro=false;summary=null;state.balance=wallet.commitSession(key,snapshot(),0,validRevision?revision:undefined);revision++;}
    state.balance=wallet.read();return true;
  }
  const art=(id,extra='')=>`<span class="symbol-art ${extra}" style="--sprite-x:${(ids.indexOf(id)%3)*50}%;--sprite-y:${Math.floor(ids.indexOf(id)/3)*50}%" aria-hidden="true"></span>`;
  function drawColumn(col,values,held=locks) {
    const reel=$('reels').children[col];reel.classList.toggle('held',held.includes(col));
    reel.innerHTML=values.map((id,row)=>`<div class="meadow-cell" data-row="${row}" role="img" aria-label="${symbols[id].name}${held.includes(col)?', rouleau figé':''}">${art(id)}${id==='wild'?'<span class="symbol-tag">JOKER</span>':id==='scatter'?'<span class="symbol-tag scatter-tag">BONUS</span>':''}</div>`).join('')+(held.includes(col)?'<span class="held-tag">LIANE FIGÉE</span>':'');
  }
  function draw() {grid.forEach((column,col)=>drawColumn(col,column));}
  function laterEffect(callback, delay) {
    const timer=setTimeout(()=>{effectTimers.delete(timer);callback();},delay);
    effectTimers.add(timer);return timer;
  }
  function removeEffect(node) {node.remove();effectNodes.delete(node);}
  function clearEffects() {
    effectVersion++;
    for(const timer of effectTimers)clearTimeout(timer);effectTimers.clear();
    for(const node of effectNodes)node.remove();effectNodes.clear();
    document.querySelectorAll('.growing-vine').forEach(node=>node.remove());
    for(const cell of reactingCells)cell.classList.remove(...reactions,'vine-settled','bloom-pulse');reactingCells.clear();
    $('mascot').classList.remove('cheering','monster-cheer-small','monster-cheer-big');
    $('reels').classList.remove('win-celebration','party');$('party-pop').hidden=true;
    audio.stop();
  }
  function clearWins() {clearEffects();displayedWins=[];$('wins-list').innerHTML='';}
  // CSS-only particles stay inside their cells; a win emits at most 18.
  // Every effect is cancelled on the next spin or when leaving the page.
  function burst(target, petals, count, seed=0) {
    if(reduced||document.hidden)return;
    const layer=document.createElement('span');layer.className='meadow-sparks'+(petals?' flower-petals':'');layer.setAttribute('aria-hidden','true');
    layer.innerHTML=Array.from({length:count},(_,i)=>{
      const angle=(i/count)*Math.PI*2+seed*.7, distance=17+(i%3)*7;
      return `<i style="--dx:${Math.round(Math.cos(angle)*distance)}px;--dy:${Math.round(Math.sin(angle)*distance)-14}px;--turn:${(i%2?1:-1)*(100+i*27)}deg;--spark-delay:${i*25}ms"></i>`;
    }).join('');
    target.append(layer);effectNodes.add(layer);laterEffect(()=>removeEffect(layer),850);
  }
  function vineArt() {
    const leaves=Array.from({length:6},(_,i)=>{
      const y=270-i*43, x=i%2?65:35, angle=i%2?-32:24;
      return `<g transform="translate(${x} ${y}) rotate(${angle})"><g class="vine-leaf" style="--leaf-delay:${Math.round((70+i*80)*(rapid?.45:1))}ms"><path d="M0 0C-9-21-30-21-31-22C-31-3-16 9 0 0Z"/><path class="leaf-vein" d="M-25-17L0 0"/></g></g>`;
    }).join('');
    const blooms=[250,151,52].map((y,i)=>`<g transform="translate(${i%2?34:65} ${y})"><g class="vine-flower" style="--leaf-delay:${Math.round((160+i*170)*(rapid?.45:1))}ms">${[0,72,144,216,288].map(angle=>`<ellipse cy="-5" rx="3.4" ry="6" transform="rotate(${angle})"/>`).join('')}<circle r="3"/></g></g>`).join('');
    return `<svg class="growing-vine rich-vine${rapid?' vine-rapid':''}" viewBox="0 0 100 300" preserveAspectRatio="none" aria-hidden="true"><path class="vine-stem vine-main" pathLength="1" d="M43 308C12 273 83 250 45 214S20 159 58 126S78 57 46-8"/><path class="vine-stem vine-twin" pathLength="1" d="M60 308C88 274 24 247 61 212S81 155 42 121S23 50 58-8"/>${leaves}${blooms}</svg>`;
  }
  function celebrateMonsters(result) {
    const winner=result.wins.reduce((best,win)=>!best||win.amount>best.amount?win:best,null);
    const ratio=result.totalWin/result.bet, big=ratio>=5;
    playSound('win',{symbol:winner?.symbol||'mochi',ratio,rapid});
    if(reduced||document.hidden)return;
    const visited=new Set();let index=0;
    for(const win of result.wins)for(const {reel,row} of win.positions){
      const position=reel*3+row;if(visited.has(position))continue;visited.add(position);
      const cell=$('reels').children[reel].children[row], symbol=grid[reel][row];
      const reaction=reactions[(Math.max(0,ids.indexOf(symbol))+index)%reactions.length];
      cell.classList.add(reaction);cell.setAttribute('style',`--reaction-delay:${(index%5)*35}ms;--reaction-count:${big?3:2}`);reactingCells.add(cell);
      if(index<6)burst(cell,false,big?3:2,index);index++;
    }
    $('mascot').classList.add(big?'monster-cheer-big':'monster-cheer-small');
    $('reels').classList.toggle('win-celebration',big);
    const bubble=document.createElement('span');bubble.className='monster-reaction-note';bubble.setAttribute('aria-hidden','true');
    bubble.textContent=big?'Quelle fête !':({mochi:'Hihi !',puff:'Youpi !',bubbles:'Bloup !',sprout:'Tadaa !',zippy:'Wouhou !',luna:'Oh oui !'})[winner?.symbol]||'Youpi !';
    $('mascot').parentElement.append(bubble);effectNodes.add(bubble);
    laterEffect(()=>{
      for(const cell of reactingCells)cell.classList.remove(...reactions);reactingCells.clear();
      $('mascot').classList.remove('monster-cheer-small','monster-cheer-big');$('reels').classList.remove('win-celebration');removeEffect(bubble);
    },big?1900:1350);
  }
  function ui() {
    const run=auto.getState(), fixed=busy||!!demo||state.inBonus||run.active||intro||!!summary;
    CasinoRewards.setBusy(busy||!!demo||run.active);
    $('balance').textContent=money(state.balance);$('bet-value').textContent=money(state.inBonus?state.bonusBet:state.bet);
    $('last-win').textContent=money(state.inBonus||summary?state.bonusWin:state.lastWin||0);
    $('win-label').textContent=state.inBonus||summary?'GAINS DU BONUS':'DERNIER GAIN';
    $('spin-button').disabled=busy||intro||!!summary||run.active||(!state.inBonus&&!!demo)||(!state.inBonus&&state.balance<state.bet);
    $('spin-label').textContent=busy?'ÇA TOURNE…':state.inBonus?'TOUR GRATUIT':'LANCER';
    $('bet-picker').disabled=fixed;
    $('bet-down').disabled=fixed||state.bet===E.BETS[0];$('bet-up').disabled=fixed||state.bet===E.BETS.at(-1);
    $('demo-button').disabled=fixed;$('rules-button').disabled=busy||run.active;$('paytable-button').disabled=busy||run.active;
    $('auto-button').disabled=!run.active&&(busy||!!demo||intro||!!summary||(!state.inBonus&&state.balance<state.bet));
    $('auto-button').setAttribute('aria-pressed',String(run.active));$('auto-label').textContent=run.active?'ARRÊTER':'AUTO';
    $('rapid-button').setAttribute('aria-pressed',String(rapid));$('sound-button').setAttribute('aria-pressed',String(sound));
    $('sound-button').setAttribute('aria-label',sound?'Couper le son':'Activer le son');$('sound-button').textContent=sound?'♫':'♪';
    $('demo-bar').hidden=!demo;$('exit-demo').disabled=busy;
    $('free-counter').hidden=!state.inBonus;$('free-count').textContent=state.freeSpins;
    $('mode-label').textContent=demo?'DÉMONSTRATION':state.inBonus?flower?'LE JARDIN S’ÉVEILLE':'LA FÊTE CONTINUE':flower?'20 LIGNES · DE GAUCHE À DROITE':'243 FAÇONS · 3 ROULEAUX DE SUITE';
    $('feature-value').textContent=flower?`${locks.length} / 2`:`×${multiplier}`;
    $('feature-caption').textContent=flower?(state.inBonus?'ROULEAUX FIGÉS EN BONUS':locks.length?'ROULEAU JOKER POUR CE TOUR':'JUSQU’À 2 ROULEAUX FIGÉS EN BONUS'):'MULTIPLICATEUR DU TOUR';
    $('auto-progress').hidden=!run.active;$('auto-progress-text').textContent=`${run.completed} / ${run.total} tours payants${run.paused?' · en pause':''}`;
    document.body.classList.toggle('bonus-active',state.inBonus);document.body.classList.toggle('is-rolling',busy);
  }
  function status(text) {$('status-text').textContent=text;}
  function showPending() {
    if(intro){$('awarded-free-spins').textContent=state.bonusSpinsAwarded;$('cancel-demo-bonus').hidden=!demo;$('bonus-dialog').showModal();}
    else if(summary){$('summary-amount').textContent=money(summary.amount);$('summary-note').textContent=demo?'Démonstration : votre vrai solde reste intact.':'Le total a été ajouté à votre portefeuille au fil des tours.';$('summary-dialog').showModal();}
  }
  async function sync() {
    if(busy||demo)return;
    busy=true;ui();let changed=false;
    try{await wallet.runExclusive(()=>{changed=loadLatest();});}catch(_){status('La synchronisation est momentanément indisponible.');}
    busy=false;state.balance=wallet.read();
    if(changed){stopAuto();clearWins();for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();draw();showPending();}
    ui();queueAuto();
  }
  function stopAuto() {clearTimeout(autoTimer);autoTimer=null;auto.stop('user');ui();}
  function queueAuto() {
    clearTimeout(autoTimer);autoTimer=null;const run=auto.getState();
    if(!run.active||run.paused||busy||intro||summary)return;
    if(!state.inBonus&&(run.remaining===0||wallet.read()<state.bet)){stopAuto();status(run.remaining===0?'Série automatique terminée.':'Série arrêtée : solde insuffisant.');return;}
    autoTimer=setTimeout(()=>{autoTimer=null;if(auto.getState().active)spin(true);},rapid?260:800);
  }
  async function roll(result,oldLocks) {
    const reels=[...$('reels').children], version=effectVersion;
    const animations=reels.map(async(reel,col)=>{
      if(oldLocks.includes(col)){drawColumn(col,result.grid[col],oldLocks);return;}
      reel.classList.add('rolling');
      const interval=reduced?null:setInterval(()=>drawColumn(col,Array.from({length:3},()=>ids[Math.floor(Math.random()*8)]),oldLocks),90);
      try{await sleep(reduced?35:(rapid?360:650)+col*(rapid?45:95));}finally{clearInterval(interval);}
      reel.classList.remove('rolling');drawColumn(col,result.baseGrid[col],oldLocks);reel.classList.add('landed');playSound('stop',col);
    });
    await Promise.all(animations);
    if(result.feature?.type==='vine'&&version===effectVersion&&!document.hidden){
      playSound('feature');$('mascot').classList.add('cheering');
      for(const col of result.feature.reels){
        const reel=reels[col];
        if(!reduced)reel.insertAdjacentHTML('beforeend',vineArt());
        for(let row=2;row>=0;row--){
          if(!reduced)await sleep(rapid?110:220);
          if(version!==effectVersion||document.hidden)break;
          const cell=reel.children[row];cell.innerHTML=art('wild')+'<span class="symbol-tag">JOKER</span>';cell.setAttribute('aria-label',symbols.wild.name);
          if(!reduced){cell.classList.add('bloom-pulse');reactingCells.add(cell);burst(cell,true,rapid?3:5,row+col);}
          playSound('bloom',2-row);
        }
        if(!reduced&&version===effectVersion)await sleep(rapid?70:140);
      }
      status(`La liane transforme le rouleau ${result.feature.reels.map(n=>n+1).join(', ')} en jokers${state.inBonus?' et le garde figé pour le bonus':''}.`);
    }else if(result.feature?.type==='party'&&version===effectVersion&&!document.hidden){
      playSound('feature');$('mascot').classList.add('cheering');$('party-value').textContent=`×${result.multiplier}`;$('party-pop').hidden=false;
      $('reels').classList.add('party');await sleep(reduced?80:850);$('party-pop').hidden=true;$('reels').classList.remove('party');
      status(`Les petits monstres font la fête : gains du tour ×${result.multiplier} !`);
    }
    draw();$('mascot').classList.remove('cheering');reels.forEach(r=>r.classList.remove('landed'));
    if(result.feature?.type==='vine'&&!reduced&&version===effectVersion&&!document.hidden){
      for(const col of result.feature.reels)for(let row=0;row<3;row++){
        const cell=reels[col].children[row];cell.classList.add('vine-settled');reactingCells.add(cell);
      }
    }
  }
  function demoGrid(){const g=copy(initial);if(flower){g[0][1]=ids[0];g[1][1]=ids[0];g[2][1]=ids[0];}else{g[0][0]=ids[0];g[1][1]=ids[0];g[2][2]=ids[0];}return g;}
  async function spin(automatic=false,forced=null){
    if(busy||CasinoRewards.isClaiming()||intro||summary||document.querySelector('dialog[open]'))return;
    if(auto.getState().active&&!automatic)return;
    if(demo&&!state.inBonus&&demo.played)return;
    busy=true;clearWins();ui();
    let result,oldLocks=[],wasBonus=false;
    try{
      const settle=()=>{
        if(!demo){loadLatest();if(intro||summary)return;}
        if(automatic&&!auto.getState().active)return;
        wasBonus=state.inBonus;oldLocks=[...(state.lockedReels||[])];
        const before=state.balance;
        const options=forced||(demo&&state.inBonus?{forcedGrid:demoGrid(),forceFeature:flower?(oldLocks.length<2?{reels:[oldLocks.includes(1)?3:1]}:false):{multiplier:3}}:{});
        const previous=rememberLocal();
        try {
          result=E.spin(state,options);state=result.state;grid=result.grid;locks=result.lockedReels||[];multiplier=result.multiplier||1;
          intro=result.bonusTriggered;summary=result.bonusEnded?{amount:state.bonusWin}:null;
          if(!demo)commit(state.balance-before);else demo.played=true;
        } catch(error) {
          // Only an uncommitted result rolls back. Later animation errors must
          // never undo a spin that already reached the shared wallet.
          restoreLocal(previous);result=null;throw error;
        }
        if(automatic&&!wasBonus)auto.consumePaidSpin();
      };
      if(demo)settle();else await wallet.runExclusive(settle);
      if(!result){busy=false;ui();showPending();return;}
      if(intro||summary)auto.pause('bonus');
      playSound('spin');status(state.inBonus?'Le bonus se poursuit…':flower?'Le jardin révèle ses fleurs…':'Les petits monstres arrivent…');
      await roll(result,oldLocks);displayedWins=result.wins;
      $('wins-list').innerHTML=result.wins.map((win,index)=>`<button data-win="${index}">${art(win.symbol)}<span>${flower?'Ligne '+(win.line??win.lineIndex??index+1):`${win.ways||1} façon${win.ways>1?'s':''}`}</span><strong>+ ${money(win.amount)}</strong></button>`).join('');
      for(const win of result.wins)for(const pos of win.positions)$('reels').children[pos.reel].children[pos.row].classList.add('winning');
      if(result.totalWin){if(flower)playSound('win');else celebrateMonsters(result);status(`${money(result.totalWin)} remportés${result.feature?.type==='party'?' · multiplicateur ×'+multiplier+' inclus':''}.`);}
      else if(!result.feature)status(flower?'Les fleurs gardent leur secret pour ce tour.':'Les petits monstres préparent leur prochaine surprise.');
      if(intro||summary)playSound('bonus');
    }catch(error){stopAuto();status(error.code==='INSUFFICIENT_BALANCE'?'Solde insuffisant. Diminuez la mise ou récupérez le cadeau disponible.':'Ce tour ne peut pas démarrer. Réessayez.');}
    finally{busy=false;if(!demo)state.balance=wallet.read();ui();showPending();queueAuto();}
  }
  async function editSession(action){
    if(busy||CasinoRewards.isClaiming()||demo)return false;
    busy=true;ui();let accepted=false;
    try{await wallet.runExclusive(()=>{
      loadLatest();const previous=rememberLocal();
      try{accepted=action()!==false;if(accepted)commit();else restoreLocal(previous);}
      catch(error){restoreLocal(previous);accepted=false;throw error;}
    });}
    catch(_){status('Votre session a changé. Réessayez.');}
    finally{busy=false;state.balance=wallet.read();draw();ui();showPending();}
    return accepted;
  }
  async function setBet(bet){if(!E.BETS.includes(bet)||state.inBonus||auto.getState().active)return;await editSession(()=>{if(state.inBonus||intro||summary||auto.getState().active)return false;state.bet=bet;});}
  async function exitDemo(){if(!demo||busy)return;for(const d of document.querySelectorAll('dialog[open]'))d.close();demo=null;state=E.createState();grid=copy(initial);locks=[];multiplier=1;revision=-1;intro=false;summary=null;clearWins();await sync();draw();ui();status('Démonstration terminée. Votre portefeuille retrouve sa valeur réelle.');}
  async function beginDemo(type){
    if(busy||auto.getState().active||state.inBonus||intro||summary)return;
    $('demo-dialog').close();await sync();if(busy||state.inBonus||intro||summary)return;
    const demoBet=state.bet;demo={played:false};state=E.createState();state.balance=10000;state.bet=demoBet;grid=copy(initial);locks=[];multiplier=1;
    if(type==='bonus'){state=E.startDemoBonus(state,3);intro=true;draw();ui();showPending();}
    else{draw();ui();$('reels').scrollIntoView?.({block:'center',behavior:reduced?'auto':'smooth'});await spin(false,{forcedGrid:demoGrid(),forceFeature:flower?{reels:[2]}:{multiplier:3}});}
  }
  for(let col=0;col<5;col++){const element=document.createElement('div');element.className='meadow-reel';element.setAttribute('role','group');element.setAttribute('aria-label',`Rouleau ${col+1}`);$('reels').append(element);}
  $('paytable').innerHTML=`<table><thead><tr><th>SYMBOLE</th><th>3</th><th>4</th><th>5</th></tr></thead><tbody>${E.SYMBOLS.filter(s=>s.pays[3]).map(s=>`<tr><td>${art(s.id)}${s.name}</td>${[3,4,5].map(n=>`<td>×${String(s.pays[n]).replace('.',',')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  $('bet-options').innerHTML=E.BETS.map(n=>`<button data-bet="${n}">${money(n)}</button>`).join('');
  $('bet-options').addEventListener('click',e=>{const b=e.target.closest('[data-bet]');if(b){$('bet-dialog').close();setBet(Number(b.dataset.bet));}});
  $('bet-picker').addEventListener('click',()=>{$('bet-options').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.bet)===state.bet)));$('bet-dialog').showModal();});
  $('bet-down').addEventListener('click',()=>setBet(E.BETS[E.BETS.indexOf(state.bet)-1]));$('bet-up').addEventListener('click',()=>setBet(E.BETS[E.BETS.indexOf(state.bet)+1]));
  $('spin-button').addEventListener('click',()=>spin());
  $('sound-button').addEventListener('click',()=>{sound=!sound;audio.setEnabled(sound);if(sound)playSound('stop');savePreferences();ui();});
  $('rapid-button').addEventListener('click',()=>{rapid=!rapid;savePreferences();ui();});
  $('rules-button').addEventListener('click',()=>{$('rules-dialog').showModal();});$('paytable-button').addEventListener('click',()=>{$('rules-dialog').showModal();});
  $('demo-button').addEventListener('click',()=>{$('demo-dialog').showModal();});$('demo-feature').addEventListener('click',()=>beginDemo('feature'));$('demo-bonus').addEventListener('click',()=>beginDemo('bonus'));$('exit-demo').addEventListener('click',exitDemo);
  $('enter-bonus').addEventListener('click',async()=>{if(busy)return;$('bonus-dialog').close();if(demo){intro=false;ui();}else await editSession(()=>{intro=false;});auto.resume();queueAuto();});
  $('cancel-demo-bonus').addEventListener('click',exitDemo);
  $('finish-bonus').addEventListener('click',async()=>{$('summary-dialog').close();if(demo){await exitDemo();return;}await editSession(()=>{summary=null;});auto.resume();queueAuto();});
  for(const id of ['bonus-dialog','summary-dialog'])$(id).addEventListener('cancel',e=>{e.preventDefault();if(demo)exitDemo();});
  $('auto-button').addEventListener('click',()=>{if(auto.getState().active){stopAuto();return;}autoBudget();$('auto-dialog').showModal();});
  $('auto-choices').addEventListener('click',e=>{const b=e.target.closest('[data-count]');if(!b)return;selectedCount=Number(b.dataset.count);$('auto-choices').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));autoBudget();});
  function autoBudget(){$('auto-budget').textContent=`${selectedCount} tours à ${money(state.bet)} · ${money(selectedCount*state.bet)} de mises au maximum. Les tours gratuits ne sont pas facturés.`;}
  $('start-auto').addEventListener('click',()=>{if(busy||demo||intro||summary)return;$('auto-dialog').close();auto.start(selectedCount);ui();queueAuto();});$('stop-auto').addEventListener('click',stopAuto);
  $('wins-list').addEventListener('click',e=>{const b=e.target.closest('[data-win]');if(!b)return;document.querySelectorAll('.meadow-cell').forEach(c=>c.classList.remove('winning'));for(const pos of displayedWins[Number(b.dataset.win)].positions)$('reels').children[pos.reel].children[pos.row].classList.add('winning');});
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat&&!document.querySelector('dialog[open]')&&!/BUTTON|INPUT|TEXTAREA|SELECT|A/.test(e.target.tagName)){e.preventDefault();if(auto.getState().active)stopAuto();else spin();}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopAuto();clearEffects();}else sync();});
  window.addEventListener('pagehide',()=>{clearTimeout(autoTimer);clearEffects();});
  ['focus','pageshow','casino-wallet-changed'].forEach(event=>window.addEventListener(event,sync));window.addEventListener('storage',e=>{if(e.key===wallet.key)sync();});
  try{await wallet.runExclusive(()=>{const saved=wallet.readSession(key);if(saved){revision=-1;loadLatest();}else{state.balance=wallet.read();commit();}});}catch(_){state.balance=wallet.read();}
  busy=false;audio.setEnabled(sound);draw();ui();showPending();
})();
