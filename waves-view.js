import { schwarzschildRadiusKm } from './relativity-model.js';

const TAU=2*Math.PI;
const COLORS={ink:'#a7bdd6',text:'#ddebfb',amber:'#f6bc81',cyan:'#8cdde5',edge:'#365471'};
const digits=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:3});
const limit=(value,min,max)=>Math.max(min,Math.min(max,value));
const pointTime=sample=>sample.elapsed??sample.time;
const strain=sample=>sample.plus??sample.strain;
const superscript=value=>String(value).replace(/[-0-9]/g,char=>'⁻⁰¹²³⁴⁵⁶⁷⁸⁹'[char==='-'?0:Number(char)+1]);
function starField() {
  let seed=45761;
  function next() {seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;}
  return Array.from({length:70},()=>({x:next(),y:next(),light:next(),tint:next()}));
}
const stars=starField();

function background(ctx,width,height,centerX,centerY) {
  const size=Math.max(width,height);
  const gradient=ctx.createRadialGradient(centerX,centerY,0,centerX,centerY,size*.72);
  gradient.addColorStop(0,'#172c4a');gradient.addColorStop(.57,'#0c182c');gradient.addColorStop(1,'#080d19');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);
}

function rings(ctx,x,y,radius) {
  ctx.strokeStyle='#658bad59';ctx.lineWidth=1;
  ctx.setLineDash([3,4]);
  ctx.beginPath();ctx.arc(x,y,radius,0,TAU);ctx.stroke();
  ctx.setLineDash([]);
}

function blackHole(ctx,x,y,radius,color) {
  const glow=ctx.createRadialGradient(x,y,radius*.56,x,y,radius*3.9);
  glow.addColorStop(0,color+'ac');glow.addColorStop(.35,color+'38');glow.addColorStop(1,color+'00');
  ctx.fillStyle=glow;ctx.beginPath();ctx.arc(x,y,radius*3.9,0,TAU);ctx.fill();
  ctx.beginPath();ctx.arc(x,y,radius,0,TAU);ctx.fillStyle='#050813';ctx.fill();
  ctx.strokeStyle=color;ctx.lineWidth=1.2;ctx.stroke();
}

function drawOrbit(ctx,width,height,frame,signal,config) {
  const centerX=width*.5,centerY=height*.45;
  background(ctx,width,height,centerX,centerY);
  for(let i=0,count=Math.min(stars.length,Math.ceil(width*height/1250));i<count;i++) {
    const star=stars[i],size=star.light>.93?1.6:1;
    ctx.globalAlpha=.08+star.light*.65;ctx.fillStyle=star.tint>.77?'#f8bc91':'#aacfff';
    ctx.fillRect(star.x*width,star.y*height,size,size);
  }
  ctx.globalAlpha=1;
  ctx.beginPath();ctx.moveTo(centerX,0);ctx.lineTo(centerX,height);
  ctx.moveTo(0,centerY);ctx.lineTo(width,centerY);ctx.strokeStyle='#6c98c122';ctx.lineWidth=1;ctx.stroke();
  if(!frame || !signal.length || !(config.mass1>0) || !(config.mass2>0)) return;
  const total=config.mass1+config.mass2;
  const far=Math.max(config.mass1,config.mass2)/total;
  const initial=signal[0].separationKm;
  const scale=Math.min(width*.36,(height-13)*.38)/Math.max(initial*far,1);
  if(!(scale>0))return;
  const relative=frame.separationKm*scale,theta=frame.orbitalPhase;
  const factor=[config.mass2/total,-config.mass1/total];
  const x=Math.cos(theta)*relative,y=Math.sin(theta)*relative;
  const positions=factor.map(offset=>[centerX+offset*x,centerY+offset*y]);
  for (const f of factor) rings(ctx,centerX,centerY,Math.abs(f*relative));
  ctx.beginPath();ctx.moveTo(...positions[0]);ctx.lineTo(...positions[1]);ctx.strokeStyle='#90b6d677';ctx.stroke();
  ctx.strokeStyle='#bbd7ef';ctx.beginPath();ctx.moveTo(centerX-3,centerY);ctx.lineTo(centerX+3,centerY);
  ctx.moveTo(centerX,centerY-3);ctx.lineTo(centerX,centerY+3);ctx.stroke();
  blackHole(ctx,...positions[0],Math.max(1.5,schwarzschildRadiusKm(config.mass1)*scale),COLORS.amber);
  blackHole(ctx,...positions[1],Math.max(1.5,schwarzschildRadiusKm(config.mass2)*scale),COLORS.cyan);

  if(height<55) return;
  const bar=10**Math.floor(Math.log10(Math.max(1,width*.18/scale)));
  if (bar*scale<4 || width<118) return;
  const bottom=height-11;
  ctx.lineWidth=1;ctx.strokeStyle='#a3cbe4';ctx.beginPath();ctx.moveTo(9,bottom-7);ctx.lineTo(9,bottom);
  ctx.lineTo(9+bar*scale,bottom);ctx.lineTo(9+bar*scale,bottom-7);ctx.stroke();
  ctx.font='11px system-ui';ctx.fillStyle=COLORS.text;
  ctx.fillText(digits.format(bar)+' km',15+bar*scale,bottom+1);
}

function geometry(width,height) {
  const compact=height<108;
  return {left:width<185?24:35,right:width-10,top:compact?7:12,bottom:height-(compact?14:19),compact};
}

function signalRange(signal,config) {
  if(!signal.length) return 1;
  const inclination=(config.inclination??0)*Math.PI/180;
  const projection=(1+Math.cos(inclination)**2)/2;
  return Math.max(1e-45,...signal.map(sample=>Math.max(Math.abs(strain(sample)),(sample.amplitude??0)*projection)))*1.04;
}

function drawSignalBase(ctx,width,height,signal,config,maximum) {
  background(ctx,width,height,width*.62,height*.43);
  if(!signal.length || width<74 || height<40) return;
  const {left,right,top,bottom,compact}=geometry(width,height);
  const duration=pointTime(signal.at(-1));
  const span=right-left,halfHeight=(bottom-top)*.5,middle=top+halfHeight;
  const y=value=>middle-value/maximum*halfHeight;
  const projection=(1+Math.cos((config.inclination??0)*Math.PI/180)**2)/2;
  const period=duration/span;
  const [timeScale,timeUnit]=duration>=86400?[86400,'j']:duration>=3600?[3600,'h']:duration>=60?[60,'min']:[1,'s'];
  ctx.lineWidth=1;
  ctx.font=(compact?'9':'11')+'px system-ui';ctx.fillStyle=COLORS.ink;
  for(const fraction of [0,.25,.5,.75,1]) {
    const column=left+fraction*span;
    ctx.beginPath();ctx.moveTo(column,top);ctx.lineTo(column,bottom);ctx.strokeStyle='#779bc832';ctx.stroke();
    if(!compact || fraction===0 || fraction===1) {
      ctx.textAlign=fraction===1?'right':fraction===0?'left':'center';
      ctx.fillText(digits.format(fraction*duration/timeScale)+(fraction===1?' '+timeUnit:''),column,bottom+(compact?11:15));
    }
  }
  for(const fraction of [-1,-.5,0,.5,1]) {
    const line=middle+fraction*halfHeight;
    ctx.strokeStyle=fraction===0?'#a6daf178':'#779bc82a';
    ctx.beginPath();ctx.moveTo(left,line);ctx.lineTo(right,line);ctx.stroke();
  }
  ctx.textAlign='right';ctx.fillText('0',left-5,middle+3);
  const powers=Math.floor(Math.log10(maximum));
  const scale=10**powers;
  if(!compact && width>=225) {
    const level=digits.format(maximum/scale);
    ctx.fillText(level,left-5,top+4);ctx.fillText('−'+level,left-5,bottom);
  }

  // Use the analytic envelope where multiple oscillations share a pixel.
  // Else each x coordinate samples the actual projected plus polarization.
  const get=typeof config.sample==='function' ? index=>config.sample(index*period)
    : index=>signal[Math.round(index/span*(signal.length-1))];
  let previous=null;
  for(let i=0;i<=Math.floor(span);i++) {
    const sample=get(i),at=left+i;
    const envelope=sample.frequency*period>.25;
    if(envelope) {
      const amplitude=(sample.amplitude??Math.abs(strain(sample)))*projection;
      ctx.strokeStyle='#7fd7eb88';ctx.beginPath();ctx.moveTo(at,y(amplitude));ctx.lineTo(at,y(-amplitude));ctx.stroke();
      previous=null;
    } else {
      const point={x:at,y:y(strain(sample))};
      if(previous) {
        ctx.strokeStyle=COLORS.cyan;ctx.lineWidth=1.25;ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(point.x,point.y);ctx.stroke();
      }
      previous=point;
    }
  }
  if(!compact) {
    ctx.textAlign='left';ctx.fillStyle=COLORS.ink;
    ctx.fillText('h × 10'+superscript(powers),left+4,top+12);
    if(signal.at(-1).frequency*period>.25 && width>=225) {
      ctx.textAlign='right';ctx.fillText('Enveloppe locale',right-4,top+12);
    }
  }
}

function drawCursor(ctx,width,height,seconds,frame,maximum) {
  if(!frame || width<74 || height<40 || !(seconds>0))return;
  const {left,right,top,bottom}=geometry(width,height);
  const x=left+limit(pointTime(frame)/seconds,0,1)*(right-left);
  const value=limit(strain(frame)/maximum,-1,1);
  const y=top+(1-value)*.5*(bottom-top);
  ctx.lineWidth=1;ctx.setLineDash([4,3]);ctx.strokeStyle=COLORS.amber;
  ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.setLineDash([]);
  ctx.beginPath();ctx.arc(x,y,3,0,TAU);ctx.fillStyle='#ffd7ad';ctx.fill();
}

function canvasSize(canvas) {
  const width=canvas.clientWidth,height=canvas.clientHeight;
  const ratio=Math.min(devicePixelRatio||1,2);
  return {width,height,ratio};
}

function canvasContext(canvas,{width,height,ratio}) {
  const pixelsX=Math.round(width*ratio),pixelsY=Math.round(height*ratio);
  if(canvas.width!==pixelsX || canvas.height!==pixelsY) {canvas.width=pixelsX;canvas.height=pixelsY;}
  const ctx=canvas.getContext('2d');
  ctx?.setTransform(ratio,0,0,ratio,0,0);
  return ctx;
}

export function createWavesView(host,{onSeek=()=>{}}={}) {
  host.classList.add('waves-view');
  host.innerHTML=`<div class="waves-view-grid" data-wave-visual>
    <section class="wv-section" aria-labelledby="wv-orbit-title"><header class="wv-heading"><h2 id="wv-orbit-title">Orbite</h2><p data-wave-masses></p></header>
    <canvas data-wave-orbit role="img" aria-label="Deux objets en orbite autour de leur centre de masse"></canvas></section>
    <section class="wv-section" aria-labelledby="wv-signal-title"><header class="wv-heading"><h2 id="wv-signal-title">Signal</h2><p data-wave-frequency></p></header>
    <canvas data-wave-signal tabindex="0" role="slider" aria-label="Position dans le signal gravitationnel" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></canvas></section>
  </div>`;
  const orbit=host.querySelector('[data-wave-orbit]');
  const chart=host.querySelector('[data-wave-signal]');
  const masses=host.querySelector('[data-wave-masses]');
  const frequency=host.querySelector('[data-wave-frequency]');
  const cache=document.createElement('canvas');
  let signal=[],config={},frame=null,maximum=1,seconds=0,graphNeedsDraw=true,paintId=0,pointer=null;

  function paint() {
    paintId=0;
    const orbitSize=canvasSize(orbit),chartSize=canvasSize(chart);
    if(orbitSize.width>0 && orbitSize.height>0) {
      const ctx=canvasContext(orbit,orbitSize);
      if(ctx) drawOrbit(ctx,orbitSize.width,orbitSize.height,frame,signal,config);
    }
    const {width,height}=chartSize;
    if(width<1 || height<1) return;
    const ctx=canvasContext(chart,chartSize);
    if(!ctx)return;
    if(graphNeedsDraw || cache.width!==chart.width || cache.height!==chart.height) {
      const baseCtx=canvasContext(cache,chartSize);
      drawSignalBase(baseCtx,width,height,signal,config,maximum);
      graphNeedsDraw=false;
    }
    ctx.drawImage(cache,0,0,width,height);
    drawCursor(ctx,width,height,seconds,frame,maximum);
  }
  function schedule() {if(!paintId) paintId=requestAnimationFrame(paint);}
  const observer=new ResizeObserver(schedule);observer.observe(orbit);observer.observe(chart);

  function update(current) {
    frame=current;
    const measured=frame&&Number.isFinite(frame.frequency);
    const text=measured?digits.format(frame.frequency)+' Hz':'—';
    if(frequency.textContent!==text) frequency.textContent=text;
    const fraction=measured&&seconds>0?limit(pointTime(frame)/seconds,0,1):0;
    chart.setAttribute('aria-valuenow',String(Math.round(fraction*100)));
    chart.setAttribute('aria-valuetext',measured?digits.format(pointTime(frame))+' s, '+text:'Aucun signal');
    chart.dataset.position=String(fraction);
    schedule();
  }
  function setSignal(samples,model) {
    signal=Array.isArray(samples)?samples:[];config=model??{};
    seconds=signal.length>1?pointTime(signal.at(-1)):0;
    maximum=signalRange(signal,config);graphNeedsDraw=true;
    masses.textContent=signal.length?digits.format(config.mass1)+' + '+digits.format(config.mass2)+' M☉':'';
    update(signal[0]??null);
  }

  function seek(event) {
    const rect=chart.getBoundingClientRect();
    const {left,right}=geometry(rect.width,rect.height);
    if(seconds>0 && right>left) onSeek(limit((event.clientX-rect.left-left)/(right-left),0,1));
  }
  chart.onpointerdown=event=>{
    if(event.button!==0 || !event.isPrimary || pointer!==null || seconds<=0) return;
    pointer=event.pointerId;chart.setPointerCapture(pointer);seek(event);
  };
  chart.onpointermove=event=>{if(pointer===event.pointerId)seek(event);};
  chart.onpointerup=chart.onpointercancel=chart.onlostpointercapture=event=>{if(pointer===event.pointerId)pointer=null;};
  chart.onkeydown=event=>{
    if(seconds<=0 || event.altKey || event.metaKey || event.ctrlKey) return;
    const current=frame?pointTime(frame)/seconds:0,step=event.shiftKey?.1:.01;
    let target;
    switch(event.key) {
      case 'Home':target=0;break;
      case 'End':target=1;break;
      case 'ArrowLeft':case 'ArrowDown':target=current-step;break;
      case 'ArrowRight':case 'ArrowUp':target=current+step;break;
      default:return;
    }
    event.preventDefault();onSeek(limit(target,0,1));
  };

  function capture() {
    if(!frame)return null;
    const canvas=document.createElement('canvas');canvas.width=1120;canvas.height=690;
    const ctx=canvas.getContext('2d');if(!ctx)return null;
    ctx.fillStyle='#101c30';ctx.fillRect(0,0,1120,690);
    ctx.save();ctx.translate(0,50);drawOrbit(ctx,1120,350,frame,signal,config);ctx.restore();
    ctx.save();ctx.translate(0,430);drawSignalBase(ctx,1120,260,signal,config,maximum);
    drawCursor(ctx,1120,260,seconds,frame,maximum);ctx.restore();
    ctx.font='bold 23px system-ui';ctx.fillStyle=COLORS.text;ctx.fillText('Orbite du système binaire',18,33);
    ctx.font='16px system-ui';ctx.textAlign='right';ctx.fillStyle=COLORS.amber;ctx.fillText(masses.textContent,1102,33);
    ctx.textAlign='left';ctx.font='bold 16px system-ui';ctx.fillStyle=COLORS.text;ctx.fillText('Signal gravitationnel',18,421);
    ctx.textAlign='right';ctx.fillStyle=COLORS.cyan;ctx.fillText(frequency.textContent,1102,421);
    return canvas;
  }

  return {setSignal,update,capture,dispose(){observer.disconnect();cancelAnimationFrame(paintId);host.replaceChildren();}};
}
