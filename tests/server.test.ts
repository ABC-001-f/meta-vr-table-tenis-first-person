// End-to-end test of the multiplayer server with two real WebSocket clients:
// private room + room ID, relay, quick matchmaking, reconnection, leaderboard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../src/net/protocol.ts';

const PORT = 18787 + Math.floor(Math.random() * 500);
let proc: ChildProcess;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pingverse-'));
  proc = spawn(process.execPath, [fileURLToPath(new URL('../server/server.ts', import.meta.url))], {
    env: { ...process.env, PORT: String(PORT), PINGVERSE_DATA: join(dir, 'leaderboard.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 20000);
    proc.stdout!.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => {
  proc?.kill();
});

class Client {
  ws!: WebSocket;
  inbox: ServerMsg[] = [];
  token = '';
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  name: string;
  id: string;

  constructor(name: string, id: string) {
    this.name = name;
    this.id = id;
  }

  async open(): Promise<ServerMsg> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.inbox.push(m);
    });
    await new Promise<void>((r, j) => {
      this.ws.once('open', () => r());
      this.ws.once('error', j);
    });
    this.send({ t: 'hello', name: this.name, playerId: this.id, token: this.token || undefined });
    const w = await this.next('welcome');
    if (w.t === 'welcome') this.token = w.token;
    return w;
  }

  send(m: ClientMsg): void {
    this.ws.send(JSON.stringify(m));
  }

  next<T extends ServerMsg['t']>(type: T, ms = 5000): Promise<Extract<ServerMsg, { t: T }>> {
    const pred = (m: ServerMsg): boolean => m.t === type;
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as Extract<ServerMsg, { t: T }>);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${type}`)), ms);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as Extract<ServerMsg, { t: T }>);
        },
      });
    });
  }
}

test('private room: create, join by ID, relay both ways', async () => {
  const a = new Client('Alice', 'alice-1');
  const b = new Client('Bob', 'bob-1');
  await a.open();
  await b.open();
  a.send({ t: 'create' });
  const room = await a.next('room');
  assert.equal(room.host, true);
  assert.match(room.room, /^[A-Z2-9]{5}$/);

  b.send({ t: 'join', room: room.room.toLowerCase() });
  assert.equal((await b.next('room')).host, false);
  assert.equal((await a.next('peer')).name, 'Bob');
  assert.equal((await b.next('peer')).name, 'Alice');

  a.send({ t: 'relay', d: { k: 'ball', why: 'hit', p: [0, 1, 1], v: [0, 1, -6], s: [-50, 0, 0], seq: 1 } });
  const got = await b.next('relay');
  assert.deepEqual(got.d, { k: 'ball', why: 'hit', p: [0, 1, 1], v: [0, 1, -6], s: [-50, 0, 0], seq: 1 });
  b.send({ t: 'relay', d: { k: 'react', e: 'Nice shot!' } });
  assert.deepEqual((await a.next('relay')).d, { k: 'react', e: 'Nice shot!' });

  // a third player cannot enter a full room, and unknown rooms are rejected
  const c = new Client('Cara', 'cara-1');
  await c.open();
  c.send({ t: 'join', room: room.room });
  assert.match((await c.next('error')).msg, /full/i);
  c.send({ t: 'join', room: 'ZZZZZ' });
  assert.match((await c.next('error')).msg, /not found/i);

  // ---- reconnection: Bob drops and comes back with his token
  b.ws.terminate();
  assert.equal((await a.next('peerLeft')).temporary, true);
  const w = await b.open();
  assert.equal(w.t === 'welcome' && w.resumed, true);
  assert.equal(w.t === 'welcome' && w.room, room.room);
  await a.next('peerBack');
  a.send({ t: 'relay', d: { k: 'rematch' } });
  assert.deepEqual((await b.next('relay')).d, { k: 'rematch' });

  // ---- result reporting + leaderboard (host only, once)
  b.send({ t: 'result', winnerId: 'bob-1', loserId: 'alice-1' }); // guest: ignored
  a.send({ t: 'result', winnerId: 'alice-1', loserId: 'bob-1' });
  a.send({ t: 'result', winnerId: 'alice-1', loserId: 'bob-1' }); // duplicate: ignored
  a.send({ t: 'leaderboard' });
  const lb = await a.next('leaderboard');
  assert.equal(lb.top.length, 2);
  assert.deepEqual([lb.top[0].name, lb.top[0].wins, lb.top[0].losses], ['Alice', 1, 0]);
  assert.ok(lb.top[0].rating > 1000 && lb.top[1].rating < 1000);

  // ---- leaving for good
  b.send({ t: 'leave' });
  assert.equal((await a.next('peerLeft')).temporary, false);
  for (const x of [a, b, c]) x.ws.close();
});

test('quick matchmaking pairs two waiting players', async () => {
  const a = new Client('Dan', 'dan-1');
  const b = new Client('Eve', 'eve-1');
  await a.open();
  await b.open();
  a.send({ t: 'quick' });
  await a.next('waiting');
  b.send({ t: 'quick' });
  const ra = await a.next('room');
  const rb = await b.next('room');
  assert.equal(ra.room, rb.room);
  assert.equal(ra.host, true);
  assert.equal(rb.host, false);
  assert.equal((await a.next('peer')).name, 'Eve');
  a.send({ t: 'ping', n: 7 });
  assert.equal((await a.next('pong')).n, 7);
  a.ws.close();
  b.ws.close();
});
