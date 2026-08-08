# Scorched Earth (web)

An open-source multiplayer remake of [Scorched Earth](<https://en.wikipedia.org/wiki/Scorched_Earth_(video_game)>),
the 1991 DOS artillery game — destructible terrain, ballistics with wind, a deep
arsenal, a between-rounds armoury, and turn-based multiplayer that survives a
dropped connection.

Runs entirely on Cloudflare Workers: one Durable Object per match, WebSocket
Hibernation so idle rooms cost nothing, and the built client served as static
assets. The whole stack runs locally under `wrangler dev` with no cloud account.

## Quick start

Requires Node 22 and pnpm 11+.

```bash
pnpm install
pnpm dev
```

Then open http://127.0.0.1:8787, click **Create room**, and share the four-letter
code with someone else (or a second browser window).

## How it is put together

The interesting decision is that **the simulation is one pure, deterministic
module shared by the server and the client**.

- `packages/sim` has no dependencies, touches no DOM or platform API, and draws
  every random number from a seeded PRNG. Given the same inputs and seed it
  produces byte-identical results on any JavaScript engine.
- The **server is authoritative**. Clients send inputs — angle, power, weapon,
  fire — and the Durable Object runs the sim and broadcasts what happened.
- Clients replay the same sim to animate. Nobody has to trust anyone's arithmetic.

That is not architecture for its own sake. It is what lets the end-to-end suite
predict a shot locally, fire it for real through two browsers, and assert that
the resulting heightmap matches column for column.

```
packages/
  sim/        pure deterministic engine — terrain, physics, weapons, turns, economy
  protocol/   Zod schemas for every WebSocket message, validated on both ends
  config/     shared TypeScript config
apps/
  client/     Phaser 3 rendering + plain-DOM menus. No game rules.
  server/     Cloudflare Worker + GameRoom Durable Object
e2e/          Playwright, against a real wrangler dev
```

## Commands

```bash
pnpm check        # supply-chain audit, lint, typecheck, unit + in-workerd tests
pnpm test:e2e     # Playwright end-to-end against wrangler dev
pnpm screenshot   # drive the game and save PNGs to e2e/screenshots/
pnpm build        # build the client
pnpm deploy       # wrangler deploy
```

## Testing

Tests run at every layer, and all of them run offline:

| Layer       | Tool                              | What it covers                                                                                                  |
| ----------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Sim         | Vitest                            | trajectories, terrain destruction, damage, turn machine, economy                                                |
| Invariants  | fast-check                        | same seed → same outcome, shots never tunnel, health never negative, the sim never throws on valid input        |
| Determinism | Vitest snapshots                  | a recorded match replays to the same state hash                                                                 |
| Server      | `@cloudflare/vitest-pool-workers` | the real Durable Object inside real workerd, including hibernation wake-up and hostile input                    |
| Protocol    | Vitest + Zod                      | every message round-trips; malformed and hostile frames are rejected                                            |
| End to end  | Playwright                        | two browsers, one room, a complete turn, an identical crater, a mid-game reconnect, and a rejected illegal move |

## Supply chain

This project treats its dependency tree as an attack surface, and the settings
are deliberately strict:

- **7-day quarantine** on newly published versions (`minimumReleaseAge: 10080`).
  Compromised releases are almost always yanked within days. If a version you
  want is too new, pick an older one or wait — the guard never comes down.
- **Install scripts blocked** except for `esbuild` and `workerd`, reviewed one at
  a time.
- **Exact version pins**, committed lockfile, CI installs with `--frozen-lockfile`.
- **Few dependencies on purpose.** The seeded RNG, the deterministic trig, and
  the supply-chain checker are all written in-repo rather than pulled in.

`scripts/verify-supply-chain.mjs` enforces every one of these and runs as part of
`pnpm check`, so the rules cannot be quietly relaxed later.

## Deploying your own

Fork it, then:

```bash
pnpm build
pnpm --filter @scorched/server exec wrangler deploy
```

You need a Cloudflare Workers Paid plan ($5/month) for Durable Objects. Hibernation
means a turn-based game consumes almost no duration between moves.

## Credits

Scorched Earth was created by Wendell Hicken in 1991. This is an independent
remake, not affiliated with or endorsed by the original author.

MIT licensed — see [LICENSE](LICENSE).
