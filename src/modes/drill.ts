// Practice drills and challenges. A ball machine at the far end launches real
// balls into the physics world; the drill watches the same contact events the
// match rules use to decide whether each return (or serve) was good.
import { BALL, HALF_L, HALF_W, TABLE } from '../core/constants.ts';
import { cross, normalize, scale } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { solveLaunch } from '../ai/solver.ts';
import { predictFlight } from '../physics/world.ts';
import type { PhysEvent, PhysicsWorld } from '../physics/world.ts';

export type FeedKind =
  | 'mixed'
  | 'forehand'
  | 'backhand'
  | 'alternate'
  | 'lob'
  | 'topspin'
  | 'backspin'
  | 'sidespin'
  | 'spinMix'
  | 'hardServe'
  | 'fast'
  | 'none';

export type TargetKind = 'none' | 'static' | 'moving' | 'small';

export interface DrillGoal {
  kind: 'targets' | 'streak' | 'returns' | 'timedScore';
  count: number;
  /** seconds; 0 = untimed */
  time: number;
  /** max balls; 0 = unlimited */
  balls: number;
}

export interface DrillDef {
  id: string;
  title: string;
  desc: string;
  group: 'practice' | 'challenge';
  feed: FeedKind;
  /** the player serves instead of receiving from the machine */
  playerServes: boolean;
  targets: TargetKind;
  interval: number;
  goal: DrillGoal | null;
}

const d = (
  id: string,
  title: string,
  desc: string,
  group: 'practice' | 'challenge',
  feed: FeedKind,
  targets: TargetKind,
  interval: number,
  goal: DrillGoal | null = null,
  playerServes = false,
): DrillDef => ({ id, title, desc, group, feed, targets, interval, goal, playerServes });

export const DRILLS: DrillDef[] = [
  d('free', 'Free Practice', 'Unlimited mixed balls from the machine', 'practice', 'mixed', 'none', 2.2),
  d('serve', 'Serve Practice', 'Toss and serve. Tracks your serve accuracy', 'practice', 'none', 'static', 1.2, null, true),
  d('spin', 'Spin Lab', 'Topspin, backspin and sidespin balls with spin display', 'practice', 'spinMix', 'none', 2.6),
  d('smash', 'Smash Training', 'High lobs to put away', 'practice', 'lob', 'none', 2.8),
  d('forehand', 'Forehand Drill', 'Every ball to your forehand', 'practice', 'forehand', 'none', 2.0),
  d('backhand', 'Backhand Drill', 'Every ball to your backhand', 'practice', 'backhand', 'none', 2.0),
  d('footwork', 'Forehand / Backhand', 'Alternating sides', 'practice', 'alternate', 'none', 1.9),
  d('target', 'Target Accuracy', 'Land returns on the targets', 'practice', 'mixed', 'static', 2.3),

  d('c-moving', 'Moving Targets', 'Hit the moving target 6 times in 75 seconds', 'challenge', 'mixed', 'moving', 2.1, { kind: 'targets', count: 6, time: 75, balls: 0 }),
  d('c-streak', 'Rally Streak', 'Return 12 balls in a row', 'challenge', 'mixed', 'none', 1.8, { kind: 'streak', count: 12, time: 0, balls: 40 }),
  d('c-serves', 'Serve Return', 'Return 6 of 12 heavy-spin serves', 'challenge', 'hardServe', 'none', 2.8, { kind: 'returns', count: 6, time: 0, balls: 12 }),
  d('c-timed', 'Beat the Clock', 'Score 15 good returns in 60 seconds', 'challenge', 'fast', 'none', 1.35, { kind: 'timedScore', count: 15, time: 60, balls: 0 }),
  d('c-precision', 'Precision', 'Hit the small targets 4 times with 20 balls', 'challenge', 'mixed', 'small', 2.3, { kind: 'targets', count: 4, time: 0, balls: 20 }),
];

export interface Target {
  x: number;
  z: number;
  r: number;
  phase: number;
  hitFlash: number;
}

export interface DrillListener {
  onFeed?(kind: string, spinRpm: number): void;
  onResult?(good: boolean, targetHit: boolean, landing: Vec3 | null): void;
  onDone?(success: boolean): void;
  /** the player must serve now */
  onNeedServe?(): void;
}

type Track = 'idle' | 'incoming' | 'bounced' | 'struck' | 'tossed' | 'serveStruck' | 'serveOwn';

export const MACHINE_POS: Vec3 = { x: 0, y: TABLE.height + 0.3, z: -(HALF_L + 0.18) };

export class Drill {
  def: DrillDef;
  world: PhysicsWorld;
  listener: DrillListener = {};
  targets: Target[] = [];
  score = 0;
  streak = 0;
  bestStreak = 0;
  attempts = 0;
  good = 0;
  balls = 0;
  timeLeft = 0;
  elapsed = 0;
  done = false;
  success = false;
  lastFeed = '';
  /** +1 when the player's forehand is on +X (right-handed) */
  foreSign: 1 | -1;
  private track: Track = 'idle';
  private nextFeed = 1.2;
  private rng: () => number;
  private alt = 1;
  private netOnServe = false;
  private waitingServe = false;

  constructor(world: PhysicsWorld, def: DrillDef, rng: () => number, rightHanded: boolean) {
    this.world = world;
    this.def = def;
    this.rng = rng;
    this.foreSign = rightHanded ? 1 : -1;
    this.timeLeft = def.goal?.time ?? 0;
    this.placeTargets();
  }

  private placeTargets(): void {
    const rng = this.rng;
    const k = this.def.targets;
    this.targets = [];
    if (k === 'static') {
      this.targets.push(
        { x: -0.45, z: -0.95, r: 0.17, phase: 0, hitFlash: 0 },
        { x: 0.45, z: -0.95, r: 0.17, phase: 0, hitFlash: 0 },
        { x: 0, z: -0.5, r: 0.17, phase: 0, hitFlash: 0 },
      );
    } else if (k === 'moving') {
      this.targets.push({ x: 0, z: -0.85, r: 0.19, phase: rng() * 6, hitFlash: 0 });
    } else if (k === 'small') {
      for (let i = 0; i < 2; i++) {
        this.targets.push({
          x: (rng() * 2 - 1) * (HALF_W - 0.2),
          z: -(0.35 + rng() * (HALF_L - 0.6)),
          r: 0.1,
          phase: 0,
          hitFlash: 0,
        });
      }
    }
  }

  update(dt: number): void {
    if (this.done) return;
    this.elapsed += dt;
    for (const t of this.targets) {
      if (t.hitFlash > 0) t.hitFlash -= dt;
      if (this.def.targets === 'moving') {
        t.phase += dt * 0.9;
        t.x = Math.sin(t.phase) * (HALF_W - 0.25);
        t.z = -0.85 + Math.sin(t.phase * 0.6) * 0.3;
      }
    }
    const g = this.def.goal;
    if (g && g.time > 0) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        return this.finish(this.score >= g.count);
      }
    }
    if (this.nextFeed >= 0) {
      this.nextFeed -= dt;
      if (this.nextFeed < 0) {
        if (g && g.balls > 0 && this.balls >= g.balls) return this.finish(this.score >= g.count);
        if (this.def.playerServes) {
          if (!this.waitingServe) {
            this.waitingServe = true;
            this.world.ballLive = false;
            this.track = 'idle';
            this.listener.onNeedServe?.();
          }
        } else this.feed();
      }
    }
  }

  /** The player tossed the ball for a practice serve. */
  tossed(): void {
    this.waitingServe = false;
    this.track = 'tossed';
    this.netOnServe = false;
  }

  private finish(success: boolean): void {
    if (this.done) return;
    this.done = true;
    this.success = success;
    this.listener.onDone?.(success);
  }

  private feed(): void {
    const rng = this.rng;
    const w = this.world;
    let kind = this.def.feed;
    if (kind === 'none') return;
    if (kind === 'spinMix') kind = (['topspin', 'backspin', 'sidespin'] as FeedKind[])[Math.floor(rng() * 3)];
    if (kind === 'alternate') {
      this.alt = -this.alt;
      kind = this.alt > 0 ? 'forehand' : 'backhand';
    }
    const from = { ...MACHINE_POS, x: (rng() * 2 - 1) * 0.15 };
    let tx = (rng() * 2 - 1) * 0.5;
    let tz = 0.55 + rng() * 0.5;
    let T = 0.6 + rng() * 0.12;
    let spinRate = 25 + rng() * 30; // rad/s topspin by default
    let side = 0;
    switch (kind) {
      case 'forehand':
        tx = this.foreSign * (0.25 + rng() * 0.3);
        break;
      case 'backhand':
        tx = -this.foreSign * (0.25 + rng() * 0.3);
        break;
      case 'lob':
        T = 1.0 + rng() * 0.15;
        tz = 0.5 + rng() * 0.35;
        spinRate = 10;
        break;
      case 'topspin':
        spinRate = 190 + rng() * 80;
        T = 0.52;
        break;
      case 'backspin':
        spinRate = -(170 + rng() * 70);
        T = 0.7;
        break;
      case 'sidespin':
        spinRate = 30;
        side = (rng() < 0.5 ? -1 : 1) * (170 + rng() * 60);
        break;
      case 'fast':
        T = 0.46 + rng() * 0.1;
        spinRate = 90;
        break;
      case 'hardServe':
        return this.feedServe(from);
    }
    // spin axes for a ball travelling toward +Z
    const fwd = normalize({ x: tx - from.x, y: 0, z: tz - from.z });
    const topAxis = cross({ x: 0, y: 1, z: 0 }, fwd);
    const spin = { x: topAxis.x * spinRate, y: side, z: topAxis.z * spinRate };
    let v: Vec3 | null = null;
    for (let i = 0; i < 6 && !v; i++, T *= 1.12) v = solveLaunch(from, tx, tz, TABLE.height + BALL.radius, T, spin);
    if (!v) v = { x: 0, y: 1.6, z: 4.6 };
    this.launch(from, v, spin, kind);
  }

  private feedServe(from: Vec3): void {
    const rng = this.rng;
    // a real serve path: bounce on the machine's side, clear the net, land on yours
    for (let tries = 0; tries < 12; tries++) {
      const type = Math.floor(rng() * 3);
      const rate = 180 + rng() * 120;
      const speed = 4.2 + rng() * 2.2;
      const bx = (rng() * 2 - 1) * 0.3;
      const bz = -HALF_L * (0.45 + rng() * 0.25);
      const fwd = normalize({ x: bx - from.x, y: 0, z: bz - from.z });
      const topAxis = cross({ x: 0, y: 1, z: 0 }, fwd);
      const spin =
        type === 0
          ? scale(topAxis, rate)
          : type === 1
            ? scale(topAxis, -rate)
            : { x: topAxis.x * 40, y: (rng() < 0.5 ? -1 : 1) * rate, z: topAxis.z * 40 };
      const dist = Math.hypot(bx - from.x, bz - from.z, from.y - TABLE.height);
      const v = solveLaunch(from, bx, bz, TABLE.height + BALL.radius, dist / speed, spin);
      if (!v) continue;
      const fl = predictFlight({ pos: from, vel: v, spin }, 1.6, (_b, _t, ev) => ev.length >= 2);
      const [a, b] = fl.events;
      if (a && b && a.type === 'table' && a.side === -1 && b.type === 'table' && b.side === 1 && Math.abs(b.pos.x) < HALF_W - 0.08 && b.pos.z < HALF_L - 0.1) {
        return this.launch(from, v, spin, ['topspin serve', 'backspin serve', 'sidespin serve'][type]);
      }
    }
    this.launch(from, { x: 0, y: 1.6, z: 4.6 }, { x: 30, y: 0, z: 0 }, 'serve');
  }

  private launch(from: Vec3, v: Vec3, spin: Vec3, kind: string): void {
    const b = this.world.ball;
    b.pos = { x: from.x, y: from.y, z: from.z };
    b.vel = v;
    b.spin = { x: spin.x, y: spin.y, z: spin.z };
    this.world.ballLive = true;
    this.track = 'incoming';
    this.balls++;
    this.lastFeed = kind;
    this.nextFeed = -1;
    this.listener.onFeed?.(kind, (Math.hypot(spin.x, spin.y, spin.z) * 60) / (2 * Math.PI));
  }

  private result(good: boolean, landing: Vec3 | null): void {
    this.track = 'idle';
    this.attempts++;
    let targetHit = false;
    const g = this.def.goal;
    if (good) {
      this.good++;
      this.streak++;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      if (landing) {
        for (const t of this.targets) {
          if (Math.hypot(landing.x - t.x, landing.z - t.z) <= t.r + BALL.radius) {
            targetHit = true;
            t.hitFlash = 0.8;
          }
        }
      }
    } else {
      this.streak = 0;
    }
    if (!g) {
      if (this.def.targets !== 'none') {
        if (targetHit) this.score++;
      } else if (good) this.score++;
    } else if (g.kind === 'targets') {
      if (targetHit) this.score++;
    } else if (g.kind === 'streak') {
      this.score = this.streak;
    } else if (good) this.score++;

    if (targetHit && this.def.targets === 'small') this.placeTargets();
    this.listener.onResult?.(good, targetHit, landing);
    this.nextFeed = this.def.interval * (good ? 0.55 : 0.75);
    if (g) {
      const best = g.kind === 'streak' ? this.bestStreak : this.score;
      if (best >= g.count) return this.finish(true);
      if (g.balls > 0 && this.balls >= g.balls && !this.def.playerServes) return this.finish(false);
    }
  }

  handle(e: PhysEvent): void {
    if (this.done) return;
    switch (this.track) {
      case 'incoming':
        if (e.type === 'net') return;
        if (e.type === 'table' && e.side === 1) this.track = 'bounced';
        else if (e.type === 'table' && e.side === -1) return; // serve feed: its own-side bounce
        else if (e.type === 'paddle') this.result(false, null); // volleyed
        else this.result(false, null);
        return;
      case 'bounced':
        if (e.type === 'paddle' && e.side === 1) this.track = 'struck';
        else if (e.type !== 'net') this.result(false, null);
        return;
      case 'struck':
        if (e.type === 'net') return;
        if (e.type === 'table' && e.side === -1) this.result(true, e.pos);
        else this.result(false, null);
        return;
      case 'tossed':
        if (e.type === 'paddle' && e.side === 1) this.track = 'serveStruck';
        else if (e.type !== 'net') {
          // dropped toss: just serve again
          this.track = 'idle';
          this.nextFeed = 0.6;
        }
        return;
      case 'serveStruck':
        if (e.type === 'table' && e.side === 1) this.track = 'serveOwn';
        else {
          this.balls++;
          this.result(false, null);
        }
        return;
      case 'serveOwn':
        if (e.type === 'net') {
          this.netOnServe = true;
          return;
        }
        if (e.type === 'table' && e.side === -1) {
          if (this.netOnServe) {
            this.track = 'idle';
            this.nextFeed = 0.8; // let: replay
          } else {
            this.balls++;
            this.result(true, e.pos);
          }
        } else {
          this.balls++;
          this.result(false, null);
        }
        return;
    }
  }

  get accuracy(): number {
    return this.attempts > 0 ? this.good / this.attempts : 0;
  }
}
