// Minimal dependency-free vector / quaternion math used by the simulation core,
// so physics, rules and AI can run headless (tests, server) without a renderer.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const copy = (out: Vec3, a: Vec3): Vec3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
});
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });
export const qClone = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

export function qNormalize(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

export function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export const qConj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export function qRotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w(u x v) + 2u x (u x v)
  const ux = q.x,
    uy = q.y,
    uz = q.z;
  const cx = uy * v.z - uz * v.y;
  const cy = uz * v.x - ux * v.z;
  const cz = ux * v.y - uy * v.x;
  return {
    x: v.x + 2 * (q.w * cx + uy * cz - uz * cy),
    y: v.y + 2 * (q.w * cy + uz * cx - ux * cz),
    z: v.z + 2 * (q.w * cz + ux * cy - uy * cx),
  };
}

export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x,
    by = b.y,
    bz = b.z,
    bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return qNormalize({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    });
  }
  const th = Math.acos(cos);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
}

export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  const n = normalize(axis);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) };
}

/** Shortest rotation taking unit vector `from` onto unit vector `to`. */
export function qFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = dot(from, to);
  if (d < -0.999999) {
    let axis = cross({ x: 1, y: 0, z: 0 }, from);
    if (len(axis) < 1e-6) axis = cross({ x: 0, y: 1, z: 0 }, from);
    return qFromAxisAngle(axis, Math.PI);
  }
  const c = cross(from, to);
  return qNormalize({ x: c.x, y: c.y, z: c.z, w: 1 + d });
}

/** Quaternion from an orthonormal right-handed basis (columns x, y, z). */
export function qFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x.x,
    m01 = y.x,
    m02 = z.x;
  const m10 = x.y,
    m11 = y.y,
    m12 = z.y;
  const m20 = x.z,
    m21 = y.z,
    m22 = z.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
  }
  return qNormalize(q);
}

/** Paddle orientation whose face normal (local +Z) is `n`, blade tip (local +Y) as close to `upHint` as possible. */
export function qFacing(n: Vec3, upHint: Vec3): Quat {
  const z = normalize(n);
  let y = sub(upHint, scale(z, dot(upHint, z)));
  if (len(y) < 1e-4) y = sub({ x: 1, y: 0, z: 0 }, scale(z, z.x));
  y = normalize(y);
  const x = cross(y, z);
  return qFromBasis(x, y, z);
}

/** Angular velocity (rad/s) that rotates q0 into q1 over dt. */
export function angularVelocity(q0: Quat, q1: Quat, dt: number): Vec3 {
  let d = qMul(q1, qConj(q0));
  if (d.w < 0) d = { x: -d.x, y: -d.y, z: -d.z, w: -d.w };
  const s = Math.hypot(d.x, d.y, d.z);
  if (s < 1e-9 || dt <= 0) return { x: 0, y: 0, z: 0 };
  const angle = 2 * Math.atan2(s, d.w);
  const k = angle / (s * dt);
  return { x: d.x * k, y: d.y * k, z: d.z * k };
}

/** Deterministic PRNG (mulberry32) so AI and tests are reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const gauss = (rng: () => number): number => {
  // Box-Muller
  const u = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};
