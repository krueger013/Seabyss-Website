import {earthSkyBody} from './earth-sky-model.js';
import {EARTH_SKY_SITES, resolveEarthSkySite} from './earth-sky-sites.js';

const angle = new Intl.NumberFormat('fr-CA', {maximumFractionDigits:1, minimumFractionDigits:1});
const directions = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const signed = n => (n >= .05 ? '+' : n <= -.05 ? '−' : '') + angle.format(Math.abs(n)) + '°';
const clockFormats = new Map();

function civilTime(timeMs, zone = 'UTC') {
  if (!clockFormats.has(zone)) clockFormats.set(zone, new Intl.DateTimeFormat('fr-CA', {
    timeZone:zone, month:'short', day:'numeric', hour:'2-digit', minute:'2-digit',
    hourCycle:'h23', timeZoneName:'shortOffset'
  }));
  return clockFormats.get(zone).format(timeMs);
}

function makeCard(side) {
  const card = document.createElement('article');
  card.className = 'es-compare-card';
  card.innerHTML = '<h4></h4><time></time><div class="es-compare-chart" aria-hidden="true">' +
    '<div class="es-compare-grid"><span class="es-compare-horizon">0°</span><i class="es-compare-marker"></i></div>' +
    '<div class="es-compare-bearings"><span>N</span><span>E</span><span>S</span><span>O</span><span>N</span></div></div>' +
    '<div class="es-compare-reading"><span>Hauteur <strong></strong></span><span class="es-compare-bearing"></span></div>' +
    '<div class="es-compare-visible"></div>';
  const name = card.querySelector('h4'), clock = card.querySelector('time'), altitude = card.querySelector('strong');
  const bearing = card.querySelector('.es-compare-bearing'), visibility = card.querySelector('.es-compare-visible');
  const marker = card.querySelector('.es-compare-marker');
  altitude.dataset.earthCompareAlt = side;
  return {card, draw(site, body, timeMs) {
    name.textContent = site.name;
    clock.dateTime = new Date(timeMs).toISOString();
    clock.textContent = civilTime(timeMs, site.timeZone);
    marker.style.left = (body.azimuthDeg / 3.6) + '%';
    marker.style.top = (50 - body.altitudeDeg / 1.8) + '%';
    marker.style.setProperty('--astro-color', body.color);
    card.dataset.up = String(body.aboveHorizon);
    altitude.dataset.degrees = String(body.altitudeDeg);
    altitude.textContent = signed(body.altitudeDeg);
    bearing.textContent = 'Azimut ' + angle.format(body.azimuthDeg) + '° ' + directions[Math.round(body.azimuthDeg / 45) % 8];
    visibility.textContent = body.aboveHorizon ? 'Au-dessus de l’horizon' : 'Sous l’horizon';
  }};
}

export function createEarthSkyComparison(host) {
  const details = document.createElement('details');
  details.className = 'es-compare';
  details.innerHTML = '<summary data-earth-compare-open>Comparer deux lieux</summary>' +
    '<div class="es-compare-body"><div class="es-compare-tools"><label>Deuxième lieu<select data-earth-compare-site></select></label>' +
    '<div class="es-compare-instant"><strong></strong><time></time></div></div><div class="es-compare-cards"></div>' +
    '<div class="es-compare-delta"><span></span><strong data-earth-compare-difference></strong></div></div>';
  const select = details.querySelector('select'), title = details.querySelector('.es-compare-instant strong');
  const timestamp = details.querySelector('.es-compare-instant time'), delta = details.querySelector('[data-earth-compare-difference]');
  const rule = details.querySelector('.es-compare-delta span'), cards = [makeCard('a'), makeCard('b')];
  details.querySelector('.es-compare-cards').append(...cards.map(item => item.card));
  const groups = new Map();
  for (const place of EARTH_SKY_SITES) {
    if (!groups.has(place.group)) {
      const group = document.createElement('optgroup');
      group.label = place.group;
      groups.set(place.group, group);
      select.append(group);
    }
    groups.get(place.group).append(new Option(place.name, place.id));
  }
  select.value = 'tromso';
  host.append(details);
  let observation = null, primaryId = null;
  function draw() {
    if (!details.open || !observation) return;
    const site = resolveEarthSkySite(observation.site);
    if (select.value === site.id) select.value = site.id === 'tromso' ? 'levis' : 'tromso';
    if (site.id !== primaryId) {
      for (const option of select.options) option.disabled = option.value === site.id;
      primaryId = site.id;
    }
    const other = resolveEarthSkySite(select.value);
    const {date, targetId} = observation;
    const timeMs = typeof date === 'number' ? date : date instanceof Date ? date.getTime() : Date.parse(date);
    const a = earthSkyBody(site, targetId, timeMs), b = earthSkyBody(other, targetId, timeMs);
    title.textContent = a.name;
    timestamp.dateTime = new Date(timeMs).toISOString();
    timestamp.textContent = civilTime(timeMs);
    cards[0].draw(site, a, timeMs);
    cards[1].draw(other, b, timeMs);
    const change = b.altitudeDeg - a.altitudeDeg;
    delta.dataset.degrees = String(change);
    delta.textContent = signed(change);
    rule.textContent = 'Écart de hauteur · ' + other.name + ' moins ' + site.name;
  }
  details.addEventListener('toggle', draw);
  select.addEventListener('change', draw);
  return {update(value) {observation = value; draw();}, dispose() {
    details.removeEventListener('toggle', draw);
    select.removeEventListener('change', draw);
    observation = null;
    details.remove();
  }};
}
