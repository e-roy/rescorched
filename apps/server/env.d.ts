/**
 * Binding types for the Worker.
 *
 * Shaped the same way `wrangler types` generates them — bindings live on
 * `Cloudflare.Env`, and the bare `Env` extends it. That matters because
 * `cloudflare:test` derives its `ProvidedEnv` from `Cloudflare.Env`, so the
 * workerd test suite gets the same typed bindings as production instead of `any`.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      GAME_ROOM: DurableObjectNamespace<import('./src/game-room.ts').GameRoom>;
      ASSETS: Fetcher;
    }
  }

  interface Env extends Cloudflare.Env {}
}

export {};
