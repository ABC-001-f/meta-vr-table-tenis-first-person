// The human serve. With two tracked hands the ball rests on the open palm of
// the free hand and is tossed by lifting that hand: it leaves the palm with
// the hand's real velocity when the hand stops accelerating upward. With one
// hand (or on desktop) the ball waits at a serve spot and is tossed
// automatically on a steady rhythm.
import { HALF_L, TABLE } from '../core/constants.ts';
import type { Vec3 } from '../core/math.ts';

export interface ServeOutput {
  /** where to draw the held ball */
  pos: Vec3;
  /** set on the frame the ball is released */
  release: Vec3 | null;
  /** 0..1 countdown to an automatic toss (for a visual cue), -1 in palm mode */
  cue: number;
}

export class ServeController {
  active = false;
  /** seconds between automatic tosses */
  autoInterval = 2.2;
  private timer = 0;
  private peakVy = 0;
  private armed = false;
  private lostHand = 0;
  private palmMode = false;
  private out: ServeOutput = { pos: { x: 0, y: 1, z: 0 }, release: null, cue: -1 };

  begin(): void {
    this.active = true;
    this.timer = 0;
    this.peakVy = 0;
    this.armed = false;
    this.lostHand = 0;
  }

  cancel(): void {
    this.active = false;
  }

  /**
   * @param palm      free-hand palm centre in table space, or null when not tracked
   * @param palmVel   its velocity
   * @param palmUp    how much the palm faces up, 0..1
   * @param foreSign  +1 right-handed (free hand on -X), -1 left-handed
   */
  update(dt: number, palm: Vec3 | null, palmVel: Vec3 | null, palmUp: number, foreSign: number): ServeOutput {
    const o = this.out;
    o.release = null;
    o.cue = -1;
    if (!this.active) return o;

    if (palm && palmVel) {
      this.lostHand = 0;
      this.palmMode = true;
    } else {
      this.lostHand += dt;
      if (this.lostHand > 0.8) this.palmMode = false;
    }

    if (this.palmMode && palm && palmVel) {
      o.pos = { x: palm.x, y: palm.y + 0.035, z: palm.z };
      const vy = palmVel.y;
      if (vy > 0.55 && palmUp > 0.2) {
        this.armed = true;
        if (vy > this.peakVy) this.peakVy = vy;
      }
      // the ball separates when the hand slows below the speed it gave the ball
      if (this.armed && vy < this.peakVy * 0.8) {
        const k = this.peakVy / Math.max(vy, 0.2);
        o.release = {
          x: palmVel.x * 0.5,
          y: Math.max(this.peakVy, 1.2),
          z: palmVel.z * 0.5 * Math.min(k, 1),
        };
        this.active = false;
      } else if (vy < 0.1) {
        this.armed = false;
        this.peakVy = 0;
      }
      return o;
    }

    if (this.palmMode) return o; // hand briefly lost: keep the ball where it was

    // automatic toss from a fixed, comfortable spot beside the paddle hand
    this.timer += dt;
    o.pos = { x: -foreSign * 0.24, y: TABLE.height + 0.2, z: HALF_L + 0.14 };
    o.cue = Math.min(1, this.timer / this.autoInterval);
    if (this.timer >= this.autoInterval) {
      o.release = { x: 0, y: 2.25, z: 0 };
      this.active = false;
    }
    return o;
  }
}
