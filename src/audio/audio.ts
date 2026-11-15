// Procedural, spatialised audio (Web Audio, HRTF panners). No sample files:
// every sound is synthesised, so the app works offline and loads instantly.
export type Ambience = 'crowd' | 'lounge' | 'synth' | 'quiet';

interface V3 {
  x: number;
  y: number;
  z: number;
}

export class GameAudio {
  ctx: AudioContext | null = null;
  volume = 0.8;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private amb: { src: AudioNode[]; gain: GainNode } | null = null;
  private ambKind: Ambience = 'quiet';

  /** Must be called from a user gesture (entering VR / first click). */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.setAmbience(this.ambKind);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Listener pose in world space. */
  setListener(pos: V3, fwd: V3, up: V3): void {
    const c = this.ctx;
    if (!c) return;
    const l = c.listener;
    if (l.positionX) {
      const t = c.currentTime;
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t);
      l.forwardY.setValueAtTime(fwd.y, t);
      l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  private out(pos: V3 | null, gain: number): { node: GainNode; t: number } | null {
    const c = this.ctx;
    if (!c || !this.master || c.state !== 'running') return null;
    const g = c.createGain();
    g.gain.value = gain;
    if (pos) {
      const p = c.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 0.6;
      p.rolloffFactor = 1.1;
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
      g.connect(p).connect(this.master);
    } else g.connect(this.master);
    return { node: g, t: c.currentTime };
  }

  /** A short pitched knock with a noise transient: the basis of every ball sound. */
  private knock(pos: V3 | null, freq: number, decay: number, gain: number, noiseAmt: number, noiseFreq: number): void {
    const o = this.out(pos, 1);
    const c = this.ctx;
    if (!o || !c || !this.noise) return;
    const { node, t } = o;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.35, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + decay * 0.35);
    const og = c.createGain();
    og.gain.setValueAtTime(gain, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    osc.connect(og).connect(node);
    osc.start(t);
    osc.stop(t + decay + 0.02);
    if (noiseAmt > 0) {
      const n = c.createBufferSource();
      n.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = noiseFreq;
      f.Q.value = 1.2;
      const ng = c.createGain();
      ng.gain.setValueAtTime(gain * noiseAmt, t);
      ng.gain.exponentialRampToValueAtTime(0.0008, t + decay * 0.6);
      n.connect(f).connect(ng).connect(node);
      n.start(t, Math.random());
      n.stop(t + decay);
    }
  }

  table(pos: V3, impact: number): void {
    const g = Math.min(1, 0.25 + impact * 0.14);
    this.knock(pos, 1150 + Math.random() * 120, 0.07, g, 0.5, 3200);
  }
  paddle(pos: V3, impact: number, spinny: boolean): void {
    const g = Math.min(1.2, 0.35 + impact * 0.07);
    // a brushed (spin) contact is duller and hissier than a flat crack
    this.knock(pos, spinny ? 520 : 760 + Math.random() * 80, 0.09, g, spinny ? 1.1 : 0.6, spinny ? 4200 : 2400);
  }
  net(pos: V3, impact: number): void {
    this.knock(pos, 180, 0.12, Math.min(0.8, 0.2 + impact * 0.06), 1.6, 900);
  }
  floor(pos: V3, impact: number): void {
    this.knock(pos, 820, 0.08, Math.min(0.7, 0.15 + impact * 0.1), 0.4, 2000);
  }
  edge(pos: V3): void {
    this.knock(pos, 1700, 0.05, 0.6, 0.8, 5000);
  }

  private tone(freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'triangle'): void {
    const o = this.out(null, 1);
    const c = this.ctx;
    if (!o || !c) return;
    const t = o.t + start;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(g).connect(o.node);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  click(): void {
    this.tone(880, 0, 0.06, 0.18, 'sine');
  }
  hover(): void {
    this.tone(1400, 0, 0.025, 0.05, 'sine');
  }
  pointWon(): void {
    this.tone(660, 0, 0.14, 0.22);
    this.tone(990, 0.1, 0.22, 0.22);
  }
  pointLost(): void {
    this.tone(440, 0, 0.14, 0.18);
    this.tone(330, 0.11, 0.24, 0.18);
  }
  let(): void {
    this.tone(700, 0, 0.1, 0.16, 'square');
    this.tone(700, 0.16, 0.1, 0.16, 'square');
  }
  fanfare(win: boolean): void {
    const notes = win ? [523, 659, 784, 1047] : [392, 349, 311, 262];
    notes.forEach((f, i) => this.tone(f, i * 0.16, 0.4, 0.24));
  }
  unlockChime(): void {
    [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, i * 0.07, 0.3, 0.16, 'sine'));
  }
  tick(): void {
    this.tone(1200, 0, 0.03, 0.1, 'square');
  }
  targetHit(): void {
    this.tone(1320, 0, 0.1, 0.2, 'sine');
    this.tone(1760, 0.07, 0.18, 0.2, 'sine');
  }
  machine(pos: V3): void {
    this.knock(pos, 140, 0.1, 0.5, 1.2, 600);
  }

  /** Crowd reaction for the arena; scaled by how exciting the point was. */
  cheer(intensity: number): void {
    if (this.ambKind !== 'crowd') return;
    const o = this.out(null, 1);
    const c = this.ctx;
    if (!o || !c || !this.noise) return;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1100;
    f.Q.value = 0.5;
    const g = c.createGain();
    const peak = 0.1 + 0.22 * Math.min(1, intensity);
    const dur = 1.6 + 1.6 * Math.min(1, intensity);
    g.gain.setValueAtTime(0.0001, o.t);
    g.gain.linearRampToValueAtTime(peak, o.t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.001, o.t + dur);
    n.connect(f).connect(g).connect(o.node);
    n.start(o.t, Math.random());
    n.stop(o.t + dur + 0.05);
  }

  setAmbience(kind: Ambience): void {
    this.ambKind = kind;
    const c = this.ctx;
    if (!c || !this.master || !this.noise) return;
    if (this.amb) {
      const old = this.amb;
      old.gain.gain.setTargetAtTime(0, c.currentTime, 0.3);
      setTimeout(() => {
        for (const s of old.src) {
          try {
            (s as AudioScheduledSourceNode).stop();
          } catch {
            /* already stopped */
          }
        }
        old.gain.disconnect();
      }, 1500);
      this.amb = null;
    }
    if (kind === 'quiet') return;
    const gain = c.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const src: AudioNode[] = [];
    const noiseLayer = (freq: number, q: number, level: number, type: BiquadFilterType = 'bandpass'): void => {
      const n = c.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.value = level;
      n.connect(f).connect(g).connect(gain);
      n.start(0, Math.random());
      src.push(n);
    };
    const drone = (freq: number, level: number, type: OscillatorType): void => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = c.createGain();
      g.gain.value = level;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.07 + Math.random() * 0.08;
      const lg = c.createGain();
      lg.gain.value = level * 0.6;
      lfo.connect(lg).connect(g.gain);
      o.connect(g).connect(gain);
      o.start();
      lfo.start();
      src.push(o, lfo);
    };
    let level = 0.5;
    if (kind === 'crowd') {
      noiseLayer(420, 0.6, 0.11);
      noiseLayer(1500, 0.8, 0.035);
      noiseLayer(120, 0.7, 0.07, 'lowpass');
    } else if (kind === 'lounge') {
      noiseLayer(240, 0.5, 0.03, 'lowpass');
      drone(110, 0.012, 'sine');
      level = 0.4;
    } else if (kind === 'synth') {
      drone(55, 0.05, 'sawtooth');
      drone(82.4, 0.035, 'triangle');
      drone(164.8, 0.015, 'sine');
      noiseLayer(3000, 2, 0.006);
      level = 0.45;
    }
    gain.gain.setTargetAtTime(level, c.currentTime, 0.8);
    this.amb = { src, gain };
  }
}
