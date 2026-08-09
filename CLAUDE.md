# Working in this repository

Orientation for anyone — human or agent — about to change something here.
`TECH_STACK.md` is the source of truth for technology choices; this file is about
how the code is actually laid out and the handful of rules that are easy to break
by accident.

## The one idea everything else follows from

The simulation is pure and deterministic, and it is the _same code_ on the server
and in the browser.

```
packages/sim  ──┬──►  apps/server   (Durable Object: authoritative, decides outcomes)
                └──►  apps/client   (Phaser: replays the same sim to render)
```

The server runs the sim and broadcasts what happened. The client replays it to
animate. Because it is literally the same module, a shot lands in the same pixel
in both places — and the e2e suite asserts exactly that by predicting a shot
locally and comparing the whole heightmap against the server's.

Break determinism and you have not caused a rendering glitch; you have caused two
players to disagree about who died.

## Layout

| Path                | What lives there                                                         | Never put here                  |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| `packages/sim`      | terrain, physics, weapons, detonation, turn machine, economy, seeded RNG | anything platform-specific      |
| `packages/protocol` | Zod schema for every WebSocket message, both directions                  | game rules                      |
| `packages/config`   | shared tsconfig                                                          | code                            |
| `apps/server`       | Worker routes + the `GameRoom` Durable Object                            | game rules (they belong in sim) |
| `apps/client`       | Phaser rendering, DOM menus, input, socket                               | game rules (they belong in sim) |
| `e2e`               | Playwright against a real `wrangler dev`                                 | unit tests                      |
| `scripts`           | dependency-free maintenance scripts                                      | build steps                     |

Inside `packages/sim`, files are split by _reason to change_:

- `rng.ts` — the only source of randomness in the whole game.
- `math.ts` — deterministic replacements for engine-defined `Math` functions.
- `terrain.ts` — heightmap generation, craters, mounds.
- `physics.ts` — projectile integration and swept collision.
- `weapons.ts` — the arsenal, as data.
- `detonation.ts` — what a weapon does on impact, and the only place that writes
  `tank.health`.
- `game.ts` — whose turn it is, when a round ends, who won.
- `ai.ts` — the computer players: what a bot fires, and what it buys.
- `economy.ts` — the shop.
- `serialize.ts` — the single crossing point to plain JSON.

## Rules that are enforced, not suggested

**`packages/sim` is pure.** ESLint bans `Math.random`, `Date.now`, `new Date()`,
and every platform global. If sim code seems to need the time or a random number,
it needs to take it as an argument or draw it from the seeded `Rng`.

**Engine-defined `Math` is banned in the sim too** — `sin`, `cos`, `tan`, `atan2`,
`pow`, `exp`, `log`, `hypot`, and the `**` operator. ECMAScript does not specify
their exact results, so two engines may differ in the last bit. Use `detSin`,
`detCos`, `detAtan2`, `hypot2` from `math.ts`. Adding a new one means building it
from `+ - * /`, `Math.sqrt`, and the exactly-specified integer helpers, then
unit-testing it against the engine's own `Math`.

**Supply-chain settings are not negotiable.** 7-day quarantine on new package
versions, install scripts blocked except a reviewed allowlist, exact pins,
committed lockfile. If a version you want is inside the quarantine window, pick an
older one or wait — never lower the guard. `scripts/verify-supply-chain.mjs` fails
the build if any of this drifts, and it runs as part of `pnpm check`.

**Adding a dependency is a last resort.** Minimal dependency count is a stated
feature. Write the small utility in-repo; that is why the RNG, the deterministic
trig and the supply-chain checker are all hand-written here.

## Commands

```bash
pnpm check        # supply-chain + lint + typecheck + all unit/workerd tests. The gate.
pnpm test:e2e     # Playwright against a real wrangler dev
pnpm screenshot   # drive the game and write PNGs to e2e/screenshots/
pnpm reference    # fetch original-game screenshots to e2e/reference/
pnpm dev          # wrangler dev
```

Nothing is done until `pnpm check` and `pnpm test:e2e` are both green.

## Looking at the game

You cannot form a visual opinion by reading the rendering code. Run
`pnpm screenshot`, then open the PNGs in `e2e/screenshots/` and actually look at
them. `e2e/reference/README.md` describes what the 1991 original looks like, and
`pnpm reference` fetches the real screenshots to compare against.

## Golden snapshots

`packages/sim/test/determinism.test.ts` snapshots the final state hash of a
recorded match. It exists to catch _accidental_ nondeterminism. When you change
the rules on purpose it will go red — regenerate with

```bash
pnpm --filter @scorched/sim exec vitest run -u
```

and say in the commit message that you did, and why. A snapshot update that
nobody mentions is indistinguishable from a determinism bug.

## The mistake this repo keeps making

Every review round so far has found the same defect, in a different file each
time: **a test that restates the constant it is supposed to police.**

```ts
// Cannot fail. `passes` is bounded by MAX_SLUMP_PASSES by construction.
expect(result.slumpPasses).toBeLessThanOrEqual(MAX_SLUMP_PASSES);

// Cannot fail. The budget is the thing under test.
expect(path.length).toBeLessThanOrEqual(PHYSICS.maxPathPoints + 1);

// Cannot fail. It restates the formula it is checking.
expect(muzzle.y).toBe(tank.y - DEFAULT_WORLD.tankRadius - 2);
```

Each of those was written in good faith, read as a guarantee, and defended
nothing. Mutating the constant left the whole suite green.

Two rules that actually work:

1. **Assert the behaviour, not the parameter.** Not "damage equals
   `SUDDEN_DEATH_STEP * 3`" but "overtime kills a full-health tank within four
   turns, and no single turn before the last takes more than half a tank".
2. **Prove it by mutation before you believe it.** Break the thing the test
   defends, watch the test fail, put it back. A test you have not seen fail is
   not evidence. When you add a load-bearing test, say in the commit message
   which mutation you ran and what died.

A golden snapshot is a change detector, not a specification. "Only
`determinism.test.ts` noticed" means the behaviour is untested.

## Two traps worth knowing about

**The Durable Object hibernates.** Anything held in an instance field is gone
after eviction. State that must survive goes in `ctx.storage` (SQLite) or on the
socket via `serializeAttachment`. The one deliberate exception is the rate-limit
buckets, which are in-memory precisely because persisting them would mean a
storage write per frame — see the comment on `consumeRateLimit`.

**Cosmetic messages must never cost a player a move.** `aim` frames are chatter
and are throttled on the client and given their own rate-limit bucket on the
server. They once shared a budget with `fire`, and the result was that a player
who adjusted their aim lost their turn silently. There is a regression test.
