export function createVoyageIndicator(heading) {
  const slot = document.createElement('div');
  slot.className = 'voyage-slot';
  slot.append(heading.querySelector('.indicator'),heading.querySelector('#mode-status'));
  heading.append(slot);
  const indicator = document.createElement('div');
  indicator.dataset.voyage = '';
  indicator.hidden = true;
  indicator.innerHTML = '<span data-voyage-phase></span><strong data-voyage-target></strong>' +
    '<span data-voyage-progress role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></span>';
  slot.append(indicator);
  const phase = indicator.querySelector('[data-voyage-phase]');
  const target = indicator.querySelector('[data-voyage-target]');
  const bar = indicator.querySelector('[data-voyage-progress]');
  let current, lastPercent = -1;

  function fill(percent) {
    if (percent === lastPercent) return;
    lastPercent = percent;
    bar.setAttribute('aria-valuenow',String(percent));
    bar.firstElementChild.style.transform = 'scaleX(' + percent / 100 + ')';
  }
  return function sync(route, name) {
    if (!route) {
      if (!current) return false;
      fill(current.progress === 1 ? 100 : 0);
      current = null;
      indicator.hidden = true;
      delete heading.dataset.guided;
      return true;
    }
    const changed = route !== current;
    if (changed) {
      current = route;
      target.textContent = name;
      bar.setAttribute('aria-label','Voyage vers ' + name);
      heading.dataset.guided = '';
      indicator.hidden = false;
    }
    const caption = route.progress < .25 ? 'Départ' : route.progress < .75 ? 'En transit' : 'Approche';
    if (phase.textContent !== caption) phase.textContent = caption;
    fill(Math.min(99,Math.floor(route.progress * 100)));
    return changed;
  };
}
