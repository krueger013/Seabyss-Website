const CLIP_SECONDS = 8;
const OUTPUT_PEAK = .18;

// Preserve the instantaneous frequency when the visual clock is slowed.
// The strain is normalized for listening and does not model loudness at Earth.
export function renderWaveAudio(model, {from, stretch=1, pitch=1, sampleRate=24000}={}) {
  if (!(model?.duration>0) || !Number.isFinite(model.duration) || typeof model.sample!=='function' ||
      !Number.isFinite(stretch) || stretch<1 || stretch>4 ||
      (pitch!==1 && pitch!==2) ||
      !Number.isInteger(sampleRate) || sampleRate<8000 || sampleRate>96000) return null;

  const start=from ?? Math.max(0,model.duration-CLIP_SECONDS/stretch);
  if (!Number.isFinite(start) || start<0 || start>=model.duration) return null;
  const finish=Math.min(model.duration,start+CLIP_SECONDS/stretch);
  const first=model.sample(start), last=model.sample(finish);
  if (!Number.isFinite(first?.phase) || !(last?.amplitude>0) || !Number.isFinite(last.amplitude)) return null;

  const count=Math.round((finish-start)*stretch*sampleRate);
  if (count<8) return null;
  const data=new Float32Array(count);
  const taper=Math.max(1,Math.min(.022*sampleRate,Math.floor(count/6)));
  const cosine=Math.cos((model.inclination ?? 0)*Math.PI/180);
  const inclination=(1+cosine**2)/2;
  const norm=last.amplitude;
  for (let i=1;i<count-1;i++) {
    const sample=model.sample(Math.min(finish,start+i/sampleRate/stretch));
    if (!(sample?.frequency>0) || !Number.isFinite(sample.frequency)) continue;
    const phase=first.phase+stretch*pitch*(sample.phase-first.phase);
    const strain=stretch===1 && pitch===1?sample.plus:inclination*sample.amplitude*Math.cos(phase);
    const ramp=Math.min(1,i/taper,(count-1-i)/taper);
    const fade=ramp===1?1:(1-Math.cos(Math.PI*ramp))/2;
    // Guard the browser's DAC from malformed model samples or frequencies
    // outside the representable band, without requesting a different pitch.
    const nyquistGain=Math.max(0,Math.min(1,(.5-sample.frequency*pitch/sampleRate)/.05));
    const value=strain/norm;
    if (Number.isFinite(value)) data[i]=OUTPUT_PEAK*fade*nyquistGain*Math.max(-1,Math.min(1,value));
  }
  return {data,sampleRate,from:start,to:finish,stretch};
}

export function createWaveAudio({onState=()=>{},onError=()=>{}}={}) {
  let context,source,frame=0,sequence=0,active=false,disposed=false;

  function setActive(value) {
    if (value===active) return;
    active=value;
    onState(value);
  }

  function stop() {
    sequence++;
    if (frame) cancelAnimationFrame(frame);
    frame=0;
    const previous=source;
    source=null;
    if (previous) {
      previous.onended=null;
      try {previous.stop();} catch {}
      previous.disconnect();
    }
    setActive(false);
  }

  async function play(model,{from,stretch=1,pitch=1,onPosition}={}) {
    if (disposed) return false;
    stop();
    const revision=sequence;
    try {
      const Audio=globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Audio) throw new Error('Lecture audio indisponible dans ce navigateur.');
      const clip=renderWaveAudio(model,{from,stretch,pitch});
      if (!clip) throw new Error('Aucun extrait sonore disponible.');
      context ??= new Audio();
      setActive(true);
      if (context.state!=='running') await context.resume();
      if (revision!==sequence || disposed) return false;

      const buffer=context.createBuffer(1,clip.data.length,clip.sampleRate);
      buffer.copyToChannel(clip.data,0);
      const player=context.createBufferSource();
      player.buffer=buffer;
      player.connect(context.destination);
      source=player;
      const started=context.currentTime;
      player.onended=()=>{
        if (revision!==sequence) return;
        onPosition?.(clip.to);
        if (revision===sequence) stop();
      };
      player.start(started);

      function sync() {
        if (revision!==sequence) return;
        const position=clip.from+Math.max(0,context.currentTime-started)/clip.stretch;
        onPosition?.(Math.min(clip.to,position));
        if (revision===sequence && onPosition) frame=requestAnimationFrame(sync);
      }
      if (onPosition) sync();
      return revision===sequence;
    } catch (error) {
      if (revision===sequence) {stop();onError(error);}
      return false;
    }
  }

  function dispose() {
    stop();
    disposed=true;
    if (context && context.state!=='closed') context.close().catch(()=>{});
  }

  return {play,stop,dispose};
}
