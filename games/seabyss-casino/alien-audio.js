(() => {
  'use strict';
  window.AlienAudio = {create() {
    let context,master,enabled=false,wantsAmbience=false,generation=0,ambientTimer=null,lastButton=-10,lastUfo=-10,lastMoo=-10,mooBuffer=null,mooLoading=null;
    const voices=new Set();
    const available=()=>enabled&&context&&!document.hidden&&context.state==='running'&&voices.size<18;
    function track(source,nodes){voices.add(source);source.onended=()=>{voices.delete(source);for(const node of [source,...nodes])node.disconnect();};}
    async function moo(){
      if(!available()||context.currentTime-lastMoo<2.1)return;lastMoo=context.currentTime;const ticket=generation;
      try{
        if(!mooBuffer){if(!mooLoading)mooLoading=fetch('assets/alien/audio/cow-moo.mp3').then(r=>{if(!r.ok)throw new Error('Audio unavailable');return r.arrayBuffer();}).then(b=>context.decodeAudioData(b)).then(b=>{mooBuffer=b;mooLoading=null;return b;}).catch(()=>{mooLoading=null;return null;});await mooLoading;}
        if(!mooBuffer||ticket!==generation||!available())return;
        const source=context.createBufferSource(),gain=context.createGain(),now=context.currentTime,duration=mooBuffer.duration;
        source.buffer=mooBuffer;gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.15,now+.04);gain.gain.setValueAtTime(.15,now+Math.max(.05,duration-.15));gain.gain.linearRampToValueAtTime(0,now+duration);source.connect(gain);gain.connect(master);track(source,[gain]);source.start();source.stop(now+duration+.01);
      }catch(_){}
    }
    function tone(from,to,duration,delay=0,volume=.035,type='sine',formant=0){
      if(!available())return;
      const source=context.createOscillator(),gain=context.createGain(),start=context.currentTime+delay,nodes=[gain];
      source.type=type;source.frequency.setValueAtTime(from,start);source.frequency.exponentialRampToValueAtTime(Math.max(30,to),start+duration);
      gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(volume,start+.03);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
      if(formant){const filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=formant;filter.Q.value=2;source.connect(filter);filter.connect(gain);nodes.push(filter);}else source.connect(gain);
      gain.connect(master);track(source,nodes);source.start(start);source.stop(start+duration+.03);
    }
    function whoosh(duration=.7,volume=.08,up=true){
      if(!available())return;
      const buffer=context.createBuffer(1,Math.ceil(context.sampleRate*duration),context.sampleRate),data=buffer.getChannelData(0);let smooth=0;
      for(let i=0;i<data.length;i++){smooth=(smooth+Math.random()*.2-.1)/1.035;data[i]=smooth;}
      const source=context.createBufferSource(),filter=context.createBiquadFilter(),gain=context.createGain(),now=context.currentTime;
      source.buffer=buffer;filter.type='bandpass';filter.Q.value=.7;filter.frequency.setValueAtTime(up?300:1300,now);filter.frequency.exponentialRampToValueAtTime(up?1900:220,now+duration);
      gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(volume,now+.08);gain.gain.exponentialRampToValueAtTime(.0001,now+duration);source.connect(filter);filter.connect(gain);gain.connect(master);track(source,[gain,filter]);source.start();source.stop(now+duration);
    }
    function ambience(){
      if(!enabled||!wantsAmbience||!context||context.state!=='running'||document.hidden||ambientTimer)return;
      tone(147,147,4.5,0,.008);tone(220,220,4.1,.15,.006);tone(587,659,.9,2.6,.009);
      ambientTimer=setTimeout(()=>{ambientTimer=null;ambience();},11000);
    }
    function wake(){if(!enabled||!context||document.hidden)return;const ticket=generation;context.resume().then(()=>{if(ticket===generation&&enabled&&wantsAmbience&&!document.hidden)ambience();}).catch(()=>{});}
    function stop(){generation++;wantsAmbience=false;clearTimeout(ambientTimer);ambientTimer=null;for(const voice of voices){try{voice.stop();}catch(_){}}voices.clear();}
    function setEnabled(value){enabled=!!value;if(!enabled){stop();return;}wantsAmbience=true;try{if(!context){context=new(window.AudioContext||window.webkitAudioContext)();master=context.createGain();master.gain.value=.55;const compressor=context.createDynamicsCompressor();compressor.threshold.value=-18;compressor.knee.value=18;compressor.ratio.value=4;compressor.attack.value=.01;compressor.release.value=.2;master.connect(compressor);compressor.connect(context.destination);}wake();}catch(_){enabled=false;}}
    function play(name,value=0){
      if(!enabled||document.hidden||!context)return;wantsAmbience=true;if(context.state!=='running'){wake();return;}ambience();const n=Math.max(0,Math.min(5,Number(value)||0));
      if(name==='spin'){whoosh(.65,.08);[196,247,294].forEach((f,i)=>tone(f,f*1.12,.36,i*.07,.025,'triangle'));}
      if(name==='stop'){tone(175+n*13,135+n*10,.17,0,.019);tone(380+n*20,340+n*17,.14,.025,.009);}
      if(name==='ufo'&&context.currentTime-lastUfo>.8){lastUfo=context.currentTime;tone(145,620,.65,0,.025);tone(288,1240,.65,.035,.012);whoosh(.7,.05);}
      if(name==='beam'){moo();whoosh(1,.13);[150,200,300].forEach((f,i)=>tone(f,f*5,1,i*.07,.025,'triangle'));tone(135,92,.85,.08,.045,'sawtooth',650);tone(137,95,.85,.1,.02,'triangle');}
      if(name==='capture'){[440,659,880].forEach((f,i)=>tone(f,f*1.1,.3,i*.075,.035));tone(260,540,.18,.18,.023,'triangle');}
      if(name==='hold'){tone(262+n*14,262+n*14,.4,0,.022);tone(524+n*28,524+n*28,.32,.07,.012);}
      if(name==='win'){[392,494,587,784].forEach((f,i)=>tone(f,f,.65,i*.1,.035,'triangle'));if(value>=10)tone(988,1175,.8,.4,.024);}
      if(name==='bonus'||name==='free-start'){[196,294,392,494,587,784].forEach((f,i)=>tone(f,f,.9,i*.12,.033,'triangle'));whoosh(.85,.07);}
      if(name==='free-end'){[784,659,523,392].forEach((f,i)=>tone(f,f,.75,i*.13,.035,'triangle'));}
      if(name==='bet'){tone(440,587,.2,0,.026);tone(660,880,.16,.06,.014);}
      if(name==='auto'){tone(330,440,.25,0,.024);tone(494,587,.25,.12,.019);}
      if(name==='button'&&context.currentTime-lastButton>.08){lastButton=context.currentTime;tone(330,270,.14,0,.014);}
    }
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else if(enabled){wantsAmbience=true;wake();}});
    document.addEventListener('click',event=>{const button=event.target.closest?.('button');if(!button||button.disabled||['spin-button','sound-button','enter-bonus','finish-bonus'].includes(button.id))return;play(button.id.startsWith('bet-')||button.dataset.bet?'bet':['auto-button','start-auto','stop-auto'].includes(button.id)?'auto':'button');});
    return Object.freeze({setEnabled,play,stop});
  }};
})();
