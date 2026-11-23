// Rounded mean elements for exploration. The snapshot has no date: angles are
// chosen to separate destinations on the map. Irregular bodies use mean radii.
const radians = Math.PI / 180;
const julianYear = 365.25;
const satelliteOrbits = 'https://ssd.jpl.nasa.gov/sats/elem/';
const satelliteSizes = 'https://ssd.jpl.nasa.gov/sats/phys_par/';
const sbdb = 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=';
const erisRotation = 'https://www.ornl.gov/publication/synchronous-rotation-136199-eris-dysnomia-system';

// Radius (km), semimajor axis (AU), orbital period (years), eccentricity,
// inclination to the ecliptic (degrees), rotation (hours), illustrative longitude.
const minorWorlds = [
  ['ceres', 'Cérès', 1, 'dwarf', 469.7, 2.77, 4.60, .079, 10.6, 9.074, 47, '#aba79f',
    'Dawn a repéré des dépôts de sels brillants dans le cratère Occator. Cérès orbite entre Mars et Jupiter.'],
  ['vesta', 'Vesta', 4, 'asteroid', 262.7, 2.36, 3.63, .089, 7.1, 5.342, -76, '#a99b90',
    'Le bassin Rheasilvia entaille le pôle sud de Vesta. La sonde Dawn a cartographié ce relief géant depuis son orbite.'],
  ['pallas', 'Pallas', 2, 'asteroid', 256.5, 2.77, 4.61, .231, 34.9, 7.81, 161, '#959b9e',
    'Pallas passe très au-dessus puis très au-dessous du plan des planètes au cours de chaque révolution.'],
  ['hygiea', 'Hygie', 10, 'asteroid', 217, 3.15, 5.59, .107, 3.8, 13.8, -150, '#736e6b',
    'Hygie est un grand astéroïde sombre de la ceinture principale. Des observations au Très Grand Télescope ont révélé sa forme presque sphérique.'],
  ['pluto', 'Pluton', 134340, 'dwarf', 1188.3, 39.48, 247.94, .249, 17.2, -153.29, 115, '#d6b79c',
    'En 2015, New Horizons a révélé des montagnes de glace d’eau et la grande plaine de glace d’azote de Spoutnik. Charon accompagne Pluton.'],
  ['haumea', 'Hauméa', 136108, 'dwarf', 798, 43.1, 283, .19, 28.2, 3.915, -122, '#c7cbcc',
    'La rotation d’Hauméa dure moins de quatre heures. Son corps très allongé est représenté ici par une sphère de volume équivalent.'],
  ['makemake', 'Makémaké', 136472, 'dwarf', 715, 45.4, 306, .16, 29, 22.5, 23, '#c5a28e',
    'Ce monde de la ceinture de Kuiper porte des glaces de méthane. À cette distance, la lumière solaire met plus de six heures à l’atteindre.'],
  ['eris', 'Éris', 136199, 'dwarf', 1163, 67.8, 558, .44, 44, 15.78 * 24, -37, '#d6dcdb',
    'Éris parcourt une orbite très allongée au-delà de Neptune. Les variations de sa lumière indiquent une rotation synchronisée avec sa lune Dysnomie.']
];

// Parent-centred JPL mean orbits. Radius (km), semimajor axis (km), period
// (days), eccentricity, inclination to the local reference plane, longitude.
const moons = [
  ['phobos', 'Phobos', 'Mars I', 'mars', 11.08, 9375, .3187, .015, 1.1, 72, '#95847c', 'rock',
    'Phobos fait le tour de Mars en moins de huit heures. Son cratère Stickney occupe une part considérable de cette petite lune.'],
  ['deimos', 'Déimos', 'Mars II', 'mars', 6.2, 23457, 1.2625, 0, 1.8, -117, '#b29e90', 'rock',
    'Déimos est la plus petite des deux lunes martiennes. Elle tourne plus loin et plus lentement que Phobos.'],
  ['iapetus', 'Japet', 'Saturne VIII', 'saturn', 734.5, 3561700, 79.331002, .028, 7.6, 35, '#ab998e', 'ice',
    'Japet présente un contraste marqué entre ses terrains sombres et clairs. Une longue crête longe une partie de son équateur.'],
  ['miranda', 'Miranda', 'Uranus V', 'uranus', 235.8, 129846, 1.413479, .001, 4.4, -106, '#b6b5ad', 'ice',
    'Les images de Voyager 2 montrent sur Miranda des terrains striés et de grandes falaises entre des régions cratérisées.'],
  ['ariel', 'Ariel', 'Uranus I', 'uranus', 578.9, 190929, 2.520379, .001, 0, 73, '#c3c3bd', 'ice',
    'Les images renvoyées par Voyager 2 montrent des vallées profondes qui recoupent les plaines cratérisées d’Ariel.'],
  ['umbriel', 'Umbriel', 'Uranus II', 'uranus', 584.7, 265986, 4.144177, .004, .1, 154, '#918e90', 'ice',
    'Umbriel possède une surface sombre et cratérisée. Un anneau de matériau clair se détache au fond du cratère Wunda.'],
  ['titania', 'Titania', 'Uranus III', 'uranus', 788.9, 436298, 8.705869, .002, .1, -38, '#beb2ab', 'ice',
    'Titania est la plus grande lune d’Uranus. Ses vallées de faille témoignent de déformations de sa croûte.'],
  ['oberon', 'Obéron', 'Uranus IV', 'uranus', 761.4, 583511, 13.463237, .002, .1, 17, '#a69a96', 'ice',
    'Obéron est la plus éloignée des cinq grandes lunes d’Uranus. Voyager 2 y a photographié des cratères aux fonds sombres.'],
  ['triton', 'Triton', 'Neptune I', 'neptune', 1352.6, 354800, 5.8792, 0, 157.3, -49, '#cfbbad', 'ice',
    'Triton tourne en sens inverse de la rotation de Neptune. Voyager 2 a observé des panaches sombres s’élevant de sa calotte australe.'],
  ['charon', 'Charon', 'Pluton I', 'pluto', 606, 19600, 6.387222, 0, 0, 67, '#a6a5a7', 'ice',
    'Pluton et Charon présentent toujours la même face l’un à l’autre. Dans cette vue, la trajectoire relative de Charon est centrée sur Pluton.']
];

// Illustrative orientations of the local reference planes in scene coordinates.
// Triton's inclination is applied relative to Neptune's equator. Japet uses a
// local Laplace plane, between Saturn's equator and the heliocentric orbit.
const moonPlanes = {mars: 38, saturn: 28, uranus: 110.77, neptune: 41.32, pluto: 132.6};

function positionAt(center, distance, phaseDegrees, planeDegrees) {
  const phase = phaseDegrees * radians, plane = planeDegrees * radians;
  const along = distance * Math.sin(phase);
  return [center[0] + distance * Math.cos(phase), center[1] + along * Math.sin(plane), center[2] + along * Math.cos(plane)];
}

export function createSolarWorlds({body, AU, existing}) {
  const byId = new Map(existing.map(world => [world.id, world]));
  const sun = byId.get('sun');
  const worlds = minorWorlds.map(([id, name, number, kind, radius, a, years, e, i, spin, phase, color, description]) => {
    const category = kind === 'dwarf' ? 'Planète naine' : 'Astéroïde';
    const distance = a * AU;
    const world = body(id, name, kind, category, '(' + number + ') ' + name, radius,
      positionAt(sun.position, distance, phase, 13), color, description, {
        parentId: 'sun', orbitRadiusKm: distance, orbitPeriodDays: years * julianYear, rotationPeriodHours: spin,
        orbitEccentricity: e, orbitInclinationDeg: i, orbitPlaneTiltDeg: 13, orbitPhaseIllustrative: true,
        solarFamily: 'minor', material: a > 30 ? 'ice' : 'rock', orbitalSourceUrl: sbdb + number,
        sourceUrl: kind === 'dwarf' ? 'https://science.nasa.gov/dwarf-planets/' + id + '/' : sbdb + number,
        ...(id === 'pluto' ? {axialTiltDeg: 119.6} : {}),
        ...(id === 'haumea' ? {sizeSourceUrl: 'https://www.nature.com/articles/nature24051'} : {}),
        ...(id === 'hygiea' ? {sizeSourceUrl: 'https://www.eso.org/public/images/eso1918b/'} : {}),
        ...(id === 'eris' ? {rotationSourceUrl: erisRotation} : {})
      });
    byId.set(id, world);
    return world;
  });
  for (const [id, name, designation, parentId, radius, a, days, e, i, phase, color, material, description] of moons) {
    const parent = byId.get(parentId);
    const plane = moonPlanes[parentId];
    const category = /^[AEÉIOU]/i.test(parent.name) ? 'Lune d’' + parent.name : 'Lune de ' + parent.name;
    // The renderer spins about each moon's own orbit normal. Triton's normal
    // already points retrograde, so synchronous rotation has a positive period.
    worlds.push(body(id, name, 'moon', category, designation, radius, positionAt(parent.position, a, phase, plane),
      color, description, {parentId, orbitRadiusKm: a, orbitPeriodDays: days, rotationPeriodHours: days * 24,
        orbitEccentricity: e, orbitInclinationDeg: i, orbitPlaneTiltDeg: plane, orbitPhaseIllustrative: true,
        solarFamily: 'satellite', material, sourceUrl: satelliteSizes, orbitalSourceUrl: satelliteOrbits}));
  }
  return worlds;
}
