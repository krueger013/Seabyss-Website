import { schwarzschildRadiusKm, schwarzschildTimeSeconds } from './relativity-model.js';

const MPC_KM = 3.085677581491367e19;
const SOLAR_GRAVITY_KM = schwarzschildRadiusKm(1) / 2;
const SOLAR_GRAVITY_SECONDS = schwarzschildTimeSeconds(1) / 2;

export const INSPIRAL_LIMITS = Object.freeze({
  mass1: Object.freeze([1,1e6]),
  mass2: Object.freeze([1,1e6]),
  distanceMpc: Object.freeze([.00001,1e6]),
  redshift: Object.freeze([0,30]),
  inclination: Object.freeze([0,180]),
  startFrequency: Object.freeze([.00001,3000])
});
export const INSPIRAL_DEFAULTS = Object.freeze({
  mass1:36, mass2:29, distanceMpc:410, redshift:0, inclination:0, startFrequency:20
});

const validNumber = (value,[min,max]) => Number.isFinite(value) && value>=min && value<=max;

// Estimate the end of the inspiral using the Schwarzschild test-particle ISCO
// of the total mass. The binary waveform and positions stop at this proxy.
export function inspiralCutoffFrequency(totalMass, redshift=0) {
  if (!Number.isFinite(totalMass) || totalMass<=0 || !validNumber(redshift,INSPIRAL_LIMITS.redshift)) return null;
  const frequency=1/(Math.PI * 6**1.5 * SOLAR_GRAVITY_SECONDS * totalMass * (1+redshift));
  return Number.isFinite(frequency) && frequency>0 ? frequency : null;
}

/**
 * Leading quadrupole, circular, nonspinning binary in the wave zone.
 * Component masses and separation are source-frame quantities. Frequencies
 * and elapsed times are measured in the observer frame. Phase is in radians.
 * https://dcc.ligo.org/LIGO-P1600161/public (equations 6–8 and section 4.6)
 * https://workarea.et-gw.eu/et/WG4-Astrophysics/visdoc/VisDoc-100224.pdf
 */
export function createInspiral(options={}) {
  if (options===null || typeof options!=='object' || Array.isArray(options)) return null;
  const {mass1,mass2,distanceMpc,redshift,inclination,startFrequency}={...INSPIRAL_DEFAULTS,...options};
  const settings={mass1,mass2,distanceMpc,redshift,inclination,startFrequency};
  if (!Object.entries(settings).every(([key,value])=>validNumber(value,INSPIRAL_LIMITS[key]))) return null;

  const totalMass=mass1+mass2;
  const symmetricMassRatio=(mass1/totalMass)*(mass2/totalMass);
  const chirpMass=totalMass*symmetricMassRatio**(3/5);
  const stretch=1+redshift;
  const detectorChirpMass=chirpMass*stretch;
  const endFrequency=inspiralCutoffFrequency(totalMass,redshift);
  if (!(startFrequency<endFrequency)) return null;

  const detectorChirpSeconds=SOLAR_GRAVITY_SECONDS*detectorChirpMass;
  const amplitudeScale=4*SOLAR_GRAVITY_KM*detectorChirpMass/(distanceMpc*MPC_KM);
  const timeScale=(5/256)*detectorChirpSeconds**(-5/3);
  // Distance in time to the formal point-mass coalescence, outside this model.
  const tauStart=timeScale*(Math.PI*startFrequency)**(-8/3);
  const logTauEndRatio=(-8/3)*Math.log1p((endFrequency-startFrequency)/startFrequency);
  const tauEnd=tauStart*Math.exp(logTauEndRatio);
  const duration=tauStart*-Math.expm1(logTauEndRatio);
  const phaseScale=(16*Math.PI/5)*startFrequency*tauStart;
  const facing=inclination===90 ? 0 : Math.cos(inclination*Math.PI/180);
  const plusProjection=(1+facing*facing)/2;
  const sourceGravitySeconds=SOLAR_GRAVITY_SECONDS*totalMass;
  const sourceGravityKm=SOLAR_GRAVITY_KM*totalMass;

  function sample(seconds) {
    if (!Number.isFinite(seconds)) return null;
    const elapsed=Math.max(0,Math.min(duration,seconds));
    const remaining=duration-elapsed;
    // Using the elapsed time near the start and the remaining time near the
    // cutoff preserves resolution at both ends, even for very long binaries.
    const logTauRatio=elapsed<=duration/2 ? Math.log1p(-elapsed/tauStart)
      : logTauEndRatio+Math.log1p(remaining/tauEnd);
    const frequency=elapsed===duration ? endFrequency
      : Math.max(startFrequency,Math.min(endFrequency,startFrequency*Math.exp((-3/8)*logTauRatio)));
    const sourceFrequency=frequency*stretch;
    const orbitalSpeedC=Math.cbrt(Math.PI*sourceFrequency*sourceGravitySeconds);
    const separationKm=sourceGravityKm/(orbitalSpeedC*orbitalSpeedC);
    const phase=phaseScale*-Math.expm1((5/8)*logTauRatio);
    const amplitude=amplitudeScale*(Math.PI*frequency*detectorChirpSeconds)**(2/3);
    const plus=amplitude*plusProjection*Math.cos(phase);
    const cross=facing===0 ? 0 : amplitude*facing*Math.sin(phase);
    return {elapsed,time:elapsed,remaining,frequency,sourceFrequency,separationKm,orbitalSpeedC,
      amplitude,plus,cross,strain:plus,phase,orbitalPhase:phase/2};
  }

  function samples(count=512) {
    if (!Number.isFinite(count)) return [];
    const length=Math.min(8192,Math.max(2,Math.floor(count)));
    return Array.from({length},(_,index)=>sample(duration*(index/(length-1))));
  }

  return Object.freeze({...settings,totalMass,chirpMass,detectorChirpMass,symmetricMassRatio,
    endFrequency,duration,sample,samples});
}
