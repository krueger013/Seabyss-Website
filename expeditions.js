const routes = [
  {
    title: 'Les anneaux et les lunes de Saturne',
    stops: [
      ['saturn', 'Fais pivoter la vue. Les anneaux semblent s’amincir quand tu les regardes par la tranche.'],
      ['titan', 'La brume orangée de Titan masque sa surface. Sous cette atmosphère dense, il existe des lacs de méthane et d’éthane.'],
      ['enceladus', 'Compare cette petite lune blanche à Titan. Sa surface glacée réfléchit une grande partie de la lumière solaire.']
    ]
  },
  {
    title: 'Les lunes de Jupiter',
    stops: [
      ['jupiter', 'Repère les bandes parallèles à l’équateur. Elles suivent les courants de l’atmosphère de Jupiter.'],
      ['io', 'Le jaune et le roux d’Io trahissent des dépôts de soufre laissés par son volcanisme.'],
      ['europa', 'Suis les lignes sombres qui traversent la glace. Elles dessinent des fractures dans la croûte d’Europe.'],
      ['ganymede', 'Sur Ganymède, des terrains clairs et sillonnés côtoient des régions plus sombres et plus anciennes.']
    ]
  },
  {
    title: 'De la Terre à Andromède',
    stops: [
      ['earth', 'Suis le bord éclairé de la Terre. À cette échelle, l’atmosphère forme un mince liseré.'],
      ['proxima', 'Depuis cette naine rouge, la lumière met environ 4,25 ans à rejoindre le Système solaire.'],
      ['milky-way', 'Repère les bras autour du bulbe lumineux. Le Soleil se trouve dans le disque, loin du centre.'],
      ['andromeda', 'Cette autre spirale se trouve à environ 2,5 millions d’années-lumière de nous. Sa lumière a voyagé pendant autant d’années.']
    ]
  },
  {
    title: 'Des étoiles à leurs vestiges',
    stops: [
      ['orion-nebula', 'Dans Orion, repère le cœur blanc qui éclaire le gaz autour de jeunes étoiles.'],
      ['pleiades', 'Les Pléiades montrent un autre aspect de la jeunesse stellaire. Plusieurs étoiles bleues se distinguent déjà du nuage qui diffuse leur lumière.'],
      ['ring-nebula', 'Dans la Lyre, observe l’enveloppe lumineuse et le centre plus sombre. Une étoile en fin de vie a rejeté ces couches de gaz.'],
      ['crab-nebula', 'Les filaments du Crabe marquent une autre fin possible pour une étoile massive. Ils proviennent des débris d’une supernova.']
    ]
  },
  {
    title: 'Les sept mondes de TRAPPIST-1',
    stops: [
      ['trappist-1', 'Observe la couleur de la petite étoile. Ses sept planètes connues gravitent très près d’elle.'],
      ['trappist-1-b', 'Commence par b, la planète la plus proche de l’étoile. Un tour du système ne lui prend qu’un peu plus d’un jour terrestre.'],
      ['trappist-1-c', 'Passe à c et compare son orbite à celle de b dans la vue Système.'],
      ['trappist-1-d', 'Repère d entre les deux orbites intérieures et les quatre planètes qui les entourent.'],
      ['trappist-1-e', 'Regarde la période de e. Elle accomplit un tour en environ six jours terrestres.'],
      ['trappist-1-f', 'À la même vitesse d’horloge, compare le déplacement de f à celui de sa voisine e.'],
      ['trappist-1-g', 'Garde g comme cible et retrouve les cinq orbites plus proches de la naine rouge.'],
      ['trappist-1-h', 'La planète h ferme la marche. Depuis sa position, compare toute l’étendue de ce système compact à l’orbite de Mercure dans le Système solaire.']
    ]
  },
  {
    title: 'Quatre silhouettes de galaxies',
    stops: [
      ['triangulum', 'Pars du noyau et remonte l’un des bras du Triangle. Des régions brillantes se détachent dans son disque.'],
      ['sombrero', 'Cherche la bande sombre qui partage le bulbe lumineux du Sombrero. Nous voyons son disque presque par la tranche.'],
      ['m87', 'Le halo de Messier 87 s’éclaircit vers le cœur. Compare cette répartition à la structure en bras du Triangle.'],
      ['centaurus-a', 'Centaurus A réunit deux formes bien distinctes. Suis la bande de poussière qui coupe son enveloppe lumineuse.']
    ]
  },
  {
    title: 'Au cœur des amas d’étoiles',
    stops: [
      ['beehive', 'Dans la Crèche, suis à l’œil l’espace entre les étoiles brillantes de cet amas ouvert.'],
      ['wild-duck', 'L’amas du Canard sauvage reste un amas ouvert, mais ses étoiles paraissent beaucoup plus serrées.'],
      ['hercules-cluster', 'Aux bords de Messier 13, tu peux distinguer des étoiles isolées. Tourne ensuite le regard vers son centre globulaire.'],
      ['omega-centauri', 'Observe l’étendue lumineuse d’Oméga du Centaure et compare sa concentration centrale à celle du premier amas visité.']
    ]
  },
  {
    title: 'Des super-Terres aux Jupiters chauds',
    stops: [
      ['55-cancri-e', 'Janssen boucle son orbite en moins d’une journée terrestre. Regarde la distance qui la sépare de son étoile.'],
      ['hd-189733-b', 'Change d’échelle. HD 189733 b est une géante gazeuse très proche de son étoile. Compare son rayon à celui de Janssen.'],
      ['kepler-62-f', 'Regarde maintenant la période de Kepler-62 f. Son orbite est bien plus longue que celles des deux planètes précédentes.'],
      ['kepler-186-f', 'Termine sur Kepler-186 f. Sa taille est proche de celle de la Terre. Sa surface et son atmosphère restent inconnues.']
    ]
  },
  {
    title:'Du Soleil à la ceinture de Kuiper',
    stops:[
      ['ceres','Entre Mars et Jupiter, repère Cérès dans la ceinture principale. Sa taille vaut une fraction de celle de notre Lune.'],
      ['vesta','Compare le rayon de Vesta à celui de Cérès, puis poursuis le voyage vers Neptune.'],
      ['triton','Chez Neptune, Triton décrit une orbite rétrograde. Ouvre sa fiche pour examiner sa période.'],
      ['pluto','Au-delà de Neptune, approche Pluton. Sa plus grande lune est la prochaine étape.'],
      ['charon','Depuis Charon, compare le rayon et la période orbitale aux mesures relevées sur Pluton.']
    ]
  },
  {
    title:'Sur les traces de trois supernovæ',
    stops:[
      ['tycho-remnant','La lumière de cette explosion est arrivée sur Terre en 1572. Ouvre Photos pour examiner les débris révélés par Chandra.'],
      ['kepler-remnant','Cette autre explosion est devenue visible en 1604. Change de point de vue autour de son enveloppe.'],
      ['sn1006','Ouvre la photographie en rayons X et retrouve les deux bords brillants de la coquille.']
    ]
  }
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text, handle, primary = false) {
  const node = element('button', primary ? 'exp-button exp-primary' : 'exp-button', text);
  node.type = 'button';
  node.addEventListener('click', handle);
  return node;
}

export function createExpeditions({ objects, travel, onChange }) {
  const byId = new Map(objects.map(object => [object.id, object]));
  const available = routes.filter(route => route.stops.every(([id]) => byId.has(id)));
  let active = null;
  let index = 0;

  function stop() {
    if (!active) return;
    active = null;
    index = 0;
    onChange();
  }

  function visit(route, step) {
    // The navigation callback can synchronously report its new target via sync().
    active = route;
    index = step;
    travel(route.stops[step][0]);
    onChange();
  }

  function renderPanel(container) {
    const list = element('div', 'exp-list');
    for (const route of available) {
      const current = active === route;
      const card = element('article', 'exp-route');
      const heading = element('h3', 'exp-title', route.title);
      card.append(heading);
      const stops = element('ol', 'exp-stops');
      stops.setAttribute('aria-label', 'Étapes');
      route.stops.forEach(([id], step) => {
        const item = element('li', '', byId.get(id).name);
        if (current && index === step) item.setAttribute('aria-current', 'step');
        stops.append(item);
      });
      card.append(stops);
      const start = button(current ? 'Revoir cette étape' : 'Partir', () => visit(route, current ? index : 0), true);
      start.setAttribute('aria-label', start.textContent + ' · ' + route.title);
      card.append(start);
      list.append(card);
    }
    container.replaceChildren(list);
  }

  function renderHud(container) {
    const focusedAction = container.contains(document.activeElement) ? document.activeElement.dataset.expAction : '';
    container.hidden = !active;
    if (!active) { container.replaceChildren(); return; }
    const route = active;
    const step = index;
    const [id, observation] = route.stops[step];
    const last = step === route.stops.length - 1;
    const card = element('section', 'exp-hud-card');
    card.setAttribute('aria-label', 'Itinéraire en cours');
    const text = element('div', 'exp-hud-copy');
    text.setAttribute('aria-live', 'polite');
    text.setAttribute('aria-atomic', 'true');
    text.append(element('p', 'exp-hud-route', route.title));
    const heading = element('h3', 'exp-hud-stop', byId.get(id).name);
    const count = element('span', 'exp-count', (step + 1) + ' / ' + route.stops.length);
    count.setAttribute('aria-label', 'Étape ' + (step + 1) + ' sur ' + route.stops.length);
    heading.append(count);
    text.append(heading, element('p', 'exp-observation', observation));
    const actions = element('div', 'exp-actions');
    const next = button(last ? 'Terminer' : 'Continuer', () => {
      if (active !== route || index !== step) return;
      if (last) stop();
      else visit(route, step + 1);
    }, true);
    next.dataset.expAction = 'next';
    if (!last) next.setAttribute('aria-label', 'Continuer vers ' + byId.get(route.stops[step + 1][0]).name);
    actions.append(next);
    if (!last) {
      const leave = button('Quitter', stop);
      leave.dataset.expAction = 'leave';
      actions.append(leave);
    }
    card.append(text, actions);
    container.replaceChildren(card);
    if (focusedAction) (actions.querySelector('[data-exp-action="' + focusedAction + '"]') || next).focus({ preventScroll: true });
  }

  function sync(currentObjectId) {
    if (active && currentObjectId !== active.stops[index][0]) stop();
  }

  return { renderPanel, renderHud, sync };
}
