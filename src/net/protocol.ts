// Wire protocol shared by the browser client and the Node WebSocket server.
// All positions are in the SENDER's table frame (sender stands at +Z); the
// receiver mirrors them (x,z -> -x,-z) so each player sees themselves at +Z.

export interface LeaderEntry {
  name: string;
  rating: number;
  wins: number;
  losses: number;
}

export type ClientMsg =
  | { t: 'hello'; name: string; playerId: string; token?: string }
  | { t: 'create' }
  | { t: 'join'; room: string }
  | { t: 'quick' }
  | { t: 'leave' }
  /** relayed verbatim to the other player in the room */
  | { t: 'relay'; d: RelayMsg }
  | { t: 'result'; winnerId: string; loserId: string }
  | { t: 'leaderboard' }
  | { t: 'ping'; n: number };

export type ServerMsg =
  | { t: 'welcome'; token: string; resumed: boolean; room?: string; host?: boolean; peer?: string }
  | { t: 'room'; room: string; host: boolean }
  | { t: 'waiting' }
  | { t: 'peer'; name: string; playerId: string }
  | { t: 'peerLeft'; temporary: boolean }
  | { t: 'peerBack' }
  | { t: 'relay'; d: RelayMsg }
  | { t: 'leaderboard'; top: LeaderEntry[] }
  | { t: 'error'; msg: string }
  | { t: 'pong'; n: number };

/** n = [x,y,z], q = [x,y,z,w] */
export type RelayMsg =
  /** pose stream ~30 Hz: head, paddle, free hand */
  | { k: 'pose'; h: number[]; hq: number[]; p: number[]; pq: number[]; f?: number[] }
  /** authoritative ball state after the sender's stroke, toss or while holding it */
  | { k: 'ball'; why: 'hit' | 'toss' | 'hold'; p: number[]; v: number[]; s: number[]; seq: number; speed?: number }
  /** host -> guest: rules state. Scores are [host, guest]; server is 'h' or 'g'. */
  | { k: 'state'; pts: [number, number]; games: [number, number]; server: 'h' | 'g'; phase: string; reason?: string; winner?: 'h' | 'g'; rally: number }
  | { k: 'start'; bestOf: number; table: string; env: string }
  | { k: 'react'; e: string }
  | { k: 'look'; paddle: string; rubber: string }
  | { k: 'rematch' };

export const REACTIONS = ['Nice shot!', 'Good game', 'Wow!', 'Oops', 'Thanks', 'Rematch?'];

export const ROOM_CODE_LEN = 5;
export const RECONNECT_GRACE_MS = 45000;
