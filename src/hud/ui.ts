// Spatial UI for bare hands: canvas-textured panels whose buttons are pressed
// by poking them with an index fingertip (or dwelling on them for in-game
// buttons, so a swing can never trigger one by accident). A mouse click works
// on desktop.
import * as THREE from '../render/three.ts';
import { font } from './fonts.ts';

export interface Widget {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  kind: 'button' | 'text' | 'title' | 'bar';
  onPress?: () => void;
  active?: boolean;
  disabled?: boolean;
  align?: CanvasTextAlign;
  size?: number;
  color?: string;
  /** 0..1 for 'bar' */
  value?: number;
  sub?: string;
}

export interface Cell {
  label: string;
  onPress?: () => void;
  active?: boolean;
  disabled?: boolean;
  flex?: number;
  sub?: string;
  color?: string;
}

const PAD = 28;
const GAP = 12;
/** smallest text size (layout px) any panel draws, so nothing becomes unreadable in the headset */
const MIN_TEXT = 22;
/** canvas pixels per layout pixel: panels are laid out at 1x and rendered at 2x for sharp text */
const SUPERSAMPLE = 2;

/** Row-based layout builder: each call adds a row and advances the cursor. */
export class Builder {
  widgets: Widget[] = [];
  y = PAD;
  w: number;
  h: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  title(text: string, sub = ''): this {
    this.widgets.push({ x: PAD, y: this.y, w: this.w - PAD * 2, h: 56, label: text, kind: 'title', sub });
    this.y += 56 + GAP;
    return this;
  }

  text(text: string, size = 28, color = '#d4def0', align: CanvasTextAlign = 'left', h = 0): this {
    size = Math.max(MIN_TEXT + 2, size);
    const hh = h || size + 12;
    this.widgets.push({ x: PAD, y: this.y, w: this.w - PAD * 2, h: hh, label: text, kind: 'text', size, color, align });
    this.y += hh + 4;
    return this;
  }

  lines(lines: string[], size = 24, color = '#d4def0'): this {
    for (const l of lines) this.text(l, size, color);
    return this;
  }

  row(cells: Cell[], h = 74): this {
    const total = cells.reduce((s, c) => s + (c.flex ?? 1), 0);
    const avail = this.w - PAD * 2 - GAP * (cells.length - 1);
    let x = PAD;
    for (const c of cells) {
      const w = (avail * (c.flex ?? 1)) / total;
      this.widgets.push({
        x,
        y: this.y,
        w,
        h,
        label: c.label,
        kind: c.onPress || c.disabled ? 'button' : 'text',
        onPress: c.onPress,
        active: c.active,
        disabled: c.disabled,
        sub: c.sub,
        color: c.color,
        align: 'center',
        size: 28,
      });
      x += w + GAP;
    }
    this.y += h + GAP;
    return this;
  }

  /** "label  [-] value [+]" stepper row */
  stepper(label: string, value: string, dec: () => void, inc: () => void): this {
    return this.row(
      [
        { label, flex: 3 },
        { label: '-', onPress: dec, flex: 1 },
        { label: value, flex: 3 },
        { label: '+', onPress: inc, flex: 1 },
      ],
      62,
    );
  }

  /** "label  [<] value [>]" chooser row */
  chooser(label: string, value: string, prev: () => void, next: () => void): this {
    return this.row(
      [
        { label, flex: 2.4 },
        { label: '<', onPress: prev, flex: 1 },
        { label: value, flex: 4.2 },
        { label: '>', onPress: next, flex: 1 },
      ],
      62,
    );
  }

  bar(value: number, label: string): this {
    this.widgets.push({ x: PAD, y: this.y, w: this.w - PAD * 2, h: 30, label, kind: 'bar', value });
    this.y += 30 + GAP;
    return this;
  }

  space(h = 10): this {
    this.y += h;
    return this;
  }

  /** place the next row at the bottom of the panel */
  bottom(h = 74): this {
    this.y = this.h - PAD - h;
    return this;
  }
}

export class Panel {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  widgets: Widget[] = [];
  /** require dwelling on a button instead of a poke */
  dwell = false;
  interactive = true;
  hovered: Widget | null = null;
  dwellProgress = 0;
  /** optional free-form drawing (scoreboard etc.), run after the background */
  custom: ((g: CanvasRenderingContext2D, w: number, h: number) => void) | null = null;
  readonly pxW: number;
  readonly pxH: number;
  readonly width: number;
  readonly height: number;
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private dirty = true;
  private bg: string;
  private ss: number;

  constructor(width: number, height: number, pxPerMetre = 1280, bg = 'rgba(10,14,28,0.92)') {
    this.width = width;
    this.height = height;
    this.pxW = Math.round(width * pxPerMetre);
    this.pxH = Math.round(height * pxPerMetre);
    this.bg = bg;
    this.ss = SUPERSAMPLE;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.pxW * this.ss;
    this.canvas.height = this.pxH * this.ss;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 10;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }
  set visible(v: boolean) {
    this.mesh.visible = v;
    if (!v) this.hovered = null;
  }

  build(fn: (b: Builder) => void): void {
    const b = new Builder(this.pxW, this.pxH);
    fn(b);
    this.widgets = b.widgets;
    this.hovered = null;
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** widget under a point given in panel-local metres (origin centre, +y up) */
  hit(lx: number, ly: number): Widget | null {
    const px = (lx / this.width + 0.5) * this.pxW;
    const py = (0.5 - ly / this.height) * this.pxH;
    for (const w of this.widgets) {
      if (w.kind === 'button' && !w.disabled && w.onPress && px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) return w;
    }
    return null;
  }

  setHover(w: Widget | null, progress = 0): boolean {
    const changed = w !== this.hovered;
    if (changed || (this.dwell && Math.abs(progress - this.dwellProgress) > 0.04)) {
      this.hovered = w;
      this.dwellProgress = progress;
      this.dirty = true;
    }
    return changed && !!w;
  }

  draw(): void {
    if (!this.dirty || !this.mesh.visible) return;
    this.dirty = false;
    const g = this.g;
    const W = this.pxW,
      H = this.pxH;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // lay out in 1x panel pixels, render at SUPERSAMPLE x
    g.setTransform(this.ss, 0, 0, this.ss, 0, 0);
    g.fillStyle = this.bg;
    g.beginPath();
    g.roundRect(2, 2, W - 4, H - 4, 30);
    g.fill();
    g.strokeStyle = 'rgba(90,200,255,0.55)';
    g.lineWidth = 3;
    g.stroke();
    g.textBaseline = 'middle';
    if (this.custom) this.custom(g, W, H);
    for (const w of this.widgets) {
      if (w.kind === 'title') {
        g.fillStyle = '#ffffff';
        g.font = font(800, 44);
        g.textAlign = 'left';
        g.fillText(w.label, w.x, w.y + w.h / 2, w.w * 0.62);
        if (w.sub) {
          g.fillStyle = '#7fdcff';
          g.font = font(600, 26);
          g.textAlign = 'right';
          g.fillText(w.sub, w.x + w.w, w.y + w.h / 2 + 4, w.w * 0.36);
        }
        g.fillStyle = 'rgba(90,200,255,0.5)';
        g.fillRect(w.x, w.y + w.h + 2, w.w, 2);
        continue;
      }
      if (w.kind === 'bar') {
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.beginPath();
        g.roundRect(w.x, w.y, w.w, w.h, 12);
        g.fill();
        g.fillStyle = '#35c8ff';
        g.beginPath();
        g.roundRect(w.x, w.y, Math.max(16, w.w * Math.min(1, Math.max(0, w.value ?? 0))), w.h, 12);
        g.fill();
        g.fillStyle = '#ffffff';
        g.font = font(700, 24);
        g.textAlign = 'center';
        g.fillText(w.label, w.x + w.w / 2, w.y + w.h / 2 + 1, w.w - 20);
        continue;
      }
      if (w.kind === 'button') {
        const hov = this.hovered === w;
        g.fillStyle = w.disabled ? 'rgba(255,255,255,0.05)' : w.active ? '#1f9ed6' : hov ? '#2c4f8f' : (w.color ?? 'rgba(255,255,255,0.11)');
        g.beginPath();
        g.roundRect(w.x, w.y, w.w, w.h, 16);
        g.fill();
        if (hov) {
          g.strokeStyle = '#8fe3ff';
          g.lineWidth = 4;
          g.stroke();
          if (this.dwell && this.dwellProgress > 0) {
            g.fillStyle = 'rgba(143,227,255,0.45)';
            g.beginPath();
            g.roundRect(w.x, w.y + w.h - 10, w.w * this.dwellProgress, 10, 5);
            g.fill();
          }
        }
      }
      g.fillStyle = w.disabled ? 'rgba(255,255,255,0.4)' : w.kind === 'button' ? '#ffffff' : (w.color ?? '#d4def0');
      const size = Math.max(MIN_TEXT, w.size ?? 28);
      g.font = font(w.kind === 'button' ? 700 : 600, size);
      g.textAlign = w.align ?? 'left';
      const tx = w.align === 'center' ? w.x + w.w / 2 : w.align === 'right' ? w.x + w.w : w.x;
      if (w.sub) {
        g.fillText(w.label, tx, w.y + w.h / 2 - 14, w.w - 14);
        g.fillStyle = 'rgba(215,232,255,0.9)';
        g.font = font(500, MIN_TEXT);
        g.fillText(w.sub, tx, w.y + w.h / 2 + 18, w.w - 14);
      } else g.fillText(w.label, tx, w.y + w.h / 2 + 1, w.w - 14);
    }
    this.tex.needsUpdate = true;
  }
}

interface Pointer {
  prevZ: number;
  cooldown: number;
  dwellOn: Widget | null;
  dwellT: number;
}

const _p = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/** Routes fingertip pokes / dwells and mouse clicks to panels. */
export class UIManager {
  panels: Panel[] = [];
  onClick: (() => void) | null = null;
  onHover: (() => void) | null = null;
  private pointers = new Map<string, Pointer>();
  private click: { x: number; y: number } | null = null;

  add(p: Panel): Panel {
    this.panels.push(p);
    return p;
  }

  attachMouse(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect();
      this.click = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
    });
  }

  /**
   * @param tips fingertip positions in the same space as the panels' parent
   */
  update(dt: number, tips: { id: string; pos: THREE.Vector3; allowDwell: boolean }[], camera: THREE.Camera): void {
    const hoverBy = new Map<Panel, { w: Widget | null; progress: number }>();
    for (const tip of tips) {
      let ptr = this.pointers.get(tip.id);
      if (!ptr) {
        ptr = { prevZ: 1, cooldown: 0, dwellOn: null, dwellT: 0 };
        this.pointers.set(tip.id, ptr);
      }
      if (ptr.cooldown > 0) ptr.cooldown -= dt;
      let touchedAny = false;
      for (const panel of this.panels) {
        if (!panel.visible || !panel.interactive) continue;
        panel.mesh.updateMatrix();
        _p.copy(tip.pos).applyMatrix4(_inv.copy(panel.mesh.matrix).invert());
        const inside = Math.abs(_p.x) <= panel.width / 2 && Math.abs(_p.y) <= panel.height / 2;
        if (!inside || _p.z > 0.07 || _p.z < -0.05) continue;
        touchedAny = true;
        const w = panel.hit(_p.x, _p.y);
        if (panel.dwell) {
          if (!tip.allowDwell && !w) continue;
          if (w && _p.z < 0.05) {
            if (ptr.dwellOn !== w) {
              ptr.dwellOn = w;
              ptr.dwellT = 0;
            }
            ptr.dwellT += dt;
            hoverBy.set(panel, { w, progress: Math.min(1, ptr.dwellT / 0.65) });
            if (ptr.dwellT >= 0.65 && ptr.cooldown <= 0) {
              ptr.cooldown = 0.9;
              ptr.dwellT = 0;
              this.onClick?.();
              w.onPress?.();
            }
          } else ptr.dwellOn = null;
        } else {
          if (w && !hoverBy.get(panel)?.w) hoverBy.set(panel, { w, progress: 0 });
          if (w && ptr.prevZ > 0.012 && _p.z <= 0.012 && ptr.cooldown <= 0) {
            ptr.cooldown = 0.35;
            this.onClick?.();
            w.onPress?.();
            ptr.prevZ = _p.z;
            return; // the press may have rebuilt the panels
          }
        }
        ptr.prevZ = _p.z;
      }
      if (!touchedAny) {
        ptr.prevZ = 1;
        ptr.dwellOn = null;
      }
    }

    // desktop: click through the camera
    if (this.click) {
      const c = this.click;
      this.click = null;
      _ray.setFromCamera(_ndc.set(c.x, c.y), camera);
      let best: { panel: Panel; w: Widget; d: number } | null = null;
      for (const panel of this.panels) {
        if (!panel.visible || !panel.interactive) continue;
        const hit = _ray.intersectObject(panel.mesh, false)[0];
        if (!hit || !hit.uv) continue;
        const w = panel.hit((hit.uv.x - 0.5) * panel.width, (hit.uv.y - 0.5) * panel.height);
        if (w && (!best || hit.distance < best.d)) best = { panel, w, d: hit.distance };
      }
      if (best) {
        this.onClick?.();
        best.w.onPress?.();
        return;
      }
    }

    for (const panel of this.panels) {
      const h = hoverBy.get(panel);
      if (panel.setHover(h?.w ?? null, h?.progress ?? 0)) this.onHover?.();
    }
  }

  draw(): void {
    for (const p of this.panels) p.draw();
  }
}
