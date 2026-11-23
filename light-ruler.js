const LIGHT_SPEED_KM_S = 299792.458;
const JULIAN_YEAR = 365.25 * 86400;
const number = new Intl.NumberFormat('fr-CA',{maximumFractionDigits:2});

export function signalPath(origin,target,roundTrip=false) {
  const distanceKm=Math.hypot(...origin.map((coordinate,i)=>coordinate-target[i]));
  return {distanceKm,seconds:distanceKm/LIGHT_SPEED_KM_S*(roundTrip?2:1)};
}

export function signalDuration(seconds) {
  if (seconds>=JULIAN_YEAR) return number.format(seconds/JULIAN_YEAR)+' '+(seconds/JULIAN_YEAR>=2?'ans':'an');
  if (seconds>=86400) return number.format(seconds/86400)+' j';
  if (seconds>=3600) return number.format(seconds/3600)+' h';
  if (seconds>=60) {
    const whole=Math.round(seconds);
    return Math.floor(whole/60)+' min '+String(whole%60).padStart(2,'0')+' s';
  }
  return number.format(seconds)+' s';
}

export function createLightRuler(host,{objects,target,measure}) {
  const sources=objects.filter(body=>!body.simulated && body.id!==target.id)
    .sort((a,b)=>a.name.localeCompare(b.name,'fr'));
  host.innerHTML=`<section class="light-ruler">
    <div class="light-fields">
      <label>Point de départ<select data-light-origin></select></label>
      <label>Trajet du signal<select data-light-mode><option value="one-way">Aller simple</option><option value="round-trip">Aller-retour</option></select></label>
    </div>
    <dl class="light-readings"><div><dt>Distance entre les centres</dt><dd data-light-distance></dd></div>
      <div><dt>Temps de lumière</dt><dd data-light-duration></dd></div></dl>
    <div class="light-track" aria-hidden="true"><div class="light-beam"></div><i class="light-emitter"></i><i class="light-receiver"></i><span class="light-pulse"></span></div>
    <div class="light-endpoints" aria-hidden="true"><span data-light-from></span><span data-light-to></span></div>
    <div class="light-playback"><button type="button" data-light-play>Lecture condensée</button>
      <label>Temps écoulé <output data-light-elapsed></output><input data-light-slider type="range" min="0" max="1000" value="0" step="1" aria-label="Position du signal dans le temps"></label>
    </div>
    <p class="light-note">Calcul dans le vide à 299 792,458 km/s, entre les centres figés à leurs positions dans la simulation.</p>
  </section>`;
  const get=selector=>host.querySelector(selector);
  const origin=get('[data-light-origin]'),mode=get('[data-light-mode]'),slider=get('[data-light-slider]');
  const play=get('[data-light-play]'),elapsed=get('[data-light-elapsed]'),duration=get('[data-light-duration]');
  const track=get('.light-track'),distance=get('[data-light-distance]');
  const details=host.closest('details');
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  for (const body of sources) origin.add(new Option(body.name,body.id));
  origin.value=target.id==='earth'?'moon':'earth';
  get('[data-light-to]').textContent=target.name;
  track.style.setProperty('--destination',target.color);
  let seconds=0,roundTrip=false,frame=0;

  function setProgress(fraction) {
    slider.value=String(Math.round(fraction*1000));
    const position=roundTrip?1-Math.abs(2*fraction-1):fraction;
    track.style.setProperty('--progress',position*100+'%');
    const time=signalDuration(fraction*seconds);
    elapsed.textContent=time;
    slider.setAttribute('aria-valuetext',time+' sur '+signalDuration(seconds));
  }
  function stop() {
    cancelAnimationFrame(frame);frame=0;
    play.textContent=Number(slider.value)===1000?'Rejouer':Number(slider.value)>0?'Reprendre':'Lecture condensée';
    play.setAttribute('aria-pressed','false');
  }
  function select() {
    const body=sources.find(item=>item.id===origin.value);
    roundTrip=mode.value==='round-trip';
    const path=signalPath(body.position,target.position,roundTrip);
    seconds=path.seconds;
    duration.textContent=signalDuration(seconds);
    duration.dataset.seconds=String(seconds);
    distance.textContent=measure(path.distanceKm);
    get('[data-light-from]').textContent=body.name;
    track.style.setProperty('--origin',body.color);
    setProgress(0);stop();
  }
  play.onclick=()=>{
    if (frame) {stop();return;}
    if (Number(slider.value)===1000) setProgress(0);
    if (motion.matches) {setProgress(1);stop();return;}
    const length=roundTrip?4800:2400;
    const start=performance.now()-Number(slider.value)/1000*length;
    play.textContent='Pause';play.setAttribute('aria-pressed','true');
    function advance(now) {
      const fraction=Math.min(1,Math.max(0,(now-start)/length));
      setProgress(fraction);
      if (fraction===1) stop();
      else frame=requestAnimationFrame(advance);
    }
    frame=requestAnimationFrame(advance);
  };
  slider.oninput=()=>{setProgress(Number(slider.value)/1000);stop();};
  origin.onchange=mode.onchange=select;
  const stopIfHidden=()=>{if (document.hidden || !details?.open) stop();};
  const stopIfReduced=()=>{if (motion.matches) stop();};
  details?.addEventListener('toggle',stopIfHidden);
  document.addEventListener('visibilitychange',stopIfHidden);
  motion.addEventListener('change',stopIfReduced);
  select();
  return ()=>{
    stop();
    details?.removeEventListener('toggle',stopIfHidden);
    document.removeEventListener('visibilitychange',stopIfHidden);
    motion.removeEventListener('change',stopIfReduced);
  };
}
