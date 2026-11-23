import {
  BLACK_HOLE_LIMITS, circularOrbit, hoverClockRate, radialFreeFallSample,
  schwarzschildRadiusKm, schwarzschildTimeSeconds, traceLightRay
} from './relativity-model.js';
import { createRelativityScene } from './relativity-scene.js';
import { RELATIVITY_SCENARIOS } from './relativity-scenarios.js';
import { createRelativityTides } from './relativity-tides.js';

const modes = [
  ['light','Lumière','lens'],['clock','Horloges','orbit'],['fall','Chute','fall']
];
const modeNames = new Map(modes.map(([key,label])=>[key,label]));
const sceneModes = Object.fromEntries(modes.map(([key,,scene])=>[key,scene]));
const presets = new Map(RELATIVITY_SCENARIOS.map(preset=>[preset.id,preset]));
const initial = 'photon-capture';
const keys = ['massSolar','radius','impact','startRadius','stopRadius','clockType'];
const inputs = [
  ['massSolar','mass','Masse du trou noir','M☉',1,1e11,'any',true],
  ['impact','impact','Paramètre d’impact','Rₛ',-10,10,'any'],
  ['radius','radius','Rayon de la sonde','Rₛ',1.001,20,.001],
  ['startRadius','start-radius','Rayon de départ','Rₛ',1.1,20,.01],
  ['stopRadius','stop-radius','Rayon d’arrivée','Rₛ',.25,1,.01]
];
const settings = new Map(inputs.map(item=>[item[0],item]));
const icons = {
  photo:'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="m7 7 2-3h6l2 3"/><circle cx="12" cy="13" r="3.4"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  play:'<path fill="currentColor" stroke="none" d="m7 5 12 7-12 7z"/>',
  pause:'<path stroke-width="3" d="M8 6v12m8-12v12"/>',
  restart:'<path d="M4 9h5V4m-5 5a8 8 0 1 1 0 6"/>',
  step:'<path d="m5 5 10 7-10 7zM18 5v14"/>'
};
const icon = key=>`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[key]}</svg>`;
const format = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3}).format;
const precise = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:6}).format;
const ratioPercent = new Intl.NumberFormat('fr-CA',{style:'percent',maximumFractionDigits:2}).format;
const clamp = (value,min,max)=>Math.max(min,Math.min(max,value));
const labels = {escaped:'Rayon dévié',captured:'Rayon capturé',critical:'Orbite critique'};
const quick = {
  light:[['capture','Capture',2.55],['critical','Seuil exact',BLACK_HOLE_LIMITS.criticalImpact],['escape','Déviation',2.75]],
  hover:[['near','Près du bord',1.25],['far','Plus loin',8]],
  orbit:[['unstable','Instable',2.7],['stable','Stable',3.2]]
};

function quantity(value,unit) {return Number.isFinite(value)?format(value)+' '+unit:'—';}
function distance(km) {
  if(!Number.isFinite(km)) return '—';
  if(km>=1e9) return quantity(km/1e9,'G km');
  if(km>=1e6) return quantity(km/1e6,'M km');
  return quantity(km,'km');
}
function clockTime(value) {
  if(value===Infinity) return '∞';
  if(!Number.isFinite(value)) return '—';
  if(value>=86400) return quantity(value/86400,'j');
  if(value>=3600) return quantity(value/3600,'h');
  if(value>=60) return quantity(value/60,'min');
  if(value>0 && value<.001) return quantity(value*1e6,'µs');
  if(value>0 && value<1) return quantity(value*1000,'ms');
  return quantity(value,'s');
}
function numberMarkup(key) {
  const [,id,label,unit,min,max,step,logarithmic] = settings.get(key);
  return `<div class="relativity-param"><div><label for="relativity-${id}">${label}</label><span><input id="relativity-${id}" data-relativity-${id} type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" aria-label="${label} en ${unit}"><small aria-hidden="true">${unit}</small></span></div><input data-relativity-range="${key}" aria-label="Régler ${label.toLowerCase()}" type="range" min="${logarithmic?0:min}" max="${logarithmic?1000:max}" step="${logarithmic?1:step==='any'?.001:step}"></div>`;
}
const metric = (key,label)=>`<div><dt>${label}</dt><dd data-relativity-${key}>—</dd></div>`;

function createState(presetId) {
  const preset = presets.get(presetId) ?? presets.get(initial);
  return {version:1,presetId:preset.id,mode:preset.mode,
    ...Object.fromEntries(keys.map(key=>[key,preset[key]])),progress:0};
}

function readState(snapshot) {
  if(snapshot?.version!==1 || !presets.has(snapshot.presetId) || !modeNames.has(snapshot.mode)) return null;
  if(snapshot.clockType!=='hover' && snapshot.clockType!=='orbit') return null;
  if(!Number.isFinite(snapshot.progress) || snapshot.progress<0 || snapshot.progress>1) return null;
  for(const [key,,,,min,max] of inputs) {
    if(!Number.isFinite(snapshot[key]) || snapshot[key]<min || snapshot[key]>max) return null;
  }
  return {version:1,presetId:snapshot.presetId,mode:snapshot.mode,
    ...Object.fromEntries(keys.map(key=>[key,snapshot[key]])),progress:snapshot.progress};
}

export function createRelativityLab(root,{onExit,onCapture,onChange,onWaves,reduceMotion=()=>false}={}) {
  root.classList.add('relativity-lab');
  root.innerHTML=`<header class="relativity-head"><div><h1>Trous noirs</h1><p data-relativity-caption></p></div>
    <div class="relativity-head-actions"><button type="button" data-relativity-waves aria-label="Laboratoire des ondes gravitationnelles">Ondes</button>
    <button type="button" class="relativity-icon" data-relativity-photo title="Photographier la scène" aria-label="Photographier la scène">${icon('photo')}</button>
    <button type="button" class="relativity-icon" data-relativity-exit title="Fermer le laboratoire" aria-label="Fermer le laboratoire">${icon('close')}</button></div></header>
    <div class="relativity-body"><section class="relativity-visual" aria-label="Visualisation du trou noir">
      <div class="relativity-telemetry"><div><span>Horizon</span><output data-relativity-horizon></output></div><div><span>Trajectoire</span><output data-relativity-result aria-live="polite"></output></div></div>
      <div class="relativity-stage" data-relativity-scene></div></section>
    <aside class="relativity-controls" aria-label="Instruments du laboratoire">
      <nav class="relativity-modes" aria-label="Mode de simulation">${modes.map(([key,label])=>`<button type="button" data-relativity-mode="${key}" aria-pressed="false">${label}</button>`).join('')}</nav>
      <div class="relativity-scroll"><label class="relativity-study-label" for="relativity-preset">Expérience</label><select id="relativity-preset" data-relativity-preset></select>
      <section data-relativity-panel="light" class="relativity-panel" aria-label="Trajet de la lumière">
        ${numberMarkup('impact')}<div class="relativity-quick" data-relativity-light-shortcuts></div>
        <dl class="relativity-readouts" data-relativity-readout="light">${metric('ray-status','Issue du trajet')}${metric('periapsis','Distance minimale')}${metric('deflection','Déviation cumulée')}${metric('critical-impact','Seuil de capture')}</dl>
      </section>
      <section data-relativity-panel="clock" class="relativity-panel" aria-label="Comparaison d’horloges" hidden>
        <label class="relativity-study-label" for="relativity-clock-type">Type d’horloge</label>
        <select id="relativity-clock-type" data-relativity-clock-type><option value="hover">Maintenue à une distance fixe</option><option value="orbit">En orbite circulaire libre</option></select>
        ${numberMarkup('radius')}<div class="relativity-quick" data-relativity-clock-shortcuts></div>
        <dl class="relativity-readouts" data-relativity-readout="clock">${metric('clock-reference','Horloge au loin')}${metric('clock-local','Horloge de la sonde')}${metric('clock-minute','À bord pour 1 min au loin')}${metric('clock-rate','Rythme relatif')}</dl>
        <p class="relativity-detail" data-relativity-clock-note></p>
      </section>
      <section data-relativity-panel="fall" class="relativity-panel" aria-label="Chute radiale libre" hidden>
        ${numberMarkup('startRadius')}${numberMarkup('stopRadius')}
        <dl class="relativity-readouts" data-relativity-readout="fall">${metric('fall-radius','Rayon actuel')}${metric('fall-speed','Vitesse locale')}${metric('fall-proper','Temps à bord')}${metric('fall-distant','Temps de Schwarzschild')}</dl>
        <p class="relativity-detail" data-relativity-fall-note></p>
      </section>
      ${numberMarkup('massSolar')}<div class="relativity-guide"><p data-relativity-description></p><p data-relativity-guide></p></div><div data-relativity-tides></div>
      <details class="relativity-notes"><summary>Modèle et références</summary>
        <p>Le modèle suit la géométrie de Schwarzschild, pour un trou noir sphérique sans rotation ni charge. Les rayons lumineux sont calculés dans le plan équatorial. Le disque coloré sert de repère visuel.</p>
        <p>Rₛ désigne le rayon de Schwarzschild. L’horizon se trouve à 1 Rₛ, la sphère des photons à 1,5 Rₛ et la limite des orbites circulaires stables à 3 Rₛ.</p>
        <p>Le temps de Schwarzschild se rapporte à une horloge idéale très loin. Sa coordonnée tend vers l’infini à l’horizon. La durée propre de la chute reste finie.</p>
        <p data-relativity-credit-row hidden><a data-relativity-credit target="_blank" rel="noopener noreferrer"></a></p>
        <p><a href="https://science.nasa.gov/apod/circling-the-black-hole-at-the-photon-sphere/" target="_blank" rel="noopener noreferrer">Sphère des photons · NASA</a></p>
      </details></div>
    </aside></div>
    <footer class="relativity-footer"><button type="button" class="relativity-primary" data-relativity-play aria-label="Lancer" aria-pressed="false">${icon('play')}<span>Lancer</span></button>
      <button type="button" class="relativity-icon" data-relativity-step title="Avancer d’un pas" aria-label="Avancer d’un pas">${icon('step')}</button>
      <label class="relativity-progress"><input type="range" min="0" max="100" step="0.1" value="0" data-relativity-progress aria-label="Progression de l’expérience"><output data-relativity-progress-label>0 %</output></label>
      <button type="button" class="relativity-icon" data-relativity-reset title="Revenir au début" aria-label="Revenir au début">${icon('restart')}</button></footer>`;

  const $ = key=>root.querySelector('[data-relativity-'+key+']');
  const pages = Array.from(root.querySelectorAll('[data-relativity-panel]'));
  const buttons = Array.from(root.querySelectorAll('[data-relativity-mode]'));
  const clockType = $('clock-type'),play = $('play'),progressInput = $('progress'),presetInput = $('preset');
  const fields = new Map(inputs.map(([key,id])=>[key,{input:$(id),range:root.querySelector('[data-relativity-range="'+key+'"]')}]));
  const setText = (key,text)=>{if($(key).textContent!==text) $(key).textContent=text;};
  const setValue = (key,value,text)=>{
    const node=$(key);
    if(!Number.isFinite(value) && value!==Infinity) delete node.dataset.value;
    else node.dataset.value=value===Infinity?'infinity':String(value);
    setText(key,text);
  };
  presetInput.replaceChildren(...RELATIVITY_SCENARIOS.map(preset=>new Option(preset.name,preset.id)));
  let state=createState(initial),running=false,ray=null,rayKey=null,orbitReading=null,shortcutMode=null,radiusKm=0,timeScale=0;
  const tides=createRelativityTides($('tides'));
  const scene=createRelativityScene($('scene'),{onRayPick:impact=>setSetting('impact',impact)});

  function serialize() {return {...state};}
  function notify() {onChange?.(serialize());}
  function resetProgress() {state.progress=0;running=false;}

  function quickButtons(host,choices,key) {
    host.replaceChildren(...choices.map(([id,label,value])=>{
      const button=document.createElement('button');button.type='button';button.dataset.relativityQuick=id;
      button.textContent=label;button.onclick=()=>setSetting(key,value);
      return button;
    }));
  }
  quickButtons($('light-shortcuts'),quick.light,'impact');

  function displayPreset() {
    const preset=presets.get(state.presetId);
    const relevant=preset.mode===state.mode;
    presetInput.value=preset.id;
    setText('caption',relevant?preset.name:modeNames.get(state.mode)+' · Réglages libres');
    setText('description',relevant?preset.description:{
      light:'Choisis le décalage du rayon à grande distance, puis suis sa déviation près de l’horizon.',
      clock:'Règle la distance de la sonde et compare son horloge à une référence lointaine.',
      fall:'Lâche une sonde sans vitesse initiale et compare les deux durées le long de sa chute.'
    }[state.mode]);
    $('guide').hidden=!relevant;
    setText('guide',relevant?preset.guide:'');
    const sourced=preset.source && relevant && state.massSolar===preset.massSolar;
    $('credit-row').hidden=!sourced;
    if(sourced) {const credit=$('credit');credit.href=preset.source;credit.textContent=preset.credit;}
  }

  function configureInputs() {
    for(const [key,{input,range}] of fields) {
      const [, , ,unit,min,max, , logarithmic]=settings.get(key);
      const value=state[key];
      input.value=String(key==='impact'?Number(value.toFixed(9)):value);
      range.value=String(logarithmic?Math.round(1000*Math.log(value/min)/Math.log(max/min)):value);
      range.setAttribute('aria-valuetext',precise(value)+' '+unit);
    }
    clockType.value=state.clockType;
    for(const button of buttons) button.setAttribute('aria-pressed',String(button.dataset.relativityMode===state.mode));
    for(const page of pages) page.hidden=page.dataset.relativityPanel!==state.mode;
    if(shortcutMode!==state.clockType) {
      shortcutMode=state.clockType;
      quickButtons($('clock-shortcuts'),quick[shortcutMode],'radius');
    }
    displayPreset();
  }

  function updatePhysics() {
    radiusKm=schwarzschildRadiusKm(state.massSolar);
    timeScale=schwarzschildTimeSeconds(state.massSolar);
    setValue('horizon',radiusKm,distance(radiusKm));
    orbitReading=null;
    if(state.mode==='light') {
      if(rayKey!==state.impact) {ray=traceLightRay(state.impact);rayKey=state.impact;}
      const status=ray?.status??'';
      $('ray-status').dataset.status=status;
      setText('ray-status',labels[status]??'Trajet indisponible');
      setText('result',labels[status]??'Trajet indisponible');
      setValue('periapsis',ray?.closestRadius,quantity(ray?.closestRadius,'Rₛ'));
      const degrees=Number.isFinite(ray?.deflection)?ray.deflection*180/Math.PI:NaN;
      setValue('deflection',degrees,quantity(degrees,'°'));
      setValue('critical-impact',BLACK_HOLE_LIMITS.criticalImpact,quantity(BLACK_HOLE_LIMITS.criticalImpact,'Rₛ'));
    } else if(state.mode==='clock') {
      if(state.clockType==='orbit') orbitReading=circularOrbit(state.radius);
      const rate=state.clockType==='hover'?hoverClockRate(state.radius):orbitReading?.clockRate;
      setValue('clock-rate',rate,Number.isFinite(rate)?ratioPercent(rate):'—');
      setValue('clock-minute',Number.isFinite(rate)?60*rate:NaN,Number.isFinite(rate)?clockTime(60*rate):'—');
      const status=state.clockType==='hover'?'Position fixe':!orbitReading?'Orbite impossible':
        Math.abs(state.radius-BLACK_HOLE_LIMITS.isco)<1e-9?'Stabilité marginale':orbitReading.stable?'Orbite stable':'Orbite instable';
      $('result').dataset.orbit=status;
      setText('result',status);
      setText('clock-note',state.clockType==='hover'?'Maintenir la sonde à cette distance exige une poussée continue.':
        orbitReading?'Période au loin '+clockTime(orbitReading.periodRs*timeScale)+' · vitesse locale '+ratioPercent(orbitReading.localSpeedC)+' de c.':
        'À ce rayon, une sonde massive ne peut pas suivre une orbite circulaire libre.');
    }
  }

  function render() {
    let fall=null,tidalRadius=state.radius;
    const progress=state.progress;
    if(state.mode==='light') tidalRadius=ray?.closestRadius;
    if(state.mode==='clock') {
      const distant=state.clockType==='hover'?60*progress:orbitReading?.periodRs*timeScale*progress;
      const factor=state.clockType==='hover'?hoverClockRate(state.radius):orbitReading?.clockRate;
      setValue('clock-reference',distant,clockTime(distant));setValue('clock-local',distant*factor,clockTime(distant*factor));
    }
    if(state.mode==='fall') {
      fall=radialFreeFallSample(state.startRadius,progress,state.stopRadius);
      tidalRadius=fall?.radius;
      const radius=fall?.radius,inside=radius<1,reached=radius<=1;
      setText('result',inside?'Sous l’horizon':reached?'Horizon atteint':progress===0?'Sonde au départ':'Chute radiale');
      setValue('fall-radius',radius,quantity(radius,'Rₛ'));
      setValue('fall-speed',fall?.arrivalSpeedC,Number.isFinite(fall?.arrivalSpeedC)?ratioPercent(fall.arrivalSpeedC)+' de c':'—');
      setValue('fall-proper',fall?.properTimeRs*timeScale,clockTime(fall?.properTimeRs*timeScale));
      setValue('fall-distant',fall?.coordinateTimeRs*timeScale,clockTime(fall?.coordinateTimeRs*timeScale));
      setText('fall-note',reached?'L’horloge embarquée continue de tourner. Le temps de Schwarzschild atteint sa limite de coordonnées à l’horizon.':
        'Le temps à bord mesure la durée ressentie par la sonde depuis son départ.');
    }
    const label=running?'Pause':progress===1?'Rejouer':'Lancer';
    if(play.title!==label) {
      play.innerHTML=icon(running?'pause':'play')+'<span>'+label+'</span>';
      play.title=label;play.setAttribute('aria-label',label);
    }
    play.setAttribute('aria-pressed',String(running));
    const readProgress=progress*100;
    progressInput.value=String(readProgress);
    progressInput.setAttribute('aria-valuetext',Math.round(readProgress)+' %');
    setText('progress-label',Math.round(readProgress)+' %');
    $('step').disabled=progress===1;
    tides.update(state.massSolar,tidalRadius);
    scene.update({mode:sceneModes[state.mode],mass:state.massSolar,radius:state.radius,impact:state.impact,
      progress,ray:state.mode==='light'?ray:null,fall:fall?{...fall,startRadius:state.startRadius,endRadius:state.stopRadius}:null,
      running,clock:state.clockType,showGuides:true});
  }
  function refresh() {configureInputs();updatePhysics();render();}
  function setSetting(key,value,commit=true) {
    const [, , , ,min,max]=settings.get(key);
    const next=Number.isFinite(value)?clamp(value,min,max):state[key];
    const changed=state[key]!==next;
    if(changed) {state[key]=next;resetProgress();}
    if(changed || commit) refresh();
    if(commit) notify();
  }

  for(const [key,{input,range}] of fields) {
    const [,,,,min,max,,logarithmic]=settings.get(key);
    input.onchange=()=>setSetting(key,input.valueAsNumber);
    range.oninput=()=>{
      const value=range.valueAsNumber;
      setSetting(key,logarithmic?Math.round(min*Math.exp(Math.log(max/min)*value/1000)):value,false);
    };
    range.onchange=notify;
  }
  for(const button of buttons) button.onclick=()=>{
    const key=button.dataset.relativityMode;
    if(state.mode===key) return;
    state.mode=key;resetProgress();
    refresh();notify();
  };
  presetInput.onchange=()=>{state=createState(presetInput.value);running=false;refresh();notify();};
  clockType.onchange=()=>{state.clockType=clockType.value;resetProgress();refresh();notify();};
  play.onclick=()=>{
    if(running) {running=false;render();notify();return;}
    if(state.progress===1) state.progress=0;
    if(reduceMotion()) {state.progress=1;render();notify();return;}
    running=true;render();
  };
  progressInput.oninput=()=>{running=false;state.progress=progressInput.valueAsNumber/100;render();};
  progressInput.onchange=notify;
  $('step').onclick=()=>{running=false;state.progress=Math.min(1,state.progress+.125);render();notify();};
  $('reset').onclick=()=>{resetProgress();render();notify();};
  $('exit').onclick=()=>onExit?.();
  $('waves').hidden=typeof onWaves!=='function';
  $('waves').onclick=()=>onWaves?.();
  $('photo').hidden=!onCapture;
  $('photo').onclick=()=>{
    const frame=scene.capture();
    if(frame?.width && frame?.height) onCapture?.(frame,'Trou noir · '+modeNames.get(state.mode)+' · '+format(state.massSolar)+' M☉');
  };
  function escape(event) {
    if(event.key!=='Escape'||event.defaultPrevented) return;
    event.preventDefault();event.stopPropagation();onExit?.();
  }
  root.addEventListener('keydown',escape);

  return {
    open({presetId,snapshot}={}) {
      const restore=snapshot?readState(snapshot):null;
      if(snapshot && !restore) return false;
      if(restore) state=restore;
      else if(presetId && presets.has(presetId)) state=createState(presetId);
      running=false;root.hidden=false;
      root.querySelector('.relativity-scroll').scrollTop=0;
      refresh();
      return true;
    },
    close() {running=false;root.hidden=true;notify();},
    tick(dt) {
      if(root.hidden || !running || !(dt>0)) return;
      const duration=state.mode==='fall'?8:5;
      state.progress=Math.min(1,state.progress+Math.min(.1,dt)/duration);
      const finished=state.progress===1;
      if(finished) running=false;
      render();
      if(finished) notify();
    },
    serialize,
    dispose() {scene.dispose();tides.dispose?.();root.removeEventListener('keydown',escape);root.replaceChildren();}
  };
}
