import {AstroTime, Atmosphere, Body, Equator, Horizon, KM_PER_AU, Observer, Refraction,
  SearchHourAngle, SearchRiseSet} from './astronomy-engine.js';

const hourMs = 3600000;
const dayMs = 24 * hourMs;
const toDegrees = 180 / Math.PI;
const horizonLift = 34 / 60;
const names = [
  // Spherical diameters are computed from physical radii in km, excluding rings.
  ['sun', 'Soleil', Body.Sun, 695700, '#ffd074'],
  ['moon', 'Lune', Body.Moon, 1738.1, '#d6e2ea'],
  ['mercury', 'Mercure', Body.Mercury, 2439.7, '#c8b9ad'],
  ['venus', 'Vénus', Body.Venus, 6051.8, '#ffddad'],
  ['mars', 'Mars', Body.Mars, 3389.5, '#f59676'],
  ['jupiter', 'Jupiter', Body.Jupiter, 69911, '#e8ba94'],
  ['saturn', 'Saturne', Body.Saturn, 58232, '#e5cf9e'],
  ['uranus', 'Uranus', Body.Uranus, 25362, '#ace5e4'],
  ['neptune', 'Neptune', Body.Neptune, 24622, '#9bb7fa']
];
export const EARTH_SKY_BODIES = Object.freeze(names.map(([id, name, body, radiusKm, color]) =>
  Object.freeze({id, name, body, radiusKm, color})));
const byId = new Map(EARTH_SKY_BODIES.map(item => [item.id, item]));

export const EARTH_SKY_SOURCES = Object.freeze({
  ephemerides: 'https://github.com/cosinekitty/astronomy/tree/master/source/js',
  conventions: 'https://aa.usno.navy.mil/faq/RST_defs',
  radii: 'https://ssd.jpl.nasa.gov/planets/phys_par.html'
});

function timeValue(date) {
  const timeMs = date instanceof Date ? date.getTime() : date;
  if (!Number.isFinite(timeMs) || !Number.isFinite(new Date(timeMs).getTime()))
    throw new RangeError('Instant astronomique invalide.');
  return timeMs;
}

function observerAt(site) {
  const {latitude, longitude, elevationMeters = 0} = site || {};
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) ||
      !Number.isFinite(elevationMeters) || elevationMeters < -500 || elevationMeters > 100000)
    throw new RangeError('Coordonnées ou altitude du site invalides.');
  const observer = new Observer(latitude, ((longitude % 360 + 540) % 360) - 180, elevationMeters);
  return {observer, density: Atmosphere(elevationMeters).density};
}

function coordinates(target, time, site) {
  // True equator/equinox of date and apparent topocentric direction including
  // aberration and lunar parallax. The horizontal conversion uses the same frame.
  const equ = Equator(target.body, time, site.observer, true, true);
  const hor = Horizon(time, site.observer, equ.ra, equ.dec);
  const distanceKm = equ.dist * KM_PER_AU;
  const angularRadius = toDegrees * Math.asin(target.radiusKm / distanceKm);
  const limb = target.id === 'sun' || target.id === 'moon' ? angularRadius : 0;
  return {id: target.id, name: target.name, color: target.color,
    altitudeDeg: hor.altitude + Refraction('normal', hor.altitude) * site.density,
    geometricAltitudeDeg: hor.altitude, azimuthDeg: hor.azimuth, raHours: equ.ra, decDegrees: equ.dec,
    distanceKm, angularDiameterDeg: 2 * angularRadius,
    // Match SearchRiseSet's apparent horizon: standard refraction for local air
    // density, upper limb of Sun/Moon, centre of other bodies, level clear horizon.
    aboveHorizon: hor.altitude + limb + horizonLift * site.density >= 0};
}

function direction({raHours, decDegrees}) {
  const ra = raHours * 15 / toDegrees, dec = decDegrees / toDegrees;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

function lunarIllumination(sun, moon) {
  const sunDirection = direction(sun), moonDirection = direction(moon);
  const fromMoon = sunDirection.map((value, i) => value * sun.distanceKm - moonDirection[i] * moon.distanceKm);
  const dot = fromMoon.reduce((sum, value, i) => sum - value * moonDirection[i], 0);
  return (1 + Math.max(-1, Math.min(1, dot / Math.hypot(...fromMoon)))) / 2;
}

function skyLight(sun) {
  if (sun.aboveHorizon) return 'day';
  if (sun.geometricAltitudeDeg >= -6) return 'civil';
  if (sun.geometricAltitudeDeg >= -12) return 'nautical';
  if (sun.geometricAltitudeDeg >= -18) return 'astronomical';
  return 'night';
}

export function earthSkySnapshot(site, date) {
  const timeMs = timeValue(date), time = new AstroTime(new Date(timeMs)), location = observerAt(site);
  const bodies = EARTH_SKY_BODIES.map(body => coordinates(body, time, location));
  const [sun, moon] = bodies;
  moon.illuminatedFraction = lunarIllumination(sun, moon);
  return {timeMs, bodies, light: skyLight(sun)};
}

export function earthSkyBody(site, id, date) {
  const target = byId.get(id);
  if (!target) throw new RangeError('Astre inconnu.');
  const location = observerAt(site), time = new AstroTime(new Date(timeValue(date)));
  const body = coordinates(target, time, location);
  if (id === 'moon') body.illuminatedFraction = lunarIllumination(coordinates(byId.get('sun'), time, location), body);
  return body;
}

export function earthSkyTrack(site, id, startDate, stepMinutes = 30, durationHours = 24) {
  const startMs = timeValue(startDate), target = byId.get(id), location = observerAt(site);
  if (!target) throw new RangeError('Astre inconnu.');
  if (!Number.isFinite(stepMinutes) || stepMinutes < 1 || !Number.isFinite(durationHours) ||
      durationHours <= 0 || durationHours > 48) throw new RangeError('Fenêtre de trajectoire invalide.');
  const endMs = timeValue(startMs + durationHours * hourMs);
  const sample = timeMs => {
    const {altitudeDeg, geometricAltitudeDeg, azimuthDeg, aboveHorizon} =
      coordinates(target, new AstroTime(new Date(timeMs)), location);
    return {timeMs, altitudeDeg, geometricAltitudeDeg, azimuthDeg, aboveHorizon};
  };
  const points = [];
  for (let t = startMs; t < endMs; t += stepMinutes * 60000) points.push(sample(t));
  points.push(sample(endMs));

  // Events come from independent continuous searches, not interpolation of
  // the plotted samples. A 25-hour civil day can have two rises or transits.
  const events = [];
  for (const type of ['rise', 'set', 'transit']) {
    let cursor = startMs - 1000;
    while (cursor < endMs) {
      const from = new Date(cursor);
      const found = type === 'transit' ? SearchHourAngle(target.body, location.observer, 0, from).time :
        SearchRiseSet(target.body, location.observer, type === 'rise' ? 1 : -1, from, (endMs - cursor) / dayMs);
      if (!found) break;
      const timeMs = found.date.getTime();
      if (timeMs >= endMs || timeMs < cursor) break;
      if (timeMs >= startMs) events.push({type, ...sample(timeMs)});
      cursor = timeMs + 60000;
    }
  }
  events.sort((a, b) => a.timeMs - b.timeMs);
  const crosses = events.some(event => event.type === 'rise' || event.type === 'set');
  const horizonState = crosses ? 'crosses' : points[0].aboveHorizon ? 'above-window' : 'below-window';
  return {startMs, endMs, points, events, horizonState};
}
