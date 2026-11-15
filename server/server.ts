// PINGVERSE VR multiplayer server: private rooms with room IDs, quick
// matchmaking, message relay between the two players, reconnection with a
// grace period, and a persistent Elo leaderboard.
// Run with:  npm run server   (Node >= 22.18 runs TypeScript directly)
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RECONNECT_GRACE_MS, ROOM_CODE_LEN } from '../src/net/protocol.ts';
import type { ClientMsg, LeaderEntry, ServerMsg } from '../src/net/protocol.ts';

interface Client {
  token: string;
  playerId: string;
  name: string;
  ws: WebSocket | null;
  room: Room | null;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

interface Room {
  code: string;
  host: Client;
  guest: Client | null;
  reported: boolean;
}

const PORT = Number(process.env.PORT ?? 8787);
const DATA = process.env.PINGVERSE_DATA ?? new URL('./leaderboard.json', import.meta.url);
const clients = new Map<string, Client>(); // by token
const rooms = new Map<string, Room>();
let quickQueue: Client | null = null;

type Ratings = Record<string, { name: string; rating: number; wins: number; losses: number }>;
let ratings: Ratings = {};
try {
  if (existsSync(DATA)) ratings = JSON.parse(readFileSync(DATA, 'utf8')) as Ratings;
} catch {
  ratings = {};
}
const saveRatings = (): void => {
  try {
    writeFileSync(DATA, JSON.stringify(ratings));
  } catch (e) {
    console.error('could not save leaderboard', e);
  }
};

const send = (c: Client | null, m: ServerMsg): void => {
  if (c?.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(m));
};
const peerOf = (c: Client): Client | null => (c.room ? (c.room.host === c ? c.room.guest : c.room.host) : null);

function roomCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const b = randomBytes(ROOM_CODE_LEN);
    let s = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) s += abc[b[i] % abc.length];
    if (!rooms.has(s)) return s;
  }
}

function leave(c: Client, temporary: boolean): void {
  if (quickQueue === c) quickQueue = null;
  const room = c.room;
  if (!room) return;
  const peer = peerOf(c);
  send(peer, { t: 'peerLeft', temporary });
  if (temporary) return;
  c.room = null;
  if (room.host === c) {
    if (peer) {
      room.host = peer;
      room.guest = null;
      send(peer, { t: 'room', room: room.code, host: true });
    } else rooms.delete(room.code);
  } else room.guest = null;
}

function pair(room: Room): void {
  const { host, guest } = room;
  if (!guest) return;
  room.reported = false;
  send(host, { t: 'peer', name: guest.name, playerId: guest.playerId });
  send(guest, { t: 'peer', name: host.name, playerId: host.playerId });
}

function top(): LeaderEntry[] {
  return Object.values(ratings)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 20)
    .map((r) => ({ name: r.name, rating: Math.round(r.rating), wins: r.wins, losses: r.losses }));
}

function handle(c: Client, m: ClientMsg): void {
  switch (m.t) {
    case 'create': {
      leave(c, false);
      const room: Room = { code: roomCode(), host: c, guest: null, reported: false };
      rooms.set(room.code, room);
      c.room = room;
      return send(c, { t: 'room', room: room.code, host: true });
    }
    case 'join': {
      const room = rooms.get(String(m.room).toUpperCase().trim());
      if (!room) return send(c, { t: 'error', msg: 'Room not found' });
      if (room.host === c || room.guest === c) return;
      if (room.guest) return send(c, { t: 'error', msg: 'Room is full' });
      leave(c, false);
      room.guest = c;
      c.room = room;
      send(c, { t: 'room', room: room.code, host: false });
      return pair(room);
    }
    case 'quick': {
      leave(c, false);
      const other = quickQueue;
      if (other && other !== c && other.ws) {
        quickQueue = null;
        const room: Room = { code: roomCode(), host: other, guest: c, reported: false };
        rooms.set(room.code, room);
        other.room = room;
        c.room = room;
        send(other, { t: 'room', room: room.code, host: true });
        send(c, { t: 'room', room: room.code, host: false });
        return pair(room);
      }
      quickQueue = c;
      return send(c, { t: 'waiting' });
    }
    case 'leave':
      return leave(c, false);
    case 'relay':
      return send(peerOf(c), { t: 'relay', d: m.d });
    case 'result': {
      // only the host reports, once per pairing, and only for the two players in the room
      const room = c.room;
      if (!room || room.host !== c || !room.guest || room.reported) return;
      const ids = [room.host.playerId, room.guest.playerId];
      if (!ids.includes(m.winnerId) || !ids.includes(m.loserId) || m.winnerId === m.loserId) return;
      room.reported = true;
      const nameOf = (id: string): string => (room.host.playerId === id ? room.host.name : room.guest!.name);
      const w = (ratings[m.winnerId] ??= { name: nameOf(m.winnerId), rating: 1000, wins: 0, losses: 0 });
      const l = (ratings[m.loserId] ??= { name: nameOf(m.loserId), rating: 1000, wins: 0, losses: 0 });
      w.name = nameOf(m.winnerId);
      l.name = nameOf(m.loserId);
      const expected = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
      const delta = 24 * (1 - expected);
      w.rating += delta;
      l.rating -= delta;
      w.wins++;
      l.losses++;
      saveRatings();
      return;
    }
    case 'leaderboard':
      return send(c, { t: 'leaderboard', top: top() });
    case 'ping':
      return send(c, { t: 'pong', n: m.n });
  }
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  let me: Client | null = null;
  ws.on('message', (raw) => {
    let m: ClientMsg;
    try {
      m = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') {
      const name = String(m.name ?? 'Player').slice(0, 20) || 'Player';
      const old = m.token ? clients.get(m.token) : undefined;
      if (old && old.playerId === m.playerId) {
        // reconnection: reattach to the same seat
        if (old.ws && old.ws !== ws) old.ws.close();
        if (old.dropTimer) clearTimeout(old.dropTimer);
        old.dropTimer = null;
        old.ws = ws;
        old.name = name;
        me = old;
        const peer = peerOf(old);
        send(old, {
          t: 'welcome',
          token: old.token,
          resumed: true,
          room: old.room?.code,
          host: old.room ? old.room.host === old : undefined,
          peer: peer?.name,
        });
        send(peer, { t: 'peerBack' });
        return;
      }
      me = {
        token: randomBytes(16).toString('hex'),
        playerId: String(m.playerId ?? '').slice(0, 32) || randomBytes(6).toString('hex'),
        name,
        ws,
        room: null,
        dropTimer: null,
      };
      clients.set(me.token, me);
      return send(me, { t: 'welcome', token: me.token, resumed: false });
    }
    if (me) handle(me, m);
  });
  ws.on('close', () => {
    const c = me;
    if (!c || c.ws !== ws) return;
    c.ws = null;
    leave(c, true);
    c.dropTimer = setTimeout(() => {
      leave(c, false);
      clients.delete(c.token);
    }, RECONNECT_GRACE_MS);
  });
  ws.on('error', () => ws.close());
});

console.log(`PINGVERSE multiplayer server listening on ws://localhost:${PORT}`);
