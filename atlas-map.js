const STAR_FIELD = 'stellar-field';
const GALAXIES = 'galaxy-field';
const DEEP_FIELD = 'deep-field';
const TITLE = {sun:'Système solaire', earth:'Terre et Lune', jupiter:'Système jovien', saturn:'Système saturnien',
  'sim-1697-star':'Système simulé 1697', [STAR_FIELD]:'Étoiles depuis le Soleil', [GALAXIES]:'Galaxies de l’atlas',
  [DEEP_FIELD]:'Nébuleuses et amas depuis le Soleil'};

const element = (tag, className, label) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label) node.textContent = label;
  return node;
};

export function createStarChart(container, {objects, currentId, measure, travel}) {
  const byId = new Map(objects.map(body => [body.id, body]));
  const parents = objects.filter(body => body.kind !== 'galaxy' && objects.some(o => o.parentId === body.id));
  const groups = ['sun', ...parents.map(body => body.id).filter(id => id !== 'sun'), STAR_FIELD, DEEP_FIELD, GALAXIES];
  function scopeFor(body) {
    if (body.kind === 'galaxy') return GALAXIES;
    if (body.kind === 'nebula' || body.kind === 'cluster') return DEEP_FIELD;
    if (body.kind === 'star' && body.id !== 'sun' && !body.simulated) return STAR_FIELD;
    return groups.includes(body.parentId) ? body.parentId : groups.includes(body.id) ? body.id : 'sun';
  }
  function groupName(id) { return TITLE[id] || (byId.get(id)?.name + ' et ses satellites'); }
  let selected = byId.get(currentId) || byId.get('earth');
  let group = scopeFor(selected);
  const toolbar = element('div','chart-toolbar');
  const field = element('label','chart-field','Région');
  const scope = element('select','chart-select');
  for (const id of groups) scope.add(new Option(groupName(id), id));
  field.append(scope);
  const targetField = element('label','chart-field','Astre');
  const selectBody = element('select','chart-select');
  targetField.append(selectBody);
  toolbar.append(field, targetField);
  const plot = element('div','chart-plot');
  const canvas = element('canvas');
  canvas.setAttribute('aria-hidden','true');
  const mapButtons = element('div','chart-pins');
  plot.append(canvas, mapButtons);
  const note = element('p','chart-note');
  const detail = element('div','chart-detail');
  const identity = element('div','chart-identity');
  const category = element('small'), title = element('h3'), distance = element('p'), description = element('p','chart-description');
  identity.append(category,title,distance);
  const actions = element('div','chart-actions');
  const enter = element('button','chart-secondary');
  const depart = element('button','primary-btn','Rejoindre');
  depart.dataset.chartTravel = '';
  actions.append(enter,depart);
  detail.append(identity,description,actions);
  container.append(toolbar, plot, note, detail);
  const compact = n => new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1}).format(n);
  let center, children, points;

  function loadGroup(id, preferred) {
    group = id;
    scope.value = id;
    center = byId.get([STAR_FIELD,DEEP_FIELD].includes(id) ? 'sun' : id === GALAXIES ? 'milky-way' : id);
    children = objects.filter(body => {
      if (id === GALAXIES) return body.kind === 'galaxy' && body !== center;
      if (id === DEEP_FIELD) return body.kind === 'nebula' || body.kind === 'cluster';
      if (id === STAR_FIELD) return body.kind === 'star' && body !== center;
      return body.parentId === center.id;
    });
    children.sort((a,b) => radial(a) - radial(b));
    selectBody.replaceChildren(...[center,...children].map(b => new Option(b.name,b.id)));
    selected = [center,...children].find(b => b.id === preferred) || center;
    note.textContent = [STAR_FIELD,GALAXIES,DEEP_FIELD].includes(id)
      ? 'Projection vue du nord céleste. Distances comprimées et tailles symboliques.'
      : 'Positions illustratives vues de dessus. Distances comprimées et tailles symboliques.';
    updateDetail();
    draw();
  }
  function radial(body) {
    return Math.hypot(...body.position.map((n,i) => n - center.position[i]));
  }
  function updateDetail() {
    selectBody.value = selected.id;
    category.textContent = selected.category;
    title.textContent = selected.name;
    const period = selected.orbitPeriodDays;
    const info = [];
    if (selected !== center) info.push('Distance à l’astre central · ' + measure(radial(selected)));
    else info.push('Rayon · ' + measure(selected.radius));
    if (period) info.push('Période · ' + compact(period) + ' j');
    distance.textContent = info.join('   ·   ');
    description.textContent = selected.description;
    enter.hidden = !groups.includes(selected.id) || selected.id === group;
    enter.textContent = 'Explorer le système';
    depart.setAttribute('aria-label', 'Rejoindre ' + selected.name);
  }
  function choose(id) { selected = byId.get(id); updateDetail(); draw(); }
  scope.onchange = () => loadGroup(scope.value);
  selectBody.onchange = () => choose(selectBody.value);
  enter.onclick = () => loadGroup(selected.id);
  depart.onclick = () => travel(selected.id);

  function draw() {
    const w = plot.clientWidth, h = plot.clientHeight;
    if (w < 2 || h < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr,dpr);
    const cx = w*.50, cy = h*.51, rx = Math.max(48,w*.41), ry = Math.max(36,h*.40);
    ctx.strokeStyle = 'rgba(212,199,174,.13)';
    ctx.setLineDash([2,6]); ctx.beginPath(); ctx.moveTo(10,cy); ctx.lineTo(w-10,cy);
    ctx.moveTo(cx,8); ctx.lineTo(cx,h-8); ctx.stroke(); ctx.setLineDash([]);
    // Map spans are compressed, but angles and marker ordering come from the
    // same positions as the actual flight model.
    const far = Math.max(1,...children.map(radial));
    const near = Math.max(1,Math.min(...children.map(radial)) * .33);
    const extent = Math.log1p(far/near);
    points = [{body:center,x:cx,y:cy}];
    for (const body of children) {
      const dx = body.position[0]-center.position[0], dz = body.position[2]-center.position[2];
      const angle = Math.atan2(dz,dx);
      const radius = Math.log1p(radial(body)/near)/extent;
      const px = cx + Math.cos(angle)*rx*radius, py = cy + Math.sin(angle)*ry*radius;
      ctx.strokeStyle = body === selected ? 'rgba(231,186,126,.64)' : 'rgba(171,193,211,.19)';
      ctx.beginPath();
      if ([STAR_FIELD,GALAXIES,DEEP_FIELD].includes(group)) {
        ctx.moveTo(cx,cy); ctx.lineTo(px,py);
      } else {
        ctx.ellipse(cx,cy,rx*radius,ry*radius,0,0,Math.PI*2);
      }
      ctx.stroke();
      points.push({body,x:px,y:py});
    }
    // Label the selection first and avoid plotting text over neighbouring points.
    const labels = [];
    ctx.font = '12px "Segoe UI", sans-serif';
    const ordered = [...points].sort((a,b) => Number(b.body === selected)-Number(a.body === selected));
    for (const p of ordered) {
      const text = p.body.name;
      const width = ctx.measureText(text).width;
      for (const [ox,oy] of [[10,-10],[10,19],[-width-10,-10],[-width-10,19]]) {
        const x = p.x+ox, y=p.y+oy;
        const rect = {x:x-3,y:y-13,w:width+6,h:17};
        const overlaps = a => rect.x<a.x+a.w && rect.x+rect.w>a.x && rect.y<a.y+a.h && rect.y+rect.h>a.y;
        if (x<3 || x+width>w-3 || y<14 || y>h-2 || labels.some(overlaps)
          || points.some(q => q!==p && overlaps({x:q.x-5,y:q.y-5,w:10,h:10}))) continue;
        ctx.lineWidth=3; ctx.strokeStyle='#0b1015'; ctx.strokeText(text,x,y);
        ctx.fillStyle = p.body===selected ? '#f6dfbf' : '#c1c6cc'; ctx.fillText(text,x,y);
        labels.push(rect); break;
      }
    }
    // Reuse the markers so focus survives keyboard selection and resizing.
    const existing = new Map([...mapButtons.children].map(b => [b.dataset.mapBody,b]));
    for (const p of points) {
      let pin = existing.get(p.body.id);
      if (!pin) {
        pin = element('button','chart-pin'); pin.type='button'; pin.dataset.mapBody=p.body.id;
        pin.setAttribute('aria-label',p.body.name);
        pin.onclick = event => {
          if (!event.detail) { choose(p.body.id); return; }
          // Some binaries are genuinely unresolved at this scale. Consecutive
          // taps cycle their members; the object selector always lists each one.
          const current = points.find(q => q.body.id === pin.dataset.mapBody);
          const near = points.filter(q => Math.hypot(q.x-current.x,q.y-current.y) < 12);
          if (near.length <= 1) { choose(p.body.id); return; }
          const index = near.findIndex(q => q.body === selected);
          choose(near[(index+1) % near.length].body.id);
        };
        mapButtons.append(pin);
      }
      existing.delete(p.body.id);
      pin.style.left=p.x+'px'; pin.style.top=p.y+'px'; pin.style.setProperty('--body-color',p.body.color);
      pin.setAttribute('aria-pressed', String(p.body===selected));
    }
    for (const pin of existing.values()) pin.remove();
  }
  loadGroup(group,selected.id);
  const observer = new ResizeObserver(draw); observer.observe(plot);
  return () => observer.disconnect();
}
