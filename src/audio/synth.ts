/**
 * Procedural Web Audio synthesizer.
 *
 * Every sound in Stepwise is generated at runtime — there are no .mp3/.wav
 * assets. Footsteps are noise bursts filtered by the surface material, wind is
 * a filtered noise bed, and the Flow chimes are FM-ish sine pairs.
 *
 * The class is deliberately tolerant of a missing AudioContext (autoplay
 * policies, headless tests): every method is a no-op when the context is
 * unavailable.
 */

import type { SurfaceMaterial } from '../core/types';

export class AudioSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  volume = 0.7;
  muted = false;

  /** Lazily creates the AudioContext (must be called from a user gesture). */
  init(): void {
    if (this.ctx) return;
    const Ctor =
      (
        globalThis as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        }
      ).AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
      return;
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);

    this.noiseBuffer = this.createNoiseBuffer(2);

    // Wind bed: looping noise through a band-pass filter.
    const wind = this.ctx.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 480;
    this.windFilter.Q.value = 0.7;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();
  }

  /** Resumes the context after a user gesture. */
  resume(): void {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.setVolume(this.volume);
  }

  private createNoiseBuffer(seconds: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Plays a footstep. The material determines the filter character:
   *  - concrete: short, filtered mid thump
   *  - metal:   bright, ringing, band-passed
   *  - glass:   crystalline, high pitched
   *  - wood:    hollow, low-mid with a knock
   */
  footstep(material: SurfaceMaterial, intensity = 0.6): void {
    if (!this.ctx || !this.master || !this.noiseBuffer || this.muted) return;
    const t = this.now();
    const gain = this.ctx.createGain();

    const profile = FOOTSTEP_PROFILES[material];
    const level = profile.level * (0.4 + intensity * 0.6);

    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = profile.rate * (0.92 + Math.random() * 0.16);

    const filter = this.ctx.createBiquadFilter();
    filter.type = profile.filterType;
    filter.frequency.value = profile.frequency * (0.9 + Math.random() * 0.2);
    filter.Q.value = profile.q;

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + profile.decay);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(t);
    source.stop(t + profile.decay + 0.05);

    if (material === 'metal' || material === 'glass') {
      this.tone(profile.toneFreq, t + 0.002, profile.toneDecay, level * 0.35, 'triangle');
    }
  }

  /** A pitched tone used for chimes and feedback. */
  tone(
    freq: number,
    startAt: number,
    duration: number,
    level: number,
    type: OscillatorType = 'sine',
  ): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = startAt;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  jump(): void {
    if (!this.ctx || this.muted) return;
    const t = this.now();
    this.tone(320, t, 0.14, 0.16, 'triangle');
    this.tone(480, t + 0.03, 0.12, 0.1, 'sine');
  }

  land(impact = 0.5): void {
    if (!this.ctx || !this.master || !this.noiseBuffer || this.muted) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260 + impact * 500;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0002, 0.16 + impact * 0.3), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.22);
  }

  /** A whoosh for vaults and rolls. */
  whoosh(strength = 1): void {
    if (!this.ctx || !this.master || !this.noiseBuffer || this.muted) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(2200, t + 0.22);
    filter.Q.value = 1.4;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16 * strength, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.36);
  }

  /** A thud for slides and roll landings. */
  thud(strength = 1): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.now();
    this.tone(78, t, 0.2, 0.2 * strength, 'sine');
    this.tone(52, t + 0.01, 0.26, 0.16 * strength, 'sine');
  }

  /** Crackling wood or shattering glass. */
  crack(kind: 'plank' | 'glass'): void {
    if (!this.ctx || !this.master || !this.noiseBuffer || this.muted) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = kind === 'glass' ? 1.8 : 0.8;
    const filter = this.ctx.createBiquadFilter();
    filter.type = kind === 'glass' ? 'highpass' : 'bandpass';
    filter.frequency.value = kind === 'glass' ? 2400 : 900;
    filter.Q.value = kind === 'glass' ? 0.8 : 3.2;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0002, t);
    gain.gain.exponentialRampToValueAtTime(kind === 'glass' ? 0.2 : 0.14, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'glass' ? 0.5 : 0.28));
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.6);
  }

  /** The Flow tier chime — pitch rises with the tier. */
  flowChime(tier: 1 | 2 | 3): void {
    if (!this.ctx || this.muted) return;
    const t = this.now();
    const base = tier === 1 ? 523.25 : tier === 2 ? 659.25 : 783.99;
    this.tone(base, t, 0.32, 0.14, 'sine');
    this.tone(base * 1.5, t + 0.04, 0.28, 0.09, 'sine');
    if (tier === 3) this.tone(base * 2, t + 0.09, 0.4, 0.07, 'sine');
  }

  /** A dramatic swell for the Flow Save. */
  flowSave(): void {
    if (!this.ctx || this.muted) return;
    const t = this.now();
    this.tone(180, t, 0.5, 0.18, 'sawtooth');
    this.tone(360, t + 0.05, 0.45, 0.12, 'triangle');
    this.tone(720, t + 0.1, 0.4, 0.08, 'sine');
  }

  /** Failure sting. */
  fail(): void {
    if (!this.ctx || this.muted) return;
    const t = this.now();
    this.tone(220, t, 0.5, 0.16, 'sawtooth');
    this.tone(160, t + 0.08, 0.55, 0.14, 'sawtooth');
  }

  /** Updates the wind bed intensity from the runner's speed. */
  setWind(speed: number, altitude = 0): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const t = this.now();
    const level = Math.min(0.16, 0.015 + (speed / 700) * 0.12 + altitude * 0.00008);
    this.windGain.gain.setTargetAtTime(this.muted ? 0 : level, t, 0.25);
    this.windFilter.frequency.setTargetAtTime(380 + speed * 0.9, t, 0.3);
  }

  dispose(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}

interface FootstepProfile {
  level: number;
  rate: number;
  filterType: BiquadFilterType;
  frequency: number;
  q: number;
  decay: number;
  toneFreq: number;
  toneDecay: number;
}

const FOOTSTEP_PROFILES: Record<SurfaceMaterial, FootstepProfile> = {
  concrete: {
    level: 0.2,
    rate: 1.0,
    filterType: 'lowpass',
    frequency: 900,
    q: 1,
    decay: 0.1,
    toneFreq: 0,
    toneDecay: 0,
  },
  metal: {
    level: 0.16,
    rate: 1.35,
    filterType: 'bandpass',
    frequency: 2600,
    q: 6,
    decay: 0.22,
    toneFreq: 1250,
    toneDecay: 0.18,
  },
  glass: {
    level: 0.14,
    rate: 1.5,
    filterType: 'bandpass',
    frequency: 4200,
    q: 9,
    decay: 0.3,
    toneFreq: 3100,
    toneDecay: 0.26,
  },
  wood: {
    level: 0.2,
    rate: 0.85,
    filterType: 'bandpass',
    frequency: 480,
    q: 3.5,
    decay: 0.16,
    toneFreq: 220,
    toneDecay: 0.12,
  },
};
