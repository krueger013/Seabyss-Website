/* Complete presentation vocabulary. Engine data and player-created names stay unchanged. */
(() => {
  'use strict';
  const rows = `
Petits Compagnons · ton jardin de poche|Little Companions · your pocket garden|Pequeños Compañeros · tu jardín de bolsillo
Petits Compagnons, accueil|Little Companions, home|Pequeños Compañeros, inicio
petits compagnons|little companions|pequeños compañeros
TON PETIT BONHEUR AU QUOTIDIEN|A LITTLE HAPPINESS EVERY DAY|UN POCO DE FELICIDAD CADA DÍA
Navigation principale|Main navigation|Navegación principal
Mon jardin|My garden|Mi jardín
Mes compagnons|My companions|Mis compañeros
La boutique|The shop|La tienda
Les étoiles se gagnent dans les mini-jeux|Earn stars in the mini-games|Gana estrellas en los minijuegos
étoiles|stars|estrellas
Couper la musique et les sons|Mute music and sounds|Silenciar música y sonidos
Activer la musique et les sons|Enable music and sounds|Activar música y sonidos
Options et sauvegarde|Settings and save|Opciones y partida guardada
UN PEU DE DOUCEUR, CHAQUE JOUR|A LITTLE GENTLENESS, EVERY DAY|UN POCO DE TERNURA CADA DÍA
La vie est plus douce|Life is sweeter|La vida es más dulce
à deux.|together.|en compañía.
Un petit compagnon, une grande histoire à commencer.|A little companion, a big story to begin.|Un pequeño compañero y una gran historia por comenzar.
Un joli jour pour jouer|A lovely day to play|Un bonito día para jugar
Prends le temps de grandir ensemble.|Take time to grow together.|Tómate tu tiempo para crecer en compañía.
Le jardin de ton compagnon|Your companion’s garden|El jardín de tu compañero
Ambiance du jardin|Garden atmosphere|Ambiente del jardín
☀ Jardin|☀ Garden|☀ Jardín
☾ Étoiles|☾ Stars|☾ Estrellas
Afficher le jardin en plein écran|Show the garden fullscreen|Ver el jardín en pantalla completa
Plein écran|Fullscreen|Pantalla completa
Quitter le plein écran|Exit fullscreen|Salir de pantalla completa
LE JARDIN DES RÊVES|THE GARDEN OF DREAMS|EL JARDÍN DE LOS SUEÑOS
Une petite rencontre t’attend…|A little friend is waiting…|Un pequeño amigo te espera…
Choisis ton tout premier compagnon.|Choose your very first companion.|Elige a tu primer compañero.
Caresser ton compagnon|Pet your companion|Acariciar a tu compañero
Un adorable petit chat|An adorable little kitten|Un adorable gatito
Ton futur compagnon|Your future companion|Tu futuro compañero
Une aventure pleine de petits bonheurs|An adventure full of little joys|Una aventura llena de pequeñas alegrías
Prendre soin de son compagnon|Care for your companion|Cuidar de tu compañero
À table|Time to eat|A comer
Un petit délice|A little treat|Una delicia
Au bain|Bath time|Al baño
Tout propre|All clean|Bien limpio
Un câlin|A cuddle|Un abrazo
Tout mon amour|All my love|Todo mi cariño
Au dodo|Bedtime|A dormir
De beaux rêves|Sweet dreams|Dulces sueños
On joue ?|Shall we play?|¿Jugamos?
À nous l’aventure|Adventure awaits|Nos espera una aventura
Informations et besoins du compagnon|Companion information and needs|Información y necesidades del compañero
MON PETIT COMPAGNON|MY LITTLE COMPANION|MI PEQUEÑO COMPAÑERO
Une belle rencontre|A lovely new friend|Una bonita amistad
Choisir un compagnon|Choose a companion|Elegir un compañero
Un nouveau départ|A new beginning|Un nuevo comienzo
À adopter|Ready for adoption|En adopción
Une amitié à faire grandir|A friendship to nurture|Una amistad por cultivar
Petit ventre|Little tummy|Barriguita
Nourriture|Food|Comida
Bonheur|Happiness|Felicidad
Énergie|Energy|Energía
Propreté|Cleanliness|Limpieza
✧ Grandir ensemble|✧ Growing together|✧ Crecer juntos
Œuf|Egg|Huevo
Bébé|Baby|Bebé
Junior|Junior|Joven
Adulte|Adult|Adulto
Quelques attentions suffisent pour commencer une belle histoire.|A little care is all it takes to start a lovely story.|Unos pequeños cuidados bastan para comenzar una bonita historia.
Les plus jolies amitiés commencent par de tout petits gestes.|The loveliest friendships begin with the smallest gestures.|Las amistades más bonitas comienzan con pequeños gestos.
DES SOUVENIRS À FABRIQUER|MEMORIES TO MAKE|RECUERDOS POR CREAR
Une petite pause pour jouer|A little break to play|Una pequeña pausa para jugar
Du bonheur et des étoiles à gagner|Happiness and stars to earn|Felicidad y estrellas por ganar
RÉFLEXES · 30 SECONDES|REFLEXES · 30 SECONDS|REFLEJOS · 30 SEGUNDOS
La cueillette magique|The magical harvest|La cosecha mágica
Attrape les douceurs du jardin.|Catch the garden’s sweet treats.|Atrapa las delicias del jardín.
C’est parti|Let’s go|A jugar
MÉMOIRE · À TON RYTHME|MEMORY · AT YOUR OWN PACE|MEMORIA · A TU RITMO
Les jolies paires|Lovely pairs|Bonitas parejas
Retrouve les petits trésors jumeaux.|Find the matching little treasures.|Encuentra los pequeños tesoros iguales.
RYTHME · 8 PETITS TEMPOS|RHYTHM · 8 LITTLE BEATS|RITMO · 8 PEQUEÑOS COMPASES
La danse des lucioles|The firefly dance|El baile de las luciérnagas
Une touche au bon moment !|One tap at the right moment!|¡Un toque en el momento justo!
✿ Fait pour les petits moments heureux.|✿ Made for little happy moments.|✿ Hecho para los pequeños momentos felices.
Ton aventure se sauvegarde toute seule|Your adventure saves automatically|Tu aventura se guarda automáticamente
Sauvegarde indisponible · exporte ton aventure dans les options|Saving unavailable · export your adventure in settings|No se puede guardar · exporta tu aventura en las opciones
Comment jouer ?|How to play?|¿Cómo se juega?
Fermer|Close|Cerrar
Dans son œuf|In the egg|En su huevo
Petit bébé|Little baby|Pequeño bebé
Junior curieux|Curious junior|Joven curioso
Grand compagnon|Grown companion|Compañero adulto
Activés|Enabled|Activados
Désactivés|Disabled|Desactivados
Activée|Enabled|Activada
Désactivée|Disabled|Desactivada
Un petit cœur bien au chaud|A little heart, warm and snug|Un corazoncito bien calentito
Toc, toc… quelqu’un est là ?|Knock, knock… is anyone there?|Toc, toc… ¿hay alguien ahí?
Clique sur l’œuf pour lui donner de la chaleur.|Tap the egg to warm it up.|Toca el huevo para darle calor.
Au pays des jolis rêves|In the land of sweet dreams|En el país de los dulces sueños
Chuuut… je rêve de toi.|Shhh… I’m dreaming of you.|Shhh… estoy soñando contigo.
Je récupère 5 points d’énergie par minute.|I recover 5 energy points per minute.|Recupero 5 puntos de energía por minuto.
Une petite faim à combler|A little tummy needs filling|Una barriguita con hambre
Mon petit ventre gargouille…|My little tummy is rumbling…|Me suena la barriguita…
Quelques baies du jardin me feraient plaisir.|Some garden berries would make me happy.|Me encantarían unas bayas del jardín.
Une sieste lui ferait du bien|A nap would do some good|Le vendría bien una siesta
Mes paupières sont lourdes…|My eyelids feel heavy…|Me pesan los párpados…
Un petit dodo et je serai en pleine forme.|A little nap and I’ll feel great.|Con una siestecita volveré a tener energía.
Un peu de mousse et de douceur|Some bubbles and gentle care|Un poco de espuma y ternura
J’ai exploré toutes les flaques !|I explored every puddle!|¡He explorado todos los charcos!
On fait un bain plein de petites bulles ?|How about a bath full of little bubbles?|¿Nos damos un baño lleno de burbujitas?
Envie d’un moment avec toi|Wishing for a moment with you|Con ganas de pasar un rato contigo
Tu viens jouer avec moi ?|Will you come play with me?|¿Vienes a jugar conmigo?
Un câlin ou un mini-jeu et tout va mieux.|A cuddle or a mini-game makes everything better.|Un abrazo o un minijuego lo arregla todo.
Heureux comme tout|Happy as can be|Feliz de la vida
C’est encore mieux quand tu es là ♡|It’s even better with you here ♡|Todo es mejor cuando estás aquí ♡
Un petit câlin ? Clique sur moi !|A little cuddle? Tap me!|¿Un abracito? ¡Tócame!
On se lève|Wake up|A despertar
Coucou le monde|Hello, world|Hola, mundo
Réchauffe l’œuf avec 5 petits gestes de tendresse pour le faire éclore.|Warm the egg with 5 little gestures of kindness to hatch it.|Dale calor al huevo con 5 pequeños gestos de cariño para que nazca.
Les soins et les mini-jeux font grandir votre amitié. Prochaine étape : junior !|Care and mini-games grow your friendship. Next stage: junior!|Los cuidados y los minijuegos hacen crecer vuestra amistad. ¡Siguiente etapa: joven!
Ton compagnon a bien grandi ! Continue à partager des petits bonheurs.|Your companion has grown! Keep sharing little joys.|¡Tu compañero ha crecido! Sigue compartiendo pequeñas alegrías.
Une grande amitié ! Continue à jouer, collectionner et prendre soin de lui.|A wonderful friendship! Keep playing, collecting and caring.|¡Una gran amistad! Sigue jugando, coleccionando y cuidándolo.
Une sieste toute douce · +5 énergie par minute|A gentle nap · +5 energy per minute|Una dulce siesta · +5 de energía por minuto
Chaque clic réchauffe son petit cœur. Il sera bientôt prêt à te rencontrer.|Every tap warms its little heart. It will be ready to meet you soon.|Cada toque calienta su corazoncito. Pronto estará listo para conocerte.
Tu peux adopter les quatre compagnons. Chacun garde sa propre histoire.|You can adopt all four companions. Each keeps their own story.|Puedes adoptar a los cuatro compañeros. Cada uno conserva su propia historia.
Les baies sont toujours gratuites. Ici, on trouve toujours de quoi prendre soin de son ami.|Berries are always free. There’s always a way to care for your friend here.|Las bayas siempre son gratis. Aquí siempre hay una forma de cuidar de tu amigo.
UNE BELLE HISTOIRE COMMENCE|A LOVELY STORY BEGINS|COMIENZA UNA BONITA HISTORIA
Qui fera battre ton cœur ?|Who will win your heart?|¿Quién te robará el corazón?
Choisis ton petit compagnon. Tout commence dans un œuf,|Choose your little companion. It all begins in an egg,|Elige a tu pequeño compañero. Todo comienza en un huevo,
et grandit avec un peu d’amour.|and grows with a little love.|y crece con un poco de amor.
Son petit nom|Their little name|Su nombre
Adopter mon compagnon|Adopt my companion|Adoptar a mi compañero
Adoption gratuite · Tu pourras accueillir les quatre compagnons.|Free adoption · You can welcome all four companions.|Adopción gratuita · Podrás acoger a los cuatro compañeros.
Chaton feuille|Leaf kitten|Gatito hoja
Lapin nuage|Cloud bunny|Conejito nube
Renard soleil|Sun fox|Zorro sol
Dragon jardin|Garden dragon|Dragón del jardín
chaton feuille|leaf kitten|gatito hoja
lapin nuage|cloud bunny|conejito nube
renard soleil|sun fox|zorro sol
dragon jardin|garden dragon|dragón del jardín
Un petit gourmand qui adore les câlins et les siestes au soleil.|A little foodie who loves cuddles and sunny naps.|Un pequeño goloso al que le encantan los abrazos y las siestas al sol.
Une boule de douceur curieuse, toujours prête à jouer.|A curious bundle of softness, always ready to play.|Una bolita de ternura curiosa, siempre lista para jugar.
De grandes oreilles, un cœur tendre et mille aventures en tête.|Big ears, a tender heart and a thousand adventures in mind.|Orejas grandes, un corazón tierno y mil aventuras en mente.
Un minuscule dragon qui fait pousser les sourires.|A tiny dragon who makes smiles bloom.|Un dragoncito que hace brotar sonrisas.
UNE FAMILLE TOUTE DOUCE|A FAMILY FULL OF LOVE|UNA FAMILIA LLENA DE TERNURA
Mes petits compagnons|My little companions|Mis pequeños compañeros
Chacun grandit à son rythme et garde ses petits souvenirs.|Each grows at their own pace and keeps their own little memories.|Cada uno crece a su ritmo y conserva sus pequeños recuerdos.
Avec toi ♡|With you ♡|Contigo ♡
Retrouver ↗|Visit ↗|Visitar ↗
Accueillir un nouvel ami ＋|Welcome a new friend ＋|Acoger a un nuevo amigo ＋
Les quatre petits cœurs sont réunis. Ta famille est au complet ♡|All four little hearts are together. Your family is complete ♡|Los cuatro corazoncitos están juntos. Tu familia está completa ♡
UN PETIT FESTIN|A LITTLE FEAST|UN PEQUEÑO FESTÍN
Qu’est-ce qu’on grignote ?|What shall we nibble?|¿Qué picamos?
Un ventre heureux, c’est le début d’une belle journée.|A happy tummy is the start of a lovely day.|Una barriguita feliz es el comienzo de un bonito día.
Toujours gratuit ♡|Always free ♡|Siempre gratis ♡
Baies du jardin|Garden berries|Bayas del jardín
Carotte croquante|Crunchy carrot|Zanahoria crujiente
Soupe réconfortante|Comforting soup|Sopa reconfortante
LES PETITS TRÉSORS|LITTLE TREASURES|PEQUEÑOS TESOROS
Un jardin à votre image|A garden of your own|Un jardín a tu gusto
Des accessoires tout doux et quelques touches de magie.|Sweet accessories and a few touches of magic.|Accesorios adorables y unos toques de magia.
Dans ton jardin ✓|In your garden ✓|En tu jardín ✓
Retirer|Remove|Quitar
Porter|Wear|Poner
Gagne des étoiles dans les mini-jeux. Tous les achats se font avec les étoiles du jeu.|Earn stars in mini-games. All purchases use in-game stars.|Gana estrellas en los minijuegos. Todas las compras se hacen con las estrellas del juego.
Fleur des prés|Meadow flower|Flor del prado
Nœud papillon|Bow tie|Pajarita
Couronne étoilée|Starry crown|Corona estrellada
Lanterne magique|Magic lantern|Linterna mágica
Petits champignons|Little mushrooms|Pequeñas setas
Une jolie fleur à porter.|A lovely flower to wear.|Una bonita flor para llevar.
Pour les grandes et petites occasions.|For occasions big and small.|Para grandes y pequeñas ocasiones.
La vedette du jardin, c’est toi !|You’re the star of the garden!|¡Tú eres la estrella del jardín!
Une douce lumière dans le jardin.|A gentle light in the garden.|Una luz suave en el jardín.
Un coin de forêt enchantée.|A little enchanted forest.|Un rincón de bosque encantado.
BIENVENUE DANS TON PETIT MONDE|WELCOME TO YOUR LITTLE WORLD|BIENVENIDO A TU PEQUEÑO MUNDO
Les petits gestes qui comptent|Little gestures that matter|Los pequeños gestos que cuentan
Pas de course : ici, on prend le temps de grandir.|There’s no rush: here, we take time to grow.|Sin prisas: aquí nos tomamos tiempo para crecer.
Choisis et nomme ton compagnon.|Choose and name your companion.|Elige y ponle nombre a tu compañero.
Clique cinq fois sur son œuf pour le réchauffer et le faire éclore.|Tap its egg five times to warm it and help it hatch.|Toca su huevo cinco veces para calentarlo y hacer que nazca.
Veille à ses quatre besoins.|Look after their four needs.|Cuida de sus cuatro necesidades.
Nourris-le, lave-le, câline-le et laisse-le dormir. Les baies sont gratuites ; une sieste rend 5 points d’énergie par minute.|Feed, wash and cuddle your friend, and let them sleep. Berries are free; a nap restores 5 energy points per minute.|Dale de comer, báñalo, abrázalo y déjalo dormir. Las bayas son gratis; una siesta recupera 5 puntos de energía por minuto.
Partage des mini-jeux.|Share mini-games.|Compartid minijuegos.
Attrape des fruits, retrouve des paires ou joue en rythme pour gagner des étoiles et de l’amitié.|Catch fruit, find pairs or play to the beat to earn stars and friendship.|Atrapa frutas, encuentra parejas o sigue el ritmo para ganar estrellas y amistad.
Grandissez ensemble.|Grow together.|Creced juntos.
À 90 points d’amitié, ton bébé devient junior. À 220, il devient adulte : il grandit à l’écran et scintille !|At 90 friendship points, your baby becomes a junior. At 220, it becomes an adult: it grows on screen and sparkles!|Con 90 puntos de amistad, tu bebé pasa a joven. Con 220, se vuelve adulto: ¡crece en pantalla y brilla!
Crée ta petite famille.|Create your little family.|Crea tu pequeña familia.
Adopte les quatre animaux et décore le jardin à la boutique. Leurs besoins évoluent doucement, même pendant ton absence (8 heures maximum).|Adopt all four animals and decorate the garden in the shop. Their needs change gently, even while you’re away (up to 8 hours).|Adopta a los cuatro animales y decora el jardín en la tienda. Sus necesidades cambian poco a poco, incluso mientras no estás (8 horas como máximo).
Le jeu se sauvegarde dans ce navigateur. Garde le même fichier et le même navigateur pour retrouver ton aventure. Tu peux aussi exporter une copie dans les options. Aucun compte, aucune publicité.|The game saves in this browser. Keep the same file and browser to return to your adventure. You can also export a copy in settings. No account, no ads.|El juego se guarda en este navegador. Usa el mismo archivo y navegador para continuar tu aventura. También puedes exportar una copia en las opciones. Sin cuentas ni anuncios.
TON PETIT COIN TRANQUILLE|YOUR LITTLE QUIET CORNER|TU PEQUEÑO RINCÓN TRANQUILO
Options & souvenirs|Settings & memories|Opciones y recuerdos
Garde une copie de votre histoire, juste au cas où.|Keep a copy of your story, just in case.|Guarda una copia de vuestra historia, por si acaso.
✧ Petits bruitages|✧ Little sound effects|✧ Pequeños efectos de sonido
Câlins, bulles, gourmandises et petites victoires.|Cuddles, bubbles, treats and little victories.|Abrazos, burbujas, delicias y pequeñas victorias.
Volume des bruitages|Sound effects volume|Volumen de los efectos
▷ Écouter un petit son|▷ Preview a little sound|▷ Escuchar un sonido
♫ Musique douce|♫ Gentle music|♫ Música suave
Volume de la musique|Music volume|Volumen de la música
Une boucle tranquille, encore plus discrète pendant les siestes et les mini-jeux.|A peaceful loop, even softer during naps and mini-games.|Una melodía tranquila, aún más suave durante las siestas y los minijuegos.
Des sons gratuits, choisis avec soin · CC0|Free sounds, carefully chosen · CC0|Sonidos gratuitos elegidos con cariño · CC0
Bruitages :|Sound effects:|Efectos de sonido:
Musique :|Music:|Música:
Licences CC0, sources et crédits conservés dans le dossier du jeu.|CC0 licenses, sources and credits are kept in the game folder.|Las licencias CC0, fuentes y créditos se conservan en la carpeta del juego.
↓ Exporter ma sauvegarde|↓ Export my save|↓ Exportar mi partida
↑ Choisir une sauvegarde à restaurer|↑ Choose a save to restore|↑ Elegir una partida para restaurar
Restaurer une sauvegarde remplace la partie de ce navigateur. Exporte la partie actuelle pour en garder une copie avant de confirmer la restauration.|Restoring a save replaces this browser’s game. Export the current game to keep a copy before confirming the restore.|Restaurar una partida reemplaza la de este navegador. Exporta la partida actual para conservar una copia antes de confirmar la restauración.
✓ La sauvegarde automatique fonctionne sur cet appareil.|✓ Automatic saving works on this device.|✓ El guardado automático funciona en este dispositivo.
Le navigateur refuse la sauvegarde automatique. Exporte régulièrement ton aventure.|This browser blocks automatic saving. Export your adventure regularly.|El navegador bloquea el guardado automático. Exporta tu aventura con frecuencia.
La musique démarre après ton premier clic et se met en pause quand tu quittes l’onglet. Tout fonctionne sans connexion Internet.|Music starts after your first tap and pauses when you leave the tab. Everything works without an Internet connection.|La música comienza tras tu primer toque y se pausa al salir de la pestaña. Todo funciona sin conexión a Internet.
Active les bruitages et monte leur volume pour écouter.|Enable sound effects and raise their volume to listen.|Activa los efectos de sonido y sube su volumen para escuchar.
Une copie de ton aventure est prête à être conservée.|A copy of your adventure is ready to keep.|Ya tienes una copia de tu aventura para guardar.
Ce fichier est trop volumineux pour une sauvegarde.|This file is too large for a game save.|Este archivo es demasiado grande para una partida guardada.
RETROUVER VOTRE HISTOIRE|RETURN TO YOUR STORY|RECUPERAR VUESTRA HISTORIA
Restaurer cette sauvegarde ?|Restore this save?|¿Restaurar esta partida?
La partie actuelle sera remplacée si le fichier est valide.|The current game will be replaced if the file is valid.|La partida actual se reemplazará si el archivo es válido.
Restaurer cette aventure|Restore this adventure|Restaurar esta aventura
Garder ma partie actuelle|Keep my current game|Conservar mi partida actual
Impossible de lire cette sauvegarde. Essaie un fichier JSON exporté par le jeu.|Unable to read this save. Try a JSON file exported by the game.|No se puede leer esta partida. Prueba un archivo JSON exportado por el juego.
Un petit réveil en douceur avant de passer à table.|A gentle wake-up before it’s time to eat.|Despiértalo con cariño antes de comer.
Je suis si content de te rencontrer.|I’m so happy to meet you.|Me alegro mucho de conocerte.
Regarde, j’ai grandi !|Look, I’ve grown!|¡Mira, he crecido!
junior|junior|joven
adulte|an adult|adulto
Réveille ton compagnon avant de partir jouer ensemble.|Wake your companion before going to play together.|Despierta a tu compañero antes de ir a jugar juntos.
Choisis une petite aventure ci-dessous !|Choose a little adventure below!|¡Elige una pequeña aventura aquí abajo!
Encore quelques câlins sur ton œuf avant de pouvoir jouer !|A few more cuddles for your egg before you can play!|¡Unos abrazos más a tu huevo antes de poder jugar!
Ton compagnon fait dodo. Réveille-le avant de jouer.|Your companion is sleeping. Wake them before playing.|Tu compañero está durmiendo. Despiértalo antes de jugar.
Le plein écran n’est pas disponible dans ce navigateur.|Fullscreen is unavailable in this browser.|La pantalla completa no está disponible en este navegador.
Une ancienne sauvegarde est illisible. Tu peux restaurer une copie dans les options.|An old save cannot be read. You can restore a copy in settings.|No se puede leer una partida antigua. Puedes restaurar una copia en las opciones.
Cette sauvegarde n’est pas compatible avec le jeu.|This save is incompatible with the game.|Esta partida no es compatible con el juego.
Un compagnon de cette sauvegarde ne peut pas être lu.|A companion in this save cannot be read.|No se puede leer un compañero de esta partida.
Ce petit animal n’existe pas.|This little animal does not exist.|Este animalito no existe.
Ce compagnon n’est pas dans ta famille.|This companion is not in your family.|Este compañero no pertenece a tu familia.
Choisis d’abord un petit compagnon.|Choose a little companion first.|Primero elige a un pequeño compañero.
Accessoire retiré.|Accessory removed.|Accesorio retirado.
Cet accessoire n’est pas encore dans ta collection.|This accessory is not in your collection yet.|Este accesorio aún no está en tu colección.
Réchauffe d’abord ton œuf pour le faire éclore.|Warm your egg first to help it hatch.|Primero calienta tu huevo para que nazca.
Ton œuf se réchauffe… encore un peu de douceur !|Your egg is warming up… a little more gentle care!|Tu huevo se está calentando… ¡un poco más de ternura!
Choisis une gourmandise dans le panier.|Choose a treat from the basket.|Elige una delicia de la cesta.
Il te manque quelques étoiles. Les baies sont toujours gratuites !|You need a few more stars. Berries are always free!|Te faltan unas estrellas. ¡Las bayas siempre son gratis!
Un gros câlin et plein de petits cœurs !|A big cuddle and lots of little hearts!|¡Un gran abrazo y muchos corazoncitos!
Cette action n’est pas disponible.|This action is unavailable.|Esta acción no está disponible.
Ton compagnon doit éclore avant de jouer.|Your companion must hatch before playing.|Tu compañero debe nacer antes de jugar.
Ton compagnon se repose pour le moment.|Your companion is resting right now.|Tu compañero está descansando.
Cette récompense ne peut pas être ajoutée.|This reward cannot be added.|No se puede añadir esta recompensa.
Cet objet n’existe pas dans la boutique.|This item does not exist in the shop.|Este objeto no existe en la tienda.
Tu possèdes déjà ce petit trésor.|You already own this little treasure.|Ya tienes este pequeño tesoro.
Ce réglage doit être activé ou désactivé.|This setting must be enabled or disabled.|Esta opción debe estar activada o desactivada.
Sons activés.|Sound enabled.|Sonidos activados.
Sons désactivés.|Sound disabled.|Sonidos desactivados.
Musique activée.|Music enabled.|Música activada.
Musique désactivée.|Music disabled.|Música desactivada.
Choisis un volume entre 0 et 100 %.|Choose a volume from 0 to 100%.|Elige un volumen entre 0 y 100 %.
Ce réglage n’est pas disponible.|This setting is unavailable.|Esta opción no está disponible.
Ce fichier de sauvegarde est trop grand ou illisible.|This save file is too large or unreadable.|Este archivo de partida es demasiado grande o ilegible.
Ce fichier n’est pas une sauvegarde valide.|This file is not a valid game save.|Este archivo no es una partida válida.
Tes petits compagnons sont de retour !|Your little companions are back!|¡Tus pequeños compañeros han vuelto!
RÉFLEXES & PETITS FRUITS|REFLEXES & LITTLE FRUITS|REFLEJOS Y PEQUEÑOS FRUTOS
Attrape les fraises et les étoiles pendant 30 secondes. Évite les nuages de pluie !|Catch strawberries and stars for 30 seconds. Avoid the rain clouds!|Atrapa fresas y estrellas durante 30 segundos. ¡Evita las nubes de lluvia!
Déplace le panier avec la souris, ton doigt ou les flèches ← →.|Move the basket with the mouse, your finger or the ← → arrows.|Mueve la cesta con el ratón, el dedo o las flechas ← →.
Les fraises valent 1 point, les étoiles 3. Un nuage enlève 2 points.|Strawberries are worth 1 point, stars 3. A cloud costs 2 points.|Las fresas valen 1 punto y las estrellas 3. Una nube quita 2 puntos.
MÉMOIRE & DOUCEUR|MEMORY & GENTLENESS|MEMORIA Y TERNURA
Retourne les cartes et retrouve les 6 paires cachées dans le jardin.|Turn over the cards and find the 6 pairs hidden in the garden.|Da la vuelta a las cartas y encuentra las 6 parejas escondidas en el jardín.
Clique ou touche deux cartes. Tu peux aussi utiliser Tab et Entrée.|Click or tap two cards. You can also use Tab and Enter.|Haz clic o toca dos cartas. También puedes usar Tab y Entrar.
Prends ton temps : chaque paire retrouvée rapproche ton compagnon de sa récompense.|Take your time: each pair found brings your companion closer to a reward.|Tómate tu tiempo: cada pareja encontrada acerca a tu compañero a su recompensa.
RYTHME & PRÉCISION|RHYTHM & PRECISION|RITMO Y PRECISIÓN
Attrape le bon tempo : appuie quand la luciole traverse la zone verte.|Catch the beat: tap when the firefly crosses the green zone.|Sigue el ritmo: pulsa cuando la luciérnaga cruce la zona verde.
Clique sur « Hop ! », touche le bouton ou utilise la barre d’espace.|Click “Hop!”, tap the button or use the space bar.|Haz clic en «¡Salta!», toca el botón o usa la barra espaciadora.
8 essais. Au centre : 3 points. Dans la zone verte : 2 points.|8 attempts. In the center: 3 points. In the green zone: 2 points.|8 intentos. En el centro: 3 puntos. En la zona verde: 2 puntos.
Fermer le mini-jeu|Close the mini-game|Cerrar el minijuego
☁ Jeu en pause — reviens quand tu veux|☁ Game paused — come back whenever you like|☁ Juego en pausa — vuelve cuando quieras
C’est parti !  →|Let’s go! →|¡A jugar! →
Toutes les paires réunies !|All pairs found!|¡Todas las parejas encontradas!
Bien joué, petit champion !|Well done, little champion!|¡Bien hecho, pequeño campeón!
Chaque essai fait progresser !|Every try helps you improve!|¡Cada intento te ayuda a mejorar!
Rejouer|Play again|Volver a jugar
Retrouver mon compagnon|Return to my companion|Volver con mi compañero
TEMPS|TIME|TIEMPO
RÉCOLTE|HARVEST|COSECHA
Cueillette : déplace le panier avec les flèches gauche et droite.|Harvest: move the basket with the left and right arrows.|Cosecha: mueve la cesta con las flechas izquierda y derecha.
ESSAIS|ATTEMPTS|INTENTOS
PAIRES|PAIRS|PAREJAS
Les douze cartes du jardin|The twelve garden cards|Las doce cartas del jardín
Six petites paires. Un grand moment de complicité.|Six little pairs. One wonderful moment together.|Seis pequeñas parejas. Un gran momento en compañía.
ESSAI|ATTEMPT|INTENTO
POINTS|POINTS|PUNTOS
À toi de jouer !|Your turn to play!|¡Te toca jugar!
Appuie quand la luciole atteint le centre.|Tap when the firefly reaches the center.|Pulsa cuando la luciérnaga llegue al centro.
Hop !|Hop!|¡Salta!
Au centre = parfait ✦     Dans le vert = bien joué|Center = perfect ✦     Green = well done|Centro = perfecto ✦     Verde = bien hecho
Parfait ! +3 points|Perfect! +3 points|¡Perfecto! +3 puntos
Bien joué ! +2 points|Well done! +2 points|¡Bien hecho! +2 puntos
La luciole est passée !|The firefly has passed!|¡La luciérnaga ya ha pasado!
Presque ! Réessaie au prochain passage.|Almost! Try again on the next pass.|¡Casi! Vuelve a intentarlo cuando pase de nuevo.
Vise le cœur de la zone verte…|Aim for the heart of the green zone…|Apunta al centro de la zona verde…
`;
  const strings = Object.fromEntries(rows.trim().split('\n').map(row => {
    const [fr, en, es] = row.split('|');
    return [fr, { fr, en, es }];
  }));
  const templates = [];
  for (const [key, value] of Object.entries(strings)) strings[key.replace(/\s+/g, ' ').trim()] = value;
  strings['· Au dodo'] = {fr:'· Au dodo',en:'· Sleeping',es:'· Durmiendo'};
  strings['Un petit jardin, quatre adorables compagnons et plein de tendresse. Un jeu Tamagotchi gratuit, en français, qui se sauvegarde sur cet appareil.'] = {fr:'Un petit jardin, quatre adorables compagnons et plein de tendresse. Un jeu Tamagotchi gratuit en français, anglais ou espagnol, qui se sauvegarde sur cet appareil.',en:'A little garden, four adorable companions and lots of tenderness. A free Tamagotchi game in French, English or Spanish that saves on this device.',es:'Un pequeño jardín, cuatro compañeros adorables y mucha ternura. Un juego Tamagotchi gratuito en francés, inglés o español que se guarda en este dispositivo.'};
  const pattern = (source, en, es, opaque = []) => templates.push({ source, fr: source, en, es, opaque });
  pattern('{0} pour cent', '{0} percent', '{0} por ciento');
  pattern('{0} attend de te rencontrer. Une belle amitié se prépare !', '{0} is waiting to meet you. A lovely friendship is about to begin!', '¡{0} está esperando conocerte. Se prepara una bonita amistad!', [0]);
  pattern('{0} est chez lui, et toi aussi. Fais comme chez toi.', '{0} is at home, and so are you. Make yourself comfortable.', '{0} está en casa, y tú también. Siéntete como en casa.', [0]);
  pattern('{0}, chaton feuille', '{0}, leaf kitten', '{0}, gatito hoja', [0]);
  pattern('{0}, lapin nuage', '{0}, cloud bunny', '{0}, conejito nube', [0]);
  pattern('{0}, renard soleil', '{0}, sun fox', '{0}, zorro sol', [0]);
  pattern('{0}, dragon jardin', '{0}, garden dragon', '{0}, dragón del jardín', [0]);
  pattern('Réchauffer l’œuf de {0}, {1}%', 'Warm {0}’s egg, {1}%', 'Calentar el huevo de {0}, {1} %', [0]);
  pattern('Réveiller {0}', 'Wake {0}', 'Despertar a {0}', [0]);
  pattern('Faire un câlin à {0}', 'Cuddle {0}', 'Abrazar a {0}', [0]);
  pattern('{0} / 5 câlins', '{0} / 5 cuddles', '{0} / 5 abrazos');
  pattern('{0} / 90 amitié', '{0} / 90 friendship', '{0} / 90 amistad');
  pattern('{0} / 220 amitié', '{0} / 220 friendship', '{0} / 220 amistad');
  pattern('{0} amitié', '{0} friendship', '{0} amistad');
  pattern('Réchauffe ton œuf · {0} / 5', 'Warm your egg · {0} / 5', 'Calienta tu huevo · {0} / 5');
  pattern('{0} petits moments partagés ensemble', '{0} little moments shared together', '{0} pequeños momentos compartidos');
  pattern('{0} · {1} · Au dodo', '{0} · {1} · Sleeping', '{0} · {1} · Durmiendo');
  pattern('{0} · {1}', '{0} · {1}', '{0} · {1}');
  pattern('+{0} petit ventre', '+{0} tummy', '+{0} barriguita');
  pattern('+{0} amitié', '+{0} friendship', '+{0} amistad');
  pattern('Ta tirelire : {0} étoiles ✦', 'Your savings: {0} stars ✦', 'Tu hucha: {0} estrellas ✦');
  pattern('Adopter · {0} ✦', 'Get · {0} ✦', 'Conseguir · {0} ✦');
  pattern('Fichier choisi : {0}', 'Selected file: {0}', 'Archivo elegido: {0}', [0]);
  pattern('Coucou ! Moi, c’est {0} ♡', 'Hi! I’m {0} ♡', '¡Hola! Soy {0} ♡', [0]);
  pattern('{0} est maintenant junior ♡', '{0} is now a junior ♡', '{0} ahora es joven ♡', [0]);
  pattern('{0} est maintenant adulte ♡', '{0} is now an adult ♡', '{0} ahora es adulto ♡', [0]);
  pattern('{0} a évolué ! Votre amitié le fait grandir ♡', '{0} has grown! Your friendship helps them grow ♡', '¡{0} ha crecido! Vuestra amistad le ayuda a crecer ♡', [0]);
  pattern('{0} est déjà dans ta famille.', '{0} is already in your family.', '{0} ya pertenece a tu familia.', [0]);
  pattern('L’œuf de {0} t’attend !', '{0}’s egg is waiting for you!', '¡El huevo de {0} te espera!', [0]);
  pattern('{0} est avec toi.', '{0} is with you.', '{0} está contigo.', [0]);
  pattern('Un nouveau look pour {0} !', 'A new look for {0}!', '¡Un nuevo aspecto para {0}!', [0]);
  pattern('Bienvenue au monde, {0} !', 'Welcome to the world, {0}!', '¡Bienvenido al mundo, {0}!', [0]);
  pattern('Chut… {0} recharge ses petites batteries.', 'Shhh… {0} is recharging.', 'Shhh… {0} está recuperando energía.', [0]);
  pattern('Bonjour {0}, prêt pour une nouvelle aventure !', 'Hello {0}, ready for a new adventure!', '¡Hola, {0}, una nueva aventura te espera!', [0]);
  pattern('{0} dort. Réveille-le doucement pour jouer.', '{0} is sleeping. Wake them gently to play.', '{0} está durmiendo. Despiértalo con cariño para jugar.', [0]);
  pattern('{0} a déjà le ventre bien rempli !', '{0} already has a full tummy!', '¡{0} ya tiene la barriguita llena!', [0]);
  pattern('Miam ! {0} se régale.', 'Yum! {0} is enjoying the treat.', '¡Ñam! {0} está disfrutando de la comida.', [0]);
  pattern('{0} est déjà tout propre !', '{0} is already nice and clean!', '¡{0} ya está bien limpio!', [0]);
  pattern('Plouf ! {0} sent bon les fleurs.', 'Splash! {0} smells like flowers.', '¡Chof! {0} huele a flores.', [0]);
  pattern('{0} déborde déjà de bonheur !', '{0} is already full of happiness!', '¡{0} ya rebosa felicidad!', [0]);
  pattern('Bravo ! +{0} étoiles et +{1} points d’amitié.', 'Well done! +{0} stars and +{1} friendship points.', '¡Muy bien! +{0} estrellas y +{1} puntos de amistad.');
  pattern('Encore {0} étoiles pour ce petit trésor.', 'You need {0} more stars for this little treasure.', 'Te faltan {0} estrellas para este pequeño tesoro.');
  pattern('{0} rejoint ta collection !', '{0} joins your collection!', '¡{0} se une a tu colección!');
  pattern('Volume des sons : {0} %.', 'Sound volume: {0}%.', 'Volumen de los sonidos: {0} %.');
  pattern('Volume de la musique : {0} %.', 'Music volume: {0}%.', 'Volumen de la música: {0} %.');
  pattern('{0} point récolté', '{0} point collected', '{0} punto recogido');
  pattern('{0} points récoltés', '{0} points collected', '{0} puntos recogidos');
  pattern('✦ {0} étoiles', '✦ {0} stars', '✦ {0} estrellas');
  pattern('♥ +{0} bonheur', '♥ +{0} happiness', '♥ +{0} felicidad');
  pattern('🌱 +{0} amitié', '🌱 +{0} friendship', '🌱 +{0} amistad');
  pattern('Partie terminée. {0} étoiles gagnées.', 'Game over. {0} stars earned.', 'Partida terminada. {0} estrellas ganadas.');
  pattern('Carte {0}, face cachée', 'Card {0}, face down', 'Carta {0}, boca abajo');
  pattern('Carte {0} : {1}', 'Card {0}: {1}', 'Carta {0}: {1}');
  pattern('Paire trouvée : {0}', 'Pair found: {0}', 'Pareja encontrada: {0}');
  pattern('Une paire trouvée ! {0} sur 6.', 'A pair found! {0} of 6.', '¡Una pareja encontrada! {0} de 6.');
  pattern('6 paires retrouvées en {0} essais.', '6 pairs found in {0} attempts.', '6 parejas encontradas en {0} intentos.');
  pattern('{0} points sur 24. Un joli moment en rythme !', '{0} points out of 24. A lovely time keeping the beat!', '¡{0} puntos de 24. Un bonito momento siguiendo el ritmo!');
  window.SeabyssI18n.register({ source: 'fr', strings, templates });
})();
