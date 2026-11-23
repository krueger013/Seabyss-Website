import { assetUrl } from './assets.js';

const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
const fold = text => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu,'')
  .toLocaleLowerCase('fr').replace(/[^\p{L}\p{N}]+/gu,' ');
const coordinate = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});

function make(tag,className,text) {
  const node=document.createElement(tag);
  if(className) node.className=className;
  if(text!==undefined) node.textContent=text;
  return node;
}

function button(className,text,action) {
  const node=make('button',className,text);
  node.type='button';
  node.onclick=action;
  return node;
}

function formatCoordinates(latitude,longitude) {
  const lat=coordinate.format(Math.abs(latitude))+'° '+(latitude<0?'S':'N');
  const lon=coordinate.format(Math.abs(longitude))+'° '+(longitude<0?'O':'E');
  return lat+' · '+lon;
}

export function renderSurfaceExplorer(panel,{worlds,sites,progress,land,pilot,initialWorld}={}) {
  const byWorld=new Map(worlds.map(world=>[world.id,world]));
  const points=sites.filter(site=>byWorld.has(site.worldId));
  let selected=points.find(site=>site.default && site.worldId===initialWorld) || points.find(site=>site.default) || points[0];
  const root=make('section','surface-atlas');
  root.setAttribute('aria-label','Atlas des surfaces');
  root.dataset.surfaceAtlas='';

  const header=make('header','sa-header');
  const overview=make('p','sa-overview',points.length+' sites · '+byWorld.size+' mondes');
  const search=make('input','sa-search');
  search.type='search';
  search.dataset.surfaceSearch='';
  search.placeholder='Chercher un lieu ou un monde';
  search.setAttribute('aria-label','Chercher un lieu ou un monde');
  const searchStatus=make('p','sa-reader');
  searchStatus.setAttribute('role','status');
  header.append(overview,search,searchStatus);

  const worldsNav=make('nav','sa-worlds');
  worldsNav.setAttribute('aria-label','Choisir un monde');
  const worldPicker=make('select','sa-world-picker');
  worldPicker.setAttribute('aria-label','Choisir un monde');
  worldPicker.dataset.surfaceAtlasWorld='';
  const worldButtons=new Map();
  function chooseWorld(id) {
    search.value='';
    const site=points.find(item=>item.worldId===id && item.default);
    if(site) selected=site;
    update();
  }
  for(const world of worlds) {
    const control=button('sa-world',world.name,()=>chooseWorld(world.id));
    control.dataset.surfaceWorldPick=world.id;
    control.style.setProperty('--sa-world',world.color);
    worldButtons.set(world.id,control);
    worldsNav.append(control);
    worldPicker.add(new Option(world.name,world.id));
  }
  worldPicker.onchange=()=>chooseWorld(worldPicker.value);

  const layout=make('div','sa-layout');
  const chart=make('section','sa-chart');
  const chartHead=make('header','sa-chart-head');
  const chartWorld=make('h4');
  const chartSiteCount=make('span');
  chartHead.append(chartWorld,chartSiteCount);
  const map=make('div','sa-map');
  map.dataset.surfaceAtlasMap='';
  const image=make('img','sa-texture');
  image.alt='';
  image.decoding='async';
  const markers=make('div','sa-markers');
  map.append(image,markers);
  const location=make('footer','sa-location');
  const locationName=make('strong');
  const locationCoords=make('span');
  const locationReadout=make('div','sa-location-readout');
  locationReadout.append(locationName,locationCoords);
  const chartExplore=button('sa-chart-explore','Explorer',()=>{
    if(selected) land(selected.worldId,selected.default?undefined:selected.id);
  });
  chartExplore.dataset.surfaceMapExplore='';
  location.append(locationReadout,chartExplore);
  chart.append(chartHead,map,location);

  const list=make('div','sa-directory');
  list.setAttribute('aria-label','Sites disponibles');
  const empty=make('p','sa-empty','Aucun site trouvé.');
  const rows=points.map(site=>{
    const world=byWorld.get(site.worldId);
    const article=make('article','sa-site');
    article.dataset.surfaceListing=site.id;
    article.style.setProperty('--sa-world',world.color);
    const details=make('div','sa-site-details');
    const name=button('sa-site-name',site.name,()=>{
      selected=site;
      update();
    });
    name.dataset.surfacePreview=site.id;
    const place=make('span','sa-site-world',world.name);
    const description=site.description?make('p','sa-description',site.description):null;
    const scans=clamp(Number(progress?.(site.worldId,site.id))||0,0,site.total);
    const count=make('span','sa-progress',scans+' / '+site.total+' relevés');
    if(scans===site.total && site.total) count.classList.add('sa-complete');
    details.append(place,name);
    if(description) details.append(description);
    details.append(count);
    const actions=make('div','sa-actions');
    const explore=button('sa-explore','Explorer le site',()=>land(site.worldId,site.default?undefined:site.id));
    explore.setAttribute('aria-label','Explorer '+site.name+' · '+world.name);
    if(site.default) explore.dataset.surfaceLand=site.worldId;
    else explore.dataset.surfaceRegion=site.id;
    actions.append(explore);
    const canPilot=world.canPilot??['moon','mars','europa'].includes(site.worldId);
    if(site.default && canPilot && pilot) {
      const steer=button('sa-steer','Piloter',()=>pilot(site.worldId));
      steer.setAttribute('aria-label','Piloter la descente vers '+site.name);
      steer.dataset.surfacePilot=site.worldId;
      actions.append(steer);
    }
    article.append(details,actions);
    list.append(article);
    return {site,article,name,titleQuery:fold([world.name,site.name].join(' ')),
      fullQuery:fold([world.name,site.name,site.description].join(' '))};
  });
  list.append(empty);
  layout.append(chart,list);
  root.append(header,worldsNav,worldPicker,layout);
  panel.append(root);

  const loadedMarkers=new Map();
  let mappedWorld;
  function drawMap(site) {
    const world=byWorld.get(site.worldId);
    if(mappedWorld!==world.id) {
      mappedWorld=world.id;
      const localized=points.filter(item=>item.worldId===world.id);
      chart.style.setProperty('--sa-world',world.color);
      chartWorld.textContent=world.name;
      chartSiteCount.textContent=localized.length+' sites';
      image.src=assetUrl(world.texture || world.id+'-day.webp');
      loadedMarkers.clear();
      markers.replaceChildren();
      for(const entry of localized) {
        const mark=button('sa-marker','',()=>{
          selected=entry;
          update();
        });
        mark.dataset.surfaceMapMarker=entry.id;
        mark.style.left=(entry.longitude+180)/3.6+'%';
        mark.style.top=(90-entry.latitude)/1.8+'%';
        mark.setAttribute('aria-label','Afficher '+entry.name);
        mark.title=entry.name;
        loadedMarkers.set(entry.id,mark);
        markers.append(mark);
      }
    }
    locationName.textContent=site.name;
    locationCoords.textContent=formatCoordinates(site.latitude,site.longitude);
    chartExplore.setAttribute('aria-label','Explorer '+site.name+' depuis la carte');
    for(const [id,mark] of loadedMarkers) mark.setAttribute('aria-pressed',String(id===site.id));
  }

  function update() {
    const query=fold(search.value).trim();
    let visible=rows.filter(row=>row.site.worldId===selected?.worldId);
    if(query) {
      const words=query.split(/\s+/);
      visible=rows.filter(row=>words.every(word=>row.titleQuery.includes(word)));
      if(!visible.length) visible=rows.filter(row=>words.every(word=>row.fullQuery.includes(word)));
    }
    if(query && visible.length && !visible.some(row=>row.site===selected)) selected=visible[0].site;
    for(const row of rows) {
      row.article.hidden=!visible.includes(row);
      row.name.setAttribute('aria-pressed',String(row.site===selected));
      row.article.classList.toggle('sa-selected',row.site===selected);
    }
    empty.hidden=visible.length>0;
    chart.hidden=!visible.length;
    root.classList.toggle('sa-searching',Boolean(query));
    if(selected) {
      worldPicker.value=selected.worldId;
      drawMap(selected);
    }
    for(const [id,control] of worldButtons) control.setAttribute('aria-pressed',String(id===selected?.worldId));
    searchStatus.textContent=query ? visible.length+(visible.length===1?' site trouvé':' sites trouvés') : '';
  }
  search.oninput=update;
  update();
  return ()=>root.remove();
}
