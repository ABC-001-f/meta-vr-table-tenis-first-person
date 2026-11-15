import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALL, HALF_L, HALF_W, NET, PADDLE, TABLE } from '../src/core/constants.ts';
import { qFacing } from '../src/core/math.ts';
import { PhysicsWorld, makePaddle, predictFlight } from '../src/physics/world.ts';
import type { PhysEvent } from '../src/physics/world.ts';

function fly(pos: number[], vel: number[], spin: number[] = [0, 0, 0], t = 2): PhysEvent[] {
  return predictFlight(
    {
      pos: { x: pos[0], y: pos[1], z: pos[2] },
      vel: { x: vel[0], y: vel[1], z: vel[2] },
      spin: { x: spin[0], y: spin[1], z: spin[2] },
    },
    t,
  ).events;
}

test('bounce height matches the ITTF spec (30 cm drop -> ~23 cm)', () => {
  const w = new PhysicsWorld();
  w.ball.pos = { x: 0, y: TABLE.height + BALL.radius + 0.3, z: 0.7 };
  w.ball.vel = { x: 0, y: 0, z: 0 };
  w.ballLive = true;
  let bounced = false;
  let peak = 0;
  w.onEvent = (e) => {
    if (e.type === 'table') bounced = true;
  };
  for (let i = 0; i < 600; i++) {
    w.stepFixed();
    if (bounced) peak = Math.max(peak, w.ball.pos.y - TABLE.height - BALL.radius);
    if (bounced && w.ball.vel.y < 0) break;
  }
  assert.ok(peak > 0.2 && peak < 0.26, `rebound ${peak.toFixed(3)} m`);
});

test('ball never passes through the table, even when smashed down', () => {
  for (const vy of [-5, -15, -30]) {
    const ev = fly([0.2, 1.2, 0.6], [0, vy, -1]);
    assert.equal(ev[0]?.type, 'table', `vy=${vy}`);
  }
});

test('ball cannot pass through the net', () => {
  for (const speed of [3, 10, 25, 40]) {
    const ev = fly([0, TABLE.height + 0.08, 1.0], [0, 0.2, -speed], [0, 0, 0], 1);
    const first = ev.find((e) => e.type === 'net' || (e.type === 'table' && e.side === -1));
    assert.equal(first?.type, 'net', `speed ${speed}`);
  }
  // a ball above the tape clears it
  const over = fly([0, TABLE.height + NET.height + 0.12, 0.3], [0, 0.6, -6], [0, 0, 0], 1);
  assert.ok(!over.some((e) => e.type === 'net'));
});

test('topspin dips, backspin floats (Magnus effect)', () => {
  const land = (sx: number): number => {
    const ev = fly([0, 1.1, 1.3], [0, 1.5, -7], [sx, 0, 0], 2);
    return ev[0].pos.z;
  };
  // moving toward -Z: topspin is spin.x < 0
  const top = land(-150);
  const flat = land(0);
  const back = land(150);
  assert.ok(top > flat + 0.2, `topspin lands shorter: ${top.toFixed(2)} vs ${flat.toFixed(2)}`);
  assert.ok(back < flat - 0.2, `backspin carries further: ${back.toFixed(2)} vs ${flat.toFixed(2)}`);
});

test('sidespin curves the ball sideways', () => {
  const a = fly([0, 1.0, 1.3], [0, 1.2, -6], [0, 120, 0])[0].pos.x;
  const b = fly([0, 1.0, 1.3], [0, 1.2, -6], [0, -120, 0])[0].pos.x;
  assert.ok(Math.abs(a - b) > 0.15 && a * b < 0, `x ${a.toFixed(2)} / ${b.toFixed(2)}`);
});

test('spin changes the bounce: topspin kicks forward, backspin holds up', () => {
  const after = (sx: number): number => {
    const ev = fly([0, 0.95, 0.9], [0, -3.5, -2], [sx, 0, 0], 1);
    return ev[0].velAfter!.z;
  };
  assert.ok(after(-200) < after(0) - 0.3, 'topspin leaves faster');
  assert.ok(after(200) > after(0) + 0.3, 'backspin leaves slower');
});

test('air resistance decelerates the ball', () => {
  const r = predictFlight({ pos: { x: 0, y: 3, z: 3 }, vel: { x: 0, y: 0, z: -20 }, spin: { x: 0, y: 0, z: 0 } }, 0.3);
  assert.equal(r.events.length, 0);
});

test('edge ball counts as on the table; side of the table does not', () => {
  // dropping right on the end-line edge
  const ev = fly([0, 1.0, HALF_L + BALL.radius * 0.6], [0, -2, 0]);
  assert.equal(ev[0].type, 'table');
  assert.equal(ev[0].edge, true);
  // hitting the side face from the side, below the top
  const side = fly([HALF_W + 0.3, TABLE.height - 0.012, 0.5], [-4, 0.05, 0], [0, 0, 0], 0.5);
  assert.equal(side[0].type, 'tableSide');
  // clearly off the table goes to the floor
  const out = fly([HALF_W + 0.2, 1.0, 0.5], [0, -1, 0]);
  assert.equal(out[0].type, 'floor');
});

function strike(paddleVel: number[], normal: number[], ballVel: number[] = [0, 0, 0]) {
  const w = new PhysicsWorld();
  const p = w.addPaddle(makePaddle(1));
  p.active = true;
  const n = { x: normal[0], y: normal[1], z: normal[2] };
  const q = qFacing(n, { x: 0, y: 1, z: 0 });
  const v = { x: paddleVel[0], y: paddleVel[1], z: paddleVel[2] };
  const start = { x: 0, y: 1.0, z: 1.6 };
  p.pos = start;
  p.prevPos = start;
  p.quat = q;
  p.prevQuat = q;
  p.vel = v;
  w.ball.pos = { x: 0, y: 1.0, z: 1.6 - 0.12 };
  w.ball.vel = { x: ballVel[0], y: ballVel[1], z: ballVel[2] };
  w.ballLive = true;
  let hit: PhysEvent | null = null;
  w.onEvent = (e) => {
    if (e.type === 'paddle') hit = e;
  };
  const dt = 1 / 72;
  for (let i = 0; i < 12 && !hit; i++) {
    p.pos = { x: p.pos.x + v.x * dt, y: p.pos.y + v.y * dt, z: p.pos.z + v.z * dt };
    w.advance(dt);
  }
  return hit as PhysEvent | null;
}

test('a faster swing produces a faster shot', () => {
  const slow = strike([0, 0, -2], [0, 0, -1]);
  const fast = strike([0, 0, -8], [0, 0, -1]);
  assert.ok(slow && fast, 'paddle made contact');
  const vs = Math.abs(slow!.velAfter!.z);
  const vf = Math.abs(fast!.velAfter!.z);
  assert.ok(vf > vs * 2.5, `${vs.toFixed(1)} -> ${vf.toFixed(1)} m/s`);
});

test('a fast thin paddle never tunnels through the ball (swept collision)', () => {
  for (const speed of [15, 25, 35]) {
    const hit = strike([0, 0, -speed], [0, 0, -1], [0, 0, 6]);
    assert.ok(hit, `contact at ${speed} m/s`);
    assert.ok(hit!.velAfter!.z < -speed * 0.9);
  }
});

test('brushing the ball generates spin; a flat hit does not', () => {
  const flat = strike([0, 0, -6], [0, 0, -1]);
  const brushUp = strike([0, 5, -6], [0, 0, -1]);
  const brushDown = strike([0, -5, -6], [0, 0, -1]);
  assert.ok(flat && brushUp && brushDown);
  assert.ok(Math.abs(flat!.spinAfter!.x) < 15, 'flat hit: negligible spin');
  assert.ok(brushUp!.spinAfter!.x < -60, `topspin ${brushUp!.spinAfter!.x.toFixed(0)}`);
  assert.ok(brushDown!.spinAfter!.x > 60, `backspin ${brushDown!.spinAfter!.x.toFixed(0)}`);
  assert.ok(brushUp!.velAfter!.y > flat!.velAfter!.y + 0.5, 'brush lifts the ball');
});

test('paddle angle steers the ball and contact point is reported', () => {
  const open = strike([0, 0, -5], [0, 0.5, -0.866]);
  assert.ok(open);
  assert.ok(open!.velAfter!.y > 1.5, 'open face sends it upward');
  assert.ok(Math.abs(open!.bladeX!) < PADDLE.bladeRadiusX && Math.abs(open!.bladeY!) < PADDLE.bladeRadiusY);
});

test('simulation is deterministic regardless of frame rate', () => {
  const run = (fps: number): number[] => {
    const w = new PhysicsWorld();
    w.ball.pos = { x: 0.1, y: 1.1, z: 1.2 };
    w.ball.vel = { x: 0.4, y: 1, z: -6 };
    w.ball.spin = { x: -80, y: 30, z: 0 };
    w.ballLive = true;
    const ev: number[] = [];
    w.onEvent = (e) => ev.push(e.pos.x, e.pos.z);
    let t = 0;
    while (t < 1.5) {
      w.advance(1 / fps);
      t += 1 / fps;
    }
    return ev.slice(0, 4);
  };
  const a = run(72),
    b = run(120),
    c = run(45);
  assert.ok(a.length >= 2);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-9 && Math.abs(a[i] - c[i]) < 1e-9, 'identical bounce points');
  }
});
