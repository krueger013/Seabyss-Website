// Seasonal Arctic sea ice: https://science.nasa.gov/earth/earth-observatory/sea-ice/
// Ice-sheet water storage: https://science.nasa.gov/earth/explore/earth-indicators/ice-sheets/

const studies = [
  {
    id: 'arctic-summer',
    name: 'Le dégel de l’Arctique',
    description: 'Pars du solstice d’hiver et suis la banquise du nord jusqu’à la fin de l’été. La carte montre la couverture de glace de l’océan autour du pôle.',
    guide: 'Avance de trois quarts d’orbite. Compare la couverture de glace de la mer de Béring et la surface de banquise dans l’hémisphère Nord.',
    years: .75,
    options: {eccentricity:0,perihelionLongitude:0,epochAnomaly:270},
    layer: 'seaIce',
    location: [61,-174]
  },
  {
    id: 'greenland-melt',
    name: 'La calotte du Groenland',
    description: 'Place une Terre simulée à 0,99 UA de son étoile. Suis la réserve de glace continentale du Groenland et la contribution totale des glaces continentales au niveau moyen des océans.',
    guide: 'Avance de trente orbites. Vérifie que la masse de glace du Groenland baisse pendant que le niveau marin moyen calculé monte.',
    years: 30,
    options: {semiMajorAxis:.99},
    layer: 'landIce',
    location: [67.5,-47]
  },
  {
    id: 'cooling-coast',
    name: 'Le retour de la banquise',
    description: 'Éloigne la Terre de son étoile. Dans cet essai, laisse les températures baisser et cherche les mers où la glace peut progresser.',
    guide: 'Avance de huit orbites, puis compare la surface de banquise nord à celle du départ. Le repère est placé sur la mer du Labrador.',
    years: 8,
    options: {semiMajorAxis:1.035},
    layer: 'seaIce',
    location: [60,-55]
  }
];

export const CRYOSPHERE_SCENARIOS = Object.freeze(studies.map(study=>Object.freeze({
  ...study,options:Object.freeze(study.options),location:Object.freeze(study.location)
})));

const delta = (before,current,key) => Number.isFinite(before?.[key]) && Number.isFinite(current?.[key])
  ? current[key]-before[key] : NaN;

export function checkCryosphereObjective(id,before,current) {
  const northIceChange=delta(before,current,'northSeaIceAreaKm2');
  if (id==='arctic-summer') return northIceChange < -500_000;
  if (id==='cooling-coast') return northIceChange > 1_000_000;
  if (id==='greenland-melt') return delta(before,current,'greenlandIceGt') < -3_500 &&
    delta(before,current,'seaLevelMeters') > .01;
  return false;
}
