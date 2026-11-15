// A match session: physics world + rules + whoever controls each end
// (tracked human, AI, or remote player). Renderer-free so it runs headless.
import type { Side } from '../core/constants.ts';
import { makeRng } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { AIController } from '../ai/opponent.ts';
import type { AIProfile } from '../ai/opponent.ts';
import { PhysicsWorld, makePaddle } from '../physics/world.ts';
import type { PaddleBody, PhysEvent } from '../physics/world.ts';
import { Match } from '../rules/match.ts';
import type { MatchConfig, MatchListener, Phase, PointReason } from '../rules/match.ts';

export type Controller = 'human' | 'ai' | 'remote';

export interface SessionListener extends MatchListener {
  onPhys?(e: PhysEvent): void;
  /** a human at `side` must now serve (ball is held, not live) */
  onHumanServe?(side: Side): void;
}

export class MatchSession {
  world = new PhysicsWorld();
  match: Match;
  paddles: Record<'1' | '-1', PaddleBody>;
  controllers: Record<'1' | '-1', Controller> = { '1': 'human', '-1': 'ai' };
  ais: AIController[] = [];
  listeners: SessionListener[] = [];
  /** when false the rules are not run locally (multiplayer guest follows the host) */
  authoritative = true;
  /** seconds between a point ending and the next serve being set up */
  pointDelay = 1.9;
  elapsed = 0;
  paused = false;
  /**
   * Online play: the player at this side strikes the ball on their own
   * device, so events that would rule "they failed to return it" are held for
   * `grace` seconds and dropped if their stroke arrives in the meantime.
   */
  deferFor: Side | null = null;
  grace = 0.25;
  private deferred: { e: PhysEvent; at: number }[] = [];
  private nextAt = -1;
  private rng: () => number;

  constructor(cfg: Partial<MatchConfig> = {}, seed = 12345) {
    this.rng = makeRng(seed);
    this.match = new Match(cfg);
    this.paddles = { '1': makePaddle(1), '-1': makePaddle(-1) };
    this.world.addPaddle(this.paddles['1']);
    this.world.addPaddle(this.paddles['-1']);

    this.world.onEvent = (e) => {
      if (this.authoritative) {
        const d = this.deferFor;
        if (d !== null && e.type === 'paddle' && e.side === d) this.deferred = [];
        const m = this.match;
        if (d !== null && m.phase === 'rally' && m.awaiting === d && m.ballHasBounced && e.type !== 'paddle' && e.type !== 'net') {
          this.deferred.push({ e, at: this.elapsed + this.grace });
        } else m.handle(e);
      }
      for (const ai of this.ais) ai.onEvent(e, this.match.awaiting === ai.side);
      for (const l of this.listeners) l.onPhys?.(e);
    };

    this.match.listener = {
      onPhase: (p) => this.phaseChanged(p),
      onPoint: (w, r, edge) => this.listeners.forEach((l) => l.onPoint?.(w, r, edge)),
      onLet: () => this.listeners.forEach((l) => l.onLet?.()),
      onGame: (w) => this.listeners.forEach((l) => l.onGame?.(w)),
      onMatch: (w) => this.listeners.forEach((l) => l.onMatch?.(w)),
      onRally: (n) => this.listeners.forEach((l) => l.onRally?.(n)),
      onStroke: (by, s) => this.listeners.forEach((l) => l.onStroke?.(by, s)),
    };
  }

  paddle(side: Side): PaddleBody {
    return this.paddles[side === 1 ? '1' : '-1'];
  }
  controller(side: Side): Controller {
    return this.controllers[side === 1 ? '1' : '-1'];
  }
  aiFor(side: Side): AIController | undefined {
    return this.ais.find((a) => a.side === side);
  }

  setAI(side: Side, profile: AIProfile): AIController {
    this.controllers[side === 1 ? '1' : '-1'] = 'ai';
    this.ais = this.ais.filter((a) => a.side !== side);
    const ai = new AIController(side, this.world, this.paddle(side), profile, this.rng);
    ai.hooks.tossed = () => this.match.tossed();
    this.ais.push(ai);
    return ai;
  }

  setHuman(side: Side): void {
    this.controllers[side === 1 ? '1' : '-1'] = 'human';
    this.ais = this.ais.filter((a) => a.side !== side);
    this.paddle(side).active = true;
  }

  setRemote(side: Side): void {
    this.controllers[side === 1 ? '1' : '-1'] = 'remote';
    this.ais = this.ais.filter((a) => a.side !== side);
    // a remote paddle never collides locally: its strokes arrive as ball states
    this.paddle(side).active = false;
  }

  start(): void {
    this.elapsed = 0;
    this.nextAt = -1;
    for (const ai of this.ais) ai.reset();
    this.match.start();
  }

  private phaseChanged(p: Phase): void {
    for (const l of this.listeners) l.onPhase?.(p);
    if (p === 'pointOver' || p === 'gameOver') {
      for (const ai of this.ais) ai.standDown();
      this.nextAt = this.elapsed + this.pointDelay + (p === 'gameOver' ? 2.5 : 0);
    } else if (p === 'matchOver') {
      for (const ai of this.ais) ai.standDown();
    } else if (p === 'preServe') {
      this.setupServe();
    }
  }

  private setupServe(): void {
    const srv = this.match.server;
    const c = this.controller(srv);
    this.world.ballLive = false;
    if (c === 'ai') this.aiFor(srv)?.beginServe();
    else if (c === 'human') for (const l of this.listeners) l.onHumanServe?.(srv);
    // remote: their client holds and tosses the ball; we receive its state
  }

  /** A human released the ball for their serve toss. */
  humanToss(pos: Vec3, vel: Vec3): void {
    const b = this.world.ball;
    b.pos = { x: pos.x, y: pos.y, z: pos.z };
    b.vel = { x: vel.x, y: vel.y, z: vel.z };
    b.spin = { x: 0, y: 0, z: 0 };
    this.world.ballLive = true;
    this.match.tossed();
  }

  /** Force a point result (multiplayer guest applying the host's ruling). */
  applyRemotePhase(points: [number, number], games: [number, number], server: Side, phase: Phase): void {
    const m = this.match;
    m.points = points;
    m.games = games;
    m.server = server;
    if (m.phase !== phase) {
      m.phase = phase;
      for (const l of this.listeners) l.onPhase?.(phase);
      if (phase === 'preServe' && this.controller(server) === 'human') {
        this.world.ballLive = false;
        for (const l of this.listeners) l.onHumanServe?.(server);
      }
    }
  }

  update(dt: number): void {
    if (this.paused) return;
    const simDt = Math.min(dt, 0.1) * this.world.timeScale;
    for (const ai of this.ais) ai.update(simDt);
    this.world.advance(dt);
    this.elapsed += simDt;
    if (!this.authoritative) return;
    while (this.deferred.length && this.deferred[0].at <= this.elapsed) {
      const d = this.deferred.shift()!;
      this.match.handle(d.e);
    }
    this.match.tick(simDt);
    if (this.nextAt >= 0 && this.elapsed >= this.nextAt) {
      this.nextAt = -1;
      this.match.nextPoint();
    }
  }
}

export type { PointReason };
