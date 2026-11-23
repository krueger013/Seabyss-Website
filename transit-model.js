export {transitTarget} from './transit-targets.js';

const clamp = (value,min,max) => Math.min(max,Math.max(min,value));

// Opaque planet and uniform stellar disk, in stellar-radius units. The
// intersection is the sum of two circular segments divided by the stellar area.
export function blockedLight(radiusRatio,separation) {
  const k = radiusRatio, z = separation;
  if (z >= 1+k) return 0;
  if (z <= 1-k) return k*k;
  const stellarAngle = Math.acos(clamp((z*z+1-k*k)/(2*z),-1,1));
  const planetAngle = Math.acos(clamp((z*z+k*k-1)/(2*z*k),-1,1));
  const segment = angle => angle-.5*Math.sin(2*angle);
  return clamp((segment(stellarAngle)+k*k*segment(planetAngle))/Math.PI,0,k*k);
}

export function transitGeometry(target,impact) {
  const {axis,periodHours,radiusRatio:k} = target;
  const limit = Math.min(axis,1+k+.25);
  const observed = target.planet.transitInclinationDeg;
  const reference = Number.isFinite(observed) ? axis*Math.abs(Math.cos(observed*Math.PI/180)) : .35;
  const b = clamp(Number.isFinite(impact) ? impact : reference,0,limit);
  const outer = 1+k;
  // Winn (2010), eq. 14, https://arxiv.org/abs/1001.2010
  // T14 for a circular orbit, first contact to last contact. At conjunction
  // the sky separation is b; the projected speed is fixed by a/R and P.
  const durationHours = b >= outer ? 0 : periodHours/Math.PI *
    Math.asin(Math.sqrt((outer*outer-b*b)/(axis*axis-b*b)));
  const centralHalfHours = periodHours/(2*Math.PI)*Math.asin(outer/axis);
  const halfWindowHours = Math.min(periodHours*.245,1.45*centralHalfHours);
  return {b,limit,depth:blockedLight(k,b),durationHours,halfWindowHours,
    inclination:Math.acos(clamp(b/axis,0,1))*180/Math.PI,
    kind:b >= outer ? 'miss' : b > 1-k ? 'grazing' : 'full'};
}

export function transitSample(target,geometry,phase) {
  const hours = clamp(phase,-1,1)*geometry.halfWindowHours;
  const angle = 2*Math.PI*hours/target.periodHours;
  const x = target.axis*Math.sin(angle), y = geometry.b*Math.cos(angle);
  return {x,y,hours,flux:1-blockedLight(target.radiusRatio,Math.hypot(x,y))};
}
