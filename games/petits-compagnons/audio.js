/* Petits Compagnons — lecteurs HTML audio locaux, sans dépendance. */
(function () {
  'use strict';

  const SFX_ROOT = 'assets/audio/sfx/';
  const MUSIC_PATH = 'assets/audio/music/sherwood.ogg';
  const MAX_VOICES = 8;
  const MAX_PENDING_NOTES = 24;
  const DEFAULTS = { sound: true, music: true, soundVolume: 0.55, musicVolume: 0.20 };
  const note = (file, at, volume, rate) => ({ file, at: at || 0, volume: volume === undefined ? 0.65 : volume, rate: rate || 1 });
  const SOUNDS = {
    tap: [note('click_001', 0, 0.35)],
    select: [note('select_001', 0, 0.48)],
    open: [note('open_001', 0, 0.45)],
    close: [note('close_001', 0, 0.38)],
    warm: [note('pluck_001', 0, 0.44, 1.08), note('glass_001', 115, 0.25, 1.12)],
    cuddle: [note('glass_003', 0, 0.42), note('pluck_002', 140, 0.31, 1.13)],
    feed: [note('drop_001', 0, 0.49), note('drop_002', 105, 0.42), note('pluck_001', 240, 0.34)],
    wash: [note('drop_003', 0, 0.44), note('drop_004', 95, 0.39), note('glass_006', 230, 0.3)],
    sleep: [note('minimize_007', 0, 0.48, 0.92)],
    wake: [note('maximize_007', 0, 0.5)],
    hatch: [note('drop_004', 0, 0.47), note('confirmation_001', 135, 0.65), note('glass_005', 320, 0.42)],
    evolve: [note('confirmation_003', 0, 0.66), note('glass_003', 190, 0.48), note('glass_005', 370, 0.43, 1.12)],
    start: [note('confirmation_002', 0, 0.58)],
    collect: [note('pluck_002', 0, 0.40, 1.07)],
    miss: [note('error_004', 0, 0.26, 0.94)],
    win: [note('confirmation_004', 0, 0.65), note('glass_005', 190, 0.43), note('glass_006', 350, 0.35, 1.1)],
    purchase: [note('confirmation_001', 0, 0.53), note('glass_001', 160, 0.36)],
    equip: [note('select_005', 0, 0.52)],
    day: [note('switch_002', 0, 0.42), note('glass_001', 130, 0.25, 1.1)],
    night: [note('switch_002', 0, 0.36, 0.9), note('glass_003', 145, 0.23, 0.9)],
    export: [note('confirmation_002', 0, 0.45)],
    import: [note('confirmation_003', 0, 0.48)]
  };
  let activeManager = null;

  function clamp(value) { return Math.max(0, Math.min(1, value)); }
  function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  function create() {
    if (activeManager) return activeManager;

    let settings = { ...DEFAULTS };
    let context = { sleeping: false, miniGame: false };
    let unlocked = false;
    let destroyed = false;
    let effectsEpoch = 0;
    let musicEpoch = 0;
    let musicIntent = false;
    let musicPending = false;
    let musicRequestEpoch = -1;
    let musicRetryAllowed = true;
    let fadeTimer = null;
    let fadeTarget = null;
    const pendingNotes = new Set();
    const lastKinds = new Map();
    const lastFiles = new Map();

    const music = document.createElement('audio');
    music.id = 'ambient-music';
    music.src = MUSIC_PATH;
    music.loop = true;
    music.preload = 'auto';
    music.volume = 0;
    music.hidden = true;
    music.setAttribute('aria-hidden', 'true');
    music.setAttribute('data-state', 'locked');
    document.body.appendChild(music);

    const effectsAllowed = () => !destroyed && unlocked && !document.hidden && settings.sound && settings.soundVolume > 0;
    const musicAllowed = () => !destroyed && unlocked && !document.hidden && settings.music && settings.musicVolume > 0;
    const desiredMusicVolume = () => clamp(settings.musicVolume * (context.sleeping ? 0.5 : 1) * (context.miniGame ? 0.45 : 1));

    function musicStatus(status) { music.setAttribute('data-state', status); }
    function pausedStatus() {
      return destroyed ? 'destroyed' : !unlocked ? 'locked' : document.hidden ? 'hidden' : !settings.music || settings.musicVolume === 0 ? 'disabled' : 'paused';
    }

    function pauseAudio(audio) {
      try { if (!audio.paused) audio.pause(); } catch (_) { /* A detached or failed reader is already silent. */ }
    }

    function cancelFade() {
      if (fadeTimer !== null) clearTimeout(fadeTimer);
      fadeTimer = null;
      fadeTarget = null;
    }

    function fadeMusic(target) {
      target = clamp(target);
      if (fadeTarget === target && fadeTimer !== null) return;
      if (Math.abs(music.volume - target) < 0.002) {
        cancelFade();
        music.volume = target;
        return;
      }
      cancelFade();
      fadeTarget = target;
      const initial = music.volume;
      const started = now();
      const epoch = musicEpoch;
      function step() {
        fadeTimer = null;
        if (destroyed || !musicAllowed() || music.paused || epoch !== musicEpoch) return;
        const progress = Math.min(1, Math.max(0, (now() - started) / 480));
        const ease = progress * progress * (3 - 2 * progress);
        music.volume = clamp(initial + (target - initial) * ease);
        if (progress < 1) fadeTimer = setTimeout(step, 40);
        else fadeTarget = null;
      }
      fadeTimer = setTimeout(step, 40);
    }

    function silenceMusic() {
      cancelFade();
      music.volume = 0;
      pauseAudio(music);
      musicStatus(pausedStatus());
    }

    function syncMusic() {
      const wanted = musicAllowed();
      if (wanted !== musicIntent) {
        musicIntent = wanted;
        musicEpoch++;
        if (wanted) musicRetryAllowed = true;
      }
      if (!wanted) { silenceMusic(); return; }
      if (musicPending) return;
      if (!music.paused) {
        musicStatus('playing');
        fadeMusic(desiredMusicVolume());
        return;
      }
      if (!musicRetryAllowed) { musicStatus('blocked'); return; }

      musicPending = true;
      musicRequestEpoch = musicEpoch;
      const requestEpoch = musicRequestEpoch;
      music.volume = 0;
      musicStatus('starting');
      let attempt;
      try { attempt = music.play(); }
      catch (_) { musicFailed(requestEpoch); return; }
      if (attempt && typeof attempt.then === 'function') {
        Promise.resolve(attempt).then(() => musicStarted(requestEpoch), () => musicFailed(requestEpoch));
      } else musicStarted(requestEpoch);
    }

    function musicStarted(requestEpoch) {
      musicPending = false;
      if (destroyed || requestEpoch !== musicEpoch || !musicAllowed()) {
        silenceMusic();
        if (!destroyed && musicAllowed()) syncMusic();
        return;
      }
      musicStatus('playing');
      fadeMusic(desiredMusicVolume());
    }

    function musicFailed(requestEpoch) {
      musicPending = false;
      if (destroyed) { silenceMusic(); return; }
      if (requestEpoch !== musicEpoch) {
        silenceMusic();
        if (musicAllowed()) syncMusic();
        return;
      }
      musicRetryAllowed = false;
      silenceMusic();
      if (musicAllowed()) musicStatus('blocked');
    }

    function onMusicPlay() {
      if (!musicAllowed() || musicRequestEpoch !== musicEpoch) silenceMusic();
    }
    function onMusicError() {
      musicRetryAllowed = false;
      silenceMusic();
      if (musicAllowed()) musicStatus('blocked');
    }
    music.addEventListener('play', onMusicPlay);
    music.addEventListener('error', onMusicError);

    const voices = Array.from({ length: MAX_VOICES }, () => {
      const audio = document.createElement('audio');
      audio.preload = 'auto';
      const voice = { audio, active: false, pending: false, epoch: 0, started: 0, baseVolume: 0, file: '' };
      voice.onEnded = () => { voice.active = false; };
      voice.onError = () => { voice.active = false; pauseAudio(audio); };
      voice.onPlay = () => {
        if (!effectsAllowed() || voice.epoch !== effectsEpoch || !voice.active) {
          audio.volume = 0;
          pauseAudio(audio);
        }
      };
      audio.addEventListener('ended', voice.onEnded);
      audio.addEventListener('error', voice.onError);
      audio.addEventListener('play', voice.onPlay);
      return voice;
    });

    function stopEffects() {
      effectsEpoch++;
      pendingNotes.forEach(timer => clearTimeout(timer));
      pendingNotes.clear();
      voices.forEach(voice => {
        voice.active = false;
        voice.audio.volume = 0;
        pauseAudio(voice.audio);
      });
    }

    function playNote(item) {
      if (!effectsAllowed()) return false;
      const time = now();
      if (time - (lastFiles.get(item.file) ?? -Infinity) < 45) return false;
      let voice = voices.find(item => !item.pending && (!item.active || item.audio.ended || item.audio.paused));
      if (!voice) voice = voices.filter(item => !item.pending).sort((a, b) => a.started - b.started)[0];
      if (!voice) return false;
      pauseAudio(voice.audio);
      voice.epoch = effectsEpoch;
      voice.active = true;
      voice.pending = true;
      voice.started = time;
      voice.baseVolume = item.volume;
      if (voice.file !== item.file) {
        voice.file = item.file;
        voice.audio.src = SFX_ROOT + item.file + '.ogg';
      }
      try { voice.audio.currentTime = 0; } catch (_) { /* Metadata may still be loading. */ }
      voice.audio.volume = clamp(settings.soundVolume * item.volume);
      voice.audio.playbackRate = item.rate;
      lastFiles.set(item.file, time);
      const epoch = voice.epoch;
      let attempt;
      try { attempt = voice.audio.play(); }
      catch (_) { settleVoice(voice, epoch, false); return false; }
      if (attempt && typeof attempt.then === 'function') {
        Promise.resolve(attempt).then(() => settleVoice(voice, epoch, true), () => settleVoice(voice, epoch, false));
      } else settleVoice(voice, epoch, true);
      return true;
    }

    function settleVoice(voice, epoch, success) {
      voice.pending = false;
      if (!success || destroyed || epoch !== effectsEpoch || !effectsAllowed() || !voice.active) {
        voice.active = false;
        voice.audio.volume = 0;
        pauseAudio(voice.audio);
      }
    }

    function sync() {
      if (!effectsAllowed()) stopEffects();
      else voices.forEach(voice => {
        if (voice.active) voice.audio.volume = clamp(settings.soundVolume * voice.baseVolume);
      });
      syncMusic();
    }

    function configure(nextSettings, nextContext) {
      if (destroyed) return;
      nextSettings = nextSettings || {};
      ['sound', 'music'].forEach(key => {
        if (typeof nextSettings[key] === 'boolean') settings[key] = nextSettings[key];
      });
      ['soundVolume', 'musicVolume'].forEach(key => {
        if (typeof nextSettings[key] === 'number' && Number.isFinite(nextSettings[key])) settings[key] = clamp(nextSettings[key]);
      });
      if (nextContext) {
        ['sleeping', 'miniGame'].forEach(key => {
          if (typeof nextContext[key] === 'boolean') context[key] = nextContext[key];
        });
      }
      sync();
    }

    function unlock() {
      if (destroyed) return;
      unlocked = true;
      musicRetryAllowed = true;
      sync();
    }

    function play(kind) {
      if (!effectsAllowed() || !Object.prototype.hasOwnProperty.call(SOUNDS, kind)) return false;
      const time = now();
      const cooldown = kind === 'tap' ? 90 : kind === 'collect' ? 85 : 120;
      if (time - (lastKinds.get(kind) ?? -Infinity) < cooldown) return false;
      lastKinds.set(kind, time);
      const epoch = effectsEpoch;
      let accepted = false;
      SOUNDS[kind].forEach(item => {
        if (item.at === 0) { accepted = playNote(item) || accepted; return; }
        if (pendingNotes.size >= MAX_PENDING_NOTES) return;
        const timer = setTimeout(() => {
          pendingNotes.delete(timer);
          if (!destroyed && epoch === effectsEpoch && effectsAllowed()) playNote(item);
        }, item.at);
        pendingNotes.add(timer);
        accepted = true;
      });
      return accepted;
    }

    function onVisibility() {
      if (!document.hidden && unlocked) musicRetryAllowed = true;
      sync();
    }
    document.addEventListener('visibilitychange', onVisibility);

    function releaseAudio(audio) {
      pauseAudio(audio);
      try {
        audio.removeAttribute('src');
        if (typeof audio.load === 'function') audio.load();
      } catch (_) { /* Release is best-effort when a reader has already failed. */ }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      musicEpoch++;
      stopEffects();
      silenceMusic();
      document.removeEventListener('visibilitychange', onVisibility);
      music.removeEventListener('play', onMusicPlay);
      music.removeEventListener('error', onMusicError);
      voices.forEach(voice => {
        voice.audio.removeEventListener('ended', voice.onEnded);
        voice.audio.removeEventListener('error', voice.onError);
        voice.audio.removeEventListener('play', voice.onPlay);
        releaseAudio(voice.audio);
      });
      releaseAudio(music);
      music.remove();
      if (activeManager === manager) activeManager = null;
    }

    const manager = { configure, unlock, play, destroy };
    activeManager = manager;
    return manager;
  }

  window.PetAudio = { create };
}());
