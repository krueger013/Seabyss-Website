import { assetUrl } from './assets.js';
import { PHASE_BODIES, phaseAt, phaseTimeline } from './phase-model.js';

const DAY = 86400000, DEG = Math.PI / 180;
const MIN = Date.UTC(1900,0,1), MAX = Date.UTC(2100,11,31,23,59);
const presets = [
  ['earth','moon',30], ['earth','venus',584], ['earth','mars',780],
  ['earth','mercury',116], ['jupiter','europa',3.55], ['europa','jupiter',3.55],
  ['jupiter','ganymede',7.16], ['moon','earth',30]
].map(([observer,target,days]) => ({id:observer+'-'+target,observer,target,days}));
const findPreset = id => presets.find(preset => preset.id === id);
const name = id => PHASE_BODIES[id].name;
const from = id => ({earth:'la Terre',moon:'la Lune'}[id] || name(id));
const formats = [0,1,2].map(maximumFractionDigits=>new Intl.NumberFormat('fr-CA',{maximumFractionDigits}));
const number = (x,digits=1) => formats[digits].format(x);
const utc = new Intl.DateTimeFormat('fr-CA',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
const shortDate = new Intl.DateTimeFormat('fr-CA',{month:'short',day:'numeric',timeZone:'UTC'});
const datedYear = new Intl.DateTimeFormat('fr-CA',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});
const angleLabel = degrees => degrees>=1 ? number(degrees,2)+'°' : degrees>=1/60 ? number(degrees*60,2)+'′' : number(degrees*3600,2)+'″';
const AUTO_FILL = .87;
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const chartColor = '#e5c997', cyan = '#9ce1dd', ink = '#dae1e3';
const arrows = {
  camera:'<path d="m8 6 2-3h4l2 3h4v14H4V6z"/><circle cx="12" cy="12.5" r="3.2"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>', play:'<path d="m7 4 12 8-12 8z"/>',
  pause:'<path d="M8 4v16M16 4v16"/>', swap:'<path d="M3 7h17l-4-4m5 14H4l4 4"/>'
};
const icon = id => '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" stroke-linecap="round">'+arrows[id]+'</svg>';
const metric = (key,title) => '<div><dt>'+title+'</dt><dd data-phase-'+key+'></dd></div>';

// Reproject the original equirectangular maps onto the facing hemisphere.
function createDisk(onTexture) {
  const buffer = document.createElement('canvas');
  const ctx = buffer.getContext('2d');
  const maps = new Map();
  let normals, image, stamp = '';
  function requestMap(id) {
    if (id==='venus' || maps.has(id)) return;
    maps.set(id,null);
    const img = new Image();
    img.onload = () => {
      const scratch=document.createElement('canvas');
      scratch.width=768;scratch.height=384;
      const painter=scratch.getContext('2d',{willReadFrequently:true});
      painter.drawImage(img,0,0,768,384);
      maps.set(id,painter.getImageData(0,0,768,384));
      stamp='';onTexture();
    };
    img.src=assetUrl(id+'-day.webp');
  }
  function disk(frame,size) {
    const id=frame.targetId, axes=frame.textureAxes;
    if (axes) requestMap(id);
    const map=maps.get(id);
    const key=[id,frame.observerId,frame.timeMs,size,!!map].join('/');
    if (key===stamp) return buffer;
    stamp=key;
    if(buffer.width!==size || !image) {
      buffer.width=buffer.height=size;
      image=ctx.createImageData(size,size);
      normals=new Float32Array(size*size);
      for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
        const dx=(2*x+1)/size-1,dy=1-(2*y+1)/size;
        normals[y*size+x]=Math.sqrt(Math.max(0,1-dx*dx-dy*dy));
      }
    }
    const light=frame.skyLight, data=image.data;
    const rough=id==='moon' || id==='mercury';
    const [meridian,east,north]=axes || [];
    const base=({earth:[82,131,168],mars:[193,119,84],venus:[247,225,178],jupiter:[206,173,139]})[id]||[190,187,180];
    for(let y=0;y<size;y++) {
      const dy=1-(2*y+1)/size;
      for(let x=0;x<size;x++) {
        const i=y*size+x,p=4*i,z=normals[i];if (!z) continue;
        const dx=(2*x+1)/size-1;
        const mu=Math.max(0,dx*light[0]+dy*light[1]+z*light[2]);
        const reflected=rough ? .7*mu/(mu+z)+.3*mu : mu;
        const brightness=.012+1.02*Math.pow(reflected,.59);
        let rgb=base,offset=0;
        if (axes && map) {
          const lon=Math.atan2(dx*east[0]+dy*east[1]+z*east[2], dx*meridian[0]+dy*meridian[1]+z*meridian[2]);
          const lat=Math.asin(clamp(dx*north[0]+dy*north[1]+z*north[2],-1,1));
          const u=((.5+lon/(2*Math.PI))*map.width|0)%map.width;
          const v=clamp((.5-lat/Math.PI)*map.height|0,0,map.height-1);
          rgb=map.data;offset=(v*map.width+u)*4;
        }
        data[p]=rgb[offset]*brightness;data[p+1]=rgb[offset+1]*brightness;
        data[p+2]=rgb[offset+2]*brightness;data[p+3]=Math.min(255,255*z*z*size/2);
      }
    }
    ctx.putImageData(image,0,0);
    return buffer;
  }
  return disk;
}

function paintField(ctx,w,h,frame,field,disk,animate) {
  const cx=w/2,cy=h/2;
  const lens=Math.max(1,Math.min(w,h)*.40);
  const gradient=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(w,h)*.70);
  gradient.addColorStop(0,'#13212b');gradient.addColorStop(.55,'#0b141c');gradient.addColorStop(1,'#060d14');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
  ctx.strokeStyle='#7d9fa52c';ctx.lineWidth=1;
  ctx.beginPath();ctx.arc(cx,cy,lens,0,Math.PI*2);ctx.stroke();
  for(let i=0;i<72;i++) {
    const a=i*Math.PI/36,l=i%6===0?6:2;
    ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*(lens+3),cy+Math.sin(a)*(lens+3));
    ctx.lineTo(cx+Math.cos(a)*(lens+3+l),cy+Math.sin(a)*(lens+3+l));ctx.stroke();
  }
  const radius=field==='auto'?lens*AUTO_FILL:lens*Math.tan(frame.angularDiameterDeg*DEG/2)/Math.tan(Number(field)*DEG/2);
  const resolution=clamp(Math.round(Math.min(radius*2.3,Math.max(w,h))/8)*8,24,animate?192:448);
  const bitmap=disk(frame,resolution);
  ctx.save();ctx.beginPath();ctx.arc(cx,cy,lens,0,2*Math.PI);ctx.clip();
  ctx.drawImage(bitmap,cx-radius,cy-radius,2*radius,2*radius);
  if(radius<4) {
    ctx.strokeStyle='#b1cabd';ctx.beginPath();
    ctx.moveTo(cx-9,cy);ctx.lineTo(cx-4,cy);ctx.moveTo(cx+4,cy);ctx.lineTo(cx+9,cy);
    ctx.moveTo(cx,cy-9);ctx.lineTo(cx,cy-4);ctx.moveTo(cx,cy+4);ctx.lineTo(cx,cy+9);ctx.stroke();
  }
  ctx.restore();ctx.fillStyle='#a5babc';ctx.font='10px monospace';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText('N',cx,Math.max(7,cy-lens-13));ctx.fillText('E',Math.max(6,cx-lens-14),cy);
}

function paintGeometry(ctx,w,h,frame) {
  ctx.clearRect(0,0,w,h);
  const cx=w*.5,cy=h*.51,R=Math.min(w*.25,h*.33);
  const [sunX,sunY]=frame.diagram.sun;
  const start=Math.PI/2, end=Math.atan2(-sunY,sunX);
  ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,R*.48,start,end,sunX>0);ctx.closePath();
  ctx.fillStyle='#edc88c26';ctx.fill();
  const ray=(vector,label,color,dotted) => {
    const x=cx+vector[0]*R,y=cy-vector[1]*R;
    ctx.strokeStyle=color;ctx.lineWidth=1.4;ctx.setLineDash(dotted?[3,3]:[]);
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(x,y);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,3,0,2*Math.PI);ctx.fill();
    ctx.font='11px system-ui';ctx.textBaseline='middle';
    const nearObserver=Math.abs(y-(cy+R))<14;
    const left=dotted ? x<cx-4 && !nearObserver : true;
    ctx.textAlign=left?'right':'left';ctx.fillText(label,x+(left?-7:7),y);
  };
  ray(frame.diagram.sun,'Soleil',chartColor,true);
  ray(frame.diagram.observer,name(frame.observerId),cyan,false);
  ctx.fillStyle='#f3f0e8';ctx.beginPath();ctx.arc(cx,cy,4.5,0,2*Math.PI);ctx.fill();
  ctx.font='600 11px system-ui';ctx.textAlign=sunX>=0?'right':'left';
  ctx.fillText(name(frame.targetId),cx+(sunX>=0?-8:8),cy-3);
}

function fit(canvas) {
  const w=canvas.clientWidth,h=canvas.clientHeight;
  if(!w || !h) return null;
  const ratio=Math.min(2,window.devicePixelRatio||1),pw=Math.round(w*ratio),ph=Math.round(h*ratio);
  if(canvas.width!==pw || canvas.height!==ph){canvas.width=pw;canvas.height=ph;}
  const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);
  return {ctx,w,h};
}

export function createPhaseLab(root,{onExit,onChange,onCapture,reduceMotion=()=>false}={}) {
  root.innerHTML=`<header class="phase-header"><div><h1>Observatoire des phases</h1><p data-phase-viewpoint></p></div><div class="phase-actions"><button type="button" data-phase-photo aria-label="Photographier l’observation" title="Photographier l’observation">${icon('camera')}</button><button type="button" data-phase-exit aria-label="Quitter l’observatoire" title="Quitter l’observatoire">${icon('close')}</button></div></header>
    <div class="phase-body"><section class="phase-observation" aria-label="Vue télescopique et évolution de la phase">
      <div class="phase-field"><canvas data-phase-sky aria-label="Disque éclairé, nord céleste en haut et est à gauche"></canvas><div class="phase-caption"><span data-phase-mode></span><b data-phase-clock></b></div></div>
      <div class="phase-timeline"><div class="phase-chart-head"><strong>Fraction éclairée</strong><output data-phase-chart-value></output></div><div class="phase-track"><canvas data-phase-curve aria-hidden="true"></canvas><input data-phase-progress type="range" min="0" max="10000" step="1" aria-label="Parcourir la période d’observation"></div><div class="phase-dates"><span data-phase-first></span><span data-phase-last></span></div></div>
    </section><section class="phase-panel" aria-label="Paramètres de l’observation"><div class="phase-scroll">
      <label>Point de vue<select data-phase-preset></select></label>
      <button type="button" class="phase-swap" data-phase-swap>${icon('swap')} Inverser le point de vue</button>
      <dl class="phase-metrics">${metric('light','Disque éclairé')}${metric('angle','Angle de phase')}${metric('distance','Distance')}${metric('diameter','Diamètre apparent')}${metric('delay','Trajet de la lumière')}${metric('limb','Orientation du limbe')}</dl>
      <figure class="phase-geometry"><figcaption>Angle Soleil–astre–observateur</figcaption><canvas data-phase-geometry aria-label="Directions du Soleil et de l’observateur vues de la cible"></canvas></figure>
      <label>Échelle de la vue<select data-phase-field><option value="auto">Agrandir le disque</option><option value="1">Champ fixe de 1°</option><option value="5">Champ fixe de 5°</option><option value="20">Champ fixe de 20°</option></select></label>
      <label>Date et heure UTC<input data-phase-date type="datetime-local" min="1900-01-01T00:00" max="2100-12-31T23:59" step="60"></label>
      <details><summary>Comment lire cette vue</summary><p>Le disque est orienté avec le nord céleste en haut. L’orientation du bord éclairé se mesure du nord vers l’est. Choisis un champ fixe pour comparer les tailles apparentes dans l’oculaire.</p><p>La date correspond à la réception de la lumière au centre de l’astre observateur. La position de la cible tient compte du temps de trajet de la lumière. Le schéma représente l’angle entre les deux directions. Les textures sont des cartes de référence. Le modèle d’éclairage direct omet les ombres d’éclipse.</p></details>
    </div></section></div>
    <footer class="phase-footer"><button type="button" data-phase-play aria-pressed="false">${icon('play')}<span>Animer</span></button><span data-phase-interval></span><button type="button" data-phase-today>Maintenant</button></footer>`;
  const controls=new Map();
  for(const node of root.querySelectorAll('*')) {
    const key=node.getAttributeNames().find(attr=>attr.startsWith('data-phase-'));
    if(key) controls.set(key.slice(11),node);
  }
  const el=k=>controls.get(k);
  const select=el('preset'), scale=el('field'), date=el('date'), slider=el('progress');
  for(const p of presets) select.add(new Option(name(p.target)+' depuis '+from(p.observer),p.id));
  let preset=presets[0], reversed=false, field='auto';
  let t=Math.floor(Date.now()/60000)*60000, begin=0, end=0;
  let playing=false, elapsed=0, samples=[], seriesKey='', frame, paintId=0, closed=true;
  const disk=createDisk(schedule);
  const observer=()=>reversed?preset.target:preset.observer;
  const target=()=>reversed?preset.observer:preset.target;
  const resize=new ResizeObserver(schedule);
  for(const key of ['sky','curve','geometry']) resize.observe(el(key));
  function centerWindow() {
    const span=preset.days*DAY;
    begin=clamp(t-span/2,MIN,MAX-span);end=begin+span;
  }
  function save(){if(!closed)onChange?.(serialize());}
  function setPlaying(value){
    playing=value;elapsed=0;
    el('play').innerHTML=icon(value?'pause':'play')+'<span>'+(value?'Pause':'Animer')+'</span>';
    el('play').setAttribute('aria-pressed',String(value));
  }
  function paint() {
    paintId=0;if(closed || !frame) return;
    const sky=fit(el('sky')),geometry=fit(el('geometry')),plot=fit(el('curve'));
    if(sky) paintField(sky.ctx,sky.w,sky.h,frame,field,disk,playing);
    if(geometry) paintGeometry(geometry.ctx,geometry.w,geometry.h,frame);
    if(plot && samples.length) {
      const {ctx,w,h}=plot,pad=3;
      ctx.clearRect(0,0,w,h);
      const py=f=>h-pad-f*(h-2*pad);
      ctx.strokeStyle='#91ada92d';ctx.lineWidth=1;
      for(const level of [0,.5,1]){
        const y=py(level);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
      }
      const trace=new Path2D();samples.forEach((f,i)=>{
        const px=i*w/(samples.length-1),y=py(f.illuminatedFraction);
        if(i===0) trace.moveTo(px,y);else trace.lineTo(px,y);
      });
      ctx.strokeStyle=chartColor;ctx.lineWidth=1.8;ctx.stroke(trace);
      trace.lineTo(w,h);trace.lineTo(0,h);trace.closePath();
      const tint=ctx.createLinearGradient(0,0,0,h);tint.addColorStop(0,'#b59d6540');tint.addColorStop(1,'#b59d6503');ctx.fillStyle=tint;ctx.fill(trace);
      const x=clamp((t-begin)/(end-begin)*w,2,w-2);
      ctx.strokeStyle=cyan;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
      ctx.beginPath();ctx.fillStyle=cyan;ctx.arc(x,py(frame.illuminatedFraction),3,0,2*Math.PI);ctx.fill();
    }
  }
  function schedule(){if(!closed && !paintId)paintId=requestAnimationFrame(paint);}
  function reading(id,value,label){const node=el(id);node.dataset.value=String(value);node.textContent=label;}
  function update() {
    frame=phaseAt(observer(),target(),t);
    if(!frame) return;
    const title=name(target())+' depuis '+from(observer());
    el('viewpoint').textContent=title;
    const fov=2*Math.atan(Math.tan(frame.angularDiameterDeg*DEG/2)/AUTO_FILL)/DEG;
    el('mode').textContent=field==='auto'?'Champ ajusté · '+angleLabel(fov):'Champ de '+field+'°';
    el('clock').textContent=utc.format(t)+' UTC';
    const light=number(frame.illuminatedFraction*100,1)+' %';
    el('chart-value').textContent=light;
    reading('light',frame.illuminatedFraction,light);reading('angle',frame.phaseAngleDeg,number(frame.phaseAngleDeg,1)+'°');
    reading('distance',frame.distanceKm,number(frame.distanceKm,0)+' km');
    const delay=frame.lightTimeSeconds;
    reading('delay',delay,delay<60?number(delay,2)+' s':number(delay/60,1)+' min');
    reading('limb',frame.brightLimbDeg,number(frame.brightLimbDeg,1)+'°');
    const d=frame.angularDiameterDeg;
    reading('diameter',d,angleLabel(d));
    date.value=new Date(t).toISOString().slice(0,16);
    slider.value=String(Math.round((t-begin)/(end-begin)*10000));
    slider.setAttribute('aria-valuetext',utc.format(t)+' UTC, '+light);
    el('sky').setAttribute('aria-label',title+', '+light+' éclairés');
    schedule();
  }
  function resample(){
    const key=[observer(),target(),begin,end].join('/');
    if(key!==seriesKey) {samples=phaseTimeline(observer(),target(),begin,end,85);seriesKey=key;}
    const dateFormat=new Date(begin).getUTCFullYear()===new Date(end).getUTCFullYear()?shortDate:datedYear;
    el('first').textContent=dateFormat.format(begin);el('last').textContent=dateFormat.format(end);
    el('interval').textContent=number((end-begin)/DAY,2)+' jours';
    update();
  }
  function setTime(ms,center=false) {
    if(!Number.isFinite(ms)||ms<MIN||ms>MAX)return false;
    setPlaying(false);t=ms;
    if(center || t<begin || t>end){centerWindow();resample();}else update();
    save();return true;
  }
  function choose(id){
    const next=findPreset(id);if(!next)return false;
    setPlaying(false);preset=next;reversed=false;select.value=id;
    syncOption();centerWindow();resample();save();return true;
  }
  select.onchange=()=>choose(select.value);
  el('swap').onclick=()=>{
    setPlaying(false);
    const counterpart=presets.find(p=>p.observer===target() && p.target===observer());
    if(counterpart){preset=counterpart;reversed=false;select.value=preset.id;}
    else reversed=!reversed;
    syncOption();resample();save();
  };
  function syncOption(){
    for(const option of select.options) {
      const p=findPreset(option.value);
      option.textContent=(p===preset && reversed)?name(target())+' depuis '+from(observer()):name(p.target)+' depuis '+from(p.observer);
    }
  }
  scale.onchange=()=>{field=scale.value;update();save();};
  date.onfocus=pause;
  date.onchange=()=>{if(!setTime(Date.parse(date.value+'Z'),true))update();};
  el('today').onclick=()=>setTime(Math.floor(Date.now()/60000)*60000,true);
  slider.oninput=()=>setTime(begin+(end-begin)*Number(slider.value)/10000);
  el('play').onclick=()=>{if(!playing && t>=end)t=begin;setPlaying(!playing);update();save();};
  el('photo').hidden=!onCapture;
  el('photo').onclick=()=>{
    pause();
    const canvas=document.createElement('canvas');canvas.width=1100;canvas.height=760;
    const ctx=canvas.getContext('2d');paintField(ctx,1100,670,frame,field,disk,false);
    ctx.fillStyle='#0c1720';ctx.fillRect(0,670,1100,90);ctx.textAlign='left';ctx.textBaseline='alphabetic';
    ctx.fillStyle=ink;ctx.font='30px Georgia';ctx.fillText(el('viewpoint').textContent,28,709);
    ctx.fillStyle=cyan;ctx.font='16px monospace';ctx.fillText(utc.format(t)+' UTC  ·  '+el('light').textContent+' éclairés  ·  '+el('diameter').textContent,28,740);
    onCapture?.(canvas,'Observatoire des phases · '+el('viewpoint').textContent);
  };
  el('exit').onclick=()=>onExit?.();
  root.onkeydown=e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('dialog[open]')){e.preventDefault();onExit?.();}};
  function serialize(){return {version:1,presetId:preset.id,reversed,field,timeMs:t,begin,end};}
  function open({presetId,snapshot}={}){
    if(snapshot){
      const p=findPreset(snapshot.presetId);
      if(snapshot.version!==1 || !p || ![snapshot.timeMs,snapshot.begin,snapshot.end].every(Number.isFinite) ||
        snapshot.begin<MIN || snapshot.end>MAX || snapshot.begin>=snapshot.end || snapshot.timeMs<snapshot.begin || snapshot.timeMs>snapshot.end)return false;
      preset=p;reversed=snapshot.reversed===true;field=['auto','1','5','20'].includes(snapshot.field)?snapshot.field:'auto';
      t=snapshot.timeMs;begin=snapshot.begin;end=snapshot.end;
    }else if(presetId){const p=findPreset(presetId);if(!p)return false;preset=p;reversed=false;centerWindow();}
    if(!end)centerWindow();
    closed=false;root.hidden=false;select.value=preset.id;scale.value=field;
    setPlaying(false);syncOption();resample();return true;
  }
  function pause(){if(playing){setPlaying(false);schedule();save();}}
  function close(){pause();save();closed=true;root.hidden=true;cancelAnimationFrame(paintId);paintId=0;}
  function tick(dt){
    if(!playing || !Number.isFinite(dt) || dt<=0 || closed)return;
    elapsed+=Math.min(dt,.25);
    if(elapsed<(reduceMotion()?.25:1/18))return;
    t=Math.min(end,t+(end-begin)*elapsed/(reduceMotion()?30:22));elapsed=0;
    if(t===end){setPlaying(false);save();}
    update();
  }
  return {open,close,pause,tick,serialize,dispose(){close();resize.disconnect();root.onkeydown=null;root.replaceChildren();}};
}
