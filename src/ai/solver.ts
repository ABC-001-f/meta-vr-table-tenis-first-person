// Shot solving used by the AI: find the launch velocity that lands on a target
// and the paddle motion that produces that launch. Everything is evaluated
// with the real collision and flight code, so the AI can only make shots the
// physics actually allows.
import { GRAVITY, SURFACES } from '../core/constants.ts';
import { add, cross, dot, len, normalize, scale, sub } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { cloneBall, collide } from '../physics/ball.ts';
import type { BallState } from '../physics/ball.ts';
import { predictFlight } from '../physics/world.ts';
import type { PhysEvent } from '../physics/world.ts';

export interface Landing {
  /** first surface contact of the flight */
  first: PhysEvent | null;
  events: PhysEvent[];
}

export function flyToFirstContact(pos: Vec3, vel: Vec3, spin: Vec3, maxTime = 1.6): Landing {
  const r = predictFlight({ pos, vel, spin }, maxTime, (_b, _t, ev) => ev.length > 0);
  return { first: r.events[0] ?? null, events: r.events };
}

/**
 * Launch velocity from `from` that makes the ball's first contact land at
 * (tx, tz) on the table after roughly `T` seconds, for a ball carrying `spin`.
 * Starts from the vacuum solution and corrects for drag and Magnus by shooting.
 * Returns null when the flight clips the net or cannot reach the table.
 */
export function solveLaunch(
  from: Vec3,
  tx: number,
  tz: number,
  ty: number,
  T: number,
  spin: Vec3,
): Vec3 | null {
  let ax = tx,
    az = tz;
  let v: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 5; i++) {
    v = {
      x: (ax - from.x) / T,
      y: (ty - from.y + 0.5 * GRAVITY * T * T) / T,
      z: (az - from.z) / T,
    };
    // compensate average drag loss roughly so the first shot is close
    const land = flyToFirstContact(from, v, spin, T * 2 + 0.5).first;
    if (!land) return null;
    if (land.type !== 'table') {
      if (land.type === 'net') return null;
      // fell short / long onto the floor: use where it crossed to correct anyway
    }
    const ex = land.pos.x - tx;
    const ez = land.pos.z - tz;
    if (land.type === 'table' && Math.abs(ex) < 0.02 && Math.abs(ez) < 0.02) return v;
    ax -= ex * 0.9;
    az -= ez * 0.9;
    if (Math.abs(ax - tx) > 3 || Math.abs(az - tz) > 3) return null;
  }
  const check = flyToFirstContact(from, v, spin, T * 2 + 0.5).first;
  if (check && check.type === 'table' && Math.abs(check.pos.x - tx) < 0.12 && Math.abs(check.pos.z - tz) < 0.15) return v;
  return null;
}

export interface PaddleSolution {
  normal: Vec3;
  /** paddle velocity at contact */
  vel: Vec3;
  /** ball state right after contact */
  out: BallState;
  residual: number;
}

function strike(ballIn: BallState, n: Vec3, vp: Vec3): BallState | null {
  const b = cloneBall(ballIn);
  return collide(b, n, vp, SURFACES.rubber) < 0 ? null : b;
}

function solve3(m: number[][], r: number[]): number[] | null {
  const [a, b, c] = m;
  const det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(det) < 1e-10) return null;
  const dx =
    r[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (r[1] * c[2] - b[2] * r[2]) + a[2] * (r[1] * c[1] - b[1] * r[2]);
  const dy =
    a[0] * (r[1] * c[2] - b[2] * r[2]) - r[0] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * r[2] - r[1] * c[0]);
  const dz =
    a[0] * (b[1] * r[2] - r[1] * c[1]) - a[1] * (b[0] * r[2] - r[1] * c[0]) + r[0] * (b[0] * c[1] - b[1] * c[0]);
  return [dx / det, dy / det, dz / det];
}

/**
 * Find the paddle face normal and velocity that turn the incoming ball into
 * one leaving with velocity `vOut`. `brush` is the stroke's tangential motion
 * (world frame) - upward for topspin, downward for backspin, sideways for
 * sidespin; it is projected onto the paddle plane. Newton iteration on the
 * real collision function, starting from the frictionless mirror solution.
 */
export function solvePaddle(ballIn: BallState, vOut: Vec3, brush: Vec3): PaddleSolution | null {
  const e = SURFACES.rubber.restitution;
  const n0 = normalize(sub(vOut, ballIn.vel));
  if (len(n0) < 0.5) return null;
  const helper = Math.abs(n0.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const t1 = normalize(cross(helper, n0));
  const t2 = cross(n0, t1);

  const build = (u: number[]): { n: Vec3; vp: Vec3 } => {
    const n = normalize(add(n0, add(scale(t1, u[0]), scale(t2, u[1]))));
    const bt = sub(brush, scale(n, dot(brush, n)));
    return { n, vp: add(scale(n, u[2]), bt) };
  };
  const residual = (u: number[]): { r: number[]; out: BallState | null } => {
    const { n, vp } = build(u);
    const out = strike(ballIn, n, vp);
    if (!out) return { r: [9, 9, 9], out: null };
    return { r: [out.vel.x - vOut.x, out.vel.y - vOut.y, out.vel.z - vOut.z], out };
  };

  let u = [0, 0, (dot(vOut, n0) + e * dot(ballIn.vel, n0)) / (1 + e)];
  let best: { u: number[]; err: number; out: BallState | null } = { u, err: Infinity, out: null };
  const eps = [1e-3, 1e-3, 1e-2];
  for (let it = 0; it < 10; it++) {
    const f = residual(u);
    const err = Math.hypot(f.r[0], f.r[1], f.r[2]);
    if (f.out && err < best.err) best = { u: [...u], err, out: f.out };
    if (err < 0.02) break;
    const J: number[][] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let k = 0; k < 3; k++) {
      const up = [...u];
      up[k] += eps[k];
      const g = residual(up);
      for (let i = 0; i < 3; i++) J[i][k] = (g.r[i] - f.r[i]) / eps[k];
    }
    const d = solve3(J, [-f.r[0], -f.r[1], -f.r[2]]);
    if (!d) break;
    u = [
      u[0] + Math.max(-0.3, Math.min(0.3, d[0])),
      u[1] + Math.max(-0.3, Math.min(0.3, d[1])),
      u[2] + Math.max(-4, Math.min(4, d[2])),
    ];
  }
  if (!best.out || best.err > 0.6) return null;
  const { n, vp } = build(best.u);
  return { normal: n, vel: vp, out: best.out, residual: best.err };
}
