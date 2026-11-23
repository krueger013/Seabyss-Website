import { createOrbitalSky } from './orbital-sky.js';
import { createGlobes } from './system-view.js';
import { G, rocheLimit } from './sandbox-physics.js';

const TAU = Math.PI * 2;
const KM_PER_AU = 149597870.7;
const AU_PER_DAY_TO_KMS = KM_PER_AU / 86400;
const AU_PER_DAY2_TO_MS2 = KM_PER_AU*1000/86400**2;
const MIN_SPAN = 1e-9, MAX_SPAN = 5e16;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const length = v => Math.hypot(...v);
const difference = (a,b) => a.map((v,i) => v-b[i]);
const number = new Intl.NumberFormat('fr-CA',{maximumSignificantDigits:3});
const bodyRank = {star:5, planet:4, moon:3, comet:2, asteroid:1};
const isRingRock = body => body.kind==='asteroid' && body.id.startsWith('ring-');
const cameraPresets = {
  perspective: {label:'Vue 3D',yaw:-.42,pitch:.53},
  top: {label:'Dessus',yaw:0,pitch:Math.PI/2},
  side: {label:'Profil',yaw:0,pitch:0}
};
const axes = [
  {vector:[1,0,0],label:'X',color:'#f29d87'},
  {vector:[0,1,0],label:'Y',color:'#b3dfaf'},
  {vector:[0,0,1],label:'Z',color:'#87cde4'}
];
const gravityColors = [[43,104,155],[91,207,207],[246,190,118]];

function formatDistance(au) {
  if (au >= .02) return number.format(au)+' UA';
  const km=au*KM_PER_AU;
  return km>=1 ? number.format(km)+' km' : number.format(km*1000)+' m';
}

function formatAcceleration(value) {
  return value>=.001&&value<1000 ? number.format(value) : value.toExponential(1).replace('.',',');
}

function asteroidShape(id) {
  let seed=2166136261;
  for (const character of id) seed=Math.imul(seed^character.charCodeAt(0),16777619);
  const random=()=>{
    seed=Math.imul(seed,1664525)+1013904223|0;
    return (seed>>>0)/4294967296;
  };
  const ridges=Array.from({length:9},(_,index)=>{
    const angle=(index+random()*.3)*TAU/9;
    const radius=.67+random()*.32;
    return [Math.cos(angle)*radius,Math.sin(angle)*radius];
  });
  return {rotation:random()*TAU,rate:random()*4+1,ridges};
}

function graduatedStep(value) {
  const decade = 10 ** Math.floor(Math.log10(value));
  const ratio = value/decade;
  return (ratio>=5 ? 5 : ratio>=2 ? 2 : 1)*decade;
}

function dominantAt(point,bodies,except,tidal=true) {
  let greatest=-1, result=null;
  for (const body of bodies) {
    if (body===except) continue;
    const delta=difference(body.position,point);
    const squared=Math.max(1e-18,body.radius**2,delta[0]**2+delta[1]**2+delta[2]**2);
    const influence=body.mass/(tidal?squared*Math.sqrt(squared):squared);
    if (influence>greatest) { greatest=influence; result=body; }
  }
  return result;
}

function orbitDuration(body,primary,span) {
  if (!primary) return 15;
  const separation=length(difference(body.position,primary.position));
  const radius=Math.max(primary.radius, Math.min(separation,span*7));
  return clamp(TAU*Math.sqrt(radius**3/(G*(primary.mass+body.mass))),.012,700);
}

function drawLine(ctx,x0,y0,x1,y1) {
  ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();
}

function createProjection(width,height,span,target,yaw,pitch) {
  const ax=Math.cos(yaw), az=Math.sin(yaw), ce=Math.cos(pitch), se=Math.sin(pitch);
  const scale=Math.min(width*.44,height*.42/Math.max(.42,Math.abs(se)))/span;
  const cx=width*.5, cy=height*.49;
  function direction(v) {
    const side=v[0]*ax+v[2]*az, along=-v[0]*az+v[2]*ax;
    return {x:side, y:along*se-v[1]*ce, depth:along*ce+v[1]*se};
  }
  function project(point) {
    const v=direction(difference(point,target));
    return {x:cx+v.x*scale,y:cy+v.y*scale,depth:v.depth};
  }
  function onPlane(x,y,planeY) {
    const safe=Math.abs(se)<.075 ? (se<0?-.075:.075) : se;
    const side=(x-cx)/scale, along=((y-cy)/scale+(planeY-target[1])*ce)/safe;
    return [target[0]+side*ax-along*az,planeY,target[2]+side*az+along*ax];
  }
  function viewOffset(x,y) {
    const across=(x-cx)/scale, up=(y-cy)/scale;
    return [across*ax-up*se*az,-up*ce,across*az+up*se*ax];
  }
  return {cx,cy,scale,direction,project,onPlane,viewOffset};
}

export function createSandboxView(container, {getBodies,getTime=()=>0,onSelect,
    buildProjectile,predict,predictBody,onLaunch,onCancelPlacement,onFollowChange}) {
  container.classList.add('sandbox-viewport');
  const canvas=document.createElement('canvas'),labels=document.createElement('div');
  canvas.dataset.sandboxCanvas=''; canvas.tabIndex=0;
  canvas.setAttribute('aria-label','Bac à sable gravitationnel en trois dimensions. Glisser pour orienter la vue. Double-cliquer ou toucher deux fois pour s’approcher. Utiliser plus ou moins pour zoomer.');
  labels.className='sb-sky-labels';
  const tip=document.createElement('div'); tip.className='sb-aim-tip';tip.hidden=true;
  const scaleLabel=document.createElement('div'); scaleLabel.className='sb-scene-scale';
  scaleLabel.innerHTML='<span></span><button type="button" data-sb-view-scale aria-pressed="false">Rayons agrandis</button><small class="sb-forecast-key" hidden>Prévision</small>';
  const controls=document.createElement('div');controls.className='sb-view-controls';
  controls.setAttribute('role','group');controls.setAttribute('aria-label','Caméra et mesures');
  controls.innerHTML='<select aria-label="Orientation de la caméra" data-sb-view-angle></select>'+
    '<button type="button" data-sb-view-fit aria-label="Cadrer tous les corps" title="Cadrer tous les corps">⛶</button>'+
    '<button type="button" data-sb-view-ruler aria-pressed="false" aria-label="Mesurer la distance au repère" title="Distance au repère">↔</button>'+
    '<button type="button" data-sb-view-vectors aria-pressed="false" aria-label="Afficher la vitesse relative" title="Vitesse relative">↗</button>'+
    '<button type="button" data-sb-view-field aria-pressed="false" aria-label="Afficher le champ gravitationnel" title="Champ gravitationnel">Champ</button>';
  const angleControl=controls.querySelector('select');
  for (const [id,preset] of Object.entries(cameraPresets)) angleControl.add(new Option(preset.label,id));
  angleControl.add(new Option('Vue libre','free'));
  angleControl.lastElementChild.disabled=true;
  const measurements=document.createElement('output');
  measurements.className='sb-view-measurements';measurements.dataset.sbViewMeasurements='';
  measurements.setAttribute('aria-live','off');measurements.hidden=true;
  const fieldLegend=document.createElement('aside');
  fieldLegend.className='sb-field-legend';fieldLegend.dataset.sbFieldLegend='';fieldLegend.hidden=true;
  fieldLegend.setAttribute('aria-label','Légende du champ gravitationnel');
  fieldLegend.innerHTML='<strong>Champ gravitationnel</strong><span>Coupe du plan de vue · échelle log.</span><i aria-hidden="true"></i><small></small><small hidden></small>';
  const fieldRange=fieldLegend.querySelector('small'),rocheLabel=fieldLegend.lastElementChild;
  container.replaceChildren(canvas,labels,tip,scaleLabel,controls,measurements,fieldLegend);
  const ctx=canvas.getContext('2d',{alpha:false});
  const skyCanvas=document.createElement('canvas'), skyContext=skyCanvas.getContext('2d',{alpha:false});
  const fieldCanvas=document.createElement('canvas'),fieldContext=fieldCanvas.getContext('2d');
  const heatMap=document.createElement('canvas'),heatContext=heatMap.getContext('2d');
  let width=1,height=1,dpr=1,span=2,yaw=-.42,pitch=.53,center=[0,0,0];
  let selected=null,referenceId=null,follow=false,placement=false,names=true,trails=true,disposed=false;
  let ruler=false,vectors=false,physicalRadii=false,field=false;
  let dirty=true,skySignature='',lastTime=NaN,lastCount=-1,lastStamp=0,raf=0;
  let fieldSignature='',lastFieldStamp=0,lastFieldDay=NaN;
  let draft=null,move=null,pinch=null,suppressTap=false,seenThrough=-Infinity,historyFrame=null,lastSignature='';
  let flight=null,lastTap=null;
  let restoredDay=null;
  let selectedForecast=null,lastForecast=0,projected=[],effects=[];
  const asteroidShapes=new Map(), fragmentBirth=new Map();
  const tracks=new Map(),pins=new Map(),pointers=new Map(),seenEvents=new Set();
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const sky=createOrbitalSky(()=>{skySignature='';invalidate();});
  const globes=createGlobes(invalidate);
  globes.request('earth');

  function scheduleRender() {
    if (!raf&&!disposed) raf=requestAnimationFrame(()=>{raf=0;render();});
  }
  function invalidate() {
    if (disposed) return;
    dirty=true;
    scheduleRender();
  }
  function measure() {
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if (!w||!h) return false;
    const ratio=Math.min(2,window.devicePixelRatio||1);
    if (width!==w||height!==h||dpr!==ratio) {
      width=w;height=h;dpr=ratio;
      canvas.width=skyCanvas.width=Math.round(w*dpr);canvas.height=skyCanvas.height=Math.round(h*dpr);
      ctx.setTransform(dpr,0,0,dpr,0,0);skyContext.setTransform(dpr,0,0,dpr,0,0);dirty=true;skySignature='';
      for(const pin of pins.values())pin.measuredWidth=0;
    }
    return true;
  }
  function projection() {return createProjection(width,height,span,center,yaw,pitch);}
  function choose(id) {if (id!=null) {setSelected(id); onSelect?.(id);}}
  function setSelected(id) {
    if (id===selected) return;
    selected=id;selectedForecast=null;lastForecast=0;
    if(follow)fieldSignature='';
    invalidate();
  }
  function at(x,y) {
    let closest=null,best=Infinity;
    for(const p of projected) {
      const d=Math.hypot(x-p.x,y-p.y);
      if (d<=Math.max(16,p.r+5) && d<best) {closest=p;best=d;}
    }
    return closest;
  }
  function selectPin(body) {
    const pin=document.createElement('button');
    pin.type='button';pin.className='sb-object-name';pin.dataset.sandboxBody=body.id;
    pin.onclick=()=>choose(body.id);
    pin.ondblclick=()=>travel(null,body.id);
    labels.append(pin);pins.set(body.id,pin);
    return pin;
  }
  function updatePins(points) {
    const occupied=[controls,fieldLegend].filter(element=>!element.hidden).map(element=>({
      x:element.offsetLeft,y:element.offsetTop,w:element.offsetWidth,h:element.offsetHeight
    }));
    const overlays=occupied.length;
    const order=points.slice().sort((a,b)=>(b.body.id===selected)-(a.body.id===selected) ||
      (bodyRank[b.body.kind]||0)-(bodyRank[a.body.kind]||0) || b.r-a.r);
    for(const {x,y,r,body} of order) {
      const pin=pins.get(body.id)||selectPin(body);
      if(pin.textContent!==body.name) {pin.textContent=body.name;pin.setAttribute('aria-label','Sélectionner '+body.name);pin.measuredWidth=0;}
      const active=body.id===selected;
      if(pin.getAttribute('aria-pressed')!==String(active)){pin.setAttribute('aria-pressed',String(active));pin.measuredWidth=0;}
      const tooManyLabels=points.length>=32&&occupied.length-overlays>=(width<630?10:18);
      if (!names||(!active&&(isRingRock(body)||tooManyLabels))||x<-8||x>width+8||y<-8||y>height+8) {pin.hidden=true;continue;}
      pin.tabIndex=placement?-1:0;
      if(pin.style.getPropertyValue('--body-color')!==body.color)pin.style.setProperty('--body-color',body.color);
      pin.hidden=false;
      const w=pin.measuredWidth||pin.offsetWidth,h=pin.measuredHeight||pin.offsetHeight;
      pin.measuredWidth=w;pin.measuredHeight=h;
      const ideal=clamp(x-w/2,3,Math.max(3,width-w-3)), top=y-r-h-4;
      const positions=[[ideal,top],[ideal,top-h-1],[x+8,top],[x-w-8,top],[ideal,y+r+3]];
      let chosen=null;
      for(const [left,up] of positions) {
        if(left<1||up<1||left+w>width-1||up+h>height-1) continue;
        if(occupied.some(a=>left<a.x+a.w+2 && left+w+2>a.x && up<a.y+a.h+1 && up+h+1>a.y)) continue;
        chosen={x:left,y:up,w,h};break;
      }
      if(!chosen) {pin.hidden=true;continue;}
      pin.style.transform='translate('+Math.round(chosen.x)+'px,'+Math.round(chosen.y)+'px)';
      occupied.push(chosen);
    }
  }
  function record(bodies,day,frame) {
    if((frame?.id||null)!==historyFrame){tracks.clear();selectedForecast=null;historyFrame=frame?.id||null;}
    const living=new Set(bodies.map(b=>b.id));
    for(const id of pins.keys()) if(!living.has(id)) {pins.get(id).remove();pins.delete(id);}
    for(const id of tracks.keys()) if(!living.has(id)) tracks.delete(id);
    for(const id of asteroidShapes.keys()) if(!living.has(id)) asteroidShapes.delete(id);
    for(const id of fragmentBirth.keys()) if(!living.has(id)) fragmentBirth.delete(id);
    const historyLimit=bodies.length>=32 ? 80 : 192;
    for(const body of bodies) {
      let history=tracks.get(body.id);
      if(!history) {history=[];tracks.set(body.id,history);}
      const last=history[history.length-1];
      const point=frame?difference(body.position,frame.position):body.position;
      if (last && (day===last.day || length(difference(point,last.p))<span*.003)) continue;
      history.push({day,p:point.slice()});
      if(history.length>historyLimit) history.splice(0,history.length-historyLimit);
    }
  }
  function drawTrack(points,project,color,alpha,lineWidth,dashed=false) {
    if(!points||points.length<2) return;
    ctx.save();ctx.strokeStyle=color;ctx.globalAlpha=alpha;ctx.lineWidth=lineWidth;
    if(dashed)ctx.setLineDash([3,5]);
    ctx.beginPath();
    points.forEach((v,i)=>{const p=project(v);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);});
    ctx.stroke();ctx.restore();
  }
  function drawRingBands(bodies,project) {
    const center=bodies.find(body=>body.id==='aronde');
    if(!center)return;
    const bands=[[],[],[]];
    for(const body of bodies) {
      if(!isRingRock(body))continue;
      const band=Math.floor(Number(body.id.slice(5))/6);
      const offset=difference(body.position,center.position);
      bands[band]?.push({body,angle:Math.atan2(offset[2],offset[0])});
    }
    ctx.save();
    for(const band of bands) {
      if(band.length!==6)continue;
      band.sort((a,b)=>a.angle-b.angle);
      // A soft trace connects the simulated ice in each band. Large gaps
      // interrupt the trace after a perturbation instead of hiding it.
      const points=band.map(({body,angle})=>({...project(body.position),angle,color:body.color}));
      ctx.strokeStyle=points[0].color;
      for(let i=0;i<points.length;i++) {
        const here=points[i],prev=points.at(i-1),next=points[(i+1)%points.length];
        if((next.angle-here.angle+TAU)%TAU>1.6)continue;
        const after=points[(i+2)%points.length];
        ctx.beginPath();ctx.moveTo(here.x,here.y);
        ctx.bezierCurveTo(here.x+(next.x-prev.x)/6,here.y+(next.y-prev.y)/6,
          next.x-(after.x-here.x)/6,next.y-(after.y-here.y)/6,next.x,next.y);
        ctx.globalAlpha=.10;ctx.lineWidth=7;ctx.stroke();
        ctx.globalAlpha=.28;ctx.lineWidth=.8;ctx.stroke();
      }
    }
    ctx.restore();
  }
  function renderTracks(bodies,pr,day,now,frame) {
    scaleLabel.lastElementChild.hidden=true;
    if(!trails) return;
    const project=frame?point=>pr.project(point.map((v,i)=>v+frame.position[i])):pr.project;
    drawRingBands(bodies,pr.project);
    for(const body of bodies) {
      const history=tracks.get(body.id);
      if(!history || history.length<2) continue;
      const steps=bodies.length>=32 && body.id!==selected ? 1 : 4;
      const block=Math.ceil((history.length-1)/steps);
      for(let i=0;i<steps;i++) {
        const slice=history.slice(i*block,Math.min(history.length,(i+1)*block+1)).map(q=>q.p);
        const faint=isRingRock(body) && body.id!==selected;
        drawTrack(slice,project,body.color,(.13+.52*(i+1)/steps)*(faint ? .36 : 1),body.id===selected?1.8:1.15);
      }
    }
    if(!predictBody||draft||bodies.length<2)return;
    let body=bodies.find(b=>b.id===selected);
    if(!body || body===frame || body.kind==='star') {
      const visible=bodies.filter(b=>b!==frame && b!==body && length(difference(b.position,center))<span*2);
      body=visible.find(b=>b.kind==='comet') || visible.find(b=>b.kind==='moon') || visible.find(b=>b.kind==='planet') || visible[0];
    }
    if(!body)return;
    const primary=dominantAt(body.position,bodies,body);
    if(!primary || primary.mass<body.mass*.02) return;
    const duration=orbitDuration(body,primary,span);
    if(!selectedForecast || selectedForecast.id!==body.id || (now-lastForecast>1800 && Math.abs(selectedForecast.day-day)>duration*.04)) {
      const samples=bodies.length>=32 ? 20 : bodies.length>12 ? 32 : 68;
      const points=predictBody(body.id,{days:duration*.92,samples,relativeTo:frame?.id});
      selectedForecast={day,id:body.id,points};lastForecast=now;
    }
    drawTrack(selectedForecast.points,project,body.color,.56,1,true);
    scaleLabel.lastElementChild.hidden=selectedForecast.points?.length<2;
  }
  function backdrop(pr) {
    const key=[width,height,dpr,yaw,pitch].join('/');
    if(key!==skySignature) {
      sky.draw(skyContext,width,height,yaw,pitch,0);skySignature=key;
      const veil=skyContext.createLinearGradient(0,0,0,height);
      veil.addColorStop(0,'rgba(8,15,30,.32)');veil.addColorStop(.54,'rgba(3,7,16,.13)');veil.addColorStop(1,'rgba(4,10,20,.52)');
      skyContext.fillStyle=veil;skyContext.fillRect(0,0,width,height);
    }
    ctx.drawImage(skyCanvas,0,0,width,height);
    const step=graduatedStep(Math.min(width*.18,95)/pr.scale);
    const scaleText=formatDistance(step);
    scaleLabel.style.setProperty('--ruler-size',Math.max(14,step*pr.scale)+'px');
    const value=scaleLabel.firstElementChild;if(value.textContent!==scaleText)value.textContent=scaleText;
    // A planar reference grid stays at world coordinates while the stars stay at infinity.
    const grid=graduatedStep(span*.52);
    const gx=Math.floor(center[0]/grid)*grid, gz=Math.floor(center[2]/grid)*grid;
    ctx.save();ctx.strokeStyle='rgba(133,174,200,.085)';ctx.lineWidth=.7;
    for(let i=-8;i<=8;i++) {
      const x=gx+i*grid,z=gz+i*grid;
      for(const [a,b] of [[[x,center[1],gz-grid*8],[x,center[1],gz+grid*8]],
        [[gx-grid*8,center[1],z],[gx+grid*8,center[1],z]]]) {
        const p=pr.project(a),q=pr.project(b);drawLine(ctx,p.x,p.y,q.x,q.y);
      }
    }
    ctx.restore();
  }
  function radius(body,scale) {
    if(physicalRadii)return Math.min(Math.max(width,height)*2,body.radius*scale);
    const symbolic=body.kind==='star' ? 20*Math.max(.62,body.mass**.15)
      : body.kind==='comet' ? 4.2 : body.kind==='moon' ? 6
        : body.kind==='asteroid' ? (isRingRock(body)?2.5:4.2) : 8.7*clamp((body.mass/3e-6)**.13,.74,2.0);
    const small=clamp(Math.min(width,height)/490,.70,1.12);
    const tracked=follow&&body.id===selected&&body.kind==='planet'?symbolic*2.25:symbolic;
    return Math.min(Math.max(width,height),Math.max(body.radius*scale,tracked*small));
  }
  function drawAsteroid(body,r,light,day) {
    let shape=asteroidShapes.get(body.id);
    if(!shape) {
      shape=asteroidShape(body.id);
      asteroidShapes.set(body.id,shape);
    }
    const age=day-(fragmentBirth.get(body.id) ?? -Infinity);
    const heat=clamp(1-age/.75,0,1);
    const angle=Math.atan2(light.y,light.x);
    const spin=shape.rotation+(motion.matches?0:day*shape.rate);
    const cos=Math.cos(spin),sin=Math.sin(spin);
    const sideX=Math.cos(angle)*r,sideY=Math.sin(angle)*r;
    const skin=ctx.createLinearGradient(sideX,sideY,-sideX,-sideY);
    skin.addColorStop(0,heat>.22?'#ffdbac':body.color);
    skin.addColorStop(.43,body.color);
    skin.addColorStop(1,'#1b1a24');
    ctx.beginPath();
    shape.ridges.forEach(([x,y],index)=>{
      const pointX=(cos*x-sin*y)*r;
      const pointY=(sin*x+cos*y)*r;
      if(index===0)ctx.moveTo(pointX,pointY);
      else ctx.lineTo(pointX,pointY);
    });
    ctx.closePath();
    ctx.fillStyle=skin;
    if(heat>0) {
      ctx.shadowColor='#ff873e';
      ctx.shadowBlur=heat*r*2.2;
    }
    ctx.fill();
    ctx.shadowBlur=0;
  }
  function drawBody(p,pr,stars,day,dense) {
    let {body}=p;
    const {x,y,r}=p;
    if(body.color.length===4)body={...body,color:'#'+body.color.slice(1).split('').map(c=>c+c).join('')};
    if(x+r*6<0||y+r*6<0||x-r*6>width||y-r*6>height)return;
    const star=body.kind==='star';
    const source=star?null:dominantAt(body.position,stars,undefined,false);
    const light=source?pr.direction(difference(source.position,body.position)):{x:-.63,y:-.72,depth:.58};
    const lightLength=Math.hypot(light.x,light.y,light.depth)||1;
    const angle=Math.atan2(light.y,light.x), depth=clamp(light.depth/lightLength,-.99,.99);
    if(star) {
      ctx.save();ctx.globalCompositeOperation='lighter';
      const ambient=ctx.createRadialGradient(x,y,r*.4,x,y,r*7.9);
      ambient.addColorStop(0,body.color+'40');ambient.addColorStop(.24,body.color+'19');ambient.addColorStop(1,body.color+'00');
      ctx.fillStyle=ambient;ctx.fillRect(x-r*8,y-r*8,r*16,r*16);
      ctx.drawImage(globes.corona(body),x-r*5.4,y-r*5.4,r*10.8,r*10.8);ctx.restore();
    }
    if(body.kind==='comet') {
      let ax=source?-light.x:pr.direction(body.velocity).x*-1,ay=source?-light.y:pr.direction(body.velocity).y*-1;
      const norm=Math.hypot(ax,ay)||1;ax/=norm;ay/=norm;
      const tail=clamp(5*r,18,60),endX=x+ax*tail,endY=y+ay*tail;
      const plume=ctx.createLinearGradient(x,y,endX,endY);plume.addColorStop(0,body.color+'af');plume.addColorStop(1,body.color+'00');
      ctx.save();ctx.fillStyle=plume;ctx.beginPath();ctx.moveTo(x-ay*r*.58,y+ax*r*.58);
      ctx.quadraticCurveTo(x+ax*tail*.55-ay*r*.6,y+ay*tail*.55+ax*r*.6,endX-ay*r*.9,endY+ax*r*.9);
      ctx.lineTo(endX+ay*r*1.4,endY-ax*r*1.4);ctx.lineTo(x+ay*r*.58,y-ax*r*.58);ctx.fill();ctx.restore();
    }
    if(dense && !star && r<10 && body.id!==selected) {
      ctx.save();ctx.fillStyle='#283443';ctx.beginPath();ctx.arc(x,y,r,0,TAU);ctx.fill();
      ctx.globalAlpha=.76;ctx.fillStyle=body.color;
      ctx.beginPath();ctx.arc(x+Math.cos(angle)*r*.2,y+Math.sin(angle)*r*.2,r*.75,0,TAU);ctx.fill();
      ctx.restore();
    } else if(body.kind==='asteroid') {
      ctx.save();ctx.translate(x,y);drawAsteroid(body,r,light,day);ctx.restore();
    } else {
      const spin=day*TAU/(star?24:body.kind==='moon'?26:1);
      const appearance=body.kind==='planet'&&body.mass>.000035?{...body,material:'gas'}:body;
      const sprite=globes.sprite(appearance,spin,angle,depth);
      ctx.drawImage(sprite,x-r,y-r,2*r,2*r);
    }
    if(body.id===selected) {
      ctx.save();ctx.lineWidth=1.15;ctx.strokeStyle=body.color;ctx.globalAlpha=.88;
      for(let i=0;i<4;i++){
        ctx.beginPath();ctx.arc(x,y,r+4,i*Math.PI/2+.24,i*Math.PI/2+.78);ctx.stroke();
      }
      ctx.restore();
    }
  }
  function drawArrow(from,to,color,context=ctx) {
    const dx=to.x-from.x,dy=to.y-from.y,distance=Math.hypot(dx,dy);
    if(distance<2)return;
    const size=Math.min(6,distance*.33),ux=dx/distance,uy=dy/distance;
    context.strokeStyle=color;drawLine(context,from.x,from.y,to.x,to.y);
    context.beginPath();context.moveTo(to.x-ux*size-uy*size*.55,to.y-uy*size+ux*size*.55);
    context.lineTo(to.x,to.y);context.lineTo(to.x-ux*size+uy*size*.55,to.y-uy*size-ux*size*.55);context.stroke();
  }
  function buildField(bodies,pr) {
    const cols=clamp(Math.ceil(width/29),10,40),rows=clamp(Math.ceil(height/29),7,26);
    const dx=width/cols,dy=height/rows;
    const samples=new Float64Array(cols*rows*3);
    const sources=bodies.map(b=>[...b.position,G*b.mass,b.radius*b.radius]);
    let min=Infinity,max=0;
    for(let row=0;row<rows;row++) for(let col=0;col<cols;col++) {
      const offset=pr.viewOffset((col+.5)*dx,(row+.5)*dy);
      const px=offset[0]+center[0],py=offset[1]+center[1],pz=offset[2]+center[2];
      let gx=0,gy=0,gz=0;
      // Radial gravity is linear inside the radius of a uniform sphere.
      for(const [x,y,z,gm,radius2] of sources) {
        const sx=x-px,sy=y-py,sz=z-pz;
        const distance2=Math.max(radius2,sx*sx+sy*sy+sz*sz);
        const force=gm/(distance2*Math.sqrt(distance2));
        gx+=sx*force;gy+=sy*force;gz+=sz*force;
      }
      const s=(row*cols+col)*3;
      const strength=Math.hypot(gx,gy,gz);
      const direction=pr.direction([gx,gy,gz]);
      samples[s]=strength;samples[s+1]=direction.x;samples[s+2]=direction.y;
      if(strength>0)min=Math.min(min,strength);
      max=Math.max(max,strength);
    }
    if(fieldCanvas.width!==width||fieldCanvas.height!==height){fieldCanvas.width=width;fieldCanvas.height=height;}
    fieldContext.clearRect(0,0,width,height);
    if(!max){fieldRange.textContent='Aucune accélération mesurée';return;}
    const low=Math.max(min,max*1e-5);
    const logRange=Math.log(max/low);
    const value=acceleration=>logRange>0?clamp(1+Math.log(acceleration/max)/logRange,0,1):1;
    const range=formatAcceleration(low*AU_PER_DAY2_TO_MS2)+' à '+formatAcceleration(max*AU_PER_DAY2_TO_MS2)+' m/s²';
    if(fieldRange.textContent!==range)fieldRange.textContent=range;
    if(heatMap.width!==cols||heatMap.height!==rows){heatMap.width=cols;heatMap.height=rows;}
    const image=heatContext.createImageData(cols,rows);
    for(let i=0;i<cols*rows;i++) {
      const heat=value(samples[i*3]),band=heat<.5?0:1,mix=heat*2-band;
      for(let k=0;k<3;k++) image.data[i*4+k]=gravityColors[band][k]*(1-mix)+gravityColors[band+1][k]*mix;
      image.data[i*4+3]=Math.round(17+heat*53);
    }
    heatContext.putImageData(image,0,0);
    fieldContext.drawImage(heatMap,0,0,width,height);
    const stride=width<530?2:3;
    fieldContext.lineWidth=.9;
    for(let row=1;row<rows;row+=stride) for(let col=1;col<cols;col+=stride) {
      const s=(row*cols+col)*3;
      const strength=samples[s],ux=samples[s+1],uy=samples[s+2];
      if(!strength)continue;
      const heat=value(strength),scale=(9+heat*13)/strength;
      const start={x:(col+.5)*dx,y:(row+.5)*dy};
      fieldContext.globalAlpha=.37+heat*.53;
      drawArrow(start,{x:start.x+ux*scale,y:start.y+uy*scale},heat>.72?'#ffdbb3':'#c5faff',fieldContext);
    }
    fieldContext.globalAlpha=1;
  }
  function drawField(bodies,pr,day,now) {
    if(!field)return;
    const signature=[width,height,span,yaw,pitch,follow?0:center.join(',')].join('/');
    if(fieldSignature!==signature||(day!==lastFieldDay&&now-lastFieldStamp>=125)) {
      buildField(bodies,pr);
      fieldSignature=signature;lastFieldDay=day;lastFieldStamp=now;
    }
    ctx.drawImage(fieldCanvas,0,0);
    const target=bodies.find(body=>body.id===selected);
    const reference=target && (bodies.find(body=>body.id===referenceId&&body!==target)||dominantAt(target.position,bodies,target));
    const limit=reference&&rocheLimit(reference,target);
    rocheLabel.hidden=!limit;
    if(!limit)return;
    const label='Limite de Roche estimée · '+formatDistance(limit);
    if(rocheLabel.textContent!==label)rocheLabel.textContent=label;
    const radius=limit*pr.scale;
    if(radius<8||radius>Math.hypot(width,height)*2)return;
    const point=pr.project(reference.position);
    ctx.save();ctx.strokeStyle='#d8b0f4';ctx.lineWidth=1.25;ctx.setLineDash([4,6]);
    ctx.beginPath();ctx.arc(point.x,point.y,radius,0,TAU);ctx.stroke();ctx.restore();
  }
  function drawAxes(pr) {
    const origin={x:width-35,y:height-34};
    ctx.save();ctx.lineWidth=1.25;
    ctx.font='10px ui-monospace, monospace';
    ctx.textBaseline='middle';ctx.textAlign='center';
    ctx.fillStyle='#07121cb8';ctx.beginPath();ctx.arc(origin.x,origin.y,29,0,TAU);ctx.fill();
    ctx.strokeStyle='#67838f53';ctx.stroke();
    for (const axis of axes) {
      const projected=pr.direction(axis.vector),rise=Math.hypot(projected.x,projected.y);
      if(rise<.2)continue;
      const point={x:origin.x+projected.x*21,y:origin.y+projected.y*21};
      drawArrow(origin,point,axis.color);
      ctx.fillStyle=axis.color;
      ctx.fillText(axis.label,point.x+projected.x*7,point.y+projected.y*7);
    }
    ctx.restore();
  }
  function drawMeasurements(bodies,pr) {
    const body=(ruler||vectors) ? bodies.find(item=>item.id===selected) : null;
    measurements.hidden=!body;
    if (!body) return;
    const namedReference=bodies.find(item=>item.id===referenceId&&item!==body);
    const focus=namedReference||dominantAt(body.position,bodies,body,false);
    const from=pr.project(body.position);
    const velocity=focus ? difference(body.velocity,focus.velocity) : body.velocity;
    const range=focus&&length(difference(body.position,focus.position));
    const reading=[];
    ctx.save();ctx.lineWidth=1.4;
    if (ruler && focus) {
      const to=pr.project(focus.position);
      ctx.strokeStyle='#efc08f';ctx.setLineDash([4,5]);drawLine(ctx,from.x,from.y,to.x,to.y);
      ctx.setLineDash([]);
      for(const point of [from,to]) {
        ctx.beginPath();ctx.arc(point.x,point.y,3.4,0,TAU);ctx.stroke();
      }
      reading.push(body.name+' ↔ '+focus.name+' · '+formatDistance(range));
    }
    if (vectors) {
      const value=length(velocity)*AU_PER_DAY_TO_KMS;
      const direction=pr.direction(velocity),size=Math.hypot(direction.x,direction.y);
      if (size>0) {
        const extent=clamp(size*pr.scale*orbitDuration(body,focus,span)*.065,12,Math.max(13,Math.min(width,height)*.26));
        drawArrow(from,{x:from.x+direction.x*extent/size,y:from.y+direction.y*extent/size},'#9be6e8');
      }
      reading.push('Vitesse '+(focus?'relative':'absolue')+' · '+number.format(value)+' km/s');
    }
    if (!reading.length) reading.push('Ajoute un second corps pour mesurer un écart.');
    const text=reading.join('  |  ');
    if(measurements.textContent!==text)measurements.textContent=text;
    ctx.restore();
  }
  function captureEvents(events,now) {
    if(restoredDay!==null) {
      for(const e of events) if(e.day<=restoredDay)seenEvents.add(e.id);
      restoredDay=null;
    }
    if(!events||!events.length)return;
    for(const e of events) {
      if(e.type==='collision')for(const id of e.fragmentIds || []) fragmentBirth.set(id,e.day);
      if(seenEvents.has(e.id) || e.day<seenThrough)continue;
      seenEvents.add(e.id);
      if(e.type==='collision'||e.type==='tidal')effects.push({e,born:now,duration:e.type==='tidal'?1750:1250});
    }
    seenThrough=Math.max(seenThrough,events[events.length-1].day);
    if(effects.length>6)effects=effects.slice(-6);
    if(seenEvents.size>512){seenEvents.clear();for(const e of events)seenEvents.add(e.id);}
  }
  function drawTidalEvent(e,pr,t) {
    const position=pr.project(e.position),direction=pr.direction(e.normal);
    if(position.x<-25||position.x>width+25||position.y<-25||position.y>height+25)return;
    const parent=e.position.map((v,i)=>v-e.normal[i]*e.distance);
    const host=pr.project(parent);
    const reduced=motion.matches;
    const spread=reduced?24:17+Math.min(77,Math.min(width,height)*.17)*(1-(1-t)**2);
    const tilt=Math.atan2(direction.y,direction.x);
    // The original positions remain marked while the resolved fragments move freely.
    ctx.save();ctx.globalAlpha=(1-t)**.85;
    ctx.strokeStyle='#c8b6f4';ctx.lineWidth=1;ctx.setLineDash([4,5]);
    drawLine(ctx,host.x,host.y,position.x,position.y);
    ctx.setLineDash([]);
    ctx.translate(position.x,position.y);ctx.rotate(tilt);
    for(const side of [-1,1]) {
      ctx.strokeStyle=side<0?'#99d7e8':'#ddb5fb';
      ctx.beginPath();ctx.moveTo(side*4,0);
      ctx.bezierCurveTo(side*spread*.37,-spread*.18,side*spread*.72,spread*.17,side*spread,0);ctx.stroke();
    }
    for(let i=0;i<e.fragmentIds.length;i++) {
      const side=i%2?1:-1;
      const along=side*spread*(.30+.7*(i+1)/e.fragmentIds.length);
      const across=Math.sin(i*2.4)*spread*.11;
      ctx.fillStyle=side<0?'#c1edfa':'#ead4ff';
      ctx.beginPath();ctx.arc(along,across,reduced?1.6:2.7-t*1.2,0,TAU);ctx.fill();
    }
    ctx.restore();
    ctx.save();ctx.globalAlpha=(1-t)**.75;ctx.textAlign='center';ctx.font='11px ui-monospace, monospace';
    ctx.strokeStyle='#101524';ctx.lineWidth=3;ctx.fillStyle='#ead8ff';
    const x=clamp(position.x,66,width-66),y=clamp(position.y-24,65,height-60);
    ctx.strokeText('Dislocation de marée',x,y);ctx.fillText('Dislocation de marée',x,y);ctx.restore();
  }
  function drawEffects(pr,now) {
    effects=effects.filter(({born,duration})=>now-born<duration);
    for (const {e,born,duration} of effects) {
      const t=clamp((now-born)/duration,0,1);
      if(e.type==='tidal'){drawTidalEvent(e,pr,t);continue;}
      const pos=pr.project(e.position);
      const power=clamp((Math.log10(Math.max(1,e.energy))-15)/22,.3,1);
      const fragmented=!!e.fragmentIds?.length;
      const extent=clamp(Math.min(width,height)*(.12+.13*power),22,130)*(fragmented?1.35:1);
      const r=motion.matches?20:(4+extent*(1-(1-t)**2));
      ctx.save();ctx.translate(pos.x,pos.y);ctx.globalAlpha=(1-t)**1.4;
      if(e.outcome==='bounce') {
        const normal=pr.direction(e.normal||[1,0,0]);
        const angle=Math.atan2(normal.y,normal.x);
        ctx.rotate(angle);ctx.strokeStyle='#91e8ef';ctx.lineWidth=1.5;
        for(const offset of [0,Math.PI]) {
          ctx.beginPath();ctx.arc(0,0,r*.55,offset-.82,offset+.82);ctx.stroke();
        }
        if(Math.hypot(normal.x,normal.y)>.1) {
          for(const side of [-1,1])drawArrow({x:side*r*.2,y:0},{x:side*r*.95,y:0},'#a7edf6');
        }
        ctx.restore();continue;
      }
      ctx.strokeStyle='#ffc490';ctx.lineWidth=motion.matches?1:1.6;ctx.beginPath();ctx.arc(0,0,r,0,TAU);ctx.stroke();
      if(!motion.matches){
        const halo=ctx.createRadialGradient(0,0,.1,0,0,r);halo.addColorStop(0,'#fff4c4b0');halo.addColorStop(.20,'#ffa56a74');halo.addColorStop(.7,'#d85e3519');halo.addColorStop(1,'#d85e3500');
        ctx.fillStyle=halo;ctx.fillRect(-r,-r,2*r,2*r);
        if(fragmented) {
          ctx.strokeStyle='#ffedd2';ctx.lineWidth=1.1;ctx.beginPath();
          ctx.arc(0,0,r*.74,0,TAU);ctx.stroke();
          const axis=e.normal?pr.direction(e.normal):{x:1,y:0};
          const heading=Math.atan2(axis.y,axis.x)+Math.PI/2;
          for(let i=0;i<23;i++) {
            const angle=heading+(i%2?Math.PI:0)+Math.sin(i*2.73)*1.15;
            const distance=r*(.45+.72*Math.sin(i*1.63+.2)**2);
            const streak=4+power*5*(1-t),x=Math.cos(angle),y=Math.sin(angle);
            ctx.strokeStyle=i%3?'#ffb375':'#fff0ce';
            drawLine(ctx,x*distance,y*distance,x*(distance+streak),y*(distance+streak));
          }
        } else {
          for(let i=0;i<17;i++) {
            const a=i*2.399963,d=r*(.45+.48*(Math.sin(i*2.73+1)**2));
            ctx.strokeStyle=i%2?'#ffe3b0':'#df8a57';drawLine(ctx,Math.cos(a)*d,Math.sin(a)*d,Math.cos(a)*(d+3),Math.sin(a)*(d+3));
          }
        }
      }
      ctx.restore();
    }
    if(effects.length)scheduleRender();
  }
  function specAt(position,end,pr) {
    const bodies=getBodies(), primary=dominantAt(position,bodies);
    const axial=difference(end,position),mag=length(axial);
    const anchor=pr.project(position),tip=pr.project(end);
    const distance=primary?Math.max(1e-10,primary.radius,length(difference(primary.position,position))):span;
    const reference=primary?Math.sqrt(G*primary.mass/distance):span*.014;
    const fraction=Math.hypot(tip.x-anchor.x,tip.y-anchor.y)/Math.max(38,Math.min(width,height)*.23);
    const speed=reference*fraction;
    const velocity=axial.map((v,i)=>(primary?.velocity[i]||0)+(mag>0?v/mag*speed:0));
    return {spec:buildProjectile(position.slice(),velocity),speed,primary};
  }
  function syncDraftFrame() {
    if(!draft?.frameId)return;
    const frame=getBodies().find(b=>b.id===draft.frameId);
    if(!frame){draft=null;updateTip();return;}
    const shift=difference(frame.position,draft.reference);
    for(let i=0;i<3;i++){draft.origin[i]+=shift[i];draft.end[i]+=shift[i];}
    draft.reference=frame.position.slice();
  }
  function drawDraft(pr,now) {
    syncDraftFrame();
    if(!draft)return;
    const {spec,speed,primary}=specAt(draft.origin,draft.end,pr);
    if(!spec)return;
    const frame=follow?getBodies().find(b=>b.id===selected):null;
    if(predict && (!draft.path || (draft.changed && now-draft.last>=120))) {
      draft.path=predict(spec,{days:orbitDuration(spec,primary,span)*.7,samples:52,relativeTo:frame?.id})||[];
      draft.last=now;draft.changed=false;
    }
    const project=frame?point=>pr.project(point.map((v,i)=>v+frame.position[i])):pr.project;
    drawTrack(draft.path,project,'#9de4e7',.9,1.5,true);
    const a=pr.project(draft.origin),b=pr.project(draft.end);
    ctx.save();ctx.fillStyle=spec.color||'#f8d29f';ctx.beginPath();ctx.arc(a.x,a.y,5,0,TAU);ctx.fill();
    ctx.strokeStyle='#d7f3f5';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(a.x,a.y,9,0,TAU);ctx.stroke();
    const dx=b.x-a.x,dy=b.y-a.y,mag=Math.hypot(dx,dy);
    if(mag>6){
      drawLine(ctx,a.x,a.y,b.x,b.y);
      const ux=dx/mag,uy=dy/mag;drawLine(ctx,b.x,b.y,b.x-ux*8-uy*4,b.y-uy*8+ux*4);drawLine(ctx,b.x,b.y,b.x-ux*8+uy*4,b.y-uy*8-ux*4);
    }
    ctx.restore();
    tip.textContent=mag>5 ? 'Vitesse de lancement · '+number.format(speed*AU_PER_DAY_TO_KMS)+' km/s' : 'Choisis la direction et la vitesse';
  }
  function render(events) {
    if(disposed||!measure()) return;
    const now=performance.now(), day=getTime(),bodies=getBodies();
    if(day<lastTime)clearHistory();
    if(events)captureEvents(events,now);
    const signature=bodies.map(b=>b.id+'='+b.mass).join('/');
    if(signature!==lastSignature){selectedForecast=null;fieldSignature='';lastSignature=signature;dirty=true;}
    const advanced=day!==lastTime||bodies.length!==lastCount;
    if(!dirty&&!advanced&&!effects.length&&!draft?.changed&&!flight)return;
    const dense=bodies.length>=32;
    if(!dirty&&now-lastStamp<1000/(dense?30:45)){if(flight||effects.length)scheduleRender();return;}
    const frame=follow?bodies.find(b=>b.id===selected):null;
    if(frame)center=frame.position.slice();
    lastStamp=now;lastCount=bodies.length;lastTime=day;dirty=false;
    if(flight) {
      const t=clamp((now-flight.started)/390,0,1),ease=t*t*(3-2*t);
      const target=bodies.find(body=>body.id===flight.id)?.position||flight.target;
      center=flight.origin.map((p,i)=>p+(target[i]-p)*ease);
      span=flight.span*(flight.endSpan/flight.span)**ease;
      if(t<1)scheduleRender();else flight=null;
    }
    const pr=projection();
    backdrop(pr);drawField(bodies,pr,day,now);record(bodies,day,frame);renderTracks(bodies,pr,day,now,frame);
    projected=bodies.map(body=>({...pr.project(body.position),body,r:radius(body,pr.scale)})).sort((a,b)=>a.depth-b.depth);
    const stars=bodies.filter(b=>b.kind==='star');
    for(const point of projected) drawBody(point,pr,stars,day,dense);
    updatePins(projected);drawMeasurements(bodies,pr);drawDraft(pr,now);drawEffects(pr,now);drawAxes(pr);
  }
  function clearHistory() {
    tracks.clear();effects=[];seenEvents.clear();fragmentBirth.clear();seenThrough=restoredDay=getTime();
    fieldSignature='';
    selectedForecast=null;lastForecast=0;lastTime=NaN;draft=null;move=null;pinch=null;flight=null;lastTap=null;pointers.clear();updateTip();invalidate();
  }
  function resetCamera({span:radius=2,target=[0,0,0]}={}) {
    flight=null;
    span=clamp(Number.isFinite(radius)?radius:2,MIN_SPAN,MAX_SPAN);
    center=Array.isArray(target)&&target.length===3?target.slice():[0,0,0];
    const preset=cameraPresets.perspective;
    yaw=preset.yaw;pitch=preset.pitch;angleControl.value='perspective';
    const stars=getBodies().filter(b=>b.kind==='star');
    if(stars.length===2) {
      const axis=difference(stars[1].position,stars[0].position);
      yaw=Math.atan2(axis[2],axis[0])-.36;
    }
    selectedForecast=null;invalidate();
  }
  function setCameraAngle(id) {
    const preset=cameraPresets[id];
    if(!preset)return;
    flight=null;
    yaw=preset.yaw;pitch=preset.pitch;
    angleControl.value=id;
    if(placement&&id==='side'){pitch=.26;angleControl.value='free';}
    invalidate();
  }
  function frameAll() {
    const bodies=getBodies();
    if(!bodies.length)return;
    flight=null;
    const min=bodies[0].position.slice(),max=min.slice();
    for(const body of bodies) {
      body.position.forEach((position,axis)=>{
        min[axis]=Math.min(min[axis],position-body.radius);
        max[axis]=Math.max(max[axis],position+body.radius);
      });
    }
    center=min.map((value,i)=>(value+max[i])/2);
    const extent=Math.max(...bodies.map(body=>length(difference(body.position,center))+body.radius));
    const adaptiveFit=Math.max(1,projection().scale*span/(height*.39));
    span=clamp(extent*1.2*adaptiveFit,MIN_SPAN,MAX_SPAN);
    if(follow){follow=false;onFollowChange?.(false);}
    invalidate();
  }
  function zoom(factor,anchor=null) {
    if(!(factor>0))return;
    flight=null;
    const from=anchor?projection().viewOffset(anchor.x,anchor.y):null;
    span=clamp(span/factor,MIN_SPAN,MAX_SPAN);
    if(from&&!follow) {
      const to=projection().viewOffset(anchor.x,anchor.y);
      center=center.map((v,i)=>v+from[i]-to[i]);
    }
    invalidate();
  }
  function updateTip(){tip.hidden=!placement;tip.textContent='Glisse pour lancer · ou touche deux points';}
  function setPlacement(enabled) {
    placement=!!enabled;draft=null;container.classList.toggle('sb-placing',placement);
    flight=null;lastTap=null;
    if(placement&&Math.abs(Math.sin(pitch))<.23){pitch=pitch<0?-.26:.26;angleControl.value='free';}
    updateTip();invalidate();
  }
  function launchDefault() {
    const bodies=getBodies();
    const around=bodies.find(b=>b.id===selected)||bodies.reduce((best,b)=>!best||b.mass>best.mass?b:best,null);
    const at=around?.position||center, radius=Math.max((around?.radius||0)*5,span*.33);
    const position=[at[0]+radius*.8,at[1],at[2]+radius*.6];
    const provisional=buildProjectile(position,[0,0,0]);if(!provisional)return;
    const speed=around?Math.sqrt(G*(around.mass+provisional.mass)/radius):span*.014;
    const velocity=[(around?.velocity[0]||0)-speed*.6,around?.velocity[1]||0,(around?.velocity[2]||0)+speed*.8];
    const spec=buildProjectile(position,velocity);if(!spec)return;
    onLaunch?.(spec);selectedForecast=null;invalidate();
  }
  const local=e=>{const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};};
  const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  const separation=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  function travel(point,id=point&&at(point.x,point.y)?.body.id) {
    if(placement)return;
    const body=getBodies().find(item=>item.id===id);
    if(!body&&!point)return;
    if(follow){follow=false;onFollowChange?.(false);}
    if(body)choose(body.id);
    const target=body?.position.slice()||projection().viewOffset(point.x,point.y).map((v,i)=>v+center[i]);
    const endSpan=clamp(body?Math.min(span,Math.max(span*.43,body.radius*3.5)):span*.60,MIN_SPAN,MAX_SPAN);
    if(motion.matches){flight=null;center=target;span=endSpan;}
    else flight={id,origin:center.slice(),target,span,endSpan,started:performance.now()};
    invalidate();
  }
  function pan(from,to) {
    flight=null;
    const pr=projection(),a=pr.viewOffset(from.x,from.y),b=pr.viewOffset(to.x,to.y);
    if(follow){follow=false;onFollowChange?.(false);}
    center=center.map((v,i)=>v+a[i]-b[i]);invalidate();
  }
  function pointInPlane(p,level) {return projection().onPlane(p.x,p.y,level);}
  function launchDraft() {
    if(!draft)return;
    const {spec}=specAt(draft.origin,draft.end,projection());
    draft=null;updateTip();
    if(spec)onLaunch?.(spec);
    selectedForecast=null;invalidate();
  }
  canvas.onpointerdown=e=>{
    if(e.button!==0&&e.button!==1&&e.button!==2)return;
    const p=local(e);canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,p);
    if(pointers.size===2) {
      const [a,b]=[...pointers.values()];pinch={mid:midpoint(a,b),distance:Math.max(2,separation(a,b))};
      move=null;draft=null;lastTap=null;suppressTap=true;updateTip();invalidate();return;
    }
    if(pointers.size>2)return;
    suppressTap=false;move={start:p,last:p,dragged:false,pan:e.shiftKey||e.button!==0};
    if(!placement||move.pan)return;
    if(draft){move.second=true;draft.end=pointInPlane(p,draft.origin[1]);draft.changed=true;}
    else{
      const selectedBody=getBodies().find(b=>b.id===selected);
      const origin=pointInPlane(p,selectedBody?.position[1]??center[1]);
      const frame=follow?selectedBody:null;
      draft={origin,end:origin.slice(),frameId:frame?.id,reference:frame?.position.slice(),path:null,last:0,changed:true};
    }
    invalidate();
  };
  canvas.onpointermove=e=>{
    const p=local(e);
    if(!pointers.has(e.pointerId)){
      if(draft&&placement&&e.pointerType==='mouse'){draft.end=pointInPlane(p,draft.origin[1]);draft.changed=true;invalidate();}
      return;
    }
    pointers.set(e.pointerId,p);
    if(pinch&&pointers.size>=2) {
      const [a,b]=[...pointers.values()],mid=midpoint(a,b),distance=Math.max(2,separation(a,b));
      pan(pinch.mid,mid);zoom(distance/pinch.distance,mid);pinch={mid,distance};return;
    }
    if(!move||suppressTap)return;
    if(separation(move.start,p)>4)move.dragged=true;
    if(!move.dragged)return;
    if(move.pan)pan(move.last,p);
    else if(placement&&draft){draft.end=pointInPlane(p,draft.origin[1]);draft.changed=true;invalidate();}
    else {flight=null;yaw-=(p.x-move.last.x)*.008;pitch=clamp(pitch+(p.y-move.last.y)*.006,-Math.PI/2,Math.PI/2);angleControl.value='free';invalidate();}
    move.last=p;
  };
  canvas.onpointerup=e=>{
    const p=local(e);
    if(!suppressTap&&move&&!move.pan) {
      if(placement&&draft&&(move.dragged||move.second)) {
        draft.end=pointInPlane(p,draft.origin[1]);launchDraft();
      } else if(!placement&&!move.dragged) {
        const hit=at(p.x,p.y);if(hit)choose(hit.body.id);
        if(e.pointerType==='touch') {
          const now=performance.now();
          if(lastTap&&now-lastTap.time<350&&separation(lastTap,p)<26){lastTap=null;travel(p);}
          else lastTap={...p,time:now};
        }
      }
    }
    pointers.delete(e.pointerId);move=null;if(pointers.size<2)pinch=null;
    if(!pointers.size)suppressTap=false;
  };
  function cancelPointer(e) {
    if(!pointers.has(e.pointerId))return;
    pointers.delete(e.pointerId);move=null;pinch=null;draft=null;suppressTap=pointers.size>0;updateTip();invalidate();
  }
  canvas.onpointercancel=cancelPointer;canvas.onlostpointercapture=cancelPointer;
  canvas.ondblclick=e=>{if(e.pointerType!=='touch'&&!e.sourceCapabilities?.firesTouchEvents)travel(local(e));};
  canvas.oncontextmenu=e=>e.preventDefault();
  canvas.onwheel=e=>{
    if(e.ctrlKey)return;
    e.preventDefault();
    const delta=e.deltaMode===1?e.deltaY*16:e.deltaY;
    zoom(Math.exp(-clamp(delta,-200,200)*.0024),local(e));
  };
  canvas.onkeydown=e=>{
    if(e.ctrlKey||e.altKey||e.metaKey)return;
    switch(e.key) {
      case '+':case '=':zoom(1.25);break;
      case '-':zoom(.8);break;
      case 'ArrowLeft':yaw-=.10;break;case 'ArrowRight':yaw+=.10;break;
      case 'ArrowUp':pitch=clamp(pitch+.10,-Math.PI/2,Math.PI/2);break;case 'ArrowDown':pitch=clamp(pitch-.10,-Math.PI/2,Math.PI/2);break;
      case 'Enter':if(!placement)return;launchDefault();break;
      case 'Escape':if(!placement)return;if(draft){draft=null;updateTip();}else {setPlacement(false);onCancelPlacement?.();}break;
      default:return;
    }
    if(e.key.startsWith('Arrow')){flight=null;angleControl.value='free';}
    e.preventDefault();e.stopPropagation();invalidate();
  };
  const bindToggle=(button,change)=>{
    button.onclick=()=>{
      const value=button.getAttribute('aria-pressed')!=='true';
      button.setAttribute('aria-pressed',String(value));change(value);invalidate();
    };
  };
  angleControl.onchange=()=>setCameraAngle(angleControl.value);
  controls.querySelector('[data-sb-view-fit]').onclick=frameAll;
  bindToggle(controls.querySelector('[data-sb-view-ruler]'),value=>{ruler=value;});
  bindToggle(controls.querySelector('[data-sb-view-vectors]'),value=>{vectors=value;});
  const fieldButton=controls.querySelector('[data-sb-view-field]');
  function setField(value) {
    field=!!value;fieldSignature='';fieldLegend.hidden=!field;
    fieldButton.setAttribute('aria-pressed',String(field));invalidate();
  }
  fieldButton.onclick=()=>setField(!field);
  const scaleButton=scaleLabel.querySelector('button');
  bindToggle(scaleButton,value=>{
    physicalRadii=value;scaleButton.textContent=value?'Rayons réels':'Rayons agrandis';
  });
  function capture() {
    dirty=true;render();
    const image=document.createElement('canvas');
    image.width=canvas.width;image.height=canvas.height;
    image.getContext('2d').drawImage(canvas,0,0);
    return image;
  }
  const observer=new ResizeObserver(invalidate);observer.observe(container);
  function dispose() {
    disposed=true;cancelAnimationFrame(raf);observer.disconnect();pointers.clear();pins.clear();tracks.clear();container.replaceChildren();
  }
  return {render,resetCamera,clearHistory,setSelected,setPlacement,zoom,launchDefault,dispose,capture,setField,
    setReference(id){if(referenceId!==id){referenceId=id;invalidate();}},
    invalidateForecast(){selectedForecast=null;invalidate();},
    setFollow(value){flight=null;follow=!!value;fieldSignature='';invalidate();},setLabels(value){names=!!value;invalidate();},
    setTrails(value){trails=!!value;invalidate();}};
}
