/**
 * Detonation behaviour and the damage ledger.
 *
 * Two things are being defended here. First, that each detonation kind is
 * actually distinct — a roller that does not chase downhill and a cluster that
 * does not scatter are the same weapon with different names, and the shop is
 * then a list of prices rather than a set of choices. Second, that
 * `applyDamage` cannot be broken: it is the only writer of `tank.health` and the
 * only payer of bounties, so every way of cheating it is pinned down below.
 *
 * Where the behaviour depends on the shape of the ground, the test uses
 * `generateTerrain` rather than a hand-built ramp. A constant-grade ramp is a
 * case a roller cannot fail: it has no ties, no ripples and no local minima. A
 * ramp is why a `flowPath` that stopped at the first tie shipped at all, and
 * the size of that gap is measurable today — collapsing `SLOPE_WINDOW` to one
 * column takes a Heavy Roller's mean travel over 1050 generated shots from
 * 110 px to 52.
 */

import { describe, expect, it } from 'vitest';

import {
  blast,
  applyDamage,
  detonate,
  NAPALM_DECAY,
  TANK_DAMAGE_OFFSET,
  type DetonationEvent,
  type DetonationRules,
  type DetonationTarget,
} from '../src/detonation.ts';
import { hypot2 } from '../src/math.ts';
import { makeRng, restoreRng } from '../src/rng.ts';
import { simulateFlight } from '../src/physics.ts';
import {
  cloneTerrain,
  emptyTerrain,
  generateTerrain,
  PROBE_TANK_RADIUS,
  surfaceAt,
  TERRAIN_STYLES,
  type Terrain,
} from '../src/terrain.ts';
import { damageAtDistance, requireWeapon, WEAPONS, type WeaponDef } from '../src/weapons.ts';

const WIDTH = 480;
const HEIGHT = 320;

/** Matches DEFAULT_WORLD in game.ts — the numbers the real game plays with. */
const RULES: DetonationRules = { damageBounty: 20, killBounty: 5000 };

/**
 * Steepest column-to-column step blast-loosened dirt is allowed to hold, from
 * terrain.ts. Duplicated because it is not exported; `terrain.test.ts` owns the
 * question of whether craters obey it, and this file owns whether dirt weapons
 * do.
 */
const MAX_BLAST_SLOPE = 5;

/**
 * How tall a tank is, in pixels — `PROBE_TANK_RADIUS` is its hit circle, so the
 * hull spans twice that. Used as the bar for "cover you could hide behind",
 * which is what the dirt weapons' shop text sells.
 */
const TANK_HEIGHT = PROBE_TANK_RADIUS * 2;

function flatTerrain(surfaceY = 200): Terrain {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  terrain.surface.fill(surfaceY);
  return terrain;
}

/** Ground that falls away to the right. Screen Y grows down, so lower = bigger. */
function slopedTerrain(): Terrain {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  for (let x = 0; x < WIDTH; x += 1) terrain.surface[x] = 60 + Math.floor(x * 0.4);
  return terrain;
}

/** A V, bottoming out at x = 240. A roller dropped on either wall must find it. */
function valleyTerrain(): Terrain {
  const terrain = emptyTerrain(WIDTH, HEIGHT);
  for (let x = 0; x < WIDTH; x += 1) {
    terrain.surface[x] = 100 + Math.round(120 - Math.abs(x - 240) * 0.5);
  }
  return terrain;
}

function testTank(x: number, y: number, health = 100) {
  return { x, y, health, alive: true, money: 0, score: 0 };
}

function makeTarget(terrain: Terrain, tanks: DetonationTarget['tanks'] = []): DetonationTarget {
  return { terrain, tanks };
}

function fire(
  target: DetonationTarget,
  weaponId: string,
  x: number,
  y: number,
  shooter: number | null = null,
  seed = 1234,
): DetonationEvent[] {
  return detonate(target, requireWeapon(weaponId), x, y, shooter, makeRng(seed), RULES);
}

const explosions = (events: DetonationEvent[]) =>
  events.filter((event): event is Extract<DetonationEvent, { type: 'explosion' }> =>
    Boolean(event.type === 'explosion'),
  );
const dirtDrops = (events: DetonationEvent[]) =>
  events.filter((event): event is Extract<DetonationEvent, { type: 'dirt' }> =>
    Boolean(event.type === 'dirt'),
  );
const damages = (events: DetonationEvent[]) =>
  events.filter((event): event is Extract<DetonationEvent, { type: 'damage' }> =>
    Boolean(event.type === 'damage'),
  );
const arcs = (events: DetonationEvent[]) =>
  events.filter((event): event is Extract<DetonationEvent, { type: 'shot' }> =>
    Boolean(event.type === 'shot'),
  );

/** Steepest column-to-column step anywhere on the map. */
function steepestStep(terrain: Terrain): number {
  let worst = 0;
  for (let x = 0; x + 1 < terrain.width; x += 1) {
    const step = Math.abs((terrain.surface[x + 1] as number) - (terrain.surface[x] as number));
    if (step > worst) worst = step;
  }
  return worst;
}

/** How much lower the ground gets within `reach` columns of x. 0 means a dip. */
function descentNear(terrain: Terrain, x: number, reach: number): number {
  const here = surfaceAt(terrain, x);
  let best = 0;
  for (let k = -reach; k <= reach; k += 1) {
    const drop = surfaceAt(terrain, x + k) - here;
    if (drop > best) best = drop;
  }
  return best;
}

/**
 * Returns the first thing wrong with an event stream, or null. Written as a
 * scan rather than a wall of `expect` because the sweep test below runs it a
 * thousand times and an assertion per field would dominate the runtime.
 */
function eventProblem(events: readonly DetonationEvent[]): string | null {
  for (const event of events) {
    if (event.type === 'explosion' || event.type === 'dirt') {
      if (!Number.isFinite(event.x)) return `non-finite x in ${event.type}`;
      if (!Number.isFinite(event.y)) return `non-finite y in ${event.type}`;
      // @scorched/protocol requires a finite POSITIVE radius on the wire.
      if (!(event.radius > 0) || !Number.isFinite(event.radius)) {
        return `bad radius ${event.radius} in ${event.type}`;
      }
    }
    if (event.type === 'damage') {
      if (!Number.isInteger(event.amount) || event.amount < 0) return `bad amount ${event.amount}`;
      if (!Number.isInteger(event.healthAfter) || event.healthAfter < 0) {
        return `bad healthAfter ${event.healthAfter}`;
      }
    }
    if (event.type === 'shot') {
      // @scorched/protocol: tankIndex is a non-negative integer and every path
      // coordinate is finite. A sub-munition's arc crosses the same wire as the
      // shell's, so it has to satisfy the same schema.
      if (!Number.isInteger(event.tankIndex) || event.tankIndex < 0) {
        return `bad tankIndex ${event.tankIndex}`;
      }
      if (event.path.length < 4 || event.path.length % 2 !== 0) {
        return `bad path length ${event.path.length}`;
      }
      for (const value of event.path) {
        if (!Number.isFinite(value)) return `non-finite path coordinate ${value}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Each detonation kind does what it claims
// ---------------------------------------------------------------------------

describe('explode', () => {
  it('carves a crater and hurts whatever is standing in it', () => {
    const target = makeTarget(flatTerrain(), [testTank(200, 200)]);
    const events = fire(target, 'baby_nuke', 200, 200, null);

    expect(explosions(events)).toHaveLength(1);
    expect(surfaceAt(target.terrain, 200)).toBeGreaterThan(200); // ground blown downward
    expect(target.tanks[0]!.health).toBeLessThan(20); // a direct Baby Nuke is decisive
  });

  it('leaves a tank outside the blast radius untouched', () => {
    const target = makeTarget(flatTerrain(), [testTank(200, 200), testTank(400, 200)]);
    fire(target, 'baby_nuke', 200, 200, null);
    expect(target.tanks[1]!.health).toBe(100);
  });
});

describe('dirt', () => {
  it.each(['dirt_clod', 'dirt_ball', 'ton_of_dirt'])('%s raises the terrain', (id) => {
    const target = makeTarget(flatTerrain());
    const before = surfaceAt(target.terrain, 240);
    const events = fire(target, id, 240, 200);

    // Smaller Y is higher ground: the mound pushed the surface up.
    expect(surfaceAt(target.terrain, 240)).toBeLessThan(before);
    expect(dirtDrops(events)).toHaveLength(1);
    expect(damages(events)).toHaveLength(0);
  });

  it.each(['dirt_clod', 'dirt_ball', 'ton_of_dirt', 'liquid_dirt'])(
    '%s leaves a heap, not a tower',
    (id) => {
      const terrain = flatTerrain();
      fire(makeTarget(terrain), id, 240, 200);

      let rise = 0;
      let width = 0;
      for (let x = 0; x < WIDTH; x += 1) {
        const added = 200 - (terrain.surface[x] as number);
        if (added !== 0) width += 1;
        if (added > rise) rise = added;
      }

      expect(rise).toBeGreaterThan(8); // it did something
      // Not a spire. A cone of the largest volume in the table (Ton of Dirt,
      // 4100 square pixels) standing at the solid-dirt repose is 111 px tall,
      // which is the ceiling this has to clear; the eight stacked circular
      // mounds it replaced stood 136.
      expect(rise).toBeLessThan(120);
      // The anti-spire property, stated the way a player sees it: dirt stands
      // at its angle of repose, so a heap is about `2 / repose` times as wide
      // as it is tall. Measured here: 0.65 for all three solid weapons and 7.8
      // for Liquid Dirt. The stacked mounds gave 136 px across 35 columns —
      // 0.26 — and nothing in the suite noticed.
      expect(width).toBeGreaterThan(rise * 0.5);
      // And it never leaves a face steeper than blast-loosened dirt will hold.
      expect(steepestStep(terrain)).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
    },
  );

  // The property the shop text is actually selling — "a shovelful of cover",
  // "bury a tank", "drops a hill" — measured on ground that slopes, because
  // flat ground is the one case where a heap cannot run away from itself.
  //
  // Dirt laid SHALLOWER than the ground it lands on does not stand up: the
  // profile never catches the hill, so it films out downhill instead of piling.
  // At 2 px/column against a generator capped at 3, and with a pool rim that
  // continued the body at the body's own slope, a Dirt Clod spread its 900
  // square pixels over 115 columns of a 2 px/column grade and stood 8 px tall;
  // over the 200 generated shots below its shallowest pile was 11 px and its
  // widest 158 columns. A tank is 18 px tall. Eleven pixels of cover is a
  // doormat.
  it.each(['dirt_clod', 'dirt_ball', 'ton_of_dirt', 'liquid_dirt'])(
    '%s leaves cover a tank could hide behind, on ground that slopes',
    (id) => {
      const weapon = requireWeapon(id);
      const rises: number[] = [];
      const spreadRatios: number[] = [];

      for (const style of TERRAIN_STYLES) {
        for (let seed = 0; seed < 8; seed += 1) {
          const base = generateTerrain(
            { width: 1280, height: 720, style },
            makeRng(seed * 7919 + 13),
          );
          for (const column of [200, 480, 640, 800, 1080]) {
            const terrain = cloneTerrain(base);
            const start = Array.from(terrain.surface);
            detonate(
              makeTarget(terrain),
              weapon,
              column,
              surfaceAt(terrain, column),
              null,
              makeRng(3),
              RULES,
            );

            let peak = 0;
            let touched = 0;
            for (let x = 0; x < 1280; x += 1) {
              const added = (start[x] as number) - (terrain.surface[x] as number);
              if (added !== 0) touched += 1;
              if (added > peak) peak = added;
            }
            rises.push(peak);
            spreadRatios.push(touched / peak);
          }
        }
      }

      const lowest = Math.min(...rises);
      const flattest = Math.max(...spreadRatios);
      // Measured minimum over these 200 shots: 31 px for the Dirt Clod, 24 for
      // Liquid Dirt, 41 for the Dirt Ball, 67 for the Ton of Dirt.
      expect(lowest, `shallowest pile was ${lowest} px`).toBeGreaterThanOrEqual(TANK_HEIGHT);
      // And it is a pile rather than a film: columns touched per pixel of
      // height. A heap at repose `r` gives `2 / r`, so 0.66 for solid dirt and
      // 8 for the liquid; measured worst case over these shots is 1.3 and 9.7,
      // where the ground it landed on carried some of it away. Reverted to the
      // shallow repose and the no-op rim, the same shots reach 14.4 for the
      // Dirt Clod, 15.9 for the Dirt Ball and 14.6 for Liquid Dirt.
      const bar = weapon.detonation === 'liquid_dirt' ? 12 : 3;
      expect(flattest, `flattest pile spread ${flattest.toFixed(1)} columns per px`).toBeLessThan(
        bar,
      );
    },
  );

  it('buries rather than damages', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200)]);
    fire(target, 'ton_of_dirt', 240, 200, null);
    expect(target.tanks[0]!.health).toBe(100);
  });

  it('delivers more dirt the more it costs', () => {
    const poured = (id: string): number => {
      const terrain = flatTerrain();
      fire(makeTarget(terrain), id, 240, 200);
      let total = 0;
      for (let x = 0; x < WIDTH; x += 1) total += 200 - (terrain.surface[x] as number);
      return total;
    };
    expect(poured('dirt_ball')).toBeGreaterThan(poured('dirt_clod'));
    expect(poured('ton_of_dirt')).toBeGreaterThan(poured('dirt_ball'));
  });
});

describe('liquid dirt', () => {
  it('pours downhill, laying deposits along the slope', () => {
    const terrain = slopedTerrain();
    const before = Array.from(terrain.surface);
    const target = makeTarget(terrain);
    const weapon = requireWeapon('liquid_dirt');
    const events = fire(target, 'liquid_dirt', 120, surfaceAt(terrain, 120));

    const drops = dirtDrops(events);
    expect(drops).toHaveLength(weapon.flowSteps as number);

    // It ran downhill (to the right) rather than piling up where it landed.
    const xs = drops.map((drop) => drop.x);
    expect(Math.max(...xs)).toBeGreaterThan(120 + weapon.radius);
    expect(Math.min(...xs)).toBe(120);

    // All of it ended up on the map, and downhill of where the shell landed.
    // Not "every deposit column rose" — on a slope the dirt runs on past the
    // column it was poured onto, which is the entire point of the weapon.
    let added = 0;
    let addedUphill = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const gain = before[x]! - terrain.surface[x]!;
      expect(gain).toBeGreaterThanOrEqual(0); // it never took ground away
      added += gain;
      if (x < 120) addedUphill += gain;
    }
    expect(added).toBeGreaterThan((requireWeapon('liquid_dirt').dirtVolume as number) * 0.5);
    expect(addedUphill).toBe(0);
  });

  it('floods a crater level instead of capping it', () => {
    // The advertised use: a hole you fell into. On a full-size map so the Nuke
    // crater has room, because that is the shape the weapon exists for.
    const terrain = emptyTerrain(1280, 720);
    terrain.surface.fill(400);
    fire(makeTarget(terrain), 'nuke', 640, 400);

    const floor = surfaceAt(terrain, 640);
    expect(floor).toBeGreaterThan(500); // a genuine hole to fill

    fire(makeTarget(terrain), 'liquid_dirt', 640, floor);

    const filled = surfaceAt(terrain, 640);
    expect(filled).toBeLessThan(floor); // it went up
    // It fills; it does not overflow into a hill on top of the crater.
    expect(filled).toBeGreaterThanOrEqual(400);
    expect(steepestStep(terrain)).toBeLessThanOrEqual(MAX_BLAST_SLOPE);

    // A liquid lies flat. A cone of soil dropped into the same hole would peak
    // in the middle and fall away; the pool must not, over any stretch of it.
    const level = surfaceAt(terrain, 640);
    for (let x = 600; x <= 680; x += 1) {
      expect(Math.abs(surfaceAt(terrain, x) - level)).toBeLessThanOrEqual(10);
    }
    // And flatter than the same volume of solid dirt would lie.
    const heaped = emptyTerrain(1280, 720);
    heaped.surface.fill(400);
    fire(makeTarget(heaped), 'nuke', 640, 400);
    fire(makeTarget(heaped), 'dirt_ball', 640, surfaceAt(heaped, 640));
    const heapedLevel = surfaceAt(heaped, 640);
    const spanOf = (map: Terrain, mid: number): number => {
      let worst = 0;
      for (let x = 600; x <= 680; x += 1) {
        const gap = Math.abs(surfaceAt(map, x) - mid);
        if (gap > worst) worst = gap;
      }
      return worst;
    };
    expect(spanOf(terrain, level)).toBeLessThan(spanOf(heaped, heapedLevel));
  });

  it('cannot be stacked into a wall, however many shots go into one spot', () => {
    const terrain = flatTerrain();
    for (let shot = 0; shot < 6; shot += 1) {
      fire(makeTarget(terrain), 'liquid_dirt', 240, surfaceAt(terrain, 240), null, shot);
      expect(steepestStep(terrain)).toBeLessThanOrEqual(MAX_BLAST_SLOPE);
    }
    // Six shots of it spread out rather than going up: still no cliff, and the
    // pile is far wider than it is tall.
    let rise = 0;
    let width = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const added = 200 - (terrain.surface[x] as number);
      if (added !== 0) width += 1;
      if (added > rise) rise = added;
    }
    expect(width).toBeGreaterThan(rise * 1.5);
  });
});

// Dirt gets the same treatment as the roller: measured on maps the generator
// actually produces, not on a fixture built to make it look good. The failure
// this catches is the shop lying — a weapon that says it delivers 3200 square
// pixels of ground and, on a hillside, deposits six.
describe.each(['dirt_clod', 'dirt_ball', 'ton_of_dirt', 'liquid_dirt'])(
  '%s on generated terrain',
  (id) => {
    const weapon = requireWeapon(id);
    const declared = weapon.dirtVolume as number;

    it.each(TERRAIN_STYLES)('delivers the dirt it promises on %s, and leaves no cliff', (style) => {
      const ratios: number[] = [];

      for (let seed = 0; seed < 8; seed += 1) {
        const base = generateTerrain(
          { width: 1280, height: 720, style },
          makeRng(seed * 7919 + 13),
        );
        const before = steepestStep(base);

        for (const column of [200, 480, 640, 800, 1080]) {
          const terrain = cloneTerrain(base);
          const start = Array.from(terrain.surface);
          detonate(
            makeTarget(terrain),
            weapon,
            column,
            surfaceAt(terrain, column),
            null,
            makeRng(3),
            RULES,
          );

          let added = 0;
          for (let x = 0; x < 1280; x += 1) {
            added += (start[x] as number) - (terrain.surface[x] as number);
          }
          ratios.push(added / declared);

          expect(steepestStep(terrain)).toBeLessThanOrEqual(Math.max(before, MAX_BLAST_SLOPE));
        }
      }

      const sorted = [...ratios].sort((a, b) => a - b);
      expect(sorted[0]).toBeGreaterThan(0.7); // never swallowed by the terrain
      expect(sorted[sorted.length - 1]).toBeLessThan(1.1); // and never conjured from nowhere
    });
  },
);

describe('roller', () => {
  const ROLLERS = ['baby_roller', 'roller', 'heavy_roller'] as const;

  it('chases downhill and detonates where it settles', () => {
    const target = makeTarget(slopedTerrain());
    const events = fire(target, 'baby_roller', 100, surfaceAt(target.terrain, 100));
    const bangs = explosions(events);

    expect(bangs).toHaveLength(1);
    // rollDistance is 260, and a constant slope never gives it a reason to stop.
    expect(bangs[0]!.x).toBeGreaterThanOrEqual(100 + 200);
  });

  it('comes to rest at the bottom of a valley rather than running out its budget', () => {
    const target = makeTarget(valleyTerrain());
    const events = fire(target, 'baby_roller', 100, surfaceAt(target.terrain, 100));
    const bangs = explosions(events);

    expect(bangs).toHaveLength(1);
    // The valley floor is at 240; the roller had budget to reach 360.
    expect(Math.abs(bangs[0]!.x - 240)).toBeLessThanOrEqual(12);
  });

  it('rolls left when left is downhill', () => {
    const terrain = slopedTerrain();
    terrain.surface.reverse();
    const target = makeTarget(terrain);
    const events = fire(target, 'baby_roller', 380, surfaceAt(terrain, 380));
    expect(explosions(events)[0]!.x).toBeLessThan(380);
  });

  it('stays put on ground with nowhere to go', () => {
    const target = makeTarget(flatTerrain());
    const events = fire(target, 'heavy_roller', 240, 200);
    expect(explosions(events)[0]!.x).toBe(240);
  });

  it('is not pulled toward a drop it is not standing on', () => {
    // The downhill test integrates over 96 columns, and for a while that width
    // applied to a shell at rest as well as a moving one: level ground with a
    // drop anywhere in the window read as downhill. On a dead-flat plateau
    // ending in a cliff, a Heavy Roller dropped 100 px back from the edge sat
    // where it landed and one dropped 60 px back rolled off and crossed the
    // map — two shots on ground that looks identical, with nothing on screen to
    // say which you would get.
    //
    // The rule now is local: nothing at rest starts moving unless the ground
    // falls away under it, within one stride. So the transition happens at the
    // visible lip, and this measures exactly where.
    const plateau = (): Terrain => {
      const terrain = emptyTerrain(WIDTH, HEIGHT);
      // Dead flat to x = 300, then a cliff into a long descending run.
      for (let x = 0; x < WIDTH; x += 1) {
        terrain.surface[x] = x < 300 ? 120 : Math.min(HEIGHT - 1, 200 + (x - 300));
      }
      return terrain;
    };

    const restingX = (id: string, landing: number): number => {
      const terrain = plateau();
      const events = fire(makeTarget(terrain), id, landing, surfaceAt(terrain, landing));
      return (explosions(events)[0] as { x: number }).x;
    };

    // A Heavy Roller's stride is 12 px, a Baby Roller's 7 (radius / 3, clamped).
    for (const [id, stride] of [
      ['heavy_roller', 12],
      ['baby_roller', 7],
    ] as const) {
      // Anywhere on the flat table it stays exactly where it landed, however
      // close the edge gets — no invisible pull.
      for (const back of [200, 100, 60, 40, 20, stride + 1]) {
        expect(restingX(id, 300 - back), `${id} landed ${back} px back`).toBe(300 - back);
      }
      // Within one stride of the lip it goes over, and then keeps going: the
      // run past the cliff descends for hundreds of pixels.
      for (const back of [stride, Math.floor(stride / 2), 1]) {
        expect(restingX(id, 300 - back), `${id} landed ${back} px from the lip`).toBeGreaterThan(
          300 + requireWeapon(id).radius,
        );
      }
    }
  });

  it('stays on the map when it lands against the edge', () => {
    const target = makeTarget(slopedTerrain());
    const events = fire(target, 'heavy_roller', WIDTH - 3, surfaceAt(target.terrain, WIDTH - 3));
    for (const bang of explosions(events)) {
      expect(bang.x).toBeGreaterThanOrEqual(0);
      expect(bang.x).toBeLessThanOrEqual(WIDTH - 1);
    }
  });

  // The one that matters. A hand-built ramp is a case `flowPath` cannot fail:
  // it has no ties, no ripples and no local minima. Generated maps have all
  // three, which is why the numbers the bars below are set against are measured
  // here and nowhere else.
  describe.each(TERRAIN_STYLES)('on generated %s terrain', (style) => {
    const MAP_WIDTH = 1280;
    const MAP_HEIGHT = 720;
    const COLUMNS = [160, 320, 480, 640, 800, 960, 1120];
    const maps = Array.from({ length: 10 }, (_unused, seed) =>
      generateTerrain({ width: MAP_WIDTH, height: MAP_HEIGHT, style }, makeRng(seed * 7919 + 13)),
    );

    it.each(ROLLERS)('%s rolls when it lands on ground that slopes', (id) => {
      const weapon = requireWeapon(id);
      const travelled: number[] = [];

      for (const map of maps) {
        for (const column of COLUMNS) {
          // Only count shots that landed somewhere with real descent within
          // reach. A roller that lands in the bottom of a dip is supposed to
          // stay there — that is the same place it would have rolled to.
          if (descentNear(map, column, 60) <= 12) continue;
          // …and only where the ground under the shell itself slopes. A roller
          // sitting on a level shelf stays on it by design (see 'is not pulled
          // toward a drop it is not standing on'), so counting those shots here
          // would be asking the weapon to break its own rule. Four columns is
          // inside every roller's stride, so a shot that passes this filter is
          // one every roller in the table is allowed to move on.
          if (descentNear(map, column, 4) <= 0) continue;

          const terrain = cloneTerrain(map);
          const events = detonate(
            makeTarget(terrain),
            weapon,
            column,
            surfaceAt(terrain, column),
            null,
            makeRng(1),
            RULES,
          );
          travelled.push(Math.abs((explosions(events)[0] as { x: number }).x - column));
        }
      }

      expect(travelled.length).toBeGreaterThan(18); // the sample is real
      const sorted = [...travelled].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] as number;
      const stalled = travelled.filter((distance) => distance < weapon.radius).length;
      const wentNowhere = travelled.filter((distance) => distance === 0).length;

      // Measured worst case over these maps, across all five styles and all
      // three rollers: a median of 70 px, 23% travelling under one blast radius
      // and 10% not moving at all. The smallest sample any style/weapon pair
      // produces is 22 shots. The bars sit outside those with room for
      // terrain.ts to be retuned. Neutering `flowPath` so a roller detonates
      // where it lands fails all fifteen of these cases.
      expect(median).toBeGreaterThanOrEqual(30);
      expect(stalled / travelled.length).toBeLessThan(0.25);
      expect(wentNowhere / travelled.length).toBeLessThan(0.15);
    });

    it('rolls further the heavier it is', () => {
      const reach = (id: string): number => {
        let total = 0;
        for (const map of maps) {
          for (const column of COLUMNS) {
            const terrain = cloneTerrain(map);
            const events = detonate(
              makeTarget(terrain),
              requireWeapon(id),
              column,
              surfaceAt(terrain, column),
              null,
              makeRng(1),
              RULES,
            );
            total += Math.abs((explosions(events)[0] as { x: number }).x - column);
          }
        }
        return total;
      };
      expect(reach('heavy_roller')).toBeGreaterThan(reach('baby_roller'));
    });
  });
});

describe('leapfrog', () => {
  it('walks its explosions across the ground instead of stacking them', () => {
    const weapon = requireWeapon('leapfrog');
    const target = makeTarget(flatTerrain());
    const xs = explosions(fire(target, 'leapfrog', 140, 200)).map((bang) => bang.x);

    expect(xs).toHaveLength(weapon.hops as number);
    expect(new Set(xs).size).toBe(xs.length); // four bangs, four places

    // Fixed spacing, on level ground as much as on a slope. Spacing them by
    // fraction-of-path instead put all four on one pixel here.
    const gaps: number[] = [];
    for (let i = 1; i < xs.length; i += 1) gaps.push(Math.abs(xs[i]! - xs[i - 1]!));
    const expected = Math.round(weapon.radius * (weapon.hopSpacing as number));
    for (const gap of gaps) expect(gap).toBe(expected);
    // A hop shorter than the blast is a smear, not a march: at 0.6 the gap was
    // 18 px under a 30 px radius and the whole weapon moved 54 px — a 114 px
    // footprint against a Baby Nuke's 110.
    expect(expected).toBeGreaterThanOrEqual(weapon.radius);
    // Total footprint: four blasts spread over more ground than the biggest
    // single explosion at anything like this price covers. Baby Nuke: 110 px.
    const span = Math.max(...xs) - Math.min(...xs) + weapon.radius * 2;
    expect(span).toBeGreaterThan(2 * requireWeapon('baby_nuke').radius);
  });

  it('aims every hop at the ground as it was, not down the last crater', () => {
    // The bug this exists for: each hop used to measure the surface AFTER the
    // hop before it had carved a crater there, so hops two onward went off 30
    // to 60 px underground. A tank standing at the impact point took one damage
    // event out of four blasts and the whole event stream was `dmg 47` followed
    // by three silent bangs.
    //
    // Measured with the hops deliberately set to overlap as well as at the
    // shipped spacing, because at two radii apart a hop lands clear of the
    // crater before it and the defect is simply out of reach — it would come
    // straight back the day someone retuned `hopSpacing`. Aiming before
    // carving is a property of the code, so it is tested against the code.
    const shipped = requireWeapon('leapfrog');
    const overlapping: WeaponDef = { ...shipped, hopSpacing: 0.6 };

    for (const weapon of [shipped, overlapping]) {
      const label = `${weapon.hopSpacing as number} radii apart`;

      const flat = flatTerrain();
      const onFlat = detonate(makeTarget(flat), weapon, 140, 200, null, makeRng(1234), RULES);
      for (const bang of explosions(onFlat)) {
        expect(bang.y, `${label}: hop at x ${bang.x}`).toBe(200);
      }

      // And on ground the generator actually produces, where "the ground line"
      // is a different number in every column.
      const hill = generateTerrain(
        { width: 1280, height: 720, style: 'rolling' },
        makeRng(7919 + 13),
      );
      const before = Array.from(hill.surface);
      const onHill = detonate(
        makeTarget(cloneTerrain(hill)),
        weapon,
        640,
        surfaceAt(hill, 640),
        null,
        makeRng(1234),
        RULES,
      );
      for (const bang of explosions(onHill)) {
        expect(bang.y, `${label}: hop at x ${bang.x}`).toBe(before[bang.x] as number);
      }
    }

    // What that buys, measured: one tank standing at each landing point, and
    // every one of them takes a near-direct hit rather than the first taking
    // 47 and the rest nothing.
    const terrain = flatTerrain();
    const hopX = explosions(
      detonate(makeTarget(cloneTerrain(terrain)), shipped, 140, 200, null, makeRng(1234), RULES),
    ).map((bang) => bang.x);
    const tanks = hopX.map((x) => testTank(x, 200, 1_000_000));
    const events = detonate(
      makeTarget(terrain, tanks),
      shipped,
      140,
      200,
      null,
      makeRng(1234),
      RULES,
    );

    const dealt = tanks.map((_tank, index) =>
      damages(events)
        .filter((hit) => hit.tankIndex === index)
        .reduce((sum, hit) => sum + hit.amount, 0),
    );
    for (const [index, amount] of dealt.entries()) {
      expect(amount, `hop ${index} dealt ${amount}`).toBeGreaterThan(shipped.damage * 0.9);
    }
    expect(damages(events)).toHaveLength(shipped.hops as number);
  });

  it('leaves four craters a player can count, not one smear', () => {
    const terrain = flatTerrain();
    const xs = explosions(fire(makeTarget(terrain), 'leapfrog', 140, 200))
      .map((bang) => bang.x)
      .sort((a, b) => a - b);

    // Between every pair of craters the ground still stands well above both
    // floors: four bowls with rims, not a trench. Measured rim height: 44 px.
    for (let i = 1; i < xs.length; i += 1) {
      const floor = Math.min(surfaceAt(terrain, xs[i]!), surfaceAt(terrain, xs[i - 1]!));
      const between = surfaceAt(terrain, (xs[i]! + xs[i - 1]!) / 2);
      expect(floor - between, `rim between hop ${i - 1} and ${i}`).toBeGreaterThan(TANK_HEIGHT);
    }
  });

  it('emits an arc for every bounce so the client can draw the hop', () => {
    // `e2e/reference/README.md` on the original: several trajectory arcs
    // visible at once. A weapon that teleports between blast points cannot be
    // drawn that way, so the flight is part of what a detonation reports.
    const weapon = requireWeapon('leapfrog');
    const events = fire(makeTarget(flatTerrain()), 'leapfrog', 140, 200, 0);
    const bangs = explosions(events);
    const flights = arcs(events);

    expect(flights).toHaveLength((weapon.hops as number) - 1);
    for (const flight of flights) {
      expect(flight.tankIndex).toBe(0);
      expect(flight.weapon).toBe(weapon.id);
      expect(flight.path.length % 2).toBe(0);
      expect(flight.path.length / 2).toBeGreaterThanOrEqual(4);
      for (const value of flight.path) expect(Number.isFinite(value)).toBe(true);
    }

    // Each arc runs from the blast it left to the blast it lands in, and it is
    // an arc: it rises above the straight line between them.
    for (let i = 0; i < flights.length; i += 1) {
      const path = flights[i]!.path;
      expect([path[0], path[1]]).toEqual([bangs[i]!.x, bangs[i]!.y]);
      expect([path[path.length - 2], path[path.length - 1]]).toEqual([
        bangs[i + 1]!.x,
        bangs[i + 1]!.y,
      ]);
      const apex = Math.min(...path.filter((_v, index) => index % 2 === 1));
      expect(apex).toBeLessThan(Math.min(path[1] as number, path[path.length - 1] as number));
    }

    // Interleaved with the explosions, because a leapfrog is sequential: bang,
    // hop, bang. The client can play the stream straight through.
    expect(events.filter((event) => event.type === 'explosion' || event.type === 'shot')).toEqual([
      bangs[0],
      flights[0],
      bangs[1],
      flights[1],
      bangs[2],
      flights[2],
      bangs[3],
    ]);
  });

  it('hops downhill when the ground has an opinion', () => {
    const terrain = slopedTerrain();
    const ground = Array.from(terrain.surface);
    const target = makeTarget(terrain);
    const bangs = explosions(fire(target, 'leapfrog', 100, surfaceAt(terrain, 100)));
    for (let i = 1; i < bangs.length; i += 1) expect(bangs[i]!.x).toBeGreaterThan(bangs[i - 1]!.x);
    // …and every one of them on the hillside as it was before the first bang.
    for (const bang of bangs) expect(bang.y).toBe(ground[bang.x] as number);
  });

  it('picks a side from the seed when the ground is level', () => {
    const side = (seed: number): number => {
      const xs = explosions(fire(makeTarget(flatTerrain()), 'leapfrog', 240, 200, null, seed)).map(
        (bang) => bang.x,
      );
      return Math.sign((xs[1] as number) - (xs[0] as number));
    };
    const sides = [1, 2, 3, 4, 5, 6, 7, 8].map(side);
    expect(new Set(sides).size).toBe(2); // both directions occur
    expect(side(3)).toBe(side(3)); // and the same seed always picks the same one
  });

  it('bounces back off the edge of the world rather than piling into it', () => {
    const target = makeTarget(flatTerrain());
    const bangs = explosions(fire(target, 'leapfrog', WIDTH - 4, 200));
    for (const bang of bangs) {
      expect(bang.x).toBeGreaterThanOrEqual(0);
      expect(bang.x).toBeLessThanOrEqual(WIDTH - 1);
      expect(bang.y).toBe(200); // still on the ground line after turning round
    }
    expect(new Set(bangs.map((bang) => bang.x)).size).toBe(bangs.length);
  });
});

describe('cluster', () => {
  it.each(['mirv', 'funky_bomb'])(
    '%s produces one blast per sub-munition, plus the parent',
    (id) => {
      const target = makeTarget(flatTerrain());
      const weapon = requireWeapon(id);
      const events = fire(target, id, 240, 200);
      expect(explosions(events)).toHaveLength(1 + (weapon.clusterCount as number));
    },
  );

  it('scatters a Funky Bomb far wider than its own blast radius', () => {
    const target = makeTarget(flatTerrain());
    const weapon = requireWeapon('funky_bomb');
    const xs = explosions(fire(target, 'funky_bomb', 240, 200)).map((bang) => bang.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(weapon.radius * 6);
  });

  it('gives the Funky Bomb a wider spread than the MIRV', () => {
    const span = (id: string): number => {
      const xs = explosions(fire(makeTarget(flatTerrain()), id, 240, 200)).map((bang) => bang.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span('funky_bomb')).toBeGreaterThan(span('mirv'));
  });

  it('lands the whole MIRV salvo on the ground as it was, not down its own craters', () => {
    // Warheads arrive together. Carving each crater before aiming the next one
    // dropped every overlapping sub-munition a crater's depth below the target,
    // so a MIRV on a direct hit did less damage than a single Missile.
    const weapon = requireWeapon('mirv');
    const target = makeTarget(flatTerrain(), [testTank(240, 200, 1_000_000)]);
    const events = fire(target, 'mirv', 240, 200, null);

    const hits = damages(events);
    expect(hits.length).toBeGreaterThanOrEqual(3); // several warheads reach it
    const dealt = hits.reduce((sum, hit) => sum + hit.amount, 0);
    expect(dealt).toBeGreaterThan(weapon.damage * 2);

    // Every child detonated on the original ground line, not in a hole.
    for (const bang of explosions(events)) expect(bang.y).toBe(200);
  });

  it.each(['mirv', 'funky_bomb'])('%s gives every warhead its own arc to draw', (id) => {
    // The look `e2e/reference/README.md` singles out from the 1991 screenshots:
    // "a Funky Bomb splitting into multiple sub-munitions, each drawing its own
    // arc", several in the air at once. A detonation that only ever reported
    // circles could not be drawn that way at all, whatever the client did.
    const weapon = requireWeapon(id);
    const count = weapon.clusterCount as number;
    const events = fire(makeTarget(flatTerrain()), id, 240, 200, 0);
    const bangs = explosions(events);
    const flights = arcs(events);

    expect(flights).toHaveLength(count);

    // Parent blast, then every warhead's flight as ONE contiguous run, then the
    // warheads landing in the same order. Contiguous is the point: a client can
    // only put several arcs in the air at once if the events it should play
    // together arrive together.
    const drawable = events.filter((event) => event.type === 'explosion' || event.type === 'shot');
    expect(drawable).toEqual([bangs[0], ...flights, ...bangs.slice(1)]);

    for (let i = 0; i < count; i += 1) {
      const path = flights[i]!.path;
      expect(flights[i]!.tankIndex).toBe(0);
      expect(flights[i]!.weapon).toBe(weapon.id);
      expect(path.length / 2).toBeGreaterThanOrEqual(4);
      for (const value of path) expect(Number.isFinite(value)).toBe(true);
      // Thrown from the parent burst, landing where warhead i goes off.
      expect([path[0], path[1]]).toEqual([bangs[0]!.x, bangs[0]!.y]);
      expect([path[path.length - 2], path[path.length - 1]]).toEqual([
        bangs[i + 1]!.x,
        bangs[i + 1]!.y,
      ]);
    }

    // Warheads land on both sides of the burst, and no two arcs are the same
    // line — eight identical paths would draw as one.
    expect(new Set(flights.map((flight) => JSON.stringify(flight.path))).size).toBe(count);
  });

  it('keeps every sub-munition on the map', () => {
    for (const x of [2, 240, WIDTH - 3]) {
      const events = fire(makeTarget(flatTerrain()), 'funky_bomb', x, 200);
      for (const bang of explosions(events)) {
        expect(bang.x).toBeGreaterThanOrEqual(0);
        expect(bang.x).toBeLessThanOrEqual(WIDTH - 1);
      }
    }
  });
});

describe('napalm', () => {
  it('burns weaker with every pool, by exactly the decay factor', () => {
    // Measuring the raw damage sequence is not a test of the decay: each pool's
    // crater lowers the ground and pushes the next pool further from the tank,
    // which produces a decreasing sequence on its own. Replaying the shipped
    // path with the decay disabled gave [44, 16, 16] against [44, 13, 11] —
    // still decreasing, still ending lower than it started. So divide the
    // geometry back out and compare what is left against NAPALM_DECAY itself.
    expect(NAPALM_DECAY).toBeGreaterThan(0);
    expect(NAPALM_DECAY).toBeLessThan(1);

    const weapon = requireWeapon('hot_napalm');
    const tankX = 240;
    const tankY = 200;
    const target = makeTarget(flatTerrain(), [testTank(tankX, tankY, 1_000_000)]);
    const events = detonate(target, weapon, tankX, tankY, null, makeRng(7), RULES);

    const ratios: { pool: number; measured: number; expected: number; tolerance: number }[] = [];
    let pool = -1;
    let source: { x: number; y: number } | null = null;

    for (const event of events) {
      if (event.type === 'explosion') {
        pool += 1;
        source = { x: event.x, y: event.y };
      } else if (event.type === 'damage' && source !== null) {
        const distance = hypot2(tankX - source.x, tankY - TANK_DAMAGE_OFFSET - source.y);
        const undecayed = damageAtDistance(weapon, distance);
        expect(undecayed).toBeGreaterThan(0);
        let expectedScale = 1;
        for (let i = 0; i < pool; i += 1) expectedScale *= NAPALM_DECAY;
        ratios.push({
          pool,
          measured: event.amount / undecayed,
          expected: expectedScale,
          // `amount` is rounded to a whole point of health before it is
          // reported, which is worth half a point of slack either way.
          tolerance: 0.5 / undecayed + 1e-9,
        });
      }
    }

    expect(ratios.length).toBeGreaterThanOrEqual(3);
    expect(ratios[0]!.expected).toBe(1); // the splash burns at full strength
    for (const ratio of ratios) {
      expect(
        Math.abs(ratio.measured - ratio.expected),
        `pool ${ratio.pool}: burned at ${ratio.measured}, expected ${ratio.expected}`,
      ).toBeLessThanOrEqual(ratio.tolerance);
    }
    // And the last pool really is weaker, not merely within tolerance of it.
    expect(ratios[ratios.length - 1]!.expected).toBeLessThan(0.8);
  });

  it('flows downhill instead of pooling where it landed', () => {
    const target = makeTarget(slopedTerrain());
    const xs = explosions(fire(target, 'hot_napalm', 120, surfaceAt(target.terrain, 120))).map(
      (bang) => bang.x,
    );
    expect(Math.max(...xs)).toBeGreaterThan(120 + requireWeapon('hot_napalm').radius * 2);
  });

  it('spreads sideways into a puddle when there is nowhere to flow', () => {
    const target = makeTarget(flatTerrain());
    const xs = explosions(fire(target, 'hot_napalm', 240, 200)).map((bang) => bang.x);
    expect(Math.min(...xs)).toBeLessThan(240);
    expect(Math.max(...xs)).toBeGreaterThan(240);
  });

  it('burns without excavating', () => {
    const napalmed = makeTarget(flatTerrain());
    fire(napalmed, 'napalm', 240, 200);
    const burnDepth = surfaceAt(napalmed.terrain, 240) - 200;

    const shelled = makeTarget(flatTerrain());
    fire(shelled, 'missile', 240, 200);
    const blastDepth = surfaceAt(shelled.terrain, 240) - 200;

    expect(burnDepth).toBeGreaterThan(0);
    expect(burnDepth).toBeLessThan(blastDepth);
  });
});

describe('riot charges', () => {
  const shape = (id: string): { depth: number; width: number } => {
    const terrain = flatTerrain();
    fire(makeTarget(terrain), id, 240, 200);
    const touched: number[] = [];
    for (let x = 0; x < WIDTH; x += 1) if (terrain.surface[x] !== 200) touched.push(x);
    return {
      depth: surfaceAt(terrain, 240) - 200,
      width: Math.max(...touched) - Math.min(...touched),
    };
  };

  it('cuts a trench: wider and shallower than a bomb of the same size', () => {
    const trench = shape('riot_blast');
    const bomb = shape('baby_nuke'); // r55 vs the Riot Blast's r44

    expect(trench.depth).toBeGreaterThan(0);
    expect(trench.width).toBeGreaterThan(requireWeapon('riot_blast').radius * 4);
    expect(trench.width / trench.depth).toBeGreaterThan(bomb.width / bomb.depth);
  });

  it('hurts nobody, even at ground zero', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200)]);
    const events = fire(target, 'riot_blast', 240, 200, null);
    expect(damages(events)).toHaveLength(0);
    expect(target.tanks[0]!.health).toBe(100);
  });
});

describe('diggers', () => {
  const shaftDepth = (id: string, startY: number): number => {
    const terrain = flatTerrain(startY);
    fire(makeTarget(terrain), id, 240, startY);
    return surfaceAt(terrain, 240) - startY;
  };

  it.each(['baby_digger', 'sandhog'])('%s sinks a shaft as deep as it advertises', (id) => {
    // Two-sided, because a one-sided `deeper than digDepth` bound is satisfied
    // by any amount of overshoot: the previous stage arithmetic assumed a
    // crater was a circle when applyCrater cuts a parabola 1.5 radii deep, and
    // a Sandhog that declared 140 dug 211.
    const weapon = requireWeapon(id);
    const declared = weapon.digDepth as number;
    for (const startY of [100, 140]) {
      const depth = shaftDepth(id, startY);
      expect(depth).toBeGreaterThanOrEqual(declared);
      expect(depth).toBeLessThanOrEqual(declared + weapon.radius);
    }
  });

  it('sinks a shaft: deeper than it is wide, unlike any bowl', () => {
    // Measured as a ratio rather than in pixels, because the exact crater
    // profile (rim slumping and so on) belongs to terrain.ts and is allowed to
    // be retuned. What must stay true is the SHAPE: a digger tunnels, a bomb
    // scoops.
    const shape = (id: string): { depth: number; width: number } => {
      const terrain = flatTerrain(100);
      fire(makeTarget(terrain), id, 240, 100);
      const touched: number[] = [];
      for (let x = 0; x < WIDTH; x += 1) if (terrain.surface[x] !== 100) touched.push(x);
      return {
        depth: surfaceAt(terrain, 240) - 100,
        width: Math.max(...touched) - Math.min(...touched),
      };
    };

    const shaft = shape('sandhog');
    const bowl = shape('baby_nuke');

    expect(shaft.depth).toBeGreaterThan(shaft.width);
    expect(bowl.width).toBeGreaterThan(bowl.depth);
  });

  it('still detonates on contact', () => {
    const target = makeTarget(flatTerrain(100), [testTank(240, 100)]);
    fire(target, 'sandhog', 240, 100, null);
    expect(target.tanks[0]!.health).toBeLessThan(100);
  });

  it('never digs past the bottom of the world', () => {
    const terrain = flatTerrain(HEIGHT - 20);
    const target = makeTarget(terrain);
    fire(target, 'sandhog', 240, HEIGHT - 20);
    for (let x = 0; x < WIDTH; x += 1) {
      expect(terrain.surface[x]!).toBeLessThanOrEqual(HEIGHT);
      expect(terrain.surface[x]!).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// applyDamage — the only writer of tank.health
// ---------------------------------------------------------------------------

describe('applyDamage', () => {
  it('never drives health below zero, for any weapon at any range', () => {
    for (const weapon of WEAPONS) {
      for (let step = 0; step <= 12; step += 1) {
        const offset = (step / 6) * weapon.radius;
        const target = makeTarget(flatTerrain(), [testTank(240, 200, 1)]);
        detonate(target, weapon, 240 + offset, 200, null, makeRng(step), RULES);
        expect(target.tanks[0]!.health).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(target.tanks[0]!.health)).toBe(true);
      }
    }
  });

  it('pays only for the damage that actually landed', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200, 10), testTank(20, 200)]);
    const events = fire(target, 'nuke', 240, 200, 1);

    const dealt = damages(events)
      .filter((event) => event.tankIndex === 0)
      .reduce((sum, event) => sum + event.amount, 0);

    expect(dealt).toBe(10); // a 150-damage Nuke on a 10-health tank
    expect(target.tanks[1]!.score).toBe(10);
    expect(target.tanks[1]!.money).toBe(10 * RULES.damageBounty + RULES.killBounty);
  });

  it('pays the kill bounty exactly once and reports exactly one death', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200, 100), testTank(20, 200)]);
    const first = fire(target, 'nuke', 240, 200, 1);
    const moneyAfterKill = target.tanks[1]!.money;

    expect(first.filter((event) => event.type === 'death')).toHaveLength(1);
    expect(target.tanks[0]!.alive).toBe(false);

    // Shelling the corpse pays nothing and does not kill it a second time.
    const second = fire(target, 'nuke', 240, 200, 1);
    expect(second.filter((event) => event.type === 'death')).toHaveLength(0);
    expect(damages(second)).toHaveLength(0);
    expect(target.tanks[1]!.money).toBe(moneyAfterKill);
  });

  it('cannot kill a tank twice inside one multi-blast detonation', () => {
    // Hot Napalm lays eleven overlapping pools on the same spot.
    const target = makeTarget(flatTerrain(), [testTank(240, 200, 5), testTank(20, 200)]);
    const events = fire(target, 'hot_napalm', 240, 200, 1);

    expect(events.filter((event) => event.type === 'death')).toHaveLength(1);
    expect(target.tanks[1]!.money).toBe(5 * RULES.damageBounty + RULES.killBounty);
  });

  it('pays the shooter nothing for hurting itself', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200)]);
    fire(target, 'baby_nuke', 240, 200, 0);

    expect(target.tanks[0]!.health).toBeLessThan(100);
    expect(target.tanks[0]!.money).toBe(0);
    expect(target.tanks[0]!.score).toBe(0);
  });

  it('pays nothing for a self-inflicted death either', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200)]);
    const events = fire(target, 'nuke', 240, 200, 0);

    expect(target.tanks[0]!.alive).toBe(false);
    expect(events.filter((event) => event.type === 'death')).toHaveLength(1);
    expect(target.tanks[0]!.money).toBe(0);
  });

  it('ignores zero, negative, fractional-to-zero and non-finite amounts', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200), testTank(20, 200)]);
    const events: DetonationEvent[] = [];
    for (const amount of [0, -50, 0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      applyDamage(target, 0, amount, 1, RULES, events);
    }
    expect(events).toHaveLength(0);
    expect(target.tanks[0]!.health).toBe(100);
    expect(target.tanks[1]!.money).toBe(0);
  });

  it('pays no bounty for health a tank never had', () => {
    // A tank arriving here already below zero is a bug upstream, but it must
    // not become a cash machine: the ledger starts from zero, so the shooter is
    // paid for nothing and the tank simply dies.
    const target = makeTarget(flatTerrain(), [testTank(240, 200, -40), testTank(20, 200)]);
    const events: DetonationEvent[] = [];
    applyDamage(target, 0, 90, 1, RULES, events);

    expect(target.tanks[0]!.health).toBe(0);
    expect(target.tanks[0]!.alive).toBe(false);
    expect(damages(events).reduce((sum, event) => sum + event.amount, 0)).toBe(0);
    expect(target.tanks[1]!.score).toBe(0);
    expect(target.tanks[1]!.money).toBe(RULES.killBounty);
    expect(eventProblem(events)).toBeNull();
  });

  it('shrugs off an out-of-range tank index or shooter index', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200)]);
    const events: DetonationEvent[] = [];
    expect(() => applyDamage(target, 7, 10, 0, RULES, events)).not.toThrow();
    expect(() => applyDamage(target, -1, 10, 0, RULES, events)).not.toThrow();
    expect(() => applyDamage(target, 0, 10, 99, RULES, events)).not.toThrow();
    expect(target.tanks[0]!.health).toBe(90);
    expect(target.tanks[0]!.money).toBe(0);
  });

  it('keeps health integral so the determinism hash stays stable', () => {
    const target = makeTarget(flatTerrain(), [testTank(240, 200)]);
    const events: DetonationEvent[] = [];
    blast(target, requireWeapon('missile'), 251.3, 203.7, null, RULES, events, {
      damageScale: 0.37,
    });
    expect(Number.isInteger(target.tanks[0]!.health)).toBe(true);
    expect(target.tanks[0]!.health).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Determinism and robustness
// ---------------------------------------------------------------------------

describe('determinism', () => {
  /** Only these consult the RNG; the rest are pure functions of the terrain. */
  const SEEDED = ['funky_bomb', 'mirv', 'leapfrog'];

  it.each(SEEDED)('%s replays identically from the same seed', (id) => {
    const run = (seed: number): string => {
      const target = makeTarget(slopedTerrain(), [testTank(220, surfaceAt(slopedTerrain(), 220))]);
      return JSON.stringify(
        detonate(
          target,
          requireWeapon(id),
          200,
          surfaceAt(target.terrain, 200),
          0,
          makeRng(seed),
          RULES,
        ),
      );
    };
    expect(run(9091)).toBe(run(9091));
  });

  it.each(['funky_bomb', 'mirv'])('%s scatters differently for a different seed', (id) => {
    const scatter = (seed: number): number[] =>
      explosions(fire(makeTarget(flatTerrain()), id, 240, 200, null, seed)).map((bang) => bang.x);
    expect(scatter(1)).not.toEqual(scatter(2));
  });

  it('leaves identical terrain for identical inputs', () => {
    const dig = (): number[] => {
      const target = makeTarget(valleyTerrain(), []);
      detonate(target, requireWeapon('mirv'), 200, 200, null, makeRng(55), RULES);
      return Array.from(target.terrain.surface);
    };
    expect(dig()).toEqual(dig());
  });

  it('resumes mid-stream from a saved RNG state and fires the same volley', () => {
    // `game.ts` runs the whole match off one stream, saving and restoring it
    // around every shot, so "same seed" is not enough — a detonation has to be
    // reproducible from a state picked up in the middle.
    const source = makeRng(9091);
    for (let i = 0; i < 5; i += 1) source.nextU32();
    const saved = source.save();

    const run = (): string =>
      JSON.stringify(
        detonate(
          makeTarget(flatTerrain()),
          requireWeapon('funky_bomb'),
          240,
          200,
          null,
          restoreRng(saved),
          RULES,
        ),
      );
    expect(run()).toBe(run());
    // …and it really did consume randomness, so the comparison means something.
    const fresh = makeRng(9091);
    expect(
      JSON.stringify(
        detonate(
          makeTarget(flatTerrain()),
          requireWeapon('funky_bomb'),
          240,
          200,
          null,
          fresh,
          RULES,
        ),
      ),
    ).not.toBe(run());
  });
});

describe('the whole arsenal, fired at every angle', () => {
  it('never throws and never produces a malformed event or terrain', () => {
    const base = generateTerrain({ width: WIDTH, height: HEIGHT, style: 'mountains' }, makeRng(21));
    const muzzle = { x: 60, y: surfaceAt(base, 60) - 12 };

    for (const weapon of WEAPONS) {
      for (let angleDeg = 0; angleDeg <= 180; angleDeg += 10) {
        for (const power of [30, 70, 100]) {
          const terrain = cloneTerrain(base);
          const tanks = [
            testTank(60, surfaceAt(terrain, 60)),
            testTank(240, surfaceAt(terrain, 240)),
            testTank(430, surfaceAt(terrain, 430)),
          ];
          const target = makeTarget(terrain, tanks);

          const shot = simulateFlight(
            { x: muzzle.x, y: muzzle.y, angleDeg, power },
            { terrain, wind: 6 },
          );

          let events: DetonationEvent[] = [];
          expect(() => {
            events = detonate(
              target,
              weapon,
              shot.impact.x,
              shot.impact.y,
              0,
              makeRng(angleDeg * 31 + power),
              RULES,
            );
          }).not.toThrow();

          expect(eventProblem(events)).toBeNull();

          for (let x = 0; x < WIDTH; x += 1) {
            const y = terrain.surface[x] as number;
            if (y < 0 || y > HEIGHT) {
              throw new Error(
                `${weapon.id} @${angleDeg}/${power}: column ${x} left the world (${y})`,
              );
            }
            if (!Number.isInteger(y)) {
              throw new Error(`${weapon.id} @${angleDeg}/${power}: column ${x} is not integral`);
            }
          }
          for (const tank of tanks) {
            if (tank.health < 0 || tank.health > 100 || !Number.isFinite(tank.health)) {
              throw new Error(`${weapon.id} @${angleDeg}/${power}: health ${tank.health}`);
            }
            if (tank.money < 0) throw new Error(`${weapon.id}: negative money`);
          }
        }
      }
    }
  });

  it('refuses a non-finite impact point instead of corrupting the terrain', () => {
    const terrain = flatTerrain();
    const target = makeTarget(terrain, [testTank(240, 200)]);
    for (const [x, y] of [
      [Number.NaN, 200],
      [240, Number.NaN],
      [Number.POSITIVE_INFINITY, 200],
    ] as const) {
      expect(fire(target, 'nuke', x, y, null)).toEqual([]);
    }
    expect(Array.from(terrain.surface)).toEqual(new Array(WIDTH).fill(200));
    expect(target.tanks[0]!.health).toBe(100);
  });

  it('clamps an off-map impact back onto the battlefield', () => {
    for (const x of [-500, WIDTH + 500]) {
      const target = makeTarget(flatTerrain());
      const events = fire(target, 'funky_bomb', x, 200, null);
      expect(eventProblem(events)).toBeNull();
      for (const bang of explosions(events)) {
        expect(bang.x).toBeGreaterThanOrEqual(0);
        expect(bang.x).toBeLessThanOrEqual(WIDTH - 1);
      }
    }
  });
});
