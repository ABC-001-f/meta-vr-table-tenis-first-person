// Paddle model. Origin = blade centre; local +Z = forehand rubber normal,
// local +Y = handle -> blade tip. Matches the physics PaddleBody frame.
import * as THREE from './three.ts';
import { PADDLE } from '../core/constants.ts';
import { HANDLES, PADDLES } from '../custom/catalog.ts';
import type { PaddleLook } from '../custom/catalog.ts';
import { font } from '../hud/fonts.ts';

function rubberTexture(hex: string, surface: string): THREE.CanvasTexture | null {
  if (surface === 'smooth') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = hex;
  g.fillRect(0, 0, 128, 128);
  if (surface === 'pimpled') {
    g.fillStyle = 'rgba(255,255,255,0.16)';
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        g.beginPath();
        g.arc(x * 8 + (y % 2 ? 6 : 2), y * 8 + 4, 1.7, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else {
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(64, 60, 22, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = font(800, 15);
    g.textAlign = 'center';
    g.fillText('PINGVERSE', 64, 104);
    g.beginPath();
    g.arc(64, 60, 7, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildPaddle(look: PaddleLook): THREE.Group {
  const design = PADDLES.find((p) => p.id === look.paddle) ?? PADDLES[0];
  const handle = HANDLES.find((h) => h.id === look.handle) ?? HANDLES[0];
  const root = new THREE.Group();
  root.name = 'paddle';
  const rx = PADDLE.bladeRadiusX;
  const ry = PADDLE.bladeRadiusY;
  const sy = ry / rx;

  // blade core (wood / composite), edge visible around the rim
  const coreT = 0.006;
  const disc = (t: number, r: number): THREE.CylinderGeometry => {
    const geo = new THREE.CylinderGeometry(r, r, t, 40);
    geo.rotateX(Math.PI / 2);
    geo.scale(1, sy, 1);
    return geo;
  };
  const edgeMat = new THREE.MeshStandardMaterial({
    color: design.edge,
    roughness: design.metalEdge ? 0.25 : 0.6,
    metalness: design.metalEdge ? 0.9 : 0.05,
    emissive: design.glow,
    emissiveIntensity: design.glow ? 1.6 : 0,
  });
  root.add(new THREE.Mesh(disc(coreT, rx), edgeMat));

  // rubbers: forehand on +Z, backhand on -Z
  const rubberT = PADDLE.halfThickness - coreT / 2;
  const mkRubber = (hex: string, z: number): void => {
    const map = rubberTexture(hex, look.surface);
    const mat = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : new THREE.Color(hex), map, roughness: 0.85, metalness: 0 });
    const m = new THREE.Mesh(disc(rubberT, rx - 0.0015), mat);
    m.position.z = z;
    root.add(m);
  };
  mkRubber(look.rubberColor, coreT / 2 + rubberT / 2);
  mkRubber(look.rubberBackColor, -(coreT / 2 + rubberT / 2));

  // neck + handle
  const hMat = new THREE.MeshStandardMaterial({
    color: handle.color,
    roughness: handle.roughness,
    metalness: handle.metalness,
    emissive: handle.glow,
    emissiveIntensity: handle.glow ? 0.5 : 0,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: handle.accent,
    roughness: 0.5,
    metalness: handle.metalness,
    emissive: handle.glow,
    emissiveIntensity: handle.glow ? 1.5 : 0,
  });
  const hl = PADDLE.handleLength;
  const top = -ry + 0.012; // where the handle meets the blade
  const hGeo = new THREE.BoxGeometry(0.027, hl, 0.023, 1, 4, 1);
  // flare the handle toward the butt and round its section slightly
  const pos = hGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = (0.5 - y / hl) * 1; // 0 at blade end .. 1 at butt
    const flare = 1 + 0.22 * k * k;
    pos.setX(i, pos.getX(i) * flare);
    pos.setZ(i, pos.getZ(i) * (1 + 0.1 * k));
  }
  hGeo.computeVertexNormals();
  const h = new THREE.Mesh(hGeo, hMat);
  h.position.y = top - hl / 2;
  root.add(h);
  // neck wedges where blade meets handle
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.0135, 0.03, 4, 1), hMat);
  neck.scale.z = 0.4;
  neck.rotation.y = Math.PI / 4;
  neck.position.y = top + 0.012;
  root.add(neck);

  // grip appearance
  if (look.grip === 'tape') {
    for (let i = 0; i < 7; i++) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.0305, 0.008, 0.0262), accentMat);
      band.position.y = top - 0.012 - i * 0.012;
      band.rotation.z = 0.18;
      root.add(band);
    }
  } else if (look.grip === 'stripe') {
    for (const z of [0.0118, -0.0118]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.006, hl * 0.9, 0.0012), accentMat);
      stripe.position.set(0, top - hl / 2, z);
      root.add(stripe);
    }
  } else {
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.0245), accentMat);
    badge.position.y = top - 0.02;
    root.add(badge);
  }
  const butt = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.004, 0.026), accentMat);
  butt.position.y = top - hl - 0.002;
  root.add(butt);
  return root;
}
