import { createPhenomenaRenderer, eclipseObservation, remnantExpansion } from './phenomena-scenes.js';

export const PHENOMENA = [
  {
    id:'black-hole', tab:'Trou noir', name:'Au bord du trou noir', title:'Inclinaison du disque',
    value:76, min:0, max:89, step:1, presets:[[0,'Face au disque'],[87,'Vue de profil']],
    description:'La gravité courbe le trajet de la lumière. Près du profil, le gaz situé derrière le trou noir réapparaît sous forme d’arcs au-dessus et au-dessous de son ombre.',
    note:'Déflexion illustrée et luminosité estimée',
    reference:'https://svs.gsfc.nasa.gov/14619',
    measurement:value=>[Math.round(value)+'°','Ombre et disque d’accrétion']
  },
  {
    id:'eclipse', tab:'Éclipse', name:'Dans l’ombre de la Lune', title:'Alignement Soleil–Lune',
    value:0, min:-2.4, max:2.4, step:.001, presets:[[-.73,'Croissant solaire'],[0,'Totalité']],
    description:'Quand la Lune masque entièrement la surface brillante du Soleil, la couronne solaire devient visible autour de sa silhouette.',
    note:'Masquage calculé à partir de deux disques apparents',
    reference:'https://science.nasa.gov/eclipses/future-eclipses/eclipse-2024/what-to-expect/',
    measurement:value=> {
      const {coverage,phase}=eclipseObservation(value);
      return [(coverage*100).toLocaleString('fr-CA',{maximumFractionDigits:1})+' % masqué',phase];
    }
  },
  {
    id:'rings', tab:'Anneaux', name:'Au-dessus des anneaux de Saturne', title:'Angle au-dessus du plan des anneaux',
    value:27, min:0, max:75, step:1, presets:[[0,'De profil'],[65,'Vue plongeante']],
    description:'Les anneaux sont très minces par rapport à leur largeur. Près de 0°, ils deviennent un trait. En prenant de la hauteur, la division de Cassini se dessine entre les deux grands anneaux.',
    note:'Anneaux projetés, textures et lunes illustrées',
    reference:'https://science.nasa.gov/mission/cassini/science/rings/',
    measurement:value=>[Math.round(value)+'°',value<3?'Traversée du plan des anneaux':'Anneaux de Saturne']
  },
  {
    id:'supernova', tab:'Supernova', name:'Le front de choc d’une supernova', title:'Temps depuis l’explosion',
    value:650, min:0, max:3000, step:1, presets:[[50,'À 50 ans'],[2500,'À 2 500 ans']],
    description:'Au début, les débris avancent presque librement. Le front de choc ralentit à mesure qu’il balaie le gaz environnant. Compare son rayon au même âge avec plusieurs vitesses de départ.',
    note:'Modèle idéal sur 3 000 ans. Masse éjectée de 1,4 masse solaire, gaz uniforme à un noyau d’hydrogène par cm³. Les filaments sont illustrés.',
    reference:'https://heasarc.gsfc.nasa.gov/docs/objects/snrs/snrstext.html',
    measurement:(years,speed)=>[Math.round(years).toLocaleString('fr-CA')+' ans',remnantExpansion(years,speed).decelerating?'Expansion ralentie':'Expansion libre']
  }
];

const movement = { 'black-hole':0, eclipse:.26, rings:5, supernova:200 };

export function createPhenomena(container, {initialId='black-hole',onRelativity,onVisit}={}) {
  const view=document.createElement('section');
  view.className='phenomena';
  view.innerHTML=`<div class="ph-tabs" role="group" aria-label="Phénomènes">${PHENOMENA.map(s=>'<button type="button" data-phenomenon-scene="'+s.id+'">'+s.tab+'</button>').join('')}</div>
    <div class="ph-window"><canvas data-phenomenon-canvas role="img"></canvas>
    <span class="ph-reading" data-ph-status></span></div>
    <div class="ph-console">
      <div class="ph-controls">
        <div class="ph-control-heading"><label data-ph-label for="ph-parameter"></label><output for="ph-parameter" data-ph-reading></output></div>
        <input id="ph-parameter" data-phenomenon-value type="range">
        <div class="ph-actions"><button type="button" data-phenomenon-play></button><button type="button" data-ph-preset="0"></button><button type="button" data-ph-preset="1"></button></div>
        <div class="ph-remnant" data-ph-remnant hidden>
          <label for="ph-speed">Vitesse initiale des débris</label>
          <select id="ph-speed" data-ph-speed><option value="5000">5 000 km/s</option><option value="10000" selected>10 000 km/s</option><option value="15000">15 000 km/s</option></select>
          <dl><div><dt>Rayon du choc</dt><dd data-ph-radius></dd></div><div><dt>Vitesse du choc</dt><dd data-ph-velocity></dd></div></dl>
        </div>
      </div>
      <div class="ph-detail"><h3 data-ph-title></h3>
        <button class="ph-relativity" type="button" data-ph-relativity hidden>Laboratoire des trous noirs</button>
        <p data-ph-description></p><span data-ph-note></span><a data-ph-reference target="_blank" rel="noopener noreferrer">Source NASA</a>
        <button class="ph-visit" type="button" data-ph-visit hidden>Observer Cassiopée A</button></div>
    </div>`;
  container.append(view);
  const $=selector=>view.querySelector(selector);
  const canvas=$('[data-phenomenon-canvas]'), range=$('[data-phenomenon-value]');
  const play=$('[data-phenomenon-play]'), status=$('[data-ph-status]'), reading=$('[data-ph-reading]');
  const lab=$('[data-ph-relativity]');
  const remnant=$('[data-ph-remnant]'),speed=$('[data-ph-speed]'),visit=$('[data-ph-visit]');
  const radius=$('[data-ph-radius]'),velocity=$('[data-ph-velocity]');
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const renderer=createPhenomenaRenderer(canvas);
  let scene,value,age=0,playing=false,target=1,timestamp=0,lastPaint=0,frame=0,disposed=false;
  let dirty=true;

  function updateReadings() {
    const initialKms=Number(speed.value);
    const [content,phase]=scene.measurement(value,initialKms);
    if (reading.textContent!==content) {
      reading.textContent=content;
      range.setAttribute('aria-valuetext',content);
    }
    if (status.textContent!==phase) status.textContent=phase;
    if (scene.id==='supernova') {
      const {radiusLy,speedKms}=remnantExpansion(value,initialKms);
      const radiusText=radiusLy.toLocaleString('fr-CA',{maximumFractionDigits:2})+' al';
      const speedText=Math.round(speedKms).toLocaleString('fr-CA')+' km/s';
      if (radius.textContent!==radiusText) radius.textContent=radiusText;
      if (velocity.textContent!==speedText) velocity.textContent=speedText;
    }
  }
  function setPlaying(next) {
    playing=next;
    play.setAttribute('aria-pressed',String(next));
    play.textContent=next?'Pause':scene.id==='black-hole'?'Animer':'Dérouler';
    timestamp=0;
    invalidate();
  }
  function invalidate() {
    dirty=true;
    if (!disposed && !frame) frame=requestAnimationFrame(draw);
  }
  function select(id) {
    scene=PHENOMENA.find(item=>item.id===id) || PHENOMENA[0];
    view.dataset.phenomenon=scene.id;
    value=scene.value;age=0;target=1;
    range.min=scene.min;range.max=scene.max;range.step=scene.step;range.value=value;
    canvas.setAttribute('aria-label',scene.name);
    $('[data-ph-label]').textContent=scene.title;
    $('[data-ph-title]').textContent=scene.name;
    $('[data-ph-description]').textContent=scene.description;
    $('[data-ph-note]').textContent=scene.note;
    $('[data-ph-reference]').href=scene.reference;
    lab.hidden=scene.id!=='black-hole' || typeof onRelativity!=='function';
    remnant.hidden=scene.id!=='supernova';
    visit.hidden=remnant.hidden || typeof onVisit!=='function';
    scene.presets.forEach((preset,index)=>{ $('[data-ph-preset="'+index+'"]').textContent=preset[1]; });
    for (const button of view.querySelectorAll('[data-phenomenon-scene]')) {
      button.setAttribute('aria-pressed',String(button.dataset.phenomenonScene===scene.id));
    }
    updateReadings();
    setPlaying(scene.id==='black-hole' && !motion.matches);
  }
  function draw(now) {
    frame=0;
    if (disposed) return;
    if (playing && canvas.getClientRects().length && !document.hidden) {
      const elapsed=timestamp ? Math.min(.05,(now-timestamp)/1000) : 0;
      timestamp=now;
      age+=elapsed;
      value+=elapsed*movement[scene.id]*target;
      if (value>=scene.max || value<=scene.min) {
        value=Math.min(scene.max,Math.max(scene.min,value));
        target=value===scene.max?-1:1;
        if ((scene.id==='eclipse' || scene.id==='supernova') && value===scene.max) setPlaying(false);
      }
      if (scene.id!=='black-hole') {
        range.value=value;
        updateReadings();
      }
    } else timestamp=0;
    if (dirty || playing && now-lastPaint>=1000/33) {
      renderer.draw(scene.id,value,age,Number(speed.value));
      lastPaint=now;
      dirty=false;
    }
    if (playing && !frame) frame=requestAnimationFrame(draw);
  }
  function setValue(next) {
    setPlaying(false);
    value=next;
    if (scene.id==='supernova') target=1;
    range.value=value;
    updateReadings();
    invalidate();
  }
  view.onclick=event=>{
    const button=event.target.closest('button');
    if (!button) return;
    if (button===lab && !lab.hidden) {onRelativity();return;}
    if (button===visit && !visit.hidden) {onVisit('cassiopeia-a');return;}
    if (button.dataset.phenomenonScene) select(button.dataset.phenomenonScene);
    if (button.hasAttribute('data-ph-preset')) setValue(scene.presets[Number(button.dataset.phPreset)][0]);
    if (button===play) {
      if (!playing && scene.id==='eclipse' && (value===scene.value || value>=scene.max)) {
        value=scene.min;range.value=value;target=1;updateReadings();
      }
      if (!playing && scene.id==='supernova' && value>=scene.max) setValue(scene.min);
      setPlaying(!playing);
    }
  };
  range.oninput=()=>setValue(range.valueAsNumber);
  speed.onchange=()=>setValue(value);
  const size = new ResizeObserver(invalidate);
  size.observe(canvas);
  const onMotion=e=>{if(e.matches) setPlaying(false);};
  motion.addEventListener('change',onMotion);
  select(initialId);
  return ()=>{
    disposed=true;
    cancelAnimationFrame(frame);
    size.disconnect();
    motion.removeEventListener('change',onMotion);
    view.remove();
  };
}
