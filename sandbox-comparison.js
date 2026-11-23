import { G } from './sandbox-physics.js';

// Same model units as the engine. https://ssd.jpl.nasa.gov/astro_par.html
const AU_METRES=149597870700;
const AU_KM=AU_METRES/1000;
const AU_PER_DAY_TO_KM_PER_SECOND=AU_KM/86400;
const SOLAR_KG=1.98847e30;
const ENERGY_J=SOLAR_KG*(AU_METRES/86400)**2;
const ANGULAR_MOMENTUM_SI=SOLAR_KG*AU_METRES**2/86400;
const SOLAR_TO_EARTH=332946;
const difference=(a,b)=>a.map((value,axis)=>value-b[axis]);
const cross=(a,b)=>[
  a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]
];

/** Copy only the state used for comparison. Capturing is independent of history. */
export function captureComparison(world,{label='',scope=''}={}) {
  if (!Number.isFinite(world?.days) || !Array.isArray(world.bodies)) return null;
  const bodies=world.bodies.map(({id,name,mass,position,velocity})=>Object.freeze({
    id,name,mass,position:Object.freeze(position.slice()),velocity:Object.freeze(velocity.slice())
  }));
  const mass=bodies.reduce((sum,body)=>sum+body.mass,0);
  const origin=bodies[0];
  const center=(field)=>Object.freeze(origin ? origin[field].map((value,axis)=>value+
    bodies.reduce((sum,body)=>sum+(body[field][axis]-value)*(body.mass/mass),0)) : [0,0,0]);
  const position=center('position'), velocity=center('velocity');
  const angular=[0,0,0];
  let kinetic=0,potential=0;
  for (let i=0;i<bodies.length;i++) {
    const body=bodies[i], relativeVelocity=difference(body.velocity,velocity);
    const bodyAngular=cross(difference(body.position,position),relativeVelocity);
    for (let axis=0;axis<3;axis++) angular[axis]+=body.mass*bodyAngular[axis];
    kinetic+=.5*body.mass*Math.hypot(...relativeVelocity)**2;
    for (let j=0;j<i;j++) {
      const other=bodies[j], separation=Math.hypot(...difference(body.position,other.position));
      // The point-mass potential is undefined for two bodies sharing a center.
      potential-=G*body.mass*other.mass/separation;
    }
  }
  const energy=(kinetic+potential)*ENERGY_J;
  return Object.freeze({day:world.days,bodyCount:bodies.length,mass,label,scope,position,velocity,
    energy:Number.isFinite(energy)?energy:null,angularMomentum:Math.hypot(...angular)*ANGULAR_MOMENTUM_SI,
    bodies:Object.freeze(bodies)});
}

export function compareBodies(a,b) {
  const sameScope=!a?.scope || !b?.scope || a.scope===b.scope;
  const rows=new Map();
  for (const body of a?.bodies ?? []) {
    const key=sameScope?body.id:'a/'+body.id;
    rows.set(key,{key,a:body,b:null});
  }
  for (const body of b?.bodies ?? []) {
    const key=sameScope?body.id:'b/'+body.id;
    const existing=rows.get(key);
    if (existing) existing.b=body;
    else rows.set(key,{key,a:null,b:body});
  }
  return [...rows.values()].map(row=>({...row,name:(row.b??row.a).name,
    status:row.a&&row.b?'common':row.b?'added':'removed'}));
}

export function measureComparedBody(snapshot,body,referenceId='') {
  if (!snapshot || !body) return null;
  const reference=referenceId?snapshot.bodies.find(entry=>entry.id===referenceId):snapshot;
  return {mass:body.mass,
    distance:reference?Math.hypot(...difference(body.position,reference.position)):null,
    speed:reference?Math.hypot(...difference(body.velocity,reference.velocity)):null};
}

const decimal=new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:4});
const scientific=new Intl.NumberFormat('fr-CA',{notation:'scientific',maximumSignificantDigits:4});
const date=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3});
const amount=(value)=> {
  if (!Number.isFinite(value)) return '—';
  const size=Math.abs(value);
  return (size>=1e5 || (size>0 && size<.001)?scientific:decimal).format(value);
};
const differenceLabel=value=>value>0?'+'+amount(value):amount(value);
const statusLabels={common:'Présents en A et B',added:'Ajoutés en B',removed:'Absents en B'};
const statuses=Object.keys(statusLabels);
const bodyOrder=new Intl.Collator('fr-CA',{numeric:true});

function metricTable() {
  return '<table class="sb-comparison-table"><thead><tr><th scope="col"><span class="sb-comparison-sr">Mesure</span></th>'+
    '<th scope="col">A</th><th scope="col">B</th></tr></thead><tbody></tbody></table>';
}

export function createSandboxComparison(panel,{getWorld,getScope=()=>'',getLabel=()=>''}) {
  const slots={a:null,b:null};
  let selected='',reference='';
  panel.classList.add('sandbox-comparison');
  panel.innerHTML='<div class="sb-comparison-pins">'+['a','b'].map(slot=>{
    const letter=slot.toUpperCase();
    return '<div class="sb-comparison-pin" data-sb-comparison-slot="'+slot+'">'+
      '<div class="sb-comparison-pin-heading"><b>'+letter+'</b><strong data-sb-comparison-time>À figer</strong></div>'+
      '<small data-sb-comparison-label hidden></small><button type="button" data-sb-comparison-pin="'+slot+'">Figer '+letter+'</button></div>';
  }).join('')+'</div><p data-sb-comparison-empty>Fige un instant. Avance, modifie le système ou reviens dans l’historique avant de figer le second.</p>'+
    '<p class="sb-comparison-sr" role="status" data-sb-comparison-status></p>'+
    '<section class="sb-comparison-card" data-sb-comparison-results hidden><div class="sb-comparison-heading">'+
    '<h3>Système</h3><button type="button" data-sb-comparison-clear>Effacer A et B</button></div>'+metricTable()+
    '<div class="sb-comparison-population" data-sb-comparison-population hidden><div class="sb-comparison-track" aria-hidden="true">'+
    statuses.map(status=>'<i data-comparison-change="'+status+'"></i>').join('')+'</div>'+
    '<ul>'+statuses.map(status=>'<li data-comparison-change="'+status+'"><strong>0</strong> '+statusLabels[status]+'</li>').join('')+'</ul></div></section>'+
    '<section class="sb-comparison-card" data-sb-comparison-detail hidden><div class="sb-comparison-heading"><h3>Par astre</h3></div>'+
    '<label>Astre<select data-sb-comparison-body></select></label><label>Repère de mesure<select data-sb-comparison-reference></select></label>'+
    '<p class="sb-comparison-presence" data-sb-comparison-presence></p>'+metricTable()+'</section>'+
    '<details class="sb-comparison-notes" data-sb-comparison-notes hidden><summary>Comment sont calculés les écarts ?</summary>'+
    '<p>Δ mesure B moins A. Les écarts sont calculés avant l’arrondi. La vitesse est relative au repère choisi et la distance est mesurée de centre à centre.</p>'+
    '<p>L’énergie inclut les mouvements relatifs au barycentre et l’attraction entre les astres. Le moment cinétique mesure leur rotation orbitale autour du barycentre. Les impacts et les modifications du système peuvent modifier ces valeurs.</p>'+
    '<p>Les astres sont appariés par identifiant de simulation. Les deux instantanés restent disponibles pendant cette session.</p>'+
    '<p><a href="https://openstax.org/books/university-physics-volume-1/pages/13-3-gravitational-potential-energy-and-total-energy" target="_blank" rel="noopener noreferrer">Énergie gravitationnelle · OpenStax</a></p></details>';
  const doc=panel.ownerDocument, $=selector=>panel.querySelector(selector);
  const system=$('[data-sb-comparison-results]'), detail=$('[data-sb-comparison-detail]');
  const empty=$('[data-sb-comparison-empty]'), population=$('[data-sb-comparison-population]');
  const bodiesSelect=$('[data-sb-comparison-body]'), referenceSelect=$('[data-sb-comparison-reference]');
  const status=$('[data-sb-comparison-status]');
  const makeOption=(text,value)=>{
    const option=doc.createElement('option');
    option.value=value;option.textContent=text;
    return option;
  };

  function appendMetric(tbody,key,label,a,b,{unit='',scale=1}={}) {
    const row=tbody.insertRow();
    row.dataset.sbComparisonMetric=key;
    const heading=doc.createElement('th');
    heading.scope='row';heading.textContent=label;
    if (unit) {
      const hint=doc.createElement('small');
      hint.textContent=unit;heading.append(hint);
    }
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const delta=doc.createElement('small');
      const change=(b-a)*scale;
      delta.className='sb-comparison-delta';
      delta.dataset.change=change===0?'steady':change>0?'up':'down';
      delta.textContent='Δ '+differenceLabel(change);
      heading.append(delta);
    }
    row.append(heading);
    row.insertCell().textContent=amount(Number.isFinite(a)?a*scale:null);
    row.insertCell().textContent=amount(Number.isFinite(b)?b*scale:null);
  }

  function massUnit(a,b) {
    return Math.max(a??0,b??0)>=.05?{unit:'M☉'}:{unit:'M⊕',scale:SOLAR_TO_EARTH};
  }

  function renderBody(rows) {
    const row=rows.find(entry=>entry.key===selected);
    if (!row) return;
    const a=measureComparedBody(slots.a,row.a,reference), b=measureComparedBody(slots.b,row.b,reference);
    const presence=$('[data-sb-comparison-presence]');
    presence.dataset.comparisonChange=row.status;
    if (!slots.a || !slots.b) presence.textContent=row.a?'Présent en A':'Présent en B';
    else if (row.status==='common') presence.textContent=row.a.name===row.b.name?'Présent en A et B':row.a.name+' → '+row.b.name;
    else presence.textContent=row.status==='added'?'Présent uniquement en B':'Présent uniquement en A';
    const tbody=detail.querySelector('tbody');
    tbody.replaceChildren();
    const distanceUnit=Math.max(a?.distance??0,b?.distance??0)>=.1?{unit:'au'}:{unit:'km',scale:AU_KM};
    appendMetric(tbody,'body-mass','Masse',a?.mass,b?.mass,massUnit(a?.mass,b?.mass));
    appendMetric(tbody,'speed','Vitesse',a?.speed,b?.speed,{unit:'km/s',scale:AU_PER_DAY_TO_KM_PER_SECOND});
    appendMetric(tbody,'distance','Distance',a?.distance,b?.distance,distanceUnit);
  }

  function render() {
    const {a,b}=slots;
    for (const slot of ['a','b']) {
      const card=$('[data-sb-comparison-slot="'+slot+'"]'), snapshot=slots[slot];
      const label=card.querySelector('[data-sb-comparison-label]');
      card.dataset.pinned=String(!!snapshot);
      card.querySelector('[data-sb-comparison-time]').textContent=snapshot?'J + '+date.format(snapshot.day):'À figer';
      label.hidden=!snapshot?.label;
      label.textContent=snapshot?.label??'';
      card.querySelector('button').textContent=(snapshot?'Refaire ':'Figer ')+slot.toUpperCase();
    }
    empty.hidden=!!(a||b);
    system.hidden=!(a||b);
    population.hidden=!(a&&b);
    $('[data-sb-comparison-notes]').hidden=!(a||b);
    if (system.hidden) {
      detail.hidden=true;
      return;
    }
    const tbody=system.querySelector('tbody');
    tbody.replaceChildren();
    appendMetric(tbody,'time','Temps',a?.day,b?.day,{unit:'j'});
    appendMetric(tbody,'count','Astres',a?.bodyCount,b?.bodyCount);
    appendMetric(tbody,'mass','Masse',a?.mass,b?.mass,massUnit(a?.mass,b?.mass));
    appendMetric(tbody,'energy','Énergie',a?.energy,b?.energy,{unit:'J'});
    appendMetric(tbody,'angular','Moment cinétique',a?.angularMomentum,b?.angularMomentum,{unit:'kg·m²/s'});
    const rows=compareBodies(a,b).sort((first,second)=>bodyOrder.compare(first.name,second.name));
    detail.hidden=!rows.length;
    const groups={};
    for (const state of statuses) {
      const group=rows.filter(row=>row.status===state);
      groups[state]=group;
      population.querySelector('i[data-comparison-change="'+state+'"]').style.flexGrow=String(group.length);
      population.querySelector('li[data-comparison-change="'+state+'"] strong').textContent=group.length;
    }
    const references=a&&b?groups.common:rows;
    if (!references.some(row=>row.key===reference)) reference='';
    referenceSelect.replaceChildren(makeOption('Barycentre',''),...references.map(row=>makeOption(row.name,row.key)));
    referenceSelect.value=reference;
    const groupNodes=[];
    for (const state of statuses) {
      if (!groups[state].length) continue;
      const options=groups[state].map(row=>makeOption(row.name,row.key));
      if (!a || !b) groupNodes.push(...options);
      else {
        const group=doc.createElement('optgroup');
        group.label=statusLabels[state];group.append(...options);groupNodes.push(group);
      }
    }
    bodiesSelect.replaceChildren(...groupNodes);
    if (!rows.some(row=>row.key===selected)) selected=groups.common[0]?.key ?? rows[0]?.key ?? '';
    bodiesSelect.value=selected;
    renderBody(rows);
  }

  function pin(slot,world=getWorld(),label=getLabel(),scope=getScope()) {
    if (slot!=='a' && slot!=='b') return false;
    const snapshot=captureComparison(world,{label,scope});
    if (!snapshot) return false;
    slots[slot]=snapshot;
    render();
    status.textContent='Instant '+slot.toUpperCase()+' fixé au jour '+date.format(snapshot.day)+'.';
    return true;
  }

  function clear(slot) {
    if (slot!==undefined && slot!=='a' && slot!=='b') return false;
    if (slot!=='b') slots.a=null;
    if (slot!=='a') slots.b=null;
    render();
    status.textContent=slot?'Instant '+slot.toUpperCase()+' effacé.':'Les deux instantanés ont été effacés.';
    return true;
  }

  for (const slot of ['a','b']) $('[data-sb-comparison-pin="'+slot+'"]').onclick=()=>pin(slot);
  $('[data-sb-comparison-clear]').onclick=()=>{
    clear();
    $('[data-sb-comparison-pin="a"]').focus();
  };
  bodiesSelect.onchange=()=>{
    selected=bodiesSelect.value;
    renderBody(compareBodies(slots.a,slots.b));
  };
  referenceSelect.onchange=()=>{
    reference=referenceSelect.value;
    renderBody(compareBodies(slots.a,slots.b));
  };
  render();
  return {pin,clear,render};
}
