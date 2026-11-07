(() => {
  'use strict';
  window.MeadowAudio = { create(theme) {
    let context, master, enabled = false, variation = 0;
    const voices = new Set(), MAX_VOICES = 12;
    function release(voice) {
      if (!voices.delete(voice)) return;
      try { voice.oscillator.disconnect(); voice.gain.disconnect(); } catch (_) {}
    }
    function cancel(voice) {
      try { voice.oscillator.stop(); } catch (_) {}
      release(voice);
    }
    function tone(frequency, end, duration, delay = 0, volume = .03, type = 'sine') {
      if (!enabled || !context || !master) return;
      while (voices.size >= MAX_VOICES) cancel(voices.values().next().value);
      let voice;
      try {
        const start = context.currentTime + Math.max(0, delay);
        const oscillator = context.createOscillator(), gain = context.createGain();
        voice = { oscillator, gain }; voices.add(voice);
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, end), start + duration);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(Math.min(.055, volume), start + Math.min(.025, duration / 3));
        gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
        oscillator.connect(gain); gain.connect(master);
        oscillator.onended = () => release(voice);
        oscillator.start(start); oscillator.stop(start + duration + .025);
      } catch (_) { if (voice) cancel(voice); }
    }
    function stop() { for (const voice of [...voices]) cancel(voice); }
    function resume() { try { context?.resume()?.catch(() => {}); } catch (_) {} }
    function setEnabled(value) {
      enabled = !!value;
      if (!enabled) { stop(); return; }
      try {
        if (!context) {
          context = new (window.AudioContext || window.webkitAudioContext)();
          master = context.createGain(); master.gain.value = .7; master.connect(context.destination);
        }
        resume();
      } catch (_) { enabled = false; stop(); }
    }
    // Short musical voices, one identity per creature. Large wins add a
    // harmony, not louder volume. No recordings, harsh clicks or noise bursts.
    function monsterWin(details) {
      const symbol = details.symbol || 'mochi', big = Number(details.ratio) >= 5;
      const pitch = [1, .95, 1.045][variation++ % 3], speed = details.rapid ? .8 : 1;
      const motifs = {
        mochi: [[220,340,.19,0],[310,235,.22,.13]],
        puff: [[285,240,.24,0],[305,345,.2,.16]],
        bubbles: [[510,330,.14,0],[620,405,.14,.1],[465,585,.18,.2]],
        sprout: [[290,390,.17,0],[365,490,.18,.11],[450,540,.2,.23]],
        zippy: [[370,560,.12,0],[590,350,.13,.09],[410,660,.16,.19]],
        luna: [[440,415,.26,0],[554,520,.3,.16]]
      };
      const notes = motifs[symbol] || motifs.mochi;
      notes.forEach(([from,to,duration,delay], index) => {
        tone(from*pitch,to*pitch,duration*speed,delay*speed,.031,index%2?'sine':'triangle');
      });
      if (big) {
        tone(660*pitch,655*pitch,.36*speed,.26*speed,.022);
        tone(880*pitch,875*pitch,.4*speed,.39*speed,.018);
      }
    }
    function play(name, detail = 0) {
      if (!enabled) return;
      if (context?.state === 'suspended') resume();
      const cute = theme === 'monsters', index = Number.isFinite(detail) ? detail : 0;
      if (name === 'stop') tone(cute ? 185+(index%2)*5 : 220-(index%2)*4, cute ? 150 : 180, .13, 0, .017, 'triangle');
      if (name === 'spin') tone(cute ? 145 : 225, cute ? 225 : 370, .25, 0, .022, 'triangle');
      if (name === 'bloom' && !cute) {
        const note = [523,659,784][Math.max(0, Math.min(2, index))];
        tone(note,note*.99,.3,0,.025); tone(note*1.5,note*1.49,.18,.035,.008);
      }
      if (name === 'feature') {
        if (cute) { tone(240,520,.23,0,.034,'triangle'); tone(460,300,.22,.17,.029); tone(330,650,.26,.33,.032,'triangle'); }
        else [392,494,587,784].forEach((frequency,i)=>tone(frequency,frequency*.99,.43,i*.095,.028));
      }
      if (name === 'win') {
        if (cute) monsterWin(detail && typeof detail === 'object' ? detail : {});
        else [523,659,784].forEach((frequency,i)=>tone(frequency,frequency*.998,.4,i*.085,.032));
      }
      if (name === 'bonus') [392,494,587,784,988,1175].forEach((frequency,i)=>tone(frequency,frequency*1.005,.6,i*.11,.033));
    }
    return Object.freeze({setEnabled,play,stop});
  }};
})();