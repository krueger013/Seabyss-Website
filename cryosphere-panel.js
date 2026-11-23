const number = new Intl.NumberFormat('fr-CA', {maximumFractionDigits:2});
const compact = new Intl.NumberFormat('fr-CA', {maximumFractionDigits:1});
const signed = new Intl.NumberFormat('fr-CA', {maximumFractionDigits:2,signDisplay:'exceptZero'});
const percent = new Intl.NumberFormat('fr-CA', {style:'percent',maximumFractionDigits:1});

const landmarks = [
  {id:'arctic',name:'Océan Arctique',latitude:86,longitude:0},
  {id:'greenland',name:'Intérieur du Groenland',latitude:72,longitude:-42},
  {id:'antarctica',name:'Intérieur de l’Antarctique',latitude:-82,longitude:88},
  {id:'weddell',name:'Mer de Weddell',latitude:-69,longitude:-40},
  {id:'levis',name:'Lévis',latitude:46.8118,longitude:-71.2048}
];

const reading = (label,key,help='') =>
  '<div><dt'+(help?' title="'+help+'"':'')+'>'+label+'</dt><dd data-cryosphere-'+key+'>–</dd></div>';
const coordinate = (degrees,negative,positive) => compact.format(Math.abs(degrees))+'° '+(degrees<0?negative:positive);
const withUnit = (value,unit,format=number) => Number.isFinite(value) ? format.format(value)+' '+unit : '–';
const coverage = (value) => Number.isFinite(value) ? percent.format(value) : '–';

function iceArea(area) {
  return area >= 1e6 ? withUnit(area/1e6,'M km²') : withUnit(area,'km²',compact);
}

function seaLevel(metres) {
  return Math.abs(metres) >= 1 ? withUnit(metres,'m',signed) : withUnit(metres*1000,'mm',signed);
}

function siteType(site) {
  if (site.landFraction >= .9) return 'Terre ferme';
  if (site.landFraction <= .1) return 'Océan';
  return 'Maille côtière';
}

function presetDuration(scenario) {
  if (Number.isFinite(scenario.days)) return compact.format(scenario.days)+' j';
  if (!Number.isFinite(scenario.years)) return '';
  return number.format(scenario.years)+(scenario.years>1?' orbites':' orbite');
}

/** Render the current geographic ice inventory without changing the model. */
export function createCryospherePanel(host,{onLayer,onSite,onPreset,scenarios=[]}={}) {
  host.classList.add('cryosphere-panel');
  host.innerHTML = '<h2>Glaces et océans</h2>' +
    '<dl class="cryosphere-readouts">' +
    reading('Banquise','sea-area','Surface de glace flottante') +
    reading('Glace à terre','land-mass','Masse de glace continentale, hors neige') +
    reading('Niveau marin','sea-level','Équivalent mondial dû aux glaces terrestres') +
    '</dl><div class="cryosphere-layers" aria-label="Choisir la glace sur le globe">' +
    '<button type="button" data-cryosphere-layer="seaIce" aria-pressed="false">Banquise</button>' +
    '<button type="button" data-cryosphere-layer="landIce" aria-pressed="false">Glaces terrestres</button>' +
    '<button type="button" data-cryosphere-layer="cryosphere" aria-pressed="false">Les deux</button>' +
    '</div><section class="cryosphere-site-card" aria-label="Sondage géographique">' +
    '<div class="cryosphere-site-head"><h3>Sondage</h3><select data-cryosphere-landmark aria-label="Choisir un repère sur le globe"></select></div>' +
    '<p class="cryosphere-site-position" data-cryosphere-site>Touche le globe pour sonder une région.</p>' +
    '<dl class="cryosphere-site-readouts" data-cryosphere-site-readouts hidden>' +
    reading('Glace sur l’eau','local-sea') + reading('Glace à terre','local-land') +
    reading('Neige sur terre','local-snow') + reading('Eau stockée dans la glace','local-depth') +
    '</dl></section><section class="cryosphere-scenarios" data-cryosphere-scenarios hidden>' +
    '<label for="cryosphere-choose-scenario">Expérience guidée</label><select id="cryosphere-choose-scenario" data-cryosphere-preset></select>' +
    '<p data-cryosphere-preset-hint hidden></p>' +
    '<button class="climate-primary" type="button" data-cryosphere-run-preset>Simuler</button></section>' +
    '<details class="cryosphere-method"><summary>Détail par région</summary><dl class="cryosphere-site-readouts">' +
    reading('Banquise au nord','north-area') + reading('Banquise au sud','south-area') +
    reading('Glace au Groenland','greenland-mass') + reading('Glace en Antarctique','antarctica-mass') +
    '</dl></details>' +
    '<details class="cryosphere-method"><summary>Comment lire ces mesures</summary>' +
    '<p>La banquise flotte sur l’océan. Sur les continents, la neige et la glace emmagasinent de l’eau. Leur fonte en restitue à l’océan.</p>' +
    '<p>Le niveau marin affiché traduit l’échange entre la glace à terre et les océans depuis l’état de départ. L’eau est répartie sur toute la surface océanique. Les lectures au globe sont des moyennes de la grille du modèle.</p>' +
    '<p><a href="https://sealevel.nasa.gov/faq/23/whats-the-difference-between-melting-sea-ice-and-melting-land-ice-on-sea-levels/" target="_blank" rel="noopener noreferrer">Banquise et glaciers · NASA</a></p>' +
    '</details>';

  const $ = key => host.querySelector('[data-cryosphere-'+key+']');
  const layerButtons = host.querySelectorAll('[data-cryosphere-layer]');
  const landmarkSelect = $('landmark');
  landmarkSelect.replaceChildren(new Option('Repères',''),...landmarks.map(site=>new Option(site.name,site.id)));
  landmarkSelect.hidden = typeof onSite !== 'function';
  landmarkSelect.onchange = () => {
    const site = landmarks.find(entry=>entry.id===landmarkSelect.value);
    if (site) onSite?.(site.latitude,site.longitude);
    landmarkSelect.value = '';
  };
  for (const button of layerButtons) {
    button.disabled = typeof onLayer !== 'function';
    button.onclick = () => onLayer?.(button.dataset.cryosphereLayer);
  }

  const presetSelect = $('preset'), presetButton = $('run-preset');
  const presetList = scenarios.filter(scenario=>typeof scenario?.id==='string' && typeof scenario.name==='string');
  $('scenarios').hidden = !onPreset || !presetList.length;
  presetSelect.replaceChildren(...presetList.map(item=>new Option(item.name,item.id)));
  const choosePreset = () => {
    const preset = presetList.find(item=>item.id===presetSelect.value);
    const guide = preset?.guide || preset?.description || '';
    const hint = $('preset-hint'), duration = preset ? presetDuration(preset) : '';
    hint.textContent = guide;hint.hidden = !guide;
    presetButton.disabled = !preset;
    presetButton.textContent = duration ? 'Simuler '+duration : 'Simuler';
    return preset;
  };
  presetSelect.onchange = choosePreset;
  presetButton.onclick = () => {
    const preset = choosePreset();
    if (preset) onPreset?.(preset.id);
  };
  choosePreset();

  function write(key,text,value) {
    const field = $(key);
    if (field.textContent !== text) field.textContent = text;
    if (Number.isFinite(value)) {
      const label = String(value);
      if (field.dataset.value !== label) field.dataset.value = label;
    } else if (field.dataset.value !== undefined) delete field.dataset.value;
  }

  function update(readings,site,activeLayer) {
    const {seaIceAreaKm2,groundedIceGt,seaLevelMeters,northSeaIceAreaKm2,southSeaIceAreaKm2,greenlandIceGt,antarcticaIceGt} = readings ?? {};
    write('sea-area',iceArea(seaIceAreaKm2),seaIceAreaKm2);
    write('land-mass',withUnit(groundedIceGt,'Gt',compact),groundedIceGt);
    write('sea-level',seaLevel(seaLevelMeters),seaLevelMeters);
    write('north-area',iceArea(northSeaIceAreaKm2),northSeaIceAreaKm2);
    write('south-area',iceArea(southSeaIceAreaKm2),southSeaIceAreaKm2);
    write('greenland-mass',withUnit(greenlandIceGt,'Gt',compact),greenlandIceGt);
    write('antarctica-mass',withUnit(antarcticaIceGt,'Gt',compact),antarcticaIceGt);
    for (const button of layerButtons) {
      const pressed = String(button.dataset.cryosphereLayer===activeLayer);
      if (button.getAttribute('aria-pressed')!==pressed) button.setAttribute('aria-pressed',pressed);
    }
    const validSite = site && Number.isFinite(site.latitude) && Number.isFinite(site.longitude) && Number.isFinite(site.landFraction);
    $('site-readouts').hidden = !validSite;
    if (!validSite) {
      write('site','Touche le globe pour sonder une région.');
      return;
    }
    const position = coordinate(site.latitude,'S','N')+' · '+coordinate(site.longitude,'O','E');
    write('site',siteType(site)+' · '+position);
    write('local-sea',site.landFraction < 1 ? coverage(site.seaIce) : '–',site.landFraction < 1 ? site.seaIce : undefined);
    write('local-land',site.landFraction > 0 ? coverage(site.landIce) : '–',site.landFraction > 0 ? site.landIce : undefined);
    write('local-snow',site.landFraction > 0 ? coverage(site.snow) : '–',site.landFraction > 0 ? site.snow : undefined);
    write('local-depth',site.landFraction > 0 ? withUnit(site.landIceMeters,'m éq. eau') : '–',site.landFraction > 0 ? site.landIceMeters : undefined);
  }

  return {update};
}
