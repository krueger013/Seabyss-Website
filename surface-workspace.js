import { createSurfaceTerrain, terrainHeight } from './surface-terrain.js';
import { SURFACE_MISSIONS, visitedFor } from './surface-missions.js';
import { SURFACE_REGIONS } from './surface-regions.js';
import { surfaceMission, surfaceStorageKey, readSurfaceSave, surfaceDefaultSite } from './surface-registry.js';
import { createDoublePress } from './double-press.js';
import { traceSurfaceGround } from './surface-motion.js';
import { mountSurfaceSky } from './surface-sky.js';

const SCAN_RANGE = 13;
const GUIDE_SPEED = 24;
const DISPLAY_RADIUS = 164;
const MAX_POSITION = 335;
const MAX_PITCH = 1.45;
const DIRECTION = {w:[0,1],z:[0,1],ArrowUp:[0,1],s:[0,-1],ArrowDown:[0,-1],a:[-1,0],q:[-1,0],d:[1,0]};
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const wrap = angle => Math.atan2(Math.sin(angle),Math.cos(angle));
const distance = (point,position) => Math.hypot(point.x-position.x,point.z-position.z);
const azimuth = (point,position) => Math.atan2(point.x-position.x,point.z-position.z);
const degrees = radians => (Math.round(radians*180/Math.PI)+360)%360;
const octants = ['N','N-E','E','S-E','S','S-O','O','N-O'];
const number = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});

function createState(id,regionId,mission) {
  const prior = readSurfaceSave(id,regionId);
  const state={x:0,z:0,heading:.08,pitch:-.035,selected:mission.places[0].id,visited:[],landed:false};
  if (prior?.version!==1) return state;
  for (const key of ['x','z']) if(Number.isFinite(prior[key])) state[key]=clamp(prior[key],-MAX_POSITION,MAX_POSITION);
  if (Number.isFinite(prior.heading)) state.heading=wrap(prior.heading);
  if (Number.isFinite(prior.pitch)) state.pitch=clamp(prior.pitch,-MAX_PITCH,MAX_PITCH);
  if (mission.places.some(site=>site.id===prior.selected)) state.selected=prior.selected;
  state.visited=visitedFor(mission,prior.visited);
  state.landed=prior.landed===true;
  return state;
}
function setText(node,value) {
  if (node.textContent!==value) node.textContent=value;
}

export function createSurfaceWorkspace(root,{onExit,onCapture,announce=()=>{},reducedMotion=()=>false}={}) {
  root.innerHTML = `<header class="surface-head">
    <div class="surface-title"><p data-surface-zone></p><h1 data-surface-title></h1></div>
    <div class="surface-location-controls">
      <label><span>Monde</span><select aria-label="Monde à explorer" data-surface-world></select></label>
      <label><span>Région</span><select aria-label="Région à explorer" data-surface-region-select></select></label>
    </div>
    <div class="surface-head-actions">
      <button type="button" data-surface-photo title="Photographier le paysage" aria-label="Photographier le paysage"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="m7 7 2-3h6l2 3"/><circle cx="12" cy="13" r="3.4"/></svg></button>
      <button data-surface-exit title="Quitter le site et retourner en orbite">Orbite <span aria-hidden="true">↗</span></button>
    </div>
  </header>
  <div class="surface-body">
    <div class="surface-scene">
      <canvas data-surface-canvas tabindex="0" aria-label="Vue du terrain. Glisse pour regarder ou touche deux fois pour te déplacer jusqu’au point. Utilise W, A, S, D ou Z, Q, S, D pour avancer."></canvas>
      <div class="surface-shade"></div>
      <div class="surface-compass">
        <button data-surface-align title="Orienter la caméra vers le site sélectionné" aria-label="Orienter la caméra vers le site sélectionné">
          <span data-surface-bearing class="surface-compass-arrow" aria-hidden="true">▲</span>
          <span data-surface-heading></span>
        </button>
      </div>
      <div class="surface-radar" aria-hidden="true"><span data-surface-north>N</span><div class="surface-radar-ring"></div><i class="surface-observer"></i><div data-surface-radar></div></div>
      <div class="surface-markers" data-surface-markers></div>
      <div class="surface-waypoint" data-surface-waypoint hidden aria-hidden="true"></div>
      <output class="surface-route" data-surface-route hidden aria-live="off" aria-label="Distance jusqu’au point choisi"></output>
      <div class="surface-coordinates" data-surface-coordinates aria-hidden="true"></div>
      <div class="surface-pad" aria-label="Déplacement tactile">
        <button type="button" data-surface-dir="ArrowUp" aria-label="Avancer">↑</button>
        <button type="button" data-surface-dir="a" aria-label="Aller à gauche">←</button>
        <button type="button" data-surface-dir="s" aria-label="Reculer">↓</button>
        <button type="button" data-surface-dir="d" aria-label="Aller à droite">→</button>
      </div>
      <div class="surface-landing" data-surface-landing hidden>
        <p>Descente</p><strong data-surface-height></strong><button data-surface-skip>Se poser</button>
      </div>
      <div class="surface-acquisition" data-surface-acquisition hidden><span>Analyse en cours</span><progress max="1" value="0" aria-label="Progression de l’analyse"></progress></div>
    </div>
    <aside class="surface-log" data-surface-log-panel aria-label="Relevés et instruments">
      <div class="surface-log-heading"><h2>Relevés</h2><output data-surface-progress></output></div>
      <progress class="surface-survey-progress" data-surface-survey-progress aria-label="Progression des relevés du secteur"></progress>
      <section class="surface-report" data-surface-report hidden>
        <h3 data-surface-instrument></h3><strong data-surface-reading></strong><p data-surface-note></p>
      </section>
      <div class="surface-sites" data-surface-sites></div>
      <dl class="surface-environment"><div><dt>Gravité</dt><dd data-surface-gravity></dd></div><div><dt>Atmosphère</dt><dd data-surface-air></dd></div></dl>
      <p class="surface-region-info" data-surface-region-info hidden></p>
      <p class="surface-model">Terrain et mesures de mission simulés</p>
    </aside>
  </div>
  <footer class="surface-foot">
    <label class="surface-target"><span>Balise</span><select aria-label="Balise à explorer" data-surface-target></select></label>
    <output class="surface-distance" data-surface-distance aria-label="Distance jusqu’à la balise"></output>
    <div class="surface-actions">
      <button type="button" data-surface-auto aria-pressed="false">Guidage</button>
      <button type="button" class="surface-primary" data-surface-scan>Analyser</button>
      <button type="button" data-surface-log aria-expanded="false">Relevés</button>
    </div>
  </footer>`;
  const element = selector => root.querySelector(selector);
  const canvas=element('[data-surface-canvas]');
  const world=element('[data-surface-world]');
  const region=element('[data-surface-region-select]');
  const target=element('[data-surface-target]');
  const guide=element('[data-surface-auto]');
  const scan=element('[data-surface-scan]');
  const log=element('[data-surface-log]');
  const markers=element('[data-surface-markers]');
  const radar=element('[data-surface-radar]');
  const land=element('[data-surface-landing]');
  const acquisition=element('[data-surface-acquisition]');
  const sites=element('[data-surface-sites]');
  const marker=element('[data-surface-waypoint]');
  const route=element('[data-surface-route]');
  const compact=matchMedia('(max-width:800px), (max-height:530px)');
  const keys=new Set();
  const pointers=new Map();
  const doublePress=createDoublePress();
  const siteRows=new Map(), siteMarkers=new Map(), radarMarkers=new Map();
  let worldId, regionId, mission, state, drag, waypoint, logOpen=false, autopilot=false, descent=0, scanning=0;
  let elapsed=0, eyeHeight=2.4, drawClock=0, saveClock=0, hudClock=0, needsDraw=true;
  let currentReport='';
  const renderer=createSurfaceTerrain(canvas,{onInvalidate:()=>{needsDraw=true;}});
  const sky=mountSurfaceSky(root,{
    look:(heading,pitch)=>{
      if(!state?.landed) return false;
      stopGuide();
      state.heading=wrap(heading);
      state.pitch=clamp(pitch,-MAX_PITCH,MAX_PITCH);
      needsDraw=true;
      refreshHud();
      canvas.focus({preventScroll:true});
      return true;
    },
    onChange:()=>{needsDraw=true;}
  });
  for (const [id,value] of Object.entries(SURFACE_MISSIONS)) world.add(new Option(value.name,id));
  const selected = () => mission.places.find(site=>site.id===state.selected);
  const isOpen = () => !root.hidden && !!state;
  const heightAt = (x,z) => terrainHeight(worldId,x,z,mission.region?.terrain);
  function save() {
    if (!state) return;
    try {localStorage.setItem(surfaceStorageKey(worldId,regionId),JSON.stringify({...state,version:1}));}
    catch {}
  }
  function toggleLog(open) {
    logOpen=!!open;
    root.classList.toggle('surface-log-open',logOpen);
    log.setAttribute('aria-expanded',String(logOpen));
    element('[data-surface-log-panel]').hidden=!logOpen;
    needsDraw=true;
  }
  function refreshReport() {
    const point=selected();
    const completed=state.visited.includes(point.id);
    const signature=point.id+'-'+completed+'-'+state.visited.length;
    if (currentReport===signature) return;
    currentReport=signature;
    for (const place of mission.places) {
      const done=state.visited.includes(place.id);
      const row=siteRows.get(place.id);
      row.setAttribute('aria-pressed',String(place===point));
      row.classList.toggle('surveyed',done);
      row.lastElementChild.textContent=done?'Analysé':'À analyser';
      siteMarkers.get(place.id).setAttribute('aria-pressed',String(place===point));
      radarMarkers.get(place.id).classList.toggle('active',place===point);
    }
    const progress=element('[data-surface-progress]');
    progress.dataset.scanned=String(state.visited.length);
    setText(progress,state.visited.length+'/'+mission.places.length+' analysés');
    const gauge=element('[data-surface-survey-progress]');
    gauge.max=mission.places.length;
    gauge.value=state.visited.length;
    const report=element('[data-surface-report]');
    report.hidden=!completed;
    if (completed) {
      setText(element('[data-surface-instrument]'),point.instrument);
      setText(element('[data-surface-reading]'),point.reading);
      setText(element('[data-surface-note]'),point.note);
    }
  }
  function refreshHud() {
    if(!state) return;
    const point=selected(), range=distance(point,state);
    const az=degrees(state.heading), relative=wrap(azimuth(waypoint??point,state)-state.heading);
    setText(element('[data-surface-heading]'),octants[Math.round(az/45)%8]+' '+String(az).padStart(3,'0')+'°');
    element('[data-surface-bearing]').style.transform='rotate('+relative+'rad)';
    const distanceOutput=element('[data-surface-distance]');
    distanceOutput.dataset.meters=String(range);
    setText(distanceOutput,Math.max(0,Math.round(range))+' m');
    const coords=element('[data-surface-coordinates]');
    coords.dataset.x=String(state.x);
    coords.dataset.z=String(state.z);
    setText(coords,number.format(state.x)+' m E · '+number.format(state.z)+' m N');
    const close=range<=SCAN_RANGE && state.landed;
    const completed=state.visited.includes(point.id);
    guide.disabled=!state.landed || scanning>0 || (close && !autopilot);
    guide.setAttribute('aria-pressed',String(autopilot));
    guide.textContent=autopilot?'Arrêter':'Guidage';
    route.hidden=!waypoint;
    if (waypoint) {
      const remaining=distance(waypoint,state);
      setText(route,'Point choisi · '+Math.ceil(remaining)+' m');
      route.dataset.meters=String(remaining);
      route.dataset.x=String(waypoint.x);
      route.dataset.z=String(waypoint.z);
    }
    scan.disabled=!close || scanning>0 || completed;
    scan.title=completed?'Ce site a été analysé.':close?'Activer les instruments.':'Approche à '+SCAN_RANGE+' m ou moins.';
    scan.textContent=completed?'Analysé':'Analyser';
    land.hidden=state.landed;
    setText(element('[data-surface-height]'),number.format(Math.max(0,eyeHeight-2.4))+' m');
    acquisition.hidden=!scanning;
    acquisition.querySelector('progress').value=scanning ? 1-Math.min(1,scanning/1.25) : 0;
    refreshReport();
  }
  function stopInput() {
    keys.clear();
    pointers.clear();
    drag=null;
    doublePress.reset();
    for(const button of root.querySelectorAll('[data-surface-dir]')) button.classList.remove('held');
  }
  function stopGuide() {
    autopilot=false;
    waypoint=null;
    marker.hidden=true;
    route.hidden=true;
  }
  function choose(id) {
    if(!state || !siteRows.has(id) || state.selected===id) return;
    scanning=0;
    stopGuide();
    state.selected=id;
    target.value=id;
    save();
    refreshHud();
    needsDraw=true;
  }
  function addPoint(point) {
    target.add(new Option(point.name,point.id));
    const row=document.createElement('button');
    row.className='surface-site';
    row.dataset.surfaceSite=point.id;
    row.innerHTML='<strong></strong><small></small>';
    row.firstElementChild.textContent=point.name;
    row.onclick=()=>choose(point.id);
    sites.append(row);
    siteRows.set(point.id,row);
    const siteMarker=document.createElement('button');
    siteMarker.className='surface-marker';
    siteMarker.dataset.surfaceMarker=point.id;
    siteMarker.textContent=point.name;
    siteMarker.onclick=()=>choose(point.id);
    siteMarker.hidden=true;
    markers.append(siteMarker);
    siteMarkers.set(point.id,siteMarker);
    const pip=document.createElement('i');
    pip.className='surface-radar-point';
    radar.append(pip);
    radarMarkers.set(point.id,pip);
  }
  function setWorld(id,nextRegionId) {
    const next=surfaceMission(id,nextRegionId);
    if(!next) return false;
    const nextId=next.region?.id;
    if(state && id===worldId && nextId===regionId) return true;
    if(state) save();
    worldId=id;
    regionId=nextId;
    mission=next;
    state=createState(id,regionId,mission);
    sky.setWorld(worldId,mission.region);
    state.landed ||= reducedMotion();
    descent=0;
    scanning=0;
    elapsed=0;
    saveClock=0;
    stopInput();
    stopGuide();
    eyeHeight=state.landed ? 2.4 : 102.4;
    world.value=id;
    region.replaceChildren(new Option(SURFACE_MISSIONS[id].title,''),...(SURFACE_REGIONS[id] ?? []).map(item=>new Option(item.name,item.id)));
    region.value=regionId ?? '';
    root.dataset.world=id;
    root.dataset.region=regionId ?? '';
    root.style.setProperty('--surface-accent',mission.color);
    setText(element('[data-surface-zone]'),mission.zone);
    setText(element('[data-surface-title]'),mission.title);
    setText(element('[data-surface-gravity]'),mission.gravity);
    setText(element('[data-surface-air]'),mission.air);
    const details=element('[data-surface-region-info]');
    const location=mission.region ?? surfaceDefaultSite(id);
    details.hidden=!location;
    if(location) {
      const coords=number.format(Math.abs(location.latitude))+'° '+(location.latitude<0?'S':'N')+' · '+
        number.format(Math.abs(location.longitude))+'° '+(location.longitude<0?'O':'E');
      setText(details,coords+(mission.region?.description?' · '+mission.region.description:''));
    }
    target.replaceChildren();sites.replaceChildren();markers.replaceChildren();radar.replaceChildren();
    siteRows.clear();siteMarkers.clear();radarMarkers.clear();
    for(const point of mission.places) addPoint(point);
    target.value=state.selected;
    currentReport='';
    needsDraw=true;
    refreshHud();
    return true;
  }
  function touchDown() {
    if(state.landed) return;
    state.landed=true;
    eyeHeight=2.4;
    save();
    refreshHud();
    needsDraw=true;
    if(document.activeElement===element('[data-surface-skip]')) canvas.focus({preventScroll:true});
  }
  function align() {
    if (!state?.landed) return;
    state.heading=azimuth(waypoint??selected(),state);
    state.pitch=-.035;
    needsDraw=true;
    refreshHud();
  }
  function startScan() {
    if (!state?.landed || scan.disabled || distance(selected(),state)>SCAN_RANGE || state.visited.includes(state.selected)) return;
    stopGuide();
    stopInput();
    scanning=1.25;
    if (reducedMotion()) completeScan();
    refreshHud();
  }
  function completeScan() {
    scanning=0;
    if (state.visited.includes(state.selected)) return;
    state.visited.push(state.selected);
    save();
    refreshHud();
    toggleLog(true);
    announce(state.visited.length===mission.places.length?'Tous les sites sont analysés.':'Relevé enregistré.');
  }
  function move(forward,strafe,heading,step) {
    state.x=clamp(state.x+(Math.sin(heading)*forward+Math.cos(heading)*strafe)*step,-MAX_POSITION,MAX_POSITION);
    state.z=clamp(state.z+(Math.cos(heading)*forward-Math.sin(heading)*strafe)*step,-MAX_POSITION,MAX_POSITION);
    needsDraw=true;
  }
  function stepMotion(dt) {
    const manual = [...keys,...pointers.values()].map(key=>DIRECTION[key]).filter(Boolean);
    const strafe=manual.reduce((sum,[x])=>sum+x,0), forward=manual.reduce((sum,[,z])=>sum+z,0);
    const norm=Math.hypot(strafe,forward);
    if(norm>0) {
      stopGuide();
      move(forward/norm,strafe/norm,state.heading,mission.speed*dt);
    } else if (keys.has('ArrowLeft') || keys.has('ArrowRight')) {
      const change=Number(keys.has('ArrowRight'))-Number(keys.has('ArrowLeft'));
      state.heading=wrap(state.heading+change*dt*1.4);
      stopGuide();
      needsDraw=true;
    } else if(autopilot) {
      const point=waypoint??selected(), course=azimuth(point,state);
      state.heading=wrap(state.heading+wrap(course-state.heading)*(reducedMotion()?1:Math.min(1,dt*5)));
      state.pitch+=(-.035-state.pitch)*Math.min(1,dt*4);
      const range=distance(point,state);
      const remaining=range-(waypoint ? .08 : 5);
      if (remaining<=.09) {
        if(waypoint) announce('Point atteint.');
        stopGuide();
        save();
        refreshHud();
        return;
      }
      const speed=waypoint ? Math.min(GUIDE_SPEED,Math.max(2,remaining*3)) : GUIDE_SPEED;
      move(1,0,course,Math.min(remaining,speed*dt));
    }
  }
  function paint() {
    const skyView=sky.observe({x:state.x,z:state.z,eyeHeight});
    renderer.draw(worldId,{x:state.x,z:state.z,heading:state.heading,pitch:state.pitch,eyeHeight,time:elapsed,sky:skyView,region:mission.region?.terrain});
    const visible=[];
    const width=canvas.clientWidth, height=canvas.clientHeight;
    const north=element('[data-surface-north]');
    north.style.transform='translate('+(-42*Math.sin(state.heading))+'px,'+(-42*Math.cos(state.heading))+'px)';
    for(const point of mission.places) {
      const current=point===selected(), range=distance(point,state);
      const projected=renderer.project({x:point.x,z:point.z,y:heightAt(point.x,point.z)+5.2});
      const marker=siteMarkers.get(point.id);
      if (state.landed && projected?.visible && projected.x>22 && projected.x<width-22
        && projected.y>42 && projected.y<height-54 && range<280) {
        const margin=77;
        const x=clamp(projected.x,margin,width-margin);
        visible.push({marker,x,y:projected.y,priority:current?0:range});
      } else marker.hidden=true;
      const relativeBearing=azimuth(point,state)-state.heading;
      const radius=clamp(range/DISPLAY_RADIUS,0,1)*42;
      radarMarkers.get(point.id).style.transform='translate('+Math.sin(relativeBearing)*radius+'px,'+(-Math.cos(relativeBearing)*radius)+'px)';
    }
    visible.sort((a,b)=>a.priority-b.priority);
    const occupied=[];
    for (const item of visible) {
      const overlap=occupied.some(box=>Math.abs(box.x-item.x)<103 && Math.abs(box.y-item.y)<30);
      item.marker.hidden=overlap;
      if(overlap) continue;
      item.marker.style.transform='translate('+item.x+'px,'+item.y+'px) translate(-50%,-100%)';
      occupied.push(item);
    }
    if(waypoint) {
      const y=heightAt(waypoint.x,waypoint.z)+.18;
      const projected=renderer.project({...waypoint,y});
      marker.hidden=!projected?.visible;
      if(!marker.hidden) marker.style.transform='translate('+projected.x+'px,'+projected.y+'px) translate(-50%,-50%)';
    }
    needsDraw=false;
  }
  function close() {
    if(!isOpen())return;
    stopInput();stopGuide();
    sky.close();
    scanning=0;
    save();
    root.hidden=true;
    worldId=undefined;
    regionId=undefined;
    state=null;
  }
  world.onchange=()=>setWorld(world.value);
  region.onchange=()=>setWorld(worldId,region.value);
  target.onchange=()=>choose(target.value);
  log.onclick=()=>toggleLog(!logOpen);
  element('[data-surface-align]').onclick=align;
  element('[data-surface-exit]').onclick=()=>onExit?.(worldId);
  const photo=element('[data-surface-photo]');
  photo.hidden=!onCapture;
  photo.onclick=()=>{
    paint();
    onCapture(canvas,mission.title+' · '+mission.name);
  };
  element('[data-surface-skip]').onclick=touchDown;
  guide.onclick=()=>{
    if(guide.disabled) return;
    if(autopilot) stopGuide();
    else autopilot=true;
    stopInput();
    refreshHud();
  };
  scan.onclick=startScan;
  function moveToScreenPoint(event) {
    if (needsDraw) paint();
    const bounds=canvas.getBoundingClientRect();
    const ray=renderer.screenGroundRay(event.clientX-bounds.left,event.clientY-bounds.top);
    const point=traceSurfaceGround(ray,heightAt,MAX_POSITION);
    if(!point || distance(point,state)<.6) {
      announce('Choisis un point sur le sol dans le secteur accessible.');
      return;
    }
    stopInput();
    waypoint=point;
    autopilot=true;
    needsDraw=true;
    refreshHud();
  }
  canvas.onpointerdown=event=>{
    if (!state?.landed || event.button!==0) return;
    if (drag || !event.isPrimary) {
      if(drag) drag.multi=true;
      doublePress.reset();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,started:event.timeStamp,moved:false,multi:false};
  };
  canvas.onpointermove=event=>{
    if(!state?.landed || drag?.id!==event.pointerId || drag.multi) return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(!drag.moved && Math.hypot(dx,dy)<6) return;
    drag.moved=true;
    doublePress.reset();
    stopGuide();
    state.heading=wrap(state.heading-dx*.0065);
    state.pitch=clamp(state.pitch+dy*.0055,-MAX_PITCH,MAX_PITCH);
    drag.x=event.clientX; drag.y=event.clientY;
    needsDraw=true;
  };
  canvas.onpointerup=event=>{
    if(drag?.id!==event.pointerId) return;
    const tap=!drag.moved && !drag.multi && event.timeStamp-drag.started<=350;
    drag=null;
    if (!tap || scanning) doublePress.reset();
    else if (doublePress.press(event)) moveToScreenPoint(event);
  };
  canvas.onpointercancel=canvas.onlostpointercapture=event=>{
    if(drag?.id===event.pointerId) {
      drag=null;
      doublePress.reset();
    }
  };
  for(const button of root.querySelectorAll('[data-surface-dir]')) {
    const direction=button.dataset.surfaceDir;
    button.onpointerdown=event=>{
      if(!state?.landed || scanning>0 || event.button>0)return;
      stopGuide();
      button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId,direction);
      button.classList.add('held');
    };
    button.onpointerup=button.onpointercancel=button.onlostpointercapture=event=>{
      pointers.delete(event.pointerId);
      button.classList.remove('held');
    };
    button.onclick=event=>{
      if(!state?.landed || scanning>0 || event.detail!==0)return;
      const [strafe,forward]=DIRECTION[direction];
      stopGuide();
      move(forward,strafe,state.heading,.55);
    };
  }
  root.addEventListener('keydown',event=>{
    if(!isOpen() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)return;
    if(event.key==='Escape') {
      event.preventDefault();event.stopPropagation();
      if(autopilot) {stopGuide();refreshHud();} else onExit?.(worldId);
      return;
    }
    if(event.target.closest('select,input,textarea,[contenteditable]') || !state.landed || scanning) return;
    const key=event.key.length===1 ? event.key.toLowerCase() : event.key;
    if(!DIRECTION[key] && key!=='ArrowLeft' && key!=='ArrowRight') return;
    event.preventDefault();
    keys.add(key);
  });
  window.addEventListener('keyup',event=>keys.delete(event.key.length===1?event.key.toLowerCase():event.key));
  window.addEventListener('blur',stopInput);
  document.addEventListener('visibilitychange',()=>{if(document.hidden && isOpen()) {save();stopInput();}});
  window.addEventListener('pagehide',()=>{if(isOpen())save();});
  compact.addEventListener('change',()=>{if(isOpen())toggleLog(!compact.matches);});
  if ('ResizeObserver' in window) new ResizeObserver(()=>{needsDraw=true;}).observe(canvas);
  return {
    isOpen, close,
    open(id,spawn,requestedRegion) {
      if(!setWorld(id,requestedRegion))return false;
      if(spawn && [spawn.x,spawn.z,spawn.heading].every(Number.isFinite)) {
        stopInput();
        stopGuide();
        state.x=clamp(spawn.x,-MAX_POSITION,MAX_POSITION);
        state.z=clamp(spawn.z,-MAX_POSITION,MAX_POSITION);
        state.heading=wrap(spawn.heading);
        state.pitch=Number.isFinite(spawn.pitch)?clamp(spawn.pitch,-.75,.72):-.035;
        state.landed=true;
        eyeHeight=2.4;
        needsDraw=true;
        save();
        refreshHud();
      }
      root.hidden=false;
      toggleLog(!compact.matches);
      canvas.focus({preventScroll:true});
      paint();
      return true;
    },
    tick(dt) {
      if(!isOpen())return;
      const step=clamp(dt,0,.1);
      sky.tick(step);
      elapsed+=step;drawClock+=step;hudClock+=step;saveClock+=step;
      if (!state.landed) {
        descent=Math.min(1,descent+step/2.3);
        eyeHeight=2.4+100*(1-descent)**2.5;
        needsDraw=true;
        if(descent===1 || reducedMotion())touchDown();
      } else if(scanning) {
        scanning=Math.max(.00001,scanning-step);
        if(scanning<.001)completeScan();
      } else stepMotion(step);
      if(needsDraw && drawClock>=1/36) {paint();drawClock=0;}
      if(hudClock>=.08) {refreshHud();hudClock=0;}
      if(saveClock>=3) {save();saveClock=0;}
    },
  };
}
