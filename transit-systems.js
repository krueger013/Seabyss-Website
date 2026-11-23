// Planet parameters and stellar radii from the published solutions tabulated by
// the NASA Exoplanet Archive. SIMBAD supplies ICRS directions at epoch J2000.0.
// Catalogue planets use mean Earth radii; scene units are kilometres.
const archive = 'https://exoplanetarchive.ipac.caltech.edu/overview/';
const simbad = 'https://simbad.cds.unistra.fr/simbad/sim-id?Ident=';
const lightYearsPerParsec = 3.261563777;
const radians = Math.PI / 180;

// Planet rows: suffix, radius (Earth radii), semimajor axis (AU), period (days),
// inclination to the line of sight (deg), model eccentricity, material, colour.
// Zero eccentricity is the circular approximation where the data allow it.
const systems = [
  {
    id: 'hd-209458', name: 'HD 209458', constellation: 'Pégase', spectralType: 'G0 V',
    raHours: 22.05299242, decDegrees: 18.88431928, parsecs: 48.3016, radiusSolar: 1.155, color: '#ffe0b9',
    description: 'Depuis la Terre, une géante gazeuse passe régulièrement devant cette étoile de Pégase. Son transit fait partie des premiers observés autour d’une étoile semblable au Soleil.',
    planets: [
      ['b', 15.23, .04707, 3.524749, 86.71, 0, 'gas', '#ba947b', 'Jupiter chaud',
        'Cette géante accomplit un tour en trois jours et demi. Le rapport entre son rayon et celui de l’étoile explique la baisse de lumière mesurée pendant un transit.']
    ]
  },
  {
    id: 'wasp-39', name: 'WASP-39', constellation: 'Vierge', spectralType: 'G',
    raHours: 14.48844867, decDegrees: -3.44450125, parsecs: 213.982, radiusSolar: .895, color: '#ffdab6',
    description: 'Le transit de sa géante permet de décomposer la lumière qui traverse l’atmosphère planétaire. Différents gaz y laissent des signatures spectrales.',
    planets: [
      ['b', 14.34, .04828, 4.055294, 87.32, 0, 'gas', '#c5a58e', 'Géante gazeuse chaude',
        'Plus large que Jupiter, WASP-39 b possède une atmosphère étendue. Le télescope Webb y a identifié du dioxyde de carbone par spectroscopie de transit.']
    ]
  },
  {
    id: 'gj-1214', name: 'GJ 1214', constellation: 'Ophiuchus', spectralType: 'M4 V',
    raHours: 17.25525944, decDegrees: 4.96390739, parsecs: 14.6427, radiusSolar: .2162, color: '#ffad92',
    description: 'Cette naine rouge a un rayon d’à peine plus d’un cinquième du rayon solaire. Une planète de taille modeste y masque une fraction appréciable du disque.',
    planets: [
      ['b', 2.733, .01505, 1.580405, 88.980, .0062, 'haze', '#ae9391', 'Sous-Neptune',
        'Plus grande que la Terre et plus petite que Neptune, GJ 1214 b passe devant sa petite étoile tous les 1,58 jours. Son aspect rapproché est schématique.']
    ]
  },
  {
    id: 'kepler-10', name: 'Kepler-10', constellation: 'Dragon', spectralType: 'G',
    raHours: 19.04529483, decDegrees: 50.241306, parsecs: 185.506, radiusSolar: 1.065, color: '#ffe1bc',
    description: 'Les transits de deux planètes ont été mesurés autour de cette étoile du Dragon. Leurs périodes orbitales diffèrent d’un facteur supérieur à cinquante.',
    planets: [
      ['b', 1.47, .01685, .8374907, 84.8, 0, 'rock', '#bb8b73', 'Super-Terre rocheuse',
        'La première planète rocheuse confirmée par la mission Kepler boucle son orbite en vingt heures environ. Elle ne masque qu’une très petite partie de l’étoile.'],
      ['c', 2.355, .2410, 45.294301, 89.623, .136, 'rock', '#99979e', 'Exoplanète',
        'Kepler-10 c présente un rayon de 2,36 rayons terrestres et une orbite légèrement elliptique. La vue rapprochée en propose une apparence schématique.']
    ]
  }
];

export function createTransitSystems({body, skyPosition, AU, solarRadius}) {
  const result = [];
  for (const star of systems) {
    const distanceLY = star.parsecs * lightYearsPerParsec;
    const center = skyPosition(distanceLY, star.raHours, star.decDegrees);
    const common = {system: star.name, transitSystem: true};
    const host = body(star.id, star.name, 'star', 'Étoile · ' + star.spectralType, star.name,
      star.radiusSolar * solarRadius, center, star.color, star.description, {
        ...common, parentId: 'milky-way', region: 'Voie lactée · ' + star.constellation,
        distanceLY, radiusSolar: star.radiusSolar, spectralType: star.spectralType, constellation: star.constellation,
        raHours: star.raHours, decDegrees: star.decDegrees, coordinateEpoch: 'J2000.0',
        sourceUrl: archive + encodeURIComponent(star.name), positionSourceUrl: simbad + encodeURIComponent(star.name)
      });
    result.push(host);
    for (const [index, parameters] of star.planets.entries()) {
      const [suffix, radiusEarth, axisAU, days, transitInclinationDeg, eccentricity, material, color, category, description] = parameters;
      const name = star.name + ' ' + suffix;
      // As in the rest of the orbital atlas, starting phases and the ascending
      // node are illustrative. The observed inclination is kept independently
      // for transit photometry; absolute rotations have not been measured here.
      const phase = (36 + index * 134) * radians;
      const axis = axisAU * AU, planeDegrees = 13, along = axis * Math.sin(phase);
      const position = [center[0] + axis * Math.cos(phase), center[1] + along * Math.sin(planeDegrees * radians),
        center[2] + along * Math.cos(planeDegrees * radians)];
      result.push(body(star.id + '-' + suffix, name, 'planet', category, name, radiusEarth * 6371,
        position, color, description, {...common, parentId: host.id, region: 'Système ' + host.name, material,
          lightPosition: host.position, orbitRadiusKm: axis, orbitPeriodDays: days, orbitEccentricity: eccentricity,
          orbitPlaneTiltDeg: planeDegrees, orbitPhaseIllustrative: true, transitInclinationDeg,
          sourceUrl: archive + encodeURIComponent(name)}));
    }
  }
  return result;
}
