const clamp = (value,min,max) => Math.max(min,Math.min(max,value));

export const LANDING_SITES = Object.freeze({
  moon:Object.freeze({name:'Lune',location:'Mer des Pluies',gravity:1.62,thrust:7.4,drag:.008,altitude:108,x:-15,z:-77,vz:6.3,accent:'#f3cb93'}),
  mars:Object.freeze({name:'Mars',location:'Valles Marineris',gravity:3.71,thrust:11.8,drag:.028,altitude:134,x:18,z:-91,vz:8.1,accent:'#ffa47c'}),
  europa:Object.freeze({name:'Europe',location:'Chaos de Conamara',gravity:1.31,thrust:6.9,drag:.007,altitude:97,x:-12,z:-71,vz:6.4,accent:'#a8e3fb'})
});

const FUEL_CAPACITY=32;
const STEERING_ACCELERATION=4.1;
export const LANDING_LIMITS=Object.freeze({radius:11,verticalSpeed:3,lateralSpeed:2.7});

export function createDescent(id,terrainHeight) {
  const site=Object.hasOwn(LANDING_SITES,id) ? LANDING_SITES[id] : null;
  if (!site) return null;
  const ground=(x,z)=>terrainHeight(id,x,z);
  const target={x:0,z:0,y:ground(0,0)};
  const state={};

  function reset() {
    Object.assign(state,{
      phase:'ready',x:site.x,z:site.z,y:ground(site.x,site.z)+site.altitude,
      vx:0,vy:-5.6,vz:site.vz,fuel:FUEL_CAPACITY,throttle:0,elapsed:0,range:Math.hypot(site.x,site.z),
      altitude:site.altitude,reason:''
    });
  }

  function guide() {
    const range=Math.max(state.range,.001);
    const closeSpeed=Math.min(12,range*.64,Math.sqrt(range*3.2));
    const alignX=-state.x/range, alignZ=-state.z/range;
    const offsetAbove=Math.max(state.altitude,state.y-target.y);
    // Keep a margin while crossing uneven terrain and then taper to a slow touchdown.
    const reserve=clamp((range-6)*.43,0,35);
    const sink=Math.min(13,Math.sqrt(Math.max(.38,offsetAbove-reserve)*2.7));
    const desiredVy=state.altitude<reserve ? 1.3 : -Math.max(.54,sink);
    return {
      thrust:clamp((site.gravity+(desiredVy-state.vy)*1.65)/site.thrust,0,1),
      x:clamp((alignX*closeSpeed-state.vx)*1.15/STEERING_ACCELERATION,-1,1),
      z:clamp((alignZ*closeSpeed-state.vz)*1.15/STEERING_ACCELERATION,-1,1)
    };
  }

  function stepFrame(dt,input) {
    const controls=input.assisted ? guide() : input;
    const power=state.fuel>0 ? clamp(controls.thrust || 0,0,1) : 0;
    const steerX=state.fuel>0 ? clamp(controls.x || 0,-1,1) : 0;
    const steerZ=state.fuel>0 ? clamp(controls.z || 0,-1,1) : 0;
    const normalizer=Math.max(1,Math.hypot(steerX,steerZ));
    const use=power+Math.hypot(steerX,steerZ)*.23;
    const burn=use ? Math.min(1,state.fuel/(use*dt)) : 0;
    state.throttle=power*burn;
    state.fuel=Math.max(0,state.fuel-use*dt*burn);
    state.vx+=(steerX/normalizer*STEERING_ACCELERATION*burn-state.vx*site.drag)*dt;
    state.vz+=(steerZ/normalizer*STEERING_ACCELERATION*burn-state.vz*site.drag)*dt;
    state.vy+=(state.throttle*site.thrust-site.gravity-state.vy*site.drag*.35)*dt;
    state.x+=state.vx*dt;
    state.z+=state.vz*dt;
    state.y+=state.vy*dt;
    state.elapsed+=dt;
    const base=ground(state.x,state.z);
    state.altitude=state.y-base;
    state.range=Math.hypot(state.x,state.z);
    if (state.range>230 || state.altitude>265 || state.elapsed>100) {
      state.phase='crashed';
      state.reason='Corridor dépassé';
    } else if (state.altitude<=0) {
      state.y=base;
      state.altitude=0;
      const soft=Math.abs(state.vy)<=LANDING_LIMITS.verticalSpeed && Math.hypot(state.vx,state.vz)<=LANDING_LIMITS.lateralSpeed;
      const onTarget=state.range<=LANDING_LIMITS.radius;
      state.phase=soft && onTarget ? 'landed' : 'crashed';
      state.reason=!soft ? 'Contact trop rapide' : !onTarget ? 'Hors de la zone de poser' : '';
    }
    if (state.phase!=='flying') state.throttle=0;
  }

  function step(dt,input={}) {
    if (state.phase!=='flying' || !Number.isFinite(dt) || dt<=0) return;
    const elapsed=Math.min(.12,dt);
    const steps=Math.ceil(elapsed*90);
    for (let i=0;i<steps && state.phase==='flying';i++) stepFrame(elapsed/steps,input);
  }

  reset();
  return {site,state,target,reset,step,fuelCapacity:FUEL_CAPACITY,
    launch(){if(state.phase==='ready') state.phase='flying';}};
}
