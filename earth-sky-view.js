import {EARTH_SKY_BODIES,earthSkySnapshot,earthSkyTrack} from './earth-sky-model.js';
import {EARTH_SKY_SITES,resolveEarthSkySite} from './earth-sky-sites.js';

const minute=60000, hour=60*minute, day=24*hour, rad=Math.PI/180;
const minTime=Date.UTC(1700,0,1),maxTime=Date.UTC(2101,0,1)-1;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const number=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const phaseNames={day:'Jour',civil:'Crépuscule civil',nautical:'Crépuscule nautique',astronomical:'Crépuscule astronomique',night:'Nuit'};
const eventNames={rise:'Lever',transit:'Culmination',set:'Coucher'};
const localParts=new Map();

function civil(ms,zone) {
  if (!localParts.has(zone)) localParts.set(zone,new Intl.DateTimeFormat('en-GB',{
    calendar:'iso8601',numberingSystem:'latn',timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));
  const parts={};
  for (const p of localParts.get(zone).formatToParts(ms)) if (p.type!=='literal') parts[p.type]=Number(p.value);
  return parts;
}
const civilDay=p=>Date.UTC(p.year,p.month-1,p.day);
const civilTime=p=>civilDay(p)+p.hour*hour+p.minute*minute+p.second*1000;

// Search local calendar boundaries rather than assuming midnight UTC or 24 h.
// This also handles zones where an offset transition takes place at midnight.
export function earthSkyDayBounds(ms,zone) {
  const key=civilDay(civil(ms,zone));
  function boundary(lo,hi,wanted) {
    while (hi-lo>1) {
      const mid=Math.floor((lo+hi)/2);
      if (civilDay(civil(mid,zone))<wanted) lo=mid;else hi=mid;
    }
    return hi;
  }
  return {startMs:boundary(ms-36*hour,ms,key),endMs:boundary(ms,ms+36*hour,key+day)};
}

export function adjacentSkyDate(ms,zone,days) {
  const wanted=civilTime(civil(ms,zone))+days*day;
  let candidate=ms+days*day,previous;
  for (let i=0;i<4;i++) {
    const difference=wanted-civilTime(civil(candidate,zone));
    if (!difference) break;
    const next=candidate+difference;
    if (next===previous) return Math.max(next,candidate); // a skipped local hour
    previous=candidate;candidate=next;
  }
  return candidate;
}

export function projectEarthSky(altitudeDeg,azimuthDeg,cx,cy,radius) {
  const r=(90-altitudeDeg)/90*radius;
  return {x:cx-r*Math.sin(azimuthDeg*rad),y:cy-r*Math.cos(azimuthDeg*rad)};
}

function drawing(canvas) {
  const w=canvas.clientWidth,h=canvas.clientHeight;
  if (!w||!h) return null;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const width=Math.round(w*dpr),height=Math.round(h*dpr);
  if (canvas.width!==width || canvas.height!==height) {canvas.width=width;canvas.height=height;}
  const ctx=canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(width/w,0,0,height/h,0,0);ctx.clearRect(0,0,w,h);
  return {ctx,w,h};
}
function paintDome(canvas,snapshot,track,target) {
  const frame=drawing(canvas);if (!frame) return [];
  const {ctx,w,h}=frame, cx=w/2,cy=h/2,r=Math.max(1,Math.min(cx-20,cy-19));
  const point=(alt,az)=>projectEarthSky(alt,az,cx,cy,r);
  const circle=(x,y,radius)=>{ctx.beginPath();ctx.arc(x,y,radius,0,2*Math.PI);};
  const daytime=snapshot.light==='day',night=snapshot.light==='night';
  const sky=ctx.createRadialGradient(cx,cy,0,cx,cy,r);
  sky.addColorStop(0,daytime?'#263e55':night?'#151526':'#24203c');
  sky.addColorStop(1,daytime?'#537084':night?'#332d48':'#715557');
  ctx.fillStyle=sky;circle(cx,cy,r);ctx.fill();
  ctx.lineWidth=1;
  for (const alt of [0,30,60]) {
    ctx.strokeStyle=alt===0?'#d1c2a1':'#cac5e044';circle(cx,cy,r*(90-alt)/90);ctx.stroke();
  }
  ctx.strokeStyle='#d1c6db2e';ctx.setLineDash([2,4]);ctx.beginPath();
  ctx.moveTo(cx-r,cy);ctx.lineTo(cx+r,cy);ctx.moveTo(cx,cy-r);ctx.lineTo(cx,cy+r);ctx.stroke();ctx.setLineDash([]);
  ctx.font='600 12px system-ui,sans-serif';ctx.fillStyle='#f2e5d2';ctx.textAlign='center';ctx.textBaseline='middle';
  for (const [az,label] of [[0,'N'],[90,'E'],[180,'S'],[270,'O']]) {
    const p=projectEarthSky(0,az,cx,cy,r+11);ctx.fillText(label,p.x,p.y);
  }
  ctx.strokeStyle='#bdaec6';ctx.beginPath();ctx.moveTo(cx-3,cy);ctx.lineTo(cx+3,cy);ctx.moveTo(cx,cy-3);ctx.lineTo(cx,cy+3);ctx.stroke();
  ctx.font='10px system-ui,sans-serif';ctx.fillStyle='#ccc0d9';ctx.fillText('Zénith',cx,cy+11);
  ctx.save();circle(cx,cy,r);ctx.clip();ctx.strokeStyle='#f1ce8bad';ctx.setLineDash([3,4]);ctx.beginPath();
  let visible=false;
  for (const sample of track.points) {
    const p=point(sample.altitudeDeg,sample.azimuthDeg);
    if (sample.altitudeDeg>=0 || visible) {
      if (visible) ctx.lineTo(p.x,p.y); else ctx.moveTo(p.x,p.y);
    }
    visible=sample.altitudeDeg>=0;
  }
  ctx.stroke();ctx.restore();
  const hits=[],candidates=snapshot.bodies.filter(body=>body.id!==target.id).concat(target);
  for (const body of candidates) {
    const selected=body.id===target.id;
    if (body.altitudeDeg<0) {
      if (selected) {
        const p=point(0,body.azimuthDeg);
        ctx.strokeStyle='#facc8d';ctx.setLineDash([2,2]);circle(p.x,p.y,6);ctx.stroke();ctx.setLineDash([]);
      }
      continue;
    }
    const p=point(body.altitudeDeg,body.azimuthDeg);
    const marker=body.id==='sun'?5.8:body.id==='moon'?4.8:3;
    ctx.fillStyle=body.color;circle(p.x,p.y,marker);ctx.fill();
    if (selected) {ctx.strokeStyle='#ffe1a2';ctx.lineWidth=1.5;circle(p.x,p.y,marker+4);ctx.stroke();}
    hits.push({...p,id:body.id,name:body.name,selected});
  }
  // Keep small phone charts readable when objects cluster in the same direction.
  const labels=[{x:cx-16,y:cy+4,width:32}];
  for (const body of [...hits].sort((a,b)=>Number(b.selected)-Number(a.selected))) {
    if (!body.selected && body.id!=='sun' && body.id!=='moon') continue;
    ctx.font=(body.selected?'600 ':'')+'11px system-ui,sans-serif';ctx.textAlign='left';
    const width=ctx.measureText(body.name).width+6;
    let x=clamp(body.x+9,2,w-width-2),y=clamp(body.y-13,4,h-18);
    const overlaps=()=>labels.some(b=>x<b.x+b.width&&b.x<x+width&&Math.abs(y-b.y)<15);
    if (overlaps()) {
      x=clamp(body.x-width-9,2,w-width-2);y=clamp(body.y+4,4,h-18);
      if (overlaps() && !body.selected) continue;
    }
    labels.push({x,y,width});ctx.fillStyle='#171625df';ctx.fillRect(x,y,width,14);
    ctx.fillStyle=body.selected?'#ffdc9c':'#dfdce7';ctx.fillText(body.name,x+3,y+7);
  }
  return hits;
}

function paintChart(canvas,track,current,ms,clock) {
  const frame=drawing(canvas);if (!frame) return;
  const {ctx,w,h}=frame,left=32,right=w-9,top=11,bottom=h-24;
  const x=time=>left+(time-track.startMs)/(track.endMs-track.startMs)*(right-left);
  const y=alt=>top+(90-alt)/180*(bottom-top);
  ctx.fillStyle='#211c33';ctx.fillRect(left,top,right-left,y(0)-top);
  ctx.fillStyle='#121420';ctx.fillRect(left,y(0),right-left,bottom-y(0));
  ctx.font='10px system-ui,sans-serif';ctx.textBaseline='middle';
  for (const alt of [-90,-45,0,45,90]) {
    ctx.strokeStyle=alt===0?'#c3af92a8':'#aaa1bc33';ctx.beginPath();ctx.moveTo(left,y(alt));ctx.lineTo(right,y(alt));ctx.stroke();
    ctx.textAlign='right';ctx.fillStyle='#c7bfd1';ctx.fillText(alt+'°',left-4,y(alt));
  }
  const nominalTicks=Math.max(2,Math.min(5,Math.floor(w/73)));
  const end=track.endMs-track.startMs;
  for (let i=0;i<nominalTicks;i++) {
    const time=i===nominalTicks-1 ? track.endMs : track.startMs+Math.round((end/hour)*i/(nominalTicks-1))*hour;
    ctx.textAlign=i===0?'left':i===nominalTicks-1?'right':'center';
    ctx.fillStyle='#c7bfd1';ctx.fillText(clock.format(time),x(time),h-10);
  }
  const plot=()=>{ctx.beginPath();track.points.forEach((p,i)=>{if(i===0)ctx.moveTo(x(p.timeMs),y(p.altitudeDeg));else ctx.lineTo(x(p.timeMs),y(p.altitudeDeg));});ctx.stroke();};
  ctx.save();ctx.beginPath();ctx.rect(left,y(0),right-left,bottom-y(0)+1);ctx.clip();
  ctx.setLineDash([3,4]);ctx.lineWidth=1.5;ctx.strokeStyle='#c2a2d2';plot();ctx.restore();
  ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,y(0)-top+1);ctx.clip();
  ctx.lineWidth=2;ctx.strokeStyle='#efbe7e';plot();ctx.restore();
  const xx=x(ms),yy=y(current.altitudeDeg);
  ctx.strokeStyle='#d4c6d5';ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();ctx.setLineDash([]);
  ctx.beginPath();ctx.arc(xx,yy,3.5,0,2*Math.PI);ctx.fillStyle='#ffe1ab';ctx.fill();
}

export function createEarthSkyView(host,{initialSite,initialTarget,initialDate,onMap,onSave,onChange}={}) {
  const view=document.createElement('section');
  view.className='earth-sky-view';view.dataset.earthSkyView='';view.setAttribute('aria-label','Ciel terrestre');
  view.innerHTML=`<div class="es-pickers"><label>Lieu d’observation<select data-earth-sky-site></select></label>
    <label>Astre<select data-earth-sky-target></select></label><button type="button" data-earth-sky-map>Choisir sur la carte</button></div>
    <div class="es-heading"><div><strong data-earth-sky-local></strong><span data-earth-sky-zone></span></div>
      <span class="es-light" data-earth-sky-light></span></div>
    <div class="es-figures">
      <figure><figcaption>Voûte locale <span>Horizon à la périphérie</span></figcaption>
        <canvas data-earth-sky-dome role="img"></canvas></figure>
      <figure><figcaption>Altitude sur la journée <span>Heure locale</span></figcaption>
        <canvas data-earth-sky-chart role="img"></canvas>
        <div class="es-events" data-earth-sky-events role="group" aria-label="Rejoindre un phénomène"></div>
        <p class="es-horizon" data-earth-sky-horizon></p></figure>
    </div>
    <dl class="es-measures"><div><dt>Altitude apparente</dt><dd data-earth-sky-altitude></dd></div>
      <div><dt>Azimut depuis le nord</dt><dd data-earth-sky-azimuth></dd></div>
      <div><dt data-earth-sky-extra-label></dt><dd data-earth-sky-extra></dd></div></dl>
    <div class="es-scrubber"><label>Parcourir la journée <input type="range" data-earth-sky-scrub min="0" step="1"></label>
      <button type="button" data-earth-sky-play aria-pressed="false">Lire la journée</button></div>
    <div class="es-time-tools"><label>Instant en UTC<input data-earth-sky-date type="datetime-local" step="1" min="1700-01-01T00:00:00" max="2100-12-31T23:59:59"></label>
      <div class="es-days"><button type="button" data-earth-sky-day="prev">Jour précédent</button>
      <button type="button" data-earth-sky-day="next">Jour suivant</button><button type="button" data-earth-sky-now>Maintenant</button></div></div>
    <div class="es-footer"><div><span data-earth-sky-coordinates></span><p>Est à gauche en regardant vers le zénith. Les symboles des astres sont agrandis pour la lecture. Levers et couchers supposent un horizon dégagé et une réfraction moyenne.</p></div>
      <button type="button" data-earth-sky-save>Consigner l’observation</button></div>
    <p data-earth-sky-status role="status"></p><div data-earth-sky-compare></div><div data-earth-sky-notebook></div>`;
  host.append(view);
  const $=name=>view.querySelector('[data-earth-sky-'+name+']');
  const siteSelect=$('site'),targetSelect=$('target'),dome=$('dome'),chart=$('chart');
  const dateInput=$('date'),scrub=$('scrub'),play=$('play'),events=$('events');
  let site=resolveEarthSkySite(initialSite);
  let targetId=EARTH_SKY_BODIES.some(body=>body.id===initialTarget)?initialTarget:'moon';
  const stamp=initialDate instanceof Date ? initialDate.getTime() : typeof initialDate==='number' ? initialDate : Date.parse(initialDate);
  let followingNow=!(Number.isFinite(stamp)&&stamp>=minTime&&stamp<=maxTime);
  let ms=followingNow?Date.now():Math.floor(stamp);
  let snapshot,current,track,positions=[],local,clock,clockSeconds,closed=false,playing=false;
  let timer=0,last=0;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  const groups=new Map();
  for (const place of EARTH_SKY_SITES) {
    if (!groups.has(place.group)) {
      const group=document.createElement('optgroup');group.label=place.group;groups.set(place.group,group);siteSelect.append(group);
    }
    groups.get(place.group).append(new Option(place.name,place.id));
  }
  const custom=site.id==='custom'?site:null;
  if (custom) siteSelect.add(new Option(custom.name,'custom'));
  for (const body of EARTH_SKY_BODIES) targetSelect.add(new Option(body.name,body.id));
  $('map').hidden=typeof onMap!=='function';$('save').hidden=typeof onSave!=='function';

  function setSite() {
    siteSelect.value=site.id;
    const fmt=options=>new Intl.DateTimeFormat('fr-CA',{timeZone:site.timeZone,hourCycle:'h23',...options});
    local=fmt({weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'shortOffset'});
    clock=fmt({hour:'2-digit',minute:'2-digit'});clockSeconds=fmt({hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'shortOffset'});
    $('zone').textContent=site.timeZone==='UTC'?'Heure de référence UTC':site.timeZone;
    const coordinates=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:4});
    $('coordinates').textContent=coordinates.format(Math.abs(site.latitude))+'° '+(site.latitude<0?'S':'N')+' · '+
      coordinates.format(Math.abs(site.longitude))+'° '+(site.longitude<0?'O':'E');
    view.dataset.latitude=site.latitude;view.dataset.longitude=site.longitude;
    track=null;
  }
  function buildTrack() {
    const bounds=earthSkyDayBounds(ms,site.timeZone);
    track=earthSkyTrack(site,targetId,bounds.startMs,15,(bounds.endMs-bounds.startMs)/hour);
    scrub.max=String(Math.round((track.endMs-track.startMs)/minute)-1);
    events.replaceChildren();
    for (const event of track.events) {
      const b=document.createElement('button');b.type='button';b.dataset.earthSkyEvent=event.type;b.dataset.timeMs=event.timeMs;
      const title=document.createElement('span');title.textContent=eventNames[event.type];
      const time=document.createElement('strong');time.textContent=clock.format(event.timeMs);
      b.append(title,time);b.setAttribute('aria-label',eventNames[event.type]+' à '+clockSeconds.format(event.timeMs));
      b.onclick=()=>{pause();setTime(event.timeMs);};events.append(b);
    }
    $('horizon').textContent=track.horizonState==='above-window'?'Au-dessus de l’horizon toute la journée.':
      track.horizonState==='below-window'?'Sous l’horizon toute la journée.':'';
  }
  function paint() {
    if (closed || !snapshot || !track) return;
    positions=paintDome(dome,snapshot,track,current);
    paintChart(chart,track,current,ms,clock);
  }
  const observation=()=>({site,targetId,date:new Date(ms).toISOString()});
  function refresh() {
    if (!track || ms<track.startMs || ms>=track.endMs) buildTrack();
    snapshot=earthSkySnapshot(site,ms);current=snapshot.bodies.find(body=>body.id===targetId);
    targetSelect.value=targetId;
    view.dataset.timeMs=String(ms);view.dataset.targetId=targetId;
    scrub.value=Math.floor((ms-track.startMs)/minute);scrub.setAttribute('aria-valuetext',clockSeconds.format(ms));
    if (document.activeElement!==dateInput || !followingNow) dateInput.value=new Date(ms).toISOString().slice(0,19);
    $('now').setAttribute('aria-pressed',String(followingNow));
    $('local').textContent=local.format(ms);$('light').textContent=phaseNames[snapshot.light];
    const altitude=$('altitude'),azimuth=$('azimuth'),extra=$('extra');
    altitude.dataset.degrees=current.altitudeDeg;azimuth.dataset.degrees=current.azimuthDeg;
    altitude.textContent=number.format(current.altitudeDeg)+'°';azimuth.textContent=number.format(current.azimuthDeg)+'°';
    const lunar=targetId==='moon';$('extra-label').textContent=lunar?'Fraction lunaire éclairée':'Horizon';
    extra.textContent=lunar?number.format(current.illuminatedFraction*100)+' %':current.aboveHorizon?'Au-dessus':'En dessous';
    dome.setAttribute('aria-label',current.name+', altitude apparente '+altitude.textContent+', azimut '+azimuth.textContent+
      '. Vue vers le zénith. Nord en haut, est à gauche.');
    chart.setAttribute('aria-label','Altitude de '+current.name+' à '+site.name+' sur la journée. À '+clock.format(ms)+' : '+altitude.textContent+'.');
    for (const button of events.children) button.setAttribute('aria-pressed',String(Number(button.dataset.timeMs)===ms));
    view.querySelector('[data-earth-sky-day="prev"]').disabled=ms-day<minTime;
    view.querySelector('[data-earth-sky-day="next"]').disabled=ms+day>maxTime;
    paint();onChange?.(observation());
  }
  function setTime(next,live=false) {
    if (!Number.isFinite(next)) return;
    followingNow=live;
    ms=clamp(Math.round(next),minTime,maxTime);refresh();
  }
  function pause() {
    playing=false;clearTimeout(timer);last=0;play.textContent='Lire la journée';play.setAttribute('aria-pressed','false');
  }
  function tick() {
    if (!playing || closed) return;
    const now=performance.now(),elapsed=Math.min(500,Math.max(0,now-last));
    last=now;const next=ms+elapsed*(track.endMs-track.startMs)/24000;
    if (next>=track.endMs-1) {setTime(track.endMs-1);pause();return;}
    setTime(next);timer=setTimeout(tick,240);
  }
  play.onclick=()=>{
    if (playing) {pause();return;}
    followingNow=false;$('now').setAttribute('aria-pressed','false');
    if (ms>=track.endMs-minute) setTime(track.startMs);
    playing=true;last=performance.now();play.textContent='Pause';play.setAttribute('aria-pressed','true');timer=setTimeout(tick,240);
  };
  targetSelect.onchange=()=>{pause();targetId=targetSelect.value;track=null;refresh();};
  siteSelect.onchange=()=>{pause();site=siteSelect.value==='custom'?custom:resolveEarthSkySite(siteSelect.value);setSite();refresh();};
  scrub.oninput=()=>{pause();setTime(track.startMs+scrub.valueAsNumber*minute);};
  dateInput.onchange=()=>{
    if (!dateInput.value || !dateInput.validity.valid) {dateInput.reportValidity();return;}
    pause();setTime(Date.parse(dateInput.value+'Z'));
  };
  for (const b of view.querySelectorAll('[data-earth-sky-day]')) b.onclick=()=>{
    pause();setTime(adjacentSkyDate(ms,site.timeZone,b.dataset.earthSkyDay==='next'?1:-1));
  };
  $('now').onclick=()=>{pause();setTime(Date.now(),true);};
  $('map').onclick=()=>{pause();onMap?.(site,{targetId,date:new Date(ms).toISOString()});};
  $('save').onclick=async()=>{
    pause();
    let result;
    try {result=await onSave?.(observation());} catch {result=false;}
    if (!closed) $('status').textContent=result===false?'L’observation n’a pas pu être enregistrée.':'Observation consignée.';
  };
  dome.onclick=e=>{
    const rect=dome.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
    const nearest=positions.map(p=>({p,d:Math.hypot(p.x-x,p.y-y)})).sort((a,b)=>a.d-b.d)[0];
    if (nearest && nearest.d<=22 && nearest.p.id!==targetId) {pause();targetId=nearest.p.id;track=null;refresh();}
  };
  chart.onclick=e=>{
    const rect=chart.getBoundingClientRect(),fraction=clamp((e.clientX-rect.left-32)/(rect.width-41),0,1);
    pause();setTime(track.startMs+fraction*(track.endMs-track.startMs-1));
  };
  // Keep "Maintenant" observing the real sky without an idle render loop.
  const updateNow=()=>{if(followingNow && !document.hidden && !closed)setTime(Date.now(),true);};
  const liveTimer=setInterval(updateNow,30000);
  const stopWhenHidden=()=>{if(document.hidden)pause();else updateNow();};
  const stopOnReduced=()=>{if(reduced.matches)pause();};
  reduced.addEventListener('change',stopOnReduced);document.addEventListener('visibilitychange',stopWhenHidden);
  setSite();refresh();
  const observer=new ResizeObserver(paint);observer.observe(dome);observer.observe(chart);
  return ()=>{
    closed=true;pause();clearInterval(liveTimer);observer.disconnect();reduced.removeEventListener('change',stopOnReduced);
    document.removeEventListener('visibilitychange',stopWhenHidden);view.remove();
  };
}
