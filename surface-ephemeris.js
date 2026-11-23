import { AstroTime, BaryState, Body, JupiterMoons, KM_PER_AU, Observer,
  ObserverVector, RotationAxis } from './astronomy-engine.js';
import { surfaceSite as site, SURFACE_SKY_SITES } from './surface-site-reference.js';
export { SURFACE_SKY_SITES };
export { bodyPosition, jovianPosition, bodyAxes, surfaceAxes };

const RAD = Math.PI / 180;
const TAU = 2 * Math.PI;
const LIGHT_KM_PER_DAY = 299792.458 * 86400;
const clampUnit = value => Math.max(-1, Math.min(1, value));
const magnitude = v => Math.hypot(...v);
const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const add = (a,b) => a.map((value,index) => value+b[index]);
const subtract = (a,b) => a.map((value,index) => value-b[index]);
const scale = (v,factor) => v.map(value => value*factor);
const unit = v => scale(v,1/magnitude(v));
const vector = ({x,y,z}) => [x,y,z];
const positiveAngle = angle => (angle+TAU)%TAU;

const worlds = {
  moon: {radius:1737.4, body:Body.Moon},
  mars: {radius:3389.5, body:Body.Mars},
  europa: {radius:1560.8, parent:Body.Jupiter},
  titan: {radius:2574.73, parent:Body.Saturn},
  mercury: {radius:2439.7, body:Body.Mercury},
  enceladus: {radius:252.1, parent:Body.Saturn},
  ganymede: {radius:2631.2, parent:Body.Jupiter}
};

// JPL SAT441 mean elements. Pole directions are in J2000 equatorial coordinates.
const saturnianOrbits = {
  titan:{semimajor:1221900,eccentricity:.029,anomaly:11.7,period:15.945448,pole:[36.4,84]},
  enceladus:{semimajor:238400,eccentricity:.005,anomaly:57,period:1.370218,pole:[40.6,83.5]}
};

const starsAndPlanets = [
  {id:'sun', name:'Soleil', radius:695700, body:Body.Sun},
  {id:'earth', name:'Terre', radius:6371.0088, body:Body.Earth},
  {id:'venus', name:'Vénus', radius:6051.8, body:Body.Venus},
  {id:'mercury', name:'Mercure', radius:2439.7, body:Body.Mercury},
  {id:'mars', name:'Mars', radius:3389.5, body:Body.Mars},
  {id:'jupiter', name:'Jupiter', radius:69911, body:Body.Jupiter},
  {id:'saturn', name:'Saturne', radius:58232, body:Body.Saturn}
];
const jovianMoons = [
  {id:'io', name:'Io', radius:1821.6},
  {id:'europa', name:'Europe', radius:1560.8},
  {id:'ganymede', name:'Ganymède', radius:2631.2},
  {id:'callisto', name:'Callisto', radius:2410.3}
];

function orbitalAxes(ra, dec, spin) {
  const north = [Math.cos(dec)*Math.cos(ra),Math.cos(dec)*Math.sin(ra),Math.sin(dec)];
  const node = [-Math.sin(ra),Math.cos(ra),0];
  const meridian = add(scale(node,Math.cos(spin)),scale(cross(north,node),Math.sin(spin)));
  return [meridian,cross(north,meridian),north];
}

function bodyAxes(body, time) {
  const axis = RotationAxis(body,time);
  if (body===Body.Earth) {
    const north = vector(axis.north);
    const meridian = unit(vector(ObserverVector(time,new Observer(0,0,0),false)));
    return [meridian,cross(north,meridian),north];
  }
  return orbitalAxes(axis.ra*15*RAD,axis.dec*RAD,axis.spin*RAD);
}

function surfaceAxes(worldId,time) {
  const world = worlds[worldId];
  if (world.body) return bodyAxes(world.body,time);
  const days = time.tt;
  if (worldId==='titan') return orbitalAxes(39.4827*RAD,83.4279*RAD,(186.5855+22.5769768*days)*RAD);
  const century = days/36525;
  if (worldId==='enceladus') return orbitalAxes((40.66-.036*century)*RAD,(83.52-.004*century)*RAD,(6.32+262.7318996*days)*RAD);
  // IAU orientations of Europa and Ganymede in NAIF pck00011.
  const argumentsRad = [[355.8,1191.3],[119.9,262.1],[229.8,64.3],[352.25,2382.6]]
    .map(([angle,rate]) => (angle+rate*century)*RAD);
  const series = (coefficients,trig) => coefficients.reduce((sum,term,i) => sum+term*trig(argumentsRad[i]),0);
  if (worldId==='ganymede') {
    const ra=268.20-.009*century+series([-.037,.431,.091],Math.sin);
    const dec=64.57+.003*century+series([-.016,.186,.039],Math.cos);
    const spin=44.064+50.3176081*days+series([.033,-.389,-.082],Math.sin);
    return orbitalAxes(ra*RAD,dec*RAD,spin*RAD);
  }
  const ra = 268.08-.009*century+series([1.086,.060,.015,.009],Math.sin);
  const dec = 64.51+.003*century+series([.468,.026,.007,.002],Math.cos);
  const spin = 36.022+101.3747235*days+series([-.980,-.054,-.014,-.008],Math.sin);
  return orbitalAxes(ra*RAD,dec*RAD,spin*RAD);
}

function moonFromSaturn(worldId,time) {
  // Use the synchronous IAU mean meridian, plus optical libration (ν−M).
  const {semimajor,eccentricity,anomaly,period,pole}=saturnianOrbits[worldId];
  const mean = positiveAngle(((anomaly+time.tt*360/period)%360)*RAD);
  let eccentric = mean;
  for (let i=0;i<5;i++) eccentric -= (eccentric-eccentricity*Math.sin(eccentric)-mean)/(1-eccentricity*Math.cos(eccentric));
  const trueAnomaly = Math.atan2(Math.sqrt(1-eccentricity**2)*Math.sin(eccentric),Math.cos(eccentric)-eccentricity);
  const opticalLibration = trueAnomaly-mean;
  const distance = semimajor*(1-eccentricity*Math.cos(eccentric));
  const orbitPole = orbitalAxes(pole[0]*RAD,pole[1]*RAD,0)[2];
  const oppositeMeridian = scale(surfaceAxes(worldId,time)[0],-1);
  const outward = unit(subtract(oppositeMeridian,scale(orbitPole,dot(orbitPole,oppositeMeridian))));
  return add(scale(outward,distance*Math.cos(opticalLibration)),
    scale(cross(orbitPole,outward),distance*Math.sin(opticalLibration)));
}

function bodyPosition(body,time) {
  return scale(vector(BaryState(body,time)),KM_PER_AU);
}

function jovianPosition(id,time) {
  return add(bodyPosition(Body.Jupiter,time),scale(vector(JupiterMoons(time)[id]),KM_PER_AU));
}

function worldPosition(worldId,time) {
  const world = worlds[worldId];
  if (world.body) return bodyPosition(world.body,time);
  if (world.parent===Body.Jupiter) return jovianPosition(worldId,time);
  return add(bodyPosition(Body.Saturn,time),moonFromSaturn(worldId,time));
}

function resolveSite(worldId,observer) {
  const candidates = SURFACE_SKY_SITES[worldId];
  if (typeof observer==='string') return candidates.find(candidate => candidate.id===observer)||candidates[0];
  if (!observer || !Number.isFinite(observer.latitude) || Math.abs(observer.latitude)>90 ||
      !Number.isFinite(observer.longitude)) return candidates[0];
  const elevation = observer.elevationKm;
  const elevationKm = Number.isFinite(elevation) && elevation>-worlds[worldId].radius ? elevation : 0;
  const longitude = ((observer.longitude%360+540)%360)-180;
  return site(observer.id||'custom',observer.name||'Site personnalisé',observer.latitude,longitude,elevationKm);
}

function localBasis(axes,observer) {
  const latitude = observer.latitude*RAD, longitude = observer.longitude*RAD;
  const equator = add(scale(axes[0],Math.cos(longitude)),scale(axes[1],Math.sin(longitude)));
  const east = add(scale(axes[0],-Math.sin(longitude)),scale(axes[1],Math.cos(longitude)));
  const up = add(scale(equator,Math.cos(latitude)),scale(axes[2],Math.sin(latitude)));
  const north = cross(up,east);
  return [east,up,north];
}

function skyAngles(direction) {
  return {
    azimuth:positiveAngle(Math.atan2(direction[0],direction[2])),
    altitude:Math.atan2(direction[1],Math.hypot(direction[0],direction[2]))
  };
}

function observe(target,observer,time,toLocal) {
  const positionAt = target.body ? t => bodyPosition(target.body,t) : t => jovianPosition(target.id,t);
  let emission = time, position = positionAt(emission);
  // First iterate the light travel time, then recompute it once at the estimated emission.
  for (let i=0;i<2;i++) {
    emission = new AstroTime(time.ut-magnitude(subtract(position,observer))/LIGHT_KM_PER_DAY);
    position = positionAt(emission);
  }
  const relative = subtract(position,observer);
  const distanceKm = magnitude(relative);
  const direction = toLocal(unit(relative));
  const {azimuth,altitude} = skyAngles(direction);
  const angularDiameter = 2*Math.asin(target.radius/distanceKm);
  const towardObserver = unit(scale(relative,-1));
  const towardSun = target.id==='sun' ? towardObserver : unit(subtract(bodyPosition(Body.Sun,emission),position));
  const phaseAngle = Math.acos(clampUnit(dot(towardObserver,towardSun)));
  const lightDirection = toLocal(towardSun);
  const lighting = skyAngles(lightDirection);
  const axes = target.body ? bodyAxes(target.body,emission)
    : Object.hasOwn(worlds,target.id) ? surfaceAxes(target.id,emission) : null;
  const viewInBody = axes?.map(axis => dot(axis,towardObserver));
  return {
    id:target.id, name:target.name, azimuth, altitude, angularDiameter, distanceKm, direction,
    illuminatedFraction:(1+Math.cos(phaseAngle))/2, phaseAngle, lightDirection,
    lightAzimuth:lighting.azimuth, lightAltitude:lighting.altitude,
    northPole:axes ? toLocal(axes[2]) : null,
    subObserverLatitude:viewInBody ? Math.asin(clampUnit(viewInBody[2])) : 0,
    subObserverLongitude:viewInBody ? Math.atan2(viewInBody[1],viewInBody[0]) : 0,
    lightTimeSeconds:distanceKm/299792.458,
    aboveHorizon:altitude+angularDiameter/2>0
  };
}

function discOverlapFraction(a,b,gap) {
  if (gap>=a+b) return 0;
  if (gap<=Math.abs(a-b)) return Math.min(1,(b/a)**2);
  const x = (gap**2+a**2-b**2)/(2*gap);
  const height = Math.sqrt(Math.max(0,a**2-x**2));
  return (a**2*Math.acos(clampUnit(x/a))+b**2*Math.acos(clampUnit((gap-x)/b))-gap*height)/(Math.PI*a*a);
}

function solarOccultation(objects) {
  const [sun] = objects;
  let fraction=0, by=null;
  for (const body of objects.slice(1)) {
    if (body.distanceKm>=sun.distanceKm) continue;
    const gap = Math.acos(clampUnit(dot(sun.direction,body.direction)));
    const covered = discOverlapFraction(sun.angularDiameter/2,body.angularDiameter/2,gap);
    if (covered>fraction) { fraction=covered; by=body; }
  }
  return {coveredFraction:fraction,occultingId:by?.id??null,occultingName:by?.name??null};
}

// Physical positions at a geometric horizon. Angles are radians except for
// the latitude and east-positive longitude of the site, which are degrees.
// equatorialBasis contains east, up and north unit vectors in J2000 coordinates.
export function surfaceEphemeris(worldId,date=new Date(),observer=undefined) {
  if (!Object.hasOwn(worlds,worldId)) return null;
  const instant = date instanceof Date ? new Date(date.valueOf()) : new Date(date);
  if (!Number.isFinite(instant.valueOf())) return null;
  const time = new AstroTime(instant), selectedSite = resolveSite(worldId,observer);
  const equatorialBasis = localBasis(surfaceAxes(worldId,time),selectedSite);
  const eye = add(worldPosition(worldId,time),scale(equatorialBasis[1],worlds[worldId].radius+selectedSite.elevationKm));
  const toLocal = v => equatorialBasis.map(axis => dot(axis,v));
  const targets = starsAndPlanets.filter(target => target.id!==worldId);
  if (worlds[worldId].parent===Body.Jupiter) targets.push(...jovianMoons.filter(target=>target.id!==worldId));
  const objects = targets.map(target => observe(target,eye,time,toLocal));
  return {date:instant,site:selectedSite,objects,equatorialBasis,solarOccultation:solarOccultation(objects),
    quality:Object.hasOwn(saturnianOrbits,worldId)?'mean-elements':'astronomy-engine'};
}
