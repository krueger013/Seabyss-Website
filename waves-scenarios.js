// Masses dans le référentiel de la source, distance de luminosité en Mpc.
// Les trois études d’observation reprennent les médianes des articles initiaux.
// L’inclinaison et la fréquence de départ servent à la simulation comparative.
const defaults = {inclination:0, startFrequency:25, redshift:0};

export const WAVES_SCENARIOS = Object.freeze([
  {
    id:'gw150914',name:'GW150914 · Première détection',
    description:'LIGO détecte le signal le 14 septembre 2015. Les valeurs centrales publiées sont de 36 et 29 masses solaires, à 410 Mpc. Le tracé simule le rapprochement avant la fusion avec ces paramètres estimés.',
    guide:'Lance la lecture et suis la fréquence. Garde le même départ à 25 Hz, puis passe à GW151226 pour comparer la durée du rapprochement.',
    options:{mass1:36,mass2:29,distanceMpc:410,redshift:.09},
    credit:'LIGO et Virgo, analyse de GW150914',source:'https://dcc.ligo.org/P1500218/public/'
  },
  {
    id:'gw151226',name:'GW151226 · Duo plus léger',
    description:'Le signal détecté le 26 décembre 2015 correspond selon les estimations à deux trous noirs de 14,2 et 7,5 masses solaires à 440 Mpc. Le modèle calcule leur rapprochement jusqu’à sa fréquence de coupure.',
    guide:'Compare la durée et la fréquence finale à celles de GW150914. Une masse totale plus faible permet dans ce modèle d’atteindre une fréquence plus haute avant la coupure.',
    options:{mass1:14.2,mass2:7.5,distanceMpc:440,redshift:.09},
    credit:'LIGO et Virgo, article de découverte de GW151226',source:'https://dcc.ligo.org/P151226/public/'
  },
  {
    id:'gw170814',name:'GW170814 · Trois détecteurs',
    description:'Le 14 août 2017, les deux détecteurs LIGO et celui de Virgo mesurent le signal. Le scénario reprend les valeurs centrales de 30,5 et 25,3 masses solaires à 540 Mpc pour calculer le rapprochement.',
    guide:'Place le curseur près de la fin et compare la fréquence et la séparation. Les tracés utilisent la même orientation de départ pour faciliter la comparaison.',
    options:{mass1:30.5,mass2:25.3,distanceMpc:540,redshift:.11},
    credit:'LIGO et Virgo, article de découverte de GW170814',source:'https://dcc.ligo.org/P170814/public/'
  },
  {
    id:'distance',name:'Une source deux fois plus loin',
    description:'Deux trous noirs fictifs de 30 et 20 masses solaires se rapprochent. Le scénario commence à une distance de luminosité de 100 Mpc et isole son effet sur le signal.',
    guide:'Passe de 100 à 200 Mpc. Lis l’amplitude en chiffres au même instant du signal. Elle est divisée par deux tandis que sa durée reste la même.',
    options:{mass1:30,mass2:20,distanceMpc:100}
  },
  {
    id:'inclination',name:'Une binaire vue par la tranche',
    description:'Observe le même type de duo fictif en regardant dans le plan de son orbite. Dans ce modèle, cette orientation annule la polarisation croisée.',
    guide:'Fais varier l’inclinaison de 90° à 0°. Compare la déformation au début du signal. Elle double et la fréquence suit le même trajet.',
    options:{mass1:30,mass2:20,distanceMpc:100,inclination:90}
  }
].map(scenario => Object.freeze({...scenario, options:Object.freeze({...defaults,...scenario.options})})));
