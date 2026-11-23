import {travellerState, travellerCoverage} from './traveller-ephemerides.js';
import {Body, HelioVector, RotateVector, Rotation_EQJ_ECL} from './astronomy-engine.js';

export const TRAVELLERS = Object.freeze([
  {id:'halley', name:'1P/Halley', short:'Halley', kind:'Comète périodique', color:'#edbf83'},
  {id:'oumuamua', name:'1I/ʻOumuamua', short:'ʻOumuamua', kind:'Objet interstellaire', color:'#cbabd9'},
  {id:'voyager-1', name:'Voyager 1', short:'Voyager 1', kind:'Sonde interplanétaire', color:'#88d7d3'},
  {id:'voyager-2', name:'Voyager 2', short:'Voyager 2', kind:'Sonde interplanétaire', color:'#97b9ed'}
]);
export const AU_KM = 149597870.7;
export const DAY_MS = 86400000;
const objectIds = new Set(TRAVELLERS.map(object => object.id));
const finiteVector = vector => vector?.length === 3 && Array.from(vector).every(Number.isFinite);
const equatorialToEcliptic=Rotation_EQJ_ECL();

// Reception at Earth's center. Iterate emission time rather than equating
// the probe's current geometric distance with the distance its signal travelled.
export function earthReception(id,timeMs) {
  const current=travellerState(id,timeMs);
  if(!current) return null;
  const earth=RotateVector(equatorialToEcliptic,HelioVector(Body.Earth,new Date(timeMs)));
  const separation=([x,y,z])=>Math.hypot(x-earth.x,y-earth.y,z-earth.z);
  const distanceAu=separation(current.positionAu);
  let seconds=distanceAu*AU_KM/299792.458;
  for(let pass=0;pass<3;pass++) {
    const emitted=travellerState(id,timeMs-seconds*1000);
    if(!emitted) return {distanceAu,seconds:null};
    seconds=separation(emitted.positionAu)*AU_KM/299792.458;
  }
  return {distanceAu,seconds};
}

export function coverageFor(id) {
  if (!objectIds.has(id)) return null;
  const interval = travellerCoverage(id);
  return Number.isFinite(interval?.startMs) && Number.isFinite(interval?.endMs) &&
    interval.endMs >= interval.startMs ? interval : null;
}

export function readingAt(id, timeMs) {
  const interval = coverageFor(id);
  if (!interval || !Number.isFinite(timeMs) || timeMs < interval.startMs || timeMs > interval.endMs) return null;
  const state = travellerState(id,timeMs);
  if (!finiteVector(state?.positionAu)) return null;
  const distanceAu = Math.hypot(...state.positionAu);
  if (!(distanceAu > 0)) return null;
  const distanceKm = distanceAu * AU_KM;
  return {...state, distanceAu, distanceKm, lightSeconds:distanceKm / 299792.458,
    speedKms: finiteVector(state.velocityAuDay) ? Math.hypot(...state.velocityAuDay)*AU_KM/86400 : null};
}

// Sampling is clipped to the same validity interval as the displayed position.
export function sampleTrail(id, timeMs) {
  const interval = coverageFor(id);
  if (!interval || timeMs < interval.startMs || timeMs > interval.endMs) return [];
  const end = Math.min(interval.endMs, Math.floor(timeMs/DAY_MS)*DAY_MS);
  const start = Math.max(interval.startMs, end - 180*DAY_MS);
  if (end <= start) return [];
  return Array.from({length:37},(_,index) => readingAt(id,start+(end-start)*index/36)?.positionAu ?? null);
}
