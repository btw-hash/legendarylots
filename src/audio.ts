/** WebAudio-generated sounds — no asset files. Tick on sector pass, gavel bang + fanfare on win. */

let ctx: AudioContext | null = null;
let muted = localStorage.getItem('ll-muted') === '1';

function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  localStorage.setItem('ll-muted', muted ? '1' : '0');
  return muted;
}

export function tick(): void {
  if (muted) return;
  const a = ac();
  const t = a.currentTime;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(2200, t);
  osc.frequency.exponentialRampToValueAtTime(900, t + 0.03);
  gain.gain.setValueAtTime(0.08, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + 0.05);
}

/** A single wooden gavel knock — used per strike during a spin. */
export function gavelBang(intensity = 1): void {
  if (muted) return;
  const a = ac();
  const t0 = a.currentTime;

  // Wooden knock: short band-passed noise crack...
  const len = Math.floor(a.sampleRate * 0.11);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 440;
  bp.Q.value = 0.9;
  const g = a.createGain();
  g.gain.setValueAtTime(0.5 * intensity, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t0);

  // ...over a low block-thump.
  const osc = a.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(165, t0);
  osc.frequency.exponentialRampToValueAtTime(58, t0 + 0.12);
  const og = a.createGain();
  og.gain.setValueAtTime(0.32 * intensity, t0);
  og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
  osc.connect(og).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + 0.16);
}

export function winFanfare(): void {
  if (muted) return;
  const a = ac();
  const t0 = a.currentTime;

  // Gavel bang: filtered noise burst.
  const len = Math.floor(a.sampleRate * 0.18);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const noise = a.createBufferSource();
  noise.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const ng = a.createGain();
  ng.gain.setValueAtTime(0.5, t0);
  ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
  noise.connect(lp).connect(ng).connect(a.destination);
  noise.start(t0);

  // Rising fanfare, tavern-style triad.
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, i) => {
    const t = t0 + 0.12 + i * 0.11;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (i === notes.length - 1 ? 0.6 : 0.24));
    osc.connect(g).connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.7);
  });
}
