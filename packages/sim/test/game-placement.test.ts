/**
 * Where the tanks start.
 *
 * The bar is not "somewhere on the ground". It is: nobody is sealed in, nobody
 * is perched on a cliff, every pair can shoot at every other pair, and nobody
 * begins the round looking down on everybody else. The first three are the
 * terrain module's `checkPlayability`, asked about the columns the real tanks
 * are standing on rather than a sampled grid. The fourth is this file's own.
 *
 * The sweep below is a slice of the 1000-match measurement quoted on
 * `MAX_SPAWN_ELEVATION_SPREAD` in `game.ts`, run on the same seeds, so the
 * numbers in that comment and the numbers here are the same numbers.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  elevationSpread,
  KNIFE_EDGE_DROP,
  MAX_SPAWN_ELEVATION_SPREAD,
  startNextRound,
  type GameState,
  type PlayerSeed,
  type Tank,
} from '../src/game.ts';
import {
  checkPlayability,
  PLAYABILITY_DEFAULTS,
  spawnBand,
  surfaceAt,
  TERRAIN_STYLES,
  type Terrain,
} from '../src/terrain.ts';
import { leaveShop } from '../src/economy.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const COUNTS = [2, 3, 4, 6, 8];
const SEEDS = 12;

const players = (count: number): PlayerSeed[] =>
  Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

/** How much the ground moves across a tank's own footprint. */
function footingDrop(terrain: Terrain, x: number): number {
  const reach = PLAYABILITY_DEFAULTS.footprint;
  let lowest = -Infinity;
  let highest = Infinity;
  for (let offset = -reach; offset <= reach; offset += 1) {
    const y = surfaceAt(terrain, x + offset);
    if (y > lowest) lowest = y;
    if (y < highest) highest = y;
  }
  return lowest - highest;
}

/**
 * The flattest placement that was available on this map, brute-forced over
 * every column of every slot rather than the ones `game.ts` sampled.
 *
 * This is the floor the height rule is measured against. Without it a spread
 * figure says nothing: 240 px is a scandal on a two-player map and the best
 * anybody could have done on an eight-player one.
 */
function flattestPossible(terrain: Terrain, count: number): number {
  const margin = Math.min(90, Math.floor(terrain.width / (count + 2)));
  const slotWidth = (terrain.width - margin * 2) / count;
  const points: { y: number; slot: number }[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const lo = Math.round(margin + slotWidth * slot + slotWidth * 0.2);
    const hi = Math.round(margin + slotWidth * slot + slotWidth * 0.8);
    for (let x = lo; x <= hi; x += 1) points.push({ y: surfaceAt(terrain, x), slot });
  }
  points.sort((a, b) => a.y - b.y || a.slot - b.slot);

  // Smallest window covering at least one candidate from every slot.
  const held = new Array<number>(count).fill(0);
  let covered = 0;
  let left = 0;
  let best = Infinity;
  for (let right = 0; right < points.length; right += 1) {
    const entering = points[right] as { y: number; slot: number };
    if (held[entering.slot] === 0) covered += 1;
    held[entering.slot] = (held[entering.slot] as number) + 1;
    while (covered === count) {
      best = Math.min(best, entering.y - (points[left] as { y: number }).y);
      const leaving = points[left] as { y: number; slot: number };
      held[leaving.slot] = (held[leaving.slot] as number) - 1;
      if (held[leaving.slot] === 0) covered -= 1;
      left += 1;
    }
  }
  return best;
}

const sweep = (): GameState[] => {
  const games: GameState[] = [];
  for (const style of TERRAIN_STYLES) {
    for (const count of COUNTS) {
      for (let seed = 0; seed < SEEDS; seed += 1) {
        games.push(
          createGame(
            {
              seed: `real-${style}-${count}-${seed}`,
              width: WIDTH,
              height: HEIGHT,
              terrainStyle: style,
            },
            players(count),
          ),
        );
      }
    }
  }
  return games;
};

describe('every tank starts somewhere it can fight from', () => {
  it('sits on the ground, in its own slot, inside the band terrain.ts checks', () => {
    const band = spawnBand(WIDTH);
    for (let count = 1; count <= 16; count += 1) {
      for (let seed = 0; seed < 6; seed += 1) {
        const state = createGame(
          { seed: `slots-${count}-${seed}`, width: WIDTH, height: HEIGHT },
          players(count),
        );
        const margin = Math.min(90, Math.floor(WIDTH / (count + 2)));
        const slotWidth = (WIDTH - margin * 2) / count;

        state.tanks.forEach((tank, index) => {
          expect(tank.y).toBe(surfaceAt(state.terrain, tank.x));
          // In its own slot: this is what keeps the tanks evenly spaced. A
          // placement free to wander to find footing is no longer fair.
          expect(tank.x).toBeGreaterThanOrEqual(
            Math.round(margin + slotWidth * index + slotWidth * 0.2) - 1,
          );
          expect(tank.x).toBeLessThanOrEqual(
            Math.round(margin + slotWidth * index + slotWidth * 0.8) + 1,
          );
          // And inside the window `terrain.ts` samples when it decides whether
          // a map is fightable at all.
          expect(tank.x).toBeGreaterThanOrEqual(band.lo);
          expect(tank.x).toBeLessThanOrEqual(band.hi);
        });
      }
    }
  }, 300_000);

  it("passes the terrain module's own check at the real tank columns", () => {
    // The check `game.ts` uses to accept a placement, run again from outside.
    // Anything but zero here is a round somebody cannot fight in — the whole
    // reason placement stopped being "even slots plus jitter".
    const complaints: string[] = [];
    const games = sweep();

    for (const state of games) {
      const columns = state.tanks.map((tank) => tank.x);
      for (const issue of checkPlayability(state.terrain, { spawns: columns }).issues) {
        complaints.push(
          `${state.tanks.length}p seed ${state.seed}: ${issue.kind} @${issue.column}` +
            (issue.target === undefined ? '' : ` -> ${issue.target}`),
        );
      }
    }

    expect(games.length).toBe(TERRAIN_STYLES.length * COUNTS.length * SEEDS);
    expect(complaints, complaints.join('\n')).toEqual([]);
  }, 300_000);

  it('keeps the tanks off knife edges', () => {
    // `checkPlayability` refuses a genuine cliff at `maxFootingDrop` = 44 px
    // across the footprint, but on a fresh map that verdict cannot fire at all:
    // the generator caps slope at 3 px per column, so eleven columns can differ
    // by at most 33 and this sweep's worst tank measures 30. Passing that check
    // therefore proves nothing about footing, which is why placement carries
    // its own preference — ground that moves by more than the tank is tall.
    let perched = 0;
    let tanks = 0;
    let worst = 0;

    for (const state of sweep()) {
      for (const tank of state.tanks) {
        const drop = footingDrop(state.terrain, tank.x);
        tanks += 1;
        worst = Math.max(worst, drop);
        if (drop > KNIFE_EDGE_DROP) perched += 1;
      }
    }

    expect(tanks).toBeGreaterThan(1000);
    // A preference, not a veto: a slot with nothing flatter still gets its
    // tank, and both reachability and the height window outrank footing when
    // they collide. Measured over these 1380 tanks, 131 of them (9.5%) end up
    // on ground steeper than the rule would like; with the preference removed
    // entirely it is 302 (21.9%). The bound is the measurement plus room for
    // the terrain module to be retuned underneath it.
    expect(perched / tanks, `worst=${worst} perched=${perched}/${tanks}`).toBeLessThan(0.13);
    // Nothing is anywhere near the cliff the terrain module refuses — and this
    // one is the generator's doing, not placement's.
    expect(worst).toBeLessThan(PLAYABILITY_DEFAULTS.maxFootingDrop);
  }, 300_000);
});

describe('nobody starts the round above everybody else', () => {
  it('lands within the height slack of the flattest placement available', () => {
    const excess: number[] = [];
    for (const state of sweep()) {
      const columns = state.tanks.map((tank) => tank.x);
      const achieved = elevationSpread(state.terrain, columns);
      const floor = flattestPossible(state.terrain, state.tanks.length);
      expect(achieved).toBeGreaterThanOrEqual(floor);
      excess.push(achieved - floor);
    }
    const sorted = [...excess].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] as number;
    const worst = sorted[sorted.length - 1] as number;
    const report = `median=${median} p95=${p95} worst=${worst}`;

    // Excess over the per-map floor, not raw spread, is what these bounds are
    // stated in — it is the only figure that is about this file rather than
    // about whatever `terrain.ts` generated, so it survives the terrain module
    // being retuned underneath it.
    //
    // These are LITERALS on purpose. Writing the bound as
    // `MAX_SPAWN_ELEVATION_SPREAD` instead made the test restate the constant
    // it was meant to police: raising the slack raised the bound with it, and
    // the assertion held all the way up to 400 px of slack while the median
    // excess went from 5 px to 79. Measured over these 300 matches at the
    // shipped 140 px of slack: median 5, p95 76, worst 123. At 200 px of slack
    // the same sweep measures median 23, p95 127, worst 187 — so a widening
    // that would matter to a player trips every one of these.
    expect(median, report).toBeLessThanOrEqual(20);
    expect(p95, report).toBeLessThanOrEqual(100);
    expect(worst, report).toBeLessThanOrEqual(140);
    // The slack is real slack, though, and the constant is what hands it out.
    expect(worst).toBeLessThanOrEqual(MAX_SPAWN_ELEVATION_SPREAD);

    // And it does not simply take the flattest every time, which would make
    // every match on the same map identical. Measured at 191 of 300.
    expect(excess.filter((value) => value > 0).length).toBeGreaterThan(excess.length / 4);
  }, 300_000);

  it('is dramatically more level than even spacing plus jitter would be', () => {
    // The rule has to earn its cost. Two tanks is the case where there is real
    // choice on the map, so it is the case where a height rule can show up at
    // all — at eight tanks the slots are narrow and the terrain decides.
    const spreads: number[] = [];
    for (const style of TERRAIN_STYLES) {
      for (let seed = 0; seed < 40; seed += 1) {
        const state = createGame(
          { seed: `real-${style}-2-${seed}`, width: WIDTH, height: HEIGHT, terrainStyle: style },
          players(2),
        );
        spreads.push(
          elevationSpread(
            state.terrain,
            state.tanks.map((tank) => tank.x),
          ),
        );
      }
    }
    const sorted = [...spreads].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    // Measured at 38 px over these 200 two-player matches, against 107 px for
    // the identical search with the height window disabled — the pair of
    // numbers quoted in `game.ts`. The bound sits well below that and well
    // above the measurement.
    expect(median).toBeLessThan(90);
  }, 300_000);
});

describe('placement is deterministic and repeats every round', () => {
  it('gives the same columns for the same seed', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const a = createGame({ seed: `det-${seed}` }, players(4));
      const b = createGame({ seed: `det-${seed}` }, players(4));
      expect(a.tanks.map((tank) => tank.x)).toEqual(b.tanks.map((tank) => tank.x));
    }
  });

  it('gives different columns for different seeds', () => {
    const seen = new Set(
      Array.from({ length: 30 }, (_, seed) =>
        createGame({ seed: `vary-${seed}` }, players(2))
          .tanks.map((tank) => tank.x)
          .join(','),
      ),
    );
    expect(seen.size).toBeGreaterThan(25);
  });

  it('re-seats everyone just as carefully at the start of the next round', () => {
    // Round two gets fresh terrain, so it gets the whole placement search
    // again. A round that only checked the first map would be half-tested.
    for (let seed = 0; seed < 10; seed += 1) {
      let state: GameState = createGame(
        { seed: `round2-${seed}`, totalRounds: 3, width: WIDTH, height: HEIGHT },
        players(4),
      );
      state = { ...state, phase: 'shopping', pendingShoppers: state.tanks.map((t) => t.id) };
      for (const id of [...state.pendingShoppers]) state = leaveShop(state, id);

      const next = startNextRound(state).state;
      expect(next.round).toBe(2);
      const columns = next.tanks.map((tank: Tank) => tank.x);
      expect(checkPlayability(next.terrain, { spawns: columns }).issues).toEqual([]);
      for (const tank of next.tanks) {
        expect(tank.y).toBe(surfaceAt(next.terrain, tank.x));
      }
    }
  }, 300_000);
});
