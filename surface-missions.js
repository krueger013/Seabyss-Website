// Distances and readings describe the simulated survey sites.
export const SURFACE_MISSIONS = {
  moon: {
    name: 'Lune', title: 'Mer des Pluies', zone: 'Site lunaire · plateau basaltique',
    color: '#c6d8ea', speed: 3.1, gravity: '1,62 m/s²', air: 'Quasi-vide',
    places: [
      {id:'albedo', x:12, z:64, name:'Bloc d’anorthosite', instrument:'Spectromètre', reading:'Albédo relatif · 0,32',
        note:'La roche claire se détache du basalte foncé. Sa composition évoque la croûte ancienne de la Lune.'},
      {id:'crater', x:-112, z:128, name:'Bord du cratère', instrument:'Télémètre', reading:'Diamètre estimé · 184 m',
        note:'Les rebords surélevés et les blocs éjectés témoignent d’un impact qui a creusé la surface.'},
      {id:'regolith', x:107, z:174, name:'Plaine de régolithe', instrument:'Pénétromètre', reading:'Enfoncement local · 46 mm',
        note:'Des impacts répétés ont broyé la roche en une couche de grains fins. Sa cohésion varie sous une même trace.'},
      {id:'basalt', x:-39, z:264, name:'Affleurement de basalte', instrument:'Spectromètre', reading:'Fer oxydé simulé · 17 %',
        note:'Les mers lunaires sont de grandes plaines sombres où d’anciennes coulées ont rempli des bassins d’impact.'},
      {id:'apron', x:71, z:109, name:'Talus du cratère', instrument:'Inclinomètre', reading:'Pente locale · 19°',
        note:'Au bord de la cuvette, les parois et les matériaux éjectés forment des pentes distinctes. Compare le relief du talus à la plaine plus régulière.'},
      {id:'edge', x:-211, z:228, name:'Balcon des Pluies', instrument:'Télémètre', reading:'Relief de la crête simulé · 24 m',
        note:'En suivant la pente vers le haut, tu prends du recul sur le bassin. Tourne-toi vers la cuvette pour voir le rebord depuis un deuxième angle.'},
    ],
  },
  mars: {
    name: 'Mars', title: 'Valles Marineris', zone: 'Site martien · plateau de falaise',
    color: '#ffc397', speed: 2.8, gravity: '3,71 m/s²', air: 'CO₂ dominant',
    places: [
      {id:'dust', x:16, z:70, name:'Dépôt de poussière', instrument:'Spectromètre', reading:'Absorption du fer · détectée',
        note:'Les oxydes de fer donnent à la poussière une teinte rouille qui colore le ciel lorsque le vent la soulève.'},
      {id:'layer', x:-96, z:142, name:'Paroi stratifiée', instrument:'Télémètre', reading:'Couche exposée · 2,6 m',
        note:'Les couches superposées permettent de distinguer plusieurs épisodes de dépôts et d’érosion.'},
      {id:'basalt', x:124, z:187, name:'Dalle volcanique', instrument:'Spectromètre', reading:'Pyroxènes · signature compatible',
        note:'Ce minéral est fréquent dans les roches volcaniques riches en fer et en magnésium.'},
      {id:'wind', x:-22, z:268, name:'Couloir de sable', instrument:'Anémomètre', reading:'Rafale simulée · 24 km/h',
        note:'Même dans une atmosphère ténue, les rafales déplacent les grains les plus fins et sculptent des rides.'},
      {id:'ravine', x:33, z:174, name:'Fond du ravin', instrument:'Télémètre', reading:'Dénivelé simulé · 12 m',
        note:'Observe la pente des deux côtés du couloir. Les parois plus hautes font ressortir les différentes couches du terrain.'},
    ],
  },
  europa: {
    name: 'Europe', title: 'Chaos de Conamara', zone: 'Site jovien · banquise fracturée',
    color: '#b6ebf3', speed: 2.9, gravity: '1,31 m/s²', air: 'O₂ très ténu',
    places: [
      {id:'ice', x:10, z:66, name:'Glace fraîche', instrument:'Spectromètre', reading:'Glace d’eau · bandes détectées',
        note:'La glace claire absorbe fortement certaines longueurs d’onde. Ces signatures servent à reconnaître l’eau gelée.'},
      {id:'rift', x:-98, z:140, name:'Fracture ocre', instrument:'Télémètre', reading:'Largeur locale · 12 m',
        note:'Les bandes colorées suivent souvent des fissures. Les contraintes de marée exercées par Jupiter déforment la croûte.'},
      {id:'slab', x:126, z:179, name:'Bloc basculé', instrument:'Inclinomètre', reading:'Inclinaison simulée · 24°',
        note:'Les zones chaotiques contiennent des blocs qui ont bougé ou pivoté. Leur disposition révèle comment la glace s’est rompue.'},
      {id:'ridge', x:-51, z:254, name:'Double crête', instrument:'Radar de surface', reading:'Réflecteurs · deux bandes',
        note:'Deux reliefs parallèles encadrent une dépression centrale. Plusieurs mécanismes peuvent former ce type de crête.'},
      {id:'channel', x:23, z:148, name:'Sillon de glace', instrument:'Télémètre', reading:'Dénivelé local simulé · 4 m',
        note:'La fracture traverse le terrain en diagonale. Compare l’ombre sur la rive du sillon à l’éclat des plaques environnantes.'},
    ],
  },
  titan: {
    name: 'Titan', title: 'Rive de Kraken Mare', zone: 'Site saturnien · plaines polaires',
    color: '#f7d493', speed: 2.6, gravity: '1,35 m/s²', air: 'Azote dominant',
    places: [
      {id:'shore', x:19, z:64, name:'Rive sombre', instrument:'Radar de surface', reading:'Écho homogène · zone plane',
        note:'Les étendues lisses de Titan produisent un écho radar faible. Les hydrocarbures peuvent s’y accumuler à l’état liquide.'},
      {id:'dune', x:-97, z:134, name:'Crête de dune', instrument:'Anémomètre', reading:'Vent simulé · 11 km/h',
        note:'Les dunes se forment à partir de grains riches en matière organique. Leur orientation enregistre les vents dominants.'},
      {id:'pebble', x:120, z:173, name:'Galets de glace', instrument:'Spectromètre', reading:'Glace d’eau · bandes détectées',
        note:'À la température de Titan, la glace d’eau forme des roches. Les galets arrondis évoquent des épisodes de transport.'},
      {id:'cloud', x:-28, z:260, name:'Station atmosphérique', instrument:'Thermomètre', reading:'Température simulée · −179 °C',
        note:'Dans l’atmosphère froide de Titan, le méthane peut s’évaporer, former des nuages et retomber sous forme de pluie.'},
      {id:'inlet', x:62, z:142, name:'Anse abritée', instrument:'Radar de surface', reading:'Retour simulé · faible et continu',
        note:'La transition entre la rive accidentée et la zone plus lisse aide à suivre le bord de l’anse, même sous la brume.'},
    ],
  },
  mercury: {
    name: 'Mercure', title: 'Bassin Caloris', zone: 'Site mercurien · plaine d’impact',
    color: '#ead1b2', speed: 2.7, gravity: '3,70 m/s²', air: 'Exosphère ténue',
    places: [
      {id:'volcanic', x:17, z:62, name:'Plaine volcanique', instrument:'Spectromètre', reading:'Silicates · signal détecté',
        note:'Du matériau volcanique a rempli une partie du vaste bassin après l’impact. La plaine relativement lisse contraste avec les terrains plus cratérisés autour du bassin.'},
      {id:'graben', x:72, z:126, name:'Fossé de Pantheon', instrument:'Télémètre', reading:'Largeur simulée du fossé · 14 m',
        note:'Les fossés de Pantheon Fossae rayonnent dans plusieurs directions. Un fossé de ce type peut se former quand la croûte s’étire et qu’un bloc descend entre deux failles.'},
      {id:'hollows', x:-102, z:151, name:'Dépressions claires', instrument:'Photomètre', reading:'Contraste simulé · 1,7 × la plaine',
        note:'Les images de MESSENGER révèlent des creux irréguliers aux bordures claires. La perte de matériaux volatils est une piste pour expliquer leur formation.'},
      {id:'scarp', x:39, z:248, name:'Rebord fracturé', instrument:'Inclinomètre', reading:'Pente locale simulée · 17°',
        note:'Plusieurs générations de cratères et de fractures entaillent le plancher de Caloris. D’ici, le petit cratère et les fossés du paysage simulé se lisent dans le même champ.'},
    ],
  },
  enceladus: {
    name: 'Encelade', title: 'Baghdad Sulcus', zone: 'Site saturnien · fracture polaire',
    color: '#b7ecfa', speed: 2.4, gravity: '0,11 m/s²', air: 'Quasi-vide',
    places: [
      {id:'frost', x:14, z:57, name:'Givre de retombée', instrument:'Spectromètre', reading:'Glace d’eau · absorption détectée',
        note:'Une partie des particules éjectées retombe sur Encelade. Ce dépôt contribue à renouveler la surface glacée exposée près des fractures polaires.'},
      {id:'vent', x:31, z:126, name:'Évent de la fracture', instrument:'Caméra infrarouge', reading:'Anomalie thermique · signal simulé',
        note:'Cassini a mesuré une émission infrarouge accrue le long de Baghdad Sulcus. Les évents étudiés projettent de la vapeur d’eau et des grains de glace dans l’espace.'},
      {id:'wall', x:-79, z:147, name:'Paroi de glace', instrument:'Télémètre', reading:'Relief de la paroi simulée · 12 m',
        note:'Des crêtes bordent les fractures du pôle sud. Leurs formes traduisent l’activité de la croûte de glace, soumise aux forces de marée exercées par Saturne.'},
      {id:'field', x:109, z:228, name:'Champ de blocs', instrument:'Radar de surface', reading:'Retour simulé · rugueux',
        note:'Les blocs isolés rendent ce secteur plus irrégulier que le dépôt de givre. Cherche les ombres au pied des gros blocs pour voir les différences de relief.'},
    ],
  },
  ganymede: {
    name: 'Ganymède', title: 'Arbela Sulcus', zone: 'Site jovien · frontière des terrains striés',
    color: '#e5d2c4', speed: 3, gravity: '1,43 m/s²', air: 'O₂ très ténu',
    places: [
      {id:'ridges', x:16, z:61, name:'Crêtes parallèles', instrument:'Radar de surface', reading:'Crêtes simulées · espacées de 22 m',
        note:'Les images de Galileo révèlent des bandes de sillons et de crêtes. Les contraintes tectoniques de la croûte de glace ont probablement contribué à les former.'},
      {id:'bright', x:-82, z:127, name:'Bande de glace claire', instrument:'Spectromètre', reading:'Glace d’eau · absorption détectée',
        note:'Une bande claire coupe les régions plus sombres dans les images d’Arbela Sulcus. La déformation de la croûte a pu exposer de la glace plus propre.'},
      {id:'dark', x:104, z:157, name:'Terrain sombre', instrument:'Photomètre', reading:'Albédo relatif simulé · 0,29',
        note:'Les terrains sombres de Ganymède sont en général anciens et fortement cratérisés. Les cratères de cette scène permettent de comparer leur texture à la bande striée.'},
      {id:'rim', x:101, z:246, name:'Anneau d’impact', instrument:'Télémètre', reading:'Diamètre du cratère simulé · 106 m',
        note:'Des cratères recoupent aussi le relief strié. La glace peut se déformer lentement avec le temps et atténuer le relief de certains grands cratères.'},
    ],
  },
};

export const surfaceStorageKey = id => 'seabyss-universe.surface.v1.'+id;

export function readSurfaceSave(id) {
  try {return JSON.parse(localStorage.getItem(surfaceStorageKey(id)));}
  catch {return null;}
}

export function visitedFor(mission,value) {
  return mission.places.filter(site=>Array.isArray(value) && value.includes(site.id)).map(site=>site.id);
}

export function readSurfaceProgress() {
  return Object.fromEntries(Object.entries(SURFACE_MISSIONS).map(([id,mission])=>[
    id,visitedFor(mission,readSurfaceSave(id)?.visited)
  ]));
}
