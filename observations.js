import { assetUrl } from './assets.js';

const crabSource = 'https://chandra.harvard.edu/graphics/press/kits/crabmovie/CrabNebulaMovie.pdf';
const plates = [
  ['orion-nebula','orion-vis','Hubble','Lumière visible','La cavité d’Orion','Les quatre étoiles du Trapèze éclairent le cœur de la nébuleuse. Suis le bord sombre où le nuage de poussière découpe la région rose.','NASA, ESA, M. Robberto (STScI/ESA) et Hubble Space Telescope Orion Treasury Project Team','https://esahubble.org/images/heic0601a/'],
  ['orion-nebula','orion','Hubble','Proche infrarouge','Dans le Trapèze','Ce champ plus serré pénètre la poussière autour du Trapèze. De faibles points lumineux apparaissent entre les étoiles massives.','NASA/ESA, K. L. Luhman (Harvard-Smithsonian CfA), G. Schneider, E. Young, G. Rieke, A. Cotera, H. Chen, M. Rieke et R. Thompson (Steward Observatory, University of Arizona)','https://science.nasa.gov/missions/hubble/hubble-spies-brown-dwarfs-in-nearby-stellar-nursery/'],
  ['crab-nebula','crab-hubble','Hubble','Lumière visible','Autour du pulsar','Repère les filaments orangés et les étoiles ponctuelles. Passe aux rayons X pour retrouver les arcs proches du pulsar dans ce même champ.','NASA/HST/ASU/J. Hester et coll.',crabSource],
  ['crab-nebula','crab-chandra','Chandra','Rayons X','Le vent du pulsar','Les anneaux bleus et le jet dessinent la région où se déplacent des particules de haute énergie. Le bleu code ici les rayons X.','NASA/CXC/ASU/J. Hester et coll.',crabSource],
  ['lagoon-nebula','lagoon-vis','Hubble','Lumière visible','Les parois de la Lagune','Autour de la jeune étoile Herschel 36, des crêtes de poussière séparent les régions lumineuses du gaz plus dense. Agrandis les bords éclairés pour suivre les petits piliers.','NASA, ESA et STScI','https://science.nasa.gov/asset/hubble/lagoon-nebula-visible-light-view/'],
  ['dumbbell-nebula','dumbbell','Hubble','Lumière visible','Les nœuds de l’Haltère','Ce gros plan isole une partie de l’enveloppe éjectée par une étoile vieillissante. Plusieurs nœuds de gaz et de poussière se terminent par de longues queues.','NASA/ESA et Hubble Heritage Team (STScI/AURA)','https://science.nasa.gov/image-detail/close-up-of-m27-the-dumbbell-nebula/'],
  ['pleiades','pleiades','Hubble','Visible et infrarouge','Les filaments de Mérope','Cette image isole un petit nuage des Pléiades. La lumière de Mérope arrive du coin supérieur droit et fait ressortir les fins filaments de poussière.','NASA et Hubble Heritage Team (STScI/AURA). Remerciements à George Herbig et Theodore Simon (Institute for Astronomy, University of Hawaii).','https://science.nasa.gov/image-detail/interstellar_cloud_in_pleiades/'],
  ['whirlpool','whirlpool','Hubble','Lumière visible','Le bras du Tourbillon','Suis le bras spiral jusqu’à sa petite galaxie compagne, NGC 5195. Les nœuds roses ponctuent les régions de formation d’étoiles.','NASA, ESA, S. Beckwith (STScI) et Hubble Heritage Team (STScI/AURA)','https://esahubble.org/images/heic0506a/'],
  ['sombrero','sombrero','Hubble','Lumière visible','La tranche du Sombrero','Une bande sombre partage le bulbe lumineux. En grossissant son bord, tu distingues les irrégularités de la poussière du disque presque vu par la tranche.','NASA et Hubble Heritage Team (STScI/AURA)','https://science.nasa.gov/image-detail/sombrero-galaxy-hubble/'],
  ['andromeda','andromeda','GALEX','Ultraviolet','Les anneaux d’Andromède','Dans cette mosaïque de dix observations, les régions riches en jeunes étoiles dessinent des arcs ultraviolets autour du centre.','NASA/JPL/California Institute of Technology','https://science.nasa.gov/photojournal/andromeda-galaxy/']
].map(([id,file,instrument,band,title,note,credit,source]) => ({id,file,instrument,band,title,note,credit,source}));

export const hasObservation = id => plates.some(p => p.id === id);
export const observationCredits = () => plates.map(p => p.title + ' — ' + p.instrument + ', ' + p.band + '\n' + p.credit + '\n' + p.source).join('\n\n');

export function openObservations(container, {objects, initialId, onClose}) {
  const objectNames = new Map(objects.map(body => [body.id, body.name]));
  container.innerHTML = '<div class="photo-picker"><label>Astre<select data-photo-target></select></label><label>Observation<select id="photo-band" data-photo-band></select></label></div>' +
    '<div id="photo-viewport" tabindex="0" aria-label="Photographie astronomique. Flèches pour déplacer la vue agrandie, plus et moins pour zoomer."><img data-observation-image alt="" draggable="false"><span class="photo-instrument"></span></div>' +
    '<div class="photo-tools"><button data-photo-zoom="out" aria-label="Réduire la photographie">−</button><output data-photo-magnification aria-label="Grossissement">1×</output><button data-photo-zoom="in" aria-label="Agrandir la photographie">+</button><button data-photo-fit>Cadrer</button><button data-photo-close>Retour</button></div>' +
    '<div class="photo-copy"><h3></h3><p></p><details><summary>Crédit et source</summary><span></span> · <a target="_blank" rel="noopener noreferrer">Fiche de mission ↗</a></details></div>';
  const find = q => container.querySelector(q);
  const target = find('[data-photo-target]'), bands = find('[data-photo-band]');
  const stage = find('#photo-viewport'), img = find('[data-observation-image]');
  const zoomIn = find('[data-photo-zoom=in]'), zoomOut = find('[data-photo-zoom=out]');
  const magnification = find('[data-photo-magnification]');
  for (const id of new Set(plates.map(p => p.id))) target.add(new Option(objectNames.get(id),id));
  let zoom = 1, x = 0, y = 0, previousId;
  const pointers = new Map();
  function paint() {
    if (!stage.clientWidth || !img.naturalWidth) return;
    const fit = Math.min(stage.clientWidth/img.naturalWidth, stage.clientHeight/img.naturalHeight);
    const w = img.naturalWidth*fit, h = img.naturalHeight*fit;
    const maxX = Math.max(0,(w*zoom-stage.clientWidth)/2), maxY = Math.max(0,(h*zoom-stage.clientHeight)/2);
    x = Math.max(-maxX,Math.min(maxX,x)); y = Math.max(-maxY,Math.min(maxY,y));
    img.style.width = w+'px'; img.style.height = h+'px';
    img.style.transform = 'translate(-50%,-50%) translate('+x+'px,'+y+'px) scale('+zoom+')';
    stage.dataset.zoom = String(zoom); magnification.textContent = zoom.toLocaleString('fr-CA',{maximumFractionDigits:1})+'×';
    zoomOut.disabled = zoom <= 1; zoomIn.disabled = zoom >= 6;
  }
  function reset() { x=0; y=0; zoom=1; paint(); }
  function scaleAt(unbounded,px=0,py=0) {
    const value = Math.max(1, Math.min(6,unbounded)), ratio = value/zoom;
    x = px+(x-px)*ratio; y = py+(y-py)*ratio; zoom=value; paint();
  }
  function stagePoint(clientX,clientY) {
    const box = stage.getBoundingClientRect();
    return [clientX-box.x-box.width/2, clientY-box.y-box.height/2];
  }
  function selectPlate() {
    const plate = plates.find(p => p.file === bands.value);
    if (plate.id !== 'crab-nebula' || previousId !== plate.id) reset();
    previousId = plate.id; pointers.clear();
    img.onload = paint; img.alt = plate.title+' — '+plate.instrument+', '+plate.band; img.src = assetUrl('plate-'+plate.file+'.webp');
    find('.photo-instrument').textContent = plate.instrument+' · '+plate.band;
    find('.photo-copy h3').textContent = plate.title; find('.photo-copy p').textContent = plate.note;
    find('.photo-copy details span').textContent = plate.credit; find('.photo-copy a').href = plate.source;
  }
  function loadTarget() {
    const views = plates.filter(p => p.id === target.value);
    bands.replaceChildren(...views.map(p => new Option(p.instrument+' · '+p.band,p.file)));
    bands.disabled = views.length === 1; selectPlate();
  }
  target.onchange = loadTarget; bands.onchange = selectPlate;
  target.value = hasObservation(initialId) ? initialId : plates[0].id;
  find('[data-photo-fit]').onclick = reset; find('[data-photo-close]').onclick = onClose;
  zoomIn.onclick = () => scaleAt(zoom*1.5); zoomOut.onclick = () => scaleAt(zoom/1.5);
  stage.onwheel = e => {
    if (e.ctrlKey) return;
    e.preventDefault(); scaleAt(zoom*Math.exp(-Math.max(-150,Math.min(150,e.deltaY))*.0035),...stagePoint(e.clientX,e.clientY));
  };
  stage.onpointerdown = e => {
    if (e.button!==0) return; stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,stagePoint(e.clientX,e.clientY));
  };
  stage.onpointermove = e => {
    const from = pointers.get(e.pointerId);
    if (!from) return;
    const to = stagePoint(e.clientX,e.clientY);
    if (pointers.size === 2) {
      const other = [...pointers].find(([id]) => id!==e.pointerId)[1];
      const oldDistance = Math.hypot(from[0]-other[0],from[1]-other[1]);
      const newDistance = Math.hypot(to[0]-other[0],to[1]-other[1]);
      if (oldDistance>2 && newDistance>2) {
        scaleAt(zoom*newDistance/oldDistance,(other[0]+from[0])/2,(other[1]+from[1])/2);
        x+=(to[0]-from[0])/2; y+=(to[1]-from[1])/2;
      }
    } else {x+=to[0]-from[0];y+=to[1]-from[1];}
    pointers.set(e.pointerId,to); paint();
  };
  stage.onlostpointercapture = e => {pointers.delete(e.pointerId);};
  stage.onkeydown = e => {
    if (e.key==='+' || e.key==='=') scaleAt(zoom*1.5);
    else if (e.key==='-') scaleAt(zoom/1.5);
    else if (e.key==='Home') reset();
    else if (e.key.startsWith('Arrow')) {x+=(Number(e.key==='ArrowLeft')-Number(e.key==='ArrowRight'))*48;y+=(Number(e.key==='ArrowUp')-Number(e.key==='ArrowDown'))*48;paint();}
    else return;
    e.preventDefault();
  };
  const resize = new ResizeObserver(paint); resize.observe(stage); loadTarget();
  return () => {resize.disconnect(); img.onload = null; pointers.clear();};
}
