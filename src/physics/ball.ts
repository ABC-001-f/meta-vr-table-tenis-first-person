// Ball state and free-flight aerodynamics: gravity, quadratic drag, Magnus lift.
import { GRAVITY, K_DRAG, K_MAGNUS, AIR, BALL } from '../core/constants.ts';
import type { Vec3 } from '../core/math.ts';

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  /** angular velocity, rad/s */
  spin: Vec3;
}

export const makeBall = (): BallState => ({
  pos: { x: 0, y: 1, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  spin: { x: 0, y: 0, z: 0 },
});

export function cloneBall(b: BallState): BallState {
  return {
    pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z },
    vel: { x: b.vel.x, y: b.vel.y, z: b.vel.z },
    spin: { x: b.spin.x, y: b.spin.y, z: b.spin.z },
  };
}

export function copyBall(out: BallState, b: BallState): void {
  out.pos.x = b.pos.x;
  out.pos.y = b.pos.y;
  out.pos.z = b.pos.z;
  out.vel.x = b.vel.x;
  out.vel.y = b.vel.y;
  out.vel.z = b.vel.z;
  out.spin.x = b.spin.x;
  out.spin.y = b.spin.y;
  out.spin.z = b.spin.z;
}

function accel(vx: number, vy: number, vz: number, s: Vec3, out: Vec3): void {
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const kd = K_DRAG * speed;
  // Magnus: a = K (w x v)
  out.x = -kd * vx + K_MAGNUS * (s.y * vz - s.z * vy);
  out.y = -GRAVITY - kd * vy + K_MAGNUS * (s.z * vx - s.x * vz);
  out.z = -kd * vz + K_MAGNUS * (s.x * vy - s.y * vx);
}

const a1: Vec3 = { x: 0, y: 0, z: 0 };
const a2: Vec3 = { x: 0, y: 0, z: 0 };

/** Advance free flight by dt using a midpoint (RK2) step. Mutates the ball. */
export function integrateFlight(b: BallState, dt: number): void {
  const { pos, vel, spin } = b;
  accel(vel.x, vel.y, vel.z, spin, a1);
  const mx = vel.x + a1.x * dt * 0.5;
  const my = vel.y + a1.y * dt * 0.5;
  const mz = vel.z + a1.z * dt * 0.5;
  accel(mx, my, mz, spin, a2);
  pos.x += mx * dt;
  pos.y += my * dt;
  pos.z += mz * dt;
  vel.x += a2.x * dt;
  vel.y += a2.y * dt;
  vel.z += a2.z * dt;
  const decay = 1 - AIR.spinDecay * dt;
  spin.x *= decay;
  spin.y *= decay;
  spin.z *= decay;
}

export interface Surface {
  restitution: number;
  friction: number;
  tangentialRestitution: number;
}

/**
 * Impulsive collision of the ball with a surface of unit normal `n` (pointing
 * away from the surface toward the ball) whose contact point moves with
 * velocity `sv`. Coulomb friction with a grip (no-slip) limit for a hollow
 * sphere (I = 2/3 m r^2) couples linear velocity and spin, so topspin kicks
 * forward, backspin holds up, and a brushing paddle generates spin.
 * Returns the normal closing speed (>= 0), or -1 if the ball was separating.
 */
export function collide(b: BallState, n: Vec3, sv: Vec3, surf: Surface): number {
  const r = BALL.radius;
  const { vel, spin } = b;
  const rvx = vel.x - sv.x;
  const rvy = vel.y - sv.y;
  const rvz = vel.z - sv.z;
  const vn = rvx * n.x + rvy * n.y + rvz * n.z;
  if (vn >= 0) return -1;

  // velocity of the ball's contact point relative to the surface, tangential part
  // contact offset = -r n  ->  v_c = v_rel + w x (-r n)
  const wxn_x = spin.y * n.z - spin.z * n.y;
  const wxn_y = spin.z * n.x - spin.x * n.z;
  const wxn_z = spin.x * n.y - spin.y * n.x;
  const tx = rvx - vn * n.x - r * wxn_x;
  const ty = rvy - vn * n.y - r * wxn_y;
  const tz = rvz - vn * n.z - r * wxn_z;
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);

  // softer rebound at high impact speed (ball deformation)
  const e = surf.restitution * (1 - Math.min(0.18, 0.006 * -vn));
  const jn = -(1 + e) * vn; // normal velocity change

  let dvx = jn * n.x;
  let dvy = jn * n.y;
  let dvz = jn * n.z;

  if (tLen > 1e-9) {
    const slideLimit = surf.friction * jn;
    const gripLimit = 0.4 * (1 + surf.tangentialRestitution) * tLen;
    const jt = Math.min(slideLimit, gripLimit) / tLen;
    const fx = -tx * jt;
    const fy = -ty * jt;
    const fz = -tz * jt;
    dvx += fx;
    dvy += fy;
    dvz += fz;
    // dw = (r_c x J) / I = -(3 / (2 r)) (n x f)
    const k = -1.5 / r;
    spin.x += k * (n.y * fz - n.z * fy);
    spin.y += k * (n.z * fx - n.x * fz);
    spin.z += k * (n.x * fy - n.y * fx);
  }

  vel.x += dvx;
  vel.y += dvy;
  vel.z += dvz;
  return -vn;
}
