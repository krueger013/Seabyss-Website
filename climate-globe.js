import { assetUrl } from './assets.js';
import { earthProjection, earthUnprojection } from './earth-explorer.js';
import { climateAtLatitude } from './climate-model.js';
import { CRYO_GRID_HEIGHT, CRYO_GRID_WIDTH, cryoLandAt } from './cryosphere-geography.js';

const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
const wrap=value=>((value+180)%360+360)%360-180;
const rad=Math.PI/180;
const start={latitude:19,longitude:-28};
const displayNumber=new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const layers={
  ice:{label:'Fraction de glace simulée',ticks:['0 %','50 %','100 %'],min:0,max:1,colors:[[15,38,58],[77,146,174],[240,250,255]]},
  temperature:{label:'Température de surface',ticks:['−60 °C','−5 °C','+50 °C'],min:-60,max:50,colors:[[57,57,164],[65,147,219],[102,216,208],[253,204,96],[223,68,58]]},
  insolation:{label:'Ensoleillement moyen sur 24 h',ticks:['0','300','600 W/m²'],min:0,max:600,colors:[[14,31,67],[61,91,145],[126,151,159],[246,190,96],[255,240,163]]},
  albedo:{label:'Lumière réfléchie',ticks:['0 %','50 %','100 %'],min:0,max:1,colors:[[20,24,51],[74,59,139],[157,121,205],[219,189,243],[255,246,247]]},
  seaIce:{label:'Couverture de banquise',ticks:['0 %','50 %','100 %'],regional:true},
  landIce:{label:'Glace continentale',ticks:['0 %','50 %','100 %'],regional:true},
  cryosphere:{label:'Glace par type de surface',regional:true,combined:true}
};
const latitudeRows=361;
const cryoSize=CRYO_GRID_HEIGHT*CRYO_GRID_WIDTH;
const opacityRamp=Uint8Array.from({length:256},(_,index)=>Math.round((index/255)**.7*255));
const coordinate=(value,negative,positive)=>displayNumber.format(Math.abs(value))+'° '+(value<0?negative:positive);

function colorScale(layer) {
  const {colors}=layer, result=new Uint8Array(256*3);
  for(let index=0;index<256;index++) {
    const p=index*(colors.length-1)/255, base=Math.floor(p), rest=p-base;
    const a=colors[base], b=colors[Math.min(colors.length-1,base+1)];
    for(let c=0;c<3;c++) result[index*3+c]=Math.round(a[c]+(b[c]-a[c])*rest);
  }
  return result;
}
const palettes=Object.fromEntries(Object.entries(layers).filter(([,layer])=>!layer.regional).map(([name,layer])=>[name,colorScale(layer)]));

// The same climate state applies at every longitude in a latitude band.
// Interpolate onto a fine display grid before updating the globe pixels.
function latitudeField(measurement,kind) {
  const layer=layers[kind], result=new Uint8Array(latitudeRows);
  if(!measurement || layer.regional) return result;
  for(let row=0;row<latitudeRows;row++) {
    const value=climateAtLatitude(measurement,row/2-90)?.[kind] ?? 0;
    result[row]=Math.round(clamp((value-layer.min)/(layer.max-layer.min),0,1)*255);
  }
  return result;
}

function regionalField(measurement,kind) {
  if(measurement?.cells?.length!==cryoSize) return null;
  const sea=new Uint8Array(cryoSize),land=new Uint8Array(cryoSize);
  for(let index=0;index<cryoSize;index++) {
    const cell=measurement.cells[index];
    if(kind!=='landIce') sea[index]=opacityRamp[Math.round(clamp(cell.seaIce,0,1)*255)];
    if(kind!=='seaIce') land[index]=opacityRamp[Math.round(clamp(cell.landIce,0,1)*255)];
  }
  return {sea,land};
}

function texturePixels(image) {
  const source=document.createElement('canvas');
  source.width=Math.min(1024,image.naturalWidth);
  source.height=Math.round(source.width*image.naturalHeight/image.naturalWidth);
  const brush=source.getContext('2d');
  if(!brush) return null;
  brush.drawImage(image,0,0,source.width,source.height);
  const map=brush.getImageData(0,0,source.width,source.height);
  // Neutralize baked snow in the polar imagery so the climate mask alone
  // supplies the bright ice layer. The underlying terrain there is stylized.
  for(let y=0;y<map.height;y++) {
    const latitude=Math.abs((.5-(y+.5)/map.height)*180);
    if(latitude<50) continue;
    for(let x=0;x<map.width;x++) {
      const t=(y*map.width+x)*4;
      const r=map.data[t], g=map.data[t+1], b=map.data[t+2];
      const luma=(r+g+b)/3, spread=Math.max(r,g,b)-Math.min(r,g,b);
      const opacity=clamp((luma-121)/76,0,1)*clamp((105-spread)/63,0,1)*clamp((latitude-50)/12,0,1);
      const cool=Math.max(0,b-r);
      map.data[t]=r+(57-cool*.30-r)*opacity;
      map.data[t+1]=g+(71-cool*.18-g)*opacity;
      map.data[t+2]=b+(75+cool*.20-b)*opacity;
    }
  }
  return map;
}

function sphereProjection(diameter,center,map,showRegions) {
  const size=diameter**2;
  const lookup=new Int32Array(size).fill(-1), belts=new Uint16Array(size), diffuse=new Uint8Array(size);
  const rims=new Uint8Array(size), alpha=new Uint8Array(size);
  const cells=showRegions?new Uint16Array(size):null;
  const coast=showRegions?new Uint8Array(size):null;
  const centerLat=center.latitude*rad, cosLat=Math.cos(centerLat), sinLat=Math.sin(centerLat);
  const shift=center.longitude/360+.5;
  for(let j=0;j<diameter;j++) {
    const y=1-(j+.5)/diameter*2;
    for(let i=0;i<diameter;i++) {
      const x=(i+.5)/diameter*2-1, r2=x*x+y*y;
      if(r2>=1) continue;
      const z=Math.sqrt(1-r2), index=j*diameter+i;
      const latitude=Math.asin(clamp(y*cosLat+z*sinLat,-1,1));
      const longitude=Math.atan2(x,z*cosLat-y*sinLat)/(2*Math.PI)+shift;
      if(cells) {
        const row=clamp(Math.floor((.5-latitude/Math.PI)*CRYO_GRID_HEIGHT),0,CRYO_GRID_HEIGHT-1);
        const column=Math.floor((longitude-Math.floor(longitude))*CRYO_GRID_WIDTH);
        cells[index]=row*CRYO_GRID_WIDTH+column;
        coast[index]=cryoLandAt(latitude/rad,(longitude-.5)*360);
      }
      belts[index]=clamp(Math.round(latitude/rad*2)+180,0,latitudeRows-1);
      alpha[index]=Math.round(255*Math.min(1,(1-r2)*diameter*.5));
      diffuse[index]=Math.round(255*(.57+.43*clamp(z*.82-x*.38+y*.38,0,1)));
      rims[index]=Math.round(255*(1-z)**4);
      if(map) {
        const sourceX=Math.floor((longitude-Math.floor(longitude))*map.width);
        const sourceY=clamp(Math.floor((.5-latitude/Math.PI)*map.height),0,map.height-1);
        lookup[index]=(sourceY*map.width+sourceX)*4;
      }
    }
  }
  return {lookup,belts,diffuse,rims,alpha,cells,coast};
}

const climateMarkup=`
  <div class="climate-globe-stage">
    <canvas data-climate-canvas tabindex="0" role="img" aria-label="Globe terrestre interactif. Les flèches le tournent et Entrée inspecte son centre.">Globe terrestre. Utilise les repères pour choisir un lieu.</canvas>
    <span class="climate-globe-source">NASA Blue Marble</span>
    <span data-climate-globe-subsolar class="climate-globe-subsolar"></span>
  </div>
  <div class="climate-globe-instruments">
    <div class="climate-globe-legend" data-climate-globe-legend data-layer="ice">
      <strong data-climate-globe-legend-title></strong>
      <div class="climate-globe-gradient" aria-hidden="true"></div>
      <div class="climate-globe-ticks"><span></span><span></span><span></span></div>
      <div class="climate-globe-glaces" data-climate-globe-glaces hidden><span>Banquise</span><span>Glace terrestre</span></div>
    </div>
    <div class="climate-globe-views" aria-label="Orienter le globe">
      <button type="button" data-climate-globe-view="north" aria-label="Centrer le pôle Nord" title="Pôle Nord">Nord</button>
      <button type="button" data-climate-globe-view="earth" aria-label="Recentrer le globe sur l’Atlantique" title="Atlantique">Globe</button>
      <button type="button" data-climate-globe-view="south" aria-label="Centrer le pôle Sud" title="Pôle Sud">Sud</button>
    </div>
  </div>`;

export function createClimateGlobe(host,{onSelect=()=>{}}={}) {
  const globe=document.createElement('div');
  globe.className='climate-globe';
  globe.innerHTML=climateMarkup;
  host.replaceChildren(globe);
  const $=selector=>globe.querySelector(selector);
  const canvas=$('[data-climate-canvas]');
  const context=canvas.getContext('2d');
  const raster=document.createElement('canvas'), pixels=raster.getContext('2d');
  const center={...start};
  const legend=$('[data-climate-globe-legend]'), sunOutput=$('[data-climate-globe-subsolar]');
  let kind='ice', measurement=null, field=latitudeField(measurement,kind), solarDeclination=0;
  let cryosphere=null,regions=null;
  let pin=null, projection=null, sizeKey='', map=null, raw=null, frame=0, recolor=true, closed=false;
  let pointer=null;
  if(!context || !pixels) {
    canvas.replaceWith(Object.assign(document.createElement('p'),{textContent:'Globe indisponible. Les relevés par latitude restent accessibles.'}));
    return {update(){},setLayer(){},setLocation(){},destroy(){host.replaceChildren();}};
  }

  function geometry() {
    const width=canvas.clientWidth, height=canvas.clientHeight;
    const dpr=Math.min(1.55,window.devicePixelRatio||1);
    return {width,height,dpr,radius:Math.min(width,height)*.455};
  }

  function request() {
    if(!frame && !closed) frame=requestAnimationFrame(draw);
  }

  function updateField() {
    if(layers[kind].regional) regions=regionalField(cryosphere,kind);
    else {
      regions=null;
      field=latitudeField(measurement,kind);
    }
    canvas.dataset.cryosphereReady=String(!!regions);
    recolor=true;
  }

  function updateTexture(image) {
    if(closed) return;
    try {
      map=texturePixels(image);
      if(map) canvas.dataset.texture=image===detail?'full':'preview';
      sizeKey='';request();
    } catch {
      // Canvas remains usable for measured fields when geographic pixels fail.
    }
  }
  const preview=new Image(), detail=new Image();
  const loadDetail=()=>{if(!closed && !detail.src) detail.src=assetUrl('earth-land-day.webp');};
  preview.onload=()=>{updateTexture(preview);requestAnimationFrame(loadDetail);};
  preview.onerror=loadDetail;
  detail.onload=()=>updateTexture(detail);
  preview.src=assetUrl('earth-land-preview.webp');

  function colorSphere() {
    const palette=palettes[kind], {lookup,belts,diffuse,rims,alpha,cells,coast}=projection;
    const data=raw.data;
    for(let index=0;index<alpha.length;index++) {
      if(!alpha[index]) continue;
      const t=lookup[index], p=index*4, intensity=field[belts[index]], color=intensity*3;
      const light=diffuse[index]/255, rim=rims[index]/255;
      const r=t>=0?map.data[t]:34, g=t>=0?map.data[t+1]:65, b=t>=0?map.data[t+2]:101;
      if(cells) {
        const cell=cells[index];
        const sea=regions && !coast[index] ? regions.sea[cell]/255 : 0;
        const land=regions && coast[index] ? regions.land[cell]/255 : 0;
        const base=1-sea-land;
        const facet=(r*.22+g*.58+b*.20)/255;
        data[p]=(r*base+(110+facet*42)*sea+(235+facet*20)*land)*light+12*rim;
        data[p+1]=(g*base+(199+facet*43)*sea+(208+facet*29)*land)*light+35*rim;
        data[p+2]=(b*base+(236+facet*19)*sea+(167+facet*46)*land)*light+60*rim;
      } else if(kind==='ice') {
        const blend=intensity/255;
        const facet=clamp((r*.2+g*.6+b*.2)/255,0,1);
        data[p]=(r+(179+facet*72-r)*blend)*light+12*rim;
        data[p+1]=(g+(220+facet*36-g)*blend)*light+35*rim;
        data[p+2]=(b+(244+facet*11-b)*blend)*light+60*rim;
      } else {
        const variation=.69+(.22*r+.57*g+.21*b)/715;
        data[p]=(palette[color]*variation+.10*r)*light+11*rim;
        data[p+1]=(palette[color+1]*variation+.14*g)*light+29*rim;
        data[p+2]=(palette[color+2]*variation+.14*b)*light+45*rim;
      }
      data[p+3]=alpha[index];
    }
    pixels.putImageData(raw,0,0);
    recolor=false;
  }

  function traceParallel(latitude,radius,stroke,segments) {
    context.beginPath();
    let onDisk=false;
    for(let i=0;i<=96;i++) {
      const point=earthProjection(latitude,center.longitude-180+i*3.75,center);
      if(point.depth<.025) {onDisk=false;continue;}
      if(onDisk) context.lineTo(point.x*radius,-point.y*radius);
      else context.moveTo(point.x*radius,-point.y*radius);
      onDisk=true;
    }
    context.strokeStyle=stroke;
    context.setLineDash(segments);
    context.lineWidth=1;
    context.stroke();
    context.setLineDash([]);
  }

  function draw() {
    frame=0;
    const {width,height,dpr,radius}=geometry();
    if(width<1 || height<1) return;
    const canvasWidth=Math.round(width*dpr), canvasHeight=Math.round(height*dpr);
    if(canvas.width!==canvasWidth || canvas.height!==canvasHeight) {canvas.width=canvasWidth;canvas.height=canvasHeight;}
    context.setTransform(dpr,0,0,dpr,canvasWidth/2,canvasHeight/2);
    context.clearRect(-width/2,-height/2,width,height);
    const diameter=Math.min(pointer?.moved?280:460,Math.max(2,Math.round(radius*2*dpr)));
    const showRegions=!!layers[kind].regional;
    const key=diameter+'/'+center.latitude+'/'+center.longitude+'/'+showRegions;
    if(key!==sizeKey) {
      sizeKey=key;
      projection=sphereProjection(diameter,center,map,showRegions);
      if(raster.width!==diameter || raster.height!==diameter) raster.width=raster.height=diameter;
      if(!raw || raw.width!==diameter) raw=pixels.createImageData(diameter,diameter);
      if(raw) raw.data.fill(0);
      recolor=true;
    }
    if(recolor) colorSphere();

    context.save();
    context.shadowColor='rgba(91,157,224,.62)';
    context.shadowBlur=14;
    context.drawImage(raster,-radius,-radius,2*radius,2*radius);
    context.restore();
    context.beginPath();
    context.arc(0,0,radius,0,Math.PI*2);
    context.strokeStyle='rgba(148,202,247,.32)';
    context.lineWidth=1;
    context.stroke();
    if(kind==='insolation') traceParallel(solarDeclination,radius,'rgba(255,238,162,.86)',[4,4]);
    else traceParallel(0,radius,'rgba(199,226,255,.24)',[2,5]);
    const selected=pin && earthProjection(pin.latitude,pin.longitude,center);
    if(selected && selected.depth>0) {
      const x=selected.x*radius, y=-selected.y*radius;
      context.beginPath();context.arc(x,y,8,0,Math.PI*2);
      context.lineWidth=3;context.strokeStyle='rgba(9,17,26,.80)';context.stroke();
      context.lineWidth=1.3;context.strokeStyle='#e9f7fd';context.stroke();
      context.beginPath();context.arc(x,y,2.8,0,Math.PI*2);
      context.fillStyle='#ffd38f';context.fill();
    }
    canvas.dataset.latitude=center.latitude.toFixed(1);
    canvas.dataset.longitude=center.longitude.toFixed(1);
  }

  function renderLegend() {
    const layer=layers[kind];
    legend.dataset.layer=kind;
    $('[data-climate-globe-legend-title]').textContent=layer.label;
    const ticks=$('.climate-globe-ticks');
    ticks.hidden=!!layer.combined;
    $('.climate-globe-gradient').hidden=!!layer.combined;
    $('[data-climate-globe-glaces]').hidden=!layer.combined;
    if(layer.ticks) ticks.querySelectorAll('span').forEach((element,index)=>{element.textContent=layer.ticks[index];});
    sunOutput.hidden=kind!=='insolation';
    updateSolarLabel();
  }

  function updateSolarLabel() {
    if(sunOutput.hidden) return;
    const text='Soleil au zénith · '+coordinate(solarDeclination,'S','N');
    if(text!==sunOutput.textContent) sunOutput.textContent=text;
  }

  function turn(latitude,longitude) {
    center.latitude=clamp(latitude,-90,90);center.longitude=wrap(longitude);request();
  }

  function setLocation(latitude,longitude,{center:recenter=false}={}) {
    if(!Number.isFinite(latitude)||!Number.isFinite(longitude)) return;
    pin={latitude:clamp(latitude,-90,90),longitude:wrap(longitude)};
    canvas.dataset.pickLatitude=pin.latitude.toFixed(3);
    canvas.dataset.pickLongitude=pin.longitude.toFixed(3);
    if(recenter || earthProjection(pin.latitude,pin.longitude,center).depth<=0) turn(pin.latitude,pin.longitude);
    else request();
  }

  function select(point) {
    if(!point) return;
    setLocation(point.latitude,point.longitude);
    onSelect(point.latitude,point.longitude);
  }

  canvas.onpointerdown=event=>{
    if(pointer || event.button!==0 || !event.isPrimary) return;
    pointer={id:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,moved:false};
    canvas.setPointerCapture(event.pointerId);
    if(event.pointerType!=='touch') canvas.focus({preventScroll:true});
  };
  canvas.onpointermove=event=>{
    if(pointer?.id!==event.pointerId) return;
    if(Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)>5) pointer.moved=true;
    if(!pointer.moved) return;
    const degrees=71/Math.max(30,geometry().radius);
    turn(center.latitude+(event.clientY-pointer.y)*degrees,center.longitude-(event.clientX-pointer.x)*degrees);
    pointer.x=event.clientX;pointer.y=event.clientY;
  };
  canvas.onpointerup=event=>{
    if(pointer?.id!==event.pointerId) return;
    if(!pointer.moved) {
      const rect=canvas.getBoundingClientRect(), {radius}=geometry();
      select(earthUnprojection((event.clientX-rect.left-rect.width/2)/radius,(rect.height/2+rect.top-event.clientY)/radius,center));
    }
    pointer=null;request();
  };
  canvas.onpointercancel=canvas.onlostpointercapture=()=>{pointer=null;request();};
  canvas.onkeydown=event=>{
    if(event.altKey||event.metaKey||event.ctrlKey) return;
    const step=event.shiftKey?25:10;
    switch(event.key) {
      case 'ArrowUp': turn(center.latitude+step,center.longitude);break;
      case 'ArrowDown': turn(center.latitude-step,center.longitude);break;
      case 'ArrowLeft': turn(center.latitude,center.longitude-step);break;
      case 'ArrowRight': turn(center.latitude,center.longitude+step);break;
      case 'Enter': select({...center});break;
      case 'Home': turn(start.latitude,start.longitude);break;
      default: return;
    }
    event.preventDefault();event.stopPropagation();
  };
  for(const button of globe.querySelectorAll('[data-climate-globe-view]')) button.onclick=()=>{
    const view=button.dataset.climateGlobeView;
    if(view==='earth') turn(start.latitude,start.longitude);
    else turn(view==='north'?90:-90,center.longitude);
  };

  const resize=new ResizeObserver(request);
  resize.observe(canvas);
  renderLegend();request();
  return {
    update(values,regionalValues=null) {
      measurement=values;
      cryosphere=regionalValues;
      const declination=measurement?.solarDeclination;
      solarDeclination=Number.isFinite(declination)?clamp(declination,-90,90):0;
      updateField();
      updateSolarLabel();
      request();
    },
    setLayer(layer) {
      if(!Object.hasOwn(layers,layer) || layer===kind) return;
      kind=layer;updateField();renderLegend();request();
    },
    setLocation,
    destroy() {
      closed=true;cancelAnimationFrame(frame);resize.disconnect();
      preview.onload=preview.onerror=detail.onload=null;
      host.replaceChildren();
    }
  };
}
