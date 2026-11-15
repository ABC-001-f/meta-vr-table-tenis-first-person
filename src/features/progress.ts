// Persistent player profile: settings, personal records, achievements,
// daily challenge, match history. Stored in localStorage (in-memory fallback
// when unavailable, e.g. in tests).
import type { Difficulty, Personality } from '../ai/opponent.ts';

export interface Settings {
  handedness: 'right' | 'left';
  /** player offset relative to the table, metres */
  tableDistance: number;
  heightOffset: number;
  lateralOffset: number;
  /** grip calibration: paddle rotation relative to the hand, degrees, and forward offset */
  gripPitch: number;
  gripRoll: number;
  gripYaw: number;
  gripForward: number;
  /** virtual reach: amplifies paddle displacement so far balls need less movement */
  reachScale: number;
  hudMode: 'full' | 'minimal' | 'hidden';
  hudSide: 'left' | 'right' | 'far';
  trajectory: boolean;
  spinViz: boolean;
  autoReplay: boolean;
  strictServe: boolean;
  /** 'model' = the SDK's skinned hand models, 'skeleton' = lightweight joint skeleton */
  handStyle: 'model' | 'skeleton';
  volume: number;
  bestOf: 1 | 3 | 5 | 7;
  difficulty: Difficulty;
  personality: Personality;
  environment: string;
  table: string;
  paddle: string;
  rubberColor: string;
  rubberBackColor: string;
  handle: string;
  grip: string;
  surface: string;
}

export const DEFAULT_SETTINGS: Settings = {
  handedness: 'right',
  tableDistance: 0,
  heightOffset: 0,
  lateralOffset: 0,
  gripPitch: 0,
  gripRoll: 0,
  gripYaw: 0,
  gripForward: 0,
  reachScale: 1,
  hudMode: 'full',
  hudSide: 'left',
  trajectory: false,
  spinViz: true,
  autoReplay: true,
  strictServe: false,
  handStyle: 'model',
  volume: 0.8,
  bestOf: 3,
  difficulty: 'normal',
  personality: 'strategist',
  environment: 'arena',
  table: 'blue',
  paddle: 'pro',
  rubberColor: '#c8102e',
  rubberBackColor: '#111111',
  handle: 'pro-stripe',
  grip: 'plain',
  surface: 'smooth',
};

export interface Records {
  fastestShotKmh: number;
  fastestSwingKmh: number;
  maxSpinRpm: number;
  longestRally: number;
  matches: number;
  wins: number;
  losses: number;
  servesIn: number;
  servesTotal: number;
  bestServeStreak: number;
  trophies: number;
  topspinShots: number;
  pointsWon: number;
}

export interface MatchRecord {
  date: number;
  mode: string;
  opponent: string;
  won: boolean;
  games: [number, number];
  scores: [number, number][];
  longestRally: number;
  fastestShotKmh: number;
  durationSec: number;
  serveAccuracy: number;
}

export interface DailyState {
  date: string;
  id: string;
  progress: number;
  done: boolean;
}

export interface Profile {
  name: string;
  playerId: string;
  settings: Settings;
  records: Records;
  achievements: Record<string, number>;
  history: MatchRecord[];
  daily: DailyState;
  challengeBest: Record<string, number>;
  challengeDone: Record<string, boolean>;
}

export interface AchievementDef {
  id: string;
  title: string;
  desc: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'firstWin', title: 'First Blood', desc: 'Win your first match' },
  { id: 'rally10', title: 'Getting Warm', desc: 'Reach a 10-stroke rally' },
  { id: 'rally25', title: 'Human Wall', desc: 'Reach a 25-stroke rally' },
  { id: 'speed60', title: 'Rocket Arm', desc: 'Hit a shot faster than 60 km/h' },
  { id: 'spin3000', title: 'Spin Doctor', desc: 'Put more than 3000 rpm on the ball' },
  { id: 'matches5', title: 'Regular', desc: 'Play 5 matches' },
  { id: 'beatHard', title: 'Giant Slayer', desc: 'Beat a Hard opponent' },
  { id: 'beatExpert', title: 'Grandmaster', desc: 'Beat an Expert opponent' },
  { id: 'perfect', title: 'Perfect Game', desc: 'Win a game 11-0' },
  { id: 'champion', title: 'Champion', desc: 'Win a tournament' },
  { id: 'serve10', title: 'Service Ace', desc: 'Land 10 legal serves in a row' },
  { id: 'daily', title: 'Daily Grind', desc: 'Complete a daily challenge' },
  { id: 'challenger', title: 'Challenger', desc: 'Complete every challenge' },
  { id: 'online', title: 'Connected', desc: 'Finish an online match' },
];

export interface DailyDef {
  id: string;
  title: string;
  target: number;
}

export const DAILIES: DailyDef[] = [
  { id: 'winMatch', title: 'Win a match against Normal or better', target: 1 },
  { id: 'topspin20', title: 'Hit 20 topspin shots', target: 20 },
  { id: 'rally12', title: 'Reach a 12-stroke rally', target: 12 },
  { id: 'serves15', title: 'Land 15 legal serves', target: 15 },
  { id: 'speed50', title: 'Hit a shot over 50 km/h', target: 1 },
  { id: 'points25', title: 'Win 25 points', target: 25 },
  { id: 'drill', title: 'Complete any challenge', target: 1 },
];

const KEY = 'pingverse.profile.v1';
const mem = new Map<string, string>();

function store(): { get(k: string): string | null; set(k: string, v: string): void } {
  try {
    if (typeof localStorage !== 'undefined') {
      return { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
    }
  } catch {
    /* storage blocked */
  }
  return { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) };
}

export const todayKey = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function dailyFor(date: string): DailyDef {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) >>> 0;
  return DAILIES[h % DAILIES.length];
}

function randomId(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)];
  return s;
}

export class Progress {
  profile: Profile;
  /** called when something worth announcing happens */
  onUnlock: ((title: string, desc: string) => void) | null = null;
  private dirty = false;

  constructor() {
    this.profile = this.load();
    this.rollDaily();
  }

  private blank(): Profile {
    return {
      name: 'Player',
      playerId: randomId(),
      settings: { ...DEFAULT_SETTINGS },
      records: {
        fastestShotKmh: 0,
        fastestSwingKmh: 0,
        maxSpinRpm: 0,
        longestRally: 0,
        matches: 0,
        wins: 0,
        losses: 0,
        servesIn: 0,
        servesTotal: 0,
        bestServeStreak: 0,
        trophies: 0,
        topspinShots: 0,
        pointsWon: 0,
      },
      achievements: {},
      history: [],
      daily: { date: '', id: '', progress: 0, done: false },
      challengeBest: {},
      challengeDone: {},
    };
  }

  private load(): Profile {
    const base = this.blank();
    try {
      const raw = store().get(KEY);
      if (!raw) return base;
      const p = JSON.parse(raw) as Partial<Profile>;
      return {
        ...base,
        ...p,
        settings: { ...base.settings, ...(p.settings ?? {}) },
        records: { ...base.records, ...(p.records ?? {}) },
        daily: { ...base.daily, ...(p.daily ?? {}) },
      };
    } catch {
      return base;
    }
  }

  save(): void {
    this.dirty = false;
    try {
      store().set(KEY, JSON.stringify(this.profile));
    } catch {
      /* quota / blocked: keep playing with in-memory state */
    }
  }
  touch(): void {
    this.dirty = true;
  }
  flush(): void {
    if (this.dirty) this.save();
  }

  get s(): Settings {
    return this.profile.settings;
  }
  get r(): Records {
    return this.profile.records;
  }

  rollDaily(): void {
    const today = todayKey();
    if (this.profile.daily.date !== today) {
      this.profile.daily = { date: today, id: dailyFor(today).id, progress: 0, done: false };
      this.save();
    }
  }

  get dailyDef(): DailyDef {
    return DAILIES.find((d) => d.id === this.profile.daily.id) ?? DAILIES[0];
  }

  /** Add progress to today's challenge if `id` is the active one. `absolute` sets instead of adds. */
  daily(id: string, amount: number, absolute = false): void {
    const d = this.profile.daily;
    if (d.done || d.id !== id) return;
    d.progress = absolute ? Math.max(d.progress, amount) : d.progress + amount;
    const def = this.dailyDef;
    if (d.progress >= def.target) {
      d.progress = def.target;
      d.done = true;
      this.onUnlock?.('Daily challenge complete', def.title);
      this.unlock('daily');
    }
    this.touch();
  }

  unlock(id: string): void {
    if (this.profile.achievements[id]) return;
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (!def) return;
    this.profile.achievements[id] = Date.now();
    this.onUnlock?.(`Achievement: ${def.title}`, def.desc);
    this.save();
  }

  /** Record one of the player's strokes. Returns which records were broken. */
  shot(ballKmh: number, swingKmh: number, spinRpm: number, topspin: boolean): string[] {
    const r = this.r;
    const broke: string[] = [];
    if (ballKmh > r.fastestShotKmh) {
      r.fastestShotKmh = ballKmh;
      broke.push('shot speed');
    }
    if (swingKmh > r.fastestSwingKmh) r.fastestSwingKmh = swingKmh;
    if (spinRpm > r.maxSpinRpm) {
      r.maxSpinRpm = spinRpm;
      broke.push('spin');
    }
    if (topspin) {
      r.topspinShots++;
      this.daily('topspin20', 1);
    }
    if (ballKmh > 60) this.unlock('speed60');
    if (ballKmh > 50) this.daily('speed50', 1);
    if (spinRpm > 3000) this.unlock('spin3000');
    this.touch();
    return broke;
  }

  rally(count: number): void {
    if (count > this.r.longestRally) this.r.longestRally = count;
    if (count >= 10) this.unlock('rally10');
    if (count >= 25) this.unlock('rally25');
    this.daily('rally12', count, true);
    this.touch();
  }

  serve(inPlay: boolean, streak: number): void {
    const r = this.r;
    r.servesTotal++;
    if (inPlay) {
      r.servesIn++;
      this.daily('serves15', 1);
    }
    if (streak > r.bestServeStreak) r.bestServeStreak = streak;
    if (streak >= 10) this.unlock('serve10');
    this.touch();
  }

  pointWon(): void {
    this.r.pointsWon++;
    this.daily('points25', 1);
    this.touch();
  }

  matchFinished(rec: MatchRecord, difficulty: Difficulty | null, online: boolean): void {
    const r = this.r;
    r.matches++;
    if (rec.won) r.wins++;
    else r.losses++;
    this.profile.history.unshift(rec);
    this.profile.history.length = Math.min(this.profile.history.length, 30);
    if (rec.won) {
      this.unlock('firstWin');
      if (difficulty === 'hard' || difficulty === 'expert') this.unlock('beatHard');
      if (difficulty === 'expert') this.unlock('beatExpert');
      if (difficulty && difficulty !== 'beginner') this.daily('winMatch', 1);
      if (rec.scores.some((s) => s[0] >= 11 && s[1] === 0)) this.unlock('perfect');
    }
    if (r.matches >= 5) this.unlock('matches5');
    if (online) this.unlock('online');
    this.save();
  }

  challengeResult(id: string, score: number, success: boolean, total: number): void {
    const p = this.profile;
    if (score > (p.challengeBest[id] ?? 0)) p.challengeBest[id] = score;
    if (success) {
      p.challengeDone[id] = true;
      this.daily('drill', 1);
      if (Object.keys(p.challengeDone).length >= total) this.unlock('challenger');
    }
    this.save();
  }

  trophy(): void {
    this.r.trophies++;
    this.unlock('champion');
    this.save();
  }
}
