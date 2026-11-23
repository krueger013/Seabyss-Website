import { daylightHours } from './climate-model.js';

const radians = Math.PI / 180;
const revolution = 2 * Math.PI;
const number = new Intl.NumberFormat('fr-CA', { maximumSignificantDigits: 4 });
const latitudeNumber = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 1 });
const landmarks = [
  { longitude: 0, name: 'Équinoxe de printemps' },
  { longitude: 90, name: 'Solstice d’été' },
  { longitude: 180, name: 'Équinoxe d’automne' },
  { longitude: 270, name: 'Solstice d’hiver' }
];
const northSeasons = ['Printemps', 'Été', 'Automne', 'Hiver'];
const wrapTurn = angle => ((angle % revolution) + revolution) % revolution;

export function orbitGeometry(measurement, options) {
  const { semiMajorAxis: a, eccentricity: e, perihelionLongitude } = options;
  const trueAnomaly = (measurement.solarLongitude - perihelionLongitude) * radians;
  const periapsis = a * (1 - e);
  const apoapsis = a * (1 + e);
  return {
    periapsis, apoapsis,
    fluxRatio: (apoapsis / periapsis) ** 2,
    center: -a * e,
    semiMajor: a,
    semiMinor: a * Math.sqrt(1 - e * e),
    planet: [measurement.orbitalDistance * Math.cos(trueAnomaly), measurement.orbitalDistance * Math.sin(trueAnomaly)]
  };
}

export function daysToOrbitLongitude(measurement, options, targetLongitude) {
  const { eccentricity: e, perihelionLongitude } = options;
  const toMeanAnomaly = longitude => {
    const angle = (longitude - perihelionLongitude) * radians;
    const eccentric = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(angle), e + Math.cos(angle));
    return eccentric - e * Math.sin(eccentric);
  };
  const phase = wrapTurn(toMeanAnomaly(targetLongitude) - toMeanAnomaly(measurement.solarLongitude));
  const period = measurement.orbitalPeriod;
  const days = period * phase / revolution;
  // At a landmark, advance to the next occurrence of that same landmark.
  return days < 1e-7 || period - days < 1e-7 ? period : days;
}

function drawOrbit(canvas, measurement, options, markedLongitude) {
  const { width, height } = canvas.getBoundingClientRect();
  if (width < 1 || height < 1) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const resolution = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * resolution), pixelHeight = Math.round(height * resolution);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(resolution, 0, 0, resolution, 0, 0);
  context.clearRect(0, 0, width, height);

  const orbit = orbitGeometry(measurement, options);
  const scale = Math.min((width - 32) / (2 * orbit.semiMajor), (height - 23) / (2 * orbit.semiMinor));
  if (scale <= 0) return;
  const focusX = width / 2 - orbit.center * scale, focusY = height / 2;
  const halfWidth = orbit.semiMajor * scale, halfHeight = orbit.semiMinor * scale;
  const onScreen = ([x, y]) => [focusX + x * scale, focusY - y * scale];
  const polar = (angle, distance) => onScreen([distance * Math.cos(angle), distance * Math.sin(angle)]);
  const dot = (x, y, radius, fill, outline) => {
    context.beginPath();
    context.arc(x, y, radius, 0, revolution);
    context.fillStyle = fill;
    context.fill();
    if (outline) { context.strokeStyle = outline; context.stroke(); }
  };

  context.beginPath();
  context.moveTo(width / 2 - halfWidth, focusY);
  context.lineTo(width / 2 + halfWidth, focusY);
  context.setLineDash([3, 4]);
  context.strokeStyle = '#53718b';
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.ellipse(width / 2, focusY, halfWidth, halfHeight, 0, 0, revolution);
  context.strokeStyle = '#789bb3';
  context.stroke();

  for (const { longitude } of landmarks) {
    const { eccentricity: e, perihelionLongitude } = options;
    const angle = (longitude - perihelionLongitude) * radians;
    const distance = orbit.semiMajor * (1 - e * e) / (1 + e * Math.cos(angle));
    const [x, y] = polar(angle, distance);
    dot(x, y, longitude === markedLongitude ? 4.5 : 2.5, '#101c29', '#b0cedd');
  }

  const planet = onScreen(orbit.planet);
  context.beginPath();
  context.moveTo(focusX, focusY);
  context.lineTo(...planet);
  context.strokeStyle = '#89d9e0b0';
  context.stroke();
  const glow = context.createRadialGradient(focusX, focusY, 2, focusX, focusY, 18);
  glow.addColorStop(0, '#ffe6a5a0');
  glow.addColorStop(1, '#f6ae5700');
  dot(focusX, focusY, 18, glow);
  dot(focusX, focusY, 5, '#ffe4a1', '#fff2ca');
  dot(...planet, 4.5, '#83dfe5', '#c4f9ff');
}

export function createClimateOrbit(host, { onAdvance } = {}) {
  host.classList.add('climate-orbit');
  host.innerHTML = '<figure class="climate-orbit-figure"><canvas data-climate-orbit-canvas role="img" aria-label="Orbite simulée vue du dessus, avec l’étoile à un foyer."></canvas>' +
    '<figcaption><span class="cl-orbit-star">Étoile</span><span class="cl-orbit-world">Planète</span><span class="cl-orbit-season">Repères saisonniers</span></figcaption></figure>' +
    '<dl class="climate-local-readouts cl-orbit-readouts"><div><dt>Distance minimale</dt><dd data-climate-orbit-periapsis></dd></div>' +
    '<div><dt>Distance maximale</dt><dd data-climate-orbit-apoapsis></dd></div>' +
    '<div><dt>Flux au plus près ÷ au plus loin</dt><dd data-climate-orbit-flux></dd></div>' +
    '<div><dt data-climate-orbit-latitude>Durée du jour</dt><dd data-climate-orbit-daylight></dd></div></dl>' +
    '<p class="cl-orbit-phase" data-climate-orbit-phase></p>' +
    '<div class="cl-orbit-action"><label for="climate-orbit-landmark">Prochain repère au nord</label>' +
    '<div><select id="climate-orbit-landmark" data-climate-orbit-landmark></select><button type="button" data-climate-orbit-go>Avancer</button></div>' +
    '<output data-climate-orbit-wait></output></div>';
  const $ = key => host.querySelector('[data-climate-orbit-' + key + ']');
  const canvas = $('canvas'), select = $('landmark'), go = $('go');
  let current, settings, frame = 0;
  for (const { longitude, name } of landmarks) select.append(new Option(name, String(longitude), longitude === 90, longitude === 90));
  go.hidden = !onAdvance;
  function schedule() {
    if (frame || !current) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawOrbit(canvas, current, settings, Number(select.value));
    });
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(canvas);
  const remainingDays = () => daysToOrbitLongitude(current, settings, Number(select.value));
  function showCountdown() {
    if (!current) return;
    $('wait').textContent = 'Dans ' + number.format(remainingDays()) + ' j simulés';
    schedule();
  }
  select.onchange = showCountdown;
  go.onclick = () => { if (current) onAdvance?.(remainingDays()); };

  function update(measurement, options, latitude = 46.8118) {
    current = measurement;
    settings = options;
    const { periapsis, apoapsis, fluxRatio } = orbitGeometry(current, settings);
    $('periapsis').textContent = number.format(periapsis) + ' UA';
    $('apoapsis').textContent = number.format(apoapsis) + ' UA';
    $('flux').textContent = '× ' + number.format(fluxRatio);
    $('latitude').textContent = 'Durée du jour à ' + latitudeNumber.format(Math.abs(latitude)) + '° ' + (latitude < 0 ? 'S' : 'N');
    $('daylight').textContent = number.format(daylightHours(latitude, current.solarDeclination)) + ' h';
    const angle = ((current.solarLongitude % 360) + 360) % 360;
    const closest = Math.round(angle / 90);
    const nearLandmark = Math.abs(angle - closest * 90) < .01;
    const phase = nearLandmark ? landmarks[closest % landmarks.length].name : northSeasons[Math.floor(angle / 90)];
    $('phase').textContent = settings.obliquity > 0 ? phase + ' au nord' : 'Axe sans inclinaison';
    showCountdown();
  }
  return { update, dispose() { observer.disconnect(); cancelAnimationFrame(frame); } };
}
