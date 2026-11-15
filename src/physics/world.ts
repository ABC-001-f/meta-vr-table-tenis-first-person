// Fixed-timestep table tennis physics world: one ball, the table, the net,
// the floor and any number of kinematic paddles (human-tracked or AI-driven).
// Every participant - player, AI, remote player - hits the ball through this
// same code path.
import { BALL, HALF_L, HALF_W, NET, PADDLE, PHYSICS_DT, SURFACES, TABLE } from '../core/constants.ts';
import type { Side } from '../core/constants.ts';
import { cross, lerp, qConj, qRotate, qSlerp } from '../core/math.ts';
import type { Quat, Vec3 } from '../core/math.ts';
import { collide, integrateFlight, makeBall } from './ball.ts';
import type { BallState } from './ball.ts';

export interface PaddleBody {
  owner: Side;
  active: boolean;
  /** blade centre + orientation. Local +Z is the forehand face normal,
   *  local +Y runs from the handle toward the blade tip. */
  pos: Vec3;
  quat: Quat;
  prevPos: Vec3;
  prevQuat: Quat;
  /** velocity of the blade centre and angular velocity, world frame */
  vel: Vec3;
  angVel: Vec3;
  cooldown: number;
}

export function makePaddle(owner: Side): PaddleBody {
  return {
    owner,
    active: false,
    pos: { x: 0, y: 1, z: owner * 1.6 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    prevPos: { x: 0, y: 1, z: owner * 1.6 },
    prevQuat: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    cooldown: 0,
  };
}

export type PhysEventType = 'table' | 'tableSide' | 'net' | 'floor' | 'paddle';

export interface PhysEvent {
  type: PhysEventType;
  time: number;
  pos: Vec3;
  /** closing speed along the contact normal, m/s */
  impact: number;
  /** table: which half was hit. paddle: whose paddle. */
  side?: Side;
  /** table: top-edge contact */
  edge?: boolean;
  /** paddle: contact point on the blade (local x, y in metres) and face (+1 forehand) */
  bladeX?: number;
  bladeY?: number;
  face?: 1 | -1;
  /** paddle: speed of the blade at the contact point */
  paddleSpeed?: number;
  /** ball state right after the contact */
  velAfter?: Vec3;
  spinAfter?: Vec3;
}

const NET_HALF_SPAN = HALF_W + NET.overhang;
const NET_TOP = TABLE.height + NET.height;
const TABLE_BOTTOM = TABLE.height - TABLE.thickness;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const R = BALL.radius;

export class PhysicsWorld {
  ball: BallState = makeBall();
  /** when false the ball is held (serve) and is not simulated */
  ballLive = false;
  paddles: PaddleBody[] = [];
  time = 0;
  /** multiplies real time; < 1 gives slow motion without changing the step size */
  timeScale = 1;
  onEvent: ((e: PhysEvent) => void) | null = null;
  private acc = 0;

  addPaddle(p: PaddleBody): PaddleBody {
    this.paddles.push(p);
    return p;
  }

  /** Advance by a variable frame time using fixed sub-steps. Paddle poses are
   *  interpolated from their previous to their current pose across the frame. */
  advance(frameDt: number): number {
    this.acc += Math.min(frameDt, 0.1) * this.timeScale;
    const n = Math.floor(this.acc / PHYSICS_DT);
    if (n <= 0) return 0;
    this.acc -= n * PHYSICS_DT;
    for (let i = 0; i < n; i++) this.substep(i / n, (i + 1) / n);
    for (const p of this.paddles) {
      p.prevPos = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      p.prevQuat = { x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w };
    }
    return n;
  }

  /** Single fixed step with paddles treated as static at their current pose. */
  stepFixed(): void {
    this.substep(1, 1);
  }

  private emit(e: PhysEvent): void {
    if (this.onEvent) {
      e.velAfter = { x: this.ball.vel.x, y: this.ball.vel.y, z: this.ball.vel.z };
      e.spinAfter = { x: this.ball.spin.x, y: this.ball.spin.y, z: this.ball.spin.z };
      this.onEvent(e);
    }
  }

  private substep(a0: number, a1: number): void {
    const dt = PHYSICS_DT;
    this.time += dt;
    for (const p of this.paddles) if (p.cooldown > 0) p.cooldown -= dt;
    if (!this.ballLive) return;
    const b = this.ball;
    const p0x = b.pos.x,
      p0y = b.pos.y,
      p0z = b.pos.z;
    integrateFlight(b, dt);

    for (const p of this.paddles) {
      if (p.active && p.cooldown <= 0) this.collidePaddle(p, p0x, p0y, p0z, a0, a1);
    }
    this.collideNet(p0x, p0y, p0z);
    this.collideTable(p0y);
    this.collideFloor();
  }

  private collidePaddle(p: PaddleBody, p0x: number, p0y: number, p0z: number, a0: number, a1: number): void {
    const b = this.ball;
    const P0 = a0 === a1 ? p.pos : lerp(p.prevPos, p.pos, a0);
    const Q0 = a0 === a1 ? p.quat : qSlerp(p.prevQuat, p.quat, a0);
    const P1 = a1 >= 1 ? p.pos : lerp(p.prevPos, p.pos, a1);
    const Q1 = a1 >= 1 ? p.quat : qSlerp(p.prevQuat, p.quat, a1);
    // cheap reject
    const dx = b.pos.x - P1.x,
      dy = b.pos.y - P1.y,
      dz = b.pos.z - P1.z;
    if (dx * dx + dy * dy + dz * dz > 0.09) return;

    const l0 = qRotate(qConj(Q0), { x: p0x - P0.x, y: p0y - P0.y, z: p0z - P0.z });
    const l1 = qRotate(qConj(Q1), { x: dx, y: dy, z: dz });
    const h = PADDLE.halfThickness + R;
    const d0 = l0.z,
      d1 = l1.z;
    let face: 1 | -1;
    let t: number;
    if (d0 >= h && d1 < h) {
      face = 1;
      t = (d0 - h) / (d0 - d1);
    } else if (d0 <= -h && d1 > -h) {
      face = -1;
      t = (-h - d0) / (d1 - d0);
    } else if (Math.abs(d0) < h && Math.abs(d1) < Math.abs(d0)) {
      face = d0 >= 0 ? 1 : -1;
      t = 0;
    } else return;

    const cx = l0.x + (l1.x - l0.x) * t;
    const cy = l0.y + (l1.y - l0.y) * t;
    const m = R * 0.5;
    const ex = cx / (PADDLE.bladeRadiusX + m);
    const ey = cy / (PADDLE.bladeRadiusY + m);
    if (ex * ex + ey * ey > 1) return;

    const n = qRotate(Q1, { x: 0, y: 0, z: face });
    const arm = qRotate(Q1, { x: cx, y: cy, z: 0 });
    const w = cross(p.angVel, arm);
    const sv = { x: p.vel.x + w.x, y: p.vel.y + w.y, z: p.vel.z + w.z };
    const impact = collide(b, n, sv, SURFACES.rubber);
    // place the ball just outside the struck face
    const out = qRotate(Q1, { x: l1.x, y: l1.y, z: face * (h + 1e-4) });
    b.pos.x = P1.x + out.x;
    b.pos.y = P1.y + out.y;
    b.pos.z = P1.z + out.z;
    if (impact < 0) return;
    p.cooldown = 0.06;
    this.emit({
      type: 'paddle',
      time: this.time,
      pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z },
      impact,
      side: p.owner,
      bladeX: cx,
      bladeY: cy,
      face,
      paddleSpeed: Math.hypot(sv.x, sv.y, sv.z),
    });
  }

  private collideNet(p0x: number, p0y: number, p0z: number): void {
    const b = this.ball;
    const pos = b.pos;
    if (Math.abs(pos.z) > 0.2 && pos.z * p0z > 0) return;
    const ht = NET.halfThickness;
    let n: Vec3 | null = null;
    if (p0z * pos.z < 0 || Math.abs(pos.z) <= ht) {
      // the centre crossed (or sits in) the net plane this step: swept test
      // against the net face so a fast ball is stopped on the side it came from
      const denom = p0z - pos.z;
      const t = Math.abs(denom) > 1e-12 ? Math.min(1, Math.max(0, p0z / denom)) : 0;
      const yx = p0y + (pos.y - p0y) * t;
      const xx = p0x + (pos.x - p0x) * t;
      if (yx > TABLE.height - R && yx < NET_TOP && Math.abs(xx) < NET_HALF_SPAN) {
        const s = p0z >= 0 ? 1 : -1;
        n = { x: 0, y: 0, z: s };
        pos.x = xx;
        pos.y = yx;
        pos.z = s * (ht + R + 1e-5);
      }
    }
    if (!n) {
      // closest point on the net slab (face grazes, tape and post ends)
      const cx = pos.x < -NET_HALF_SPAN ? -NET_HALF_SPAN : pos.x > NET_HALF_SPAN ? NET_HALF_SPAN : pos.x;
      const cy = pos.y < TABLE.height ? TABLE.height : pos.y > NET_TOP ? NET_TOP : pos.y;
      const cz = pos.z < -ht ? -ht : pos.z > ht ? ht : pos.z;
      const dx = pos.x - cx,
        dy = pos.y - cy,
        dz = pos.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R * R && d2 > 1e-12) {
        const d = Math.sqrt(d2);
        n = { x: dx / d, y: dy / d, z: dz / d };
        pos.x = cx + n.x * (R + 1e-5);
        pos.y = cy + n.y * (R + 1e-5);
        pos.z = cz + n.z * (R + 1e-5);
      }
    }
    if (!n) return;
    const impact = collide(b, n, ZERO, SURFACES.net);
    if (impact > 0.05) {
      // the mesh soaks up energy and spin
      b.spin.x *= 0.5;
      b.spin.y *= 0.5;
      b.spin.z *= 0.5;
      this.emit({ type: 'net', time: this.time, pos: { x: pos.x, y: pos.y, z: pos.z }, impact });
    }
  }

  private collideTable(p0y: number): void {
    const b = this.ball;
    const pos = b.pos;
    if (pos.y > TABLE.height + R || pos.y < TABLE_BOTTOM - R) return;
    if (Math.abs(pos.x) > HALF_W + R || Math.abs(pos.z) > HALF_L + R) return;
    const cx = pos.x < -HALF_W ? -HALF_W : pos.x > HALF_W ? HALF_W : pos.x;
    const cy = pos.y < TABLE_BOTTOM ? TABLE_BOTTOM : pos.y > TABLE.height ? TABLE.height : pos.y;
    const cz = pos.z < -HALF_L ? -HALF_L : pos.z > HALF_L ? HALF_L : pos.z;
    const dx = pos.x - cx,
      dy = pos.y - cy,
      dz = pos.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= R * R) return;
    let n: Vec3;
    let type: PhysEventType = 'table';
    let edge = false;
    if (d2 < 1e-12) {
      // centre inside the slab: resolve vertically toward where it came from
      const up = p0y >= TABLE.height - TABLE.thickness / 2;
      n = { x: 0, y: up ? 1 : -1, z: 0 };
      pos.y = up ? TABLE.height + R + 1e-5 : TABLE_BOTTOM - R - 1e-5;
      if (!up) type = 'tableSide';
    } else {
      const d = Math.sqrt(d2);
      n = { x: dx / d, y: dy / d, z: dz / d };
      pos.x = cx + n.x * (R + 1e-5);
      pos.y = cy + n.y * (R + 1e-5);
      pos.z = cz + n.z * (R + 1e-5);
      const onTopLevel = cy >= TABLE.height;
      // ball centre is over the table footprint -> the contact is on the flat top
      const interior = dx === 0 && dz === 0;
      if (onTopLevel && interior) {
        // flat top
      } else if (onTopLevel && n.y > 0.08) {
        edge = true; // top edge: a legal "edge ball"
      } else {
        type = 'tableSide';
      }
    }
    const vn = b.vel.x * n.x + b.vel.y * n.y + b.vel.z * n.z;
    if (vn > -0.25 && type === 'table' && !edge) {
      // resting / rolling contact: kill the normal velocity, apply rolling drag
      if (vn < 0) {
        b.vel.y -= vn * n.y;
      }
      const k = 1 - 1.5 * PHYSICS_DT;
      b.vel.x *= k;
      b.vel.z *= k;
      b.spin.x *= k;
      b.spin.z *= k;
      return;
    }
    const impact = collide(b, n, ZERO, SURFACES.table);
    if (impact < 0) return;
    this.emit({
      type,
      time: this.time,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      impact,
      side: pos.z >= 0 ? 1 : -1,
      edge,
    });
  }

  private collideFloor(): void {
    const b = this.ball;
    if (b.pos.y >= R) return;
    b.pos.y = R;
    if (b.vel.y > -0.3) {
      if (b.vel.y < 0) b.vel.y = 0;
      const k = 1 - 2.5 * PHYSICS_DT;
      b.vel.x *= k;
      b.vel.z *= k;
      b.spin.x *= k;
      b.spin.y *= k;
      b.spin.z *= k;
      return;
    }
    const impact = collide(b, { x: 0, y: 1, z: 0 }, ZERO, SURFACES.floor);
    this.emit({ type: 'floor', time: this.time, pos: { x: b.pos.x, y: R, z: b.pos.z }, impact });
  }
}

export interface FlightSample {
  events: PhysEvent[];
  /** sampled positions (every `sampleEvery` steps) for trajectory display */
  path: Vec3[];
}

/**
 * Deterministically predict a ball's flight against the table, net and floor
 * (no paddles). Used by the AI to read the incoming ball and plan shots, and
 * by the trajectory analysis display. `stop` may end the prediction early.
 */
export function predictFlight(
  start: BallState,
  maxTime: number,
  stop?: (b: BallState, t: number, events: PhysEvent[]) => boolean,
  sampleEvery = 0,
): FlightSample {
  const w = scratch;
  w.ball.pos.x = start.pos.x;
  w.ball.pos.y = start.pos.y;
  w.ball.pos.z = start.pos.z;
  w.ball.vel.x = start.vel.x;
  w.ball.vel.y = start.vel.y;
  w.ball.vel.z = start.vel.z;
  w.ball.spin.x = start.spin.x;
  w.ball.spin.y = start.spin.y;
  w.ball.spin.z = start.spin.z;
  w.ballLive = true;
  w.time = 0;
  const events: PhysEvent[] = [];
  const path: Vec3[] = [];
  w.onEvent = (e) => events.push(e);
  const steps = Math.ceil(maxTime / PHYSICS_DT);
  for (let i = 0; i < steps; i++) {
    w.stepFixed();
    if (sampleEvery > 0 && i % sampleEvery === 0) path.push({ x: w.ball.pos.x, y: w.ball.pos.y, z: w.ball.pos.z });
    if (stop && stop(w.ball, w.time, events)) break;
  }
  return { events, path };
}

const scratch = new PhysicsWorld();
/** Ball state of the scratch world after the last predictFlight call. */
export const predictedBall = (): BallState => scratch.ball;
