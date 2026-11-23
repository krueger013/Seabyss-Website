const defaults = Object.freeze({massSolar:10,radius:5,impact:2.75,startRadius:8,stopRadius:1,clockType:'hover'});

const cases = [
  {
    id:'clock-redshift',name:'Deux horloges',mode:'clock',radius:1.25,
    description:'Une horloge est maintenue près de l’horizon. Une deuxième sert de référence très loin du trou noir.',
    guide:'Compare le temps écoulé à 1,25 puis à 8 rayons de Schwarzschild, pour une même minute mesurée au loin.'
  },
  {
    id:'photon-capture',name:'La frontière des photons',mode:'light',impact:2.75,
    description:'Un rayon passe près de la sphère des photons. Sa trajectoire dépend du paramètre d’impact, le décalage de départ vu de très loin.',
    guide:'Lance le rayon à 2,75 rayons de Schwarzschild, puis ramène le paramètre à 2,55. Observe la différence entre une trajectoire déviée et une capture.'
  },
  {
    id:'last-stable-orbit',name:'La dernière orbite stable',mode:'clock',radius:3.2,clockType:'orbit',
    description:'La sonde suit une orbite circulaire. Sa vitesse et la gravité modifient toutes deux le rythme de son horloge.',
    guide:'Compare une orbite à 3,2 rayons de Schwarzschild avec une à 2,7. Le repère à 3 rayons indique la limite de stabilité.'
  },
  {
    id:'radial-fall',name:'Chute vers l’horizon',mode:'fall',
    description:'La sonde est lâchée sans vitesse initiale à 8 rayons de Schwarzschild, puis tombe en ligne radiale.',
    guide:'Lance la chute. Compare le temps fini mesuré par la sonde à l’horizon avec le temps de Schwarzschild, qui augmente sans limite à l’approche de ce point.'
  },
  {
    id:'sagittarius-a',name:'Sagittarius A*',mode:'fall',massSolar:4e6,destinationId:'milky-way',
    description:'Le trou noir au centre de la Voie lactée a une masse estimée à environ quatre millions de Soleils. La simulation reprend cette masse dans une géométrie de Schwarzschild.',
    guide:'Refais la chute depuis 8 rayons de Schwarzschild. Compare la durée à bord avec celle du scénario à dix masses solaires.',
    credit:'Event Horizon Telescope Collaboration, 2022',
    source:'https://eventhorizontelescope.org/publications/first-sagittarius-event-horizon-telescope-results-i-shadow-supermassive-black-hole'
  },
  {
    id:'m87-star',name:'M87*',mode:'light',massSolar:6.5e9,destinationId:'m87',
    description:'Le trou noir au centre de Messier 87 a une masse estimée à 6,5 milliards de Soleils. La simulation utilise cette masse et la géométrie de Schwarzschild.',
    guide:'Compare le rayon de l’horizon à celui de Sagittarius A*, puis lance un rayon de part et d’autre du seuil de capture. Le seuil exprimé en rayons de Schwarzschild reste le même.',
    credit:'Event Horizon Telescope Collaboration, 2019',
    source:'https://eventhorizontelescope.org/press-release-april-10-2019-astronomers-capture-first-image-black-hole'
  },
  {
    id:'ton-618',name:'TON 618',mode:'fall',massSolar:4.07e10,
    description:'Le spectre du quasar TON 618 permet d’estimer la masse de son trou noir. Cette expérience prend environ 40,7 milliards de masses solaires comme ordre de grandeur.',
    guide:'Lâche la sonde depuis 8 rayons de Schwarzschild. Compare son temps à bord à celui d’une chute depuis le même repère autour de Sagittarius A*.',
    credit:'Ge et ses collègues, The Astronomical Journal, 2019',
    source:'https://arxiv.org/abs/1903.08830'
  }
];

export const RELATIVITY_SCENARIOS = Object.freeze(cases.map(scenario=>Object.freeze({...defaults,...scenario})));
