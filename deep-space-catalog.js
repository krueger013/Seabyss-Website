import {remnantEntries} from './stellar-remnants.js';

// Equatorial sky coordinates (J2000; RA in hours, declination in degrees).
// For diffuse objects the radius is the luminous region used in the scene.
// Measurement sources and the assumptions behind the renderings are in deep-space-credits.txt.
const diffuseCatalog = [
  // ID, name, type, morphology, category, designation, region, distance and radius (ly), RA, Dec, color, description, observation.
  ['orion-nebula', 'Nébuleuse d’Orion', 'nebula', 'emission', 'Pouponnière stellaire', 'M42 · NGC 1976', 'Voie lactée · Orion', 1500, 12, 5.588, -5.39, '#f19baf',
    'Sous la ceinture d’Orion, les étoiles massives du Trapèze éclairent une cavité ouverte dans leur nuage natal.',
    'Repère le cœur très lumineux, puis suis la transition vers les bords diffus du nuage.'],
  ['carina-nebula', 'Nébuleuse de la Carène', 'nebula', 'emission', 'Complexe de formation stellaire', 'NGC 3372 · Caldwell 92', 'Voie lactée · Carène', 7500, 115, 10.751, -59.87, '#e98971',
    'Dans cette vaste région australe, le rayonnement et les vents des étoiles massives découpent des cavités dans le gaz.',
    'Compare la largeur des cavités au complexe entier. Les célèbres Falaises cosmiques n’en occupent qu’une petite région.'],
  ['lagoon-nebula', 'Nébuleuse de la Lagune', 'nebula', 'emission', 'Nébuleuse en émission', 'M8 · NGC 6523', 'Voie lactée · Sagittaire', 5200, 40, 18.063, -24.38, '#ef8894',
    'Un chenal de poussière partage la région brillante de la Lagune. Les étoiles jeunes du voisinage font rayonner l’hydrogène.',
    'Suis la coupure sombre entre les zones brillantes pour retrouver la forme de la lagune.'],
  ['eagle-nebula', 'Nébuleuse de l’Aigle', 'nebula', 'pillars', 'Nébuleuse en émission', 'M16 · IC 4703', 'Voie lactée · Serpent', 7000, 35, 18.313, -13.80, '#b8b190',
    'Les Piliers de la création sont des colonnes de gaz et de poussière dans la nébuleuse associée à l’amas NGC 6611.',
    'Cherche les silhouettes sombres détachées sur le gaz éclairé. Les têtes des piliers font face aux étoiles chaudes.'],
  ['crab-nebula', 'Nébuleuse du Crabe', 'nebula', 'remnant', 'Rémanent de supernova', 'M1 · NGC 1952', 'Voie lactée · Taureau', 6500, 3, 5.575, 22.02, '#eea272',
    'Une supernova observée en 1054 a laissé des filaments en expansion. Un pulsar alimente encore la lueur intérieure.',
    'Distingue les filaments de matière expulsée de la lueur diffuse au centre du rémanent.'],
  ['ring-nebula', 'Nébuleuse de l’Anneau', 'nebula', 'planetary', 'Nébuleuse planétaire', 'M57 · NGC 6720', 'Voie lactée · Lyre', 2000, .65, 18.893, 33.03, '#89dbe0',
    'Une étoile en fin de vie a expulsé ses enveloppes. Son cœur dénudé éclaire le gaz qui dessine l’anneau.',
    'Observe la différence de luminosité entre le bord de l’enveloppe et son intérieur.'],
  ['dumbbell-nebula', 'Nébuleuse de l’Haltère', 'nebula', 'bipolar', 'Nébuleuse planétaire bipolaire', 'M27 · NGC 6853', 'Voie lactée · Petit Renard', 1200, 1.4, 19.993, 22.72, '#8dd1b5',
    'Les deux lobes de cette enveloppe de gaz forment un haltère. Le rayonnement de la naine blanche centrale entretient sa lumière.',
    'Tourne autour de l’enveloppe et cherche l’axe qui relie ses deux lobes brillants.'],
  ['m78', 'Nébuleuse de réflexion M78', 'nebula', 'reflection', 'Nébuleuse par réflexion', 'M78 · NGC 2068', 'Voie lactée · Orion', 1600, 2.5, 5.779, .05, '#8dbceb',
    'La poussière de M78 diffuse la lumière d’étoiles voisines. Sa couleur bleutée contraste avec les nuages rouges d’hydrogène ionisé.',
    'Compare ce voile bleu au gaz rose de la nébuleuse d’Orion, dans la même constellation.'],
  ['pleiades', 'Les Pléiades', 'cluster', 'open', 'Amas ouvert', 'M45 · Les Sept Sœurs', 'Voie lactée · Taureau', 445, 8, 3.790, 24.12, '#a1c1ff',
    'Les étoiles bleues des Pléiades se sont formées ensemble. La poussière qui les entoure diffuse la lumière de ses membres les plus brillants.',
    'Pars du groupe de points bleus les plus brillants, puis repère les étoiles plus faibles autour.'],
  ['beehive', 'Amas de la Crèche', 'cluster', 'open', 'Amas ouvert', 'M44 · Praesepe', 'Voie lactée · Cancer', 600, 12, 8.670, 19.67, '#f3dbad',
    'Les étoiles de la Crèche forment un groupe lâche que l’œil nu perçoit comme une tache dans le Cancer.',
    'Compare la dispersion de ses étoiles au centre beaucoup plus serré du grand amas d’Hercule.'],
  ['wild-duck', 'Amas du Canard sauvage', 'cluster', 'open', 'Amas ouvert dense', 'M11 · NGC 6705', 'Voie lactée · Écu', 6200, 10, 18.852, -6.27, '#d0dafa',
    'M11 est un amas ouvert particulièrement riche. Son surnom vient du V qu’évoque la disposition de ses étoiles brillantes depuis la Terre.',
    'Repère la concentration du centre et compare-la au groupe beaucoup plus épars des Pléiades.'],
  ['hercules-cluster', 'Grand amas d’Hercule', 'cluster', 'globular', 'Amas globulaire', 'M13 · NGC 6205', 'Halo de la Voie lactée · Hercule', 25000, 75, 16.695, 36.47, '#f2d6a8',
    'Plus de cent mille étoiles composent cette sphère ancienne du halo galactique. Leur concentration augmente fortement vers le centre.',
    'Compte quelques étoiles à la périphérie puis déplace ton regard vers le cœur, où leur lumière se confond.'],
  ['omega-centauri', 'Oméga du Centaure', 'cluster', 'globular', 'Amas globulaire massif', 'NGC 5139 · Caldwell 80', 'Halo de la Voie lactée · Centaure', 17000, 75, 13.446, -47.48, '#e3c8a0',
    'Ce géant du ciel austral abrite plusieurs populations stellaires et des millions d’étoiles liées par la gravité.',
    'Reculer de quelques rayons permet de comparer le noyau compact à son vaste halo.'],
  ['triangulum', 'Galaxie du Triangle', 'galaxy', 'spiral', 'Galaxie spirale', 'M33 · NGC 598', 'Groupe local · Triangle', 2.9e6, 30000, 1.565, 30.66, '#98cae3',
    'La troisième grande spirale du Groupe local contient de nombreuses régions de formation stellaire. NGC 604 est l’une des plus étendues.',
    'Compare son noyau peu dominant au bulbe d’Andromède, sa voisine dans le Groupe local.'],
  ['sombrero', 'Galaxie du Sombrero', 'galaxy', 'edge-on', 'Galaxie vue par la tranche', 'M104 · NGC 4594', 'Univers extragalactique · Vierge', 28e6, 25000, 12.666, -11.62, '#e7c49b',
    'Un épais disque de poussière barre un immense bulbe d’étoiles. Vue de la Terre, cette géométrie rappelle le bord d’un chapeau.',
    'Cherche la bande sombre près du plan du disque et la lumière qui dépasse des deux côtés.'],
  ['pinwheel', 'Galaxie du Moulinet', 'galaxy', 'spiral', 'Spirale vue de face', 'M101 · NGC 5457', 'Univers extragalactique · Grande Ourse', 25e6, 85000, 14.054, 54.35, '#a3bcf1',
    'Les bras étendus et asymétriques du Moulinet portent de nombreuses régions où naissent des étoiles.',
    'Compare la longueur des bras de part et d’autre du noyau, puis incline le disque pour en voir la minceur.'],
  ['bodes-galaxy', 'Galaxie de Bode', 'galaxy', 'spiral', 'Galaxie spirale', 'M81 · NGC 3031', 'Groupe de M81 · Grande Ourse', 11.6e6, 45000, 9.926, 69.07, '#d7c0dd',
    'La spirale de Bode et la galaxie du Cigare appartiennent au même groupe. De jeunes étoiles bleues longent les bras autour d’un bulbe lumineux.',
    'Observe la différence de teinte entre le noyau et les bras. Compare ensuite sa forme à celle de M82.'],
  ['cigar-galaxy', 'Galaxie du Cigare', 'galaxy', 'starburst', 'Galaxie à flambée d’étoiles', 'M82 · NGC 3034', 'Groupe de M81 · Grande Ourse', 12e6, 19000, 9.931, 69.68, '#f4ae8d',
    'La naissance intense d’étoiles dans le centre de M82 alimente un vent de gaz qui s’élève hors de son disque.',
    'Distingue la bande allongée des étoiles et les filaments qui s’en échappent perpendiculairement.'],
  ['centaurus-a', 'Centaurus A', 'galaxy', 'lenticular', 'Galaxie active à bande de poussière', 'NGC 5128 · Caldwell 77', 'Groupe Centaurus A · Centaure', 11e6, 30000, 13.424, -43.02, '#d8b491',
    'Une large bande de poussière traverse le corps lumineux de Centaurus A. Son noyau actif produit des jets visibles à plusieurs longueurs d’onde.',
    'Repère la poussière devant la lueur diffuse du corps galactique.'],
  ['m87', 'Messier 87', 'galaxy', 'elliptical', 'Galaxie elliptique géante', 'M87 · Virgo A · NGC 4486', 'Amas de la Vierge', 54e6, 60000, 12.514, 12.39, '#e9cd9c',
    'M87 domine le centre de l’amas de la Vierge. Le trou noir supermassif M87* alimente un jet de matière relativiste.',
    'Compare sa répartition de lumière, lisse et concentrée au centre, à celle d’une galaxie spirale.']
];

// Stellar radii in solar radii. Several bright stars rotate rapidly or pulsate;
// each radius is a rounded, representative value for a spherical display.
const brightStars = [
  ['altair','Altaïr','Alpha Aquilae · A7 V','Aigle',16.7,1.8,19.846,8.87,'#dbe5ff','Cette étoile blanche tourne si vite qu’elle est aplatie aux pôles.','Compare sa couleur à celle d’Arcturus, plus froide et plus orangée.'],
  ['arcturus','Arcturus','Alpha Boötis · K1.5 III','Bouvier',36.7,25,14.261,19.18,'#ffbc84','Arcturus est une géante orange dont les couches externes se sont dilatées. Son rayon vaut environ vingt-cinq fois celui du Soleil.','Compare le rayon d’Arcturus au rayon solaire à la même distance de la caméra.'],
  ['polaris','Étoile Polaire','Alpha Ursae Minoris · Céphéide','Petite Ourse',447,46,2.530,89.26,'#fff0c1','La composante principale de Polaris est une céphéide pulsante. Vue de la Terre, elle se trouve très près du pôle nord céleste.','Repère sa direction presque alignée avec l’axe de rotation terrestre.'],
  ['rigel','Rigel','Bêta Orionis · B8 Ia','Orion',860,79,5.242,-8.20,'#b6cdff','Cette supergéante bleue marque un pied d’Orion. Sa surface est bien plus chaude que celle de Bételgeuse.','Compare les couleurs des deux supergéantes d’Orion, Rigel et Bételgeuse.'],
  ['aldebaran','Aldébaran','Alpha Tauri · K5 III','Taureau',65,44,4.599,16.51,'#ffad70','Cette géante orangée paraît se trouver parmi les Hyades depuis la Terre. Elle se situe en réalité devant cet amas.','Regarde sa couleur ambrée puis visite les étoiles bleues des Pléiades dans la même constellation.']
];

// Radius (Earth radii), semimajor axis (AU) and orbital period (days).
// Tones, surface material, starting phase and inclination in game coordinates
// are visual models. The illustrated synchronous spin uses the measured orbital period.
const hosts = [
  {
    id:'trappist-1', name:'TRAPPIST-1', designation:'2MASS J23062928−0502285', spectral:'Naine ultrafroide', constellation:'Verseau',
    distance:40.5, radius:.119, ra:23.108, dec:-5.041, color:'#fe8762', tilt:14,
    description:'Sept mondes proches de la taille terrestre gravitent autour de cette minuscule étoile. Toute la famille tient largement à l’intérieur de l’orbite de Mercure.',
    observation:'Accélère le temps d’un jour par seconde et compare le rythme orbital de b à celui de h.',
    planets:[
      ['b',1.116,.01154,1.5109,'#b26e51','lava','La planète la plus intérieure de la chaîne complète un tour en un jour et demi.','Compare la taille apparente de l’étoile depuis b puis depuis h.'],
      ['c',1.097,.01580,2.4218,'#c79f84','desert','Bien que proche de la Terre par sa taille, ce monde reçoit bien plus de rayonnement de son étoile.','Regarde c avancer d’environ cinq tours pendant que b en effectue huit.'],
      ['d',.788,.02227,4.0492,'#b88478','rock','Le rayon de TRAPPIST-1 d est inférieur à celui de la Terre. Son orbite est la troisième en partant de l’étoile.','Compare son rayon à celui de b, sa voisine intérieure plus grande.'],
      ['e',.920,.02925,6.1010,'#998a80','rock','Ce monde proche de la taille terrestre se trouve dans la zone tempérée de son étoile. La présence d’un océan ou d’une atmosphère reste incertaine.','Accélère le temps et compare sa révolution de six jours à celle de sa voisine f.'],
      ['f',1.045,.03849,9.2075,'#88a5ae','ice','La cinquième planète du système met un peu plus de neuf jours à faire le tour de la naine ultrafroide.','Compare trois révolutions de e à deux révolutions de f.'],
      ['g',1.129,.04683,12.352,'#b0a093','desert','TRAPPIST-1 g est légèrement plus grande que la Terre. Sa période est proche de quatre tiers de celle de f.','Observe l’ordre des conjonctions de f et de g pendant plusieurs semaines simulées.'],
      ['h',.755,.06189,18.773,'#91aebe','ice','Petite et éloignée de son étoile à l’échelle de ce système compact, h parcourt son orbite en moins de dix-neuf jours.','Compare le rayon de son orbite extérieure à la distance de Mercure au Soleil.']
    ]
  },
  {
    id:'kepler-186', name:'Kepler-186', designation:'KOI-571 · KIC 8120608', spectral:'Naine rouge', constellation:'Cygne',
    distance:579, radius:.52, ra:19.9102, dec:43.955, color:'#ffab87', tilt:-16,
    description:'Cette naine rouge héberge cinq planètes détectées lorsqu’elles passent devant son disque depuis la Terre.',
    observation:'Compare le groupe serré des quatre premières orbites à la grande trajectoire extérieure de f.',
    planets:[
      ['b',1.07,.0343,3.8868,'#c7957c','rock','Kepler-186 b est la plus proche de l’étoile parmi les cinq planètes représentées. Son année dure moins de quatre jours.','Regarde b achever plusieurs tours pendant que f parcourt un seul arc.'],
      ['c',1.25,.0451,7.2673,'#d19b75','desert','Un peu plus grande que la Terre, c passe devant l’étoile environ une fois par semaine vue depuis notre direction.','Compare sa période à celle de b et suis l’écart qui se creuse entre elles.'],
      ['d',1.40,.0781,13.343,'#c9aa91','rock','Des cinq planètes de Kepler-186, d présente le plus grand rayon mesuré dans cette sélection.','Compare les rayons affichés de d, e et f.'],
      ['e',1.27,.110,22.408,'#ab9481','desert','Kepler-186 e ferme le groupe d’orbites intérieures. Une large séparation orbitale la distingue de sa voisine f.','Dézoome pour voir en même temps e et l’orbite extérieure de f.'],
      ['f',1.17,.432,129.945,'#879b9c','rock','Kepler-186 f fut la première planète de taille terrestre découverte dans la zone habitable de son étoile. Son climat et sa surface restent inconnus.','Compare son année de près de cent trente jours aux vingt-deux jours de e.']
    ]
  },
  {
    id:'kepler-62', name:'Kepler-62', designation:'KOI-701 · KIC 9002278', spectral:'Étoile de type K', constellation:'Lyre',
    distance:981, radius:.60, ra:18.8808, dec:45.3498, color:'#ffd09d', tilt:19,
    description:'Une étoile plus petite que le Soleil éclaire cinq planètes connues. La mission Kepler les a détectées grâce à leurs transits.',
    observation:'Examine la différence d’échelle entre les trois orbites rapprochées et les deux orbites extérieures.',
    planets:[
      ['b',1.31,.0553,5.715,'#bc8d79','rock','Kepler-62 b se tient tout près de son étoile orangée et en fait le tour en moins de six jours.','Compare la vitesse de b à celle de la petite planète c.'],
      ['c',.54,.0929,12.442,'#a19b9a','rock','Cette petite planète a un rayon proche de celui de Mars. Elle est bien plus petite que ses voisines b et d.','Alterne entre c et d et compare leurs rayons.'],
      ['d',1.95,.120,18.164,'#b98e76','desert','Presque deux fois plus large que la Terre, d est la plus grande des cinq planètes représentées autour de Kepler-62.','Essaye de distinguer les trois orbites intérieures en vue du dessus.'],
      ['e',1.61,.427,122.39,'#919f9c','rock','Kepler-62 e occupe l’une des deux orbites extérieures du système. La composition de son atmosphère reste inconnue.','Compare le grand intervalle entre d et e à l’espacement des orbites intérieures.'],
      ['f',1.41,.718,267.29,'#8da3b1','ice','La lumière de Kepler-62 atteint f après un parcours d’environ 0,72 unité astronomique. Sa période approche neuf mois terrestres.','Chronomètre une révolution de f et observe combien de fois b repasse au même endroit.']
    ]
  },
  {
    id:'hd-189733', name:'HD 189733 A', designation:'V452 Vulpeculae', spectral:'Naine orange', constellation:'Petit Renard',
    distance:64.5, radius:.76, ra:20.011, dec:22.711, color:'#ffc28d', tilt:10,
    description:'La lumière de cette étoile orangée traverse le bord de l’atmosphère de son Jupiter chaud pendant ses transits.',
    observation:'Compare la taille de l’étoile et de la géante gazeuse qui passe tout près.',
    planets:[
      ['b',12.67,.03126,2.2186,'#4579c3','gas','Ce Jupiter chaud présente une teinte bleue mesurée en lumière visible. Son atmosphère brûlante reçoit un rayonnement intense.','Compare sa très courte révolution à l’année de Jupiter autour du Soleil.']
    ]
  },
  {
    id:'55-cancri', name:'55 Cancri A', designation:'Copernicus · Rho¹ Cancri', spectral:'Étoile de type G', constellation:'Cancer',
    distance:41, radius:.94, ra:8.877, dec:28.331, color:'#ffd6a0', tilt:-8,
    description:'L’étoile Copernicus fait partie d’un système multiple et possède plusieurs planètes. Le parcours présente sa proche compagne planétaire e.',
    observation:'Place-toi près de 55 Cancri e pour saisir à quel point son orbite serre son étoile.',
    planets:[
      ['e',1.875,.01544,.73655,'#e58f58','lava','Cette super-Terre brûlante accomplit un tour en moins de dix-huit heures. Une surface partiellement fondue est vraisemblable.','À une heure par seconde, observe une année de la planète en moins de dix-huit secondes.']
    ]
  }
];

export function createDeepSpaceCatalog({body, skyPosition, AU, LIGHT_YEAR}) {
  const result = [...diffuseCatalog,...remnantEntries].map(([id,name,kind,morphology,category,designation,region,distance,radius,ra,dec,color,description,observation,sourceUrl,radiusBasis]) =>
    body(id, name, kind, category, designation, radius * LIGHT_YEAR, skyPosition(distance,ra,dec), color, description,
      {parentId: kind === 'galaxy' ? null : 'milky-way', region, morphology, observation,sourceUrl,radiusBasis}));
  for (const [id,name,designation,constellation,distance,radius,ra,dec,color,description,observation] of brightStars) {
    result.push(body(id,name,'star','Étoile remarquable',designation,radius * 695700,skyPosition(distance,ra,dec),color,description,
      {region:'Voie lactée · ' + constellation, observation}));
  }
  for (const star of hosts) {
    const center = skyPosition(star.distance,star.ra,star.dec);
    const tilt = star.tilt * Math.PI / 180;
    const host = body(star.id,star.name,'star',star.spectral,star.designation,star.radius*695700,center,star.color,star.description,
      {system:star.name,region:'Voie lactée · ' + star.constellation, observation:star.observation});
    result.push(host);
    for (const [i,planet] of star.planets.entries()) {
      const [suffix,radius,axisAU,period,color,material,description,observation] = planet;
      const name = star.name.replace(/ A$/, '') + ' ' + suffix;
      const phase = (35 + 137.508*i + star.tilt) * Math.PI / 180;
      const axis = axisAU * AU, sine = axis * Math.sin(phase);
      const position = [center[0]+axis*Math.cos(phase), center[1]+sine*Math.sin(tilt), center[2]+sine*Math.cos(tilt)];
      const category = material === 'gas' ? 'Jupiter chaud' : 'Exoplanète';
      result.push(body(star.id+'-'+suffix,name,'planet',category,star.id==='55-cancri' ? 'Janssen · 55 Cnc e' : name,
        radius*6371,position,color,description, {parentId:star.id, system:star.name, region:'Système ' + star.name, observation, material,
          orbitRadiusKm:axis, orbitPeriodDays:period, orbitPlaneTiltDeg:star.tilt, lightPosition:host.position,
          rotationPeriodHours:period*24, rotationIllustrative:true}));
    }
  }
  return result;
}
