# Build Prompt — Scorched Earth Web

Read `TECH_STACK.md` first. It is the source of truth for every technology choice in
this project. Do not deviate from it or introduce alternatives.

I want you to build a web-based remake of Scorched Earth (the 1991 DOS artillery
game) as an open-source multiplayer web app, and it should be utterly perfect —
destructible pixel terrain with satisfying craters, projectile physics with gravity
and wind, a deep weapons arsenal, the between-rounds shop and economy, and turn-based
multiplayer that works flawlessly end to end.

The architecture is non-negotiable:

- A pure, deterministic simulation package (`packages/sim`) shared by client and
  server — no DOM, no platform APIs, all randomness through the seeded RNG.
  `Math.random` and `Date.now` are banned there.
- The server is authoritative: clients send inputs (angle, power, weapon, fire);
  Cloudflare Durable Object game rooms run the sim via the WebSocket Hibernation API
  and broadcast results; clients replay the same sim to render.
- Every WebSocket message is defined and validated with Zod in `packages/protocol`.
- The Phaser 3 client renders and captures input only — zero game rules in it.
- The entire stack runs locally under `wrangler dev` with no cloud account.
- Supply-chain protection per `TECH_STACK.md` is mandatory: pnpm 11+ with
  `minimumReleaseAge: 10080` (a 7-day quarantine on newly published package versions),
  lifecycle scripts blocked except an explicitly reviewed allowlist, exact version
  pins, a committed lockfile installed with `--frozen-lockfile` in CI, and as few
  dependencies as possible — prefer writing small utilities in-repo over adding a
  package. No agent may ever weaken these settings (no `minimumReleaseAge: 0`, no
  `dangerouslyAllowAllBuilds`), even if a fresh package version seems needed — pick an
  older version or wait out the quarantine instead.

Begin by scaffolding the pnpm monorepo exactly as laid out in `TECH_STACK.md` —
workspace packages, configs, and the `pnpm check` / `pnpm test:e2e` scripts — and get
a minimal walking skeleton green (one passing test at every layer, client connects to
a Durable Object room under `wrangler dev`) before building out features.

Then fan out sub-agents and have each one tackle a single area individually so the game is
utterly perfect: terrain generation and destruction, ballistics, weapons and damage,
the turn state machine, the shop and economy, the Durable Object room, the protocol,
the Phaser rendering layer, and the lobby/menus UI. /loop on each item, and pair
every builder with a separate, ruthlessly harsh critic sub-agent:

- For gameplay and visual items, the critic compares the result side by side against
  the original Scorched Earth — screenshots and game feel — and only passes work that
  would wow a player who loved the original. If it doesn't, it keeps going. Visual
  verdicts MUST be based on actual captured screenshots of the running game, using the
  methods in TECH_STACK.md's "Agent visual verification" section (Playwright screenshot
  runs against `wrangler dev`, plus Chrome DevTools MCP if available) — never on
  reading the code and imagining the output.
- For every code item, the critic verifies the tests demanded by `TECH_STACK.md`
  actually exist and pass: Vitest unit tests on the sim; fast-check property tests
  (same seed → identical outcome, shots never tunnel through terrain, health never
  goes negative, the sim never throws on valid input); golden-file determinism
  snapshots; `@cloudflare/vitest-pool-workers` tests exercising the Durable Object
  inside real workerd, including hibernation wake-up and hostile/malformed messages;
  and Playwright e2e tests where two browser contexts join the same room, play a
  complete turn, and both observe the identical crater — plus a mid-game reconnect
  and a rejected illegal move.

Nothing is "done" until `pnpm check` and `pnpm test:e2e` pass green, and no critic
signs off on any item it isn't utterly wowed by — visually or in test coverage.
/loop until it's utterly perfect. Fan out sub-agents and ultracode.
