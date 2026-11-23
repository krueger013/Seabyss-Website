import { assetUrl } from './assets.js';
import { createOrbitalSky } from './orbital-sky.js';
import { createDoublePress } from './double-press.js';

const circle = Math.PI * 2;
const auKm = 149597870.7;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const format = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 });
const scopeNames = {sun: 'Système solaire', earth: 'Terre et Lune', mars: 'Lunes de Mars',
  jupiter: 'Système jovien', saturn: 'Système saturnien', uranus: 'Lunes d’Uranus',
  neptune: 'Lunes de Neptune', pluto: 'Pluton et Charon'};
const minorScope = 'sun-minor';
const tiles = ['earth','moon','mars','jupiter','saturn','io','europa','ganymede','callisto','titan','enceladus'];

function node(tag, className, content) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content) result.textContent = content;
  return result;
}
function button(label, content, className) {
  const result = node('button', className, content);
  result.type = 'button';
  result.setAttribute('aria-label', label);
  result.title = label;
  return result;
}
function random(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function rgb(hex) {
  return [1,3,5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
function hash(text) {
  let value=2166136261;
  for (const char of text) value=Math.imul(value^char.charCodeAt(0),16777619);
  return value>>>0;
}
function distance(km) {
  return km > 1.5e7 ? format.format(km / 149597870.7) + ' UA' : format.format(Math.round(km)) + ' km';
}
function caption(value, name) {
  const wrapper = node('div', 'system-metric');
  wrapper.append(node('span', '', name), value);
  return wrapper;
}
function paintRings(context,x,y,radius,back) {
  const bands=[[1.32,.12,'#8a8273'],[1.56,.24,'#b4a286'],[1.78,.18,'#d6c3a0'],[1.96,.09,'#857e73'],[2.07,.12,'#cbbca6']];
  context.save();context.translate(x,y);context.rotate(-.40);
  context.globalAlpha=back?.80:1;
  for(const [outer,thickness,color] of bands) {
    context.lineWidth=radius*thickness;context.strokeStyle=color;
    context.beginPath();context.ellipse(0,0,radius*outer,radius*outer*.30,0,back?Math.PI:0,back?circle:Math.PI);
    context.stroke();
  }
  context.restore();
}

// Maps are sampled once at a modest resolution. At display time each globe
// is projected through a sphere and receives light from the central star.
export function createGlobes(redraw) {
  const maps = new Map(), sprites = new Map(), photospheres = new Map(), coronas = new Map();
  function photosphere(body) {
    if(photospheres.has(body.id)) return photospheres.get(body.id);
    const rng=random(hash(body.id)), w=160,h=80, value=new Float32Array(w*h);
    const octaves=[8,16,38,80].map(n=>({n,grid:Float32Array.from({length:n*n},()=>rng())}));
    const spots=body.id==='sun'?[]:Array.from({length:8},()=>({u:rng(),v:.38+rng()*.23,r:.006+rng()*.009}));
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const u=x/w,v=y/h;
      let light=1.04;
      for(let level=0;level<octaves.length;level++) {
        const {n,grid}=octaves[level],nx=u*n,ny=v*n/2,ix=Math.floor(nx),iy=Math.floor(ny);
        const tx=nx-ix,ty=ny-iy;
        const a=grid[iy*n+ix]*(1-tx)+grid[iy*n+(ix+1)%n]*tx;
        const b=grid[(iy+1)*n+ix]*(1-tx)+grid[(iy+1)*n+(ix+1)%n]*tx;
        light+=((a*(1-ty)+b*ty)-.5)*[.18,.12,.21,.28][level];
      }
      for(const spot of spots) {
        const du=Math.min(Math.abs(u-spot.u),1-Math.abs(u-spot.u))*2;
        const distance=(du*du+(v-spot.v)**2)/(spot.r*spot.r);
        if(distance<8) light-=.53*Math.exp(-distance*1.1)+.15*Math.exp(-distance*.23);
      }
      value[y*w+x]=light;
    }
    photospheres.set(body.id,value);return value;
  }
  function corona(body) {
    const cached=coronas.get(body.id);
    if(cached?.color===body.color)return cached.canvas;
    const result=node('canvas'),size=256, mid=size/2;result.width=result.height=size;
    const context=result.getContext('2d'), pixels=context.createImageData(size,size);
    const base=rgb(body.color),phase=hash(body.id)%360*Math.PI/180;
    for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
      const dx=(x-mid)/mid*5.4,dy=(y-mid)/mid*5.4,radius=Math.hypot(dx,dy);
      if(radius>5.4) continue;
      const azimuth=Math.atan2(dy,dx)+phase,r=Math.max(0,radius-1);
      const rays=Math.cos(azimuth*2.2+.16*Math.sin(azimuth*7)+r*.08)**6;
      const wisps=.82+.18*Math.cos(azimuth*21+.22*Math.sin(azimuth*9)+r*.15);
      const glow=.62*Math.exp(-r*6.5)+.23*Math.exp(-r*1.75)+.16*rays*wisps*Math.exp(-r*1.4);
      const i=(y*size+x)*4;
      pixels.data[i]=base[0];pixels.data[i+1]=base[1]*.75;pixels.data[i+2]=base[2]*.66;
      pixels.data[i+3]=255*glow*Math.min(1,5.4-radius);
    }
    context.putImageData(pixels,0,0);coronas.set(body.id,{color:body.color,canvas:result});return result;
  }
  let loading = false;
  function request(id) {
    if (loading || !tiles.includes(id)) return;
    loading = true;
    const image = new Image();
    image.onload = () => {
      const map = node('canvas');
      map.width = 160; map.height = 80;
      const ctx = map.getContext('2d', { willReadFrequently: true });
      for (const [i,name] of tiles.entries()) {
        ctx.drawImage(image,(i%4)*160,Math.floor(i/4)*80,160,80,0,0,160,80);
        maps.set(name,ctx.getImageData(0,0,160,80));
        sprites.delete(name);
      }
      redraw();
    };
    image.src = assetUrl('orbital-surfaces.webp');
  }
  function sprite(body, angle, lightAngle, lightDepth) {
    const spin = Math.round((angle || 0) * 14) / 14;
    const heading = Math.round(lightAngle * 12) / 12;
    const phase = Math.round(lightDepth * 12) / 12;
    const key = [spin,heading,phase,body.color,body.kind,body.material,body.axialTiltDeg].join('/');
    const current = sprites.get(body.id);
    if (current?.key === key) return current.canvas;
    const canvas = current?.canvas || node('canvas');
    const size = body.kind==='star' ? 100 : 72;
    if (canvas.width!==size) { canvas.width = size; canvas.height = size; }
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(size, size);
    const color = rgb(body.color), map = maps.get(body.id), star = body.kind === 'star';
    const surface = star ? photosphere(body) : null;
    const lx = Math.cos(heading) * Math.sqrt(1 - phase * phase);
    const ly = Math.sin(heading) * Math.sqrt(1 - phase * phase);
    const tilt = (body.axialTiltDeg || 0) * Math.PI / 180;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = (2 * x + 1) / size - 1, ny = (2 * y + 1) / size - 1;
      const rad = nx * nx + ny * ny;
      if (rad >= 1) continue;
      const nz = Math.sqrt(1 - rad);
      const u = ((Math.atan2(nx * ct + ny * st, nz) + spin) / circle + 1.5) % 1;
      const v = .5 + Math.asin(clamp(ny * ct - nx * st, -1, 1)) / Math.PI;
      const mi = map && 4 * (Math.min(79, Math.floor(v * 80)) * 160 + Math.floor(u * 160));
      const incidence=nx*lx+ny*ly+nz*phase;
      const light = star ? (.51+.61*Math.pow(nz,.66))*surface[Math.min(79,Math.floor(v*80))*160+Math.min(159,Math.floor(u*160))]
        : .13 + 1.02 * Math.pow(Math.max(0,incidence), .69);
      let mottling = 1;
      if (!map && !star) {
        if (body.id === 'venus' || body.id === 'uranus' || body.id === 'neptune' || body.material === 'gas')
          mottling += .07 * Math.sin(v * 44 + Math.sin(u * circle * 3) * 1.1);
        else mottling += .1 * Math.sin(u * 89.3 + v * 62.5) * Math.cos(v * 94 - u * 51);
      }
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) {
        const sample=map ? map.data[mi + k] : color[k];
        pixels.data[i+k] = star ? sample*light*(.78+.22*Math.pow(nz,.9)*k)+sample*(1-k*.5)*.26
          : sample*light*mottling;
      }
      pixels.data[i + 3] = Math.min(255, (1 - Math.sqrt(rad)) * size * 170);
    }
    ctx.putImageData(pixels, 0, 0);
    sprites.set(body.id, { key, canvas });
    return canvas;
  }
  return { request, sprite, corona };
}

export function createSystemView(container, { objects, getPosition = b => b.position, getRotation = b => b.spinAngle || 0,
  orbitPath, getRevision = () => 0, getDays = () => 0, onObserve, onExit, onDiscover, canTransit = () => false, onTransit }) {
  const byId = new Map(objects.map(b => [b.id, b]));
  const scopes = objects.filter(b => ['star','planet','dwarf'].includes(b.kind) && objects.some(o => o.parentId === b.id));
  scopes.sort((a,b) => Number(b.id === 'sun') - Number(a.id === 'sun'));
  const scopeIds = new Set(scopes.map(b => b.id));
  container.classList.add('system-view');
  container.hidden = true;
  container.setAttribute('aria-label','Laboratoire orbital');
  const head = node('header', 'system-head');
  const systemField = node('label', 'system-title');
  const summary = node('span');
  systemField.append(summary);
  const scope = node('select');
  scope.dataset.systemScope = '';
  scope.setAttribute('aria-label','Changer de système');
  const hasMinorWorlds = objects.some(b => b.solarFamily === 'minor');
  for (const b of scopes) {
    scope.add(new Option(scopeNames[b.id] || b.name, b.id));
    if (b.id === 'sun' && hasMinorWorlds) scope.add(new Option('Astéroïdes et planètes naines', minorScope));
  }
  systemField.append(scope);
  const gravity = node('div','system-gravity');
  gravity.dataset.systemGravity = '';
  const discover = button('Découvrir le ciel profond','', 'system-discover');
  discover.dataset.systemDiscover = '';
  discover.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m8 4 1.3 4.7L14 10l-4.7 1.3L8 16l-1.3-4.7L2 10l4.7-1.3zM17 11l1.1 3.9L22 16l-3.9 1.1L17 21l-1.1-3.9L12 16l3.9-1.1z"/></svg><span>Découvrir</span>';
  discover.onclick=()=>onDiscover?.();
  const leave = button('Quitter la vue du système', '×', 'system-icon');
  leave.dataset.systemExit = '';
  head.append(systemField, discover, gravity, leave);

  const stage = node('div', 'system-stage');
  const canvas = node('canvas', 'system-canvas');
  canvas.dataset.systemPlot = '';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label','Vue orbitale en trois dimensions. Glisser ou utiliser les flèches pour tourner, + et − pour zoomer.');
  const labels = node('div', 'system-labels');
  const zoom = node('div', 'system-zoom');
  const zoomOut = button('Éloigner la vue du système', '−', 'system-icon');
  const zoomIn = button('Rapprocher la vue du système', '+', 'system-icon');
  zoomIn.dataset.systemZoom = 'in'; zoomOut.dataset.systemZoom = 'out';
  const reset = button('Rétablir le cadrage', '⊙', 'system-icon');
  reset.dataset.systemFrame = '';
  const anglePreset = button('Voir le plan orbital de dessus','','system-icon system-angle');
  anglePreset.dataset.systemAngle = 'perspective';
  anglePreset.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="12" cy="13" rx="9" ry="3.5" transform="rotate(-22 12 13)"/><path d="M12 4v14m-3-11 3-3 3 3"/><circle cx="12" cy="13" r="1.6" fill="currentColor" stroke="none"/></svg>';
  zoom.append(anglePreset,zoomOut, reset, zoomIn);
  const legend = node('span', 'system-legend', 'Échelle comprimée · corps agrandis');
  const scaleBar = node('span','system-scale'); scaleBar.dataset.systemScale = '';
  const orbitalTools = node('div','system-orbit-tools');
  const focusOrbit = button('Cadrer seulement l’orbite sélectionnée','Cadrer l’orbite','system-secondary');
  focusOrbit.dataset.systemOrbitFocus = '';
  const mark = button('Marquer la position simulée de la planète','Marquer','system-secondary');
  mark.dataset.systemMarker = '';
  const since = node('output','system-marker-time'); since.dataset.systemMarkerElapsed = '';
  since.setAttribute('aria-live','off');
  since.setAttribute('aria-label','Temps simulé écoulé depuis le repère');
  orbitalTools.append(focusOrbit,mark,since);
  stage.append(canvas, labels, legend, scaleBar, zoom, orbitalTools);

  const foot = node('footer','system-foot');
  const selection = node('div','system-selection');
  const specimen = node('canvas','system-specimen');
  specimen.width=specimen.height=84;
  specimen.setAttribute('aria-hidden','true');
  const identity = node('label','system-identity');
  const category = node('span');
  const compactPeriod = node('span','system-compact-period');
  const target = node('select'); target.dataset.systemTarget = '';
  target.setAttribute('aria-label','Astre sélectionné');
  identity.append(category,compactPeriod,target);
  const metrics = node('div','system-metrics');
  const orbitRadius = node('strong'), period = node('strong');
  const distanceMetric = caption(orbitRadius,'Rayon orbital moyen');
  const periodMetric = caption(period,'Période orbitale');
  metrics.append(distanceMetric,periodMetric);
  const actions = node('div','system-actions');
  const moons = button('Explorer les satellites', 'Satellites', 'system-secondary');
  moons.dataset.systemMoons = '';
  const observe = button('Observer la sélection', 'Observer', 'system-observe');
  observe.dataset.systemObserve = '';
  const transit = button('Observer le transit','Observer le transit','system-secondary system-transit');
  transit.dataset.systemTransit = '';
  transit.replaceChildren(node('span','system-transit-full','Observer le transit'),node('span','system-transit-short','Transit'));
  actions.append(moons,transit,observe);
  selection.append(specimen,identity,metrics,actions);
  const clock = node('div','system-clock-slot'); clock.dataset.systemClock = '';
  foot.append(selection,clock);
  container.append(head, stage, foot);

  let center = byId.get('sun'), selected = byId.get('earth'), tracks = [], reference = 1, far = 1;
  let linear = false, isolated = false, marker = null;
  let yaw = -.30, elevation = .87, magnification = 1, panX = 0, panY = 0, showNames = true, showTracks = true, lastRevision;
  let points = [], width = 0, height = 0, dpr = 1, needPaint = true, lastPaint = -Infinity, lastSceneKey = '';
  let starCanvas, skyKey, orbitLayer, cachedProjection, projectionKey, layerProject, layerSelected, layerTracks;
  const specimenContext=specimen.getContext('2d');
  let specimenKey, solarImage, solarStamp, solarRequested=false;
  async function loadSolarSymbol() {
    if (solarRequested) return;
    solarRequested=true;
    try {
      const response=await fetch(assetUrl('solar-frame.json'));
      if (!response.ok) return;
      const meta=await response.json(), time=Date.parse(meta.observedAt);
      if (!/^solar-photosphere-[a-f0-9]{12}\.jpg$/.test(meta.image) || !Number.isFinite(time)) return;
      const image=new Image();image.src=assetUrl(meta.image);await image.decode();
      // The source includes a black frame and a UTC caption. Determine the
      // photospheric limb on the central scan lines, away from that caption.
      const sample=node('canvas');sample.width=sample.height=160;
      const painter=sample.getContext('2d',{willReadFrequently:true});
      painter.drawImage(image,0,0,160,160);
      const {data}=painter.getImageData(0,0,160,160);
      const bright=(x,y)=>data[(160*y+x)*4]>38;
      let left=0,right=159,top=0,bottom=159;
      while(left<80 && !bright(left,80))left++;
      while(right>80 && !bright(right,80))right--;
      while(top<80 && !bright(80,top))top++;
      while(bottom>80 && !bright(80,bottom))bottom--;
      if(right-left<110 || bottom-top<110) return;
      const disk=node('canvas');disk.width=disk.height=144;
      const ctx=disk.getContext('2d');
      ctx.beginPath();ctx.arc(72,72,72,0,circle);ctx.clip();
      ctx.drawImage(image,left*image.width/160,top*image.height/160,(right-left+1)*image.width/160,(bottom-top+1)*image.height/160,0,0,144,144);
      solarImage=disk;
      solarStamp=new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(time)+' UTC';
      specimenKey=null;needPaint=true;refreshDetails();render();
    } catch {
      solarRequested=false;
    }
  }
  const sky = createOrbitalSky(() => {skyKey=null;layerProject=null;needPaint=true;render();});
  const ctx = canvas.getContext('2d');
  const observer = new ResizeObserver(() => { needPaint = true; render(); }); observer.observe(stage);
  const globes = createGlobes(() => {specimenKey=null;needPaint=true;render();});
  const pins = new Map();
  const rng = random(70865);
  const belt = Array.from({ length: 590 }, () => {
    const theta = rng() * circle, radius = (2.12 + (rng() + rng()) * .56) * 149597870.7;
    return { p: [Math.cos(theta)*radius, Math.sin(theta)*radius*.224 + (rng()-.5)*radius*.053, Math.sin(theta)*radius*.975],
      radius, alpha:.14+rng()*.29, size:.38+rng()*.6 };
  });

  function restoreFrame() {
    const aspect = stage.clientHeight / Math.max(1, stage.clientWidth);
    yaw = -.30;
    elevation = aspect < .36 ? .43 : aspect > 1.28 ? .59 : aspect > .95 ? .90 : .68;
    magnification = 1; panX = 0; panY = 0; setPresetLabel('perspective'); needPaint = true; render();
  }
  function clearMarker() {
    marker=null;mark.setAttribute('aria-pressed','false');mark.textContent='Marquer';
    mark.setAttribute('aria-label','Marquer la position simulée de la planète');mark.title=mark.getAttribute('aria-label');
    since.hidden=true;delete since.dataset.days;
  }
  function showOrbitalTools() {
    if (selected===center) isolated=false;
    orbitalTools.hidden=!linear || selected===center;
    focusOrbit.setAttribute('aria-pressed',String(isolated));
    focusOrbit.textContent=isolated?'Tout le système':'Cadrer l’orbite';
    focusOrbit.setAttribute('aria-label',isolated?'Afficher toutes les orbites du système':'Cadrer seulement l’orbite sélectionnée');
    focusOrbit.title=focusOrbit.getAttribute('aria-label');
    if (isolated) for (const [id,pin] of pins) {
      if (id!==center.id && id!==selected.id) pin.hidden=true;
    }
    transit.hidden=typeof onTransit!=='function' || !canTransit(selected.id);
    transit.setAttribute('aria-label','Observer le transit de '+selected.name);
  }
  function setPresetLabel(current) {
    anglePreset.dataset.systemAngle=current;
    const next=current==='perspective'?'Voir le plan orbital de dessus':current==='face'?'Voir le plan orbital par la tranche':'Revenir à la perspective';
    anglePreset.title=next;anglePreset.setAttribute('aria-label',next);
  }
  function cyclePerspective() {
    const next=anglePreset.dataset.systemAngle==='perspective'?'face':'edge';
    if(anglePreset.dataset.systemAngle==='edge') {restoreFrame();return;}
    const reference=selected.orbitNormal&&selected!==center?selected:tracks.find(t=>t.body.id==='earth')?.body||tracks[0]?.body;
    let n=reference?.orbitNormal || [0,1,0];
    if(n[1]<0) n=n.map(v=>-v);
    let view=n;
    if(next==='edge') {
      const delta=Math.hypot(n[1],n[2]);
      view=delta>1e-6?[0,-n[2]/delta,n[1]/delta]:[0,0,1];
    }
    yaw=Math.atan2(-view[0],view[2]);elevation=Math.asin(clamp(view[1],-1,1));
    magnification=1;panX=0;panY=0;setPresetLabel(next);needPaint=true;render();
  }
  function refreshDetails() {
    category.textContent = selected.category;
    if(selected.id==='sun' && !solarRequested)loadSolarSymbol();
    const observed=selected.id==='sun' && solarImage;
    legend.textContent=linear?'Phase illustrative · corps agrandis':observed?'SDO/HMI · '+solarStamp:selected.orbitPhaseIllustrative ? 'Orbite simulée · échelle comprimée' : 'Échelle comprimée · corps agrandis';
    scaleBar.hidden=!linear;
    legend.title=observed?'Disque observé depuis la Terre. Échelle des orbites comprimée, corps agrandis.':'';
    legend.dataset.systemSolarFrame=observed?solarStamp:'';
    if(observed)category.textContent='Vue depuis la Terre';
    target.value = selected.id;
    identity.style.setProperty('--object-color',selected.color);
    distanceMetric.firstChild.textContent = selected === center ? 'Rayon' : linear ? 'Demi-grand axe' : 'Rayon orbital moyen';
    orbitRadius.textContent = distance(selected === center ? selected.radius : selected.orbitRadiusKm);
    periodMetric.hidden = selected === center || !selected.orbitPeriodDays;
    period.textContent = selected.orbitPeriodDays ? format.format(selected.orbitPeriodDays) + ' j' : '';
    compactPeriod.hidden=!linear || selected===center;
    if (!compactPeriod.hidden) compactPeriod.textContent='Période '+period.textContent;
    moons.hidden = selected === center || !scopeIds.has(selected.id);
    moons.setAttribute('aria-label','Explorer les satellites de ' + selected.name);
    observe.setAttribute('aria-label','Observer ' + selected.name);
    showOrbitalTools();
    for (const [id, pin] of pins) pin.setAttribute('aria-pressed',String(id === selected.id));
  }
  function choose(id) {
    if (!byId.has(id) || selected.id===id) return;
    const refit=isolated;
    selected = byId.get(id);clearMarker();refreshDetails();needPaint=true;
    if (refit) restoreFrame(); else render();
  }
  function scaledRadius(r) { return Math.log1p(r/reference) / Math.log1p(far/reference); }
  function recalculateTracks() {
    lastRevision = getRevision();
    projectionKey = null;
    const children = objects.filter(b => {
      if (b.parentId !== center.id) return false;
      if (center.id !== 'sun') return true;
      return scope.value === minorScope ? b.solarFamily === 'minor' : b.kind === 'planet';
    });
    far = Math.max(1, ...children.map(b => b.orbitRadiusKm || 1));
    reference = Math.max(1, far * .003, Math.min(...children.map(b => b.orbitRadiusKm || 1)) * .72);
    tracks = children.sort((a,b) => a.orbitRadiusKm - b.orbitRadiusKm).map(body => {
      const radius = body.orbitRadiusKm || 1;
      const scale = linear ? 1/far : scaledRadius(radius)/radius;
      const path = orbitPath ? orbitPath(body, 104) : Array.from({length:105},(_,i) => {
        const theta = i * circle / 104;
        return [radius*Math.cos(theta),radius*Math.sin(theta)*.225,radius*Math.sin(theta)*.974];
      });
      return { body, scale, color: rgb(body.color).join(','), path };
    });
    needPaint = true;
  }
  function selectScope(id, preferred = id) {
    center = byId.get(id === minorScope ? 'sun' : id); scope.value = id;
    linear=center.kind==='star' && center.id!=='sun' && !center.simulated;
    container.toggleAttribute('data-exoplanet-system',linear);
    isolated=false;clearMarker();
    recalculateTracks();
    const moonsOnly = tracks.every(entry=>entry.body.kind==='moon');
    const count = tracks.length;
    const unit = id === minorScope ? 'corps' : (moonsOnly ? 'lune' : 'planète') + (count === 1 ? '' : 's');
    summary.textContent = center.name + ' · ' + count + ' ' + unit;
    labels.replaceChildren(); pins.clear();
    const listed = [center, ...tracks.map(o => o.body)];
    target.replaceChildren(...listed.map(b => new Option(b.name,b.id)));
    for (const body of listed) {
      const pin = button(body.name, body.name, 'system-pin');
      pin.dataset.systemBody = body.id;
      const press=createDoublePress();
      pin.onclick = event => {
        if (event.detail>0 && press.press(event)) onObserve(body.id);
        else choose(body.id);
      };
      labels.append(pin); pins.set(body.id, pin);
      globes.request(body.id);
    }
    selected = listed.find(b => b.id === preferred) || center;
    refreshDetails(); restoreFrame();
  }
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight, ratio = Math.min(2, window.devicePixelRatio || 1);
    if (!w || !h) return false;
    if (w === width && h === height && ratio === dpr) return true;
    if (width && height) { panX *= w/width; panY *= h/height; }
    width = w; height = h; dpr = ratio; needPaint = true;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    starCanvas = node('canvas'); starCanvas.width = canvas.width; starCanvas.height = canvas.height;
    skyKey=null;
    return true;
  }

  function cameraRoll() { return height>width*1.28?-1.28:height>width*.95?-.86:-.085; }
  function projection() {
    const key = [yaw,elevation,width,height,magnification,panX,panY,isolated?selected.id:''].join(',');
    if (projectionKey === key) return cachedProjection;
    const ax = Math.cos(yaw), az = Math.sin(yaw), ce = Math.cos(elevation), se = Math.sin(elevation);
    const angle = cameraRoll();
    const rr = Math.cos(angle), rs = Math.sin(angle);
    function normalize(v, factor) {
      const [x,y,z] = v;
      const side = (x*ax + z*az)*factor, along = (-x*az+z*ax)*factor;
      const up = -y*factor*ce + along*se;
      const depth = along*ce + y*factor*se;
      const perspective = linear ? 1 : 1 / clamp(1 - .10*depth, .6, 1.6);
      return {x:(side*rr-up*rs)*perspective, y:(side*rs+up*rr)*perspective, depth};
    }
    let spanX=isolated?1e-8:.15, spanY=spanX;
    for (const track of tracks) {
      if (isolated && track.body!==selected) continue;
      for (let i=0;i<track.path.length;i+=3) {
        const p=normalize(track.path[i],track.scale);
        spanX=Math.max(spanX,Math.abs(p.x));spanY=Math.max(spanY,Math.abs(p.y));
      }
    }
    const scale = magnification * Math.min((width*.5-Math.min(49,width*.095))/spanX, (height*.5-Math.min(39,height*.12))/spanY);
    if(linear && scale>0) {
      const maxAu=clamp(width*.17,54,88)*far/(scale*auKm);
      const unit=10**Math.floor(Math.log10(maxAu));
      const rulerAu=([5,2,1].find(n=>n*unit<=maxAu)||1)*unit;
      scaleBar.textContent=rulerAu.toLocaleString('fr-CA',{maximumSignificantDigits:2})+' UA';
      scaleBar.dataset.au=String(rulerAu);
      scaleBar.style.width=(rulerAu*auKm*scale/far)+'px';
      scaleBar.title='Échelle des distances projetées dans le plan de l’écran';
    }
    cachedProjection=(v, factor = 1) => {
      const p=normalize(v,factor);
      p.x=width*.5+panX+p.x*scale;p.y=height*.495+panY+p.y*scale;
      return p;
    };
    projectionKey=key;
    return cachedProjection;
  }
  function drawPaths(project, ctx) {
    if (!showTracks) return;
    if (center.id === 'sun') {
      for (const grain of belt) {
        const p = project(grain.p,scaledRadius(grain.radius)/grain.radius);
        ctx.fillStyle = 'rgba(184,169,151,'+grain.alpha+')';
        ctx.fillRect(p.x,p.y,grain.size,grain.size);
      }
    }
    for (const track of tracks) {
      if ((isolated && track.body!==selected) || !track.path || !track.path.length) continue;
      const active = track.body === selected;
      // Depth along the orbit subtly fades the far side of its path.
      const samples=track.path.map(v=>project(v,track.scale));
      ctx.lineWidth = active ? 1.57 : .95;
      for (let start=0;start<samples.length-1;start+=8) {
        const end=Math.min(samples.length-1,start+8);
        const depth=samples[(start+end)>>1].depth;
        const alpha=clamp((active ? .71 : .36)+depth*.15,.19,.96);
        ctx.strokeStyle='rgba('+track.color+','+alpha+')';
        ctx.beginPath();ctx.moveTo(samples[start].x,samples[start].y);
        for(let i=start+1;i<=end;i++) ctx.lineTo(samples[i].x,samples[i].y);
        ctx.stroke();
      }
    }
  }
  function drawBackground(project) {
    const orientation=[yaw,elevation,width,height].join('/');
    if(skyKey!==orientation) {
      const starCtx=starCanvas.getContext('2d');
      starCtx.setTransform(dpr,0,0,dpr,0,0);
      sky.draw(starCtx,width,height,yaw,elevation,cameraRoll());
      skyKey=orientation;
    }
    if (!orbitLayer || orbitLayer.width !== canvas.width || orbitLayer.height !== canvas.height) {
      orbitLayer = node('canvas'); orbitLayer.width=canvas.width; orbitLayer.height=canvas.height;
      layerProject = null;
    }
    if (layerProject !== project || layerSelected !== selected || layerTracks !== showTracks) {
      const sky = orbitLayer.getContext('2d');
      sky.setTransform(dpr,0,0,dpr,0,0);
      sky.drawImage(starCanvas,0,0,width,height);
      drawPaths(project,sky);
      layerProject = project; layerSelected=selected; layerTracks=showTracks;
    }
    ctx.drawImage(orbitLayer,0,0,width,height);
  }
  function drawWake(track, relative, project) {
    const length=track.path.length-1;
    if (!showTracks || length<8) return;
    // Highlight the most recent portion of this object's own trajectory.
    // Orbit samples run in order of increasing eccentric anomaly.
    let nearest=0, best=Infinity;
    for(let i=0;i<length;i++) {
      const p=track.path[i];
      const d=(p[0]-relative[0])**2+(p[1]-relative[1])**2+(p[2]-relative[2])**2;
      if(d<best) {best=d;nearest=i;}
    }
    const block=track.body===selected ? 9 : 6;
    const current=project(relative,track.scale);
    const first=project(track.path[(nearest-block+length)%length],track.scale);
    const trail=ctx.createLinearGradient(first.x,first.y,current.x,current.y);
    trail.addColorStop(0,'rgba('+track.color+',0)');trail.addColorStop(1,'rgba('+track.color+',.91)');
    ctx.strokeStyle=trail;ctx.lineWidth=track.body===selected?2.25:1.65;
    ctx.beginPath();ctx.moveTo(first.x,first.y);
    for(let k=block-1;k>0;k--) {
      const p=project(track.path[(nearest-k+length)%length],track.scale);ctx.lineTo(p.x,p.y);
    }
    ctx.lineTo(current.x,current.y);ctx.stroke();
  }
  function planetRadius(body,isCenter) {
    const mobile = width < 550 || height < 270;
    const sizeFactor = clamp(Math.sqrt(magnification),.82,1.8);
    if (isCenter) return sizeFactor*clamp(Math.min(width,height)*.046,mobile ? 12:20,mobile ? 23:38);
    const physical = (body.kind === 'moon' ? 3.0 : 1.55) * Math.log10(Math.max(1,body.radius/600));
    return sizeFactor*((mobile ? 3.5 : 5) + physical * (mobile ? 1.7 : 2.4));
  }
  function paintBody(point, origin) {
    const {body,x,y,r} = point;
    const star = body.kind === 'star';
    const ink = rgb(body.color).join(',');
    if (star) {
      ctx.save();ctx.translate(x,y);ctx.rotate(getRotation(body)||0);
      ctx.drawImage(globes.corona(body),-r*5.4,-r*5.4,r*10.8,r*10.8);ctx.restore();
    }
    if (body.id === 'saturn') paintRings(ctx,x,y,r,true);
    const angle = Math.atan2(origin.y - y, origin.x - x);
    const face = body === center || center.kind !== 'star' ? .72 : clamp(.37-point.depth*.61, -.30, .93);
    const globe = (body.id==='sun' && solarImage) || globes.sprite(body,getRotation(body),body === center || center.kind !== 'star' ? -2.27 : angle,face);
    ctx.drawImage(globe,x-r,y-r,r*2,r*2);
    if (body===selected && specimen.offsetWidth>0) {
      const key=[body.id,Math.round((getRotation(body)||0)*14),Math.round(angle*12),Math.round(face*12)].join('/');
      if (specimenKey!==key) {
        specimenContext.clearRect(0,0,84,84);
        const previewRadius=body.id==='saturn'?17:29;
        if(star) specimenContext.drawImage(globes.corona(body),-56,-56,196,196);
        if(body.id==='saturn') paintRings(specimenContext,42,42,previewRadius,true);
        specimenContext.drawImage(globe,42-previewRadius,42-previewRadius,previewRadius*2,previewRadius*2);
        if(body.id==='saturn') paintRings(specimenContext,42,42,previewRadius,false);
        specimenKey=key;
      }
    }
    if (body.id==='earth' || body.id==='titan' || body.id==='venus' || body.material==='gas') {
      const color=body.id==='earth'?'151,207,255':ink;
      ctx.strokeStyle='rgba('+color+',.60)';ctx.lineWidth=Math.max(.7,r*.026);
      const light=body===center||center.kind!=='star'?-2.27:angle;
      ctx.beginPath();ctx.arc(x,y,r-.2,light-1.36,light+1.36);ctx.stroke();
    }
    if (body.id === 'saturn') paintRings(ctx,x,y,r,false);
    if (body === selected) {
      ctx.lineWidth=1.3; ctx.strokeStyle='rgba('+ink+',.94)';
      for(let i=0;i<4;i++) {
        ctx.beginPath(); ctx.arc(x,y,r+(body.id==='saturn'?r*.8:5),i*Math.PI/2+.28,i*Math.PI/2+.82); ctx.stroke();
      }
    }
  }
  function positionLabels() {
    const occupied = orbitalTools.hidden ? [] : [
      {x:orbitalTools.offsetLeft,y:orbitalTools.offsetTop,w:orbitalTools.offsetWidth,h:orbitalTools.offsetHeight}
    ];
    const ordered = [...points].sort((a,b) => Number(b.body === selected) - Number(a.body === selected));
    for (const p of ordered) {
      const pin = pins.get(p.body.id);
      const inside = p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height;
      pin.hidden = !showNames || !inside;
      if (pin.hidden) continue;
      const w = pin.offsetWidth || 45, h = pin.offsetHeight || 22;
      const floor = Math.max(2,Math.min(height-h-2,p.y-p.r-h-3));
      const ideal = clamp(p.x-w/2,3,Math.max(3,width-w-3));
      let best, minCost = Infinity;
      for (const dy of [0,-h,h*-2,h*-3]) for (const dx of [0,-w*.62,w*.62,-w,w]) {
        const x=clamp(ideal+dx,2,Math.max(2,width-w-2)), y=clamp(floor+dy,2,Math.max(2,height-h-2));
        let cost=Math.abs(dx)*.72+Math.abs(dy);
        for(const a of occupied) cost += Math.max(0, Math.min(x+w,a.x+a.w)-Math.max(x,a.x)) * Math.max(0,Math.min(y+h,a.y+a.h)-Math.max(y,a.y))*5;
        for(const q of points) if (q!==p && q.x>x-3 && q.x<x+w+3 && q.y>y-3 && q.y<y+h+3) cost+=300;
        if(cost<minCost) {minCost=cost;best={x,y,w,h};}
      }
      occupied.push(best);
      const centerX=best.x+best.w/2, bottom=best.y+best.h, anchorY=p.y-p.r-2;
      if (Math.abs(centerX-p.x)>6 || anchorY-bottom>5) {
        ctx.beginPath(); ctx.strokeStyle='rgba(174,196,215,.43)'; ctx.lineWidth=.8;
        ctx.moveTo(centerX,bottom-1);ctx.lineTo(p.x,anchorY);ctx.stroke();
      }
      pin.style.transform='translate('+Math.round(best.x)+'px,'+Math.round(best.y)+'px)';
    }
  }
  function paintMarker(project,track) {
    const p=project(marker.position,track.scale);
    ctx.save();
    ctx.strokeStyle='#c3e5f0';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(p.x,p.y-5);ctx.lineTo(p.x+5,p.y);
    ctx.lineTo(p.x,p.y+5);ctx.lineTo(p.x-5,p.y);ctx.closePath();ctx.stroke();ctx.restore();
    const days=getDays()-marker.day, absolute=Math.abs(days);
    const unit=absolute>=1 ? [1,'j'] : absolute>=1/24 ? [24,'h'] : absolute>=1/1440 ? [1440,'min'] : [86400,'s'];
    const label='Δt '+(days<0?'−':'')+format.format(absolute*unit[0])+' '+unit[1];
    if(since.textContent!==label) since.textContent=label;
    since.dataset.days=String(days);
  }
  function render() {
    if (container.hidden || !resize()) return;
    if (lastRevision !== getRevision()) {clearMarker();recalculateTracks();refreshDetails();}
    const now = performance.now();
    if (!needPaint && now-lastPaint < 1000/30) return;
    const parent = getPosition(center);
    const bodies = tracks.map(t => {
      const p=getPosition(t.body); return p.map((v,i) => v-parent[i]);
    });
    const key = bodies.map((v,i)=>v.join('/')+':'+Math.round((getRotation(tracks[i].body)||0)*14)).join(',') + '/' + Math.round((getRotation(center)||0)*14);
    if (!needPaint && key===lastSceneKey) return;
    needPaint=false; lastSceneKey=key; lastPaint=now;
    const project=projection();
    ctx.setTransform(dpr,0,0,dpr,0,0);drawBackground(project);
    const origin=project([0,0,0]);
    points=[{...origin,body:center,r:planetRadius(center,true)}];
    for(let i=0;i<tracks.length;i++) {
      const b=tracks[i].body;
      if(isolated && b!==selected) continue;
      drawWake(tracks[i],bodies[i],project);
      points.push({...project(bodies[i],tracks[i].scale),body:b,r:planetRadius(b,false)});
    }
    points.sort((a,b)=>a.depth-b.depth);
    for (const p of points) paintBody(p,origin);
    if(marker) {
      const track=tracks.find(t=>t.body===selected);
      if(track) paintMarker(project,track);
    }
    positionLabels();
  }
  function zoomBy(factor, anchor) {
    const next = clamp(magnification*factor,.53,4.8);
    const ratio = next / magnification;
    const point = anchor || points.find(p=>p.body === selected) || {x:width*.5,y:height*.495};
    panX = (point.x-width*.5)*(1-ratio) + panX*ratio;
    panY = (point.y-height*.495)*(1-ratio) + panY*ratio;
    magnification=next; needPaint=true; render();
  }
  function orbitBy(dx,dy) { yaw-=dx*.008; elevation=clamp(elevation+dy*.007,-1.46,1.46);setPresetLabel('perspective');needPaint=true;render(); }
  const pointers = new Map();
  const doublePress = createDoublePress();
  let moved = false, lastGap = 0;
  function touchCenter() {
    const [a,b]=pointers.values(),bounds=canvas.getBoundingClientRect();
    return {x:(a.x+b.x)*.5-bounds.left,y:(a.y+b.y)*.5-bounds.top};
  }
  function gap() {
    const [a,b] = pointers.values(); return Math.hypot(a.x-b.x,a.y-b.y);
  }
  canvas.onpointerdown = e => {
    if (e.button !== 0) return;
    canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY});
    if (pointers.size===1) moved=false;
    else if (pointers.size===2) {moved=true;lastGap=gap();doublePress.reset();}
  };
  canvas.onpointermove = e => {
    const p=pointers.get(e.pointerId); if (!p) return;
    const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
    if (pointers.size===2) {
      const current=gap();
      panX+=dx/2;panY+=dy/2;
      if(lastGap>2 && current>2) zoomBy(current/lastGap,touchCenter());
      lastGap=current;return;
    }
    if (!moved && Math.hypot(p.x-p.sx,p.y-p.sy)>3) {moved=true;doublePress.reset();}
    if(moved) orbitBy(dx,dy);
  };
  canvas.onpointerup = e => {
    if (!pointers.has(e.pointerId)) return;
    if (!moved && pointers.size===1) {
      const bounds=canvas.getBoundingClientRect(),x=e.clientX-bounds.left,y=e.clientY-bounds.top;
      const hits=points.map(p=>({p,d:Math.hypot(x-p.x,y-p.y)})).filter(q=>q.d<=Math.max(q.p.r+4,22)).sort((a,b)=>a.d-b.d);
      const repeated=doublePress.press(e);
      if(hits.length) {
        const id=hits[0].p.body.id;
        if (repeated) onObserve(id);
        else choose(id);
      } else if (repeated) zoomBy(1.52,{x,y});
    }
    pointers.delete(e.pointerId);
  };
  canvas.onpointercancel = canvas.onlostpointercapture = e => {
    if (pointers.delete(e.pointerId)) doublePress.reset();
  };
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const bounds=canvas.getBoundingClientRect();
    zoomBy(Math.exp(-clamp(e.deltaY,-160,160)*.0023),{x:e.clientX-bounds.left,y:e.clientY-bounds.top});
  }, {passive:false});
  canvas.onkeydown = e => {
    const turns={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-8],ArrowDown:[0,8]};
    if (turns[e.key]) orbitBy(...turns[e.key]);
    else if(e.key==='+'||e.key==='=') zoomBy(1.2);
    else if(e.key==='-') zoomBy(1/1.2);
    else if(e.key==='Home') restoreFrame(); else return;
    e.stopPropagation();e.preventDefault();
  };
  container.addEventListener('keydown', e => {
    container.classList.add('system-keyboard');
    if(e.key==='Escape' && !document.querySelector('dialog[open]') && !e.defaultPrevented && e.target.tagName!=='SELECT') {
      e.preventDefault();e.stopPropagation();onExit();
    }
  });
  container.addEventListener('pointerdown',()=>container.classList.remove('system-keyboard'),{capture:true});
  leave.onclick=()=>onExit();
  observe.onclick=()=>onObserve(selected.id);
  transit.onclick=()=>{if(canTransit(selected.id)) onTransit?.(selected.id);};
  focusOrbit.onclick=()=>{
    isolated=!isolated;showOrbitalTools();restoreFrame();
  };
  mark.onclick=()=>{
    if(marker) clearMarker();
    else {
      const position=getPosition(selected),origin=getPosition(center);
      marker={position:position.map((n,i)=>n-origin[i]),day:getDays()};
      mark.textContent='Effacer';mark.setAttribute('aria-label','Effacer le repère de position');
      mark.title=mark.getAttribute('aria-label');mark.setAttribute('aria-pressed','true');since.hidden=false;
    }
    needPaint=true;render();
  };
  scope.onchange=()=>selectScope(scope.value);
  target.onchange=()=>choose(target.value);
  moons.onclick=()=>selectScope(selected.id);
  zoomIn.onclick=()=>zoomBy(1.23);zoomOut.onclick=()=>zoomBy(1/1.23);reset.onclick=restoreFrame;
  anglePreset.onclick=cyclePerspective;
  return {
    open(id='earth') {
      const object=byId.get(id) || byId.get('earth');
      container.hidden=false;document.body.classList.add('system-view-active');
      const group=object.solarFamily === 'minor' ? minorScope : scopeIds.has(object.parentId) ? object.parentId : scopeIds.has(id) ? id : 'sun';
      selectScope(group,id); canvas.focus({preventScroll:true});
    },
    close() { container.hidden=true;document.body.classList.remove('system-view-active');pointers.clear();doublePress.reset(); },
    render, isOpen:()=>!container.hidden, getCenterId:()=>center.id, getSelectedId:()=>selected.id,
    setLabels(visible) {showNames=Boolean(visible);needPaint=true;render();},
    setOrbits(visible) {showTracks=Boolean(visible);needPaint=true;render();}
  };
}
