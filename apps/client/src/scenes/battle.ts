/**
 * The battle scene: draws authoritative state, animates broadcast events.
 *
 * This file contains ZERO game rules. It never decides what a shot hits, how
 * much damage it does, or whose turn it is. It is handed a snapshot plus a list
 * of events and its only job is to make them look good.
 */

import Phaser from 'phaser';
import type { GameSnapshot, WireGameEvent } from '@scorched/protocol';

export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 720;

/** Tank colours, in the saturated EGA spirit of the original. */
export const TANK_COLORS: readonly number[] = [
  0x4fc3f7, // cyan
  0xef5350, // red
  0x66bb6a, // green
  0xffee58, // yellow
  0xab47bc, // magenta
  0xff9800, // orange
  0x26c6da, // teal
  0xe0e0e0, // white
];

const SKY_TOP = 0x0b1026;
const SKY_BOTTOM = 0x2b3a67;
const GROUND_TOP = 0x8d6e3f;
const GROUND_BOTTOM = 0x3a2a14;
const GROUND_EDGE = 0xc9a25c;

export interface BattleCallbacks {
  /** Fired when the animation queue drains, so the HUD can re-enable input. */
  onIdle(): void;
}

export class BattleScene extends Phaser.Scene {
  static readonly KEY = 'battle';

  private snapshot: GameSnapshot | null = null;
  private terrainTexture: Phaser.Textures.CanvasTexture | null = null;
  private terrainImage: Phaser.GameObjects.Image | null = null;
  private tankLayer!: Phaser.GameObjects.Container;
  private effectLayer!: Phaser.GameObjects.Container;
  private trailGraphics!: Phaser.GameObjects.Graphics;
  private windArrow!: Phaser.GameObjects.Graphics;
  private callbacks: BattleCallbacks = { onIdle: () => {} };
  private animating = false;

  constructor() {
    super(BattleScene.KEY);
  }

  setCallbacks(callbacks: BattleCallbacks): void {
    this.callbacks = callbacks;
  }

  // Phaser calls this by name off the scene config; it is not declared on the
  // `Scene` base type, so it is not an `override`.
  create(): void {
    this.cameras.main.setBackgroundColor(SKY_BOTTOM);
    this.drawSky();

    this.trailGraphics = this.add.graphics();
    this.tankLayer = this.add.container(0, 0);
    this.effectLayer = this.add.container(0, 0);
    this.windArrow = this.add.graphics();

    if (this.snapshot !== null) this.render(this.snapshot);
  }

  /** Gradient sky, painted once into its own texture. */
  private drawSky(): void {
    const key = 'sky';
    if (!this.textures.exists(key)) {
      const texture = this.textures.createCanvas(key, 2, VIEW_HEIGHT);
      const context = texture?.getContext();
      if (texture !== null && context != null) {
        const gradient = context.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
        gradient.addColorStop(0, hex(SKY_TOP));
        gradient.addColorStop(1, hex(SKY_BOTTOM));
        context.fillStyle = gradient;
        context.fillRect(0, 0, 2, VIEW_HEIGHT);
        texture.refresh();
      }
    }
    this.add.image(0, 0, key).setOrigin(0, 0).setDisplaySize(VIEW_WIDTH, VIEW_HEIGHT).setDepth(-10);
  }

  /** Replace everything on screen with this authoritative snapshot. */
  render(snapshot: GameSnapshot): void {
    this.snapshot = snapshot;
    if (!this.scene.isActive()) return;

    this.redrawTerrain(snapshot);
    this.redrawTanks(snapshot);
    this.redrawWind(snapshot);
  }

  private redrawTerrain(snapshot: GameSnapshot): void {
    const { width, height, surface } = snapshot.terrain;
    const key = 'terrain';

    if (this.terrainTexture === null) {
      this.textures.remove(key);
      this.terrainTexture = this.textures.createCanvas(key, width, height);
    }
    const texture = this.terrainTexture;
    if (texture === null) return;

    const context = texture.getContext();
    if (context == null) return;

    context.clearRect(0, 0, width, height);

    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, hex(GROUND_TOP));
    gradient.addColorStop(1, hex(GROUND_BOTTOM));

    // One path for the whole ground silhouette: cheap, and gives a crisp
    // single-pixel crust line like the original's dithered terrain edge.
    context.beginPath();
    context.moveTo(0, height);
    for (let x = 0; x < width; x += 1) {
      context.lineTo(x, surface[x] ?? height);
    }
    context.lineTo(width, height);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();

    context.beginPath();
    for (let x = 0; x < width; x += 1) {
      const y = surface[x] ?? height;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = hex(GROUND_EDGE);
    context.lineWidth = 2;
    context.stroke();

    texture.refresh();

    if (this.terrainImage === null) {
      this.terrainImage = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(-5);
    }
  }

  private redrawTanks(snapshot: GameSnapshot): void {
    this.tankLayer.removeAll(true);

    snapshot.tanks.forEach((tank, index) => {
      if (!tank.alive) {
        const wreck = this.add.graphics();
        wreck.fillStyle(0x2a2a2a, 1);
        wreck.fillRect(tank.x - 9, tank.y - 5, 18, 5);
        this.tankLayer.add(wreck);
        return;
      }

      const color = TANK_COLORS[tank.colorIndex % TANK_COLORS.length] ?? 0xffffff;
      const graphics = this.add.graphics();

      // Hull
      graphics.fillStyle(color, 1);
      graphics.fillRect(tank.x - 11, tank.y - 7, 22, 7);
      // Turret
      graphics.fillStyle(darken(color, 0.75), 1);
      graphics.fillRect(tank.x - 5, tank.y - 12, 10, 5);
      // Barrel — points where the player is actually aiming.
      const radians = Phaser.Math.DegToRad(tank.angleDeg);
      const barrelLength = 18;
      graphics.lineStyle(3, darken(color, 0.6), 1);
      graphics.beginPath();
      graphics.moveTo(tank.x, tank.y - 10);
      graphics.lineTo(
        tank.x + Math.cos(radians) * barrelLength,
        tank.y - 10 - Math.sin(radians) * barrelLength,
      );
      graphics.strokePath();

      // Health pip above the tank.
      const healthWidth = 22;
      graphics.fillStyle(0x000000, 0.6);
      graphics.fillRect(tank.x - healthWidth / 2, tank.y - 24, healthWidth, 4);
      graphics.fillStyle(healthColor(tank.health), 1);
      graphics.fillRect(
        tank.x - healthWidth / 2,
        tank.y - 24,
        (healthWidth * Math.max(0, tank.health)) / 100,
        4,
      );

      if (index === snapshot.activeTank && snapshot.phase === 'aiming') {
        graphics.lineStyle(1, 0xffa41b, 0.9);
        graphics.strokeRect(tank.x - 14, tank.y - 16, 28, 18);
      }

      this.tankLayer.add(graphics);

      const label = this.add
        .text(tank.x, tank.y - 34, tank.name, {
          fontFamily: 'Courier New, monospace',
          fontSize: '11px',
          color: '#c9d3e6',
        })
        .setOrigin(0.5, 1);
      this.tankLayer.add(label);
    });
  }

  private redrawWind(snapshot: GameSnapshot): void {
    this.windArrow.clear();
    const centerX = VIEW_WIDTH / 2;
    const y = 34;
    const magnitude = Math.min(Math.abs(snapshot.wind), 10);
    const direction = snapshot.wind >= 0 ? 1 : -1;
    const length = 12 + magnitude * 9;

    this.windArrow.lineStyle(2, 0x9fb4d8, 0.85);
    this.windArrow.beginPath();
    this.windArrow.moveTo(centerX - (direction * length) / 2, y);
    this.windArrow.lineTo(centerX + (direction * length) / 2, y);
    this.windArrow.strokePath();

    const tipX = centerX + (direction * length) / 2;
    this.windArrow.fillStyle(0x9fb4d8, 0.85);
    this.windArrow.fillTriangle(tipX, y, tipX - direction * 8, y - 5, tipX - direction * 8, y + 5);
  }

  // -----------------------------------------------------------------------
  // Event playback
  // -----------------------------------------------------------------------

  /**
   * Animate a turn's events, then settle on the authoritative snapshot.
   * The snapshot is the truth; the animation is decoration on the way to it.
   */
  async playEvents(events: readonly WireGameEvent[], finalSnapshot: GameSnapshot): Promise<void> {
    this.animating = true;
    for (const event of events) {
      await this.playEvent(event);
    }
    this.render(finalSnapshot);
    this.animating = false;
    this.callbacks.onIdle();
  }

  get isAnimating(): boolean {
    return this.animating;
  }

  private async playEvent(event: WireGameEvent): Promise<void> {
    switch (event.type) {
      case 'shot':
        await this.animateShot(event.path);
        return;
      case 'explosion':
        await this.animateExplosion(event.x, event.y, event.radius);
        return;
      case 'dirt':
        await this.animateExplosion(event.x, event.y, event.radius, 0x8d6e3f);
        return;
      case 'damage':
      case 'death':
      case 'turn':
      case 'roundEnd':
      case 'gameOver':
        // Reflected by the snapshot render; no separate animation yet.
        return;
      default:
        return;
    }
  }

  private animateShot(path: readonly number[]): Promise<void> {
    return new Promise((resolve) => {
      const points = path.length / 2;
      if (points < 2) {
        resolve();
        return;
      }

      const shell = this.add.circle(path[0] ?? 0, path[1] ?? 0, 2.5, 0xffe082);
      this.effectLayer.add(shell);
      // Wipe the previous shot's trail — otherwise every arc ever fired stays
      // scrawled across the sky.
      this.trailGraphics.clear();
      this.trailGraphics.lineStyle(1.5, 0xffc46b, 0.75);
      this.trailGraphics.beginPath();
      this.trailGraphics.moveTo(path[0] ?? 0, path[1] ?? 0);

      let index = 1;
      // Pace the shell: a short lob snaps over in a fifth of a second, a long
      // mortar arc takes about three quarters. The original's shells are quick —
      // a slow shell makes every turn feel like waiting rather than playing.
      const frames = clamp(Math.ceil(points / 6), 12, 46);
      const stepsPerFrame = Math.max(1, Math.ceil(points / frames));

      const advance = (): void => {
        for (let i = 0; i < stepsPerFrame && index < points; i += 1, index += 1) {
          const x = path[index * 2] ?? 0;
          const y = path[index * 2 + 1] ?? 0;
          shell.setPosition(x, y);
          this.trailGraphics.lineTo(x, y);
        }
        this.trailGraphics.strokePath();
        this.trailGraphics.beginPath();
        this.trailGraphics.moveTo(shell.x, shell.y);

        if (index >= points) {
          shell.destroy();
          resolve();
          return;
        }
        this.time.delayedCall(16, advance);
      };

      advance();
    });
  }

  private animateExplosion(x: number, y: number, radius: number, tint = 0xffa41b): Promise<void> {
    return new Promise((resolve) => {
      const flash = this.add.circle(x, y, radius * 0.4, 0xffffff, 0.95);
      const fire = this.add.circle(x, y, radius * 0.25, tint, 0.9);
      this.effectLayer.add(flash);
      this.effectLayer.add(fire);

      this.tweens.add({
        targets: fire,
        radius,
        alpha: 0,
        duration: 340,
        ease: 'Quad.easeOut',
        onUpdate: (_tween, target: Phaser.GameObjects.Arc) => {
          target.setRadius(target.radius);
        },
      });

      this.tweens.add({
        targets: [flash, fire],
        scale: 2.4,
        alpha: 0,
        duration: 340,
        ease: 'Quad.easeOut',
        onComplete: () => {
          flash.destroy();
          fire.destroy();
          resolve();
        },
      });
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

function healthColor(health: number): number {
  if (health > 60) return 0x4caf50;
  if (health > 30) return 0xffa41b;
  return 0xe53935;
}
