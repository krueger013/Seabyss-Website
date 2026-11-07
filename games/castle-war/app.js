(() => {
  'use strict';
  const E = window.CastleEngine, R = window.CastleRenderer, P = window.CastleProgression, $ = id => document.getElementById(id);
  const MAPS = {
    abyss: { name: 'The Cursed Reef', subtitle: 'BIOLUMINESCENT TIDES', number: '01' },
    ember: { name: 'Shadowforge', subtitle: 'RIVERS OF MOLTEN FIRE', number: '02' },
    frost: { name: 'Frostgrave', subtitle: 'THE FROZEN KINGDOM', number: '03' }
  };
  const SHORT_NAMES = { sentinel:'Sentinel',archer:'Tide Archer',golem:'Coral Golem',swarm:'Crab Swarm',cannon:'Abyss Cannon',mortar:'Siege Mortar',heal:'Healing Spring',lightning:'Abyssal Lightning' };
  const TYPE_NAMES = { unit:'TROOP',tower:'DEFENSE',spell:'SPELL' };
  const RUNNER = E.CARD_DEFS.find(card=>card.id==='runner');
  const SAVE_KEY = 'seabyss-castle-war-v1', PREF_KEY = 'seabyss-castle-war-options', PROFILE_KEY = 'seabyss-castle-war-profile-v1';
  const ELEMENT_LABELS = {physical:'Physical',fire:'Fire',ice:'Ice',water:'Water',neutral:'Neutral'};
  const canvas = $('battlefield'), ctx = canvas.getContext('2d'), modal = $('modal');
  let options = {mode:2,mapId:'abyss',difficulty:'normal'}, state, saved = null, profile = P.createProfile(), playing = false, paused = false;
  let hoverPoint = null, lastFrame = 0, accumulator = 0, hudTime = 0, saveTime = 0, toastTimer, sound = false, audioContext;
  let lastKilled = 0, modalWasPaused = false, endShown = false, lastRender = 0, visualTime = 0;
  let profileUnsaved = false, immersive = false, fullscreenBusy = false;
  let deliveryCount = 0, lastRelicId = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const mobileEffects = matchMedia('(max-width: 760px), (max-height: 500px) and (max-width: 1024px), (pointer: coarse)');
  try {
    const pref = JSON.parse(localStorage.getItem(PREF_KEY));
    if (pref) options = {mode:pref.mode===4?4:2,mapId:MAPS[pref.mapId]?pref.mapId:'abyss',difficulty:['easy','normal','hard'].includes(pref.difficulty)?pref.difficulty:'normal'};
  } catch (_) { /* Storage can be disabled without preventing play. */ }
  try { saved = E.restoreGame(localStorage.getItem(SAVE_KEY)); } catch (_) {}
  try { profile = P.restoreProfile(localStorage.getItem(PROFILE_KEY)) || P.createProfile(); } catch (_) {}

  function notify(message) {
    $('toast').textContent = message; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2600);
  }
  function tone(frequency = 330, duration = .1, type = 'triangle', volume = .045) {
    if (!sound) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      audioContext.resume(); const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * .6, audioContext.currentTime + duration);
      gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
      oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + duration);
    } catch (_) { sound = false; $('sound').setAttribute('aria-pressed','false'); }
  }
  function save() {
    if(profileUnsaved&&!persistProfile(true))return;
    if (!playing || !state) return;
    saved = state.status === 'playing' ? E.restoreGame(JSON.stringify(state)) : null;
    try {
      // Keep a completed battle until its rewards have been stored successfully.
      if (state.status === 'playing' || !profile.claimedBattles.includes(state.battleId)) localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (_) { $('save-state').textContent = 'Saving is unavailable in this browser'; }
  }
  function refreshProfile() {
    if(profileUnsaved)return;
    try { profile = P.restoreProfile(localStorage.getItem(PROFILE_KEY)) || profile; } catch (_) {}
  }
  function persistProfile(silent=false) {
    try { localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));profileUnsaved=false;return true; }
    catch (_) {profileUnsaved=true;if(!silent)notify('Progress could not be saved. Keep this tab open to retain your rewards.');return false;}
  }
  function updateProfileHud() {
    $('gold-value').textContent=profile.gold.toLocaleString('en');
    $('armory').setAttribute('aria-label',`Open the Armory. ${profile.gold} gold. ${profile.unlocked.length} of ${E.CARD_DEFS.length} cards unlocked.`);
    $('collection-count').textContent=`${profile.unlocked.length} / ${E.CARD_DEFS.length} cards`;
    $('first-win-note').textContent=profile.firstVictory?'Win battles, earn gold and unlock new powers.':'Win your first battle to earn a free elemental card.';
  }
  function ownedCards(){return E.CARD_DEFS.filter(card=>profile.unlocked.includes(card.id));}
  function settleDeliveries(battle,announce=true) {
    if(!battle?.deliveries?.length)return;
    refreshProfile();
    const result=P.claimDeliveries(profile,battle);
    if(result.ok){persistProfile();updateProfileHud();if(announce&&result.gold>0){notify(`Treasure delivered! +${result.gold} gold added to your Armory.`);tone(780,.25);}}
  }
  function settleBattle(battle) {
    settleDeliveries(battle,false);
    refreshProfile();
    const reward=P.rewardBattle(profile,battle);
    if(persistProfile()&&(reward.ok||profile.claimedBattles.includes(battle.battleId))) {try {localStorage.removeItem(SAVE_KEY);}catch(_) {}}
    updateProfileHud();buildHand();return reward;
  }
  function saveOptions() { try {localStorage.setItem(PREF_KEY, JSON.stringify(options));} catch (_) {} }
  function formatTime(value) { const s = Math.floor(value);return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
  function applyTheme() {
    const map = MAPS[state.mapId];document.body.dataset.map = state.mapId;
    $('map-name').textContent = map.name.toLocaleUpperCase('en');$('arena-condition').textContent = map.subtitle;$('map-number').textContent = map.number;
    $('mode-label').textContent = state.mode === 4 ? 'CONQUEST · 4 KINGDOMS' : 'DUEL · 2 CASTLES';
  }
  function resize() {
    const bounds = $('canvas-wrap').getBoundingClientRect(), scale = Math.min(bounds.width/1000,bounds.height/700), dpr = Math.min(window.devicePixelRatio || 1,2);
    const width = Math.max(1,Math.floor(1000*scale)), height = Math.max(1,Math.floor(700*scale));
    canvas.style.width = width+'px';canvas.style.height = height+'px';
    if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
    draw();
  }
  function draw() {
    R.draw(ctx,state,{width:canvas.width,height:canvas.height,time:visualTime,selectedCard:playing?state.selectedCard:null,hoverPoint,reducedMotion:reducedMotion.matches,quality:mobileEffects.matches?'low':'high'});
  }
  function preview() {
    state = E.createGame({...options,availableCards:profile.unlocked});
    // A static garrison makes each illustrated map readable before the battle.
    for(const c of state.castles) {
      const angle = c.team === 0 ? -Math.PI/2 : c.team === 1 ? Math.PI/2 : c.team === 2 ? 0 : Math.PI;
      for(let i=0;i<3;i++) state.units.push({id:`preview-${c.team}-${i}`,team:c.team,cardId:['sentinel','archer','golem'][i],x:c.x+Math.cos(angle)*105+(i-1)*38,y:c.y+Math.sin(angle)*105,hp:100,maxHp:100,facing:angle});
    }
    applyTheme();$('difficulty').value=options.difficulty;
    document.querySelectorAll('.map-option').forEach(button=>{const chosen=button.dataset.map===options.mapId;button.classList.toggle('selected',chosen);button.setAttribute('aria-pressed',chosen);});
    document.querySelectorAll('#mode-picker button').forEach(button=>button.setAttribute('aria-pressed',Number(button.dataset.mode)===options.mode));
    $('resume').hidden=!saved;resize();
  }
  function showHome() {
    save();playing=false;paused=false;hoverPoint=null;
    document.body.className='is-home';$('setup').hidden=false;$('commander').hidden=true;$('controls').hidden=true;$('fortresses').hidden=true;$('pause').hidden=true;$('pause-banner').hidden=true;$('home-legend').hidden=false;
    $('arena-hint').textContent='◆ One kingdom to defend. Every other kingdom to conquer.';$('timer').textContent='00:00';
    preview();saveOptions();window.scrollTo({top:0,behavior:'instant'});
  }
  function startGame(resume=false) {
    refreshProfile();updateProfileHud();buildHand();
    state=resume&&saved?E.restoreGame(JSON.stringify(saved)):E.createGame({...options,availableCards:profile.unlocked});
    if(!state) state=E.createGame({...options,availableCards:profile.unlocked});
    state.availableCards=[...profile.unlocked];
    settleDeliveries(state,false);deliveryCount=state.deliveries?.length||0;lastRelicId=state.relic?.id||null;
    options={mode:state.mode,mapId:state.mapId,difficulty:state.difficulty};
    playing=true;paused=false;endShown=false;lastKilled=state.stats.kills;accumulator=0;lastFrame=0;visualTime=state.elapsed;hoverPoint=null;
    document.body.className='is-playing';$('setup').hidden=true;$('commander').hidden=false;$('controls').hidden=false;$('fortresses').hidden=false;$('pause').hidden=false;$('home-legend').hidden=true;$('pause-banner').hidden=true;
    $('pause').textContent='Pause';applyTheme();buildFortresses();updateHud();resize();save();saveOptions();
    window.scrollTo({top:0,behavior:'instant'});tone(520,.17);if(!resume)notify('Your citadel is at the bottom. Choose your first card!');
  }
  function buildFortresses() {
    $('fortresses').classList.toggle('four',state.mode===4);
    $('fortresses').innerHTML=state.castles.map(c=>`<button class="fortress" data-team="${c.team}" style="--team:${c.color}" ${c.team===0?'aria-label="Your castle"':'aria-pressed="false"'}><span class="fortress-pv"></span><span class="fortress-name">${['YOU','RED BASTION','SUNFIRE CROWN','TWILIGHT KEEP'][c.team]}</span><div class="hp-track"><i></i></div></button>`).join('');
  }
  function buildHand() {
    const cards=ownedCards();
    $('hand').innerHTML=cards.map((card,index)=>`<button class="card element-${card.element||'physical'}" data-card="${card.id}" aria-label="${card.name}, ${card.cost} aether${card.element&&card.element!=='physical'?', '+ELEMENT_LABELS[card.element]:''}" aria-pressed="false"><span class="card-art">${R.cardIcon(card.id)}</span><span class="card-cost">${card.cost}</span>${index<8?`<span class="card-key">${index+1}</span>`:''}<span class="card-name">${SHORT_NAMES[card.id]||card.name}</span><span class="card-type">${card.id==='runner'?'COLLECTOR':(card.element&&card.element!=='physical'?ELEMENT_LABELS[card.element].toUpperCase()+' · ':'')+TYPE_NAMES[card.kind]}</span></button>`).join('');
    $('hand-count').textContent=`${cards.length} READY`;
    $('mana-bar').innerHTML=Array.from({length:10},()=>'<i><b></b></i>').join('');
  }
  function selectedDef(){return E.CARD_DEFS.find(c=>c.id===state.selectedCard);}
  function runnerAvailability(){const point=E.defaultPlacement(state,'runner');return E.canCast(state,'runner',point.x,point.y);}
  function updateRelicHud() {
    const home=state.castles[0],relic=state.relic,runner=state.units.find(u=>u.team===0&&u.cardId==='runner'&&u.hp>0);
    const carrier=relic?.carrierId?state.units.find(u=>u.id===relic.carrierId):null;
    const name=relic?.kind==='gold'?'Gold chest':'×2 Aether',available=runnerAvailability();
    let title,description;
    if(!relic){title=`Next relic · ${formatTime(Math.ceil(Math.max(0,(state.nextRelicAt??state.elapsed)-state.elapsed)))}`;description='Relics appear at the center. Bring one home to claim it.';}
    else if(carrier?.team===0){title=`${name} · ${carrier.task==='collecting'?'picking up':'returning home'}`;description=carrier.task==='collecting'?'Your runner is securing the relic. Keep him safe!':'Follow the glowing runner back to your castle. The reward is not yours until he arrives alive.';}
    else if(carrier){title=`${name} · enemy carrier`;description=`${state.castles[carrier.team].name} has the relic. Stop the carrier before it reaches home.`;}
    else {title=`${name} at the center`;description=relic.kind==='gold'?'Bring it home for +40 gold. Every kingdom can claim it.':'Bring it home for double aether regeneration for 60 seconds.';}
    $('relic-status').textContent=title;$('relic-description').textContent=description;
    $('relic-symbol').textContent=relic?.kind==='gold'?'◆':relic?'×2':'✦';
    $('relic-panel').dataset.kind=relic?.kind||'waiting';$('relic-panel').classList.toggle('relic-available',!!relic&&!carrier);
    $('runner-status').textContent=runner?`${Math.ceil(runner.hp)} HP · ${runner.task==='collecting'?'PICKING UP':runner.carrying?'RETURNING':runner.task==='waiting'?'WAITING AT CENTER':'OUTBOUND'}`:home.runnerCooldown>0?`Runner ready in ${Math.ceil(home.runnerCooldown)}s`:`${RUNNER.cost} AETHER · ${RUNNER.hp} HP · UNARMED`;
    $('runner-journey').hidden=!runner;$('runner-journey').dataset.phase=runner?.task||'outbound';
    $('send-runner').disabled=paused||state.status!=='playing'||!available.ok;
    $('send-runner').textContent=runner?'Runner deployed':home.runnerCooldown>0?'Recovering…':!relic?'Waiting for relic':home.mana<RUNNER.cost?`Need ${RUNNER.cost} aether`:`Send · ${RUNNER.cost} aether`;
    $('send-runner').setAttribute('aria-label',`Send Relic Runner for ${RUNNER.cost} aether.${available.ok?'':` ${available.message}`}`);
    $('boost-indicator').hidden=!(home.aetherBoostTime>0);$('boost-time').textContent=formatTime(Math.ceil(home.aetherBoostTime||0));
    $('boost-indicator').setAttribute('aria-label',`Double aether regeneration. ${Math.ceil(home.aetherBoostTime||0)} seconds remaining.`);
  }
  function sendRunner() {
    if(!playing||paused||modal.open||state.status!=='playing')return;
    const result=E.playCard(state,'runner');notify(result.message);
    if(result.ok){deploymentFeedback('runner');tone(630,.13);save();updateHud();draw();}
  }
  function processRelicEvents() {
    if(state.relic&&state.relic.id!==lastRelicId){lastRelicId=state.relic.id;notify(state.relic.kind==='gold'?'A gold chest appeared at the center. Send your runner!':'A ×2 Aether relic appeared at the center. Send your runner!');tone(600,.18);}
    const receipts=state.deliveries||[];
    if(receipts.length>deliveryCount){
      // Store the successful return before applying its permanent gold reward.
      save();settleDeliveries(state);
      const latest=receipts.slice(deliveryCount);deliveryCount=receipts.length;
      if(latest.some(receipt=>receipt.team===0&&receipt.kind==='aether')){notify('Relic delivered! Double aether regeneration for 60 seconds.');tone(850,.3);}
      else if(latest.every(receipt=>receipt.team!==0)){const receipt=latest[latest.length-1];notify(`${state.castles[receipt.team].name} secured the ${receipt.kind==='gold'?'gold chest':'×2 Aether relic'}.`);}
    }
  }
  function showRelicRules() {
    showModal('A small runner. A big reward.',`<div class="card-detail-art">${R.cardIcon('runner')}</div><div class="detail-stats"><span>${RUNNER.cost} aether per dispatch</span><span>♥ 28 HP</span><span>Unarmed</span></div><div class="rules"><p><strong>Race to the center</strong><br>The first relic appears after 12 seconds. Every kingdom starts with this card. Spend ${RUNNER.cost} aether to send your collector from your castle. Follow his glowing ring and marked path to the center.</p><p><strong>Bring it home alive</strong><br>Watch him stop to pick up the relic, then walk back with the treasure on his pack. Picking it up does not grant its reward. He moves more slowly while carrying it. Enemy soldiers, spells and weapons can kill him. Escort him with your army!</p><p><strong>Two kinds of treasure</strong><br>×2 Aether doubles regeneration for 60 seconds. A gold chest adds 40 gold to your Armory as soon as it arrives home, even before the battle ends.</p><p><strong>Every kingdom competes</strong><br>Only one runner per kingdom can be deployed at a time, with a 20-second dispatch cooldown. Unladen runners wait at the center while a rival carries the relic. If the carrier dies, the relic returns to the center for another attempt.</p><p><strong>The next race</strong><br>A new relic appears 45 seconds after a successful delivery. Aether and gold alternate. Pausing the battle also pauses the race and the boost timer.</p></div>`,'THE RELIC RACE');
  }
  function updateHud() {
    if(!playing)return;
    updateRelicHud();
    const mana=state.castles[0].mana, card=selectedDef();$('mana-value').textContent=Math.floor(mana);$('timer').textContent=formatTime(state.elapsed);
    [...$('mana-bar').children].forEach((bar,i)=>bar.firstElementChild.style.width=Math.max(0,Math.min(1,mana-i))*100+'%');
    document.querySelectorAll('.card').forEach(button=>{const def=E.CARD_DEFS.find(c=>c.id===button.dataset.card);button.classList.toggle('unaffordable',mana<def.cost||(def.id==='runner'&&!runnerAvailability().ok));button.setAttribute('aria-pressed',state.selectedCard===def.id);});
    document.querySelectorAll('.fortress').forEach(button=>{const c=state.castles[Number(button.dataset.team)];button.querySelector('.fortress-pv').textContent=c.alive?Math.ceil(c.hp)+' HP':'DESTROYED';button.querySelector('.hp-track i').style.width=Math.max(0,c.hp/c.maxHp*100)+'%';button.classList.toggle('dead',!c.alive);if(c.team!==0){button.setAttribute('aria-pressed',state.targetTeam===c.team&&c.alive);button.disabled=!c.alive;button.setAttribute('aria-label',`${c.name}, ${Math.ceil(c.hp)} HP. ${state.targetTeam===c.team?'Current target':'Attack this castle'}`);}});
    $('army-count').textContent=state.units.filter(u=>u.team===0).length;$('tower-count').textContent=state.towers.filter(u=>u.team===0).length+' / 3';
    $('details').disabled=!card;$('cast').disabled=!card||paused||state.status!=='playing'||mana<card.cost||(card.id==='runner'&&!runnerAvailability().ok);
    $('cast').innerHTML=card?.id==='runner'?'Send runner <span>➜</span>':card?.kind==='tower'?'Build <span>➜</span>':card?.kind==='spell'?'Auto-cast <span>✦</span>':'Deploy <span>➜</span>';
    const selectedText=card?.id==='runner'?`Relic Runner · ${RUNNER.cost} aether · ${RUNNER.hp} HP. ${runnerAvailability().ok?'Send him from your castle. Escort him home to claim the relic.':runnerAvailability().message}`:card?`${card.name} · ${card.cost} aether. ${mana<card.cost?'Wait for your aether to recharge.':card.kind==='spell'?'Tap a target, or use Auto-cast.':card.kind==='tower'?'Tap your territory, or use Build.':'Tap your territory, or use Deploy.'}`:`Choose a card. Scroll your hand to see all ${ownedCards().length} cards.`;
    if($('selection-hint').textContent!==selectedText)$('selection-hint').textContent=selectedText;
    const target=state.castles.find(c=>c.team===state.targetTeam);
    $('arena-hint').textContent=paused?'Ⅱ Battle paused':card?.id==='runner'?'✦ Your runner collects relics and returns home. Keep him alive!':card?`◆ ${card.kind==='spell'?'Spell ready: tap an area to target.':'Deploy within the highlighted area.'}`:`⚑ Target: ${target?.name||'none'}${state.mode===4?' · Tap a castle above to change target.':''}`;
    if(hoverPoint&&card)hoverPoint.valid=E.canCast(state,card.id,hoverPoint.x,hoverPoint.y).ok;
  }
  function selectCard(id) {
    if(!playing||state.status!=='playing')return;
    state.selectedCard=state.selectedCard===id?null:id;hoverPoint=null;
    if(state.selectedCard&&id!=='runner'){const point=E.defaultPlacement(state,id);hoverPoint={...point,valid:E.canCast(state,id,point.x,point.y).ok};}
    updateHud();save();tone(410,.045);draw();
  }
  function cast(point) {
    if(!playing||paused||modal.open||!state.selectedCard||state.status!=='playing')return;
    const selected=selectedDef(), place=point||E.defaultPlacement(state,state.selectedCard);
    const result=E.playCard(state,state.selectedCard,place.x,place.y);
    if(!result.ok){notify(result.message);tone(100,.08,'sawtooth',.02);return;}
    deploymentFeedback(selected.id);tone(selected.kind==='spell'?740:selected.kind==='tower'?170:420,.15);notify(result.message);hoverPoint=null;updateHud();save();
    if(state.status!=='playing')showResult();
  }
  function deploymentFeedback(id) {
    if(reducedMotion.matches)return;
    const button=document.querySelector(`.card[data-card="${id}"]`);
    if(button?.animate)button.animate([{filter:'brightness(1.5)',transform:'translateY(0)'},{filter:'brightness(1)',transform:'translateY(0)'}],{duration:420,easing:'ease-out'});
  }
  function setPaused(value) {
    if(!playing||state.status!=='playing')return;
    paused=value;accumulator=0;lastFrame=0;$('pause-banner').hidden=!paused;$('pause').textContent=paused?'Resume':'Pause';updateHud();save();
  }
  function showModal(title,body,kicker='THE CONQUEROR’S HANDBOOK') {
    if(!modal.open){modalWasPaused=paused;if(playing)setPaused(true);}
    modal.classList.remove('armory-modal');
    $('modal-title').textContent=title;$('modal-kicker').textContent=kicker;$('modal-body').innerHTML=body;if(!modal.open)modal.showModal();modal.scrollTop=0;
  }
  function showBattleMenu() {
    if(!playing)return;
    showModal('Command your kingdom.',`<div class="detail-stats"><span>${MAPS[state.mapId].name}</span><span>${state.mode===4?'Four kingdoms':'Duel'}</span><span>${formatTime(state.elapsed)}</span></div><div class="battle-menu-actions"><button id="menu-resume" class="primary">Return to battle <span>➜</span></button><button id="menu-maps" class="quiet">Maps & modes</button><button id="menu-armory" class="quiet">Visit the Armory</button><button id="menu-sound" class="quiet">${sound?'Mute sound':'Enable sound'}</button><button id="menu-guide" class="quiet">How to play</button></div><p class="menu-note">Your battle is paused. Progress is saved on this device.</p>`,'THE ABYSSAL CROWN');
    $('menu-resume').onclick=()=>modal.close();
    $('menu-maps').onclick=()=>{modal.close();showHome();};
    $('menu-armory').onclick=showArmory;
    $('menu-sound').onclick=()=>{$('sound').click();$('menu-sound').textContent=sound?'Mute sound':'Enable sound';};
    $('menu-guide').onclick=()=>$('help').click();
  }
  function elementGuide(){return `<div class="element-guide"><span class="fire">Fire <b>→</b> Ice</span><span class="ice">Ice <b>→</b> Water</span><span class="water">Water <b>→</b> Fire</span></div><p class="element-explainer">An advantage deals 35% more damage. Matching elements resist 35% of damage. Physical attacks are neutral. Aegis reduces incoming damage by 40% for 8 seconds.</p>`;}
  function affinityInfo(card){return card.affinity&&card.affinity!=='neutral'?`Resists ${ELEMENT_LABELS[card.resistance||card.affinity]} · vulnerable to ${ELEMENT_LABELS[card.weakness]||'elemental counters'}`:'No elemental weakness';}
  function showArmory() {
    refreshProfile();updateProfileHud();
    const cards=P.UNLOCKS.map(unlock=>{
      const card=E.CARD_DEFS.find(c=>c.id===unlock.id),owned=profile.unlocked.includes(card.id),affordable=profile.gold>=unlock.price;
      return `<article class="shop-card element-${card.element||'physical'}"><div class="shop-art">${R.cardIcon(card.id)}<span class="shop-mana">${card.cost} AETHER</span></div><div class="shop-copy"><div class="shop-type">${TYPE_NAMES[card.kind]}${card.element&&card.element!=='physical'?' · '+ELEMENT_LABELS[card.element].toUpperCase():''}</div><h3>${card.name}</h3><p>${card.description}</p>${card.kind==='unit'?`<small>${affinityInfo(card)}</small>`:''}<button class="${owned?'owned':'purchase'}" data-unlock="${card.id}" ${owned||!affordable?'disabled':''} aria-label="${owned?card.name+' unlocked':'Unlock '+card.name+' for '+unlock.price+' gold'}">${owned?'✓ Unlocked':`<span>Unlock</span><strong>◆ ${unlock.price}</strong>`}</button>${!owned&&!affordable?`<small class="gold-needed">Earn ${unlock.price-profile.gold} more gold</small>`:''}</div></article>`;
    }).join('');
    showModal('The Armory',`<div class="armory-intro"><p>New powers. New ways to conquer.<small>Your nine starter cards include the Relic Runner. Dispatching him costs ${RUNNER.cost} aether. Every unlock joins your hand immediately.</small></p><div class="gold-balance"><span>YOUR GOLD</span><strong>◆ ${profile.gold.toLocaleString('en')}</strong></div></div><div id="shop-status" class="shop-status" role="status" tabindex="-1">${profile.firstVictory?'Battle spoils turn into permanent unlocks.':'FIRST VICTORY REWARD · A free elemental card + gold'}</div>${elementGuide()}<div class="shop-grid">${cards}</div><div class="armory-footnote"><strong>Earn your war chest</strong><p>Victory earns at least 120 gold. Conquest and higher difficulties pay more. Enemy defeats add a bonus. A defeat after 20 seconds with a summoned unit still earns a small reward.</p><p>Gold and cards are saved in this browser on this device.</p></div>`,'YOUR COLLECTION · '+profile.unlocked.length+' / '+E.CARD_DEFS.length);
    modal.classList.add('armory-modal');
  }
  function purchaseCard(id) {
    refreshProfile();const result=P.purchase(profile,id);
    if(!result.ok){notify(result.message);showArmory();return;}
    persistProfile();if(playing)state.availableCards=[...profile.unlocked];
    buildHand();updateProfileHud();updateHud();save();
    const scroll=modal.scrollTop;showArmory();modal.scrollTop=scroll;
    const card=E.CARD_DEFS.find(c=>c.id===id);$('shop-status').textContent=`${card.name} unlocked! Ready in your summoning hand.`;
    $('shop-status').focus({preventScroll:true});tone(740,.22);notify(`${card.name} unlocked!`);
  }
  function showRules() {
    showModal('The art of the siege',`<div class="rules"><p><strong>Claim the crown</strong><br>Destroy the enemy castle before yours falls. In Conquest, four kingdoms fight for themselves. Defeat all three rivals to win.</p><p><strong>1. Summon your army</strong><br>Select a card, then tap your highlighted territory. Your soldiers and monsters march toward your target and fight enemies along the way. Deploy picks a safe position for you.</p><p><strong>2. Fortify your kingdom</strong><br>Cannons and mortars stay where you build them. Place up to three weapons near your citadel. Your enemies can build defenses, too.</p><p><strong>3. Master your aether</strong><br>The violet number is a card’s cost. Aether regenerates up to 10. Healing Spring restores nearby allies; Abyssal Lightning strikes an enemy area.</p><p><strong>Choose your target</strong><br>In Conquest, tap an enemy castle in the bar above the battlefield. Your entire army receives the new objective.</p><p><strong>Play anywhere</strong><br>Scroll your hand to reach every card. Details shows the selected card’s full description. Both screen orientations and browser zoom are supported. Battles save on this device and pause when you leave the tab. Ambient effects respect your device’s reduced-motion setting.</p><p><strong>Keyboard shortcuts</strong><br><kbd>1</kbd>–<kbd>8</kbd> select a card · <kbd>Enter</kbd> on the battlefield deploys · <kbd>P</kbd> pauses · <kbd>Esc</kbd> closes a window or clears your selection.</p></div>`);
  }
  function showCard() {
    const card=selectedDef();if(!card)return;
    if(card.id==='runner'){showRelicRules();return;}
    const stats=`<span>◆ ${card.cost} aether</span>${card.hp?`<span>♥ ${card.hp} HP</span>`:''}${card.damage?`<span>⚔ ${card.damage} damage</span>`:''}${card.range?`<span>◎ ${card.range} range</span>`:''}`;
    showModal(card.name,`<div class="card-detail-art">${R.cardIcon(card.id)}</div><div class="detail-stats">${stats}</div><div class="rules"><p>${card.description}</p><p>${card.kind==='tower'?'A stationary weapon. Build it within your territory.':card.kind==='unit'?'Advances toward your target and attacks enemies along the way.':'Tap an area on the battlefield, or use Auto-cast to choose a target for you.'}</p></div>`,TYPE_NAMES[card.kind]);
    $('modal-body').insertAdjacentHTML('beforeend',`<div class="affinity-detail element-${card.element||'physical'}"><strong>${card.kind==='spell'&&!card.damage?'Support spell':(ELEMENT_LABELS[card.element]||'Physical')+' attack'}</strong>${card.kind==='unit'?`<span>${affinityInfo(card)}</span>`:''}</div>${elementGuide()}`);
  }
  function showResult() {
    if(endShown)return;endShown=true;save();const reward=settleBattle(state);
    const won=state.status==='won';tone(won?660:130,.5);
    const unlocks=(reward.newCards||[]).map(id=>{const c=E.CARD_DEFS.find(c=>c.id===id);return `<div class="reward-card"><span>${R.cardIcon(id)}</span><div><small>FIRST VICTORY UNLOCK</small><strong>${c.name}</strong><p>Added to your summoning hand.</p></div></div>`;}).join('');
    showModal(won?'The crown is yours.':'Your kingdom has fallen.',`<div class="result-icon">${won?'♛':'♜'}</div><p class="result-summary">${won?'The rival fortresses lie in ruins. Your reign begins.':'The depths have not heard the last of you.'}</p><div class="battle-reward"><span>WAR SPOILS</span><strong>+${reward.gold||0} <small>GOLD</small></strong><p>${reward.gold?'Your next power is waiting in the Armory.':'Summon a unit and fight for at least 20 seconds to earn defeat rewards.'}</p></div>${unlocks}<div class="detail-stats"><span>◷ ${formatTime(state.elapsed)}</span><span>${state.stats.unitsSummoned} ${state.stats.unitsSummoned===1?'unit':'units'} summoned</span><span>${state.stats.kills} ${state.stats.kills===1?'enemy':'enemies'} defeated</span></div><div class="modal-actions"><button id="replay" class="primary">Play again <span>↻</span></button><button id="result-armory" class="quiet">Visit the Armory</button><button id="choose-map" class="quiet">Choose another map</button></div>`,won?'VICTORY':'DEFEAT');
    $('replay').onclick=()=>{modal.close();startGame();};$('choose-map').onclick=()=>{modal.close();showHome();};
    $('result-armory').onclick=()=>{showHome();showArmory();};
  }
  function fullscreenElement(){return document.fullscreenElement||document.webkitFullscreenElement;}
  function syncFullscreen() {
    const active=Boolean(fullscreenElement())||immersive;
    document.documentElement.dataset.immersive=active?'true':'false';
    const label=active?(immersive?'Exit expanded view':'Exit fullscreen'):'Enter fullscreen';
    $('fullscreen').setAttribute('aria-label',label);$('fullscreen').setAttribute('aria-pressed',String(active));$('fullscreen').title=label;
    requestAnimationFrame(resize);
  }
  async function toggleFullscreen() {
    if(fullscreenBusy)return;fullscreenBusy=true;
    try {
      if(fullscreenElement()) {
        const exit=document.exitFullscreen||document.webkitExitFullscreen;
        if(exit)await exit.call(document);
      } else if(immersive) immersive=false;
      else {
        const request=document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen;
        if(request) {
          try {await request.call(document.documentElement);}
          catch (_) {immersive=true;notify('Expanded view enabled. This browser does not allow native fullscreen.');}
        } else {immersive=true;notify('Expanded view enabled. Use the same button to exit.');}
      }
    } catch (_) {notify('Use Escape or your browser’s fullscreen control to exit.');}
    finally {fullscreenBusy=false;syncFullscreen();}
  }
  function mapPoint(event) {const bounds=canvas.getBoundingClientRect();return{x:(event.clientX-bounds.left)/bounds.width*1000,y:(event.clientY-bounds.top)/bounds.height*700};}
  let pressPoint=null;
  canvas.addEventListener('pointerdown',event=>{pressPoint={clientX:event.clientX,clientY:event.clientY,id:event.pointerId};});
  canvas.addEventListener('pointercancel',()=>pressPoint=null);
  canvas.addEventListener('pointerup',event=>{if(pressPoint?.id===event.pointerId&&Math.hypot(event.clientX-pressPoint.clientX,event.clientY-pressPoint.clientY)<10){if(!playing)return;const point=mapPoint(event);if(state.selectedCard)cast(point);else{const target=state.castles.find(c=>c.team!==0&&c.alive&&Math.hypot(c.x-point.x,c.y-point.y)<65);if(target){E.setTarget(state,target.team);updateHud();save();}else notify('Select a card from your hand.');}}pressPoint=null;});
  canvas.addEventListener('pointermove',event=>{if(!playing||!state.selectedCard||event.pointerType==='touch')return;const point=mapPoint(event);hoverPoint={...point,valid:E.canCast(state,state.selectedCard,point.x,point.y).ok};});
  canvas.addEventListener('pointerleave',()=>{hoverPoint=null;pressPoint=null;});
  $('map-picker').addEventListener('click',event=>{const button=event.target.closest('[data-map]');if(!button)return;options.mapId=button.dataset.map;preview();saveOptions();});
  $('mode-picker').addEventListener('click',event=>{const button=event.target.closest('[data-mode]');if(!button)return;options.mode=Number(button.dataset.mode);preview();saveOptions();});
  $('difficulty').addEventListener('change',event=>{options.difficulty=event.target.value;saveOptions();});
  $('start').onclick=()=>startGame();$('resume').onclick=()=>startGame(true);
  $('hand').addEventListener('click',event=>{const card=event.target.closest('[data-card]');if(card)selectCard(card.dataset.card);});
  $('fortresses').addEventListener('click',event=>{const button=event.target.closest('[data-team]');if(!button)return;if(Number(button.dataset.team)===0){notify(`Your citadel: ${Math.ceil(state.castles[0].hp)} HP. Defend it!`);return;}if(E.setTarget(state,Number(button.dataset.team))){tone(280,.06);updateHud();save();}});
  $('cast').onclick=()=>cast();$('details').onclick=showCard;$('pause').onclick=()=>setPaused(!paused);$('unpause').onclick=()=>setPaused(false);$('menu').onclick=showHome;
  $('help').onclick=()=>{showRules();$('modal-body').insertAdjacentHTML('beforeend',`<div class="rules extra-rules"><p><strong>Race for the relic</strong><br>Every kingdom starts with the Relic Runner: ${RUNNER.cost} aether per dispatch, 28 HP and no attacks. Use Send runner to collect the central treasure. Escort him home to earn 40 gold or double aether regeneration for 60 seconds. If the carrier dies, the relic returns to the center. The ? button beside the relic explains the race.</p><p><strong>Earn gold. Unlock power.</strong><br>Visit the Armory to spend battle rewards on seven new cards. Your first victory grants a free elemental card. All unlocked cards join your hand automatically. Enemies gain elemental reinforcements as battles progress.</p><p><strong>Counter the elements</strong><br>Fire burns. Ice slows movement and attacks. Water counters fire. The Coral Golem resists ice but fears fire; your Tide Archer resists water but fears ice. Aegis Ward protects nearby allies for eight seconds.</p></div>${elementGuide()}<div class="rules extra-rules"><p><strong>Fill the screen</strong><br>The four-corner button enters fullscreen. If your browser does not support it, the game uses an expanded layout. Use the button again or Escape to exit.</p></div>`);};
  $('armory').onclick=showArmory;$('collection').onclick=showArmory;$('fullscreen').onclick=toggleFullscreen;
  $('battle-menu').onclick=showBattleMenu;
  $('send-runner').onclick=sendRunner;$('relic-help').onclick=showRelicRules;
  modal.addEventListener('click',event=>{const button=event.target.closest('[data-unlock]');if(button&&!button.disabled)purchaseCard(button.dataset.unlock);});
  document.addEventListener('fullscreenchange',()=>{immersive=false;syncFullscreen();});
  document.addEventListener('webkitfullscreenchange',()=>{immersive=false;syncFullscreen();});
  $('sound').onclick=()=>{sound=!sound;$('sound').setAttribute('aria-pressed',sound);$('sound').setAttribute('aria-label',sound?'Mute sound':'Enable sound');document.querySelector('.sound-slash').hidden=sound;if(sound)tone(600,.12);};
  $('close-modal').onclick=()=>modal.close();
  modal.addEventListener('close',()=>{if(playing&&state.status==='playing')setPaused(modalWasPaused);});
  document.addEventListener('keydown',event=>{
    if(modal.open||event.target.matches('select,input,textarea'))return;
    if(event.key==='Escape'){if(immersive){immersive=false;syncFullscreen();return;}if(playing&&state.selectedCard){state.selectedCard=null;hoverPoint=null;updateHud();save();}return;}
    if(!playing)return;
    if(/^[1-8]$/.test(event.key)){event.preventDefault();selectCard(ownedCards()[Number(event.key)-1].id);}
    else if(event.key.toLowerCase()==='p'){event.preventDefault();setPaused(!paused);}
    else if(event.key==='Enter'&&event.target===canvas){event.preventDefault();cast();}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(playing&&!modal.open)setPaused(true);save();}});
  window.addEventListener('pagehide',save);
  new ResizeObserver(resize).observe($('canvas-wrap'));
  window.addEventListener('resize',resize);
  function frame(now) {
    const dt=lastFrame?Math.min((now-lastFrame)/1000,.15):0;lastFrame=now;
    if(!document.hidden&&(!playing||(!paused&&!modal.open&&state.status==='playing')))visualTime+=dt;
    if(playing&&!paused&&!modal.open&&state.status==='playing') {
      accumulator+=dt;while(accumulator>=1/30){E.advance(state,1/30);accumulator-=1/30;}
      processRelicEvents();
      if(state.stats.kills>lastKilled){tone(115,.06,'triangle',.02);lastKilled=state.stats.kills;}
      if(state.status!=='playing')showResult();
      saveTime+=dt;if(saveTime>2){saveTime=0;save();}
    }
    hudTime+=dt;if(hudTime>.12){hudTime=0;updateHud();}
    // Cap presentation work on phones; combat uses its own fixed simulation step.
    const frameBudget=mobileEffects.matches?1000/30:1000/60;
    if(!document.hidden&&now-lastRender>=frameBudget-1){draw();lastRender=now;}
    requestAnimationFrame(frame);
  }
  updateProfileHud();buildHand();preview();
  if(saved)settleDeliveries(saved,false);
  if(saved&&saved.status!=='playing'){const reward=settleBattle(saved);saved=null;$('resume').hidden=true;if(reward.gold)notify(`Battle rewards recovered: +${reward.gold} gold.`);}
  syncFullscreen();requestAnimationFrame(frame);
})();
