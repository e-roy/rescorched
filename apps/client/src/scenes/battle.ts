/**
 * The battle scene: draws authoritative state, animates broadcast events.
 *
 * This file contains ZERO game rules. It never decides what a shot hits, how
 * much damage it does, or whose turn it is. It is handed a snapshot plus a list
 * of events and its only job is to make them look good.
 *
 * The one contract that matters: **animate the events, then settle on the
 * snapshot**. `playEvents` finishes by calling `render(finalSnapshot)`, and it
 * does so from a `finally`, so a thrown tween or a malformed event cannot leave
 * the picture disagreeing with the server about who is alive.
 *
 * What the scene owns is assembled from `../render/*`:
 *
 *   sky        a seeded starfield, so every client is under the same sky
 *   terrain    one flat saturated fill, a crisp crust, and crater scars
 *   tank       hull, turret, an aiming barrel, health, whose turn it is
 *   trails     several trajectory arcs at once, as the original draws them
 *   explosion  hard-edged stacked circles, sized off the event's radius
 *   particles  debris, sparks, flame, falling earth
 *
 * The weapon table is read from `@scorched/sim` for one purpose only: to decide
 * whether a blast is drawn as fire, as napalm or as thrown earth, and whether a
 * shell should be seen rolling before it goes off. The sim decided all of that
 * already; this is looking up how to draw what it decided.
 */

import Phaser from 'phaser';
import type { GameSnapshot, WireGameEvent } from '@scorched/protocol';
import { getWeapon } from '@scorched/sim';
import { lighten } from '../render/color.ts';
import {
  blastStyle,
  drawBlast,
  drawMuzzleFlash,
  type BlastKind,
  type BlastStyle,
} from '../render/explosion.ts';
import { ParticleField } from '../render/particles.ts';
import { roundPalette, type RoundPalette } from '../render/palette.ts';
import { ensureStarfield, SKY_BASE_COLOR, starfieldKey } from '../render/sky.ts';
import { addDecal, paintTerrain, type ScorchDecal } from '../render/terrain.ts';
import { drawTank, muzzlePoint, TANK_NAME_OFFSET_Y, tankColor } from '../render/tank.ts';
import { TrailLayer } from '../render/trails.ts';

export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 720;

/**
 * Re-exported, not moved: `ui.ts` and `ui/format.ts` colour their player chips
 * from this list and import it from here. The definition lives with the tank
 * drawing that uses it.
 */
export { TANK_COLORS } from '../render/tank.ts';

const DEPTH = {
  sky: -30,
  terrain: -20,
  trails: 5,
  tanks: 10,
  // Debris sits UNDER the fireball. Over it, the dark chunks thrown out of a
  // Nuke land on top of its white-hot core and read as dirt on the lens.
  particles: 18,
  effects: 20,
  flash: 38,
  frame: 40,
} as const;

/** A thin light-grey frame around the playfield, as the original has. */
const FRAME_COLOR = 0xa8adba;

export interface BattleCallbacks {
  /** Fired when the animation queue drains, so the HUD can re-enable input. */
  onIdle(): void;
}

export class BattleScene extends Phaser.Scene {
  static readonly KEY = 'battle';

  private snapshot: GameSnapshot | null = null;
  private callbacks: BattleCallbacks = { onIdle: () => {} };
  private animating = false;
  private ready = false;

  private skyImage: Phaser.GameObjects.Image | null = null;
  private skyKey = '';
  private terrainTexture: Phaser.Textures.CanvasTexture | null = null;
  private terrainImage: Phaser.GameObjects.Image | null = null;
  private terrainSignature = '';

  private tankLayer!: Phaser.GameObjects.Container;
  private effectLayer!: Phaser.GameObjects.Container;
  private frame!: Phaser.GameObjects.Graphics;
  private flash!: Phaser.GameObjects.Rectangle;
  private trails!: TrailLayer;
  private particles!: ParticleField;

  private palette: RoundPalette = roundPalette(0, 1);
  private roundKey = '';
  private decals: ScorchDecal[] = [];
  /** Bumped on every scar, so the terrain repaint check notices merges too. */
  private decalRevision = 0;

  /** Where the last animated shell came down — a roller starts from there. */
  private lastImpact: { x: number; y: number } | null = null;
  private firedThisTurn = false;

  private shakePeak = 0;
  private shakeEndsAt = 0;

  constructor() {
    super(BattleScene.KEY);
  }

  setCallbacks(callbacks: BattleCallbacks): void {
    this.callbacks = callbacks;
  }

  // Phaser calls this by name off the scene config; it is not declared on the
  // `Scene` base type, so it is not an `override`.
  create(): void {
    // Matching the sky means the gutters a camera shake opens up at the edges
    // are the same near-black as the sky itself, instead of a flashing border.
    this.cameras.main.setBackgroundColor(SKY_BASE_COLOR);

    this.trails = new TrailLayer(this, DEPTH.trails);
    this.tankLayer = this.add.container(0, 0).setDepth(DEPTH.tanks);
    this.effectLayer = this.add.container(0, 0).setDepth(DEPTH.effects);
    this.particles = new ParticleField(this, 0x1f2c3d, DEPTH.particles, VIEW_HEIGHT);

    this.flash = this.add
      .rectangle(0, 0, VIEW_WIDTH, VIEW_HEIGHT, 0xffffff)
      .setOrigin(0, 0)
      .setDepth(DEPTH.flash)
      .setAlpha(0);

    this.frame = this.add.graphics().setDepth(DEPTH.frame);

    this.ready = true;
    this.ensureSky(this.snapshot?.seed ?? 0);
    this.drawFrame();
    if (this.snapshot !== null) this.render(this.snapshot);
  }

  override update(_time: number, delta: number): void {
    this.particles.update(delta);
  }

  // -----------------------------------------------------------------------
  // Authoritative state
  // -----------------------------------------------------------------------

  /** Replace everything on screen with this authoritative snapshot. */
  render(snapshot: GameSnapshot): void {
    this.snapshot = snapshot;
    if (!this.ready) return;

    this.syncRound(snapshot);
    this.redrawTerrain(snapshot);
    this.redrawTanks(snapshot);
    this.drawFrame(snapshot);
    this.particles.setSurface(snapshot.terrain.surface, snapshot.terrain.height);
  }

  /**
   * A new round means new ground: a new palette and no scars.
   *
   * Keyed on `seed:round` rather than on `round` alone so that a fresh match
   * that happens to start at round 1 does not inherit the last match's craters.
   */
  private syncRound(snapshot: GameSnapshot): void {
    const key = `${snapshot.seed}:${snapshot.round}`;
    if (key !== this.roundKey) {
      this.roundKey = key;
      this.palette = roundPalette(snapshot.seed, snapshot.round);
      this.decals = [];
      this.decalRevision += 1;
      this.trails.clear();
      this.particles.clear();
    }
    this.ensureSky(snapshot.seed);
  }

  private ensureSky(seed: number): void {
    const expected = starfieldKey(seed, VIEW_WIDTH, VIEW_HEIGHT);
    if (this.skyKey === expected && this.skyImage !== null) return;

    // Drop the old image before the old texture goes, not after.
    this.skyImage?.destroy();
    this.skyImage = null;
    this.skyKey = ensureStarfield(this, seed, VIEW_WIDTH, VIEW_HEIGHT);
    this.skyImage = this.add
      .image(0, 0, this.skyKey)
      .setOrigin(0, 0)
      .setDisplaySize(VIEW_WIDTH, VIEW_HEIGHT)
      .setDepth(DEPTH.sky);
  }

  private redrawTerrain(snapshot: GameSnapshot): void {
    const { width, height, surface } = snapshot.terrain;
    const key = 'terrain';

    if (this.terrainTexture === null || this.terrainTexture.width !== width) {
      this.textures.remove(key);
      this.terrainTexture = this.textures.createCanvas(key, width, height);
      this.terrainImage?.destroy();
      this.terrainImage = null;
      this.terrainSignature = '';
    }
    const texture = this.terrainTexture;
    if (texture === null) return;

    // Repainting is the most expensive thing this scene does and a `state`
    // frame arrives for reasons that have nothing to do with the ground. Skip
    // the paint when neither the heightmap nor the scars have moved.
    const signature = `${this.roundKey}|${this.decalRevision}|${hashSurface(surface)}`;
    if (signature !== this.terrainSignature) {
      const context = texture.getContext();
      if (context == null) return;
      paintTerrain(context, {
        surface,
        width,
        height,
        palette: this.palette,
        decals: this.decals,
        seed: snapshot.seed,
      });
      texture.refresh();
      this.terrainSignature = signature;
    }

    if (this.terrainImage === null) {
      this.terrainImage = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(DEPTH.terrain);
    }
  }

  private redrawTanks(snapshot: GameSnapshot): void {
    this.tankLayer.removeAll(true);

    snapshot.tanks.forEach((tank, index) => {
      const graphics = this.add.graphics();
      drawTank(graphics, tank, {
        isActive: index === snapshot.activeTank && tank.alive && snapshot.phase !== 'gameover',
        isAiming: snapshot.phase === 'aiming',
      });
      this.tankLayer.add(graphics);

      const label = this.add
        .text(tank.x, tank.y + TANK_NAME_OFFSET_Y, tank.name, {
          fontFamily: 'Courier New, monospace',
          fontSize: '11px',
          // Lightened, not the raw player colour: the darker end of the palette
          // (red, magenta) is barely legible as small text on a black sky.
          color: tank.alive ? cssColor(lighten(tankColor(tank.colorIndex), 0.4)) : '#6b6b6b',
        })
        .setOrigin(0.5, 1);
      label.setShadow(1, 1, '#000000', 0, true, true);
      this.tankLayer.add(label);
    });
  }

  /**
   * The playfield frame, plus the wind gauge.
   *
   * The HUD carries the wind as a number; this is the felt version — a ruler of
   * ticks with an arrow whose length is the strength and whose direction is the
   * direction. It sits on the canvas because that is where the shell is.
   */
  private drawFrame(snapshot?: GameSnapshot): void {
    const g = this.frame;
    g.clear();

    g.lineStyle(2, FRAME_COLOR, 0.85);
    g.strokeRect(1, 1, VIEW_WIDTH - 2, VIEW_HEIGHT - 2);

    if (snapshot === undefined) return;

    const centerX = VIEW_WIDTH / 2;
    const arrowY = 24;
    const scaleY = 36;

    // The scale sits BELOW the arrow, not behind it. Drawn on the same line the
    // arrow occupies, half its ticks are covered by the arrow itself and the
    // gauge reads as a lopsided dashed line.
    for (let i = -5; i <= 5; i += 1) {
      const tickX = centerX + i * 13;
      const tall = i === 0 ? 6 : 3;
      g.lineStyle(i === 0 ? 2 : 1, i === 0 ? 0x8e9ab8 : 0x545c72, 0.9);
      g.beginPath();
      g.moveTo(tickX, scaleY - tall);
      g.lineTo(tickX, scaleY + tall);
      g.strokePath();
    }

    const magnitude = Math.min(Math.abs(snapshot.wind), 10);
    if (magnitude < 0.05) return;
    const direction = snapshot.wind >= 0 ? 1 : -1;
    const length = 10 + magnitude * 6.5;
    const tipX = centerX + direction * length;

    g.lineStyle(2, 0xd6dcf0, 0.95);
    g.beginPath();
    g.moveTo(centerX, arrowY);
    g.lineTo(tipX, arrowY);
    g.strokePath();
    g.fillStyle(0xd6dcf0, 0.95);
    g.fillTriangle(tipX + direction * 7, arrowY, tipX, arrowY - 5, tipX, arrowY + 5);
  }

  // -----------------------------------------------------------------------
  // Event playback
  // -----------------------------------------------------------------------

  get isAnimating(): boolean {
    return this.animating;
  }

  /**
   * Animate a turn's events, then settle on the authoritative snapshot.
   * The snapshot is the truth; the animation is decoration on the way to it.
   */
  async playEvents(events: readonly WireGameEvent[], finalSnapshot: GameSnapshot): Promise<void> {
    this.animating = true;
    this.trails.clear();
    this.lastImpact = null;
    this.firedThisTurn = false;

    try {
      let index = 0;
      // A hostile or buggy frame must not be able to hang the client on a turn
      // it can never finish, so playback is bounded by the event count.
      let guard = events.length + 1;
      while (index < events.length && guard > 0) {
        guard -= 1;
        index = await this.playFrom(events, index);
      }
    } finally {
      // The settle. Whatever the animation believed, this is what is true.
      this.render(finalSnapshot);
      this.trails.settle();
      this.animating = false;
      this.callbacks.onIdle();
    }
  }

  /**
   * Play the run of events starting at `start`, returning the next index.
   *
   * Runs, not single events, because the sim groups things it intends to be
   * seen together: a cluster's sub-munition arcs arrive as one contiguous block
   * of `shot` events precisely so a client can put several in the air at once,
   * and a salvo of explosions is a barrage rather than a queue.
   */
  private async playFrom(events: readonly WireGameEvent[], start: number): Promise<number> {
    const first = events[start];
    if (first === undefined) return start + 1;

    if (first.type === 'shot') {
      const shots: Extract<WireGameEvent, { type: 'shot' }>[] = [];
      let end = start;
      while (end < events.length) {
        const event = events[end];
        if (event === undefined || event.type !== 'shot') break;
        shots.push(event);
        end += 1;
      }
      await Promise.all(shots.map((shot) => this.animateShot(shot)));
      return end;
    }

    if (first.type === 'explosion' || first.type === 'dirt') {
      return this.playBlastRun(events, start);
    }

    this.playInstant(first);
    return start + 1;
  }

  /**
   * A barrage.
   *
   * `damage` and `death` are collected into the run rather than ending it,
   * because `blast()` in the sim emits them immediately after the explosion
   * that caused them — so a MIRV's events read explosion, damage, explosion,
   * damage… and treating damage as a boundary would serialise a salvo the sim
   * meant to be simultaneous. Each side effect inherits the delay of the blast
   * it belongs to, so the numbers still pop over the right bang.
   */
  private async playBlastRun(events: readonly WireGameEvent[], start: number): Promise<number> {
    interface Scheduled {
      readonly event: WireGameEvent;
      readonly slot: number;
    }

    const run: Scheduled[] = [];
    let end = start;
    let blasts = 0;

    while (end < events.length) {
      const event = events[end];
      if (event === undefined) break;
      if (event.type === 'explosion' || event.type === 'dirt') {
        run.push({ event, slot: blasts });
        blasts += 1;
        end += 1;
        continue;
      }
      if (event.type === 'damage' || event.type === 'death') {
        run.push({ event, slot: Math.max(0, blasts - 1) });
        end += 1;
        continue;
      }
      break;
    }

    // A pair of blasts should land like two punches; nine should land like a
    // burst. Spacing the whole run over roughly the same wall-clock budget does
    // both without a special case per weapon.
    const stagger = clamp(420 / Math.max(1, blasts), 55, 150);

    await Promise.all(
      run.map(async ({ event, slot }) => {
        await this.wait(slot * stagger);
        if (event.type === 'explosion' || event.type === 'dirt') {
          await this.playBlast(event);
        } else {
          await this.wait(90);
          this.playInstant(event);
        }
      }),
    );

    return end;
  }

  private playInstant(event: WireGameEvent): void {
    switch (event.type) {
      case 'damage':
        this.popDamage(event.tankIndex, event.amount);
        return;
      case 'death':
        this.playDeath(event.tankIndex);
        return;
      default:
        // turn / roundEnd / gameOver / timeout are all carried by the snapshot.
        return;
    }
  }

  // ------------------------------------------------------------------- shots

  private animateShot(event: Extract<WireGameEvent, { type: 'shot' }>): Promise<void> {
    const path = event.path;
    const points = Math.floor(path.length / 2);
    if (points < 2) return Promise.resolve();

    const handle = this.trails.add(path);
    this.lastImpact = {
      x: path[(points - 1) * 2] ?? 0,
      y: path[(points - 1) * 2 + 1] ?? 0,
    };

    // Only the shell that actually left a barrel gets a muzzle flash; the arcs
    // a cluster draws start in mid-air.
    if (!this.firedThisTurn) {
      this.firedThisTurn = true;
      this.muzzleFlash(event.tankIndex);
    }

    // Paced by how far the shell actually travels, not by how many points the
    // path happens to contain. The sim decimates long flights before they cross
    // the wire, so point count is a property of the encoding: a full-screen lob
    // and a lob over the next ridge can arrive with the same number of points
    // and would then take the same time to cross very different distances.
    const duration = clamp(pathLength(path) * 1.3, 260, 900);

    return new Promise((resolve) => {
      const state = { p: 0 };
      this.tweens.add({
        targets: state,
        p: 1,
        duration,
        ease: 'Linear',
        onUpdate: () => {
          this.trails.reveal(handle, Math.max(2, Math.round(state.p * points)));
          this.trails.draw();
        },
        onComplete: () => {
          this.trails.finish(handle);
          this.trails.draw();
          resolve();
        },
      });
    });
  }

  private muzzleFlash(tankIndex: number): void {
    const tank = this.snapshot?.tanks[tankIndex];
    if (tank === undefined) return;
    const { x, y } = muzzlePoint(tank);
    const graphics = this.add.graphics().setDepth(DEPTH.effects);
    this.effectLayer.add(graphics);
    const state = { t: 0 };
    this.tweens.add({
      targets: state,
      t: 1,
      duration: 130,
      onUpdate: () => drawMuzzleFlash(graphics, x, y, state.t),
      onComplete: () => graphics.destroy(),
    });
  }

  // ------------------------------------------------------------------ blasts

  private async playBlast(
    event: Extract<WireGameEvent, { type: 'explosion' | 'dirt' }>,
  ): Promise<void> {
    if (event.type === 'dirt') {
      const style = blastStyle('dirt', event.radius, this.palette);
      this.particles.spawnFallingDirt(
        event.x,
        event.y,
        Math.round(14 + event.radius * 0.7),
        event.radius,
        this.palette.dirt,
      );
      addDecal(this.decals, { x: event.x, radius: event.radius, burnt: false });
      this.decalRevision += 1;
      await this.spawnBlast(event.x, event.y, event.radius * 0.7, style);
      return;
    }

    const kind = this.blastKindFor(event.weapon);

    // A roller only tells the client where it stopped. The travel between the
    // shell's impact and that point is ours to show, and it is the whole reason
    // anyone buys the weapon.
    if (this.isRoller(event.weapon) && this.lastImpact !== null) {
      await this.animateRoll(this.lastImpact.x, event.x, event.radius);
    }

    const style = blastStyle(kind, event.radius, this.palette);
    // Every `explosion` leaves a burn, including a Riot Charge — it is drawn as
    // thrown earth rather than as fire because it does no damage, but it is
    // still a charge going off, and it still takes the ground away. Only a
    // `dirt` event, which adds ground, leaves clean earth.
    addDecal(this.decals, { x: event.x, radius: event.radius, burnt: true });
    this.decalRevision += 1;
    await this.spawnBlast(event.x, event.y, event.radius, style);
  }

  private spawnBlast(x: number, y: number, radius: number, style: BlastStyle): Promise<void> {
    const graphics = this.add.graphics().setDepth(DEPTH.effects);
    this.effectLayer.add(graphics);

    if (style.debris > 0) {
      this.particles.spawnDebris(x, y, style.debris, radius, style.debrisColors);
    }
    if (style.sparks > 0) this.particles.spawnSparks(x, y, style.sparks, radius);
    if (style.flame > 0) this.particles.spawnFlame(x, y, style.flame, radius);
    if (style.shake > 0) this.shakeCamera(style.shakeMs, style.shake);
    if (style.flash > 0) this.punchFlash(style.flash);

    return new Promise((resolve) => {
      const state = { t: 0 };
      this.tweens.add({
        targets: state,
        t: 1,
        duration: style.durationMs,
        ease: 'Linear',
        onUpdate: () => drawBlast(graphics, x, y, radius, state.t, style),
        onComplete: () => {
          graphics.destroy();
          resolve();
        },
      });
    });
  }

  /** A shell rolling downhill, following the ground it is rolling on. */
  private animateRoll(fromX: number, toX: number, radius: number): Promise<void> {
    const surface = this.snapshot?.terrain.surface ?? [];
    const distance = Math.abs(toX - fromX);
    if (distance < 10 || surface.length === 0) return Promise.resolve();

    const ballRadius = clamp(radius * 0.2, 3, 8);
    const duration = clamp(distance * 2.1, 200, 950);
    const graphics = this.add.graphics().setDepth(DEPTH.effects);
    this.effectLayer.add(graphics);
    let dustTick = 0;

    return new Promise((resolve) => {
      const state = { p: 0 };
      this.tweens.add({
        targets: state,
        p: 1,
        duration,
        ease: 'Sine.easeIn',
        onUpdate: () => {
          const x = fromX + (toX - fromX) * state.p;
          const ground = surface[clampInt(Math.round(x), 0, surface.length - 1)] ?? 0;
          const y = ground - ballRadius;

          graphics.clear();
          graphics.fillStyle(0x14141a, 1);
          graphics.fillCircle(x, y, ballRadius);
          graphics.fillStyle(0xff8c1a, 1);
          graphics.fillCircle(x - ballRadius * 0.3, y - ballRadius * 0.35, ballRadius * 0.45);

          dustTick += 1;
          if (dustTick % 4 === 0) {
            this.particles.spawnDust(x, ground, 2, this.palette.debris);
          }
        },
        onComplete: () => {
          graphics.destroy();
          resolve();
        },
      });
    });
  }

  /**
   * How a weapon's blast is drawn.
   *
   * Cosmetic classification only — the sim has already decided what happened
   * and said so in the event. An unknown id falls back to fire rather than
   * throwing: a client that is one build behind should render a strange weapon
   * plainly, not stop animating the turn.
   */
  private blastKindFor(weaponId: string): BlastKind {
    const detonation = getWeapon(weaponId)?.detonation;
    if (detonation === 'napalm') return 'napalm';
    // Riot weapons carry damage 0 and exist to move earth. Drawing them as a
    // fireball says "that hurt", and it did not.
    if (detonation === 'riot') return 'dirt';
    return 'fire';
  }

  private isRoller(weaponId: string): boolean {
    return getWeapon(weaponId)?.detonation === 'roller';
  }

  // ------------------------------------------------------------ consequences

  private popDamage(tankIndex: number, amount: number): void {
    const tank = this.snapshot?.tanks[tankIndex];
    if (tank === undefined || amount < 0.5) return;

    const text = this.add
      .text(tank.x, tank.y - 32, `-${Math.round(amount)}`, {
        fontFamily: 'Courier New, monospace',
        fontSize: '15px',
        color: '#ff7a5e',
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.effects);
    text.setShadow(1, 1, '#000000', 0, true, true);

    this.tweens.add({
      targets: text,
      y: tank.y - 58,
      alpha: 0,
      duration: 850,
      ease: 'Quad.easeOut',
      onComplete: () => text.destroy(),
    });
  }

  private playDeath(tankIndex: number): void {
    const tank = this.snapshot?.tanks[tankIndex];
    if (tank === undefined) return;
    const style = blastStyle('death', 34, this.palette);
    void this.spawnBlast(tank.x, tank.y - 8, 34, style);
  }

  // ------------------------------------------------------------------ camera

  /**
   * Shake, but let the biggest blast in a salvo win.
   *
   * Phaser's shake restarts from scratch on every call, so a Nuke followed 60 ms
   * later by its own sub-munition would have its shake replaced by the smaller
   * one — the more spectacular the weapon, the flatter it would feel.
   */
  private shakeCamera(durationMs: number, intensity: number): void {
    const now = this.time.now;
    if (now < this.shakeEndsAt && intensity <= this.shakePeak) return;
    this.shakePeak = intensity;
    this.shakeEndsAt = now + durationMs;
    this.cameras.main.shake(durationMs, intensity, true);
  }

  private punchFlash(alpha: number): void {
    this.tweens.killTweensOf(this.flash);
    this.flash.setAlpha(alpha);
    this.tweens.add({
      targets: this.flash,
      alpha: 0,
      duration: 240,
      ease: 'Quad.easeOut',
    });
  }

  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.time.delayedCall(ms, resolve);
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

/** Total travelled distance of a flat `[x, y, x, y, …]` polyline. */
function pathLength(path: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < path.length / 2; i += 1) {
    const dx = (path[i * 2] ?? 0) - (path[i * 2 - 2] ?? 0);
    const dy = (path[i * 2 + 1] ?? 0) - (path[i * 2 - 1] ?? 0);
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

/** Cheap change detector for the heightmap — far cheaper than a repaint. */
function hashSurface(surface: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const value of surface) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
