/**
 * Debris, embers and flame.
 *
 * A blast without thrown material is a coloured circle. This is what turns it
 * into something that happened to the ground.
 *
 * Deliberately not Phaser's particle emitter: a couple of hundred axis-aligned
 * squares drawn into one `Graphics` is cheaper than that many game objects, and
 * squares are what the original's chunky palette animation actually looks like.
 * Nothing here is simulated by the game — it is decoration with a lifetime.
 */

import type Phaser from 'phaser';
import { mix } from './color.ts';
import { VisualRng } from './rng.ts';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived / total. */
  age: number;
  life: number;
  size: number;
  color: number;
  /** Blended toward as the particle ages — embers cool, flame goes to smoke. */
  fadeTo: number;
  gravity: number;
  drag: number;
}

/** Above this the field stops accepting spawns rather than dropping frame rate. */
const MAX_PARTICLES = 1400;

export class ParticleField {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly particles: Particle[] = [];
  private readonly rng: VisualRng;
  /** Floor for debris, so chunks pile up on the ground instead of raining through it. */
  private surface: readonly number[] = [];
  private floor: number;

  constructor(scene: Phaser.Scene, seed: number, depth: number, floor: number) {
    this.graphics = scene.add.graphics().setDepth(depth);
    this.rng = new VisualRng(seed);
    this.floor = floor;
  }

  setSurface(surface: readonly number[], floor: number): void {
    this.surface = surface;
    this.floor = floor;
  }

  clear(): void {
    this.particles.length = 0;
    this.graphics.clear();
  }

  destroy(): void {
    this.graphics.destroy();
  }

  /** Earth and hot fragments thrown out of a crater. */
  spawnDebris(
    x: number,
    y: number,
    count: number,
    radius: number,
    colors: readonly number[],
  ): void {
    const speed = 40 + radius * 3.2;
    for (let i = 0; i < count; i += 1) {
      const angle = this.rng.range(-Math.PI, 0); // upward half-plane
      const power = this.rng.range(0.35, 1) * speed;
      this.push({
        x,
        y,
        vx: Math.cos(angle) * power,
        vy: Math.sin(angle) * power,
        age: 0,
        life: this.rng.range(0.45, 1.15),
        size: this.rng.int(1, radius > 45 ? 4 : 3),
        color: this.rng.pick(colors),
        fadeTo: 0x120b08,
        gravity: 340,
        drag: 0.86,
      });
    }
  }

  /** Sparks: faster, smaller, shorter-lived than debris, and they stay bright. */
  spawnSparks(x: number, y: number, count: number, radius: number): void {
    for (let i = 0; i < count; i += 1) {
      const angle = this.rng.range(0, Math.PI * 2);
      const power = this.rng.range(0.5, 1) * (90 + radius * 4);
      this.push({
        x,
        y,
        vx: Math.cos(angle) * power,
        vy: Math.sin(angle) * power,
        age: 0,
        life: this.rng.range(0.18, 0.42),
        size: 2,
        color: this.rng.pick([0xffffff, 0xffe27a, 0xffb02a]),
        fadeTo: 0xff3c00,
        gravity: 120,
        drag: 0.8,
      });
    }
  }

  /** Napalm: rises, flickers, cools to smoke. The one thing that goes UP. */
  spawnFlame(x: number, y: number, count: number, radius: number): void {
    for (let i = 0; i < count; i += 1) {
      this.push({
        x: x + this.rng.range(-radius, radius),
        y: y + this.rng.range(-radius * 0.3, radius * 0.2),
        vx: this.rng.range(-18, 18),
        vy: this.rng.range(-70, -22),
        age: 0,
        life: this.rng.range(0.5, 1.4),
        size: this.rng.int(2, 5),
        color: this.rng.pick([0xffe066, 0xff9a20, 0xff5a10, 0xffffff]),
        fadeTo: 0x2a1208,
        gravity: -26,
        drag: 0.93,
      });
    }
  }

  /** Earth falling out of the sky — dirt weapons, and only them. */
  spawnFallingDirt(x: number, y: number, count: number, radius: number, color: number): void {
    for (let i = 0; i < count; i += 1) {
      this.push({
        x: x + this.rng.range(-radius, radius),
        y: y - this.rng.range(radius * 1.5, radius * 5),
        vx: this.rng.range(-12, 12),
        vy: this.rng.range(90, 240),
        age: 0,
        life: this.rng.range(0.35, 0.8),
        size: this.rng.int(2, 4),
        color: this.rng.chance(0.75) ? color : mix(color, 0x000000, 0.35),
        fadeTo: color,
        gravity: 420,
        drag: 1,
      });
    }
  }

  /** Dust kicked up by a rolling shell. */
  spawnDust(x: number, y: number, count: number, color: number): void {
    for (let i = 0; i < count; i += 1) {
      this.push({
        x,
        y,
        vx: this.rng.range(-30, 30),
        vy: this.rng.range(-45, -8),
        age: 0,
        life: this.rng.range(0.25, 0.6),
        size: this.rng.int(1, 3),
        color,
        fadeTo: 0x1a1410,
        gravity: 90,
        drag: 0.88,
      });
    }
  }

  private push(particle: Particle): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push(particle);
  }

  update(deltaMs: number): void {
    const dt = Math.min(deltaMs, 50) / 1000;
    const list = this.particles;

    for (let i = list.length - 1; i >= 0; i -= 1) {
      const p = list[i];
      if (p === undefined) continue;

      p.age += dt;
      if (p.age >= p.life) {
        list.splice(i, 1);
        continue;
      }

      p.vy += p.gravity * dt;
      // Per-second drag applied per-frame: `Math.pow` would be the honest form,
      // but a linear approximation over a 16 ms step is indistinguishable and
      // this runs a thousand times a frame.
      const drag = 1 - (1 - p.drag) * dt * 60;
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Settle on the ground rather than sinking through it.
      const ground = this.groundAt(p.x);
      if (p.y > ground) {
        p.y = ground;
        p.vy = -p.vy * 0.25;
        p.vx *= 0.5;
        if (Math.abs(p.vy) < 12) {
          p.vy = 0;
          p.gravity = 0;
        }
      }
    }

    this.draw();
  }

  private groundAt(x: number): number {
    if (this.surface.length === 0) return this.floor;
    const index = Math.round(x);
    if (index < 0 || index >= this.surface.length) return this.floor;
    return this.surface[index] ?? this.floor;
  }

  private draw(): void {
    const g = this.graphics;
    g.clear();
    for (const p of this.particles) {
      const t = p.age / p.life;
      // Colour is what fades, not alpha: a hard little square that cools to
      // charcoal keeps its edge, and edges are the whole aesthetic here.
      g.fillStyle(mix(p.color, p.fadeTo, t * t), t > 0.8 ? (1 - t) / 0.2 : 1);
      g.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
  }
}
