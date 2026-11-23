export function enableCinema(canvas, enterButton, exitButton, dialog, {nav, onStart}={}) {
  const controls = document.createElement('div');
  controls.className = 'cinema-camera';
  controls.hidden = true;
  controls.setAttribute('role','group');
  controls.setAttribute('aria-label','Caméra orbitale');
  controls.innerHTML = `<button type="button" data-cinema-play aria-pressed="false">
    <span class="cinema-play-mark" aria-hidden="true"></span><span data-cinema-label>Orbite caméra</span>
    </button><label><span class="cinema-sr">Vitesse de caméra</span>
    <select data-cinema-speed aria-label="Vitesse de caméra"><option value="3">3°/s</option>
    <option value="6" selected>6°/s</option><option value="12">12°/s</option></select></label>
    <button type="button" data-cinema-reverse aria-label="Inverser le sens de rotation" title="Inverser le sens de rotation" aria-pressed="false"><span aria-hidden="true">↻</span></button>`;
  exitButton.after(controls);
  const play = controls.querySelector('[data-cinema-play]');
  const label = controls.querySelector('[data-cinema-label]');
  const speed = controls.querySelector('select');
  const reverse = controls.querySelector('[data-cinema-reverse]');
  let running = false, direction = 1, degreesPerSecond = Number(speed.value);
  let pose, angle = 0, velocity = 0;

  function setRunning(active) {
    running = active;
    play.setAttribute('aria-pressed', String(active));
    label.textContent = active ? 'Pause caméra' : 'Orbite caméra';
    pose = null;
    angle = velocity = 0;
    if (active) onStart?.();
  }
  play.onclick = () => setRunning(!running);
  speed.onchange = () => { degreesPerSecond = Number(speed.value); };
  reverse.onclick = () => {
    direction *= -1;
    reverse.setAttribute('aria-pressed', String(direction < 0));
    reverse.firstElementChild.textContent = direction < 0 ? '↺' : '↻';
  };
  function pause() { if (running) setRunning(false); }
  canvas.addEventListener('pointerdown',pause);
  canvas.addEventListener('wheel',pause,{passive:true});
  canvas.addEventListener('keydown',event => {
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(event.key)) pause();
  });
  document.addEventListener('visibilitychange',() => { if (document.hidden) pause(); });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event => { if (event.matches) pause(); });

  function tick(dt) {
    if (!running || controls.hidden || dialog.open || document.hidden || nav.travelling || !(dt>0)) return;
    if (pose && pose.id !== nav.selectedId) { pause(); return; }
    pose ??= nav.orbitPose();
    const target = direction * degreesPerSecond * Math.PI / 180;
    const elapsed = Math.min(dt,.25);
    const tau = .42, blend = -Math.expm1(-elapsed/tau);
    angle += target*elapsed + (velocity-target)*tau*blend;
    velocity += (target-velocity)*blend;
    nav.setOrbitPose(pose,angle);
  }

  function setCinema(active) {
    pause();
    document.body.classList.toggle('cinema', active);
    exitButton.hidden = !active;
    controls.hidden = !active || !nav;
    const focusTarget = active ? canvas : enterButton;
    focusTarget.focus({ preventScroll: true });
  }

  enterButton.addEventListener('click', () => setCinema(true));
  exitButton.addEventListener('click', () => setCinema(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !exitButton.hidden && !dialog.open) {
      event.preventDefault();
      setCinema(false);
    }
  });
  return {tick, pause};
}
