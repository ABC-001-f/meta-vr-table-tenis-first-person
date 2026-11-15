// AI opponent. It reads the incoming ball by running the real flight
// prediction, chooses a shot, solves for the paddle motion that produces it,
// then moves a kinematic paddle (limited speed, reaction delay, aiming noise)
// through the ball. The ball is only ever affected by that paddle colliding
// with it in the shared physics world - no teleporting, no score tampering.
import { BALL, HALF_L, HALF_W, PADDLE, TABLE } from '../core/constants.ts';
import type { Side } from '../core/constants.ts';
import {
  add,
  clamp,
  cross,
  gauss,
  len,
  lerp,
  normalize,
  qFacing,
  qSlerp,
  scale,
  sub,
} from '../core/math.ts';
import type { Quat, Vec3 } from '../core/math.ts';
import { cloneBall } from '../physics/ball.ts';
import type { BallState } from '../physics/ball.ts';
import { predictFlight } from '../physics/world.ts';
import type { PaddleBody, PhysEvent, PhysicsWorld } from '../physics/world.ts';
import { flyToFirstContact, solveLaunch, solvePaddle } from './solver.ts';

export type Difficulty = 'beginner' | 'normal' | 'hard' | 'expert';
export type Personality = 'defender' | 'attacker' | 'strategist' | 'spin';

export interface AIProfile {
  name: string;
  difficulty: Difficulty;
  personality: Personality;
}

interface Skill {
  reaction: number; // s before it starts responding to a stroke
  moveSpeed: number; // paddle travel speed m/s
  swingMax: number; // max paddle speed in a stroke m/s
  aimNoise: number; // rad, error in paddle angle
  speedNoise: number; // fractional error in swing speed
  timingNoise: number; // s
  pace: number; // multiplies shot speed
  spin: number; // 0..1 how much spin it applies
  placement: number; // 0..1 how wide it dares to aim
  smash: number; // 0..1 willingness to smash high balls
}

export const SKILLS: Record<Difficulty, Skill> = {
  beginner: {
    reaction: 0.34,
    moveSpeed: 2.0,
    swingMax: 6,
    aimNoise: 0.075,
    speedNoise: 0.14,
    timingNoise: 0.022,
    pace: 0.72,
    spin: 0.1,
    placement: 0.25,
    smash: 0,
  },
  normal: {
    reaction: 0.24,
    moveSpeed: 3.0,
    swingMax: 9,
    aimNoise: 0.04,
    speedNoise: 0.08,
    timingNoise: 0.012,
    pace: 0.95,
    spin: 0.45,
    placement: 0.5,
    smash: 0.3,
  },
  hard: {
    reaction: 0.17,
    moveSpeed: 4.4,
    swingMax: 13,
    aimNoise: 0.024,
    speedNoise: 0.05,
    timingNoise: 0.007,
    pace: 1.15,
    spin: 0.8,
    placement: 0.75,
    smash: 0.7,
  },
  expert: {
    reaction: 0.11,
    moveSpeed: 6.0,
    swingMax: 17,
    aimNoise: 0.012,
    speedNoise: 0.025,
    timingNoise: 0.003,
    pace: 1.32,
    spin: 1,
    placement: 0.95,
    smash: 1,
  },
};

export const PERSONALITY_LABEL: Record<Personality, string> = {
  defender: 'The Defender',
  attacker: 'The Attacker',
  strategist: 'The Strategist',
  spin: 'The Spin Master',
};

type State = 'ready' | 'waiting' | 'approach' | 'swing' | 'recover' | 'serveHold' | 'serveToss';

interface Plan {
  tContact: number;
  tStart: number;
  tEnd: number;
  start: Vec3; // blade centre at swing start
  vel: Vec3; // paddle velocity through the swing
  quat: Quat;
}

export interface AIHooks {
  /** the AI released the ball for a serve */
  tossed?: () => void;
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };

export class AIController {
  side: Side;
  world: PhysicsWorld;
  paddle: PaddleBody;
  profile: AIProfile;
  skill: Skill;
  hooks: AIHooks = {};
  state: State = 'ready';
  /** last planned shot type, for commentary / HUD */
  lastShot = '';
  private rng: () => number;
  private plan: Plan | null = null;
  private pendingAt = -1; // world time at which to (re)plan
  private pendingNoise = 1;
  private serveAt = 0;
  private restQuat: Quat;

  constructor(side: Side, world: PhysicsWorld, paddle: PaddleBody, profile: AIProfile, rng: () => number) {
    this.side = side;
    this.world = world;
    this.paddle = paddle;
    this.profile = profile;
    this.skill = SKILLS[profile.difficulty];
    this.rng = rng;
    this.restQuat = qFacing({ x: 0, y: 0, z: -side }, UP);
    this.reset();
  }

  setProfile(p: AIProfile): void {
    this.profile = p;
    this.skill = SKILLS[p.difficulty];
  }

  get readyPos(): Vec3 {
    const back = this.profile.personality === 'defender' ? 0.55 : this.profile.personality === 'attacker' ? 0.3 : 0.4;
    return { x: 0, y: TABLE.height + 0.2, z: this.side * (HALF_L + back) };
  }

  /** where the AI holds the ball before serving */
  get serveHoldPos(): Vec3 {
    return { x: this.side * 0.22, y: TABLE.height + 0.22, z: this.side * (HALF_L + 0.22) };
  }

  reset(): void {
    this.state = 'ready';
    this.plan = null;
    this.pendingAt = -1;
    const p = this.paddle;
    p.pos = this.readyPos;
    p.prevPos = this.readyPos;
    p.quat = this.restQuat;
    p.prevQuat = this.restQuat;
    p.vel = { x: 0, y: 0, z: 0 };
    p.angVel = { x: 0, y: 0, z: 0 };
    p.active = false;
  }

  /** Point is over / ball dead: stand down. */
  standDown(): void {
    this.plan = null;
    this.pendingAt = -1;
    if (this.state !== 'serveHold') this.state = 'recover';
    this.paddle.active = false;
  }

  /** Begin a service: hold the ball briefly, toss it, strike it. */
  beginServe(): void {
    this.plan = null;
    this.state = 'serveHold';
    this.serveAt = this.world.time + 1.1 + this.rng() * 0.6;
    const b = this.world.ball;
    this.world.ballLive = false;
    b.pos = this.serveHoldPos;
    b.vel = { x: 0, y: 0, z: 0 };
    b.spin = { x: 0, y: 0, z: 0 };
  }

  /** React to physics contacts. `mustReturn` says whether the AI owes a stroke. */
  onEvent(e: PhysEvent, mustReturn: boolean): void {
    if (this.state === 'serveHold' || this.state === 'serveToss') return;
    if (!mustReturn) return;
    const t = this.world.time;
    if (e.type === 'paddle' && e.side !== this.side) {
      // opponent struck: read it after the reaction delay
      this.plan = null;
      this.state = 'waiting';
      this.pendingAt = t + this.skill.reaction * (0.85 + 0.3 * this.rng());
      this.pendingNoise = 1;
    } else if (e.type === 'net' || (e.type === 'table' && e.side === this.side)) {
      // the bounce / net cord reveals the true path: refine quickly
      if (this.state === 'swing') return;
      this.pendingAt = Math.max(this.pendingAt, t + this.skill.reaction * 0.25);
      this.pendingNoise = 0.7;
    }
  }

  /** Update the paddle pose for the frame that ends `dt` sim-seconds from now. */
  update(dt: number): void {
    const w = this.world;
    const t1 = w.time + dt;
    const p = this.paddle;
    if (dt <= 0) return;

    if (this.state === 'serveHold') {
      this.moveToward(add(this.serveHoldPos, { x: -this.side * 0.45, y: 0.05, z: this.side * 0.12 }), dt, this.restQuat);
      if (w.time >= this.serveAt) this.tossAndPlan();
      return;
    }

    if (this.pendingAt >= 0 && w.time >= this.pendingAt && this.state !== 'swing' && this.state !== 'serveToss') {
      this.pendingAt = -1;
      const plan = w.ballLive ? this.planReturn(this.pendingNoise) : null;
      if (plan) {
        this.plan = plan;
        this.state = 'approach';
      } else if (this.state === 'waiting') {
        this.state = 'recover';
      }
    }

    const plan = this.plan;
    if (plan && (this.state === 'approach' || this.state === 'serveToss' || this.state === 'swing')) {
      if (t1 < plan.tStart) {
        // travel to the start of the swing, limited by footwork / arm speed
        this.moveToward(plan.start, dt, plan.quat, plan.tStart - w.time);
        p.active = false;
        return;
      }
      if (this.state !== 'swing') {
        this.state = 'swing';
        // swing from wherever the paddle actually got to: arriving late means a mishit
        plan.start = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      }
      if (t1 <= plan.tEnd) {
        const k = t1 - plan.tStart;
        p.pos = add(plan.start, scale(plan.vel, k));
        p.quat = plan.quat;
        p.vel = plan.vel;
        p.angVel = { x: 0, y: 0, z: 0 };
        p.active = true;
        return;
      }
      this.plan = null;
      this.state = 'recover';
      p.active = false;
    }

    // recover / idle: drift back to the ready position
    p.active = false;
    this.moveToward(this.readyPos, dt, this.restQuat, 0, 0.6);
    if (this.state === 'recover' && len(sub(p.pos, this.readyPos)) < 0.03) this.state = 'ready';
  }

  private moveToward(target: Vec3, dt: number, q: Quat, timeLeft = 0, speedScale = 1): void {
    const p = this.paddle;
    const d = sub(target, p.pos);
    const dist = len(d);
    let speed = this.skill.moveSpeed * speedScale;
    if (timeLeft > dt) speed = Math.min(speed, Math.max(dist / timeLeft, speed * 0.35));
    const step = Math.min(dist, speed * dt);
    const v = dist > 1e-6 ? scale(d, step / dist / dt) : { x: 0, y: 0, z: 0 };
    p.pos = add(p.pos, scale(v, dt));
    p.vel = v;
    p.angVel = { x: 0, y: 0, z: 0 };
    p.quat = qSlerp(p.quat, q, clamp(dt * 9, 0, 1));
  }

  // ---------------------------------------------------------------- serving

  private tossAndPlan(): void {
    const w = this.world;
    const b = w.ball;
    b.pos = this.serveHoldPos;
    b.vel = { x: 0, y: 2.3, z: 0 }; // ~27 cm rise: a legal toss
    b.spin = { x: 0, y: 0, z: 0 };
    w.ballLive = true;
    this.hooks.tossed?.();
    this.state = 'serveToss';

    // strike it on the way down
    const hitY = b.pos.y + 0.06;
    const found: { ball: BallState | null; t: number } = { ball: null, t: 0 };
    predictFlight(b, 1.2, (s, t) => {
      if (s.vel.y < 0 && s.pos.y <= hitY) {
        found.ball = cloneBall(s);
        found.t = t;
        return true;
      }
      return false;
    });
    const plan = found.ball ? this.planServe(found.ball, w.time + found.t) : null;
    if (plan) this.plan = plan;
    else this.state = 'recover'; // ball simply drops: the rules handle the missed serve
  }

  private planServe(ballIn: BallState, tContact: number): Plan | null {
    const sk = this.skill;
    const s = this.side;
    const pers = this.profile.personality;
    const rng = this.rng;
    // try faster serves first for stronger players, fall back to safer ones
    const speeds = [3.4 + 2.6 * sk.pace * (0.8 + 0.4 * rng()), 4.2, 3.6, 3.0];
    const spinAmt = sk.spin * (pers === 'spin' ? 1.4 : 1);
    const kinds: Vec3[] = [
      { x: 0, y: -1.6 * spinAmt, z: 0 }, // backspin
      { x: (rng() < 0.5 ? -1 : 1) * 2.2 * spinAmt, y: -0.4 * spinAmt, z: 0 }, // sidespin
      { x: 0, y: 1.2 * spinAmt, z: 0 }, // topspin
      { x: 0, y: 0, z: 0 },
    ];
    const brush0 = pers === 'attacker' ? kinds[2] : pers === 'defender' ? kinds[0] : kinds[Math.floor(rng() * 3)];
    const tx = (rng() * 2 - 1) * (HALF_W - 0.25) * sk.placement;
    for (const brush of [brush0, kinds[3]]) {
      for (const speed of speeds) {
        for (const frac of [0.5, 0.62, 0.4, 0.72]) {
          const bz = s * HALF_L * frac;
          const bx = ballIn.pos.x + (tx - ballIn.pos.x) * 0.35;
          const d = Math.hypot(bx - ballIn.pos.x, bz - ballIn.pos.z, ballIn.pos.y - TABLE.height);
          let spinEst: Vec3 = { x: 0, y: 0, z: 0 };
          for (let pass = 0; pass < 2; pass++) {
            const v = solveLaunch(ballIn.pos, bx, bz, TABLE.height + BALL.radius, d / speed, spinEst);
            if (!v) break;
            const sol = solvePaddle(ballIn, v, brush);
            if (!sol || len(sol.vel) > sk.swingMax) break;
            spinEst = sol.out.spin;
            if (pass === 0) continue;
            // verify the whole serve with the real flight: own side, clear net, their side
            const fl = predictFlight(sol.out, 1.6, (_b, _t, ev) => ev.length >= 2);
            const [e1, e2] = fl.events;
            if (
              e1 &&
              e2 &&
              e1.type === 'table' &&
              e1.side === s &&
              e2.type === 'table' &&
              e2.side !== s &&
              Math.abs(e2.pos.x) < HALF_W - 0.1 &&
              Math.abs(e2.pos.z) < HALF_L - 0.12 &&
              Math.abs(e2.pos.z) > 0.25
            ) {
              this.lastShot = 'serve';
              // a serve is a rehearsed, unhurried stroke: far less error than a rally shot
              return this.makePlan(ballIn, tContact, sol.normal, sol.vel, 0.3);
            }
          }
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- returning

  private planReturn(noiseScale: number): Plan | null {
    const w = this.world;
    const s = this.side;
    const sk = this.skill;
    const pers = this.profile.personality;
    const rng = this.rng;

    // 1. read the incoming ball: find it after its bounce on our side
    const late = pers === 'defender' ? 0.1 : pers === 'attacker' ? 0.0 : 0.045;
    let bouncedAt = -1;
    let peakAt = -1;
    const found: { ball: BallState | null; t: number; dead: boolean } = { ball: null, t: 0, dead: false };
    predictFlight(w.ball, 2.2, (b, t, ev) => {
      if (bouncedAt < 0) {
        const last = ev[ev.length - 1];
        if (last) {
          if (last.type === 'floor' || last.type === 'tableSide') {
            found.dead = true;
            return true;
          }
          if (last.type === 'table' && last.side === s) bouncedAt = t;
        }
        if (ev.length > 3) {
          found.dead = true;
          return true;
        }
        return false;
      }
      // after the bounce
      if (ev[ev.length - 1].time > bouncedAt + 1e-6 && ev[ev.length - 1].type !== 'net') {
        // second contact before we could take it
        return true;
      }
      if (peakAt < 0 && b.vel.y <= 0) peakAt = t;
      const overTable = Math.abs(b.pos.z) < HALF_L;
      const take =
        (peakAt >= 0 && t >= peakAt + late) ||
        (peakAt >= 0 && overTable && b.pos.y < TABLE.height + 0.13) ||
        s * b.pos.z > HALF_L + 0.75;
      if (take || (peakAt >= 0 && b.pos.y < TABLE.height + 0.13)) {
        found.ball = cloneBall(b);
        found.t = t;
        return true;
      }
      return false;
    });
    if (found.dead || !found.ball) return null;
    const ballIn: BallState = found.ball;
    const tC = found.t;
    if (ballIn.pos.y < 0.35 || Math.abs(ballIn.pos.x) > HALF_W + 1.1) return null; // out of reach
    const tContact = w.time + tC;
    if (tC < 0.05) return null;

    // 2. choose the shot
    const height = ballIn.pos.y - TABLE.height;
    const oppPaddle = w.paddles.find((q) => q.owner !== s);
    let tx = (rng() * 2 - 1) * (HALF_W - 0.14) * sk.placement;
    let depth = 0.55 + 0.33 * rng();
    let speed = 6.4 * sk.pace;
    let brush: Vec3 = { x: 0, y: 1.6 * sk.spin, z: 0 };
    let shot = 'drive';
    const canSmash = height > 0.3 && s * ballIn.pos.z < HALF_L + 0.25 && rng() < sk.smash;

    switch (pers) {
      case 'defender':
        speed *= 0.78;
        depth = 0.68 + 0.22 * rng();
        tx *= 0.6;
        if (rng() < 0.75) {
          brush = { x: 0, y: -2.6 * sk.spin, z: 0 };
          shot = 'chop';
        } else {
          brush = { x: 0, y: 0, z: 0 };
          shot = 'block';
        }
        break;
      case 'attacker':
        speed *= 1.22;
        brush = { x: 0, y: 3.2 * sk.spin, z: 0 };
        shot = 'loop';
        break;
      case 'strategist': {
        // place it away from where the opponent is
        const ox = oppPaddle ? oppPaddle.pos.x : 0;
        const away = ox >= 0 ? -1 : 1;
        tx = away * (HALF_W - 0.14) * (0.45 + 0.55 * sk.placement) * (0.7 + 0.3 * rng());
        depth = rng() < 0.3 ? 0.38 + 0.12 * rng() : 0.72 + 0.18 * rng();
        if (depth < 0.55) {
          speed *= 0.7;
          brush = { x: 0, y: -1.5 * sk.spin, z: 0 };
          shot = 'drop';
        } else shot = 'placement';
        break;
      }
      case 'spin': {
        const r = rng();
        if (r < 0.4) {
          brush = { x: 0, y: 4.2 * sk.spin, z: 0 };
          shot = 'heavy topspin';
        } else if (r < 0.7) {
          brush = { x: 0, y: -3.4 * sk.spin, z: 0 };
          speed *= 0.8;
          shot = 'heavy backspin';
        } else {
          brush = { x: (rng() < 0.5 ? -1 : 1) * 3.6 * sk.spin, y: 1.2 * sk.spin, z: 0 };
          shot = 'sidespin';
        }
        break;
      }
    }
    if (canSmash && pers !== 'defender') {
      speed = (11 + 5 * sk.pace) * (pers === 'attacker' ? 1.1 : 1);
      brush = { x: 0, y: 0.6, z: 0 };
      depth = 0.6 + 0.25 * rng();
      shot = 'smash';
    }
    // backspin balls sitting low force a safer, slower lift
    if (height < 0.1) speed = Math.min(speed, 6.5);

    // 3. solve launch + paddle, lofting / slowing until the physics allows it
    const tz = -s * HALF_L * depth;
    const d = Math.hypot(tx - ballIn.pos.x, tz - ballIn.pos.z);
    let T = d / speed;
    for (let tries = 0; tries < 7; tries++, T *= 1.16) {
      let spinEst: Vec3 = { x: 0, y: 0, z: 0 };
      let sol = null;
      let ok = true;
      for (let pass = 0; pass < 2 && ok; pass++) {
        const v = solveLaunch(ballIn.pos, tx, tz, TABLE.height + BALL.radius, T, spinEst);
        if (!v) {
          ok = false;
          break;
        }
        sol = solvePaddle(ballIn, v, brush);
        if (!sol || len(sol.vel) > sk.swingMax) {
          ok = false;
          break;
        }
        spinEst = sol.out.spin;
      }
      if (!ok || !sol) {
        if (tries === 3) brush = scale(brush, 0.4); // give up on heavy spin before giving up the shot
        continue;
      }
      const land = flyToFirstContact(sol.out.pos, sol.out.vel, sol.out.spin).first;
      if (!land || land.type !== 'table' || land.side === s) continue;
      this.lastShot = shot;
      return this.makePlan(ballIn, tContact, sol.normal, sol.vel, noiseScale);
    }
    return null;
  }

  /** Turn an ideal contact into a swing, adding this player's human error. */
  private makePlan(ballIn: BallState, tContact: number, normal: Vec3, vel: Vec3, noiseScale: number): Plan {
    const sk = this.skill;
    const rng = this.rng;
    const k = noiseScale;
    // aiming error: tilt the face about two axes
    const helper = Math.abs(normal.y) < 0.9 ? UP : { x: 1, y: 0, z: 0 };
    const a1 = normalize(cross(helper, normal));
    const a2 = cross(normal, a1);
    const n = normalize(
      add(normal, add(scale(a1, gauss(rng) * sk.aimNoise * k), scale(a2, gauss(rng) * sk.aimNoise * k))),
    );
    const v = scale(vel, 1 + gauss(rng) * sk.speedNoise * k);
    const tC = tContact + gauss(rng) * sk.timingNoise * k;
    const speed = Math.max(len(v), 0.5);
    const tau = clamp(0.22 / speed, 0.035, 0.07);
    const centre = sub(ballIn.pos, scale(n, PADDLE.halfThickness + BALL.radius));
    const start = sub(centre, scale(v, tau));
    // keep the blade tip up and tilted away from the body for a natural look
    const tipHint = normalize({ x: -this.side * 0.25 * Math.sign(ballIn.pos.x || 1), y: 1, z: 0 });
    // strike with whichever face points at the ball: forehand (+Z) by default
    const quat = qFacing(n, tipHint);
    return { tContact: tC, tStart: tC - tau, tEnd: tC + tau, start, vel: v, quat };
  }
}

/** Blend helper for avatars that follow the AI paddle. */
export const mixVec = lerp;
