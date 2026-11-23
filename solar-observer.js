import { assetUrl } from './assets.js';

const latest = 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMII.jpg';
const archive = 'https://sdo.gsfc.nasa.gov/assets/img/browse/2026/11/23/20261123_000000_4096_HMIIF.jpg';
// NOAA SWPC / USAF Solar Region Summary issued 23 Nov 2026 at 00:30 UTC.
// https://services.swpc.noaa.gov/text/srs.txt
const reportTime = '2026-11-23T00:00:00Z';
const regions = [
  {id:4579, latitude:15, west:36, location:'N15 W36', spots:1, magnetic:'Alpha'},
  {id:4581, latitude:-8, west:1, location:'S08 W01', spots:2, magnetic:'Bêta'}
];
const formatter = new Intl.DateTimeFormat('fr-CA', {
  timeZone:'UTC', year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
});
function formatTime(value) {
  const stamp = typeof value==='string' ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? formatter.format(stamp)+' UTC' : '';
}

// Earth heliographic latitude at the report epoch, computed from the solar
// north pole and heliocentric Earth vector (Astronomy Engine, J2000).
const radians = Math.PI/180, tilt = 1.9225*radians;
function project(latitude, westLongitude) {
  const lat=latitude*radians, lon=westLongitude*radians;
  const c=Math.cos(lat), s=Math.sin(lat), meridian=c*Math.cos(lon);
  return {x:c*Math.sin(lon), y:s*Math.cos(tilt)-meridian*Math.sin(tilt),
    facing:s*Math.sin(tilt)+meridian*Math.cos(tilt)};
}

function drawReport(canvas, chosen) {
  const rect=canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return [];
  const ratio=Math.min(2,window.devicePixelRatio||1);
  canvas.width=Math.round(rect.width*ratio); canvas.height=Math.round(rect.height*ratio);
  const ctx=canvas.getContext('2d');
  if (!ctx) return [];
  ctx.setTransform(ratio,0,0,ratio,0,0);
  const cx=rect.width/2, cy=rect.height/2, radius=Math.max(1,Math.min(cx-31,cy-25));
  const xy=p=>({x:cx+radius*p.x,y:cy-radius*p.y});
  ctx.clearRect(0,0,rect.width,rect.height);
  ctx.fillStyle='#1b2022'; ctx.beginPath(); ctx.arc(cx,cy,radius,0,2*Math.PI); ctx.fill();
  ctx.strokeStyle='#dab17a';ctx.lineWidth=1.3;ctx.stroke();
  function line(start,end,point) {
    let visible=false;
    ctx.beginPath();
    for(let t=start;t<=end;t+=2) {
      const p=point(t);
      if(p.facing<0){visible=false;continue;}
      const {x,y}=xy(p);
      if(visible)ctx.lineTo(x,y);else ctx.moveTo(x,y);
      visible=true;
    }
    ctx.stroke();
  }
  ctx.lineWidth=.8;ctx.strokeStyle='#586260';
  for(let latitude=-60;latitude<=60;latitude+=30)line(-180,180,t=>project(latitude,t));
  for(let west=-90;west<=90;west+=30)line(-90,90,t=>project(t,west));
  ctx.font='12px system-ui';ctx.fillStyle='#c8cdc4';ctx.textAlign='center';ctx.textBaseline='middle';
  for (const [letter,x,y] of [['N',cx,cy-radius-13],['S',cx,cy+radius+13],
    ['E',cx-radius-15,cy],['O',cx+radius+15,cy]]) ctx.fillText(letter,x,y);
  const markers=[];
  for(const region of regions) {
    const {x,y}=xy(project(region.latitude,region.west));
    const selected=region.id===chosen;
    ctx.strokeStyle=selected?'#ffd090':'#b2e1df'; ctx.lineWidth=selected?2:1.5;
    ctx.beginPath();ctx.arc(x,y,selected?8:6,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle=ctx.strokeStyle;ctx.font='bold 12px system-ui';ctx.textAlign='left';
    const right=x+52<rect.width;
    ctx.textAlign=right?'left':'right';
    ctx.fillText(''+region.id,x+(right?12:-12),y-12);
    markers.push({x,y,region});
  }
  return markers;
}

function loadPhoto(src) {
  const img=new Image();
  img.alt='Photographie du disque solaire en lumière visible par SDO/HMI';
  img.decoding='async';img.referrerPolicy='no-referrer';img.draggable=false;
  let settle;
  const done=new Promise(resolve=>{settle=resolve;});
  let timer;
  function finish(result) {
    clearTimeout(timer);img.onload=img.onerror=null;settle(result);
  }
  img.onload=()=>finish(img.naturalWidth>=256 && img.naturalHeight>=256?img:null);
  img.onerror=()=>finish(null);
  timer=setTimeout(()=>{finish(null);img.removeAttribute('src');},9000);
  img.src=src;
  return {done,cancel(){if(img.onload){finish(null);img.removeAttribute('src');}}};
}

const mark = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m6 6 12 12m0-12L6 18" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
export function createSolarObserver(root,{onExit,onChange}={}) {
  root.innerHTML=`
    <header class="solar-heading"><div><p>SEABYSS</p><h1>Soleil observé</h1></div>
      <button type="button" data-solar-exit aria-label="Quitter l’observation solaire" title="Quitter">${mark}</button></header>
    <div class="solar-body">
      <section class="solar-observation" aria-label="Observation solaire">
        <div class="solar-view-tabs" aria-label="Vue de l’observatoire">
          <button type="button" data-solar-photo>Photographie</button><button type="button" data-solar-map>Carte NOAA</button></div>
        <div class="solar-field"><div class="solar-image-area" data-solar-viewport hidden></div>
          <canvas data-solar-canvas aria-label="Carte des régions solaires. Le nord est en haut et l’ouest à droite."></canvas>
          <p class="solar-empty" data-solar-empty hidden></p></div>
        <div class="solar-caption"><div><strong data-solar-caption></strong><span data-solar-date></span></div>
          <button type="button" data-solar-zoom hidden aria-pressed="false">Agrandir ×2</button></div>
      </section>
      <aside class="solar-notes">
        <section><h2>Photosphère</h2><p>HMI, à bord de l’observatoire solaire SDO, photographie le disque en lumière visible. Les taches solaires apparaissent plus sombres que leur voisinage.</p>
          <p class="solar-status" data-solar-status role="status"></p>
          <div class="solar-links"><button type="button" data-solar-refresh>Actualiser la photo</button>
          <a data-solar-source href="${archive}" target="_blank" rel="noopener noreferrer">Image NASA ↗</a></div></section>
        <section><h2>Régions actives</h2><p>Relevé NOAA du <time datetime="${reportTime}">23 novembre 2026 à 00 h UTC</time>. Chaque cercle situe le centre d’une région recensée.</p>
          <div class="solar-regions" data-solar-regions></div><p data-solar-selection class="solar-selection"></p>
          <a href="https://www.spaceweather.gov/products/solar-region-summary" target="_blank" rel="noopener noreferrer">Bulletins NOAA ↗</a></section>
      </aside>
    </div>`;
  const $=name=>root.querySelector('[data-solar-'+name+']');
  const canvas=$('canvas'), viewport=$('viewport'), photoTab=$('photo'), mapTab=$('map');
  let revision=0, active=false, mode='photo', explicit=false, selected=regions[0].id;
  let photo=null, pending=false, latestUnavailable=false, zoom=false, markers=[], observer, abort, requests=[];
  const save=()=>onChange?.(serialize());
  function serialize(){return {version:1,mode,selected};}
  function cancel() {
    revision++; abort?.abort();abort=null;
    for (const request of requests)request.cancel();
    requests=[];
  }
  function paint() {
    const map=mode==='map'||(!photo && !explicit);
    photoTab.setAttribute('aria-pressed',String(!map));
    mapTab.setAttribute('aria-pressed',String(map));
    canvas.hidden=!map;
    viewport.hidden=map||!photo;
    $('empty').hidden=map||!!photo;
    $('empty').textContent=pending?'Chargement de la photographie…':'Photographie indisponible. La carte NOAA reste consultable.';
    $('caption').textContent=map?'Carte des régions à taches':latestUnavailable&&photo?.rank===3?'Cliché précédent · SDO/HMI':photo?.title||'Photographie SDO/HMI';
    $('date').textContent=map?formatTime(reportTime):photo?.stamp||'HMI · Continuum visible';
    $('source').href=photo?.source||archive;
    $('zoom').hidden=map||!photo;
    $('zoom').textContent=zoom?'Vue entière':'Agrandir ×2';
    $('zoom').setAttribute('aria-pressed',String(zoom));
    viewport.classList.toggle('solar-zoomed',zoom);
    if(photo && viewport.firstChild!==photo.img)viewport.replaceChildren(photo.img);
    if(map)markers=drawReport(canvas,selected);
    for(const button of $('regions').children)button.setAttribute('aria-pressed',String(Number(button.value)===selected));
    const r=regions.find(x=>x.id===selected);
    $('selection').textContent='AR '+r.id+' · '+r.location+' · Classe magnétique '+r.magnetic+'.';
    $('status').textContent=(latestUnavailable&&photo?'Actualisation indisponible. ':'')+
      (photo?.detail||(pending?'Recherche du cliché SDO/HMI.':'Photo indisponible. La carte NOAA embarquée fonctionne hors ligne.'));
  }
  function chooseRegion(id) {
    selected=id;mode='map';explicit=true;zoom=false;paint();save();
  }
  for(const region of regions) {
    const button=document.createElement('button');button.type='button';button.value=String(region.id);
    button.dataset.solarRegion=region.id;button.setAttribute('aria-label','Région '+region.id+', '+region.location);
    const number=document.createElement('strong'),count=document.createElement('span');
    number.textContent='AR '+region.id;count.textContent=region.spots+' tache'+(region.spots===1?'':'s');
    button.append(number,count);button.onclick=()=>chooseRegion(region.id);$('regions').append(button);
  }
  async function fetchImage(src) {
    const request=loadPhoto(src);requests.push(request);
    return request.done;
  }
  async function bundled(token,signal) {
    try {
      const response=await fetch(assetUrl('solar-frame.json'),{signal});
      if(!response.ok)return;
      const data=await response.json();
      if(token!==revision||!/^solar-photosphere(?:-[\da-f]{12})?\.jpg$/.test(data.image||''))return;
      const img=await fetchImage(assetUrl(data.image));
      if(!img||token!==revision||(photo && photo.rank>=2))return;
      const observed=formatTime(data.observedAt),retrieved=formatTime(data.retrievedAt);
      const source=typeof data.source==='string'&&data.source.startsWith('https://sdo.gsfc.nasa.gov/')?data.source:archive;
      photo={img,source,rank:2,title:'Archive embarquée · SDO/HMI',
        stamp:observed||'Heure d’observation inscrite sur le cliché (UTC)',
        detail:retrieved?'Copie embarquée récupérée le '+retrieved+'.':'Photographie NASA embarquée, disponible hors ligne.'};
      paint();
    } catch { /* The standalone edition can be compiled before the first acquisition. */ }
  }
  async function refresh() {
    cancel();const token=revision;
    pending=true;latestUnavailable=navigator.onLine===false;abort=new AbortController();paint();
    const localWork=bundled(token,abort.signal);
    if(navigator.onLine!==false){
      const img=await fetchImage(latest);
      if(token!==revision)return;
      latestUnavailable=!img;
      if(img)photo={img,source:latest,rank:3,title:'Dernier cliché diffusé · SDO/HMI',
        stamp:'Heure d’observation inscrite sur le cliché (UTC)',detail:'Dernière photographie reçue de NASA/SDO. Lis l’horodatage imprimé sur le cliché.'};
      paint();
    }
    await localWork;
    if(token!==revision)return;
    if(!photo && navigator.onLine!==false) {
      const img=await fetchImage(archive);
      if(token!==revision)return;
      if(img)photo={img,source:archive,rank:1,title:'Archive du 23 novembre · SDO/HMI',stamp:formatTime(reportTime),detail:'Photographie d’archive NASA/SDO du 23 novembre 2026.'};
    }
    pending=false;paint();
  }
  photoTab.onclick=()=>{explicit=true;mode='photo';paint();save();};
  mapTab.onclick=()=>{explicit=true;mode='map';zoom=false;paint();save();};
  $('refresh').onclick=()=>refresh();
  $('zoom').onclick=()=>{
    zoom=!zoom;paint();viewport.scrollLeft=(viewport.scrollWidth-viewport.clientWidth)/2;
    viewport.scrollTop=(viewport.scrollHeight-viewport.clientHeight)/2;
  };
  canvas.onclick=event=>{
    const b=canvas.getBoundingClientRect();
    const hit=markers.find(p=>Math.hypot(event.clientX-b.left-p.x,event.clientY-b.top-p.y)<22);
    if(hit)chooseRegion(hit.region.id);
  };
  $('exit').onclick=()=>onExit?.();
  root.onkeydown=e=>{if(e.key==='Escape'&&!e.defaultPrevented){e.preventDefault();onExit?.();}};
  observer=new ResizeObserver(()=>{if(active&&!canvas.hidden)markers=drawReport(canvas,selected);});
  function open({snapshot}={}) {
    active=true;root.hidden=false;
    explicit=snapshot?.version===1 && snapshot.mode==='map';mode=explicit?'map':'photo';
    selected=regions.some(r=>r.id===snapshot?.selected)?snapshot.selected:regions[0].id;
    photo=null;viewport.replaceChildren();zoom=false;
    observer.observe(canvas.parentElement);refresh();return true;
  }
  function close(){active=false;cancel();pending=false;observer.disconnect();root.hidden=true;}
  return {open,close,serialize,tick(){},dispose(){close();root.replaceChildren();}};
}
