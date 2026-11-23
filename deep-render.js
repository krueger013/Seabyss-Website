const TAU = 2 * Math.PI;
const volumeIds = new Set(['orion-nebula','lagoon-nebula','eagle-nebula','carina-nebula',
  'crab-nebula','ring-nebula','dumbbell-nebula','m78','pleiades','triangulum','sombrero',
  'pinwheel','bodes-galaxy','cigar-galaxy','centaurus-a','m87','hercules-cluster','omega-centauri']);
const detailed = new Set(['orion-nebula','crab-nebula','ring-nebula','dumbbell-nebula','sombrero','eagle-nebula']);
export const hasPhotoDetail = id => detailed.has(id);
const historicDisks = new Set(['andromeda','milky-way','whirlpool']);
export const isDeep = obj => obj.kind === 'nebula' || obj.kind === 'cluster' ||
  (obj.kind === 'galaxy' && !historicDisks.has(obj.id));
export const hasVolume = id => volumeIds.has(id);
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const colours = [[.53,.68,1],[.66,.83,1],[.85,.90,1],[1,.95,.85],[1,.83,.59],[1,.66,.39]];
const particleSets = new Map();
function seedFor(name) {
  let state=2166136261;
  for (const c of name) state=Math.imul(state^c.charCodeAt(0),16777619);
  return () => ((state=Math.imul(1664525,state)+1013904223)>>>0)/4294967296;
}
// One catalogue of illustrative member stars is shared by both renderers.
// Entries pack world position, apparent size in body radii, RGB and luminosity.
export function deepParticles(obj) {
  if(particleSets.has(obj.id)) return particleSets.get(obj.id);
  const rng=seedFor(obj.id), globular=obj.kind==='cluster' && obj.morphology==='globular';
  const cluster=obj.kind==='cluster', nebula=obj.kind==='nebula';
  const count=globular?3200:cluster?(obj.id==='wild-duck'?920:260):nebula?155:110;
  const values=[];
  function add(x,y,z,size,color,intensity) { values.push(x,y,z,size,...colours[color],intensity); }
  for(let i=0;i<count;i++) {
    const az=rng()*TAU, axis=rng()*2-1, xy=Math.sqrt(1-axis*axis);
    // The central concentration of globular clusters follows a truncated
    // Plummer profile. Loose associations retain distinct bright members.
    const m=globular?Math.min(.995,rng()):rng();
    const r=globular?Math.min(.98,(obj.id==='omega-centauri'?.18:.16)/Math.sqrt(m**(-2/3)-1)):Math.pow(m,.56)*.93;
    const x=r*xy*Math.cos(az), y=r*axis*(globular?.88:.82), z=r*xy*Math.sin(az);
    const luminous=rng()**8, size=(globular?.0075:nebula?.0044:.006)+luminous*(globular?.033:nebula?.016:.025);
    const shade=rng();
    const color=globular?(shade>.89?5:shade>.66?4:shade>.36?3:2)
      :obj.id==='pleiades'?(shade>.82?2:1):Math.min(5,Math.floor(shade*6));
    add(x,y,z,size,color,(globular?.32:.22)+luminous*.73);
  }
  if(obj.id==='pleiades') {
    // A loose, asymmetric grouping of blue giants set in reflection dust.
    for(const [x,y,z,s] of [[-.305,.272,.12,.116],[.314,.473,-.10,.104],[.456,-.188,.10,.099],
      [-.054,-.238,-.15,.095],[-.833,.490,.08,.083],[.548,.556,.02,.074],[-.791,.649,.15,.064]])
      add(x*(1-z/2.9),y*(1-z/2.9),z,s,1,1.0);
  }
  if(obj.id==='orion-nebula') {
    for(const [x,y] of [[-.086,.045],[-.062,.064],[-.053,.034],[-.080,.017]])
      add(x,y,.15,.047,2,1.0);
  }
  if(obj.id==='ring-nebula'||obj.id==='dumbbell-nebula'||obj.id==='crab-nebula') add(0,0,.055,.028,1,.93);
  const array=new Float32Array(values);
  particleSets.set(obj.id,array); return array;
}

const side=96, lastSlice=47;
const glows=new Map();
const toByte = v => Math.round(v*255);
function starSprite(index,bright) {
  const key=index+'-'+bright;
  if(glows.has(key)) return glows.get(key);
  const img=document.createElement('canvas'), n=48;img.width=img.height=n;
  const ctx=img.getContext('2d'), col=colours[index].map(toByte);
  const grad=ctx.createRadialGradient(24,24,0,24,24,24);
  const rgb=col.join(',');
  grad.addColorStop(0,'rgba(255,255,250,1)');grad.addColorStop(.062,'rgba('+rgb+',1)');
  grad.addColorStop(.15,'rgba('+rgb+',.86)');grad.addColorStop(.29,'rgba('+rgb+',.24)');
  grad.addColorStop(.61,'rgba('+rgb+',.052)');grad.addColorStop(1,'rgba('+rgb+',0)');
  ctx.fillStyle=grad;ctx.fillRect(0,0,n,n);
  if(bright) {
    ctx.save();ctx.translate(24,24);ctx.rotate(.14);
    for(let i=0;i<4;i++) {
      ctx.rotate(Math.PI/2);const spike=ctx.createLinearGradient(0,0,20,0);
      spike.addColorStop(0,'rgba(255,255,255,.83)');spike.addColorStop(.40,'rgba('+rgb+',.21)');spike.addColorStop(1,'rgba('+rgb+',0)');
      ctx.fillStyle=spike;ctx.beginPath();ctx.moveTo(0,-.8);ctx.lineTo(21,0);ctx.lineTo(0,.8);ctx.fill();
    }
    ctx.restore();
  }
  glows.set(key,img);return img;
}
export function deepPoints2D(ctx,frame,item) {
  const {cam}=frame, {obj,center}=item, data=deepParticles(obj);
  const focal=cam.h/(2*cam.scale[1]), alpha=Math.min(1,Math.max(.04,item.radius/23));
  const step=item.radius<7?12:item.radius<22?4:1;
  ctx.save();ctx.globalCompositeOperation='lighter';
  for(let i=0;i<data.length;i+=8*step) {
    const x=data[i],y=data[i+1],z=data[i+2];
    const d=center[2]+x*cam.forward[0]+y*cam.forward[1]+z*cam.forward[2];
    if(d<.03) continue;
    const px=cam.cx*cam.w+(center[0]+x*cam.right[0]+y*cam.right[1]+z*cam.right[2])*focal/d;
    const py=cam.cy*cam.h-(center[1]+x*cam.up[0]+y*cam.up[1]+z*cam.up[2])*focal/d;
    if(px< -30 || px>cam.w+30 || py< -30 || py>cam.h+30) continue;
    const diameter=clamp(data[i+3]*focal/d*1.90,2.15,74);
    ctx.globalAlpha=alpha*data[i+7];
    let tone=2;
    if(data[i+4]<.6) tone=0;else if(data[i+4]<.8) tone=1;else if(data[i+6]<.45) tone=5;
    else if(data[i+6]<.65) tone=4;else if(data[i+6]<.9) tone=3;
    ctx.drawImage(starSprite(tone, data[i+3]>.04),px-diameter/2,py-diameter/2,diameter,diameter);
  }
  ctx.restore();
}

export function readVolumeImage(image) {
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
  return ctx.getImageData(0,0,image.width,image.height);
}
// Retain observed filaments finer than the simulation grid. The signed
// residual is applied only near the measured sky direction. Depths and
// side projections continue to use the full 3-D field.
export function photoRelief(image) {
  const size=256, low=document.createElement('canvas'), high=document.createElement('canvas');
  low.width=low.height=48;high.width=high.height=size;
  const coarse=low.getContext('2d'), ctx=high.getContext('2d',{willReadFrequently:true});
  coarse.imageSmoothingQuality='high';coarse.drawImage(image,0,0,48,48);
  ctx.drawImage(image,0,0,size,size);const exact=ctx.getImageData(0,0,size,size);
  ctx.drawImage(low,0,0,size,size);const soft=ctx.getImageData(0,0,size,size);
  for(let i=0;i<exact.data.length;i+=4) for(let k=0;k<3;k++)
    exact.data[i+k]=128+1.5*(exact.data[i+k]-soft.data[i+k]);
  ctx.putImageData(exact,0,0);return high;
}
// Software ray integration samples the same 3-D colour field as the fragment
// shader. Screen bounds and an adaptive sample budget keep phone frames small.
export class CanvasVolumes {
  constructor() { this.maps=new Map();this.details=new Map();this.cache=new Map(); }
  load(id,img) { this.maps.set(id,readVolumeImage(img));this.cache.delete(id); }
  loadDetail(id,img) {this.details.set(id,readVolumeImage(img));this.cache.delete(id);}
  draw(ctx,frame,item) {
    const {cam}=frame, {obj,center,bounds}=item, map=this.maps.get(obj.id);
    if(!map) return;
    const left=clamp((bounds[0]+1)*cam.w*.5-1,0,cam.w);
    const right=clamp((bounds[2]+1)*cam.w*.5+1,0,cam.w);
    const top=clamp((1-bounds[3])*cam.h*.5-1,0,cam.h);
    const bottom=clamp((1-bounds[1])*cam.h*.5+1,0,cam.h);
    const width=right-left,height=bottom-top;
    if(width<1||height<1) return;
    const factor=Math.min(1,(frame.cameraMoving?180:320)/Math.max(width,height));
    const w=Math.max(2,Math.ceil(width*factor)),h=Math.max(2,Math.ceil(height*factor));
    const key=[w,h,cam.cx,cam.cy,...cam.scale,...center,...cam.matrix].map(v=>Math.round(v*1800)).join(',');
    let entry=this.cache.get(obj.id);
    if(!entry||entry.key!==key) {
      const canvas=entry?.canvas||document.createElement('canvas');canvas.width=w;canvas.height=h;
      const context=canvas.getContext('2d'), image=context.createImageData(w,h), pixels=image.data;
      const data=map.data,stride=map.width*4,steps=frame.cameraMoving?30:48,details=this.details.get(obj.id);
      const a=cam.right,b=cam.up,c=cam.forward;
      const o=[0,1,2].map(j=>-center[0]*a[j]-center[1]*b[j]-center[2]*c[j]);
      const originSq=dot(o,o);
      for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
        const dx=((left+(x+.5)*width/w)/cam.w-cam.cx)*2*cam.scale[0];
        const dy=(cam.cy-(top+(y+.5)*height/h)/cam.h)*2*cam.scale[1];
        const inv=1/Math.hypot(dx,dy,1);
        const vx=(a[0]*dx+b[0]*dy+c[0])*inv,vy=(a[1]*dx+b[1]*dy+c[1])*inv,vz=(a[2]*dx+b[2]*dy+c[2])*inv;
        const closest=-(vx*o[0]+vy*o[1]+vz*o[2]), disc=1-originSq+closest*closest;
        if(disc<=0)continue;
        const half=Math.sqrt(disc), first=Math.max(0,closest-half),end=closest+half;
        if(end<=first)continue;
        const n=Math.min(steps,Math.max(6,Math.ceil((end-first)*steps*.63))),step=(end-first)/n;
        let red=0,green=0,blue=0,t=first+step*.5;
        for(let j=0;j<n;j++,t+=step) {
          const px=clamp((o[0]+vx*t+1)*47.5,0,95),py=clamp((1-o[1]-vy*t)*47.5,0,95);
          const slice=clamp((o[2]+vz*t+1)*lastSlice*.5,0,lastSlice);
          const ix=Math.floor(px),iy=Math.floor(py),iz=Math.floor(slice),next=Math.min(lastSlice,iz+1);
          const fx=px-ix,fy=py-iy,fz=slice-iz;
          const k0=((iz>>3)*side+iy)*stride+((iz%8)*side+ix)*4;
          const k1=((next>>3)*side+iy)*stride+((next%8)*side+ix)*4;
          const right=ix<95?4:0,down=iy<95?stride:0;
          if(frame.cameraMoving) {
            const nearest=(fx>.5?right:0)+(fy>.5?down:0);
            const ka=k0+nearest,kb=k1+nearest;
            red+=data[ka]*(1-fz)+data[kb]*fz;green+=data[ka+1]*(1-fz)+data[kb+1]*fz;blue+=data[ka+2]*(1-fz)+data[kb+2]*fz;
            continue;
          }
          for(let uv=0;uv<4;uv++) {
            const off=(uv%2)*right+(uv>>1)*down;
            const weight=(uv%2?fx:1-fx)*(uv>1?fy:1-fy), one=weight*(1-fz), two=weight*fz;
            red+=data[k0+off]*one+data[k1+off]*two;
            green+=data[k0+off+1]*one+data[k1+off+1]*two;
            blue+=data[k0+off+2]*one+data[k1+off+2]*two;
          }
        }
        const gain=step*3.85/255, k=(y*w+x)*4;
        pixels[k]=255*(1-Math.exp(-gain*red));pixels[k+1]=255*(1-Math.exp(-gain*green));
        pixels[k+2]=255*(1-Math.exp(-gain*blue));pixels[k+3]=255;
        if(details && vz<-.45) {
          const plane=-o[2]/vz, sx=(1+o[0]+vx*plane)*.5, sy=(1-o[1]-vy*plane)*.5;
          if(plane>0&&sx>0&&sx<1&&sy>0&&sy<1) {
            const d=(Math.floor(sy*details.height)*details.width+Math.floor(sx*details.width))*4;
            const amount=Math.min(1,(-vz-.45)*2)*Math.min(1,Math.max(pixels[k],pixels[k+1],pixels[k+2])/28)*.73;
            for(let channel=0;channel<3;channel++)pixels[k+channel]+=(details.data[d+channel]-128)*amount;
          }
        }
      }
      context.putImageData(image,0,0);
      entry={canvas,key};this.cache.set(obj.id,entry);
    }
    ctx.save();ctx.globalCompositeOperation='screen';ctx.drawImage(entry.canvas,left,top,width,height);ctx.restore();
  }
}
