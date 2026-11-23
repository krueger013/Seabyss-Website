const height = 23;
const margin = 5;
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// Compare sightlines, rather than screen circles. Wide-angle and off-axis
// projections otherwise show names through the dark limb of foreground planets.
function isOcculted(item, bodies) {
  const ray = item.center.map(value => value / item.distance);
  for (const near of bodies) {
    if (near === item || near.range >= item.range || ['galaxy','nebula','cluster'].includes(near.obj.kind) || near.distance <= 1) continue;
    const [a, b, c] = near.center;
    const along = a * ray[0] + b * ray[1] + c * ray[2];
    if (along <= 0) continue;
    const impact = Math.hypot(b * ray[2] - c * ray[1], c * ray[0] - a * ray[2], a * ray[1] - b * ray[0]);
    if (impact < 1) return true;
  }
  return false;
}

export function placeBodyLabels(items, selectedId, viewport, reserved, measure) {
  const candidates = items.filter(({obj, visible, bounds, radius, distance}) =>
    visible && bounds && radius >= .5 && distance > 1 && (obj.kind !== 'galaxy' || distance > 1.15));
  candidates.sort((a, b) => Number(b.obj.id === selectedId) - Number(a.obj.id === selectedId) || b.radius - a.radius);
  const placed = [];
  const occupied = reserved.slice();
  for (const item of candidates) {
    if (isOcculted(item, items)) continue;
    const selected = item.obj.id === selectedId;
    const width = measure(item.obj.name, selected);
    if (width + 2 * margin > viewport.w) continue;
    const left = Math.max(margin, Math.min(viewport.w - width - margin, item.x - width / 2));
    // A label stays above its own centre, including on a closely zoomed globe.
    // When the limb is off-screen, the name rests just inside the visible disc.
    const minTop = margin;
    const maxTop = Math.min(viewport.h - height - margin, item.y - height - 2);
    if (maxTop < minTop) continue;
    const idealTop = Math.min(maxTop, Math.max(minTop, item.y - (item.labelRise ?? item.radius) - height - 7));
    const choices = [idealTop];
    for (const box of occupied) {
      if (box.right <= left || box.left >= left + width) continue;
      choices.push(box.top - height - 1, box.bottom + 1);
    }
    choices.sort((a,b) => Math.abs(a-idealTop)-Math.abs(b-idealTop));
    for (const top of choices) {
      if (top < minTop || top > maxTop) continue;
      if (!selected && Math.abs(top-idealTop) > 46) continue;
      const box = { left, top, right: left + width, bottom: top + height };
      if (occupied.some(other => intersects(box, other))) continue;
      placed.push({ id:item.obj.id, name:item.obj.name, selected, left, top });
      occupied.push({ left:box.left - 4, right:box.right + 4, top:box.top - 3, bottom:box.bottom + 3 });
      break;
    }
  }
  return placed;
}

export class BodyLabels {
  constructor(canvas) {
    this.canvas = canvas;
    this.layer = document.createElement('div');
    this.layer.className = 'body-labels';
    this.layer.setAttribute('aria-hidden', 'true');
    canvas.after(this.layer);
    this.labels = new Map();
    this.widths = new Map();
    this.measuring = document.createElement('canvas').getContext('2d');
    this.measuring.font = '600 12px "Segoe UI", Arial, sans-serif';
    this.revision = 0;
    this.layoutKey = '';
    this.panels = Array.from(document.querySelectorAll(
      '.brand-type,.masthead,.stage-heading,.target-info,.destinations,.flight-hud,.flight-controls .pad,.flight-controls .speed-panel,#exit-cinema,.sim-toolbar'));
    const changed = () => { this.layoutKey = ''; this.revision++; };
    this.observer = new ResizeObserver(changed);
    for (const panel of [canvas, ...this.panels]) this.observer.observe(panel);
    this.stateObserver = new MutationObserver(changed);
    this.stateObserver.observe(document.body, { attributes:true, attributeFilter:['class'] });
  }
  reserved(w, h) {
    const key = w + ',' + h + ',' + document.body.className;
    if (key !== this.layoutKey) {
      const stage = this.canvas.getBoundingClientRect();
      this.obstacles = this.panels.map(panel => panel.getBoundingClientRect())
        .filter(box => box.width > 0 && box.height > 0 && box.right > stage.left && box.bottom > stage.top)
        .map(box => ({left:box.left-stage.left-3, top:box.top-stage.top-2, right:box.right-stage.left+3, bottom:box.bottom-stage.top+2}));
      this.layoutKey = key;
    }
    return this.obstacles;
  }
  draw(items, selectedId, cam, visible) {
    this.layer.hidden = !visible;
    if (!visible) return;
    const positions = placeBodyLabels(items, selectedId, cam, this.reserved(cam.w, cam.h), name => {
      if (!this.widths.has(name)) this.widths.set(name, Math.ceil(this.measuring.measureText(name).width) + 17);
      return this.widths.get(name);
    });
    const shown = new Set();
    for (const {id, name, selected, left, top} of positions) {
      let element = this.labels.get(id);
      if (!element) {
        element = document.createElement('span');
        element.className = 'body-label';
        element.dataset.objectId = id;
        element.textContent = name;
        this.layer.append(element);
        this.labels.set(id, element);
      }
      shown.add(id);
      element.hidden = false;
      element.classList.toggle('is-target', selected);
      element.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    }
    for (const [id, element] of this.labels) if (!shown.has(id)) element.hidden = true;
  }
}
