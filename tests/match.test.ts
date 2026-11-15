import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HALF_L } from '../src/core/constants.ts';
import type { Side } from '../src/core/constants.ts';
import { Match } from '../src/rules/match.ts';
import type { PhysEvent } from '../src/physics/world.ts';
import { MatchSession } from '../src/game/session.ts';
import type { AIProfile, Difficulty, Personality } from '../src/ai/opponent.ts';

const ev = (type: PhysEvent['type'], side?: Side, z = 0, edge = false): PhysEvent => ({
  type,
  side,
  edge,
  time: 0,
  impact: 1,
  pos: { x: 0, y: 0.78, z },
});

/** play a legal serve by `s` up to the point where the receiver must return */
function legalServe(m: Match, s: Side): void {
  m.tossed();
  m.handle(ev('paddle', s, s * 1.5));
  m.handle(ev('table', s, s * 0.7));
  m.handle(ev('table', -s as Side, -s * 0.7));
}

test('legal serve then missed return scores for the server', () => {
  const m = new Match();
  m.start();
  legalServe(m, 1);
  assert.equal(m.phase, 'rally');
  m.handle(ev('table', -1, -1)); // second bounce on receiver's side
  assert.deepEqual(m.points, [1, 0]);
  assert.equal(m.lastReason, 'doubleBounce');
});

test('serve faults: no bounce on own side, into the net, long', () => {
  let m = new Match();
  m.start();
  m.tossed();
  m.handle(ev('paddle', 1, 1.5));
  m.handle(ev('table', -1, -0.7)); // straight over without own-side bounce
  assert.deepEqual(m.points, [0, 1]);

  m = new Match();
  m.start();
  m.tossed();
  m.handle(ev('paddle', 1, 1.5));
  m.handle(ev('table', 1, 0.7));
  m.handle(ev('net'));
  m.handle(ev('table', 1, 0.2)); // fell back on own side
  assert.deepEqual(m.points, [0, 1]);

  m = new Match();
  m.start();
  m.tossed();
  m.handle(ev('paddle', 1, 1.5));
  m.handle(ev('table', 1, 0.7));
  m.handle(ev('floor', undefined, -3)); // long
  assert.deepEqual(m.points, [0, 1]);
});

test('net serve that lands in is a let and is replayed', () => {
  const m = new Match();
  m.start();
  let lets = 0;
  m.listener.onLet = () => lets++;
  m.tossed();
  m.handle(ev('paddle', 1, 1.5));
  m.handle(ev('table', 1, 0.7));
  m.handle(ev('net'));
  m.handle(ev('table', -1, -0.4));
  assert.equal(lets, 1);
  assert.deepEqual(m.points, [0, 0]);
  assert.equal(m.phase, 'preServe');
  assert.equal(m.server, 1);
});

test('rally rulings: out, own side, volley, double hit, edge ball', () => {
  const rally = (): Match => {
    const m = new Match();
    m.start();
    legalServe(m, 1);
    m.handle(ev('paddle', -1, -1.6)); // legal return by -1
    return m;
  };
  let m = rally();
  m.handle(ev('floor', undefined, 3)); // return flew long
  assert.deepEqual(m.points, [1, 0]);
  assert.equal(m.lastReason, 'out');

  m = rally();
  m.handle(ev('table', -1, -0.5)); // return landed on the hitter's own side
  assert.deepEqual(m.points, [1, 0]);

  m = rally();
  m.handle(ev('paddle', 1, 0.6)); // +1 volleys over the table
  assert.deepEqual(m.points, [0, 1]);
  assert.equal(m.lastReason, 'volley');

  m = rally();
  m.handle(ev('paddle', 1, HALF_L + 0.5)); // +1 catches a ball already past the end line: it was out
  assert.deepEqual(m.points, [1, 0]);

  m = rally();
  m.handle(ev('paddle', -1, -1.6)); // double hit
  assert.deepEqual(m.points, [1, 0]);

  m = rally();
  let edge = false;
  m.listener.onPoint = (_w, _r, e) => (edge = e);
  m.handle(ev('table', 1, HALF_L, true)); // edge ball is good
  m.handle(ev('floor', undefined, 2));
  assert.deepEqual(m.points, [0, 1]);
  assert.equal(m.lastReason, 'missedReturn');
  assert.equal(edge, false);
});

test('service alternates every 2 points and every point from 10-10', () => {
  const m = new Match({ bestOf: 1 });
  m.start();
  const servers: Side[] = [];
  const win = (s: Side): void => {
    servers.push(m.server);
    legalServe(m, m.server);
    // receiver fails -> server wins; or server's serve is returned and they miss
    if (s === m.server) m.handle(ev('table', -m.server as Side, 0));
    else {
      m.handle(ev('paddle', -m.server as Side, 0));
      m.handle(ev('table', m.server, 0));
      m.handle(ev('table', m.server, 0));
    }
    if (m.phase === 'pointOver') m.nextPoint();
  };
  for (let i = 0; i < 20; i++) win(i % 2 === 0 ? 1 : -1); // 10-10
  assert.deepEqual(m.points, [10, 10]);
  assert.deepEqual(servers.slice(0, 8), [1, 1, -1, -1, 1, 1, -1, -1]);
  win(1);
  win(-1);
  win(1);
  assert.deepEqual(servers.slice(20), [1, -1, 1]);
  assert.equal(m.phase, 'preServe'); // 12-11 is not a win: play continues
  assert.deepEqual(m.points, [12, 11]);
  win(1);
  assert.equal(m.phase, 'matchOver'); // 13-11
  assert.deepEqual(m.gameScores[0], [13, 11]);
});

test('first server alternates each game and best-of-3 ends at two games', () => {
  const m = new Match({ bestOf: 3 });
  m.start();
  const sweep = (): void => {
    while (m.phase !== 'gameOver' && m.phase !== 'matchOver') {
      legalServe(m, m.server);
      // side +1 always wins the point
      if (m.server === 1) m.handle(ev('table', -1, 0));
      else {
        m.handle(ev('paddle', 1, 1.6));
        m.handle(ev('table', -1, -0.5));
        m.handle(ev('table', -1, -0.5));
      }
      if (m.phase === 'pointOver') m.nextPoint();
    }
  };
  sweep();
  assert.deepEqual(m.games, [1, 0]);
  m.nextPoint();
  assert.equal(m.server, -1);
  sweep();
  assert.equal(m.phase, 'matchOver');
  assert.deepEqual(m.games, [2, 0]);
});

test('human serve: a missed toss is replayed (lenient) or a fault (strict)', () => {
  for (const strict of [false, true]) {
    const s = new MatchSession({ bestOf: 1, strictServe: strict }, 3);
    s.setHuman(1);
    s.setAI(-1, { name: 'x', difficulty: 'normal', personality: 'strategist' });
    let asked = 0;
    s.listeners.push({ onHumanServe: () => asked++ });
    s.start();
    assert.equal(asked, 1, 'human is asked to serve first');
    assert.equal(s.world.ballLive, false, 'ball is held, not simulated');
    s.humanToss({ x: -0.2, y: 1.0, z: 1.5 }, { x: 0, y: 2.2, z: 0 });
    assert.equal(s.match.phase, 'toss');
    for (let i = 0; i < 72 * 3 && s.match.phase === 'toss'; i++) s.update(1 / 72);
    if (strict) assert.deepEqual(s.match.points, [0, 1]);
    else {
      assert.deepEqual(s.match.points, [0, 0]);
      assert.equal(s.match.phase, 'preServe');
      assert.equal(asked, 2, 'asked to serve again');
    }
  }
});

test('online: a late-arriving stroke from the remote player cancels the provisional ruling', () => {
  const s = new MatchSession({ bestOf: 1 }, 5);
  s.setHuman(1);
  s.setRemote(-1);
  s.deferFor = -1;
  s.grace = 0.3;
  s.start();
  const m = s.match;
  const fire = (e: PhysEvent): void => s.world.onEvent!(e);
  m.tossed();
  fire(ev('paddle', 1, 1.5));
  fire(ev('table', 1, 0.7));
  fire(ev('table', -1, -0.7)); // legal serve: remote must return
  assert.equal(m.phase, 'rally');
  fire(ev('floor', undefined, -3)); // locally the ball flew past them...
  assert.deepEqual(m.points, [0, 0], 'ruling is held during the grace period');
  fire(ev('paddle', -1, -1.6)); // ...but their stroke arrives in time
  for (let i = 0; i < 60; i++) s.update(1 / 72);
  assert.deepEqual(m.points, [0, 0]);
  assert.equal(m.awaiting, 1, 'rally continues, now we must return');

  // and with no stroke arriving, the point is awarded after the grace period
  fire(ev('table', 1, 0.6));
  fire(ev('paddle', 1, 1.5));
  fire(ev('table', -1, -0.7));
  fire(ev('floor', undefined, -3));
  assert.deepEqual(m.points, [0, 0]);
  for (let i = 0; i < 60; i++) s.update(1 / 72);
  assert.deepEqual(m.points, [1, 0]);
});

// ------------------------------------------------------------------ AI

function aiMatch(a: AIProfile, b: AIProfile, seed: number, maxSeconds = 1500) {
  const s = new MatchSession({ bestOf: 1 }, seed);
  s.setAI(1, a);
  s.setAI(-1, b);
  s.pointDelay = 0.2;
  const stats = { strokes: 0, serves: 0, serveFaults: 0, points: 0, illegal: 0, longest: 0, reasons: {} as Record<string, number> };
  let ballJumps = 0;
  s.listeners.push({
    onStroke: (_by, isServe) => {
      stats.strokes++;
      if (isServe) stats.serves++;
    },
    onPoint: (_w, reason) => {
      stats.points++;
      stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
      if (reason === 'serviceFault') stats.serveFaults++;
      if (reason === 'doubleHit' || reason === 'volley') stats.illegal++;
    },
  });
  s.start();
  const dt = 1 / 72;
  let prev = { ...s.world.ball.pos };
  for (let t = 0; t < maxSeconds && s.match.phase !== 'matchOver'; t += dt) {
    const wasLive = s.world.ballLive;
    s.update(dt);
    const p = s.world.ball.pos;
    // while in play the ball may only move by flying: no teleporting
    if (wasLive && s.world.ballLive) {
      const d = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      const v = Math.hypot(s.world.ball.vel.x, s.world.ball.vel.y, s.world.ball.vel.z);
      if (d > (v + 30) * dt * 1.5 + 0.05) ballJumps++;
    }
    prev = { ...p };
  }
  stats.longest = s.match.longestRally;
  return { s, stats, ballJumps };
}

const P = (difficulty: Difficulty, personality: Personality): AIProfile => ({ name: `${difficulty}-${personality}`, difficulty, personality });

test('AI vs AI plays a full legal game through the shared physics', () => {
  const { s, stats, ballJumps } = aiMatch(P('hard', 'attacker'), P('hard', 'defender'), 7);
  console.log('hard attacker vs hard defender', s.match.gameScores, stats);
  assert.equal(s.match.phase, 'matchOver', 'match finished');
  assert.equal(ballJumps, 0, 'ball never teleports during play');
  assert.ok(stats.strokes / stats.points > 2, `real rallies: ${(stats.strokes / stats.points).toFixed(1)} strokes/point`);
  assert.ok(stats.serveFaults / stats.serves < 0.25, `serves mostly legal: ${stats.serveFaults}/${stats.serves}`);
  assert.ok(stats.illegal / stats.points < 0.1, `few illegal strokes: ${stats.illegal}`);
});

test('every personality and difficulty can serve and rally', () => {
  const pers: Personality[] = ['defender', 'attacker', 'strategist', 'spin'];
  const diffs: Difficulty[] = ['beginner', 'normal', 'hard', 'expert'];
  let seed = 100;
  for (const d of diffs) {
    for (const p of pers) {
      const { s, stats } = aiMatch(P(d, p), P('normal', 'strategist'), seed++, 900);
      console.log(d, p, s.match.gameScores[0] ?? s.match.points, 'strokes/pt', (stats.strokes / Math.max(1, stats.points)).toFixed(1), 'faults', stats.serveFaults + '/' + stats.serves, 'longest', stats.longest);
      assert.equal(s.match.phase, 'matchOver', `${d} ${p} finished`);
      assert.ok(stats.strokes / stats.points > 1.3, `${d} ${p} rallies`);
    }
  }
});

test('stronger AI beats weaker AI over several games', () => {
  let expertWins = 0;
  for (let i = 0; i < 5; i++) {
    const { s } = aiMatch(P('expert', 'attacker'), P('beginner', 'attacker'), 500 + i);
    if (s.match.games[0] > s.match.games[1]) expertWins++;
  }
  assert.ok(expertWins >= 4, `expert won ${expertWins}/5`);
});
