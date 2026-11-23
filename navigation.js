import { LIGHT_YEAR, objects } from './catalog.js';

const DEG = Math.PI / 180;
const DEFAULT_FOV = 54 * DEG;
const reference = new Map(objects.map(object => [object.id, object]));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const delta = (a, b) => a.map((n, i) => n - b[i]);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const pitchLimit = Math.PI / 2 - 0.001;
const safeRadius = body => body.radius * 1.002;
export const isDiffuse = body => body.kind === 'galaxy' || body.kind === 'nebula' || body.kind === 'cluster';

function unit(vector) {
  const length = Math.hypot(...vector);
  return length ? vector.map(n => n / length) : [0, 0, 1];
}

function framingDistance(body) {
  // Leave space for the rings and stellar corona.
  if (isDiffuse(body)) return body.radius * 2.9;
  return body.radius * (body.id === 'saturn' ? 6.4 : body.kind === 'star' ? 4.8 : 4);
}

function arrivalDirection(body, sun) {
  if (body.id === 'earth' || body.kind === 'star' || isDiffuse(body)) return [0, 0, 1];
  const [x, y, z] = unit(delta(body.lightPosition || sun.position, body.position));
  const horizontal = Math.hypot(x, z) || 1;
  // Offset the camera to the side and below the sunlight direction: this
  // reveals surface relief and gives Saturn's rings an open viewing angle.
  return unit([0.72 * x + 0.65 * z / horizontal, 0.72 * y - 0.38, 0.72 * z - 0.65 * x / horizontal]);
}

function frameView(body, sun) {
  const direction = arrivalDirection(body, sun);
  const offset = framingDistance(body);
  const position = body.position.map((n, i) => n + offset * direction[i]);
  // Near a small planet a thousand light-years away, rounding the world
  // position can move it a kilometre. Aim from the position actually stored.
  const [dx, dy, dz] = delta(body.position, position);
  return {
    position,
    yaw: Math.atan2(dx, -dz),
    pitch: Math.atan2(dy, Math.hypot(dx, dz)),
    fov: DEFAULT_FOV
  };
}

function localScale(position, objects) {
  let scale = Infinity;
  for (const body of objects) {
    const d = distance(position, body.position);
    // A galaxy is transparent. Its vast disk must never slow a nearby planet
    // approach or stop the camera when crossing a galactic boundary.
    const local = isDiffuse(body) ? Math.max(body.radius * 0.15, d)
      : Math.max(body.radius * 0.004, d - body.radius);
    scale = Math.min(scale, local);
  }
  return scale;
}

function nearestSolid(position, solids) {
  let closest = solids[0], leastGap = Infinity;
  for (const body of solids) {
    const gap = distance(position, body.position) - body.radius;
    if (gap < leastGap) {
      leastGap = gap;
      closest = body;
    }
  }
  return closest;
}

// Clip the entire movement segment. This also catches a fast flight that would
// pass through a planet and finish outside it in a single simulation step.
function safeStep(position, direction, wanted, solids) {
  let step = wanted;
  for (const body of solids) {
    const rel = delta(body.position, position);
    const along = rel.reduce((sum, n, i) => sum + n * direction[i], 0);
    if (along <= 0 || along - body.radius * 1.003 > step) continue;
    const radius = safeRadius(body);
    const lateral = Math.hypot(...rel.map((n, i) => n - along * direction[i]));
    if (lateral >= radius) continue;
    const entry = along - Math.sqrt((radius - lateral) * (radius + lateral));
    step = Math.min(step, Math.max(0, entry - radius * 1e-9));
  }
  return step;
}

function easeFromEnd(phase, length, scale) {
  const ratio = length / Math.max(1, scale);
  return ratio > 0.001 ? Math.expm1(Math.log1p(ratio) * phase) / ratio : phase;
}

// A moving destination can carry a guided trajectory through its own star.
// Clip the whole chord and advance around the first obstructing sphere. A
// tangent from each endpoint sets the maximum angle of a safe detour step.
function guidedStep(start, end, solids) {
  const dx = end[0]-start[0], dy = end[1]-start[1], dz = end[2]-start[2];
  const length = Math.hypot(dx,dy,dz);
  if (!length) return end;
  const ux = dx/length, uy = dy/length, uz = dz/length;
  const minX = Math.min(start[0],end[0]), maxX = Math.max(start[0],end[0]);
  const minY = Math.min(start[1],end[1]), maxY = Math.max(start[1],end[1]);
  const minZ = Math.min(start[2],end[2]), maxZ = Math.max(start[2],end[2]);
  let obstacle, first = Infinity;
  for (const body of solids) {
    const [x,y,z] = body.position, r = safeRadius(body);
    if (x+r < minX || x-r > maxX || y+r < minY || y-r > maxY || z+r < minZ || z-r > maxZ) continue;
    const ax = start[0]-x, ay = start[1]-y, az = start[2]-z;
    const bx = end[0]-x, by = end[1]-y, bz = end[2]-z;
    const before = ax*ux + ay*uy + az*uz, after = bx*ux + by*uy + bz*uz;
    if (before >= 0 && bx*bx+by*by+bz*bz >= r*r) continue; // Already moving away.
    if (after <= 0 && bx*bx+by*by+bz*bz >= r*r) continue; // Stops before the surface.
    // Calculate perpendicular separation from the *nearer* endpoint. This
    // retains kilometre detail on the last leg of a multi-galaxy transfer.
    const useStart = Math.abs(before) < Math.abs(after);
    const along = useStart ? before : after;
    const px = (useStart ? ax : bx)-along*ux, py = (useStart ? ay : by)-along*uy, pz = (useStart ? az : bz)-along*uz;
    const gap = r*r-px*px-py*py-pz*pz;
    if (gap <= 0) continue;
    const entry = Math.max(0,-before-Math.sqrt(gap));
    if (entry < first) { first = entry; obstacle = body; }
  }
  if (!obstacle) return end;
  const from = delta(start,obstacle.position), to = delta(end,obstacle.position);
  const fromRadius = Math.hypot(...from), toRadius = Math.hypot(...to);
  const a = unit(from), b = toRadius ? unit(to) : a;
  const r = safeRadius(obstacle);
  const outer = clamp(toRadius, r*1.3, r*2.4);
  const clearance = Math.min(r,fromRadius*.9999);
  const maxAngle = Math.acos(clamp(clearance / Math.max(1,fromRadius),0,1)) + Math.acos(clearance / outer);
  const cosine = clamp(a[0]*b[0]+a[1]*b[1]+a[2]*b[2],-1,1);
  const angle = Math.min(Math.acos(cosine), maxAngle*.985);
  let tangent = b.map((n,i) => n-cosine*a[i]);
  if (Math.hypot(...tangent) < 1e-8) {
    tangent = Math.abs(a[1]) < .9 ? [-a[2],0,a[0]] : [0,a[2],-a[1]];
  }
  const axis = unit(tangent), ca = Math.cos(angle), sa = Math.sin(angle);
  return obstacle.position.map((n,i) => n+outer*(ca*a[i]+sa*axis[i]));
}

export class Navigation {
  constructor(catalog = objects) {
    this.catalog = catalog;
    this.byId = new Map(catalog.map(body => [body.id,body]));
    this.solids = catalog.filter(body => !isDiffuse(body));
    this.sun = this.byId.get('sun');
    this.selectedId = 'earth';
    this.speedStep = 0;
    this.view = frameView(this.selected, this.sun);
    this.lastTargetPosition = this.selected.position.slice();
    this.route = null;
    this.pointRoute = null;
    // World-space heading and thrust, expressed in multiples of the local
    // cruise speed. Looking around does not rotate existing momentum.
    this.impulse = [0, 0, 0];
    this.actualSpeed = 0;
    this.braking = false;
  }

  get selected() { return this.byId.get(this.selectedId); }
  get distance() { return distance(this.view.position, this.selected.position); }
  get travelling() { return this.route !== null || this.pointRoute !== null; }
  get transitIntensity() {
    if (!this.route) return 0;
    const { elapsed, duration, length } = this.route;
    const span = Math.log1p(length / LIGHT_YEAR) / Math.log(101);
    return Math.sin(Math.PI * elapsed / duration) ** 2 * Math.min(1, span);
  }
  get speed() { return Math.min(1e8 * LIGHT_YEAR, localScale(this.view.position,this.catalog) * 0.42 * 2 ** this.speedStep); }

  frame(id = this.selectedId) {
    const target = this.byId.get(id);
    if (!target) return false;
    this.selectedId = id;
    this.lastTargetPosition = target.position.slice();
    Object.assign(this.view, frameView(target, this.sun));
    this.cancelTravel();
    this.halt();
    return true;
  }

  goTo(id, instant = false) {
    const target = this.byId.get(id);
    if (!target) return false;
    this.cancelTravel();
    this.halt();
    const start = this.view.position.slice(), end = frameView(target, this.sun).position;
    const length = distance(start, end);
    if (instant || length < target.radius * 0.0001) return this.frame(id);
    const startScale = localScale(start, this.catalog);
    const departureBody = nearestSolid(start,this.solids);
    const startOffset = delta(start,departureBody.position);
    const departure = unit(startOffset);
    this.selectedId = id;
    this.lastTargetPosition = target.position.slice();
    this.route = { start, end, length, departure, approachDirection: arrivalDirection(target,this.sun), startScale, endScale: framingDistance(target),
      departureBody: Math.hypot(...startOffset) < 32*departureBody.radius ? departureBody : null, startOffset,
      yaw: this.view.yaw, targetYaw: this.view.yaw, pitch: this.view.pitch, fov: this.view.fov, elapsed: 0,
      duration: clamp(1.45 + 0.16 * Math.log10(1 + length / Math.min(startScale, target.radius)), 1.45, 4.6) };
    return true;
  }

  cancelTravel() { this.route = null; this.pointRoute = null; }

  bodyAlong(direction,tolerance=0) {
    const ray=unit(direction);
    let closest=null, entry=Infinity;
    for (const body of this.catalog) {
      const rel=delta(body.position,this.view.position);
      const along=rel.reduce((sum,coordinate,axis)=>sum+coordinate*ray[axis],0);
      if (along<=0 || (isDiffuse(body) && Math.hypot(...rel)<body.radius*1.3)) continue;
      const radius=body.radius+Math.min(body.radius*.9,along*tolerance);
      const lateral=Math.hypot(...rel.map((coordinate,axis)=>coordinate-along*ray[axis]));
      if (lateral>radius) continue;
      const contact=along-Math.sqrt((radius-lateral)*(radius+lateral));
      if (contact<entry) {closest=body;entry=contact;}
    }
    return closest;
  }

  advanceToward(direction,instant=false) {
    if (!direction.every(Number.isFinite) || Math.hypot(...direction)<1e-8) return false;
    this.cancelTravel();
    this.halt();
    const ray=unit(direction);
    const amount=safeStep(this.view.position,ray,localScale(this.view.position,this.catalog)*.64,this.solids);
    if (!amount) return false;
    this.pointRoute={ray,amount,elapsed:0,progress:0,yaw:this.view.yaw,pitch:this.view.pitch};
    if (instant) this.updatePointRoute(1);
    return true;
  }

  updatePointRoute(dt) {
    const route=this.pointRoute;
    route.elapsed+=dt;
    const phase=clamp(route.elapsed/.85,0,1);
    const progress=phase*phase*(3-2*phase);
    const amount=safeStep(this.view.position,route.ray,(progress-route.progress)*route.amount,this.solids);
    for(let axis=0;axis<3;axis++) this.view.position[axis]+=route.ray[axis]*amount;
    const [x,y,z]=route.ray;
    this.view.yaw=wrap(route.yaw+progress*wrap(Math.atan2(x,-z)-route.yaw));
    this.view.pitch=clamp(route.pitch+progress*(Math.asin(clamp(y,-1,1))-route.pitch),-pitchLimit,pitchLimit);
    route.progress=progress;
    if (phase===1) this.pointRoute=null;
  }

  syncSimulation(followSelected = true) {
    const target = this.selected;
    if (this.route) {
      const route = this.route;
      if (route.departureBody) {
        route.start = route.departureBody.position.map((n,i) => n+route.startOffset[i]);
      }
      route.end = frameView(target,this.sun).position;
      route.approachDirection = arrivalDirection(target,this.sun);
      route.length = distance(route.start,route.end);
    } else if (followSelected || (!isDiffuse(target) && distance(this.view.position,this.lastTargetPosition) < 32*target.radius)) {
      // Close free flight shares the planet's orbital velocity; thrusters
      // still move independently around it, even at thirty days per second.
      for (let i=0;i<3;i++) this.view.position[i] += target.position[i]-this.lastTargetPosition[i];
    }
    for (let i=0;i<3;i++) this.lastTargetPosition[i] = target.position[i];
  }

  halt() {
    this.impulse.fill(0);
    this.actualSpeed = 0;
    this.braking = false;
  }

  brake() { this.braking = true; }

  updateRoute(dt) {
    const route = this.route;
    route.elapsed += dt;
    if (route.elapsed >= route.duration) {
      const final = guidedStep(this.view.position,route.end,this.solids);
      if (final === route.end) this.frame();
      else {
        this.view.position = final;
        const [dx,dy,dz] = delta(this.selected.position,final);
        this.view.yaw = Math.atan2(dx,-dz);
        this.view.pitch = Math.atan2(dy,Math.hypot(dx,dz));
      }
      return;
    }
    const ratio = route.elapsed / route.duration;
    const phase = ratio * ratio * (3 - 2 * ratio);
    let t, u;
    // Keep the two interpolation weights separately. Subtracting a tiny
    // remaining fraction from one would lose the last kilometres on a return
    // to Earth from a galaxy several million light-years away.
    if (phase < 0.5) {
      t = 0.5 * easeFromEnd(phase * 2, route.length, route.startScale);
      u = 1 - t;
    } else {
      u = 0.5 * easeFromEnd(2 * (1 - phase), route.length, route.endScale);
      t = 1 - u;
    }
    const a = u * u * (u + 3 * t), b = t * t * (t + 3 * u);
    const leave = route.length * 0.7 * u * u * t;
    const approach = route.length * 0.7 * u * t * t;
    const desired = route.start.map((n, i) => n * a + route.end[i] * b
      + route.departure[i] * leave + route.approachDirection[i] * approach);
    this.view.position = guidedStep(this.view.position,desired,this.solids);
    const [dx, dy, dz] = delta(this.selected.position, this.view.position);
    const align = Math.min(1, ratio / 0.32);
    const turn = align * align * (3 - 2 * align);
    // Follow the continuous bearing if a moving target crosses directly
    // behind the departure heading during the opening turn.
    route.targetYaw += wrap(Math.atan2(dx, -dz) - route.targetYaw);
    this.view.yaw = wrap(route.yaw + turn * (route.targetYaw - route.yaw));
    this.view.pitch = route.pitch + turn * (Math.atan2(dy, Math.hypot(dx, dz)) - route.pitch);
    this.view.fov = route.fov + (DEFAULT_FOV - route.fov) * phase;
  }

  update(dt, input = {}) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const axis = n => Number.isFinite(n) ? clamp(n, -1, 1) : 0;
    const forward = axis(input.forward), right = axis(input.right), up = axis(input.up);
    const magnitude = Math.hypot(forward, right, up);
    if (this.pointRoute && !magnitude && !input.brake) {
      this.updatePointRoute(Math.min(dt,.25));
      return;
    }
    if (this.route && !magnitude && !input.brake) {
      this.updateRoute(Math.min(dt, .25));
      return;
    }
    if (magnitude || input.brake) this.cancelTravel();
    if (input.brake) this.brake();
    else if (magnitude) this.braking = false;
    if (!magnitude && !this.actualSpeed) return;
    const { yaw, pitch } = this.view;
    const sinY = Math.sin(yaw), cosY = Math.cos(yaw), sinP = Math.sin(pitch), cosP = Math.cos(pitch);
    const thrust = [
      forward * sinY * cosP + right * cosY - up * sinY * sinP,
      forward * sinP + up * cosP,
      -forward * cosY * cosP + right * sinY + up * cosY * sinP
    ];
    const thrustScale = this.braking ? 0 : (input.boost ? 5 : 1) / Math.max(1, magnitude);
    for (let i = 0; i < 3; i++) thrust[i] *= thrustScale;
    // Integrate the first-order thruster exactly over each short interval.
    // Recompute physical speed at substeps as a planet approaches the camera.
    const elapsed = Math.min(dt, .25), steps = Math.ceil(elapsed * 120);
    const stepTime = elapsed / steps;
    const tau = this.braking ? .055 : magnitude ? .26 : .32;
    const blend = -Math.expm1(-stepTime / tau);
    const travel = [0, 0, 0];
    for (let i = 0; i < steps; i++) {
      const cruise = this.speed;
      for (let axis = 0; axis < 3; axis++) {
        const gap = this.impulse[axis] - thrust[axis];
        travel[axis] = cruise * (thrust[axis] * stepTime + gap * tau * blend);
        this.impulse[axis] -= gap * blend;
      }
      const wanted = Math.hypot(...travel);
      if (!wanted) continue;
      const direction = travel.map(component => component / wanted);
      const allowed = safeStep(this.view.position, direction, wanted, this.solids);
      for (let axis = 0; axis < 3; axis++) this.view.position[axis] += direction[axis] * allowed;
      const throttle = Math.hypot(...this.impulse);
      if (allowed < wanted || ((!magnitude || this.braking) && throttle < .001)) {
        this.halt();
        break;
      }
      this.actualSpeed = cruise * throttle;
    }
  }

  look(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return;
    this.cancelTravel();
    this.view.yaw = wrap(this.view.yaw + dx);
    this.view.pitch = clamp(this.view.pitch + dy, -pitchLimit, pitchLimit);
  }

  orbit(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.cancelTravel();
    this.halt();
    const pose = this.orbitPose();
    this.setOrbitPose(pose, dx, dy);
  }

  // Capture once for a camera orbit. Accumulating angles from rounded world
  // positions would progressively distort the framing at interstellar scales.
  orbitPose() {
    const offset = delta(this.view.position, this.selected.position);
    return {id:this.selectedId, radius:Math.max(1,Math.hypot(...offset)),
      yaw:Math.atan2(-offset[0],offset[2]), pitch:Math.atan2(-offset[1],Math.hypot(offset[0],offset[2]))};
  }

  setOrbitPose(pose, dx, dy=0) {
    if (pose.id !== this.selectedId) return;
    const yaw = wrap(pose.yaw + dx);
    const pitch = clamp(pose.pitch + dy, -pitchLimit, pitchLimit);
    const outward = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    this.view.position = this.selected.position.map((n, i) => n + pose.radius * outward[i]);
    this.view.yaw = yaw;
    this.view.pitch = pitch;
  }

  changeSpeed(steps) {
    if (Number.isFinite(steps)) this.speedStep = clamp(this.speedStep + Math.round(steps), -6, 8);
  }

  approach(steps) {
    if (!Number.isFinite(steps) || !steps) return;
    this.cancelTravel();
    this.halt();
    const offset = delta(this.view.position, this.selected.position);
    const outward = unit(offset);
    const current = Math.hypot(...offset);
    const closest = this.selected.radius * (isDiffuse(this.selected) ? .005 : 1.003);
    const desired = clamp(current * Math.exp(-.2 * clamp(steps, -40, 40)), closest, 1e25);
    const direction = desired < current ? outward.map(n => -n) : outward;
    const step = safeStep(this.view.position, direction, Math.abs(desired - current), this.solids);
    for (let axis = 0; axis < 3; axis++) this.view.position[axis] += direction[axis] * step;
    this.view.yaw = Math.atan2(-outward[0], outward[2]);
    this.view.pitch = -Math.asin(clamp(outward[1], -1, 1));
  }

  zoom(steps) {
    if (Number.isFinite(steps)) {
      this.cancelTravel();
      this.view.fov = clamp(this.view.fov * 0.88 ** steps, 20 * DEG, 85 * DEG);
    }
  }

  resetZoom() { this.view.fov = DEFAULT_FOV; }

  serialize() {
    const { position, yaw, pitch, fov } = this.view;
    const common = { selectedId: this.selectedId, position: position.slice(), yaw, pitch, fov, speedStep: this.speedStep };
    if (this.catalog === objects) return {version:1, ...common};
    const near = nearestSolid(position,this.solids);
    const anchor = this.distance < 512*this.selected.radius ? this.selected
      : distance(position,near.position) < 512*near.radius ? near : null;
    return {version:2, ...common, anchorId:anchor?.id ?? null, anchorOffset:anchor ? delta(position,anchor.position) : null};
  }

  restore(data) {
    if (!data || ![1,2].includes(data.version) || !this.byId.has(data.selectedId) || !Array.isArray(data.position)
      || data.position.length !== 3 || !data.position.every(n => Number.isFinite(n) && Math.abs(n) < 1e28)
      || ![data.yaw, data.pitch, data.fov, data.speedStep].every(Number.isFinite)) return false;
    let position = data.position.slice();
    if (data.version === 2) {
      const anchor = this.byId.get(data.anchorId);
      if (!anchor && (data.anchorId !== null || data.anchorOffset !== null)) return false;
      if (anchor) {
        if (!Array.isArray(data.anchorOffset) || data.anchorOffset.length !== 3
          || !data.anchorOffset.every(n => Number.isFinite(n) && Math.abs(n) < 1e28)) return false;
        position = anchor.position.map((n,i) => n+data.anchorOffset[i]);
      }
    } else if (this.catalog !== objects) {
      const oldTarget = reference.get(data.selectedId), target = this.byId.get(data.selectedId);
      if (oldTarget && distance(position,oldTarget.position) < 512*oldTarget.radius) {
        position = target.position.map((n,i) => n+(position[i]-oldTarget.position[i]));
      }
    }
    if (this.solids.some(body => distance(position, body.position) < body.radius)) return false;
    this.selectedId = data.selectedId;
    this.lastTargetPosition = this.selected.position.slice();
    this.speedStep = clamp(Math.round(data.speedStep), -6, 8);
    Object.assign(this.view, { position, yaw: wrap(data.yaw),
      pitch: clamp(data.pitch, -pitchLimit, pitchLimit), fov: clamp(data.fov, 20 * DEG, 85 * DEG) });
    this.cancelTravel();
    this.halt();
    return true;
  }
}
