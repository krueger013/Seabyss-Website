import { createPhenomenaRenderer } from './phenomena-scenes.js';
import { BLACK_HOLE_LIMITS } from './relativity-model.js';

const TAU=Math.PI*2;
const HORIZON='#ffc683', PHOTONS='#b9a8fa', ISCO='#88cadd';
const rayColors={escaped:'#9cf2f1',captured:'#ffaa80',critical:'#cdb7ff'};
const rays=new WeakMap();
const clamp=(value,low,high)=>Math.max(low,Math.min(value,high));
const circle=(ctx,x,y,radius)=>{ctx.beginPath();ctx.arc(x,y,radius,0,TAU);};
const fmt=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2}).format;

function stars() {
  let seed=20396821;
  const next=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  return Array.from({length:380},()=>[next(),next(),next(),next()]);
}

function cachedSky(width,height,field) {
  const sky=document.createElement('canvas');
  sky.width=width;sky.height=height;
  const ctx=sky.getContext('2d');
  ctx.fillStyle='#070b16';ctx.fillRect(0,0,width,height);
  const edge=Math.max(width,height);
  const halos=[[.12,.72,.52,'#282045'],[.74,.24,.49,'#142b42'],[.48,.65,.56,'#202040']];
  for (const [x,y,size,tint] of halos) {
    const glow=ctx.createRadialGradient(width*x,height*y,0,width*x,height*y,edge*size);
    glow.addColorStop(0,tint);glow.addColorStop(1,'#0b0d2000');
    ctx.fillStyle=glow;ctx.fillRect(0,0,width,height);
  }
  for(const [x,y,b,hue] of field) {
    ctx.globalAlpha=.17+.6*b*b*b;
    ctx.fillStyle=hue>.75?'#f5c6b2':hue>.5?'#b2c8fa':'#d4e6fa';
    circle(ctx,x*width,y*height,.25+b*b*.9);ctx.fill();
    if(b>.98) {
      ctx.globalAlpha=.23;
      ctx.fillRect(x*width-3,y*height-.35,6,.7);
      ctx.fillRect(x*width-.35,y*height-2.4,.7,4.8);
    }
  }
  return sky;
}

function plotRay(ray) {
  if(!ray?.points?.length) return null;
  if(rays.has(ray)) return rays.get(ray);
  const points=ray.points;
  const line=new Path2D();
  let length=0;
  const distance=new Float64Array(points.length);
  line.moveTo(points[0].x,points[0].y);
  for(let index=1;index<points.length;index++) {
    const point=points[index],prior=points[index-1];
    length+=Math.hypot(point.x-prior.x,point.y-prior.y);
    distance[index]=length;
    line.lineTo(point.x,point.y);
  }
  const plotted={line,points,distance,length};
  rays.set(ray,plotted);
  return plotted;
}

function rayPosition({points,distance,length},progress) {
  const covered=clamp(progress,0,1)*length;
  if(covered<=0) return points[0];
  let first=1,last=points.length-1;
  while(first<last) {
    const middle=Math.floor((first+last)/2);
    if(distance[middle]<covered) first=middle+1;else last=middle;
  }
  const prior=points[first-1],next=points[first];
  const part=(covered-distance[first-1])/(distance[first]-distance[first-1] || 1);
  return {x:prior.x+(next.x-prior.x)*part,y:prior.y+(next.y-prior.y)*part};
}

function spot(ctx,x,y,color) {
  ctx.fillStyle=color;
  ctx.shadowBlur=11;ctx.shadowColor=color;
  circle(ctx,x,y,3.6);ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='#fff7ef';circle(ctx,x,y,1.35);ctx.fill();
}

function marker(ctx,x,y,label,color,width,height) {
  spot(ctx,x,y,color);
  const toLeft=x>width-94, tx=clamp(x+(toLeft?-9:9),5,width-5),ty=clamp(y-5,15,height-7);
  ctx.font='600 11px system-ui,sans-serif';ctx.textAlign=toLeft?'right':'left';ctx.textBaseline='bottom';
  ctx.lineWidth=4;ctx.strokeStyle='#080c1c';ctx.strokeText(label,tx,ty);
  ctx.fillStyle='#edf5fc';ctx.fillText(label,tx,ty);
}

function band(ctx,x,y,radius,color,dashes) {
  ctx.strokeStyle=color;ctx.lineWidth=1.15;ctx.setLineDash(dashes);
  circle(ctx,x,y,radius);ctx.stroke();ctx.setLineDash([]);
}

function blackHole(ctx,cx,cy,scale,withGuides) {
  const radius=BLACK_HOLE_LIMITS.horizon*scale;
  const glow=ctx.createRadialGradient(cx,cy,radius*.7,cx,cy,radius*3.7);
  glow.addColorStop(0,'#fb96675c');glow.addColorStop(.29,'#a88ace3d');
  glow.addColorStop(.56,'#55488e22');glow.addColorStop(1,'#33265800');
  ctx.fillStyle=glow;circle(ctx,cx,cy,radius*3.7);ctx.fill();
  if(withGuides) {
    band(ctx,cx,cy,BLACK_HOLE_LIMITS.isco*scale,'#88cadd88',[3,6]);
    band(ctx,cx,cy,BLACK_HOLE_LIMITS.photonSphere*scale,'#b9a8fab0',[3,3]);
  }
  ctx.fillStyle='#02040b';circle(ctx,cx,cy,radius);ctx.fill();
  ctx.shadowBlur=7;ctx.shadowColor='#ed8b5e';
  band(ctx,cx,cy,radius,HORIZON,[]);ctx.shadowBlur=0;
}

function backgroundGrid(ctx,cx,cy,scale,width,height) {
  const step=scale*2**Math.max(1,Math.ceil(Math.log2(20/scale)));
  ctx.strokeStyle='#97bbdd18';ctx.lineWidth=.65;ctx.beginPath();
  for(let x=cx%step;x<=width;x+=step) {ctx.moveTo(x,0);ctx.lineTo(x,height);}
  for(let y=cy%step;y<=height;y+=step) {ctx.moveTo(0,y);ctx.lineTo(width,y);}
  ctx.stroke();
}

function ruler(ctx,scale,height) {
  const count=Math.max(1,Math.round(30/scale));
  const length=count*scale;
  if(height<100 || length>80) return;
  const x=14,y=height-15;
  ctx.strokeStyle='#b5d0df9c';ctx.lineWidth=1;ctx.lineCap='butt';ctx.beginPath();
  ctx.moveTo(x,y-3);ctx.lineTo(x,y+3);ctx.moveTo(x,y);ctx.lineTo(x+length,y);
  ctx.moveTo(x+length,y-3);ctx.lineTo(x+length,y+3);ctx.stroke();
  ctx.fillStyle='#c7e1ee';ctx.font='11px system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';
  ctx.fillText(count+' Rₛ',x+length+6,y+3);
}

function drawRay(ctx,state,cx,cy,scale,width,height) {
  const y=cy-state.impact*scale;
  if(state.showGuides && y>0 && y<height) {
    ctx.strokeStyle='#b2c7da64';ctx.lineWidth=.9;ctx.setLineDash([4,7]);
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();ctx.setLineDash([]);
  }
  const record=plotRay(state.ray);
  if(!record) return;
  const color=rayColors[state.ray.status] || rayColors.escaped;
  ctx.save();ctx.translate(cx,cy);ctx.scale(scale,-scale);
  ctx.strokeStyle=color;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.globalAlpha=.14;ctx.lineWidth=9/scale;ctx.stroke(record.line);
  ctx.globalAlpha=.39;ctx.lineWidth=4/scale;ctx.stroke(record.line);
  ctx.globalAlpha=1;ctx.lineWidth=1.4/scale;ctx.stroke(record.line);
  ctx.restore();
  if(state.progress>0 || state.running) {
    const point=rayPosition(record,state.progress);
    spot(ctx,cx+point.x*scale,cy-point.y*scale,color);
  }
}

function drawObserver(ctx,state,cx,cy,scale,width,height) {
  const rotating=state.clock!=='hover';
  if(state.radius<=1 || rotating && state.radius<=BLACK_HOLE_LIMITS.photonSphere) return;
  const angle=rotating?TAU*state.progress-.63:-.63;
  const distance=state.radius*scale;
  if(rotating) band(ctx,cx,cy,distance,'#80ead6b0',[5,4]);
  const x=cx+distance*Math.cos(angle),y=cy-distance*Math.sin(angle);
  if(x<4 || y<4 || x>width-4 || y>height-4) return;
  marker(ctx,x,y,rotating?'Horloge en orbite':'Horloge fixe','#8ce4d5',width,height);
}

function drawFall(ctx,state,cx,cy,scale,width,height) {
  const angle=.34,dx=Math.cos(angle)*scale,dy=-Math.sin(angle)*scale;
  const start=Math.max(1,state.fall?.startRadius || state.radius);
  const stop=clamp(state.fall?.endRadius ?? 1,0,start);
  const now=clamp(state.fall?.radius ?? start,0,start);
  const x=cx+dx*now,y=cy+dy*now;
  const sx=cx+dx*start,sy=cy+dy*start;
  ctx.lineWidth=1.1;ctx.strokeStyle='#dcc8f3a4';ctx.setLineDash([4,5]);
  ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(cx+dx*stop,cy+dy*stop);ctx.stroke();ctx.setLineDash([]);
  ctx.strokeStyle='#e1caff';ctx.lineWidth=1.8;
  ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(x,y);ctx.stroke();
  const label=now<1?'Sous l’horizon':now<=1.0001?'Horizon atteint':'Sonde';
  if(x>4 && y>4 && x<width-4 && y<height-4) marker(ctx,x,y,label,'#d2b4fd',width,height);
}

const sceneMarkup=`<div class="rl-scene-stage">
  <canvas tabindex="0" data-relativity-canvas aria-label="Schéma du trou noir"></canvas>
  <span class="rl-scene-note" data-relativity-scene-note>Coupe équatoriale</span>
</div><div class="rl-scene-controls" aria-label="Cadrage du trou noir">
  <div class="rl-view-switch" role="group" aria-label="Vue">
    <button type="button" data-relativity-view="diagram" aria-pressed="true">Schéma</button>
    <button type="button" data-relativity-view="disk" aria-pressed="false">Disque</button>
  </div>
  <div class="rl-scaling" role="group" data-relativity-scene-scaling aria-label="Grossissement">
    <button type="button" data-relativity-zoom="out" aria-label="Éloigner le schéma" title="Éloigner le schéma">−</button>
    <button type="button" data-relativity-zoom="in" aria-label="Rapprocher le schéma" title="Rapprocher le schéma">+</button>
  </div>
</div><div class="rl-scene-guide" data-relativity-scene-guide aria-label="Repères du schéma">
  <span>Horizon</span><span>Sphère photonique</span><span>Orbite stable minimale</span>
</div>`;

export function createRelativityScene(host,{onRayPick}={}) {
  host.classList.add('relativity-scene');host.innerHTML=sceneMarkup;
  const $=selector=>host.querySelector(selector),canvas=$('[data-relativity-canvas]');
  const context=canvas.getContext('2d',{alpha:false});
  const guides=$('[data-relativity-scene-guide]'),note=$('[data-relativity-scene-note]');
  const control=$('[data-relativity-scene-scaling]');
  const buttons=Array.from(host.querySelectorAll('[data-relativity-view]'));
  const out=$('[data-relativity-zoom="out"]'),inside=$('[data-relativity-zoom="in"]');
  const renderer=context?createPhenomenaRenderer(canvas):null;
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const field=stars();
  let state={mode:'lens',radius:4.5,impact:2.75,progress:0,showGuides:true,clock:'orbit'};
  let view='diagram',zoom=0,inclination=74,frame=0,dirty=true,disposed=false,lastPaint=0;
  let sky=null,projection=null;

  function syncControls() {
    const disk=view==='disk';
    for(const button of buttons) button.setAttribute('aria-pressed',String(button.dataset.relativityView===view));
    guides.hidden=disk || !state.showGuides;
    control.setAttribute('aria-label',disk?'Inclinaison du disque':'Grossissement');
    out.setAttribute('aria-label',disk?'Réduire l’inclinaison du disque':'Éloigner le schéma');
    inside.setAttribute('aria-label',disk?'Augmenter l’inclinaison du disque':'Rapprocher le schéma');
    out.title=out.getAttribute('aria-label');inside.title=inside.getAttribute('aria-label');
    out.disabled=disk?inclination<=12:zoom<=-2;
    inside.disabled=disk?inclination>=88:zoom>=3;
    note.textContent=disk?'Disque illustré · '+fmt(inclination)+'°':'Coupe équatoriale';
    canvas.dataset.view=view;
    canvas.dataset.mode=state.mode;
    canvas.setAttribute('aria-label',disk?'Disque d’accrétion illustré autour d’un trou noir':state.mode==='lens'
      ? 'Trajectoire calculée du rayon. Touche le schéma ou utilise les flèches pour régler le paramètre d’impact.'
      : state.mode==='fall'?'Trajectoire de la sonde en chute radiale':'Schéma de l’horloge dans le champ du trou noir');
  }

  function invalidate() {
    dirty=true;
    if(!disposed && !frame) frame=requestAnimationFrame(paint);
  }

  function paint(now,force=false) {
    frame=0;
    if(!context || disposed || !dirty && !force) return;
    if(!force && now-lastPaint<(view==='disk'?60:27)) {frame=requestAnimationFrame(paint);return;}
    const width=canvas.clientWidth,height=canvas.clientHeight;
    if(!width || !height) return;
    lastPaint=now;dirty=false;
    if(view==='disk') {
      context.setTransform(1,0,0,1,0,0);
      renderer.draw('black-hole',inclination,motion.matches?0:state.progress*4);
      return;
    }
    const dpr=Math.min(1.6,window.devicePixelRatio||1);
    const pixelsWide=Math.round(width*dpr),pixelsHigh=Math.round(height*dpr);
    if(canvas.width!==pixelsWide || canvas.height!==pixelsHigh || !sky || sky.width!==pixelsWide || sky.height!==pixelsHigh) {
      canvas.width=pixelsWide;canvas.height=pixelsHigh;
      sky=cachedSky(pixelsWide,pixelsHigh,field);
    }
    context.setTransform(dpr,0,0,dpr,0,0);
    context.drawImage(sky,0,0,width,height);
    const cx=width*.49,cy=height*.51;
    const farRadius=state.mode==='fall'?state.fall?.startRadius ?? state.radius:state.radius;
    const span=state.mode==='lens'?Math.max(4.7,Math.abs(state.impact)*1.15+1):Math.max(3.8,farRadius*1.14);
    const scale=Math.min((height*.47)/span,(width*.45)/(span*.85))*1.28**zoom;
    projection={cx,cy,scale};
    if(state.showGuides) backgroundGrid(context,cx,cy,scale,width,height);
    blackHole(context,cx,cy,scale,state.showGuides);
    if(state.mode==='lens') drawRay(context,state,cx,cy,scale,width,height);
    else if(state.mode==='fall') drawFall(context,state,cx,cy,scale,width,height);
    else drawObserver(context,state,cx,cy,scale,width,height);
    ruler(context,scale,height);
  }

  function setView(next) {view=next;syncControls();invalidate();}
  function changeScale(direction) {
    if(view==='disk') inclination=clamp(inclination+direction*19,12,88);
    else zoom=clamp(zoom+direction,-2,3);
    syncControls();invalidate();
  }

  for(const button of buttons) button.onclick=()=>setView(button.dataset.relativityView);
  out.onclick=()=>changeScale(-1);inside.onclick=()=>changeScale(1);
  canvas.onclick=event=>{
    if(view!=='diagram' || state.mode!=='lens' || !projection || event.detail===0) return;
    const {top}=canvas.getBoundingClientRect();
    const impact=(projection.cy-(event.clientY-top))/projection.scale;
    onRayPick?.(Math.round(100*impact)/100);
  };
  canvas.onkeydown=event=>{
    if(event.altKey || event.metaKey || event.ctrlKey) return;
    if(event.key==='+' || event.key==='=') changeScale(1);
    else if(event.key==='-') changeScale(-1);
    else if(view==='diagram' && state.mode==='lens' && ['ArrowUp','ArrowDown'].includes(event.key) && onRayPick) {
      const step=event.shiftKey?.5:.05;
      onRayPick(Math.round((state.impact+(event.key==='ArrowUp'?step:-step))*100)/100);
    } else return;
    event.preventDefault();event.stopPropagation();
  };
  const resize=new ResizeObserver(invalidate);resize.observe(canvas);
  motion.addEventListener('change',invalidate);
  syncControls();invalidate();

  return {
    update(next={}) {
      const previous=state;
      state={...state,...next};
      state.mode=({light:'lens',clock:'orbit',clocks:'orbit',dive:'fall'})[state.mode] || state.mode;
      state.radius=Number.isFinite(state.radius)?Math.max(1,state.radius):4.5;
      state.impact=Number.isFinite(state.impact)?state.impact:2.75;
      state.progress=Number.isFinite(state.progress)?clamp(state.progress,0,1):0;
      if(previous.mode!==state.mode || previous.showGuides!==state.showGuides) syncControls();
      if(previous.ray?.status!==state.ray?.status) canvas.dataset.rayStatus=state.ray?.status || '';
      invalidate();
    },
    capture() {
      if(frame) {cancelAnimationFrame(frame);frame=0;}
      paint(performance.now(),true);
      if(!context || !canvas.width || !canvas.height) return null;
      const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;
      copy.getContext('2d').drawImage(canvas,0,0);
      return copy;
    },
    dispose() {
      disposed=true;cancelAnimationFrame(frame);resize.disconnect();motion.removeEventListener('change',invalidate);
      host.replaceChildren();
    }
  };
}
