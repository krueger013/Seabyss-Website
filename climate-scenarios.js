// Orbital reference values follow the USNO description of Earth's seasons.
// https://aa.usno.navy.mil/faq/seasons_orbit
// Ice feedback: https://www.giss.nasa.gov/research/features/201508_slushball/
// Infrared forcing: https://science.nasa.gov/climate-change/faq/what-is-the-greenhouse-effect/
// Polar daylight: https://pmel.noaa.gov/arctic-zone/gallery_np_seasons.html
// Thermal inertia: https://scied.ucar.edu/learning-zone/earth-system/climate-system/transfer-and-storage-heat-oceans
// Earth's geothermal baseline: https://doi.org/10.5194/se-1-5-2010

const northernMidlatitudes = state => Array.isArray(state.bands) && state.bands.find(band => band.latitude >= 52);

const studies = [
  {
    id: 'earth',
    name: 'Terre de référence',
    description: 'Retrouve une inclinaison de 23,44° et une orbite légèrement elliptique. Examine la glace près des pôles et la température de chaque latitude.',
    guide: 'Avance d’une année. Repère sur le globe les bandes gelées et celles qui restent plus chaudes.',
    years: 1,
    options: {},
    goal: (before, now) => now.day - before.day >= 360 && now.iceFraction > .005 && now.iceFraction < .5
  },
  {
    id: 'ice-front',
    name: 'La glace gagne du terrain',
    description: 'Éloigne la Terre à 1,03 UA. Elle reçoit moins d’énergie solaire. La glace formée réfléchit davantage de lumière et amplifie le refroidissement.',
    guide: 'Avance de douze ans et observe si la surface couverte de glace augmente d’au moins 10 points.',
    years: 12,
    options: {semiMajorAxis:1.03},
    goal: (before, now) => now.iceFraction - before.iceFraction >= .1 && now.meanTemperature <= before.meanTemperature - 3
  },
  {
    id: 'greenhouse',
    name: 'Une atmosphère plus isolante',
    description: 'Augmente le CO₂ à 1 680 ppm sur l’orbite de référence. Dans ce modèle, une partie du rayonnement infrarouge est retenue et la surface se réchauffe.',
    guide: 'Observe la hausse de température moyenne et le recul de la glace sur douze ans.',
    years: 12,
    options: {co2:1680},
    goal: (before, now) => now.meanTemperature - before.meanTemperature >= 1.5 && before.iceFraction - now.iceFraction >= .015
  },
  {
    id: 'high-tilt',
    name: 'Le Soleil monte sur l’Arctique',
    description: 'Donne à la Terre une inclinaison de 58° sur une orbite circulaire. L’expérience commence à l’équinoxe et suit la montée du Soleil dans le ciel du Nord.',
    guide: 'Avance d’un trimestre. Le point qui reçoit le Soleil à la verticale doit dépasser 45° de latitude nord.',
    years: .25,
    options: {obliquity:58,eccentricity:0,perihelionLongitude:0,epochAnomaly:0},
    goal: (before, now) => now.day > before.day && now.solarDeclination > 45
  },
  {
    id: 'eccentric',
    name: 'Du plus loin au plus près',
    description: 'Parcours une orbite d’excentricité 0,28 avec un axe droit. La distance à l’étoile passe de 1,28 à 0,72 UA et module l’énergie reçue par les deux hémisphères.',
    guide: 'Avance d’un semestre. Près du point le plus rapproché, le flux reçu par la planète doit dépasser deux fois celui du départ.',
    years: .5,
    options: {eccentricity:.28,obliquity:0,perihelionLongitude:0,epochAnomaly:180},
    goal: (before, now) => now.orbitalDistance < .76 && now.meanInsolation > before.meanInsolation * 2
  },
  {
    id: 'weak-transport',
    name: 'Des pôles plus isolés',
    description: 'Réduis le transfert de chaleur des basses vers les hautes latitudes. Le rayonnement solaire incident reste celui de l’orbite de référence.',
    guide: 'Après douze ans, mesure de combien l’écart entre la bande la plus chaude et la plus froide a augmenté.',
    years: 12,
    options: {heatTransport:.08},
    goal: (before, now) => now.maxTemperature - now.minTemperature >= before.maxTemperature - before.minTemperature + 10
  },
  {
    id: 'dark-ice',
    name: 'Une glace plus sombre',
    description: 'Ramène la réflectivité de la glace à 32 %. À orbite égale, la glace sombre renvoie moins de lumière et laisse davantage d’énergie réchauffer la planète.',
    guide: 'Laisse passer dix orbites. Mesure le recul de la glace après le changement de réflectivité.',
    years: 10,
    options: {iceAlbedo:.32},
    goal: (before, now) => now.meanTemperature >= before.meanTemperature + 1 && now.iceFraction < before.iceFraction - .025
  },
  {
    id: 'geothermal-night',
    name: 'La chaleur des profondeurs',
    description: 'Éclaire très faiblement une planète fictive et impose un flux interne de 40 W/m², bien supérieur à celui de la Terre. Sa surface se refroidit tout en recevant de l’énergie de l’intérieur.',
    guide: 'Avance de six orbites. Vérifie que le flux interne dépasse l’énergie solaire absorbée.',
    years: 6,
    options: {solarLuminosity:.035,geothermalFlux:40},
    goal: (before, now) => now.day - before.day >= 1800 && now.geothermalFlux > now.absorbedFlux && now.meanTemperature < before.meanTemperature
  },
  {
    id: 'polar-night',
    name: 'Les pôles sans Soleil',
    description: 'Pars de l’équinoxe avec une orbite circulaire et un axe incliné de 23,44°. Au solstice d’hiver du Nord, l’Arctique reste dans la nuit, tandis que le Soleil ne se couche plus aux plus hautes latitudes du Sud.',
    guide: 'Avance de trois quarts d’orbite. Sur la carte Ensoleillement, compare les hautes latitudes nord et sud.',
    years: .75,
    options: {eccentricity:0,perihelionLongitude:0,epochAnomaly:0},
    goal: (before, now) => now.solarDeclination < -23 && Array.isArray(now.bands) &&
      now.bands.at(-1)?.insolation === 0 && now.bands[0]?.insolation > 450
  },
  {
    id: 'dry-seasons',
    name: 'L’inertie des océans',
    description: 'Réduis à deux mètres l’épaisseur de la couche océanique qui échange sa chaleur avec l’atmosphère dans le modèle. Sa température change alors plus vite d’une saison à l’autre.',
    guide: 'Va jusqu’au solstice d’été du Nord. Repère la bande vers 54° N et vérifie qu’elle dépasse 15 °C.',
    years: .25,
    options: {eccentricity:0,perihelionLongitude:0,epochAnomaly:0,oceanMixingDepth:2},
    goal: (before, now) => now.solarDeclination > 22 && northernMidlatitudes(now)?.temperature >= 15
  }
];

export const CLIMATE_SCENARIOS = Object.freeze(studies.map(({goal,...scenario}) =>
  Object.freeze({...scenario,options:Object.freeze(scenario.options)})));

export function checkClimateObjective(id,before,current) {
  if (!Number.isFinite(before?.day) || !Number.isFinite(current?.day) || current.day <= before.day) return false;
  return studies.find(study => study.id===id)?.goal(before,current) ?? false;
}
