// Builds public/models/crowd.glb and public/models/player.glb from MakeHuman's
// CC0 assets, with no Blender and no MakeHuman install: the base mesh, the
// macro targets, MPFB's Mixamo-named rig and weights, the low-poly crowd
// proxies, skins, clothes, hair, eyes and eyebrows are fetched straight from
// the MakeHuman GitHub repositories and the official system-asset pack (read
// over HTTP range requests, so the 280 MB zip is never downloaded whole).
//
//   node tools/build-humans.ts            # Node 22+, no dependencies
//   MH_CACHE=.cache/makehuman             # where the sources are kept
//
// What it does, in order: parse base.obj -> blend the macro targets (gender,
// age, muscle, weight, height, ethnicity) -> place the 52 Mixamo bones from
// the joint helper cubes -> fit proxies (clothes, hair, eyes, low-poly bodies)
// with MakeHuman's own barycentric + scaled-offset rule and inherit the body's
// skin weights -> paint shirt/trousers/shoes into the crowd's skin atlas ->
// author the animation clips procedurally -> write glTF binaries.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ sources

const MH_RAW = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/';
const MPFB_RAW = 'https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/src/mpfb/data/rigs/standard/';
const SYS_ZIP = 'https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip';
const CACHE = process.env.MH_CACHE ?? '.cache/makehuman';
const OUT_DIR = 'public/models';

/** MakeHuman works in decimetres; the game in metres */
const DM = 0.1;

async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  let err: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok || r.status === 206) return r;
      err = new Error(`${r.status} ${url}`);
    } catch (e) {
      err = e;
    }
    await new Promise((res) => setTimeout(res, 1000 + i * 1500));
  }
  throw err;
}

/** A file from one of the git repositories, cached under CACHE/<rel>. */
async function repoFile(base: string, rel: string): Promise<string> {
  const dest = join(CACHE, 'repo', rel);
  if (!existsSync(dest)) {
    console.log('  fetch', rel);
    const r = await fetchRetry(base + rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  return dest;
}

interface ZipEntry {
  name: string;
  method: number;
  csize: number;
  usize: number;
  off: number;
}

let zipDir: Promise<{ size: number; entries: ZipEntry[] }> | null = null;

/** The zip's central directory (cached) so single entries can be range-fetched. */
function zipDirectory(): Promise<{ size: number; entries: ZipEntry[] }> {
  zipDir ??= (async () => {
    const cached = join(CACHE, 'syspack.json');
    if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
    const head = await fetchRetry(SYS_ZIP, { method: 'HEAD' });
    const size = Number(head.headers.get('content-length'));
    const tailLen = Math.min(size, 2 * 1024 * 1024);
    const tail = Buffer.from(await (await fetchRetry(SYS_ZIP, { headers: { Range: `bytes=${size - tailLen}-${size - 1}` } })).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new Error('zip: no end-of-central-directory record');
    const cdSize = tail.readUInt32LE(eocd + 12),
      cdOff = tail.readUInt32LE(eocd + 16);
    const cd = tail.subarray(cdOff - (size - tailLen), cdOff - (size - tailLen) + cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const nl = cd.readUInt16LE(p + 28),
        el = cd.readUInt16LE(p + 30),
        cl = cd.readUInt16LE(p + 32);
      entries.push({ name: cd.toString('utf8', p + 46, p + 46 + nl), method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), off: cd.readUInt32LE(p + 42) });
      p += 46 + nl + el + cl;
    }
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, JSON.stringify({ size, entries }));
    return { size, entries };
  })();
  return zipDir;
}

/** One file out of the system-asset pack, cached under CACHE/sys/<name>. */
async function sysFile(name: string): Promise<string> {
  const dest = join(CACHE, 'sys', name);
  if (existsSync(dest)) return dest;
  const { entries } = await zipDirectory();
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error(`not in the asset pack: ${name}`);
  console.log('  fetch pack', name, `(${(e.usize / 1e6).toFixed(1)} MB)`);
  const lh = Buffer.from(await (await fetchRetry(SYS_ZIP, { headers: { Range: `bytes=${e.off}-${e.off + 29}` } })).arrayBuffer());
  const start = e.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const data = e.csize ? Buffer.from(await (await fetchRetry(SYS_ZIP, { headers: { Range: `bytes=${start}-${start + e.csize - 1}` } })).arrayBuffer()) : Buffer.alloc(0);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, e.method === 8 ? inflateRawSync(data) : data);
  return dest;
}

// ------------------------------------------------------------------ small math

type V3 = [number, number, number];
type Q = [number, number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const qAxis = (axis: V3, angle: number): Q => {
  const s = Math.sin(angle / 2),
    a = norm(axis);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
};
const qX = (a: number): Q => qAxis([1, 0, 0], a);
const qY = (a: number): Q => qAxis([0, 1, 0], a);
const qZ = (a: number): Q => qAxis([0, 0, 1], a);
const qMul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** q1 then q2 then ... applied to a vector (q1 innermost). */
const qChain = (...qs: Q[]): Q => qs.reduce((acc, q) => qMul(q, acc), [0, 0, 0, 1] as Q);
const qRot = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1],
    iy = w * v[1] + z * v[0] - x * v[2],
    iz = w * v[2] + x * v[1] - y * v[0],
    iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);

// ------------------------------------------------------------------ OBJ / target / mhclo parsing

interface Face {
  v: number[];
  vt: number[];
  g: string;
}

interface Obj {
  v: V3[];
  vt: [number, number][];
  faces: Face[];
  /** vertex indices per group */
  groups: Map<string, Set<number>>;
}

function parseObj(path: string): Obj {
  const v: V3[] = [],
    vt: [number, number][] = [],
    faces: Face[] = [];
  const groups = new Map<string, Set<number>>();
  let g = 'default';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.trim().split(/\s+/);
      v.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('vt ')) {
      const p = line.trim().split(/\s+/);
      vt.push([+p[1], +p[2]]);
    } else if (line.startsWith('g ') || line.startsWith('o ')) {
      g = line.slice(2).trim();
    } else if (line.startsWith('f ')) {
      const f: Face = { v: [], vt: [], g };
      for (const t of line.slice(2).trim().split(/\s+/)) {
        const [vi, ti] = t.split('/');
        f.v.push(+vi - 1);
        f.vt.push(ti ? +ti - 1 : -1);
      }
      faces.push(f);
      let set = groups.get(g);
      if (!set) groups.set(g, (set = new Set()));
      for (const i of f.v) set.add(i);
    }
  }
  return { v, vt, faces, groups };
}

type Target = [number, number, number, number][];

async function loadTarget(rel: string): Promise<Target> {
  const path = await repoFile(MH_RAW, `data/targets/macrodetails/${rel}.target`);
  const out: Target = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length >= 4) out.push([+p[0], +p[1], +p[2], +p[3]]);
  }
  return out;
}

/** MakeHuman's macro sliders, all 0..1 (0.5 = the average person, 0.5 age = 25 years). */
interface Macro {
  gender: number;
  age: number;
  muscle: number;
  weight: number;
  height: number;
  african: number;
  asian: number;
  caucasian: number;
}

/** The weighted macro targets MakeHuman itself blends for these slider values. */
function macroTargets(m: Macro): [string, number][] {
  const gender: [string, number][] = [
    ['female', 1 - m.gender],
    ['male', m.gender],
  ];
  const age: [string, number][] =
    m.age < 0.1875
      ? [
          ['baby', 1 - m.age / 0.1875],
          ['child', m.age / 0.1875],
        ]
      : m.age < 0.5
        ? [
            ['child', 1 - (m.age - 0.1875) / 0.3125],
            ['young', (m.age - 0.1875) / 0.3125],
          ]
        : [
            ['young', 1 - (m.age - 0.5) / 0.5],
            ['old', (m.age - 0.5) / 0.5],
          ];
  const tri = (x: number, lo: string, mid: string, hi: string): [string, number][] =>
    x < 0.5
      ? [
          [lo, 1 - x / 0.5],
          [mid, x / 0.5],
        ]
      : [
          [mid, 1 - (x - 0.5) / 0.5],
          [hi, (x - 0.5) / 0.5],
        ];
  const muscle = tri(m.muscle, 'minmuscle', 'averagemuscle', 'maxmuscle');
  const weight = tri(m.weight, 'minweight', 'averageweight', 'maxweight');
  const height: [string, number][] = m.height < 0.5 ? [['minheight', 1 - m.height / 0.5]] : [['maxheight', (m.height - 0.5) / 0.5]];
  const ethnic: [string, number][] = [
    ['african', m.african],
    ['asian', m.asian],
    ['caucasian', m.caucasian],
  ];
  const out: [string, number][] = [];
  for (const [g, gw] of gender)
    for (const [a, aw] of age) {
      for (const [e, ew] of ethnic) if (ew * gw * aw > 1e-3) out.push([`${e}-${g}-${a}`, ew * gw * aw]);
      for (const [mu, mw] of muscle)
        for (const [w, ww] of weight) {
          const base = gw * aw * mw * ww;
          if (base < 1e-3) continue;
          out.push([`universal-${g}-${a}-${mu}-${w}`, base]);
          for (const [h, hw] of height) if (base * hw > 1e-3) out.push([`height/${g}-${a}-${mu}-${w}-${h}`, base * hw]);
        }
    }
  return out;
}

async function morph(base: V3[], m: Macro): Promise<V3[]> {
  const v = base.map((p) => [...p] as V3);
  for (const [name, w] of macroTargets(m)) {
    const t = await loadTarget(name);
    for (const [i, dx, dy, dz] of t) {
      v[i][0] += dx * w;
      v[i][1] += dy * w;
      v[i][2] += dz * w;
    }
  }
  return v;
}

interface Mhclo {
  dir: string;
  obj: string;
  scale: [number, number, number][];
  verts: { i: [number, number, number]; w: [number, number, number]; o: V3 }[];
  del: Set<number>;
  material: string | null;
}

function parseMhclo(path: string): Mhclo {
  const m: Mhclo = { dir: dirname(path), obj: '', scale: [], verts: [], del: new Set(), material: null };
  const scale: Record<string, [number, number, number]> = {};
  let section: 'verts' | 'del' | null = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    if (p[0] === 'obj_file') m.obj = join(m.dir, p[1]);
    else if (p[0] === 'material') m.material = join(m.dir, p.slice(1).join(' '));
    else if (/^[xyz]_scale$/.test(p[0])) scale[p[0][0]] = [+p[1], +p[2], +p[3]];
    else if (p[0] === 'verts') section = 'verts';
    else if (p[0] === 'delete_verts') section = 'del';
    else if (section === 'verts' && /^-?[\d.]/.test(p[0])) {
      if (p.length === 1) m.verts.push({ i: [+p[0], +p[0], +p[0]], w: [1, 0, 0], o: [0, 0, 0] });
      else m.verts.push({ i: [+p[0], +p[1], +p[2]], w: [+p[3], +p[4], +p[5]], o: [+p[6], +p[7], +p[8]] });
    } else if (section === 'del' && /^\d/.test(p[0])) {
      // "a b c - d e" : single indices and inclusive ranges
      for (let k = 0; k < p.length; k++) {
        if (p[k + 1] === '-') {
          for (let i = +p[k]; i <= +p[k + 2]; i++) m.del.add(i);
          k += 2;
        } else m.del.add(+p[k]);
      }
    } else if (/^[a-z_]+$/i.test(p[0]) && section) section = null;
  }
  m.scale = [scale.x ?? [0, 0, 1], scale.y ?? [0, 0, 1], scale.z ?? [0, 0, 1]];
  return m;
}

/** Fit a proxy to the (morphed, MakeHuman-space) body: barycentric anchor + offset scaled by the body's size. */
function fitProxy(m: Mhclo, body: V3[]): V3[] {
  const s = m.scale.map(([a, b, den], axis) => (den ? Math.abs(body[a][axis] - body[b][axis]) / den : 1));
  return m.verts.map(({ i, w, o }) => {
    const p: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      p[0] += body[i[k]][0] * w[k];
      p[1] += body[i[k]][1] * w[k];
      p[2] += body[i[k]][2] * w[k];
    }
    return [p[0] + o[0] * s[0], p[1] + o[1] * s[1], p[2] + o[2] * s[2]];
  });
}

function mhmatTexture(mhmat: string, key = 'diffuseTexture'): string | null {
  for (const raw of readFileSync(mhmat, 'utf8').split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === key) return join(dirname(mhmat), p.slice(1).join(' '));
  }
  return null;
}

// ------------------------------------------------------------------ rig and weights

interface Bone {
  name: string;
  parent: number;
  /** rest head position, game space (metres, facing -Z) */
  head: V3;
  tail: V3;
}

interface RigJson {
  bones: Record<string, { parent: string; head: { strategy: string; vertex_indices?: number[]; cube_name?: string }; tail: { strategy: string; vertex_indices?: number[]; cube_name?: string } }>;
}

const mixamoName = (n: string): string => n.replace('mixamorig:', 'mixamorig');

/** Place the Mixamo rig on this body: MEAN of vertices or the centroid of a joint helper cube. */
function buildRig(rig: RigJson, body: V3[], obj: Obj, toGame: (p: V3) => V3): Bone[] {
  const at = (s: { strategy: string; vertex_indices?: number[]; cube_name?: string }): V3 => {
    const idx = s.strategy === 'CUBE' ? [...(obj.groups.get(s.cube_name!) ?? [])] : (s.vertex_indices ?? []);
    if (!idx.length) throw new Error(`rig: no vertices for ${JSON.stringify(s)}`);
    let p: V3 = [0, 0, 0];
    for (const i of idx) p = add(p, body[i]);
    return toGame(scale(p, 1 / idx.length));
  };
  const names = Object.keys(rig.bones);
  const bones: Bone[] = [];
  const index = new Map<string, number>();
  // parents first
  const visit = (n: string): void => {
    if (index.has(n)) return;
    const b = rig.bones[n];
    if (b.parent) visit(b.parent);
    index.set(n, bones.length);
    bones.push({ name: mixamoName(n), parent: b.parent ? index.get(b.parent)! : -1, head: at(b.head), tail: at(b.tail) });
  };
  for (const n of names) visit(n);
  return bones;
}

/** per vertex: [boneIndex, weight][] */
type Skin = [number, number][][];

function bodySkin(weights: Record<string, [number, number][]>, bones: Bone[], nVerts: number): Skin {
  const skin: Skin = Array.from({ length: nVerts }, () => []);
  const idx = new Map(bones.map((b, i) => [b.name, i]));
  for (const [name, list] of Object.entries(weights)) {
    const bi = idx.get(mixamoName(name));
    if (bi === undefined) continue;
    for (const [v, w] of list) if (v < nVerts && w > 0) skin[v].push([bi, w]);
  }
  return skin;
}

function proxySkin(m: Mhclo, body: Skin): Skin {
  return m.verts.map(({ i, w }) => {
    const acc = new Map<number, number>();
    for (let k = 0; k < 3; k++) if (w[k] > 0) for (const [b, bw] of body[i[k]]) acc.set(b, (acc.get(b) ?? 0) + bw * w[k]);
    return [...acc];
  });
}

/** best four influences, normalised */
function top4(list: [number, number][]): { j: number[]; w: number[] } {
  const s = [...list].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = s.reduce((a, x) => a + x[1], 0) || 1;
  const j = [0, 0, 0, 0],
    w = [0, 0, 0, 0];
  s.forEach(([b, x], k) => {
    j[k] = b;
    w[k] = x / sum;
  });
  return { j, w };
}

// ------------------------------------------------------------------ mesh parts

interface Part {
  name: string;
  material: number;
  pos: number[];
  nrm: number[];
  uv: number[];
  joints: number[];
  weights: number[];
  idx: number[];
  /** dominant bone per vertex (for painting) */
  bone: number[];
}

interface PartOpts {
  faceFilter?: (f: Face) => boolean;
  /** maps an OBJ (u, v) to the final glTF uv (already V-flipped when called) */
  uvMap?: (u: number, v: number) => [number, number];
}

/** Split vertices by (position, uv), triangulate, smooth normals shared across uv seams. */
function buildPart(name: string, material: number, obj: Obj, pos: V3[], skin: Skin, opts: PartOpts = {}): Part {
  const part: Part = { name, material, pos: [], nrm: [], uv: [], joints: [], weights: [], idx: [], bone: [] };
  const faceNormals = pos.map(() => [0, 0, 0] as V3);
  const key = new Map<string, number>();
  const srcOf: number[] = [];
  const vert = (vi: number, ti: number): number => {
    const k = `${vi}/${ti}`;
    let id = key.get(k);
    if (id !== undefined) return id;
    id = srcOf.length;
    key.set(k, id);
    srcOf.push(vi);
    part.pos.push(...pos[vi]);
    let [u, v] = ti >= 0 ? obj.vt[ti] : [0, 0];
    v = 1 - v;
    if (opts.uvMap) [u, v] = opts.uvMap(u, v);
    part.uv.push(u, v);
    const { j, w } = top4(skin[vi]);
    part.joints.push(...j);
    part.weights.push(...w);
    part.bone.push(j[0]);
    return id;
  };
  for (const f of obj.faces) {
    if (opts.faceFilter && !opts.faceFilter(f)) continue;
    const n = norm(cross(sub(pos[f.v[1]], pos[f.v[0]]), sub(pos[f.v[2]], pos[f.v[0]])));
    const area = len(cross(sub(pos[f.v[1]], pos[f.v[0]]), sub(pos[f.v[2]], pos[f.v[0]])));
    for (const vi of f.v) faceNormals[vi] = add(faceNormals[vi], scale(n, area));
    for (let k = 1; k + 1 < f.v.length; k++) part.idx.push(vert(f.v[0], f.vt[0]), vert(f.v[k], f.vt[k]), vert(f.v[k + 1], f.vt[k + 1]));
  }
  for (const vi of srcOf) part.nrm.push(...norm(faceNormals[vi]));
  return part;
}

// ------------------------------------------------------------------ PNG

interface Img {
  w: number;
  h: number;
  data: Uint8Array; // RGBA
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(buf: Buffer): Img {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8,
    w = 0,
    h = 0,
    depth = 8,
    type = 6,
    interlace = 0;
  const idat: Buffer[] = [];
  let plte: Buffer | null = null,
    trns: Buffer | null = null;
  while (p < buf.length) {
    const n = buf.readUInt32BE(p),
      tag = buf.toString('ascii', p + 4, p + 8),
      d = buf.subarray(p + 8, p + 8 + n);
    if (tag === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      depth = d[8];
      type = d[9];
      interlace = d[12];
    } else if (tag === 'IDAT') idat.push(d);
    else if (tag === 'PLTE') plte = d;
    else if (tag === 'tRNS') trns = d;
    else if (tag === 'IEND') break;
    p += 12 + n;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]!;
  const bps = depth / 8; // bytes per sample (1 or 2)
  const bpp = Math.max(1, channels * bps);
  const stride = Math.ceil((w * channels * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0,
        b = prev[i],
        c = i >= bpp ? prev[i - bpp] : 0;
      let x = line[i];
      if (ft === 1) x += a;
      else if (ft === 2) x += b;
      else if (ft === 3) x += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c,
          pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = x & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (depth < 8) {
        const bit = (line[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
        if (type === 3 && plte) {
          out[o] = plte[bit * 3];
          out[o + 1] = plte[bit * 3 + 1];
          out[o + 2] = plte[bit * 3 + 2];
          out[o + 3] = trns && bit < trns.length ? trns[bit] : 255;
        } else {
          const g = (bit * 255) / ((1 << depth) - 1);
          out[o] = out[o + 1] = out[o + 2] = g;
          out[o + 3] = 255;
        }
        continue;
      }
      const s = (k: number): number => line[(x * channels + k) * bps];
      if (type === 0) {
        out[o] = out[o + 1] = out[o + 2] = s(0);
        out[o + 3] = 255;
      } else if (type === 2) {
        out[o] = s(0);
        out[o + 1] = s(1);
        out[o + 2] = s(2);
        out[o + 3] = 255;
      } else if (type === 3) {
        const i = s(0);
        out[o] = plte![i * 3];
        out[o + 1] = plte![i * 3 + 1];
        out[o + 2] = plte![i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (type === 4) {
        out[o] = out[o + 1] = out[o + 2] = s(0);
        out[o + 3] = s(1);
      } else {
        out[o] = s(0);
        out[o + 1] = s(1);
        out[o + 2] = s(2);
        out[o + 3] = s(3);
      }
    }
    prev = line;
  }
  return { w, h, data: out };
}

function encodePng(img: Img, alpha = true): Buffer {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc((img.w * ch + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (img.w * ch + 1)] = 0;
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4,
        d = y * (img.w * ch + 1) + 1 + x * ch;
      raw[d] = img.data[s];
      raw[d + 1] = img.data[s + 1];
      raw[d + 2] = img.data[s + 2];
      if (alpha) raw[d + 3] = img.data[s + 3];
    }
  }
  const chunk = (tag: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(tag, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 7 })), chunk('IEND', Buffer.alloc(0))]);
}

/** area-averaging downscale */
function resize(img: Img, w: number, h: number): Img {
  if (img.w === w && img.h === h) return img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.h) / h),
      y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.w) / w),
        x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / w));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.w + sx) * 4;
          acc[0] += img.data[o];
          acc[1] += img.data[o + 1];
          acc[2] += img.data[o + 2];
          acc[3] += img.data[o + 3];
          n++;
        }
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = acc[k] / n;
    }
  }
  return { w, h, data: out };
}

const imgCache = new Map<string, Img>();
function loadImage(path: string, w: number, h: number): Img {
  const k = `${path}@${w}x${h}`;
  let img = imgCache.get(k);
  if (!img) {
    console.log('  texture', posix.basename(path.replace(/\\/g, '/')), `-> ${w}x${h}`);
    img = resize(decodePng(readFileSync(path)), w, h);
    imgCache.set(k, img);
  }
  return img;
}

/**
 * Fill the triangles of a part in texture space (with a one-pixel bleed),
 * calling paint once per covered pixel with the triangle, the pixel offset and
 * the barycentric weights of its corners (so values can be interpolated).
 */
function paintTriangles(img: Img, part: Part, keep: (t: number) => boolean, paint: (t: number, o: number, bary: V3) => void): void {
  const done = new Uint8Array(img.w * img.h);
  for (let t = 0; t < part.idx.length; t += 3) {
    if (!keep(t)) continue;
    const P = [0, 1, 2].map((k) => {
      const i = part.idx[t + k];
      return [part.uv[i * 2] * img.w, part.uv[i * 2 + 1] * img.h];
    });
    const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])) - 1),
      maxX = Math.min(img.w - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])) + 1);
    const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])) - 1),
      maxY = Math.min(img.h - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])) + 1);
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    const edge = (a: number[], b: number[], x: number, y: number): number => ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / area;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5,
          py = y + 0.5;
        const w0 = edge(P[1], P[2], px, py),
          w1 = edge(P[2], P[0], px, py),
          w2 = edge(P[0], P[1], px, py);
        // bleed: allow a little outside the edges (in barycentric units of ~1px)
        const tol = 1.2 / Math.sqrt(Math.abs(area));
        if (w0 >= -tol && w1 >= -tol && w2 >= -tol && !done[y * img.w + x]) {
          done[y * img.w + x] = 1;
          const s = w0 + w1 + w2;
          paint(t, (y * img.w + x) * 4, [w0 / s, w1 / s, w2 / s]);
        }
      }
  }
}

/** interpolate a per-vertex scalar of a triangle at barycentric weights */
function interp(part: Part, t: number, bary: V3, value: (vertex: number) => number): number {
  return bary[0] * value(part.idx[t]) + bary[1] * value(part.idx[t + 1]) + bary[2] * value(part.idx[t + 2]);
}

// ------------------------------------------------------------------ outfit painting

const SKIN = 0,
  SHIRT = 1,
  TROUSERS = 2,
  SHOES = 3;

const TORSO = 1,
  ARM = 2,
  LEG = 3,
  FOOT = 4;

/** Body region of a vertex from the bone that drives it (0 = head, hands: always skin). */
function regionOf(boneName: string): number {
  const n = boneName.replace('mixamorig', '');
  if (/Foot|ToeBase/.test(n)) return FOOT;
  if (/Hips|UpLeg|^(Left|Right)Leg$/.test(n)) return LEG;
  if (/^Spine|Shoulder|Hips/.test(n)) return TORSO;
  if (/^(Left|Right)Arm$/.test(n)) return ARM;
  return 0;
}

interface Marks {
  shoulder: number;
  waist: number;
  ankle: number;
  neck: number;
}

/**
 * Paint a T-shirt, trousers and shoes onto a body's texture. Hems are cut per
 * pixel by interpolated height (straight lines), regions by the driving bone.
 */
function paintOutfit(img: Img, part: Part, bones: Bone[], h: Marks, paint: (cat: number, o: number) => void): void {
  const region = new Int8Array(part.pos.length / 3);
  for (let i = 0; i < region.length; i++) region[i] = regionOf(bones[part.bone[i]].name);
  const majority = (t: number): number => {
    const c = [region[part.idx[t]], region[part.idx[t + 1]], region[part.idx[t + 2]]];
    for (const x of c) if (c.filter((y) => y === x).length >= 2) return x;
    return c[0];
  };
  paintTriangles(
    img,
    part,
    () => true,
    (t, o, bary) => {
      const r = majority(t);
      const y = interp(part, t, bary, (v) => part.pos[v * 3 + 1]);
      let cat = SKIN;
      if (r === FOOT || y < h.ankle) cat = SHOES;
      else if (r === LEG || r === TORSO) cat = y > h.neck ? SKIN : y > h.waist - 0.03 ? SHIRT : TROUSERS;
      else if (r === ARM) cat = y > h.shoulder - 0.11 ? SHIRT : SKIN;
      if (cat !== SKIN) paint(cat, o);
    },
  );
}

// ------------------------------------------------------------------ animation

interface BonePose {
  q?: Q;
  /** translation offset from the rest position, metres */
  p?: V3;
}
type Pose = Record<string, BonePose>;

interface ClipDef {
  name: string;
  duration: number;
  pose: (t: number, u: number) => Pose; // u = t / duration
}

interface Track {
  bone: string;
  times: number[];
  rot?: Q[];
  pos?: V3[];
}

interface Clip {
  name: string;
  tracks: Track[];
}

function sampleClip(def: ClipDef, fps = 24): Clip {
  const n = Math.max(2, Math.round(def.duration * fps));
  const samples: { t: number; pose: Pose }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * def.duration;
    samples.push({ t, pose: def.pose(t, i / n) });
  }
  const names = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.pose)) names.add(k);
  const tracks: Track[] = [];
  for (const b of names) {
    const rot = samples.map((s) => s.pose[b]?.q ?? ([0, 0, 0, 1] as Q));
    const pos = samples.map((s) => s.pose[b]?.p ?? ([0, 0, 0] as V3));
    const tr: Track = { bone: b, times: samples.map((s) => s.t) };
    if (rot.some((q) => Math.abs(q[3] - 1) > 1e-6)) tr.rot = rot;
    if (pos.some((p) => len(p) > 1e-6)) tr.pos = pos;
    if (tr.rot || tr.pos) tracks.push(tr);
  }
  return { name: def.name, tracks };
}

const TAU = Math.PI * 2;
const d2r = (d: number): number => (d * Math.PI) / 180;

/**
 * Pose helpers. Every bone's rest rotation is the identity in model space
 * (X right, Y up, -Z forward), so: arms hang along -Y, rotZ(+) raises the
 * right arm out and up, rotZ(-) the left; rotX(+) swings a leg or arm
 * forward; rotX(-) on the spine leans forward; rotY turns.
 */
const R = 'mixamorigRight',
  L = 'mixamorigLeft';

function armsUp(pose: Pose, amount: number, pump = 0, spread = 0): void {
  // 135 deg from the A-pose puts the arm straight up
  pose[`${R}Arm`] = { q: qChain(qZ(d2r((120 + spread) * amount)), qX(d2r(10 * amount))) };
  pose[`${L}Arm`] = { q: qChain(qZ(d2r(-(120 + spread) * amount)), qX(d2r(10 * amount))) };
  pose[`${R}ForeArm`] = { q: qChain(qZ(d2r(-25 * amount + pump)), qX(d2r(-10 * amount))) };
  pose[`${L}ForeArm`] = { q: qChain(qZ(d2r(25 * amount - pump)), qX(d2r(-10 * amount))) };
}

function armsDown(pose: Pose, swingR: number, swingL: number, elbow: number): void {
  // relaxed: arms a little closer to the body than the A-pose, swinging about X
  pose[`${R}Arm`] = { q: qChain(qZ(d2r(-28)), qX(swingR)) };
  pose[`${L}Arm`] = { q: qChain(qZ(d2r(28)), qX(swingL)) };
  pose[`${R}ForeArm`] = { q: qX(elbow) };
  pose[`${L}ForeArm`] = { q: qX(elbow) };
}

function crowdClips(): ClipDef[] {
  const idle: ClipDef = {
    name: 'Idle',
    duration: 4,
    pose: (t) => {
      const p: Pose = {};
      const sway = Math.sin((t / 4) * TAU);
      p.mixamorigHips = { q: qZ(d2r(1.5) * sway), p: [0.012 * sway, -0.004 * Math.abs(sway), 0] };
      p.mixamorigSpine = { q: qChain(qZ(d2r(-1.2) * sway), qX(d2r(0.8) * Math.sin((t / 2.6) * TAU))) };
      p.mixamorigSpine1 = { q: qX(d2r(-1.0) + d2r(1.2) * Math.sin((t / 2.6) * TAU + 0.5)) };
      p.mixamorigNeck = { q: qY(d2r(6) * Math.sin((t / 4) * TAU + 1.2)) };
      p.mixamorigHead = { q: qChain(qY(d2r(8) * Math.sin((t / 4) * TAU + 1.2)), qX(d2r(2) * Math.sin((t / 3) * TAU))) };
      armsDown(p, d2r(3) * Math.sin((t / 4) * TAU), d2r(-3) * Math.sin((t / 4) * TAU), d2r(18));
      return p;
    },
  };
  const cheer: ClipDef = {
    name: 'Cheer',
    duration: 1.2,
    pose: (t, u) => {
      const p: Pose = {};
      // arms shoot up in the first fifth, then pump twice
      const up = smooth(Math.min(1, u / 0.2));
      const pump = up * d2r(14) * Math.sin(u * 2 * TAU);
      armsUp(p, up, pump, 12 * Math.sin(u * TAU));
      const bob = Math.max(0, Math.sin(u * 2 * TAU));
      p.mixamorigHips = { p: [0, -0.03 * bob, 0] };
      p.mixamorigSpine = { q: qX(d2r(6) * up - d2r(4) * bob) };
      p.mixamorigSpine1 = { q: qX(d2r(4) * up) };
      p.mixamorigHead = { q: qX(d2r(8) * up) };
      const knee = d2r(12) * bob;
      for (const s of [R, L]) {
        p[`${s}UpLeg`] = { q: qX(knee) };
        p[`${s}Leg`] = { q: qX(-2 * knee) };
        p[`${s}Foot`] = { q: qX(knee) };
      }
      return p;
    },
  };
  const jump: ClipDef = {
    name: 'Jump',
    duration: 1.4,
    pose: (t, u) => {
      const p: Pose = {};
      // crouch 0-0.25, airborne 0.25-0.7, land 0.7-1
      let y = 0,
        knee = 0,
        up = 0;
      if (u < 0.25) {
        const k = smooth(u / 0.25);
        knee = d2r(40) * k;
        y = -0.12 * k;
        up = 0.3 * k;
      } else if (u < 0.7) {
        const k = (u - 0.25) / 0.45;
        y = 0.32 * 4 * k * (1 - k) - 0.0;
        knee = d2r(40) * (1 - Math.min(1, k * 4)) + d2r(25) * Math.max(0, k - 0.6);
        up = 1;
      } else {
        const k = (u - 0.7) / 0.3;
        knee = d2r(30) * (1 - smooth(k));
        y = -0.09 * (1 - smooth(k)) * Math.sin(k * Math.PI);
        up = 1 - smooth(k);
      }
      // the hips drop by what the knees take, and the pelvis rides the jump
      const drop = 0.42 * (1 - Math.cos(knee));
      p.mixamorigHips = { p: [0, y - drop, 0] };
      for (const s of [R, L]) {
        p[`${s}UpLeg`] = { q: qX(knee) };
        p[`${s}Leg`] = { q: qX(-2 * knee) };
        p[`${s}Foot`] = { q: qX(knee - (u > 0.25 && u < 0.7 ? d2r(20) : 0)) };
      }
      armsUp(p, up, 0, 20 * (1 - up));
      p.mixamorigSpine = { q: qX(d2r(-10) * (knee / d2r(40)) + d2r(4) * up) };
      p.mixamorigHead = { q: qX(d2r(10) * up) };
      return p;
    },
  };
  const wave: ClipDef = {
    name: 'Wave',
    duration: 1.6,
    pose: (t, u) => {
      const p: Pose = {};
      const up = smooth(Math.min(1, u / 0.25, (1 - u) / 0.2));
      const w = up * d2r(28) * Math.sin(u * 3 * TAU);
      p[`${R}Arm`] = { q: qChain(qZ(d2r(105) * up - d2r(28) * (1 - up)), qX(d2r(12) * up)) };
      p[`${R}ForeArm`] = { q: qChain(qZ(d2r(-20) * up + w), qX(d2r(18) * (1 - up))) };
      p[`${R}Hand`] = { q: qZ(w * 0.6) };
      p[`${L}Arm`] = { q: qZ(d2r(28)) };
      p[`${L}ForeArm`] = { q: qX(d2r(18)) };
      p.mixamorigSpine = { q: qZ(d2r(-3) * up) };
      p.mixamorigHead = { q: qY(d2r(-10) * up) };
      return p;
    },
  };
  return [idle, cheer, jump, wave];
}

function playerClips(): ClipDef[] {
  const idle: ClipDef = {
    name: 'idle',
    duration: 3.2,
    pose: (t) => {
      const p: Pose = {};
      const breathe = Math.sin((t / 3.2) * TAU);
      const sway = Math.sin((t / 3.2) * TAU * 0.5 + 1);
      p.mixamorigHips = { q: qZ(d2r(0.8) * sway), p: [0.006 * sway, 0.004 * breathe, 0] };
      p.mixamorigSpine = { q: qX(d2r(1.0) * breathe) };
      p.mixamorigSpine1 = { q: qX(d2r(1.2) * breathe) };
      p.mixamorigSpine2 = { q: qX(d2r(-1.4) * breathe) };
      p[`${R}Shoulder`] = { q: qZ(d2r(1.5) * breathe) };
      p[`${L}Shoulder`] = { q: qZ(d2r(-1.5) * breathe) };
      armsDown(p, d2r(2) * breathe, d2r(2) * breathe, d2r(22));
      return p;
    },
  };
  const gait = (name: string, duration: number, stride: number, knee: number, armSwing: number, elbow: number, bob: number, lean: number): ClipDef => ({
    name,
    duration,
    pose: (t, u) => {
      const p: Pose = {};
      const ph = u * TAU;
      const r = Math.sin(ph),
        l = Math.sin(ph + Math.PI);
      // the swinging leg bends at the knee just after toe-off and is straight again by heel strike
      const kneeR = knee * Math.max(0, Math.sin(ph + Math.PI * 0.75)) ** 1.5 + knee * 0.12;
      const kneeL = knee * Math.max(0, Math.sin(ph + Math.PI * 1.75)) ** 1.5 + knee * 0.12;
      p[`${R}UpLeg`] = { q: qX(stride * r) };
      p[`${L}UpLeg`] = { q: qX(stride * l) };
      p[`${R}Leg`] = { q: qX(-kneeR) };
      p[`${L}Leg`] = { q: qX(-kneeL) };
      p[`${R}Foot`] = { q: qX(kneeR * 0.5 - stride * r * 0.4) };
      p[`${L}Foot`] = { q: qX(kneeL * 0.5 - stride * l * 0.4) };
      p.mixamorigHips = { q: qChain(qY(d2r(4) * r), qZ(d2r(2) * Math.sin(ph))), p: [0, -bob * (1 - Math.abs(Math.cos(ph))) - 0.01, 0] };
      p.mixamorigSpine = { q: qChain(qX(-lean), qY(d2r(-5) * r)) };
      p.mixamorigSpine1 = { q: qY(d2r(-3) * r) };
      p.mixamorigHead = { q: qY(d2r(5) * r) };
      armsDown(p, armSwing * l, armSwing * r, elbow);
      return p;
    },
  });
  return [idle, gait('walk', 1.1, d2r(24), d2r(42), d2r(18), d2r(20), 0.025, d2r(2)), gait('run', 0.7, d2r(38), d2r(70), d2r(32), d2r(70), 0.05, d2r(8))];
}

/** Forward kinematics for sanity checks: world position of each bone head. */
function fk(bones: Bone[], pose: Pose): V3[] {
  const wq: Q[] = [],
    wp: V3[] = [];
  bones.forEach((b, i) => {
    const bp = pose[b.name] ?? {};
    const q = bp.q ?? ([0, 0, 0, 1] as Q);
    const local = add(b.parent >= 0 ? sub(b.head, bones[b.parent].head) : b.head, bp.p ?? [0, 0, 0]);
    if (b.parent < 0) {
      wq[i] = q;
      wp[i] = local;
    } else {
      wq[i] = qMul(wq[b.parent], q);
      wp[i] = add(wp[b.parent], qRot(wq[b.parent], local));
    }
  });
  return wp;
}

// ------------------------------------------------------------------ glTF writer

interface Material {
  name: string;
  image: Img;
  alpha?: 'MASK' | 'BLEND';
  doubleSided?: boolean;
  roughness?: number;
}

interface RigSet {
  bones: Bone[];
  parts: Part[];
  /** node name of the mesh (skinned to these bones) */
  meshName: string;
}

interface GltfModel {
  materials: Material[];
  rigs: RigSet[];
  clips: Clip[];
}

function writeGlb(model: GltfModel, path: string): void {
  const bin: Buffer[] = [];
  let binLen = 0;
  const bufferViews: unknown[] = [],
    accessors: unknown[] = [];
  const view = (data: Buffer, target?: number): number => {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) {
      bin.push(Buffer.alloc(pad));
      binLen += pad;
    }
    bin.push(data);
    const bv = { buffer: 0, byteOffset: binLen, byteLength: data.length, target };
    binLen += data.length;
    bufferViews.push(bv);
    return bufferViews.length - 1;
  };
  const accessor = (arr: Float32Array | Uint8Array | Uint16Array | Uint32Array, type: string, target?: number, minmax = false): number => {
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    const componentType = arr instanceof Float32Array ? 5126 : arr instanceof Uint8Array ? 5121 : arr instanceof Uint16Array ? 5123 : 5125;
    const acc: Record<string, unknown> = { bufferView: view(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), target), componentType, count: arr.length / comps, type };
    if (minmax) {
      const min = Array(comps).fill(Infinity),
        max = Array(comps).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) {
        min[i % comps] = Math.min(min[i % comps], arr[i]);
        max[i % comps] = Math.max(max[i % comps], arr[i]);
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // one image per distinct bitmap (materials may share one)
  const imageOf = new Map<Img, number>();
  const images: unknown[] = [];
  for (const m of model.materials) {
    if (imageOf.has(m.image)) continue;
    imageOf.set(m.image, images.length);
    images.push({ bufferView: view(encodePng(m.image, m.alpha !== undefined || m.name === 'atlas')), mimeType: 'image/png', name: m.name });
  }
  const textures = images.map((_, i) => ({ source: i, sampler: 0 }));
  const materials = model.materials.map((m) => ({
    name: m.name,
    pbrMetallicRoughness: { baseColorTexture: { index: imageOf.get(m.image)! }, metallicFactor: 0, roughnessFactor: m.roughness ?? 0.85 },
    alphaMode: m.alpha ?? 'OPAQUE',
    alphaCutoff: m.alpha === 'MASK' ? 0.4 : undefined,
    doubleSided: m.doubleSided ?? false,
  }));

  const nodes: Record<string, unknown>[] = [];
  const skins: unknown[] = [];
  const meshes: unknown[] = [];
  const sceneNodes: number[] = [];
  const nodeOf = new Map<string, number>(); // bone name -> node (first rig wins for clips; clips target every rig that has the bone)
  const boneNodes: Map<string, number>[] = [];

  for (const rig of model.rigs) {
    const first = nodes.length;
    const map = new Map<string, number>();
    rig.bones.forEach((b, i) => {
      const local = b.parent >= 0 ? sub(b.head, rig.bones[b.parent].head) : b.head;
      nodes.push({ name: b.name, translation: local, children: [] as number[] });
      map.set(b.name, first + i);
      if (b.parent >= 0) (nodes[first + b.parent].children as number[]).push(first + i);
      else sceneNodes.push(first + i);
      if (!nodeOf.has(b.name)) nodeOf.set(b.name, first + i);
    });
    boneNodes.push(map);
    for (const n of nodes.slice(first)) if ((n.children as number[]).length === 0) delete n.children;
    const ibm = new Float32Array(rig.bones.length * 16);
    rig.bones.forEach((b, i) => {
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b.head[0], -b.head[1], -b.head[2], 1], i * 16);
    });
    skins.push({ name: `${rig.meshName}-skin`, joints: rig.bones.map((_, i) => first + i), skeleton: first, inverseBindMatrices: accessor(ibm, 'MAT4') });
    const primitives = rig.parts.map((p) => {
      const idx = p.pos.length / 3 > 65535 ? new Uint32Array(p.idx) : new Uint16Array(p.idx);
      return {
        attributes: {
          POSITION: accessor(new Float32Array(p.pos), 'VEC3', 34962, true),
          NORMAL: accessor(new Float32Array(p.nrm), 'VEC3', 34962),
          TEXCOORD_0: accessor(new Float32Array(p.uv), 'VEC2', 34962),
          JOINTS_0: accessor(new Uint8Array(p.joints), 'VEC4', 34962),
          WEIGHTS_0: accessor(new Float32Array(p.weights), 'VEC4', 34962),
        },
        indices: accessor(idx, 'SCALAR', 34963),
        material: p.material,
        mode: 4,
      };
    });
    meshes.push({ name: rig.meshName, primitives });
    nodes.push({ name: rig.meshName, mesh: meshes.length - 1, skin: skins.length - 1 });
    sceneNodes.push(nodes.length - 1);
  }

  const animations = model.clips.map((clip) => {
    const samplers: unknown[] = [],
      channels: unknown[] = [];
    for (const tr of clip.tracks) {
      const times = accessor(new Float32Array(tr.times), 'SCALAR', undefined, true);
      for (const map of boneNodes) {
        const node = map.get(tr.bone);
        if (node === undefined) continue;
        if (tr.rot) {
          samplers.push({ input: times, output: accessor(new Float32Array(tr.rot.flat()), 'VEC4'), interpolation: 'LINEAR' });
          channels.push({ sampler: samplers.length - 1, target: { node, path: 'rotation' } });
        }
        if (tr.pos) {
          const rig = model.rigs[boneNodes.indexOf(map)];
          const b = rig.bones.find((x) => x.name === tr.bone)!;
          const rest = b.parent >= 0 ? sub(b.head, rig.bones[b.parent].head) : b.head;
          samplers.push({ input: times, output: accessor(new Float32Array(tr.pos.flatMap((p) => add(rest, p))), 'VEC3'), interpolation: 'LINEAR' });
          channels.push({ sampler: samplers.length - 1, target: { node, path: 'translation' } });
        }
      }
    }
    return { name: clip.name, samplers, channels };
  });

  const json = {
    asset: { version: '2.0', generator: 'pingverse build-humans (MakeHuman CC0 assets)' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes,
    skins,
    materials,
    textures,
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
    animations,
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  let binBuf = Buffer.concat(bin);
  if (binBuf.length % 4) binBuf = Buffer.concat([binBuf, Buffer.alloc(4 - (binBuf.length % 4))]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const ch = (len: number, type: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, ch(jsonBuf.length, 0x4e4f534a), jsonBuf, ch(binBuf.length, 0x004e4942), binBuf]));
  const tris = model.rigs.reduce((a, r) => a + r.parts.reduce((b, p) => b + p.idx.length / 3, 0), 0);
  console.log(`wrote ${path}: ${(header.readUInt32LE(8) / 1e6).toFixed(2)} MB, ${tris} triangles, ${model.rigs.length} rig(s), ${model.clips.length} clips`);
}

// ------------------------------------------------------------------ humans

interface Shared {
  base: Obj;
  rig: RigJson;
  weights: Record<string, [number, number][]>;
}

interface Human {
  /** morphed body, MakeHuman space */
  mh: V3[];
  /** morphed body, game space */
  pos: V3[];
  bones: Bone[];
  skin: Skin;
  toGame: (p: V3) => V3;
  /** landmark heights, metres */
  marks: Marks;
  height: number;
}

async function makeHuman(sh: Shared, macro: Macro): Promise<Human> {
  const mh = await morph(sh.base.v, macro);
  // feet on the floor: lowest body vertex (toes) at y = 0
  let floor = Infinity;
  for (let i = 0; i < 13380; i++) floor = Math.min(floor, mh[i][1]);
  const toGame = (p: V3): V3 => [-p[0] * DM, (p[1] - floor) * DM, -p[2] * DM];
  const pos = mh.map(toGame);
  const bones = buildRig(sh.rig, mh, sh.base, toGame);
  const skin = bodySkin(sh.weights, bones, mh.length);
  const by = (n: string): number => bones.find((b) => b.name === n)!.head[1];
  let top = 0;
  for (let i = 0; i < 13380; i++) top = Math.max(top, pos[i][1]);
  return { mh, pos, bones, skin, toGame, height: top, marks: { shoulder: by('mixamorigRightArm'), waist: by('mixamorigSpine'), ankle: by('mixamorigRightFoot') + 0.02, neck: by('mixamorigNeck') } };
}

/** A fitted proxy (clothes, hair, eyes...) as a part. */
async function proxyPart(name: string, material: number, mhcloPath: string, h: Human, opts: PartOpts = {}): Promise<{ part: Part; mhclo: Mhclo }> {
  const mhclo = parseMhclo(mhcloPath);
  const obj = parseObj(mhclo.obj);
  if (obj.v.length !== mhclo.verts.length) throw new Error(`${name}: obj has ${obj.v.length} vertices, mhclo maps ${mhclo.verts.length}`);
  const pos = fitProxy(mhclo, h.mh).map(h.toGame);
  const skin = proxySkin(mhclo, h.skin);
  return { part: buildPart(name, material, obj, pos, skin, opts), mhclo };
}

function logFk(bones: Bone[], clip: ClipDef, at: number[]): void {
  const idx = (n: string): number => bones.findIndex((b) => b.name === n);
  for (const u of at) {
    const w = fk(bones, clip.pose(u * clip.duration, u));
    const f = (n: string): string => w[idx(n)].map((x) => x.toFixed(2)).join(',');
    console.log(`    ${clip.name} u=${u}: head ${f('mixamorigHead')} rHand ${f('mixamorigRightHand')} lHand ${f('mixamorigLeftHand')} rFoot ${f('mixamorigRightFoot')} hips ${f('mixamorigHips')}`);
  }
}

// ------------------------------------------------------------------ crowd

const TILE_W = 512,
  TILE_H = 576, // 512 of skin + a 64 px strip of hair colour
  TILE_COLS = 3,
  TILE_ROWS = 2;

async function buildCrowd(sh: Shared): Promise<void> {
  console.log('crowd');
  const atlas: Img = { w: TILE_W * TILE_COLS, h: TILE_H * TILE_ROWS, data: new Uint8Array(TILE_W * TILE_COLS * TILE_H * TILE_ROWS * 4) };
  const skins: [string, string][][] = [
    [
      ['skins/young_caucasian_male/young_lightskinned_male_diffuse.png', '#5a3d2b'],
      ['skins/young_african_male/young_darkskinned_male_diffuse.png', '#17110f'],
      ['skins/young_asian_male/young_lightskinned_male_diffuse3.png', '#1a1412'],
    ],
    [
      ['skins/young_caucasian_female/young_lightskinned_female_diffuse.png', '#6b4a2e'],
      ['skins/young_african_female/young_darkskinned_female_diffuse.png', '#17110f'],
      ['skins/young_asian_female/young_lightskinned_female_diffuse3.png', '#1a1412'],
    ],
  ];
  const trousers = ['#2b3a63', '#23232a', '#5a5f6a'];
  const shoes = ['#f0f0f0', '#1c1c1c', '#d8d0c0'];
  const hex = (s: string): number[] => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

  const rigs: RigSet[] = [];
  const bodies: { name: string; proxy: string; macro: Macro }[] = [
    { name: 'male', proxy: 'proxymeshes/male1591/male1591', macro: { gender: 1, age: 0.5, muscle: 0.5, weight: 0.5, height: 0.5, african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 } },
    { name: 'female', proxy: 'proxymeshes/female1605/female1605', macro: { gender: 0, age: 0.5, muscle: 0.5, weight: 0.5, height: 0.5, african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 } },
  ];
  const clips = crowdClips().map((c) => sampleClip(c, 20));
  for (let row = 0; row < bodies.length; row++) {
    const b = bodies[row];
    const h = await makeHuman(sh, b.macro);
    await sysFile(`${b.proxy}.obj`);
    const bodyUv = (u: number, v: number): [number, number] => [u, (v * 512) / TILE_H];
    const { part } = await proxyPart(b.name, 0, await sysFile(`${b.proxy}.proxy`), h, { uvMap: bodyUv });
    // hair: the base mesh's own hair helper, a close-fitting cap, pointed at the hair-colour strip
    const cap = buildPart(`${b.name}-hair`, 0, sh.base, h.pos, h.skin, { faceFilter: (f) => f.g === 'helper-hair', uvMap: () => [0.5, (512 + 32) / TILE_H] });
    // paint the outfit into each of this row's skin tiles
    for (let col = 0; col < TILE_COLS; col++) {
      const [skinName, hairColor] = skins[row][col];
      const img = loadImage(await sysFile(skinName), 512, 512);
      const ox = col * TILE_W,
        oy = row * TILE_H;
      for (let y = 0; y < 512; y++)
        for (let x = 0; x < 512; x++) {
          const s = (y * 512 + x) * 4,
            d = ((oy + y) * atlas.w + ox + x) * 4;
          atlas.data[d] = img.data[s];
          atlas.data[d + 1] = img.data[s + 1];
          atlas.data[d + 2] = img.data[s + 2];
          atlas.data[d + 3] = 0; // alpha = "tint me" mask, skin is never tinted
        }
      const hc = hex(hairColor);
      for (let y = 512; y < TILE_H; y++)
        for (let x = 0; x < TILE_W; x++) {
          const d = ((oy + y) * atlas.w + ox + x) * 4;
          atlas.data.set([hc[0], hc[1], hc[2], 0], d);
        }
      const tc = hex(trousers[col]),
        sc = hex(shoes[col]);
      const tile: Img = { w: TILE_W, h: TILE_H, data: new Uint8Array(0) };
      paintOutfit(tile, part, h.bones, h.marks, (cat, o) => {
        // o is an offset in the tile; map to the atlas
        const px = (o / 4) % TILE_W,
          py = Math.floor(o / 4 / TILE_W);
        const d = ((oy + py) * atlas.w + ox + px) * 4;
        // keep a little of the skin's own shading so cloth isn't flat (read from the
        // untouched skin image, not the atlas, so overlapping bleeds don't brighten)
        const s = (Math.min(511, py) * 512 + px) * 4;
        const shade = 0.75 + (0.25 * (img.data[s] + img.data[s + 1] + img.data[s + 2])) / 3 / 190;
        const c = cat === SHIRT ? [235, 235, 235] : cat === TROUSERS ? tc : sc;
        atlas.data[d] = Math.min(255, c[0] * shade);
        atlas.data[d + 1] = Math.min(255, c[1] * shade);
        atlas.data[d + 2] = Math.min(255, c[2] * shade);
        atlas.data[d + 3] = cat === SHIRT ? 255 : 0;
      });
    }
    rigs.push({ bones: h.bones, parts: [part, cap], meshName: b.name });
    console.log(`  ${b.name}: ${part.idx.length / 3 + cap.idx.length / 3} tris, height ${h.height.toFixed(2)} m`);
    if (row === 0) for (const c of crowdClips()) logFk(h.bones, c, [0, 0.5]);
  }
  writeGlb({ materials: [{ name: 'atlas', image: atlas, roughness: 0.9 }], rigs, clips }, join(OUT_DIR, 'crowd.glb'));
}

// ------------------------------------------------------------------ player

async function buildPlayer(sh: Shared): Promise<void> {
  console.log('player');
  const h = await makeHuman(sh, { gender: 1, age: 0.5, muscle: 0.62, weight: 0.48, height: 0.55, african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 });
  const materials: Material[] = [];
  const mat = (name: string, image: Img, extra: Partial<Material> = {}): number => {
    materials.push({ name, image, ...extra });
    return materials.length - 1;
  };
  const parts: Part[] = [];
  const del = new Set<number>();

  // clothes: t-shirt + jeans, split so the game can tint the shirt alone
  await sysFile('clothes/male_casualsuit04/male_casualsuit04.obj');
  await sysFile('clothes/male_casualsuit04/male_casualsuit04.mhmat');
  const suitTex = await sysFile('clothes/male_casualsuit04/male_casualsuit04_diffuse.png');
  const suitImg = { ...loadImage(suitTex, 1024, 1024) };
  suitImg.data = new Uint8Array(suitImg.data);
  const suitMat = mat('shirt', suitImg, { roughness: 0.9 });
  const trousersMat = mat('trousers', suitImg, { roughness: 0.9 });
  const suit = await proxyPart('suit', suitMat, await sysFile('clothes/male_casualsuit04/male_casualsuit04.mhclo'), h);
  for (const v of suit.mhclo.del) del.add(v);
  // the T-shirt is the top 41 % of this suit's texture, the jeans the rest
  const sp = suit.part;
  const isShirt = (t: number): boolean => (sp.uv[sp.idx[t] * 2 + 1] + sp.uv[sp.idx[t + 1] * 2 + 1] + sp.uv[sp.idx[t + 2] * 2 + 1]) / 3 < 0.41;
  const split = (keep: (t: number) => boolean, name: string, material: number): Part => {
    const out: Part = { ...sp, name, material, idx: [] };
    for (let t = 0; t < sp.idx.length; t += 3) if (keep(t)) out.idx.push(sp.idx[t], sp.idx[t + 1], sp.idx[t + 2]);
    return out;
  };
  const shirt = split(isShirt, 'shirt', suitMat);
  const jeans = split((t) => !isShirt(t), 'trousers', trousersMat);
  // grey the shirt's texels so a tint colour reads as that colour
  paintTriangles(
    suitImg,
    shirt,
    () => true,
    (_, o) => {
      const l = 0.3 * suitImg.data[o] + 0.59 * suitImg.data[o + 1] + 0.11 * suitImg.data[o + 2];
      const g = Math.min(255, 120 + l * 0.6);
      suitImg.data[o] = suitImg.data[o + 1] = suitImg.data[o + 2] = g;
    },
  );
  parts.push(shirt, jeans);

  await sysFile('clothes/shoes04/shoes04.obj');
  const shoesMhclo = await sysFile('clothes/shoes04/shoes04.mhclo');
  const shoesMat = mat('shoes', loadImage(await sysFile('clothes/shoes04/shoes04_diffuse.png'), 512, 512));
  const shoes = await proxyPart('shoes', shoesMat, shoesMhclo, h);
  for (const v of shoes.mhclo.del) del.add(v);
  parts.push(shoes.part);

  // body: skin, minus what the clothes hide
  const skinImg = loadImage(await sysFile('skins/young_caucasian_male/young_lightskinned_male_diffuse.png'), 1024, 1024);
  const skinMat = mat('skin', skinImg, { roughness: 0.7 });
  parts.push(buildPart('body', skinMat, sh.base, h.pos, h.skin, { faceFilter: (f) => f.g === 'body' && !f.v.every((v) => del.has(v)) }));

  // eyes, eyebrows, hair
  await repoFile(MH_RAW, 'data/eyes/low-poly/low-poly.obj');
  await repoFile(MH_RAW, 'data/eyes/materials/brown.mhmat');
  const eyesMat = mat('eyes', loadImage(await repoFile(MH_RAW, 'data/eyes/materials/brown_eye.png'), 256, 256), { roughness: 0.3 });
  parts.push((await proxyPart('eyes', eyesMat, await repoFile(MH_RAW, 'data/eyes/low-poly/low-poly.mhclo'), h)).part);

  await sysFile('eyebrows/eyebrow001/eyebrow001.obj');
  const browMat = mat('eyebrows', loadImage(await sysFile('eyebrows/eyebrow001/eyebrow001.png'), 256, 256), { alpha: 'MASK', doubleSided: true });
  parts.push((await proxyPart('eyebrows', browMat, await sysFile('eyebrows/eyebrow001/eyebrow001.mhclo'), h)).part);

  await sysFile('hair/short02/short02.obj');
  const hairMat = mat('hair', loadImage(await sysFile('hair/short02/short02_diffuse.png'), 512, 512), { alpha: 'MASK', doubleSided: true, roughness: 0.6 });
  parts.push((await proxyPart('hair', hairMat, await sysFile('hair/short02/short02.mhclo'), h)).part);

  const clips = playerClips().map((c) => sampleClip(c, 24));
  for (const c of playerClips()) logFk(h.bones, c, [0, 0.25, 0.5]);
  for (const p of parts) console.log(`  ${p.name}: ${p.idx.length / 3} tris`);
  console.log(`  height ${h.height.toFixed(2)} m, shoulder ${h.marks.shoulder.toFixed(2)}, waist ${h.marks.waist.toFixed(2)}`);
  writeGlb({ materials, rigs: [{ bones: h.bones, parts, meshName: 'player' }], clips }, join(OUT_DIR, 'player.glb'));
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  console.log('sources');
  const base = parseObj(await repoFile(MH_RAW, 'data/3dobjs/base.obj'));
  const rig: RigJson = JSON.parse(readFileSync(await repoFile(MPFB_RAW, 'rig.mixamo.json'), 'utf8'));
  const weights = JSON.parse(readFileSync(await repoFile(MPFB_RAW, 'weights.mixamo.json'), 'utf8')).weights;
  const sh: Shared = { base, rig, weights };
  const only = process.argv[2];
  if (!only || only === 'crowd') await buildCrowd(sh);
  if (!only || only === 'player') await buildPlayer(sh);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
