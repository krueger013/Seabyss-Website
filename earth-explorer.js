import { assetUrl } from './assets.js';
import { EARTH_SKY_SITES as sites, resolveEarthSkySite } from './earth-sky-sites.js';

const rad = Math.PI / 180;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const wrap = n => ((n + 180) % 360 + 360) % 360 - 180;
const coordinateKey = 'seabyss-universe.earth-pin.v1';
const maps = 'https://www.google.com/maps/@';
const earthRadiusKm = 6371;

const tours = [
  {id:'saint-laurent', name:'Du Saint-Laurent à l’Atlantique', stops:['montreal','quebec','levis','perce','forillon','cap-breton']},
  {id:'cordillere', name:'Des Rocheuses jusqu’aux Andes', stops:['banff','grand-canyon','cusco','valparaiso']},
  {id:'meridiens', name:'Ports et méridiens', stops:['paris','venice','cape-town','sydney','tokyo']}
];
const sitesById = new Map(sites.map(site=>[site.id,site]));
export function earthGreatCircle(a,b) {
  const spherical=({latitude,longitude})=>[Math.cos(latitude*rad)*Math.cos(longitude*rad),
    Math.cos(latitude*rad)*Math.sin(longitude*rad),Math.sin(latitude*rad)];
  const start=spherical(a), end=spherical(b);
  const dot=clamp(start.reduce((sum,n,i)=>sum+n*end[i],0),-1,1);
  const toward=end.map((n,i)=>n-dot*start[i]);
  const crossLength=Math.hypot(...toward);
  const angle=Math.atan2(crossLength,dot);
  if (crossLength<1e-12 && dot>0) return {distance:0,at:t=>t<1?a:b};
  // At opposite points any great circle reaches the destination. Pick a
  // stable tangent rather than dividing by the sine of a half revolution.
  const perpendicular=Math.abs(start[2])<.9 ? [-start[1],start[0],0] : [0,-start[2],start[1]];
  const tangent=crossLength>=1e-12 ? toward : perpendicular;
  const length=Math.hypot(...tangent);
  return {
    distance:angle*earthRadiusKm,
    at(t) {
      if (t<=0) return a;
      if (t>=1) return b;
      const cos=Math.cos(angle*t), sin=Math.sin(angle*t)/length;
      const [x,y,z]=start.map((n,i)=>n*cos+tangent[i]*sin);
      return {latitude:Math.atan2(z,Math.hypot(x,y))/rad,longitude:wrap(Math.atan2(y,x)/rad)};
    }
  };
}

function buildTour(model) {
  const stops=model.stops.map(id=>sitesById.get(id));
  const legs=stops.slice(1).map((site,index)=>{
    const arc=earthGreatCircle(stops[index],site);
    const segments=Math.max(6,Math.ceil(arc.distance/250));
    return {distance:arc.distance,track:Array.from({length:segments+1},(_,step)=>arc.at(step/segments))};
  });
  return {stops,legs,distance:legs.reduce((sum,leg)=>sum+leg.distance,0)};
}

function selectCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {latitude:Number(latitude.toFixed(5)), longitude:Number(longitude.toFixed(5))};
}

function observerPin(value) {
  const point=selectCoordinates(value?.latitude,value?.longitude);
  return point ? resolveEarthSkySite({...value,...point}) : null;
}

function readPin() {
  try {
    const stored = JSON.parse(localStorage.getItem(coordinateKey));
    return observerPin(stored);
  } catch { return null; }
}

function coordinates(pin) {
  return `${pin.latitude.toFixed(5)},${pin.longitude.toFixed(5)}`;
}

export function earthExploreUrls(pin, key='') {
  const point = selectCoordinates(pin?.latitude,pin?.longitude);
  if (!point) return null;
  const center = coordinates(point);
  const direct = values => maps + '?' + new URLSearchParams({api:'1',...values});
  return {
    satellite:direct({map_action:'map',center,zoom:'17',basemap:'satellite'}),
    street:direct({map_action:'pano',viewpoint:center}),
    earth:'https://earth.google.com/web/',
    embed:key ? 'https://www.google.com/maps/embed/v1/streetview?' +
      new URLSearchParams({key,location:center,fov:'86'}) : ''
  };
}

export function earthProjection(latitude, longitude, center) {
  const lat = latitude * rad, delta = (longitude - center.longitude) * rad;
  const centerLat = center.latitude * rad;
  const cosLat = Math.cos(lat);
  const toward = cosLat * Math.cos(delta);
  return {
    x:cosLat * Math.sin(delta),
    y:Math.cos(centerLat)*Math.sin(lat) - Math.sin(centerLat)*toward,
    depth:Math.sin(centerLat)*Math.sin(lat) + Math.cos(centerLat)*toward
  };
}

export function earthUnprojection(x, y, center) {
  const r2 = x*x+y*y;
  if (r2 > 1) return null;
  const z = Math.sqrt(1-r2), centerLat = center.latitude*rad;
  const sinLat = y*Math.cos(centerLat) + z*Math.sin(centerLat);
  const tangent = z*Math.cos(centerLat) - y*Math.sin(centerLat);
  return {latitude:Math.asin(clamp(sinLat,-1,1))/rad,longitude:wrap(center.longitude+Math.atan2(x,tangent)/rad)};
}

function createGlobe(canvas,{view,select,turn,magnify}) {
  const ctx = canvas.getContext('2d');
  const texture = new Image();
  const preview = new Image();
  const raster = document.createElement('canvas');
  const pixels = raster.getContext('2d');
  let map = null, detailed = false, key = '', request = 0, closed = false;
  let pointer, secondPointer, lastTap, pinching=false;
  const dimensions = () => {
    const {width,height} = canvas.getBoundingClientRect();
    const dpr = Math.min(1.4, window.devicePixelRatio || 1);
    return {width,height,dpr,radius:Math.min(width,height)*.414*view.zoom};
  };
  const invalidate = () => { if (!request && !closed) request=requestAnimationFrame(draw); };
  function loadTexture(image) {
    if (image===preview && detailed) return;
    detailed=image===texture;
    const source = document.createElement('canvas');
    source.width=Math.min(1024,image.naturalWidth); source.height=source.width/2;
    const layer = source.getContext('2d',{willReadFrequently:true});
    layer.drawImage(image,0,0,source.width,source.height);
    map = layer.getImageData(0,0,source.width,source.height);
    key=''; invalidate();
  }
  // Request the small local image first. Once it is rendered, load detail.
  function loadFull() {
    if (!closed && !texture.src) texture.src=assetUrl('earth-land-day.webp');
  }
  texture.onload=()=>loadTexture(texture);
  preview.onload=()=>{loadTexture(preview);requestAnimationFrame(loadFull);};
  preview.onerror=loadFull;
  preview.src=assetUrl('earth-land-preview.webp');

  function drawTour(radius) {
    if (!view.tour) return;
    const renderPoint = point => earthProjection(point.latitude,point.longitude,view.center);
    for (const [index,leg] of view.tour.legs.entries()) {
      const active=index===Math.max(0,view.stop-1);
      ctx.beginPath();
      let onDisk=false;
      for (const waypoint of leg.track) {
        const p=renderPoint(waypoint);
        if (p.depth<.01) {onDisk=false;continue;}
        if (!onDisk) ctx.moveTo(p.x*radius,-p.y*radius);
        else ctx.lineTo(p.x*radius,-p.y*radius);
        onDisk=true;
      }
      ctx.lineCap='round';
      ctx.setLineDash([]);
      ctx.strokeStyle='rgba(6,19,28,.70)';
      ctx.lineWidth=active?4:2.5;
      ctx.stroke();
      ctx.strokeStyle=active?'#ffcf83':index<view.stop?'#b0eeea':'#a9ddf0';
      ctx.lineWidth=active?1.8:1.2;
      ctx.setLineDash(active?[]:[3,4]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const stop of view.tour.stops) {
      const p=renderPoint(stop);
      if (p.depth<.01) continue;
      ctx.beginPath();
      ctx.arc(p.x*radius,-p.y*radius,3.3,0,Math.PI*2);
      ctx.fillStyle='#e7f9f7'; ctx.fill();
      ctx.strokeStyle='#192a36'; ctx.lineWidth=1; ctx.stroke();
    }
  }
  function draw() {
    request=0;
    const {width,height,dpr,radius}=dimensions();
    if (width<1 || height<1) return;
    canvas.width=Math.round(width*dpr); canvas.height=Math.round(height*dpr);
    ctx.setTransform(dpr,0,0,dpr,width*dpr/2,height*dpr/2);
    const diameter=Math.min(view.animating?224:620,Math.round(radius*2*dpr));
    const cameraKey=[view.center.latitude,view.center.longitude,diameter].join('/');
    if (key!==cameraKey) {
      key=cameraKey;
      raster.width=raster.height=diameter;
      const raw = pixels.createImageData(diameter,diameter);
      const centerLat = view.center.latitude*rad;
      const cosLat = Math.cos(centerLat), sinLat = Math.sin(centerLat);
      const longitudeShift = view.center.longitude/360+.5;
      for (let j=0;j<diameter;j++) {
        const y=1-(j+.5)/diameter*2, y2=y*y;
        for (let i=0;i<diameter;i++) {
          const x=(i+.5)/diameter*2-1, length2=x*x+y2;
          if (length2>=1) continue;
          const z=Math.sqrt(1-length2), index=(j*diameter+i)*4;
          const diffuse=.72+.28*clamp(z*.84-x*.29+y*.32,0,1);
          const rim=Math.pow(1-z,5);
          let r=29, g=73, b=109;
          if (map) {
            const lon = Math.atan2(x,z*cosLat-y*sinLat)/(2*Math.PI)+longitudeShift;
            const lat = .5-Math.asin(clamp(y*cosLat+z*sinLat,-1,1))/Math.PI;
            const sx = Math.floor(((lon%1+1)%1)*map.width);
            const sy = clamp(Math.floor(lat*map.height),0,map.height-1);
            const t = (sy*map.width+sx)*4;
            r=map.data[t]; g=map.data[t+1]; b=map.data[t+2];
          }
          raw.data[index]=r*diffuse+rim*21;
          raw.data[index+1]=g*diffuse+rim*57;
          raw.data[index+2]=b*diffuse+rim*89;
          raw.data[index+3]=255*Math.min(1,(1-length2)*diameter/3);
        }
      }
      pixels.putImageData(raw,0,0);
    }
    if (radius>0) {
      ctx.save();
      ctx.shadowColor='#5e9ff096';
      ctx.shadowBlur=14;
      ctx.drawImage(raster,-radius,-radius,radius*2,radius*2);
      ctx.restore();
    }
    drawTour(radius);
    const cross = earthProjection(view.pin.latitude,view.pin.longitude,view.center);
    if (cross.depth<=0) return;
    const x=cross.x*radius, y=-cross.y*radius;
    if (Math.abs(x)>width/2 || Math.abs(y)>height/2) return;
    ctx.beginPath();
    ctx.arc(x,y,11,0,Math.PI*2);
    ctx.strokeStyle='#e7f4ff';
    ctx.lineWidth=1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x,y,3.5,0,Math.PI*2);
    ctx.fillStyle='#ffca92';
    ctx.fill();
  }
  const inspect = event => {
    const box = canvas.getBoundingClientRect();
    return earthUnprojection((event.clientX-box.left-box.width/2)/dimensions().radius,
      (box.top+box.height/2-event.clientY)/dimensions().radius,view.center);
  };
  canvas.onpointerdown = event => {
    if (event.button !== 0) return;
    const point={id:event.pointerId,x:event.clientX,y:event.clientY,travel:0};
    if (!event.isPrimary) {
      if (event.pointerType!=='touch' || !pointer || secondPointer) return;
      secondPointer=point;
      pinching=true;
      lastTap=null;
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (secondPointer) return;
    canvas.focus({preventScroll:true});
    pointer=point;
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (pinching) {
      if (!pointer || !secondPointer) return;
      const point=event.pointerId===pointer.id?pointer:event.pointerId===secondPointer.id?secondPointer:null;
      if (!point) return;
      const before=Math.hypot(pointer.x-secondPointer.x,pointer.y-secondPointer.y);
      point.x=event.clientX; point.y=event.clientY;
      const after=Math.hypot(pointer.x-secondPointer.x,pointer.y-secondPointer.y);
      if (before>3 && after>3) magnify(after/before);
      return;
    }
    if (event.pointerId!==pointer?.id) return;
    const dx=event.clientX-pointer.x, dy=event.clientY-pointer.y;
    pointer.travel+=Math.hypot(dx,dy);
    if (pointer.travel>5) {
      const gain=68/dimensions().radius;
      turn(dy*gain,-dx*gain);
    }
    pointer.x=event.clientX; pointer.y=event.clientY;
  };
  function releasePointer(id) {
    if (id===pointer?.id) pointer=null;
    if (id===secondPointer?.id) secondPointer=null;
    if (!pointer && !secondPointer) pinching=false;
  }
  canvas.onpointerup = event => {
    if (!pinching && event.pointerId===pointer?.id && pointer.travel<=5) {
      const point = inspect(event);
      const now = performance.now();
      const double = lastTap && now-lastTap.time<430 &&
        Math.hypot(event.clientX-lastTap.x,event.clientY-lastTap.y)<24;
      if (point) select(point,double);
      lastTap = double ? null : {x:event.clientX,y:event.clientY,time:now};
    } else lastTap=null;
    releasePointer(event.pointerId);
  };
  canvas.onlostpointercapture=event=>releasePointer(event.pointerId);
  canvas.onpointercancel=event=>{ releasePointer(event.pointerId); lastTap=null; };
  canvas.onkeydown = event => {
    const controls = {
      ArrowUp:()=>turn(8,0), ArrowDown:()=>turn(-8,0),
      ArrowLeft:()=>turn(0,-8), ArrowRight:()=>turn(0,8),
      Enter:()=>select(view.center,false), '+':()=>magnify(1.23), '=':()=>magnify(1.23), '-':()=>magnify(1/1.23)
    };
    const invoke=controls[event.key];
    if (invoke) {event.preventDefault();event.stopPropagation();invoke();}
  };
  canvas.addEventListener('wheel',event=>{
    if (event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    magnify(event.deltaY<0?1.23:1/1.23);
  },{passive:false});
  const observer=new ResizeObserver(invalidate);
  observer.observe(canvas);
  invalidate();
  return {
    render:invalidate,
    dispose() {closed=true; observer.disconnect(); cancelAnimationFrame(request); texture.onload=preview.onload=preview.onerror=null;}
  };
}

export function createEarthExplorer(container,{initialSite,onOrbit,onSky}={}) {
  const panel=document.createElement('section');
  panel.className='earth-view';
  panel.setAttribute('aria-label','Exploration terrestre');
  panel.innerHTML=`
    <section class="earth-route" aria-label="Itinéraires terrestres">
      <label class="earth-field"><span>Itinéraire terrestre</span><select data-earth-tour>
        <option value="">Exploration libre</option>
      </select></label>
      <div class="earth-route-details" data-earth-tour-controls hidden>
        <div class="earth-route-stops">
          <button type="button" data-earth-tour-prev aria-label="Étape précédente">‹</button>
          <label class="earth-field">
            <span data-earth-tour-progress></span><select data-earth-tour-stop aria-label="Étape de l’itinéraire"></select>
          </label>
          <button type="button" data-earth-tour-next aria-label="Étape suivante">›</button>
          <button type="button" data-earth-tour-play>Lancer</button>
        </div>
        <output data-earth-tour-distance></output>
      </div>
    </section>
    <div class="earth-main">
      <figure class="earth-globe">
        <canvas data-earth-map tabindex="0" aria-label="Globe interactif. Glisse ou utilise les flèches pour tourner, puis sélectionne un point. Entrée sélectionne le centre."></canvas>
        <div class="earth-scale" aria-label="Ajuster le globe">
          <button type="button" data-earth-zoom="-1" aria-label="Éloigner le globe">−</button>
          <button type="button" data-earth-center aria-label="Centrer le globe sur la sélection" title="Centrer sur la sélection">◎</button>
          <button type="button" data-earth-zoom="1" aria-label="Rapprocher le globe">+</button>
        </div>
        <figcaption>Globe NASA Blue Marble · hors ligne</figcaption>
      </figure>
      <div class="earth-controls">
        <h3>Explorer la Terre</h3>
        <label class="earth-field"><span>Destination</span><select data-earth-site><option value="">Coordonnées libres</option></select></label>
        <form class="earth-coordinate-form" data-earth-position>
          <label class="earth-field"><span>Latitude</span><input data-earth-lat inputmode="text" spellcheck="false" placeholder="46,8124" required></label>
          <label class="earth-field"><span>Longitude</span><input data-earth-lon inputmode="text" spellcheck="false" placeholder="−71,1802" required></label>
          <button type="submit" class="earth-apply">Repérer</button>
        </form>
        <output data-earth-status role="status">Choisis un lieu ou touche le globe.</output>
        <div class="earth-observe">
          <button type="button" class="earth-apply" data-earth-sky hidden>Voir le ciel ici</button>
          <button type="button" class="earth-orbit earth-apply" data-earth-orbit hidden>Survoler ce lieu en orbite</button>
        </div>
        <div class="earth-links" aria-label="Ouvrir en ligne">
          <a data-earth-street target="_blank" rel="noopener noreferrer">Google Street View <span aria-hidden="true">↗</span></a>
          <a data-earth-satellite target="_blank" rel="noopener noreferrer">Google Maps satellite <span aria-hidden="true">↗</span></a>
          <a data-earth-open target="_blank" rel="noopener noreferrer">Google Earth <span aria-hidden="true">↗</span></a>
          <button type="button" data-earth-copy>Copier les coordonnées</button>
        </div>
        <p class="earth-provider-note">Accès Google par Internet. Street View ouvre le panorama le plus proche selon la couverture. Tu peux coller les coordonnées dans la recherche de Google Earth.</p>
      </div>
    </div>
    <details class="earth-embed" data-earth-embed>
      <summary>Afficher Street View dans SEABYSS</summary>
      <p>Ce mode utilise une clé Google Maps Embed API autorisée pour ce site. <a href="https://developers.google.com/maps/documentation/embed/get-api-key" target="_blank" rel="noopener noreferrer">Configurer une clé</a></p>
      <form data-earth-embed-form>
        <label class="earth-field"><span>Clé de navigateur Maps Embed API</span><input data-earth-key type="password" autocomplete="off" spellcheck="false" maxlength="160" required></label>
        <button type="submit" class="earth-apply">Afficher le panorama</button>
      </form>
      <p data-earth-embed-message role="status"></p>
      <div data-earth-panorama></div>
    </details>`;
  container.replaceChildren(panel);
  const $ = selector => panel.querySelector(selector);
  const menu=$('[data-earth-site]'), latitude=$('[data-earth-lat]'), longitude=$('[data-earth-lon]');
  const status=$('[data-earth-status]'), panorama=$('[data-earth-panorama]'), embed=$('[data-earth-embed]');
  const tourMenu=$('[data-earth-tour]'), tourControls=$('[data-earth-tour-controls]'), stops=$('[data-earth-tour-stop]');
  const previous=$('[data-earth-tour-prev]'), next=$('[data-earth-tour-next]'), playback=$('[data-earth-tour-play]');
  const distance=$('[data-earth-tour-distance]'), progress=$('[data-earth-tour-progress]');
  const keyField=$('[data-earth-key]');
  const embedMessage=$('[data-earth-embed-message]');
  const canEmbed = ['https:','http:'].includes(location.protocol) && location.hostname!=='univers.seabyss.invalid';
  embed.hidden = !canEmbed;
  const groups=new Map();
  for (const site of sites) {
    if (!groups.has(site.group)) {
      const group=document.createElement('optgroup');
      group.label=site.group;
      groups.set(site.group,group);
      menu.append(group);
    }
    groups.get(site.group).append(new Option(site.name,site.id));
  }
  for (const tour of tours) tourMenu.append(new Option(tour.name,tour.id));
  const favorite=observerPin(typeof initialSite==='string'?sitesById.get(initialSite):initialSite) || readPin() || observerPin(sites[0]);
  const view={center:{...favorite},pin:{...favorite},zoom:1,tour:null,stop:0,animating:false};
  const decimal = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:5,minimumFractionDigits:2,useGrouping:false});
  const kilometers = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:0});
  const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
  let playing=false, resumeAtStop=false, ticker=0, flightFrame=0;
  function update() {
    latitude.value=decimal.format(view.pin.latitude);
    longitude.value=decimal.format(view.pin.longitude);
    menu.value=sitesById.has(view.pin.id)?view.pin.id:'';
    status.value=view.pin.name || 'Point sélectionné';
    const links=earthExploreUrls(view.pin);
    $('[data-earth-street]').href=links.street;
    $('[data-earth-satellite]').href=links.satellite;
    $('[data-earth-open]').href=links.earth;
    globe.render();
  }
  function placePin(point, center=false) {
    const samePin=point.latitude===view.pin.latitude && point.longitude===view.pin.longitude;
    const next=observerPin(samePin?{...view.pin,...point}:point);
    if (!next) return;
    if (panorama.firstChild) {
      panorama.replaceChildren();
      embedMessage.textContent='Actualise le panorama pour le nouveau lieu.';
    }
    view.pin=next;
    if (center) view.center={...next};
    try { localStorage.setItem(coordinateKey,JSON.stringify(view.pin)); } catch {}
    update();
  }
  function select(point, center=false) {
    setTour('');
    placePin(point,center);
  }
  function magnify(factor) {
    view.zoom=clamp(view.zoom*factor,.72,3.3);
    globe.render();
  }
  function turn(latitudeDelta,longitudeDelta) {
    if (view.animating || playing) {
      pauseTour();
      syncTourControls();
    }
    view.center.latitude=clamp(view.center.latitude+latitudeDelta,-90,90);
    view.center.longitude=wrap(view.center.longitude+longitudeDelta);
    globe.render();
  }
  const globe=createGlobe($('[data-earth-map]'),{view,select,turn,magnify});
  function syncTourControls() {
    tourControls.hidden=!view.tour;
    if (!view.tour) return;
    const count=view.tour.stops.length;
    const position=view.stop;
    previous.disabled=position===0;
    next.disabled=position===count-1;
    playback.textContent=playing?'Pause':position===count-1&&!resumeAtStop?'Rejouer':'Lancer';
    playback.setAttribute('aria-pressed',String(playing));
    progress.textContent='Étape '+(position+1)+' / '+count;
    stops.value=String(position);
    const leg=view.tour.legs[Math.max(0,position-1)];
    const legLabel=position===0?'Prochain trajet':'Trajet depuis l’étape '+position;
    distance.textContent=legLabel+' · '+kilometers.format(leg.distance)+' km · Circuit '+kilometers.format(view.tour.distance)+' km';
  }
  function pauseTour() {
    if (playing && view.animating) resumeAtStop=true;
    playing=false;
    clearTimeout(ticker);
    cancelAnimationFrame(flightFrame);
    view.animating=false;
    globe.render();
  }
  function visit(position) {
    clearTimeout(ticker);
    cancelAnimationFrame(flightFrame);
    resumeAtStop=false;
    view.stop=position;
    const target=view.tour.stops[position];
    const arc=earthGreatCircle(view.center,target);
    const initialZoom=view.zoom;
    placePin(target);
    function arrive() {
      view.center={...target};
      view.zoom=1;
      view.animating=false;
      globe.render();
      if (playing && position+1<view.tour.stops.length) {
        ticker=setTimeout(()=>visit(position+1),2700);
      } else playing=false;
      syncTourControls();
    }
    if (motionPreference.matches || arc.distance<.2) {arrive();return;}
    const length=clamp(680+arc.distance*.085,680,1900);
    const start=performance.now();
    view.animating=true;
    syncTourControls();
    function animate(now) {
      const time=clamp((now-start)/length,0,1);
      const smooth=time*time*(3-2*time);
      view.center=arc.at(smooth);
      view.zoom=initialZoom+(1-initialZoom)*smooth;
      if (time===1) {arrive();return;}
      globe.render();
      flightFrame=requestAnimationFrame(animate);
    }
    flightFrame=requestAnimationFrame(animate);
  }
  function setTour(id) {
    if (!view.tour && !id) return;
    pauseTour();
    resumeAtStop=false;
    tourMenu.value=id;
    const definition=tours.find(tour=>tour.id===id);
    view.tour=definition ? buildTour(definition) : null;
    stops.replaceChildren(...(view.tour?.stops.map((site,index)=>new Option(site.name,index)) || []));
    if (view.tour) visit(0);
    else syncTourControls();
  }
  function seekStop(position) {
    pauseTour();
    visit(position);
  }
  update();
  tourMenu.onchange=()=>setTour(tourMenu.value);
  previous.onclick=()=>seekStop(view.stop-1);
  next.onclick=()=>seekStop(view.stop+1);
  stops.onchange=()=>seekStop(Number(stops.value));
  playback.onclick=()=>{
    if (playing) {pauseTour();syncTourControls();return;}
    playing=true;
    const last=view.tour.stops.length-1;
    visit(resumeAtStop || view.animating ? view.stop : view.stop===last ? 0 : view.stop+1);
  };
  menu.onchange=()=>{
    const next=sites.find(site=>site.id===menu.value);
    if (next) select(next,true);
    else latitude.focus();
  };
  const parse = input => {
    const value=input.value.trim().replace(',', '.').replace('−','-');
    return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : NaN;
  };
  function readPositionFields() {
    const point=selectCoordinates(parse(latitude),parse(longitude));
    if (!point) status.value='Latitude de −90° à 90° et longitude de −180° à 180°.';
    return point;
  }
  $('[data-earth-position]').onsubmit=event=>{
    event.preventDefault();
    const point=readPositionFields();
    if (point) select(point,true);
  };
  $('[data-earth-center]').onclick=()=>{
    if (view.animating || playing) {
      pauseTour();
      syncTourControls();
    }
    view.center={...view.pin};view.zoom=1;globe.render();
  };
  for (const button of panel.querySelectorAll('[data-earth-zoom]')) {
    button.onclick=()=>magnify(Number(button.dataset.earthZoom)>0?1.23:1/1.23);
  }
  $('[data-earth-copy]').onclick=async()=>{
    try {
      await navigator.clipboard.writeText(coordinates(view.pin));
      status.value='Coordonnées copiées.';
    } catch {status.value=coordinates(view.pin);}
  };
  const orbit=$('[data-earth-orbit]');
  orbit.hidden=typeof onOrbit!=='function';
  orbit.onclick=()=>onOrbit?.(view.pin.latitude,view.pin.longitude);
  const sky=$('[data-earth-sky]');
  sky.hidden=typeof onSky!=='function';
  sky.onclick=()=>{
    const point=readPositionFields();
    if (!point) return;
    if (point.latitude!==view.pin.latitude || point.longitude!==view.pin.longitude) select(point,true);
    onSky?.({...view.pin});
  };
  $('[data-earth-embed-form]').onsubmit=event=>{
    event.preventDefault();
    if (!canEmbed) return;
    const key=keyField.value.trim();
    if (!/^[a-zA-Z0-9_-]{20,160}$/.test(key)) {
      embedMessage.textContent='Saisis une clé Google Maps Embed API valide.';
      return;
    }
    const frame=document.createElement('iframe');
    frame.title='Panorama Google Street View';
    frame.referrerPolicy='strict-origin-when-cross-origin';
    frame.allowFullscreen=true;
    frame.src=earthExploreUrls(view.pin,key).embed;
    panorama.replaceChildren(frame);
    embedMessage.textContent='';
  };
  embed.ontoggle=()=>{
    if (embed.open) return;
    panorama.replaceChildren();
    keyField.value='';
    embedMessage.textContent='';
  };
  return () => { pauseTour(); globe.dispose(); panorama.replaceChildren(); keyField.value=''; };
}
