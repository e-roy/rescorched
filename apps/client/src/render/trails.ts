/**
 * Trajectory arcs.
 *
 * The reference: "thin blue/violet lines, and several are visible at once (a
 * Funky Bomb splitting into multiple sub-munitions, each drawing its own arc)".
 *
 * Several at once is the part that constrains the design. The sim deliberately
 * emits a cluster's sub-munition flights as one contiguous run of `shot` events
 * "so a client can only draw that if the events it is meant to play together
 * arrive together" (`packages/sim/src/detonation.ts`). This layer therefore
 * holds any number of arcs at the same time, each with its own head, and the
 * scene animates a whole run in parallel.
 *
 * Arcs survive until the next shot is fired, dimmed once the turn settles — the
 * original leaves them on screen too, and a fresh crater under a still-visible
 * arc is most of what a screenshot of this game is supposed to show.
 */

import type Phaser from 'phaser';

/** One flight, revealed a point at a time. */
interface Trail {
  readonly points: readonly number[];
  /** How many of `points` (as pairs) are currently drawn. */
  revealed: number;
  /** Still travelling — draws a bright head at the tip. */
  live: boolean;
}

/** Blue-violet, as the original draws it — not white. */
const LINE_COLOR = 0x7d8cff;
const LINE_CORE = 0xc3ccff;
const HEAD_COLOR = 0xfff2c0;

export class TrailLayer {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private trails: Trail[] = [];

  constructor(scene: Phaser.Scene, depth: number) {
    this.graphics = scene.add.graphics().setDepth(depth);
  }

  /** Drop everything — a new turn's shot is about to start. */
  clear(): void {
    this.trails = [];
    this.graphics.clear();
    this.graphics.setAlpha(1);
  }

  /** Register a flight and return its handle index. */
  add(points: readonly number[]): number {
    this.trails.push({ points, revealed: 1, live: true });
    return this.trails.length - 1;
  }

  reveal(index: number, pairs: number): void {
    const trail = this.trails[index];
    if (trail === undefined) return;
    trail.revealed = Math.min(pairs, trail.points.length / 2);
  }

  finish(index: number): void {
    const trail = this.trails[index];
    if (trail === undefined) return;
    trail.revealed = trail.points.length / 2;
    trail.live = false;
  }

  /** Turn resolved: leave the arcs up, but stop them competing with the crater. */
  settle(): void {
    for (const trail of this.trails) trail.live = false;
    this.graphics.setAlpha(0.5);
    this.draw();
  }

  destroy(): void {
    this.graphics.destroy();
  }

  draw(): void {
    const g = this.graphics;
    g.clear();

    for (const trail of this.trails) {
      if (trail.revealed < 2) continue;

      // Two strokes: a wide, dim violet body and a thin bright core. That is
      // what makes a one-pixel line read as bright against a black sky without
      // making it thick.
      for (const [width, color, alpha] of [
        [3, LINE_COLOR, 0.45],
        [1, LINE_CORE, 0.95],
      ] as const) {
        g.lineStyle(width, color, alpha);
        g.beginPath();
        g.moveTo(trail.points[0] ?? 0, trail.points[1] ?? 0);
        for (let i = 1; i < trail.revealed; i += 1) {
          g.lineTo(trail.points[i * 2] ?? 0, trail.points[i * 2 + 1] ?? 0);
        }
        g.strokePath();
      }
    }

    for (const trail of this.trails) {
      if (!trail.live || trail.revealed < 1) continue;
      const head = trail.revealed - 1;
      const x = trail.points[head * 2] ?? 0;
      const y = trail.points[head * 2 + 1] ?? 0;
      g.fillStyle(HEAD_COLOR, 0.35);
      g.fillCircle(x, y, 4);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(x, y, 2);
    }
  }
}
