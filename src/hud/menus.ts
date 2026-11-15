// Menu screens. One poke-able panel that floats in front of the player; each
// screen is a function that lays out rows with the Builder.
import * as THREE from '../render/three.ts';
import { HALF_L } from '../core/constants.ts';
import type { Difficulty, Personality } from '../ai/opponent.ts';
import { PERSONALITY_LABEL } from '../ai/opponent.ts';
import { ENVIRONMENTS, GRIPS, HANDLES, PADDLES, RUBBER_COLORS, SURFACES_LOOK, TABLES, cycle } from '../custom/catalog.ts';
import { ACHIEVEMENTS, DEFAULT_SETTINGS } from '../features/progress.ts';
import type { Settings } from '../features/progress.ts';
import type { Game } from '../game/game.ts';
import { DRILLS } from '../modes/drill.ts';
import { REACTIONS, ROOM_CODE_LEN } from '../net/protocol.ts';
import { Panel } from './ui.ts';
import type { Builder } from './ui.ts';

const _fwd = new THREE.Vector3();

type Screen =
  | 'main'
  | 'quick'
  | 'practice'
  | 'challenge'
  | 'tournament'
  | 'online'
  | 'customize'
  | 'comfort'
  | 'grip'
  | 'options'
  | 'stats'
  | 'achievements'
  | 'history'
  | 'rankings'
  | 'pause'
  | 'result'
  | 'keypad';

const DIFFS: Difficulty[] = ['beginner', 'normal', 'hard', 'expert'];
const PERS: Personality[] = ['defender', 'attacker', 'strategist', 'spin'];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const step = <T>(list: T[], cur: T, dir: number): T => list[(list.indexOf(cur) + dir + list.length) % list.length];

export class Menus {
  panel: Panel;
  screen: Screen = 'main';
  /** room code from an invite link (?room=XXXXX) */
  pendingRoom = '';
  private game: Game;
  private keypad = { title: '', value: '', max: 12, done: (_v: string) => {} };
  private back: Screen = 'main';
  private placed = false;

  constructor(game: Game) {
    this.game = game;
    this.panel = game.ui.add(new Panel(0.92, 0.72, 1150));
    this.panel.visible = false;
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.panel.visible = true;
    this.placed = false;
    this.refresh();
  }

  hide(): void {
    this.panel.visible = false;
  }

  refresh(): void {
    if (!this.panel.visible) return;
    this.panel.build((b) => this.build(b));
  }

  /** Keep the panel within comfortable arm's reach of wherever the player is. */
  update(_dt: number): void {
    if (!this.panel.visible) return;
    const t = this.game.tracker;
    const m = this.panel.mesh;
    if (!t.inXR) {
      // Desktop: square in front of the camera, as close as possible while still fitting the
      // window (recomputed every frame so resizing the window keeps it filling the view)
      const cam = this.game.host.camera;
      const view = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
      const d = Math.max(this.panel.height / (view * 0.9), this.panel.width / (view * cam.aspect * 0.94));
      const fwd = _fwd.set(0, 0, -1).applyQuaternion(t.headQuat);
      m.position.copy(t.headPos).addScaledVector(fwd, d);
      m.quaternion.copy(t.headQuat);
      this.placed = true;
      return;
    }
    // VR: within easy arm's reach for poking
    const dist = 0.45;
    // re-place when the player has moved away from it in any direction (stepping back, sideways, leaning)
    const dx = m.position.x - t.headPos.x;
    const dz = m.position.z - t.headPos.z;
    const drift = Math.abs(Math.hypot(dx, dz) - dist) > 0.25 || Math.abs(dx) > 0.35;
    if (!this.placed || drift) {
      this.placed = true;
      // face the way the head is looking (yaw only), but never let it sink into the table
      const fwd = _fwd.set(0, 0, -1).applyQuaternion(t.headQuat);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      const z = Math.max(HALF_L + 0.1, t.headPos.z + fwd.z * dist);
      m.position.set(t.headPos.x + fwd.x * dist, Math.max(1.05, t.headPos.y - 0.26), z);
      m.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0, 'YXZ');
      m.rotateX(-0.28);
    }
  }

  private go(s: Screen): () => void {
    return () => this.show(s);
  }

  private set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.game.progress.s[key] = value;
    this.game.progress.save();
    this.refresh();
  }

  private openKeypad(title: string, initial: string, max: number, back: Screen, done: (v: string) => void): void {
    this.keypad = { title, value: initial, max, done };
    this.back = back;
    this.show('keypad');
  }

  private build(b: Builder): void {
    const g = this.game;
    const s = g.progress.s;
    const p = g.progress.profile;
    const backRow = (to: Screen = 'main'): void => {
      b.bottom().row([{ label: 'Back', onPress: this.go(to) }]);
    };

    switch (this.screen) {
      case 'main': {
        const d = g.progress.dailyDef;
        b.title('PINGVERSE VR', p.name);
        b.row([
          { label: 'Quick Match', sub: 'Play the AI now', onPress: this.go('quick') },
          { label: 'Practice', sub: 'Ball machine & drills', onPress: this.go('practice') },
          { label: 'Tournament', sub: '8 players, 3 rounds', onPress: () => (g.tournament && g.tournament.status === 'playing' ? this.show('tournament') : g.startTournament()) },
        ], 96);
        b.row([
          { label: 'Challenges', sub: 'Targets, streaks, clock', onPress: this.go('challenge') },
          { label: 'Multiplayer', sub: 'Rooms & matchmaking', onPress: this.go('online') },
          { label: 'Customize', sub: 'Paddle, table, venue', onPress: this.go('customize') },
        ], 96);
        b.row([
          { label: 'Records & Stats', onPress: this.go('stats') },
          { label: 'Comfort & Grip', onPress: this.go('comfort') },
          { label: 'Options', onPress: this.go('options') },
        ], 70);
        b.text(`Daily challenge: ${d.title}`, 24, '#ffd23f');
        b.bar(p.daily.progress / d.target, p.daily.done ? 'Completed' : `${p.daily.progress} / ${d.target}`);
        b.bottom(64).row([
          { label: g.heldBy ? 'Put paddle down' : `Hold paddle (${s.handedness})`, onPress: () => { if (g.heldBy) g.putPaddleDown(); else g.holdPaddle(s.handedness); this.refresh(); } },
          { label: 'Recenter', onPress: () => g.recenter() },
          { label: g.tracker.inXR ? 'Exit VR' : 'Enter VR', onPress: () => (g.tracker.inXR ? g.host.exitXR() : g.host.enterXR()) },
        ], 64);
        break;
      }

      case 'quick':
        b.title('Quick Match');
        b.chooser('Difficulty', cap(s.difficulty), () => this.set('difficulty', step(DIFFS, s.difficulty, -1)), () => this.set('difficulty', step(DIFFS, s.difficulty, 1)));
        b.chooser('Opponent', PERSONALITY_LABEL[s.personality], () => this.set('personality', step(PERS, s.personality, -1)), () => this.set('personality', step(PERS, s.personality, 1)));
        b.chooser('Match', `Best of ${s.bestOf}`, () => this.set('bestOf', step([1, 3, 5, 7] as const as (1 | 3 | 5 | 7)[], s.bestOf, -1)), () => this.set('bestOf', step([1, 3, 5, 7] as (1 | 3 | 5 | 7)[], s.bestOf, 1)));
        b.text({ beginner: 'Slow returns, basic positioning, frequent mistakes.', normal: 'Balanced returns with some spin and better positioning.', hard: 'Stronger attacks, spin variation, smarter shot selection.', expert: 'Fast reactions, strategic placement, powerful smashes.' }[s.difficulty], 22, '#9fb4d8');
        b.space(6);
        b.row([
          { label: 'Play', onPress: () => g.startQuickMatch(), color: '#1f8f4e' },
          { label: 'Play a friend', onPress: this.go('online') },
          { label: 'Spectate AI match', onPress: () => g.startSpectate() },
        ], 86);
        backRow();
        break;

      case 'practice':
      case 'challenge': {
        const group = this.screen;
        b.title(group === 'practice' ? 'Practice' : 'Challenges', group === 'practice' ? 'Unlimited' : `${Object.keys(p.challengeDone).length} completed`);
        const list = DRILLS.filter((d) => d.group === group);
        for (let i = 0; i < list.length; i += 2) {
          b.row(
            list.slice(i, i + 2).map((d) => ({
              label: (p.challengeDone[d.id] ? '* ' : '') + d.title,
              sub: d.desc + (group === 'challenge' && p.challengeBest[d.id] ? `  (best ${p.challengeBest[d.id]})` : ''),
              onPress: () => g.startDrill(d.id),
            })),
            group === 'practice' ? 84 : 96,
          );
        }
        backRow();
        break;
      }

      case 'tournament': {
        const t = g.tournament;
        b.title('Tournament', t ? ['Quarter-finals', 'Semi-finals', 'Final'][t.round] : '');
        if (!t) {
          b.row([{ label: 'Start a new tournament', onPress: () => g.startTournament() }]);
        } else {
          b.lines(t.describe(), 20);
          b.space(4);
          if (t.status === 'champion') b.text('You are the champion!', 30, '#ffd23f', 'center');
          else if (t.status === 'eliminated') b.text(t.pending ? 'You are out. Remaining matches are being played...' : `Champion: ${t.championName || 'to be decided'}`, 24, '#ffb3a8', 'center');
          const opp = t.opponent;
          b.bottom().row([
            t.status === 'playing' && opp
              ? { label: `Play ${opp.name}`, sub: `${cap(opp.profile!.difficulty)} - ${PERSONALITY_LABEL[opp.profile!.personality]}`, onPress: () => g.playTournamentMatch(), color: '#1f8f4e', flex: 2 }
              : { label: 'New tournament', onPress: () => g.startTournament(), flex: 2 },
            { label: 'Back', onPress: this.go('main') },
          ]);
        }
        break;
      }

      case 'online': {
        const net = g.net;
        b.title('Multiplayer', net ? cap(net.status) : 'Not connected');
        if (!net || net.status === 'offline') {
          b.text('Play a real opponent over the network. Requires the PINGVERSE', 22);
          b.text('server to be running (npm run server).', 22);
          b.row([{ label: 'Connect', onPress: () => { g.netConnect(); if (this.pendingRoom) g.net?.joinRoom(this.pendingRoom); this.refresh(); }, color: '#1f8f4e' }], 80);
          if (g.netNote) b.text(g.netNote, 22, '#ffb3a8');
        } else if (net.room) {
          b.text(`Room ID:  ${net.room}`, 46, '#ffd23f', 'center', 70);
          b.text(net.peerPresent ? `Opponent: ${net.peerName}` : 'Share this ID - waiting for your friend to join...', 24, '#c9d4ea', 'center');
          b.text(`Invite link:  ${location.origin}/?room=${net.room}`, 19, '#8fe3ff', 'center');
          if (net.peerPresent) {
            b.row([{ label: net.host ? 'Start match' : 'Ask for match', onPress: () => g.requestRematch(), color: '#1f8f4e' }], 80);
            b.row(REACTIONS.slice(0, 3).map((r) => ({ label: r, onPress: () => g.sendReaction(r) })), 60);
          }
          b.row([{ label: 'Leave room', onPress: () => { g.leaveOnline(); this.refresh(); } }], 60);
          if (g.netNote) b.text(g.netNote, 22, '#9fb4d8', 'center');
        } else {
          b.row([
            { label: 'Create private room', sub: 'Get a room ID to share', onPress: () => net.createRoom() },
            { label: 'Join with room ID', sub: this.pendingRoom ? `Invite: ${this.pendingRoom}` : 'Enter a code', onPress: () => this.openKeypad('Room ID', this.pendingRoom, ROOM_CODE_LEN, 'online', (v) => { if (v) net.joinRoom(v); }) },
          ], 96);
          b.row([
            { label: 'Quick matchmaking', sub: 'Play the next player waiting', onPress: () => net.quickMatch() },
            { label: 'Global rankings', onPress: () => { net.requestLeaderboard(); this.show('rankings'); } },
          ], 96);
          b.text(g.netNote || `Signed in as ${p.name}   -   ping ${Math.round(net.rtt)} ms`, 22, '#9fb4d8', 'center');
        }
        backRow();
        break;
      }

      case 'customize': {
        const paddle = PADDLES.find((x) => x.id === s.paddle) ?? PADDLES[0];
        const look = (fn: () => void): (() => void) => () => { fn(); g.applyLook(); this.refresh(); };
        const colour = (hex: string): string => RUBBER_COLORS.find((c) => c.hex === hex)?.name ?? 'Red';
        const nextColour = (hex: string, dir: number): string => {
          const i = Math.max(0, RUBBER_COLORS.findIndex((c) => c.hex === hex));
          return RUBBER_COLORS[(i + dir + RUBBER_COLORS.length) % RUBBER_COLORS.length].hex;
        };
        b.title('Customize', 'Cosmetic only - all paddles play the same');
        b.chooser('Paddle', paddle.name, look(() => { const n = cycle(PADDLES, s.paddle, -1); s.paddle = n.id; s.handle = n.handle; }), look(() => { const n = cycle(PADDLES, s.paddle, 1); s.paddle = n.id; s.handle = n.handle; }));
        b.chooser('Forehand', colour(s.rubberColor), look(() => (s.rubberColor = nextColour(s.rubberColor, -1))), look(() => (s.rubberColor = nextColour(s.rubberColor, 1))));
        b.chooser('Backhand', colour(s.rubberBackColor), look(() => (s.rubberBackColor = nextColour(s.rubberBackColor, -1))), look(() => (s.rubberBackColor = nextColour(s.rubberBackColor, 1))));
        b.chooser('Handle', (HANDLES.find((h) => h.id === s.handle) ?? HANDLES[0]).name, look(() => (s.handle = cycle(HANDLES, s.handle, -1).id)), look(() => (s.handle = cycle(HANDLES, s.handle, 1).id)));
        b.chooser('Grip', (GRIPS.find((x) => x.id === s.grip) ?? GRIPS[0]).name, look(() => (s.grip = cycle(GRIPS, s.grip, -1).id)), look(() => (s.grip = cycle(GRIPS, s.grip, 1).id)));
        b.chooser('Surface', (SURFACES_LOOK.find((x) => x.id === s.surface) ?? SURFACES_LOOK[0]).name, look(() => (s.surface = cycle(SURFACES_LOOK, s.surface, -1).id)), look(() => (s.surface = cycle(SURFACES_LOOK, s.surface, 1).id)));
        const table = (dir: number): (() => void) => () => { s.table = cycle(TABLES, s.table, dir).id; g.applyTable(); g.progress.save(); this.refresh(); };
        const venue = (dir: number): (() => void) => () => { s.environment = cycle(ENVIRONMENTS, s.environment, dir).id; g.applyVenue(); g.progress.save(); this.refresh(); };
        b.chooser('Table', (TABLES.find((t) => t.id === s.table) ?? TABLES[0]).name, table(-1), table(1));
        b.chooser('Venue', (ENVIRONMENTS.find((e) => e.id === s.environment) ?? ENVIRONMENTS[0]).name, venue(-1), venue(1));
        backRow();
        break;
      }

      case 'comfort': {
        const adj = (key: 'tableDistance' | 'heightOffset' | 'lateralOffset' | 'reachScale', d: number, lo: number, hi: number): (() => void) => () => {
          s[key] = Math.round(Math.min(hi, Math.max(lo, s[key] + d)) * 100) / 100;
          g.progress.save();
          g.recenter();
          this.refresh();
        };
        const cm = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v * 100)} cm`;
        b.title('Comfort', 'Seated and standing friendly');
        b.row([
          { label: 'Right-handed', active: s.handedness === 'right', onPress: () => { g.holdPaddle('right'); this.refresh(); } },
          { label: 'Left-handed', active: s.handedness === 'left', onPress: () => { g.holdPaddle('left'); this.refresh(); } },
          { label: 'Recenter', onPress: () => g.recenter() },
        ], 64);
        b.stepper('Table distance', cm(s.tableDistance), adj('tableDistance', -0.05, -0.4, 0.6), adj('tableDistance', 0.05, -0.4, 0.6));
        b.stepper('Table height', cm(s.heightOffset), adj('heightOffset', -0.03, -0.5, 0.4), adj('heightOffset', 0.03, -0.5, 0.4));
        b.stepper('Side position', cm(s.lateralOffset), adj('lateralOffset', -0.05, -0.6, 0.6), adj('lateralOffset', 0.05, -0.6, 0.6));
        b.stepper('Virtual reach', `x${s.reachScale.toFixed(2)}`, adj('reachScale', -0.1, 1, 1.8), adj('reachScale', 0.1, 1, 1.8));
        b.text('Virtual reach amplifies your paddle movement so wide balls need less', 20, '#9fb4d8');
        b.text('physical movement. Your view never moves artificially.', 20, '#9fb4d8');
        b.bottom().row([
          { label: 'Grip calibration', onPress: this.go('grip') },
          { label: 'Back', onPress: this.go('main') },
        ]);
        break;
      }

      case 'grip': {
        const adj = (key: 'gripPitch' | 'gripRoll' | 'gripYaw', d: number): (() => void) => () => {
          s[key] = Math.max(-90, Math.min(90, s[key] + d));
          g.progress.save();
          this.refresh();
        };
        const fwd = (d: number): (() => void) => () => {
          s.gripForward = Math.round(Math.max(-0.05, Math.min(0.08, s.gripForward + d)) * 1000) / 1000;
          g.progress.save();
          this.refresh();
        };
        const preset = (pitch: number, roll: number, yaw: number, f: number): (() => void) => () => {
          s.gripPitch = pitch;
          s.gripRoll = roll;
          s.gripYaw = yaw;
          s.gripForward = f;
          g.progress.save();
          this.refresh();
        };
        b.title('Grip calibration', 'Hold the paddle and adjust until it feels right');
        b.stepper('Tilt face open / closed', `${s.gripPitch} deg`, adj('gripPitch', -5), adj('gripPitch', 5));
        b.stepper('Rotate in hand', `${s.gripRoll} deg`, adj('gripRoll', -5), adj('gripRoll', 5));
        b.stepper('Twist handle', `${s.gripYaw} deg`, adj('gripYaw', -5), adj('gripYaw', 5));
        b.stepper('Slide along handle', `${Math.round(s.gripForward * 1000)} mm`, fwd(-0.005), fwd(0.005));
        b.row([
          { label: 'Shakehand', onPress: preset(0, 0, 0, 0) },
          { label: 'Penhold', onPress: preset(0, 90, 0, -0.02) },
          { label: 'Relaxed', onPress: preset(-10, -15, 0, 0.01) },
        ], 66);
        backRow('comfort');
        break;
      }

      case 'options': {
        const tog = (key: 'trajectory' | 'spinViz' | 'autoReplay' | 'strictServe'): (() => void) => () => this.set(key, !s[key]);
        b.title('Options');
        b.row([
          { label: 'Trajectory analysis', sub: s.trajectory ? 'On' : 'Off', active: s.trajectory, onPress: tog('trajectory') },
          { label: 'Spin visualisation', sub: s.spinViz ? 'On' : 'Off', active: s.spinViz, onPress: tog('spinViz') },
        ], 80);
        b.row([
          { label: 'Auto slow-mo replay', sub: s.autoReplay ? 'After long rallies' : 'Off', active: s.autoReplay, onPress: tog('autoReplay') },
          { label: 'Strict serve rule', sub: s.strictServe ? 'Missed toss is a fault' : 'Missed toss is replayed', active: s.strictServe, onPress: tog('strictServe') },
        ], 80);
        b.row([
          { label: 'Hands: SDK model', active: s.handStyle === 'model', onPress: () => this.set('handStyle', 'model') },
          { label: 'Hands: skeleton', active: s.handStyle === 'skeleton', onPress: () => this.set('handStyle', 'skeleton') },
        ], 60);
        b.chooser('Scoreboard', cap(s.hudMode), () => { g.cycleHud(); g.cycleHud(); this.refresh(); }, () => { g.cycleHud(); this.refresh(); });
        const sides: Settings['hudSide'][] = ['left', 'right', 'far'];
        const side = (dir: number): (() => void) => () => { s.hudSide = step(sides, s.hudSide, dir); g.layoutHud(); g.progress.save(); this.refresh(); };
        b.chooser('Scoreboard position', cap(s.hudSide), side(-1), side(1));
        const vol = (d: number): (() => void) => () => { s.volume = Math.round(Math.min(1, Math.max(0, s.volume + d)) * 10) / 10; g.audio.setVolume(s.volume); g.progress.save(); this.refresh(); };
        b.stepper('Volume', `${Math.round(s.volume * 100)}%`, vol(-0.1), vol(0.1));
        b.row([
          { label: `Name: ${p.name}`, onPress: () => this.openKeypad('Your name', p.name, 12, 'options', (v) => { if (v) { p.name = v; g.progress.save(); } }), flex: 2 },
          { label: 'Reset settings', onPress: () => { Object.assign(s, DEFAULT_SETTINGS); g.progress.save(); g.applyLook(); g.applyTable(); g.applyVenue(); g.layoutHud(); this.refresh(); } },
        ], 64);
        backRow();
        break;
      }

      case 'stats': {
        const r = g.progress.r;
        b.title('Records & Stats');
        const acc = r.servesTotal ? Math.round((r.servesIn / r.servesTotal) * 100) : 0;
        b.lines([
          `Matches ${r.matches}     Wins ${r.wins}     Losses ${r.losses}     Trophies ${r.trophies}`,
          `Fastest shot ${Math.round(r.fastestShotKmh)} km/h      Fastest swing ${Math.round(r.fastestSwingKmh)} km/h`,
          `Most spin ${Math.round(r.maxSpinRpm)} rpm      Longest rally ${r.longestRally} strokes`,
          `Serve accuracy ${acc}%  (${r.servesIn}/${r.servesTotal})      Best serve streak ${r.bestServeStreak}`,
          `Points won ${r.pointsWon}      Topspin shots ${r.topspinShots}`,
        ], 24, '#e6ecf8');
        b.space(8);
        b.row([
          { label: 'Achievements', sub: `${Object.keys(p.achievements).length} / ${ACHIEVEMENTS.length}`, onPress: this.go('achievements') },
          { label: 'Match history', sub: `${p.history.length} matches`, onPress: this.go('history') },
          { label: 'Global rankings', onPress: () => { g.netConnect().requestLeaderboard(); this.show('rankings'); } },
        ], 84);
        backRow();
        break;
      }

      case 'achievements':
        b.title('Achievements', `${Object.keys(p.achievements).length} / ${ACHIEVEMENTS.length}`);
        for (let i = 0; i < ACHIEVEMENTS.length; i += 2) {
          b.row(
            ACHIEVEMENTS.slice(i, i + 2).map((a) => ({ label: (p.achievements[a.id] ? '[x] ' : '[  ] ') + a.title, sub: a.desc, color: p.achievements[a.id] ? '#ffd23f' : '#7f8aa3' })),
            58,
          );
        }
        backRow('stats');
        break;

      case 'history':
        b.title('Match history');
        if (!p.history.length) b.text('No matches yet - go play one!', 26);
        for (const h of p.history.slice(0, 9)) {
          const date = new Date(h.date);
          b.text(
            `${date.getMonth() + 1}/${date.getDate()}  ${h.won ? 'WON ' : 'LOST'}  v ${h.opponent}  ${h.scores.map((x) => x.join('-')).join(' ')}  rally ${h.longestRally}  ${h.fastestShotKmh} km/h`,
            21,
            h.won ? '#9df0b6' : '#ffb3a8',
          );
        }
        backRow('stats');
        break;

      case 'rankings': {
        b.title('Global rankings', g.net ? cap(g.net.status) : '');
        const top = g.leaderboard;
        if (!g.net || g.net.status !== 'online') b.text('Rankings come from the multiplayer server, which is not reachable.', 22, '#ffb3a8');
        else if (!top) b.text('Loading...', 24);
        else if (!top.length) b.text('No ranked matches have been played yet.', 24);
        else top.slice(0, 10).forEach((e, i) => b.text(`${String(i + 1).padStart(2)}.  ${e.name.padEnd(14)}  ${e.rating}   ${e.wins}W ${e.losses}L`, 23, i === 0 ? '#ffd23f' : '#e6ecf8'));
        backRow('stats');
        break;
      }

      case 'pause':
        b.title('Paused', g.mode === 'drill' ? g.drill?.def.title : `v ${g.opponentName}`);
        b.row([{ label: 'Resume', onPress: () => g.resume(), color: '#1f8f4e' }], 90);
        b.row([
          { label: 'Slow-mo replay', onPress: () => { g.resume(); g.replayNow(); } },
          { label: 'Recenter', onPress: () => g.recenter() },
          { label: g.heldBy ? 'Put paddle down' : 'Hold paddle', onPress: () => { if (g.heldBy) g.putPaddleDown(); else g.holdPaddle(s.handedness); this.refresh(); } },
        ], 76);
        b.row([
          { label: `Trajectory: ${s.trajectory ? 'on' : 'off'}`, onPress: () => this.set('trajectory', !s.trajectory) },
          { label: `Scoreboard: ${s.hudMode}`, onPress: () => { g.cycleHud(); this.refresh(); } },
          { label: `Reach x${s.reachScale.toFixed(1)}`, onPress: () => this.set('reachScale', s.reachScale >= 1.75 ? 1 : Math.round((s.reachScale + 0.25) * 100) / 100) },
        ], 76);
        if (g.matchKind === 'online' && g.mode === 'match') b.row(REACTIONS.slice(0, 4).map((r) => ({ label: r, onPress: () => g.sendReaction(r) })), 60);
        b.bottom().row([{ label: 'Quit to menu', onPress: () => g.toMenu() }]);
        break;

      case 'result': {
        const r = g.result;
        b.title(r?.title ?? 'Finished');
        b.lines(r?.lines ?? [], 26, '#e6ecf8');
        const cells = [];
        if (g.mode === 'drill' && g.drill) cells.push({ label: 'Try again', onPress: () => g.startDrill(g.drill!.def.id), color: '#1f8f4e' });
        else if (g.matchKind === 'tournament' && g.tournament) cells.push({ label: 'Tournament bracket', onPress: () => { g.toMenu(); this.show('tournament'); }, color: '#1f8f4e' });
        else if (g.matchKind === 'online') cells.push({ label: 'Rematch', onPress: () => g.requestRematch(), color: '#1f8f4e' });
        else if (g.mode === 'spectate') cells.push({ label: 'Watch another', onPress: () => g.startSpectate(), color: '#1f8f4e' });
        else cells.push({ label: 'Rematch', onPress: () => g.startQuickMatch(g.opponentProfile ?? undefined), color: '#1f8f4e' });
        cells.push({ label: 'Slow-mo replay', onPress: () => g.replayNow() });
        cells.push({ label: 'Menu', onPress: () => g.toMenu() });
        b.bottom(84).row(cells, 84);
        break;
      }

      case 'keypad': {
        const k = this.keypad;
        b.title(k.title);
        b.text(k.value || '_', 54, '#ffd23f', 'center', 76);
        const rows = ['ABCDEFGHJ', 'KLMNPQRST', 'UVWXYZ234', '56789'];
        for (const row of rows) {
          const cells = row.split('').map((ch) => ({ label: ch, onPress: () => { if (k.value.length < k.max) k.value += ch; this.refresh(); } }));
          if (row.length < 9) {
            cells.push({ label: 'Del', onPress: () => { k.value = k.value.slice(0, -1); this.refresh(); } });
            cells.push({ label: 'Clear', onPress: () => { k.value = ''; this.refresh(); } });
          }
          b.row(cells, 66);
        }
        b.bottom().row([
          { label: 'OK', onPress: () => { k.done(k.value); this.show(this.back); }, color: '#1f8f4e' },
          { label: 'Cancel', onPress: this.go(this.back) },
        ]);
        break;
      }
    }
  }
}
