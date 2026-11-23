import { assetUrl } from './assets.js';

const toDegrees = angle => angle * 180 / Math.PI;
const number = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const diameter = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});
const kilometres = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:0});
const clock = new Intl.DateTimeFormat('fr-CA',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'});
const signedDegrees = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:0,signDisplay:'exceptZero'});
const acceleratedRates = new Set([3600,86400]);
const octants=['N','N-E','E','S-E','S','S-O','O','N-O'];
const compass = azimuth => octants[Math.round(((toDegrees(azimuth)%360)+360)%360/45)%8];
const aboveHorizon = body => !!body && body.altitude >= -body.angularDiameter/2;
const latestDate = Date.UTC(2101,0,1) - 1000;
const starColour = index => [
  213 + Math.round(42 * Math.max(0,Math.min(1,index))),
  228 + Math.round(12 * Math.max(0,Math.min(1,index))),
  255 - Math.round(39 * Math.max(0,Math.min(1,index)))
].join(',');
const histories = {moon:29.53,mars:1.0275,europa:3.55,titan:15.945,mercury:176,ganymede:7.16,enceladus:1.371};
let catalogPromise, ephemerisPromise;

function localStars(basis, stars) {
  if (!basis || !stars?.length) return [];
  return stars.map(star=>({
    at:basis.map(axis=>star.at[0]*axis[0]+star.at[1]*axis[1]+star.at[2]*axis[2]),
    bright:star.bright,colour:star.colour
  })).filter(star=>star.at[1]>=0);
}

function loadStars() {
  catalogPromise ??= fetch(assetUrl('sky-stars.txt')).then(res=>{
    if (!res.ok) throw new Error('Catalogue stellaire indisponible');
    return res.json();
  }).then(data=>data.stars.map(([,ra,dec,mag,index])=>{
    const a=ra*Math.PI/180,d=dec*Math.PI/180,cos=Math.cos(d);
    return {at:[cos*Math.cos(a),cos*Math.sin(a),Math.sin(d)],
      bright:Math.min(1,.14+.49*Math.pow(10,-.21*mag)),colour:starColour(index)};
  })).catch(()=>null);
  return catalogPromise;
}

function age(seconds) {
  return seconds>=60 ? number.format(seconds/60)+' min' : number.format(seconds)+' s';
}

function angularSize(angle) {
  const degrees=toDegrees(angle);
  return degrees<.1 ? number.format(degrees*3600)+'″' : diameter.format(degrees)+'°';
}

export function mountSurfaceSky(root,{look,onChange=()=>{},announce=()=>{}}={}) {
  const stage=root.querySelector('.surface-scene');
  const canvas=stage.querySelector('canvas');
  const wrapper=document.createElement('div');
  wrapper.className='surface-sky';
  wrapper.innerHTML=`
    <button type="button" class="surface-sky-toggle" data-sky-surface-toggle aria-expanded="false"
      aria-controls="surface-sky-panel" aria-label="Ciel local et heure UTC">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.45">
        <path d="m12 3 1.8 6.8L21 12l-7.2 2.2L12 21l-2-6.8L3 12l7-2.2z"/>
      </svg>
      <span class="surface-sky-hud">
        <span class="surface-sky-hud-line"><strong data-sky-hud-mode>Ciel</strong><span data-sky-hud-sun></span></span>
        <time data-sky-hud-clock></time>
      </span>
    </button>
    <button type="button" class="surface-sky-release" data-sky-surface-release hidden>
      <span><strong data-sky-track-name></strong><small data-sky-track-bearing></small></span>
      <span aria-hidden="true">×</span>
    </button>
    <section class="surface-sky-panel" data-sky-surface-panel id="surface-sky-panel" aria-label="Observation du ciel" hidden>
      <header class="surface-sky-heading">
        <div><h2>Ciel local</h2><p data-sky-surface-coordinates></p></div>
        <button type="button" class="surface-sky-close" aria-label="Fermer le ciel" data-sky-surface-close>×</button>
      </header>
      <div data-sky-track-controls></div>
      <div class="surface-sky-offline" data-sky-surface-unavailable role="status" hidden></div>
      <div data-sky-surface-content>
        <div class="surface-sky-summary">
          <strong data-sky-surface-status></strong><span data-sky-surface-sun></span>
        </div>
        <div class="surface-sky-time">
          <label>Instant (UTC)<input data-sky-surface-date type="datetime-local" min="1900-01-01T00:00" max="2100-12-31T23:59"></label>
          <button type="button" data-sky-surface-now>Direct</button>
        </div>
        <label class="surface-sky-rate"><span>Accélérer le ciel</span>
          <select data-sky-surface-rate><option value="0">Arrêt</option><option value="3600">1 heure par seconde</option><option value="86400">1 jour par seconde</option></select>
        </label>
        <div class="surface-sky-presets">
          <button type="button" data-sky-surface-solar="day">Jour</button>
          <button type="button" data-sky-surface-solar="night">Nuit</button>
          <label><input type="checkbox" data-sky-surface-stars> Voir les étoiles de jour</label>
        </div>
        <label data-sky-surface-site-wrap class="surface-sky-site" hidden>Position d’observation
          <select data-sky-surface-site></select>
        </label>
        <p class="surface-sky-comparison" data-sky-surface-comparison hidden></p>
        <div class="surface-sky-presets" data-sky-surface-events hidden>
          <button type="button" data-sky-surface-event="apollo">Apollo 11</button>
          <button type="button" data-sky-surface-event="eclipse">Éclipse de 2022</button>
        </div>
        <p class="surface-sky-eclipse" data-sky-surface-eclipse hidden></p>
        <div class="surface-sky-objects" data-sky-surface-objects></div>
        <p class="surface-sky-model" data-sky-surface-model></p>
      </div>
    </section>`;
  stage.append(wrapper);
  const reticle=document.createElement('div');
  reticle.className='surface-sky-reticle';reticle.setAttribute('aria-hidden','true');reticle.hidden=true;stage.append(reticle);
  const $=selector=>wrapper.querySelector(selector);
  const button=$('[data-sky-surface-toggle]'),panel=$('[data-sky-surface-panel]'),dateInput=$('[data-sky-surface-date]');
  const list=$('[data-sky-surface-objects]'),siteSelect=$('[data-sky-surface-site]'),starsInput=$('[data-sky-surface-stars]');
  const rateSelect=$('[data-sky-surface-rate]');
  const hudClock=$('[data-sky-hud-clock]'),hudMode=$('[data-sky-hud-mode]'),hudSun=$('[data-sky-hud-sun]');
  const objects=new Map();
  const release=$('[data-sky-surface-release]'),trackName=$('[data-sky-track-name]'),trackBearing=$('[data-sky-track-bearing]');
  let trackedId;
  let world,siteId,landedSite,date=new Date(),live=true,rate=0,nextUpdate=0,timePassed=0,snapshot=null,stars,loaded=false;
  let engine=null,failed=false,hudSnapshot;

  const observer=()=>siteId===landedSite?.id ? landedSite : siteId;
  function sunInView() {
    return snapshot?.objects.find(body=>body.id==='sun');
  }
  function setText(element,content) {
    if (element.textContent!==content) element.textContent=content;
  }
  function stopTracking(message) {
    if(!trackedId) return false;
    objects.get(trackedId)?.track.setAttribute('aria-pressed','false');
    trackedId=null;reticle.hidden=true;release.hidden=true;
    delete release.dataset.target;
    if(message) announce(message);
    return true;
  }
  function aimAt(body, continuing=false) {
    if (!aboveHorizon(body) || typeof look!=='function') return false;
    return look(body.azimuth,body.altitude,continuing)!==false;
  }
  function updateBearing(body) {
    setText(trackBearing,compass(body.azimuth)+' · '+signedDegrees.format(toDegrees(body.altitude))+'°');
  }
  function startTracking(body) {
    if(!aimAt(body)) return;
    stopTracking();
    trackedId=body.id;release.dataset.target=body.id;
    setText(trackName,'Suivi · '+body.name);updateBearing(body);
    release.setAttribute('aria-label','Arrêter le suivi de '+body.name);
    release.title='Arrêter le suivi de '+body.name;
    objects.get(trackedId).track.setAttribute('aria-pressed','true');
    reticle.hidden=false;release.hidden=false;
    open(false);canvas.focus({preventScroll:true});
  }
  function renderHud() {
    const shown=live?new Date():date;
    const iso=shown.toISOString();
    if (hudClock.dateTime.slice(0,19)!==iso.slice(0,19)) {
      hudClock.dateTime=iso;
      setText(hudClock,iso.slice(11,19)+' UTC');
    }
    const mode=live?'live':rate?'timelapse':'historical';
    if (button.dataset.mode!==mode) button.dataset.mode=mode;
    setText(hudMode,live?'Direct':rate?'Accéléré':'Ciel daté');
    if (snapshot===hudSnapshot) return;
    hudSnapshot=snapshot;
    const sun=sunInView();
    setText(hudSun,sun?signedDegrees.format(toDegrees(sun.altitude))+'°':'');
    if (sun) {
      hudSun.title='Hauteur du Soleil à l’horizon géométrique';
      button.dataset.solarAltitude=String(toDegrees(sun.altitude));
      button.dataset.ephemerisTime=String(snapshot.date.valueOf());
    } else {
      delete button.dataset.solarAltitude;
      delete button.dataset.ephemerisTime;
    }
  }

  function open(visible,focus=false) {
    panel.hidden=!visible;
    if(visible) $('[data-sky-track-controls]').append(release);
    else button.after(release);
    button.setAttribute('aria-expanded',String(visible));
    if (visible) {
      update(true);
      render();
      if(focus) $('[data-sky-surface-close]').focus({preventScroll:true});
    } else if(focus) button.focus({preventScroll:true});
  }

  function objectRow(object) {
    const row=document.createElement('div');
    row.className='surface-sky-object';
    row.dataset.skySurfaceBody=object.id;
    const details=document.createElement('div');
    details.className='surface-sky-readout';
    const title=document.createElement('strong'),distance=document.createElement('span');
    const angles=document.createElement('small'),aspect=document.createElement('small');
    distance.dataset.skyKm='';
    angles.dataset.skyAngles='';
    details.append(title,distance,angles,aspect);
    const aim=document.createElement('button');
    aim.type='button'; aim.dataset.skySurfaceLook=object.id;
    aim.onclick=()=>{
      const found=snapshot?.objects.find(body=>body.id===object.id);
      if(!aimAt(found)) return;
      stopTracking();open(false);canvas.focus({preventScroll:true});
    };
    const track=document.createElement('button');
    track.type='button';track.dataset.skySurfaceTrack=object.id;track.textContent='Suivre';
    track.setAttribute('aria-pressed','false');track.setAttribute('aria-label','Suivre '+object.name+' dans le ciel');
    track.onclick=()=>{
      if(trackedId===object.id) stopTracking();
      else startTracking(snapshot?.objects.find(body=>body.id===object.id));
    };
    const actions=document.createElement('div');
    actions.className='surface-sky-actions';actions.append(aim,track);
    row.append(details,actions);list.append(row);
    return {row,title,distance,angles,aspect,aim,track};
  }

  function render() {
    const available=!!snapshot?.objects?.length;
    const unavailable=$('[data-sky-surface-unavailable]');
    unavailable.hidden=available;
    $('[data-sky-surface-content]').hidden=!available;
    if (!available) {
      unavailable.textContent=engine || failed ? 'Les éléments orbitaux de ce monde sont indisponibles.' : 'Chargement des éphémérides…';
      return;
    }
    const {site,objects:bodies}=snapshot;
    const latitude=number.format(Math.abs(site.latitude))+'° '+(site.latitude<0?'S':'N');
    const longitude=number.format(Math.abs(site.longitude))+'° '+(site.longitude<0?'O':'E');
    const point=site.name && (siteSelect.options.length>1 || site.name.length<26) ? site.name+' · ' : '';
    $('[data-sky-surface-coordinates]').textContent=point+latitude+' · '+longitude;
    const sun=sunInView();
    const visibleSun=aboveHorizon(sun);
    setText($('[data-sky-surface-status]'),live?'Calcul en direct':rate?'Temps accéléré':'Instant choisi');
    setText($('[data-sky-surface-sun]'),sun?'Soleil '+signedDegrees.format(toDegrees(sun.altitude))+'° · '+(!visibleSun?'sous l’horizon':sun.altitude<sun.angularDiameter/2?'sur l’horizon':'au-dessus de l’horizon'):'');
    const comparison=$('[data-sky-surface-comparison]');
    const ground=landedSite ?? engine?.SURFACE_SKY_SITES[world]?.[0];
    comparison.hidden=!ground || site.id===ground.id;
    if(!comparison.hidden) setText(comparison,'Ciel vu de '+site.name+'. Ton terrain reste '+ground.name+'.');
    if (document.activeElement!==dateInput) dateInput.value=date.toISOString().slice(0,16);
    dateInput.setAttribute('aria-description',clock.format(date)+' UTC');
    $('[data-sky-surface-now]').setAttribute('aria-pressed',String(live));
    for (const body of bodies) {
      if(!objects.has(body.id))objects.set(body.id,objectRow(body));
      const {row,title,distance,angles,aspect,aim,track}=objects.get(body.id);
      const above=aboveHorizon(body);
      row.dataset.above=String(above);
      title.textContent=body.name;
      distance.textContent=kilometres.format(body.distanceKm)+' km';
      distance.dataset.skyKm=String(body.distanceKm);
      angles.textContent=compass(body.azimuth)+' · az. '+number.format((toDegrees(body.azimuth)+360)%360)+'° · hauteur '+number.format(toDegrees(body.altitude))+'°';
      aspect.textContent=angularSize(body.angularDiameter)+' de diamètre · '+age(body.distanceKm/299792.458)+' pour la lumière';
      aim.textContent=above?'Viser':'Sous l’horizon';
      aim.disabled=!above;
      track.hidden=!above;
      track.setAttribute('aria-pressed',String(trackedId===body.id));
      aim.setAttribute('aria-label',above?'Tourner vers '+body.name:body.name+' sous l’horizon');
    }
    const eclipse=$('[data-sky-surface-eclipse]'),cover=snapshot.solarOccultation;
    eclipse.hidden=!cover?.occultingName || cover.coveredFraction<.005;
    if(!eclipse.hidden) eclipse.textContent=number.format(cover.coveredFraction*100)+' % du disque solaire masqué par '+cover.occultingName+'.';
    if(snapshot.quality==='mean-elements') $('[data-sky-surface-model]').textContent=world==='titan'
      ? 'Orbite de Titan approchée et visibilité limitée par la brume. Terrain simulé.'
      : 'Orbite d’Encelade approchée. Terrain et panaches simulés.';
    else $('[data-sky-surface-model]').textContent='Éphémérides calculées au site indiqué. Relief et illumination locale simulés.';
  }

  function update(force=false) {
    if (!world || !engine) return;
    if (live) {
      const now=Date.now();
      const fromLast=Math.abs(now-date.valueOf());
      if (!force && fromLast<3000) return;
      date=new Date(now);
    } else {
      if (!force && timePassed<nextUpdate) return;
      nextUpdate=timePassed+(trackedId && rate && panel.hidden ? 1/15 : .25);
    }
    try {
      const data=engine.surfaceEphemeris(world,date,observer());
      snapshot={...data,stars:localStars(data.equatorialBasis,stars),showDayStars:starsInput.checked};
    } catch {
      snapshot=null;
    }
    if(trackedId) {
      const body=snapshot?.objects.find(item=>item.id===trackedId);
      if(!body) stopTracking('Suivi interrompu : éphémérides indisponibles.');
      else if(!aboveHorizon(body)) stopTracking('Fin du suivi. '+body.name+' est sous l’horizon.');
      else if(aimAt(body,true)) updateBearing(body);
      else stopTracking();
    }
    if (!panel.hidden) render();
    renderHud();
    onChange();
  }

  function setSites() {
    const reference=engine?.SURFACE_SKY_SITES[world] ?? [];
    const sites=landedSite ? [landedSite,...reference.filter(site=>site.id!==landedSite.id)] : reference;
    siteSelect.replaceChildren(...sites.map(site=>new Option(site.name,site.id)));
    if (siteId) siteSelect.value=siteId;
    else siteId=siteSelect.value || undefined;
    $('[data-sky-surface-site-wrap]').hidden=sites.length<2;
    $('[data-sky-surface-events]').hidden=world!=='moon';
  }

  function setWorld(id,region) {
    const place=region && Number.isFinite(region.latitude) && Number.isFinite(region.longitude) ? region : null;
    if(id===world && place?.id===landedSite?.id) {update(true);return;}
    stopTracking();
    world=id;landedSite=place;siteId=place?.id;
    snapshot=null;objects.clear();list.replaceChildren();
    rate=0;rateSelect.value='0';live=true;
    setSites();
    renderHud();
    update(true);
    if(loaded) return;
    loaded=true;
    ephemerisPromise ??= import('./surface-ephemeris.js');
    ephemerisPromise.then(module=>{
      engine=module;setSites();update(true);
      return loadStars();
    }).then(found=>{
      stars=found;update(true);
    }).catch(()=>{
      failed=true;
      if(!panel.hidden)render();
    });
  }

  function chooseSun(target) {
    const duration=histories[world] || 2;
    const step=duration*86400000/72;
    let chosen=null;
    for(let i=0;i<=73;i++) {
      const when=new Date(date.valueOf()+i*step);
      let sun;
      try {sun=engine?.surfaceEphemeris(world,when,observer()).objects.find(body=>body.id==='sun');}
      catch {break;}
      if (!sun) break;
      if ((target==='day' && sun.altitude>.46) || (target==='night' && sun.altitude<-.27)) {
        chosen=when;break;
      }
      if (i===0 || (target==='day' ? sun.altitude>chosen.altitude : sun.altitude<chosen.altitude))
        chosen={when,altitude:sun.altitude};
    }
    if(chosen) {
      date=chosen instanceof Date?chosen:chosen.when;
      jump(date);
    }
  }
  function jump(instant) {
    date=instant;live=false;rate=0;rateSelect.value='0';update(true);
  }

  button.onclick=()=>open(panel.hidden);
  release.onclick=()=>{
    const track=objects.get(trackedId)?.track;
    stopTracking();
    (panel.hidden?canvas:track)?.focus({preventScroll:true});
  };
  $('[data-sky-surface-close]').onclick=()=>open(false,true);
  $('[data-sky-surface-now]').onclick=()=>{live=true;rate=0;rateSelect.value='0';update(true);};
  rateSelect.onchange=()=>{
    const selected=Number(rateSelect.value);
    rate=acceleratedRates.has(selected)?selected:0;
    if(live) date=new Date();
    live=false;update(true);
  };
  for(const preset of wrapper.querySelectorAll('[data-sky-surface-solar]')) {
    preset.onclick=()=>chooseSun(preset.dataset.skySurfaceSolar);
  }
  for(const preset of wrapper.querySelectorAll('[data-sky-surface-event]')) {
    preset.onclick=()=>{
      const apollo=preset.dataset.skySurfaceEvent==='apollo';
      stopTracking();
      siteId=apollo?'apollo-11':'imbrium';
      siteSelect.value=siteId;
      jump(new Date(apollo?'1969-07-20T20:17:40Z':'2022-11-08T10:59:00Z'));
    };
  }
  dateInput.onchange=()=>{
    const changed=new Date(dateInput.value+'Z');
    const year=changed.getUTCFullYear();
    if (Number.isNaN(year) || year<1900 || year>2100) {
      dateInput.value=date.toISOString().slice(0,16);
      return;
    }
    jump(changed);
  };
  siteSelect.onchange=()=>{stopTracking();siteId=siteSelect.value;update(true);};
  starsInput.onchange=()=>update(true);
  wrapper.addEventListener('keydown',event=>{
    if (event.key==='Escape' && !panel.hidden) {event.preventDefault();event.stopPropagation();open(false,true);}
    if(event.target instanceof HTMLInputElement) event.stopPropagation();
  });

  return {
    setWorld,stopTracking,
    observe:()=>snapshot,
    close:()=>{stopTracking();open(false);},
    tick(dt) {
      if(live || rate) {
        timePassed+=dt;
        if(rate) {
          date=new Date(Math.min(latestDate,date.valueOf()+rate*dt*1000));
          if(date.valueOf()>=latestDate) {jump(date);return;}
        }
        update();
        renderHud();
      }
    }
  };
}
