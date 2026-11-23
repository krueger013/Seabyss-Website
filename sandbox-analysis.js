import { G } from './sandbox-physics.js';

const AU_KM = 149597870.7;
const KM_PER_SECOND = AU_KM/86400;
const STEFAN_BOLTZMANN = 5.670374419e-8;
const SUN_FLUX_AT_AU = 1361;
const RADIANS_TO_DEGREES = 180/Math.PI;
const HISTORY_LIMIT = 120;
const dot = (a,b) => a.reduce((sum,value,axis)=>sum+value*b[axis],0);
const difference = (a,b) => a.map((value,axis)=>value-b[axis]);
const cross = (a,b) => [
  a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]
];
const magnitude = values=>Math.hypot(...values);
const clamp = (value,low,high)=>Math.max(low,Math.min(high,value));

// XZ is the simulation reference plane. Its forward orbital normal is -Y.
// The instantaneous conic assumes two point masses at the measured state.
export function measureOrbit(body,reference) {
  if(!body || !reference || body===reference || body.id===reference.id) return null;
  const position=difference(body.position,reference.position);
  const velocity=difference(body.velocity,reference.velocity);
  const radius=magnitude(position), speed=magnitude(velocity);
  if(!(radius>0)) return null;
  const mu=G*(body.mass+reference.mass);
  const potential=mu/radius;
  const energy=speed**2/2-potential;
  const momentum=cross(position,velocity), h=magnitude(momentum);
  const eccentricity=magnitude(cross(velocity,momentum).map((value,axis)=>value/mu-position[axis]/radius));
  const p=h*h/mu, nearParabola=Math.abs(energy)<=1e-8*potential;
  const semiMajor=nearParabola ? null : -mu/(2*energy);
  const radial=h<=1e-9*radius*speed;
  const bound=energy<0&&!nearParabola;
  const kind=radial ? 'radial' : nearParabola ? 'parabolic' : bound ?
    eccentricity<1e-3?'circular':'elliptic' : 'hyperbolic';
  const periapsis=p/(1+eccentricity);
  const apoapsis=bound ? semiMajor*(1+eccentricity) : null;
  const periodDays=bound&&!radial ? Math.PI*2*semiMajor*Math.sqrt(semiMajor/mu) : null;
  const inclination=radial ? null : Math.acos(clamp(-momentum[1]/h,-1,1))*RADIANS_TO_DEGREES;
  const gap=radius-body.radius-reference.radius;
  return {
    kind,radius,speed,radialSpeed:dot(position,velocity)/radius,escapeSpeed:Math.sqrt(2*potential),
    energy,eccentricity,semiMajor,periapsis,apoapsis,periodDays,inclination,gap,
    crossesContact:periapsis<body.radius+reference.radius
  };
}

export function strongestReference(body,bodies,referenceId='') {
  const candidates=bodies.filter(other=>other.id!==body.id);
  let total=0, greatest=0, chosen=null, value=0;
  for(const candidate of candidates) {
    // Limit the diagnostic in an overlapping edit to the combined radius.
    const radius=Math.max(body.radius+candidate.radius,magnitude(difference(candidate.position,body.position)));
    const influence=candidate.mass/radius**2;
    total+=influence;
    if(candidate.id===referenceId || (!referenceId && influence>greatest)) {
      chosen=candidate;
      value=influence;
    }
    greatest=Math.max(greatest,influence);
  }
  return {body:chosen,influence:total?value/total:0};
}

export function measureStarlight(body,bodies) {
  if(!body || body.kind==='star') return null;
  let total=0, stars=0;
  for(const star of bodies) {
    if(star.kind!=='star') continue;
    const radius=Math.max(star.radius,magnitude(difference(star.position,body.position)));
    total+=SUN_FLUX_AT_AU*star.mass**3.5/radius**2;
    stars++;
  }
  return stars?{flux:total,stars}:null;
}

export function equilibriumTemperature(flux,albedo=.30) {
  if(!Number.isFinite(flux) || flux<0 || !Number.isFinite(albedo) || albedo<0 || albedo>1) return null;
  return (flux*(1-albedo)/(4*STEFAN_BOLTZMANN))**.25;
}

const orbitKinds={
  circular:'Quasi circulaire',elliptic:'Elliptique',parabolic:'Quasi parabolique',
  hyperbolic:'Hyperbolique',radial:'Trajectoire radiale'
};
const decimal=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});
const oneDecimal=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const fine=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:4});
const scientific=new Intl.NumberFormat('fr-CA',{notation:'scientific',maximumFractionDigits:2});
function quantity(value,format=decimal) {
  if(!Number.isFinite(value)) return '—';
  return (Math.abs(value)>=1e7 || (value!==0&&Math.abs(value)<.008)) ? scientific.format(value) : format.format(value);
}
const units = (value,suffix,format) => Number.isFinite(value)?quantity(value,format)+' '+suffix:'—';
function distance(value) {
  return value===null?'—':Math.abs(value)>=.1?units(value,'UA',fine):units(value*AU_KM,'km');
}
const speed=value=>units(value*KM_PER_SECOND,'km/s');
const metricTitles={
  distance:{title:'Distance au centre de référence',unit:'UA',color:'#9edcdc',format:distance},
  speed:{title:'Vitesse relative',unit:'km/s',color:'#ffbe8d',format:speed},
  thermal:{title:'Température d’équilibre',unit:'K',color:'#ffcfa6',format:value=>units(value,'K',oneDecimal)}
};

function setText(node,value) {
  if(node.textContent!==value) node.textContent=value;
}

function plot(canvas,history,metric,albedo) {
  const width=canvas.clientWidth,height=canvas.clientHeight;
  if(width<10||height<10) return;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)) {
    canvas.width=Math.round(width*dpr);
    canvas.height=Math.round(height*dpr);
  }
  const ctx=canvas.getContext('2d'), spec=metricTitles[metric];
  if(!ctx) return;
  const values=history.map(point=>({day:point.day,
    value:metric==='thermal'?equilibriumTemperature(point.flux,albedo):point[metric]
  })).filter(point=>Number.isFinite(point.value));
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,width,height);
  const left=8, top=12, right=width-8, bottom=height-22;
  ctx.strokeStyle='#4d697c66';
  ctx.lineWidth=1;
  for(let grid=0;grid<=3;grid++) {
    const y=top+(bottom-top)*grid/3;
    ctx.beginPath();
    ctx.moveTo(left,y);
    ctx.lineTo(right,y);
    ctx.stroke();
  }
  ctx.font='11px ui-monospace, monospace';
  ctx.fillStyle='#aebfca';
  if(!values.length) {
    ctx.textAlign='center';
    ctx.fillText('Aucune mesure pour cette courbe',width*.5,(top+bottom)*.5);
    canvas.setAttribute('aria-label',spec.title+' · aucune mesure');
    return;
  }
  const first=values[0],last=values.at(-1);
  const lowest=Math.min(...values.map(p=>p.value)),highest=Math.max(...values.map(p=>p.value));
  const pad=Math.max((highest-lowest)*.08,Math.abs(highest)*.0005,1e-11);
  const min=lowest-pad,max=highest+pad;
  const daySpan=Math.max(1e-12,last.day-first.day);
  const x=p=>values.length===1 ? left+(right-left)*.5 : left+(right-left)*(p.day-first.day)/daySpan;
  const y=p=>bottom-(bottom-top)*(p.value-min)/(max-min);
  ctx.beginPath();
  values.forEach((p,i)=>i===0?ctx.moveTo(x(p),y(p)):ctx.lineTo(x(p),y(p)));
  if(values.length>1) {
    ctx.lineTo(x(last),bottom);
    ctx.lineTo(x(first),bottom);
    ctx.closePath();
    const fade=ctx.createLinearGradient(0,top,0,bottom);
    fade.addColorStop(0,spec.color+'47');
    fade.addColorStop(1,spec.color+'06');
    ctx.fillStyle=fade;
    ctx.fill();
    ctx.beginPath();
    values.forEach((p,i)=>i===0?ctx.moveTo(x(p),y(p)):ctx.lineTo(x(p),y(p)));
    ctx.strokeStyle=spec.color;
    ctx.lineWidth=1.7;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x(last),y(last),3,0,2*Math.PI);
  ctx.fillStyle=spec.color;
  ctx.fill();
  ctx.fillStyle='#bccecf';
  ctx.textAlign='left';
  ctx.fillText('J '+quantity(first.day),left,height-5);
  if(values.length>1) {
    ctx.textAlign='right';
    ctx.fillText('J '+quantity(last.day),right,height-5);
  }
  canvas.setAttribute('aria-label',spec.title+' · de '+spec.format(lowest)+' à '+spec.format(highest));
}

export function createSandboxAnalysis(panel,{getWorld,getBody,onReference}) {
  const root=document.createElement('section');
  root.className='sandbox-analysis';
  root.innerHTML=`
    <div class="sb-analysis-control">
      <label>Référence de l’orbite <select data-sb-analysis-reference></select></label>
      <output class="sb-analysis-context" data-sb-analysis-context></output>
    </div>
    <section class="sb-analysis-sheet">
      <div class="sb-analysis-heading"><h3>Orbite instantanée</h3><strong data-sb-analysis-kind>—</strong></div>
      <dl class="sb-analysis-grid">
        <div><dt>Distance au centre</dt><dd data-sb-analysis-distance>—</dd></div>
        <div><dt>Vitesse relative</dt><dd data-sb-analysis-speed>—</dd></div>
        <div><dt>Péricentre</dt><dd data-sb-analysis-periapsis>—</dd></div>
        <div><dt>Apocentre</dt><dd data-sb-analysis-apoapsis>—</dd></div>
        <div><dt>Excentricité</dt><dd data-sb-analysis-eccentricity>—</dd></div>
        <div><dt>Inclinaison XZ</dt><dd data-sb-analysis-inclination>—</dd></div>
        <div><dt>Période estimée</dt><dd data-sb-analysis-period>—</dd></div>
        <div><dt>Vitesse de libération</dt><dd data-sb-analysis-escape>—</dd></div>
      </dl>
      <p class="sb-analysis-warning" data-sb-analysis-warning hidden>Le péricentre calculé franchit la limite de contact.</p>
    </section>
    <section class="sb-analysis-sheet sb-analysis-chart">
      <div class="sb-analysis-heading"><h3>Courbe de mesure</h3><output data-sb-analysis-points></output></div>
      <label class="sb-analysis-accessible" for="sb-analysis-metric">Mesure à tracer</label>
      <select id="sb-analysis-metric" data-sb-analysis-metric>
        <option value="distance">Distance</option><option value="speed">Vitesse relative</option><option value="thermal">Température d’équilibre</option>
      </select>
      <canvas data-sb-analysis-chart role="img" aria-label="Historique des mesures"></canvas>
      <p data-sb-analysis-chartnote>Les mesures s’ajoutent lorsque le temps avance.</p>
    </section>
    <section class="sb-analysis-sheet">
      <div class="sb-analysis-heading"><h3>Équilibre thermique</h3><strong data-sb-analysis-thermal>—</strong></div>
      <label class="sb-analysis-albedo">Albédo de Bond <output data-sb-analysis-albedo-value>30 %</output>
        <input type="range" min="0" max="100" step="1" value="30" data-sb-analysis-albedo>
      </label>
      <p data-sb-analysis-flux></p>
    </section>
    <details class="sb-analysis-notes">
      <summary>Modèles et sources</summary>
      <p>La conique osculatrice utilise l’état actuel de deux astres. La simulation à plusieurs corps continue de faire évoluer ces éléments. L’inclinaison est mesurée par rapport au plan XZ dans le sens des orbites préréglées.</p>
      <p>L’équilibre thermique suppose un rayonnement de corps noir et une redistribution uniforme de la chaleur. Les luminosités suivent l’approximation de séquence principale L ∝ M³·⁵. L’albédo règle uniquement cette mesure.</p>
      <ul>
        <li><a href="https://orbital-mechanics.space/classical-orbital-elements/orbital-elements-and-the-state-vector.html" target="_blank" rel="noopener noreferrer">Éléments orbitaux · Orbital Mechanics &amp; Astrodynamics</a></li>
        <li><a href="https://www.astro.princeton.edu/~anatoly/ast203/Lectures/Lecture_08.html" target="_blank" rel="noopener noreferrer">Équilibre radiatif · Université de Princeton</a></li>
        <li><a href="https://courses.ems.psu.edu/astro801/content/l7_p3.html" target="_blank" rel="noopener noreferrer">Luminosité et masse des étoiles · Penn State</a></li>
      </ul>
    </details>`;
  panel.append(root);
  const fields=new Map();
  function field(name) {
    if(!fields.has(name)) fields.set(name,root.querySelector('[data-sb-analysis-'+name+']'));
    return fields.get(name);
  }
  const reference=field('reference'),metric=field('metric'),albedo=field('albedo');
  const canvas=field('chart');
  const history=[];
  let worldKey,bodyKey,anchorKey,optionKey='',referenceId='',previousDay,plotDirty=true;
  function reset() {
    history.length=0;
    previousDay=undefined;
    plotDirty=true;
  }
  function setRow(key,value) { setText(field(key),value); }
  function drawChart() {
    if(!plotDirty) return;
    plotDirty=false;
    plot(canvas,history,metric.value,Number(albedo.value)/100);
  }
  function update() {
    const world=getWorld(),requested=getBody();
    const body=world?.bodies.find(item=>item.id===(typeof requested==='string'?requested:requested?.id));
    const key=JSON.stringify(body?world.bodies.filter(item=>item.id!==body.id).map(({id,name})=>[id,name]):[]);
    if(key!==optionKey) {
      optionKey=key;
      const options=JSON.parse(key);
      if(!options.some(([id])=>id===referenceId)) referenceId='';
      reference.replaceChildren(new Option('Attraction dominante',''),...options.map(([id,name])=>new Option(name,id)));
      reference.value=referenceId;
      reference.disabled=!options.length;
    }
    const anchor=body?strongestReference(body,world.bodies,referenceId):{body:null,influence:0};
    const orbit=measureOrbit(body,anchor.body), light=body?measureStarlight(body,world.bodies):null;
    if(world!==worldKey||body?.id!==bodyKey||anchor.body?.id!==anchorKey||world?.days<previousDay) reset();
    if(anchor.body?.id!==anchorKey) onReference?.(anchor.body?.id||'');
    worldKey=world;bodyKey=body?.id;anchorKey=anchor.body?.id;
    if((orbit||light) && Number.isFinite(world.days) && world.days!==previousDay) {
      history.push({day:world.days,distance:orbit?.radius??null,speed:orbit?.speed??null,flux:light?.flux??null});
      if(history.length>HISTORY_LIMIT) history.shift();
      previousDay=world.days;
      plotDirty=true;
    } else if(body && history.length) {
      // Edits while paused replace the latest value at the same instant.
      const latest=history.at(-1), flux=light?.flux??null;
      if(latest.distance!==(orbit?.radius??null)||latest.speed!==(orbit?.speed??null)||latest.flux!==flux) {
        Object.assign(latest,{distance:orbit?.radius??null,speed:orbit?.speed??null,flux});
        plotDirty=true;
      }
    }
    setRow('context',anchor.body?body.name+' / '+anchor.body.name+' · '+quantity(anchor.influence*100,oneDecimal)+' % des attractions':
      body?body.name+' · aucun astre de référence':'Sélectionne un astre.');
    setRow('kind',orbit?orbitKinds[orbit.kind]:'—');
    setRow('distance',orbit?distance(orbit.radius):'—');
    setRow('speed',orbit?speed(orbit.speed):'—');
    setRow('periapsis',orbit?distance(orbit.periapsis):'—');
    setRow('apoapsis',orbit?distance(orbit.apoapsis):'—');
    setRow('eccentricity',orbit?quantity(orbit.eccentricity,fine):'—');
    setRow('inclination',units(orbit?.inclination,'°',oneDecimal));
    setRow('period',units(orbit?.periodDays,'j'));
    setRow('escape',orbit?speed(orbit.escapeSpeed):'—');
    field('warning').hidden=!orbit?.crossesContact;
    setRow('points',String(history.length)+' / '+HISTORY_LIMIT);
    field('points').dataset.count=String(history.length);
    setRow('chartnote',history.length<2?'Les mesures s’ajoutent lorsque le temps avance.':
      'Les '+history.length+' dernières mesures dans ce repère.');
    const reflectance=Number(albedo.value);
    setRow('albedo-value',reflectance+' %');
    const temperature=equilibriumTemperature(light?.flux,reflectance/100);
    setRow('thermal',units(temperature,'K',oneDecimal));
    setRow('flux',light?units(temperature-273.15,'°C',oneDecimal)+' · '+units(light.flux,'W/m²')+' · '+light.stars+(light.stars===1?' étoile':' étoiles') :
      body?.kind==='star'?'Mesure de l’équilibre des corps éclairés.':'Aucune source stellaire dans le système.');
    drawChart();
  }
  reference.onchange=()=>{referenceId=reference.value;reset();update();};
  metric.onchange=()=>{plotDirty=true;drawChart();};
  albedo.oninput=()=>{plotDirty=true;update();};
  const observer=new ResizeObserver(()=>{plotDirty=true;drawChart();});
  observer.observe(canvas);
  update();
  return {update,reset,dispose(){observer.disconnect();root.remove();}};
}
