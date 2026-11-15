// The game orchestrator: owns the table-space scene graph, turns tracked
// hands into the player's paddle, runs the active mode (match, drill,
// tournament, spectate, online) and drives HUD, audio, replay and progress.
import * as THREE from '../render/three.ts';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BALL, HALF_L, HALF_W, PADDLE, TABLE } from '../core/constants.ts';
import type { Side } from '../core/constants.ts';
import type { Vec3 } from '../core/math.ts';
import type { AIProfile } from '../ai/opponent.ts';
import { PERSONALITY_LABEL } from '../ai/opponent.ts';
import { GameAudio } from '../audio/audio.ts';
import { PADDLES, TABLES } from '../custom/catalog.ts';
import type { PaddleLook } from '../custom/catalog.ts';
import { buildVenue } from '../env/environments.ts';
import type { Venue } from '../env/environments.ts';
import { Progress } from '../features/progress.ts';
import { Replay } from '../features/replay.ts';
import { Panel, UIManager } from '../hud/ui.ts';
import { Menus } from '../hud/menus.ts';
import { DRILLS, Drill, MACHINE_POS } from '../modes/drill.ts';
import type { DrillDef } from '../modes/drill.ts';
import { Tournament } from '../modes/tournament.ts';
import { NetClient } from '../net/client.ts';
import type { LeaderEntry, RelayMsg } from '../net/protocol.ts';
import { ServeController } from '../paddle/serve.ts';
import { HandTracker, HandView } from '../paddle/tracking.ts';
import type { HandData, Handed } from '../paddle/tracking.ts';
import { predictFlight } from '../physics/world.ts';
import type { PhysEvent } from '../physics/world.ts';
import { Avatar } from '../render/avatar.ts';
import { BallView, classifySpin } from '../render/ballView.ts';
import { buildPaddle } from '../render/paddleModel.ts';
import { buildTable, disposeTree } from '../render/table.ts';
import { REASON_TEXT } from '../rules/match.ts';
import type { Phase, PointReason } from '../rules/match.ts';
import { MatchSession } from './session.ts';
import { font } from '../hud/fonts.ts';

export type Mode = 'menu' | 'match' | 'drill' | 'spectate';
export type MatchKind = 'quick' | 'tournament' | 'online';

export interface Host {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** the XR origin the camera hangs under */
  rig: THREE.Object3D;
  canvas: HTMLElement;
  enterXR(): void;
  exitXR(): void;
  /** show / hide the SDK's own hand models */
  setSdkHands(on: boolean): void;
}

export interface ShotInfo {
  ballKmh: number;
  swingKmh: number;
  rpm: number;
  kind: string;
  /** landing spot on the far half, table space, or null if it missed */
  landing: Vec3 | null;
}

export interface ResultInfo {
  title: string;
  lines: string[];
  won: boolean;
}

const mirror3 = (a: number[]): number[] => [-a[0], a[1], -a[2]];
/** quaternion of the same rotation seen from the other end (rotate 180 deg about Y) */
const mirrorQ = (q: number[]): number[] => {
  // R_y(pi) * q  with R_y(pi) = (0,1,0,0)
  const [x, y, z, w] = q;
  return [z, w, -x, -y];
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

export class Game {
  host: Host;
  progress = new Progress();
  audio = new GameAudio();
  ui = new UIManager();
  menus: Menus;
  tracker = new HandTracker();
  /** everything lives in table space under this root; moving it repositions the player */
  root = new THREE.Group();
  s: MatchSession = new MatchSession();
  mode: Mode = 'menu';
  matchKind: MatchKind = 'quick';
  drill: Drill | null = null;
  tournament: Tournament | null = null;
  net: NetClient | null = null;
  leaderboard: LeaderEntry[] | null = null;
  netNote = '';
  lastShot: ShotInfo | null = null;
  result: ResultInfo | null = null;
  opponentName = 'Opponent';
  opponentProfile: AIProfile | null = null;
  heldBy: Handed | null = null;
  replay = new Replay();
  paused = false;

  private venue: Venue | null = null;
  private tableMesh: THREE.Group | null = null;
  private ballView = new BallView();
  private myPaddle: THREE.Group;
  private oppPaddle: THREE.Group;
  private avatar: Avatar;
  private avatarNear: Avatar;
  private hands = { left: new HandView(), right: new HandView() };
  private hud: Panel;
  private quick: Panel;
  private toastPanel: Panel;
  private toastText = '';
  private toastSub = '';
  private toastLife = 0;
  private serve = new ServeController();
  private serveFor: 'match' | 'drill' | null = null;
  private targets: THREE.Mesh[] = [];
  private machine: THREE.Group;
  private needRecenter = 2;
  private wasXR = false;
  private prevPaddlePos = new THREE.Vector3();
  private prevPaddleQuat = new THREE.Quaternion();
  private paddleVel = new THREE.Vector3();
  private paddleAng = new THREE.Vector3();
  private paddleFresh = false;
  private hudTimer = 0;
  private time = 0;
  private replayAt = -1;
  private myServePending = false;
  private serveStreak = 0;
  private mFastest = 0;
  private mServesIn = 0;
  private mServes = 0;
  private poseTimer = 0;
  private stateTimer = 0;
  private ballSeq = 0;
  private remoteSeq = -1;
  private remoteHead = new THREE.Vector3(0, 1.6, -(HALF_L + 0.8));
  private remoteHeadQ = new THREE.Quaternion();
  private remoteFree: THREE.Vector3 | null = null;
  private remotePaddleP = new THREE.Vector3(0, 1, -(HALF_L + 0.4));
  private remotePaddleQ = new THREE.Quaternion();
  private gotRemotePose = false;
  private saveTimer = 0;
  private tournamentBusy = false;
  private cueTick = 0;
  private handStyleApplied = '';

  constructor(host: Host) {
    this.host = host;
    host.scene.add(this.root);

    try {
      const pmrem = new THREE.PMREMGenerator(host.renderer);
      host.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      host.scene.environmentIntensity = 0.3;
      pmrem.dispose();
    } catch (e) {
      console.warn('environment reflections unavailable', e);
    }

    this.root.add(this.ballView.group);
    this.myPaddle = buildPaddle(this.look());
    this.oppPaddle = buildPaddle(this.oppLook());
    this.root.add(this.myPaddle, this.oppPaddle);
    this.avatar = new Avatar(-1, 'Opponent');
    this.avatarNear = new Avatar(1, 'Player', 0x2f6fd0);
    this.avatarNear.group.visible = false;
    this.avatar.group.visible = false;
    this.oppPaddle.visible = false;
    this.root.add(this.avatar.group, this.avatarNear.group);
    this.root.add(this.hands.left.group, this.hands.right.group);

    // ball machine
    this.machine = new THREE.Group();
    const mm = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.5, metalness: 0.5 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.3), mm);
    body.position.set(0, -0.12, -0.2);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.2, 14), new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.4 }));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.08;
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, MACHINE_POS.y - 0.27, 8), mm);
    stand.position.set(0, -0.27 - (MACHINE_POS.y - 0.27) / 2, -0.2);
    this.machine.add(body, barrel, stand);
    this.machine.position.set(MACHINE_POS.x, MACHINE_POS.y, MACHINE_POS.z);
    this.machine.visible = false;
    this.root.add(this.machine);

    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 1, 28),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
      );
      t.rotation.x = -Math.PI / 2;
      t.visible = false;
      this.targets.push(t);
      this.root.add(t);
    }

    // HUD panels
    this.hud = this.ui.add(new Panel(0.62, 0.36, 1100, 'rgba(8,11,22,0.86)'));
    this.hud.interactive = false;
    this.hud.custom = (g, w, h) => this.drawHud(g, w, h);
    this.quick = this.ui.add(new Panel(0.5, 0.1, 1280, 'rgba(8,11,22,0.8)'));
    this.quick.dwell = true;
    this.toastPanel = this.ui.add(new Panel(1.0, 0.2, 900, 'rgba(8,11,22,0.78)'));
    this.toastPanel.interactive = false;
    this.toastPanel.custom = (g, w, h) => {
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = font(700, 62);
      g.fillText(this.toastText, w / 2, this.toastSub ? h * 0.38 : h / 2, w - 60);
      if (this.toastSub) {
        g.fillStyle = '#8fe3ff';
        g.font = font(600, 40);
        g.fillText(this.toastSub, w / 2, h * 0.74, w - 60);
      }
    };
    this.toastPanel.visible = false;
    this.toastPanel.mesh.position.set(0, 1.92, -0.7);
    this.toastPanel.mesh.rotation.x = 0.12;
    this.root.add(this.hud.mesh, this.quick.mesh, this.toastPanel.mesh);

    this.menus = new Menus(this);
    this.root.add(this.menus.panel.mesh);

    this.ui.onClick = () => this.audio.click();
    this.ui.onHover = () => this.audio.hover();
    this.ui.attachMouse(host.canvas);
    this.tracker.attachMouse(host.canvas);
    host.canvas.addEventListener('pointerdown', () => this.audio.unlock());

    this.progress.onUnlock = (title, desc) => {
      this.toast(title, desc, 3.5);
      this.audio.unlockChime();
    };
    this.audio.setVolume(this.progress.s.volume);

    this.applyTable();
    this.applyVenue();
    this.bindSession();
    this.layoutHud();
    this.buildQuick();
    this.menus.show('main');

    const room = new URLSearchParams(location.search).get('room');
    if (room) this.menus.pendingRoom = room.toUpperCase();
  }

  // ------------------------------------------------------------ looks

  look(): PaddleLook {
    const s = this.progress.s;
    return { paddle: s.paddle, rubberColor: s.rubberColor, rubberBackColor: s.rubberBackColor, handle: s.handle, grip: s.grip, surface: s.surface };
  }

  private oppLook(id = 'pro'): PaddleLook {
    const p = PADDLES.find((x) => x.id === id) ?? PADDLES[1];
    return { paddle: p.id, rubberColor: '#111111', rubberBackColor: '#c8102e', handle: p.handle, grip: 'plain', surface: 'smooth' };
  }

  applyLook(): void {
    const old = this.myPaddle;
    this.myPaddle = buildPaddle(this.look());
    this.myPaddle.position.copy(old.position);
    this.myPaddle.quaternion.copy(old.quaternion);
    this.root.remove(old);
    disposeTree(old);
    this.root.add(this.myPaddle);
    this.progress.save();
    this.net?.relay({ k: 'look', paddle: this.progress.s.paddle, rubber: this.progress.s.rubberColor });
  }

  applyTable(id = this.progress.s.table): void {
    if (this.tableMesh) {
      this.root.remove(this.tableMesh);
      disposeTree(this.tableMesh);
    }
    this.tableMesh = buildTable(TABLES.find((t) => t.id === id) ?? TABLES[0]);
    this.root.add(this.tableMesh);
  }

  applyVenue(id = this.progress.s.environment): void {
    if (this.venue) {
      this.root.remove(this.venue.group);
      disposeTree(this.venue.group);
    }
    this.venue = buildVenue(id);
    this.root.add(this.venue.group);
    const sc = this.host.scene;
    sc.background = new THREE.Color(this.venue.background);
    sc.fog = this.venue.fog ? new THREE.Fog(this.venue.fog.color, this.venue.fog.near, this.venue.fog.far) : null;
    this.audio.setAmbience(this.venue.ambience);
    this.hudTimer = 0;
  }

  // ------------------------------------------------------------ comfort

  recenter(): void {
    this.needRecenter = 1;
  }

  /** Place the table so the player's head sits at the playing position, facing the far end. */
  private doRecenter(): void {
    const cam = this.host.camera;
    cam.updateWorldMatrix(true, false);
    const head = _v.setFromMatrixPosition(cam.matrixWorld);
    const fwd = _v2.set(0, 0, -1).transformDirection(cam.matrixWorld);
    const s = this.progress.s;
    const spectate = this.mode === 'spectate';
    // where the head should be in table space, and which way it should face
    const lx = spectate ? HALF_W + 1.5 : s.lateralOffset;
    const lz = spectate ? 0 : HALF_L + 0.72 + s.tableDistance;
    const faceYaw = spectate ? Math.PI / 2 : 0; // table-space yaw the player looks along (-Z = 0, -X = +90deg)
    const headYaw = Math.atan2(-fwd.x, -fwd.z);
    const yaw = headYaw - faceYaw;
    this.root.rotation.set(0, yaw, 0);
    const c = Math.cos(yaw),
      sn = Math.sin(yaw);
    // world = rootPos + R(yaw) * local  ->  rootPos = head - R(yaw) * local
    this.root.position.set(head.x - (c * lx + sn * lz), s.heightOffset, head.z - (-sn * lx + c * lz));
    this.root.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------ session wiring

  private bindSession(): void {
    this.s.listeners.push({
      onPhys: (e) => this.onPhys(e),
      onPhase: (p) => this.onPhase(p),
      onPoint: (w, r, edge) => this.onPoint(w, r, edge),
      onLet: () => {
        this.toast('Let', 'Replay the serve', 1.6);
        this.audio.let();
        this.myServePending = false;
      },
      onGame: (w) => {
        this.venue?.excite?.(this.s.match.phase === 'matchOver' ? 3 : 2);
        if (this.s.match.phase !== 'matchOver') this.toast(w === 1 ? 'Game to you' : `Game to ${this.opponentName}`, `Games ${this.s.match.games[0]} - ${this.s.match.games[1]}`, 2.6);
      },
      onMatch: (w) => this.onMatch(w),
      onRally: (n) => {
        if (this.mode === 'match') this.progress.rally(n);
      },
      onStroke: (by, isServe) => {
        if (by === 1 && isServe && this.mode === 'match') {
          this.myServePending = true;
          this.mServes++;
        }
      },
      onHumanServe: (side) => {
        if (side === 1 && this.mode === 'match') {
          this.serveFor = 'match';
          this.serve.begin();
        }
      },
    });
  }

  private newSession(): void {
    this.s = new MatchSession({ bestOf: this.progress.s.bestOf, strictServe: this.progress.s.strictServe }, (Date.now() & 0xfffff) + 1);
    this.bindSession();
    this.replay.clear();
    this.ballView.clearTrail();
    this.paddleFresh = false;
    this.serve.cancel();
    this.serveFor = null;
    this.drill = null;
    this.lastShot = null;
    this.myServePending = false;
    this.mFastest = 0;
    this.mServes = 0;
    this.mServesIn = 0;
    this.paused = false;
    this.replayAt = -1;
    this.gotRemotePose = false;
  }

  private enterPlay(mode: Mode): void {
    this.mode = mode;
    this.menus.hide();
    this.avatar.group.visible = mode !== 'drill';
    this.oppPaddle.visible = mode !== 'drill';
    this.avatarNear.group.visible = mode === 'spectate';
    this.machine.visible = mode === 'drill' && !!this.drill && !this.drill.def.playerServes;
    this.layoutHud();
    this.buildQuick();
    this.hudTimer = 0;
    this.needRecenter = Math.max(this.needRecenter, 1);
  }

  startQuickMatch(profile?: AIProfile): void {
    const s = this.progress.s;
    const p: AIProfile = profile ?? { name: PERSONALITY_LABEL[s.personality], difficulty: s.difficulty, personality: s.personality };
    this.newSession();
    this.matchKind = this.tournament && profile ? 'tournament' : 'quick';
    this.opponentProfile = p;
    this.opponentName = p.name;
    this.avatar.setName(`${p.name} - ${p.difficulty}`);
    this.avatar.setShirt({ defender: 0x2f8f5b, attacker: 0xd23b3b, strategist: 0x7a4fd0, spin: 0xe0932f }[p.personality]);
    this.s.setHuman(1);
    this.s.setAI(-1, p);
    this.enterPlay('match');
    this.s.start();
    this.toast(`vs ${p.name}`, `${p.difficulty.toUpperCase()} - best of ${s.bestOf}`, 2.5);
  }

  startSpectate(): void {
    const s = this.progress.s;
    this.newSession();
    const pers = ['attacker', 'defender', 'strategist', 'spin'] as const;
    const pick = pers[Math.floor(Math.random() * 4)];
    const a: AIProfile = { name: PERSONALITY_LABEL[pick], difficulty: s.difficulty, personality: pick };
    const b: AIProfile = { name: PERSONALITY_LABEL[s.personality], difficulty: s.difficulty, personality: s.personality };
    this.s.setAI(1, a);
    this.s.setAI(-1, b);
    this.opponentName = b.name;
    this.opponentProfile = b;
    this.avatar.setName(b.name);
    this.avatarNear.setName(a.name);
    this.enterPlay('spectate');
    this.s.start();
    this.toast('Spectating', `${a.name} v ${b.name}`, 2.5);
  }

  startDrill(id: string): void {
    const def: DrillDef = DRILLS.find((d) => d.id === id) ?? DRILLS[0];
    this.newSession();
    this.s.authoritative = false;
    this.s.setHuman(1);
    this.s.setRemote(-1); // nobody at the far end
    this.drill = new Drill(this.s.world, def, Math.random, this.progress.s.handedness === 'right');
    this.drill.listener = {
      onFeed: () => {
        this.machine.getWorldPosition(_v);
        this.audio.machine(_v);
        this.ballView.clearTrail();
      },
      onResult: (good, targetHit) => {
        if (targetHit) this.audio.targetHit();
        else if (good) this.audio.tick();
        if (def.playerServes) {
          this.serveStreak = good ? this.serveStreak + 1 : 0;
          this.progress.serve(good, this.serveStreak);
        }
        this.hudTimer = 0;
      },
      onNeedServe: () => {
        this.serveFor = 'drill';
        this.serve.begin();
      },
      onDone: (success) => this.onDrillDone(success),
    };
    this.enterPlay('drill');
    this.toast(def.title, def.desc, 3);
  }

  private onDrillDone(success: boolean): void {
    const d = this.drill;
    if (!d) return;
    const total = DRILLS.filter((x) => x.group === 'challenge').length;
    this.progress.challengeResult(d.def.id, d.def.goal?.kind === 'streak' ? d.bestStreak : d.score, success, total);
    this.audio.fanfare(success);
    this.result = {
      title: success ? 'Challenge complete!' : 'Challenge failed',
      won: success,
      lines: [
        d.def.title,
        `Score ${d.score}${d.def.goal ? ' / ' + d.def.goal.count : ''}`,
        `Good returns ${d.good} of ${d.attempts}  (${Math.round(d.accuracy * 100)}%)`,
        `Best streak ${d.bestStreak}`,
        `Personal best ${this.progress.profile.challengeBest[d.def.id] ?? 0}`,
      ],
    };
    this.s.world.ballLive = false;
    this.menus.show('result');
  }

  // ---- tournament

  startTournament(): void {
    this.tournament = new Tournament(this.progress.profile.name);
    this.menus.show('tournament');
  }

  playTournamentMatch(): void {
    const opp = this.tournament?.opponent;
    if (!opp?.profile) return;
    this.startQuickMatch(opp.profile);
    this.matchKind = 'tournament';
  }

  // ---- menu / pause

  toMenu(): void {
    if (this.matchKind === 'online' && this.mode === 'match') this.leaveOnline();
    this.mode = 'menu';
    this.s.paused = true;
    this.s.world.ballLive = false;
    this.serve.cancel();
    this.replay.stop();
    this.avatar.group.visible = false;
    this.avatarNear.group.visible = false;
    this.oppPaddle.visible = false;
    this.machine.visible = false;
    this.toastLife = 0;
    this.toastPanel.visible = false;
    this.layoutHud();
    this.buildQuick();
    this.menus.show('main');
    this.progress.save();
    this.needRecenter = Math.max(this.needRecenter, 1);
  }

  pause(): void {
    if (this.mode === 'menu') return;
    this.paused = true;
    if (this.matchKind !== 'online' || this.mode !== 'match') this.s.paused = true;
    this.menus.show('pause');
  }

  resume(): void {
    this.paused = false;
    this.s.paused = false;
    this.menus.hide();
  }

  replayNow(): void {
    if (this.replay.start(5, 0.3)) this.toast('Replay', 'Slow motion', 1.4);
    else this.toast('Nothing to replay yet', '', 1.2);
  }

  putPaddleDown(): void {
    this.heldBy = null;
    this.s.paddle(1).active = false;
  }

  holdPaddle(h: Handed): void {
    this.heldBy = h;
    this.progress.s.handedness = h;
    this.paddleFresh = false;
    this.progress.touch();
  }

  toast(text: string, sub = '', life = 2): void {
    this.toastText = text;
    this.toastSub = sub;
    this.toastLife = life;
    this.toastPanel.visible = true;
    this.toastPanel.invalidate();
  }

  cycleHud(): void {
    const s = this.progress.s;
    s.hudMode = s.hudMode === 'full' ? 'minimal' : s.hudMode === 'minimal' ? 'hidden' : 'full';
    this.layoutHud();
    this.progress.touch();
  }

  layoutHud(): void {
    const s = this.progress.s;
    const m = this.hud.mesh;
    const show = this.mode !== 'menu' && s.hudMode !== 'hidden';
    this.hud.visible = show;
    const k = s.hudMode === 'minimal' ? 0.55 : 1;
    if (s.hudSide === 'far') {
      m.position.set(0, 2.25, -(HALF_L + 1.6));
      m.rotation.set(0.1, 0, 0);
      m.scale.setScalar(2.6 * k);
    } else {
      const sx = s.hudSide === 'left' ? -1 : 1;
      m.position.set(sx * (HALF_W + 0.62), 1.3, -0.35);
      m.rotation.set(0, -sx * 0.62, 0);
      // ~1.3 m from the player: scaled up so the small lines stay readable
      m.scale.setScalar(1.3 * k);
    }
    this.hud.invalidate();
  }

  private buildQuick(): void {
    const inPlay = this.mode !== 'menu';
    this.quick.visible = inPlay;
    const fore = this.progress.s.handedness === 'right' ? 1 : -1;
    this.quick.mesh.position.set(-fore * 0.62, TABLE.height + 0.13, HALF_L + 0.34);
    this.quick.mesh.rotation.set(-0.75, 0, 0);
    this.quick.build((b) => {
      b.y = 12;
      b.row(
        [
          { label: 'Menu', onPress: () => this.pause() },
          { label: 'Recenter', onPress: () => this.recenter() },
          { label: 'Replay', onPress: () => this.replayNow() },
          { label: 'HUD', onPress: () => this.cycleHud() },
        ],
        104,
      );
    });
  }

  // ------------------------------------------------------------ events

  private toWorld(p: Vec3): THREE.Vector3 {
    return _v.set(p.x, p.y, p.z).applyMatrix4(this.root.matrixWorld);
  }

  private onPhys(e: PhysEvent): void {
    const wp = this.toWorld(e.pos);
    switch (e.type) {
      case 'table':
        if (e.edge) this.audio.edge(wp);
        else this.audio.table(wp, e.impact);
        break;
      case 'tableSide':
        this.audio.edge(wp);
        break;
      case 'net':
        this.audio.net(wp, e.impact);
        break;
      case 'floor':
        this.audio.floor(wp, e.impact);
        break;
      case 'paddle': {
        const sp = e.spinAfter && e.velAfter ? classifySpin(e.velAfter, e.spinAfter) : { kind: 'flat' as const, rpm: 0 };
        this.audio.paddle(wp, e.impact, sp.rpm > 1500);
        if (e.side === 1 && this.s.controller(1) === 'human' && e.velAfter && e.spinAfter) this.onMyStroke(e, sp.kind, sp.rpm);
        break;
      }
    }
    this.drill?.handle(e);
  }

  private onMyStroke(e: PhysEvent, kind: string, rpm: number): void {
    const v = e.velAfter!;
    const ballKmh = Math.hypot(v.x, v.y, v.z) * 3.6;
    const swingKmh = (e.paddleSpeed ?? 0) * 3.6;
    // analyse where it is going with the real flight model
    const ball = { pos: e.pos, vel: v, spin: e.spinAfter! };
    const fl = predictFlight(ball, 1.4, (_b, _t, ev) => ev.some((x) => x.type === 'table' || x.type === 'floor'), 12);
    const first = fl.events.find((x) => x.type === 'table' || x.type === 'floor');
    const landing = first && first.type === 'table' && first.side === -1 ? first.pos : null;
    this.lastShot = { ballKmh, swingKmh, rpm, kind, landing };
    if (ballKmh > this.mFastest) this.mFastest = ballKmh;
    this.progress.shot(ballKmh, swingKmh, rpm, kind === 'topspin');
    const s = this.progress.s;
    if (s.trajectory || (this.drill && (this.drill.def.id === 'spin' || this.drill.def.targets !== 'none'))) {
      this.ballView.setTrajectory(fl.path, landing, landing ? 0x6dff9c : 0xff6d6d);
    }
    this.hudTimer = 0;
    if (this.matchKind === 'online' && this.mode === 'match') this.sendBall('hit');
  }

  private onPhase(p: Phase): void {
    this.hudTimer = 0;
    if (p === 'preServe') this.ballView.clearTrail();
    if (p === 'rally' && this.myServePending) {
      this.myServePending = false;
      this.mServesIn++;
      this.serveStreak++;
      this.progress.serve(true, this.serveStreak);
    }
    if (this.isHost()) this.sendState();
  }

  private onPoint(winner: Side, reason: PointReason, edge: boolean): void {
    const m = this.s.match;
    if (this.myServePending) {
      this.myServePending = false;
      const ok = reason !== 'serviceFault';
      if (ok) this.mServesIn++;
      this.serveStreak = ok ? this.serveStreak + 1 : 0;
      this.progress.serve(ok, this.serveStreak);
    }
    const mine = winner === 1;
    const who = this.mode === 'spectate' ? (mine ? 'Near player' : this.opponentName) : mine ? 'Your point' : `${this.opponentName}'s point`;
    this.toast(who, (edge ? 'Edge ball - ' : '') + REASON_TEXT[reason], 1.7);
    // the crowd and the avatars react, and the AI has a word now and then
    this.venue?.excite?.(1);
    this.avatar.react(mine ? 'lose' : 'win');
    if (this.avatarNear.group.visible) this.avatarNear.react(mine ? 'win' : 'lose');
    if (this.matchKind !== 'online' && this.opponentProfile && Math.random() < 0.3) {
      const lines = AVATAR_LINES[this.opponentProfile.personality];
      this.avatar.say(lines[mine ? 1 : 0][Math.floor(Math.random() * 3)]);
    }
    if (this.mode === 'match') {
      if (mine) {
        this.audio.pointWon();
        this.progress.pointWon();
      } else this.audio.pointLost();
    }
    this.audio.cheer(Math.min(1, m.rally / 10));
    if (this.progress.s.autoReplay && m.rally >= 6 && this.matchKind !== 'online' && m.phase !== 'matchOver') this.replayAt = this.time + 0.7;
    if (this.isHost()) this.sendState(reason, winner);
  }

  private onMatch(winner: Side): void {
    const m = this.s.match;
    const won = winner === 1;
    this.audio.fanfare(won);
    this.audio.cheer(1);
    const scores = m.gameScores.map((g) => `${g[0]}-${g[1]}`).join('  ');
    if (this.mode === 'spectate') {
      this.result = { title: `${won ? 'Near player' : this.opponentName} wins`, won: true, lines: [scores, `Longest rally ${m.longestRally}`] };
      this.menus.show('result');
      return;
    }
    const acc = this.mServes > 0 ? this.mServesIn / this.mServes : 0;
    const online = this.matchKind === 'online';
    this.progress.matchFinished(
      {
        date: Date.now(),
        mode: this.matchKind,
        opponent: this.opponentName,
        won,
        games: [m.games[0], m.games[1]],
        scores: m.gameScores.map((g) => [g[0], g[1]] as [number, number]),
        longestRally: m.longestRally,
        fastestShotKmh: Math.round(this.mFastest),
        durationSec: Math.round(this.s.elapsed),
        serveAccuracy: acc,
      },
      this.opponentProfile?.difficulty ?? null,
      online,
    );
    const lines = [
      `Games ${m.games[0]} - ${m.games[1]}   (${scores})`,
      `Longest rally ${m.longestRally} strokes`,
      `Fastest shot ${Math.round(this.mFastest)} km/h`,
      `Serve accuracy ${Math.round(acc * 100)}%  (${this.mServesIn}/${this.mServes})`,
      `Match time ${fmtTime(this.s.elapsed)}`,
    ];
    this.result = { title: won ? 'You win!' : `${this.opponentName} wins`, won, lines };
    if (this.matchKind === 'tournament' && this.tournament) {
      this.tournament.reportPlayer(won, scores);
      this.tournamentBusy = true;
      if (this.tournament.status === 'champion') this.progress.trophy();
    }
    if (online && this.net?.host && this.net.peerId) {
      const me = this.progress.profile.playerId;
      this.net.send({ t: 'result', winnerId: won ? me : this.net.peerId, loserId: won ? this.net.peerId : me });
    }
    this.menus.show('result');
  }

  // ------------------------------------------------------------ multiplayer

  private isHost(): boolean {
    return this.matchKind === 'online' && this.mode === 'match' && !!this.net?.host;
  }

  netConnect(): NetClient {
    if (this.net) return this.net;
    const p = this.progress.profile;
    const net = new NetClient(NetClient.defaultUrl(), p.name, p.playerId);
    this.net = net;
    net.listener = {
      onStatus: (st) => {
        this.netNote = st === 'online' ? '' : st === 'offline' ? 'Offline' : st === 'reconnecting' ? 'Reconnecting...' : 'Connecting...';
        if (st === 'reconnecting' && this.matchKind === 'online' && this.mode === 'match') this.toast('Connection lost', 'Reconnecting...', 3);
        if (st === 'online' && this.isHost()) this.sendState();
        this.menus.refresh();
      },
      onRoom: () => this.menus.refresh(),
      onWaiting: () => {
        this.netNote = 'Looking for an opponent...';
        this.menus.refresh();
      },
      onPeer: (name) => {
        this.netNote = `${name} joined`;
        this.menus.refresh();
        if (net.host) this.startOnline();
      },
      onPeerLeft: (temporary) => {
        if (this.matchKind === 'online' && this.mode === 'match') {
          if (temporary) {
            this.s.paused = true;
            this.toast('Opponent disconnected', 'Waiting for them to reconnect...', 6);
          } else {
            this.toast('Opponent left', '', 2.5);
            this.matchKind = 'quick';
            this.toMenu();
          }
        }
        this.netNote = temporary ? 'Opponent reconnecting...' : 'Opponent left';
        this.menus.refresh();
      },
      onPeerBack: () => {
        this.s.paused = false;
        this.toast('Opponent is back', '', 1.5);
        if (this.isHost()) this.sendState();
      },
      onRelay: (d) => this.onRelay(d),
      onLeaderboard: (top) => {
        this.leaderboard = top;
        this.menus.refresh();
      },
      onError: (msg) => {
        this.netNote = msg;
        this.toast(msg, '', 2.5);
        this.menus.refresh();
      },
    };
    net.connect();
    return net;
  }

  leaveOnline(): void {
    this.net?.send({ t: 'leave' });
    if (this.net) {
      this.net.room = '';
      this.net.peerPresent = false;
    }
    this.matchKind = 'quick';
  }

  /** Host: begin the match and tell the guest. */
  startOnline(): void {
    const net = this.net;
    if (!net) return;
    const s = this.progress.s;
    net.relay({ k: 'start', bestOf: s.bestOf, table: s.table, env: s.environment });
    this.beginOnline(true);
  }

  private beginOnline(host: boolean): void {
    const net = this.net!;
    this.newSession();
    this.matchKind = 'online';
    this.opponentProfile = null;
    this.opponentName = net.peerName || 'Opponent';
    this.avatar.setName(this.opponentName);
    this.avatar.setShirt(0xd23b3b);
    this.s.setHuman(1);
    this.s.setRemote(-1);
    this.s.authoritative = host;
    // the opponent's stroke happens on their device: wait out the network
    // delay before ruling that they failed to return the ball
    this.s.deferFor = -1;
    this.s.grace = 0.2 + Math.min(0.4, net.rtt / 1000);
    this.remoteSeq = -1;
    this.enterPlay('match');
    if (host) this.s.start();
    net.relay({ k: 'look', paddle: this.progress.s.paddle, rubber: this.progress.s.rubberColor });
    this.toast(`vs ${this.opponentName}`, host ? 'You serve first' : 'Online match', 2.5);
  }

  sendReaction(text: string): void {
    this.net?.relay({ k: 'react', e: text });
    this.toast(`You: ${text}`, '', 1.2);
  }

  private sendState(reason?: PointReason, winner?: Side): void {
    const m = this.s.match;
    this.net?.relay({
      k: 'state',
      pts: [m.points[0], m.points[1]],
      games: [m.games[0], m.games[1]],
      server: m.server === 1 ? 'h' : 'g',
      phase: m.phase,
      reason,
      winner: winner === undefined ? undefined : winner === 1 ? 'h' : 'g',
      rally: m.rally,
    });
  }

  private sendBall(why: 'hit' | 'toss' | 'hold'): void {
    const b = this.s.world.ball;
    this.net?.relay({
      k: 'ball',
      why,
      p: [b.pos.x, b.pos.y, b.pos.z],
      v: [b.vel.x, b.vel.y, b.vel.z],
      s: [b.spin.x, b.spin.y, b.spin.z],
      seq: ++this.ballSeq,
    });
  }

  private onRelay(d: RelayMsg): void {
    switch (d.k) {
      case 'start':
        if (this.net && !this.net.host) {
          this.progress.s.bestOf = ([1, 3, 5, 7].includes(d.bestOf) ? d.bestOf : 3) as 1 | 3 | 5 | 7;
          this.applyTable(d.table);
          this.applyVenue(d.env);
          this.beginOnline(false);
        }
        return;
      case 'pose': {
        if (this.matchKind !== 'online') return;
        const h = mirror3(d.h),
          hq = mirrorQ(d.hq),
          p = mirror3(d.p),
          pq = mirrorQ(d.pq);
        this.remoteHead.set(h[0], h[1], h[2]);
        this.remoteHeadQ.set(hq[0], hq[1], hq[2], hq[3]);
        this.remotePaddleP.set(p[0], p[1], p[2]);
        this.remotePaddleQ.set(pq[0], pq[1], pq[2], pq[3]);
        if (d.f) {
          const f = mirror3(d.f);
          this.remoteFree = (this.remoteFree ?? new THREE.Vector3()).set(f[0], f[1], f[2]);
        } else this.remoteFree = null;
        this.gotRemotePose = true;
        return;
      }
      case 'ball': {
        if (this.matchKind !== 'online' || this.mode !== 'match' || d.seq <= this.remoteSeq) return;
        this.remoteSeq = d.seq;
        const w = this.s.world;
        const p = mirror3(d.p),
          v = mirror3(d.v),
          sp = mirror3(d.s);
        w.ball.pos = { x: p[0], y: p[1], z: p[2] };
        w.ball.vel = { x: v[0], y: v[1], z: v[2] };
        w.ball.spin = { x: sp[0], y: sp[1], z: sp[2] };
        w.ballLive = d.why !== 'hold';
        if (d.why === 'toss') {
          this.ballView.clearTrail();
          if (this.s.authoritative) this.s.match.tossed();
        } else if (d.why === 'hit') {
          // their stroke happened on their machine; feed it through our rules and effects
          w.onEvent?.({
            type: 'paddle',
            time: w.time,
            pos: { ...w.ball.pos },
            impact: Math.hypot(v[0], v[1], v[2]) * 0.6,
            side: -1,
            velAfter: { ...w.ball.vel },
            spinAfter: { ...w.ball.spin },
          });
        }
        return;
      }
      case 'state': {
        if (this.matchKind !== 'online' || this.s.authoritative) return;
        const before = this.s.match.phase;
        // host's [host, guest] -> ours [me, them]
        this.s.applyRemotePhase([d.pts[1], d.pts[0]], [d.games[1], d.games[0]], d.server === 'g' ? 1 : -1, d.phase as Phase);
        this.s.match.rally = d.rally;
        if (d.winner && d.reason) {
          const mine = d.winner === 'g';
          this.toast(mine ? 'Your point' : `${this.opponentName}'s point`, REASON_TEXT[d.reason as PointReason] ?? '', 1.7);
          if (mine) {
            this.audio.pointWon();
            this.progress.pointWon();
          } else this.audio.pointLost();
        }
        if (d.phase === 'matchOver' && before !== 'matchOver') {
          const m = this.s.match;
          m.gameScores = m.gameScores.length ? m.gameScores : [[m.points[0], m.points[1]]];
          this.onMatch(m.games[0] > m.games[1] ? 1 : -1);
        }
        this.hudTimer = 0;
        return;
      }
      case 'react':
        this.avatar.say(String(d.e).slice(0, 24));
        return;
      case 'look': {
        const old = this.oppPaddle;
        const look = this.oppLook(d.paddle);
        if (/^#[0-9a-f]{6}$/i.test(d.rubber)) look.rubberBackColor = d.rubber;
        this.oppPaddle = buildPaddle(look);
        this.oppPaddle.visible = old.visible;
        this.root.remove(old);
        disposeTree(old);
        this.root.add(this.oppPaddle);
        return;
      }
      case 'rematch':
        if (this.net?.host) this.startOnline();
        return;
    }
  }

  requestRematch(): void {
    if (this.net?.host) this.startOnline();
    else this.net?.relay({ k: 'rematch' });
  }

  // ------------------------------------------------------------ paddle from the hand

  private updatePlayerPaddle(dt: number): void {
    const body = this.s.paddle(1);
    if (this.s.controller(1) !== 'human') {
      // spectating: the near AI owns this paddle
      this.myPaddle.position.set(body.pos.x, body.pos.y, body.pos.z);
      this.myPaddle.quaternion.set(body.quat.x, body.quat.y, body.quat.z, body.quat.w);
      return;
    }
    const st = this.progress.s;
    const fore = st.handedness === 'right' ? 1 : -1;

    if (!this.heldBy) {
      // waiting to be picked up: it hovers within easy reach beside the player
      // (seated-friendly - no leaning over the table). Close a hand around the handle.
      const rackX = st.lateralOffset + fore * 0.3,
        rackZ = HALF_L + 0.3 + st.tableDistance;
      this.myPaddle.position.set(rackX, TABLE.height + 0.28 + Math.sin(this.time * 1.6) * 0.012, rackZ);
      this.myPaddle.rotation.set(0, this.time * 0.6, 0);
      body.active = false;
      const handle = _v2.set(0, -PADDLE.gripToBlade, 0).applyQuaternion(this.myPaddle.quaternion).add(this.myPaddle.position);
      for (const h of [this.tracker.right, this.tracker.left]) {
        if (!h.tracked) continue;
        if (h.source === 'mouse' || (h.palm.distanceTo(handle) < 0.14 && (h.grab > 0.5 || h.pinch))) {
          this.holdPaddle(h.handed);
          this.audio.click();
          break;
        }
      }
      if (!this.heldBy) return;
    }

    const h: HandData = this.tracker.hand(this.heldBy);
    if (!h.tracked) {
      // tracking dropped: freeze, and stop colliding if it lasts
      body.vel = { x: 0, y: 0, z: 0 };
      body.angVel = { x: 0, y: 0, z: 0 };
      if (h.lost > 0.25) {
        body.active = false;
        this.paddleFresh = false;
      }
      return;
    }

    // paddle frame from the palm: handle runs across the palm toward the
    // thumb/index web, the forehand rubber faces out of the palm
    if (h.source === 'hand') _y.copy(h.across).multiplyScalar(0.92).addScaledVector(h.fingers, 0.38);
    else if (h.source === 'controller') _y.copy(h.across).multiplyScalar(0.6).addScaledVector(h.fingers, 0.8);
    else _y.copy(h.across);
    _y.normalize();
    _z.copy(h.palmNormal).addScaledVector(_y, -h.palmNormal.dot(_y)).normalize();
    _x.crossVectors(_y, _z);
    _q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    // grip calibration
    const d2r = Math.PI / 180;
    _q.multiply(_q2.setFromEuler(_e.set(st.gripPitch * d2r, st.gripYaw * d2r, st.gripRoll * d2r, 'XYZ')));
    const pos = _v.set(0, PADDLE.gripToBlade - 0.035 + st.gripForward, 0).applyQuaternion(_q).add(h.palm);

    // optional virtual reach: amplify displacement from in front of the body
    if (st.reachScale > 1.001) {
      const ax = this.tracker.headPos.x,
        az = this.tracker.headPos.z - 0.32;
      pos.x = ax + (pos.x - ax) * st.reachScale;
      pos.z = az + (pos.z - az) * st.reachScale;
    }

    const jumped = this.paddleFresh && pos.distanceTo(this.prevPaddlePos) > 0.6;
    if (!this.paddleFresh || jumped || dt <= 0) {
      // first frame after (re)acquiring: no velocity, no sweep from a stale pose
      this.paddleVel.set(0, 0, 0);
      this.paddleAng.set(0, 0, 0);
      body.prevPos = { x: pos.x, y: pos.y, z: pos.z };
      body.prevQuat = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
      this.paddleFresh = true;
    } else {
      _v2.subVectors(pos, this.prevPaddlePos).multiplyScalar(1 / dt);
      this.paddleVel.lerp(_v2, 0.7);
      // angular velocity from the orientation change
      _q2.copy(this.prevPaddleQuat).invert().premultiply(_q);
      if (_q2.w < 0) _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w);
      const sn = Math.hypot(_q2.x, _q2.y, _q2.z);
      if (sn > 1e-6) {
        const k = (2 * Math.atan2(sn, _q2.w)) / (sn * dt);
        _v2.set(_q2.x * k, _q2.y * k, _q2.z * k);
      } else _v2.set(0, 0, 0);
      this.paddleAng.lerp(_v2, 0.6);
    }
    this.prevPaddlePos.copy(pos);
    this.prevPaddleQuat.copy(_q);

    body.pos = { x: pos.x, y: pos.y, z: pos.z };
    body.quat = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
    body.vel = { x: this.paddleVel.x, y: this.paddleVel.y, z: this.paddleVel.z };
    body.angVel = { x: this.paddleAng.x, y: this.paddleAng.y, z: this.paddleAng.z };
    body.active = this.mode !== 'menu' && !this.replay.playing && !this.paused;
    this.myPaddle.position.copy(pos);
    this.myPaddle.quaternion.copy(_q);
  }

  private updateServe(dt: number): void {
    if (!this.serve.active || !this.serveFor) return;
    if (this.paused || this.replay.playing) return;
    const st = this.progress.s;
    const fore = st.handedness === 'right' ? 1 : -1;
    const freeHand = this.heldBy ? this.tracker.hand(this.heldBy === 'right' ? 'left' : 'right') : null;
    const usable = freeHand && freeHand.tracked && freeHand.source === 'hand';
    const palm = usable ? { x: freeHand.palm.x, y: freeHand.palm.y, z: freeHand.palm.z } : null;
    const vel = usable ? { x: freeHand.palmVel.x, y: freeHand.palmVel.y, z: freeHand.palmVel.z } : null;
    const out = this.serve.update(dt, palm, vel, usable ? Math.max(0, freeHand.palmNormal.y) : 0, fore);
    const w = this.s.world;
    if (out.release) {
      if (this.serveFor === 'match') this.s.humanToss(out.pos, out.release);
      else {
        w.ball.pos = { ...out.pos };
        w.ball.vel = { ...out.release };
        w.ball.spin = { x: 0, y: 0, z: 0 };
        w.ballLive = true;
        this.drill?.tossed();
      }
      this.ballView.clearTrail();
      this.audio.tick();
      if (this.matchKind === 'online' && this.mode === 'match') this.sendBall('toss');
      this.serveFor = null;
      return;
    }
    w.ballLive = false;
    w.ball.pos = { ...out.pos };
    w.ball.vel = { x: 0, y: 0, z: 0 };
    w.ball.spin = { x: 0, y: 0, z: 0 };
    // audible countdown before an automatic toss
    if (out.cue >= 0) {
      const step = Math.floor(out.cue * 3);
      if (step !== this.cueTick && step > 0 && step < 3) this.audio.hover();
      this.cueTick = step;
    }
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const { renderer, camera } = this.host;
    const xr = renderer.xr.isPresenting;
    if (xr !== this.wasXR) {
      this.wasXR = xr;
      this.needRecenter = 12; // let tracking settle for a few frames first
      if (xr) this.audio.unlock();
    }
    if (!xr) {
      // desktop preview camera: stand at the player's end
      camera.position.set(0, 1.55, 0);
      camera.rotation.set(-0.3, 0, 0);
      this.host.rig.position.set(0, 0, 0);
      if (this.needRecenter === 0 && this.time < 0.5) this.needRecenter = 1;
    }
    if (this.needRecenter > 0 && --this.needRecenter === 0) this.doRecenter();

    const st = this.progress.s;
    this.tracker.update(renderer, camera, this.root, dt, st.handedness);
    this.updatePlayerPaddle(dt);
    this.updateServe(dt);

    // remote opponent pose
    if (this.matchKind === 'online' && this.mode === 'match' && this.gotRemotePose) {
      const b = this.s.paddle(-1);
      const k = Math.min(1, dt * 22);
      _v.set(b.pos.x, b.pos.y, b.pos.z).lerp(this.remotePaddleP, k);
      _q.set(b.quat.x, b.quat.y, b.quat.z, b.quat.w).slerp(this.remotePaddleQ, k);
      b.pos = { x: _v.x, y: _v.y, z: _v.z };
      b.quat = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
      this.avatar.setTracked(this.remoteHead, this.remoteHeadQ, this.remoteFree);
    }

    // simulation or replay
    if (this.replayAt >= 0 && this.time >= this.replayAt) {
      this.replayAt = -1;
      if (this.replay.start(4.5, 0.3)) this.toast('Replay', 'Slow motion', 1.2);
    }
    let showBall = this.s.world.ballLive || this.serve.active || ((this.mode === 'match' || this.mode === 'spectate') && this.s.match.phase === 'preServe');
    let simDt = 0;
    if (this.replay.playing) {
      const f = this.replay.update(dt);
      if (f) {
        const b = this.s.world.ball;
        this.ballView.update({ pos: { x: f.ball[0], y: f.ball[1], z: f.ball[2] }, vel: b.vel, spin: { x: 0, y: 0, z: 0 } }, true, 0, dt);
        this.myPaddle.position.set(f.p1[0], f.p1[1], f.p1[2]);
        this.myPaddle.quaternion.set(f.p1[3], f.p1[4], f.p1[5], f.p1[6]);
        this.oppPaddle.position.set(f.p2[0], f.p2[1], f.p2[2]);
        this.oppPaddle.quaternion.set(f.p2[3], f.p2[4], f.p2[5], f.p2[6]);
        this.avatar.update(dt * 0.3, this.oppPaddle.position, this.oppPaddle.quaternion);
      }
    } else {
      if (this.mode !== 'menu' && !this.paused) {
        simDt = dt;
        this.drill?.update(dt);
        this.s.update(dt);
        this.replay.record(this.s, dt);
      }
      if (this.mode === 'menu') showBall = false;
      this.ballView.showSpin = st.spinViz;
      this.ballView.update(this.s.world.ball, showBall, simDt, dt);
      const ob = this.s.paddle(-1);
      this.oppPaddle.position.set(ob.pos.x, ob.pos.y, ob.pos.z);
      this.oppPaddle.quaternion.set(ob.quat.x, ob.quat.y, ob.quat.z, ob.quat.w);
      // the players' eyes follow the ball while it is in play
      const bp = this.s.world.ball.pos;
      const look = showBall ? _ballLook.set(bp.x, bp.y, bp.z) : undefined;
      if (this.avatar.group.visible) this.avatar.update(dt, this.oppPaddle.position, this.oppPaddle.quaternion, look);
      if (this.avatarNear.group.visible) this.avatarNear.update(dt, this.myPaddle.position, this.myPaddle.quaternion, look);
    }

    // tournament: other fixtures are really played, a few ms per frame
    if (this.tournamentBusy && this.tournament) {
      if (this.tournament.pending) this.tournament.work(4);
      else {
        this.tournament.advance();
        this.tournamentBusy = false;
        this.menus.refresh();
      }
    }

    this.updateNet(dt);
    this.updateTargets();
    if (st.handStyle !== this.handStyleApplied) {
      this.handStyleApplied = st.handStyle;
      this.host.setSdkHands(st.handStyle === 'model');
    }
    this.hands.left.update(this.tracker.left);
    this.hands.right.update(this.tracker.right);
    if (st.handStyle === 'model') {
      this.hands.left.group.visible = false;
      this.hands.right.group.visible = false;
    }
    this.venue?.update(this.time);

    // UI: fingertips poke panels; the paddle hand may dwell on in-game buttons
    const tips: { id: string; pos: THREE.Vector3; allowDwell: boolean }[] = [];
    for (const h of [this.tracker.left, this.tracker.right]) {
      if (h.tracked && h.source !== 'mouse') tips.push({ id: h.handed, pos: h.indexTip, allowDwell: true });
    }
    this.ui.update(dt, tips, camera);

    if (this.toastLife > 0) {
      this.toastLife -= dt;
      if (this.toastLife <= 0) this.toastPanel.visible = false;
    }
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.5;
      this.hud.invalidate();
      this.pushVenueScore();
    }
    this.menus.update(dt);
    this.ui.draw();

    // audio listener follows the head
    camera.updateWorldMatrix(true, false);
    const e = camera.matrixWorld.elements;
    this.audio.setListener({ x: e[12], y: e[13], z: e[14] }, { x: -e[8], y: -e[9], z: -e[10] }, { x: e[4], y: e[5], z: e[6] });

    this.saveTimer += dt;
    if (this.saveTimer > 10) {
      this.saveTimer = 0;
      this.progress.flush();
    }
  }

  private updateNet(dt: number): void {
    const net = this.net;
    if (!net || this.matchKind !== 'online' || this.mode !== 'match') return;
    this.poseTimer += dt;
    if (this.poseTimer >= 1 / 30) {
      this.poseTimer = 0;
      const t = this.tracker;
      const b = this.s.paddle(1);
      const free = this.heldBy ? t.hand(this.heldBy === 'right' ? 'left' : 'right') : null;
      net.relay({
        k: 'pose',
        h: r3(t.headPos.x, t.headPos.y, t.headPos.z),
        hq: [t.headQuat.x, t.headQuat.y, t.headQuat.z, t.headQuat.w].map(r4),
        p: r3(b.pos.x, b.pos.y, b.pos.z),
        pq: [b.quat.x, b.quat.y, b.quat.z, b.quat.w].map(r4),
        f: free && free.tracked ? r3(free.palm.x, free.palm.y, free.palm.z) : undefined,
      });
      if (this.serve.active && this.serveFor === 'match') this.sendBall('hold');
    }
    if (net.host) {
      this.stateTimer += dt;
      if (this.stateTimer > 1) {
        this.stateTimer = 0;
        this.sendState();
      }
    }
  }

  private updateTargets(): void {
    const ts = this.drill && this.mode === 'drill' ? this.drill.targets : [];
    this.targets.forEach((m, i) => {
      const t = ts[i];
      m.visible = !!t;
      if (!t) return;
      m.position.set(t.x, TABLE.height + 0.0015, t.z);
      m.scale.setScalar(t.r);
      (m.material as THREE.MeshBasicMaterial).color.setHex(t.hitFlash > 0 ? 0x6dff9c : 0xffd23f);
    });
  }

  private pushVenueScore(): void {
    const v = this.venue;
    if (!v?.setScore) return;
    const m = this.s.match;
    if (this.mode === 'match' || this.mode === 'spectate') {
      v.setScore(this.mode === 'spectate' ? 'Near' : this.progress.profile.name, this.opponentName, m.points[0], m.points[1], `GAMES ${m.games[0]} - ${m.games[1]}   GAME ${m.gameNumber}`);
    } else if (this.mode === 'drill' && this.drill) {
      v.setScore('Score', 'Streak', this.drill.score, this.drill.streak, this.drill.def.title.toUpperCase());
    } else v.setScore('PINGVERSE', 'VR', 0, 0, 'WELCOME');
  }

  // ------------------------------------------------------------ HUD drawing

  private drawHud(g: CanvasRenderingContext2D, W: number, H: number): void {
    const st = this.progress.s;
    const m = this.s.match;
    g.textBaseline = 'middle';
    if (this.mode === 'drill' && this.drill) {
      const d = this.drill;
      g.fillStyle = '#6fd3ff';
      g.font = font(700, 34);
      g.textAlign = 'left';
      g.fillText(d.def.title, 28, 40, W - 56);
      g.fillStyle = '#ffffff';
      g.font = font(700, 120);
      g.textAlign = 'center';
      g.fillText(d.def.goal ? `${d.score}/${d.def.goal.count}` : String(d.score), W * 0.3, H * 0.47, W * 0.52);
      g.font = font(600, 32);
      g.textAlign = 'left';
      const rows = [
        `Streak ${d.streak}  (best ${d.bestStreak})`,
        `Accuracy ${Math.round(d.accuracy * 100)}%`,
        d.def.goal?.time ? `Time ${fmtTime(d.timeLeft)}` : `Balls ${d.balls}${d.def.goal?.balls ? '/' + d.def.goal.balls : ''}`,
        d.lastFeed ? `Feed: ${d.lastFeed}` : '',
      ];
      rows.forEach((r, i) => g.fillText(r, W * 0.58, H * 0.28 + i * 44, W * 0.4));
      this.drawShot(g, W, H);
      return;
    }
    const me = this.mode === 'spectate' ? 'Near player' : this.progress.profile.name;
    if (st.hudMode === 'minimal') {
      g.fillStyle = '#ffffff';
      g.font = font(700, 190);
      g.textAlign = 'center';
      g.fillText(`${m.points[0]} - ${m.points[1]}`, W / 2, H / 2, W - 80);
      g.fillStyle = '#ffd23f';
      g.beginPath();
      g.arc(m.server === 1 ? 46 : W - 46, H / 2, 16, 0, Math.PI * 2);
      g.fill();
      return;
    }
    // names
    g.font = font(700, 36);
    g.fillStyle = '#8fe3ff';
    g.textAlign = 'left';
    g.fillText(me, 28, 40, W * 0.42);
    g.textAlign = 'right';
    g.fillStyle = '#ffb3a8';
    g.fillText(this.opponentName, W - 28, 40, W * 0.42);
    // score
    g.fillStyle = '#ffffff';
    g.font = font(700, 150);
    g.textAlign = 'center';
    g.fillText(String(m.points[0]), W * 0.26, H * 0.4);
    g.fillText(String(m.points[1]), W * 0.74, H * 0.4);
    g.font = font(600, 60);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillText('-', W / 2, H * 0.39);
    // service indicator
    g.fillStyle = '#ffd23f';
    g.beginPath();
    g.arc(m.server === 1 ? W * 0.08 : W * 0.92, H * 0.4, 13, 0, Math.PI * 2);
    g.fill();
    g.font = font(700, 26);
    g.fillText('SERVE', m.server === 1 ? W * 0.08 : W * 0.92, H * 0.4 + 32);
    // games, rally, timer
    g.fillStyle = '#c9d4ea';
    g.font = font(600, 32);
    g.textAlign = 'left';
    g.fillText(`Game ${m.gameNumber}   Games ${m.games[0]}-${m.games[1]}`, 28, H * 0.68, W * 0.5);
    g.textAlign = 'right';
    g.fillText(`Rally ${m.rally}   ${fmtTime(this.s.elapsed)}`, W - 28, H * 0.68, W * 0.44);
    if (m.phase === 'matchOver') {
      g.fillStyle = '#ffd23f';
      g.textAlign = 'center';
      g.font = font(800, 38);
      g.fillText(m.games[0] > m.games[1] ? `${me} wins the match` : `${this.opponentName} wins the match`, W / 2, H * 0.82, W - 56);
      return;
    }
    this.drawShot(g, W, H);
  }

  private drawShot(g: CanvasRenderingContext2D, W: number, H: number): void {
    const s = this.lastShot;
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(20, H * 0.76, W - 40, H * 0.2);
    g.font = font(600, 30);
    g.textAlign = 'left';
    g.fillStyle = '#9fb4d8';
    if (!s) {
      g.fillText('Shot analysis appears after your first stroke', 34, H * 0.86, W - 68);
      return;
    }
    g.fillStyle = '#ffffff';
    const place = s.landing ? `${s.landing.x * (this.progress.s.handedness === 'right' ? 1 : -1) > 0.2 ? 'cross' : Math.abs(s.landing.x) < 0.2 ? 'middle' : 'line'} ${Math.abs(s.landing.z) > HALF_L * 0.6 ? 'deep' : 'short'}` : 'missed';
    g.fillText(`Ball ${Math.round(s.ballKmh)} km/h   Swing ${Math.round(s.swingKmh)} km/h`, 34, H * 0.81, W - 68);
    g.fillStyle = '#8fe3ff';
    g.fillText(`${s.kind} ${Math.round(s.rpm)} rpm   ${place}`, 34, H * 0.91, W - 68);
    void BALL;
  }
}

const _ballLook = new THREE.Vector3();

/** what each AI personality says after [winning, losing] a point */
const AVATAR_LINES: Record<AIProfile['personality'], [string[], string[]]> = {
  attacker: [['Too slow!', 'Smash!', 'Feel that?'], ['Lucky.', 'Again!', 'Hmph.']],
  defender: [['Patience wins.', 'Keep pushing.', 'Nice try.'], ['Well played.', 'Good shot.', 'I saw that.']],
  strategist: [['As planned.', 'Predictable.', 'Checkmate.'], ['Interesting...', 'Noted.', 'Adjusting.']],
  spin: [['Spin city!', 'Read that?', 'Wobbly!'], ['Nice read.', 'Oops.', 'Next one curls.']],
};

const r3 = (x: number, y: number, z: number): number[] => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(z * 1000) / 1000];
const r4 = (x: number): number => Math.round(x * 10000) / 10000;

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
