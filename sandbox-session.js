import { GravitySandbox } from './sandbox-physics.js';
import { SANDBOX_SCENARIOS, createGuide, createScenario } from './sandbox-scenarios.js';

// Snapshots are sampled in real time so the same controls work for a flight
// lasting a few hours and for one lasting several simulated years.
const HISTORY_LIMIT = 110;
const known = id => SANDBOX_SCENARIOS.some(s => s.id === id);
const isDisruptive = event => event.type==='collision' || event.type==='tidal';

export class SandboxSession {
  constructor(id='binary') {
    this.history=[];
    this.cursor=-1;
    this.start(id);
  }
  start(id) {
    this.scenario = createScenario(known(id) ? id : 'binary');
    this.sim = new GravitySandbox(this.scenario.bodies, {
      collisionMode:this.scenario.collisionMode,tidesEnabled:this.scenario.tidesEnabled
    });
    this.guide = createGuide(this.scenario.id);
    this.selectedId = this.scenario.focusId || this.sim.bodies[0]?.id || '';
    this.serial = 1;
    this.rate = this.scenario.rate;
    this.history=[]; this.cursor=-1; this.elapsed=0;
    this.record();
  }
  snapshot() {
    return {version:1,scenarioId:this.scenario.id,world:this.sim.serialize(),
      selectedId:this.selectedId,serial:this.serial,rate:this.rate,guide:this.guide?.serialize() ?? null};
  }
  apply(snapshot) {
    if (snapshot?.version!==1 || !known(snapshot.scenarioId)) return false;
    const world=GravitySandbox.restore(snapshot.world);
    if (!world) return false;
    const sameScenario=this.scenario?.id===snapshot.scenarioId;
    this.scenario = sameScenario ? this.scenario : createScenario(snapshot.scenarioId);
    this.sim=world; this.selectedId=snapshot.selectedId; this.ensureSelection();
    this.guide=createGuide(this.scenario.id,snapshot.guide);
    this.serial=Number.isSafeInteger(snapshot.serial) && snapshot.serial>0 ? snapshot.serial : 1;
    this.rate=Number.isFinite(snapshot.rate) && snapshot.rate>0 && snapshot.rate<=this.scenario.rate*8
      ? snapshot.rate : this.scenario.rate;
    this.elapsed=0;
    return true;
  }
  load(snapshot) {
    if (!this.apply(snapshot)) return false;
    this.history=[]; this.cursor=-1; this.record();
    return true;
  }
  ensureSelection() {
    if (!this.sim.bodies.some(b=>b.id===this.selectedId)) this.selectedId=this.sim.bodies[0]?.id || '';
  }
  trimFuture() {
    if (this.cursor+1 < this.history.length) this.history.splice(this.cursor+1);
  }
  record(snapshot=this.snapshot()) {
    this.trimFuture();
    this.history.push(snapshot);
    if (this.history.length>HISTORY_LIMIT) this.history.shift();
    this.cursor=this.history.length-1; this.elapsed=0;
  }
  tick(realSeconds,forceRecord=false) {
    if (!(realSeconds>0)) return;
    this.trimFuture();
    const previousCount=this.sim.bodies.length;
    const previousEventId=this.sim.events.findLast(isDisruptive)?.id;
    this.sim.advance(realSeconds*this.rate);
    this.ensureSelection();
    this.guide?.update(this.sim,{selectedId:this.selectedId,paused:false});
    this.elapsed+=realSeconds;
    const event=this.sim.events.findLast(isDisruptive);
    if (forceRecord || this.elapsed>=.65 || previousCount!==this.sim.bodies.length ||
        (event && event.id!==previousEventId)) this.record();
  }
  seek(index) {
    if (!Number.isInteger(index) || index<0 || index>=this.history.length) return false;
    if (!this.apply(this.history[index])) return false;
    this.cursor=index;
    return true;
  }
  edit(change) {
    // Capture the unsampled moment just before an edit. A launch or mass
    // change is reversible even while the clock is paused at day zero.
    const pending=this.elapsed>0 ? this.snapshot() : null;
    const result=change(this.sim);
    if (!result) return false;
    if (pending) this.record(pending);
    this.ensureSelection();
    this.guide?.update(this.sim,{selectedId:this.selectedId});
    this.record();
    return true;
  }
}
