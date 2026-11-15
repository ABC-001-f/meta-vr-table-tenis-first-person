// Slow-motion replay: a ring buffer of the last few seconds of ball and
// paddle poses, played back in place (the camera is never moved - the player
// keeps their own viewpoint, which is the comfortable way to do it in VR).
import type { MatchSession } from '../game/session.ts';

const STRIDE = 19; // t, ball xyz, live, paddle+ pos/quat, paddle- pos/quat
const MAX = 900;

export interface ReplayFrame {
  ball: [number, number, number];
  live: boolean;
  p1: number[]; // x,y,z,qx,qy,qz,qw
  p2: number[];
}

export class Replay {
  playing = false;
  speed = 0.3;
  private buf = new Float32Array(MAX * STRIDE);
  private head = 0;
  private count = 0;
  private clock = 0;
  private playT = 0;
  private playEnd = 0;
  private from = 0;
  private n = 0;
  private out: ReplayFrame = { ball: [0, 0, 0], live: false, p1: [0, 0, 0, 0, 0, 0, 1], p2: [0, 0, 0, 0, 0, 0, 1] };

  record(s: MatchSession, dt: number): void {
    if (this.playing) return;
    this.clock += dt;
    const o = this.head * STRIDE;
    const b = this.buf;
    const ball = s.world.ball.pos;
    b[o] = this.clock;
    b[o + 1] = ball.x;
    b[o + 2] = ball.y;
    b[o + 3] = ball.z;
    b[o + 4] = s.world.ballLive ? 1 : 0;
    let k = o + 5;
    for (const p of [s.paddles['1'], s.paddles['-1']]) {
      b[k++] = p.pos.x;
      b[k++] = p.pos.y;
      b[k++] = p.pos.z;
      b[k++] = p.quat.x;
      b[k++] = p.quat.y;
      b[k++] = p.quat.z;
      b[k++] = p.quat.w;
    }
    this.head = (this.head + 1) % MAX;
    if (this.count < MAX) this.count++;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }

  get available(): number {
    if (this.count < 2) return 0;
    const newest = this.buf[((this.head - 1 + MAX) % MAX) * STRIDE];
    const oldest = this.buf[((this.head - this.count + MAX) % MAX) * STRIDE];
    return newest - oldest;
  }

  /** Replay the last `seconds` of play. */
  start(seconds: number, speed = 0.3): boolean {
    const have = this.available;
    if (have < 0.5) return false;
    const span = Math.min(seconds, have);
    const newest = this.buf[((this.head - 1 + MAX) % MAX) * STRIDE];
    // find the first frame inside the window
    let n = 0;
    for (let i = 1; i <= this.count; i++) {
      const t = this.buf[((this.head - i + MAX) % MAX) * STRIDE];
      if (newest - t > span) break;
      n = i;
    }
    if (n < 4) return false;
    this.n = n;
    this.from = (this.head - n + MAX) % MAX;
    this.playT = this.buf[this.from * STRIDE];
    this.playEnd = newest;
    this.speed = speed;
    this.playing = true;
    return true;
  }

  stop(): void {
    this.playing = false;
  }

  /** 0..1 progress of the current playback */
  get progress(): number {
    const t0 = this.buf[this.from * STRIDE];
    return this.playEnd > t0 ? (this.playT - t0) / (this.playEnd - t0) : 1;
  }

  /** Advance playback; returns the interpolated frame or null when finished. */
  update(dt: number): ReplayFrame | null {
    if (!this.playing) return null;
    this.playT += dt * this.speed;
    if (this.playT >= this.playEnd) {
      this.playing = false;
      return null;
    }
    const b = this.buf;
    // linear scan is fine: n <= 900
    let i = 0;
    while (i < this.n - 2 && b[((this.from + i + 1) % MAX) * STRIDE] < this.playT) i++;
    const a = ((this.from + i) % MAX) * STRIDE;
    const c = ((this.from + i + 1) % MAX) * STRIDE;
    const span = b[c] - b[a];
    const f = span > 1e-6 ? Math.min(1, Math.max(0, (this.playT - b[a]) / span)) : 0;
    const o = this.out;
    const L = (k: number): number => b[a + k] + (b[c + k] - b[a + k]) * f;
    o.live = b[a + 4] > 0.5;
    // do not interpolate across a serve reset (ball jumps while not live)
    const jump = b[a + 4] !== b[c + 4];
    o.ball[0] = jump ? b[a + 1] : L(1);
    o.ball[1] = jump ? b[a + 2] : L(2);
    o.ball[2] = jump ? b[a + 3] : L(3);
    for (let k = 0; k < 7; k++) {
      o.p1[k] = L(5 + k);
      o.p2[k] = L(12 + k);
    }
    return o;
  }
}
