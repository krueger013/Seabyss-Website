(() => {
  'use strict';
  const E = window.PirateDraughts;
  const $ = id => document.getElementById(id);
  const SAVE = 'seabyss-dames-v1';
  let mode = 'ai', gameMode = 'ai', level = 'moyen', sound = false, audio;
  let state = null, history = [], log = [], selected = null, route = [], hint = null;
  let aiTimer = null, toastTimer = null, revision = 0, screen = 'home', modalKind = '';
  const coord = i => String.fromCharCode(97 + i % 10) + (10 - Math.floor(i / 10));
  const pieceX = p => p === 1 ? '0%' : p === -1 ? '33.3333%' : p === 2 ? '66.6667%' : '100%';
  const pieceName = p => `${Math.abs(p) === 2 ? 'Dame' : 'Pion'} ${p > 0 ? 'doré' : 'turquoise'}`;
  const safeStore = () => {
    try { localStorage.setItem(SAVE, JSON.stringify({version:1,state,history:history.slice(-24),log:log.slice(-200),mode,gameMode,level,sound,selected,route})); }
    catch { /* Le duel reste jouable si le navigateur refuse le stockage. */ }
  };
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE));
      if (!saved || saved.version !== 1) return;
      mode = saved.mode === 'local' ? 'local' : 'ai'; gameMode = (saved.gameMode || saved.mode) === 'local' ? 'local' : 'ai';
      level = ['facile','moyen','difficile'].includes(saved.level) ? saved.level : 'moyen';
      sound = saved.sound === true;
      if (E.validateState(saved.state)) {
        state = saved.state;
        history = Array.isArray(saved.history) ? saved.history.filter(s => E.validateState(s)).slice(-24) : [];
        log = Array.isArray(saved.log) ? saved.log.filter(s => typeof s === 'string').slice(-200) : [];
        selected = Number.isInteger(saved.selected) ? saved.selected : null;
        route = Array.isArray(saved.route) && saved.route.every(Number.isInteger) ? saved.route : [];
        if (!candidates().length) { selected = null; route = []; }
      }
    } catch { state = null; }
  }
  function note(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2800);
  }
  function tone(kind = 'move') {
    if (!sound) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const now = audio.currentTime, notes = kind === 'win' ? [330,440,554,660] : kind === 'capture' ? [130,195] : kind === 'crown' ? [440,660] : [240];
      notes.forEach((hz,i) => { const oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(hz,now+i*.085); oscillator.frequency.exponentialRampToValueAtTime(hz*.68,now+i*.085+.18); gain.gain.setValueAtTime(.0001,now); gain.gain.setValueAtTime(.10,now+i*.085); gain.gain.exponentialRampToValueAtTime(.0001,now+i*.085+.23); oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now+i*.085); oscillator.stop(now+i*.085+.25); });
    } catch { sound = false; updateSettings(); }
  }
  function updateSettings() {
    document.querySelectorAll('[data-mode]').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('active',on); b.setAttribute('aria-pressed',String(on)); });
    document.querySelectorAll('[data-level]').forEach(b => { const on = b.dataset.level === level; b.classList.toggle('active',on); b.setAttribute('aria-pressed',String(on)); });
    $('difficulty-line').hidden = mode === 'local';
    $('sound').setAttribute('aria-pressed',String(sound));
    $('sound').setAttribute('aria-label',sound ? 'Couper les sons' : 'Activer les sons');
    $('sound').querySelector('.sound-label').textContent = sound ? 'Son activé' : 'Son coupé';
    $('resume').hidden = !state || state.winner !== null;
  }
  function preview() {
    const b = E.createGame().board;
    $('preview-board').innerHTML = b.map((p,i) => `<div class="preview-cell ${(Math.floor(i/10)+i%10)%2 ? 'dark' : ''}">${p ? `<span class="piece ${p>0?'gold':'teal'}" style="--x:${pieceX(p)}"></span>` : ''}</div>`).join('');
  }
  function cancelAI() { clearTimeout(aiTimer); aiTimer = null; revision++; $('game').classList.remove('thinking'); }
  function showHome() {
    cancelAI(); screen = 'home'; $('game').hidden = true; $('home').hidden = false;
    updateSettings(); safeStore(); window.scrollTo(0,0);
  }
  function showGame() {
    if (!state) return;
    screen = 'game'; $('home').hidden = true; $('game').hidden = false;
    $('toast').hidden = true; render(); window.scrollTo(0,0); scheduleAI();
  }
  function start(useMode = mode) {
    cancelAI(); gameMode = useMode; state = E.createGame(); history = []; log = []; selected = null; route = []; hint = null;
    safeStore(); showGame(); tone();
  }
  function humanTurn() { return state && state.winner === null && (gameMode === 'local' || state.turn === 1); }
  function candidates() {
    if (!state || selected === null) return [];
    return E.legalMoves(state).filter(m => m.from === selected && route.every((p,i) => m.path[i] === p));
  }
  function activeBoard() {
    const b = state.board.slice();
    if (selected !== null && route.length) { const p=b[selected]; b[selected]=0; b[route[route.length-1]]=p; }
    return b;
  }
  function render() {
    if (!state) return;
    const focusIndex = document.activeElement?.closest('#board [data-cell]')?.dataset.cell;
    const moves = E.legalMoves(state), options = candidates(), next = new Set(options.map(m => m.path[route.length]));
    const current = route.length ? route[route.length-1] : selected;
    const partialCaptures = route.length && options[0] ? options[0].captures.slice(0,route.length) : [];
    const display = activeBoard(), last = state.lastMove;
    const fragment = document.createDocumentFragment();
    display.forEach((p,i) => {
      const row = Math.floor(i/10), col = i%10, dark = (row+col)%2 === 1;
      const el = document.createElement(dark ? 'button' : 'div');
      el.className = ['square',dark?'dark':'',current===i?'selected':'',next.has(i)?'option':'',partialCaptures.includes(i)?'captured':'',last && (last.from===i || last.to===i)?'last':'',hint && (hint.from===i || hint.path.includes(i))?'hinted':''].filter(Boolean).join(' ');
      if (dark) {
        el.dataset.cell = i;
        el.setAttribute('aria-label',`${coord(i)}, ${p ? pieceName(p) : 'case libre'}${next.has(i) ? ', destination possible' : ''}${current===i ? ', sélectionné' : ''}`);
        el.setAttribute('aria-pressed',String(current===i));
        el.tabIndex = i === Number(focusIndex ?? current ?? 61) ? 0 : -1;
      } else el.setAttribute('aria-hidden','true');
      if (p) { const token = document.createElement('span'); token.className='piece '+(p>0?'gold':'teal'); token.style.setProperty('--x',pieceX(p)); el.append(token); }
      fragment.append(el);
    });
    $('board').replaceChildren(fragment);
    if (focusIndex !== undefined) $('board').querySelector(`[data-cell="${focusIndex}"]`)?.focus({preventScroll:true});
    const counts=E.pieceCounts(state);
    for (const team of ['gold','teal']) {
      const n = counts[team]; $(''+team+'-count').textContent = n.total;
      $(team+'-kings').textContent = n.kings ? `${n.kings} dame${n.kings>1?'s':''} couronnée${n.kings>1?'s':''}` : 'Aucune dame couronnée';
      $(team+'-turn').classList.toggle('current',state.winner===null && state.turn===(team==='gold'?1:-1));
    }
    $('gold-turn').textContent = state.turn===1 && state.winner===null ? 'À vous de jouer' : 'Guette la marée';
    $('teal-turn').textContent = state.turn===-1 && state.winner===null ? (gameMode==='ai' ? 'Le capitaine réfléchit…' : 'À vous de jouer') : 'Guette la marée';
    $('turn-number').textContent = `TOUR ${String(Math.floor(state.ply/2)+1).padStart(2,'0')}`;
    const captureCount=moves[0]?.captures.length || 0;
    let title = state.turn===1 ? 'À vous, capitaine' : gameMode==='ai' ? 'Le Kraken prépare son coup' : 'Au tour du Kraken';
    let status = humanTurn() ? `Sélectionnez un pion ${state.turn===1?'doré':'turquoise'}, puis une case lumineuse.` : 'L’équipage des abysses prépare sa manœuvre…';
    if (captureCount && humanTurn()) status = `Prise obligatoire : ${captureCount} pièce${captureCount>1?'s':''} à capturer. Choisissez un pion puis la case lumineuse.`;
    if (selected !== null && humanTurn()) status = route.length ? 'La rafle continue : touchez la prochaine case lumineuse.' : 'Touchez une case lumineuse pour déplacer votre pièce.';
    if (hint) status = 'Conseil : la pièce et son parcours sont encadrés en turquoise.';
    if (state.winner !== null) { title=state.winner===0?'Pavillon blanc':state.winner===1?'Victoire des Corsaires':'Victoire du Kraken'; status='Le duel est terminé. Rejouez depuis le menu.'; }
    $('turn-title').textContent=title; $('status').textContent=status;
    $('undo').disabled = !history.length && selected===null;
    $('hint').disabled = !humanTurn() || route.length>0;
    $('move-log').innerHTML='';
    (log.length ? log.slice(-4) : ['Les équipages prennent place.']).forEach(text=>{const li=document.createElement('li');li.textContent=text;$('move-log').append(li);});
  }
  function clickCell(index) {
    if (!humanTurn() || $('modal').open) return;
    const possible=candidates(), next=possible.filter(m=>m.path[route.length]===index);
    if (next.length) {
      route.push(index); hint=null;
      const complete=next.find(m=>m.path.length===route.length);
      if (complete) commit(complete);
      else {tone('capture');render();safeStore();}
      return;
    }
    if (route.length) {note('Terminez la rafle sur une case lumineuse.');return;}
    if (selected===index) {selected=null;hint=null;render();safeStore();return;}
    if (state.board[index]*state.turn>0) {
      if (!E.legalMoves(state).some(m=>m.from===index)) {note('Cette pièce ne peut pas jouer. Une prise prioritaire peut être obligatoire.');return;}
      selected=index;route=[];hint=null;render();safeStore();
    }
  }
  function commit(move) {
    const before=state, next=E.applyMove(state,move);
    history.push(before); if(history.length>24)history.shift();
    state=next;
    log.push(`${before.turn===1?'Or':'Kraken'} · ${coord(move.from)} ${move.captures.length?'×':'→'} ${move.path.map(coord).join(' → ')}${move.captures.length?' · '+move.captures.length+' prise'+(move.captures.length>1?'s':''):''}`);
    selected=null;route=[];hint=null;
    tone(state.winner!==null?'win':Math.abs(before.board[move.from])===1&&Math.abs(state.board[move.to])===2?'crown':move.captures.length?'capture':'move');
    safeStore();render();
    if(state.winner!==null) result(); else scheduleAI();
  }
  function scheduleAI() {
    if (screen!=='game' || !state || state.winner!==null || gameMode!=='ai' || state.turn!==-1 || $('modal').open || aiTimer) return;
    const ticket=revision;
    $('game').classList.add('thinking');
    aiTimer=setTimeout(()=>{
      aiTimer=null;
      if(ticket!==revision || screen!=='game' || $('modal').open)return;
      const move=E.chooseMove(state,level);
      $('game').classList.remove('thinking');
      if(move)commit(move);
    },550);
  }
  function undo() {
    cancelAI();
    if(selected!==null){selected=null;route=[];hint=null;render();safeStore();scheduleAI();return;}
    if(!history.length)return;
    state=history.pop();log.pop();
    if(gameMode==='ai' && state.turn===-1 && history.length){state=history.pop();log.pop();}
    selected=null;route=[];hint=null;safeStore();render();scheduleAI();
  }
  function openModal(kind,title,kicker,html) {
    cancelAI(); modalKind=kind; $('modal-title').textContent=title;$('modal-kicker').textContent=kicker;$('modal-content').innerHTML=html;
    if(!$('modal').open)$('modal').showModal(); $('modal').scrollTop=0;
  }
  function closeModal() { $('modal').close();modalKind='';scheduleAI(); }
  function rules() {
    openModal('rules','Le code des corsaires','LES DAMES · 100 CASES',`<ol class="rules-list"><li><strong>Deux équipages, un seul vainqueur.</strong>Chaque camp dispose de 20 pions. Les Corsaires dorés commencent. Capturez toutes les pièces adverses, ou empêchez-les de jouer.</li><li><strong>Avancez en diagonale.</strong>Un pion avance d’une case libre vers le camp adverse, uniquement sur les cases sombres. Touchez votre pièce, puis une destination lumineuse.</li><li><strong>Une prise ? À l’abordage !</strong>Les prises sont obligatoires, vers l’avant comme vers l’arrière. Sautez une pièce ennemie et atterrissez sur la case libre juste derrière. Si plusieurs prises s’enchaînent, terminez la rafle. Le parcours capturant le plus de pièces est imposé.</li><li><strong>Couronnez votre légende.</strong>Un pion qui termine son tour sur la dernière rangée devient une dame. Elle glisse aussi loin qu’elle le souhaite en diagonale et peut capturer à distance. Une seule pièce ennemie peut être franchie par saut.</li><li><strong>Gardez le cap.</strong>Les pièces capturées restent bloquantes jusqu’à la fin d’une rafle. Une pièce ne se capture qu’une fois. Une rafle peut ramener une dame à sa case de départ.</li></ol><p class="rules-note">Nulle après trois répétitions de la même position avec le même camp au trait, ou 25 tours de chaque camp sans prise ni déplacement de pion. Les finales à décompte spécial de compétition ne sont pas appliquées.<br><br>Au clavier : Tab pour atteindre le damier, flèches pour parcourir les cases, Entrée ou Espace pour jouer. Votre duel et votre sélection sont sauvegardés sur cet appareil.</p><div class="dialog-actions"><button data-dialog="close">J’ai compris · Prendre la mer</button></div>`);
  }
  function pause() {
    openModal('pause','Une escale, capitaine ?','LE DUEL EST SAUVEGARDÉ',`<span data-language-picker></span><p class="result-copy">Votre équipage vous attend. La partie reste conservée sur cet appareil.</p><div class="dialog-actions"><button data-dialog="close">Continuer le duel</button><button data-dialog="restart">Recommencer</button><button data-dialog="home">Retour à la taverne</button></div>`);
  }
  function result() {
    const draw=state.winner===0, gold=state.winner===1;
    openModal('result',draw?'Pavillon blanc':gold?'Le trésor est à vous !':'Le Kraken triomphe',draw?'LES DEUX ÉQUIPAGES RESTENT À FLOT':'LE DUEL EST TERMINÉ',`<p class="result-copy">${draw?(state.endReason==='repetition'?'La même position est revenue trois fois.':'Les deux équipages ont tenu 25 tours sans prise ni mouvement de pion.') : gold?'Les Corsaires règnent sur ces eaux. Un nouveau défi vous attend au prochain port.':'L’équipage des abysses remporte le duel. La prochaine marée sera peut-être la vôtre.'}</p><div class="dialog-actions"><button data-dialog="new">Rejouer ce duel</button><button data-dialog="home">Retour à la taverne</button></div>`);
  }
  function confirmRestart() {openModal('restart','Lever un nouveau pavillon ?','NOUVEAU DUEL',`<p class="result-copy">La partie en cours sera remplacée par un nouveau duel.</p><div class="dialog-actions"><button data-dialog="new">Commencer le nouveau duel</button><button data-dialog="close">Garder ma partie</button></div>`);}
  $('start').addEventListener('click',()=>state&&state.winner===null?confirmRestart():start());
  $('resume').addEventListener('click',showGame);
  $('brand').addEventListener('click',()=>screen==='game'?pause():showHome());
  $('home-nav').addEventListener('click',()=>screen==='game'?pause():showHome());
  document.querySelectorAll('[data-rules]').forEach(b=>b.addEventListener('click',rules));
  document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{if(state&&state.winner===null&&mode!==b.dataset.mode){note('Le mode choisi s’appliquera au prochain duel.');} mode=b.dataset.mode;updateSettings();}));
  document.querySelectorAll('[data-level]').forEach(b=>b.addEventListener('click',()=>{level=b.dataset.level;updateSettings();safeStore();}));
  $('sound').addEventListener('click',()=>{sound=!sound;updateSettings();safeStore();tone();});
  $('board').addEventListener('click',e=>{const b=e.target.closest('[data-cell]');if(b)clickCell(Number(b.dataset.cell));});
  $('board').addEventListener('keydown',e=>{
    const b=e.target.closest('[data-cell]');if(!b||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();const cells=[...$('board').querySelectorAll('[data-cell]')], at=cells.indexOf(b), delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-5,ArrowDown:5}[e.key], to=cells[Math.max(0,Math.min(cells.length-1,at+delta))];
    cells.forEach(c=>c.tabIndex=-1);to.tabIndex=0;to.focus({preventScroll:true});
  });
  $('undo').addEventListener('click',undo);
  $('hint').addEventListener('click',()=>{if(!humanTurn())return;hint=E.chooseMove(state,'moyen');selected=null;route=[];render();});
  $('pause').addEventListener('click',pause);
  $('modal-close').addEventListener('click',closeModal);
  $('modal').addEventListener('cancel',e=>{e.preventDefault();closeModal();});
  $('modal').addEventListener('click',e=>{
    const action=e.target.closest('[data-dialog]')?.dataset.dialog;
    if(action==='close')closeModal();
    if(action==='home'){cancelAI();$('modal').close();modalKind='';showHome();}
    if(action==='restart')confirmRestart();
    if(action==='new'){const nextMode=screen==='game'?gameMode:mode;cancelAI();$('modal').close();modalKind='';start(nextMode);}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAI();safeStore();}else scheduleAI();});
  window.addEventListener('pagehide',safeStore);
  restore();updateSettings();preview();
})();
