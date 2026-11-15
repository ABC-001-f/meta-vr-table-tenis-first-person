// Regulation table model: 2.74 x 1.525 m top at 0.76 m, 2 cm boundary lines,
// 3 mm centre line, 15.25 cm net with posts and clamps, folding undercarriage.
import * as THREE from './three.ts';
import { HALF_L, HALF_W, NET, TABLE } from '../core/constants.ts';
import type { TableDesign } from '../custom/catalog.ts';

function carbonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16181b';
  g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const on = (x + y) % 2 === 0;
      const grad = g.createLinearGradient(x * 8, y * 8, x * 8 + (on ? 8 : 0), y * 8 + (on ? 0 : 8));
      grad.addColorStop(0, '#22252a');
      grad.addColorStop(1, '#0e0f11');
      g.fillStyle = grad;
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 44);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function netTexture(color: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 32);
  const col = new THREE.Color(color);
  g.strokeStyle = `rgba(${Math.round(col.r * 255 + 40)},${Math.round(col.g * 255 + 40)},${Math.round(col.b * 255 + 40)},0.95)`;
  g.lineWidth = 1.2;
  for (let x = 0; x <= 256; x += 4) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 32);
    g.stroke();
  }
  for (let y = 0; y <= 32; y += 4) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildTable(d: TableDesign): THREE.Group {
  const root = new THREE.Group();
  root.name = 'table';
  const H = TABLE.height;
  const glow = d.glow !== 0;

  const topMat = new THREE.MeshStandardMaterial({
    color: d.top,
    roughness: d.roughness,
    metalness: d.metalness,
    map: d.carbon ? carbonTexture() : null,
  });
  const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width, TABLE.thickness, TABLE.length), topMat);
  top.position.y = H - TABLE.thickness / 2;
  root.add(top);

  // markings sit a hair above the surface
  const lineMat = new THREE.MeshStandardMaterial({
    color: d.line,
    roughness: 0.6,
    emissive: glow ? d.glow : 0x000000,
    emissiveIntensity: glow ? 1.4 : 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const line = (w: number, l: number, x: number, z: number): void => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, H + 0.0004, z);
    root.add(m);
  };
  const lw = TABLE.lineWidth;
  line(lw, TABLE.length, -HALF_W + lw / 2, 0);
  line(lw, TABLE.length, HALF_W - lw / 2, 0);
  line(TABLE.width, lw, 0, -HALF_L + lw / 2);
  line(TABLE.width, lw, 0, HALF_L - lw / 2);
  line(TABLE.centreLineWidth, TABLE.length, 0, 0);

  // edge banding
  const frameMat = new THREE.MeshStandardMaterial({ color: d.frame, roughness: 0.45, metalness: Math.max(0.5, d.metalness) });
  const apronH = 0.045;
  const apron = (w: number, l: number, x: number, z: number): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, apronH, l), frameMat);
    m.position.set(x, H - TABLE.thickness - apronH / 2, z);
    root.add(m);
  };
  apron(0.02, TABLE.length - 0.06, -HALF_W + 0.03, 0);
  apron(0.02, TABLE.length - 0.06, HALF_W - 0.03, 0);
  apron(TABLE.width - 0.06, 0.02, 0, -HALF_L + 0.03);
  apron(TABLE.width - 0.06, 0.02, 0, HALF_L - 0.03);
  apron(TABLE.width - 0.06, 0.02, 0, -0.06);
  apron(TABLE.width - 0.06, 0.02, 0, 0.06);

  // undercarriage: two leg assemblies per half, cross braces, castors
  const legMat = new THREE.MeshStandardMaterial({ color: d.legs, roughness: 0.4, metalness: 0.7 });
  const legH = H - TABLE.thickness - apronH;
  const legGeo = new THREE.BoxGeometry(0.04, legH - 0.06, 0.04);
  const wheelGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.03, 14);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.8 });
  for (const sz of [-1, 1]) {
    for (const zz of [0.32, HALF_L - 0.3]) {
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(sx * (HALF_W - 0.16), 0.06 + (legH - 0.06) / 2, sz * zz);
        root.add(leg);
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * (HALF_W - 0.16), 0.035, sz * zz);
        root.add(wheel);
      }
      const brace = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width - 0.32, 0.03, 0.03), legMat);
      brace.position.set(0, 0.2, sz * zz);
      root.add(brace);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, HALF_L - 0.62), legMat);
    rail.position.set(0, 0.2, sz * (0.32 + (HALF_L - 0.62) / 2));
    root.add(rail);
  }

  // net: mesh, top tape, posts and clamps
  const span = TABLE.width + NET.overhang * 2;
  const netMat = new THREE.MeshBasicMaterial({
    map: netTexture(d.net),
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const net = new THREE.Mesh(new THREE.PlaneGeometry(span, NET.height), netMat);
  net.position.set(0, H + NET.height / 2, 0);
  net.renderOrder = 2;
  root.add(net);
  const tapeMat = new THREE.MeshStandardMaterial({
    color: glow ? d.glow : 0xf4f4f4,
    roughness: 0.7,
    emissive: glow ? d.glow : 0,
    emissiveIntensity: glow ? 1.2 : 0,
  });
  const tape = new THREE.Mesh(new THREE.BoxGeometry(span, 0.015, 0.006), tapeMat);
  tape.position.set(0, H + NET.height - 0.0075, 0);
  root.add(tape);
  const postMat = new THREE.MeshStandardMaterial({ color: d.frame, roughness: 0.35, metalness: 0.8 });
  for (const sx of [-1, 1]) {
    const x = sx * (HALF_W + NET.overhang);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(NET.postRadius, NET.postRadius, NET.height + 0.01, 12), postMat);
    post.position.set(x, H + NET.height / 2, 0);
    root.add(post);
    // clamp: arm reaching in over the table edge, jaw under it, thumb screw
    const arm = new THREE.Mesh(new THREE.BoxGeometry(NET.overhang + 0.03, 0.018, 0.03), postMat);
    arm.position.set(sx * (HALF_W + NET.overhang / 2 - 0.015), H + 0.009, 0);
    root.add(arm);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.016, 0.03), postMat);
    jaw.position.set(sx * (HALF_W - 0.02), H - TABLE.thickness - 0.012, 0);
    root.add(jaw);
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.016, TABLE.thickness + 0.045, 0.03), postMat);
    spine.position.set(sx * (HALF_W + 0.012), H - TABLE.thickness / 2 - 0.004, 0);
    root.add(spine);
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10), postMat);
    screw.position.set(sx * (HALF_W - 0.02), H - TABLE.thickness - 0.035, 0);
    root.add(screw);
  }

  if (glow) {
    const under = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE.width + 0.5, TABLE.length + 0.5),
      new THREE.MeshBasicMaterial({ color: d.glow, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    under.rotation.x = -Math.PI / 2;
    under.position.y = 0.004;
    root.add(under);
  }

  // soft contact shadow on the floor
  const sh = document.createElement('canvas');
  sh.width = sh.height = 64;
  const sg = sh.getContext('2d')!;
  const grad = sg.createRadialGradient(32, 32, 6, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 64, 64);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE.width + 1.1, TABLE.length + 1.1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  root.add(shadow);

  return root;
}

export function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      const tex = (x as THREE.MeshStandardMaterial).map;
      if (tex) tex.dispose();
      x.dispose();
    }
  });
}
