// Kenney CC0 recordings and softened effects. Sources and processing: SOURCES-AUDIO.txt.
(function (root) {
  'use strict';
  const samples = {
    click: { file: 'button-click.ogg', volume: .34 },
    tick: { file: 'reel-tick.ogg', volume: .10 },
    stop: { file: 'reel-stop-soft.wav', volume: .22 },
    win: { file: 'coin-win.ogg', volume: .5 },
    freeze: { file: 'freeze-chime.ogg', volume: .43 },
    bonus: { file: 'bonus-fanfare.ogg', volume: .4 },
    sword: { file: 'sword-slash.ogg', volume: .5 },
    draw: { file: 'sword-draw.ogg', volume: .42 }
  };
  const cache = new Map();
  const voices = new Set();
  let enabled = false;

  function warm() {
    if (typeof Audio === 'undefined' || cache.size) return;
    for (const [name, sample] of Object.entries(samples)) {
      const audio = new Audio(`assets/audio/${sample.file}`);
      audio.preload = 'auto';
      cache.set(name, audio);
      audio.load();
    }
  }

  function stopAll() {
    for (const audio of voices) audio.pause();
    voices.clear();
  }

  function setEnabled(value) {
    enabled = value === true;
    if (enabled) warm();
    else stopAll();
  }

  function play(name, options = {}) {
    if (!enabled || !samples[name] || typeof Audio === 'undefined') return false;
    warm();
    const audio = cache.get(name).cloneNode();
    audio.volume = Math.min(1, Math.max(0, samples[name].volume * (options.volume ?? 1)));
    audio.playbackRate = Math.min(2, Math.max(.5, options.rate ?? 1));
    if (voices.size >= 12) {
      const oldest = voices.values().next().value;
      oldest.pause(); voices.delete(oldest);
    }
    voices.add(audio);
    const release = () => voices.delete(audio);
    audio.addEventListener('ended', release, { once: true });
    audio.addEventListener('error', release, { once: true });
    try {
      const playback = audio.play();
      if (playback?.catch) playback.catch(release);
    } catch (_) { release(); }
    return true;
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAll(); });
  root.SeabyssSounds = Object.freeze({ setEnabled, play, stopAll });
})(globalThis);
