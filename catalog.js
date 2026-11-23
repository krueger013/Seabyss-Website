// One world unit is one kilometre. The catalog is the simulation's initial snapshot.
// Distances to external objects and visible galaxy radii are rounded estimates.
import { createDeepSpaceCatalog } from './deep-space-catalog.js';
import { createNearbyStars } from './nearby-stars.js';
import { createSolarWorlds } from './solar-worlds.js';
import { createTransitSystems } from './transit-systems.js';

export const AU = 149597870.7;
export const LIGHT_YEAR = 9460730472580.8;
const DEG = Math.PI / 180;

function orbit(distanceAU, phase) {
  const along = distanceAU * AU * Math.sin(phase * DEG);
  return [distanceAU * AU * Math.cos(phase * DEG), along * Math.sin(13 * DEG), along * Math.cos(13 * DEG)];
}

const sunPosition = orbit(1, -55).map(x => -x);

function planetPosition(distanceAU, phase) {
  return orbit(distanceAU, phase).map((value, axis) => value + sunPosition[axis]);
}

const jupiterPosition = planetPosition(5.2, 154);
const saturnPosition = planetPosition(9.58, 103);
// Sidereal revolution (days), rotation (hours), obliquity (degrees), orbital
// eccentricity and inclination (degrees). Starting longitudes are illustrative.
// https://nssdc.gsfc.nasa.gov/planetary/factsheet/
// https://ssd.jpl.nasa.gov/planets/approx_pos.html
// https://ssd.jpl.nasa.gov/planets/phys_par.html (Julian years × 365.25)
const planetMotion = Object.freeze({
  mercury: [87.969, 1407.6, .034, .205636, 7.005],
  venus: [224.701, -5832.5, 177.4, .006777, 3.395],
  earth: [365.256, 23.9345, 23.44, .016711, 0],
  mars: [686.980, 24.623, 25.19, .093394, 1.850],
  jupiter: [4332.820, 9.925, 3.13, .048386, 1.304],
  saturn: [10755.699, 10.7, 26.73, .053862, 2.486],
  uranus: [30687.153, -17.24, 97.77, .047257, .773],
  neptune: [60190.030, 16.11, 28.32, .008590, 1.770]
});

function skyPosition(distanceLY, raHours, decDegrees) {
  const ra = raHours * 15 * DEG;
  const dec = decDegrees * DEG;
  const km = distanceLY * LIGHT_YEAR;
  return [km * Math.cos(dec) * Math.sin(ra), km * Math.sin(dec), -km * Math.cos(dec) * Math.cos(ra)];
}

function body(id, name, kind, category, designation, radius, position, color, description, extra = {}) {
  const parentId = kind === 'star' ? 'milky-way' : kind === 'planet' ? 'sun' : null;
  const motion = planetMotion[id];
  const solarOrbit = motion ? {
    orbitPeriodDays: motion[0], rotationPeriodHours: motion[1], axialTiltDeg: motion[2],
    orbitEccentricity: motion[3], orbitInclinationDeg: motion[4], orbitPlaneTiltDeg: 13,
    orbitRadiusKm: Math.hypot(...position.map((n, i) => n - sunPosition[i]))
  } : {};
  return Object.freeze({ id, name, kind, category, designation, radius,
    position: Object.freeze(position), color, description, parentId, ...solarOrbit, ...extra });
}

// Orbital radii and sidereal periods are independent of the illustrative phases.
// Sources and map provenance are recorded in assets/moons-credits.txt.
function satellite(id, name, designation, parentId, radius, orbitRadiusKm, orbitPeriodDays, phase, material, color, description) {
  const jovian = parentId === 'jupiter';
  const center = jovian ? jupiterPosition : saturnPosition;
  const angle = phase * DEG;
  const tilt = jovian ? 13 * DEG : 22 * DEG;
  const along = orbitRadiusKm * Math.sin(angle);
  const position = [center[0] + orbitRadiusKm * Math.cos(angle), center[1] - along * Math.sin(tilt), center[2] + along * Math.cos(tilt)];
  return body(id, name, 'moon', jovian ? 'Lune de Jupiter' : 'Lune de Saturne', designation, radius, position,
    color, description, { parentId, orbitRadiusKm, orbitPeriodDays, rotationPeriodHours: orbitPeriodDays * 24,
      orbitPlaneTiltDeg: jovian ? -13 : -22, material });
}

const majorSatellites = [
  satellite('io', 'Io', 'Jupiter I', 'jupiter', 1821.49, 421800, 1.769138, -32, 'sulfur', '#dec379',
    'Les marées de Jupiter déforment Io et chauffent son intérieur. Des volcans y déposent du soufre sur des plaines jaunes et rouges.'),
  satellite('europa', 'Europe', 'Jupiter II · Europa', 'jupiter', 1560.8, 671100, 3.551181, 126, 'fissured-ice', '#dbd1b6',
    'De longues fractures rousses découpent une croûte de glace. Sous elle, plusieurs indices révèlent la présence probable d’un océan salé.'),
  satellite('ganymede', 'Ganymède', 'Jupiter III', 'jupiter', 2631.2, 1070400, 7.154553, 41, 'grooved-ice', '#a39b8d',
    'De larges bandes claires et sillonnées traversent des terrains plus sombres. Ganymède possède son propre champ magnétique.'),
  satellite('callisto', 'Callisto', 'Jupiter IV', 'jupiter', 2410.3, 1882700, 16.689017, -117, 'cratered-rock', '#817c75',
    'Des cratères clairs ponctuent la surface ancienne de Callisto. Les plus grands impacts ont laissé des systèmes d’anneaux concentriques.'),
  satellite('titan', 'Titan', 'Saturne VI', 'saturn', 2574.76, 1221900, 15.945421, -60, 'haze', '#daa661',
    'Une brume orangée cache les dunes et les mers de méthane et d’éthane. Son atmosphère dense est surtout composée d’azote.'),
  satellite('enceladus', 'Encelade', 'Saturne II · Enceladus', 'saturn', 252.1, 238400, 1.370218, 120, 'polar-ice', '#d4e5e7',
    'Au pôle sud, de longues fractures expulsent de la vapeur et des grains de glace provenant d’un océan sous la surface.')
];

// J2000 sky directions and rounded visual radii. The Alpha Centauri binary
// is shown at a representative separation, not at a date-specific phase.
const alphaCenter = skyPosition(4.37, 14.660, -60.834);
const solarRadius = 695700;
const stellarData = [
  ['alpha-cen-a', 'Alpha Centauri A', 'G2 V', 1.22, alphaCenter, '#ffe1aa', 'La composante la plus brillante du couple Alpha Centauri ressemble au Soleil.'],
  ['alpha-cen-b', 'Alpha Centauri B', 'K1 V', .86, alphaCenter.map((n, i) => i === 0 ? n + 23.4 * AU : n), '#ffbb8c', 'Cette étoile orangée partage son orbite avec Alpha Centauri A. La séparation affichée est illustrative.'],
  ['barnard', 'Étoile de Barnard', 'M4 V', .185, skyPosition(5.96, 17.964, 4.693), '#ff977d', 'Cette naine rouge proche se déplace rapidement sur le fond du ciel.'],
  ['sirius', 'Sirius A', 'A1 V', 1.71, skyPosition(8.60, 6.7525, -16.716), '#e2edff', 'L’étoile principale du Grand Chien est accompagnée d’une naine blanche.'],
  ['vega', 'Véga', 'A0 V', 2.6, skyPosition(25.0, 18.616, 38.784), '#c9deff', 'La rotation rapide de Véga aplatit ses pôles. Le rayon affiché est une approximation sphérique.'],
  ['betelgeuse', 'Bételgeuse', 'M1–M2 Ia', 750, skyPosition(700, 5.9195, 7.407), '#ffa27a', 'Cette supergéante rouge marque une épaule d’Orion. Sa taille varie et sa distance reste incertaine.']
];

export function generateSystem(seed) {
  // A precisely specified integer PRNG keeps this atlas reproducible across browsers.
  const key = seed >>> 0;
  let state = key;
  function noise() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  }
  const center = skyPosition(12 + noise() * 18, noise() * 24, noise() * 100 - 50);
  const prefix = 'sim-' + key;
  const system = 'Système ' + key;
  const host = body(prefix + '-star', system, 'star', 'Étoile simulée', 'Simulation ' + key,
    solarRadius * (.65 + noise() * .5), center, '#ffd39c',
    'Étoile fictive générée avec la graine ' + key + '. Ses planètes et sa lune peuvent être visitées.', { simulated: true, system });
  const result = [host];
  const count = 3 + Math.floor(noise() * 3);
  const inclination = (noise() - .5) * .50;
  let axisAU = .23;
  const properties = { simulated: true, system, lightPosition: host.position, orbitPlaneTiltDeg: inclination / DEG };
  for (let i = 0; i < count; i++) {
    axisAU *= 1.65 + noise() * .8;
    const phase = noise() * 2 * Math.PI;
    const along = axisAU * AU * Math.sin(phase);
    const pos = [center[0] + axisAU * AU * Math.cos(phase), center[1] + along * Math.sin(inclination),
      center[2] + along * Math.cos(inclination)];
    const giant = i === count - 1;
    const label = key + ' ' + String.fromCharCode(98 + i);
    const radius = giant ? 25000 + 40000 * noise() : 2400 + 5300 * noise();
    const colors = giant ? ['#c9b08c', '#83b6cd'] : ['#b87961', '#a08a70', '#879ca4'];
    result.push(body(prefix + '-p' + i, label, 'planet', giant ? 'Géante simulée' : 'Planète rocheuse simulée',
      'Simulation ' + key, radius, pos, colors[Math.floor(noise() * colors.length)],
      'Monde fictif du système ' + key + ', sur une orbite illustrative de ' + axisAU.toFixed(2) + ' UA.',
      { ...properties, parentId: host.id, orbitRadiusKm: axisAU * AU, orbitPeriodDays: 365.256 * axisAU ** 1.5,
        rotationPeriodHours: giant ? 11 : 19 + 3 * i, axialTiltDeg: 6 + 7 * i, material: giant ? 'gas' : 'rock' }));
    if (giant) {
      const moon = [pos[0] + radius * 12, pos[1] + radius * .4, pos[2]];
      result.push(body(prefix + '-moon', label + ' I', 'moon', 'Lune simulée', 'Simulation ' + key,
        600 + noise() * 1300, moon, '#c6bdaf', 'Satellite fictif de la géante ' + label + '.',
        { ...properties, parentId: prefix + '-p' + i, orbitRadiusKm: radius * Math.hypot(12, .4),
          orbitPeriodDays: 8, rotationPeriodHours: 192, material: 'rock' }));
    }
  }
  return result;
}

const baseObjects = [
  body('earth', 'Terre', 'planet', 'Planète tellurique', 'Sol III', 6371, [0, 0, 0], '#77b8ee',
    'Une mince couche d’air dessine un halo bleu au-dessus des océans et des continents.'),
  body('moon', 'Lune', 'moon', 'Satellite naturel', 'Luna', 1737.4, skyPosition(384400 / LIGHT_YEAR, 1.1, 8), '#d9d6cf',
    'Les plaines sombres de la Lune sont d’anciennes coulées de lave entre des terres criblées de cratères.',
    { parentId: 'earth', orbitRadiusKm: 384400, orbitPeriodDays: 27.322, rotationPeriodHours: 655.728,
      axialTiltDeg: 6.7, orbitEccentricity: .0549, orbitPlaneTiltDeg: 13 }),
  body('saturn', 'Saturne', 'planet', 'Géante gazeuse', 'Sol VI', 58232, saturnPosition, '#ddc692',
    'Des milliards de fragments de glace tracent des anneaux dans le plan de son équateur.'),
  body('proxima', 'Proxima Centauri', 'star', 'Naine rouge', 'Alpha Cen C', 107300, skyPosition(4.2465, 14.495, -62.68), '#f89975',
    'Cette étoile discrète du Centaure est la plus proche voisine du Soleil.'),
  body('milky-way', 'Voie lactée', 'galaxy', 'Spirale barrée', 'Galaxie hôte', 50000 * LIGHT_YEAR,
    skyPosition(26000, 17.76, -28.93), '#c4c6f7',
    'Le Soleil habite le disque de cette galaxie, à quelque 26 000 années-lumière de son centre.'),
  body('andromeda', 'Andromède', 'galaxy', 'Galaxie spirale', 'M31', 130000 * LIGHT_YEAR,
    skyPosition(2.5e6, 0.712, 41.27), '#d5c6ed',
    'À deux millions et demi d’années-lumière, cette grande spirale est visible à l’œil nu sous un ciel sombre.'),
  body('sun', 'Soleil', 'star', 'Étoile de type G', 'Sol', 695700, sunPosition, '#ffdd93',
    'Au cœur du Système solaire, la fusion de l’hydrogène alimente l’étoile qui éclaire les planètes.',
    { rotationPeriodHours: 25.4 * 24, axialTiltDeg: 7.25 }),
  body('mercury', 'Mercure', 'planet', 'Planète tellurique', 'Sol I', 2439.4, planetPosition(0.387, 22), '#ab9e92',
    'De longues falaises et des cratères d’impact racontent l’histoire de la plus petite planète du Système solaire.'),
  body('venus', 'Vénus', 'planet', 'Planète tellurique', 'Sol II', 6051.8, planetPosition(0.723, -119), '#e6c792',
    'Sous ses nuages épais, une atmosphère dense retient la chaleur à la surface.'),
  body('mars', 'Mars', 'planet', 'Planète tellurique', 'Sol IV', 3389.5, planetPosition(1.524, -34), '#cf8563',
    'Des oxydes de fer teintent en rouge les poussières de cette planète aux grands volcans.'),
  body('jupiter', 'Jupiter', 'planet', 'Géante gazeuse', 'Sol V', 69911, jupiterPosition, '#d5ae92',
    'Ses bandes nuageuses tournent à des vitesses différentes et bordent d’immenses tourbillons.'),
  body('uranus', 'Uranus', 'planet', 'Géante de glaces', 'Sol VII', 25362, planetPosition(19.2, -158), '#a3d9d6',
    'Son axe de rotation est si incliné que la planète semble rouler le long de son orbite.'),
  body('neptune', 'Neptune', 'planet', 'Géante de glaces', 'Sol VIII', 24622, planetPosition(30.05, 43), '#82a9d3',
    'Dans les confins du Système solaire, de puissants vents parcourent son atmosphère froide.'),
  body('whirlpool', 'Galaxie du Tourbillon', 'galaxy', 'Galaxie spirale', 'M51', 30000 * LIGHT_YEAR,
    skyPosition(31e6, 13.498, 47.2), '#a6c3eb',
    'Les bras de cette spirale des Chiens de chasse abritent des nuages de gaz où naissent des étoiles.'),
  ...stellarData.map(([id, name, spectral, radius, position, color, description]) =>
    body(id, name, 'star', 'Étoile · ' + spectral, name, radius * solarRadius, position, color, description)),
  ...majorSatellites,
  ...createNearbyStars({body, skyPosition, solarRadius}),
  ...createTransitSystems({body, skyPosition, AU, solarRadius}),
  ...generateSystem(1697),
  ...createDeepSpaceCatalog({body, skyPosition, AU, LIGHT_YEAR})
];
export const objects=Object.freeze([...baseObjects,...createSolarWorlds({body,AU,existing:baseObjects})]);
