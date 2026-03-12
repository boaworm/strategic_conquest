import { UnitType } from '@sc/shared';

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/** Big boom — low rumbling explosion for 2s */
function playBomberAttack() {
  const ctx = getCtx();
  const duration = 2;
  const t0 = ctx.currentTime;

  // Noise buffer for explosion
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  // Low-pass filter for deep rumble
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(200, t0);
  lp.frequency.exponentialRampToValueAtTime(40, t0 + duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.6, t0);
  gain.gain.exponentialRampToValueAtTime(0.01, t0 + duration);

  // Sub-bass thump
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(60, t0);
  osc.frequency.exponentialRampToValueAtTime(20, t0 + duration);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.5, t0);
  oscGain.gain.exponentialRampToValueAtTime(0.01, t0 + duration);

  noise.connect(lp).connect(gain).connect(ctx.destination);
  osc.connect(oscGain).connect(ctx.destination);
  noise.start(t0);
  noise.stop(t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration);
}

/** Jet fly-by — rising then falling pitch whoosh for 2s */
function playFighterAttack() {
  const ctx = getCtx();
  const duration = 2;
  const t0 = ctx.currentTime;

  // Jet engine noise
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(800, t0);
  bp.frequency.linearRampToValueAtTime(2000, t0 + 0.8);
  bp.frequency.linearRampToValueAtTime(600, t0 + duration);
  bp.Q.value = 2;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.01, t0);
  gain.gain.linearRampToValueAtTime(0.5, t0 + 0.6);
  gain.gain.linearRampToValueAtTime(0.5, t0 + 1.0);
  gain.gain.exponentialRampToValueAtTime(0.01, t0 + duration);

  // Whine tone
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(400, t0);
  osc.frequency.linearRampToValueAtTime(1200, t0 + 0.8);
  osc.frequency.linearRampToValueAtTime(300, t0 + duration);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.01, t0);
  oscGain.gain.linearRampToValueAtTime(0.15, t0 + 0.6);
  oscGain.gain.exponentialRampToValueAtTime(0.01, t0 + duration);

  noise.connect(bp).connect(gain).connect(ctx.destination);
  osc.connect(oscGain).connect(ctx.destination);
  noise.start(t0);
  noise.stop(t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration);
}

/** Rifle fire — rapid burst crackling for 2s */
function playRifleAttack() {
  const ctx = getCtx();
  const duration = 2;
  const t0 = ctx.currentTime;

  // Crackle bursts
  for (let i = 0; i < 8; i++) {
    const offset = i * 0.22 + Math.random() * 0.05;
    const shotLen = 0.12;

    const bufSize = Math.floor(ctx.sampleRate * shotLen);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < bufSize; j++) d[j] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1000;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t0 + offset);
    g.gain.exponentialRampToValueAtTime(0.01, t0 + offset + shotLen);

    src.connect(hp).connect(g).connect(ctx.destination);
    src.start(t0 + offset);
    src.stop(t0 + offset + shotLen);
  }
}

/** Sonar ping — classic ping with echo for 2s */
function playSonarAttack() {
  const ctx = getCtx();
  const duration = 2;
  const t0 = ctx.currentTime;

  for (let i = 0; i < 2; i++) {
    const offset = i * 0.9;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1500, t0 + offset);
    osc.frequency.exponentialRampToValueAtTime(1200, t0 + offset + 0.3);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.3, t0 + offset);
    gain.gain.exponentialRampToValueAtTime(0.01, t0 + offset + 0.8);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + offset);
    osc.stop(t0 + offset + 0.8);
  }
}

/** Big naval gun — single cannon shot with reverb tail for 2s */
function playNavalGunAttack() {
  const ctx = getCtx();
  const duration = 2;
  const t0 = ctx.currentTime;

  // Initial shot crack
  const crackLen = 0.15;
  const crackBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * crackLen), ctx.sampleRate);
  const cd = crackBuf.getChannelData(0);
  for (let i = 0; i < cd.length; i++) cd[i] = Math.random() * 2 - 1;

  const crack = ctx.createBufferSource();
  crack.buffer = crackBuf;
  const crackGain = ctx.createGain();
  crackGain.gain.setValueAtTime(0.6, t0);
  crackGain.gain.exponentialRampToValueAtTime(0.01, t0 + crackLen);

  const crackBp = ctx.createBiquadFilter();
  crackBp.type = 'bandpass';
  crackBp.frequency.value = 800;
  crackBp.Q.value = 1;

  crack.connect(crackBp).connect(crackGain).connect(ctx.destination);
  crack.start(t0);
  crack.stop(t0 + crackLen);

  // Low boom tail
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(80, t0);
  osc.frequency.exponentialRampToValueAtTime(30, t0 + duration);
  const boomGain = ctx.createGain();
  boomGain.gain.setValueAtTime(0.5, t0);
  boomGain.gain.exponentialRampToValueAtTime(0.01, t0 + duration);

  osc.connect(boomGain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration);

  // Reverb-like echo noise
  const echoBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
  const ed = echoBuf.getChannelData(0);
  for (let i = 0; i < ed.length; i++) ed[i] = Math.random() * 2 - 1;

  const echo = ctx.createBufferSource();
  echo.buffer = echoBuf;
  const echoLp = ctx.createBiquadFilter();
  echoLp.type = 'lowpass';
  echoLp.frequency.setValueAtTime(300, t0);
  echoLp.frequency.exponentialRampToValueAtTime(60, t0 + duration);
  const echoGain = ctx.createGain();
  echoGain.gain.setValueAtTime(0.01, t0);
  echoGain.gain.linearRampToValueAtTime(0.2, t0 + 0.1);
  echoGain.gain.exponentialRampToValueAtTime(0.01, t0 + duration);

  echo.connect(echoLp).connect(echoGain).connect(ctx.destination);
  echo.start(t0);
  echo.stop(t0 + duration);
}

/** Triumphant trumpet fanfare for capturing a city (~1.5s) */
export function playCityCaptureFanfare(): void {
  const ctx = getCtx();
  const t0 = ctx.currentTime;

  // Brass-like tone using sawtooth + low-pass filter
  const notes = [
    { freq: 523, start: 0, dur: 0.15 },    // C5 – short
    { freq: 659, start: 0.18, dur: 0.15 },  // E5 – short
    { freq: 784, start: 0.36, dur: 0.15 },  // G5 – short
    { freq: 1047, start: 0.55, dur: 0.7 },  // C6 – long triumphant hold
  ];

  for (const n of notes) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(n.freq, t0 + n.start);

    // Low-pass to soften into brass timbre
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(n.freq * 3, t0 + n.start);
    lp.Q.value = 1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0 + n.start);
    gain.gain.linearRampToValueAtTime(0.3, t0 + n.start + 0.03); // quick attack
    gain.gain.setValueAtTime(0.3, t0 + n.start + n.dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.01, t0 + n.start + n.dur);

    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start(t0 + n.start);
    osc.stop(t0 + n.start + n.dur);
  }
}

/** Play the appropriate attack sound for a unit type. */
/** Crash sound — descending whine + impact for stranded fighters (~1.5s) */
export function playCrashSound(): void {
  const ctx = getCtx();
  const t0 = ctx.currentTime;

  // Descending whine (fighter engine dying)
  const whine = ctx.createOscillator();
  whine.type = 'sawtooth';
  whine.frequency.setValueAtTime(1200, t0);
  whine.frequency.exponentialRampToValueAtTime(100, t0 + 0.8);
  const whineLp = ctx.createBiquadFilter();
  whineLp.type = 'lowpass';
  whineLp.frequency.setValueAtTime(2000, t0);
  whineLp.frequency.exponentialRampToValueAtTime(200, t0 + 0.8);
  const whineGain = ctx.createGain();
  whineGain.gain.setValueAtTime(0.25, t0);
  whineGain.gain.exponentialRampToValueAtTime(0.01, t0 + 0.8);
  whine.connect(whineLp).connect(whineGain).connect(ctx.destination);
  whine.start(t0);
  whine.stop(t0 + 0.8);

  // Impact crunch at 0.7s
  const impactLen = 0.6;
  const impactBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * impactLen), ctx.sampleRate);
  const id = impactBuf.getChannelData(0);
  for (let i = 0; i < id.length; i++) id[i] = Math.random() * 2 - 1;
  const impact = ctx.createBufferSource();
  impact.buffer = impactBuf;
  const impactBp = ctx.createBiquadFilter();
  impactBp.type = 'bandpass';
  impactBp.frequency.value = 400;
  impactBp.Q.value = 0.8;
  const impactGain = ctx.createGain();
  impactGain.gain.setValueAtTime(0.5, t0 + 0.7);
  impactGain.gain.exponentialRampToValueAtTime(0.01, t0 + 0.7 + impactLen);
  impact.connect(impactBp).connect(impactGain).connect(ctx.destination);
  impact.start(t0 + 0.7);
  impact.stop(t0 + 0.7 + impactLen);
}

export function playAttackSound(unitType: UnitType): void {
  switch (unitType) {
    case UnitType.Bomber:
      playBomberAttack();
      break;
    case UnitType.Fighter:
      playFighterAttack();
      break;
    case UnitType.Infantry:
    case UnitType.Tank:
      playRifleAttack();
      break;
    case UnitType.Submarine:
      playSonarAttack();
      break;
    case UnitType.Destroyer:
    case UnitType.Battleship:
      playNavalGunAttack();
      break;
    default:
      playRifleAttack();
      break;
  }
}
