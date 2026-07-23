"use client";

// Chain-danger alarm. This is deliberately harsh: a sawtooth air-raid siren
// sweeping through a dissonant partner tone, chopped by a fast tremolo so it
// stutters. It should be impossible to ignore across a room.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    // browsers suspend the context until a user gesture resumes it
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call once from a click handler so the browser lets us make noise later. */
export function armAlarm(): boolean {
  const c = audio();
  if (!c) return false;
  // a silent blip unlocks audio on iOS/Safari
  const osc = c.createOscillator();
  const gain = c.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.01);
  return true;
}

/**
 * One alarm burst. `critical` (chain about to die) is faster, higher and
 * louder than the standard warning.
 */
export function playAlarm(critical: boolean): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime;
  const dur = critical ? 1.5 : 1.1;
  const sweeps = critical ? 3 : 2; // siren rises per burst
  const lowHz = critical ? 620 : 440;
  const highHz = critical ? 1750 : 1150;

  const master = c.createGain();
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(critical ? 0.6 : 0.42, t0 + 0.02);
  master.gain.setValueAtTime(critical ? 0.6 : 0.42, t0 + dur - 0.08);
  master.gain.linearRampToValueAtTime(0, t0 + dur);

  // tremolo: chops the tone so it pulses rather than drones
  const tremolo = c.createGain();
  tremolo.gain.value = 1;
  const lfo = c.createOscillator();
  const lfoDepth = c.createGain();
  lfo.type = "square";
  lfo.frequency.value = critical ? 14 : 9;
  lfoDepth.gain.value = 0.5;
  lfo.connect(lfoDepth).connect(tremolo.gain);

  // a touch of distortion for grit
  const shaper = c.createWaveShaper();
  const curve = new Float32Array(257);
  for (let i = 0; i < 257; i++) {
    const x = (i / 256) * 2 - 1;
    curve[i] = Math.tanh(x * 3);
  }
  shaper.curve = curve;

  tremolo.connect(shaper).connect(master).connect(c.destination);

  const makeVoice = (type: OscillatorType, detune: number, level: number) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.detune.value = detune;
    g.gain.value = level;
    // sweep up and back, repeatedly, like an emergency siren
    const step = dur / (sweeps * 2);
    osc.frequency.setValueAtTime(lowHz, t0);
    for (let i = 0; i < sweeps; i++) {
      const base = t0 + i * step * 2;
      osc.frequency.linearRampToValueAtTime(highHz, base + step);
      osc.frequency.linearRampToValueAtTime(lowHz, base + step * 2);
    }
    osc.connect(g).connect(tremolo);
    osc.start(t0);
    osc.stop(t0 + dur);
  };

  makeVoice("sawtooth", 0, 0.5);
  makeVoice("square", 30, 0.28); // dissonant partner = harsher, more "wrong"
  if (critical) makeVoice("sawtooth", -1200, 0.22); // octave-down growl

  lfo.start(t0);
  lfo.stop(t0 + dur);

  // phones: buzz in the same rhythm
  try {
    navigator.vibrate?.(critical ? [300, 90, 300, 90, 600] : [220, 120, 220]);
  } catch {
    /* unsupported */
  }
}

/** Repeat interval between bursts, in ms. */
export function alarmInterval(critical: boolean): number {
  return critical ? 1700 : 2600;
}
