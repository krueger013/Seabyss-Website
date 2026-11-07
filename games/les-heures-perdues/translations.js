/* Complete presentation catalogue; save identifiers and puzzle solutions remain unchanged. */
(() => {
  'use strict';
  const strings = {};
  const add = (source, en, es) => { strings[source] = { en, es }; };
  const rows = `Les Heures Perdues	The Lost Hours	Las Horas Perdidas
Les Heures	The Lost	Las Horas
Perdues	Hours	Perdidas
Le testament de l’astronome	The Astronomer’s Testament	El testamento del astrónomo
Les Heures Perdues — Le testament de l’astronome	The Lost Hours — The Astronomer’s Testament	Las Horas Perdidas — El testamento del astrónomo
Les Heures Perdues — Une enquête d'objets cachés dans la Provence de la Renaissance.	The Lost Hours — A hidden-object investigation in Renaissance Provence.	Las Horas Perdidas — Una investigación de objetos ocultos en la Provenza del Renacimiento.
Une aventure d’observation & de mystère	An adventure of observation & mystery	Una aventura de observación y misterio
Un maître disparu. Un ciel chargé de secrets.	A missing master. A sky filled with secrets.	Un maestro desaparecido. Un cielo lleno de secretos.
Dans le silence de sa demeure, chaque objet	In the silence of his home, every object	En el silencio de su hogar, cada objeto
a quelque chose à vous révéler.	has something to reveal.	tiene algo que revelar.
Revoir le dénouement	Revisit the ending	Volver al desenlace
Reprendre l’enquête	Continue the investigation	Continuar la investigación
Commencer l’enquête	Begin the investigation	Comenzar la investigación
Nouvelle partie	New game	Nueva partida
Comment jouer	How to play	Cómo jugar
Secrets & bonus	Secrets & bonuses	Secretos y bonificaciones
Explorez à votre rythme. Le temps vous appartient.	Explore at your own pace. Time is yours.	Explora a tu ritmo. El tiempo te pertenece.
Les trois lieux de votre aventure	The three locations of your adventure	Los tres lugares de tu aventura
Le cabinet	The study	El gabinete
Le jardin	The garden	El jardín
La tour	The tower	La torre
Une enquête en trois chapitres	An investigation in three chapters	Una investigación en tres capítulos
Objets cachés · Énigmes · Secrets	Hidden objects · Puzzles · Secrets	Objetos ocultos · Enigmas · Secretos
Provence, 1566	Provence, 1566	Provenza, 1566
PROVENCE · MDLXVI	PROVENCE · MDLXVI	PROVENZA · MDLXVI
Navigation	Navigation	Navegación
Carte	Map	Mapa
Journal	Journal	Diario
Son activé	Sound on	Sonido activado
Son coupé	Sound off	Sonido desactivado
Options	Options	Opciones
Retour au menu	Back to menu	Volver al menú
Progression des chapitres	Chapter progress	Progreso de los capítulos
Prenez le temps d’observer	Take time to observe	Tómate tu tiempo para observar
Un instant…	One moment…	Un momento…
Trois clics sans objet.	Three clicks without an object.	Tres clics sin encontrar un objeto.
La scène se déverrouille dans	The scene unlocks in	La escena se desbloquea en
Temps restant	Time remaining	Tiempo restante
Les menus restent accessibles.	The menus remain accessible.	Los menús siguen disponibles.
Observez les détails. Chaque objet raconte une histoire.	Observe the details. Every object tells a story.	Observa los detalles. Cada objeto cuenta una historia.
Agrandir ou réduire la scène	Enlarge or reduce the scene	Ampliar o reducir la escena
Réduire	Reduce	Reducir
Agrandir	Enlarge	Ampliar
Plein écran	Fullscreen	Pantalla completa
Poursuivre l’enquête	Continue the investigation	Continuar la investigación
Examiner le coffret	Examine the casket	Examinar el cofre
Examiner l’alambic	Examine the still	Examinar el alambique
Examiner la sphère céleste	Examine the celestial sphere	Examinar la esfera celeste
Objets à retrouver	Objects to find	Objetos que encontrar
Ouvrez l’œil	Keep your eyes open	Abre bien los ojos
Objets cachés	Hidden objects	Objetos ocultos
Révéler l’emplacement d’un objet	Reveal an object’s location	Revelar la ubicación de un objeto
Révéler un objet (I)	Reveal an object (I)	Revelar un objeto (I)
Un indice	A hint	Una pista
Une lueur pour vous guider	A glimmer to guide you	Un destello para guiarte
Trois clics sans objet bloquent la scène pendant dix secondes.	Three clicks without finding an object lock the scene for ten seconds.	Tres clics sin encontrar un objeto bloquean la escena durante diez segundos.
Clics sans objet	Clicks without an object	Clics sin encontrar un objeto
3 = pause de 10 s	3 = 10-second pause	3 = pausa de 10 s
Le carnet de Camille	Camille’s journal	El diario de Camille
Lire le carnet	Read the journal	Leer el diario
Pièces de l’enquête	Evidence	Pruebas de la investigación
Pièce encore inconnue	Undiscovered evidence	Prueba aún desconocida
Le mystère se dévoile	The mystery unfolds	El misterio se revela
Contemplation	Contemplation	Contemplación
Détective	Detective	Detective
Sans limite de temps	No time limit	Sin límite de tiempo
Progression sauvegardée	Progress saved	Progreso guardado
Sauvegarde indisponible	Saving unavailable	Guardado no disponible
Fermer	Close	Cerrar
Prologue · Provence, 1566	Prologue · Provence, 1566	Prólogo · Provenza, 1566
Le maître a disparu.	The master has vanished.	El maestro ha desaparecido.
Vous incarnez	You play as	Interpretas a
Camille de Valombre	Camille de Valombre	Camille de Valombre
, ancienne élève de l’astronome Aurèle. Une lettre vous a conduite à sa demeure, désertée depuis trois jours.	, a former student of the astronomer Aurèle. A letter has brought you to his home, deserted for three days.	, antigua alumna del astrónomo Aurèle. Una carta te ha llevado a su casa, desierta desde hace tres días.
Retrouvez les	Find the	Encuentra los
huit objets de la liste	eight listed objects	ocho objetos de la lista
dans chaque scène, puis résolvez l’énigme pour découvrir le lieu suivant. Le carnet conserve vos découvertes.	in each scene, then solve the puzzle to discover the next location. Your journal records your discoveries.	en cada escena y resuelve el enigma para descubrir el siguiente lugar. El diario conserva tus descubrimientos.
Prenez votre temps. Les indices	Take your time. Hints	Tómate tu tiempo. Las pistas
vous aideront si nécessaire.	will help if needed.	te ayudarán si lo necesitas.
Entrer dans le cabinet →	Enter the study →	Entrar en el gabinete →
Tous les objets sont réunis. Le mécanisme vous attend.	All the objects have been gathered. The mechanism awaits.	Ya has reunido todos los objetos. El mecanismo te espera.
Tout retrouvé	Everything found	Todo encontrado
Scène en pause	Scene paused	Escena en pausa
Révéler un objet	Reveal an object	Revelar un objeto
Les lieux de l’enquête	Investigation locations	Lugares de la investigación
Sur les pas d’Aurèle	Following Aurèle’s footsteps	Tras los pasos de Aurèle
✓ Enquête résolue	✓ Investigation solved	✓ Investigación resuelta
● Vous êtes ici	● You are here	● Estás aquí
⌑ Lieu encore inaccessible	⌑ Location still inaccessible	⌑ Lugar aún inaccesible
Chaque énigme résolue ouvre le chapitre suivant.	Each solved puzzle unlocks the next chapter.	Cada enigma resuelto desbloquea el siguiente capítulo.
Mémoire de l’enquête	Investigation records	Memoria de la investigación
Votre objectif.	Your objective.	Tu objetivo.
Préférences	Preferences	Preferencias
À votre rythme	At your own pace	A tu ritmo
Mode détective	Detective mode	Modo detective
Indices espacés de 45 secondes, au lieu de 12.	Hints every 45 seconds instead of 12.	Pistas cada 45 segundos, en lugar de 12.
Trois clics sans objet : pause de 10 secondes.	Three clicks without an object: a 10-second pause.	Tres clics sin encontrar un objeto: pausa de 10 segundos.
Ambiance sonore	Ambient sound	Ambiente sonoro
Notes cristallines discrètes et sons de découverte.	Subtle crystalline notes and discovery sounds.	Notas cristalinas suaves y sonidos de descubrimiento.
La progression est enregistrée dans ce navigateur. Reprenez avec le même navigateur et le même fichier.	Progress is saved in this browser. Continue with the same browser and the same file.	El progreso se guarda en este navegador. Continúa con el mismo navegador y el mismo archivo.
Aide	Help	Ayuda
Enregistrer	Save	Guardar
Guide de jeu	Game guide	Guía del juego
L’art de l’observation	The art of observation	El arte de observar
Repérez les huit objets indiqués dans le panneau « Objets cachés ». Cliquez sur un objet pour le recueillir ; il scintille, puis reste illuminé et marqué d’une coche dorée. Son nom est barré dans la liste.	Find the eight objects listed in the Hidden Objects panel. Click an object to collect it; it sparkles, then remains lit with a golden checkmark. Its name is crossed off the list.	Encuentra los ocho objetos del panel « Objetos ocultos ». Haz clic en un objeto para recogerlo; brillará y quedará iluminado con una marca dorada. Su nombre se tachará en la lista.
Une fois la liste complétée, examinez le mécanisme. Sa devinette donne la solution ; le journal la conserve.	Once the list is complete, examine the mechanism. Its riddle gives the solution; the journal preserves it.	Cuando completes la lista, examina el mecanismo. Su acertijo da la solución y el diario la conserva.
Résolvez les trois chapitres pour découvrir le testament d’Aurèle.	Solve all three chapters to discover Aurèle’s testament.	Resuelve los tres capítulos para descubrir el testamento de Aurèle.
Besoin d’aide ?	Need help?	¿Necesitas ayuda?
Le bouton ✧ éclaire un objet. « Agrandir » permet de parcourir une scène plus grande avec les barres de défilement ou le doigt. Les décors contiennent aussi des objets qui ne sont pas à recueillir.	The ✧ button illuminates an object. Enlarge lets you explore a larger scene using the scrollbars or your finger. The scenery also contains objects you cannot collect.	El botón ✧ ilumina un objeto. « Ampliar » permite recorrer una escena más grande con las barras de desplazamiento o el dedo. Los escenarios también contienen objetos que no se pueden recoger.
Indice	Hint	Pista
Échap	Esc	Esc
Fermer	Close	Cerrar
Au clavier : Tab pour parcourir les commandes, Entrée pour les activer.	Keyboard: Tab to move through controls, Enter to activate them.	Teclado: Tab para recorrer los controles y Entrar para activarlos.
Observez avant de cliquer.	Observe before clicking.	Observa antes de hacer clic.
Trois clics dans la scène sans objet à ramasser déclenchent une pause de dix secondes. Le compteur se remet à zéro à la fin de la pause ou au chapitre suivant. Trouver un objet ne remet pas le compteur à zéro. La carte et le journal restent accessibles.	Three clicks on the scene without collecting an object trigger a ten-second pause. The counter resets when the pause ends or at the next chapter. Finding an object does not reset it. The map and journal remain accessible.	Tres clics en la escena sin recoger un objeto activan una pausa de diez segundos. El contador se reinicia al terminar la pausa o al pasar al siguiente capítulo. Encontrar un objeto no reinicia el contador. El mapa y el diario siguen disponibles.
Défis & bonus.	Challenges & bonuses.	Desafíos y bonificaciones.
Après quatre objets, un mini-jeu lié au lieu se débloque. Sa première réussite donne deux éclats de clairvoyance et un fragment d’histoire. Un éclat révèle jusqu’à deux objets sans les ramasser. Les trois défis réussis ouvrent le dernier secret dans « Secrets & bonus ». Les récompenses ne sont attribuées qu’une fois par défi ; les mini-jeux sont facultatifs et leur progression est sauvegardée.	After four objects, a location-specific mini-game unlocks. Its first completion awards two clairvoyance shards and a story fragment. One shard reveals up to two objects without collecting them. Completing the first three challenges unlocks the last secret in Secrets & Bonuses. Rewards are granted only once per challenge; mini-games are optional and their progress is saved.	Tras encontrar cuatro objetos, se desbloquea un minijuego del lugar. Su primera victoria otorga dos fragmentos de clarividencia y un fragmento de historia. Un fragmento revela hasta dos objetos sin recogerlos. Al superar los tres desafíos se desbloquea el último secreto en « Secretos y bonificaciones ». Las recompensas se reciben una sola vez por desafío; los minijuegos son opcionales y su progreso se guarda.
Chaque énigme propose une aide détaillée et une résolution assistée. Aucun passage ne peut vous bloquer.	Every puzzle offers detailed hints and an assisted solution. No stage can leave you stuck.	Cada enigma ofrece ayuda detallada y una solución asistida. Ningún pasaje puede bloquear tu avance.
J’ai compris	Got it	Entendido
Soleil	Sun	Sol
Lune	Moon	Luna
Étoile	Star	Estrella
Saturne	Saturn	Saturno
Cliquez sur chaque cadran pour changer son symbole	Click each dial to change its symbol	Haz clic en cada esfera para cambiar su símbolo
Ouvrir le coffret	Open the casket	Abrir el cofre
Ingrédients ajoutés	Ingredients added	Ingredientes añadidos
Feuille	Leaf	Hoja
Rose	Rose	Rosa
Champignon	Mushroom	Seta
Sauge	Sage	Salvia
Vider le mortier	Empty the mortar	Vaciar el mortero
Révéler l’encre	Reveal the ink	Revelar la tinta
Gardien	Guardian	Guardián
Voyageur	Traveler	Viajero
Couronne	Crown	Corona
Lyre	Lyre	Lira
Aube	Dawn	Alba
Effacer le tracé	Clear the path	Borrar el trazado
Le coffret des heures	The casket of hours	El cofre de las horas
Le révélateur de rosée	The dew developer	El revelador de rocío
Le chemin des étoiles	The path of stars	El camino de las estrellas
Consulter un indice	Consult a hint	Consultar una pista
Réglez les trois cadrans sur Lune ☽, Soleil ☉, puis Étoile ✦. Chaque clic fait tourner un cadran.	Set the three dials to Moon ☽, Sun ☉, then Star ✦. Each click turns a dial.	Ajusta las tres esferas a Luna ☽, Sol ☉ y Estrella ✦, en ese orden. Cada clic gira una esfera.
Ajoutez, dans cet ordre : la sauge, la rose, puis le champignon. Ensuite, révélez l’encre.	Add the sage, rose, then mushroom, in that order. Then reveal the ink.	Añade la salvia, la rosa y la seta, en ese orden. Después, revela la tinta.
Sélectionnez Gardien, Voyageur, Couronne, Lyre et Aube, dans cet ordre.	Select Guardian, Traveler, Crown, Lyre and Dawn, in that order.	Selecciona Guardián, Viajero, Corona, Lira y Alba, en ese orden.
Résoudre avec cette aide →	Solve with this help →	Resolver con esta ayuda →
Découvrir l’épilogue	Discover the epilogue	Descubrir el epílogo
Explorer le lieu suivant	Explore the next location	Explorar el siguiente lugar
Épilogue	Epilogue	Epílogo
Les heures retrouvées	The hours regained	Las horas recuperadas
« L’avenir n’est pas écrit.	“ The future is not written.	« El futuro no está escrito.
Il appartient à ceux qui l’éclairent. »	It belongs to those who illuminate it. ”	Pertenece a quienes lo iluminan. »
À l’aube, la ville s’éveille. Sur la table de la tour, vous posez le testament. Aurèle vous a laissé bien plus qu’un secret : une œuvre à poursuivre.	At dawn, the city awakens. You lay the testament on the tower’s table. Aurèle has left you more than a secret: a life’s work to continue.	Al alba, la ciudad despierta. Dejas el testamento sobre la mesa de la torre. Aurèle te ha legado mucho más que un secreto: una obra que continuar.
Votre enquête est terminée.	Your investigation is complete.	Tu investigación ha terminado.
OBJETS RETROUVÉS	OBJECTS FOUND	OBJETOS ENCONTRADOS
CHAPITRES RÉSOLUS	CHAPTERS SOLVED	CAPÍTULOS RESUELTOS
INDICES UTILISÉS	HINTS USED	PISTAS UTILIZADAS
Rejouer l’enquête	Replay the investigation	Volver a jugar la investigación
Nouvelle enquête	New investigation	Nueva investigación
Revenir au commencement ?	Return to the beginning?	¿Volver al principio?
Votre progression actuelle sera remplacée. Les préférences de son et de difficulté seront conservées.	Your current progress will be replaced. Sound and difficulty preferences will be kept.	Tu progreso actual será sustituido. Se conservarán las preferencias de sonido y dificultad.
Annuler	Cancel	Cancelar
Commencer	Begin	Comenzar
Mini-jeux et récompenses	Mini-games and rewards	Minijuegos y recompensas
Défi accompli	Challenge complete	Desafío completado
Un nouveau mystère	A new mystery	Un nuevo misterio
Un mystère à découvrir	A mystery to discover	Un misterio por descubrir
Rejouer	Replay	Volver a jugar
Jouer	Play	Jugar
Secrets et bonus (B)	Secrets and bonuses (B)	Secretos y bonificaciones (B)
Bonus	Bonuses	Bonificaciones
Les secrets retrouvés	Secrets uncovered	Secretos descubiertos
Médaille d’or	Gold medal	Medalla de oro
Médaille d’argent	Silver medal	Medalla de plata
Médaille de bronze	Bronze medal	Medalla de bronce
or	gold	oro
argent	silver	plata
bronze	bronze	bronce
Vous connaissez aussi la dernière confidence d’Aurèle.	You also know Aurèle’s final confidence.	También conoces la última confidencia de Aurèle.
L’enquête est résolue, mais les archives recèlent encore des secrets.	The investigation is solved, but the archives still hold secrets.	La investigación está resuelta, pero los archivos aún guardan secretos.
Reprenez une scène pour utiliser vos éclats.	Resume a scene to use your shards.	Vuelve a una escena para usar tus fragmentos.
La scène est en pause. Attendez la fin du décompte.	The scene is paused. Wait for the countdown to end.	La escena está en pausa. Espera a que termine la cuenta atrás.
Tous les objets de cette scène sont trouvés.	All objects in this scene have been found.	Se han encontrado todos los objetos de esta escena.
Réussissez un défi pour gagner des éclats.	Complete a challenge to earn shards.	Supera un desafío para ganar fragmentos.
Un éclat éclaire jusqu’à deux objets, sans les ramasser.	A shard illuminates up to two objects without collecting them.	Un fragmento ilumina hasta dos objetos sin recogerlos.
Les archives d’Aurèle	Aurèle’s archives	Los archivos de Aurèle
éclat(s) de clairvoyance	clairvoyance shard(s)	fragmento(s) de clarividencia
secrets retrouvés	secrets uncovered	secretos descubiertos
Un regard plus perçant	A keener eye	Una mirada más aguda
Réussissez les trois premiers défis.	Complete the first three challenges.	Supera los tres primeros desafíos.
Le dernier secret	The final secret	El último secreto
Une lettre inédite	An unseen letter	Una carta inédita
2 éclats + un fragment d’histoire	2 shards + a story fragment	2 fragmentos + un fragmento de historia
Partie en cours sauvegardée.	Current game saved.	Partida en curso guardada.
Rejouez pour améliorer votre médaille.	Play again to improve your medal.	Vuelve a jugar para mejorar tu medalla.
Le défi vous attend.	The challenge awaits.	El desafío te espera.
Reprendre	Resume	Continuar
Découvrir	Discover	Descubrir
Verrouillé	Locked	Bloqueado
Chaque défi donne sa récompense une seule fois. Vous pouvez rejouer pour améliorer votre médaille. Votre enquête principale peut continuer à tout moment.	Each challenge grants its reward only once. You can replay to improve your medal. You can continue the main investigation at any time.	Cada desafío otorga su recompensa una sola vez. Puedes volver a jugar para mejorar tu medalla. Puedes continuar la investigación principal en cualquier momento.
Ce mystère n’est pas encore accessible.	This mystery is not yet accessible.	Este misterio aún no está disponible.
Défi d’enquête	Investigation challenge	Desafío de investigación
Mystère élucidé	Mystery solved	Misterio resuelto
Une nouvelle pièce de l’histoire	A new piece of the story	Una nueva pieza de la historia
+2 éclats de clairvoyance	+2 clairvoyance shards	+2 fragmentos de clarividencia
La dernière confidence	The final confidence	La última confidencia
Votre meilleur résultat est conservé	Your best result is kept	Se conserva tu mejor resultado
Utilisez-les depuis « Bonus » pour éclairer des objets cachés.	Use them from Bonuses to illuminate hidden objects.	Úsalos desde « Bonificaciones » para iluminar objetos ocultos.
Les archives d’Aurèle sont désormais complètes.	Aurèle’s archives are now complete.	Los archivos de Aurèle ya están completos.
Ce défi a déjà donné sa récompense ; aucun éclat supplémentaire n’est ajouté.	This challenge has already granted its reward; no extra shard is added.	Este desafío ya ha otorgado su recompensa; no se añaden fragmentos adicionales.
Les trois fragments sont réunis. Le dernier mystère est maintenant accessible.	The three fragments are gathered. The final mystery is now accessible.	Ya has reunido los tres fragmentos. El último misterio está disponible.
Voir mes bonus	View my bonuses	Ver mis bonificaciones
Continuer l’enquête	Continue the investigation	Continuar la investigación
Ce bonus ne peut pas être utilisé pour le moment.	This bonus cannot be used right now.	Esta bonificación no se puede usar ahora.
La scène est de nouveau accessible. Bonne observation.	The scene is accessible again. Happy observing.	La escena vuelve a estar disponible. Observa con atención.
Le chemin s’efface. Reprenez avec le Gardien et suivez les mots du manuscrit.	The path fades. Start again with the Guardian and follow the manuscript’s words.	El camino se borra. Empieza de nuevo con el Guardián y sigue las palabras del manuscrito.
Le plein écran est indisponible dans cette fenêtre.	Fullscreen is unavailable in this window.	La pantalla completa no está disponible en esta ventana.
Utilisez le mode plein écran de votre navigateur.	Use your browser’s fullscreen mode.	Usa el modo de pantalla completa del navegador.
Les rouages résistent. Relisez l’ordre donné par la devinette.	The gears resist. Read the order in the riddle again.	Los engranajes se resisten. Relee el orden del acertijo.
L’encre reste invisible. Videz le mortier et suivez l’ordre de la recette.	The ink remains invisible. Empty the mortar and follow the recipe’s order.	La tinta sigue invisible. Vacía el mortero y sigue el orden de la receta.
La mémoire des sceaux	The memory of seals	La memoria de los sellos
Les doubles empreintes du cabinet	The study’s paired impressions	Las huellas gemelas del gabinete
Clairvoyance et fragment de témoignage	Clairvoyance and a testimony fragment	Clarividencia y un fragmento de testimonio
Les canaux de rosée	The dew channels	Los canales de rocío
Rétablissez le circuit de l’alambic	Restore the still’s circuit	Restablece el circuito del alambique
Les fragments de la tour	The tower fragments	Los fragmentos de la torre
Reconstituez une gravure de l’observatoire	Reassemble an engraving of the observatory	Reconstruye un grabado del observatorio
Le dernier sceau	The final seal	El último sello
Le secret laissé entre les lignes	The secret between the lines	El secreto entre líneas
Le secret d’Aurèle et une distinction	Aurèle’s secret and an award	El secreto de Aurèle y una distinción
Clef	Key	Llave
Sablier	Hourglass	Reloj de arena
Mini-jeu inconnu.	Unknown mini-game.	Minijuego desconocido.
Zone de mini-jeu absente.	Missing mini-game area.	Falta el área del minijuego.
Retournez les cartes dans un ordre régulier. Retenez le symbole et la position de chaque sceau : chacun possède exactement un double.	Turn the cards over in a regular order. Remember each seal’s symbol and position: each has exactly one match.	Da la vuelta a las cartas en un orden regular. Recuerda el símbolo y la posición de cada sello: cada uno tiene exactamente una pareja.
Un circuit possible remonte depuis l’arrivée à gauche, traverse toute la rangée supérieure, puis redescend vers la sortie à droite. Les deux extrémités de deux canaux voisins doivent se faire face.	One possible circuit goes up from the inlet on the left, crosses the entire top row, then goes down to the outlet on the right. The ends of neighboring channels must face one another.	Un circuito posible sube desde la entrada de la izquierda, cruza toda la fila superior y baja hacia la salida de la derecha. Los extremos de los canales vecinos deben estar enfrentados.
Les repères 1 à 9 indiquent la place de chaque fragment, de gauche à droite puis de haut en bas. Sélectionnez deux fragments pour échanger leurs positions.	Markers 1 to 9 show each fragment’s position, from left to right and top to bottom. Select two fragments to swap their positions.	Las marcas del 1 al 9 indican la posición de cada fragmento, de izquierda a derecha y de arriba abajo. Selecciona dos fragmentos para intercambiar sus posiciones.
La nuit évoque la Lune, la sauge la Feuille, le ciel l’Étoile et l’aube le Soleil. Respectez l’ordre du témoignage.	Night suggests the Moon, sage the Leaf, the sky the Star and dawn the Sun. Follow the order of the testimony.	La noche evoca la Luna, la salvia la Hoja, el cielo la Estrella y el alba el Sol. Respeta el orden del testimonio.
Retrouvez les six paires de sceaux. Retournez deux cartes à la fois ; une paire identique reste visible.	Find the six pairs of seals. Turn over two cards at a time; a matching pair stays visible.	Encuentra las seis parejas de sellos. Da la vuelta a dos cartas cada vez; las parejas idénticas permanecen visibles.
Faites pivoter les neuf canaux pour relier l’arrivée, à gauche, à la sortie, à droite. Seul un chemin continu est nécessaire : les autres canaux peuvent rester inutilisés.	Rotate the nine channels to connect the inlet on the left to the outlet on the right. Only one continuous path is needed: the other channels can remain unused.	Gira los nueve canales para conectar la entrada de la izquierda con la salida de la derecha. Solo se necesita un camino continuo: los demás canales pueden quedar sin usar.
Reconstituez la gravure de l’observatoire. Sélectionnez deux fragments pour les échanger. Vous pouvez consulter le modèle aussi souvent que nécessaire.	Reassemble the observatory engraving. Select two fragments to swap them. You can view the reference as often as needed.	Reconstruye el grabado del observatorio. Selecciona dos fragmentos para intercambiarlos. Puedes consultar el modelo tantas veces como necesites.
Aurèle a caché quatre signes dans son dernier témoignage. Choisissez les quatre sceaux dans le bon ordre, puis ouvrez le médaillon.	Aurèle hid four signs in his final testimony. Choose the four seals in the right order, then open the medallion.	Aurèle escondió cuatro signos en su último testimonio. Elige los cuatro sellos en el orden correcto y abre el medallón.
La rosée atteint enfin le réceptacle.	The dew finally reaches the receptacle.	El rocío llega por fin al recipiente.
Arrivée de rosée →	Dew inlet →	Entrada de rocío →
→ Réceptacle	→ Receptacle	→ Recipiente
haut	up	arriba
droite	right	derecha
bas	down	abajo
gauche	left	izquierda
Gravure complète de l’observatoire à reconstituer	Complete observatory engraving to reassemble	Grabado completo del observatorio que reconstruir
Masquer le modèle	Hide the reference	Ocultar el modelo
Voir le modèle	View the reference	Ver el modelo
Masquer les repères	Hide markers	Ocultar las marcas
Repères numérotés · aide	Numbered markers · help	Marcas numeradas · ayuda
« À la tombée de la nuit, je cueillis la sauge ; les étoiles me guidèrent jusqu’à l’aube. »	“At nightfall, I picked sage; the stars guided me until dawn.”	« Al caer la noche, recogí salvia; las estrellas me guiaron hasta el alba. »
— Le dernier témoignage d’Aurèle	— Aurèle’s final testimony	— El último testimonio de Aurèle
Sceaux sélectionnés	Selected seals	Sellos seleccionados
Retirer le dernier sceau	Remove the last seal	Retirar el último sello
Ouvrir le médaillon	Open the medallion	Abrir el medallón
Cette tentative sera notée « avec aide ».	This attempt will be marked “assisted”.	Este intento se marcará como « con ayuda ».
Mystère élucidé. Votre découverte a été enregistrée.	Mystery solved. Your discovery has been saved.	Misterio resuelto. Tu descubrimiento se ha guardado.
Retour aux mystères	Back to mysteries	Volver a los misterios
Un conseil	A tip	Un consejo
Recommencer	Restart	Reiniciar
Deux sceaux différents… Retenez leur position.	Two different seals… Remember their positions.	Dos sellos diferentes… Recuerda sus posiciones.
Les quatre sceaux répondent. Le secret est à vous.	The four seals respond. The secret is yours.	Los cuatro sellos responden. El secreto es tuyo.
Le médaillon reste fermé. Retirez un sceau ou recommencez en suivant le témoignage.	The medallion stays closed. Remove a seal or start again, following the testimony.	El medallón sigue cerrado. Retira un sello o empieza de nuevo siguiendo el testimonio.`;
  rows.split('\n').filter(Boolean).forEach(line => add(...line.split('\t')));
  add('L’observatoire', 'The observatory', 'El observatorio');
  add('Découvrir l’épilogue →', 'Discover the epilogue →', 'Descubrir el epílogo →');
  add('Explorer le lieu suivant →', 'Explore the next location →', 'Explorar el siguiente lugar →');
  const narrative = `Le cabinet de l’astronome	The astronomer’s study	El gabinete del astrónomo
17 octobre 1566 · 21 h 00	17 October 1566 · 9:00 pm	17 de octubre de 1566 · 21:00
Une lettre sans signature	An unsigned letter	Una carta sin firma
Maître Aurèle a disparu. Sur son bureau, une lettre vous attend : « Camille, les heures que l’on nous vole ne sont pas perdues. Rassemble mes huit témoins ; ils ouvriront le coffret. »	Master Aurèle has vanished. A letter awaits on his desk: “Camille, the hours stolen from us are not lost. Gather my eight witnesses; they will open the casket.”	El maestro Aurèle ha desaparecido. Una carta te espera en su escritorio: « Camille, las horas que nos roban no están perdidas. Reúne a mis ocho testigos; abrirán el cofre. »
Repérez les huit témoins du travail d’Aurèle pour ouvrir son coffret.	Find the eight witnesses to Aurèle’s work to open his casket.	Encuentra los ocho testigos del trabajo de Aurèle para abrir su cofre.
« La nuit ouvre la marche, le jour lui succède ; puis l’étoile montre le chemin. »	“Night leads the way, day follows; then the star shows the path.”	« La noche abre la marcha, el día la sigue; después, la estrella muestra el camino. »
La clef du jardin	The garden key	La llave del jardín
Le coffret renferme une clef et le plan d’un jardin clos. Au dos : « Ce que la lumière cache, la rosée le révèle. » Aurèle avait préparé votre venue.	The casket holds a key and a plan of a walled garden. On the back: “What light conceals, dew reveals.” Aurèle had prepared for your arrival.	El cofre contiene una llave y el plano de un jardín amurallado. Al dorso: « Lo que la luz esconde, el rocío lo revela. » Aurèle había preparado tu llegada.
Petite clef de laiton	Small brass key	Pequeña llave de latón
Plume dans l’encrier	Quill in the inkwell	Pluma en el tintero
Horloge miniature	Miniature clock	Reloj en miniatura
Buste de marbre	Marble bust	Busto de mármol
Sablier de verre	Glass hourglass	Reloj de arena de cristal
Parchemin déroulé	Unrolled parchment	Pergamino desenrollado
Chouette perchée	Perched owl	Búho posado
Coupe d’argent	Silver cup	Copa de plata
Le jardin des simples	The herb garden	El jardín de hierbas
La serre oubliée	The forgotten greenhouse	El invernadero olvidado
17 octobre 1566 · 23 h 15	17 October 1566 · 11:15 pm	17 de octubre de 1566 · 23:15
L’encre invisible	The invisible ink	La tinta invisible
La clef ouvre une serre que personne n’entretient plus. Pourtant, un feu veille encore sous l’alambic. Une page semble vierge. Il vous faut retrouver la formule qui en révélera l’encre.	The key opens a greenhouse no one tends anymore. Yet a fire still burns beneath the still. A page appears blank. You must discover the formula that will reveal its ink.	La llave abre un invernadero que ya nadie cuida. Sin embargo, todavía arde un fuego bajo el alambique. Una página parece estar en blanco. Debes encontrar la fórmula que revelará su tinta.
Rassemblez les huit curiosités du jardin, puis préparez le révélateur.	Gather the garden’s eight curiosities, then prepare the developer.	Reúne las ocho curiosidades del jardín y prepara el revelador.
« D’abord la feuille qui respire, puis la fleur qui rougit, enfin le gardien des sous-bois. »	“First the breathing leaf, then the blushing flower, and finally the guardian of the undergrowth.”	« Primero la hoja que respira, luego la flor que se sonroja y, por último, el guardián del sotobosque. »
La carte révélée	The revealed map	El mapa revelado
L’encre apparaît : une carte du ciel et trois mots, « Regardez avant l’aube ». Une trace d’encre fraîche prouve qu’Aurèle était ici cette nuit. La carte désigne l’observatoire.	The ink appears: a sky chart and three words, “Look before dawn.” A trace of fresh ink proves Aurèle was here tonight. The chart points to the observatory.	La tinta aparece: un mapa del cielo y tres palabras, « Mira antes del alba ». Un rastro de tinta fresca demuestra que Aurèle estuvo aquí esta noche. El mapa señala el observatorio.
Flacon bleu	Blue vial	Frasco azul
Mortier et pilon	Mortar and pestle	Mortero y mano
Bol de fleurs violettes	Bowl of purple flowers	Cuenco de flores violetas
Panier d’osier	Wicker basket	Cesta de mimbre
Arrosoir de laiton	Brass watering can	Regadera de latón
Pot bleu et blanc	Blue-and-white pot	Maceta azul y blanca
Bocal ambré	Amber jar	Tarro ámbar
Petit coffret doré	Small gilded casket	Pequeño cofre dorado
L’observatoire silencieux	The silent observatory	El observatorio silencioso
La tour des étoiles	The tower of stars	La torre de las estrellas
18 octobre 1566 · 04 h 40	18 October 1566 · 4:40 am	18 de octubre de 1566 · 04:40
La dernière heure	The final hour	La última hora
Au sommet de la tour, un mécanisme attend sous les étoiles. La ville dort encore. Aurèle a dissimulé son dernier message dans la sphère céleste ; seule la bonne constellation peut la déverrouiller.	At the top of the tower, a mechanism awaits beneath the stars. The city still sleeps. Aurèle hid his final message in the celestial sphere; only the right constellation can unlock it.	En lo alto de la torre, un mecanismo espera bajo las estrellas. La ciudad aún duerme. Aurèle escondió su último mensaje en la esfera celeste; solo la constelación correcta puede abrirla.
Repérez les huit instruments et curiosités de la tour, puis reconstituez le chemin céleste.	Find the tower’s eight instruments and curiosities, then retrace the celestial path.	Encuentra los ocho instrumentos y curiosidades de la torre y reconstruye el camino celeste.
« Du Gardien au Voyageur, de la Couronne à la Lyre, jusqu’à l’Aube. »	“From Guardian to Traveler, from Crown to Lyre, all the way to Dawn.”	« Del Guardián al Viajero, de la Corona a la Lira, hasta el Alba. »
Le testament d’Aurèle	Aurèle’s testament	El testamento de Aurèle
La sphère s’ouvre. Aurèle a choisi de disparaître pour protéger ses observations. Son testament vous confie la tour et ses recherches : prédire l’avenir compte moins que donner aux autres les moyens de le comprendre.	The sphere opens. Aurèle chose to vanish to protect his observations. His testament entrusts you with the tower and his research: predicting the future matters less than giving others the means to understand it.	La esfera se abre. Aurèle decidió desaparecer para proteger sus observaciones. Su testamento te confía la torre y sus investigaciones: predecir el futuro importa menos que dar a los demás los medios para comprenderlo.
Longue-vue rangée	Stored spyglass	Catalejo guardado
Livre étoilé	Starred book	Libro de estrellas
Sablier miniature	Miniature hourglass	Reloj de arena en miniatura
Lanterne de gauche	Left lantern	Farol izquierdo
Plume et encrier	Quill and inkwell	Pluma y tintero
Petit globe bleu	Small blue globe	Pequeño globo azul
Loupe de lecture	Reading magnifier	Lupa de lectura
Coupe de cuivre	Copper cup	Copa de cobre
Le cachet du cabinet portait deux empreintes. Aurèle avait un correspondant qui signait d’une lune brisée. Leur correspondance devait rester à l’abri des curieux.	The study’s seal bore two impressions. Aurèle had a correspondent who signed with a broken moon. Their correspondence had to be kept from prying eyes.	El sello del gabinete tenía dos huellas. Aurèle tenía un corresponsal que firmaba con una luna rota. Su correspondencia debía quedar a salvo de los curiosos.
Une note retrouvée sous l’alambic révèle que l’encre réagit à la lumière lunaire. Aurèle préparait une carte lisible seulement pendant quelques heures, avant l’aube.	A note found beneath the still reveals that the ink reacts to moonlight. Aurèle was preparing a chart that could only be read for a few hours before dawn.	Una nota encontrada bajo el alambique revela que la tinta reacciona a la luz de la luna. Aurèle preparaba un mapa que solo se podía leer durante unas horas antes del alba.
Au revers de la gravure restaurée, les constellations dessinent un itinéraire vers le port. Aurèle n’a pas été enlevé : quelqu’un lui avait préparé un départ secret.	On the back of the restored engraving, the constellations trace a route to the harbor. Aurèle was not abducted: someone had arranged a secret departure for him.	Al dorso del grabado restaurado, las constelaciones trazan una ruta hacia el puerto. Aurèle no fue secuestrado: alguien le había preparado una partida secreta.
« Camille, j’ai confié mes carnets à une amie du port. Aucun ciel ne commande à notre conscience. Si tu lis ceci, la tour est à toi. Garde les étoiles pour guide, jamais pour chaînes. — Aurèle »	“Camille, I entrusted my journals to a friend at the harbor. No sky can command our conscience. If you read this, the tower is yours. Let the stars be your guide, never your chains. — Aurèle”	« Camille, confié mis cuadernos a una amiga del puerto. Ningún cielo gobierna nuestra conciencia. Si lees esto, la torre es tuya. Que las estrellas te guíen, nunca que te encadenen. — Aurèle »`;
  narrative.split('\n').forEach(line => add(...line.split('\t')));
  const templates = [];
  const pattern = (source, en, es) => templates.push({ source, en, es });
  pattern('Votre aventure est sauvegardée · Chapitre {0}', 'Your adventure is saved · Chapter {0}', 'Tu aventura está guardada · Capítulo {0}');
  pattern('Chapitre {0}', 'Chapter {0}', 'Capítulo {0}');
  pattern('Chapitre {0} · {1}', 'Chapter {0} · {1}', 'Capítulo {0} · {1}');
  pattern('Chapitre {0} · {1}/8 objets', 'Chapter {0} · {1}/8 objects', 'Capítulo {0} · {1}/8 objetos');
  pattern('Scène d’objets cachés : {0}', 'Hidden-object scene: {0}', 'Escena de objetos ocultos: {0}');
  pattern('{0} — retrouvé', '{0} — found', '{0} — encontrado');
  pattern('Un nouveau défi est disponible : {0}', 'A new challenge is available: {0}', 'Hay un nuevo desafío disponible: {0}');
  pattern('Disponible dans {0} s', 'Available in {0} s', 'Disponible en {0} s');
  pattern('Une lueur révèle {0}.', 'A glimmer reveals {0}.', 'Un destello revela {0}.');
  pattern('Cadran {0} : {1}', 'Dial {0}: {1}', 'Esfera {0}: {1}');
  pattern('{0} / 5 étoiles reliées · Suivez le chemin du manuscrit', '{0} / 5 stars connected · Follow the manuscript’s path', '{0} / 5 estrellas conectadas · Sigue el camino del manuscrito');
  pattern('Énigme du chapitre {0}', 'Chapter {0} puzzle', 'Enigma del capítulo {0}');
  pattern('Chapitre {0} · Élucidé', 'Chapter {0} · Solved', 'Capítulo {0} · Resuelto');
  pattern('{0} minutes d’exploration · {1} énigme(s) assistée(s)', '{0} minutes exploring · {1} assisted puzzle(s)', '{0} minutos de exploración · {1} enigma(s) con ayuda');
  pattern('{0} objets encore', '{0} objects to go', '{0} objetos más');
  pattern('Médaille {0}', '{0} medal', 'Medalla de {0}');
  pattern('{0}/4 défis accomplis · {1} éclat(s) utilisé(s)', '{0}/4 challenges complete · {1} shard(s) used', '{0}/4 desafíos completados · {1} fragmento(s) usado(s)');
  pattern('Révéler {0} objet(s) · 1 éclat', 'Reveal {0} object(s) · 1 shard', 'Revelar {0} objeto(s) · 1 fragmento');
  pattern('Après 4 objets au chapitre {0}.', 'After 4 objects in chapter {0}.', 'Tras encontrar 4 objetos en el capítulo {0}.');
  pattern('{0} objet(s) éclairé(s). À vous de les retrouver.', '{0} object(s) illuminated. Now find them.', '{0} objeto(s) iluminado(s). Ahora encuéntralos.');
  pattern('{0} clics sans objet sur 3 avant la pause', '{0} clicks without an object out of 3 before the pause', '{0} clics sin encontrar un objeto de los 3 que activan la pausa');
  pattern('{0} / 6 paires retrouvées · {1} tentative{2}', '{0} / 6 pairs found · {1} attempt{2}', '{0} / 6 parejas encontradas · {1} intento{2}');
  pattern('{0} rotation{1} · Les canaux alimentés deviennent lumineux', '{0} rotation{1} · Connected channels light up', '{0} giro{1} · Los canales conectados se iluminan');
  pattern('Carte {0}', 'Card {0}', 'Carta {0}');
  pattern('{0}, paire retrouvée', '{0}, pair found', '{0}, pareja encontrada');
  pattern('{0} et {1}', '{0} and {1}', '{0} y {1}');
  pattern('Canal {0}, ouvert vers {1}. Tourner d’un quart de tour.', 'Channel {0}, open toward {1}. Rotate a quarter turn.', 'Canal {0}, abierto hacia {1}. Girar un cuarto de vuelta.');
  pattern('{0} / 9 fragments à leur place · {1} échange{2}', '{0} / 9 fragments in place · {1} swap{2}', '{0} / 9 fragmentos colocados · {1} intercambio{2}');
  pattern('Fragment {0}, position {1}, sélectionné', 'Fragment {0}, position {1}, selected', 'Fragmento {0}, posición {1}, seleccionado');
  pattern('Fragment {0}, position {1}', 'Fragment {0}, position {1}', 'Fragmento {0}, posición {1}');
  pattern('position {0}, sélectionné', 'position {0}, selected', 'posición {0}, seleccionada');
  pattern('position {0}', 'position {0}', 'posición {0}');
  pattern('{0} / 4 sceaux choisis · {1} essai{2}', '{0} / 4 seals selected · {1} attempt{2}', '{0} / 4 sellos elegidos · {1} intento{2}');
  pattern('{0} / 4 sceaux choisis', '{0} / 4 seals selected', '{0} / 4 sellos elegidos');
  pattern('Emplacement {0}, vide', 'Slot {0}, empty', 'Espacio {0}, vacío');
  pattern('La paire « {0} » est réunie.', 'The “{0}” pair is complete.', 'La pareja « {0} » está completa.');
  templates.sort((a, b) => b.source.replace(/\{\d+\}/g, '').length - a.source.replace(/\{\d+\}/g, '').length);
  window.SeabyssI18n.register({ source: 'fr', strings, templates });
})();
