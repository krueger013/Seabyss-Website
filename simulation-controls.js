import { AU } from './catalog.js';
import { GRAVITY_SCALES } from './simulation.js';

const rateNames = ['Temps réel', '1 min/s', '1 h/s', '1 j/s', '7 j/s', '30 j/s'];
const motions = {
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  play: '<path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  names: '<path d="M3 6h11m-5.5 0v13M5 19h5M14 11h8m-4 0v8"/>',
  lab: '<path d="M9 3h6m-5 0v6l-5.1 8.6A2 2 0 0 0 6.6 21h10.8a2 2 0 0 0 1.7-3.4L14 9V3M8 15h8"/>'
};
const icon = name => '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + motions[name] + '</svg>';
const decimal = new Intl.NumberFormat('fr-CA', {maximumFractionDigits:2});
const integer = new Intl.NumberFormat('fr-CA', {maximumFractionDigits:0});
const displayDistance = km => km > AU * .05 ? decimal.format(km / AU) + ' UA' : integer.format(km) + ' km';

export function createSimulationControls({sim, rates, systemView, dialogBody, showDialog, resetNavigation, openSandbox}) {
  const toolbar = document.createElement('div');
  toolbar.className = 'sim-toolbar';
  toolbar.setAttribute('role','group');
  toolbar.setAttribute('aria-label','Temps et noms des astres');
  toolbar.innerHTML = '<button id="sim-pause" type="button"></button>' +
    '<select id="sim-rate" aria-label="Vitesse du temps"></select>' +
    '<output id="sim-elapsed" aria-live="off" title="Temps simulé écoulé"></output>' +
    '<button id="sim-names" type="button" title="Noms des astres" aria-label="Noms des astres">' + icon('names') + '</button>';
  const pause = toolbar.querySelector('#sim-pause');
  const speed = toolbar.querySelector('#sim-rate');
  const elapsed = toolbar.querySelector('#sim-elapsed');
  const names = toolbar.querySelector('#sim-names');
  rates.forEach((rate,i) => speed.add(new Option(rateNames[i], String(i))));
  const lab = document.createElement('button');
  lab.type = 'button'; lab.id = 'sim-lab'; lab.className = 'sim-lab-button';
  lab.innerHTML = icon('lab') + '<span>Laboratoire</span>';
  lab.setAttribute('aria-label','Laboratoire de gravité');
  let manualRate = false;
  let showNames = true;
  let showOrbits = true;
  try {
    showNames = localStorage.getItem('seabyss-universe.names') !== 'off';
    showOrbits = localStorage.getItem('seabyss-universe.orbits') !== 'off';
  } catch {}
  const remember = (key, value) => {
    try { localStorage.setItem('seabyss-universe.' + key, value ? 'on' : 'off'); } catch {}
  };
  function update() {
    const pressed = String(sim.paused);
    if (pause.getAttribute('aria-pressed') !== pressed) {
      pause.innerHTML = icon(sim.paused ? 'play' : 'pause');
      pause.setAttribute('aria-pressed', pressed);
      pause.title = sim.paused ? 'Reprendre le temps' : 'Mettre le temps en pause';
      pause.setAttribute('aria-label', pause.title);
    }
    speed.value = String(rates.indexOf(sim.rate));
    const days = sim.days;
    const stamp = String(Number(days.toFixed(9)));
    if (elapsed.dataset.days !== stamp) {
      elapsed.dataset.days = stamp;
      elapsed.textContent = days >= 1 ? 'J + ' + decimal.format(days)
        : Math.floor(days * 24) + ' h ' + String(Math.floor(days * 1440) % 60).padStart(2, '0');
    }
    names.setAttribute('aria-pressed', String(showNames));
  }
  function applyRate(index) { sim.setRate(rates[index]); update(); }
  pause.onclick = () => { sim.setPaused(!sim.paused); update(); };
  speed.onchange = () => { manualRate = true; applyRate(Number(speed.value)); };
  names.onclick = () => {
    showNames = !showNames;
    remember('names',showNames);
    systemView.setLabels(showNames);
    update();
  };
  function restoreToolbar() {
    if (systemView.isOpen()) {
      document.querySelector('[data-system-clock]').append(toolbar);
      document.querySelector('[data-system-gravity]').append(lab);
    } else toolbar.remove();
  }
  function openClock() {
    showDialog('Horloge et affichage');
    dialogBody.closest('dialog').dataset.panel = 'simulation';
    const info = document.createElement('p');
    info.className = 'help-copy';
    info.textContent = 'La même horloge règle la rotation des astres et leur déplacement sur leurs orbites.';
    dialogBody.append(info,toolbar);
    update();
  }
  lab.onclick = () => {
    const center = sim.objects.find(body => body.id === systemView.getCenterId());
    if (!center) return;
    showDialog('Laboratoire de gravité');
    dialogBody.closest('dialog').dataset.panel = 'simulation';
    const panel = document.createElement('section');
    panel.className = 'gravity-panel';
    panel.innerHTML = '<div class="gravity-heading"><span class="gravity-key">Corps central</span><strong></strong></div>' +
      '<label class="gravity-mass" for="gravity-scale"><span>Masse relative</span><select id="gravity-scale"></select></label>' +
      '<p class="gravity-note">Modifie la masse en conservant la position et la vitesse des astres en orbite. Leur nouvelle trajectoire apparaît dans la vue du système.</p>' +
      '<section class="gravity-result"><h3></h3><dl><div><dt>Au plus près</dt><dd></dd></div><div><dt>Au plus loin</dt><dd></dd></div></dl></section>' +
      '<p class="gravity-feedback" role="status"></p><label class="gravity-orbits"><input id="sim-orbits" type="checkbox"> Afficher les trajectoires</label>' +
      '<div class="gravity-actions"><button class="chart-secondary" id="sim-reset" type="button">Rétablir le système initial</button><button class="primary-btn" id="gravity-return" type="button">Voir les orbites</button></div>';
    panel.querySelector('.gravity-heading strong').textContent = center.name;
    const mass = panel.querySelector('#gravity-scale');
    for (const n of GRAVITY_SCALES) mass.add(new Option('× ' + decimal.format(n),String(n)));
    const feedback = panel.querySelector('.gravity-feedback');
    const track = panel.querySelector('#sim-orbits');
    track.checked = showOrbits;
    track.onchange = () => { showOrbits = track.checked; remember('orbits',showOrbits); systemView.setOrbits(showOrbits); };
    function measureOrbit() {
      mass.value = String(sim.getGravityScale(center.id));
      const children = sim.objects.filter(body => body.parentId === center.id && body.orbitPeriodDays > 0);
      const selected = document.querySelector('[data-system-target]')?.value;
      const target = children.find(body => body.id === selected) || children[0];
      const result = panel.querySelector('.gravity-result');
      result.hidden = !target;
      if (!target) return;
      result.querySelector('h3').textContent = target.name + ' · ' + decimal.format(target.orbitPeriodDays) + ' jours par orbite';
      const [near, far] = result.querySelectorAll('dd');
      near.textContent = displayDistance(target.orbitRadiusKm * (1 - target.orbitEccentricity));
      far.textContent = displayDistance(target.orbitRadiusKm * (1 + target.orbitEccentricity));
    }
    mass.onchange = () => {
      const changed = sim.setGravityScale(center.id, Number(mass.value));
      feedback.textContent = changed ? 'Trajectoires recalculées.' : sim.gravityError;
      measureOrbit();
      systemView.render();
    };
    panel.querySelector('#sim-reset').onclick = () => {
      const paused = sim.paused, rate = sim.rate;
      sim.reset(); sim.setRate(rate); sim.setPaused(paused);
      resetNavigation(); update(); measureOrbit(); systemView.render();
      feedback.textContent = 'Masses et positions initiales rétablies. Le compteur repart de zéro.';
    };
    panel.querySelector('#gravity-return').onclick = () => dialogBody.closest('dialog').close();
    const create = document.createElement('button');
    create.type='button';create.className='archive-entry';create.dataset.openSandbox='';
    create.textContent='Créer un système dans l’atelier';create.onclick=openSandbox;
    panel.append(create);dialogBody.append(panel); measureOrbit();
  };
  function placeInSystem() {
    if (!manualRate) applyRate(3);
    restoreToolbar();
    systemView.setLabels(showNames); systemView.setOrbits(showOrbits); update();
  }
  function leaveSystem() {
    if (!manualRate) applyRate(2);
    toolbar.remove();
  }
  return {get showNames() { return showNames; }, update, openClock, placeInSystem, leaveSystem, restoreToolbar};
}
