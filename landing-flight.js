import { createSurfaceTerrain, terrainHeight } from './surface-terrain.js';
import { createDescent, LANDING_LIMITS, LANDING_SITES } from './landing-dynamics.js';

export { LANDING_SITES } from './landing-dynamics.js';

const icons={
  left:'<path d="m14.5 6-6 6 6 6"/>',right:'<path d="m9.5 6 6 6-6 6"/>',
  up:'<path d="m6 14.5 6-6 6 6"/>',down:'<path d="m6 9.5 6 6 6-6"/>',
  thrust:'<path d="M10 19h4m-6-5h8m-9-5 5-5 5 5m-5-5v6"/>',
  plane:'<path d="M4 12h16m-8-8v16"/><circle cx="12" cy="12" r="5"/>',
  pause:'<path d="M9 5v14m6-14v14"/>',
  resume:'<path d="m9 5 11 7-11 7Z"/>',
  retry:'<path d="M20 11a8 8 0 1 1-2.3-5.7L20 8m0-5v5h-5"/>'
};
const icon=name=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icons[name]+'</svg>';
const format = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:1});
const radiansBetween=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
const phaseTitles={ready:'Poser le module',landed:'Module posé',crashed:'Atterrissage manqué'};
const keys = {
  arrowup:'forward',w:'forward',z:'forward',arrowdown:'back',s:'back',
  arrowleft:'left',a:'left',q:'left',arrowright:'right',d:'right',' ':'thrust'
};

function writeText(element,text) {
  if (element.textContent!==text) element.textContent=text;
}

export function createLandingFlight(root,{onExit,onLanded,announce=()=>{},reducedMotion=()=>false}={}) {
  root.innerHTML=`
    <header class="landing-head">
      <div class="landing-title"><p>Approche finale</p><h1 data-landing-title></h1></div>
      <div class="landing-head-tools">
        <button data-landing-pause type="button" aria-label="Mettre en pause" title="Mettre en pause">${icon('pause')}</button>
        <button data-landing-exit type="button">Orbite</button>
      </div>
    </header>
    <div class="landing-scene">
      <canvas data-landing-canvas tabindex="0" aria-label="Vue du site d’atterrissage"></canvas>
      <svg class="landing-overlay" aria-hidden="true" preserveAspectRatio="none">
        <path class="landing-pad-outline" data-landing-pad></path>
        <path class="landing-pad-cross" data-landing-cross></path>
      </svg>
      <div class="landing-horizon" aria-hidden="true"><span></span><b></b><span></span></div>
      <dl class="landing-instruments">
        <div><dt>Altitude</dt><dd data-landing-altitude>–</dd></div>
        <div><dt>Descente</dt><dd data-landing-vspeed>–</dd></div>
        <div><dt>Dérive</dt><dd data-landing-hspeed>–</dd></div>
        <div><dt>Cible</dt><dd data-landing-range>–</dd></div>
      </dl>
      <div class="landing-status" data-landing-status data-phase="ready" aria-live="polite">
        <p data-landing-site></p>
        <h2 data-landing-heading></h2>
        <p data-landing-detail></p>
        <div class="landing-status-actions">
          <button data-landing-start class="landing-primary" type="button">Commencer</button>
          <button data-landing-reset type="button">${icon('retry')} Recommencer</button>
          <button data-landing-continue class="landing-primary" type="button">Explorer à pied</button>
        </div>
      </div>
    </div>
    <footer class="landing-controls">
      <div class="landing-fuel"><div><span>Carburant</span><output data-landing-fuel-value>100 %</output></div>
        <meter value="1" min="0" max="1" low=".13" optimum="1" aria-label="Carburant"></meter></div>
      <div class="landing-manual" aria-label="Commandes du module">
        <div class="landing-direction" aria-label="Déplacement latéral">
          <button type="button" data-landing-dir="left" aria-label="Aller à gauche">${icon('left')}</button>
          <button type="button" data-landing-dir="forward" aria-label="Aller vers l’avant">${icon('up')}</button>
          <button type="button" data-landing-dir="back" aria-label="Aller vers l’arrière">${icon('down')}</button>
          <button type="button" data-landing-dir="right" aria-label="Aller à droite">${icon('right')}</button>
        </div>
        <button type="button" data-landing-dir="thrust" data-landing-thrust>${icon('thrust')} <span>Poussée</span></button>
      </div>
      <button data-landing-mode aria-pressed="false" type="button" title="Activer le pilotage assisté">${icon('plane')} <span>Assistance</span></button>
      <button data-landing-flight-reset type="button" aria-label="Recommencer la descente" title="Recommencer la descente">${icon('retry')}</button>
    </footer>`;

  const $=selector=>root.querySelector(selector);
  const canvas=$('[data-landing-canvas]');
  const overlay=$('.landing-overlay');
  const status=$('[data-landing-status]');
  const mode=$('[data-landing-mode]');
  const pauseButton=$('[data-landing-pause]');
  const flightReset=$('[data-landing-flight-reset]');
  const manual=[...root.querySelectorAll('[data-landing-dir]')];
  const pressed=new Map();
  const renderer=createSurfaceTerrain(canvas);
  const reduced=()=>typeof reducedMotion==='function' ? reducedMotion() : !!reducedMotion;
  let worldId, flight, paused=false, assisted=false, assistanceUsed=false, heading=0, pitch=-.7, drawClock=0;

  function clearControls() {
    pressed.clear();
    for (const button of manual) button.classList.remove('is-pressed');
  }

  function isOpen() {return !root.hidden && Boolean(flight);}

  function setStatus() {
    const {state,site}=flight;
    const phase=state.phase;
    const number=n=>format.format(Math.abs(n));
    function showReading(selector,value,data) {
      const target=$(selector);
      target.dataset.value=String(data);
      writeText(target,value);
    }
    const sinking=state.vy<=.05;
    const drift=Math.hypot(state.vx,state.vz);
    showReading('[data-landing-altitude]',number(state.altitude)+' m',state.altitude);
    showReading('[data-landing-vspeed]',(sinking?'↓ ':'↑ ')+number(state.vy)+' m/s',state.vy);
    showReading('[data-landing-hspeed]',number(drift)+' m/s',drift);
    showReading('[data-landing-range]',number(state.range)+' m',state.range);
    const fuel=state.fuel/flight.fuelCapacity;
    const meter=$('meter');
    if (meter.value!==fuel) meter.value=fuel;
    writeText($('[data-landing-fuel-value]'),Math.round(fuel*100)+' %');
    mode.setAttribute('aria-pressed',String(assisted));
    root.dataset.engine=state.throttle>.13?'active':'idle';
    root.dataset.near=state.altitude<=18?'true':'false';
    status.dataset.phase=phase;
    status.dataset.paused=String(paused);
    status.classList.toggle('in-flight',phase==='flying'&&!paused);
    pauseButton.hidden=phase!=='flying';
    const pauseLabel=paused?'Reprendre la descente':'Mettre en pause';
    if(pauseButton.getAttribute('aria-label')!==pauseLabel) {
      pauseButton.innerHTML=icon(paused?'resume':'pause');
      pauseButton.setAttribute('aria-label',pauseLabel);
      pauseButton.title=pauseLabel;
    }
    $('[data-landing-start]').hidden=phase!=='ready'&&!paused;
    writeText($('[data-landing-start]'),paused?'Reprendre':'Commencer');
    $('[data-landing-reset]').hidden=phase!=='crashed'&&phase!=='landed';
    flightReset.hidden=phase!=='flying';
    $('[data-landing-continue]').hidden=phase!=='landed';
    mode.disabled=phase==='landed'||phase==='crashed';
    for (const button of manual) button.disabled=phase!=='flying'||paused||assisted;
    const title=paused?'Descente en pause':phaseTitles[phase] || '';
    writeText($('[data-landing-site]'),site.location);
    writeText($('[data-landing-heading]'),title);
    const text=phase==='ready' ? (assisted ? 'Le pilote automatique ramène le module dans la zone.':'Pousse pour freiner. Corrige la dérive et vise le cercle au sol.')
      : phase==='landed' ? (assistanceUsed?'Approche assistée terminée. ':'Approche manuelle terminée. ')+'Vitesse au contact '+number(state.vy)+' m/s.'
      : phase==='crashed' ? state.reason+'.' : '';
    writeText($('[data-landing-detail]'),text);
  }

  function draw(dt) {
    const {state,target}=flight;
    const xDiff=target.x-state.x, zDiff=target.z-state.z;
    if (state.range>7) {
      const bearing=Math.atan2(xDiff,zDiff);
      heading+=radiansBetween(bearing,heading)*(reduced()?1:1-Math.exp(-dt*3.2));
    }
    const aim=-Math.atan2(state.y-target.y,Math.max(14,state.range));
    pitch+=(Math.max(-1.2,Math.min(-.10,aim))-pitch)*(reduced()?1:1-Math.exp(-dt*3.5));
    renderer.draw(worldId,{x:state.x,z:state.z,heading,pitch,eyeHeight:state.altitude+2.5,time:state.elapsed,sky:null});
    const width=canvas.clientWidth, height=canvas.clientHeight;
    if (width<4 || height<4) return;
    const viewBox='0 0 '+width+' '+height;
    if (overlay.getAttribute('viewBox')!==viewBox) overlay.setAttribute('viewBox',viewBox);
    const ring=Array.from({length:29},(_,i)=>{
      const angle=i*Math.PI/14;
      return renderer.project({x:target.x+Math.cos(angle)*LANDING_LIMITS.radius,z:target.z+Math.sin(angle)*LANDING_LIMITS.radius});
    });
    const path=ring.map((point,i)=>point.visible ? (i>0 && ring[i-1].visible?'L':'M')+point.x.toFixed(1)+','+point.y.toFixed(1) : '').join(' ');
    $('[data-landing-pad]').setAttribute('d',path);
    const center=renderer.project({x:target.x,z:target.z});
    $('[data-landing-cross]').setAttribute('d',center.visible?'M'+(center.x-6)+','+center.y+'h12 M'+center.x+','+(center.y-6)+'v12':'');
    root.style.setProperty('--landing-lean',Math.max(-22,Math.min(22,state.vx*2.5))+'px');
  }

  function reset() {
    clearControls();
    paused=false;
    assistanceUsed=false;
    flight.reset();
    const initial=flight.state;
    heading=Math.atan2(-initial.x,-initial.z);
    pitch=-Math.atan2(initial.y-flight.target.y,initial.range);
    drawClock=0;
    setStatus();
    draw(0);
  }

  function start() {
    if(flight.state.phase==='ready') flight.launch();
    paused=false;
    setStatus();
    canvas.focus({preventScroll:true});
  }

  function togglePause() {
    paused=!paused;
    clearControls();
    setStatus();
    if(paused) $('[data-landing-start]').focus({preventScroll:true});
    else canvas.focus({preventScroll:true});
  }

  function close() {
    clearControls();
    root.hidden=true;
  }

  $('[data-landing-start]').onclick=start;
  $('[data-landing-exit]').onclick=()=>onExit?.(worldId);
  $('[data-landing-reset]').onclick=flightReset.onclick=reset;
  pauseButton.onclick=togglePause;
  mode.onclick=()=>{
    assisted=!assisted;
    clearControls();
    setStatus();
  };
  $('[data-landing-continue]').onclick=()=>{
    const {state}=flight;
    if(state.phase==='landed') onLanded?.(worldId,{x:state.x,z:state.z,heading,pitch:-.035});
  };

  for (const button of manual) {
    const action=button.dataset.landingDir;
    button.addEventListener('pointerdown',event=>{
      if(button.disabled || event.button!==0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      pressed.set(event.pointerId,action);
      button.classList.add('is-pressed');
    });
    function release(event) {
      pressed.delete(event.pointerId);
      button.classList.toggle('is-pressed',[...pressed.values()].includes(action));
    }
    for (const event of ['pointerup','pointercancel','lostpointercapture']) button.addEventListener(event,release);
  }

  window.addEventListener('blur',clearControls);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearControls();});
  root.addEventListener('keydown',event=>{
    if (!isOpen() || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key==='Escape') {event.preventDefault();return onExit?.(worldId);}
    if (event.key.toLowerCase()==='p' && flight.state.phase==='flying' && !event.repeat) {
      event.preventDefault();togglePause();return;
    }
    if (paused || assisted || flight.state.phase!=='flying' || (event.key===' ' && event.target.closest('button'))) return;
    const action=keys[event.key.toLowerCase()];
    if (action) {
      event.preventDefault();
      pressed.set(event.code || event.key,action);
      manual.find(button=>button.dataset.landingDir===action)?.classList.add('is-pressed');
    }
  });
  window.addEventListener('keyup',event=>{
    const action=pressed.get(event.code || event.key);
    if (!action) return;
    pressed.delete(event.code || event.key);
    manual.find(button=>button.dataset.landingDir===action)?.classList.toggle('is-pressed',[...pressed.values()].includes(action));
  });

  return {
    isOpen,close,
    open(id) {
      if (!Object.hasOwn(LANDING_SITES,id)) return false;
      worldId=id;
      flight=createDescent(id,terrainHeight);
      root.hidden=false;
      root.style.setProperty('--landing-accent',flight.site.accent);
      writeText($('[data-landing-title]'),flight.site.name);
      reset();
      $('[data-landing-start]').focus({preventScroll:true});
      return true;
    },
    tick(dt) {
      if (!isOpen()) return;
      const before=flight.state.phase;
      if (!paused && before==='flying') {
        const active=new Set(pressed.values());
        const right=Number(active.has('right'))-Number(active.has('left'));
        const forward=Number(active.has('forward'))-Number(active.has('back'));
        const sin=Math.sin(heading), cos=Math.cos(heading);
        assistanceUsed ||= assisted;
        flight.step(dt,{assisted,thrust:Number(active.has('thrust')),x:right*cos+forward*sin,z:forward*cos-right*sin});
        if (flight.state.phase!==before) {
          clearControls();
          announce(flight.state.phase==='landed'?'Module posé':'Atterrissage manqué');
        }
      }
      drawClock+=dt;
      if (drawClock<1/32 && before===flight.state.phase) return;
      draw(drawClock);
      setStatus();
      if (flight.state.phase!==before) {
        $(flight.state.phase==='landed'?'[data-landing-continue]':'[data-landing-reset]').focus({preventScroll:true});
      }
      drawClock=0;
    }
  };
}
