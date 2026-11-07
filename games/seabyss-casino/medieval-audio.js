(() => {
  'use strict';
  window.MedievalAudio = {create() {
    let context, enabled = false, master;
    const voices = new Set();
    function tone(from,to,duration,delay=0,volume=.05,type='sine') {
      if (!enabled || !context || voices.size>=16) return;
      const start = context.currentTime+delay, oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = type;oscillator.frequency.setValueAtTime(from,start);oscillator.frequency.exponentialRampToValueAtTime(Math.max(25,to),start+duration);
      gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(volume,start+.025);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
      oscillator.connect(gain);gain.connect(master);voices.add(oscillator);
      oscillator.onended = () => {voices.delete(oscillator);oscillator.disconnect();gain.disconnect();};oscillator.start(start);oscillator.stop(start+duration+.03);
    }
    function wind() {
      if (!enabled || !context || voices.size>=16) return;
      const duration=1.4, buffer=context.createBuffer(1,Math.ceil(context.sampleRate*duration),context.sampleRate), samples=buffer.getChannelData(0);
      for (let at=0;at<samples.length;at++) samples[at]=(Math.random()*2-1)*.3;
      const source=context.createBufferSource(), filter=context.createBiquadFilter(), gain=context.createGain();source.buffer=buffer;filter.type='lowpass';filter.frequency.setValueAtTime(800,context.currentTime);filter.frequency.exponentialRampToValueAtTime(220,context.currentTime+duration);
      gain.gain.setValueAtTime(0,context.currentTime);gain.gain.linearRampToValueAtTime(.3,context.currentTime+.18);gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+duration);
      source.connect(filter);filter.connect(gain);gain.connect(master);voices.add(source);source.onended=()=>{voices.delete(source);source.disconnect();filter.disconnect();gain.disconnect();};source.start();source.stop(context.currentTime+duration);
    }
    function stop() {for(const voice of voices) {try{voice.stop();}catch(_){}}voices.clear();}
    function setEnabled(value) {
      enabled=!!value;if(!enabled){stop();return;}
      try {if(!context){context=new (window.AudioContext||window.webkitAudioContext)();master=context.createGain();master.gain.value=.7;master.connect(context.destination);}context.resume().catch(()=>{});}catch(_){enabled=false;}
    }
    function play(name,index=0) {
      if(!enabled)return;if(context?.state==='suspended')context.resume().catch(()=>{});
      if(name==='stop')tone(240+index*22,200+index*20,.19,0,.035);
      if(name==='spin')tone(130,230,.3,0,.035,'triangle');
      if(name==='dragon'){wind();tone(80,48,1.2,0,.09,'triangle');tone(115,58,.8,.2,.055,'sine');}
      if(name==='key'){tone(740,720,.45,0,.045);tone(1108,1080,.55,.09,.025);}
      if(name==='gate'){[196,247,294,392].forEach((f,i)=>tone(f,f,.65,i*.09,.055,'triangle'));tone(62,42,.4,0,.06);}
      if(name==='win'){[330,415,494].forEach((f,i)=>tone(f,f*.995,.6,i*.11,.05));if(index>=5)[659,830].forEach((f,i)=>tone(f,f,.75,.35+i*.12,.04));}
      if(name==='bonus')[196,247,294,392,494,587].forEach((f,i)=>tone(f,f,.85,i*.13,.05,'triangle'));
    }
    return Object.freeze({setEnabled,play,stop});
  }};
})();
