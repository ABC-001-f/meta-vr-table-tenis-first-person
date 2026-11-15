// Cosmetic catalogue: table designs, paddles, environments. Nothing in here
// touches physics - every paddle plays identically, so customization can
// never give a competitive advantage.

export interface TableDesign {
  id: string;
  name: string;
  top: number;
  line: number;
  frame: number;
  legs: number;
  net: number;
  metalness: number;
  roughness: number;
  /** emissive glow colour for lines / under-glow, 0 = none */
  glow: number;
  carbon: boolean;
}

export const TABLES: TableDesign[] = [
  { id: 'blue', name: 'Professional Competition Blue', top: 0x1d4f9e, line: 0xffffff, frame: 0x20242c, legs: 0x2a2f38, net: 0x15233f, metalness: 0.05, roughness: 0.55, glow: 0, carbon: false },
  { id: 'green', name: 'Classic Tournament Green', top: 0x1b6a43, line: 0xffffff, frame: 0x1d2420, legs: 0x26302a, net: 0x10301f, metalness: 0.05, roughness: 0.6, glow: 0, carbon: false },
  { id: 'carbon', name: 'Carbon Black', top: 0x17191d, line: 0xd9dde3, frame: 0x0c0d0f, legs: 0x17181b, net: 0x0a0a0a, metalness: 0.35, roughness: 0.4, glow: 0, carbon: true },
  { id: 'gold', name: 'Luxury Gold', top: 0x14110c, line: 0xe2b857, frame: 0xc79a3a, legs: 0xb98d32, net: 0x1a1508, metalness: 0.3, roughness: 0.35, glow: 0, carbon: false },
  { id: 'neon', name: 'Futuristic Neon', top: 0x0b0d1c, line: 0x35e6ff, frame: 0x151833, legs: 0x1b1f45, net: 0x1a0f3a, metalness: 0.4, roughness: 0.3, glow: 0x35e6ff, carbon: false },
];

export interface PaddleDesign {
  id: string;
  name: string;
  blade: number; // wood / edge colour
  edge: number;
  handle: string; // default handle material id
  glow: number;
  metalEdge: boolean;
}

export const PADDLES: PaddleDesign[] = [
  { id: 'classic', name: 'Classic Wooden Paddle', blade: 0xc9a06a, edge: 0xb8905c, handle: 'flared-wood', glow: 0, metalEdge: false },
  { id: 'pro', name: 'Professional Competition Paddle', blade: 0xb78a55, edge: 0x1c1c1c, handle: 'pro-stripe', glow: 0, metalEdge: false },
  { id: 'carbon', name: 'Carbon Fibre Paddle', blade: 0x2a2c30, edge: 0x101113, handle: 'carbon', glow: 0, metalEdge: false },
  { id: 'gold', name: 'Gold Edition', blade: 0x3a2c12, edge: 0xd9ad4a, handle: 'gold', glow: 0, metalEdge: true },
  { id: 'neon', name: 'Futuristic Neon Paddle', blade: 0x14162b, edge: 0x35e6ff, handle: 'neon', glow: 0x35e6ff, metalEdge: false },
];

export interface HandleDesign {
  id: string;
  name: string;
  color: number;
  accent: number;
  metalness: number;
  roughness: number;
  glow: number;
}

export const HANDLES: HandleDesign[] = [
  { id: 'flared-wood', name: 'Light Wood', color: 0xc79b62, accent: 0x8a5a2b, metalness: 0, roughness: 0.7, glow: 0 },
  { id: 'pro-stripe', name: 'Walnut Stripe', color: 0x6b4423, accent: 0x1b4f9c, metalness: 0, roughness: 0.6, glow: 0 },
  { id: 'carbon', name: 'Carbon', color: 0x1b1c1f, accent: 0x55585e, metalness: 0.4, roughness: 0.35, glow: 0 },
  { id: 'gold', name: 'Gold', color: 0xd4a843, accent: 0x2a1f0a, metalness: 0.9, roughness: 0.25, glow: 0 },
  { id: 'neon', name: 'Neon', color: 0x181a33, accent: 0xff3fd0, metalness: 0.3, roughness: 0.4, glow: 0xff3fd0 },
];

export const RUBBER_COLORS: { name: string; hex: string }[] = [
  { name: 'Red', hex: '#c8102e' },
  { name: 'Black', hex: '#111111' },
  { name: 'Blue', hex: '#1f5fd0' },
  { name: 'Green', hex: '#1f9d55' },
  { name: 'Pink', hex: '#e8479a' },
  { name: 'Violet', hex: '#7a3fd6' },
];

export const GRIPS = [
  { id: 'plain', name: 'Plain' },
  { id: 'tape', name: 'Wrapped Tape' },
  { id: 'stripe', name: 'Striped' },
];

export const SURFACES_LOOK = [
  { id: 'smooth', name: 'Smooth' },
  { id: 'pimpled', name: 'Pimpled' },
  { id: 'logo', name: 'Logo Print' },
];

export const ENVIRONMENTS = [
  { id: 'arena', name: 'Professional Sports Arena' },
  { id: 'club', name: 'Luxury Table Tennis Club' },
  { id: 'cyber', name: 'Futuristic Cyber Arena' },
  { id: 'studio', name: 'Minimal Training Studio' },
];

export interface PaddleLook {
  paddle: string;
  rubberColor: string;
  rubberBackColor: string;
  handle: string;
  grip: string;
  surface: string;
}

export function cycle<T extends { id: string }>(list: T[], id: string, dir = 1): T {
  const i = Math.max(0, list.findIndex((x) => x.id === id));
  return list[(i + dir + list.length) % list.length];
}
