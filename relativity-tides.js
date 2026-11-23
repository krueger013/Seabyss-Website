import { radialTidalAcceleration } from './relativity-model.js';

const EARTH_GRAVITY=9.80665;
const decimal=new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:3});
const scientific=new Intl.NumberFormat('fr-CA',{notation:'scientific',maximumSignificantDigits:3});

function number(value) {
  if (!Number.isFinite(value)) return '—';
  return (value!==0 && (Math.abs(value)<.01 || Math.abs(value)>=1e5)?scientific:decimal).format(value);
}

export function createRelativityTides(host) {
  host.innerHTML=`<details class="relativity-tides"><summary>Forces de marée</summary>
    <label>Distance entre deux points<select data-relativity-tidal-length>
      <option value="2" selected>2 m</option><option value="10">10 m</option>
      <option value="100">100 m</option><option value="1000">1 km</option>
    </select></label>
    <dl class="relativity-tidal-readings"><div><dt>Écart d’accélération ici</dt><dd data-relativity-tidal-local>—</dd></div>
    <div><dt>À l’horizon de ce trou noir</dt><dd data-relativity-tidal-horizon>—</dd></div></dl>
    <p>Deux points en chute libre s’écartent dans la direction radiale. Le calcul local suppose une séparation petite devant le rayon.</p>
    <p data-relativity-tidal-note hidden>Réduis la séparation pour rester dans l’approximation locale.</p>
    </details>`;
  const length=host.querySelector('[data-relativity-tidal-length]');
  const local=host.querySelector('[data-relativity-tidal-local]');
  const horizon=host.querySelector('[data-relativity-tidal-horizon]');
  const warning=host.querySelector('[data-relativity-tidal-note]');
  let mass, radius;
  function show(element,value) {
    const label=value===null?'—':number(value)+' m/s² · '+number(value/EARTH_GRAVITY)+' g';
    if(element.textContent!==label) element.textContent=label;
    if(value!==null) element.dataset.value=String(value);
    else delete element.dataset.value;
  }
  function render() {
    const metres=Number(length.value);
    const here=radialTidalAcceleration(mass,radius,metres), edge=radialTidalAcceleration(mass,1,metres);
    warning.hidden=here!==null && edge!==null;
    show(local,here);show(horizon,edge);
  }
  length.onchange=render;
  return {update(massSolar,radiusRs){mass=massSolar;radius=radiusRs;render();}};
}
