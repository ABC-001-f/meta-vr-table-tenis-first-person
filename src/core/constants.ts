// Physical constants and regulation dimensions (ITTF), SI units.
// Table-local frame: origin on the floor under the table centre.
//   X = across the table, Y = up, Z = along the table.
//   The local player stands at +Z looking toward -Z. The net is at z = 0.

export const TABLE = {
  length: 2.74,
  width: 1.525,
  height: 0.76, // playing surface above floor
  thickness: 0.025,
  lineWidth: 0.02,
  centreLineWidth: 0.003,
} as const;

export const NET = {
  height: 0.1525,
  overhang: 0.1525, // net extends past each side line
  halfThickness: 0.003,
  postRadius: 0.011,
} as const;

export const BALL = {
  radius: 0.02,
  mass: 0.0027,
} as const;

export const PADDLE = {
  bladeRadiusX: 0.075, // half width of blade
  bladeRadiusY: 0.079, // half height of blade
  halfThickness: 0.0075, // blade + rubbers
  handleLength: 0.1,
  // blade centre is this far along the handle axis from the grip centre
  gripToBlade: 0.115,
} as const;

export const AIR = {
  density: 1.2,
  dragCoefficient: 0.4,
  liftFactor: 0.9, // scales the spin-proportional Magnus lift
  spinDecay: 0.25, // 1/s exponential decay of spin in flight
} as const;

export const GRAVITY = 9.81;

// Derived per-unit-mass aerodynamic factors
const area = Math.PI * BALL.radius * BALL.radius;
export const K_DRAG = (0.5 * AIR.density * AIR.dragCoefficient * area) / BALL.mass; // a = -K_DRAG |v| v
export const K_MAGNUS = (0.5 * AIR.density * area * BALL.radius * AIR.liftFactor) / BALL.mass; // a = K_MAGNUS (w x v)

export const SURFACES = {
  // restitution from the ITTF bounce spec: 30 cm drop -> ~23 cm rebound
  table: { restitution: 0.876, friction: 0.25, tangentialRestitution: 0 },
  floor: { restitution: 0.72, friction: 0.4, tangentialRestitution: 0 },
  net: { restitution: 0.12, friction: 0.6, tangentialRestitution: 0 },
  // inverted rubber: grippy, slightly elastic tangentially
  rubber: { restitution: 0.78, friction: 0.95, tangentialRestitution: 0.25 },
} as const;

export const PHYSICS_DT = 1 / 600;

export type Side = 1 | -1; // +1 = local player's end (+Z), -1 = opponent's end

export const HALF_L = TABLE.length / 2;
export const HALF_W = TABLE.width / 2;
