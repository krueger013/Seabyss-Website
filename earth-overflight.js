import { geographicDirection } from './renderer.js';

const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
export const DEFAULT_OVERFLIGHT_ALTITUDE=4800;
const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const normalize=vector=>{
  const length=Math.hypot(...vector);
  return length ? vector.map(n=>n/length) : [0,0,1];
};

function arcDirection(from,to,t) {
  const cosine=clamp(dot(from,to),-1,1);
  if(cosine>.999999) return normalize(from.map((n,i)=>n+(to[i]-n)*t));
  let tangent=to.map((n,i)=>n-cosine*from[i]);
  if(Math.hypot(...tangent)<1e-7) {
    const axis=Math.abs(from[1])<.8?[0,1,0]:[1,0,0];
    tangent=axis.map((n,i)=>n-dot(axis,from)*from[i]);
  }
  const direction=normalize(tangent), angle=t*Math.acos(cosine);
  return from.map((n,i)=>n*Math.cos(angle)+direction[i]*Math.sin(angle));
}

export function createEarthOverflight(latitude,longitude) {
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180) return null;
  let altitude=DEFAULT_OVERFLIGHT_ALTITUDE, departure=null, progress=0;
  return {
    latitude,longitude,
    setAltitude(value) {
      if(![800,2100,4800,12000].includes(value)) return;
      altitude=value;
      departure=null;
      progress=0;
    },
    update(body,view,dt,instant) {
      const target=geographicDirection(body,latitude,longitude);
      const offset=view.position.map((p,i)=>p-body.position[i]);
      departure ||= {direction:normalize(offset),distance:Math.max(body.radius*1.002,Math.hypot(...offset))};
      progress=instant?1:clamp(progress+dt/1.65,0,1);
      const easing=progress*progress*(3-2*progress);
      const outward=arcDirection(departure.direction,target,easing);
      const distance=Math.exp(Math.log(departure.distance)*(1-easing)+Math.log(body.radius+altitude)*easing);
      view.position=body.position.map((p,i)=>p+outward[i]*distance);
      view.yaw=Math.atan2(-outward[0],outward[2]);
      view.pitch=Math.atan2(-outward[1],Math.hypot(outward[0],outward[2]));
      return distance-body.radius;
    }
  };
}
