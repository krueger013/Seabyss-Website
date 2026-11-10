(() => {
  'use strict';
  window.AlchemyAudio = {create() {
    let context, master, enabled = false, wantsAtmosphere = false, generation = 0, ambient = null, loadingAmbient = false, ambientTimer = null, lastButton = -10;
    const voices = new Set(), buffers = new Map(), pending = new Map();
    const files = {bubbles:'assets/alchemy/audio/bubbles.mp3',pour:'assets/alchemy/audio/pour.mp3',glass:'assets/alchemy/audio/glass.mp3'};
    function available() { return enabled && context && !document.hidden && voices.size < 18; }
    function track(source, nodes) {
      voices.add(source);
      source.onended = () => {voices.delete(source);for (const node of [source,...nodes]) node.disconnect();if (ambient === source) {ambient=null;if(enabled&&wantsAtmosphere&&!document.hidden)ambientTimer=setTimeout(()=>{ambientTimer=null;atmosphere();},1200);}};
    }
    async function bufferFor(name) {
      if (buffers.has(name)) return buffers.get(name);
      if (!pending.has(name)) pending.set(name,fetch(files[name]).then(r=>{if(!r.ok)throw new Error('Audio unavailable');return r.arrayBuffer();}).then(b=>context.decodeAudioData(b)).then(b=>{buffers.set(name,b);pending.delete(name);return b;}).catch(()=>{pending.delete(name);return null;}));
      return pending.get(name);
    }
    async function sample(name,volume=.1,rate=1,loop=false) {
      if (!available()) return null;
      const ticket=generation, buffer=await bufferFor(name);
      if (!buffer || ticket!==generation || !available()) return null;
      const source=context.createBufferSource(),gain=context.createGain(),filter=context.createBiquadFilter(),now=context.currentTime,duration=buffer.duration/rate;
      source.buffer=buffer;source.playbackRate.value=rate;source.loop=false;
      filter.type='lowpass';filter.frequency.value=loop?1800:3500;filter.Q.value=.6;
      gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(volume,now+(loop?1.5:Math.min(.035,duration*.2)));
      gain.gain.setValueAtTime(volume,now+Math.max(loop?1.6:.04,duration-(loop?2:.1)));gain.gain.linearRampToValueAtTime(0,now+duration);
      source.connect(filter);filter.connect(gain);gain.connect(master);track(source,[filter,gain]);source.start();source.stop(now+duration+.01);return source;
    }
    async function atmosphere() {
      if (!enabled || !wantsAtmosphere || !context || document.hidden || context.state!=='running' || ambient || loadingAmbient || ambientTimer) return;
      const ticket=generation;loadingAmbient=true;
      try {ambient=await sample('bubbles',.055,.82,true);} finally {loadingAmbient=false;}
      if (!ambient && ticket!==generation && enabled && wantsAtmosphere && !document.hidden) atmosphere();
    }
    function tone(from,to,duration,delay=0,volume=.035,type='sine') {
      if (!available()) return;
      const source=context.createOscillator(),gain=context.createGain(),start=context.currentTime+delay;
      source.type=type;source.frequency.setValueAtTime(from,start);source.frequency.exponentialRampToValueAtTime(Math.max(30,to),start+duration);
      gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(volume,start+.025);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
      source.connect(gain);gain.connect(master);track(source,[gain]);source.start(start);source.stop(start+duration+.03);
    }
    function shimmer(duration=.55,frequency=850,volume=.1) {
      if (!available()) return;
      const buffer=context.createBuffer(1,Math.ceil(context.sampleRate*duration),context.sampleRate),data=buffer.getChannelData(0);let smooth=0;
      for(let i=0;i<data.length;i++){smooth=(smooth+Math.random()*.18-.09)/1.04;data[i]=smooth;}
      const source=context.createBufferSource(),filter=context.createBiquadFilter(),gain=context.createGain(),now=context.currentTime;
      source.buffer=buffer;filter.type='bandpass';filter.Q.value=.8;filter.frequency.setValueAtTime(frequency,now);filter.frequency.exponentialRampToValueAtTime(250,now+duration);
      gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(volume,now+.07);gain.gain.exponentialRampToValueAtTime(.0001,now+duration);
      source.connect(filter);filter.connect(gain);gain.connect(master);track(source,[filter,gain]);source.start();source.stop(now+duration);
    }
    function stop() {generation++;wantsAtmosphere=false;clearTimeout(ambientTimer);ambientTimer=null;ambient=null;for(const source of voices){try{source.stop();}catch(_){}}voices.clear();}
    function setEnabled(value) {
      enabled=!!value;if(!enabled){stop();return;}wantsAtmosphere=true;
      try {
        if(!context){context=new(window.AudioContext||window.webkitAudioContext)();master=context.createGain();master.gain.value=.58;const compressor=context.createDynamicsCompressor();compressor.threshold.value=-18;compressor.knee.value=18;compressor.ratio.value=4;compressor.attack.value=.01;compressor.release.value=.2;master.connect(compressor);compressor.connect(context.destination);}
        context.resume().then(atmosphere).catch(()=>{});
      }catch(_){enabled=false;}
    }
    function play(name,value=0) {
      if(!enabled||document.hidden)return;wantsAtmosphere=true;
      if(context?.state==='suspended')context.resume().then(atmosphere).catch(()=>{});else atmosphere();
      const level=Math.max(0,Math.min(6,Number(value)||0));
      if(name==='spin'){shimmer(.65,900,.1);[196,294,392].forEach((f,i)=>tone(f,f*1.12,.45,i*.08,.022,'triangle'));}
      if(name==='stop'){tone(210+level*14,160+level*12,.17,0,.016);tone(430+level*24,390+level*20,.15,.025,.009);}
      if(name==='react'){const base=294*Math.pow(1.12246,level);[1,1.25,1.5].forEach((n,i)=>tone(base*n,base*n,.55,i*.075,.035,'triangle'));}
      if(name==='cascade'){shimmer(.5,1100+level*160,.09);[740,622,494].forEach((f,i)=>tone(f,f*.75,.23,i*.065,.021));}
      if(name==='win'){[392,494,587,784].forEach((f,i)=>tone(f,f,.7,i*.1,.033,'triangle'));if(value>=10)tone(988,988,1,.4,.025);}
      if(name==='bonus'){shimmer(1,1800,.12);[196,294,392,494,587,784].forEach((f,i)=>tone(f,f,1.1,i*.14,.035,'triangle'));}
      if(name==='pick'){sample('glass',.1,1+level*.04);tone(588+level*30,720+level*30,.35,.05,.025);}
      if(name==='pour'){sample('pour',.16,.95+level*.025);[260,370,290,450,330].forEach((f,i)=>tone(f,f*1.7,.17,i*.14,.025));shimmer(.8,550,.09);}
      if(name==='complete'){[262,330,392,523,659,784].forEach((f,i)=>tone(f,f,1.15,i*.12,.038,'triangle'));shimmer(1,1600,.1);if(value>=2)[988,1175].forEach((f,i)=>tone(f,f,1,.65+i*.13,.023));}
      if(name==='bet'){tone(440,523,.2,0,.025);tone(660,784,.2,.06,.014);}
      if(name==='auto'){tone(330,440,.23,0,.023);tone(494,587,.25,.11,.019);}
      if(name==='button'&&context.currentTime-lastButton>.08){lastButton=context.currentTime;tone(350,290,.14,0,.014);}
    }
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(enabled){wantsAtmosphere=true;atmosphere();}});
    document.addEventListener('click',event=>{const button=event.target.closest?.('button');if(!button||button.disabled||['spin-button','sound-button','finish-brew'].includes(button.id)||button.classList.contains('ingredient-button'))return;play(button.id.startsWith('bet-')||button.dataset.bet?'bet':['auto-button','start-auto','stop-auto'].includes(button.id)?'auto':'button');});
    return Object.freeze({setEnabled,play,stop});
  }};
})();
