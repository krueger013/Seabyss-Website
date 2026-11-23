// G in AU³ / (solar mass × day²), from the measured solar GM.
// https://ssd.jpl.nasa.gov/astro_par.html
export const G = 0.0002959122082855911;
export const MAX_BODIES = 64;
export const COLLISION_MODES = Object.freeze(['merge','fragment','bounce']);
export const BOUNCE_RESTITUTION = .65;
export const TIDAL_TRIGGER_FRACTION = .88;
const MAX_STEPS = 512;
const MAX_EVENTS = 80;
const MAX_FRAGMENTS = 6;
const TIDAL_EJECTA_FRACTION = .54;
const TIDAL_REMNANT_FRACTION = 1-TIDAL_EJECTA_FRACTION;
const MIN_MASS = 1e-20;
const MIN_RADIUS = 1e-12;
const ENERGY_UNIT = 1.98847e30 * (149597870700 / 86400) ** 2;
const kinds = new Set(['star', 'planet', 'moon', 'comet', 'asteroid']);
const editable = new Set(['name','kind','color','mass','radius','position','velocity']);
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const bounded = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const vector = (v, limit) => Array.isArray(v) && v.length === 3 &&
  bounded(v[0],-limit,limit) && bounded(v[1],-limit,limit) && bounded(v[2],-limit,limit);
const pairKey = (a, b) => a < b ? a + '/' + b : b + '/' + a;
const zeros = () => [0, 0, 0];

function validBody(b) {
  return b && typeof b.id === 'string' && idPattern.test(b.id) &&
    typeof b.name === 'string' && b.name.trim().length > 0 && b.name.length <= 80 &&
    kinds.has(b.kind) && typeof b.color==='string' && /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(b.color) &&
    bounded(b.mass, MIN_MASS, 1e12) && bounded(b.radius, MIN_RADIUS, 1e8) &&
    vector(b.position, 1e16) && vector(b.velocity, 1e8);
}

function copyBody(b) {
  return { id:b.id, name:b.name, kind:b.kind, color:b.color, mass:b.mass, radius:b.radius,
    position:b.position.slice(), velocity:b.velocity.slice() };
}

function cloneEvent(e) {
  const copy={...e, position:e.position.slice(), bodyIds:e.bodyIds.slice(), names:e.names.slice()};
  if (e.fragmentIds) copy.fragmentIds=e.fragmentIds.slice();
  if (e.normal) copy.normal=e.normal.slice();
  return copy;
}

function validFragments(e,minCount) {
  return Array.isArray(e.fragmentIds) && e.fragmentIds.length>=minCount &&
    e.fragmentIds.length<=MAX_FRAGMENTS && new Set(e.fragmentIds).size===e.fragmentIds.length &&
    e.fragmentIds.every(id=>typeof id==='string' && idPattern.test(id) && !e.bodyIds.includes(id)) &&
    bounded(e.fragmentMass,1e-20,2e12);
}

function unitNormal(v) {
  return vector(v,1) && Math.abs(Math.hypot(...v)-1)<1e-8;
}

function validEvent(e, day) {
  if (!(e && Number.isSafeInteger(e.id) && e.id > 0 && bounded(e.day, 0, day) &&
    ['collision','encounter','tidal'].includes(e.type) && vector(e.position, 1e16) &&
    Array.isArray(e.bodyIds) && e.bodyIds.length === 2 && e.bodyIds.every(id => typeof id === 'string' && idPattern.test(id)) &&
    Array.isArray(e.names) && e.names.length === 2 && e.names.every(s => typeof s === 'string' && s.length<=80) &&
    bounded(e.distance,0,1e17) && bounded(e.relativeSpeed,0,1e9) && bounded(e.energy,0,Number.MAX_VALUE))) return false;
  if (e.type==='tidal') return e.bodyIds[0]!==e.bodyIds[1] && e.survivorId===e.bodyIds[1] &&
    e.outcome===undefined && e.restitution===undefined && unitNormal(e.normal) && validFragments(e,1) &&
    bounded(e.rocheRadius,1e-12,1e20) && bounded(e.strength,1,1e100) &&
    bounded(e.differentialAcceleration,0,Number.MAX_VALUE) &&
    Math.abs(e.strength/(e.rocheRadius/e.distance)**3-1)<1e-8;
  return e.rocheRadius===undefined && e.strength===undefined && e.differentialAcceleration===undefined &&
    (e.outcome === 'bounce' ?
      e.type === 'collision' && e.survivorId === null && e.restitution === BOUNCE_RESTITUTION &&
        unitNormal(e.normal) :
      e.outcome === undefined && e.restitution === undefined && e.normal === undefined &&
        (e.type === 'collision' ? e.bodyIds.includes(e.survivorId) : e.survivorId === null)) &&
    (e.fragmentIds===undefined ? e.fragmentMass===undefined :
      e.type==='collision' && e.outcome===undefined && validFragments(e,3));
}

const cross = (a,b) => [
  a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]
];

function direction(v) {
  const length=Math.hypot(...v);
  return length>0 ? v.map(x=>x/length) : [1,0,0];
}

export function rocheLimit(primary,secondary) {
  if (!primary || !secondary || primary===secondary || primary.kind==='asteroid' ||
      !['planet','moon','comet'].includes(secondary.kind) ||
      !(secondary.mass>0 && secondary.mass<=.05*primary.mass && secondary.radius>0)) return 0;
  // Fluid, synchronously rotating model. Express the usual density ratio
  // in terms of masses and the radius of the smaller body.
  // https://doi.org/10.1088/2041-8205/773/1/L15
  return 2.44*secondary.radius*Math.cbrt(primary.mass/secondary.mass);
}

function ejectaPlan(a,b,mass,radius,speed,count) {
  // Compare the energy in the centre-of-mass frame to the binding energy
  // of an equivalent uniform sphere. This is a simplified disruption law.
  const share=b.mass/mass;
  const impact=.5*a.mass*share*speed**2;
  const binding=.6*G*mass**2/radius;
  const severity=impact/binding;
  if (count<3 || share<.05 || severity<1.1 ||
      [a.kind,b.kind].some(kind=>kind==='star' || kind==='asteroid')) return null;

  const fraction=Math.min(.52,.12+.16*Math.log2(severity/1.1));
  const fragmentMass=mass*fraction/count;
  const fragmentRadius=radius*Math.cbrt(fraction/count);
  const remnantRadius=radius*Math.cbrt(1-fraction);
  const separation=Math.max(1.22*(remnantRadius+fragmentRadius),1.22*fragmentRadius/Math.sin(Math.PI/count));
  const ejectSpeed=.72*Math.sqrt(2*(impact-binding)/(fragmentMass*count));
  const normal=direction(b.position.map((x,k)=>x-a.position[k]));
  const incoming=b.velocity.map((x,k)=>x-a.velocity[k]);
  const normalSpeed=incoming.reduce((sum,x,k)=>sum+x*normal[k],0);
  const tangent=incoming.map((x,k)=>x-normalSpeed*normal[k]);
  const side=direction(Math.hypot(...tangent)>speed*1e-6 ? tangent :
    cross(normal,Math.abs(normal[1])<.9 ? [0,1,0] : [1,0,0]));
  const up=cross(normal,side);
  // Rotate the ejecta plane towards the incoming trajectory. Opposing
  // directions balance both the displacement and the outflow momentum.
  const tilted=direction(up.map((x,k)=>x*.88+normal[k]*.47));
  const axes=Array.from({length:count},(_,i)=>{
    const angle=2*Math.PI*(i+.18)/count;
    return side.map((x,k)=>x*Math.cos(angle)+tilted[k]*Math.sin(angle));
  });
  return {axes,fragmentMass,fragmentRadius,remnantRadius,separation,ejectSpeed};
}

// Find the first contact during the linear drift of a kick–drift–kick step.
// The quotient form is stable when the first root is close to zero.
function contactTime(a, b, limit, radius=a.radius+b.radius) {
  const ax=b.position[0]-a.position[0], ay=b.position[1]-a.position[1], az=b.position[2]-a.position[2];
  const vx=b.velocity[0]-a.velocity[0], vy=b.velocity[1]-a.velocity[1], vz=b.velocity[2]-a.velocity[2];
  const gap=ax*ax+ay*ay+az*az-radius*radius;
  if (gap<=0) return 0;
  const toward=ax*vx+ay*vy+az*vz;
  if (toward>=0) return Infinity;
  const speed2=vx*vx+vy*vy+vz*vz;
  const discriminant=toward*toward-speed2*gap;
  if (discriminant<0) return Infinity;
  const when=gap/(-toward+Math.sqrt(discriminant));
  return when<=limit ? when : Infinity;
}

export class GravitySandbox {
  constructor(bodies = [], {collisionMode='merge',tidesEnabled=false} = {}) {
    this.bodies = [];
    this.days = 0;
    this.events = [];
    this.nextBody = 1;
    this.nextEvent = 1;
    this.near = new Set();
    this.collisionMode = 'merge';
    if (!this.setCollisionMode(collisionMode)) throw new RangeError('Mode de collision invalide.');
    if (!this.setTidesEnabled(tidesEnabled)) throw new RangeError('Option de marées invalide.');
    if (!Array.isArray(bodies) || bodies.length>MAX_BODIES) throw new RangeError('Configuration gravitationnelle invalide.');
    for (const body of bodies) if (!this.addBody(body)) throw new RangeError('Corps initial invalide.');
  }

  setCollisionMode(mode) {
    if (!COLLISION_MODES.includes(mode)) return false;
    this.collisionMode=mode;
    return true;
  }

  setTidesEnabled(enabled) {
    if (typeof enabled!=='boolean') return false;
    this.tidesEnabled=enabled;
    return true;
  }

  addBody(spec) {
    if (!spec || this.bodies.length>=MAX_BODIES) return null;
    let id=spec.id;
    if (id === undefined) {
      let candidate=this.nextBody;
      while (this.bodies.some(b=>b.id==='body-'+candidate)) candidate++;
      id='body-'+candidate;
    }
    const b={...spec,id};
    if (!validBody(b) || this.bodies.some(other=>other.id===id)) return null;
    const copy=copyBody(b);
    this.bodies.push(copy);
    if (spec.id === undefined) this.nextBody=Number(id.slice(5))+1;
    return copy;
  }

  removeBody(id) {
    const index=this.bodies.findIndex(b=>b.id===id);
    if (index===-1) return false;
    this.bodies.splice(index,1);
    this.clearNearby(id);
    return true;
  }

  clearNearby(id) {
    for (const key of this.near) if (key.startsWith(id+'/') || key.endsWith('/'+id)) this.near.delete(key);
  }

  updateBody(id,patch) {
    const body=this.bodies.find(b=>b.id===id);
    if (!body || !patch || typeof patch!=='object' || Array.isArray(patch) ||
        Object.keys(patch).some(field=>!editable.has(field))) return false;
    const updated={...body,...patch};
    if (!validBody(updated)) return false;
    Object.assign(body,copyBody(updated));
    if (Object.hasOwn(patch,'position') || Object.hasOwn(patch,'radius')) this.clearNearby(id);
    return true;
  }

  setMass(id,mass) { return this.updateBody(id,{mass}); }

  kick(id,deltaVelocity) {
    const body=this.bodies.find(b=>b.id===id);
    if (!body || !vector(deltaVelocity,1e8)) return false;
    const velocity=body.velocity.map((v,i)=>v+deltaVelocity[i]);
    if (!vector(velocity,1e8)) return false;
    body.velocity=velocity;
    return true;
  }

  // Newton's third law is applied to both members of each pair in the same
  // iteration. The tighter of the local gravity and crossing time scales
  // controls the step near a compact moon or a fast flyby.
  forces(chooseStep) {
    const bodies=this.bodies, acceleration=bodies.map(zeros);
    let step=.5;
    for (let i=0;i<bodies.length;i++) for (let j=i+1;j<bodies.length;j++) {
      const a=bodies[i], b=bodies[j];
      const x=b.position[0]-a.position[0], y=b.position[1]-a.position[1], z=b.position[2]-a.position[2];
      const r2=x*x+y*y+z*z;
      if (r2===0) continue;
      const r=Math.sqrt(r2), invCube=G/(r*r2);
      const fa=invCube*b.mass, fb=invCube*a.mass;
      acceleration[i][0]+=fa*x; acceleration[i][1]+=fa*y; acceleration[i][2]+=fa*z;
      acceleration[j][0]-=fb*x; acceleration[j][1]-=fb*y; acceleration[j][2]-=fb*z;
      if (chooseStep) {
        step=Math.min(step, .035*Math.sqrt(r*r2/(G*(a.mass+b.mass))));
        const vx=b.velocity[0]-a.velocity[0], vy=b.velocity[1]-a.velocity[1], vz=b.velocity[2]-a.velocity[2];
        const speed2=vx*vx+vy*vy+vz*vz;
        if (speed2>0) step=Math.min(step, .20*r/Math.sqrt(speed2));
      }
    }
    return {acceleration,step};
  }

  applyAcceleration(acceleration, dt) {
    for (let i=0;i<this.bodies.length;i++) for (let k=0;k<3;k++)
      this.bodies[i].velocity[k]+=acceleration[i][k]*dt;
  }

  record(type, a, b, day, t, separation, survivorId=null, existing=null) {
    const share=b.mass/(a.mass+b.mass), position=[0,0,0], dv=[0,0,0];
    for (let k=0;k<3;k++) {
      dv[k]=b.velocity[k]-a.velocity[k];
      position[k]=a.position[k]+(b.position[k]-a.position[k])*share+(a.velocity[k]+dv[k]*share)*t;
    }
    const speed=Math.hypot(...dv);
    const readings={day,position,distance:separation,energy:.5*(a.mass*share)*speed*speed*ENERGY_UNIT,relativeSpeed:speed};
    if (existing) {
      Object.assign(existing,readings);
      return existing;
    }
    const event={type,id:this.nextEvent++,bodyIds:[a.id,b.id],names:[a.name,b.name],survivorId,...readings};
    this.events.push(event);
    if (this.events.length>MAX_EVENTS) this.events.shift();
    return event;
  }

  encounter(a, b, duration, startDay) {
    const dx=b.position[0]-a.position[0], dy=b.position[1]-a.position[1], dz=b.position[2]-a.position[2];
    const vx=b.velocity[0]-a.velocity[0], vy=b.velocity[1]-a.velocity[1], vz=b.velocity[2]-a.velocity[2];
    // A comet's perihelion can be visually interesting tens of stellar
    // radii from the photosphere. This reporting window never changes force.
    const stellarComet=(a.kind==='comet' && b.kind==='star') || (a.kind==='star' && b.kind==='comet');
    const radii=a.radius+b.radius;
    // The ordinary reporting radius around a giant would announce almost
    // every ring orbit as a flyby. Use a contact-relative scale for debris.
    const debris=a.kind==='asteroid' || b.kind==='asteroid';
    const limit=debris ? 3*radii : Math.max((stellarComet?40:16)*radii,.002,.025*Math.cbrt(a.mass+b.mass));
    const distance2=dx*dx+dy*dy+dz*dz, toward=dx*vx+dy*vy+dz*vz, speed2=vx*vx+vy*vy+vz*vz;
    if (distance2>limit*limit*2.25 && this.near.size) this.near.delete(pairKey(a.id,b.id));
    if (toward>=0 || !speed2) return;
    const closest=Math.min(duration,-toward/speed2);
    const sx=dx+vx*closest, sy=dy+vy*closest, sz=dz+vz*closest;
    const close2=sx*sx+sy*sy+sz*sz;
    if (close2>=limit*limit) return;
    const key=pairKey(a.id,b.id);
    if (this.near.has(key)) {
      // Refine this one passage's closest measured distance until the pair
      // is moving away. It keeps the same event ID for visual effects.
      const known=this.events.findLast(e=>e.type==='encounter' && e.bodyIds[0]===a.id && e.bodyIds[1]===b.id);
      if (known && close2<known.distance*known.distance) {
        this.record('encounter',a,b,startDay+closest,closest,Math.sqrt(close2),null,known);
      }
      return;
    }
    this.near.add(key);
    this.record('encounter',a,b,startDay+closest,closest,Math.sqrt(close2));
  }

  merge(a,b,day,onImpact) {
    const survivor=a.mass>=b.mass ? a : b, other=survivor===a ? b : a;
    const distance=Math.hypot(...a.position.map((n,k)=>n-b.position[k]));
    const event=this.record('collision',survivor,other,day,0,distance,survivor.id);
    const mass=survivor.mass+other.mass, share=other.mass/mass;
    const radius=Math.cbrt(survivor.radius**3+other.radius**3);
    const count=Math.min(MAX_FRAGMENTS,MAX_BODIES-this.bodies.length+1);
    const plan=this.collisionMode==='fragment' ?
      ejectaPlan(survivor,other,mass,radius,event.relativeSpeed,count) : null;
    const radiusShare=survivor.radius/(survivor.radius+other.radius);
    onImpact?.(survivor,other);
    for (let k=0;k<3;k++) {
      const separation=other.position[k]-survivor.position[k];
      event.position[k]=survivor.position[k]+separation*radiusShare;
      survivor.position[k]+=separation*share;
      survivor.velocity[k]+=(other.velocity[k]-survivor.velocity[k])*share;
    }
    survivor.radius=radius;
    survivor.mass=mass;
    this.removeBody(other.id);
    if (plan) this.releaseFragments(survivor,other,plan,event);
    return event;
  }

  releaseFragments(survivor,other,plan,event) {
    const existing=new Set(this.bodies.map(b=>b.id));
    existing.add(other.id);
    const fragments=plan.axes.map((axis,index)=>{
      const stem='fragment-'+event.id+'-'+(index+1);
      let id=stem;
      for(let suffix=1;existing.has(id);suffix++) id=stem+'-'+suffix;
      return {id,name:'Éclat '+(index+1),kind:'asteroid',color:index%2 ? survivor.color : other.color,
        mass:plan.fragmentMass,radius:plan.fragmentRadius,
        position:survivor.position.map((x,k)=>x+axis[k]*plan.separation),
        velocity:survivor.velocity.map((x,k)=>x+axis[k]*plan.ejectSpeed)};
    });
    if (!fragments.every(validBody)) return;
    event.fragmentIds=fragments.map(body=>body.id);
    event.fragmentMass=fragments.length*plan.fragmentMass;
    survivor.mass-=event.fragmentMass;
    survivor.radius=plan.remnantRadius;
    this.bodies.push(...fragments);
  }

  rebound(a,b,day) {
    const offset=b.position.map((value,i)=>value-a.position[i]);
    const velocity=b.velocity.map((value,i)=>value-a.velocity[i]);
    const separation=Math.hypot(...offset);
    const normal=separation>0 ? offset.map(n=>n/separation) : direction(velocity.map(v=>-v));
    const approach=velocity.reduce((sum,value,i)=>sum+value*normal[i],0);
    const combinedMass=a.mass+b.mass, contact=a.radius+b.radius;
    const ratioA=a.mass/combinedMass, ratioB=b.mass/combinedMass;
    // Remove tiny gravity-driven chatter at resting contacts. The floor is
    // tied to the local integration step and remains far below escape speed.
    const threshold=.025*Math.sqrt(G*combinedMass/contact);
    const restitution=approach < -Math.max(1e-12,threshold) ? BOUNCE_RESTITUTION : 0;
    if (restitution) {
      const event=this.record('collision',a,b,day,0,separation);
      event.outcome='bounce';
      event.normal=normal;
      event.restitution=restitution;
      event.position=a.position.map((value,i)=>value+a.radius*normal[i]);
    }
    const impulse=(1+restitution)*Math.min(0,approach);
    // The centre of mass stays fixed. The small clearance keeps the same
    // contact from being rediscovered before the next physical drift.
    const floating=Math.max(...a.position.map(Math.abs),...b.position.map(Math.abs))*Number.EPSILON;
    const correction=Math.max(0,contact+Math.max(contact*1e-7,8*floating)-separation);
    for (let i=0;i<3;i++) {
      a.velocity[i]+=normal[i]*impulse*ratioB;
      b.velocity[i]-=normal[i]*impulse*ratioA;
      a.position[i]-=normal[i]*correction*ratioB;
      b.position[i]+=normal[i]*correction*ratioA;
    }
  }

  disrupt(primary,body,rocheRadius,day,onImpact) {
    const offset=body.position.map((value,i)=>value-primary.position[i]);
    const distance=Math.hypot(...offset), normal=direction(offset);
    const relative=body.velocity.map((value,i)=>value-primary.velocity[i]);
    const radialSpeed=relative.reduce((sum,value,i)=>sum+value*normal[i],0);
    const planeVelocity=relative.map((value,i)=>value-radialSpeed*normal[i]);
    const tangent=direction(Math.hypot(...planeVelocity)>1e-12 ? planeVelocity :
      cross(normal,Math.abs(normal[1])<.9?[0,1,0]:[1,0,0]));
    const side=direction(cross(normal,tangent));
    const count=Math.min(MAX_FRAGMENTS,MAX_BODIES-this.bodies.length,
      Math.floor(body.mass*TIDAL_EJECTA_FRACTION/MIN_MASS),
      Math.floor((body.radius/MIN_RADIUS)**3*TIDAL_EJECTA_FRACTION));
    if (count<1) return false;
    const fragmentMass=body.mass*TIDAL_EJECTA_FRACTION/count, remnantMass=body.mass-fragmentMass*count;
    const radius=body.radius*Math.cbrt(fragmentMass/body.mass);
    const remnantRadius=body.radius*Math.cbrt(remnantMass/body.mass);
    const reach=1.54*(radius+remnantRadius);
    const speed=.83*Math.sqrt(2*G*body.mass/body.radius);
    const existing=new Set(this.bodies.map(candidate=>candidate.id));
    const fragments=Array.from({length:count},(_,index)=>{
      const sign=index%2===0 ? 1 : -1;
      const lane=Math.floor(index/2)-Math.floor((count-1)/2)/2;
      const stem='fragment-'+this.nextEvent+'-'+(index+1);
      let id=stem;
      for(let suffix=1;existing.has(id);suffix++) id=stem+'-'+suffix;
      return {id,name:'Éclat de marée '+(index+1),kind:'asteroid',color:body.color,mass:fragmentMass,radius,
        position:body.position.map((value,i)=>value+normal[i]*reach*sign+tangent[i]*lane*2.4*radius+side[i]*lane*radius*.5),
        velocity:body.velocity.map((value,i)=>value+normal[i]*speed*sign+tangent[i]*speed*(-sign*.36+lane*.13)+side[i]*speed*lane*.08)};
    });
    const recenter=(attribute,index)=>body[attribute][index]-fragments.reduce((sum,piece)=>
      sum+(piece[attribute][index]-body[attribute][index])*fragmentMass/remnantMass,0);
    const remnant={...body,mass:remnantMass,radius:remnantRadius,kind:'asteroid',
      position:[0,1,2].map(i=>recenter('position',i)),velocity:[0,1,2].map(i=>recenter('velocity',i))};
    if (!validBody(remnant) || !fragments.every(validBody)) return false;
    onImpact?.(null,body);
    const event=this.record('tidal',primary,body,day,0,distance,body.id);
    event.position=body.position.slice();
    event.normal=normal;
    event.rocheRadius=rocheRadius;
    event.strength=(rocheRadius/distance)**3;
    // Leading radial differential acceleration across a diameter, in AU/day².
    event.differentialAcceleration=4*G*primary.mass*body.radius/distance**3;
    event.fragmentIds=fragments.map(fragment=>fragment.id);
    event.fragmentMass=fragmentMass*count;
    Object.assign(body,remnant);
    this.clearNearby(body.id);
    this.bodies.push(...fragments);
    return true;
  }

  drift(duration,startDay,onImpact) {
    let moved=0;
    // Each pair may need several constraint corrections when overlapping
    // others. Bound zero-time corrections so a dense cluster progresses.
    const stationaryContacts=this.collisionMode==='bounce' ? new Map() : null;
    const invalidTides=this.tidesEnabled ? new Set() : null;
    for (;;) {
      const remaining=duration-moved;
      let hit=null, tidal=null, segment=remaining, corrected=false;
      const tideCapacity=invalidTides && this.bodies.length<MAX_BODIES;
      for (let i=0;i<this.bodies.length;i++) for (let j=i+1;j<this.bodies.length;j++) {
        const a=this.bodies[i], b=this.bodies[j];
        if (tideCapacity) {
          const primary=a.mass>=b.mass?a:b, secondary=primary===a?b:a;
          if (!invalidTides.has(secondary.id) && secondary.mass*TIDAL_REMNANT_FRACTION>=MIN_MASS &&
              secondary.radius*Math.cbrt(TIDAL_REMNANT_FRACTION)>=MIN_RADIUS) {
            const roche=rocheLimit(primary,secondary), trigger=roche*TIDAL_TRIGGER_FRACTION;
            const surface=a.radius+b.radius;
            if (trigger>surface*1.04) {
              const t=contactTime(a,b,segment,trigger);
              // A pre-existing overlap is a collision, even in a tidal zone.
              if (t<=segment && (t>0 || contactTime(a,b,0)!==0)) {
                hit=null;tidal={primary,secondary,roche};segment=t;
              }
            }
          }
        }
        const t=contactTime(a,b,segment);
        if (t===0 && stationaryContacts && a.kind!=='star' && b.kind!=='star') {
          // Sweep the whole cluster before picking a future contact. Doing a
          // fresh search after every correction can stall the editor when
          // many bodies were placed at the same point.
          const key=pairKey(a.id,b.id), attempted=stationaryContacts.get(key)||0;
          if (attempted<3) {
            stationaryContacts.set(key,attempted+1);
            this.rebound(a,b,startDay+moved);
            corrected=true;
          }
          continue;
        }
        if (t<=segment) {hit=[a,b];tidal=null;segment=t;}
      }
      if (corrected) continue;
      if (segment>0) {
        for (let i=0;i<this.bodies.length;i++) for (let j=i+1;j<this.bodies.length;j++)
          this.encounter(this.bodies[i],this.bodies[j],segment,startDay+moved);
        for (const b of this.bodies) for (let k=0;k<3;k++) b.position[k]+=b.velocity[k]*segment;
        stationaryContacts?.clear();
        moved+=segment;
      }
      if (tidal) {
        const {primary,secondary,roche}=tidal;
        if (!this.disrupt(primary,secondary,roche,startDay+moved,onImpact)) invalidTides.add(secondary.id);
        continue;
      }
      if (!hit) return;
      const [a,b]=hit;
      if (stationaryContacts && a.kind!=='star' && b.kind!=='star') {
        stationaryContacts.set(pairKey(a.id,b.id),1);
        this.rebound(a,b,startDay+moved);
      } else this.merge(a,b,startDay+moved,onImpact);
    }
  }

  integrate(requested,budget,onImpact) {
    let spent=0, steps=0;
    if (requested>0) this.drift(0,this.days,onImpact);
    while (spent<requested && steps<budget) {
      const initial=this.forces(true), dt=Math.min(requested-spent,initial.step);
      if (!(dt>0) || this.days+dt===this.days) break;
      this.applyAcceleration(initial.acceleration,dt*.5);
      this.drift(dt,this.days,onImpact);
      this.applyAcceleration(this.forces(false).acceleration,dt*.5);
      this.days+=dt; spent+=dt; steps++;
    }
    return {spent,steps};
  }

  advance(days) {
    if (!Number.isFinite(days) || days<=0) return 0;
    return this.integrate(days,MAX_STEPS).spent;
  }

  predict(spec,options={}) { return this.forecast(spec,null,options); }
  predictBody(id,options={}) { return this.forecast(null,id,options); }
  forecast(spec,id,options) {
    const duration=options.days ?? 240, count=Math.max(2,Math.min(160,Math.round(options.samples ?? 80)));
    if (!Number.isFinite(duration) || duration<=0 || !Number.isFinite(count)) return [];
    const clone=new GravitySandbox(this.bodies,{collisionMode:this.collisionMode,tidesEnabled:this.tidesEnabled});
    clone.days=this.days; clone.nextBody=this.nextBody;
    const tracked=spec ? clone.addBody(spec) : clone.bodies.find(b=>b.id===id);
    if (!tracked) return [];
    const anchor=options.relativeTo ? clone.bodies.find(b=>b.id===options.relativeTo) : null;
    if (options.relativeTo && !anchor) return [];
    const point=()=>anchor ? tracked.position.map((x,k)=>x-anchor.position[k]) : tracked.position.slice();
    const path=[point()], interval=Math.min(36500,duration)/(count-1);
    const bodyBudget=this.collisionMode==='fragment' || this.tidesEnabled ?
      Math.min(MAX_BODIES,clone.bodies.length+MAX_FRAGMENTS) : clone.bodies.length;
    const pairs=Math.max(1,bodyBudget*(bodyBudget-1)/2);
    let budget=Math.min(4096,Math.floor(160000/pairs));
    let impact=null;
    const onImpact=(survivor,other)=>{
      // Sample the target and its moving reference before either body is
      // replaced. Their end-of-interval positions may be far from contact.
      if (!impact && (tracked===survivor || tracked===other || anchor===other)) impact=point();
    };
    for (let i=1;i<count && budget>0;i++) {
      const result=clone.integrate(interval,budget,onImpact);
      budget-=result.steps;
      if (impact) {path.push(impact);break;}
      if (!result.spent) break;
      path.push(point());
    }
    return path;
  }

  serialize() {
    return {version:1,days:this.days,bodies:this.bodies.map(copyBody),events:this.events.map(cloneEvent),
      nextBody:this.nextBody,nextEvent:this.nextEvent,near:[...this.near],collisionMode:this.collisionMode,tidesEnabled:this.tidesEnabled};
  }

  static restore(state) {
    if (!state || state.version!==1 || !bounded(state.days,0,1e12) ||
        (state.collisionMode!==undefined && !COLLISION_MODES.includes(state.collisionMode)) ||
        (state.tidesEnabled!==undefined && typeof state.tidesEnabled!=='boolean') ||
        !Array.isArray(state.bodies) || state.bodies.length>MAX_BODIES || !state.bodies.every(validBody) ||
        new Set(state.bodies.map(b=>b.id)).size!==state.bodies.length ||
        !Array.isArray(state.events) || state.events.length>MAX_EVENTS || !state.events.every(e=>validEvent(e,state.days+1e-8)) ||
        !Number.isSafeInteger(state.nextEvent) || state.nextEvent<1 || !Number.isSafeInteger(state.nextBody) || state.nextBody<1 ||
        !Array.isArray(state.near) || state.near.length>MAX_BODIES*(MAX_BODIES-1)/2) return null;
    if (state.events.some((e,i)=>e.id>=state.nextEvent || (i>0 && state.events[i-1].id>=e.id))) return null;
    const sim=new GravitySandbox(state.bodies,{collisionMode:state.collisionMode,tidesEnabled:state.tidesEnabled});
    const ids=new Set(sim.bodies.map(b=>b.id));
    for (const key of state.near) {
      if (typeof key!=='string' || key.length>129) return null;
      const parts=key.split('/');
      if (parts.length!==2 || parts[0]>=parts[1] || !parts.every(id=>ids.has(id))) return null;
      sim.near.add(key);
    }
    sim.days=state.days;sim.events=state.events.map(cloneEvent);
    sim.nextBody=state.nextBody;sim.nextEvent=state.nextEvent;
    return sim;
  }
}
