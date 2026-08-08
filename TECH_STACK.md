# Tech Stack — Scorched Earth Web (open source, multiplayer)

Authoritative reference for all development. AI agents working on this project should
treat this document as the source of truth for technology choices. Do not introduce
alternatives to these choices without an explicit decision recorded here.

## Core principles (these drive every choice below)

1. **The simulation is pure and deterministic.** All game logic (physics, terrain,
   weapons, wind, damage) lives in a shared package with zero dependencies on the DOM,
   Phaser, or Cloudflare APIs. Same inputs + same seed → identical results everywhere.
   This is what makes the game testable by agents without a browser.
2. **The server is authoritative.** Clients send inputs (angle, power, weapon, fire).
   The Durable Object runs the simulation and broadcasts results. Clients replay the
   same sim for rendering. Never trust client-computed outcomes.
3. **Everything runs locally.** `wrangler dev` runs the real Workers runtime (workerd)
   on the developer's machine — no cloud account needed to develop or test.
4. **No randomness outside the seeded RNG.** `Math.random()` is banned in `packages/sim`
   (enforce via ESLint rule). All randomness flows through a seeded PRNG owned by the server.

## Language & tooling

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, `strict: true` | One language across client, server, sim, tests |
| Runtime (dev) | Node.js 22 LTS | Dev tooling only; production runtime is workerd |
| Package manager | pnpm 11+ (workspaces) | Monorepo. Pinned via `packageManager` field. Version 11+ required for the supply-chain defaults below |
| Bundler / dev server | Vite | Client build + HMR |
| Lint / format | ESLint (flat config) + Prettier | Add rule banning `Math.random` and `Date.now` in `packages/sim` |
| Schema validation | Zod | Single source of truth for all client↔server messages |

## Supply-chain security (non-negotiable)

Defense against npm supply-chain attacks. These settings live in `pnpm-workspace.yaml`
and MUST NOT be weakened, bypassed, or removed by any agent. In particular: never set
`minimumReleaseAge: 0`, never use `dangerouslyAllowAllBuilds`, and never install with
lifecycle scripts globally enabled.

```yaml
# pnpm-workspace.yaml
minimumReleaseAge: 10080      # 7 days (minutes) — newly published versions are
                              # quarantined for a week before pnpm will install them.
                              # Compromised releases are almost always yanked within days.
blockExoticSubdeps: true      # transitive deps must resolve from the registry —
                              # no git URLs or tarball URLs smuggled in
trustPolicy: no-downgrade     # refuse packages whose trust level dropped vs prior release
```

Additional rules:

- **Lifecycle scripts stay blocked** (pnpm 10+ default). Approve build scripts only for
  the explicit few that need them (expected: `workerd`, `esbuild`, Playwright's browser
  install) via `allowBuilds` / `onlyBuiltDependencies` — reviewed one by one, never blanket.
- **Exact version pins** (`save-exact=true` in `.npmrc`). No `^` or `~` ranges.
- **`pnpm-lock.yaml` is committed**; CI installs with `--frozen-lockfile`. A PR that
  changes the lockfile without a corresponding `package.json` change is rejected.
- **`pnpm audit` runs in CI** and fails the build on high/critical advisories.
- **Minimal dependency count is a feature.** Before adding any new dependency, prefer
  implementing in-repo (the seeded RNG is already in-repo for this reason). Every new
  dependency addition must be justified in the PR description.

## Monorepo layout

```
/
├── packages/
│   ├── sim/        # Pure deterministic game engine — NO platform dependencies
│   │   ├── physics (projectile integration, wind, gravity)
│   │   ├── terrain (heightmap generation + crater destruction)
│   │   ├── weapons (definitions, damage models)
│   │   ├── rng     (seeded PRNG, e.g. mulberry32/sfc32 — implemented in-repo)
│   │   └── game    (turn state machine, win conditions, economy/shop)
│   ├── protocol/   # Zod schemas + TS types for every WebSocket message
│   └── config/     # Shared tsconfig / eslint config
├── apps/
│   ├── client/     # Phaser 3 + Vite. Rendering & input ONLY — no game rules here
│   └── server/     # Cloudflare Worker + Durable Object game rooms
├── e2e/            # Playwright tests (run against `wrangler dev`)
└── .github/workflows/
```

## Client (`apps/client`)

| Concern | Choice | Notes |
|---|---|---|
| Rendering | Phaser 3 | Canvas/WebGL scenes, particles, tweens, input. Thin layer over `packages/sim` |
| Terrain rendering | Heightmap array from sim → drawn to a Phaser texture | Destruction = sim mutates heightmap, client redraws |
| Lobby / shop / menus UI | Plain HTML/CSS + TypeScript overlaid on the canvas | Deliberately NOT React — keeps bundle small and the surface simple for agents. Revisit only if UI complexity demands it |
| Networking | Native `WebSocket` API | Messages validated with `packages/protocol` Zod schemas on both ends |
| State | Sim state replayed from server-broadcast inputs | Client is a renderer of authoritative state |

## Server (`apps/server`)

| Concern | Choice | Notes |
|---|---|---|
| Platform | Cloudflare Workers (Paid plan, $5/mo) | Hard, predictable cost ceiling |
| Game rooms | Durable Objects (SQLite-backed) | One DO instance per match; holds room state |
| WebSockets | DO **WebSocket Hibernation API** | Mandatory — this is what keeps turn-based games nearly free. Use `state.acceptWebSocket()`, not the legacy `accept()` |
| Persistence | SQLite inside the Durable Object (`ctx.storage.sql`) | Match state, replays. No external DB at launch |
| Static hosting | Workers Static Assets | Serves the built Vite client; asset requests are unmetered |
| Matchmaking | Room codes first (create/join by code) | Public lobby list later via a singleton "lobby" DO |
| Auth | Anonymous session IDs (crypto-random, cookie) | No accounts at launch. If accounts later: revisit deliberately |
| Rate limiting / abuse | Per-IP limits in the Worker + Turnstile on room creation (later, if needed) | |
| Deploy tool | Wrangler CLI (`wrangler.jsonc`) | `pnpm deploy` → `wrangler deploy`. Forkers deploy their own instance the same way |

## Testing (the agent-facing surface — invest heavily here)

| Layer | Tool | What agents test |
|---|---|---|
| Unit: sim | Vitest | Physics trajectories, terrain destruction, damage, turn state machine, economy. Fast, pure, no mocks needed |
| Property-based | fast-check (with Vitest) | Invariants: same seed → identical outcome; shots never tunnel through terrain; health never negative; sim never throws for any valid input |
| Determinism | Vitest golden-file tests | Recorded input sequences → snapshot final state hash. Catches accidental nondeterminism |
| Unit/integration: server | Vitest + `@cloudflare/vitest-pool-workers` | Runs tests INSIDE workerd: Durable Object lifecycle, WebSocket message handling, hibernation wake-up, protocol validation |
| Protocol | Vitest + Zod | Every message type round-trips schema parse; malformed/hostile messages are rejected |
| E2E | Playwright (Chromium) | Full stack against `wrangler dev`: two browser contexts join one room, play a complete turn, both see the same crater. Also: reconnect mid-game, refuse illegal moves |
| Visual (optional, later) | Playwright screenshot snapshots | Terrain rendering regressions |

Test commands agents should rely on:

```
pnpm test          # all Vitest suites (sim, protocol, server-in-workerd)
pnpm test:e2e      # Playwright against a spawned wrangler dev
pnpm typecheck     # tsc --noEmit across workspace
pnpm lint          # eslint + prettier check
pnpm check         # all of the above — the gate for "done"
```

## Agent visual verification

How agents (builders and critics) are expected to LOOK at the game, not just test it:

1. **Playwright screenshots (primary, always available).** Write a script or test that
   launches Chromium against `wrangler dev`, drives the game to the state under review
   (a fired shot, a fresh crater, the shop screen), and saves PNGs to `e2e/screenshots/`.
   Agents then read the PNG files to visually inspect the result. Every visual-critic
   pass MUST be based on actual screenshots, never on reasoning about what the code
   "should" render. Keep the helper script in `e2e/screenshot.ts` so any agent can
   capture the current build in one command.
2. **Chrome DevTools MCP (interactive, if configured in the session).** Use it for live
   debugging: driving the page, reading console errors, and inspecting network/WebSocket
   traffic when something renders wrong. Prefer it for diagnosis; prefer Playwright
   scripts for repeatable evidence. If the MCP is not available in the session, fall
   back to path 1 — it covers everything needed.
3. **Reference comparison.** Critics compare captured screenshots against reference
   images of the original Scorched Earth (screenshots findable via web search; save
   copies to `e2e/reference/` once so comparisons are stable and offline).

## Local development

```
pnpm dev           # runs `wrangler dev` (server + static assets, real workerd runtime)
                   # and Vite in watch mode for the client build
```

- `wrangler dev` emulates Workers, Durable Objects, SQLite storage, and WebSockets
  locally with no Cloudflare account or network access required.
- The entire test suite runs offline. CI needs no secrets except for the deploy step.

## CI/CD (GitHub Actions)

1. **On PR:** `pnpm check` (lint, typecheck, unit, workerd tests) + `pnpm test:e2e`.
2. **On merge to `main`:** deploy via `cloudflare/wrangler-action` with a
   `CLOUDFLARE_API_TOKEN` repo secret.
3. Node 22 + pnpm cache; Playwright browsers cached.

## Cost model

- Workers Paid: **$5/month flat** — includes 10M requests/mo and generous DO duration.
- WebSocket Hibernation means idle/slow turn-based rooms consume almost no duration.
- Static assets unmetered. SQLite storage within included quota at this scale.
- Realistic worst case for a hobby-viral spike: still $5/mo. No other paid services.

## Explicitly NOT in the stack (and why)

- **React / Next.js** — game UI is a canvas; menus are simple DOM. Avoid framework weight.
- **Socket.IO / Colyseus** — Durable Objects + native WebSocket replace both.
- **Firebase / Supabase / external DB** — DO SQLite covers persistence; no second backend.
- **Docker** — nothing to containerize; workerd runs via wrangler.
- **Any physics engine (matter.js, box2d)** — Scorched Earth ballistics are ~50 lines of
  deterministic integration. An external engine adds nondeterminism risk for no gain.
