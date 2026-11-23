import { assetUrl } from './assets.js';
import { LIGHT_YEAR } from './catalog.js';

const rad = Math.PI / 180;
const clamp = (n,lo,hi) => Math.max(lo,Math.min(hi,n));
const wrap = degrees => ((degrees % 360) + 360) % 360;
const site = {latitude:46.8, longitude:-71.18333};
const families = {star:'Étoiles',planet:'Exoplanètes',nebula:'Nébuleuses',cluster:'Amas',galaxy:'Galaxies'};
const symbols = {star:'#e4c394',planet:'#9bd6bf',nebula:'#ed9aba',cluster:'#93c5eb',galaxy:'#d2abec'};
const number = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const clock = new Intl.DateTimeFormat('fr-CA',{timeZone:'America/Toronto',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

function direction(ra,dec) {
  const a=ra*rad, d=dec*rad, c=Math.cos(d);
  return [c*Math.sin(a),Math.sin(d),-c*Math.cos(a)];
}
function coordinates(vec) {
  const length = Math.hypot(...vec);
  return {ra:wrap(Math.atan2(vec[0],-vec[2])/rad),dec:Math.asin(clamp(vec[1]/length,-1,1))/rad};
}
function axes(ra,dec) {
  return {front:direction(ra,dec),east:direction(ra+90,0),north:direction(ra,dec+90)};
}

// Stereographic finder. The celestial east is at the left when looking up.
// The field value is the angle spanning the shorter screen dimension.
export function skyProjection(ra,dec,field,width,height) {
  const {front,east,north} = axes(ra,dec);
  const scale = Math.min(width,height)/2/Math.tan(field*rad/4);
  return {
    project(vec) {
      const denominator = 1+dot(front,vec);
      if (denominator < .045) return null;
      return [width/2-scale*dot(east,vec)/denominator,height/2-scale*dot(north,vec)/denominator];
    },
    directionAt(x,y) {
      const u=(width*.5-x)/scale, v=(height*.5-y)/scale, r2=u*u+v*v, d=1+r2;
      return front.map((n,i) => ((1-r2)*n+2*u*east[i]+2*v*north[i])/d);
    },
    scale
  };
}

// Mean sidereal time; the local horizon is a geometric approximation for the
// J2000 finder, independent of the Universe Explorer simulation clock.
export function levisHorizon(milliseconds) {
  const days = milliseconds/86400000+2440587.5-2451545;
  const t = days/36525;
  const meridian = wrap(280.46061837+360.98564736629*days+.000387933*t*t-t*t*t/38710000+site.longitude);
  const basis = axes(meridian,site.latitude);
  return {
    zenith:basis.front,
    horizontal(vec) {
      return {altitude:Math.asin(clamp(dot(vec,basis.front),-1,1))/rad,
        azimuth:wrap(Math.atan2(dot(vec,basis.east),dot(vec,basis.north))/rad)};
    },
    at(azimuth) {
      const a=azimuth*rad;
      return basis.north.map((n,i)=>n*Math.cos(a)+basis.east[i]*Math.sin(a));
    }
  };
}

function positionLabel(pos) {
  const total=Math.round(pos.ra/15*60)%1440;
  const decl=Math.round(Math.abs(pos.dec)*60);
  return Math.floor(total/60)+' h '+String(total%60).padStart(2,'0')+' min  ·  '+
    (pos.dec<0?'−':'+')+Math.floor(decl/60)+'° '+String(decl%60).padStart(2,'0')+'′';
}
function distanceLabel(km) {
  const ly=km/LIGHT_YEAR;
  if (ly>=1e6) return number.format(ly/1e6)+' M al';
  if (ly>=1000) return number.format(ly/1000)+' k al';
  return number.format(ly)+' al';
}
function colorIndex(bv) {
  if (bv===null) return '#d6dce8';
  if (bv<.05) return '#abc6ff';
  if (bv<.4) return '#ccdfff';
  if (bv<.8) return '#f0ece4';
  if (bv<1.25) return '#edd2ae';
  return '#eeac84';
}
let cataloguePromise;
function loadStars() {
  if (!cataloguePromise) {
    cataloguePromise = fetch(assetUrl('sky-stars.txt')).then(result => {
      if (!result.ok) throw new Error('Étoiles indisponibles.');
      return result.json();
    }).then(data => {
      const stars=data.stars.map(([hip,ra,dec,mag,bv,name]) => ({
        id:'hip-'+hip,name:name || 'HIP '+hip,designation:'HIP '+hip,kind:'field',ra:wrap(ra),dec,mag,
        color:colorIndex(bv),vec:direction(ra,dec),named:Boolean(name)
      }));
      const figures=data.figures.map(([code,name,ra,dec,segments]) => ({
        code,name,vec:direction(ra,dec),lines:segments.map(points=>{
          const line=[]; for(let i=0;i<points.length;i+=2) line.push(direction(points[i],points[i+1]));
          return line;
        })
      }));
      return {stars,figures};
    }).catch(error => {cataloguePromise=undefined;throw error;});
  }
  return cataloguePromise;
}
function chartDestinations(objects) {
  const earth=objects.find(body=>body.id==='earth')?.position || [0,0,0];
  return objects.filter(b=>!b.simulated && b.id!=='sun' && b.id!=='milky-way' &&
    (['galaxy','nebula','cluster','star'].includes(b.kind) || (b.kind==='planet' && b.system))).map(b=>{
    const offset=b.position.map((v,i)=>v-earth[i]), km=Math.hypot(...offset), vec=offset.map(v=>v/km);
    return {id:b.id,name:b.name,designation:b.designation||'',kind:b.kind,category:b.category,color:symbols[b.kind],
      ...coordinates(vec),vec,km,radius:b.radius,system:b.system};
  });
}
function make(tag,cls,value) {
  const el=document.createElement(tag); if(cls) el.className=cls;
  if(value!==undefined) el.textContent=value;
  return el;
}
function field(title,control) {
  const label=make('label','sky-field');label.append(make('span','',title),control);return label;
}
function button(text,label) {
  const b=make('button','',text);b.type='button';
  if(label){b.setAttribute('aria-label',label);b.title=label;}
  return b;
}

export function createSkyObserver(container,{objects,travel,currentId,onEarthSky}) {
  const root=make('section','sky-observer');
  root.setAttribute('aria-label','Planétarium équatorial');
  const controls=make('div','sky-filters');
  const search=make('input');search.type='search';search.placeholder='Nom, M42, HIP…';search.dataset.skySearch='';
  const family=make('select');family.dataset.skyKind='';
  family.add(new Option('Toutes les familles','all'));
  Object.entries(families).forEach(([k,n])=>family.add(new Option(n,k)));
  const target=make('select');target.dataset.skyTarget='';
  controls.append(field('Rechercher',search),field('Famille',family),field('Objet',target));
  const frame=make('div','sky-frame');
  const canvas=make('canvas');canvas.dataset.skyCanvas='';canvas.tabIndex=0;
  canvas.setAttribute('aria-label','Carte du ciel. Glisse ou utilise les flèches pour parcourir, plus et moins pour zoomer. Touche un repère pour le sélectionner.');
  const compass=make('div','sky-compass','N ↑   E ←');compass.setAttribute('aria-hidden','true');
  const settings=make('div','sky-settings');
  const constellation=button('Tracés','Tracés des constellations');constellation.dataset.skyFigures='';
  const horizon=button('Horizon de Lévis','Afficher l’horizon actuel de Lévis');horizon.dataset.skyHorizon='';
  settings.append(constellation,horizon);
  const zoomBar=make('div','sky-zoom');
  const out=button('−','Élargir le champ');out.dataset.skyZoom='out';
  const inside=button('+','Resserrer le champ');inside.dataset.skyZoom='in';
  const center=button('◎','Recentrer sur la sélection');center.dataset.skyCenter='';
  zoomBar.append(out,inside,center);
  const scale=make('output','sky-scale');scale.dataset.skyFov='';
  frame.append(canvas,compass,settings,zoomBar,scale);
  const info=make('div','sky-info'), copy=make('div','sky-copy');
  const type=make('span','sky-type'), title=make('strong','sky-name'), coords=make('span','sky-position');
  const alt=make('span','sky-alt');alt.dataset.skyAltitude='';
  copy.append(type,title,coords,alt);
  const fly=button('Rejoindre');fly.className='primary-btn sky-travel';fly.dataset.skyTravel='';
  info.append(copy,fly);
  const note=make('p','sky-note','Glisse pour parcourir le ciel et touche un repère pour l’identifier. La carte montre les directions (J2000). Les distances sont exprimées en années-lumière.');
  root.append(controls,frame,info,note);container.append(root);
  if (onEarthSky) {
    const local=button('Ciel terrestre','Observer le Soleil, la Lune et les planètes depuis un lieu');
    local.className='chart-secondary';local.onclick=onEarthSky;root.append(local);
  }

  const destinations=chartDestinations(objects);
  const lookup=new Map(destinations.map(b=>[b.id,b]));
  let selected=lookup.get(currentId) || lookup.get('orion-nebula') || destinations[0];
  let pointing={ra:selected.ra,dec:selected.dec}, fov=57;
  let stars=[],figures=[],showFigures=true,showHorizon=false,disposed=false;
  let width=1,height=1,projection=null,visible=[],starHits=[],raf=0;
  let pointerStart,dragged=false,gradient;
  const pointers=new Map();
  const ctx=canvas.getContext('2d');
  const samples=36, shade=document.createElement('canvas');
  shade.width=shade.height=samples;
  const shadeContext=shade.getContext('2d'), water=shadeContext.createImageData(samples,samples);
  const checkpoints=[];
  function refreshDetails() {
    type.textContent=selected.kind==='field'?'Étoile de repérage':selected.category;
    title.textContent=selected.name;
    coords.textContent=positionLabel(selected)+'   ·   '+(selected.kind==='field'?
      selected.designation+' · mag. '+number.format(selected.mag):distanceLabel(selected.km));
    fly.hidden=selected.kind==='field';fly.setAttribute('aria-label','Rejoindre '+selected.name);
    alt.hidden=!showHorizon;
    if(showHorizon){
      const now=Date.now(), h=levisHorizon(now).horizontal(selected.vec);
      alt.textContent='Lévis · '+clock.format(now)+' · hauteur '+(h.altitude<0?'−':'+')+number.format(Math.abs(h.altitude))+'° · azimut '+Math.round(h.azimuth)%360+'°';
    }
    scale.textContent='Champ '+number.format(fov)+'°';scale.dataset.skyFov=String(fov);
    constellation.setAttribute('aria-pressed',String(showFigures));
    horizon.setAttribute('aria-pressed',String(showHorizon));
    inside.disabled=fov<=7;out.disabled=fov>=120;
  }
  function searchText(b) {return normalize([b.name,b.designation,b.system||''].join(' '));}
  function fillTargets() {
    const q=normalize(search.value),filter=family.value;
    const matches=destinations.filter(d=>(filter==='all'||d.kind===filter)&&searchText(d).includes(q));
    if(q && (filter==='all'||filter==='star')){
      for(const s of stars) if(searchText(s).includes(q)) matches.push(s);
    }
    if(!q && selected.kind==='field' && !matches.includes(selected) && (filter==='all'||filter==='star')) matches.push(selected);
    matches.sort((a,b)=>a.name.localeCompare(b.name,'fr'));
    target.replaceChildren(...matches.map(d=>new Option(d.name,d.id)));
    if(matches.some(d=>d.id===selected.id)) target.value=selected.id;
    if(!matches.length)target.add(new Option('Aucun objet',''));
    target.disabled=fly.disabled=!matches.length;
    return matches;
  }
  function pick(b,recenter,fromCanvas=false) {
    if(!b)return;
    selected=b;
    if(fromCanvas){search.value='';family.value='all';}
    if(recenter) pointing={ra:b.ra,dec:b.dec};
    fillTargets();refreshDetails();queue();
  }
  function updateFilter() {
    const list=fillTargets();
    if(list.length && !list.some(b=>b.id===selected.id)) pick(list[0],true);
    queue();
  }
  search.oninput=updateFilter;family.onchange=updateFilter;
  target.onchange=()=>pick(lookup.get(target.value),true);
  fly.onclick=()=>{if(selected.kind!=='field')travel(selected.id);};
  center.onclick=()=>pick(selected,true);
  horizon.onclick=()=>{showHorizon=!showHorizon;refreshDetails();queue();};
  constellation.onclick=()=>{showFigures=!showFigures;refreshDetails();queue();};

  function queue() {if(!disposed && !raf) raf=requestAnimationFrame(draw);}
  function resize() {
    width=frame.clientWidth;height=frame.clientHeight;
    const ratio=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
    ctx.setTransform(ratio,0,0,ratio,0,0);
    gradient=ctx.createRadialGradient(width*.44,height*.46,0,width*.5,height*.5,Math.max(width,height)*.8);
    gradient.addColorStop(0,'#101b2b');gradient.addColorStop(.65,'#080f1a');gradient.addColorStop(1,'#050a10');
    queue();
  }
  function pan(dx,dy){
    const perPixel=fov/Math.min(width,height);
    pointing={ra:wrap(pointing.ra+dx*perPixel/Math.max(.18,Math.cos(pointing.dec*rad))),
      dec:clamp(pointing.dec+dy*perPixel,-89.9,89.9)};
    queue();
  }
  function zoom(factor,x=width/2,y=height/2) {
    const before=skyProjection(pointing.ra,pointing.dec,fov,width,height);
    const anchor=coordinates(before.directionAt(x,y));
    fov=clamp(fov*factor,7,120);
    for(let i=0;i<2;i++){
      const after=skyProjection(pointing.ra,pointing.dec,fov,width,height);
      const actual=coordinates(after.directionAt(x,y));
      pointing.ra=wrap(pointing.ra+((anchor.ra-actual.ra+540)%360-180));
      pointing.dec=clamp(pointing.dec+anchor.dec-actual.dec,-89.9,89.9);
    }
    refreshDetails();queue();
  }
  inside.onclick=()=>zoom(.72);out.onclick=()=>zoom(1/.72);
  function local(e) {const box=canvas.getBoundingClientRect();return [e.clientX-box.left,e.clientY-box.top];}
  canvas.onpointerdown=e=>{
    if(e.button!==0)return;
    const p=local(e);canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,p);
    if(pointers.size===1){pointerStart=p;dragged=false;}else dragged=true;
  };
  canvas.onpointermove=e=>{
    const from=pointers.get(e.pointerId);if(!from)return;
    const to=local(e);pointers.set(e.pointerId,to);
    if(pointers.size===2){
      const other=[...pointers].find(([id])=>id!==e.pointerId)[1];
      const oldD=Math.hypot(from[0]-other[0],from[1]-other[1]),newD=Math.hypot(to[0]-other[0],to[1]-other[1]);
      if(oldD>2&&newD>2){zoom(oldD/newD,(from[0]+other[0])/2,(from[1]+other[1])/2);pan((to[0]-from[0])/2,(to[1]-from[1])/2);}
    } else {
      if(pointerStart&&Math.hypot(to[0]-pointerStart[0],to[1]-pointerStart[1])>4)dragged=true;
      if(dragged)pan(to[0]-from[0],to[1]-from[1]);
    }
  };
  canvas.onpointerup=e=>{
    const p=local(e);
    if(!dragged && pointers.size===1) {
      const near=(list,limit)=>list.map(h=>[h.b,Math.hypot(p[0]-h.x,p[1]-h.y)]).filter(h=>h[1]<limit).sort((a,b)=>a[1]-b[1])[0]?.[0];
      pick(near(visible,16)||near(starHits,10),false,true);
    }
    pointers.delete(e.pointerId);
  };
  canvas.onpointercancel=e=>{dragged=true;pointers.delete(e.pointerId);};
  canvas.onlostpointercapture=e=>pointers.delete(e.pointerId);
  canvas.addEventListener('wheel',e=>{if(e.ctrlKey)return;e.preventDefault();zoom(Math.exp(clamp(e.deltaY,-220,220)*.002),...local(e));},{passive:false});
  canvas.onkeydown=e=>{
    if(e.key==='+'||e.key==='=')zoom(.8);
    else if(e.key==='-')zoom(1.25);
    else if(e.key==='Home')pick(selected,true);
    else if(e.key.startsWith('Arrow'))pan((Number(e.key==='ArrowRight')-Number(e.key==='ArrowLeft'))*42,(Number(e.key==='ArrowDown')-Number(e.key==='ArrowUp'))*42);
    else return;
    e.preventDefault();
  };
  function line(points) {
    let prev=null;
    for(const v of points){
      const p=projection.project(v);
      if(p && prev && Math.hypot(p[0]-prev[0],p[1]-prev[1]) < Math.max(width,height)*.7) {ctx.moveTo(prev[0],prev[1]);ctx.lineTo(p[0],p[1]);}
      prev=p;
    }
  }
  function path(points,color,weight=1) {
    ctx.beginPath();line(points);ctx.strokeStyle=color;ctx.lineWidth=weight;ctx.stroke();
  }
  const step=5, grid=[];
  for(let lon=0;lon<360;lon+=30) {
    const meridian=[]; for(let lat=-85;lat<=85;lat+=step)meridian.push(direction(lon,lat));grid.push(meridian);
  }
  for(let lat=-75;lat<=75;lat+=15) {
    const parallel=[];for(let lon=0;lon<=360;lon+=step)parallel.push(direction(lon,lat));grid.push(parallel);
  }
  function drawHorizon() {
    const h=levisHorizon(Date.now());
    // A coarse tint marks the half-sky below the horizon. Stroke an independent
    // great circle at full resolution so its edge stays sharp while zooming.
    for(let row=0;row<samples;row++)for(let col=0;col<samples;col++){
      const below=dot(h.zenith,projection.directionAt((col+.5)*width/samples,(row+.5)*height/samples));
      const i=(row*samples+col)*4;
      water.data[i]=65;water.data[i+1]=92;water.data[i+2]=86;water.data[i+3]=below<0?38:0;
    }
    shadeContext.putImageData(water,0,0);ctx.drawImage(shade,0,0,width,height);
    const circle=[];for(let a=0;a<=360;a+=3)circle.push(h.at(a));
    ctx.setLineDash([7,4]);path(circle,'#8cbfa1',1.2);ctx.setLineDash([]);
    ctx.font='600 11px system-ui';ctx.fillStyle='#b1e3c2';ctx.textAlign='center';
    ['N','E','S','O'].forEach((tag,i)=>{const p=projection.project(h.at(i*90));if(p)ctx.fillText(tag,p[0],p[1]-5);});
  }
  function inFrame(p,m=7) {return p && p[0]>-m && p[1]>-m && p[0]<width+m && p[1]<height+m;}
  function label(text,x,y,color,important=false,style='12px system-ui') {
    ctx.font=style;ctx.textAlign='left';
    const w=ctx.measureText(text).width, x0=clamp(x,4,width-w-4),y0=clamp(y,16,height-7);
    const rect=[x0-2,y0-11,x0+w+2,y0+3];
    if(!important && checkpoints.some(r=>r[0]<rect[2]&&r[2]>rect[0]&&r[1]<rect[3]&&r[3]>rect[1]))return;
    checkpoints.push(rect);ctx.lineJoin='round';ctx.lineWidth=3;ctx.strokeStyle='#07101bf2';
    ctx.strokeText(text,x0,y0);ctx.fillStyle=color;ctx.fillText(text,x0,y0);
  }
  function marker(b,x,y) {
    const r=b===selected?7:4;ctx.lineWidth=b===selected?1.7:1.15;ctx.strokeStyle=b.color;ctx.beginPath();
    if(b.kind==='galaxy')ctx.ellipse(x,y,r*1.35,r*.52,-.5,0,Math.PI*2);
    else if(b.kind==='nebula'){ctx.moveTo(x,y-r);ctx.lineTo(x+r,y);ctx.lineTo(x,y+r);ctx.lineTo(x-r,y);ctx.closePath();}
    else if(b.kind==='cluster'){ctx.setLineDash([2,2]);ctx.arc(x,y,r,0,Math.PI*2);}
    else {ctx.moveTo(x-r,y);ctx.lineTo(x+r,y);ctx.moveTo(x,y-r);ctx.lineTo(x,y+r);}
    ctx.stroke();ctx.setLineDash([]);
  }
  function draw() {
    raf=0;if(disposed||width<2||height<2)return;
    projection=skyProjection(pointing.ra,pointing.dec,fov,width,height);
    ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);
    ctx.beginPath();grid.forEach(line);ctx.strokeStyle='rgba(140,176,200,.11)';ctx.lineWidth=.8;ctx.stroke();
    if(showFigures){
      ctx.beginPath();figures.forEach(figure=>figure.lines.forEach(line));ctx.strokeStyle='rgba(117,183,207,.38)';ctx.lineWidth=1;ctx.stroke();
    }
    starHits=[];visible=[];checkpoints.length=0;
    for(const s of stars) {
      const p=projection.project(s.vec);if(!inFrame(p))continue;
      const [x,y]=p,brightness=clamp((5.8-s.mag)/6.2,0,1),radius=.7+brightness**1.55*2.35;
      ctx.fillStyle=s.color;ctx.globalAlpha=.53+brightness*.47;
      if(s.mag<1.85) {
        const halo=ctx.createRadialGradient(x,y,0,x,y,radius*4.8);
        halo.addColorStop(0,s.color+'b0');halo.addColorStop(.34,s.color+'36');halo.addColorStop(1,s.color+'00');
        ctx.fillStyle=halo;ctx.fillRect(x-radius*5,y-radius*5,10*radius,10*radius);
        ctx.fillStyle=s.color;
      }
      ctx.beginPath();ctx.arc(x,y,radius,0,2*Math.PI);ctx.fill();starHits.push({b:s,x,y});
    }
    ctx.globalAlpha=1;
    if(showHorizon)drawHorizon();
    const planetHosts=new Set(selected.kind==='planet'?[selected.system]:[]);
    for(const d of destinations) {
      if(d!==selected && family.value!=='all' && d.kind!==family.value)continue;
      if(d!==selected && d.kind==='planet'){
        if(family.value!=='planet'||planetHosts.has(d.system))continue;
        planetHosts.add(d.system);
      }
      const p=projection.project(d.vec);if(!inFrame(p))continue;
      marker(d,...p);visible.push({b:d,x:p[0],y:p[1]});
    }
    const c=canvas.getBoundingClientRect();
    for(const el of [compass,settings,zoomBar,scale]) {
      const e=el.getBoundingClientRect();
      checkpoints.push([e.x-c.x-2,e.y-c.y-2,e.right-c.x+2,e.bottom-c.y+2]);
    }
    const hit=projection.project(selected.vec);
    if(inFrame(hit)){
      ctx.strokeStyle='#f7d9a6';ctx.lineWidth=1.2;
      for(let i=0;i<4;i++){ctx.beginPath();ctx.arc(hit[0],hit[1],12,i*Math.PI/2+.12,i*Math.PI/2+1.23);ctx.stroke();}
      label(selected.name,hit[0]+15,hit[1]-10,'#ffe1ae',true,'600 12px system-ui');
    }
    for(const h of visible) if(h.b!==selected)label(h.b.name,h.x+7,h.y-6,h.b.color);
    for(const h of starHits) if(h.b.named && h.b!==selected && h.b.mag<(fov<35?4:2.15)) {
      if(visible.some(d=>Math.hypot(d.x-h.x,d.y-h.y)<8)) continue;
      label(h.b.name,h.x+5,h.y+13,'#b8cada',false,'10px system-ui');
    }
    if(showFigures)for(const f of figures){
      const p=projection.project(f.vec);if(inFrame(p,-20))label(f.name.toLocaleUpperCase('fr'),p[0]-12,p[1],'#77a9b1',false,'600 10px system-ui');
    }
    canvas.dataset.skyRa=pointing.ra.toFixed(3);canvas.dataset.skyDec=pointing.dec.toFixed(3);
    canvas.dataset.skyStars=String(stars.length);canvas.dataset.skyVisible=String(starHits.length);
  }
  const observer=new ResizeObserver(resize);observer.observe(frame);
  fillTargets();refreshDetails();resize();
  loadStars().then(data=>{
    if(disposed)return;
    stars=data.stars;figures=data.figures;stars.forEach(s=>lookup.set(s.id,s));fillTargets();queue();
  }).catch(()=>{if(!disposed)note.textContent='Le fond stellaire n’a pas pu être chargé. Les destinations du catalogue restent consultables.';});
  const timer=setInterval(()=>{if(showHorizon&&!document.hidden){refreshDetails();queue();}},30000);
  return ()=>{disposed=true;observer.disconnect();clearInterval(timer);cancelAnimationFrame(raf);pointers.clear();};
}
