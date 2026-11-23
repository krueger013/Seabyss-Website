import { G } from './sandbox-physics.js';
import { measureOrbit } from './sandbox-analysis.js';

const AU_KM = 149597870.7;
const EARTH_MASS = 3.00349e-6;
const MOON_MASS = 3.6943e-8;
const TURN = 2 * Math.PI;
const zero = () => [0, 0, 0];
const body = (id, name, kind, color, mass, radiusKm, position = zero(), velocity = zero()) =>
  ({id, name, kind, color, mass, radius: radiusKm / AU_KM, position, velocity});

// Each scene starts in its barycentric inertial frame. Rendering may follow
// any member of the scene without assigning it infinite mass in the solver.
function balance(bodies) {
  const total = bodies.reduce((sum, item) => sum + item.mass, 0);
  for (const field of ['position', 'velocity']) {
    for (let axis = 0; axis < 3; axis++) {
      const center = bodies.reduce((sum, item) => sum + item.mass * item[field][axis], 0) / total;
      for (const item of bodies) item[field][axis] -= center;
    }
  }
  return bodies;
}

// Keplerian initial conditions only; all subsequent motion comes from the
// live N-body solver. The phase is the eccentric anomaly in radians.
function orbit(item, parent, a, phase, { eccentricity = 0, tilt = 0 } = {}) {
  const c = Math.cos(phase), s = Math.sin(phase), b = Math.sqrt(1 - eccentricity ** 2);
  const speed = Math.sqrt(G * (parent.mass + item.mass) / a) / (1 - eccentricity * c);
  const offset = [a * (c - eccentricity), a * s * b * Math.sin(tilt), a * s * b * Math.cos(tilt)];
  const tangent = [-speed * s, speed * c * b * Math.sin(tilt), speed * c * b * Math.cos(tilt)];
  item.position = parent.position.map((x, axis) => x + offset[axis]);
  item.velocity = parent.velocity.map((x, axis) => x + tangent[axis]);
  return item;
}

function solar() {
  // Rounded physical scales from JPL Physical Parameters, NASA's Moon Fact
  // Sheet and IAU's astronomical unit. This is an illustrative starting epoch.
  // https://ssd.jpl.nasa.gov/planets/phys_par.html
  // https://ssd.jpl.nasa.gov/astro_par.html
  // https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html
  const sun = body('sun','Soleil','star','#ffe2ab',1,695700);
  const earth = body('earth','Terre','planet','#67afff',EARTH_MASS,6371);
  const moon = body('moon','Lune','moon','#c3cbd6',MOON_MASS,1737.4);
  orbit(earth,sun,1,.56,{eccentricity:.0167});
  orbit(moon,earth,384400/AU_KM,.87,{eccentricity:.0549,tilt:5.145*Math.PI/180});
  return balance([sun,earth,moon]);
}

function binary() {
  const gold = body('ambre','Ambre','star','#ffbb76',.64,486000);
  const blue = body('azur','Azur','star','#d1e9ff',1.13,842000);
  orbit(blue,gold,.46,1.13);
  balance([gold,blue]);
  const center = {mass:gold.mass+blue.mass, position:zero(), velocity:zero()};
  const world = orbit(body('circumbinary','Iride','planet','#62d5c9',3.8*EARTH_MASS,9800),center,1.48,-.46,{tilt:.09});
  return balance([gold,blue,world]);
}

function comet() {
  const star = body('solis','Solis','star','#ffd896',1,695700);
  const nucleus = orbit(body('iris','Iris','comet','#a6e8fa',1e-15,3.1),star,.90,-1.0,{eccentricity:.82,tilt:.19});
  const ochre = orbit(body('ochre','Ocre','planet','#e6a875',2.4*EARTH_MASS,8600),star,.72,1.31,{tilt:.05});
  return balance([star,nucleus,ochre]);
}

function collision() {
  const basalt = body('basalte','Basalte','planet','#e28e5c',.84*EARTH_MASS,6000);
  const opal = body('opale','Opale','planet','#73cbd0',.37*EARTH_MASS,4530,
    [.0017,.000035,.000107],[-.00115,0,0]);
  return balance([basalt,opal]);
}

function resonance() {
  const star = body('braise','Braise','star','#fe855f',.11,91000);
  const series = [
    ['cendre','Cendre','#f0ae8b',.72,5100,.10],
    ['ambre-b','Silex','#d29f85',1.14,6690,1.68],
    ['sienne','Sienne','#df784d',.91,6100,3.47],
    ['nacre','Nacre','#abe2df',1.25,7020,4.71],
    ['jade','Jade','#7bca8f',1.10,6510,5.91]
  ];
  const planets = series.map(([id,name,color,mass,radius,phase],i) => {
    const planet = body(id,name,'planet',color,mass*EARTH_MASS,radius);
    const period = 4 * 1.5 ** i;
    const a = Math.cbrt(G*(star.mass+planet.mass)*(period/TURN)**2);
    return orbit(planet,star,a,phase,{tilt:.009*i});
  });
  return balance([star,...planets]);
}

function encounter() {
  const sun = body('phare','Phare','star','#fff0ca',.97,674000);
  const giant = orbit(body('geant','Borée','planet','#8eb9df',.000955,69911),sun,1.55,0);
  const particle = body('sonde','Éclat','comet','#e7e6ba',1e-15,2.5,
    [giant.position[0]-.055,.0009,-.011],[.005,0,giant.velocity[2]]);
  return balance([sun,giant,particle]);
}

function shatter() {
  const vesper=body('vesta','Vesper','planet','#d08155',.07*EARTH_MASS,3180);
  const ignis=body('ignis','Ignis','planet','#83cee2',.06*EARTH_MASS,2840,
    [.0105,.000025,-.000019],[-.0083,0,0]);
  return balance([vesper,ignis]);
}

function rings() {
  const giant=body('aronde','Aronde','planet','#84bdcc',.00026,52200);
  const particles=Array.from({length:18},(_,i)=>{
    const band=Math.floor(i/6), sector=i%6;
    const phase=sector*TURN/6+band*.26;
    const palette=['#9bc6d4','#b4eeea','#bba8d0'];
    const pebble=body('ring-'+i,'Glace '+(i+1),'asteroid',palette[band],4e-13,85+band*12);
    return orbit(pebble,giant,.00135+band*.00030,phase,{eccentricity:.018,tilt:.10+band*.05});
  });
  const inner=orbit(body('rill','Rill','moon','#e2ccbc',1e-9,550),giant,.00106,-.85,{tilt:.12});
  const outer=orbit(body('alite','Alite','moon','#a8cfe9',4e-9,920),giant,.0027,.45,{tilt:.21});
  return balance([giant,inner,outer,...particles]);
}

const EIGHT_RADIUS=.245;

function figureEight() {
  // Simó's initial conditions, scaled to solar masses, AU and days.
  // https://people.ucsc.edu/~rmont/NbdyB.html
  const mass=.60;
  const velocityScale=Math.sqrt(G*mass/EIGHT_RADIUS);
  const first=[-.97000436,.24308753], middleVelocity=[.93240737,.86473146];
  const points=[
    ['huit-aube','Aube','#ffd1a7',first,-.5],
    ['huit-nacre','Perle','#b5daff',first.map(n=>-n),-.5],
    ['huit-sillage','Sillage','#e8baff',[0,0],1]
  ];
  return balance(points.map(([id,name,color,[x,z],factor])=>body(id,name,'star',color,mass,450000,
    [x*EIGHT_RADIUS,0,z*EIGHT_RADIUS],[middleVelocity[0]*factor*velocityScale,0,middleVelocity[1]*factor*velocityScale])));
}

function retrograde() {
  const giant=body('saros','Saros','planet','#a597d8',.0013,72000);
  const forward=orbit(body('thalie','Thalie','moon','#ffc493',5e-9,1010),giant,.00153,.62,{tilt:.10});
  const reverse=orbit(body('nereis','Néréïs','moon','#94def0',3e-9,840),giant,.00242,-.70,{tilt:.35});
  reverse.velocity=reverse.velocity.map((v,i)=>2*giant.velocity[i]-v);
  return balance([giant,forward,reverse]);
}

function escape() {
  const star=body('ancre','Ancre','star','#ffdba3',.88,655000);
  const bound=orbit(body('attache','Attache','planet','#93c9fb',.6*EARTH_MASS,5100),star,.42,2.95);
  const stray=body('fugace','Fugace','asteroid','#eab791',5e-12,110,[.42,0,0],
    [0,0,1.23*Math.sqrt(2*G*star.mass/.42)]);
  return balance([star,bound,stray]);
}

function trojans() {
  // Original compact system illustrating the Jupiter Trojans' equilateral geometry.
  // https://www.nasa.gov/missions/nasas-lucy-in-the-sky-with-asteroids/
  const star=body('lanterne','Lanterne','star','#ffe1a3',.90,672000);
  const giant=orbit(body('patrouille','Patrouille','planet','#cfac8f',.001,71500),star,.82,0);
  balance([star,giant]);
  const orbitCenter={mass:star.mass+giant.mass,position:star.position,velocity:star.velocity};
  const particles=Array.from({length:40},(_,index)=>{
    const side=index<20 ? 1 : -1;
    const group=side>0 ? 'a' : 'b';
    const offset=index%20;
    const phase=side*Math.PI/3+(offset%5-2)*.055+Math.floor(offset/5)*.011;
    const separation=.82+(Math.floor(offset/5)-1.5)*.003;
    const asteroid=body('trojan-'+group+'-'+offset,(side>0?'Avant ':'Arrière ')+(offset+1),'asteroid',
      side>0?'#a4e5c9':'#d5acf1',3e-14,24+(offset%5)*8);
    return orbit(asteroid,orbitCenter,separation,phase,{tilt:(offset%4-1.5)*.022});
  });
  return balance([star,giant,...particles]);
}

function whiteDwarf() {
  // Illustrative Newtonian system with white-dwarf scale.
  // https://science.nasa.gov/missions/hubble/measuring-a-white-dwarf-star/
  const star=body('perle-blanche','Perle blanche','star','#d9efff',.62,8200);
  const inner=orbit(body('carillon','Carillon','planet','#bcb494',7e-9,960),star,.0094,.19,{eccentricity:.12,tilt:.13});
  const outer=orbit(body('nuit','Nuit','planet','#8a85bc',1.4e-8,1610),star,.0142,2.43,{tilt:.23});
  return balance([star,inner,outer]);
}

function ricochet() {
  const echo=body('echo','Écho','moon','#a0e0eb',.06*EARTH_MASS,1700);
  const mica=body('mica','Mica','asteroid','#f1bb6d',.05*EARTH_MASS,1450,
    [.0069,0,.000014],[-.0066,0,0]);
  return balance([echo,mica]);
}

function rochePass() {
  const giant=body('porte-de-glace','Porte de glace','planet','#96c8ec',.0012,72500);
  const ice=orbit(body('craie','Craie','moon','#e3f5ee',1.5e-8,1950),giant,.00134,Math.PI,{eccentricity:.44,tilt:.12});
  const sentinel=orbit(body('veilleur','Veilleur','moon','#e2a877',3.5e-9,630),giant,.00265,.80,{tilt:.19});
  return balance([giant,ice,sentinel]);
}

function shockDuel() {
  const slow=body('choc-ambre','Ambre rouge','planet','#f1a367',2.10e-7,3180,[0,0,-.0028]);
  const slowPartner=body('choc-granit','Granit','planet','#c9a291',1.80e-7,2840,
    [.00043,.0000015,-.002795],[-.00013,0,0]);
  const fast=body('choc-lazuli','Lazuli','planet','#529fde',2.10e-7,3180,[0,0,.0028]);
  const fastPartner=body('choc-verre','Verre bleu','planet','#7fdbdf',1.80e-7,2840,
    [.0076,.000011,.002786],[-.0076,0,0]);
  return balance([slow,slowPartner,fast,fastPartner]);
}

function eccentricTwins() {
  const star=body('orbe-des-jumeaux','Méridien','star','#ffcc95',.92,659000);
  const circle=orbit(body('cadence','Cadence','planet','#82c5ed',.45*EARTH_MASS,4800),star,.35,.40);
  const ellipse=orbit(body('elan','Élan','planet','#efa578',.45*EARTH_MASS,4800),star,.35,Math.PI,{eccentricity:.58,tilt:.32});
  return balance([star,circle,ellipse]);
}

function moonExchange() {
  // Fictional satellites inspired by the orbital exchange of Janus and Epimetheus.
  // https://science.nasa.gov/resource/janus-epimetheus-swing/
  const primary=body('harmonie','Harmonie','planet','#ddbcaa',.00040,55000);
  const inner=orbit(body('satin','Satin','moon','#d4a8ec',1.8e-8,1500),primary,.0034*(1-.023/2),0);
  const outer=orbit(body('cobalt','Cobalt','moon','#9be0f3',1.242e-8,1300),primary,.0034*(1+.023/2),.20);
  return balance([primary,inner,outer]);
}

function stellarTransit() {
  const host=body('havre','Havre','star','#ffcf96',.80,580000);
  const visitor=body('traverse','Traverse','star','#f099a3',.56,432000,[-3.6,0,.62],[.045,0,0]);
  const inner=orbit(body('veille','Veille','planet','#d9ad84',1e-6,4900),host,.31,Math.PI);
  const outer=orbit(body('lisiere','Lisière','planet','#8ec3ff',2e-6,5900),host,1.15,Math.PI/2);
  return balance([host,visitor,inner,outer]);
}

function custom() {
  return [body('helios','Hélios','star','#ffdfab',1,695700)];
}

const initialConditions = {solar,binary,comet,collision,resonance,encounter,shatter,rings,custom,
  'figure-eight':figureEight,retrograde,escape,trojans,'white-dwarf':whiteDwarf,ricochet,
  'roche-pass':rochePass,'shock-duel':shockDuel,'eccentric-twins':eccentricTwins,
  'moon-exchange':moonExchange,'stellar-transit':stellarTransit};

export const SANDBOX_SCENARIOS = [
  {id:'roche-pass',name:'La traversée de Roche',caption:'Craie frôle la géante Porte de glace. Le modèle de marée peut disloquer cette lune peu dense dès qu’elle s’approche trop. Veilleur poursuit son orbite au large.',rate:.062,span:.0064,focusId:'porte-de-glace',guide:'Observer une rupture de marée',tidesEnabled:true},
  {id:'shock-duel',name:'Deux régimes de choc',caption:'Deux paires de corps de mêmes masses se percutent à des vitesses différentes. Observe le résultat de chaque choc en mode Fragmentation, puis compare avec Rebond ou Fusion.',rate:.26,span:.013,focusId:'',guide:'Comparer les énergies d’impact',collisionMode:'fragment'},
  {id:'eccentric-twins',name:'Deux orbites, une année',caption:'Cadence et Élan partent sur des orbites de même demi-grand axe. Suis le changement de vitesse d’Élan au cours de son année autour de Méridien.',rate:6.5,span:1.18,focusId:'orbe-des-jumeaux',guide:'Mesurer les deux extrêmes d’Élan'},
  {id:'moon-exchange',name:'L’échange des lunes',caption:'Satin rattrape Cobalt autour d’Harmonie. Leur attraction peut échanger l’orbite intérieure et l’orbite extérieure, comme pour Janus et Épiméthée autour de Saturne.',rate:.46,span:.0082,focusId:'harmonie',guide:'Mesurer un changement d’orbite'},
  {id:'stellar-transit',name:'Le passage des étoiles',caption:'Traverse arrive près du système de Havre. Compare la trajectoire de Veille, la planète intérieure, à celle de Lisière, qui passe bien plus près de l’étoile de passage.',rate:14,span:8.0,focusId:'havre',guide:'Mesurer une éjection gravitationnelle'},
  {id:'solar',name:'Terre, Lune et Soleil',caption:'Suis la Lune à sa vraie distance de la Terre. Le Soleil exerce aussi son attraction depuis la limite du champ.',rate:2,span:.012,focusId:'earth',guide:'Le mois lunaire'},
  {id:'binary',name:'Sous deux soleils',caption:'Ambre et Azur tournent autour de leur centre de masse. Plus loin, Iride décrit sa route autour du couple.',rate:6,span:3.9,focusId:'',guide:null},
  {id:'comet',name:'Le virage de la comète',caption:'Iris fonce vers Solis. Compare son mouvement avant et après son passage au plus près de l’étoile.',rate:4,span:1.65,focusId:'solis',guide:'Le passage d’Iris'},
  {id:'collision',name:'Impact de deux mondes',caption:'Opale et Basalte arrivent de biais. Le choc les rassemble en un corps dont la masse et le mouvement proviennent des deux protoplanètes.',rate:.30,span:.0045,focusId:'',guide:'Après l’impact'},
  {id:'resonance',name:'La chaîne de Braise',caption:'Cinq mondes fictifs entourent une naine rouge. Les périodes de départ se succèdent dans un rapport de trois à deux, inspiré des systèmes compacts.',rate:.8,span:.21,focusId:'braise',guide:null},
  {id:'encounter',name:'Fronde gravitationnelle',caption:'Depuis Borée, suis la courbe de l’infime Éclat. Il arrive derrière la géante et sa direction change au passage.',rate:1.8,span:.20,focusId:'geant',guide:null},
  {id:'shatter',name:'L’éclatement de Vesper',caption:'Ignis percute Vesper à grande vitesse. Une partie de la masse s’échappe en fragments que tu peux suivre et sélectionner. Le menu de collisions permet de comparer avec une fusion complète.',rate:.5,span:.030,focusId:'vesta',guide:null,collisionMode:'fragment'},
  {id:'rings',name:'Les anneaux d’Aronde',caption:'Dix-huit blocs de glace et deux lunes orbitent autour d’Aronde. Modifie la masse de la géante ou la vitesse d’une lune pour observer la réaction des anneaux.',rate:.16,span:.0068,focusId:'aronde',guide:null},
  {id:'figure-eight',name:'La ronde en huit',caption:'Trois étoiles de même masse se poursuivent sur la même courbe. Change la vitesse de l’une d’elles pour transformer la ronde.',rate:6.5,span:.63,focusId:'huit-sillage',guide:'Parcourir les deux boucles'},
  {id:'retrograde',name:'Lunes à contre-courant',caption:'Thalie et Néréïs tournent autour de Saros dans des sens opposés. Suis les deux tracés et mesure un tour de Néréïs.',rate:.15,span:.0063,focusId:'saros',guide:'La révolution rétrograde'},
  {id:'escape',name:'La vitesse de libération',caption:'Attache et Fugace partent à la même distance d’Ancre. La vitesse initiale de Fugace lui permet de quitter le système.',rate:1.2,span:1.72,focusId:'ancre',guide:'Repérer une orbite ouverte'},
  {id:'trojans',name:'Les essaims troyens',caption:'Quarante astéroïdes partagent l’orbite de Patrouille. Les deux essaims commencent à environ 60° en avant et en arrière de la géante.',rate:13.5,span:2.4,focusId:'lanterne',guide:null},
  {id:'white-dwarf',name:'Une année en quelques heures',caption:'Observe Carillon dans un système fictif autour d’une naine blanche. Le rayon et la masse de l’étoile suivent les ordres de grandeur de ces astres.',rate:.036,span:.037,focusId:'perle-blanche',guide:'Mesurer l’année de Carillon'},
  {id:'ricochet',name:'Le choc d’Écho',caption:'Mica arrive en biais au contact d’Écho. Le réglage Rebond laisse les deux astres repartir. Reviens avant le contact et essaie Fusion.',rate:.30,span:.016,focusId:'',guide:null,collisionMode:'bounce'},
  {id:'custom',name:'Système libre',caption:'Hélios est seule. Place une planète, choisis sa vitesse de lancement et regarde l’orbite que tu viens de créer.',rate:3,span:2.8,focusId:'helios',guide:null}
];

export const BODY_PRESETS = [
  {id:'rock', name:'Planète rocheuse', kind:'planet', color:'#77bfea', mass:EARTH_MASS, radius:6371/AU_KM},
  {id:'giant', name:'Géante gazeuse', kind:'planet', color:'#e4ad79', mass:.000955, radius:69911/AU_KM},
  {id:'moon', name:'Lune', kind:'moon', color:'#c4c9d8', mass:MOON_MASS, radius:1737.4/AU_KM},
  {id:'comet', name:'Comète', kind:'comet', color:'#a9e6e9', mass:1e-15, radius:3.1/AU_KM},
  {id:'star', name:'Étoile', kind:'star', color:'#ffe1aa', mass:1, radius:695700/AU_KM}
];

export function createScenario(id) {
  const scene = SANDBOX_SCENARIOS.find(item => item.id === id);
  return scene ? {...scene,bodies:initialConditions[id]()} : null;
}

const guides = {
  'roche-pass': [
    ['L’approche de Craie','Active Marées et laisse Craie s’approcher de la géante.'],
    ['Trajectoire d’un éclat','Sélectionne un éclat de Craie pour suivre son mouvement après la rupture.'],
    ['Rupture observée','Craie est passée sous le seuil du modèle de marée avant de toucher la géante.']
  ],
  'shock-duel': [
    ['Le choc entre Ambre rouge et Granit','Choisis Fragmentation et laisse les deux astres se rejoindre.'],
    ['Le choc entre Lazuli et Verre bleu','Observe le deuxième impact et compare son énergie à celle du premier.'],
    ['Énergies comparées','Le choc rapide a projeté des éclats. Avant le contact, son énergie cinétique dans le référentiel du centre de masse valait plus de huit fois celle du premier choc.']
  ],
  'eccentric-twins': [
    ['La planète Élan','Sélectionne Élan. La mesure commence quand elle est à plus de 0,52 UA de Méridien.'],
    ['Au plus près de Méridien','Suis Élan jusqu’à moins de 0,16 UA. Sa vitesse dépasse alors largement celle de Cadence.'],
    ['Retour au plus loin','Attends qu’Élan revienne à plus de 0,52 UA, où elle se déplace plus lentement que Cadence.'],
    ['Une année en ellipse','Au cours d’un tour, Élan a dépassé 1,8 fois la vitesse de Cadence près de l’étoile, puis est retombée sous 60 % de cette vitesse loin de l’étoile.']
  ],
  'moon-exchange': [
    ['Les deux orbites','Compare leurs demi-grands axes autour d’Harmonie, la planète centrale.'],
    ['Le rapprochement','Observe Satin rattraper Cobalt. L’attraction des deux lunes modifie leur demi-grand axe.'],
    ['Les lunes s’éloignent','Sélectionne Satin ou Cobalt et compare leurs orbites après leur rapprochement.'],
    ['Orbites échangées','Satin a pris l’orbite extérieure et Cobalt l’orbite intérieure. Les lunes poursuivent leur course autour d’Harmonie.']
  ],
  'stellar-transit': [
    ['L’approche de Traverse','Observe les étoiles se rapprocher jusqu’à moins de 0,55 UA.'],
    ['Éloignement de Lisière','Sélectionne Lisière et compare son mouvement à celui de Veille, restée près de Havre.'],
    ['Éjection mesurée','Lisière s’éloigne de Havre avec une énergie orbitale positive relative aux deux étoiles. Veille reste liée à Havre.']
  ],
  solar: [
    ['Repérer la Lune','Sélectionne la Lune pour commencer la mesure de son trajet autour de la Terre.'],
    ['Un demi-tour','Laisse avancer le temps. La ligne Terre–Lune doit balayer un demi-tour depuis ta sélection.'],
    ['Une révolution','Poursuis jusqu’au retour de la Lune dans la direction initiale.'],
    ['Révolution observée','La direction Terre–Lune a balayé un tour complet depuis ta sélection.']
  ],
  comet: [
    ['Suivre Iris','Sélectionne Iris, le petit noyau bleu qui se dirige vers Solis.'],
    ['Franchir 0,24 UA','Observe Iris entrer à moins de 0,24 unité astronomique du centre de Solis.'],
    ['Repartir au large','Suis la comète jusqu’à ce que sa distance dépasse de nouveau 0,33 UA.'],
    ['Passage observé','Iris a franchi le seuil intérieur, tourné près de Solis et repris de la distance.']
  ],
  collision: [
    ['Attendre le contact','Choisis Fusion dans le menu des collisions, puis guette le contact entre Basalte et Opale.'],
    ['Examiner le résultat','Mets le temps en pause et sélectionne le corps issu de la fusion pour l’examiner.'],
    ['Fusion observée','Le choc a réuni les deux masses. Le corps sélectionné suit leur mouvement commun.']
  ],
  'figure-eight': [
    ['Repérer Sillage','Sélectionne Sillage, l’étoile violette au départ près du centre.'],
    ['La première boucle','Laisse Sillage entrer dans la boucle à droite du centre de masse.'],
    ['La deuxième boucle','Attends que Sillage atteigne l’autre boucle.'],
    ['Retour au centre','Suis Sillage jusqu’à ce que sa trajectoire recroise le centre.'],
    ['Les deux boucles observées','Sillage est revenue au centre après avoir parcouru les deux côtés.']
  ],
  retrograde: [
    ['Trouver Néréïs','Sélectionne la lune bleue Néréïs et garde Saros dans le champ.'],
    ['Le premier demi-tour','Observe Néréïs tourner autour de Saros en sens inverse de Thalie.'],
    ['Terminer le tour','Laisse Néréïs poursuivre sa course jusqu’à la direction de départ.'],
    ['Révolution rétrograde observée','La direction Saros–Néréïs a tourné de 360° en sens inverse de Thalie.']
  ],
  escape: [
    ['Suivre Fugace','Sélectionne Fugace. Compare son mouvement à celui de la planète Attache.'],
    ['Observer l’éloignement','Laisse avancer Fugace au-delà de 0,58 UA, tout en suivant sa trajectoire.'],
    ['Fugace quitte le voisinage','Attends que Fugace dépasse 0,84 UA tout en continuant à s’éloigner.'],
    ['Orbite ouverte mesurée','Fugace s’éloigne et son énergie orbitale relative à Ancre reste positive.']
  ],
  'white-dwarf': [
    ['Repérer Carillon','Sélectionne la planète intérieure Carillon, près de Perle blanche.'],
    ['Observer le demi-tour','Laisse Carillon faire un demi-tour autour de Perle blanche.'],
    ['Mesurer un tour complet','Garde la planète dans le champ jusqu’au retour dans la direction initiale.'],
    ['Une année observée','La direction Perle blanche–Carillon a parcouru 360°.']
  ]
};
const clamp01 = n => Math.max(0,Math.min(1,n));
const resetState = () => ({step:0,lastDay:0,angle:null,arc:0,inner:false,survivor:null});

function measuredRevolution(state,primary,secondary,selectedId,direction) {
  if (!primary || !secondary) return 0;
  const angle=Math.atan2(secondary.position[2]-primary.position[2],secondary.position[0]-primary.position[0]);
  if (state.step===0 && selectedId===secondary.id) {state.step=1;state.angle=angle;}
  if (state.step===0 || state.step>=3) return 0;
  const change=angle-state.angle;
  state.arc=Math.max(0,state.arc+direction*Math.atan2(Math.sin(change),Math.cos(change)));
  state.angle=angle;
  // Adjust the step from the signed arc. Reversing the orbit must not
  // complete the requested prograde or retrograde revolution.
  state.step=state.arc>=TURN ? 3 : state.arc>=Math.PI ? 2 : 1;
  return state.step===1 ? clamp01(state.arc/Math.PI) : clamp01((state.arc-Math.PI)/Math.PI);
}

function measuredEight(state,sim,selectedId) {
  const stars=sim.bodies.filter(b=>b.id.startsWith('huit-'));
  const tracked=stars.find(b=>b.id==='huit-sillage');
  if (stars.length!==3 || !tracked) return 0;
  if (state.step===0 && selectedId===tracked.id) state.step=1;
  if (state.step===0 || state.step>=4) return 0;
  const mass=stars.reduce((sum,b)=>sum+b.mass,0);
  const relative=tracked.position.map((value,axis)=>
    value-stars.reduce((sum,b)=>sum+b.position[axis]*b.mass,0)/mass);
  if (state.step===1 && relative[0]>.8*EIGHT_RADIUS) state.step=2;
  else if (state.step===2 && relative[0]<-.8*EIGHT_RADIUS) state.step=3;
  else if (state.step===3 && Math.hypot(...relative)<.10*EIGHT_RADIUS) state.step=4;
  if (state.step===1) return clamp01(relative[0]/(.8*EIGHT_RADIUS));
  if (state.step===2) return clamp01((.8*EIGHT_RADIUS-relative[0])/(1.6*EIGHT_RADIUS));
  return clamp01(1-Math.hypot(...relative)/EIGHT_RADIUS);
}

function measuredEscape(state,star,stray,selectedId) {
  if (!star || !stray) return 0;
  const offset=stray.position.map((x,i)=>x-star.position[i]);
  const velocity=stray.velocity.map((x,i)=>x-star.velocity[i]);
  const distance=Math.hypot(...offset);
  const energy=velocity.reduce((sum,v)=>sum+v*v/2,0)-G*(star.mass+stray.mass)/distance;
  const movingAway=offset.reduce((sum,x,i)=>sum+x*velocity[i],0)>0;
  if (state.step===0 && selectedId===stray.id) state.step=1;
  if (state.step===1 && distance>.58 && energy>0) state.step=2;
  if (state.step===2 && distance>.84 && energy>0 && movingAway) state.step=3;
  if (state.step===1) return clamp01((distance-.42)/.16);
  if (state.step===2) return clamp01((distance-.58)/.26);
  return 0;
}

function measuredRoche(state,sim,selectedId) {
  const rupture=sim.events.find(e=>e.type==='tidal' && e.bodyIds[0]==='porte-de-glace' &&
    e.bodyIds[1]==='craie' && e.fragmentIds?.length && e.distance<e.rocheRadius);
  if (!rupture) return 0;
  if (state.step===0) state.step=1;
  if (rupture.fragmentIds.includes(selectedId)) state.step=2;
  return 0;
}

function measuredShocks(state,sim) {
  const slow=sim.events.find(e=>e.type==='collision' && e.survivorId &&
    e.bodyIds.includes('choc-ambre') && e.bodyIds.includes('choc-granit') && !e.fragmentIds?.length);
  const fast=sim.events.find(e=>e.type==='collision' && e.fragmentIds?.length &&
    e.bodyIds.includes('choc-lazuli') && e.bodyIds.includes('choc-verre'));
  if (state.step===0 && sim.collisionMode==='fragment' && slow) state.step=1;
  if (state.step===1 && slow && fast?.energy>8*slow.energy) state.step=2;
  return 0;
}

function measuredTwins(state,star,elliptical,circular,selectedId) {
  const ellipse=measureOrbit(elliptical,star);
  const circle=measureOrbit(circular,star);
  if (!ellipse || !circle) return 0;
  if (state.step===0 && selectedId===elliptical.id && ellipse.radius>.52) state.step=1;
  if (state.step===1 && ellipse.radius<.16 && ellipse.speed>1.8*circle.speed) state.step=2;
  if (state.step===2 && ellipse.radius>.52 && ellipse.speed<.60*circle.speed) state.step=3;
  if (state.step===1) return clamp01((.52-ellipse.radius)/.36);
  if (state.step===2) return clamp01((ellipse.radius-.16)/.36);
  return 0;
}

function measuredExchange(state,primary,satin,cobalt,selectedId) {
  const first=measureOrbit(satin,primary);
  const second=measureOrbit(cobalt,primary);
  if (!first || !second || !first.periodDays || !second.periodDays) return 0;
  const separation=Math.hypot(...satin.position.map((x,i)=>x-cobalt.position[i]));
  const difference=first.semiMajor-second.semiMajor;
  if (state.step===0 && difference<0) state.step=1;
  if (state.step===1 && difference>.000026) state.step=2;
  if (state.step===2 && difference>.000026 && separation>.00075 &&
      (selectedId===satin.id || selectedId===cobalt.id)) state.step=3;
  if (state.step===1) return clamp01((difference+.000078)/.000104);
  if (state.step===2) return clamp01(separation/.00075)*.9;
  return 0;
}

function measuredTransit(state,host,visitor,inner,outer,selectedId) {
  const approach=measureOrbit(visitor,host);
  const near=measureOrbit(inner,host);
  const distant=measureOrbit(outer,host);
  const distantFromVisitor=measureOrbit(outer,visitor);
  if (!approach || !near || !distant || !distantFromVisitor) return 0;
  if (state.step===0 && approach.radius<.55) state.step=1;
  if (state.step===1 && selectedId===outer.id && distant.radius>1.55 && distant.radialSpeed>0 &&
      distant.energy>0 && distantFromVisitor.energy>0 && near.energy<0) state.step=2;
  if (state.step===0) return clamp01((3.65-approach.radius)/3.1);
  return state.step===1 ? clamp01((distant.radius-1.15)/.40)*.9 : 0;
}

// Only measured state advances an observation. Persist the small measurements
// alongside a physics snapshot so a restored orbit resumes from the same arc.
export function createGuide(id, saved = null) {
  const rows = guides[id];
  if (!rows) return null;
  const total = rows.length-1;
  let state = resetState();
  if (saved?.id===id && saved.version===1 && Number.isInteger(saved.step) && saved.step>=0 && saved.step<=total &&
      Number.isFinite(saved.lastDay) && saved.lastDay>=0 && (saved.angle===null || Number.isFinite(saved.angle)) &&
      Number.isFinite(saved.arc) && saved.arc>=0 && typeof saved.inner==='boolean' &&
      (saved.survivor===null || typeof saved.survivor==='string')) {
    state = {step:saved.step,lastDay:saved.lastDay,angle:saved.angle,arc:saved.arc,inner:saved.inner,survivor:saved.survivor};
  }
  const title = SANDBOX_SCENARIOS.find(s => s.id===id).guide;
  const steps = rows.slice(0,total).map(([label,instruction]) => ({label,instruction}));
  function update(sim, {selectedId,paused=false} = {}) {
    if (sim.days < state.lastDay - 1e-10) state = resetState();
    state.lastDay = sim.days;
    const get = key => sim.bodies.find(b => b.id === key);
    let fraction = 0;
    if (id === 'solar') {
      fraction=measuredRevolution(state,get('earth'),get('moon'),selectedId,1);
    } else if (id==='retrograde') {
      fraction=measuredRevolution(state,get('saros'),get('nereis'),selectedId,-1);
    } else if (id==='white-dwarf') {
      fraction=measuredRevolution(state,get('perle-blanche'),get('carillon'),selectedId,1);
    } else if (id==='figure-eight') {
      fraction=measuredEight(state,sim,selectedId);
    } else if (id==='escape') {
      fraction=measuredEscape(state,get('ancre'),get('fugace'),selectedId);
    } else if (id==='roche-pass') {
      fraction=measuredRoche(state,sim,selectedId);
    } else if (id==='shock-duel') {
      fraction=measuredShocks(state,sim);
    } else if (id==='eccentric-twins') {
      fraction=measuredTwins(state,get('orbe-des-jumeaux'),get('elan'),get('cadence'),selectedId);
    } else if (id==='moon-exchange') {
      fraction=measuredExchange(state,get('harmonie'),get('satin'),get('cobalt'),selectedId);
    } else if (id==='stellar-transit') {
      fraction=measuredTransit(state,get('havre'),get('traverse'),get('veille'),get('lisiere'),selectedId);
    } else if (id === 'comet') {
      const star=get('solis'), nucleus=get('iris');
      if (star && nucleus) {
        const dist=Math.hypot(...nucleus.position.map((p,i)=>p-star.position[i]));
        if (dist<=.24) state.inner=true;
        if (!state.step && selectedId==='iris') state.step=1;
        if (state.step===1 && state.inner) state.step=2;
        if (state.step===2 && dist>=.33) state.step=total;
        fraction=state.step===1 ? clamp01((.5-dist)/.26) : state.step===2 ? clamp01((dist-.162)/(.33-.162)) : 0;
      }
    } else {
      if (!state.step) {
        const event=sim.events.find(e=>e.type==='collision' && e.survivorId && !e.fragmentIds?.length &&
          e.bodyIds.includes('basalte') && e.bodyIds.includes('opale'));
        if (event) {state.step=1;state.survivor=event.survivorId;}
        else {
          const basalt=get('basalte'),opal=get('opale');
          if (basalt && opal) {
            const distance=Math.hypot(...basalt.position.map((p,i)=>p-opal.position[i]));
            fraction=clamp01((.001704-distance)/(.001704-basalt.radius-opal.radius));
          }
        }
      }
      if (state.step===1 && paused && selectedId===state.survivor) state.step=total;
    }
    return {index:Math.min(state.step,total-1),total,done:state.step===total,label:rows[state.step][0],
      instruction:rows[state.step][1],progress:state.step===total ? 1 : (state.step+fraction)/total};
  }
  return {title,steps,update,serialize:() => ({version:1,id,...state})};
}
