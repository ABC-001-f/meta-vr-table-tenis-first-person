// Hand tracking. Reads WebXR hand joints straight from the XR frame every
// render frame (lowest latency), converts them into table space, and derives
// palm frame, pinch, grab curl and fingertip positions for each hand.
// Controllers are supported as a fallback and a mouse-driven hand exists for
// desktop testing, but the game is designed for bare hands.
import * as THREE from '../render/three.ts';
import { HALF_L, TABLE } from '../core/constants.ts';

export const JOINT_COUNT = 25;
// XRHand joint indices
const WRIST = 0,
  THUMB_TIP = 4,
  INDEX_PROX = 6,
  INDEX_TIP = 9,
  MIDDLE_PROX = 11,
  MIDDLE_TIP = 14,
  RING_TIP = 19,
  PINKY_PROX = 21,
  PINKY_TIP = 24;

export const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8], [8, 9],
  [0, 10], [10, 11], [11, 12], [12, 13], [13, 14],
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19],
  [0, 20], [20, 21], [21, 22], [22, 23], [23, 24],
  [6, 11], [11, 16], [16, 21],
];

export type Handed = 'left' | 'right';

export class HandData {
  handed: Handed;
  tracked = false;
  /** seconds since last tracked */
  lost = 99;
  source: 'hand' | 'controller' | 'mouse' = 'hand';
  /** joint positions in table space */
  joints = new Float32Array(JOINT_COUNT * 3);
  wrist = new THREE.Vector3();
  /** centre of the grip (where a handle sits in the palm) */
  palm = new THREE.Vector3();
  /** unit vector out of the palm */
  palmNormal = new THREE.Vector3(0, 0, -1);
  /** unit vector pinky -> index (toward the thumb side) */
  across = new THREE.Vector3(0, 1, 0);
  /** unit vector wrist -> fingers */
  fingers = new THREE.Vector3(0, 0, -1);
  indexTip = new THREE.Vector3();
  thumbTip = new THREE.Vector3();
  palmVel = new THREE.Vector3();
  pinch = false;
  /** 0 = open hand, 1 = fist */
  grab = 0;
  private prevPalm = new THREE.Vector3();
  private hadPrev = false;

  constructor(handed: Handed) {
    this.handed = handed;
  }

  joint(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.fromArray(this.joints, i * 3);
  }

  /** finish a frame: velocities and tracking timers */
  commit(tracked: boolean, dt: number): void {
    if (tracked) {
      if (this.hadPrev && dt > 0 && this.lost < 0.1) {
        _v.subVectors(this.palm, this.prevPalm).multiplyScalar(1 / dt);
        this.palmVel.lerp(_v, 0.5);
      } else this.palmVel.set(0, 0, 0);
      this.prevPalm.copy(this.palm);
      this.hadPrev = true;
      this.lost = 0;
    } else {
      this.lost += dt;
      this.palmVel.set(0, 0, 0);
    }
    this.tracked = tracked;
  }
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _inv = new THREE.Matrix4();

export class HandTracker {
  left = new HandData('left');
  right = new HandData('right');
  /** head pose in table space */
  headPos = new THREE.Vector3(0, 1.6, HALF_L + 0.9);
  headQuat = new THREE.Quaternion();
  inXR = false;
  private poses = new Float32Array(JOINT_COUNT * 16);
  private mouse = { x: 0, y: 0.35, active: false };

  hand(h: Handed): HandData {
    return h === 'left' ? this.left : this.right;
  }

  /** Desktop fallback: drive the right "hand" with the mouse. */
  attachMouse(el: HTMLElement): void {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouse.y = 1 - (e.clientY - r.top) / r.height;
      this.mouse.active = true;
    });
  }

  /**
   * @param tableRoot the Object3D whose local frame is table space
   */
  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera, tableRoot: THREE.Object3D, dt: number, mouseHand: Handed): void {
    const xr = renderer.xr;
    const session = xr.isPresenting ? xr.getSession() : null;
    const frame = session ? (xr.getFrame() as XRFrame | null) : null;
    const ref = session ? xr.getReferenceSpace() : null;
    this.inXR = !!session;

    // table space <- world
    tableRoot.updateWorldMatrix(true, false);
    _inv.copy(tableRoot.matrixWorld).invert();
    camera.updateWorldMatrix(true, false);
    _m.multiplyMatrices(_inv, camera.matrixWorld);
    this.headPos.setFromMatrixPosition(_m);
    this.headQuat.setFromRotationMatrix(_m);

    let gotL = false,
      gotR = false;
    if (session && frame && ref) {
      // table space <- reference space (the camera's parent is the XR origin)
      const rig = camera.parent;
      if (rig) {
        rig.updateWorldMatrix(true, false);
        _m.multiplyMatrices(_inv, rig.matrixWorld);
      } else _m.copy(_inv);

      for (const src of session.inputSources) {
        if (src.handedness !== 'left' && src.handedness !== 'right') continue;
        const hd = this.hand(src.handedness);
        let ok = false;
        if (src.hand) ok = this.readHand(frame, ref, src.hand, hd);
        else if (src.gripSpace) ok = this.readController(frame, ref, src, hd);
        if (ok) {
          if (src.handedness === 'left') gotL = true;
          else gotR = true;
        }
      }
    } else if (this.mouse.active) {
      this.readMouse(this.hand(mouseHand));
      if (mouseHand === 'left') gotL = true;
      else gotR = true;
    }
    this.left.commit(gotL, dt);
    this.right.commit(gotR, dt);
  }

  private readHand(frame: XRFrame, ref: XRReferenceSpace, hand: XRHand, hd: HandData): boolean {
    const P = this.poses;
    // fillPoses reads all 25 joints in one call; fall back to per-joint poses
    const f = frame as XRFrame & {
      fillPoses?: (spaces: Iterable<XRSpace>, base: XRSpace, out: Float32Array) => boolean;
      getJointPose?: (joint: XRJointSpace, base: XRSpace) => XRJointPose | undefined;
    };
    let ok = false;
    try {
      if (f.fillPoses) ok = f.fillPoses(hand.values() as unknown as Iterable<XRSpace>, ref, P);
      if (!ok && f.getJointPose) {
        let i = 0;
        ok = true;
        for (const space of hand.values() as unknown as Iterable<XRJointSpace>) {
          const jp = f.getJointPose(space, ref);
          if (!jp) {
            ok = false;
            break;
          }
          P.set(jp.transform.matrix, i * 16);
          i++;
        }
      }
    } catch {
      ok = false;
    }
    if (!ok) return false;
    const J = hd.joints;
    for (let i = 0; i < JOINT_COUNT; i++) {
      const x = P[i * 16 + 12],
        y = P[i * 16 + 13],
        z = P[i * 16 + 14];
      if (!Number.isFinite(x)) return false;
      _v.set(x, y, z).applyMatrix4(_m);
      J[i * 3] = _v.x;
      J[i * 3 + 1] = _v.y;
      J[i * 3 + 2] = _v.z;
    }
    hd.source = 'hand';
    hd.joint(WRIST, hd.wrist);
    hd.joint(INDEX_TIP, hd.indexTip);
    hd.joint(THUMB_TIP, hd.thumbTip);
    const ip = hd.joint(INDEX_PROX, _a);
    const pp = hd.joint(PINKY_PROX, _b);
    const mp = hd.joint(MIDDLE_PROX, _c);
    hd.fingers.subVectors(mp, hd.wrist).normalize();
    hd.across.subVectors(ip, pp);
    hd.across.addScaledVector(hd.fingers, -hd.across.dot(hd.fingers)).normalize();
    hd.palmNormal.crossVectors(hd.fingers, hd.across).normalize();
    if (hd.handed === 'right') hd.palmNormal.negate();
    // grip centre: in the hollow of the palm, a little off the skin
    hd.palm.addVectors(ip, pp).multiplyScalar(0.5).lerp(hd.wrist, 0.32).addScaledVector(hd.palmNormal, 0.022);

    const size = Math.max(0.05, mp.distanceTo(hd.wrist));
    let ratio = 0;
    for (const tip of [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]) ratio += hd.joint(tip, _v).distanceTo(hd.wrist) / size;
    ratio /= 4;
    hd.grab = THREE.MathUtils.clamp((1.8 - ratio) / 0.8, 0, 1);
    const pd = hd.indexTip.distanceTo(hd.thumbTip);
    hd.pinch = hd.pinch ? pd < 0.035 : pd < 0.018;
    return true;
  }

  private readController(frame: XRFrame, ref: XRReferenceSpace, src: XRInputSource, hd: HandData): boolean {
    const pose = src.gripSpace ? frame.getPose(src.gripSpace, ref) : null;
    if (!pose) return false;
    const t = pose.transform;
    _v.set(t.position.x, t.position.y, t.position.z).applyMatrix4(_m);
    _q.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
    const rot = new THREE.Quaternion().setFromRotationMatrix(_m).multiply(_q);
    this.synth(hd, _v, rot);
    hd.source = 'controller';
    const gp = src.gamepad;
    hd.grab = gp && gp.buttons[1] ? gp.buttons[1].value : 0;
    hd.pinch = !!(gp && gp.buttons[0] && gp.buttons[0].value > 0.6);
    return true;
  }

  /** Build palm frame + a plausible skeleton from a single rigid pose. */
  private synth(hd: HandData, pos: THREE.Vector3, rot: THREE.Quaternion): void {
    hd.palm.copy(pos);
    hd.wrist.copy(pos).add(_a.set(0, -0.02, 0.07).applyQuaternion(rot));
    hd.fingers.set(0, 0, -1).applyQuaternion(rot);
    hd.across.set(0, 1, 0).applyQuaternion(rot);
    hd.palmNormal.set(hd.handed === 'right' ? -1 : 1, 0, 0).applyQuaternion(rot);
    hd.indexTip.copy(pos).addScaledVector(hd.fingers, 0.1).addScaledVector(hd.across, 0.03);
    hd.thumbTip.copy(pos).addScaledVector(hd.across, 0.06);
    for (let i = 0; i < JOINT_COUNT; i++) hd.palm.toArray(hd.joints, i * 3);
    hd.wrist.toArray(hd.joints, WRIST * 3);
    hd.indexTip.toArray(hd.joints, INDEX_TIP * 3);
    hd.thumbTip.toArray(hd.joints, THUMB_TIP * 3);
  }

  private readMouse(hd: HandData): void {
    const mx = this.mouse.x,
      my = this.mouse.y;
    const sign = hd.handed === 'right' ? 1 : -1;
    // higher on screen = further over the table and a little higher
    const pos = _v.set(mx * 0.95, TABLE.height + 0.1 + my * 0.5, HALF_L + 0.42 - my * 0.75);
    // palm faces the far end, tilting to aim across the table, thumb side up
    // world-space: open the face slightly (about X), aim toward the middle (about Y),
    // then turn the hand so the palm normal points down the table
    const open = 0.14 + (1 - my) * 0.16;
    const e = new THREE.Euler(open, mx * 0.35 - (sign * Math.PI) / 2, 0, 'XYZ');
    this.synth(hd, pos, _q.setFromEuler(e));
    hd.source = 'mouse';
    hd.grab = 1;
    hd.pinch = false;
  }
}

// ---------------------------------------------------------------- hand visuals

export class HandView {
  group = new THREE.Group();
  private dots: THREE.InstancedMesh;
  private bones: THREE.LineSegments;
  private bonePos: Float32Array;
  private o = new THREE.Object3D();

  constructor(color = 0x9fd8ff) {
    this.dots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.0085, 8, 6),
      new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.25, transparent: true, opacity: 0.9 }),
      JOINT_COUNT,
    );
    this.dots.frustumCulled = false;
    this.bonePos = new Float32Array(BONES.length * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.bonePos, 3));
    this.bones = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 }));
    this.bones.frustumCulled = false;
    this.group.add(this.dots, this.bones);
  }

  update(hd: HandData): void {
    const show = hd.tracked && hd.source === 'hand';
    this.group.visible = show;
    if (!show) return;
    const J = hd.joints;
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.o.position.set(J[i * 3], J[i * 3 + 1], J[i * 3 + 2]);
      const tip = i === 4 || i === 9 || i === 14 || i === 19 || i === 24;
      this.o.scale.setScalar(i === 0 ? 1.5 : tip ? 0.85 : 1);
      this.o.updateMatrix();
      this.dots.setMatrixAt(i, this.o.matrix);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    BONES.forEach(([a, b], k) => {
      this.bonePos[k * 6] = J[a * 3];
      this.bonePos[k * 6 + 1] = J[a * 3 + 1];
      this.bonePos[k * 6 + 2] = J[a * 3 + 2];
      this.bonePos[k * 6 + 3] = J[b * 3];
      this.bonePos[k * 6 + 4] = J[b * 3 + 1];
      this.bonePos[k * 6 + 5] = J[b * 3 + 2];
    });
    this.bones.geometry.attributes.position.needsUpdate = true;
  }
}
