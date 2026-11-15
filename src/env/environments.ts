// The four venues. Each is built procedurally (no downloads), kept light for
// Quest: instanced seats/crowd, a handful of lights, canvas textures.
import * as THREE from '../render/three.ts';
import { font } from '../hud/fonts.ts';
import { Crowd } from '../render/crowd.ts';
import type { Spot } from '../render/crowd.ts';

export interface Venue {
  id: string;
  group: THREE.Group;
  background: number;
  fog: { color: number; near: number; far: number } | null;
  ambience: 'crowd' | 'lounge' | 'synth' | 'quiet';
  /** per-frame animation */
  update(t: number): void;
  /** arena scoreboards / studio wall display */
  setScore?(left: string, right: string, a: number, b: number, sub: string): void;
  /** the crowd reacts: 1 = a point, 2 = a game, 3 = the match */
  excite?(level: number): void;
}

const std = (color: number, roughness = 0.7, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.anisotropy = 4;
  return t;
}

function woodTexture(base: string, dark: string, repeat: [number, number]): THREE.CanvasTexture {
  return canvasTex(
    256,
    256,
    (g) => {
      g.fillStyle = base;
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 8; i++) {
        const y = i * 32;
        g.fillStyle = `rgba(0,0,0,${0.04 + ((i * 37) % 5) * 0.025})`;
        g.fillRect(0, y, 256, 32);
        g.strokeStyle = dark;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(256, y);
        const off = (i * 97) % 256;
        g.moveTo(off, y);
        g.lineTo(off, y + 32);
        g.stroke();
        g.strokeStyle = 'rgba(60,30,10,0.12)';
        g.lineWidth = 1;
        for (let k = 0; k < 5; k++) {
          g.beginPath();
          const yy = y + 4 + k * 6 + ((i + k) % 3);
          g.moveTo(0, yy);
          g.bezierCurveTo(80, yy + 2, 170, yy - 2, 256, yy + 1);
          g.stroke();
        }
      }
    },
    repeat,
  );
}

function scoreScreen(): { tex: THREE.CanvasTexture; set: NonNullable<Venue['setScore']> } {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const set: NonNullable<Venue['setScore']> = (left, right, a, b, sub) => {
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#ffb000';
    g.font = font(700, 32);
    g.textAlign = 'center';
    g.fillText(left.toUpperCase().slice(0, 14), 128, 48, 230);
    g.fillText(right.toUpperCase().slice(0, 14), 384, 48, 230);
    g.fillStyle = '#ffffff';
    g.font = font(700, 120);
    g.fillText(String(a), 128, 170);
    g.fillText(String(b), 384, 170);
    g.fillStyle = '#7fd4ff';
    g.font = font(600, 28);
    g.fillText(sub, 256, 232, 490);
    g.fillStyle = '#ffb000';
    g.fillRect(254, 70, 4, 120);
    tex.needsUpdate = true;
  };
  set('PINGVERSE', 'VR', 0, 0, 'WELCOME');
  return { tex, set };
}

// ---------------------------------------------------------------- arena

function arena(): Venue {
  const g = new THREE.Group();
  // hall floor + competition court
  box(40, 0.1, 40, std(0x14161c, 0.9), 0, -0.05, 0, g);
  const court = new THREE.Mesh(new THREE.PlaneGeometry(8, 14), std(0x9c2a2e, 0.85));
  court.rotation.x = -Math.PI / 2;
  court.position.y = 0.001;
  g.add(court);

  // court surrounds
  const barrierTex = canvasTex(512, 96, (c) => {
    c.fillStyle = '#12357a';
    c.fillRect(0, 0, 512, 96);
    c.fillStyle = '#ffffff';
    c.font = font(700, 52);
    c.textAlign = 'center';
    c.fillText('PINGVERSE VR', 256, 66);
  });
  const barrierMat = new THREE.MeshStandardMaterial({ map: barrierTex, roughness: 0.6 });
  for (let i = -3; i <= 3; i++) {
    for (const sx of [-1, 1]) {
      const b = box(0.04, 0.75, 1.95, barrierMat, sx * 4, 0.375, i * 2, g);
      b.material = barrierMat;
    }
  }
  for (let i = -1; i <= 1; i++) {
    for (const sz of [-1, 1]) {
      const b = box(2.3, 0.75, 0.04, barrierMat, i * 2.6, 0.375, sz * 7, g);
      b.rotation.y = 0;
    }
  }

  // tiered standing terraces on three sides: an animated crowd on the risers,
  // empty seats where nobody turned up
  const seatMat = std(0x1e2a44, 0.8);
  const tiers = 7;
  const seatGeo = new THREE.BoxGeometry(0.5, 0.45, 0.5);
  const seats: THREE.Matrix4[] = [];
  const spots: Spot[] = [];
  const palette = [0xd94f4f, 0x4f8fd9, 0xe0c060, 0x6fc48a, 0xeeeeee, 0x9a6fd0, 0x333a4a, 0xe08a4f];
  let seed = 9;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const mtx = new THREE.Matrix4();
  const addRow = (x: number, y: number, z: number, alongX: boolean, count: number): void => {
    for (let i = 0; i < count; i++) {
      const o = (i - (count - 1) / 2) * 0.62;
      const px = alongX ? x + o : x;
      const pz = alongX ? z : z + o;
      if (rnd() < 0.72) {
        // stands on the riser top, a little jitter so rows don't look stamped, facing the court
        const jx = (rnd() - 0.5) * 0.12,
          jz = (rnd() - 0.5) * 0.12;
        spots.push({ pos: new THREE.Vector3(px + jx, y - 0.22, pz + jz), yaw: Math.atan2(-(px + jx), -(pz + jz)) + (rnd() - 0.5) * 0.3, color: new THREE.Color(palette[Math.floor(rnd() * palette.length)]) });
      } else seats.push(mtx.clone().makeTranslation(px, y, pz));
    }
  };
  for (let t = 0; t < tiers; t++) {
    const y = 0.5 + t * 0.48;
    const off = 5.6 + t * 0.85;
    addRow(-off, y, 0, false, 26);
    addRow(off, y, 0, false, 26);
    addRow(0, y, -(off + 3.6), true, 18);
    // risers
    box(0.85, 0.48, 17, std(0x191c24, 0.9), -off, y - 0.46, 0, g);
    box(0.85, 0.48, 17, std(0x191c24, 0.9), off, y - 0.46, 0, g);
    box(12, 0.48, 0.85, std(0x191c24, 0.9), 0, y - 0.46, -(off + 3.6), g);
  }
  const seatInst = new THREE.InstancedMesh(seatGeo, seatMat, seats.length);
  seats.forEach((m, i) => seatInst.setMatrixAt(i, m));
  g.add(seatInst);
  const crowd = new Crowd(spots);
  g.add(crowd.group);

  // roof, lighting truss, light panels
  box(40, 0.3, 40, std(0x0a0b0f, 1), 0, 11, 0, g);
  const truss = std(0x2a2d35, 0.5, 0.8);
  const panel = new THREE.MeshBasicMaterial({ color: 0xfff4dc });
  for (const x of [-2.6, 2.6]) {
    box(0.12, 0.12, 12, truss, x, 6.4, 0, g);
    for (let i = -2; i <= 2; i++) box(0.9, 0.06, 0.5, panel, x, 6.3, i * 2.2, g);
  }
  for (const z of [-5, 0, 5]) box(5.4, 0.12, 0.12, truss, 0, 6.4, z, g);

  // scoreboards
  const board = scoreScreen();
  const screenMat = new THREE.MeshBasicMaterial({ map: board.tex });
  const s1 = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), screenMat);
  s1.position.set(0, 5.2, -12.4);
  g.add(s1);
  box(4.5, 2.4, 0.2, std(0x101216, 0.6, 0.5), 0, 5.2, -12.52, g);
  for (const sx of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.3), screenMat);
    s.position.set(sx * 9.6, 5.4, -3);
    s.rotation.y = -sx * 1.1;
    g.add(s);
  }

  // lights: bright, even tournament lighting
  g.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2620, 1.0));
  const key = new THREE.DirectionalLight(0xfff2de, 1.9);
  key.position.set(2, 8, 3);
  g.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
  fill.position.set(-3, 7, -4);
  g.add(fill);

  return {
    id: 'arena',
    group: g,
    background: 0x07080c,
    fog: { color: 0x07080c, near: 14, far: 42 },
    ambience: 'crowd',
    setScore: board.set,
    excite: (level) => crowd.excite(level),
    update(t) {
      crowd.update(t);
    },
  };
}

// ---------------------------------------------------------------- club

function club(): Venue {
  const g = new THREE.Group();
  const W = 11,
    D = 14,
    H = 3.6;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: woodTexture('#8a5a33', 'rgba(40,20,8,0.5)', [5, 7]), roughness: 0.42, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 6.6), std(0x3b1f2b, 0.95));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.003;
  g.add(rug);
  const rugEdge = new THREE.Mesh(new THREE.PlaneGeometry(4.7, 6.9), std(0xb08a4a, 0.9));
  rugEdge.rotation.x = -Math.PI / 2;
  rugEdge.position.y = 0.002;
  g.add(rugEdge);

  const panelTex = woodTexture('#5b3920', 'rgba(20,10,4,0.6)', [6, 2]);
  const wallMat = new THREE.MeshStandardMaterial({ map: panelTex, roughness: 0.55 });
  const plaster = std(0xe9dfcf, 0.95);
  // walls: wood wainscot below, plaster above
  const wall = (w: number, x: number, z: number, ry: number): void => {
    const low = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.5), wallMat);
    low.position.set(x, 0.75, z);
    low.rotation.y = ry;
    g.add(low);
    const up = new THREE.Mesh(new THREE.PlaneGeometry(w, H - 1.5), plaster);
    up.position.set(x, 1.5 + (H - 1.5) / 2, z);
    up.rotation.y = ry;
    g.add(up);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 0.05), std(0x3a2414, 0.5));
    rail.position.set(x, 1.52, z);
    rail.rotation.y = ry;
    g.add(rail);
  };
  wall(W, 0, -D / 2, 0);
  wall(W, 0, D / 2, Math.PI);
  wall(D, -W / 2, 0, Math.PI / 2);
  wall(D, W / 2, 0, -Math.PI / 2);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), std(0x2c1c10, 0.8));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  g.add(ceil);
  for (let i = -2; i <= 2; i++) box(W, 0.18, 0.2, std(0x24160c, 0.7), 0, H - 0.09, i * 2.8, g);

  // windows with an evening sky
  const sky = canvasTex(64, 128, (c) => {
    const gr = c.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, '#1b2a55');
    gr.addColorStop(0.6, '#c9703f');
    gr.addColorStop(1, '#f2c27a');
    c.fillStyle = gr;
    c.fillRect(0, 0, 64, 128);
  });
  for (const z of [-3.5, 0, 3.5]) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.7), new THREE.MeshBasicMaterial({ map: sky }));
    win.position.set(-W / 2 + 0.01, 2.45, z);
    win.rotation.y = Math.PI / 2;
    g.add(win);
    box(0.06, 1.8, 0.06, std(0x2a1a0e), -W / 2 + 0.03, 2.45, z, g);
    box(0.06, 0.06, 1.6, std(0x2a1a0e), -W / 2 + 0.03, 2.45, z, g);
  }

  // pendant lamps over the table
  const brass = std(0xb8893a, 0.3, 0.9);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  for (const z of [-1.1, 1.1]) {
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.26, 20, 1, true), brass);
    shade.position.set(0, 2.55, z);
    g.add(shade);
    box(0.012, H - 2.68, 0.012, brass, 0, 2.68 + (H - 2.68) / 2, z, g);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), glowMat);
    bulb.position.set(0, 2.47, z);
    g.add(bulb);
    const pl = new THREE.PointLight(0xffd2a0, 9, 9, 1.6);
    pl.position.set(0, 2.4, z);
    g.add(pl);
  }

  // lounge: sofas, coffee table, bar, shelves, plants, art
  const leather = std(0x5a2a1c, 0.5);
  const sofa = (x: number, z: number, ry: number): void => {
    const s = new THREE.Group();
    box(2.0, 0.4, 0.85, leather, 0, 0.2, 0, s);
    box(2.0, 0.5, 0.2, leather, 0, 0.6, -0.33, s);
    box(0.2, 0.3, 0.85, leather, -0.9, 0.5, 0, s);
    box(0.2, 0.3, 0.85, leather, 0.9, 0.5, 0, s);
    s.position.set(x, 0, z);
    s.rotation.y = ry;
    g.add(s);
  };
  sofa(W / 2 - 0.7, -2.2, -Math.PI / 2);
  sofa(W / 2 - 0.7, 2.2, -Math.PI / 2);
  const tableMat = std(0x2a1a0e, 0.35, 0.1);
  box(0.9, 0.05, 1.3, tableMat, W / 2 - 1.9, 0.42, 0, g);
  box(0.06, 0.42, 0.06, brass, W / 2 - 1.9, 0.21, 0, g);
  // bar along the back wall
  box(4.2, 1.05, 0.6, new THREE.MeshStandardMaterial({ map: panelTex, roughness: 0.5 }), -1.8, 0.525, -D / 2 + 0.75, g);
  box(4.4, 0.06, 0.75, std(0x1a1210, 0.2, 0.3), -1.8, 1.08, -D / 2 + 0.75, g);
  for (let s = 0; s < 3; s++) {
    box(4.0, 0.04, 0.26, tableMat, -1.8, 1.7 + s * 0.45, -D / 2 + 0.16, g);
    for (let b = 0; b < 9; b++) {
      const col = [0x2f6b45, 0x8a4b1f, 0xb9a15a, 0x3a3a55][(b + s) % 4];
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.28, 8), std(col, 0.2, 0.1, { transparent: true, opacity: 0.85 }));
      bottle.position.set(-3.6 + b * 0.45, 1.86 + s * 0.45, -D / 2 + 0.16);
      g.add(bottle);
    }
  }
  for (const [x, z] of [
    [-W / 2 + 0.5, -D / 2 + 0.6],
    [W / 2 - 0.5, D / 2 - 0.6],
    [-W / 2 + 0.5, D / 2 - 0.6],
  ]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.4, 12), std(0x2b2b2b, 0.6));
    pot.position.set(x, 0.2, z);
    g.add(pot);
    const leaves = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), std(0x2f6b3a, 0.9));
    leaves.scale.set(1, 1.5, 1);
    leaves.position.set(x, 1.0, z);
    g.add(leaves);
  }
  for (const z of [-4, -1.3, 1.3, 4]) {
    box(0.04, 0.8, 1.0, brass, W / 2 - 0.02, 2.4, z, g);
    box(0.045, 0.7, 0.9, std([0x2c4a6e, 0x6e2c3a, 0x3d5a3a, 0x70552a][Math.abs(Math.round(z)) % 4], 0.9), W / 2 - 0.022, 2.4, z, g);
  }

  g.add(new THREE.HemisphereLight(0xffe2c0, 0x3a2414, 0.75));
  const d = new THREE.DirectionalLight(0xffd9b0, 0.8);
  d.position.set(-4, 3, 1);
  g.add(d);
  return { id: 'club', group: g, background: 0x1a110a, fog: null, ambience: 'lounge', update() {} };
}

// ---------------------------------------------------------------- cyber

function cyber(): Venue {
  const g = new THREE.Group();
  const grid = canvasTex(
    256,
    256,
    (c) => {
      c.fillStyle = '#05061a';
      c.fillRect(0, 0, 256, 256);
      c.strokeStyle = '#2a7bff';
      c.lineWidth = 3;
      c.strokeRect(0, 0, 256, 256);
      c.strokeStyle = 'rgba(160,80,255,0.55)';
      c.lineWidth = 1;
      for (let i = 64; i < 256; i += 64) {
        c.beginPath();
        c.moveTo(i, 0);
        c.lineTo(i, 256);
        c.moveTo(0, i);
        c.lineTo(256, i);
        c.stroke();
      }
    },
    [30, 30],
  );
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: grid, emissiveMap: grid, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.6 }));
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);
  // raised hex platform under the table
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.5, 0.08, 6), std(0x0c0e24, 0.3, 0.7));
  plat.position.y = -0.04 + 0.001;
  g.add(plat);
  const platEdge = new THREE.Mesh(new THREE.TorusGeometry(4.25, 0.03, 6, 6), new THREE.MeshBasicMaterial({ color: 0x35e6ff }));
  platEdge.rotation.x = Math.PI / 2;
  platEdge.rotation.z = Math.PI / 6;
  platEdge.position.y = 0.02;
  g.add(platEdge);

  const pulse: THREE.MeshBasicMaterial[] = [];
  const dark = std(0x0d1030, 0.35, 0.7);
  const neonA = new THREE.MeshBasicMaterial({ color: 0x35e6ff });
  const neonB = new THREE.MeshBasicMaterial({ color: 0xb04dff });
  pulse.push(neonA, neonB);
  // pillars with light strips
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const r = 9.5;
    const x = Math.cos(a) * r,
      z = Math.sin(a) * r;
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.9, 9, 0.9), dark);
    p.position.set(x, 4.5, z);
    p.rotation.y = -a;
    g.add(p);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 8.6, 0.08), i % 2 ? neonA : neonB);
    strip.position.set(Math.cos(a) * (r - 0.5), 4.5, Math.sin(a) * (r - 0.5));
    g.add(strip);
  }
  // arches
  for (const z of [-7, 7]) {
    const arch = new THREE.Mesh(new THREE.TorusGeometry(6, 0.12, 8, 40, Math.PI), neonB);
    arch.position.set(0, 0, z);
    g.add(arch);
  }
  // floating rings
  const rings: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2 + i * 1.3, 0.035, 6, 64), i % 2 ? neonB : neonA);
    ring.position.y = 5.2 + i * 0.9;
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    rings.push(ring);
  }
  // distant skyline
  let seed = 4;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const towerGeo = new THREE.BoxGeometry(1, 1, 1);
  const towers = new THREE.InstancedMesh(towerGeo, std(0x0a0c24, 0.5, 0.4, { emissive: 0x1a1050, emissiveIntensity: 0.6 }), 40);
  const m = new THREE.Object3D();
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = 20 + rnd() * 6;
    const h = 5 + rnd() * 16;
    m.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
    m.scale.set(1.5 + rnd() * 2.5, h, 1.5 + rnd() * 2.5);
    m.updateMatrix();
    towers.setMatrixAt(i, m.matrix);
  }
  g.add(towers);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(45, 24, 12),
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      fog: false,
      map: canvasTex(8, 128, (c) => {
        const gr = c.createLinearGradient(0, 0, 0, 128);
        gr.addColorStop(0, '#02010a');
        gr.addColorStop(0.5, '#150a3d');
        gr.addColorStop(0.62, '#5b1f8f');
        gr.addColorStop(0.7, '#0a0620');
        gr.addColorStop(1, '#02010a');
        c.fillStyle = gr;
        c.fillRect(0, 0, 8, 128);
      }),
    }),
  );
  g.add(dome);

  g.add(new THREE.HemisphereLight(0x8fb4ff, 0x2a1050, 0.85));
  const k = new THREE.DirectionalLight(0xcfe6ff, 1.3);
  k.position.set(1, 8, 2);
  g.add(k);
  const c1 = new THREE.PointLight(0x35e6ff, 14, 14, 1.6);
  c1.position.set(-3.5, 2.6, -2);
  g.add(c1);
  const c2 = new THREE.PointLight(0xb04dff, 14, 14, 1.6);
  c2.position.set(3.5, 2.6, 2);
  g.add(c2);

  return {
    id: 'cyber',
    group: g,
    background: 0x03020c,
    fog: { color: 0x0a0624, near: 16, far: 46 },
    ambience: 'synth',
    update(t) {
      rings.forEach((r, i) => {
        r.rotation.z = t * (0.12 + i * 0.05) * (i % 2 ? -1 : 1);
        r.position.y = 5.2 + i * 0.9 + Math.sin(t * 0.6 + i) * 0.15;
      });
      const p = 0.75 + 0.25 * Math.sin(t * 1.7);
      neonA.color.setRGB(0.21 * p, 0.9 * p, 1.0 * p);
      neonB.color.setRGB(0.69 * (1.75 - p), 0.3 * (1.75 - p), 1.0 * (1.75 - p));
      void pulse;
    },
  };
}

// ---------------------------------------------------------------- studio

function studio(): Venue {
  const g = new THREE.Group();
  const white = std(0xe8eaee, 0.9);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 16), std(0x8b929c, 0.8));
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(5, 8.4), std(0x2f6f8f, 0.85));
  mat.rotation.x = -Math.PI / 2;
  mat.position.y = 0.002;
  g.add(mat);
  // plain walls with a curved cove behind the opponent
  const back = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 4.2, 32, 1, true, Math.PI * 0.75, Math.PI * 0.5), new THREE.MeshStandardMaterial({ color: 0xe8eaee, roughness: 0.95, side: THREE.BackSide }));
  back.position.set(0, 2.1, 0.5);
  g.add(back);
  const wallL = new THREE.Mesh(new THREE.PlaneGeometry(16, 4.2), white);
  wallL.position.set(-5.7, 2.1, 0);
  wallL.rotation.y = Math.PI / 2;
  g.add(wallL);
  const wallR = wallL.clone();
  wallR.position.x = 5.7;
  wallR.rotation.y = -Math.PI / 2;
  g.add(wallR);
  const wallB = new THREE.Mesh(new THREE.PlaneGeometry(11.4, 4.2), white);
  wallB.position.set(0, 2.1, 8);
  wallB.rotation.y = Math.PI;
  g.add(wallB);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(14, 16), std(0xd5d8de, 1));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 4.2;
  g.add(ceil);
  // softbox over the table
  box(2.2, 0.08, 3.6, new THREE.MeshBasicMaterial({ color: 0xffffff }), 0, 3.6, 0, g);
  box(2.3, 0.12, 3.7, std(0x22252b, 0.6), 0, 3.67, 0, g);
  // bench, ball basket, towel
  box(1.6, 0.06, 0.38, std(0xb58a55, 0.6), -4.6, 0.45, 1.5, g);
  box(0.05, 0.45, 0.34, std(0x2a2d33, 0.5, 0.6), -5.3, 0.225, 1.5, g);
  box(0.05, 0.45, 0.34, std(0x2a2d33, 0.5, 0.6), -3.9, 0.225, 1.5, g);
  box(0.5, 0.03, 0.3, std(0x2f6f8f, 0.95), -4.3, 0.495, 1.5, g);
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.34, 14, 1, true), std(0x30343c, 0.6, 0.4, { side: THREE.DoubleSide }));
  basket.position.set(4.4, 0.6, -1.2);
  g.add(basket);
  box(0.04, 0.45, 0.04, std(0x30343c, 0.5, 0.6), 4.4, 0.22, -1.2, g);
  const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(0.02, 8, 6), std(0xfff3df, 0.5), 30);
  const o = new THREE.Object3D();
  for (let i = 0; i < 30; i++) {
    const a = i * 2.4;
    o.position.set(4.4 + Math.cos(a) * 0.13 * ((i % 5) / 5), 0.5 + (i % 6) * 0.035, -1.2 + Math.sin(a) * 0.13 * ((i % 5) / 5));
    o.updateMatrix();
    balls.setMatrixAt(i, o.matrix);
  }
  g.add(balls);
  // wall display
  const board = scoreScreen();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.0), new THREE.MeshBasicMaterial({ map: board.tex }));
  screen.position.set(5.68, 2.2, -1.5);
  screen.rotation.y = -Math.PI / 2;
  g.add(screen);

  g.add(new THREE.HemisphereLight(0xffffff, 0x9aa0aa, 1.25));
  const k = new THREE.DirectionalLight(0xffffff, 1.5);
  k.position.set(1, 6, 2);
  g.add(k);
  return { id: 'studio', group: g, background: 0xd9dce2, fog: null, ambience: 'quiet', setScore: board.set, update() {} };
}

export function buildVenue(id: string): Venue {
  switch (id) {
    case 'club':
      return club();
    case 'cyber':
      return cyber();
    case 'studio':
      return studio();
    default:
      return arena();
  }
}
