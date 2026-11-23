const fields = [
  ['meanTemperature','Température','°C',1],
  ['iceFraction','Surface glacée','%',100],
  ['meanInsolation','Ensoleillement','W/m²',1],
  ['energyImbalance','Bilan d’énergie','W/m²',1]
];
const regionalFields = [
  ['seaIceAreaKm2','Banquise','M km²',1e-6],
  ['groundedIceGt','Glaces terrestres','milliers de Gt',1e-3],
  ['seaLevelMeters','Niveau marin équiv.','cm',100]
];
const comparisonFields = [...fields,...regionalFields];
const parameters = [
  ['semiMajorAxis','Demi-grand axe','UA',1],['eccentricity','Excentricité','',1],
  ['obliquity','Inclinaison','°',1],['solarLuminosity','Luminosité','L☉',1],
  ['perihelionLongitude','Longitude du périhélie','°',1],['co2','CO₂','ppm',1],
  ['pressure','Pression','bar',1],['water','Eau disponible','%',100],
  ['heatTransport','Transport thermique','W/m²/K',1],['iceAlbedo','Albédo de la glace','%',100],
  ['geothermalFlux','Chaleur interne','W/m²',1],['oceanMixingDepth','Profondeur océanique','m',1]
];
const layers = {
  temperature:{name:'Température',unit:'°C',scale:1},
  ice:{name:'Glace',unit:'%',scale:100}
};
const number = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1}).format;
const precise = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3}).format;
const signed = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1,signDisplay:'exceptZero'}).format;
const colors = {a:'#a2ebe1',b:'#ffc39a'};
const within = (value,min,max) => Number.isFinite(value) && value >= min && value <= max;
const measure = (value,unit) => Number.isFinite(value) ? number(value)+' '+unit : '—';
const latitudeName = value => value===0 ? 'Équateur' : number(Math.abs(value))+'° '+(value<0?'S':'N');

export function captureClimateComparisonState(reading,options={},name='',regional=reading) {
  if (!within(reading?.day,0,1e9) || !Array.isArray(reading.bands) || reading.bands.length<2 || reading.bands.length>256) return null;
  if (!within(reading.iceFraction,0,1) || fields.some(([key])=>!within(reading[key],-1e13,1e13))) return null;
  const bands=[];
  for (const band of reading.bands) {
    if (!within(band?.latitude,-90,90) || !within(band.temperature,-273.15,2400) || !within(band.ice,0,1) ||
      (bands.length && band.latitude<=bands.at(-1).latitude)) return null;
    bands.push({latitude:band.latitude,temperature:band.temperature,ice:band.ice});
  }
  const selectedOptions={};
  for (const [key] of parameters) {
    if (within(options?.[key],0,1e7)) selectedOptions[key]=options[key];
  }
  const regionalReadings=Object.fromEntries(regionalFields.filter(([key])=>within(regional?.[key],-1e13,1e13))
    .map(([key])=>[key,regional[key]]));
  return {name:typeof name==='string'?name.trim().slice(0,80):'',options:selectedOptions,...regionalReadings,
    day:reading.day,meanTemperature:reading.meanTemperature,iceFraction:reading.iceFraction,
    meanInsolation:reading.meanInsolation,energyImbalance:reading.energyImbalance,bands};
}

export function climateValueAtLatitude(state,latitude,layer) {
  if (!state || !Object.hasOwn(layers,layer) || !within(latitude,-90,90)) return null;
  const {bands}=state;
  if (latitude<=bands[0].latitude) return bands[0][layer];
  const index=bands.findIndex(band=>band.latitude>=latitude);
  if (index<0) return bands.at(-1)[layer];
  const {latitude:before,[layer]:a}=bands[index-1];
  const {latitude:after,[layer]:b}=bands[index];
  return a+(b-a)*(latitude-before)/(after-before);
}

function plotClimate(canvas,slots,layer,latitude) {
  const width=canvas.clientWidth,height=canvas.clientHeight;
  const ctx=canvas.getContext('2d');
  if (!ctx || width<100 || height<80) return;
  const scale=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
  ctx.setTransform(scale,0,0,scale,0,0);
  const active=Object.entries(slots).filter(([,value])=>value);
  if (!active.length) return;
  const {unit,scale:multiplier}=layers[layer];
  const range=active.flatMap(([,state])=>state.bands.map(band=>band[layer]));
  const [floor,ceiling]=layer==='ice' ? [0,1] : [Math.floor((Math.min(...range)-2)/10)*10,Math.ceil((Math.max(...range)+2)/10)*10];
  const inset={left:39,right:18,top:12,bottom:26};
  const graphWidth=width-inset.left-inset.right,graphHeight=height-inset.top-inset.bottom;
  const x=latitude=>inset.left+(latitude+90)/180*graphWidth;
  const y=value=>inset.top+(ceiling-value)/(ceiling-floor)*graphHeight;
  ctx.font='11px system-ui,sans-serif';ctx.textBaseline='middle';
  ctx.textAlign='right';ctx.fillStyle='#bacfd9';
  for(let i=0;i<=4;i++) {
    const value=floor+(ceiling-floor)*i/4,offset=y(value);
    ctx.strokeStyle='#354e64';ctx.lineWidth=1;ctx.beginPath();
    ctx.moveTo(inset.left,offset);ctx.lineTo(width-inset.right,offset);ctx.stroke();
    ctx.fillText(number(value*multiplier),inset.left-5,offset);
  }
  ctx.textAlign='center';
  for(const lat of [-90,-45,0,45,90]) {
    ctx.strokeStyle='#223b52';ctx.beginPath();ctx.moveTo(x(lat),inset.top);ctx.lineTo(x(lat),height-inset.bottom);ctx.stroke();
    ctx.fillText(lat===0?'0°':latitudeName(lat),x(lat),height-12);
  }
  const mark=x(latitude);
  ctx.strokeStyle='#d7e9f3';ctx.lineWidth=1;ctx.setLineDash([2,3]);
  ctx.beginPath();ctx.moveTo(mark,inset.top);ctx.lineTo(mark,height-inset.bottom);ctx.stroke();
  for(const [slot,state] of active) {
    ctx.strokeStyle=colors[slot];ctx.lineWidth=2;ctx.setLineDash(slot==='b'?[5,3]:[]);
    ctx.beginPath();
    for(let lat=-90;lat<=90;lat+=2) {
      const offset=y(climateValueAtLatitude(state,lat,layer));
      if(lat===-90)ctx.moveTo(x(lat),offset);else ctx.lineTo(x(lat),offset);
    }
    ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=colors[slot];ctx.beginPath();
    ctx.arc(mark,y(climateValueAtLatitude(state,latitude,layer)),2.5,0,Math.PI*2);ctx.fill();
  }
  canvas.setAttribute('aria-label','Profil par latitude · '+layers[layer].name+' en '+unit);
}

const slotsMarkup = ['a','b'].map(slot=>{
  const letter=slot.toUpperCase();
  return `<div class="climate-compare-slot" data-climate-compare-slot="${slot}">
    <div class="climate-compare-pin"><b>${letter}</b><span data-climate-compare-name>Aucun relevé</span></div>
    <small data-climate-compare-day hidden></small>
    <button type="button" data-climate-compare-capture="${slot}">Figer ${letter}</button>
  </div>`;
}).join('');

function comparisonRow([key,label]) {
  return `<tr data-climate-compare-metric="${key}"><th scope="row">${label}</th><td>—</td><td>—</td><td>—</td></tr>`;
}

export function createClimateComparison(host,{getMeasurement,getRegional,getOptions=()=>({}),getName=()=>'',onChange}={}) {
  host.classList.add('climate-compare');
  host.innerHTML=`<div class="climate-compare-slots">${slotsMarkup}</div>
    <p class="climate-compare-status" role="status" data-climate-compare-status></p>
    <p data-climate-compare-help>Fige A, change un réglage ou avance le temps, puis fige B.</p>
    <section class="climate-compare-results" data-climate-compare-ready="false" hidden>
      <div class="climate-compare-heading"><h3>Bilan global</h3><button type="button" data-climate-compare-clear>Effacer A et B</button></div>
      <table class="climate-compare-table" aria-label="Mesures globales des deux états"><thead><tr><th scope="col">Mesure</th><th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th></tr></thead>
        <tbody>${comparisonFields.map(comparisonRow).join('')}</tbody>
      </table>
      <div class="climate-compare-heading"><h3>Profil par latitude</h3><select data-climate-compare-layer aria-label="Mesure du profil par latitude"><option value="temperature">Température</option><option value="ice">Glace</option></select></div>
      <canvas class="climate-compare-chart" role="img" aria-label="Profil par latitude" data-climate-compare-chart></canvas>
      <label class="climate-compare-latitude"><span>Sonder la latitude <output data-climate-compare-latitude-name></output></span>
        <input type="range" min="-90" max="90" step="1" value="47" data-climate-compare-latitude></label>
      <dl class="climate-compare-reading"><div><dt>A</dt><dd data-climate-compare-reading="a">—</dd></div><div><dt>B</dt><dd data-climate-compare-reading="b">—</dd></div><div><dt>B − A</dt><dd data-climate-compare-reading="delta">—</dd></div></dl>
      <details class="climate-compare-options"><summary>Réglages modifiés</summary><p data-climate-compare-same hidden>Les réglages des deux états sont identiques.</p>
        <table class="climate-compare-table" aria-label="Différences entre les réglages" data-climate-compare-settings hidden><thead><tr><th scope="col">Réglage</th><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody></tbody></table>
      </details>
    </section>`;
  const $=selector=>host.querySelector(selector);
  const results=$('[data-climate-compare-ready]'),help=$('[data-climate-compare-help]');
  const status=$('[data-climate-compare-status]'),can=$('[data-climate-compare-chart]');
  const layerSelect=$('[data-climate-compare-layer]'),latitudeRange=$('[data-climate-compare-latitude]');
  const settings=$('[data-climate-compare-settings]'),same=$('[data-climate-compare-same]');
  const records=new Map(Array.from(host.querySelectorAll('[data-climate-compare-metric]'),row=>[
    row.dataset.climateCompareMetric,Array.from(row.querySelectorAll('td'))
  ]));
  const slots={a:null,b:null};
  let layer='temperature',latitude=47;

  function showLatitude() {
    const {unit,scale}=layers[layer];
    const a=climateValueAtLatitude(slots.a,latitude,layer),b=climateValueAtLatitude(slots.b,latitude,layer);
    const name=latitudeName(latitude);
    $('[data-climate-compare-latitude-name]').textContent=name;
    latitudeRange.setAttribute('aria-valuetext',name);
    $('[data-climate-compare-reading="a"]').textContent=measure(a===null?NaN:a*scale,unit);
    $('[data-climate-compare-reading="b"]').textContent=measure(b===null?NaN:b*scale,unit);
    $('[data-climate-compare-reading="delta"]').textContent=a===null || b===null ? '—' : signed((b-a)*scale)+(layer==='ice'?' pts':' '+unit);
    plotClimate(can,slots,layer,latitude);
  }

  function showSettings() {
    const changes=[];
    for (const [key,label,unit,scale] of parameters) {
      const a=slots.a?.options[key],b=slots.b?.options[key];
      if(a===b)continue;
      const row=host.ownerDocument.createElement('tr');
      const cells=[host.ownerDocument.createElement('th'),host.ownerDocument.createElement('td'),host.ownerDocument.createElement('td')];
      cells[0].scope='row';cells[0].textContent=label;
      for (const [index,value] of [[1,a],[2,b]]) cells[index].textContent=Number.isFinite(value)?precise(value*scale)+(unit?' '+unit:''):'—';
      row.append(...cells);changes.push(row);
    }
    settings.querySelector('tbody').replaceChildren(...changes);
    settings.hidden=changes.length===0;same.hidden=changes.length!==0;
  }

  function refresh() {
    for (const [slot,current] of Object.entries(slots)) {
      const element=$('[data-climate-compare-slot="'+slot+'"]');
      element.dataset.pinned=String(!!current);
      element.querySelector('[data-climate-compare-name]').textContent=current?(current.name||'Relevé climatique'):'Aucun relevé';
      const date=element.querySelector('[data-climate-compare-day]');
      date.hidden=!current;date.textContent=current?'Jour '+precise(current.day):'';
      const button=element.querySelector('button');
      button.textContent=(current?'Refaire ':'Figer ')+slot.toUpperCase();
    }
    const both=!!slots.a && !!slots.b;
    results.dataset.climateCompareReady=String(both);
    results.hidden=!slots.a && !slots.b;help.hidden=both;
    results.querySelector('.climate-compare-options').hidden=!both;
    for (const [key,,unit,scale] of comparisonFields) {
      const a=slots.a?.[key],b=slots.b?.[key];
      const [first,second,delta]=records.get(key);
      const paired=Number.isFinite(a) && Number.isFinite(b);
      first.closest('tr').hidden=!Number.isFinite(a) && !Number.isFinite(b);
      first.textContent=measure(a*scale,unit);second.textContent=measure(b*scale,unit);
      delta.textContent=paired?signed((b-a)*scale)+(key==='iceFraction'?' pts':' '+unit):'—';
      if(paired) delta.dataset.value=String((b-a)*scale);else delete delta.dataset.value;
    }
    if (!results.hidden) {showLatitude();if(both)showSettings();}
  }

  function serialize() {
    if (!slots.a && !slots.b) return null;
    return {version:1,a:slots.a?structuredClone(slots.a):null,b:slots.b?structuredClone(slots.b):null,layer,latitude};
  }

  function capture(slot) {
    if (!Object.hasOwn(slots,slot)) return false;
    const state=captureClimateComparisonState(getMeasurement?.(),getOptions(),getName(),getRegional?.());
    if (!state) return false;
    slots[slot]=state;
    refresh();status.textContent='État '+slot.toUpperCase()+' figé au jour '+precise(state.day)+'.';
    onChange?.(serialize());
    return true;
  }

  function resetSlots() {slots.a=null;slots.b=null;layer='temperature';latitude=47;}
  function clear(slot) {
    if (slot!==undefined && !Object.hasOwn(slots,slot)) return false;
    if(slot) slots[slot]=null;else resetSlots();
    layerSelect.value=layer;latitudeRange.value=latitude;
    refresh();status.textContent=slot?'État '+slot.toUpperCase()+' effacé.':'Les deux états ont été effacés.';
    onChange?.(serialize());
    return true;
  }

  function restore(snapshot) {
    if (snapshot===null || snapshot===undefined) resetSlots();
    else {
      if (snapshot?.version!==1 || (snapshot.a!==null && !snapshot.a) || (snapshot.b!==null && !snapshot.b)) return false;
      const a=snapshot.a&&captureClimateComparisonState(snapshot.a,snapshot.a.options,snapshot.a.name);
      const b=snapshot.b&&captureClimateComparisonState(snapshot.b,snapshot.b.options,snapshot.b.name);
      if ((snapshot.a && !a) || (snapshot.b && !b)) return false;
      slots.a=a;slots.b=b;
      layer=Object.hasOwn(layers,snapshot.layer)?snapshot.layer:'temperature';
      latitude=within(snapshot.latitude,-90,90)?Math.round(snapshot.latitude):47;
    }
    layerSelect.value=layer;latitudeRange.value=latitude;status.textContent='';
    refresh();
    return true;
  }

  for (const slot of ['a','b']) $('[data-climate-compare-capture="'+slot+'"]').onclick=()=>capture(slot);
  $('[data-climate-compare-clear]').onclick=()=>{
    clear();$('[data-climate-compare-capture="a"]').focus({preventScroll:true});
  };
  layerSelect.onchange=()=>{layer=layerSelect.value;showLatitude();onChange?.(serialize());};
  latitudeRange.oninput=()=>{latitude=latitudeRange.valueAsNumber;showLatitude();};
  latitudeRange.onchange=()=>onChange?.(serialize());
  const observer=new ResizeObserver(()=>{if (!results.hidden)plotClimate(can,slots,layer,latitude);});
  observer.observe(can);
  refresh();
  return {capture,clear,refresh,serialize,restore,dispose(){observer.disconnect();host.replaceChildren();}};
}
