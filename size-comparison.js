import { assetUrl } from './assets.js';
import { earthUnprojection } from './earth-explorer.js';

const groups = new Map([
  ['planet', 'Planètes'], ['moon', 'Satellites naturels'], ['dwarf', 'Planètes naines'],
  ['asteroid', 'Astéroïdes'], ['star', 'Étoiles']
]);
const presets = [
  ['earth-moon', 'Terre / Lune', 'earth', 'moon'],
  ['jupiter-earth', 'Jupiter / Terre', 'jupiter', 'earth'],
  ['sun-earth', 'Soleil / Terre', 'sun', 'earth']
];
const mappedBodies = new Set(['earth','moon','mercury','mars','jupiter','saturn','io','europa','ganymede','callisto','enceladus','titan']);
const kilometres = new Intl.NumberFormat('fr-CA', {maximumFractionDigits:2});
const ratios = new Intl.NumberFormat('fr-CA', {maximumSignificantDigits:4});
const smallRatios = new Intl.NumberFormat('fr-CA', {maximumSignificantDigits:4,notation:'scientific'});

export function comparableBodies(objects) {
  return objects.filter(body => groups.has(body.kind) && !body.simulated && body.radiusBasis !== 'field' &&
    Number.isFinite(body.radius) && body.radius > 0);
}

export function comparisonScale(a, b, width, height) {
  const diameterA = 2 * a.radius, diameterB = 2 * b.radius;
  const largest = Math.max(diameterA, diameterB);
  const pxPerKm = Math.min(width * .42, height * .89) / largest;
  const target = largest * .4;
  const decade = 10 ** Math.floor(Math.log10(target));
  const rulerKm = (target >= 5 * decade ? 5 : target >= 2 * decade ? 2 : 1) * decade;
  return {diameterA, diameterB, ratio:diameterA / diameterB, pxPerKm, rulerKm};
}

// Project each existing surface map once. Both silhouettes use the same km/pixel scale.
function globeTexture(image, id) {
  const map = document.createElement('canvas');
  map.width = 512; map.height = 256;
  const source = map.getContext('2d', {willReadFrequently:true});
  source.drawImage(image, 0, 0, map.width, map.height);
  const pixels = source.getImageData(0, 0, map.width, map.height).data;
  const disk = document.createElement('canvas');
  disk.width = disk.height = 224;
  const ctx = disk.getContext('2d'), frame = ctx.createImageData(disk.width, disk.height);
  const view = {latitude:id === 'earth' ? 16 : 2, longitude:id === 'earth' ? -38 : 0};
  for (let y = 0; y < disk.height; y++) {
    const ny = 1 - 2 * (y + .5) / disk.height;
    for (let x = 0; x < disk.width; x++) {
      const nx = 2 * (x + .5) / disk.width - 1;
      const point = earthUnprojection(nx, ny, view);
      if (!point) continue;
      const u = Math.min(map.width-1, Math.floor((point.longitude+180)/360*map.width));
      const v = Math.min(map.height-1, Math.floor((90-point.latitude)/180*map.height));
      const i = (v * map.width + u) * 4, j = (y * disk.width + x) * 4;
      const z = Math.sqrt(Math.max(0, 1-nx*nx-ny*ny));
      const light = .27 + .83 * Math.max(0, -.37*nx + .30*ny + .88*z);
      frame.data[j] = pixels[i] * light;
      frame.data[j+1] = pixels[i+1] * light;
      frame.data[j+2] = pixels[i+2] * light;
      frame.data[j+3] = 255;
    }
  }
  ctx.putImageData(frame,0,0);
  return disk;
}

function paintDisk(ctx, body, texture, x, y, diameter) {
  const radius = diameter / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x,y,radius,0,2*Math.PI);
  ctx.clip();
  const light = ctx.createRadialGradient(x-.24*radius,y-.22*radius,0,x,y,radius);
  light.addColorStop(0, body.kind === 'star' ? '#fff6d9' : '#e3e3dc');
  light.addColorStop(.60, body.color);
  light.addColorStop(1, body.kind === 'star' ? body.color : '#35404b');
  ctx.fillStyle = light;
  ctx.fillRect(x-radius,y-radius,diameter,diameter);
  if (texture) ctx.drawImage(texture,x-radius,y-radius,diameter,diameter);
  ctx.restore();
}

export function createSizeComparison(host, {objects=[],initialId,onVisit}={}) {
  const list = comparableBodies(objects);
  const byId = new Map(list.map(body => [body.id,body]));
  const view = document.createElement('section');
  view.className = 'size-comparison';
  view.setAttribute('aria-label','Comparateur de diamètres');
  host.append(view);
  if (list.length < 2) {
    view.textContent = 'Deux astres de rayon connu sont nécessaires pour comparer leurs diamètres.';
    return () => view.remove();
  }
  view.innerHTML = `<div class="size-pickers">
    <label>Astre de gauche<select data-size-a></select></label>
    <button type="button" data-size-swap>Inverser</button>
    <label>Astre de droite<select data-size-b></select></label></div>
    <div class="size-stage">
      <div class="size-labels" aria-hidden="true"><span data-size-name="a"></span><span data-size-name="b"></span></div>
      <canvas data-size-canvas role="img"></canvas>
      <div class="size-ruler" aria-hidden="true"><i></i><span></span></div>
    </div>
    <dl class="size-results" aria-live="polite" aria-atomic="true">
      <div><dt data-size-label="a"></dt><dd data-size-diameter="a"></dd></div>
      <div class="size-ratio"><dt data-size-ratio-label></dt><dd data-size-ratio></dd></div>
      <div><dt data-size-label="b"></dt><dd data-size-diameter="b"></dd></div>
    </dl>
    <p class="size-note">Diamètres estimés à partir des rayons du catalogue. Les silhouettes des corps irréguliers utilisent leur rayon moyen.</p>
    <div class="size-examples" role="group" aria-label="Exemples de comparaison"></div>
    <div class="size-visits"><button type="button" data-size-visit="a"></button><button type="button" data-size-visit="b"></button></div>`;
  const $ = selector => view.querySelector(selector);
  const side = [$('[data-size-a]'), $('[data-size-b]')];
  const canvas = $('[data-size-canvas]'), ctx = canvas.getContext('2d');
  const label = ['a','b'];
  const names = label.map(key => $('[data-size-name="'+key+'"]'));
  const values = label.map(key => $('[data-size-diameter="'+key+'"]'));
  const titles = label.map(key => $('[data-size-label="'+key+'"]'));
  const visits = label.map(key => $('[data-size-visit="'+key+'"]'));
  const textures = new Map(), examples = $('.size-examples');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let closed = false, transition;
  const first = byId.get(initialId) || byId.get('earth') || list[0];
  let second = byId.get(first.id === 'earth' ? 'moon' : 'earth');
  if (!second || second === first) second = list.find(body => body !== first);
  const pair = [first,second];

  for (const select of side) {
    for (const [kind,title] of groups) {
      const entries = list.filter(body => body.kind === kind).sort((a,b) => a.name.localeCompare(b.name,'fr'));
      if (!entries.length) continue;
      const group = document.createElement('optgroup');
      group.label = title;
      for (const body of entries) group.append(new Option(body.name,body.id));
      select.append(group);
    }
  }
  for (const [id,title,left,right] of presets) {
    if (!byId.has(left) || !byId.has(right)) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.sizePreset = id; button.textContent = title;
    button.onclick = () => { pair[0] = byId.get(left); pair[1] = byId.get(right); update(true); };
    examples.append(button);
  }
  $('.size-visits').hidden = typeof onVisit !== 'function';

  function draw() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (closed || !width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1,2);
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
    ctx.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
    const scale = comparisonScale(pair[0],pair[1],width,height);
    const y = height/2;
    ctx.strokeStyle = '#7089934a'; ctx.setLineDash([2,6]); ctx.beginPath();
    ctx.moveTo(0,y); ctx.lineTo(width,y); ctx.stroke(); ctx.setLineDash([]);
    const tiny = [];
    pair.forEach((body,i) => {
      const diameter = 2*body.radius*scale.pxPerKm;
      paintDisk(ctx,body,textures.get(body.id),width*(i === 0 ? .25 : .75),y,diameter);
      names[i].textContent = body.name + (diameter < 1 ? ' · < 1 px' : '');
      if (diameter < 1) tiny.push(body.name+' occupe moins d’un pixel.');
    });
    $('.size-ruler i').style.width = scale.rulerKm*scale.pxPerKm+'px';
    $('.size-ruler span').textContent = kilometres.format(scale.rulerKm)+' km';
    canvas.setAttribute('aria-label',pair.map((body,i) => body.name+', '+values[i].textContent).join(' et ')+
      ', à la même échelle. '+tiny.join(' '));
  }
  function loadMap(body) {
    if (!mappedBodies.has(body.id) || textures.has(body.id)) return;
    textures.set(body.id,null);
    const image = new Image();
    image.onload = () => {
      if (closed) return;
      textures.set(body.id,globeTexture(image,body.id));
      if (pair.includes(body)) draw();
    };
    image.src = assetUrl(body.id === 'earth' ? 'earth-land-preview.webp' : body.id+'-day.webp');
  }
  function update(animate) {
    pair.forEach((body,i) => {
      side[i].value = body.id;
      const diameter = body.radius*2;
      titles[i].textContent = 'Diamètre · '+body.name;
      values[i].dataset.km = String(diameter);
      values[i].textContent = kilometres.format(diameter)+' km';
      visits[i].textContent = 'Explorer '+body.name;
      loadMap(body);
    });
    const ratio = pair[0].radius/pair[1].radius;
    $('[data-size-ratio-label]').textContent = pair[0].name+' ÷ '+pair[1].name;
    const output = $('[data-size-ratio]');
    output.dataset.value = String(ratio);
    output.textContent = (ratio < .0001 ? smallRatios : ratios).format(ratio)+' ×';
    for (const button of examples.children) {
      button.setAttribute('aria-pressed',String(button.dataset.sizePreset === pair.map(body => body.id).join('-')));
    }
    draw();
    transition?.cancel();
    if (animate && !reduced.matches) transition = canvas.animate([{opacity:.65},{opacity:1}],{duration:220,easing:'ease-out'});
  }
  side.forEach((select,i) => {
    select.onchange = () => {
      const next = byId.get(select.value);
      if (next === pair[1-i]) pair[1-i] = pair[i];
      pair[i] = next;
      update(true);
    };
    visits[i].onclick = () => onVisit?.(pair[i].id);
  });
  $('[data-size-swap]').onclick = () => { pair.reverse(); update(true); };
  const observer = new ResizeObserver(draw);
  observer.observe(canvas);
  const onMotion = () => { if (reduced.matches) transition?.cancel(); };
  reduced.addEventListener('change',onMotion);
  update(false);
  return () => {
    closed = true;
    observer.disconnect(); transition?.cancel();
    reduced.removeEventListener('change',onMotion);
    textures.clear(); view.remove();
  };
}
