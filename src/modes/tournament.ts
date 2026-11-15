// Single-elimination tournament: 8 entrants, quarter-finals, semi-finals,
// final. The other bracket matches are not coin flips: they are played out by
// the real AI through the real physics, time-sliced so the frame rate holds.
import type { AIProfile, Difficulty, Personality } from '../ai/opponent.ts';
import { MatchSession } from '../game/session.ts';

export interface Entrant {
  name: string;
  /** null = the human player */
  profile: AIProfile | null;
}

export interface Fixture {
  a: number; // entrant index, -1 = not decided yet
  b: number;
  winner: number;
  score: string;
}

export const ROUND_NAMES = ['Quarter-finals', 'Semi-finals', 'Final'];

const FIELD: [string, Difficulty, Personality][] = [
  ['Mika Brandt', 'beginner', 'defender'],
  ['Jun Okafor', 'normal', 'attacker'],
  ['Lena Voss', 'normal', 'spin'],
  ['Tariq Bell', 'hard', 'strategist'],
  ['Sora Lind', 'hard', 'attacker'],
  ['Ivo Marek', 'hard', 'spin'],
  ['Ada Kessler', 'expert', 'strategist'],
];

export class Tournament {
  entrants: Entrant[] = [];
  rounds: Fixture[][] = [];
  round = 0;
  /** 'playing' until the player is out or wins */
  status: 'playing' | 'eliminated' | 'champion' = 'playing';
  private sim: { session: MatchSession; fixture: Fixture; t: number } | null = null;
  private seed: number;

  constructor(playerName: string, seed = Date.now() & 0xffff) {
    this.seed = seed;
    this.entrants = [{ name: playerName, profile: null }];
    for (const [name, difficulty, personality] of FIELD) {
      this.entrants.push({ name, profile: { name, difficulty, personality } });
    }
    // seeding: the player meets the weakest first, the strongest sits in the other half
    const order = [0, 1, 2, 4, 3, 5, 6, 7];
    const qf: Fixture[] = [];
    for (let i = 0; i < 8; i += 2) qf.push({ a: order[i], b: order[i + 1], winner: -1, score: '' });
    this.rounds = [
      qf,
      [
        { a: -1, b: -1, winner: -1, score: '' },
        { a: -1, b: -1, winner: -1, score: '' },
      ],
      [{ a: -1, b: -1, winner: -1, score: '' }],
    ];
  }

  /** The player's fixture in the current round, or null if they are out. */
  get playerFixture(): Fixture | null {
    if (this.status !== 'playing') return null;
    return this.rounds[this.round].find((f) => f.a === 0 || f.b === 0) ?? null;
  }

  get opponent(): Entrant | null {
    const f = this.playerFixture;
    if (!f) return null;
    const i = f.a === 0 ? f.b : f.a;
    return i >= 0 ? this.entrants[i] : null;
  }

  /** Report the result of the player's own match. */
  reportPlayer(won: boolean, score: string): void {
    const f = this.playerFixture;
    if (!f) return;
    const opp = f.a === 0 ? f.b : f.a;
    f.winner = won ? 0 : opp;
    f.score = score;
    if (!won) this.status = 'eliminated';
    else if (this.round === 2) this.status = 'champion';
  }

  /** True while other matches of the current round still need to be played. */
  get pending(): boolean {
    return this.rounds[this.round].some((f) => f.winner < 0 && f.a >= 0 && f.b >= 0);
  }

  /**
   * Play the other fixtures of this round for up to `budgetMs` of CPU time.
   * Call every frame until `pending` is false, then call `advance()`.
   */
  work(budgetMs: number): void {
    const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const end = now() + budgetMs;
    while (now() < end) {
      if (!this.sim) {
        const f = this.rounds[this.round].find((x) => x.winner < 0 && x.a > 0 && x.b > 0);
        if (!f) return;
        const s = new MatchSession({ bestOf: 1 }, this.seed++);
        s.setAI(1, this.entrants[f.a].profile!);
        s.setAI(-1, this.entrants[f.b].profile!);
        s.pointDelay = 0.2;
        s.start();
        this.sim = { session: s, fixture: f, t: 0 };
      }
      const { session, fixture } = this.sim;
      for (let i = 0; i < 30 && session.match.phase !== 'matchOver'; i++) {
        session.update(1 / 60);
        this.sim.t += 1 / 60;
      }
      const m = session.match;
      if (m.phase === 'matchOver' || this.sim.t > 1800) {
        const aWon = m.phase === 'matchOver' ? m.games[0] > m.games[1] : m.points[0] >= m.points[1];
        fixture.winner = aWon ? fixture.a : fixture.b;
        const g = m.gameScores[0] ?? m.points;
        fixture.score = `${g[0]}-${g[1]}`;
        this.sim = null;
      }
    }
  }

  /** Move winners into the next round. Returns false when the tournament is over. */
  advance(): boolean {
    if (this.pending) return true;
    if (this.round >= 2) return false;
    const cur = this.rounds[this.round];
    const next = this.rounds[this.round + 1];
    for (let i = 0; i < next.length; i++) {
      next[i].a = cur[i * 2].winner;
      next[i].b = cur[i * 2 + 1].winner;
    }
    this.round++;
    return true;
  }

  get championName(): string {
    const f = this.rounds[2][0];
    return f.winner >= 0 ? this.entrants[f.winner].name : '';
  }

  /** Text lines describing the bracket, for the HUD. */
  describe(): string[] {
    const lines: string[] = [];
    this.rounds.forEach((r, i) => {
      lines.push(ROUND_NAMES[i]);
      for (const f of r) {
        const a = f.a >= 0 ? this.entrants[f.a].name : 'TBD';
        const b = f.b >= 0 ? this.entrants[f.b].name : 'TBD';
        const w = f.winner >= 0 ? `  ${f.score}  ${this.entrants[f.winner].name} wins` : '';
        lines.push(`  ${a} v ${b}${w}`);
      }
    });
    return lines;
  }
}
