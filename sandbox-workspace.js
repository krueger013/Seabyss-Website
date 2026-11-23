import { COLLISION_MODES, GravitySandbox, MAX_BODIES } from './sandbox-physics.js';
import { SANDBOX_SCENARIOS, BODY_PRESETS } from './sandbox-scenarios.js';
import { SandboxSession } from './sandbox-session.js';
import { createSandboxView } from './sandbox-view.js';
import { createBodyEditor } from './sandbox-editor.js';
import { createSandboxAnalysis } from './sandbox-analysis.js';
import { createSandboxComparison } from './sandbox-comparison.js';
import { climateFromSandbox, proposeSandboxClimateOrbit, sandboxClimateUnavailable } from './sandbox-climate-link.js';
import { EXPERIMENT_FILE_LIMIT, experimentFilename, makeExperimentFile, readExperimentFile } from './sandbox-exchange.js';

const savePrefix='seabyss-universe.experiment.v1.';
const resumeKey='seabyss-universe.workbench.v1';
const checkpointsKey='seabyss-universe.checkpoints.v1';
const checkpointLimit=8;
const fmt=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});
const scientific=new Intl.NumberFormat('fr-CA',{notation:'scientific',maximumFractionDigits:2});
const km=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:0});
const AU_DAY_TO_KMS=149597870.7/86400;
const SOLAR_TO_EARTH=332946;
const impactModels={
  merge:{label:'Fusion',hint:'Les astres se réunissent au contact.'},
  fragment:{label:'Fragmentation',hint:'Un choc assez violent peut projeter des éclats, chacun avec sa propre orbite.'},
  bounce:{label:'Rebond',hint:'Le choc fait rebondir les corps en dissipant une partie de leur énergie. Un contact avec une étoile entraîne une fusion.'}
};
const isFragment=body=>body.id.startsWith('fragment-');
const formatMass=b => b.mass>=.05 ? fmt.format(b.mass)+' M☉' : b.mass*SOLAR_TO_EARTH>=.001
  ? fmt.format(b.mass*SOLAR_TO_EARTH)+' M⊕' : (b.mass*SOLAR_TO_EARTH).toExponential(1)+' M⊕';
const dayLabel=days=>'J + '+fmt.format(days);
const paths={
  play:'<path fill="currentColor" stroke="none" d="m7 4 13 8-13 8z"/>', pause:'<path stroke-width="3" d="M8 5v14m8-14v14"/>',
  back:'<path d="M5 5v14m14-14L8 12l11 7z"/>', save:'<path d="M4 3h13l3 3v15H4zm4 0v6h8V3M8 21v-8h8v8"/>',
  next:'<path d="M19 5v14M5 5l11 7-11 7z"/>', step:'<path d="m5 5 10 7-10 7zM19 5v14"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  photo:'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="m7 7 2-3h6l2 3"/><circle cx="12" cy="13" r="3.4"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>', add:'<path d="M12 4v16M4 12h16"/>',
  settings:'<path d="M3 7h9m4 0h5M3 17h3m4 0h11"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  focus:'<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/><circle cx="12" cy="12" r="3"/>'
};
function glyph(key) {return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+paths[key]+'</svg>';}
function setText(node,text) {if(node.textContent!==text)node.textContent=text;}
function localRead(key) {
  try {const data=localStorage.getItem(key);return data && JSON.parse(data);} catch {return null;}
}

export function createSandboxWorkspace(root,{onExit,onCapture,onClimate,announce,reducedMotion}) {
  const session=new SandboxSession('figure-eight');
  root.innerHTML = '<header class="sb-head"><div class="sb-title"><h1>Atelier gravitationnel</h1><span data-sb-count></span></div>' +
    '<div class="sb-head-tools"><button data-sb-photo title="Photographier l’expérience" aria-label="Photographier l’expérience">'+glyph('photo')+'</button><button data-sb-save title="Expériences sauvegardées" aria-label="Expériences sauvegardées">'+glyph('save')+'<span>Sauvegardes</span></button><button data-sb-exit title="Revenir au système" aria-label="Revenir au système">'+glyph('close')+'</button></div></header>' +
    '<div class="sb-body"><div class="sb-scene"><div id="sandbox-stage"></div><div class="sb-flight-note" data-sb-note hidden><strong data-sb-note-title></strong><small data-sb-note-detail hidden></small></div></div>' +
    '<aside class="sb-side" aria-label="Instruments de l’atelier"><div class="sb-panel-head"><h2 data-sb-panel-title tabindex="-1">Expérience</h2><button data-sb-panel-close aria-label="Fermer les instruments">'+glyph('close')+'</button></div>' +
    '<div class="sb-sheet" data-sb-sheet="inspect"><p data-sb-caption></p><section class="sb-guide" hidden><h3 data-sb-guide-title></h3><p data-sb-guide></p><progress max="1" value="0" aria-label="Progression de l’observation"></progress></section>' +
    '<label>Astre sélectionné<select data-sb-target></select></label><div class="sb-research"><button class="sb-primary" data-sb-editor-open>Modifier l’astre</button><button data-sb-analysis-open>Analyser l’orbite</button></div><dl class="sb-metrics"><div><dt>Masse</dt><dd data-sb-mass>—</dd></div><div><dt>Vitesse</dt><dd data-sb-velocity>—</dd></div><div><dt>Diamètre</dt><dd data-sb-diameter>—</dd></div></dl>' +
    '<section class="sb-research" aria-label="Rejouer une expérience"><button data-sb-checkpoints-open>Points de reprise</button><button data-sb-comparison-open>Comparer deux états</button></section>' +
    '<button class="sb-climate" data-sb-climate-open hidden>Simuler le climat de cette planète</button>' +
    '<div class="sb-impact-model"><label>Modèle de collision<select data-sb-collision-mode aria-describedby="sb-impact-hint"></select></label><p id="sb-impact-hint"></p>' +
    '<button data-sb-fragment hidden>Suivre un éclat <span data-sb-debris></span></button>' +
    '<button data-sb-tides type="button" aria-pressed="false" aria-describedby="sb-tides-hint">Dislocation par les marées</button><p id="sb-tides-hint">Le modèle peut détacher des débris lors d’un passage à l’intérieur de la limite de Roche calculée pour un corps fluide.</p></div>' +
    '<div class="sb-chips"><button data-sb-follow aria-pressed="false">Suivre l’astre</button><button data-sb-frame>'+glyph('focus')+'Tout cadrer</button></div>' +
    '<details class="sb-adjust"><summary>Actions rapides</summary><div class="sb-chips"><button data-sb-mass-scale="0.5">Masse ÷ 2</button><button data-sb-mass-scale="2">Masse × 2</button><button data-sb-kick="-0.1">Ralentir de 10 %</button><button data-sb-kick="0.1">Accélérer de 10 %</button><button data-sb-duplicate>Dupliquer l’astre</button><button data-sb-remove>Retirer l’astre</button></div><small>L’impulsion est mesurée par rapport au voisin qui exerce la plus forte attraction.</small></details>' +
    '<details class="sb-adjust"><summary>Affichage et événements</summary><div class="sb-chips"><button data-sb-labels aria-pressed="true">Noms</button><button data-sb-trails aria-pressed="true">Traînées</button></div><ol data-sb-event></ol></details>' +
    '<button data-sb-reset class="sb-reset">Recommencer cette expérience</button></div>' +
    '<section class="sb-sheet" data-sb-sheet="editor" hidden></section><section class="sb-sheet" data-sb-sheet="analysis" hidden></section>' +
    '<section class="sb-sheet" data-sb-sheet="comparison" hidden></section>' +
    '<section class="sb-sheet" data-sb-sheet="checkpoints" hidden><p>Repars du même instant après avoir essayé un réglage différent.</p>' +
    '<label>Nom du point<input data-sb-checkpoint-name maxlength="44" placeholder="Avant la rencontre" autocomplete="off"></label><button class="sb-primary" data-sb-checkpoint-save>Capturer cet instant</button>' +
    '<p class="sb-transfer-note" data-sb-checkpoint-status role="status"></p><ul class="sb-checkpoints" data-sb-checkpoint-list></ul></section>' +
    '<div class="sb-sheet" data-sb-sheet="create" hidden><label>Type d’astre<select data-sb-preset></select></label><label>Nom<input data-sb-name maxlength="40" placeholder="Nom de ton astre" autocomplete="off"></label>' +
    '<label>Masse de départ<select data-sb-weight><option value=".5">× 0,5</option><option value="1" selected>× 1</option><option value="2">× 2</option><option value="5">× 5</option></select></label>' +
    '<p>Touche son point de départ et glisse pour régler la vitesse. La courbe montre sa trajectoire prévue. Relâche pour lancer.</p><div class="sb-create-buttons"><button data-sb-draw>Tracer un tir</button><button data-sb-insert class="sb-primary">Placer en orbite</button></div></div>' +
    '<div class="sb-sheet" data-sb-sheet="saves" hidden><label>Nom de l’expérience<input data-sb-save-name maxlength="52" placeholder="Mon système" autocomplete="off"></label><button class="sb-primary" data-sb-save-confirm>Enregistrer</button><ul class="sb-saves" data-sb-saves></ul><div class="sb-chips"><button data-sb-export>Exporter en JSON</button><button data-sb-import-open>Importer un fichier</button></div><input hidden data-sb-import type="file" accept=".json,application/json"><p class="sb-transfer-note" data-sb-transfer-note role="status"></p></div></aside></div>' +
    '<footer class="sb-foot"><div class="sb-scene-select"><label for="sb-which">Expérience</label><select id="sb-which" data-sb-scene></select></div><div class="sb-clock"><button data-sb-pause></button><select data-sb-rate aria-label="Vitesse du bac à sable"></select><output aria-live="off" data-sb-time></output></div>' +
    '<div class="sb-timeline"><button data-sb-rewind aria-label="Revenir un état en arrière" title="Revenir en arrière">'+glyph('back')+'</button><input data-sb-history type="range" min="0" max="0" value="0" step="1" aria-label="Historique de l’expérience"><button data-sb-forward title="Avancer dans l’historique" aria-label="Avancer dans l’historique">'+glyph('next')+'</button><button data-sb-step title="Calculer un pas et rester en pause" aria-label="Calculer un pas">'+glyph('step')+'</button></div>' +
    '<div class="sb-modes"><button data-sb-inspect title="Instruments et fiche de l’astre">'+glyph('settings')+'<span>Instruments</span></button><button class="sb-primary" data-sb-create>'+glyph('add')+'<span>Créer</span></button></div></footer>';
  const $=q=>root.querySelector(q);
  const scene=$('[data-sb-scene]'), rate=$('[data-sb-rate]'), pause=$('[data-sb-pause]'), select=$('[data-sb-target]');
  const history=$('[data-sb-history]'), preset=$('[data-sb-preset]'), eventList=$('[data-sb-event]'), note=$('[data-sb-note]');
  const collisionMode=$('[data-sb-collision-mode]'), debris=$('[data-sb-debris]'), noteTitle=$('[data-sb-note-title]'), noteDetail=$('[data-sb-note-detail]');
  const compact=matchMedia('(max-width:700px), (max-height:490px)');
  const tides=$('[data-sb-tides]');
  const climateButton=$('[data-sb-climate-open]');
  const savedPoints=localRead(checkpointsKey);
  const checkpoints=Array.isArray(savedPoints) ? savedPoints.filter(point=>typeof point?.name==='string' &&
    typeof point.snapshot?.world?.days==='number' && Number.isFinite(point.snapshot.world.days)).slice(0,checkpointLimit) : [];
  for(const model of SANDBOX_SCENARIOS) scene.add(new Option(model.name,model.id));
  for(const model of BODY_PRESETS) preset.add(new Option(model.name,model.id));
  for(const id of COLLISION_MODES) collisionMode.add(new Option(impactModels[id].label,id));
  let paused=reducedMotion(), placing=false, resumeLaunch=false, follow=false, names=true, trails=true;
  let mode='inspect', panelOpen=false, loaded=false, signature='', noticeId='', autosaveClock=0, uiClock=0, transfer=0;
  const selected=()=>session.sim.bodies.find(b=>b.id===session.selectedId);
  function projectile(position,velocity) {
    const model=BODY_PRESETS.find(p=>p.id===preset.value) || BODY_PRESETS[0];
    let serial=session.serial;
    while(session.sim.bodies.some(b=>b.id==='created-'+serial)) serial++;
    return {id:'created-'+serial,name:$('[data-sb-name]').value.trim() || model.name+' '+serial,
      kind:model.kind,color:model.color,mass:model.mass*Number($('[data-sb-weight]').value),
      radius:model.radius,position:position.slice(),velocity:velocity.slice()};
  }
  function selectBody(id) {
    if (!session.sim.bodies.some(b=>b.id===id)) return;
    session.selectedId=id;
    view.setSelected(id);
    refresh();
  }
  function orbitPrediction(body,options) {return session.sim.predict(body,options);}
  const view=createSandboxView($('#sandbox-stage'),{
    getBodies:()=>session.sim.bodies,getTime:()=>session.sim.days,
    onSelect:selectBody,onFollowChange:value=>{follow=value;refresh();},buildProjectile:projectile,predict:orbitPrediction,
    predictBody:(id,options)=>session.sim.predictBody?.(id,options) || [],
    onLaunch:body=>{
      const ok=session.edit(world=>{
        const added=world.addBody(body);
        if (!added) return false;
        session.serial++;session.selectedId=added.id;return true;
      });
      if (!ok) {announce('Ce corps ne peut pas être ajouté. La limite est de '+MAX_BODIES+' astres.');return;}
      finishPlacement(); view.setSelected(session.selectedId); noticeId='';
      $('[data-sb-name]').value='';persistResume();refresh();view.render();
    },
    onCancelPlacement:()=>{finishPlacement();refresh();}
  });
  const editor=createBodyEditor($('[data-sb-sheet="editor"]'),{
    onApply:(id,patch)=>{
      if (!session.edit(world=>world.updateBody(id,patch))) return false;
      session.selectedId=id;
      afterEdit();
      setPanel('inspect',true);
      announce('Paramètres appliqués.');
      return true;
    },
    onCancel:()=>setPanel('inspect',true)
  });
  const analysis=createSandboxAnalysis($('[data-sb-sheet="analysis"]'),{
    getWorld:()=>session.sim,getBody:selected,onReference:id=>view.setReference?.(id)
  });
  const comparison=createSandboxComparison($('[data-sb-sheet="comparison"]'),{
    getWorld:()=>session.sim,getLabel:()=>session.scenario.name,getScope:()=>session.scenario.id
  });
  const photo=$('[data-sb-photo]');
  photo.hidden=!onCapture;
  photo.onclick=()=>{
    const frame=view.capture?.();
    if (frame) onCapture(frame,selected()?.name||session.scenario.name);
  };
  function finishPlacement() {
    if (!placing) return;
    placing=false;view.setPlacement(false);
    if (resumeLaunch) paused=false;
    resumeLaunch=false;
  }
  function arm() {
    if (!placing) resumeLaunch=!paused;
    paused=true;placing=true;view.setPlacement(true);refresh();
  }
  function setPanel(next,open=true) {
    if (next!=='create' || !open) finishPlacement();
    if (mode==='editor' && next!=='editor') editor.close();
    const changed=mode!==next;
    if (changed) {transfer++;$('.sb-side').scrollTop=0;}
    mode=next;panelOpen=open;
    root.dataset.sheet=mode;root.classList.toggle('sb-panel-open',open);
    for (const sheet of root.querySelectorAll('[data-sb-sheet]')) sheet.hidden=sheet.dataset.sbSheet!==mode;
    setText($('[data-sb-panel-title]'),({inspect:'Instruments',create:'Nouvel astre',saves:'Sauvegardes',editor:'Éditer l’astre',analysis:'Analyse',checkpoints:'Points de reprise',comparison:'Comparer deux états'})[next]);
    if (next==='saves') {renderSaves();$('[data-sb-save-name]').value=session.scenario.name;transferStatus('');}
    if (next==='create' && open) arm();
    if (next==='checkpoints') renderCheckpoints();
    refresh();
    if (changed && open && (next==='checkpoints' || next==='comparison')) $('[data-sb-panel-title]').focus({preventScroll:true});
  }
  function restoreFrame() {
    const anchor=session.sim.bodies.find(b=>b.id===session.scenario.focusId);
    const total=session.sim.bodies.reduce((sum,b)=>sum+b.mass,0);
    const center=anchor?.position || [0,1,2].map(i=>session.sim.bodies.reduce((sum,b)=>sum+b.position[i]*b.mass,0)/(total||1));
    view.resetCamera({span:session.scenario.span/2,target:center});
    // Keep a planet and its nearby satellites together as they travel around their star.
    follow=!!anchor && ['solar','encounter'].includes(session.scenario.id) && session.selectedId===anchor.id;
    view.setSelected(session.selectedId);view.setFollow(follow);
  }
  function applyPresentation(resetView=true) {
    finishPlacement();scene.value=session.scenario.id;
    rate.replaceChildren(...[.25,1,4].map(f=>{
      const value=session.scenario.rate*f;
      return new Option(fmt.format(value)+' j/s',String(value));
    }));
    rate.value=String(session.rate);
    signature='';noticeId='';view.clearHistory();view.setSelected(session.selectedId);
    analysis.reset();
    if(resetView)restoreFrame();
    refresh();view.render();
  }
  function frameAll() {
    const bodies=session.sim.bodies;
    if (!bodies.length) return;
    const center=[0,1,2].map(axis=>{
      const coordinates=bodies.map(b=>b.position[axis]);
      return (Math.min(...coordinates)+Math.max(...coordinates))/2;
    });
    const extent=Math.max(...bodies.map(b=>Math.hypot(...b.position.map((x,i)=>x-center[i]))+b.radius));
    const span=bodies.length===1 ? Math.max(session.scenario.span/2,extent*4) : extent*1.16;
    follow=false;view.setFollow(false);view.resetCamera({span,target:center});refresh();view.render();
  }
  function rebuild(id) {
    finishPlacement();
    session.start(id);paused=reducedMotion() || id==='shatter' || session.scenario.tidesEnabled===true;
    setPanel('inspect',!compact.matches);applyPresentation();persistResume();
  }
  function chooseTime(index) {
    if (mode==='editor') setPanel('inspect',true);
    if (placing) finishPlacement();
    if (!session.seek(index)) return;
    paused=true;applyPresentation(false);
  }
  function togglePause() {
    if (mode==='editor') return;
    if (placing) {resumeLaunch=false;finishPlacement();}
    paused=!paused;refresh();
  }
  function referenceBody(body) {
    let best=null, force=0;
    for (const other of session.sim.bodies) if(other!==body) {
      const d=Math.hypot(...body.position.map((n,i)=>n-other.position[i]));
      const f=other.mass/Math.max(1e-30,d*d);
      if (f>force) {best=other;force=f;}
    }
    return best;
  }
  function editSelection(change) {
    const body=selected();if(!body)return;
    if (!session.edit(world=>change(world,body))) {announce('Cette modification dépasse les limites de la simulation.');return;}
    afterEdit();
  }
  function afterEdit() {
    view.clearHistory();view.setSelected(session.selectedId);analysis.reset();persistResume();refresh();view.render();
  }
  function describe(e) {
    if (e.type==='tidal') return dayLabel(e.day)+' · Dislocation de '+e.names[1]+' près de '+e.names[0];
    const title=e.outcome==='bounce'?'Rebond de ':e.fragmentIds?.length?'Fragmentation de ':e.type==='collision'?'Fusion de ':'Passage rapproché de ';
    return dayLabel(e.day)+' · '+title+e.names.join(' et ');
  }
  function fragmentSummary(event) {
    const count=event.fragmentIds?.length;
    return count ? fmt.format(count)+' éclat'+(count===1?' projeté':'s projetés') : '';
  }
  const rocheLabel=event=>'Limite de Roche à '+km.format(event.rocheRadius*149597870.7)+' km';
  function refresh() {
    session.ensureSelection();
    const bodies=session.sim.bodies;
    const token=bodies.map(b=>b.id+':'+b.name).join('|');
    if(token!==signature) {
      signature=token;select.replaceChildren(...bodies.map(b=>new Option(b.name,b.id)));
    }
    select.value=session.selectedId;
    const body=selected();
    setText($('[data-sb-caption]'),session.scenario.caption);
    climateButton.hidden=!onClimate || body?.kind!=='planet';
    const counter=$('[data-sb-count]');counter.dataset.count=String(bodies.length);
    setText(counter,bodies.length+' astre'+(bodies.length>1?'s':''));
    const fragments=bodies.filter(isFragment);
    debris.dataset.count=String(fragments.length);
    setText(debris,String(fragments.length));
    $('[data-sb-fragment]').hidden=!fragments.length;
    const model=session.sim.collisionMode;
    if(collisionMode.value!==model)collisionMode.value=model;
    setText($('#sb-impact-hint'),impactModels[model].hint);
    tides.setAttribute('aria-pressed',String(session.sim.tidesEnabled===true));
    const time=$('[data-sb-time]');time.dataset.days=String(session.sim.days);setText(time,dayLabel(session.sim.days));
    setText($('[data-sb-mass]'),body?formatMass(body):'—');
    setText($('[data-sb-velocity]'),body?fmt.format(Math.hypot(...body.velocity)*AU_DAY_TO_KMS)+' km/s':'—');
    setText($('[data-sb-diameter]'),body?fmt.format(body.radius*2*149597870.7)+' km':'—');
    if (pause.getAttribute('aria-pressed')!==String(paused)) {
      pause.setAttribute('aria-pressed',String(paused));pause.innerHTML=glyph(paused?'play':'pause');
      pause.title=paused?'Reprendre la simulation':'Mettre la simulation en pause';pause.setAttribute('aria-label',pause.title);
    }
    for(const [key,val] of [['follow',follow],['labels',names],['trails',trails],['draw',placing],['inspect',mode==='inspect'&&panelOpen]]) {
      $('[data-sb-'+key+']').setAttribute('aria-pressed',String(val));
    }
    history.max=String(Math.max(0,session.history.length-1));history.value=String(session.cursor);
    history.disabled=session.history.length<2;
    history.setAttribute('aria-valuetext',dayLabel(session.sim.days));
    $('[data-sb-rewind]').disabled=session.cursor<=0;
    $('[data-sb-forward]').disabled=session.cursor>=session.history.length-1;
    $('[data-sb-step]').disabled=mode==='editor';
    pause.disabled=mode==='editor';
    $('[data-sb-remove]').disabled=!body || bodies.length<2;
    $('[data-sb-editor-open]').disabled=!body;
    $('[data-sb-analysis-open]').disabled=!body;
    $('[data-sb-duplicate]').disabled=!body || bodies.length>=MAX_BODIES;
    if (mode==='analysis' && panelOpen) analysis.update();
    const g=session.guide?.update(session.sim,{selectedId:session.selectedId,paused});
    $('.sb-guide').hidden=!g;
    if(g) {
      setText($('[data-sb-guide-title]'),session.guide.title);
      setText($('[data-sb-guide]'),g.label+' · '+g.instruction);
      $('.sb-guide progress').value=g.progress;
    }
    const events=session.sim.events;
    const latest=events.at(-1);
    const key=latest ? latest.id+'@'+latest.day+'#'+events.length : 'empty';
    if(key!==noticeId) {
      noticeId=key;eventList.replaceChildren();
      for(const event of events.slice(-12).reverse()) {
        const item=document.createElement('li'),detail=document.createElement('small');
        item.textContent=describe(event);
        const speed=fmt.format(event.relativeSpeed*AU_DAY_TO_KMS)+' km/s';
        const fragmentsText=fragmentSummary(event);
        const separation=km.format(event.distance*149597870.7)+' km';
        const readings=event.type==='tidal' ? rocheLabel(event)+' · Distance '+separation : event.type==='collision'
          ? 'Vitesse relative '+speed+' · Énergie du choc '+scientific.format(event.energy)+' J'
          : 'Distance minimale '+separation+' · Vitesse relative '+speed;
        detail.textContent=fragmentsText ? fragmentsText+' · '+readings : readings;
        item.append(detail);eventList.append(item);
      }
      if (!latest) {const li=document.createElement('li');li.textContent='Aucun événement pour le moment.';eventList.append(li);}
    }
    const recentWindow=Math.max(.3,session.rate*4);
    const lastImpact=events.findLast(event=>['collision','tidal'].includes(event.type) && session.sim.days-event.day<recentWindow);
    const announcement=lastImpact || latest;
    const recent=announcement && session.sim.days-announcement.day<recentWindow;
    note.hidden=placing || !recent;
    if (!note.hidden) {
      const fragmentsText=fragmentSummary(announcement);
      note.dataset.fragmented=String(!!fragmentsText);
      noteDetail.hidden=!fragmentsText && announcement.type!=='tidal';
      setText(noteTitle,describe(announcement));
      if(announcement.type==='tidal') setText(noteDetail,[fragmentsText,rocheLabel(announcement)].filter(Boolean).join(' · '));
      else if(fragmentsText)setText(noteDetail,fragmentsText+' · '+scientific.format(announcement.energy)+' J');
    }
  }
  function persistResume() {
    try {localStorage.setItem(resumeKey,JSON.stringify({snapshot:session.snapshot(),paused}));} catch {}
  }
  function checkpointStatus(message) {setText($('[data-sb-checkpoint-status]'),message);}
  function storeCheckpoints() {
    try {localStorage.setItem(checkpointsKey,JSON.stringify(checkpoints));return true;} catch {return false;}
  }
  function renderCheckpoints() {
    const list=$('[data-sb-checkpoint-list]');list.replaceChildren();
    $('[data-sb-checkpoint-save]').disabled=checkpoints.length>=checkpointLimit;
    for(const [index,point] of checkpoints.entries()) {
      const item=document.createElement('li'), title=document.createElement('h3'), details=document.createElement('p');
      const actions=document.createElement('div');actions.className='sb-checkpoint-actions';
      title.textContent=point.name;
      const scenario=SANDBOX_SCENARIOS.find(choice=>choice.id===point.snapshot.scenarioId);
      details.textContent=(scenario?.name||'Expérience')+' · '+dayLabel(point.snapshot.world.days);
      const resume=document.createElement('button');resume.dataset.sbCheckpointResume='';resume.textContent='Reprendre';
      resume.onclick=()=>{
        if(!session.load(point.snapshot)) {checkpointStatus('Ce point de reprise est illisible.');return;}
        paused=true;setPanel('inspect',true);applyPresentation();persistResume();
        announce('Point de reprise chargé.');
      };
      actions.append(resume);
      for(const slot of ['a','b']) {
        const pin=document.createElement('button');pin.dataset.sbCheckpointPin=slot;
        pin.textContent='État '+slot.toUpperCase();
        pin.setAttribute('aria-label','Comparer '+point.name+' comme état '+slot.toUpperCase());
        pin.onclick=()=>{
          const world=GravitySandbox.restore(point.snapshot.world);
          if(!world || !comparison.pin(slot,world,point.name,point.snapshot.scenarioId)) {checkpointStatus('Ce point de reprise est illisible.');return;}
          setPanel('comparison',true);
        };
        actions.append(pin);
      }
      const remove=document.createElement('button');remove.dataset.sbCheckpointRemove='';remove.textContent='Supprimer';
      remove.setAttribute('aria-label','Supprimer le point '+point.name);
      remove.onclick=()=>{
        checkpoints.splice(index,1);
        const saved=storeCheckpoints();renderCheckpoints();
        checkpointStatus(saved?'Point supprimé.':'Point supprimé pour cette session. Le stockage local est indisponible.');
        $('[data-sb-checkpoint-save]').focus({preventScroll:true});
      };
      actions.append(remove);item.append(title,details,actions);list.append(item);
    }
    if(checkpoints.length>=checkpointLimit) checkpointStatus('Les 8 places sont utilisées. Supprime un point pour libérer une place.');
  }
  $('[data-sb-checkpoint-save]').onclick=()=>{
    if(checkpoints.length>=checkpointLimit) return;
    const field=$('[data-sb-checkpoint-name]');
    const name=field.value.trim() || dayLabel(session.sim.days);
    checkpoints.unshift({name,snapshot:session.snapshot()});
    const saved=storeCheckpoints();field.value='';renderCheckpoints();
    if(checkpoints.length<checkpointLimit) checkpointStatus(saved?'Instant capturé.':'Instant capturé pour cette session. Le stockage local est indisponible.');
  };
  function renderSaves() {
    const ul=$('[data-sb-saves]');ul.replaceChildren();
    let keys=[];
    try {keys=Object.keys(localStorage).filter(key=>key.startsWith(savePrefix)).sort().reverse();} catch {}
    for (const key of keys) {
      const saved=localRead(key);if (!saved || typeof saved.name!=='string' || !saved.snapshot) continue;
      const item=document.createElement('li'),btn=document.createElement('button');
      btn.type='button';btn.dataset.sbLoad=key;btn.textContent=saved.name+' · '+dayLabel(saved.snapshot.world?.days ?? 0);
      btn.onclick=()=>{
        if(!session.load(saved.snapshot)) {announce('Cette sauvegarde ne peut pas être ouverte.');return;}
        paused=true;setPanel('inspect',!compact.matches);applyPresentation();persistResume();announce('Expérience chargée.');
      };
      item.append(btn);ul.append(item);
    }
    if (!ul.children.length) {const li=document.createElement('li');li.textContent='Tes expériences enregistrées apparaîtront ici.';ul.append(li);}
  }
  const experimentName=()=>$('[data-sb-save-name]').value.trim() || session.scenario.name;
  function saveNamed(name) {
    try {
      const key=savePrefix+Date.now()+'-'+Math.random().toString(36).slice(2,8);
      localStorage.setItem(key,JSON.stringify({name,snapshot:session.snapshot()}));
      return true;
    } catch {return false;}
  }
  function transferStatus(message) {setText($('[data-sb-transfer-note]'),message);}
  $('[data-sb-save-confirm]').onclick=()=>{
    if (saveNamed(experimentName())) {renderSaves();announce('Expérience enregistrée.');}
    else announce('Le stockage est indisponible ou plein.');
  };
  $('[data-sb-export]').onclick=()=>{
    const title=experimentName();
    const file=new Blob([makeExperimentFile(title,session.snapshot())],{type:'application/json'});
    const url=URL.createObjectURL(file);
    const link=document.createElement('a');
    link.href=url;link.download=experimentFilename(title);
    root.append(link);
    link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
    transferStatus('L’état actuel est exporté.');
  };
  const importFile=$('[data-sb-import]');
  $('[data-sb-import-open]').onclick=()=>importFile.click();
  importFile.onchange=async ()=>{
    const file=importFile.files[0];
    importFile.value='';
    if (!file) return;
    const request=++transfer;
    if (file.size>EXPERIMENT_FILE_LIMIT) {transferStatus('Le fichier dépasse 2 Mo.');return;}
    transferStatus('Lecture de l’expérience…');
    let item;
    try {item=readExperimentFile(await file.text());} catch {}
    if (request!==transfer || mode!=='saves' || root.hidden) return;
    if (!item || !session.load(item.snapshot)) {transferStatus('Ce fichier ne contient pas une expérience valide.');return;}
    paused=true;
    applyPresentation();
    persistResume();
    const saved=saveNamed(item.title);
    $('[data-sb-save-name]').value=item.title;
    renderSaves();
    transferStatus(saved?'Expérience importée et enregistrée.':'Expérience importée. Le stockage local est indisponible.');
  };
  scene.onchange=()=>rebuild(scene.value);
  select.onchange=()=>selectBody(select.value);
  collisionMode.onchange=()=>{
    if(session.edit(world=>world.setCollisionMode(collisionMode.value))) {
      view.invalidateForecast();persistResume();refresh();
    }
  };
  tides.onclick=()=>{
    if(session.edit(world=>world.setTidesEnabled(!world.tidesEnabled))) {
      view.invalidateForecast();persistResume();refresh();
    }
  };
  rate.onchange=()=>{session.rate=Number(rate.value);refresh();};
  pause.onclick=togglePause;
  $('[data-sb-rewind]').onclick=()=>chooseTime(session.cursor-1);
  $('[data-sb-forward]').onclick=()=>chooseTime(session.cursor+1);
  $('[data-sb-step]').onclick=()=>{
    finishPlacement();
    paused=true;session.tick(.25,true);
    view.setSelected(session.selectedId);view.render(session.sim.events);refresh();persistResume();
  };
  history.oninput=()=>chooseTime(Number(history.value));
  $('[data-sb-create]').onclick=()=>setPanel('create',true);
  $('[data-sb-draw]').onclick=arm;
  $('[data-sb-insert]').onclick=()=>{view.launchDefault();};
  $('[data-sb-save]').onclick=()=>{finishPlacement();paused=true;setPanel('saves',true);};
  $('[data-sb-inspect]').onclick=()=>setPanel('inspect',!compact.matches || !(panelOpen && mode==='inspect'));
  $('[data-sb-panel-close]').onclick=()=>setPanel('inspect',mode!=='inspect' || !compact.matches);
  $('[data-sb-editor-open]').onclick=()=>{
    const body=selected();
    if (!body) return;
    paused=true;setPanel('editor',true);editor.open(body,session.sim.bodies);
  };
  $('[data-sb-analysis-open]').onclick=()=>setPanel('analysis',true);
  $('[data-sb-checkpoints-open]').onclick=()=>{paused=true;setPanel('checkpoints',true);};
  $('[data-sb-comparison-open]').onclick=()=>setPanel('comparison',true);
  climateButton.onclick=()=>{
    const world=session.sim, body=selected(), setup=climateFromSandbox(world,body);
    if (!setup) {announce(sandboxClimateUnavailable(session.sim,body));return;}
    paused=true;refresh();persistResume();
    onClimate?.(setup,options=>{
      if (session.sim!==world) return {ok:false,reason:'L’expérience de départ a changé. Rouvre le climat depuis l’Atelier.'};
      const proposal=proposeSandboxClimateOrbit(world,body.id,options,setup.sourceIdentity);
      if (!proposal.ok) return proposal;
      if (!session.edit(sim=>sim.updateBody(proposal.planetId,proposal.patch))) {
        return {ok:false,reason:'Cette orbite dépasse les limites de l’Atelier.'};
      }
      session.selectedId=proposal.planetId;afterEdit();
      return proposal;
    });
  };
  $('[data-sb-reset]').onclick=()=>rebuild(session.scenario.id);
  $('[data-sb-exit]').onclick=onExit;
  $('[data-sb-frame]').onclick=frameAll;
  $('[data-sb-follow]').onclick=()=>{follow=!follow;view.setFollow(follow);refresh();view.render();};
  $('[data-sb-fragment]').onclick=()=>{
    const pieces=session.sim.bodies.filter(isFragment);
    if(!pieces.length)return;
    const next=pieces[(pieces.findIndex(piece=>piece.id===session.selectedId)+1)%pieces.length];
    follow=true;view.setFollow(true);selectBody(next.id);view.render();
  };
  $('[data-sb-labels]').onclick=()=>{names=!names;view.setLabels(names);refresh();view.render();};
  $('[data-sb-trails]').onclick=()=>{trails=!trails;view.setTrails(trails);refresh();view.render();};
  for(const button of root.querySelectorAll('[data-sb-mass-scale]')) button.onclick=()=>{
    editSelection((world,b)=>world.setMass(b.id,b.mass*Number(button.dataset.sbMassScale)));
  };
  for(const button of root.querySelectorAll('[data-sb-kick]')) button.onclick=()=>{
    editSelection((world,b)=>{
      const other=referenceBody(b);
      if(!other)return false;
      return world.kick(b.id,b.velocity.map((v,i)=>(v-other.velocity[i])*Number(button.dataset.sbKick)));
    });
  };
  $('[data-sb-duplicate]').onclick=()=>editSelection((world,body)=>{
    let serial=session.serial;
    while(world.bodies.some(other=>other.id==='created-'+serial)) serial++;
    const name=body.name.slice(0,32)+' · copie';
    const position=body.position.slice();
    position[1]+=Math.max(body.radius*2.6,1e-8);
    const copy=world.addBody({...body,id:'created-'+serial,name,position});
    if (!copy) return false;
    session.serial=serial+1;session.selectedId=copy.id;
    return true;
  });
  $('[data-sb-remove]').onclick=()=>editSelection((world,body)=>world.removeBody(body.id));
  root.addEventListener('keydown',e=>{
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.target.closest('input,select,textarea')) return;
    if (e.key==='Escape') {
      if (mode!=='inspect') setPanel('inspect',true);
      else if (placing || (compact.matches && panelOpen)) setPanel('inspect',false);
      else onExit();
      e.preventDefault();
    }
    if (e.code==='Space' && !e.target.closest('button,summary')) { e.preventDefault(); togglePause(); }
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden && !root.hidden)persistResume();});
  window.addEventListener('pagehide',()=>{if(!root.hidden)persistResume();});
  return {
    open(id) {
      root.hidden=false;
      if (!loaded) {
        const saved=id?null:localRead(resumeKey);
        if (saved && session.load(saved.snapshot)) paused=!!saved.paused || reducedMotion();
        loaded=true;setPanel('inspect',!compact.matches);applyPresentation();
      } else {refresh();view.render();}
      if(id && SANDBOX_SCENARIOS.some(s=>s.id===id))rebuild(id);
      root.querySelector('[data-sandbox-canvas]')?.focus({preventScroll:true});
    },
    close() {transfer++;finishPlacement();persistResume();root.hidden=true;},
    tick(dt) {
      if (!paused) {
        const id=session.selectedId;session.tick(dt);if(id!==session.selectedId)view.setSelected(session.selectedId);
      }
      view.render(session.sim.events);
      uiClock+=dt;autosaveClock+=dt;
      if(uiClock>.10) {refresh();uiClock=0;}
      if(autosaveClock>6 && !paused) {persistResume();autosaveClock=0;}
    }
  };
}
