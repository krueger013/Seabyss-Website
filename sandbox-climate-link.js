import { CLIMATE_RANGES } from './climate-model.js';
import { measureOrbit, strongestReference } from './sandbox-analysis.js';
import { G } from './sandbox-physics.js';

const AU_KM = 149597870.7;
const EARTH_RADIUS = 6371 / AU_KM;
const SOLAR_RADIUS = 695700 / AU_KM;
const orbitTooClose = 'Le périastre placerait la planète au contact de son étoile.';
const sourceChanged = 'La planète ou l’étoile a changé dans l’Atelier. Rouvre Climat depuis la planète pour repartir de sa nouvelle orbite.';
const outOfRange = 'Les paramètres dépassent les limites de calcul de l’Atelier.';
const relativeVector = (body, reference, field) => body[field].map((value, axis) => value - reference[field][axis]);
const bodyState = body => JSON.stringify([body.kind, body.mass, body.radius, body.position, body.velocity]);
const withinClimateRange = (key, value) => Number.isFinite(value) && value >= CLIMATE_RANGES[key][0] && value <= CLIMATE_RANGES[key][1];

const messages = {
  missing: 'Sélectionne une planète dans l’Atelier pour analyser son climat.',
  kind: 'Sélectionne une planète à surface solide pour ouvrir ce modèle climatique.',
  star: 'Il faut une étoile dans le système pour estimer l’ensoleillement de cette planète.',
  orbit: 'Le laboratoire a besoin d’une orbite fermée autour d’une étoile, sans passage au contact.',
  compact: 'La luminosité d’une étoile compacte ne peut pas être estimée à partir de sa masse seule.',
  range: 'L’orbite ou la luminosité mesurée dépasse la plage prise en charge par le modèle climatique.'
};

function meanAnomaly({ radius, semiMajor, eccentricity, radialSpeed }) {
  if (eccentricity < 1e-6) return 0;
  // Recover E from r = a(1 − e cos E). Radial motion distinguishes the two
  // sides of the orbit. See JPL Orbital Mechanics, equations (7-48) and (7-51).
  // https://spsweb.fltops.jpl.nasa.gov/portaldataops/mpg/MPG_Docs/MPG%20Book/Release/Chapter7-OrbitalMechanics.pdf
  const cosine = Math.max(-1, Math.min(1, (1 - radius / semiMajor) / eccentricity));
  const eccentricAnomaly = Math.acos(cosine) * (radialSpeed < 0 ? -1 : 1);
  const degrees = (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly)) * 180 / Math.PI;
  return (degrees + 360) % 360;
}

function estimate(world, selection) {
  const id = typeof selection === 'string' ? selection : selection?.id;
  const body = world?.bodies?.find(candidate => candidate.id === id);
  if (!body) return { reason: messages.missing };
  if (body.kind !== 'planet' || body.radius > 3 * EARTH_RADIUS) return { reason: messages.kind };

  const stars = world.bodies.filter(candidate => candidate.kind === 'star');
  const { body: star } = strongestReference(body, stars);
  if (!star) return { reason: messages.star };
  if (star.radius < .05 * SOLAR_RADIUS) return { reason: messages.compact };

  const orbit = measureOrbit(body, star);
  if (!orbit || orbit.crossesContact || !['circular', 'elliptic'].includes(orbit.kind)) {
    return { reason: messages.orbit };
  }

  // Reuse the approximation used by orbital diagnostics for a main-sequence
  // star. Equal solar masses must yield equal solar luminosity in the model.
  const options = {
    solarLuminosity: star.mass ** 3.5,
    semiMajorAxis: orbit.semiMajor,
    eccentricity: orbit.eccentricity,
    period: orbit.periodDays,
    epochAnomaly: meanAnomaly(orbit)
  };
  if (!Object.entries(options).every(([key,value]) => withinClimateRange(key,value))) return { reason: messages.range };

  const illumination = stars.length === 1 ? 'de l’étoile' : 'de l’étoile dominante, seule source de lumière du modèle';
  const details = `Orbite instantanée de la planète et luminosité estimée ${illumination}. Axe et atmosphère de type terrestre au départ.`;
  const sourceIdentity = {
    planetId:body.id, starId:star.id, day:world.days, bodyState:bodyState(body), starState:bodyState(star)
  };
  return { result: { options, details, planetName: body.name, planetId: body.id, starName: star.name, starId: star.id, sourceIdentity } };
}

export function climateFromSandbox(world, body) {
  return estimate(world, body).result ?? null;
}

export function sandboxClimateUnavailable(world, body) {
  return estimate(world, body).reason ?? '';
}

/** Reconstruct a bound conic at the source instant without editing the world. */
export function proposeSandboxClimateOrbit(world, selection, climateOptions, sourceIdentity) {
  const id = typeof selection === 'string' ? selection : selection?.id;
  if (!sourceIdentity || !Array.isArray(world?.bodies) || id !== sourceIdentity.planetId || world.days !== sourceIdentity.day) {
    return {ok:false,reason:sourceChanged};
  }
  const body=world.bodies.find(candidate=>candidate.id===id);
  const star=world.bodies.find(candidate=>candidate.id===sourceIdentity.starId);
  if (body?.kind!=='planet' || star?.kind!=='star' || bodyState(body)!==sourceIdentity.bodyState || bodyState(star)!==sourceIdentity.starState) {
    return {ok:false,reason:sourceChanged};
  }
  const {semiMajorAxis,eccentricity}=climateOptions ?? {};
  if (!withinClimateRange('semiMajorAxis',semiMajorAxis) || !withinClimateRange('eccentricity',eccentricity)) {
    return {ok:false,reason:outOfRange};
  }
  const periapsis=semiMajorAxis*(1-eccentricity), apoapsis=semiMajorAxis*(1+eccentricity);
  if (periapsis<=body.radius+star.radius) return {ok:false,reason:orbitTooClose};

  const orbit=measureOrbit(body,star);
  if (!orbit || orbit.crossesContact || !['circular','elliptic'].includes(orbit.kind)) return {ok:false,reason:messages.orbit};
  const mu=G*(star.mass+body.mass);
  const periodDays=2*Math.PI*semiMajorAxis*Math.sqrt(semiMajorAxis/mu);
  // Reusing the unchanged state avoids numerical drift on a round trip.
  let patch={position:body.position.slice(),velocity:body.velocity.slice()};
  if (Math.abs(semiMajorAxis-orbit.semiMajor)>1e-10 || Math.abs(eccentricity-orbit.eccentricity)>1e-10) {
    const radial=relativeVector(body,star,'position').map(value=>value/orbit.radius);
    const tangent=relativeVector(body,star,'velocity').map((value,axis)=>value-orbit.radialSpeed*radial[axis]);
    const tangentLength=Math.hypot(...tangent);
    if (!(tangentLength>0)) return {ok:false,reason:messages.orbit};

    // Keep the current azimuth and orbital plane. The direction of a nearly
    // circular source orbit defines the periapsis of the new ellipse.
    // JPL Orbital Mechanics, Chapter 7, equations (7-19) and (7-20).
    const originalLatus=orbit.periapsis*(1+orbit.eccentricity);
    const anomaly=orbit.eccentricity<1e-6 ? 0 : Math.atan2(
      (orbit.radialSpeed/Math.sqrt(mu/originalLatus))/orbit.eccentricity,
      (originalLatus/orbit.radius-1)/orbit.eccentricity
    );
    const latus=semiMajorAxis*(1-eccentricity**2);
    const speedScale=Math.sqrt(mu/latus);
    const factor=1+eccentricity*Math.cos(anomaly);
    const radialSpeed=speedScale*eccentricity*Math.sin(anomaly);
    const tangentialSpeed=speedScale*factor;
    patch={
      position:radial.map((value,axis)=>star.position[axis]+value*latus/factor),
      velocity:radial.map((value,axis)=>star.velocity[axis]+value*radialSpeed+tangent[axis]/tangentLength*tangentialSpeed)
    };
  }
  const candidate=measureOrbit({...body,...patch},star);
  if (!candidate || candidate.crossesContact || !Number.isFinite(candidate.semiMajor) ||
      Math.abs(candidate.semiMajor/semiMajorAxis-1)>1e-6 || Math.abs(candidate.eccentricity-eccentricity)>1e-6) {
    return {ok:false,reason:outOfRange};
  }
  return {
    ok:true,planetId:id,starId:star.id,patch,periapsis,apoapsis,periodDays,
    details:'Demi-grand axe et excentricité autour de '+star.name+'. Le plan et le sens de l’orbite sont conservés.'
  };
}
