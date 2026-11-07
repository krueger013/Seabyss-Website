(() => {
  'use strict';
  window.FelineAudio = { create() {
    let context, master, enabled = false, ambient = null, birdTimer = null, ambientLoading = false, wantsAtmosphere = false;
    const voices = new Set();
    const buffers = new Map(), pendingBuffers = new Map();
    const files = {jungle:'assets/feline/audio/jungle-ambience.mp3',birds:'assets/feline/audio/jungle-birds.mp3',lion:'assets/feline/audio/lion-growl.mp3',tiger:'assets/feline/audio/tiger-call.mp3'};
    let generation = 0, lastClaw = -10, lastButton = -10;
    async function bufferFor(name) {
      if (buffers.has(name)) return buffers.get(name);
      if (!pendingBuffers.has(name)) pendingBuffers.set(name,fetch(files[name]).then(response => {if (!response.ok) throw new Error('Audio unavailable');return response.arrayBuffer();}).then(bytes => context.decodeAudioData(bytes)).then(buffer => {buffers.set(name,buffer);pendingBuffers.delete(name);return buffer;}).catch(() => {pendingBuffers.delete(name);return null;}));
      return pendingBuffers.get(name);
    }
    async function sample(name, volume = .15, rate = 1, loop = false) {
      if (!enabled || !context || document.hidden || voices.size >= 18) return null;
      const ticket = generation, buffer = await bufferFor(name);
      if (!buffer || !enabled || ticket !== generation || document.hidden || voices.size >= 18) return null;
      const source = context.createBufferSource(), gain = context.createGain(), filter = context.createBiquadFilter(), now = context.currentTime;
      source.buffer = buffer;source.playbackRate.value = rate;source.loop = loop;filter.type = 'lowpass';filter.frequency.value = loop ? 6500 : 4500;
      const duration = buffer.duration / rate;
      gain.gain.setValueAtTime(0, now);gain.gain.linearRampToValueAtTime(volume, now + (loop ? 1.8 : .07));
      if (!loop) {gain.gain.setValueAtTime(volume, now + Math.max(.08, duration - .18));gain.gain.linearRampToValueAtTime(0, now + duration);}
      source.connect(filter);filter.connect(gain);gain.connect(master);voices.add(source);
      source.onended = () => {voices.delete(source);source.disconnect();filter.disconnect();gain.disconnect();if (ambient === source) ambient = null;};source.start();if (!loop) source.stop(now + duration + .02);return source;
    }
    function scheduleBirds() {
      clearTimeout(birdTimer);birdTimer = null;
      if (!enabled || document.hidden) return;
      birdTimer = setTimeout(() => {birdTimer = null;if (enabled && !document.hidden) {sample('birds',.07,.95 + Math.random()*.1);scheduleBirds();}},22000 + Math.random()*12000);
    }
    async function atmosphere() {
      if (!enabled || !wantsAtmosphere || !context || document.hidden || context.state !== 'running' || ambient || ambientLoading) return;
      const ticket = generation;
      ambientLoading = true;try {ambient = await sample('jungle',.11,1,true);} finally {ambientLoading = false;}
      if (ambient) scheduleBirds();
      else if (ticket !== generation && enabled && wantsAtmosphere && !document.hidden) atmosphere();
    }
    function tone(from, to, duration, delay = 0, volume = .04, type = 'sine') {
      if (!enabled || !context || voices.size >= 18) return;
      const start = context.currentTime + delay, source = context.createOscillator(), gain = context.createGain();
      source.type = type;source.frequency.setValueAtTime(from, start);source.frequency.exponentialRampToValueAtTime(Math.max(25, to), start + duration);
      gain.gain.setValueAtTime(0, start);gain.gain.linearRampToValueAtTime(volume, start + .025);gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      source.connect(gain);gain.connect(master);voices.add(source);
      source.onended = () => { voices.delete(source);source.disconnect();gain.disconnect(); };source.start(start);source.stop(start + duration + .03);
    }
    function rustle(duration = .55, frequency = 700, volume = .12) {
      if (!enabled || !context || voices.size >= 18) return;
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate), samples = buffer.getChannelData(0);
      let smooth = 0;for (let i = 0; i < samples.length; i++) {smooth = (smooth + Math.random() * .18 - .09) / 1.04;samples[i] = smooth;}
      const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain(), now = context.currentTime;
      source.buffer = buffer;filter.type = 'bandpass';filter.frequency.setValueAtTime(frequency, now);filter.frequency.exponentialRampToValueAtTime(180, now + duration);filter.Q.value = .65;
      gain.gain.setValueAtTime(0, now);gain.gain.linearRampToValueAtTime(volume, now + .06);gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      source.connect(filter);filter.connect(gain);gain.connect(master);voices.add(source);
      source.onended = () => {voices.delete(source);source.disconnect();filter.disconnect();gain.disconnect();};source.start();source.stop(now + duration);
    }
    function stop() {generation++;wantsAtmosphere=false;clearTimeout(birdTimer);birdTimer = null;ambient = null;for (const voice of voices) {try {voice.stop();} catch (_) {}}voices.clear();}
    function setEnabled(value) {
      enabled = !!value;if (!enabled) {stop();return;}
      wantsAtmosphere = true;
      try {if (!context) {context = new (window.AudioContext || window.webkitAudioContext)();master = context.createGain();master.gain.value = .58;const compressor=context.createDynamicsCompressor();compressor.threshold.value=-18;compressor.knee.value=18;compressor.ratio.value=4;compressor.attack.value=.01;compressor.release.value=.2;master.connect(compressor);compressor.connect(context.destination);}context.resume().then(atmosphere).catch(() => {});} catch (_) {enabled = false;}
    }
    function play(name, index = 0) {
      if (!enabled || document.hidden) return;wantsAtmosphere = true;if (context?.state === 'suspended') context.resume().then(atmosphere).catch(() => {});else atmosphere();
      if (name === 'spin') {rustle(.28, 500, .075);tone(160, 230, .25, 0, .025, 'triangle');}
      if (name === 'stop') {tone(285 + index * 24, 235 + index * 22, .22, 0, .03);tone(570 + index * 48, 470 + index * 44, .13, .015, .008);}
      if (name === 'claw') {
        rustle(.7, 1200, .35);tone(100 - index * 5, 43 + index * 3, .75, 0, .06, 'triangle');
        if (context.currentTime - lastClaw > .45) {lastClaw = context.currentTime;const feline = [{name:'lion',rate:.9,volume:.21},{name:'tiger',rate:.93,volume:.19},{name:'lion',rate:1.3,volume:.15},{name:'tiger',rate:.72,volume:.18},{name:'tiger',rate:1.45,volume:.15}][Math.max(0,Math.min(4,index))];sample(feline.name,feline.volume,feline.rate);}
        if (index===4) {tone(750,440,.2,.1,.02);tone(680,410,.2,.35,.018);}
      }
      if (name === 'wheel') {[294, 349, 440, 587, 698, 880].forEach((f, i) => tone(f, f * .995, .5, i * .16, .035, 'triangle'));rustle(1.2, 450, .1);}
      if (name === 'win') {[392, 494, 587].forEach((f, i) => tone(f, f, .5, i * .1, .045));if (index >= 5) [784, 988].forEach((f, i) => tone(f, f, .65, .32 + i * .12, .03));}
      if (name === 'prize' || name === 'bonus') [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, f, .8, i * .12, .045, 'triangle'));
      if (name === 'prize') {rustle(.65,1800,.16);if (index >= 100) {[131,196,262,330].forEach((f,i)=>tone(f,f,1.2,.5+i*.14,.045,'triangle'));sample('lion',.13,.85);}}
      if (name === 'hold') {tone(294+index*12,294+index*12,.4,0,.023);tone(588+index*24,588+index*24,.4,.06,.012);}
      if (name === 'release') {rustle(.35,600,.13);tone(310,210,.32,0,.022);}
      if (name === 'scatter') {[523,659,784].slice(0,Math.min(3,index)).forEach((f,i)=>tone(f,f,.5,.1*i,.035,'triangle'));}
      if (name === 'free-start') {[392,494,587,784].forEach((f,i)=>tone(f,f,.7,.13*i,.035));sample('birds',.11,1.05);}
      if (name === 'free-end') {[784,659,523,392].forEach((f,i)=>tone(f,f,.8,.12*i,.035,'triangle'));}
      if (name === 'button' && context.currentTime-lastButton>.08) {lastButton=context.currentTime;tone(370,310,.13,0,.014);}
      if (name === 'bet') {tone(460,540,.18,0,.022);tone(690,810,.15,.04,.012);}
      if (name === 'auto') {tone(330,440,.25,0,.022);tone(494,587,.2,.1,.017);}
    }
    document.addEventListener('visibilitychange',() => {if (document.hidden) stop();else if (enabled) {wantsAtmosphere = true;atmosphere();}});
    document.addEventListener('click',event => {const button=event.target.closest?.('button');if (!button || button.disabled || ['spin-button','spin-wheel','sound-button','enter-bonus','finish-bonus'].includes(button.id)) return;play(button.id.startsWith('bet-') || button.dataset.bet ? 'bet' : ['auto-button','start-auto','stop-auto'].includes(button.id) ? 'auto' : 'button');});
    return Object.freeze({setEnabled, play, stop});
  }};
})();
