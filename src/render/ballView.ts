// Ball visuals: the ball itself (with a printed mark so spin is visible), a
// contact shadow for depth perception, a motion trail, a spin-axis ring and a
// predicted-trajectory line.
import * as THREE from './three.ts';
import { BALL, HALF_L, HALF_W, TABLE } from '../core/constants.ts';
import type { Vec3 } from '../core/math.ts';
import type { BallState } from '../physics/ball.ts';
import { font } from '../hud/fonts.ts';

const TRAIL = 22;

function ballTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff6e6';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#e8590c';
  g.fillRect(0, 29, 128, 6); // equator band
  g.fillStyle = '#1b3a8a';
  g.font = font(700, 13);
  g.textAlign = 'center';
  g.fillText('PV 40+', 32, 22);
  g.fillText('***', 96, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export type SpinKind = 'flat' | 'topspin' | 'backspin' | 'sidespin';

/** Classify spin relative to the direction of travel. */
export function classifySpin(vel: Vec3, spin: Vec3): { kind: SpinKind; rpm: number } {
  const mag = Math.hypot(spin.x, spin.y, spin.z);
  const rpm = (mag * 60) / (2 * Math.PI);
  const h = Math.hypot(vel.x, vel.z);
  if (rpm < 300 || h < 0.3) return { kind: 'flat', rpm };
  // topspin axis for travel direction f is up x f
  const fx = vel.x / h,
    fz = vel.z / h;
  const top = spin.x * fz + spin.z * -fx; // dot(spin, up x f) = dot(spin, (fz, 0, -fx))
  const side = Math.abs(spin.y);
  if (side > Math.abs(top) * 1.2) return { kind: 'sidespin', rpm };
  return { kind: top > 0 ? 'topspin' : 'backspin', rpm };
}

export const SPIN_COLOR: Record<SpinKind, number> = {
  flat: 0xffffff,
  topspin: 0xff5a36,
  backspin: 0x3aa0ff,
  sidespin: 0x4be08a,
};

export class BallView {
  group = new THREE.Group();
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  ring: THREE.Mesh;
  showSpin = true;
  showTrail = true;
  private trail: THREE.Line;
  private trailPos: Float32Array;
  private trailCol: Float32Array;
  private trailN = 0;
  private path: THREE.Line;
  private pathLife = 0;
  private landing: THREE.Mesh;
  private dq = new THREE.Quaternion();
  private axis = new THREE.Vector3();
  private yAxis = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius, 20, 14),
      new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.45, metalness: 0, emissive: 0x332a1e, emissiveIntensity: 0.35 }),
    );
    this.group.add(this.mesh);

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL.radius * 1.15, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.group.add(this.shadow);

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(BALL.radius * 1.7, 0.0025, 6, 28, Math.PI * 1.6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.ring.visible = false;
    this.group.add(this.ring);

    this.trailPos = new Float32Array(TRAIL * 3);
    this.trailCol = new Float32Array(TRAIL * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3));
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.trail.frustumCulled = false;
    this.group.add(this.trail);

    this.path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.85, depthWrite: false }));
    this.path.frustumCulled = false;
    this.path.visible = false;
    this.group.add(this.path);

    this.landing = new THREE.Mesh(
      new THREE.RingGeometry(0.03, 0.042, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
    );
    this.landing.rotation.x = -Math.PI / 2;
    this.landing.visible = false;
    this.group.add(this.landing);
  }

  /** Show a predicted / analysed path for a few seconds. */
  setTrajectory(points: Vec3[], landing: Vec3 | null, color = 0xffe066): void {
    const arr = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    });
    this.path.geometry.dispose();
    this.path.geometry = new THREE.BufferGeometry();
    this.path.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    (this.path.material as THREE.LineBasicMaterial).color.setHex(color);
    this.path.visible = points.length > 1;
    this.pathLife = 2.6;
    if (landing) {
      this.landing.position.set(landing.x, landing.y - BALL.radius + 0.0012, landing.z);
      this.landing.visible = true;
    } else this.landing.visible = false;
  }

  clearTrail(): void {
    this.trailN = 0;
  }

  /** `simDt` drives the visible rotation, so slow motion slows the spin too. */
  update(b: BallState, visible: boolean, simDt: number, dt: number): void {
    this.mesh.visible = visible;
    this.shadow.visible = visible;
    if (this.pathLife > 0) {
      this.pathLife -= dt;
      const o = Math.min(1, this.pathLife / 0.6);
      (this.path.material as THREE.LineBasicMaterial).opacity = 0.85 * o;
      (this.landing.material as THREE.MeshBasicMaterial).opacity = 0.9 * o;
      if (this.pathLife <= 0) {
        this.path.visible = false;
        this.landing.visible = false;
      }
    }
    if (!visible) {
      this.ring.visible = false;
      this.trail.visible = false;
      return;
    }
    const p = b.pos;
    this.mesh.position.set(p.x, p.y, p.z);

    // spin the mesh with the real angular velocity
    const w = Math.hypot(b.spin.x, b.spin.y, b.spin.z);
    if (w > 0.5 && simDt > 0) {
      this.axis.set(b.spin.x / w, b.spin.y / w, b.spin.z / w);
      this.dq.setFromAxisAngle(this.axis, w * simDt);
      this.mesh.quaternion.premultiply(this.dq);
    }

    // shadow on the table when over it, else on the floor
    const over = Math.abs(p.x) <= HALF_W && Math.abs(p.z) <= HALF_L && p.y >= TABLE.height;
    const ground = over ? TABLE.height : 0;
    const h = Math.max(0, p.y - ground - BALL.radius);
    this.shadow.position.set(p.x, ground + 0.0012, p.z);
    const s = 1 + h * 1.8;
    this.shadow.scale.set(s, s, 1);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.06, 0.5 - h * 0.45);

    const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    const sp = classifySpin(b.vel, b.spin);
    this.ring.visible = this.showSpin && sp.kind !== 'flat';
    if (this.ring.visible) {
      this.ring.position.copy(this.mesh.position);
      this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.axis);
      this.ring.rotateZ(performance.now() * 0.004 * Math.min(3, w / 100));
      (this.ring.material as THREE.MeshBasicMaterial).color.setHex(SPIN_COLOR[sp.kind]);
    }

    // trail
    this.trail.visible = this.showTrail && speed > 2.5;
    const tp = this.trailPos;
    tp.copyWithin(3, 0, (TRAIL - 1) * 3);
    tp[0] = p.x;
    tp[1] = p.y;
    tp[2] = p.z;
    if (this.trailN < TRAIL) {
      this.trailN++;
      for (let i = this.trailN; i < TRAIL; i++) {
        tp[i * 3] = p.x;
        tp[i * 3 + 1] = p.y;
        tp[i * 3 + 2] = p.z;
      }
    }
    const col = new THREE.Color(SPIN_COLOR[sp.kind]);
    const k = Math.min(1, speed / 12);
    for (let i = 0; i < TRAIL; i++) {
      const f = (1 - i / TRAIL) * k;
      this.trailCol[i * 3] = col.r * f;
      this.trailCol[i * 3 + 1] = col.g * f;
      this.trailCol[i * 3 + 2] = col.b * f;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.color.needsUpdate = true;
    void this.yAxis;
  }
}
