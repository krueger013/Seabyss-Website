import { CLIMATE_DEFAULTS, CLIMATE_RANGES, ClimateModel, climateAtLatitude } from './climate-model.js';
import { createClimateGlobe } from './climate-globe.js';
import { CLIMATE_SCENARIOS, checkClimateObjective } from './climate-scenarios.js';
import { createClimateComparison } from './climate-compare.js';
import { createClimateOrbit } from './climate-orbit.js';
import { CryosphereModel } from './cryosphere-model.js';
import { createCryospherePanel } from './cryosphere-panel.js';
import { CRYOSPHERE_SCENARIOS, checkCryosphereObjective } from './cryosphere-scenarios.js';

const YEAR=365.256;
const HISTORY_LIMIT=241;
const regular=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const fine=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3});
const percent=new Intl.NumberFormat('fr-CA',{style:'percent',maximumFractionDigits:1}).format;
const dayLabel=value=>fine.format(value)+' j';
const annual=value=>regular.format(value)+' ans';
const temp=value=>regular.format(value)+' °C';
const flux=value=>regular.format(value)+' W/m²';
const space=value=>fine.format(value)+' UA';
const LAYERS=['ice','temperature','insolation','albedo'];
const CRYO_LAYERS=['seaIce','landIce','cryosphere'];
const MEASURES=['day','meanTemperature','minTemperature','maxTemperature','iceFraction','energyImbalance','meanInsolation','orbitalDistance','solarDeclination'];
const CRYO_MEASURES=['seaLevelMeters','groundedIceGt','seaIceAreaKm2'];
const SITES=[
  ['levis','Lévis',46.8118,-71.2048],
  ['tropics','Quito',-.18,-78.47],
  ['arctic','Arctique',78.22,15.65],
  ['antarctic','Antarctique',-75,0]
];
const fields=[
  ['orbit','semiMajorAxis','Demi-grand axe','UA',.001,true],
  ['orbit','eccentricity','Excentricité','',.001,false],
  ['orbit','obliquity','Inclinaison de l’axe','°',.1,false],
  ['orbit','solarLuminosity','Luminosité stellaire','L☉',.001,true],
  ['orbit','perihelionLongitude','Saison du périhélie','°',1,false],
  ['air','co2','CO₂ atmosphérique','ppm',1,true],
  ['air','pressure','Pression de surface','bar',.001,true],
  ['air','water','Fraction d’eau de surface','%',.01,false,100],
  ['air','heatTransport','Transport méridien','W/m²/K',.01,false],
  ['air','iceAlbedo','Réflectivité de la glace','%',.01,false,100],
  ['air','oceanMixingDepth','Profondeur de la couche océanique','m',.1,true],
  ['air','geothermalFlux','Chaleur interne','W/m²',.01,true]
];
const layerText=['Glace','Température','Soleil','Albédo'];
const studyLayers={'ice-front':'ice','high-tilt':'insolation',eccentric:'insolation','dark-ice':'albedo',
  'geothermal-night':'temperature','polar-night':'insolation','dry-seasons':'temperature'};
const icons={
  play:'<path fill="currentColor" stroke="none" d="m7 4 13 8-13 8z"/>',
  pause:'<path stroke-width="3" d="M8 5v14m8-14v14"/>',
  step:'<path d="m5 5 11 7-11 7zM19 5v14"/>',
  photo:'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="m7 7 2-3h6l2 3"/><circle cx="12" cy="13" r="3.4"/>',
  exit:'<path d="m6 6 12 12M18 6 6 18"/>'
};
const icon=key=>'<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+icons[key]+'</svg>';
const readout=(label,key)=>'<div><dt>'+label+'</dt><dd data-climate-'+key+'>—</dd></div>';
const copyMeasures=(state,ice=state)=>Object.fromEntries(MEASURES.map(key=>[key,state[key]]).concat(
  CRYO_MEASURES.filter(key=>Number.isFinite(ice?.[key])).map(key=>[key,ice[key]])));
const cryoSummary=readings=>readings?Object.fromEntries(Object.entries(readings).filter(([,value])=>Number.isFinite(value))):null;
const validMeasures=state=>state && MEASURES.every(key=>Number.isFinite(state[key])) && state.day>=0 && state.iceFraction>=0 && state.iceFraction<=1;
const siteText=(lat,lon)=>regular.format(Math.abs(lat))+'° '+(lat<0?'S':'N')+' · '+regular.format(Math.abs(lon))+'° '+(lon<0?'O':'E');
const orbitalPeriod=options=>options.period??YEAR*options.semiMajorAxis**1.5;

function paramMarkup([,key,name,unit,step,log,factor=1]) {
  const [min,max]=CLIMATE_RANGES[key];
  const floor=min===0?0:min*factor;
  const label=unit?name+' ('+unit+')':name;
  const increment=step*factor;
  return '<div class="climate-param"><div><label for="climate-param-'+key+'">'+name+'</label><span>'+
    '<input id="climate-param-'+key+'" inputmode="decimal" aria-label="'+label+'" type="number" min="'+floor+'" max="'+max*factor+
    '" step="'+increment+'" data-climate-param="'+key+'">'+(unit?'<span aria-hidden="true">'+unit+'</span>':'')+
    '</span></div><input aria-label="Ajuster '+label+'" type="range" min="'+(log?0:floor)+'" max="'+(log?1000:max*factor)+
    '" step="'+(log?1:increment)+'" data-climate-range="'+key+'"></div>';
}

function mapRange(key,value,toModel) {
  const [min,max]=CLIMATE_RANGES[key];
  // A logarithmic scale gives useful increments near terrestrial values. An
  // An offset includes the vacuum endpoint without log(0).
  const offset=min===0?.01:0;
  const logarithm=Math.log((max+offset)/(min+offset));
  return toModel
    ? Math.max(min,Math.min(max,(min+offset)*Math.exp(logarithm*value/1000)-offset))
    : 1000*Math.log((value+offset)/(min+offset))/logarithm;
}

function drawPlot(canvas,history,key) {
  if(canvas.closest('[hidden]')) return;
  const {width,height}=canvas.getBoundingClientRect();
  if(width<50 || height<50) return;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  const ctx=canvas.getContext('2d');
  if(!ctx) return;
  ctx.scale(dpr,dpr);
  const entries=history.filter(sample=>Number.isFinite(sample[key]));
  if(!entries.length) return;
  const values=entries.map(sample=>sample[key]);
  const minSpan={iceFraction:.05,seaLevelMeters:.01,groundedIceGt:100,seaIceAreaKm2:1e5};
  const span=Math.max(Math.max(...values)-Math.min(...values),minSpan[key] ?? 2);
  const middle=(Math.max(...values)+Math.min(...values))/2;
  const max=middle+span*.62,min=middle-span*.62;
  const from=entries[0].day,to=entries.at(-1).day;
  const left=47,top=12,h=height-35,w=width-left-10;
  const x=day=>left+(day-from)/Math.max(1,to-from)*w;
  const y=value=>top+(max-value)/(max-min)*h;
  ctx.font='10px system-ui';ctx.textBaseline='middle';
  const format={meanTemperature:temp,iceFraction:percent,energyImbalance:flux,
    seaLevelMeters:value=>fine.format(value*100)+' cm',groundedIceGt:value=>regular.format(value)+' Gt',
    seaIceAreaKm2:value=>regular.format(value/1e6)+' M km²'}[key];
  for(let line=0;line<3;line++) {
    const value=max-(max-min)*line/2,pos=y(value);
    ctx.strokeStyle='#283d4b';ctx.beginPath();ctx.moveTo(left,pos);ctx.lineTo(width-10,pos);ctx.stroke();
    ctx.fillStyle='#c0d2db';ctx.textAlign='right';ctx.fillText(format(value),left-4,pos,41);
  }
  ctx.beginPath();
  entries.forEach((sample,index)=>index ? ctx.lineTo(x(sample.day),y(sample[key])) : ctx.moveTo(x(sample.day),y(sample[key])));
  ctx.strokeStyle='#9be8e2';ctx.lineWidth=2;ctx.stroke();
  ctx.beginPath();ctx.arc(x(to),y(values.at(-1)),3,0,Math.PI*2);ctx.fillStyle='#bbf5ed';ctx.fill();
  ctx.fillStyle='#c0d2db';ctx.textAlign='left';ctx.fillText(dayLabel(from),left,height-8);
  if(to-from>1) {ctx.textAlign='right';ctx.fillText(dayLabel(to),width-10,height-8);}
}

export function createClimateLab(root,{onExit,onChange,onExport,onImport,onCapture}={}) {
  root.classList.add('climate-lab');
  root.innerHTML='<header class="climate-head"><div><h1>Climat planétaire</h1>'+
    '<p><strong data-climate-name>Terre</strong><span data-climate-note hidden></span></p></div>'+
    '<div class="climate-head-actions"><button data-climate-photo class="climate-exit" type="button" title="Photographier le globe" aria-label="Photographier le globe">'+icon('photo')+'</button>'+
    '<button data-climate-exit class="climate-exit" type="button" title="Fermer le laboratoire" aria-label="Fermer le laboratoire">'+icon('exit')+'</button></div></header>'+
    '<div class="climate-body"><section class="climate-visual" aria-label="Observation du globe">'+
    '<dl class="climate-primary-readouts">'+readout('Température','mean')+readout('Surface glacée','ice')+readout('Bilan d’énergie','balance')+'</dl>'+
    '<div class="climate-globe-host" data-climate-globe-host></div><div class="climate-layers" aria-label="Carte du globe">'+
    LAYERS.map((key,index)=>'<button type="button" data-climate-layer="'+key+'"'+(key==='insolation'?' aria-label="Ensoleillement"':'')+' aria-pressed="'+(index===0)+'">'+layerText[index]+'</button>').join('')+
    '</div></section><aside class="climate-controls" aria-label="Paramètres et lectures climatiques">'+
    '<nav class="climate-tabs" aria-label="Instruments">'+[['experiments','Études','Expériences'],['cryosphere','Glaces','Banquise et glaciers'],['orbit','Orbite','Orbite et saisons'],['air','Air','Atmosphère et surface'],['compare','A/B','Comparer deux climats'],['history','Journal','Journal']]
      .map(([key,label,spoken])=>'<button type="button" data-climate-options="'+key+'" aria-label="'+spoken+'" aria-pressed="'+(key==='experiments')+'">'+label+'</button>').join('')+'</nav>'+
    '<div class="climate-panels" data-climate-panels><section class="climate-panel" data-climate-panel="experiments">'+
    '<label class="climate-field" for="climate-preset">Expérience</label><select id="climate-preset" data-climate-preset></select>'+
    '<p data-climate-description></p><button type="button" class="climate-primary" data-climate-simulate>Simuler</button>'+
    '<div class="climate-objective" data-climate-objective><strong data-climate-objective-status></strong><p data-climate-guide></p></div>'+
    '<section class="climate-section"><div class="climate-detail-heading"><h2>Mesure locale</h2>'+
    '<select aria-label="Recentrer sur un repère" data-climate-site><option value="">Repères</option>'+
    SITES.map(([id,name])=>'<option value="'+id+'">'+name+'</option>').join('')+
    '</select></div><p class="climate-coordinates" data-climate-coordinates></p>'+
    '<dl class="climate-local-readouts">'+readout('Température','local-temperature')+readout('Glace','local-ice')+
    readout('Soleil moyen','local-flux')+readout('Énergie absorbée','local-absorbed')+
    readout('Durée du jour','local-daylight')+readout('Albédo','local-albedo')+'</dl>'+
    '<p class="climate-small">Le globe représente des moyennes par latitude.</p>'+
    '<p class="climate-small" data-climate-map-note hidden></p></section></section>'+
    '<section class="climate-panel" data-climate-panel="orbit" hidden><h2>Orbite et saisons</h2>'+
    '<dl class="climate-local-readouts">'+readout('Distance instantanée','distance')+readout('Période','period')+
    readout('Latitude subsolaire','declination')+readout('Soleil moyen','insolation')+'</dl>'+
    '<div data-climate-orbit></div>'+fields.filter(field=>field[0]==='orbit').map(paramMarkup).join('')+
    '<section class="climate-section" data-climate-orbit-transfer hidden><p class="climate-small">Transfère le demi-grand axe et l’excentricité à la planète d’origine. Tu peux annuler dans l’Atelier.</p><button type="button" class="climate-primary" data-climate-apply-orbit>Appliquer l’orbite dans l’Atelier</button><p class="climate-small" data-climate-transfer-status role="status"></p></section>'+
    '<p class="climate-limit" data-climate-limit hidden>Les conditions atteignent la limite numérique du modèle.</p></section>'+
    '<section class="climate-panel" data-climate-panel="air" hidden><h2>Atmosphère et surface</h2>'+
    fields.filter(field=>field[0]==='air').map(paramMarkup).join('')+
    '<dl class="climate-local-readouts">'+readout('Soleil absorbé','absorbed-flux')+readout('Infrarouge émis','outgoing-flux')+
    readout('Chaleur interne','internal-flux')+readout('Albédo global','mean-albedo')+'</dl>'+
    '<p class="climate-small">La couche d’eau amortit les variations saisonnières. La chaleur interne est répartie uniformément dans le calcul.</p></section>'+
    '<section class="climate-panel" data-climate-panel="compare" hidden><div data-climate-compare></div></section>'+
    '<section class="climate-panel" data-climate-panel="cryosphere" hidden><div data-climate-cryosphere></div></section>'+
    '<section class="climate-panel" data-climate-panel="history" hidden><h2>Historique du climat</h2>'+
    '<label class="climate-field" for="climate-metric">Courbe</label><select id="climate-metric" data-climate-metric>'+
    '<option value="meanTemperature">Température globale</option><option value="iceFraction">Surface glacée</option>'+
    '<option value="energyImbalance">Bilan d’énergie</option><optgroup label="Glaces de la Terre" data-climate-cryo-metrics>'+
    '<option value="seaIceAreaKm2">Surface de banquise</option><option value="groundedIceGt">Masse de glace terrestre</option>'+
    '<option value="seaLevelMeters">Niveau marin équivalent</option></optgroup></select>'+
    '<canvas class="climate-chart" data-climate-chart role="img" aria-label="Historique climatique"></canvas>'+
    '<p class="climate-small" data-climate-chart-note></p><div class="climate-files">'+
    '<button type="button" data-climate-csv>Mesures CSV</button><button type="button" data-climate-export>Exporter JSON</button>'+
    '<button type="button" data-climate-import-open>Importer JSON</button></div>'+
    '<details class="climate-model" data-climate-model><summary>Modèle et limites</summary>'+
    '<p>Le bilan énergétique par latitude tient compte du rayonnement reçu, du rayonnement infrarouge sortant, du stockage de chaleur et des échanges entre latitudes. La glace réfléchit davantage de lumière et évolue progressivement.</p>'+
    '<p>La géographie du globe sert de repère. La température et la glace représentent des moyennes par latitude. Les courants océaniques, les nuages, les reliefs, le détail régional et la météorologie locale sont hors du modèle.</p>'+
    '<p><a href="https://doi.org/10.3402/tellusa.v21i5.10109" target="_blank" rel="noopener noreferrer">Bilan énergétique et glace · Budyko</a></p></details></section></div></aside></div>'+
    '<footer class="climate-footer"><div class="climate-clock"><output data-climate-days>—</output><small data-climate-season></small></div>'+
    '<button type="button" class="climate-primary climate-play" data-climate-play aria-label="Lancer la simulation"></button>'+
    '<button type="button" data-climate-step title="Avancer d’une orbite" aria-label="Avancer d’une orbite">'+icon('step')+'<span>1 orbite</span></button>'+
    '<select data-climate-rate aria-label="Vitesse de simulation"><option value="30">30 j/s</option><option value="180" selected>180 j/s</option>'+
    '<option value="365">365 j/s</option><option value="730">730 j/s</option></select>'+
    '<button type="button" data-climate-reset title="Recommencer cette expérience">Repartir</button></footer>';

  const $=key=>root.querySelector('[data-climate-'+key+']');
  const presetSelect=$('preset'),metric=$('metric'),canvas=$('chart');
  const presets=new Map([...CLIMATE_SCENARIOS,...CRYOSPHERE_SCENARIOS].map(item=>[item.id,item]));
  const cryoPresets=new Set(CRYOSPHERE_SCENARIOS.map(item=>item.id));
  const custom='custom';
  const baseName='Terre simulée';
  const ranges=new Map(fields.map(field=>[field[1],{
    field,input:root.querySelector('[data-climate-param="'+field[1]+'"]'),range:root.querySelector('[data-climate-range="'+field[1]+'"]')
  }]));
  const cryoGroup=document.createElement('optgroup');cryoGroup.label='Banquise et glaciers';
  cryoGroup.append(...CRYOSPHERE_SCENARIOS.map(item=>new Option(item.name,item.id)));
  presetSelect.replaceChildren(...CLIMATE_SCENARIOS.map(item=>new Option(item.name,item.id)),cryoGroup,new Option('Réglages libres',custom));
  let model=new ClimateModel(),name=baseName,note='',planetId='earth',layer='ice',selectedPreset='earth';
  let baseline,samples=[],current,location=[46.8118,-71.2048],lastPreset='earth',startParams={};
  let cryosphere=null, cryoReadings=null, cryoBaseline=null;
  let tab='experiments',playing=false,targetDay=null,elapsed=0,daysToAdvance=0,persistedAt=0,goalReached=false;
  let workshopApply=null;
  const comparison=createClimateComparison($('compare'),{
    getMeasurement:()=>model.measure(),getOptions:()=>model.options,
    getRegional:()=>cryoReadings,getName:()=>presets.get(selectedPreset)?.name || name,onChange:()=>notify()
  });
  const orbit=createClimateOrbit($('orbit'),{onAdvance:days=>advanceTarget(days,true)});
  const regionalPanel=createCryospherePanel($('cryosphere'),{
    scenarios:CRYOSPHERE_SCENARIOS,
    onLayer:key=>{setLayer(key);notify();},
    onSite:(latitude,longitude)=>focusLocation(latitude,longitude),
    onPreset:id=>{applyPreset(id);advanceTarget(currentDuration(),true);}
  });
  const globe=createClimateGlobe($('globe-host'),{onSelect:(latitude,longitude)=>{
    location=[latitude,longitude];
    showLocation();
    updateOrbit();
    updateRegionalPanel();
    notify();
  }});

  function setText(key,value) {const display=$(key);if(display.textContent!==value) display.textContent=value;}
  function showLocation() {
    setText('coordinates',siteText(...location));
    if(!current) return;
    const data=climateAtLatitude(current,location[0]);
    if(!data) return;
    setText('local-temperature',temp(data.temperature));
    setText('local-ice',percent(data.ice));
    setText('local-flux',flux(data.insolation));
    setText('local-absorbed',flux(data.absorbed));
    setText('local-daylight',regular.format(data.daylightHours)+' h');
    setText('local-albedo',percent(data.albedo));
  }
  function updateOrbit() {if(tab==='orbit' && current) orbit.update(current,model.options,location[0]);}
  function updateRegionalPanel() {
    if(tab==='cryosphere' && cryosphere && cryoReadings) {
      regionalPanel.update(cryoReadings,cryosphere.sample(cryoReadings,...location),layer);
    }
  }
  function focusLocation(latitude,longitude) {
    location=[latitude,longitude];globe.setLocation(...location,{center:true});
    showLocation();updateOrbit();updateRegionalPanel();notify();
  }
  function showOrbitTransfer() {
    $('orbit-transfer').hidden=!workshopApply;
    $('apply-orbit').disabled=model.options.semiMajorAxis===startParams.semiMajorAxis && model.options.eccentricity===startParams.eccentricity;
  }
  function setLayer(key) {
    layer=CRYO_LAYERS.includes(key) && !cryosphere?'ice':key;
    for(const button of root.querySelectorAll('[data-climate-layer]')) button.setAttribute('aria-pressed',String(button.dataset.climateLayer===layer));
    globe.setLayer(layer);
    updateRegionalPanel();
  }
  function currentDuration() {
    return (presets.get(selectedPreset)?.years || 1)*orbitalPeriod(model.options);
  }
  function showExposure() {
    const active=presets.get(selectedPreset);
    const description=active?.description||'Change les réglages, puis avance le temps pour observer la réaction du climat.';
    setText('description',description);
    const guide=active?.guide;
    $('objective').hidden=!guide;
    if(guide) {
      setText('guide',guide);setText('objective-status',goalReached?'Observation confirmée':'À observer');
      $('objective').dataset.achieved=String(goalReached);
    }
    const years=active?.years || 1;
    setText('simulate',targetDay!==null?'Interrompre l’avance':
      years===1?'Simuler une orbite':years<1?'Simuler '+dayLabel(currentDuration()):'Simuler '+annual(years));
  }
  function showClock() {
    const running=playing||targetDay!==null;
    const button=$('play'),label=running?'Mettre en pause':'Lancer la simulation';
    if(button.getAttribute('aria-pressed')!==String(running)||!button.innerHTML) button.innerHTML=icon(running?'pause':'play');
    button.setAttribute('aria-pressed',String(running));button.setAttribute('aria-label',label);button.title=label;
    $('days').dataset.days=String(current.day);
    setText('days','Jour '+fine.format(current.day));
    setText('season','Soleil à '+regular.format(current.solarDeclination)+'°');
  }
  function storeSample() {
    const sample=copyMeasures(current,cryoReadings), latest=samples.at(-1);
    if(latest?.day===current.day) {samples[samples.length-1]=sample;return;}
    if(latest && current.day-latest.day<13) return;
    samples.push(sample);
    if(samples.length>HISTORY_LIMIT) samples.shift();
  }
  function chart() {
    drawPlot(canvas,samples,metric.value);
    const available=samples.filter(sample=>Number.isFinite(sample[metric.value]));
    setText('chart-note',available.length>1 ? available.length+' relevés · '+dayLabel(available[0].day)+' à '+dayLabel(available.at(-1).day)
      : 'Les relevés s’ajoutent avec le temps simulé.');
  }
  function refresh({sample=false,paint=true}={}) {
    current=model.measure();
    cryoReadings=cryosphere?.measure(current) ?? null;
    if(sample) storeSample();
    if(!goalReached && selectedPreset!==custom && baseline && current.day>baseline.day) {
      goalReached=cryoPresets.has(selectedPreset)
        ? checkCryosphereObjective(selectedPreset,cryoBaseline,cryoReadings)
        : checkClimateObjective(selectedPreset,baseline,current);
    }
    const geographyNote=planetId!=='earth'?'Fond de carte terrestre de référence.':'';
    setText('name',name);setText('note',[note,geographyNote].filter(Boolean).join(' '));$('note').hidden=!note&&!geographyNote;
    setText('map-note',geographyNote);$('map-note').hidden=!geographyNote;
    setText('mean',temp(current.meanTemperature));$('mean').dataset.value=String(current.meanTemperature);
    setText('ice',percent(current.iceFraction));$('ice').dataset.value=String(current.iceFraction);
    setText('balance',flux(current.energyImbalance));
    $('limit').hidden=!current.limitReached;
    setText('distance',space(current.orbitalDistance));setText('period',dayLabel(orbitalPeriod(model.options)));
    setText('declination',regular.format(current.solarDeclination)+'°');setText('insolation',flux(current.meanInsolation));
    showClock();showExposure();showLocation();
    updateOrbit();showOrbitTransfer();
    setText('absorbed-flux',flux(current.absorbedFlux));setText('outgoing-flux',flux(current.outgoingFlux));
    setText('internal-flux',flux(current.geothermalFlux));setText('mean-albedo',percent(current.meanAlbedo));
    if(paint) globe.update(current,cryoReadings);
    updateRegionalPanel();
    if(tab==='history') chart();
  }
  function syncParameters(skip) {
    for(const [key,{field,input,range}] of ranges) {
      const [, , , unit,step,log,factor=1]=field;
      const value=model.options[key];
      const precision=unit==='ppm'?0:Math.max(2,Math.ceil(-Math.log10(step)));
      if(input!==skip) input.value=String(Number((value*factor).toFixed(precision)));
      if(range!==skip) range.value=String(log?mapRange(key,value,false):value*factor);
    }
  }
  function switchPanel(key) {
    tab=key;
    for(const button of root.querySelectorAll('[data-climate-options]')) button.setAttribute('aria-pressed',String(button.dataset.climateOptions===key));
    for(const panel of root.querySelectorAll('[data-climate-panel]')) panel.hidden=panel.dataset.climatePanel!==key;
    $('panels').scrollTop=0;
    if(key==='history') chart();
    if(key==='orbit') updateOrbit();
    if(key==='compare') comparison.refresh();
    if(key==='cryosphere') {
      if(!CRYO_LAYERS.includes(layer)) setLayer('cryosphere');
      updateRegionalPanel();
    }
  }
  function updateRegionalAvailability() {
    root.querySelector('[data-climate-options="cryosphere"]').hidden=!cryosphere;
    $('cryo-metrics').hidden=!cryosphere;$('cryo-metrics').disabled=!cryosphere;
    if(!cryosphere && CRYO_MEASURES.includes(metric.value)) metric.value='meanTemperature';
    if(!cryosphere && tab==='cryosphere') switchPanel('experiments');
    if(!cryosphere && CRYO_LAYERS.includes(layer)) setLayer('ice');
  }
  function serialize() {
    return {version:1,model:model.serialize(),name,note,planetId,selectedPreset,lastPreset,startParams,
      goalReached,baseline,samples,layer,location,comparison:comparison.serialize(),
      cryosphere:cryosphere?.serialize() ?? null,cryoBaseline};
  }
  function notify() {onChange?.(serialize());}
  function stop() {playing=false;targetDay=null;elapsed=0;daysToAdvance=0;}
  function begin(options,{preset='earth',planet=baseName,message='',id='earth'}={}) {
    stop();model=new ClimateModel(options);
    name=planet;note=message;planetId=id;selectedPreset=preset;lastPreset=preset;startParams={...model.options};
    cryosphere=id==='earth'?new CryosphereModel():null;
    baseline=copyMeasures(model.measure());cryoBaseline=cryoSummary(cryosphere?.measure(model.measure()));
    samples=[];goalReached=false;persistedAt=0;
    updateRegionalAvailability();
    presetSelect.value=preset;syncParameters();refresh({sample:true});
  }
  function restore(snapshot) {
    if(snapshot?.version!==1) return false;
    const candidate=ClimateModel.restore(snapshot.model);
    if(!candidate) return false;
    const restoredIce=snapshot.cryosphere?CryosphereModel.restore(snapshot.cryosphere):null;
    if(snapshot.cryosphere && !restoredIce) return false;
    workshopApply=null;
    stop();model=candidate;
    name=typeof snapshot.name==='string' && snapshot.name.trim() ? snapshot.name.trim().slice(0,70) : baseName;
    note=typeof snapshot.note==='string' ? snapshot.note.slice(0,320) : '';
    planetId=typeof snapshot.planetId==='string' && snapshot.planetId ? snapshot.planetId.slice(0,80) : 'earth';
    cryosphere=planetId==='earth'?(restoredIce ?? new CryosphereModel()):null;
    const firstCryo=cryosphere?.measure(model.measure());
    cryoBaseline=firstCryo?cryoSummary(restoredIce && snapshot.cryoBaseline && typeof snapshot.cryoBaseline==='object'
      ? snapshot.cryoBaseline:firstCryo):null;
    selectedPreset=presets.has(snapshot.selectedPreset)?snapshot.selectedPreset:custom;
    lastPreset=presets.has(snapshot.lastPreset)?snapshot.lastPreset:custom;
    startParams={...model.options};
    if(snapshot.startParams && typeof snapshot.startParams==='object') {
      const initial=new ClimateModel();
      if(initial.configure(snapshot.startParams)) startParams={...initial.options};
    }
    baseline=validMeasures(snapshot.baseline)?copyMeasures(snapshot.baseline):copyMeasures(model.measure());
    goalReached=snapshot.goalReached===true && selectedPreset!==custom;
    const currentDay=model.measure().day;
    samples=Array.isArray(snapshot.samples)?snapshot.samples.slice(-HISTORY_LIMIT).filter(sample=>validMeasures(sample)&&sample.day<=currentDay).map(sample=>copyMeasures(sample)).sort((a,b)=>a.day-b.day):[];
    if(Array.isArray(snapshot.location)&&snapshot.location.length===2&&snapshot.location.every(Number.isFinite)) {
      location=[Math.max(-90,Math.min(90,snapshot.location[0])),((snapshot.location[1]+180)%360+360)%360-180];
    }
    persistedAt=currentDay;
    if(!comparison.restore(snapshot.comparison ?? null)) comparison.restore(null);
    updateRegionalAvailability();
    presetSelect.value=selectedPreset;syncParameters();setLayer([...LAYERS,...CRYO_LAYERS].includes(snapshot.layer)?snapshot.layer:'ice');
    refresh({sample:true});
    globe.setLocation(...location,{center:true});
    return true;
  }
  function applyPreset(id) {
    const preset=presets.get(id);
    if(!preset) {selectedPreset=custom;showExposure();notify();return;}
    workshopApply=null;
    begin(preset.options,{preset:id});
    if(preset.layer || studyLayers[id]) setLayer(preset.layer || studyLayers[id]);
    if(preset.location) focusLocation(...preset.location);
    notify();
  }
  function changeParam(key,value,skip) {
    if(!Number.isFinite(value)) return false;
    const [min,max]=CLIMATE_RANGES[key];
    const patch={[key]:Math.max(min,Math.min(max,value))};
    if(key==='semiMajorAxis' && model.options.period!==null) {
      const [minPeriod,maxPeriod]=CLIMATE_RANGES.period;
      patch.period=Math.max(minPeriod,Math.min(maxPeriod,model.options.period*(patch[key]/model.options.semiMajorAxis)**1.5));
    }
    if(!model.configure(patch)) return false;
    selectedPreset=custom;goalReached=false;presetSelect.value=custom;
    syncParameters(skip);refresh();return true;
  }
  function advanceTarget(days,replace=false) {
    if(targetDay!==null && !replace) {stop();refresh();notify();return;}
    stop();targetDay=current.day+days;refresh({paint:false});
  }
  for(const [key,{field,input,range}] of ranges) {
    const [, , , ,step,log,factor=1]=field;
    input.onchange=()=>{changeParam(key,input.valueAsNumber/factor);syncParameters();notify();};
    range.oninput=()=>{
      const value=range.valueAsNumber;
      const raw=log?mapRange(key,value,true):value/factor;
      changeParam(key,Math.round(raw/step)*step,range);
    };
    range.onchange=()=>notify();
  }
  for(const button of root.querySelectorAll('[data-climate-options]')) button.onclick=()=>switchPanel(button.dataset.climateOptions);
  for(const button of root.querySelectorAll('[data-climate-layer]')) button.onclick=()=>{setLayer(button.dataset.climateLayer);notify();};
  $('site').onchange=event=>{
    const site=SITES.find(item=>item[0]===event.target.value);
    if(site) focusLocation(...site.slice(2));
    event.target.value='';
  };
  $('exit').onclick=()=>onExit?.();
  $('photo').hidden=!onCapture;
  $('photo').onclick=()=>{
    const frame=root.querySelector('[data-climate-canvas]');
    if (!frame?.width || !frame.height) return;
    const caption={ice:'Glace',temperature:'Température',insolation:'Ensoleillement',albedo:'Albédo',
      seaIce:'Banquise',landIce:'Glaces terrestres',cryosphere:'Banquise et glaciers'}[layer];
    onCapture?.(frame,name+' · '+caption+' · jour '+fine.format(current.day));
  };
  presetSelect.onchange=()=>applyPreset(presetSelect.value);
  $('play').onclick=()=>{
    if(playing||targetDay!==null) {stop();notify();}
    else playing=true;
    showClock();showExposure();
  };
  $('step').onclick=()=>advanceTarget(orbitalPeriod(model.options));
  $('simulate').onclick=()=>advanceTarget(currentDuration());
  $('apply-orbit').onclick=()=>{
    if(!workshopApply || $('apply-orbit').disabled) return;
    const result=workshopApply(model.options);
    setText('transfer-status',result?.ok?'Orbite appliquée.':result?.reason || 'Impossible de transférer cette orbite.');
  };
  $('reset').onclick=()=>{
    begin(startParams,{preset:lastPreset,planet:name,message:note,id:planetId});
    notify();
  };
  $('export').hidden=!onExport;$('export').onclick=()=>onExport?.();
  $('import-open').hidden=!onImport;$('import-open').onclick=()=>onImport?.();
  $('csv').onclick=()=>{
    const lines=['jour,temperature_moyenne_C,glace_fraction,bilan_W_m2,ensoleillement_moyen_W_m2,distance_UA,banquise_km2,glace_terrestre_Gt,niveau_marin_equivalent_m'];
    for(const item of samples) lines.push([item.day,item.meanTemperature,item.iceFraction,item.energyImbalance,item.meanInsolation,item.orbitalDistance,
      item.seaIceAreaKm2,item.groundedIceGt,item.seaLevelMeters].join(','));
    const url=URL.createObjectURL(new Blob([lines.join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='releves-climatiques.csv';
    root.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  };
  metric.onchange=chart;
  const chartObserver=new ResizeObserver(()=>{if(!root.hidden&&tab==='history') chart();});
  chartObserver.observe(canvas);
  // The application owns the animation clock as it does for the sandbox.
  begin(CLIMATE_DEFAULTS);
  setLayer('ice');
  function advanceClimate(days) {
    if(!cryosphere) return model.advance(days);
    const steps=Math.ceil(days/24), step=days/steps;
    let before=current;
    for(let index=0;index<steps;index++) {
      if(!model.advance(step)) return false;
      const after=model.measure();
      cryosphere.advance(before,after,step);
      before=after;
    }
    return true;
  }

  return {
    open({name:planet,params,snapshot,note:message,planetId:id,applyOrbit}={}) {
      if(snapshot) {
        if(!restore(snapshot)) return false;
      } else if(planet||params||message) {
        const validation=new ClimateModel();
        if(params && !validation.configure(params)) return false;
        workshopApply=typeof applyOrbit==='function'?applyOrbit:null;
        setText('transfer-status','');
        begin(validation.options,{planet:planet||baseName,message:message||'',preset:custom,id:id||'earth'});
      }
      root.hidden=false;
      globe.setLocation(...location,{center:true});
      refresh();
      return true;
    },
    close() {stop();workshopApply=null;notify();root.hidden=true;},
    tick(dt) {
      if(root.hidden || !(dt>0) || (!playing&&targetDay===null)) return;
      elapsed+=Math.min(dt,.2);
      if(playing) daysToAdvance+=Math.min(dt,.2)*Number($('rate').value);
      if(elapsed<.075 && targetDay===null) return;
      const requested=targetDay===null?daysToAdvance:Math.min(366,targetDay-current.day);
      const days=Math.min(366,requested);
      if(days>0 && !advanceClimate(days)) {stop();refresh();notify();return;}
      elapsed=0;daysToAdvance=0;
      const completed=targetDay!==null && model.measure().day>=targetDay-1e-7;
      if(completed) stop();
      refresh({sample:true});
      if(completed || current.day-persistedAt>=YEAR) {persistedAt=current.day;notify();}
    },
    serialize,
    dispose(){chartObserver.disconnect();comparison.dispose();orbit.dispose?.();globe.destroy();root.replaceChildren();}
  };
}
