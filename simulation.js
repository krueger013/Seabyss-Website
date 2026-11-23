import { objects as initialCatalog } from './catalog.js';

const TAU = 2 * Math.PI;
const RAD = Math.PI / 180;
export const TIME_RATES = Object.freeze([1 / 86400, 1 / 1440, 1 / 24, 1, 7, 30]);
export const GRAVITY_SCALES = Object.freeze([.75, 1, 1.25, 1.5, 2]);

const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => { const length = Math.hypot(...a); return a.map(n => n/length); };
const combine = (a,x,b,y) => a.map((n,i) => n*x + b[i]*y);

// All conics are relative to their own moving focus. Time is measured in
// days, positions in kilometres and velocities in kilometres per day.
function initialOrbit(body, parent) {
  const offset = body.position.map((n,i) => n-parent.position[i]);
  const a = Math.hypot(...offset);
  const u = unit(offset);
  const tilt = (body.orbitPlaneTiltDeg || 0) * RAD;
  const referenceNorth = [0, Math.cos(tilt), -Math.sin(tilt)];
  let tangent = cross(u, referenceNorth);
  if (Math.hypot(...tangent) < 1e-8) tangent = cross(u,[1,0,0]);
  tangent = unit(tangent);
  const inclination = (body.orbitInclinationDeg || 0) * RAD;
  const v = combine(tangent, Math.cos(inclination), unit(cross(tangent,u)), Math.sin(inclination));
  const e = body.orbitEccentricity || 0;
  const bRatio = Math.sqrt(1-e*e);
  // At E=π/2 the orbital radius equals the semimajor axis. Orient the
  // ellipse around the catalog's initial radius so old atlas views survive.
  const p = e ? combine(u,-e,v,-bRatio) : u;
  const q = e ? combine(u,bRatio,v,-e) : v;
  const period = body.orbitPeriodDays;
  const mu = (TAU/period)**2 * a**3;
  return { a, e, bRatio, p, q, period, mu, epoch: 0, mean0: e ? Math.PI/2-e : 0, initial: offset };
}

function eccentricAnomaly(orbit, days) {
  const mean = orbit.mean0 + TAU * (((days-orbit.epoch) % orbit.period) / orbit.period);
  if (orbit.e === 0) return mean;
  const m = Math.atan2(Math.sin(mean),Math.cos(mean));
  let anomaly = orbit.e < .8 ? m : Math.sign(m || 1) * Math.PI;
  for (let i=0; i<15; i++) {
    const step = (anomaly - orbit.e*Math.sin(anomaly) - m) / (1 - orbit.e*Math.cos(anomaly));
    anomaly -= step;
    if (Math.abs(step) < 1e-13) break;
  }
  return anomaly;
}

function positionAtAnomaly(orbit, anomaly) {
  return combine(orbit.p, orbit.a*(Math.cos(anomaly)-orbit.e),
    orbit.q, orbit.a*orbit.bRatio*Math.sin(anomaly));
}

function stateAt(orbit, days) {
  const anomaly = eccentricAnomaly(orbit, days);
  const omega = TAU / (orbit.period * (1 - orbit.e*Math.cos(anomaly)));
  const position = days === orbit.epoch ? orbit.initial : positionAtAnomaly(orbit, anomaly);
  const velocity = combine(orbit.p,-orbit.a*Math.sin(anomaly)*omega,
    orbit.q,orbit.a*orbit.bRatio*Math.cos(anomaly)*omega);
  return {position, velocity};
}

// Refit an osculating ellipse after an instantaneous central-mass change.
// Specific energy sets the new semimajor axis and the eccentricity vector
// points at the new periapsis. Both r and v are preserved at the change.
function refit(orbit, days, massRatio, safeRadius) {
  const {position:r, velocity:v} = stateAt(orbit,days);
  const radius = Math.hypot(...r), mu = orbit.mu*massRatio;
  const vv = dot(v,v), rv = dot(r,v);
  const energy = vv/2-mu/radius;
  if (energy >= 0) return null;
  const a = -mu/(2*energy);
  const eccentricity = combine(r,(vv-mu/radius)/mu,v,-rv/mu);
  const e = Math.hypot(...eccentricity);
  if (!(e < .999999) || a*(1-e) <= safeRadius) return null;
  const p = e > 1e-12 ? unit(eccentricity) : unit(r);
  const q = unit(cross(unit(cross(r,v)),p));
  const bRatio = Math.sqrt(1-e*e);
  const anomaly = Math.atan2(dot(r,q)/(a*bRatio),dot(r,p)/a+e);
  return {a,e,bRatio,p,q,mu,period:TAU*Math.sqrt(a**3/mu),epoch:days,
    mean0:anomaly-e*Math.sin(anomaly),initial:r.slice()};
}

export class OrbitalSimulation {
  constructor(catalog = initialCatalog) {
    this.objects = catalog.map(body => ({...body, position: body.position.slice(),
      rotationPeriodHours: body.rotationPeriodHours ?? 0, axialTiltDeg: body.axialTiltDeg ?? 0, spinAngle: 0}));
    this.byId = new Map(this.objects.map(body => [body.id,body]));
    this.reference = new Map(catalog.map(body => [body.id,body]));
    this.ordered = [];
    const seen = new Set();
    const append = body => {
      if (seen.has(body.id)) return;
      seen.add(body.id);
      const parent = this.byId.get(body.parentId);
      if (parent) append(parent);
      if (parent && body.orbitPeriodDays > 0) {
        this.ordered.push({body,parent,baseline:initialOrbit(body,parent)});
      }
      if (body.lightPosition && parent) body.lightPosition = parent.kind === 'star' ? parent.position : parent.lightPosition;
    };
    this.objects.forEach(append);
    this.entries = new Map(this.ordered.map(entry => [entry.body.id,entry]));
    this.gravity = new Map();
    this.revision = 0;
    this.rate = TIME_RATES[2];
    this.paused = false;
    this.reset();
  }

  setRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0 || rate > TIME_RATES.at(-1)) return false;
    this.rate = rate;
    return true;
  }
  setPaused(paused) { this.paused = Boolean(paused); }

  update(elapsedSeconds) {
    if (this.paused || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;
    this.setDays(this.days + elapsedSeconds*this.rate);
  }

  setDays(days) {
    if (!Number.isFinite(days) || Math.abs(days) > 1e12) return false;
    this.days = days;
    for (const {body,parent,orbit} of this.ordered) {
      // Preserve the exact double precision starting snapshot at its epoch.
      if (days === 0 && !this.gravity.size) {
        const initial = this.reference.get(body.id).position;
        for (let i=0;i<3;i++) body.position[i] = initial[i];
      } else {
        const offset = days === orbit.epoch ? orbit.initial : positionAtAnomaly(orbit,eccentricAnomaly(orbit,days));
        for (let i=0;i<3;i++) body.position[i] = parent.position[i]+offset[i];
      }
    }
    for (const body of this.objects) {
      const period = body.rotationPeriodHours/24;
      body.spinAngle = period ? TAU*((days%period)/period) : 0;
    }
    return true;
  }

  reset() {
    this.gravity.clear();
    this.gravityError = '';
    for (const entry of this.ordered) this.assignOrbit(entry, entry.baseline);
    this.revision++;
    this.setDays(0);
  }

  assignOrbit(entry, orbit) {
    entry.orbit = orbit;
    entry.body.orbitRadiusKm = orbit.a;
    entry.body.orbitPeriodDays = orbit.period;
    entry.body.orbitEccentricity = orbit.e;
    entry.body.orbitNormal = unit(cross(orbit.q,orbit.p));
  }

  getGravityScale(centerId) { return this.gravity.get(centerId) ?? 1; }

  setGravityScale(centerId, scale) {
    this.gravityError = '';
    const children = this.ordered.filter(entry => entry.parent.id === centerId);
    if (!children.length || !GRAVITY_SCALES.includes(scale)) {
      this.gravityError = 'Choisis un système et une masse disponible.';
      return false;
    }
    const current = this.getGravityScale(centerId);
    if (scale === current) return true;
    const changes = children.map(({orbit,parent,body}) => refit(orbit,this.days,scale/current,parent.radius+body.radius));
    if (changes.some(orbit => !orbit)) {
      this.gravityError = 'Cette masse produirait une évasion ou un impact. Choisis une valeur intermédiaire.';
      return false;
    }
    changes.forEach((orbit,i) => this.assignOrbit(children[i],orbit));
    this.gravity.set(centerId,scale);
    this.revision++;
    return true;
  }

  orbitPath(idOrBody, segments = 96, relative = false) {
    const entry = this.entries.get(typeof idOrBody === 'string' ? idOrBody : idOrBody?.id);
    if (!entry) return [];
    const count = Number.isFinite(segments) ? Math.max(8,Math.min(1024,Math.round(segments))) : 96;
    const points = [];
    for (let i=0; i<count; i++) {
      const offset = positionAtAnomaly(entry.orbit, TAU*i/count);
      points.push(relative ? offset : offset.map((n,axis) => n+entry.parent.position[axis]));
    }
    points.push(points[0].slice());
    return points;
  }

  relativeState(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const {position,velocity} = stateAt(entry.orbit,this.days);
    return {position:position.slice(), velocity, mu:entry.orbit.mu};
  }
}
