import { createInspiral, inspiralCutoffFrequency, INSPIRAL_DEFAULTS, INSPIRAL_LIMITS } from './waves-model.js';
import { WAVES_SCENARIOS } from './waves-scenarios.js';
import { createWavesView } from './waves-view.js';
import { createWaveAudio } from './waves-audio.js';
import { createWavesComparison } from './waves-compare.js';

const fields = [
  ['mass1', 'mass1', 'Masse du premier objet', 'M☉'],
  ['mass2', 'mass2', 'Masse du second objet', 'M☉'],
  ['distanceMpc', 'distance', 'Distance de luminosité', 'Mpc'],
  ['inclination', 'inclination', 'Inclinaison de l’orbite', '°'],
  ['redshift', 'redshift', 'Décalage vers le rouge', ''],
  ['startFrequency', 'start-frequency', 'Fréquence initiale', 'Hz']
];
const duration = new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:4});
const valueFormat = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});
const exponential = new Intl.NumberFormat('fr-CA',{notation:'scientific',maximumFractionDigits:2});
const clampProgress = value => Math.min(1,Math.max(0,value));
const localValue = value => value>=0.01 && value<1e6 ? valueFormat.format(value) : exponential.format(value);
const timeValue = value => value===0 || (value>=.001 && value<1e5) ? duration.format(value) : exponential.format(value);

const icons = {
  camera:'<path d="M4 7h4l2-3h4l2 3h4v13H4z"/><circle cx="12" cy="13" r="3"/>',
  cross:'<path d="m6 6 12 12M18 6 6 18"/>',
  play:'<path d="m8 5 12 7-12 7z"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
  volume:'<path d="M4 10v4h4l5 4V6l-5 4H4zM16 8c3 2 3 6 0 8m2-11c5 4 5 10 0 14"/>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
  reset:'<path d="M6 6v5h5m-5 0a7 7 0 1 1 1 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const reading = (key,label) => `<div><dt>${label}</dt><dd data-waves-${key}>—</dd></div>`;

function fieldMarkup([key,id,label,unit]) {
  const [min,max]=INSPIRAL_LIMITS[key];
  return `<label class="waves-field"><span>${label}</span><span class="waves-number"><input type="number" min="${min}" max="${max}" step="any" inputmode="decimal" data-waves-${id}>${unit?`<small aria-hidden="true">${unit}</small>`:''}</span></label>`;
}

export function createWavesLab(root,{onExit,onCapture,onChange,notify=()=>{},reduceMotion=()=>false}={}) {
  root.innerHTML=`<header class="waves-head"><div><h1>Ondes gravitationnelles</h1><p data-waves-title></p></div><div class="waves-head-actions"><button type="button" data-waves-photo title="Photographier l’expérience" aria-label="Photographier l’expérience">${icon('camera')}</button><button type="button" data-waves-exit title="Fermer le laboratoire" aria-label="Fermer le laboratoire">${icon('cross')}</button></div></header>
    <div class="waves-body">
      <section class="waves-visual" aria-label="Orbite et signal calculés">
        <dl class="waves-telemetry">${reading('frequency','Fréquence observée')}${reading('separation','Séparation')}${reading('strain','Signal +')}</dl>
        <div class="waves-scene-host" data-waves-scene></div>
      </section>
      <section class="waves-instruments" aria-label="Expérience et paramètres">
        <div class="waves-scroll">
          <label class="waves-study" for="waves-preset">Expérience</label><select id="waves-preset" data-waves-preset></select>
          <p class="waves-description" data-waves-description></p>
          <p class="waves-guide" data-waves-guide></p>
          <div class="waves-parameters">${fields.slice(0,4).map(fieldMarkup).join('')}</div>
          <details class="waves-details"><summary>Réglages avancés</summary><div class="waves-parameters">${fields.slice(4).map(fieldMarkup).join('')}</div>
            <label class="waves-audio-option">Hauteur du son<select data-waves-pitch><option value="1">Fréquence calculée</option><option value="2">Une octave plus haut</option></select></label>
          </details>
          <p class="waves-status" data-waves-status role="status" hidden></p>
          <dl class="waves-measurements">${reading('chirp-mass','Masse de chirp')}${reading('duration','Durée observée')}${reading('cutoff','Fréquence de coupure')}${reading('cross','Signal ×')}</dl>
          <details class="waves-details"><summary>Comparer deux systèmes</summary><div data-waves-compare></div></details>
          <details class="waves-details"><summary>Modèle et sources</summary>
            <p>Deux objets sans rotation sur une orbite circulaire. Le calcul s’arrête à une fréquence de coupure estimée, avant les phases de fusion et de relaxation. Le graphe montre la polarisation +.</p>
            <p>Le son est synthétisé et son volume est normalisé. Tu peux le jouer à la fréquence calculée ou une octave plus haut pour l’entendre sur de petits haut-parleurs. Dans les expériences longues, tu entends un extrait.</p>
            <p data-waves-credits hidden><a data-waves-source target="_blank" rel="noopener noreferrer"></a></p>
          </details>
        </div>
      </section>
    </div>
    <footer class="waves-footer">
      <button class="waves-primary" type="button" data-waves-play aria-pressed="false">${icon('play')}<span>Animer</span></button>
      <button type="button" data-waves-audio aria-pressed="false">${icon('volume')}<span>Écouter</span></button>
      <label class="waves-progress"><input type="range" min="0" max="1000" step="1" value="0" data-waves-progress aria-label="Progression du rapprochement"><output data-waves-time>—</output></label>
      <button type="button" data-waves-reset title="Retour au début" aria-label="Retour au début">${icon('reset')}</button>
    </footer>`;
  const $ = key => root.querySelector('[data-waves-'+key+']');
  const scenarioList = WAVES_SCENARIOS.map(study=>[study.id,study]);
  const scenarios = new Map(scenarioList);
  const options = $('preset');
  for (const [id,study] of scenarioList) options.add(new Option(study.name,id));
  const inputs = Object.fromEntries(fields.map(([setting,id])=>[setting,$(id)]));
  const progress = $('progress');
  let presetId = scenarioList[0][0];
  let settings = {...INSPIRAL_DEFAULTS,...scenarios.get(presetId).options};
  let model = createInspiral(settings);
  let position = 0;
  let playing = false;
  let listening = false;
  let pitch = 1;
  let pendingSave = null;

  const view = createWavesView($('scene'),{onSeek:fraction=>seek(fraction,false)});
  const audio = createWaveAudio({
    onState:running=>{
      listening=running;
      $('audio').setAttribute('aria-pressed',String(running));
      $('audio').innerHTML=icon(running?'stop':'volume')+`<span>${running?'Arrêter':'Écouter'}</span>`;
      if (!running && !root.hidden) save();
    },
    onError:()=>{
      announce('Le navigateur n’a pas pu jouer le son.');
    }
  });
  const comparison = createWavesComparison($('compare'),{getModel:()=>model,onChange:save});

  // A saved experiment holds only the observer settings and playhead.
  function serialize() {
    return {version:1,presetId,settings:{...settings},progress:position,pitch,comparison:comparison.serialize()};
  }
  function save() {
    clearTimeout(pendingSave);pendingSave=null;
    onChange?.(serialize());
  }
  function announce(message) {
    $('status').hidden=!message;
    $('status').textContent=message;
    if (message) notify(message);
  }
  function setPlaying(value) {
    if (playing===value) return;
    playing=value;
    $('play').setAttribute('aria-pressed',String(value));
    $('play').innerHTML=icon(value?'pause':'play')+`<span>${value?'Pause':'Animer'}</span>`;
  }
  function pause() {
    setPlaying(false);
    audio.stop();
  }
  function setReading(key,number,formatted) {
    const target=$(key);
    target.textContent=formatted;
    target.dataset.value=String(number);
  }
  function updateFrame() {
    const frame=model.sample(position*model.duration);
    setReading('frequency',frame.frequency,localValue(frame.frequency)+' Hz');
    setReading('separation',frame.separationKm,localValue(frame.separationKm)+' km');
    setReading('strain',frame.plus,exponential.format(frame.plus));
    setReading('cross',frame.cross,exponential.format(frame.cross));
    setReading('time',frame.elapsed,timeValue(frame.elapsed)+' / '+timeValue(model.duration)+' s');
    progress.value=String(Math.round(position*1000));
    progress.setAttribute('aria-valuetext',timeValue(frame.elapsed)+' secondes');
    view.update(frame);
  }
  function seek(fraction,commit=true) {
    if (!Number.isFinite(fraction)) return;
    pause();
    position=clampProgress(fraction);
    updateFrame();
    if (commit) save();
    else {
      clearTimeout(pendingSave);
      pendingSave=setTimeout(save,160);
    }
  }
  function display() {
    const study=scenarios.get(presetId);
    options.value=presetId;
    const original={...INSPIRAL_DEFAULTS,...study.options};
    const adjusted=Object.keys(inputs).some(key=>settings[key]!==original[key]);
    $('title').textContent=adjusted?'Paramètres personnalisés':study.name;
    $('description').textContent=study.description;
    $('guide').textContent=study.guide;
    $('credits').hidden=!study.source;
    if (study.source) $('source').href=study.source;
    else $('source').removeAttribute('href');
    $('source').textContent=study.credit||'';
    for (const [key,input] of Object.entries(inputs)) input.value=String(settings[key]);
    setReading('chirp-mass',model.chirpMass,localValue(model.chirpMass)+' M☉');
    setReading('duration',model.duration,timeValue(model.duration)+' s');
    setReading('cutoff',model.endFrequency,localValue(model.endFrequency)+' Hz');
    view.setSignal(model.samples(1800),model);
    comparison.update();
    updateFrame();
  }
  function selectPreset(id) {
    const scenario=scenarios.get(id);
    if (!scenario) return false;
    const requested={...INSPIRAL_DEFAULTS,...scenario.options};
    const next=createInspiral(requested);
    if (!next) return false;
    pause();
    presetId=id;settings=requested;model=next;position=0;
    announce('');display();save();
    return true;
  }

  options.onchange=()=>selectPreset(options.value);
  $('pitch').onchange=()=>{audio.stop();pitch=Number($('pitch').value);save();};
  for (const [key,input] of Object.entries(inputs)) {
    input.onchange=()=>{
      const candidate={...settings,[key]:input.valueAsNumber};
      const cutoff=inspiralCutoffFrequency(candidate.mass1+candidate.mass2,candidate.redshift);
      const corrected=key!=='startFrequency' && Number.isFinite(cutoff) && candidate.startFrequency>=cutoff;
      if (corrected) candidate.startFrequency=Number((cutoff*.8).toPrecision(5));
      const next=createInspiral(candidate);
      if (!next) {
        input.value=String(settings[key]);
        announce(key==='startFrequency'?'Choisis une fréquence plus basse que la coupure.':'Choisis une valeur comprise dans la plage du réglage.');
        return;
      }
      pause();settings=candidate;model=next;
      display();save();
      announce(corrected?'La fréquence de départ a été abaissée sous la coupure.':'');
    };
    input.addEventListener('keydown',event=>{if(event.key==='Enter') input.blur();});
  }
  $('play').onclick=()=>{
    audio.stop();
    if (playing) {setPlaying(false);save();return;}
    if (position===1) position=0;
    setPlaying(true);updateFrame();
  };
  $('audio').onclick=()=>{
    if (listening) {audio.stop();return;}
    setPlaying(false);
    audio.play(model,{
      pitch,
      stretch:Math.min(4,Math.max(1,1.75/model.duration)),
      onPosition:seconds=>{
        if(root.hidden) return;
        position=clampProgress(seconds/model.duration);updateFrame();
      }
    });
  };
  progress.oninput=()=>seek(Number(progress.value)/1000,false);
  progress.onchange=save;
  $('reset').onclick=()=>seek(0);
  $('photo').hidden=!onCapture;
  $('photo').onclick=()=>{
    pause();save();
    const frame=view.capture();
    if(frame) onCapture?.(frame,'Ondes gravitationnelles · '+$('title').textContent);
  };
  $('exit').onclick=()=>onExit?.();
  root.onkeydown=event=>{
    if(event.key!=='Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    event.preventDefault();onExit?.();
  };

  function open({presetId:id,snapshot}={}) {
    if(snapshot!==undefined && snapshot!==null) {
      const clean=snapshot.version===1 && snapshot.settings && createInspiral(snapshot.settings);
      if(!clean || !scenarios.has(snapshot.presetId) || !Number.isFinite(snapshot.progress)) return false;
      pause();presetId=snapshot.presetId;
      settings=Object.fromEntries(fields.map(([key])=>[key,clean[key]]));
      model=clean;position=clampProgress(snapshot.progress);pitch=snapshot.pitch===2?2:1;
      comparison.restore(snapshot.comparison ?? null);
    } else if(id && !selectPreset(id)) return false;
    root.hidden=false;
    $('pitch').value=String(pitch);
    announce('');display();
    return true;
  }
  function close() {
    pause();save();root.hidden=true;
  }
  function tick(dt) {
    if(!playing || root.hidden || !Number.isFinite(dt) || dt<=0) return;
    const playDuration=reduceMotion()?12:9;
    position=clampProgress(position+dt/playDuration);
    updateFrame();
    if(position===1) {setPlaying(false);save();}
  }
  function dispose() {
    close();audio.dispose();view.dispose();root.onkeydown=null;root.replaceChildren();
  }
  return {open,close,tick,pause,serialize,dispose};
}
