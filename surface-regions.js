const survey = (id,name,x,z,instrument,reading,note) => ({id,name,x,z,instrument,reading,note});

// Geographic positions use signed east longitude. These routes and their
// instrument readings describe reconstructions, not measured local transects.
export const SURFACE_REGIONS = {
  moon: [
    {
      id:'apollo-11',name:'Site d’Apollo 11',latitude:.67416,longitude:23.47314,elevationKm:-1.926,
      zone:'Mer de la Tranquillité · plaine basaltique',
      description:'Une plaine de lave ancienne sur la face visible de la Lune. Lève les yeux vers la Terre depuis le site d’alunissage.',
      terrain:{seed:1119,shape:'plains',scale:.82},
      places:[
        survey('apollo-regolith','Plaine de régolithe',-12,59,'Pénétromètre','Enfoncement · 29 mm','Les micrométéorites pulvérisent la roche et remanient sans cesse cette couche meuble.'),
        survey('apollo-basalt','Éclats de basalte',82,128,'Spectromètre','Roche basaltique · signature détectée','Apollo 11 a rapporté des échantillons de basalte issus des coulées qui ont rempli la mer de la Tranquillité.'),
        survey('apollo-rim','Petit rebord d’impact',-70,201,'Télémètre','Diamètre local · 48 m','Observe le rebord et les débris dispersés autour de la cuvette.')
      ]
    },
    {
      id:'chang-e-4',name:'Site de Chang’e 4',latitude:-45.4562,longitude:177.5885,elevationKm:-5.927,
      zone:'Face cachée · cratère Von Kármán',
      description:'Une plaine d’impact au cœur de la face cachée. Le ciel offre un point de comparaison avec Apollo 11 au même instant.',
      terrain:{seed:4019,shape:'craters',scale:1.12},
      places:[
        survey('change-fines','Poussière de Von Kármán',8,67,'Radar de surface','Première interface · 1,8 m','Yutu-2 utilise le radar pour examiner la stratification de la subsurface de cette région.'),
        survey('change-ejecta','Blocs d’éjecta',-93,142,'Spectromètre','Minéraux silicatés · signature compatible','Plusieurs impacts ont recouvert le sol local de matériaux issus de différentes profondeurs.'),
        survey('change-rim','Versant criblé',110,224,'Inclinomètre','Pente · 17°','Des petits reliefs se superposent au plancher d’un cratère plus ancien dans ce parcours reconstruit.')
      ]
    }
  ],
  mars: [
    {
      id:'jezero',name:'Cratère Jezero',latitude:18.44,longitude:77.45,
      zone:'Bassin de Jezero · ancien delta',
      description:'Explore des talus qui évoquent le delta ancien étudié par Perseverance et mesure les traces de sédiments.',
      terrain:{seed:2021,shape:'canyon',scale:1.10},
      places:[
        survey('jezero-layers','Talus du delta',13,68,'Télémètre','Épaisseur visible · 2,4 m','L’empilement des couches raconte plusieurs phases de transport et de dépôt par l’eau.'),
        survey('jezero-pebbles','Lit de galets',-81,139,'Imagerie rapprochée','Grains arrondis · jusqu’à 4 cm','Les galets arrondis évoquent une abrasion pendant le transport dans un ancien courant.'),
        survey('jezero-fines','Dépôt à grains fins',103,213,'Spectromètre','Minéraux argileux · signature compatible','Des sédiments fins peuvent se déposer quand l’énergie du courant diminue.')
      ]
    },
    {
      id:'gale',name:'Cratère Gale',latitude:-4.59,longitude:137.44,
      zone:'Plancher de Gale · strates du mont Sharp',
      description:'Un relief de couches rouges et de bancs érodés inspiré du bassin parcouru par Curiosity.',
      terrain:{seed:6112,shape:'highlands',scale:1.26},
      places:[
        survey('gale-outcrop','Banc de roche feuilletée',-14,57,'Imagerie rapprochée','Lamination · visible','Les strates visibles dans le bassin de Gale enregistrent de longs épisodes de dépôt et d’érosion.'),
        survey('gale-mineral','Veine claire',94,138,'Spectromètre','Sulfates · signature compatible','Une veine minérale peut se former quand un fluide circule dans une fracture et y laisse des sels.'),
        survey('gale-cliff','Front de strate',-109,213,'Inclinomètre','Versant · 23°','L’érosion ne creuse pas toutes les couches à la même vitesse. Certaines restent en saillie.')
      ]
    }
  ],
  europa: [
    {
      id:'pwyll',name:'Cratère Pwyll',latitude:-25.20,longitude:88.60,
      zone:'Cratère d’impact · rayons de glace',
      description:'Une cuvette entourée d’éjectas clairs inspirée du cratère photographié par Galileo.',
      terrain:{seed:4878,shape:'craters',scale:1.18},
      places:[
        survey('pwyll-grains','Rayon d’éjectas clairs',6,64,'Spectromètre','Glace d’eau · signal élevé','Les rayons pâles de Pwyll pourraient contenir de fines particules de glace d’eau fraîchement exposées.'),
        survey('pwyll-relief','Épaulement glacé',-74,136,'Télémètre','Relief local · 18 m','La cuvette et son épaulement illustrent le déplacement de matière au moment d’un impact.'),
        survey('pwyll-contact','Transition sombre',105,216,'Photomètre','Albédo relatif · 0,46','Compare un dépôt clair au terrain plus ancien dans lequel se prolonge le rayon.')
      ]
    },
    {
      id:'agenor',name:'Agenor Linea',latitude:-43.80,longitude:146.50,
      zone:'Hémisphère sud · longue bande claire',
      description:'Des lignes de glace guident la marche le long d’une des grandes bandes colorées d’Europe.',
      terrain:{seed:8409,shape:'fissures',scale:.95},
      places:[
        survey('agenor-band','Lisière de la bande claire',18,60,'Photomètre','Albédo relatif · 0,69','Une bande claire se distingue des terrains environnants par la lumière qu’elle réfléchit.'),
        survey('agenor-crack','Ligne de rupture',-92,150,'Télémètre','Ouverture locale · 13 m','Le relief reproduit à petite échelle le contraste entre les longues lignes et les plaques adjacentes.'),
        survey('agenor-ice','Plaque striée',100,220,'Radar de surface','Discontinuité · détectée','Les forces de marée sont capables de déformer et de fracturer la croûte de glace d’Europe.')
      ]
    }
  ],
  titan: [
    {
      id:'selk',name:'Cratère Selk',latitude:7,longitude:161,
      zone:'Région équatoriale · dunes organiques',
      description:'Traverse les dunes dans une région visée par Dragonfly. La brume rase le relief quand le Soleil descend.',
      terrain:{seed:14334,shape:'dunes',scale:1.08},
      places:[
        survey('selk-dune','Crête de dune équatoriale',13,66,'Anémomètre','Vent local · 8 km/h','Les dunes équatoriales de Titan contiennent des grains riches en composés organiques.'),
        survey('selk-sand','Sable sombre',-78,137,'Spectromètre','Composés organiques · signal marqué','Des particules produites dans l’atmosphère peuvent rejoindre la surface et alimenter les dépôts.'),
        survey('selk-wall','Sortie du champ de dunes',105,211,'Télémètre','Dénivelé · 22 m','La région de Selk donne l’occasion d’étudier côte à côte des dunes et un cratère d’impact.')
      ]
    },
    {
      id:'vid-flumina',name:'Vid Flumina',latitude:72.90,longitude:117.75,
      zone:'Région polaire nord · canaux de Ligeia Mare',
      description:'Des canaux sombres découpent les rives sur le chemin de la mer d’hydrocarbures Ligeia Mare.',
      terrain:{seed:15088,shape:'shores',scale:1.14},
      places:[
        survey('vid-waterline','Bord sombre du canal',10,62,'Radar de surface','Écho lisse · détecté','Les observations radar de Cassini indiquent du liquide dans de profonds canaux de Vid Flumina.'),
        survey('vid-ridge','Rive entaillée',-83,129,'Télémètre','Paroi locale · 32 m','Le relief local représente les parois raides observées de loin par Cassini.'),
        survey('vid-merge','Jonction de deux chenaux',97,212,'Altimètre','Niveaux des chenaux · proches','Vid Flumina fait partie du réseau qui débouche dans la mer polaire Ligeia Mare.')
      ]
    }
  ],
  mercury: [
    {
      id:'rachmaninoff',name:'Bassin Rachmaninoff',latitude:27.66,longitude:57.37,
      zone:'Bassin d’impact · plaines intérieures',
      description:'Une plaine intérieure plus lisse que les reliefs qui l’entourent, d’après les observations de MESSENGER.',
      terrain:{seed:14688,shape:'plains',scale:.9},
      places:[
        survey('rach-plains','Plaine intérieure lisse',-12,71,'Imagerie rapprochée','Densité de cratères · faible','Certaines plaines du bassin se sont formées après l’ouverture du cratère.'),
        survey('rach-ring','Pied de l’anneau',87,132,'Télémètre','Relief exposé · 25 m','Rachmaninoff montre un anneau de relief à l’intérieur de son rebord extérieur.'),
        survey('rach-contact','Limite de plaine',-106,219,'Spectromètre','Contraste spectral · détecté','Les différences de texture et de couleur aident à cartographier les terrains internes.')
      ]
    },
    {
      id:'hokusai',name:'Cratère Hokusai',latitude:57.84,longitude:16.65,
      zone:'Hémisphère nord · impact à rayons clairs',
      description:'Des lignes de matière claire rayonnent vers l’horizon depuis les environs d’un cratère de Mercure.',
      terrain:{seed:14644,shape:'craters',scale:1.32},
      places:[
        survey('hokusai-rays','Rayon clair',14,59,'Photomètre','Albédo relatif · 0,27','Les rayons brillants de Hokusai sont des traînées de matériaux dispersés par l’impact.'),
        survey('hokusai-blocks','Blocs près du rebord',-89,132,'Imagerie rapprochée','Débris anguleux · visibles','Des fragments peuvent être projetés puis retomber autour du cratère principal.'),
        survey('hokusai-pit','Cuvette secondaire',110,209,'Télémètre','Diamètre local · 76 m','Les débris les plus gros peuvent eux-mêmes creuser de petites cuvettes à leur retombée.')
      ]
    }
  ],
  enceladus: [
    {
      id:'damascus',name:'Damascus Sulcus',latitude:-80.59,longitude:74.13,
      zone:'Pôle sud · fracture active',
      description:'Approche un sillon glacé actif et observe ses panaches reconstitués au-dessus du pôle sud.',
      terrain:{seed:14252,shape:'fissures',scale:1.18,plumes:true},
      places:[
        survey('damascus-frost','Givre près de la fissure',11,64,'Spectromètre','Glace d’eau · signal élevé','Cassini a observé des jets issus de la région polaire où se trouve Damascus Sulcus.'),
        survey('damascus-edge','Lèvre de la fracture',-82,138,'Télémètre','Dénivelé local · 16 m','Les bords de ces sillons portent l’empreinte des contraintes qui ont fracturé la glace.'),
        survey('damascus-heat','Secteur d’émission',104,214,'Radiomètre','Contraste thermique local · détecté','Cassini a ciblé les fractures polaires et repéré des zones où des jets s’échappent.')
      ]
    },
    {
      id:'samarkand',name:'Samarkand Sulci',latitude:30,longitude:32.50,
      zone:'Hémisphère nord · relief sillonné',
      description:'Un second visage d’Encelade, avec des crêtes et des terrains sillonnés loin des fractures polaires.',
      terrain:{seed:5291,shape:'highlands',scale:.94},
      places:[
        survey('samarkand-furrow','Sillon étroit',-8,62,'Télémètre','Largeur locale · 18 m','Samarkand Sulci regroupe de longues structures présentes dans la croûte de glace.'),
        survey('samarkand-crest','Sommet de crête',88,143,'Inclinomètre','Pente locale · 15°','Les sommets et les dépressions permettent de lire la direction des grands sillons.'),
        survey('samarkand-ledges','Gradins de glace',-106,218,'Radar de surface','Deux interfaces · détectées','La coupe simulée oppose des gradins à un terrain ondulé situé de l’autre côté du sillon.')
      ]
    }
  ],
  ganymede: [
    {
      id:'galileo',name:'Galileo Regio',latitude:45,longitude:-127,
      zone:'Grand plateau · terrain sombre fracturé',
      description:'Parcours un plateau sombre inspiré de la grande région glacée photographiée par Galileo.',
      terrain:{seed:2076,shape:'highlands',scale:1.19},
      places:[
        survey('galileo-dark','Plaque de terrain sombre',9,67,'Photomètre','Albédo relatif · 0,31','Les grands terrains sombres de Ganymède se distinguent des bandes de glace plus claires.'),
        survey('galileo-rift','Couloir fracturé',-91,147,'Télémètre','Ouverture locale · 15 m','La tectonique a fracturé le terrain sombre dans plusieurs directions près de Galileo Regio.'),
        survey('galileo-boundary','Limite du plateau',112,218,'Spectromètre','Glace d’eau · détectée','Dans ce relief simulé, un secteur clair met en évidence la limite entre deux paysages.')
      ]
    },
    {
      id:'tros',name:'Cratère Tros',latitude:11.14,longitude:-27.26,
      zone:'Cratère équatorial · éjectas brillants',
      description:'Descends au milieu des éjectas clairs d’un cratère de glace, avec Jupiter dans le ciel quand sa direction le permet.',
      terrain:{seed:6091,shape:'craters',scale:1.35},
      places:[
        survey('tros-ice','Éjectas givrés',-9,68,'Spectromètre','Glace à grains fins · signal compatible','L’impact a déposé des rayons clairs autour du cratère.'),
        survey('tros-wall','Paroi intérieure',96,143,'Télémètre','Paroi locale · 28 m','Les pentes restituent à petite échelle la géométrie d’une cuvette d’impact.'),
        survey('tros-ray','Bord du rayon clair',-106,217,'Photomètre','Contraste d’albédo · 0,23','La limite du rayon permet de comparer les matériaux excavés avec le terrain voisin.')
      ]
    }
  ]
};
