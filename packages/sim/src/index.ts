/**
 * @scorched/sim — the pure, deterministic Scorched Earth engine.
 *
 * Shared verbatim by the Cloudflare Durable Object (authoritative) and the
 * Phaser client (replay for rendering). It has no dependencies, touches no
 * platform API, and draws every random number from a seeded PRNG.
 *
 * If you are adding code here, the bar is: given the same inputs and seed, it
 * must produce byte-identical output on every JavaScript engine, forever.
 */

export * from './rng.ts';
export * from './math.ts';
export * from './terrain.ts';
export * from './physics.ts';
export * from './weapons.ts';
export * from './detonation.ts';
export * from './game.ts';
export * from './economy.ts';
export * from './ai.ts';
export * from './serialize.ts';
