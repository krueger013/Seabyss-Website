import { AstroTime, Body } from './astronomy-engine.js';
import { bodyPosition, jovianPosition, bodyAxes, surfaceAxes } from './surface-ephemeris.js';

const C_KM_S = 299792.458;
const DEG = 180 / Math.PI;
const FIRST_MS = Date.UTC(1900, 0, 1);
const END_MS = Date.UTC(2101, 0, 1);
const ECLIPTIC_NORTH = [0, -Math.sin(23.4392911 / DEG), Math.cos(23.4392911 / DEG)];

// Mean radii in km. https://ssd.jpl.nasa.gov/planets/phys_par.html
// https://ssd.jpl.nasa.gov/sats/phys_par/
export const PHASE_BODIES = Object.freeze({
  earth: {name:'Terre', radiusKm:6371.0088, body:Body.Earth},
  moon: {name:'Lune', radiusKm:1737.4, body:Body.Moon},
  mercury: {name:'Mercure', radiusKm:2439.7, body:Body.Mercury},
  venus: {name:'Vénus', radiusKm:6051.8, body:Body.Venus},
  mars: {name:'Mars', radiusKm:3389.5, body:Body.Mars},
  jupiter: {name:'Jupiter', radiusKm:69911, body:Body.Jupiter},
  io: {name:'Io', radiusKm:1821.6},
  europa: {name:'Europe', radiusKm:1560.8},
  ganymede: {name:'Ganymède', radiusKm:2631.2},
  callisto: {name:'Callisto', radiusKm:2410.3}
});

const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const subtract = (a, b) => a.map((x, i) => x - b[i]);
const unit = v => { const norm = Math.hypot(...v); return v.map(x => x / norm); };
const clampCosine = x => Math.max(-1, Math.min(1, x));
const milliseconds = time => time instanceof Date ? time.getTime() : time;
const validTime = time => Number.isFinite(time) && time >= FIRST_MS && time < END_MS;

function position(id, time) {
  const body = PHASE_BODIES[id].body;
  return body ? bodyPosition(body, time) : jovianPosition(id, time);
}

// Center-to-center phase. A spherical target with parallel Sun rays is assumed.
// Eclipse shadows and observer aberration are outside this illumination model.
export function phaseAt(observerId, targetId, date) {
  const timeMs = milliseconds(date);
  if (!validTime(timeMs) || typeof observerId !== 'string' || typeof targetId !== 'string' ||
      !Object.hasOwn(PHASE_BODIES, observerId) || !Object.hasOwn(PHASE_BODIES, targetId) ||
      observerId === targetId) return null;
  const reception = new AstroTime(new Date(timeMs));
  const observer = position(observerId, reception);
  let emission = reception;
  let target = position(targetId, emission);
  for (let i = 0; i < 2; i++) {
    const delayDays = Math.hypot(...subtract(target, observer)) / (C_KM_S * 86400);
    emission = new AstroTime(reception.ut - delayDays);
    target = position(targetId, emission);
  }

  const sightline = subtract(target, observer);
  const distanceKm = Math.hypot(...sightline);
  const forward = unit(sightline);
  const toObserver = forward.map(x => -x);
  const toSun = unit(subtract(bodyPosition(Body.Sun, emission), target));
  // A sky image with celestial north (J2000) up has east on the left.
  const east = unit(cross(Math.abs(forward[2]) < 1 - 1e-14 ? [0,0,1] : [1,0,0], forward));
  const north = cross(forward, east);
  const toScreen = axis => [-dot(axis,east), dot(axis,north), dot(axis,toObserver)];
  const skyLight = toScreen(toSun);
  const cosine = clampCosine(skyLight[2]);
  const sine = Math.hypot(skyLight[0], skyLight[1]);
  const handedness = dot(cross(toObserver, toSun), ECLIPTIC_NORTH) < 0 ? -1 : 1;
  const {body, radiusKm} = PHASE_BODIES[targetId];
  const axes = body ? bodyAxes(body, emission)
    : ['europa','ganymede'].includes(targetId) ? surfaceAxes(targetId, emission) : null;

  return {
    timeMs, observerId, targetId, distanceKm, skyLight,
    lightTimeSeconds:distanceKm / C_KM_S,
    angularDiameterDeg:2 * Math.asin(radiusKm / distanceKm) * DEG,
    phaseAngleDeg:Math.atan2(sine, cosine) * DEG,
    illuminatedFraction:(1 + cosine) / 2,
    brightLimbDeg:(Math.atan2(-skyLight[0], skyLight[1]) * DEG + 360) % 360,
    textureAxes:axes ? axes.map(toScreen) : null,
    // Triangle plane through the three centers. Rays have unit length to keep
    // the phase angle readable despite the very different distance scales.
    diagram:{target:[0,0], observer:[0,-1], sun:[handedness * sine, -cosine]}
  };
}

export function phaseTimeline(observerId, targetId, start, end, count = 61) {
  const first = milliseconds(start), last = milliseconds(end);
  if (!validTime(first) || !validTime(last) || last < first ||
      !Number.isInteger(count) || count < 2 || count > 512) return [];
  const frames = [];
  for (let i = 0; i < count; i++) {
    const frame = phaseAt(observerId, targetId, Math.round(first + (last-first) * i / (count-1)));
    if (!frame) return [];
    frames.push(frame);
  }
  return frames;
}
