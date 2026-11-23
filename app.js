import { AU, LIGHT_YEAR } from './catalog.js';
import { Navigation } from './navigation.js';
import { createVoyageIndicator } from './voyage-indicator.js';
import { UniverseRenderer, directionAtPixel } from './renderer.js';
import { createEarthOverflight, DEFAULT_OVERFLIGHT_ALTITUDE } from './earth-overflight.js';
import { createDoublePress } from './double-press.js';
import { SURFACE_MISSIONS } from './surface-missions.js';
import { experienceLinks, renderLandingChoices } from './experiences.js';
import { hasObservation, openObservations, observationCredits } from './observations.js';
import { createExpeditions } from './expeditions.js';
import { assetUrl } from './assets.js';
import { enableCinema } from './cinema.js';
import { OrbitalSimulation, TIME_RATES } from './simulation.js';
import { createSystemView } from './system-view.js';
import { isTransitPlanet } from './transit-targets.js';
import { createSimulationControls } from './simulation-controls.js';

const $ = selector => document.querySelector(selector);
const sim = new OrbitalSimulation();
const objects = sim.objects;
const nav = new Navigation(objects);
const syncVoyage = createVoyageIndicator($('.stage-heading'));
const canvas = $('#space');
const dialog = $('#overlay');
const dialogBody = $('#dialog-body');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
sim.setPaused(motionPreference.matches);
motionPreference.addEventListener('change', event => {
  if (event.matches) { sim.setPaused(true); nav.finishTravel(); updateTelemetry(); }
});
const featureIds = ['earth', 'moon', 'saturn', 'proxima', 'milky-way', 'andromeda'];
const bookmarksKey = 'seabyss-universe.positions.v1';
const symbols = {
  earth:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>',
  climate:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M7 6.5c2 1.2 8 1.2 10 0m-10 11c2-1.2 8-1.2 10 0M12 3c4 3 4 15 0 18-4-3-4-15 0-18z"/>',
  terrain:'<path d="M3 19h18M4 16l5-7 4 4 3-5 4 8M12 2v6m-2.5-2.5L12 8l2.5-2.5"/>',
  eclipse:'<circle cx="12" cy="12" r="7"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.6 1.6m10.8 10.8L19 19M5 19l1.6-1.6M19 5l-1.6 1.6"/>',
  fragments:'<path d="m4 14 1-5 7-2 4 4-3 7-5 2zM15 4l3 2 2-2m0 6 1 3m-2 5 2 2"/>',
  gravity:'<path d="M2.5 17.5c2.8 3.7 7.7 1.6 12.2-2.8S21.8 5.4 19 3.7M4 7h6m-3-3v6"/><circle cx="13" cy="11" r="4.1"/><circle cx="20.4" cy="15.6" r="1.4"/>',
  waves:'<path d="M2.5 12h3l2-3 2.5 6 2.4-9 2.4 12 2.4-10 1.8 4h2.5"/>',
  photo:'<rect x="2.5" y="6.5" width="19" height="14" rx="2"/><path d="m6.5 6.5 2-3h7l2 3"/><circle cx="12" cy="13" r="3.7"/>',
  system:'<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="5.5" transform="rotate(-28 12 12)"/><circle cx="20" cy="7.5" r="1.6" fill="currentColor"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  orbit:'<ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-38 12 12)"/><circle cx="12" cy="12" r="6"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/>',
  book:'<path d="M4 4.5c3.5-1 5.9-.6 8 1.3 2.1-1.9 4.5-2.3 8-1.3V19c-3.1-.9-5.5-.4-8 1.1-2.5-1.5-4.9-2-8-1.1zM12 6v14"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.8 2.8 0 0 1 5.5.5c0 1.9-2.8 2.3-2.8 4.4m0 2.8h.1"/>',
  expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  navigate:'<path d="m20.7 3.3-6.2 17.4-3.7-7.5-7.5-3.7z"/>',
  bookmark:'<path d="M6 3.5h12v17l-6-3.9-6 3.9z"/>',
  cinema:'<rect x="2" y="4.5" width="20" height="15" rx="2"/><path d="M2 8h20M2 16h20"/>',
  drag:'<path d="M7 9V7a5 5 0 0 1 10 0v7a5 5 0 0 1-10 0zM12 4v5"/>',
  focus:'<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/><circle cx="12" cy="12" r="3"/>',
  left:'<path d="m14.5 6-6 6 6 6"/>',right:'<path d="m9.5 6 6 6-6 6"/>',
  up:'<path d="m6 14.5 6-6 6 6"/>',down:'<path d="m6 9.5 6 6 6-6"/>',
  ascend:'<path d="M4 20h16M12 15V3m-5 5 5-5 5 5"/>',descend:'<path d="M4 20h16M12 3v12m-5-5 5 5 5-5"/>',
  minus:'<path d="M5 12h14"/>',plus:'<path d="M5 12h14M12 5v14"/>',
  'arrow-up-right':'<path d="M6 18 18 6M7 6h11v11"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
};
function icons(scope = document) {
  for (const node of scope.querySelectorAll('i[data-icon]:empty')) {
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = '<svg viewBox="0 0 24 24" focusable="false">' + (symbols[node.dataset.icon] || '') + '</svg>';
  }
}
function icon(name) { return '<i data-icon="' + name + '"></i>'; }
const numeric = [0, 1, 2].map(digits => new Intl.NumberFormat('fr-CA', { maximumFractionDigits:digits }));
function measure(km) {
  if (km >= LIGHT_YEAR * 1e6) return numeric[2].format(km / (LIGHT_YEAR * 1e6)) + ' M al';
  if (km >= LIGHT_YEAR * .1) return numeric[km > LIGHT_YEAR * 100 ? 0 : 2].format(km / LIGHT_YEAR) + ' al';
  if (km > AU * .1) return numeric[2].format(km / AU) + ' UA';
  return numeric[km < 10 ? 2 : 0].format(km) + ' km';
}
function region(object) {
  if (object.simulated) return 'Simulation · ' + object.system;
  if (object.region) return object.region;
  if (object.kind === 'galaxy') return 'Espace intergalactique';
  if (object.id === 'proxima' || object.id.startsWith('alpha-cen-')) return 'Alpha Centauri';
  return object.kind === 'star' && object.id !== 'sun' ? 'Voie lactée' : 'Système solaire';
}
function setText(id, value) {
  const element = document.getElementById(id);
  if (element.textContent !== value) element.textContent = value;
}

const strip = $('#destination-strip');
const cinema = enableCinema(canvas, $('#enter-cinema'), $('#exit-cinema'), dialog, {nav, onStart:endOverflight});
for (const id of featureIds) {
  const object = objects.find(item => item.id === id);
  const card = document.createElement('button');
  card.type = 'button';
  card.dataset.id = id;
  card.className = 'destination-card';
  const thumb = document.createElement('img');
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.draggable = false;
  thumb.src = assetUrl('thumb-' + id.replace('milky-way', 'milkyway') + '.webp');
  const caption = document.createElement('span');
  caption.className = 'card-caption';
  const name = document.createElement('strong');
  name.textContent = object.name;
  const category = document.createElement('small');
  category.textContent = object.category;
  caption.append(name, category);
  const marker = document.createElement('span');
  marker.className = 'card-marker';
  marker.hidden = true;
  marker.setAttribute('aria-hidden', 'true');
  card.append(thumb, caption, marker);
  card.addEventListener('click', () => travel(id));
  strip.append(card);
}
let flying = false;
const expeditionHud = $('#expedition-hud');
const expeditions = createExpeditions({objects, travel, onChange: () => expeditions.renderHud(expeditionHud)});
let releaseChart;
let sandbox, climate, surface, landingFlight, overflight, landingRequest=0;
const sandboxIsOpen = () => !!sandbox && !$('#sandbox-workspace').hidden;
const climateIsOpen = () => !!climate && !$('#climate-lab').hidden;
const climateSaveKey = 'seabyss-universe.climate.v1';
let climateFromWorkshop=false;
const surfaceIsOpen = () => !!surface && surface.isOpen();
const landingIsOpen = () => !!landingFlight?.isOpen();
const canLand = id => Object.hasOwn(SURFACE_MISSIONS,id);
const pilotWorlds=['moon','mars','europa'];
function closeLanding() {
  if (!landingIsOpen()) return;
  landingFlight.close();
  document.body.classList.remove('landing-active');
}
async function openLanding(id) {
  if (!pilotWorlds.includes(id)) return;
  const request=++landingRequest;
  if (!landingFlight) {
    try {
      const {createLandingFlight}=await import('./landing-flight.js');
      if (request!==landingRequest) return;
      landingFlight=createLandingFlight($('#landing-workspace'),{
        onExit:exitLanding,onLanded:openSurface,announce,reducedMotion:()=>motionPreference.matches
      });
    } catch {
      if (request===landingRequest) announce('La descente n’a pas pu être chargée.');
      return;
    }
  }
  if (dialog.open) dialog.close();
  closeSurface();closeSandbox();closeClimate();closeAstrophysics();closeSystem();endOverflight();flight(false);
  nav.goTo(id,true);
  syncTarget();
  document.body.classList.add('landing-active');
  landingFlight.open(id);
  activateTab('explore-tab');
}
function exitLanding(id) {
  closeLanding();
  nav.goTo(pilotWorlds.includes(id)?id:nav.selectedId,true);
  syncTarget();
  $('#surface-open').focus({preventScroll:true});
}
function closeSurface() {
  landingRequest++;
  if (!surfaceIsOpen()) return;
  surface.close();
  document.body.classList.remove('surface-active');
}
function exitSurface(id) {
  closeSurface();
  if (canLand(id)) nav.goTo(id,true);
  syncTarget();
  activateTab('explore-tab');
  $('#surface-open').focus({preventScroll:true});
}
async function openSurface(id,spawn,regionId) {
  if (!canLand(id)) return;
  const request=++landingRequest;
  if (!surface) {
    const pending=document.createElement('p');
    pending.setAttribute('role','status');
    pending.className='landing-status';
    pending.textContent='Préparation du relief et du ciel…';
    if (dialog.open) dialogBody.prepend(pending);
    else announce(pending.textContent);
    try {
      const {createSurfaceWorkspace}=await import('./surface-workspace.js');
      if (request!==landingRequest) return;
      surface=createSurfaceWorkspace($('#surface-workspace'),{onExit:exitSurface,onCapture:openStudio,announce,reducedMotion:()=>motionPreference.matches});
    } catch {
      if (request===landingRequest) {
        if (pending.isConnected) {
          const error=pending.cloneNode();
          error.textContent='Le terrain a échoué à charger. Réessaie en choisissant un site.';
          pending.after(error);
        } else announce('Impossible de charger le terrain.');
      }
      return;
    } finally {
      pending.remove();
    }
  }
  if (dialog.open) dialog.close();
  closeLanding();closeSandbox();closeClimate();closeAstrophysics();closeSystem();endOverflight();flight(false);
  nav.goTo(id,true);
  syncTarget();
  document.body.classList.add('surface-active');
  if (!surface.open(id,spawn,regionId)) {
    document.body.classList.remove('surface-active');
    announce('Ce site est indisponible.');
    return;
  }
  activateTab('explore-tab');
}
$('#surface-open').onclick = () => openSurface(nav.selectedId);
function closeSandbox() {
  if (!sandboxIsOpen()) return;
  sandbox.close();
  document.body.classList.remove('sandbox-active');
}
async function openSandbox(id) {
  const request=++landingRequest;
  if (!sandbox) {
    try {
      const {createSandboxWorkspace}=await withPanelStyles('sandbox',import('./sandbox-workspace.js'));
      if (request!==landingRequest) return;
      sandbox=createSandboxWorkspace($('#sandbox-workspace'),{
        onExit:openSystem,onCapture:openStudio,onClimate:openClimateFromWorkshop,announce,reducedMotion:()=>motionPreference.matches
      });
    } catch {
      if (request===landingRequest) announce('L’atelier n’a pas pu être chargé.');
      return;
    }
  }
  if (dialog.open) dialog.close();
  closeLanding();endOverflight();
  closeSurface();closeClimate();closeAstrophysics();
  if (sandboxIsOpen()) {
    if (typeof id === 'string') sandbox.open(id);
    activateTab('sandbox-open');
    return;
  }
  closeSystem(); releaseControls(); nav.cancelTravel();
  if (flying) { flight(false); nav.goTo(nav.selectedId,true); }
  document.body.classList.add('sandbox-active');
  sandbox.open(typeof id === 'string' ? id : undefined);
  activateTab('sandbox-open');
}
$('#sandbox-open').onclick=openSandbox;
function storeClimate(snapshot) {
  if (!snapshot) return;
  try { localStorage.setItem(climateSaveKey,JSON.stringify(snapshot)); } catch {}
}
function savedClimate() {
  try { return JSON.parse(localStorage.getItem(climateSaveKey)); } catch { return null; }
}
function closeClimate() {
  if (!climateIsOpen()) return;
  climate.close();
  document.body.classList.remove('climate-active');
}
function exitClimate() {
  if (climateFromWorkshop) openSandbox();
  else { openSystem(); $('#climate-open').focus({preventScroll:true}); }
}
function openClimateFromWorkshop(setup,commitOrbit) {
  openClimate({name:setup.planetName,params:setup.options,note:setup.details,planetId:setup.planetId,applyOrbit:options=>{
    const result=commitOrbit(options);
    if (result.ok) {
      openSandbox();
      announce('Orbite appliquée. Tu peux revenir en arrière dans l’historique de l’Atelier.');
    }
    return result;
  }},true);
}
async function openClimate(setup,fromWorkshop=false) {
  const request=++landingRequest;
  if (!setup && climateIsOpen()) return;
  if (!climate) {
    try {
      const [{createClimateLab}, exchange]=await Promise.all([withPanelStyles('climate',import('./climate-lab.js')),import('./climate-exchange.js')]);
      if (request!==landingRequest) return;
      const picker=$('#climate-file');
      climate=createClimateLab($('#climate-lab'),{
        onExit:exitClimate,onChange:storeClimate,onCapture:openStudio,reducedMotion:()=>motionPreference.matches,
        onExport:()=>{
          const snapshot=climate.serialize();
          if (!snapshot) return;
          const url=URL.createObjectURL(new Blob([exchange.makeClimateFile(snapshot)],{type:'application/json'}));
          const link=document.createElement('a');
          link.href=url;link.download=exchange.climateFilename(snapshot.name);
          document.body.append(link);link.click();link.remove();
          setTimeout(()=>URL.revokeObjectURL(url),1500);
          announce('Expérience climatique exportée.');
        },
        onImport:()=>picker.click()
      });
      picker.onchange=async ()=>{
        const file=picker.files[0];picker.value='';
        if (!file) return;
        if (file.size>exchange.CLIMATE_FILE_LIMIT) {announce('Ce fichier dépasse '+exchange.CLIMATE_FILE_LIMIT/1024+' Ko.');return;}
        const loading=landingRequest;
        let snapshot;
        try { snapshot=exchange.readClimateFile(await file.text()); } catch {}
        if (!climateIsOpen() || loading!==landingRequest) return;
        if (!snapshot || !climate.open({snapshot})) {announce('Cette expérience climatique est illisible.');return;}
        storeClimate(climate.serialize());
        announce('Expérience climatique importée.');
      };
    } catch {
      if (request===landingRequest) announce('Le laboratoire climatique n’a pas pu être chargé.');
      return;
    }
  }
  if (dialog.open) dialog.close();
  closeLanding();closeSurface();closeSandbox();closeAstrophysics();closeSystem();endOverflight();
  releaseControls();nav.cancelTravel();
  if (flying) {flight(false);nav.goTo(nav.selectedId,true);}
  climateFromWorkshop=fromWorkshop;
  document.body.classList.add('climate-active');
  const snapshot=setup?null:savedClimate();
  if (!climate.open(setup ?? (snapshot?{snapshot}:{}))) climate.open();
  storeClimate(climate.serialize());
  activateTab('climate-open');
  $('#climate-lab [data-climate-exit]').focus({preventScroll:true});
}
$('#climate-open').onclick=()=>openClimate();
window.addEventListener('pagehide',()=>{if (climateIsOpen()) storeClimate(climate.serialize());});
$('#climate-lab').addEventListener('keydown',event=>{
  if(event.key!=='Escape' || event.defaultPrevented) return;
  event.preventDefault();exitClimate();
});
const loadedPanelStyles=new Map();
function loadPanelStyles(id) {
  if (loadedPanelStyles.has(id)) return loadedPanelStyles.get(id);
  const fragment=document.getElementById(id+'-styles').content.cloneNode(true);
  const elements=[...fragment.children];
  const waiting=elements.filter(el=>el.tagName==='LINK').map(el=>new Promise((resolve,reject)=>{
    el.onload=resolve;el.onerror=reject;
  }));
  document.head.append(fragment);
  const ready=Promise.all(waiting).catch(error=>{
    for(const el of elements) el.remove();
    loadedPanelStyles.delete(id);throw error;
  });
  loadedPanelStyles.set(id,ready);
  return ready;
}
function withPanelStyles(id,modulePromise) {
  return Promise.all([modulePromise,loadPanelStyles(id)]).then(([module])=>module);
}
function createAtlasLab(id,load,label,extra={}) {
  const root=$('#'+id+'-workspace'), key='seabyss-universe.'+id+'.v1', activeClass=id+'-active';
  let instance, returnTo;
  const isOpen=()=>!!instance&&!root.hidden;
  function saved() {try {return JSON.parse(localStorage.getItem(key));} catch {return null;}}
  function store(snapshot) {
    if (!snapshot) return;
    try {localStorage.setItem(key,JSON.stringify(snapshot));} catch {}
  }
  function close() {
    if (!isOpen()) return;
    instance.close();store(instance.serialize());document.body.classList.remove(activeClass);
  }
  function exit() {
    close();
    if (returnTo) returnTo(); else openAtlas('discover');
  }
  async function open(presetId,onReturn) {
    const request=++landingRequest;
    if (!instance) {
      try {
        const [create]=await Promise.all([load(),loadPanelStyles(id)]);
        if(request!==landingRequest) return;
        instance=create(root,{onExit:exit,onCapture:openStudio,onChange:store,notify:announce,
          reduceMotion:()=>motionPreference.matches,...extra});
      } catch {
        if(request===landingRequest) announce('Impossible de charger '+label+'.');
        return;
      }
    }
    if (dialog.open) dialog.close();
    closeLanding();closeSurface();closeSandbox();closeClimate();closeSystem();endOverflight();
    for (const lab of astrophysics) if (lab.close!==close) lab.close();
    releaseControls();nav.cancelTravel();
    if(flying) {flight(false);nav.goTo(nav.selectedId,true);}
    returnTo=onReturn;
    document.body.classList.add(activeClass);
    const restore=presetId?null:isOpen()?instance.serialize():saved();
    if (instance.open(presetId?{presetId}:restore?{snapshot:restore}:{})===false) instance.open();
    store(instance.serialize());
    activateTab('atlas-open');
    root.querySelector('[data-'+id+'-exit]')?.focus({preventScroll:true});
  }
  window.addEventListener('pagehide',()=>{if(isOpen()) store(instance.serialize());});
  const pause=()=>instance?.pause?.();
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&isOpen())pause();});
  return {isOpen,open,close,saved,pause,resume:()=>open(undefined,returnTo),tick:dt=>instance.tick(dt)};
}
const blackHoleLab=createAtlasLab('relativity',()=>import('./relativity-lab.js').then(module=>module.createRelativityLab),
  'le laboratoire des trous noirs',{onWaves:()=>openWaves(undefined,blackHoleLab.resume)});
const wavesLab=createAtlasLab('waves',()=>import('./waves-lab.js').then(module=>module.createWavesLab),
  'le laboratoire des ondes gravitationnelles');
const phaseLab=createAtlasLab('phase',()=>import('./phase-lab.js').then(m=>m.createPhaseLab),'l’observatoire des phases');
const travellerLab=createAtlasLab('traveller',()=>import('./traveller-lab.js').then(m=>m.createTravellerLab),'le suivi des comètes et des sondes');
const solarLab=createAtlasLab('solar',()=>import('./solar-observer.js').then(m=>m.createSolarObserver),'l’observation solaire');
const astrophysics=[blackHoleLab,wavesLab,phaseLab,travellerLab,solarLab];
const openRelativity=blackHoleLab.open, openWaves=wavesLab.open;
const activeAtlasLab=()=>astrophysics.find(lab=>lab.isOpen());
function closeAstrophysics() {for(const lab of astrophysics) lab.close();}
const systemView = createSystemView($('#system-view'), {
  objects,
  canTransit:id=>isTransitPlanet(sim.byId.get(id)),
  onTransit:id=>openAtlas('transits',id),
  getDays:()=>sim.days,
  onDiscover: () => openAtlas('discover'),
  getRotation: body => body.spinAngle,
  getRevision: () => sim.revision,
  orbitPath: (body, count) => sim.orbitPath(body, count, true),
  onObserve: id => travel(id),
  onExit: () => { closeSystem(); $('#system-open').focus({preventScroll:true}); }
});
const controls = createSimulationControls({
  sim, rates: TIME_RATES, systemView, dialogBody,
  openSandbox,
  showDialog: title => showDialog(title, systemView.isOpen() ? 'system-open' : 'explore-tab'),
  resetNavigation: () => { nav.syncSimulation(!flying); }
});
function activateTab(id) {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.id === id);
    if (item.id === id) item.setAttribute('aria-current','page');
    else item.removeAttribute('aria-current');
  }
}
function openSystem(id) {
  if (dialog.open) dialog.close();
  closeLanding();endOverflight();
  closeSurface();
  closeSandbox();closeClimate();closeAstrophysics();
  if (systemView.isOpen()) {
    if (typeof id==='string') systemView.open(id);
    return;
  }
  releaseControls();
  nav.cancelTravel();
  if (flying) { flight(false); nav.goTo(nav.selectedId,true); }
  document.body.classList.add('system-active');
  systemView.open(typeof id==='string'?id:nav.selectedId);
  controls.placeInSystem();
  activateTab('system-open');
}
function closeSystem() {
  if (!systemView.isOpen()) return;
  systemView.close();
  document.body.classList.remove('system-active');
  controls.leaveSystem();
  activateTab('explore-tab');
}
$('#system-open').onclick = () => openSystem();
$('#time-open').onclick = controls.openClock;
function syncTarget() {
  const object = nav.selected;
  expeditions.sync(object.id);
  setText('target-name', object.name);
  $('#target-name').classList.toggle('long-name', object.name.length > 7);
  setText('location', region(object));
  $('#object-dossier').setAttribute('aria-label','Fiche d’observation de '+object.name);
  setText('target-description', object.description);
  const solarTarget=object.id==='sun';
  const photoButton=$('#photo-open');
  photoButton.hidden = !solarTarget&&!hasObservation(object.id);
  const photoLabel=solarTarget?'Voir le Soleil observé par SDO':'Photographies de mission';
  photoButton.title=photoLabel;photoButton.setAttribute('aria-label',photoLabel);
  photoButton.querySelector('span').textContent=solarTarget?'Soleil observé':'Photos';
  $('#surface-open').hidden = !canLand(object.id);
  $('#surface-open').setAttribute('aria-label','Atterrir sur '+object.name);
  $('#earth-open').hidden = object.id!=='earth';
  setText('radius', measure(object.radius));
  $('#radius').previousElementSibling.textContent=object.radiusBasis==='field'?'Rayon du champ':'Rayon';
  setText('flight-name', object.name);
  for (const card of strip.children) {
    const selected = card.dataset.id === object.id;
    card.setAttribute('aria-pressed', String(selected));
    card.querySelector('.card-marker').hidden = !selected;
  }
  updateTelemetry();
}
function updateTelemetry() {
  syncVoyage(nav.route,nav.selected.name);
  setText('mode-status', nav.travelling ? 'Voyage en cours' : overflight ? 'Survol terrestre' : flying ? 'Vol libre' : 'Observation');
  const distance = measure(nav.distance);
  setText('distance', distance);
  if (flying) {
    setText('flight-distance', distance);
    setText('speed', measure(nav.speed) + '/s');
    if ($('#flight-velocity')) setText('flight-velocity', measure(nav.actualSpeed) + '/s');
  }
}
const pressed = new Set();
const held = new Map();
const pointers = new Map();
const doublePress = createDoublePress();
const sensitivityKey = 'seabyss-universe.sensitivity';
let sensitivity = 1;
try {
  const saved = Number(localStorage.getItem(sensitivityKey));
  if (saved >= .4 && saved <= 2.4) sensitivity = saved;
} catch { /* Storage may be unavailable on file URLs. */ }
let tapStart = null;
let locked = false;
let wheelRemainder = 0;
function releaseControls() {
  pressed.clear();
  held.clear();
  pointers.clear();
  tapStart = null;
  doublePress.reset();
  wheelRemainder = 0;
  nav.halt();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  document.querySelectorAll('.held').forEach(button => button.classList.remove('held'));
}
function flight(enabled) {
  releaseControls();
  flying = enabled;
  document.body.classList.toggle('flying', enabled);
  for (const selector of ['.flight-controls','.flight-hud','.reticle']) $(selector).hidden = !enabled;
  updateTelemetry();
}
function travel(id, observeSun=true) {
  if (dialog.open) dialog.close();
  closeLanding();endOverflight();
  closeSurface();
  closeSandbox();closeClimate();closeAstrophysics();
  closeSystem();
  flight(false);
  nav.goTo(id, motionPreference.matches);
  syncTarget();
  if (id==='sun' && observeSun) solarLab.open(undefined,()=>travel('sun',false));
}
$('#enter-flight').onclick = () => { endOverflight();nav.cancelTravel(); flight(true); canvas.focus({preventScroll:true}); };
$('#flight-exit').onclick = () => { travel(nav.selectedId); $('#enter-flight').focus({preventScroll:true}); };
$('#explore-tab').onclick = () => { if (dialog.open) dialog.close(); closeLanding();endOverflight();closeSurface(); closeSandbox();closeClimate();closeAstrophysics(); closeSystem(); activateTab('explore-tab'); if (flying) travel(nav.selectedId); };
$('#speed-up').onclick = () => { nav.changeSpeed(1); updateTelemetry(); };
$('#speed-down').onclick = () => { nav.changeSpeed(-1); updateTelemetry(); };
function applyBrake() {
  nav.cancelTravel();
  pressed.clear();
  held.clear();
  document.querySelectorAll('.held').forEach(button => button.classList.remove('held'));
  nav.brake();
}
const brakeButton = $('#flight-brake');
if (brakeButton) {
  brakeButton.onpointerdown = event => {
    if (event.button !== 0) return;
    applyBrake();
    brakeButton.setPointerCapture(event.pointerId);
    held.set(event.pointerId, 'brake');
    brakeButton.classList.add('held');
  };
  brakeButton.onlostpointercapture = event => {
    held.delete(event.pointerId);
    if (![...held.values()].includes('brake')) brakeButton.classList.remove('held');
  };
  brakeButton.onclick = event => { if (event.detail === 0) applyBrake(); };
}
for (const button of document.querySelectorAll('[data-move]')) {
  button.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    held.set(event.pointerId, button.dataset.move);
    button.classList.add('held');
  };
  button.onlostpointercapture = event => {
    held.delete(event.pointerId);
    if (![...held.values()].includes(button.dataset.move)) button.classList.remove('held');
  };
  // Keyboard and assistive-technology activation of a directional button moves one step.
  button.onclick = event => { if (event.detail === 0) { held.set('key', button.dataset.move); nav.update(.12, input()); held.delete('key'); updateTelemetry(); } };
}
function input() {
  const active = new Set([...pressed, ...held.values()]);
  const any = (...keys) => Number(keys.some(k => active.has(k)));
  return {
    forward:any('forward','w','z') - any('back','s'),
    right:any('right','d') - any('left','a','q'),
    up:any('up',' ','r') - any('down','control','f'), boost:active.has('shift'), brake:!!any('x','brake')
  };
}
function announce(message) {
  setText('toast', message);
  $('#toast').classList.add('visible');
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => $('#toast').classList.remove('visible'), 2100);
}
document.addEventListener('keydown', event => {
  if ((sandboxIsOpen() || climateIsOpen() || activeAtlasLab() || surfaceIsOpen() || landingIsOpen()) && !dialog.open) return;
  if (dialog.open || event.target.closest?.('input, textarea, select, [contenteditable="true"]') ||
      event.metaKey || event.altKey || (event.ctrlKey && event.key !== 'Control')) return;
  const key = event.key.toLowerCase();
  if (key === 'escape' && document.pointerLockElement === canvas) {
    event.preventDefault(); releaseControls(); return;
  }
  if (key === 'escape' && flying) { travel(nav.selectedId); $('#enter-flight').focus(); return; }
  if (key === '?') { openHelp(); return; }
  if (key==='p' && !systemView.isOpen()) {event.preventDefault();captureOrbit();return;}
  if (systemView.isOpen()) return;
  if (flying && key==='l') {event.preventDefault();togglePointerLock();return;}
  if (!flying) {
    if (event.target === canvas && key.startsWith('arrow')) {
      event.preventDefault();
      endOverflight();
      nav.orbit(key === 'arrowleft' ? -.07 : key === 'arrowright' ? .07 : 0, key === 'arrowup' ? .07 : key === 'arrowdown' ? -.07 : 0);
    } else if (event.target === canvas && ['+', '=', '-'].includes(key)) {
      event.preventDefault();
      endOverflight();
      nav.approach(key === '-' ? -1 : 1);
    }
    return;
  }
  if (key === 'x') {
    event.preventDefault();
    applyBrake();
    pressed.add('x');
    return;
  }
  if (key === '+' || key === '=' || key === '-') {
    event.preventDefault(); nav.changeSpeed(key === '-' ? -1 : 1); updateTelemetry(); return;
  }
  if (key === ' ' && event.target.closest('button')) return;
  if (['w','a','s','d','z','q','r','f','arrowup','arrowdown','arrowleft','arrowright','shift','control',' '].includes(key)) {
    event.preventDefault(); pressed.add(key);
  }
});
document.addEventListener('keyup', event => pressed.delete(event.key.toLowerCase()));
window.addEventListener('blur', releaseControls);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseControls(); });
window.screen.orientation?.addEventListener('change', releaseControls);
function turnGain() {
  return 2.3 * sensitivity / Math.max(280, Math.min(canvas.clientWidth, canvas.clientHeight));
}
document.addEventListener('pointerlockchange', () => {
  const wasLocked = locked;
  locked = document.pointerLockElement === canvas;
  $('#flight-lock').setAttribute('aria-pressed',String(locked));
  if (locked && (!flying || dialog.open || document.hidden)) {
    releaseControls();
    return;
  }
  if (wasLocked && !locked) releaseControls();
});
document.addEventListener('mousemove', event => {
  if (!locked || !flying || dialog.open || document.hidden) return;
  const gain = turnGain();
  nav.look(event.movementX * gain, -event.movementY * gain);
});
canvas.onpointerdown = event => {
  if (event.button !== 0 || locked || dialog.open) return;
  canvas.focus({preventScroll:true});
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, [event.clientX, event.clientY]);
  if (pointers.size===1) tapStart=[event.clientX,event.clientY];
  else {tapStart=null;doublePress.reset();}
};
canvas.onpointermove = event => {
  const from = pointers.get(event.pointerId);
  if (!from) return;
  const to = [event.clientX, event.clientY];
  if (tapStart && Math.hypot(to[0]-tapStart[0],to[1]-tapStart[1])>5) {tapStart=null;doublePress.reset();}
  pointers.set(event.pointerId, to);
  if (pointers.size > 1) {
    endOverflight();
    const other = [...pointers].find(([id]) => id !== event.pointerId)[1];
    const before = Math.hypot(from[0] - other[0], from[1] - other[1]);
    const after = Math.hypot(to[0] - other[0], to[1] - other[1]);
    if (before > 1 && after > 1) {
      const steps = Math.log(after / before) * 5;
      if (flying) nav.zoom(steps);
      else nav.approach(steps);
    }
  } else {
    if (tapStart) return;
    endOverflight();
    const gain = turnGain();
    const dx = (to[0] - from[0]) * gain, dy = (to[1] - from[1]) * gain;
    if (flying) nav.look(dx, -dy);
    else nav.orbit(dx, -dy);
  }
};
canvas.onpointerup = event => {
  if (tapStart && pointers.size===1 && doublePress.press(event)) moveToPoint(event);
  tapStart=null;
  pointers.delete(event.pointerId);
};
canvas.onlostpointercapture = event => {
  if (pointers.delete(event.pointerId)) doublePress.reset();
  tapStart=null;
};
function togglePointerLock() {
  if (locked) {releaseControls();return;}
  try {canvas.requestPointerLock()?.catch(()=>announce('La visée à la souris est indisponible.'));} catch {}
}
const pointerLockButton=$('#flight-lock');
pointerLockButton.hidden=!canvas.requestPointerLock || !matchMedia('(any-pointer:fine)').matches;
pointerLockButton.onclick=togglePointerLock;
function moveToPoint(event) {
  const box=canvas.getBoundingClientRect();
  const width=canvas.clientWidth,height=canvas.clientHeight;
  if (!width || !height) return;
  const x=event.clientX-box.left,y=event.clientY-box.top;
  const {view,centerX,centerY}=viewProjection(width,height);
  const direction=directionAtPixel(view,width,height,x,y,{centerX,centerY});
  endOverflight();
  const body=nav.bodyAlong(direction,2*Math.tan(view.fov/2)*6/height);
  if (body && body.id!==nav.selectedId) travel(body.id);
  else if (!nav.advanceToward(direction,motionPreference.matches)) return;
  const marker=$('#navigation-mark');
  marker.style.left=x+'px';marker.style.top=y+'px';marker.hidden=false;
  clearTimeout(moveToPoint.timer);
  moveToPoint.timer=setTimeout(()=>{marker.hidden=true;},740);
  updateTelemetry();
}
canvas.addEventListener('wheel', event => {
  if (event.ctrlKey) return;
  event.preventDefault();
  endOverflight();
  const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? canvas.clientHeight : 1;
  const steps = Math.max(-4, Math.min(4, -event.deltaY * unit / 96));
  if (flying) {
    if (Math.sign(steps) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
    wheelRemainder += steps;
    const whole = Math.trunc(wheelRemainder);
    nav.changeSpeed(whole);
    wheelRemainder -= whole;
  } else nav.approach(steps);
  updateTelemetry();
}, {passive:false});

function showDialog(title, activeId) {
  landingRequest++;
  activeAtlasLab()?.pause();
  releaseChart?.(); releaseChart = null;
  dialog.dataset.panel = activeId === 'atlas-open' ? 'atlas' : '';
  delete dialog.dataset.atlasView;
  releaseControls();
  setText('dialog-title', title);
  dialogBody.replaceChildren();
  activateTab(activeId);
  if (!dialog.open) dialog.showModal();
  dialogBody.scrollTop = 0;
}
dialog.addEventListener('close', () => {
  if (dialog.open) return;
  landingRequest++;
  releaseChart?.(); releaseChart = null;
  activateTab(activeAtlasLab() ? 'atlas-open' : climateIsOpen() ? 'climate-open' : sandboxIsOpen() ? 'sandbox-open' : systemView.isOpen() ? 'system-open' : 'explore-tab');
  controls.restoreToolbar();
  $('#toast').classList.remove('visible');
});
$('#close-dialog').onclick = () => dialog.close();
dialog.onclick = event => {
  if (event.target !== dialog) return;
  const r = dialog.getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
};
const fold = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'')
  .replaceAll('œ','oe').replaceAll('æ','ae').replaceAll('ε','epsilon').replaceAll('τ','tau').replace(/[^\p{L}\p{N}]/gu,'');
function renderDirectory(container) {
  container.innerHTML = '<div class="atlas-search-line"><label class="search-wrap">' + icon('search') + '<input type="search" aria-label="Rechercher un astre" placeholder="Rechercher un astre…" autocomplete="off"></label><select class="atlas-filter" aria-label="Catégorie"><option value="">Tous les astres</option><option value="planet">Planètes</option><option value="moon">Lunes</option><option value="star">Étoiles</option><option value="galaxy">Galaxies</option><option value="simulation">Simulations</option></select></div><p class="atlas-group-count" aria-live="polite"></p><div class="atlas-list"></div>';
  const list = container.querySelector('.atlas-list');
  const search = container.querySelector('input');
  const category = container.querySelector('select');
  category.add(new Option('Comètes et sondes','traveller'));
  category.add(new Option('Planètes naines','dwarf'));
  category.add(new Option('Astéroïdes','asteroid'));
  const tracked=[
    ['halley','1P/Halley','Comète périodique'],
    ['oumuamua','1I/ʻOumuamua','Objet interstellaire'],
    ['voyager-1','Voyager 1','Sonde interstellaire'],
    ['voyager-2','Voyager 2','Sonde interstellaire']
  ];
  category.add(new Option('Nébuleuses','nebula'),category.options.namedItem('simulation') || category.options[category.length-1]);
  category.add(new Option('Amas d’étoiles','cluster'),category.options[category.length-1]);
  function filter() {
    list.replaceChildren();
    const query = fold(search.value);
    for (const obj of objects) {
      const fit = category.value === 'simulation' ? obj.simulated : !category.value || obj.kind === category.value;
      if (!fit || !fold([obj.name,obj.category,obj.designation,obj.system || '',region(obj)].join(' ')).includes(query)) continue;
      const row = document.createElement('button');
      row.className = 'object-row';
      row.dataset.travel = obj.id;
      row.innerHTML = '<span class="object-symbol" style="--orb:' + obj.color + '"></span><span><strong>' + obj.name + '</strong><small>' + obj.category + ' · ' + obj.designation + '</small></span>' + icon('arrow-up-right');
      row.onclick = () => travel(obj.id);
      list.append(row);
    }
    if (!category.value || category.value==='traveller') {
      for (const [id,title,description] of tracked) {
        if(!fold([id,title,description].join(' ')).includes(query)) continue;
        const row=document.createElement('button');
        row.type='button';row.className='object-row';row.dataset.track=id;
        row.innerHTML='<span class="object-symbol" style="--orb:#a0d8d0"></span><span><strong>'+title+'</strong><small>'+description+'</small></span>'+icon('arrow-up-right');
        row.onclick=()=>travellerLab.open(id,()=>openAtlas('catalog'));
        list.append(row);
      }
    }
    const n = list.children.length;
    container.querySelector('.atlas-group-count').textContent = n + (n > 1 ? ' destinations' : ' destination');
    if (!n) {
      const empty=document.createElement('p'),reset=document.createElement('button');
      empty.className='empty-copy';empty.textContent='Aucun astre ne correspond à cette recherche.';
      reset.type='button';reset.className='chart-secondary';reset.textContent='Afficher tous les astres';
      reset.onclick=()=>{search.value='';category.value='';filter();search.focus();};
      list.append(empty,reset);
    }
    icons(dialogBody);
  }
  search.oninput = filter;
  category.onchange = filter;
  filter();
}
function openPhoto(id, fromGallery = false) {
  showDialog('Observatoire photographique',fromGallery ? 'atlas-open' : 'explore-tab');
  dialog.dataset.panel = 'photos';
  releaseChart = openObservations(dialogBody, {objects,initialId:id,
    onClose:() => { if (fromGallery) openAtlas('discover'); else dialog.close(); }});
}
function openAtlasModule(panel, ready, label) {
  const pending = document.createElement('p');
  pending.className='help-copy';
  pending.setAttribute('role','status');
  pending.textContent='Chargement '+label+'…';
  panel.append(pending);
  let dispose, active=true;
  ready.then(create=>{
    if (!active || !panel.isConnected) return;
    pending.remove();
    dispose=create(panel);
  }).catch(()=>{
    if (!active) return;
    pending.textContent='Le chargement '+label+' a échoué.';
    if (!pending.isConnected) panel.append(pending);
  });
  return () => {active=false;dispose?.();};
}
function cloneFrame(source) {
  const image=document.createElement('canvas');
  image.width=source.width;image.height=source.height;
  image.getContext('2d').drawImage(source,0,0);
  return image;
}
function openStudio(source,caption) {
  if (!source?.width || !source.height) return;
  showStudio(cloneFrame(source),caption);
}
function showStudio(photo,caption) {
  showDialog('Studio photo','explore-tab');
  dialog.dataset.panel='studio';
  releaseChart=openAtlasModule(dialogBody,withPanelStyles('studio',import('./photo-studio.js')).then(({createPhotoStudio})=>
    panel=>createPhotoStudio(panel,{capture:()=>photo,caption,onClose:()=>dialog.close()})),'du studio');
}
function openStudioGallery() {
  showDialog('Album d’exploration','journal-open');
  dialog.dataset.panel='studio';
  releaseChart=openAtlasModule(dialogBody,withPanelStyles('studio',import('./photo-studio.js')).then(({openPhotoGallery})=>
    panel=>openPhotoGallery(panel,{onClose:()=>dialog.close()})),'de l’album');
}
function openOverflight(latitude,longitude) {
  const route=createEarthOverflight(latitude,longitude);
  if (!route) return;
  if (dialog.open) dialog.close();
  closeLanding();closeSurface();closeSandbox();closeClimate();closeAstrophysics();closeSystem();flight(false);
  nav.goTo('earth',motionPreference.matches);
  overflight=route;
  delete $('#earth-overflight').dataset.altitude;
  $('#earth-overflight').hidden=false;
  $('#earth-overflight-altitude').value=String(DEFAULT_OVERFLIGHT_ALTITUDE);
  setSurveyLight(true);
  const coordinates=number=>numeric[2].format(Math.abs(number))+'°';
  setText('earth-overflight-location',coordinates(latitude)+(latitude<0?' S':' N')+' · '+coordinates(longitude)+(longitude<0?' O':' E'));
  document.body.classList.add('earth-overflight-active');
  activateTab('explore-tab');
  syncTarget();
}
function endOverflight() {
  if (!overflight) return;
  overflight=null;
  $('#earth-overflight').hidden=true;
  document.body.classList.remove('earth-overflight-active');
}
$('#earth-overflight-altitude').onchange=event=>overflight?.setAltitude(Number(event.target.value));
$('#earth-overflight-return').onclick=()=>openAtlas('earth');
const surveyLight=$('#earth-overflight-light');
function setSurveyLight(enabled) {
  surveyLight.setAttribute('aria-pressed',String(enabled));
  surveyLight.textContent=enabled?'Éclairage de carte':'Lumière simulée';
}
surveyLight.onclick=()=>setSurveyLight(surveyLight.getAttribute('aria-pressed')!=='true');
function openDossier() {
  const body = nav.selected;
  showDialog(body.name,'explore-tab');
  dialog.dataset.panel='dossier';
  const meta = document.createElement('p'); meta.className='dossier-meta';
  meta.textContent=[body.category,body.designation].filter(Boolean).join(' · ');
  const description = document.createElement('p'); description.className='help-copy'; description.textContent=body.description;
  const data = document.createElement('dl'); data.className='dossier-data';
  const solar = objects.find(o => o.id==='sun');
  const distanceFromSun = Math.hypot(...body.position.map((n,i) => n-solar.position[i]));
  const readings = [['Région',region(body)],[body.radiusBasis==='field'?'Rayon du champ illustré':'Rayon de référence',measure(body.radius)]];
  if (body.id !== 'sun') readings.push(['Distance au Soleil',measure(distanceFromSun)]);
  if (body.stellarNeighborhood) {
    const raMinutes=Math.round(body.raHours*60)%1440;
    readings.push(['Type spectral',body.spectralType],
      ['Ascension droite (J2000)',Math.floor(raMinutes/60)+' h '+String(raMinutes%60).padStart(2,'0')+' min'],
      ['Déclinaison (J2000)',numeric[2].format(body.decDegrees)+'°']);
  }
  if (body.orbitPeriodDays) readings.push(['Période orbitale',numeric[2].format(body.orbitPeriodDays)+' j']);
  if (body.rotationPeriodHours) readings.push(['Rotation',numeric[2].format(Math.abs(body.rotationPeriodHours))+' h'+(body.rotationPeriodHours<0?' · rétrograde':'')]);
  for (const [name,val] of readings) {
    const pair=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=name;dd.textContent=val;pair.append(dt,dd);data.append(pair);
  }
  dialogBody.append(meta,description,data);
  if (['earth','sun','moon','mercury','venus','mars','jupiter','saturn','uranus','neptune'].includes(body.id)) {
    const localSky=document.createElement('button');
    localSky.type='button';localSky.className='archive-entry';localSky.dataset.dossierEarthSky=body.id;
    localSky.textContent=body.id==='earth'?'Observer le ciel depuis la Terre':'Repérer cet astre dans le ciel terrestre';
    localSky.onclick=()=>openEarthSky({targetId:body.id==='earth'?'moon':body.id});dialogBody.append(localSky);
  }
  const transitPlanet=isTransitPlanet(body)?body:body.kind==='star' && objects.find(p=>p.parentId===body.id && isTransitPlanet(p));
  if (transitPlanet) {
    const orbit=document.createElement('button'),transit=document.createElement('button');
    orbit.type=transit.type='button';orbit.className=transit.className='archive-entry';
    orbit.dataset.dossierSystem=body.id;orbit.textContent='Explorer ce système planétaire';
    orbit.onclick=()=>openSystem(body.id);
    transit.dataset.dossierTransit=transitPlanet.id;transit.textContent='Observer le transit de '+transitPlanet.name;
    transit.onclick=()=>openAtlas('transits',transitPlanet.id);
    dialogBody.append(orbit,transit);
  }
  if (!body.simulated) {
    const ruler=document.createElement('details'), heading=document.createElement('summary'), host=document.createElement('div');
    ruler.dataset.lightRuler='';
    heading.className='archive-entry';
    heading.textContent='Mesurer un trajet de lumière';
    ruler.append(heading,host);dialogBody.append(ruler);
    ruler.ontoggle=()=>{
      if (!ruler.open || !ruler.isConnected || host.childElementCount) return;
      const ready=Promise.all([import('./light-ruler.js'),loadPanelStyles('light')])
        .then(([module])=>container=>module.createLightRuler(container,{objects,target:body,measure}));
      releaseChart=openAtlasModule(host,ready,'de la mesure de distance');
    };
    if (body.radiusBasis!=='field' && ['star','planet','moon','dwarf','asteroid'].includes(body.kind)) {
      const compare=document.createElement('button');
      compare.type='button';compare.className='archive-entry';compare.dataset.dossierCompare=body.id;
      compare.textContent='Comparer son diamètre';
      compare.onclick=()=>openAtlas('compare',body.id);dialogBody.append(compare);
    }
  }
  if(body.orbitPhaseIllustrative) {
    const note=document.createElement('p');note.className='help-copy';
    note.textContent='La phase de départ de cette orbite est illustrative.';dialogBody.append(note);
  }
  if(body.sourceUrl) {
    const source=document.createElement('a');source.className='archive-entry';source.target='_blank';source.rel='noopener noreferrer';
    source.href=body.sourceUrl;source.textContent='Consulter la fiche astronomique de référence';dialogBody.append(source);
  }
  if (body.stellarNeighborhood) {
    const notes=document.createElement('details'),summary=document.createElement('summary');
    summary.className='archive-entry';summary.textContent='Catalogue et méthode';
    const note=document.createElement('p');note.className='help-copy';
    note.textContent='La distance est déduite de la parallaxe. Les coordonnées donnent la direction à l’époque J2000. La surface stellaire est une illustration.';
    notes.append(summary,note);
    for (const [title,url] of [['Positions du catalogue RECONS',body.positionSourceUrl],['Parallaxes du catalogue des 10 parsecs',body.distanceSourceUrl]]) {
      const link=document.createElement('a');link.className='archive-entry';link.target='_blank';link.rel='noopener noreferrer';
      link.href=url;link.textContent=title;notes.append(link);
    }
    dialogBody.append(notes);
  }
  if(body.morphology==='remnant') {
    const launch=document.createElement('button');
    launch.type='button';launch.className='archive-entry';launch.dataset.dossierSupernova='';
    launch.textContent='Simuler l’expansion d’un rémanent';
    launch.onclick=()=>openAtlas('phenomena','supernova');dialogBody.append(launch);
  }
  if (['earth','moon','venus','mercury','mars','jupiter','io','europa','ganymede','callisto'].includes(body.id)) {
    const observer = body.id==='earth' ? 'moon' : 'earth';
    const observerName = observer==='moon' ? 'la Lune' : 'la Terre';
    const details = document.createElement('details');
    const heading = document.createElement('summary');
    const reading = document.createElement('p');
    heading.className='archive-entry';
    heading.textContent='Aspect actuel depuis '+observerName;
    reading.className='help-copy';
    details.dataset.phaseReading=body.id;
    details.append(heading,reading);
    const phasePreset={earth:'moon-earth',moon:'earth-moon',mercury:'earth-mercury',venus:'earth-venus',mars:'earth-mars',europa:'jupiter-europa',ganymede:'jupiter-ganymede',jupiter:'europa-jupiter'}[body.id];
    if (phasePreset) {
      const launch=document.createElement('button');
      launch.type='button';launch.className='archive-entry';launch.dataset.dossierPhase=phasePreset;
      launch.textContent='Ouvrir l’observatoire des phases';
      launch.onclick=()=>phaseLab.open(phasePreset,openDossier);
      dialogBody.append(launch);
    }
    dialogBody.append(details);
    details.ontoggle=async ()=>{
      if (!details.open) return;
      reading.textContent='Calcul des éphémérides…';
      try {
        const {phaseAt}=await import('./phase-model.js');
        if (!details.isConnected || !details.open) return;
        const date=new Date();
        const frame=phaseAt(observer,body.id,date);
        if (!frame) throw new Error();
        const minutes=frame.angularDiameterDeg*60;
        const diameter=minutes>=1 ? numeric[1].format(minutes)+'′' : numeric[1].format(minutes*60)+'″';
        reading.textContent=date.toLocaleString('fr-CA')+' · Disque éclairé à '+numeric[1].format(frame.illuminatedFraction*100)
          +' % · Diamètre apparent '+diameter+' · Distance entre les centres '+measure(frame.distanceKm)+'.';
      } catch { reading.textContent='Les éphémérides sont indisponibles pour cette observation.'; }
    };
  }
  if (body.id==='milky-way' || body.id==='m87') {
    const galacticCenter=document.createElement('button');
    galacticCenter.type='button';galacticCenter.className='archive-entry';galacticCenter.dataset.dossierRelativity='';
    const inMilkyWay=body.id==='milky-way';
    galacticCenter.innerHTML=icon('gravity')+(inMilkyWay?'Étudier Sagittarius A*':'Étudier M87*');
    galacticCenter.onclick=()=>openRelativity(inMilkyWay?'sagittarius-a':'m87-star',openDossier);
    dialogBody.append(galacticCenter);icons(galacticCenter);
  }
  if (body.observation) {
    const title=document.createElement('h3'), note=document.createElement('p');
    title.className='help-title';title.textContent='À observer';
    note.className='help-copy';note.textContent=body.observation;dialogBody.append(title,note);
  }
  if (hasObservation(body.id)) {
    const button=document.createElement('button');button.type='button';button.className='archive-entry';
    button.innerHTML=icon('photo')+'Photographies de mission';button.onclick=() => openPhoto(body.id);
    dialogBody.append(button);icons(button);
  }
  if (canLand(body.id)) {
    const button=document.createElement('button');
    button.type='button';button.className='archive-entry';button.dataset.dossierLand=body.id;
    button.innerHTML=icon('terrain')+'Explorer la surface';
    button.onclick=()=>openSurface(body.id);
    dialogBody.append(button);icons(button);
    const sites=document.createElement('button');
    sites.type='button';sites.className='archive-entry';
    sites.innerHTML=icon('grid')+'Voir les sites de '+body.name;
    sites.onclick=()=>openAtlas('surfaces',body.id);
    dialogBody.append(sites);icons(sites);
  }
  if (body.id==='earth') {
    const button=document.createElement('button');
    button.type='button';button.className='archive-entry';
    button.innerHTML=icon('earth')+'Explorer la Terre';
    button.onclick=()=>openAtlas('earth');
    dialogBody.append(button);icons(button);
    const climateEntry=document.createElement('button');
    climateEntry.type='button';climateEntry.className='archive-entry';climateEntry.dataset.dossierClimate='';
    climateEntry.innerHTML=icon('climate')+'Simuler le climat de la Terre';
    climateEntry.onclick=()=>openClimate({name:'Terre',planetId:'earth'});
    dialogBody.append(climateEntry);icons(climateEntry);
  }
}
$('#object-dossier').onclick=openDossier;
$('#photo-open').onclick = () => nav.selectedId==='sun' ? solarLab.open(undefined,()=>travel('sun',false)) : openPhoto(nav.selectedId);
$('#earth-open').onclick = () => openAtlas('earth');
function openEarthSky(observation={}) {openAtlas('earth-sky',undefined,undefined,observation);}
function openAtlas(first = 'catalog',initialWorld,initialImpact,observation={}) {
  showDialog('Atlas céleste','atlas-open');
  const tools = document.createElement('nav');
  tools.className = 'atlas-tools'; tools.setAttribute('aria-label','Vues de l’atlas');
  const panel = document.createElement('section');
  dialogBody.append(tools,panel);
  const sections = [
    ['discover','Découvrir', () => {
      const experiences=experienceLinks({surfaces:()=>open('surfaces'),pilot:()=>open('pilot'),phenomena:()=>open('phenomena'),events:()=>open('events'),
        sandbox:()=>openSandbox('shatter'),climate:()=>openClimate(),relativity:()=>openRelativity(),waves:()=>openWaves(),
        phase:()=>phaseLab.open(),traveller:()=>travellerLab.open(),solar:()=>solarLab.open()});
      releaseChart=openAtlasModule(panel,import('./deep-atlas.js').then(({createDeepAtlas})=>host=>{
        const dispose=createDeepAtlas(host,{objects,travel,experiences,
            openArchive:()=>openPhoto(nav.selectedId,true),openCompare:()=>openAtlas('compare'),
            openTransit:id=>openAtlas('transits',id),openEarthSky:()=>openAtlas('earth-sky')});
        icons(host);
        return dispose;
      }),'de la galerie');
    }],
    ['catalog','Répertoire', () => renderDirectory(panel)],
    ['transits','Transits', () => {
      const ready=Promise.all([import('./transit-workspace.js'),loadPanelStyles('transits')])
        .then(([module])=>host=>module.createTransitWorkspace(host,{objects,initialId:initialWorld || nav.selectedId,initialImpact,
          onVisit:id=>travel(id,false),onRecall:recallTransit,onObservation:openTransitObservation}));
      releaseChart=openAtlasModule(panel,ready,'des transits');
    }],
    ['compare','Comparer', () => {
      const ready=Promise.all([import('./size-comparison.js'),loadPanelStyles('compare')])
        .then(([module])=>host=>module.createSizeComparison(host,{objects,initialId:initialWorld || nav.selectedId,onVisit:id=>travel(id,false)}));
      releaseChart=openAtlasModule(panel,ready,'du comparateur');
    }],
    ['events','Cataclysmes', () => {
      releaseChart=openAtlasModule(panel,import('./cosmic-events.js').then(({renderCosmicEvents})=>host=>
        renderCosmicEvents(host,openSandbox,()=>openAtlas('phenomena','supernova'))),'des cataclysmes');
    }],
    ['sky','Planétarium', () => {
      releaseChart=openAtlasModule(panel,withPanelStyles('sky',import('./sky-observer.js')).then(({createSkyObserver})=>
        target=>createSkyObserver(target,{objects,travel,currentId:nav.selectedId,onEarthSky:()=>openEarthSky()})),'du planétarium');
    }],
    ['earth-sky','Ciel terrestre', () => {
      const ready=withPanelStyles('earth-sky',import('./earth-sky-workspace.js')).then(module=>host=>
        module.createEarthSkyWorkspace(host,{observation,onRecall:openEarthSky,
          onMap:(site,state)=>openAtlas('earth',undefined,undefined,{...state,site})}));
      releaseChart=openAtlasModule(panel,ready,'du ciel terrestre');
    }],
    ['surfaces','Surfaces', () => {
      const view=Promise.all([import('./surface-registry.js'),withPanelStyles('surface-atlas',import('./surface-atlas.js'))]).then(([registry,atlas])=>target=>{
        const worlds=Object.entries(SURFACE_MISSIONS).map(([id,mission])=>({
          id,name:mission.name,color:mission.color,canPilot:pilotWorlds.includes(id)
        }));
        return atlas.renderSurfaceExplorer(target,{worlds,sites:registry.surfaceSiteIndex(),
          progress:registry.surfaceProgress,land:(world,site)=>openSurface(world,undefined,site),
          pilot:openLanding,initialWorld});
      });
      releaseChart=openAtlasModule(panel,view,'des sites de surface');
    }],
    ['pilot','Pilotage', () => renderLandingChoices(panel,{worlds:pilotWorlds,start:openLanding})],
    ['earth','Terre', () => {
      releaseChart=openAtlasModule(panel,withPanelStyles('earth-atlas',import('./earth-explorer.js')).then(({createEarthExplorer})=>
        target=>createEarthExplorer(target,{initialSite:observation.site,onOrbit:openOverflight,
          onSky:site=>openEarthSky({...observation,site})})),'de la carte terrestre');
    }],
    ['phenomena','Phénomènes', () => {
      releaseChart=openAtlasModule(panel,withPanelStyles('phenomena',import('./phenomena.js')).then(({createPhenomena})=>host=>createPhenomena(host,{
        initialId:initialWorld==='supernova'?'supernova':undefined,
        onVisit:travel,
        onRelativity:()=>openRelativity(undefined,()=>openAtlas('phenomena','black-hole'))
      })),'de l’observatoire');
    }],
    ['map','Carte', () => {
      releaseChart=openAtlasModule(panel,import('./atlas-map.js').then(({createStarChart})=>host=>createStarChart(host,{objects,currentId:nav.selectedId,measure,travel})),'de la carte');
    }],
    ['routes','Itinéraires', () => expeditions.renderPanel(panel)]
  ];
  function open(id) {
    landingRequest++;
    releaseChart?.(); releaseChart = null;
    panel.replaceChildren();
    dialog.dataset.atlasView=id;
    setText('dialog-title',id==='surfaces'?'Sites de surface':'Atlas céleste');
    for (const button of tools.children) {
      const selected=button.dataset.atlasView===id;
      button.setAttribute('aria-pressed',String(selected));
      if (selected) {
        const outer=tools.getBoundingClientRect(), inner=button.getBoundingClientRect();
        if(inner.x<outer.x) tools.scrollLeft+=inner.x-outer.x;
        else if(inner.right>outer.right) tools.scrollLeft+=inner.right-outer.right;
      }
    }
    sections.find(item => item[0] === id)[2]();
    dialogBody.scrollTop = 0;
  }
  for (const [id,label] of sections) {
    const button = document.createElement('button');
    button.type='button'; button.dataset.atlasView=id; button.textContent=label; button.onclick=() => open(id);
    tools.append(button);
  }
  open(typeof first === 'string' && sections.some(item => item[0] === first) ? first : 'catalog');
}
$('#atlas-open').onclick = $('#atlas-all').onclick = openAtlas;
$('#surface-atlas-open').onclick=()=>openAtlas('surfaces',canLand(nav.selectedId)?nav.selectedId:undefined);
function readBookmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem(bookmarksKey) || '[]');
    return Array.isArray(saved) ? saved.filter(item => item && Number.isFinite(item.stamp) && objects.some(obj => obj.id === item.view?.selectedId)) : [];
  } catch { return []; }
}
let bookmarks = readBookmarks();
function storeBookmarks(next) {
  try {
    localStorage.setItem(bookmarksKey,JSON.stringify(next));
    bookmarks = next;
    return true;
  } catch { announce('Le stockage des positions est indisponible.'); return false; }
}
function savePosition() {
  const item = {stamp:Date.now(), view:nav.serialize(), flying};
  if (storeBookmarks([item, ...bookmarks])) announce('Position enregistrée dans le carnet');
}
$('#save-position').onclick = savePosition;
function recallTransit(entry) { openAtlas('transits',entry.planetId,entry.impact); }
function openTransitNotes() {
  showDialog('Mesures de transit','journal-open');
  const ready=Promise.all([import('./transit-notebook.js'),loadPanelStyles('transits')])
    .then(([module])=>host=>{
      const back=document.createElement('button');
      back.type='button';back.className='chart-secondary';back.textContent='Retour au carnet';back.onclick=openJournal;
      const list=document.createElement('div');host.append(back,list);
      return module.createTransitNotebook(list,{objects,onRecall:recallTransit}).dispose;
    });
  releaseChart=openAtlasModule(dialogBody,ready,'du carnet de mesures');
}
function openTransitObservation(id) {
  showDialog('Photométrie de HD 209458 b','atlas-open');
  const ready=Promise.all([import('./transit-observation.js'),loadPanelStyles('transits')])
    .then(([module])=>host=>module.createTransitObservation(host,{onReturn:()=>openAtlas('transits',id)}));
  releaseChart=openAtlasModule(dialogBody,ready,'de la photométrie');
}
function openEarthSkyNotes() {
  showDialog('Observations du ciel terrestre','journal-open');
  const ready=withPanelStyles('earth-sky',import('./earth-sky-notes.js')).then(module=>host=>{
    const back=document.createElement('button');
    back.type='button';back.className='chart-secondary';back.textContent='Retour au carnet';back.onclick=openJournal;
    const list=document.createElement('div');host.append(back,list);
    return module.createEarthSkyNotebook(list,{onRecall:openEarthSky}).dispose;
  });
  releaseChart=openAtlasModule(dialogBody,ready,'du carnet d’observations');
}
function openJournal() {
  showDialog('Carnet de vol','journal-open');
  const save = document.createElement('button');
  save.className = 'primary-btn'; save.innerHTML = icon('bookmark') + 'Enregistrer ma position';
  save.onclick = () => { savePosition(); openJournal(); };
  const album=document.createElement('button');
  album.type='button';album.className='archive-entry';album.dataset.openAlbum='';
  album.innerHTML=icon('photo')+'Album d’exploration';album.onclick=openStudioGallery;
  const transits=document.createElement('button');
  transits.type='button';transits.className='archive-entry';transits.dataset.journalTransits='';
  transits.textContent='Mesures de transit';transits.onclick=openTransitNotes;
  const skyNotes=document.createElement('button');
  skyNotes.type='button';skyNotes.className='archive-entry';skyNotes.dataset.journalEarthSky='';
  skyNotes.textContent='Observations du ciel terrestre';skyNotes.onclick=openEarthSkyNotes;
  dialogBody.append(save,album,transits,skyNotes);
  for (const {lab,id,symbol,label} of [
    {lab:phaseLab,id:'phase',symbol:'eclipse',label:'Reprendre l’observation des phases'},
    {lab:travellerLab,id:'traveller',symbol:'navigate',label:'Reprendre le suivi des trajectoires'},
    {lab:blackHoleLab,id:'relativity',symbol:'gravity',label:'Reprendre l’expérience du trou noir'},
    {lab:wavesLab,id:'waves',symbol:'waves',label:'Reprendre l’expérience d’ondes gravitationnelles'}
  ]) {
    if(!lab.saved()) continue;
    const restart=document.createElement('button');
    restart.type='button';restart.className='archive-entry';restart.setAttribute('data-resume-'+id,'');
    restart.innerHTML=icon(symbol)+label;
    restart.onclick=()=>lab.open(undefined,openJournal);
    dialogBody.append(restart);
  }
  const list = document.createElement('div');
  list.className = 'journal-list';
  if (!bookmarks.length) list.innerHTML = '<p class="empty-copy">Enregistre une position pour y revenir avec le même angle de vue et la même vitesse.</p>';
  for (const item of bookmarks) {
    const obj = objects.find(o => o.id === item.view.selectedId);
    const row = document.createElement('div'), restore = document.createElement('button'), remove = document.createElement('button');
    row.className = 'journal-row'; restore.className = 'object-row'; remove.className = 'icon-btn';
    restore.innerHTML = icon('bookmark') + '<span><strong>' + obj.name + '</strong><small>' + new Date(item.stamp).toLocaleString('fr-CA') + '</small></span>';
    restore.onclick = () => {
      if (nav.restore(item.view)) { dialog.close(); closeLanding();endOverflight();closeSurface(); closeSandbox();closeClimate();closeAstrophysics(); closeSystem(); flight(!!item.flying); syncTarget(); }
      else announce('Cette position ne peut plus être chargée.');
    };
    remove.setAttribute('aria-label','Supprimer la position près de ' + obj.name);
    remove.innerHTML = icon('trash');
    remove.onclick = () => { if (storeBookmarks(bookmarks.filter(entry => entry !== item))) openJournal(); };
    row.append(restore,remove); list.append(row);
  }
  dialogBody.append(list); icons(dialogBody);
  const record=document.createElement('section');
  record.className='surface-entry-links';
  dialogBody.append(record);
  import('./surface-registry.js').then(({surfaceProgress,surfaceSiteIndex})=>{
    if (!record.isConnected) return;
    const results=surfaceSiteIndex().map(site=>({site,count:surfaceProgress(site.worldId,site.id)}))
      .filter(({count})=>count>0);
    if (!results.length) {record.remove();return;}
    const title=document.createElement('h3');
    title.className='help-title';title.textContent='Relevés de surface';
    record.append(title);
    for (const {site,count} of results) {
      const button=document.createElement('button');
      const label=document.createElement('span');
      label.textContent=site.name+' · '+count+' / '+site.total;
      button.type='button';button.className='archive-entry';
      if (site.default) button.dataset.surfaceJournal=site.worldId;
      else button.dataset.surfaceJournalRegion=site.id;
      button.innerHTML=icon('terrain');
      button.append(label);
      button.onclick=()=>openSurface(site.worldId,undefined,site.id);
      record.append(button);
    }
    icons(record);
  }).catch(()=>record.remove());
}
$('#journal-open').onclick = openJournal;
function openHelp() {
  showDialog('Commandes','');
  dialogBody.innerHTML = '<h3 class="help-title">Observer un astre</h3><p class="help-copy">Double-clique ou touche deux fois un astre pour le rejoindre. Dans la vue spatiale, le même geste fait avancer vers le point visé. Glisse pour tourner autour de l’astre. La molette, deux doigts ou les touches + et − changent la distance d’observation.</p>' +
    '<h3 class="help-title">Piloter en vol libre</h3><p class="help-copy">Maintiens une direction pour accélérer. Au relâchement, le vaisseau conserve brièvement son élan. Le frein raccourcit la dérive. Glisse pour regarder autour de toi. La touche L verrouille la visée à la souris et Échap la libère.</p>' +
    '<label class="shortcut" for="look-sensitivity"><span>Sensibilité de visée</span><input id="look-sensitivity" type="range" min="0.4" max="2.4" step="0.1"></label>' +
    [['Avancer et reculer','W ou Z / S'],['Se déplacer de côté','A ou Q / D'],['Regarder autour de soi','Flèches du clavier'],['Monter et descendre','R / F'],['Accélérer temporairement','Maj'],['Freiner','X'],['Ajuster la vitesse','+ / −'],['Revenir vers la cible','Échap']].map(([label,keys]) => '<div class="shortcut"><span>'+label+'</span><kbd>'+keys+'</kbd></div>').join('') +
    '<p class="help-copy">La vitesse s’adapte à la distance des astres. Le carnet conserve tes points de vue sur cet appareil.</p>';
  const slider = $('#look-sensitivity');
  const orbitalHelp = document.createElement('p');
  orbitalHelp.className = 'help-copy';
  orbitalHelp.textContent = 'Dans Système, choisis un astre par son nom. Glisse pour incliner les orbites et utilise la molette ou deux doigts pour zoomer. L’horloge permet de voir une journée ou plusieurs semaines en quelques secondes. Laboratoire modifie la masse du corps central et recalcule les trajectoires de ses satellites.';
  dialogBody.prepend(orbitalHelp);
  const workshopHelp=document.createElement('p');
  workshopHelp.className='help-copy';
  workshopHelp.textContent='Dans Atelier, sélectionne un astre pour régler sa masse et son orbite. Ouvre Points de reprise pour mémoriser un instant, puis Comparer deux états pour mesurer l’effet de tes changements. Tu peux exporter tes expériences dans Sauvegardes.';
  dialogBody.prepend(workshopHelp);
  const climateHelp=document.createElement('p');
  climateHelp.className='help-copy';
  climateHelp.textContent='Dans Climat, modifie l’orbite, l’inclinaison ou l’atmosphère, puis fais avancer les années. Les couches du globe montrent la glace, la température et le rayonnement par latitude. Depuis l’Atelier, tu peux reprendre les paramètres orbitaux d’une planète éligible.';
  dialogBody.prepend(climateHelp);
  const relativityHelp=document.createElement('p');
  relativityHelp.className='help-copy';
  relativityHelp.textContent='Dans Atlas → Découvrir, ouvre le Laboratoire des trous noirs. Vise de part et d’autre du seuil de capture d’un rayon, compare la durée mesurée près de l’horizon à celle d’une horloge éloignée, ou lance une chute radiale.';
  dialogBody.prepend(relativityHelp);
  const waveHelp=document.createElement('p');
  waveHelp.className='help-copy';
  waveHelp.textContent='Dans Atlas → Découvrir → Ondes gravitationnelles, rapproche deux trous noirs. Glisse sur la courbe pour parcourir le signal calculé, puis utilise Écouter pour l’entendre.';
  dialogBody.prepend(waveHelp);
  const surfaceHelp=document.createElement('p');
  surfaceHelp.className='help-copy';
  surfaceHelp.textContent='Dans Atlas → Surfaces, choisis un lieu d’atterrissage. Double-clique ou touche deux fois le sol pour marcher jusqu’au point visé. Tu peux aussi utiliser les flèches ou suivre une balise. Dans Atlas → Terre, choisis un lieu par ses coordonnées pour l’ouvrir dans Google Maps ou Street View.';
  dialogBody.prepend(surfaceHelp);
  const pilotHelp=document.createElement('p');
  pilotHelp.className='help-copy';
  pilotHelp.textContent='Dans Atlas → Pilotage, règle ta poussée pour poser le module. L’assistance pilote la descente si tu veux observer la manœuvre. L’appareil photo ouvre le studio et le carnet conserve ton album.';
  dialogBody.prepend(pilotHelp);
  slider.value = String(sensitivity);
  slider.oninput = () => {
    sensitivity = slider.valueAsNumber;
    try { localStorage.setItem(sensitivityKey, String(sensitivity)); } catch {}
  };
  const credits = document.createElement('button');
  credits.type='button'; credits.className='chart-secondary'; credits.textContent='Données et crédits des images';
  credits.onclick = openCredits;
  dialogBody.append(credits);
}
async function openCredits() {
  showDialog('Données et crédits','');
  const content = document.createElement('div');
  content.className='source-notes'; content.textContent='Chargement…';
  dialogBody.append(content);
  try {
    const files = await Promise.all(['credits.txt','moons-credits.txt','deep-space-credits.txt','deep-atlas-credits.txt','sky-credits.txt','experiences-credits.txt','surface-ephemeris-credits.txt','surface-regions-credits.txt'].map(async name => {
      const response=await fetch(assetUrl(name));
      if (!response.ok) throw new Error('Crédits indisponibles');
      return response.text();
    }));
    content.textContent = files.concat(observationCredits()).join('\n\n');
  } catch { content.textContent='Les crédits complets se trouvent aussi dans le dossier web/assets de l’archive.'; }
}
$('#help-open').onclick = openHelp;
const fullButton = $('#fullscreen');
if (!document.fullscreenEnabled) fullButton.hidden = true;
fullButton.onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { announce('Le plein écran est indisponible dans cette fenêtre.'); }
};
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran';
  fullButton.title = label; fullButton.setAttribute('aria-label',label);
});
icons(); syncTarget();
let renderer;
// Use the space left by the instruments. Portrait reflows the scene above
// the dossier even when a selected destination has a longer name.
const frameElement = $('#object-frame');
const observationFrame = { x: 0, y: 0, diameter: 1 };
function measureObservationFrame() {
  observationFrame.x = frameElement.offsetLeft + frameElement.clientWidth / 2;
  observationFrame.y = frameElement.offsetTop + frameElement.clientHeight / 2;
  observationFrame.diameter = Math.max(1, Math.min(frameElement.clientWidth * .97, frameElement.clientHeight * .91));
}
const frameObserver = new ResizeObserver(measureObservationFrame);
frameObserver.observe(frameElement);
frameObserver.observe(canvas);
measureObservationFrame();
function viewProjection(width,height) {
  const frame=observationFrame;
  const centerX=flying ? .5 : frame.x/Math.max(1,width);
  const centerY=flying ? .5 : frame.y/Math.max(1,height);
  const fov=overflight ? 70*Math.PI/180 : flying ? nav.view.fov :
    2*Math.atan(Math.tan(nav.view.fov/2)*height*.506/Math.max(1,frame.diameter));
  return {view:{...nav.view,fov},centerX,centerY};
}
function orbitalImage(now,capture=false) {
  const {view,centerX,centerY}=viewProjection(canvas.clientWidth,canvas.clientHeight);
  if (!renderer) renderer=new UniverseRenderer(canvas);
  const options={selectedId:nav.selectedId,time:now/1000,simulationDays:sim.days,showNames:controls.showNames,
    reducedMotion:motionPreference.matches,transit:motionPreference.matches?0:nav.transitIntensity,centerX,centerY,
    earthSurvey:!!overflight&&surveyLight.getAttribute('aria-pressed')==='true'};
  return capture ? renderer.capture(view,objects,options) : renderer.draw(view,objects,options);
}
function captureOrbit() {
  if (dialog.open || !canvas.clientWidth || !canvas.clientHeight || systemView.isOpen()) return;
  const photo=orbitalImage(performance.now(),true);
  if(photo?.width) showStudio(photo,nav.selected.name);
}
$('#capture-orbit').onclick=captureOrbit;
let previousTime = 0, telemetryClock = 0;
function draw(now) {
  const dt = previousTime ? Math.min(.25, (now - previousTime) / 1000) : 0;
  previousTime = now;
  const atlasLab=activeAtlasLab();
  if (atlasLab) {
    if (!document.hidden && !dialog.open) atlasLab.tick(dt);
    requestAnimationFrame(draw);
    return;
  }
  if (climateIsOpen()) {
    if (!document.hidden && !dialog.open) climate.tick(dt);
    requestAnimationFrame(draw);
    return;
  }
  if (landingIsOpen()) {
    if (!document.hidden && !dialog.open) landingFlight.tick(dt);
    requestAnimationFrame(draw);
    return;
  }
  if (surfaceIsOpen()) {
    if (!document.hidden && !dialog.open) surface.tick(dt);
    requestAnimationFrame(draw);
    return;
  }
  if (sandboxIsOpen()) {
    if (!document.hidden && !dialog.open) sandbox.tick(dt);
    requestAnimationFrame(draw);
    return;
  }
  if (!document.hidden && (!dialog.open || dialog.dataset.panel === 'simulation')) {
    sim.update(dt);
    nav.syncSimulation(!flying);
  }
  if (now >= telemetryClock) { updateTelemetry(); controls.update(); telemetryClock = now + 110; }
  if (systemView.isOpen()) {
    systemView.render();
    requestAnimationFrame(draw);
    return;
  }
  if (!dialog.open) {
    if (flying) {
      const turn = Number(pressed.has('arrowright')) - Number(pressed.has('arrowleft'));
      const tilt = Number(pressed.has('arrowup')) - Number(pressed.has('arrowdown'));
      if (turn || tilt) nav.look(turn * dt * 1.4, tilt * dt * 1.4);
    }
    nav.update(dt, flying ? input() : {});
    if (syncVoyage(nav.route,nav.selected.name)) updateTelemetry();
    cinema.tick(dt);
    if (overflight && !nav.travelling) {
      const earth=nav.selected;
      if (earth.id==='earth') {
        const altitude=overflight.update(earth,nav.view,dt,motionPreference.matches);
        $('#earth-overflight').dataset.altitude=String(Math.round(altitude));
      } else endOverflight();
    }
  }
  orbitalImage(now);
  requestAnimationFrame(draw);
}
openSystem();
requestAnimationFrame(draw);
