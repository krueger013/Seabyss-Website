import {assetUrl} from './assets.js';

const number=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:4});
const node=(tag,text='')=>{const el=document.createElement(tag);el.textContent=text;return el;};
const clock=hours=>(hours>0?'+':'')+number.format(hours)+' h';

export function measuredDepth(baseline,inTransit) {
  return 1-inTransit/baseline;
}
export function nearestSample(points,time) {
  let lo=0,hi=points.length-1;
  while(lo<hi) {
    const mid=Math.floor((lo+hi)/2);
    if(points[mid][0]<time)lo=mid+1;else hi=mid;
  }
  if(lo && time-points[lo-1][0]<points[lo][0]-time)return lo-1;
  return lo;
}
export function observationCsv(data) {
  return 'time_from_reference_h,time_bjd_tdb,relative_flux,relative_flux_error\r\n'+data.points.map(([h,f,e])=>
    [h,(data.referenceBjdTdb+h/24).toFixed(7),f,e].join(',')).join('\r\n')+'\r\n';
}

export function createTransitObservation(host,{onReturn}) {
  const view=node('section');view.className='transit-observation';
  const back=node('button','Retour au modèle');back.type='button';back.className='chart-secondary';
  back.dataset.observationReturn='';back.onclick=onReturn;
  const status=node('p','Chargement des mesures…');status.setAttribute('role','status');
  view.append(back,status);host.append(view);
  let closed=false,resize;
  const controller=new AbortController();
  async function load() {
    const response=await fetch(assetUrl('transit-observation.json'),{signal:controller.signal});
    if (!response.ok) throw new Error('observation');
    const data=await response.json();
    if (!Array.isArray(data.points) || data.points.length<2 || !Number.isFinite(data.referenceBjdTdb)
      || data.points.some(([h,f,e],i)=>!Number.isFinite(h) || !(f>0) || !Number.isFinite(f) || !Number.isFinite(e) || e<0 || (i && h<=data.points[i-1][0]))) throw new Error('photometry');
    if (closed) return;
    status.remove();
    const rows=data.points;
    const title=node('h3',data.targetName || 'HD 209458 b');
    const info=node('p',[data.instrument,data.observationDate,rows.length+' mesures'].filter(Boolean).join(' · '));
    view.append(title,info);
    const canvas=node('canvas');canvas.dataset.observedCurve='';canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label','Flux stellaire mesuré en fonction du temps. Utilise le curseur pour lire chaque mesure.');
    const field=node('label','Parcourir les mesures'),slider=node('input');
    slider.type='range';slider.min='0';slider.max=String(rows.length-1);slider.step='1';slider.dataset.observedSample='';
    field.className='photo-sample';field.append(slider);
    const sample=node('output');sample.dataset.observedReading='';
    const errorLabel=node('label'),errors=node('input');errors.type='checkbox';errors.dataset.observedErrors='';
    errorLabel.className='photo-error-choice';errorLabel.append(errors,'Afficher les incertitudes');
    view.append(canvas,field,sample,errorLabel);
    const measurement=node('section');measurement.className='photo-depth-measure';
    const prompt=node('p','Choisis une mesure hors transit comme référence, puis une mesure dans le creux.');
    const picks=node('div');picks.className='photo-actions';
    const baseline=node('button','Marquer la référence'),trough=node('button','Marquer le creux');
    baseline.type=trough.type='button';baseline.dataset.observedBaseline='';trough.dataset.observedTrough='';
    picks.append(baseline,trough);
    const depth=node('output');depth.dataset.observedDepth='';depth.setAttribute('aria-live','polite');
    measurement.append(node('h4','Mesurer la baisse de lumière'),prompt,picks,depth);view.append(measurement);
    const source=node('details'),heading=node('summary','Observation et traitement');
    const archive=node('a',data.sourceTitle || 'Produit original dans MAST');archive.href=data.sourceUrl;archive.target='_blank';archive.rel='noopener noreferrer';
    source.append(heading,node('p',data.epoch),node('p',data.processing),archive);
    const download=node('button','Télécharger les mesures (CSV)');download.type='button';download.className='chart-secondary';download.dataset.observedCsv='';
    download.onclick=()=>{
      const blob=new Blob([observationCsv(data)],{type:'text/csv;charset=utf-8'});
      const url=URL.createObjectURL(blob),link=node('a');
      link.download='SEABYSS-HD-209458-b-photometrie.csv';link.href=url;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    view.append(source,download);
    let active=nearestSample(rows,0),reference=null,bottom=null;
    const xmin=rows[0][0],xmax=rows.at(-1)[0];
    const low=Math.min(...rows.map(([,f,e])=>f-e)),high=Math.max(...rows.map(([,f,e])=>f+e));
    const pad=Math.max((high-low)*.09,.0001),ymin=low-pad,ymax=high+pad;
    const margin={left:48,right:12,top:28,bottom:32};
    function paint() {
      const box=canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const ratio=Math.min(devicePixelRatio||1,2),w=box.width,h=box.height;
      const pixelsW=Math.round(w*ratio),pixelsH=Math.round(h*ratio);
      if(canvas.width!==pixelsW || canvas.height!==pixelsH){canvas.width=pixelsW;canvas.height=pixelsH;}
      const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
      const x=value=>margin.left+(value-xmin)/(xmax-xmin)*(w-margin.left-margin.right);
      const y=value=>h-margin.bottom-(value-ymin)/(ymax-ymin)*(h-margin.top-margin.bottom);
      ctx.font='12px system-ui';ctx.fillStyle='#d3dedf';ctx.textAlign='left';ctx.fillText('Flux relatif (%)',4,15);
      for(let i=0;i<=3;i++){
        const f=ymin+(ymax-ymin)*i/3,py=y(f);ctx.fillStyle='#c6d3d8';ctx.textAlign='right';
        ctx.fillText((f*100).toLocaleString('fr-CA',{maximumFractionDigits:1}),margin.left-6,py+4);
        ctx.strokeStyle='#35434b';ctx.beginPath();ctx.moveTo(margin.left,py);ctx.lineTo(w-margin.right,py);ctx.stroke();
      }
      ctx.textAlign='center';
      for(let i=0;i<3;i++){
        const t=[xmin,0,xmax][i];ctx.fillStyle='#c6d3d8';
        ctx.textAlign=i===0?'left':i===2?'right':'center';ctx.fillText(clock(t),x(t),h-9);
      }
      ctx.fillStyle='#9ad4dd';ctx.beginPath();
      for(const [t,f] of rows){const px=x(t),py=y(f);ctx.moveTo(px+1.6,py);ctx.arc(px,py,1.6,0,Math.PI*2);}
      ctx.fill();
      if (errors.checked) {
        ctx.beginPath();ctx.strokeStyle='#f2c68d';
        for(const [t,f,e] of rows){
          const px=x(t),top=y(f+e),bottom=y(f-e);
          ctx.moveTo(px,top);ctx.lineTo(px,bottom);
          ctx.moveTo(px-1.8,top);ctx.lineTo(px+1.8,top);
          ctx.moveTo(px-1.8,bottom);ctx.lineTo(px+1.8,bottom);
        }
        ctx.stroke();
      }
      const px=x(rows[active][0]);ctx.strokeStyle='#aeb8b685';ctx.setLineDash([3,4]);
      ctx.beginPath();ctx.moveTo(px,margin.top);ctx.lineTo(px,h-margin.bottom);ctx.stroke();ctx.setLineDash([]);
      for(const [i,color,r] of [[reference,'#9ee5bf',7],[bottom,'#dba6ec',7],[active,'#ffd197',4]]) {
        if(i===null)continue;
        ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x(rows[i][0]),y(rows[i][1]),r,0,Math.PI*2);ctx.stroke();
      }
      ctx.lineWidth=1;
    }
    function select(i) {
      active=i;slider.value=String(i);
      const [t,f,e]=rows[i];
      sample.textContent=clock(t)+' · flux '+number.format(f*100)+' % ± '+number.format(e*100)+' point de pourcentage';
      sample.dataset.flux=String(f);
      slider.setAttribute('aria-valuetext',sample.textContent);paint();
    }
    function mark(isReference) {
      if (isReference) reference=active;else bottom=active;
      if(reference!==null)baseline.textContent='Référence · '+clock(rows[reference][0]);
      if(bottom!==null)trough.textContent='Creux · '+clock(rows[bottom][0]);
      if(reference!==null && bottom!==null){
        const value=measuredDepth(rows[reference][1],rows[bottom][1]);
        depth.dataset.value=String(value);
        depth.textContent='Baisse estimée sur ces deux mesures : '+number.format(100*value)+' %.';
      }
      paint();
    }
    slider.oninput=()=>select(Number(slider.value));errors.onchange=paint;
    baseline.onclick=()=>mark(true);trough.onclick=()=>mark(false);
    canvas.onclick=event=>{
      const box=canvas.getBoundingClientRect(),fraction=(event.clientX-box.left-margin.left)/(box.width-margin.left-margin.right);
      select(nearestSample(rows,xmin+Math.max(0,Math.min(1,fraction))*(xmax-xmin)));
    };
    resize=new ResizeObserver(paint);resize.observe(canvas);select(active);
  }
  load().catch(()=>{if(!closed)status.textContent='Les mesures ne sont pas disponibles dans cette vue.';});
  return ()=>{closed=true;controller.abort();resize?.disconnect();};
}
