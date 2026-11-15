// Table tennis laws for singles: rally adjudication, legal serves, lets,
// edge balls, 11-point games with a two-point margin, service rotation
// (every 2 points, every point from 10-10), alternating first server per game.
import { HALF_L } from '../core/constants.ts';
import type { Side } from '../core/constants.ts';
import type { PhysEvent } from '../physics/world.ts';

export type Phase = 'idle' | 'preServe' | 'toss' | 'serve' | 'rally' | 'pointOver' | 'gameOver' | 'matchOver';

export type PointReason =
  | 'doubleBounce'
  | 'out'
  | 'net'
  | 'missedReturn'
  | 'serviceFault'
  | 'volley'
  | 'doubleHit'
  | 'ownSide'
  | 'tableSide'
  | 'deadBall';

export interface MatchConfig {
  pointsPerGame: number;
  bestOf: number;
  firstServer: Side;
  /** when true, a tossed serve that is missed counts as a fault */
  strictServe: boolean;
}

export const DEFAULT_MATCH: MatchConfig = { pointsPerGame: 11, bestOf: 3, firstServer: 1, strictServe: false };

export interface MatchListener {
  onPhase?(phase: Phase): void;
  onPoint?(winner: Side, reason: PointReason, edge: boolean): void;
  onLet?(): void;
  onGame?(winner: Side): void;
  onMatch?(winner: Side): void;
  onRally?(count: number): void;
  /** a legal stroke was made (serve or return) */
  onStroke?(by: Side, isServe: boolean): void;
}

const other = (s: Side): Side => (s === 1 ? -1 : 1);

export class Match {
  cfg: MatchConfig;
  phase: Phase = 'idle';
  /** points in the current game, indexed by side: [0] = side +1, [1] = side -1 */
  points: [number, number] = [0, 0];
  games: [number, number] = [0, 0];
  gameScores: [number, number][] = [];
  server: Side = 1;
  rally = 0;
  longestRally = 0;
  lastPointWinner: Side | null = null;
  lastReason: PointReason | null = null;
  listener: MatchListener = {};

  // rally tracking
  private lastHitter: Side = 1;
  private bouncedOnTarget = false;
  private serveBouncedOwn = false;
  private netTouchedOnServe = false;
  private lastEdge = false;
  private quietTime = 0;

  constructor(cfg: Partial<MatchConfig> = {}) {
    this.cfg = { ...DEFAULT_MATCH, ...cfg };
    this.server = this.cfg.firstServer;
  }

  static idx(s: Side): 0 | 1 {
    return s === 1 ? 0 : 1;
  }
  score(s: Side): number {
    return this.points[Match.idx(s)];
  }
  gamesWon(s: Side): number {
    return this.games[Match.idx(s)];
  }
  get gameNumber(): number {
    return this.games[0] + this.games[1] + 1;
  }
  get totalPoints(): number {
    return this.points[0] + this.points[1];
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.listener.onPhase?.(p);
  }

  start(): void {
    this.points = [0, 0];
    this.games = [0, 0];
    this.gameScores = [];
    this.server = this.cfg.firstServer;
    this.rally = 0;
    this.longestRally = 0;
    this.setPhase('preServe');
  }

  /** Called when the next point should begin (after pointOver / gameOver). */
  nextPoint(): void {
    if (this.phase === 'matchOver') return;
    if (this.phase === 'gameOver') {
      this.points = [0, 0];
      // first server alternates each game
      const g = this.games[0] + this.games[1];
      this.server = g % 2 === 0 ? this.cfg.firstServer : other(this.cfg.firstServer);
    }
    this.rally = 0;
    this.setPhase('preServe');
  }

  /** Server for the current score: 2 serves each, 1 each from deuce (10-10). */
  private computeServer(): Side {
    const g = this.games[0] + this.games[1];
    const first = g % 2 === 0 ? this.cfg.firstServer : other(this.cfg.firstServer);
    const total = this.totalPoints;
    const deuce = this.cfg.pointsPerGame - 1;
    let turns: number;
    if (this.points[0] >= deuce && this.points[1] >= deuce) {
      turns = Math.floor((2 * deuce) / 2) + (total - 2 * deuce);
    } else {
      turns = Math.floor(total / 2);
    }
    return turns % 2 === 0 ? first : other(first);
  }

  /** The ball has left the server's hand (free toss). */
  tossed(): void {
    if (this.phase !== 'preServe') return;
    this.serveBouncedOwn = false;
    this.netTouchedOnServe = false;
    this.bouncedOnTarget = false;
    this.quietTime = 0;
    this.setPhase('toss');
  }

  /** Re-arm the serve without a fault (lenient missed toss / let). */
  private reserve(): void {
    this.rally = 0;
    this.setPhase('preServe');
  }

  private award(winner: Side, reason: PointReason): void {
    const i = Match.idx(winner);
    this.points[i]++;
    this.lastPointWinner = winner;
    this.lastReason = reason;
    if (this.rally > this.longestRally) this.longestRally = this.rally;
    this.listener.onPoint?.(winner, reason, this.lastEdge);
    const p = this.points;
    const target = this.cfg.pointsPerGame;
    if ((p[0] >= target || p[1] >= target) && Math.abs(p[0] - p[1]) >= 2) {
      this.games[i]++;
      this.gameScores.push([p[0], p[1]]);
      this.listener.onGame?.(winner);
      const need = Math.ceil(this.cfg.bestOf / 2);
      if (this.games[i] >= need) {
        this.setPhase('matchOver');
        this.listener.onMatch?.(winner);
      } else {
        this.setPhase('gameOver');
      }
    } else {
      this.server = this.computeServer();
      this.setPhase('pointOver');
    }
  }

  /** Advance the dead-ball timer; call once per frame with real seconds. */
  tick(dt: number): void {
    if (this.phase !== 'rally' && this.phase !== 'serve' && this.phase !== 'toss') return;
    this.quietTime += dt;
    if (this.quietTime > 5) {
      if (this.phase === 'toss') {
        if (this.cfg.strictServe) this.award(other(this.server), 'serviceFault');
        else this.reserve();
      } else if (this.phase === 'serve') {
        this.award(other(this.server), 'serviceFault');
      } else {
        // ball died (e.g. trapped in the net or rolling): decide by where it is owed
        this.award(this.bouncedOnTarget ? this.lastHitter : other(this.lastHitter), 'deadBall');
      }
    }
  }

  /** Feed every physics contact event here. */
  handle(e: PhysEvent): void {
    const ph = this.phase;
    if (ph !== 'toss' && ph !== 'serve' && ph !== 'rally') return;
    this.quietTime = 0;
    this.lastEdge = e.type === 'table' && !!e.edge;
    if (ph === 'toss') return this.handleToss(e);
    if (ph === 'serve') return this.handleServe(e);
    this.handleRally(e);
  }

  private handleToss(e: PhysEvent): void {
    const srv = this.server;
    if (e.type === 'paddle') {
      if (e.side === srv) {
        this.lastHitter = srv;
        this.serveBouncedOwn = false;
        this.netTouchedOnServe = false;
        this.bouncedOnTarget = false;
        this.rally = 1;
        this.listener.onStroke?.(srv, true);
        this.listener.onRally?.(this.rally);
        this.setPhase('serve');
      } else {
        // receiver interfered with the toss: replay
        this.listener.onLet?.();
        this.reserve();
      }
      return;
    }
    // ball dropped without being struck
    if (e.type === 'floor' || e.type === 'table' || e.type === 'tableSide') {
      if (this.cfg.strictServe) this.award(other(srv), 'serviceFault');
      else this.reserve();
    }
  }

  private handleServe(e: PhysEvent): void {
    const srv = this.server;
    const rcv = other(srv);
    switch (e.type) {
      case 'net':
        this.netTouchedOnServe = true;
        return;
      case 'paddle':
        if (e.side === srv) return this.award(rcv, 'doubleHit');
        // receiver struck before the ball bounced on their side
        if (this.serveBouncedOwn && !this.bouncedOnTarget && Math.abs(e.pos.z) > HALF_L) {
          // already past the end line untouched: the serve was long
          return this.award(rcv, 'serviceFault');
        }
        return this.award(srv, 'volley');
      case 'table':
        if (e.side === srv) {
          if (this.serveBouncedOwn) return this.award(rcv, 'serviceFault');
          this.serveBouncedOwn = true;
          return;
        }
        // receiver's side
        if (!this.serveBouncedOwn) return this.award(rcv, 'serviceFault');
        if (this.netTouchedOnServe) {
          this.listener.onLet?.();
          return this.reserve();
        }
        this.bouncedOnTarget = true;
        this.setPhase('rally');
        return;
      case 'tableSide':
      case 'floor':
        return this.award(rcv, 'serviceFault');
    }
  }

  private handleRally(e: PhysEvent): void {
    const A = this.lastHitter;
    const B = other(A);
    switch (e.type) {
      case 'net':
        return;
      case 'paddle':
        if (e.side === A) return this.award(B, 'doubleHit');
        if (this.bouncedOnTarget) {
          this.lastHitter = B;
          this.bouncedOnTarget = false;
          this.rally++;
          this.listener.onStroke?.(B, false);
          this.listener.onRally?.(this.rally);
          return;
        }
        // struck before it bounced: a volley over the table loses the point,
        // but a ball already past the end line was going out
        if (Math.abs(e.pos.z) > HALF_L) return this.award(B, 'out');
        return this.award(A, 'volley');
      case 'table':
        if (e.side === B) {
          if (this.bouncedOnTarget) return this.award(A, 'doubleBounce');
          this.bouncedOnTarget = true;
          return;
        }
        // landed on the striker's own side
        if (this.bouncedOnTarget) return this.award(A, 'missedReturn');
        return this.award(B, 'ownSide');
      case 'tableSide':
        return this.award(this.bouncedOnTarget ? A : B, 'tableSide');
      case 'floor':
        return this.award(this.bouncedOnTarget ? A : B, this.bouncedOnTarget ? 'missedReturn' : 'out');
    }
  }

  /** Who must play the ball next, or null when no stroke is owed. */
  get awaiting(): Side | null {
    if (this.phase === 'serve') return other(this.server);
    if (this.phase === 'rally') return other(this.lastHitter);
    return null;
  }
  get hitter(): Side {
    return this.lastHitter;
  }
  get ballHasBounced(): boolean {
    return this.bouncedOnTarget;
  }
}

export const REASON_TEXT: Record<PointReason, string> = {
  doubleBounce: 'Double bounce',
  out: 'Out',
  net: 'Into the net',
  missedReturn: 'Not returned',
  serviceFault: 'Service fault',
  volley: 'Volley - struck before the bounce',
  doubleHit: 'Double hit',
  ownSide: 'Landed on own side',
  tableSide: 'Hit the side of the table',
  deadBall: 'Dead ball',
};
