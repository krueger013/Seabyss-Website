import { createInspiral, INSPIRAL_DEFAULTS } from './waves-model.js';

const keys=Object.keys(INSPIRAL_DEFAULTS);
const number=new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:4});
const scientific=new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:3,notation:'scientific'});
const metrics=[['duration','Durée simulée','s'],['cutoff','Dernière fréquence','Hz'],
  ['amplitude','Amplitude de h₊',''],['separation','Écart final des centres','km']];

function summarise(model) {
  if(!model) return null;
  const final=model.sample(model.duration);
  const projection=(1+Math.cos(model.inclination*Math.PI/180)**2)/2;
  return {duration:model.duration,cutoff:final.frequency,amplitude:final.amplitude*projection,separation:final.separationKm};
}

function display(value,unit) {
  const formatter=value!==0 && (Math.abs(value)<.001 || Math.abs(value)>=1e6)?scientific:number;
  return formatter.format(value)+(unit?' '+unit:'');
}

export function createWavesComparison(host,{getModel,onChange}={}) {
  host.classList.add('waves-comparison');
  host.innerHTML=`<div class="waves-compare-actions"><button type="button" data-waves-compare-freeze>Figer A</button>
    <button type="button" data-waves-compare-clear disabled>Effacer A</button></div>
    <p data-waves-compare-status role="status">Fige les réglages A, puis modifie le système B.</p>
    <section data-waves-compare-reading hidden><table aria-label="Comparaison des deux inspirales">
      <thead><tr><th scope="col">Mesure</th><th scope="col">État A</th><th scope="col">État B</th></tr></thead>
      <tbody>${metrics.map(([key,label])=>`<tr data-waves-compare-metric="${key}"><th scope="row">${label}</th>
        <td data-waves-compare-a></td><td data-waves-compare-b></td></tr>`).join('')}</tbody></table>
      <p data-waves-compare-ratio></p><p>Les deux relevés s’arrêtent à la limite de leur modèle d’inspirale.</p></section>`;
  const select=key=>host.querySelector('[data-waves-compare-'+key+']');
  const rows=new Map(Array.from(host.querySelectorAll('[data-waves-compare-metric]'),row=>[row.dataset.wavesCompareMetric,row]));
  let reference=null;

  function serialize() {return reference?{version:1,settings:{...reference.settings}}:null;}
  function update() {
    const current=getModel?.();
    const reading=select('reading');
    reading.hidden=!reference || !current;
    select('freeze').disabled=!current;
    select('clear').disabled=!reference;
    if(reading.hidden) return;
    const active=summarise(current);
    for(const [key,,unit] of metrics) {
      const row=rows.get(key), a=row.querySelector('[data-waves-compare-a]'), b=row.querySelector('[data-waves-compare-b]');
      a.textContent=display(reference.metrics[key],unit);a.dataset.value=String(reference.metrics[key]);
      b.textContent=display(active[key],unit);b.dataset.value=String(active[key]);
    }
    const ratio=active.amplitude/reference.metrics.amplitude;
    const output=select('ratio');
    output.textContent='Amplitude B par rapport à A · × '+display(ratio,'');
    output.dataset.value=String(ratio);
  }

  select('freeze').onclick=()=>{
    const active=getModel?.();
    if(!active) return;
    reference={settings:Object.fromEntries(keys.map(key=>[key,active[key]])),metrics:summarise(active)};
    select('status').textContent='État A figé · '+display(active.mass1,'M☉')+' + '+display(active.mass2,'M☉');
    update();onChange?.(serialize());
  };
  select('clear').onclick=()=>{
    reference=null;
    select('status').textContent='Référence effacée.';
    update();select('freeze').focus({preventScroll:true});onChange?.(serialize());
  };

  function restore(snapshot) {
    const settings=snapshot?.version===1?snapshot.settings:null;
    const model=settings && keys.every(key=>Number.isFinite(settings[key]))?createInspiral(settings):null;
    reference=model?{settings:Object.fromEntries(keys.map(key=>[key,model[key]])),metrics:summarise(model)}:null;
    select('status').textContent=reference?'État A restauré.':'Fige les réglages A, puis modifie le système B.';
    update();
    return snapshot==null || !!reference;
  }

  return {update,serialize,restore};
}
