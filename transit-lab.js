import {isTransitPlanet, transitTarget} from './transit-targets.js';
import {transitGeometry, transitSample} from './transit-model.js';

const dec = (n,digits) => n.toLocaleString('fr-CA',{maximumFractionDigits:digits});
const percent = value => dec(value*100,4)+' %';
const signedHours = hours => (hours < 0 ? '−' : hours > 0 ? '+' : '')+dec(Math.abs(hours),2)+' h';
const descriptions = {full:'Transit complet',grazing:'Transit rasant',miss:'Aucun transit'};
const canvasContext = canvas => {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return null;
  const step = Math.min(window.devicePixelRatio || 1,2);
  const w = Math.round(width*step), h = Math.round(height*step);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(w/width,0,0,h/height,0,0);
  ctx.clearRect(0,0,width,height);
  return {ctx,width,height};
};

function drawDisk(canvas,target,geometry,sample) {
  const frame = canvasContext(canvas);
  if (!frame) return;
  const {ctx,width,height} = frame;
  const r = Math.min(width*.255,height/(2.68+target.radiusRatio*2));
  const cx = width/2, cy = height*.60;
  const x = cx+r*sample.x, y = cy-r*sample.y, planetR = r*target.radiusRatio;
  const circle = (x,y,r) => { ctx.beginPath(); ctx.arc(x,y,r,0,2*Math.PI); ctx.fill(); };
  // Outer glow ends at the exact limb. The luminous surface itself has
  // constant brightness, matching the uniform-disk photometric model.
  const halo = ctx.createRadialGradient(cx,cy,r,cx,cy,r*1.15);
  halo.addColorStop(0,'#edbd7a38'); halo.addColorStop(1,'#edbd7a00');
  ctx.fillStyle = halo; circle(cx,cy,r*1.15);
  ctx.fillStyle = target.star.color; circle(cx,cy,r);
  ctx.strokeStyle = '#829ba763'; ctx.lineWidth = 1; ctx.setLineDash([3,5]); ctx.beginPath();
  for (let i=0;i<=64;i++) {
    const p = transitSample(target,geometry,i/32-1);
    const px = cx+r*p.x, py = cy-r*p.y;
    if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
  }
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#050b12'; circle(x,y,planetR);
  // An outer guide identifies the planet against the dark sky without
  // increasing the silhouette where the planet crosses the stellar limb.
  if (Math.hypot(sample.x,sample.y) >= 1+target.radiusRatio) {
    ctx.strokeStyle = '#8aa6b2'; ctx.beginPath(); ctx.arc(x,y,planetR,0,2*Math.PI); ctx.stroke();
  }
}

function drawCurve(canvas,curve,target,geometry,phase,sample) {
  const frame = canvasContext(canvas);
  if (!frame) return;
  const {ctx,width,height} = frame;
  const left=48, right=width-12, top=16, bottom=height-25;
  const domainDepth = target.radiusRatio**2;
  const x = p => left+(p+1)*(right-left)/2;
  const y = flux => top+(1-flux)/domainDepth*(bottom-top)*.84;
  ctx.font = '11px system-ui,sans-serif'; ctx.textBaseline = 'middle';
  for (const t of [0,.5,1]) {
    const flux=1-t*domainDepth, line=y(flux);
    ctx.strokeStyle='#718b973e'; ctx.beginPath();ctx.moveTo(left,line);ctx.lineTo(right,line);ctx.stroke();
    ctx.fillStyle='#b6c9cf';ctx.textAlign='right';ctx.fillText(dec(flux,5),left-5,line);
  }
  for (const p of [-1,0,1]) {
    ctx.fillStyle='#bdcbd0';ctx.textAlign=p<0?'left':p>0?'right':'center';
    ctx.fillText(signedHours(p*geometry.halfWindowHours),x(p),height-10);
  }
  ctx.beginPath();
  curve.forEach((flux,i) => {
    const cx=x(i*2/(curve.length-1)-1),cy=y(flux);
    if (i===0) ctx.moveTo(cx,cy); else ctx.lineTo(cx,cy);
  });
  ctx.lineWidth=2;ctx.strokeStyle='#84d7d4';ctx.stroke();
  const cx=x(phase),cy=y(sample.flux);
  ctx.lineWidth=1;ctx.strokeStyle='#ffd699b8';ctx.setLineDash([3,3]);
  ctx.beginPath();ctx.moveTo(cx,top-5);ctx.lineTo(cx,bottom);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#ffcc85';ctx.beginPath();ctx.arc(cx,cy,3.5,0,2*Math.PI);ctx.fill();
}

export function createTransitLab(host,{objects=[],initialId,initialImpact,onVisit,onRecord,onObservation,observedId}={}) {
  const view = document.createElement('section');
  view.className='transit-lab';view.setAttribute('aria-label','Observatoire des transits');host.append(view);
  const models = objects.filter(isTransitPlanet).map(p => transitTarget(objects,p.id)).filter(Boolean);
  if (!models.length) {
    view.textContent='Le catalogue ne contient aucun système de transit avec les dimensions nécessaires.';
    return () => view.remove();
  }
  view.innerHTML=`<header class="tl-select"><label>Planète observée<select data-transit-target></select></label>
    <span data-transit-kind></span></header>
    <div class="tl-instruments">
      <figure><figcaption>Disque stellaire <span data-transit-star></span></figcaption><canvas data-transit-disc role="img"></canvas></figure>
      <figure><figcaption>Flux normalisé <span>1 hors transit</span></figcaption><canvas data-transit-curve role="img"></canvas></figure>
    </div>
    <dl class="tl-metrics"><div><dt>Flux au curseur</dt><dd data-transit-flux></dd></div>
      <div><dt>Profondeur maximale</dt><dd data-transit-depth></dd></div>
      <div><dt>Durée du passage</dt><dd data-transit-duration></dd></div></dl>
    <div class="tl-tools">
      <div class="tl-control"><label>Temps autour de la conjonction <output data-transit-time-label></output>
        <input data-transit-time type="range" min="-1" max="1" step="0.001"></label>
        <button type="button" data-transit-play aria-pressed="false">Lire le passage</button></div>
      <div class="tl-control"><label>Paramètre d’impact <output data-transit-impact-label></output>
        <input data-transit-impact type="range" min="0" step="0.001"></label>
        <div class="tl-presets" role="group" aria-label="Géométrie du passage"><button type="button" data-transit-preset="central">Centré</button>
          <button type="button" data-transit-preset="grazing">Rasant</button><button type="button" data-transit-preset="miss">Sans transit</button></div></div>
    </div>
    <p class="tl-method">Courbe simulée pour une orbite circulaire et une étoile de luminosité uniforme. Le paramètre d’impact donne la distance minimale entre les centres, en rayons stellaires. La durée va du premier au dernier contact.</p>
    <div class="tl-links"><button type="button" data-transit-visit></button><button type="button" data-transit-observed>Courbe observée</button>
      <button type="button" data-transit-record>Consigner cette mesure</button><a data-transit-source target="_blank" rel="noopener noreferrer">Données du système</a></div>
    <p class="tl-feedback" data-transit-feedback role="status"></p><div data-transit-notebook></div>`;
  const $ = selector => view.querySelector(selector);
  const select=$('[data-transit-target]'),impact=$('[data-transit-impact]'),time=$('[data-transit-time]');
  const play=$('[data-transit-play]'),disc=$('[data-transit-disc]'),chart=$('[data-transit-curve]');
  const flux=$('[data-transit-flux]'), depth=$('[data-transit-depth]'), duration=$('[data-transit-duration]');
  const timeLabel=$('[data-transit-time-label]'),note=$('[data-transit-feedback]');
  const visits=$('[data-transit-visit]'),record=$('[data-transit-record]'),observed=$('[data-transit-observed]');
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  const grouped=new Map();
  for (const model of models) {
    if (!grouped.has(model.star.id)) {
      const group=document.createElement('optgroup');group.label=model.star.name;select.append(group);grouped.set(model.star.id,group);
    }
    grouped.get(model.star.id).append(new Option(model.planet.name,model.planet.id));
  }
  let target=transitTarget(objects,initialId) || models.find(m=>m.planet.id==='wasp-39-b') ||
    models.find(m=>m.planet.id==='hd-189733-b') || models[0];
  let geometry,curve,phase=0,playing=false,firstPlay=true,frame=0,last=0,closed=false;
  function render() {
    if (closed) return;
    const point=transitSample(target,geometry,phase);
    drawDisk(disc,target,geometry,point);drawCurve(chart,curve,target,geometry,phase,point);
    time.value=phase;
    const label=signedHours(point.hours);
    timeLabel.textContent=label;time.setAttribute('aria-valuetext',label);
    flux.dataset.value=point.flux;flux.textContent=dec(point.flux,6);
    disc.setAttribute('aria-label',target.planet.name+' et '+target.star.name+' à '+label+'. '+descriptions[geometry.kind]+'.');
    chart.setAttribute('aria-label','Flux normalisé à '+label+' : '+flux.textContent+'. Profondeur maximale '+percent(geometry.depth)+'.');
  }
  function pause() {
    playing=false;cancelAnimationFrame(frame);last=0;
    play.setAttribute('aria-pressed','false');play.textContent='Lire le passage';
  }
  function tick(now) {
    if (!playing || closed) return;
    if (!last || now-last>=1000/30) {
      if (last) phase=Math.min(1,phase+Math.min(100,now-last)/4500);
      last=now;render();
    }
    if (phase>=1) pause(); else frame=requestAnimationFrame(tick);
  }
  function configure(next,reference=false) {
    pause();geometry=transitGeometry(target,next);
    curve=Array.from({length:301},(_,i)=>transitSample(target,geometry,i/150-1).flux);
    select.value=target.planet.id;impact.max=String(Math.floor(geometry.limit*1000)/1000);impact.value=geometry.b;
    const detail='b = '+dec(geometry.b,3)+' · i = '+dec(geometry.inclination,3)+'°';
    $('[data-transit-impact-label]').textContent=detail;impact.setAttribute('aria-valuetext',detail);
    $('[data-transit-star]').textContent=target.star.name;
    $('[data-transit-kind]').textContent=descriptions[geometry.kind];
    depth.dataset.value=geometry.depth;depth.textContent=percent(geometry.depth);
    duration.dataset.hours=geometry.durationHours;duration.textContent=geometry.durationHours ? dec(geometry.durationHours,3)+' h' : '0 h';
    for (const button of view.querySelectorAll('[data-transit-preset]')) {
      const values={central:0,grazing:1,miss:1+target.radiusRatio+.16};
      button.setAttribute('aria-pressed',String(Math.abs(geometry.b-values[button.dataset.transitPreset])<.0001));
    }
    const given=Number.isFinite(target.planet.transitInclinationDeg);
    note.textContent=reference ? (given ? 'Inclinaison initiale issue du catalogue.' : 'Géométrie initiale illustrative.') : '';
    visits.hidden=typeof onVisit!=='function';visits.textContent='Explorer '+target.planet.name;
    record.hidden=typeof onRecord!=='function';
    observed.hidden=typeof onObservation!=='function' || observedId!==target.planet.id;
    const source=$('[data-transit-source]');
    source.href=target.planet.sourceUrl || 'https://exoplanetarchive.ipac.caltech.edu/overview/'+encodeURIComponent(target.planet.name);
    render();
  }
  select.onchange=()=>{
    target=models.find(m=>m.planet.id===select.value);phase=0;firstPlay=true;configure(undefined,true);
  };
  for (const button of view.querySelectorAll('[data-transit-preset]')) button.onclick=()=>{
    const values={central:0,grazing:1,miss:1+target.radiusRatio+.16};
    phase=0;firstPlay=true;configure(values[button.dataset.transitPreset]);
  };
  impact.oninput=()=>configure(impact.valueAsNumber);
  time.oninput=()=>{pause();firstPlay=false;phase=time.valueAsNumber;render();};
  play.onclick=()=>{
    if (playing) {pause();return;}
    if (firstPlay || phase>=1) phase=-1;
    firstPlay=false;playing=true;last=0;
    play.textContent='Pause';play.setAttribute('aria-pressed','true');render();frame=requestAnimationFrame(tick);
  };
  visits.onclick=()=>onVisit?.(target.planet.id);
  observed.onclick=()=>onObservation?.(target.planet.id);
  record.onclick=async()=>{
    const measure={planetId:target.planet.id,impact:geometry.b,depth:geometry.depth,durationHours:geometry.durationHours};
    let success;
    try { success=await onRecord?.(measure); } catch { success=false; }
    if (!closed && success===false) note.textContent='La mesure n’a pas pu être enregistrée.';
  };
  const visibility=()=>{if (document.hidden) pause();};
  const motion=()=>{if (reduced.matches) pause();};
  document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',motion);
  configure(initialImpact,!Number.isFinite(initialImpact));
  const observer=new ResizeObserver(render);observer.observe(disc);observer.observe(chart);
  return ()=>{closed=true;pause();observer.disconnect();document.removeEventListener('visibilitychange',visibility);
    reduced.removeEventListener('change',motion);view.remove();};
}
