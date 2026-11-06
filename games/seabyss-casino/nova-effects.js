// Presentation only. Awards and wallet settlement remain in the game engine/app.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const money = cents => (cents / 100).toLocaleString('fr-CA', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' $';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const transient = new Set();
  let generation = 0;
  function reset() {
    generation++;
    for (const element of transient) element.remove();
    transient.clear();
    $('orbit-feedback').hidden = true;
    $('reels').classList.remove('has-result','has-focus');
    document.querySelectorAll('.group-active,.jackpot-awarded,.collecting').forEach(element => element.classList.remove('group-active','jackpot-awarded','collecting'));
  }
  function focus(positions) {
    document.querySelectorAll('.group-active').forEach(element => element.classList.remove('group-active'));
    $('reels').classList.toggle('has-focus', positions.length > 0);
    for (const { reel,row } of positions) $('reels').children[reel]?.children[row]?.classList.add('group-active');
  }
  async function count(element, amount, duration) {
    const token = generation;
    if (reduced() || !duration) { element.textContent = money(amount); return; }
    const start = performance.now();
    await new Promise(resolve => {
      function frame(now) {
        if (token !== generation) return resolve();
        const fraction = Math.min(1,(now-start)/duration);
        element.textContent = money(Math.round(amount*(1-Math.pow(1-fraction,3))));
        if (fraction < 1) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
  }
  async function win(wins, amount, bet, fast) {
    if (!wins.length) return;
    const token = generation, ratio = amount / bet;
    $('reels').classList.add('has-result');
    focus(wins.flatMap(item => item.positions));
    $('feedback-label').textContent = ratio >= 20 ? 'GAIN STELLAIRE' : ratio >= 5 ? 'BELLE DÉCOUVERTE' : wins.length > 1 ? 'GROUPES GAGNANTS' : 'GROUPE GAGNANT';
    $('feedback-note').textContent = `${wins.reduce((sum,item) => sum+item.count,0)} symboles connectés · ${wins.length} groupe${wins.length>1?'s':''}`;
    $('orbit-feedback').dataset.kind = ratio >= 5 ? 'large' : 'win';
    $('orbit-feedback').hidden = false;
    await count($('feedback-amount'),amount,fast ? 230 : 430);
    await wait(reduced() ? 0 : fast ? 180 : 450);
    if (token === generation) { $('orbit-feedback').hidden=true; focus([]); }
  }
  async function collect(orbs, fast) {
    if (!orbs.length) return;
    const token = generation;
    const bank = $('board-meter');
    bank.classList.add('collecting');
    for (const orb of orbs) if (orb.kind !== 'cash') document.querySelector(`.jackpot.${orb.kind}`)?.classList.add('jackpot-awarded');
    if (reduced()) { bank.classList.remove('collecting'); return; }
    const target = bank.getBoundingClientRect();
    const flights = orbs.slice(0,12).map(async (orb,index) => {
      const source = $('reels').children[orb.reel]?.children[orb.row];
      if (!source) return;
      const rect = source.getBoundingClientRect();
      const image = document.createElement('img'); image.src='assets/nova/orb.png'; image.alt=''; image.className='orb-flight'; image.setAttribute('aria-hidden','true');
      image.style.left=`${rect.left+rect.width/2-16}px`; image.style.top=`${rect.top+rect.height/2-16}px`;
      document.body.append(image); transient.add(image);
      const dx=target.left+target.width/2-(rect.left+rect.width/2), dy=target.top+target.height/2-(rect.top+rect.height/2);
      const motion = image.animate?.([
        {transform:'translate(0,0) scale(.7)',opacity:0},
        {transform:'translate(0,-8px) scale(1.1)',opacity:1,offset:.16},
        {transform:`translate(${dx*.5}px,${dy*.5-45}px) scale(.9)`,opacity:1,offset:.6},
        {transform:`translate(${dx}px,${dy}px) scale(.25)`,opacity:0}
      ],{duration:fast?350:520,delay:index*(fast?12:25),easing:'cubic-bezier(.22,.6,.33,1)',fill:'both'});
      if (motion) await motion.finished.catch(()=>{});
      image.remove(); transient.delete(image);
    });
    await Promise.all(flights);
    if (token === generation) bank.classList.remove('collecting');
  }
  function bumpRespins(previous, current, gained) {
    const meter=$('respin-pips');
    meter.classList.remove('recharged','last-chance');
    if (gained && current===3) { void meter.offsetWidth; meter.classList.add('recharged'); }
    else if (current===1) meter.classList.add('last-chance');
  }
  globalThis.NovaEffects = Object.freeze({reset,focus,win,collect,count,bumpRespins});
})();
