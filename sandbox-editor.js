import { G } from './sandbox-physics.js';

const AU_KM=149597870.7;
const SECONDS_PER_DAY=86400;
const SOLAR_KG=1.98847e30;
const EARTH_IN_SOLAR_MASSES=1/332946;
const EARTH_RADIUS_KM=6371;
const AXES=['X','Y','Z'];
const KINDS=[['star','Étoile'],['planet','Planète'],['moon','Lune'],['comet','Comète'],['asteroid','Astéroïde']];
const FIELDS={
  mass:{min:1e-20,max:1e12,label:'La masse',units:[['earth','Masse terrestre',EARTH_IN_SOLAR_MASSES],['solar','Masse solaire',1],['kg','kg',1/SOLAR_KG]]},
  radius:{min:1e-12,max:1e8,label:'Le rayon',units:[['km','km',1/AU_KM],['earth','Rayon terrestre',EARTH_RADIUS_KM/AU_KM],['au','UA',1]]},
  position:{min:-1e16,max:1e16,label:'La position',units:[['au','UA',1],['km','km',1/AU_KM]]},
  velocity:{min:-1e8,max:1e8,label:'La vitesse',units:[['kms','km/s',SECONDS_PER_DAY/AU_KM],['aud','UA/j',1]]}
};
const number=new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:5});
const exponent=new Intl.NumberFormat('fr-CA',{notation:'scientific',maximumSignificantDigits:5});
const format=value=>value && (Math.abs(value)<.01 || Math.abs(value)>=1e7) ? exponent.format(value) : number.format(value);

export function parseBodyEditorNumber(text) {
  const value=text.trim().replace('−','-').replace(',','.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return NaN;
  const number=Number(value);
  return Number.isFinite(number) ? number : NaN;
}

export function bodyMeasurements(mass,radius) {
  if (!(mass>0 && radius>0) || ![mass,radius].every(Number.isFinite)) return null;
  return {
    density:mass*SOLAR_KG/(4/3*Math.PI*(radius*AU_KM*1000)**3)/1000,
    escapeSpeed:Math.sqrt(2*G*mass/radius)*AU_KM/SECONDS_PER_DAY
  };
}

// A two-body periapsis state in the workshop's XZ reference plane.
// Other bodies take part in the ordinary N-body integration after applying.
export function makeOrbitalState(body,anchor,{periapsis,apoapsis,inclination,orientation,retrograde=false}) {
  if (!anchor || ![periapsis,apoapsis,inclination,orientation].every(Number.isFinite) ||
      periapsis<=body.radius+anchor.radius || apoapsis<periapsis ||
      inclination<0 || inclination>180 || orientation<0 || orientation>360) return null;
  const semiMajorAxis=(periapsis+apoapsis)/2;
  const speed=Math.sqrt(G*(body.mass+anchor.mass)*(2/periapsis-1/semiMajorAxis))*(retrograde?-1:1);
  const azimuth=orientation*Math.PI/180, tilt=inclination*Math.PI/180;
  const cos=Math.cos(azimuth), sin=Math.sin(azimuth);
  const radial=[cos,sin*Math.sin(tilt),sin*Math.cos(tilt)];
  const tangent=[-sin,cos*Math.sin(tilt),cos*Math.cos(tilt)];
  return {position:radial.map((value,i)=>anchor.position[i]+periapsis*value),
    velocity:tangent.map((value,i)=>anchor.velocity[i]+speed*value)};
}

function cleanColor(value) {
  return value.length===4 ? '#'+value.slice(1).split('').map(letter=>letter+letter).join('') : value;
}
function copyBody(body) {
  return {...body,position:body.position.slice(),velocity:body.velocity.slice()};
}
function measureField(field,title) {
  return '<div class="sbe-field"><label>'+title+'<input data-sb-editor-'+field+
    ' inputmode="decimal" type="text" autocomplete="off" spellcheck="false"></label>'+
    '<select data-sbe-unit="'+field+'" aria-label="Unité — '+title+'"></select></div>';
}
function vectorField(field,title) {
  return '<fieldset class="sbe-vector"><legend>'+title+'</legend><label class="sbe-vector-unit">Unité<select data-sbe-unit="'+field+'"></select></label>'+
    '<div class="sbe-axes">'+AXES.map(axis=>'<label aria-label="'+title+' '+axis+'">'+axis+
    '<input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-sbe-vector="'+field+
    '" data-axis="'+axis+'"></label>').join('')+'</div></fieldset>';
}

export function createBodyEditor(panel,{onApply,onCancel}={}) {
  const form=document.createElement('form');
  form.className='sb-editor';
  form.dataset.sbEditorForm='';
  form.hidden=true;
  form.innerHTML=
    '<div class="sbe-tabs" role="group" aria-label="Paramètres de l’astre">'+
    '<button type="button" data-sbe-tab="body">Astre</button>'+
    '<button type="button" data-sbe-tab="motion">Vecteurs</button>'+
    '<button type="button" data-sbe-tab="orbit">Orbite</button></div>'+
    '<section class="sbe-section" data-sbe-pane="body">'+
    '<label>Nom<input data-sb-editor-name type="text" maxlength="80" autocomplete="off"></label>'+
    '<div class="sbe-field sbe-kind"><label>Type<select data-sb-editor-kind></select></label>'+
    '<label>Couleur<input data-sb-editor-color type="color"></label></div>'+
    measureField('mass','Masse')+measureField('radius','Rayon')+
    '<dl class="sbe-derived"><div><dt>Densité</dt><dd data-sbe-density></dd></div>'+
    '<div><dt>Vitesse de libération</dt><dd data-sbe-escape></dd></div></dl></section>'+
    '<label class="sbe-reference" hidden>Référentiel<select data-sb-editor-reference></select></label>'+
    '<section class="sbe-section" data-sbe-pane="motion" hidden>'+
    vectorField('position','Position')+vectorField('velocity','Vitesse')+'</section>'+
    '<section class="sbe-section" data-sbe-pane="orbit" hidden>'+
    '<p class="sbe-hint">Départ au périastre. Les distances partent du centre de l’astre de référence.</p>'+
    '<div class="sbe-orbit-grid">'+
    '<label>Périastre (km)<input data-sbe-orbit="periapsis" type="text" inputmode="decimal"></label>'+
    '<label>Apoastre (km)<input data-sbe-orbit="apoapsis" type="text" inputmode="decimal"></label>'+
    '<label>Inclinaison (°)<input data-sbe-orbit="inclination" type="text" inputmode="decimal" value="0"></label>'+
    '<label>Orientation (°)<input data-sbe-orbit="orientation" type="text" inputmode="decimal" value="0"></label>'+
    '</div><label>Sens<select data-sbe-direction><option value="prograde">Prograde</option>'+
    '<option value="retrograde">Rétrograde</option></select></label>'+
    '<button type="button" data-sb-editor-orbit>Préparer les vecteurs</button>'+
    '<p class="sbe-hint" data-sbe-orbit-note>Plan XZ à 0°. Des astres voisins peuvent perturber cette orbite.</p>'+
    '</section><p class="sbe-status" data-sbe-prepared role="status" hidden>Orbite préparée. Applique les paramètres pour la lancer.</p>'+
    '<p class="sbe-error" data-sb-editor-error role="alert" hidden></p>'+
    '<div class="sbe-actions"><button type="button" data-sb-editor-cancel>Annuler</button>'+
    '<button class="sb-primary" type="submit" data-sb-editor-apply>Appliquer</button></div>';
  panel.append(form);
  const $=selector=>form.querySelector(selector);
  const kind=$('[data-sb-editor-kind]'),name=$('[data-sb-editor-name]'),color=$('[data-sb-editor-color]');
  const reference=$('[data-sb-editor-reference]'),error=$('[data-sb-editor-error]');
  const orbitButton=$('[data-sb-editor-orbit]');
  const prepared=$('[data-sbe-prepared]');
  const orbitInputs=[...form.querySelectorAll('[data-sbe-orbit]')];
  const tabs=[...form.querySelectorAll('[data-sbe-tab]')];
  const selectUnit=field=>$('[data-sbe-unit="'+field+'"]');
  const storage={};
  for (const [field,descriptor] of Object.entries(FIELDS)) {
    const inputs=field==='mass'||field==='radius'?[$('[data-sb-editor-'+field+']')]:
      [...form.querySelectorAll('[data-sbe-vector="'+field+'"]')];
    storage[field]={unit:descriptor.units[0][0],inputs,display:[]};
    for (const [id,label] of descriptor.units) selectUnit(field).add(new Option(label,id));
  }
  for (const [id,label] of KINDS) kind.add(new Option(label,id));
  let original=null,draft=null,neighbours=[],referenceId='';

  function report(message='') {
    error.hidden=!message;
    error.textContent=message;
    if(message) error.scrollIntoView({block:'nearest'});
  }
  function unit(field) {
    return FIELDS[field].units.find(([id])=>id===storage[field].unit)[2];
  }
  function referenceBody() {
    return neighbours.find(body=>body.id===referenceId);
  }
  function numberAt(field,position) {
    const entry=storage[field],input=entry.inputs[position];
    if (input.value===entry.display[position]) return Array.isArray(draft[field])?draft[field][position]:draft[field];
    const relative=field==='position'||field==='velocity';
    return parseBodyEditorNumber(input.value)*unit(field)+(relative?referenceBody()?.[field][position]??0:0);
  }
  function writeFields() {
    const basis=referenceBody();
    for (const [field,entry] of Object.entries(storage)) {
      const values=Array.isArray(draft[field])?draft[field]:[draft[field]];
      const offsets=basis?.[field];
      entry.display=values.map((value,i)=>String((value-(Array.isArray(offsets)?offsets[i]:0))/unit(field)));
      entry.inputs.forEach((input,i)=>{input.value=entry.display[i];});
      selectUnit(field).value=entry.unit;
    }
  }
  function updateMeasurements() {
    const readings=bodyMeasurements(numberAt('mass',0),numberAt('radius',0));
    $('[data-sbe-density]').textContent=readings?format(readings.density)+' g/cm³':'—';
    $('[data-sbe-escape]').textContent=readings?format(readings.escapeSpeed)+' km/s':'—';
  }
  function readDraft() {
    const result={...draft,name:name.value===draft.name?draft.name:name.value.trim(),kind:kind.value,color:color.value};
    if (!result.name) {report('Donne un nom à cet astre.');return null;}
    for (const [field,entry] of Object.entries(storage)) {
      const values=entry.inputs.map((_,i)=>numberAt(field,i));
      const {min,max,label}=FIELDS[field];
      if (values.some(value=>!Number.isFinite(value)||value<min||value>max)) {
        report(label+' doit rester dans les limites de la simulation. Utilise un nombre ou la notation 1e-6.');
        return null;
      }
      result[field]=values.length===1?values[0]:values;
    }
    if (result.color.toLowerCase()===cleanColor(original.color).toLowerCase()) result.color=original.color;
    return result;
  }
  function resetOrbitalFields() {
    const anchor=referenceBody();
    orbitButton.disabled=!anchor;
    if (!anchor) return;
    const rel=draft.position.map((value,i)=>value-anchor.position[i]);
    const distance=Math.max(Math.hypot(...rel),3*(draft.radius+anchor.radius))*AU_KM;
    orbitInputs[0].value=orbitInputs[1].value=String(Number(distance.toPrecision(8)));
  }
  function switchReference(next) {
    const result=readDraft();
    if (!result) {reference.value=referenceId;return false;}
    draft=result;
    referenceId=next;
    reference.value=next;
    writeFields();
    resetOrbitalFields();
    report();
    return true;
  }
  function selectPane(pane) {
    for (const button of tabs) button.setAttribute('aria-pressed',String(button.dataset.sbeTab===pane));
    for (const section of form.querySelectorAll('[data-sbe-pane]')) section.hidden=section.dataset.sbePane!==pane;
    reference.parentElement.hidden=pane==='body';
    if(pane==='orbit' && !referenceId && neighbours.length) {
      const primary=neighbours.reduce((best,body)=>body.mass>best.mass?body:best);
      switchReference(primary.id);
    }
  }
  function close() {
    form.hidden=true;
    original=null;
    draft=null;
  }
  for (const button of tabs) button.onclick=()=>selectPane(button.dataset.sbeTab);
  for (const field of Object.keys(storage)) {
    const input=selectUnit(field);
    input.onchange=()=>{
      const result=readDraft();
      if (!result) {input.value=storage[field].unit;return;}
      draft=result;
      storage[field].unit=input.value;
      writeFields();
      updateMeasurements();
      report();
    };
  }
  reference.onchange=()=>switchReference(reference.value);
  $('[data-sb-editor-mass]').oninput=$('[data-sb-editor-radius]').oninput=updateMeasurements;
  orbitButton.onclick=()=>{
    const candidate=readDraft();
    if(!candidate) return;
    const anchor=referenceBody();
    const orbit=Object.fromEntries(orbitInputs.map(input=>[input.dataset.sbeOrbit,parseBodyEditorNumber(input.value)]));
    orbit.periapsis/=AU_KM;
    orbit.apoapsis/=AU_KM;
    orbit.retrograde=$('[data-sbe-direction]').value==='retrograde';
    const place=makeOrbitalState(candidate,anchor,orbit);
    if(!place) {
      report('Choisis un astre de référence, un périastre au-delà des deux rayons et un apoastre au moins aussi éloigné.');
      return;
    }
    draft={...candidate,...place};
    writeFields();
    report();
    prepared.hidden=false;
    selectPane('motion');
  };
  $('[data-sb-editor-cancel]').onclick=()=>{close();onCancel?.();};
  form.onsubmit=event=>{
    event.preventDefault();
    if(!original)return;
    const candidate=readDraft();
    if(!candidate)return;
    const changes={};
    for (const field of ['name','kind','color','mass','radius','position','velocity']) {
      const prior=original[field],next=candidate[field];
      const equals=Array.isArray(prior)?prior.every((value,i)=>value===next[i]):prior===next;
      if(!equals) changes[field]=next;
    }
    if(!Object.keys(changes).length) {close();onCancel?.();return;}
    if(onApply?.(original.id,changes)) close();
    else report('Ces paramètres ne peuvent pas être appliqués à cet astre.');
  };
  return {
    open(body,bodies=[]) {
      if (!body) return false;
      original=copyBody(body);
      draft=copyBody(body);
      neighbours=bodies.filter(other=>other.id!==body.id).map(copyBody);
      referenceId='';
      reference.replaceChildren(new Option('Origine du système',''),...neighbours.map(other=>new Option(other.name,other.id)));
      name.value=body.name;
      kind.value=body.kind;
      color.value=cleanColor(body.color);
      storage.mass.unit=body.mass>=.05?'solar':'earth';
      storage.radius.unit='km';
      storage.position.unit='au';
      storage.velocity.unit='kms';
      orbitInputs[2].value=orbitInputs[3].value='0';
      $('[data-sbe-direction]').value='prograde';
      prepared.hidden=true;
      form.hidden=false;
      selectPane('body');
      writeFields();
      updateMeasurements();
      resetOrbitalFields();
      report();
      tabs[0].focus({preventScroll:true});
      return true;
    },
    close,
    isOpen:()=>!form.hidden,
    dispose:()=>form.remove()
  };
}
