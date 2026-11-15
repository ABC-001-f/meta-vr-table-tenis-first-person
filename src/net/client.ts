// Browser WebSocket client: rooms, matchmaking, relay, automatic reconnection.
import type { ClientMsg, LeaderEntry, RelayMsg, ServerMsg } from './protocol.ts';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'reconnecting';

export interface NetListener {
  onStatus?(s: NetStatus): void;
  onRoom?(room: string, host: boolean): void;
  onWaiting?(): void;
  onPeer?(name: string, playerId: string): void;
  onPeerLeft?(temporary: boolean): void;
  onPeerBack?(): void;
  onRelay?(d: RelayMsg): void;
  onLeaderboard?(top: LeaderEntry[]): void;
  onError?(msg: string): void;
}

export class NetClient {
  status: NetStatus = 'offline';
  room = '';
  host = false;
  peerName = '';
  peerId = '';
  peerPresent = false;
  /** round-trip time, ms */
  rtt = 0;
  listener: NetListener = {};
  private ws: WebSocket | null = null;
  private token = '';
  private wanted = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSent = new Map<number, number>();
  private pingN = 0;
  private queue: ClientMsg[] = [];
  private url: string;
  private name: string;
  private playerId: string;

  constructor(url: string, name: string, playerId: string) {
    this.url = url;
    this.name = name;
    this.playerId = playerId;
  }

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.listener.onStatus?.(s);
  }

  connect(): void {
    this.wanted = true;
    if (this.ws) return;
    this.setStatus(this.token ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw({ t: 'hello', name: this.name, playerId: this.playerId, token: this.token || undefined });
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.wanted) this.scheduleRetry();
      else this.setStatus('offline');
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    this.ws = null;
    if (!this.wanted) return this.setStatus('offline');
    this.retry++;
    if (this.retry > 8) {
      this.wanted = false;
      this.setStatus('offline');
      this.listener.onError?.('Cannot reach the multiplayer server');
      return;
    }
    this.setStatus(this.token ? 'reconnecting' : 'connecting');
    this.retryTimer = setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** (this.retry - 1)));
  }

  disconnect(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ws) {
      this.raw({ t: 'leave' });
      this.ws.close();
    }
    this.ws = null;
    this.token = '';
    this.room = '';
    this.peerPresent = false;
    this.queue = [];
    this.setStatus('offline');
  }

  private raw(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  /** Send once the handshake has completed (queued until then). */
  send(m: ClientMsg): void {
    if (this.status === 'online') this.raw(m);
    else if (m.t !== 'relay') this.queue.push(m);
  }

  relay(d: RelayMsg): void {
    if (this.status === 'online' && this.peerPresent) this.raw({ t: 'relay', d });
  }

  createRoom(): void {
    this.send({ t: 'create' });
  }
  joinRoom(code: string): void {
    this.send({ t: 'join', room: code });
  }
  quickMatch(): void {
    this.send({ t: 'quick' });
  }
  requestLeaderboard(): void {
    this.send({ t: 'leaderboard' });
  }

  private handle(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.token = m.token;
        this.setStatus('online');
        if (m.resumed && m.room) {
          this.room = m.room;
          this.host = !!m.host;
          this.peerPresent = !!m.peer;
        }
        for (const q of this.queue) this.raw(q);
        this.queue = [];
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          const n = ++this.pingN;
          this.pingSent.set(n, performance.now());
          if (this.pingSent.size > 10) this.pingSent.clear();
          this.raw({ t: 'ping', n });
        }, 2000);
        return;
      case 'room':
        this.room = m.room;
        this.host = m.host;
        return this.listener.onRoom?.(m.room, m.host);
      case 'waiting':
        return this.listener.onWaiting?.();
      case 'peer':
        this.peerName = m.name;
        this.peerId = m.playerId;
        this.peerPresent = true;
        return this.listener.onPeer?.(m.name, m.playerId);
      case 'peerLeft':
        this.peerPresent = false;
        return this.listener.onPeerLeft?.(m.temporary);
      case 'peerBack':
        this.peerPresent = true;
        return this.listener.onPeerBack?.();
      case 'relay':
        return this.listener.onRelay?.(m.d);
      case 'leaderboard':
        return this.listener.onLeaderboard?.(m.top);
      case 'error':
        return this.listener.onError?.(m.msg);
      case 'pong': {
        const t0 = this.pingSent.get(m.n);
        if (t0 !== undefined) {
          this.rtt = performance.now() - t0;
          this.pingSent.delete(m.n);
        }
        return;
      }
    }
  }
}
