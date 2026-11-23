import {TRAVELLERS, DAY_MS, coverageFor, readingAt, sampleTrail, earthReception} from './traveller-model.js';

const fmt = (value,precision=1) => value.toLocaleString('fr-CA',{maximumFractionDigits:precision});
const clock = new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',dateStyle:'medium',timeStyle:'medium'});
const shortDate = new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',dateStyle:'medium'});
const isoMinute = t => new Date(t).toISOString().slice(0,16);
const objects = new Map(TRAVELLERS.map(object=>[object.id,object]));
const metric = (id,label) => '<div><dt>'+label+'</dt><dd data-traveller-'+id+'>—</dd></div>';
const button = (id,label,icon) => '<button type="button" data-traveller-'+id+' title="'+label+'" aria-label="'+label+'"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">'+icon+'</svg></button>';
const lightDelay = seconds => {
  const minutes=Math.round(seconds/60);
  return minutes>=60 ? Math.floor(minutes/60)+' h '+String(minutes%60).padStart(2,'0')+' min' : minutes+' min';
};

function renderTrack(ctx,w,h,track,point,index,startLabel) {
  const vectors=track.filter(Boolean).concat([point.vector]);
  const xs=vectors.map(v=>v[0]), ys=vectors.map(v=>v[index]);
  const xMin=Math.min(...xs), xMax=Math.max(...xs), yMin=Math.min(...ys), yMax=Math.max(...ys);
  const scale=Math.min(w*.62/Math.max(.0001,xMax-xMin),h*.57/Math.max(.0001,yMax-yMin));
  const xy=v=>[w*.5+(v[0]-(xMin+xMax)/2)*scale,h*.50-(v[index]-(yMin+yMax)/2)*scale];
  const order=10**Math.floor(Math.log10(w*.22/scale));
  const grid=[5,2,1].map(i=>i*order).find(step=>step*scale<=w*.24) || order;
  const pitch=grid*scale, margin=10;
  ctx.strokeStyle='#6f8d9724';ctx.lineWidth=1;ctx.beginPath();
  for(let x=(w/2)%pitch;x<w;x+=pitch){ctx.moveTo(x,0);ctx.lineTo(x,h);}
  for(let y=(h/2)%pitch;y<h;y+=pitch){ctx.moveTo(0,y);ctx.lineTo(w,y);}
  ctx.stroke();
  ctx.beginPath();let continuous=false;
  for(const v of [...track,point.vector]){
    if(!v){continuous=false;continue;}
    const [x,y]=xy(v);
    if(continuous)ctx.lineTo(x,y);else ctx.moveTo(x,y);
    continuous=true;
  }
  ctx.lineWidth=2;ctx.strokeStyle=point.color;ctx.stroke();
  const [sx,sy]=xy(vectors[0]),[x,y]=xy(point.vector);
  ctx.fillStyle='#09131a';ctx.beginPath();ctx.arc(sx,sy,3.5,0,Math.PI*2);ctx.fill();ctx.lineWidth=1.5;ctx.stroke();
  ctx.beginPath();ctx.arc(x,y,9,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle=point.color;ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);ctx.fill();
  ctx.font='12px system-ui,sans-serif';ctx.textAlign=x>w*.5?'right':'left';
  ctx.fillText(point.short,x+(x>w*.5?-13:13),y-8);
  if (Math.hypot(sx-x,sy-y)>36) {
    ctx.textAlign=sx>w*.5?'right':'left';ctx.fillStyle='#acbec4';ctx.font='10px monospace';
    ctx.fillText(startLabel,sx,sy+(sy<h*.5?-10:16));
  }
  ctx.textAlign='left';ctx.font='11px monospace';ctx.fillStyle='#b4c6ce';ctx.strokeStyle='#91a8b0';
  ctx.fillText(fmt(grid,5)+' UA',margin,h-15);
  ctx.beginPath();ctx.moveTo(margin,h-11);ctx.lineTo(margin,h-7);ctx.lineTo(margin+pitch,h-7);ctx.lineTo(margin+pitch,h-11);ctx.stroke();
  ctx.textAlign='right';ctx.fillText('↑ +'+(index===2?'Z':'Y')+'    → +X',w-8,16);
  return [{id:point.id,x,y}];
}

function renderChart(canvas, points, track, selected, plane, group, startLabel) {
  const ctx=canvas.getContext('2d');
  const box=canvas.getBoundingClientRect(), w=box.width, h=box.height;
  if (!ctx || w<3 || h<3) return [];
  const dpr=Math.min(2,window.devicePixelRatio||1);
  const width=Math.round(w*dpr), height=Math.round(h*dpr);
  if(canvas.width!==width || canvas.height!==height) {canvas.width=width;canvas.height=height;}
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#09131a';ctx.fillRect(0,0,w,h);
  const index=plane==='xz'?2:1;
  const visible=group?points:points.filter(p=>p.id===selected);
  const pos=points.find(p=>p.id===selected);
  if(!group && pos) return renderTrack(ctx,w,h,track,pos,index,startLabel);
  const radius=Math.min(w*.38,h*.36);
  const extent=Math.max(1,...visible.map(p=>Math.hypot(p.vector[0],p.vector[index])));
  const approximateGrid=extent/3;
  const unit=10**Math.floor(Math.log10(approximateGrid));
  const grid=[1,2,5,10].map(multiplier=>multiplier*unit).find(step=>step>=approximateGrid);
  const scale=radius/(extent*1.09);
  const cx=w*.5, cy=h*.51;
  const xy=v=>[cx+v[0]*scale,cy-v[index]*scale];
  ctx.font='11px monospace';ctx.lineWidth=1;
  ctx.strokeStyle='#40535e';ctx.beginPath();
  ctx.moveTo(12,cy);ctx.lineTo(w-12,cy);ctx.moveTo(cx,8);ctx.lineTo(cx,h-12);ctx.stroke();
  ctx.fillStyle='#97aab1';ctx.textAlign='left';ctx.fillText(plane==='xz'?'+Z':'+Y',cx+7,17);
  ctx.textAlign='right';ctx.fillText('+X',w-12,cy-6);
  for(let i=1;i<=4;i++) {
    const r=grid*i*scale;
    if (r>Math.min(w/2,h/2)-9) break;
    ctx.setLineDash([2,6]);ctx.strokeStyle='#657c853f';
    ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#97aab1';ctx.textAlign='left';
    const x=cx+r*.707+3,y=cy+r*.707+10;
    if(x+28<w && y<h-4)ctx.fillText(fmt(grid*i)+' UA',x,y);
  }
  ctx.strokeStyle=objects.get(selected).color;ctx.globalAlpha=.63;ctx.lineWidth=1.6;
  ctx.beginPath();let drawing=false;
  for (const vector of [...track,pos?.vector]) {
    if(!vector){drawing=false;continue;}
    const [x,y]=xy(vector);
    if(drawing)ctx.lineTo(x,y);else ctx.moveTo(x,y);
    drawing=true;
  }
  ctx.stroke();ctx.globalAlpha=1;
  ctx.fillStyle='#f9ce8d';ctx.beginPath();ctx.arc(cx,cy,4.5,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#ddcbb0';ctx.textAlign='left';ctx.fillText('Soleil',cx+7,cy+15);
  const hits=[];
  const ordered=[...visible].sort((a,b)=>Number(a.id===selected)-Number(b.id===selected));
  for (const point of ordered) {
    const [x,y]=xy(point.vector);
    const active=point.id===selected;
    ctx.fillStyle=point.color;
    ctx.beginPath();ctx.arc(x,y,active?4.6:3.6,0,Math.PI*2);ctx.fill();
    if(active || h>=140) {
      if(active){ctx.strokeStyle=point.color;ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.stroke();}
      ctx.font=(active?'600 12px':'11px')+' system-ui,sans-serif';
      const left=x>w/2, labelX=left?x-12:x+12;
      ctx.textAlign=left?'right':'left';ctx.lineWidth=3;
      const labelY=y+(point.id==='voyager-2'||(!left && x>cx-45 && y>cy-25 && y<cy+15)?-12:16);
      ctx.strokeStyle='#09131a';ctx.strokeText(point.short,labelX,labelY);ctx.fillText(point.short,labelX,labelY);
    }
    hits.push({id:point.id,x,y});
  }
  return hits;
}

export function createTravellerLab(root,{onExit,onChange,onCapture}={}) {
  root.innerHTML=`<header class="traveller-head"><div><h1>Comètes et sondes</h1><p>Positions héliocentriques · écliptique J2000</p></div>
    <div class="traveller-actions">${button('capture','Photographier la carte','<path d="M3 7h5l2-3h4l2 3h5v13H3z"/><circle cx="12" cy="13" r="4"/>')}${button('exit','Fermer le suivi','<path d="m5 5 14 14M19 5 5 19"/>')}</div></header>
    <div class="traveller-body"><section class="traveller-map" aria-label="Carte du Système solaire"><div class="traveller-chartbar"><div><strong data-traveller-name></strong><span data-traveller-kind></span></div>
      <label><span class="traveller-sr">Projection de la carte</span><select data-traveller-plane><option value="xy">Vue de dessus · XY</option><option value="xz">Vue de côté · XZ</option></select></label></div>
      <div class="traveller-field"><canvas data-traveller-canvas role="img"></canvas></div>
      <div class="traveller-scale"><label><input type="checkbox" data-traveller-group checked> Vue d’ensemble</label><span data-traveller-mapnote></span></div></section>
    <section class="traveller-panel" aria-label="Mesures et sources"><label class="traveller-label">Objet suivi<select data-traveller-preset></select></label>
      <p class="traveller-status" data-traveller-status></p>
      <dl class="traveller-metrics">${metric('distance','Distance au Soleil')}${metric('km','Distance en km')}${metric('speed','Vitesse héliocentrique')}${metric('delay','Trajet de la lumière depuis le Soleil')}${metric('earth','Distance à la Terre')}${metric('reception','Trajet de la lumière vers la Terre')}</dl>
      <dl class="traveller-coords">${metric('x','X · UA')}${metric('y','Y · UA')}${metric('z','Z · UA')}</dl>
      <div class="traveller-origin"><h2>Données de trajectoire</h2><p data-traveller-method></p><p data-traveller-ref></p><p data-traveller-coverage></p>
      <a data-traveller-source target="_blank" rel="noopener noreferrer"></a></div></section></div>
    <footer class="traveller-footer"><div class="traveller-time"><button type="button" data-traveller-now aria-pressed="true">Maintenant</button>
      <label><span>Instant UTC</span><input type="datetime-local" step="60" data-traveller-date></label></div>
      <div class="traveller-timeline"><input type="range" data-traveller-range min="0" max="10000" step="1" aria-label="Parcourir la période disponible"><output data-traveller-time></output></div></footer>`;
  const get=key=>root.querySelector('[data-traveller-'+key+']');
  const picker=get('preset'), range=get('range'), date=get('date'), canvas=get('canvas');
  for(const object of TRAVELLERS)picker.add(new Option(object.name,object.id));
  let selected='halley', plane='xy', group=true, live=true, timeMs=Date.now();
  let lastSecond=-1, trailKey='', trail=[], startLabel='', currentPoints=[], hits=[];
  const serialize=()=>({version:1,presetId:selected,timeMs,live,plane,group});
  const save=()=>onChange?.(serialize());
  const setValue=(key,n,text)=>{
    const el=get(key);el.textContent=Number.isFinite(n)?text:'—';
    if(Number.isFinite(n))el.dataset.value=String(n);else delete el.dataset.value;
  };
  function paint(){
    hits=renderChart(canvas,currentPoints,trail,selected,plane,group,startLabel);
  }
  function refresh(){
    const interval=coverageFor(selected), object=objects.get(selected);
    const picked=readingAt(selected,timeMs);
    const info=picked || (interval && readingAt(selected,Math.min(interval.endMs,Math.max(interval.startMs,timeMs))));
    get('name').textContent=object.name;
    get('kind').textContent=object.kind;
    let status='Position indisponible à cet instant. Choisis une date dans la période couverte.';
    if (picked) {
      status='Position calculée pour l’instant choisi';
      if (picked.quality.includes('Extrapolation')) {
        const ageDays=(timeMs-picked.referenceMs)/DAY_MS;
        status='Estimation · '+fmt(ageDays,1)+' j depuis le dernier vecteur';
      } else if (picked.quality.includes('deux corps')) {
        status='Position estimée à partir des éléments orbitaux';
      }
    }
    get('status').textContent=status;
    get('status').classList.toggle('traveller-missing',!picked);
    const d=picked?.distanceAu, k=picked?.distanceKm, v=picked?.speedKms, light=picked?.lightSeconds;
    setValue('distance',d,picked?fmt(d,2)+' UA':'');
    setValue('km',k,picked?fmt(k/1e9,3)+' milliards de km':'');
    setValue('speed',v,Number.isFinite(v)?fmt(v,1)+' km/s':'');
    setValue('delay',light,picked?lightDelay(light):'');
    const earth=picked?earthReception(selected,timeMs):null;
    setValue('earth',earth?.distanceAu,earth?fmt(earth.distanceAu,2)+' UA':'');
    setValue('reception',earth?.seconds,Number.isFinite(earth?.seconds)?lightDelay(earth.seconds):'');
    ['x','y','z'].forEach((key,i)=>setValue(key,picked?.positionAu[i],picked?fmt(picked.positionAu[i],2):''));
    get('method').textContent=info?.quality || '';
    get('ref').textContent=Number.isFinite(info?.referenceMs)?'Époque de référence · '+clock.format(info.referenceMs)+' UTC':'';
    get('coverage').textContent=interval?'Période couverte · '+shortDate.format(interval.startMs)+' au '+shortDate.format(interval.endMs)+' UTC':'';
    const source=get('source');
    source.textContent=info?.source || 'JPL Solar System Dynamics';
    source.href=typeof info?.sourceUrl==='string' && /^https:\/\//.test(info.sourceUrl)?info.sourceUrl:'https://ssd.jpl.nasa.gov/horizons/';
    range.disabled=!interval || interval.startMs===interval.endMs;
    if (interval) {
      date.min=isoMinute(interval.startMs);date.max=isoMinute(interval.endMs);
      range.value=String(Math.round(10000*(timeMs-interval.startMs)/(interval.endMs-interval.startMs || 1)));
    }
    const when=clock.format(timeMs)+' UTC';
    if(document.activeElement!==date)date.value=isoMinute(timeMs);
    get('time').textContent=when;range.setAttribute('aria-valuetext',when);
    get('now').setAttribute('aria-pressed',String(live));
    get('plane').value=plane;get('group').checked=group;picker.value=selected;
    currentPoints=TRAVELLERS.flatMap(o=>{
      const reading=o.id===selected?picked:readingAt(o.id,timeMs);
      return reading?[{...o,vector:reading.positionAu}]:[];
    });
    const key=selected+'/'+Math.floor(timeMs/DAY_MS)+'/'+Boolean(picked);
    if (key!==trailKey) {
      trailKey=key;trail=picked?sampleTrail(selected,timeMs):[];
      startLabel=interval?shortDate.format(Math.max(interval.startMs,(Math.floor(timeMs/DAY_MS)-180)*DAY_MS)):'';
    }
    get('mapnote').textContent=group?(plane==='xy'?'Projection sur l’écliptique':'Plan XZ'):'Trajectoire agrandie';
    canvas.setAttribute('aria-label',picked?object.name+' à '+fmt(d,2)+' unités astronomiques du Soleil. '+when:'Aucune position disponible pour '+object.name);
    paint();
  }
  function select(id){if(objects.has(id)){selected=id;refresh();save();}}
  picker.onchange=()=>select(picker.value);
  get('plane').onchange=()=>{plane=get('plane').value;refresh();save();};
  get('group').onchange=()=>{group=get('group').checked;refresh();save();};
  get('now').onclick=()=>{live=true;timeMs=Date.now();refresh();save();};
  date.onchange=()=>{
    const timestamp=Date.parse(date.value+'Z');
    if(!Number.isFinite(timestamp) || !date.checkValidity()){date.reportValidity();return;}
    live=false;timeMs=timestamp;refresh();save();
  };
  date.onblur=()=>{date.value=isoMinute(timeMs);};
  range.oninput=()=>{
    const interval=coverageFor(selected);if(!interval)return;
    live=false;timeMs=Math.round(interval.startMs+(interval.endMs-interval.startMs)*Number(range.value)/10000);refresh();
  };
  range.onchange=save;
  canvas.onclick=event=>{
    const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
    const hit=hits.map(p=>({id:p.id,d:Math.hypot(x-p.x,y-p.y)})).filter(p=>p.d<=18).sort((a,b)=>a.d-b.d)[0];
    if(hit)select(hit.id);
  };
  get('capture').hidden=!onCapture;
  get('capture').onclick=()=>{
    if(!canvas.width || !onCapture)return;
    onCapture(canvas,objects.get(selected).name+' · '+clock.format(timeMs)+' UTC');
  };
  get('exit').onclick=()=>onExit?.();
  root.onkeydown=event=>{
    if(event.key==='Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
      event.preventDefault();onExit?.();
    }
  };
  const observer=new ResizeObserver(()=>{if(!root.hidden)paint();});
  observer.observe(canvas.parentElement);
  function open({presetId,snapshot}={}){
    if(snapshot){
      if(snapshot.version!==1 || !objects.has(snapshot.presetId) || !Number.isFinite(snapshot.timeMs) ||
        Math.abs(snapshot.timeMs)>8640000000000000 || typeof snapshot.live!=='boolean') return false;
      selected=snapshot.presetId;live=snapshot.live;timeMs=live?Date.now():snapshot.timeMs;
      plane=snapshot.plane==='xz'?'xz':'xy';group=snapshot.group!==false;
    }else if(presetId){
      if(!objects.has(presetId))return false;
      selected=presetId;live=true;
    }
    if(live)timeMs=Date.now();
    root.hidden=false;refresh();return true;
  }
  function close(){save();root.hidden=true;}
  function tick(){
    if(!live || root.hidden || document.hidden)return;
    const now=Date.now(),second=Math.floor(now/1000);
    if(second!==lastSecond){lastSecond=second;timeMs=now;refresh();}
  }
  function dispose(){observer.disconnect();close();root.onkeydown=null;root.replaceChildren();}
  return {open,close,tick,serialize,dispose};
}
