# Reference images — the original Scorched Earth (1991)

These are what a visual critic compares the running game against. Per
`TECH_STACK.md`, **a visual verdict must be based on actual captured
screenshots**, never on reading the rendering code and imagining the result.

## Getting the images

```bash
node scripts/fetch-reference.mjs
```

The image files are **deliberately not committed**. They are screenshots of a
copyrighted commercial game, hosted on Wikipedia under a fair-use rationale;
redistributing copies inside an open-source repository is a licensing problem
this project has no reason to take on. The fetch script pulls them on demand and
`.gitignore` keeps them out of history.

## What to compare against

If the fetch fails (offline, or the upstream files move), these notes are the
fallback. They were written from the actual images, not from memory.

### `scorched-earth-gameplay.png` — a match in progress

The look worth stealing:

- **Sky is near-black, dense with white stars.** Not a blue gradient. The
  starfield is the single most recognisable thing about the battlefield, and its
  absence is why a modern remake reads as "generic artillery game".
- **Terrain is one flat, saturated colour** — bright green in this capture, but
  the original randomises the palette per round. Flat fill, no gradient, no
  texture. The silhouette does all the work.
- **Mountains are steep and dramatic**, with narrow peaks and deep valleys —
  much more vertical than gentle rolling hills.
- **Trajectory arcs are thin blue/violet lines** and several are visible at once
  (a Funky Bomb splitting into multiple sub-munitions, each drawing its own arc).
- **Explosions are filled circles of saturated red and orange**, stacked, with
  hard edges. No soft glow, no blur.
- **Tanks are tiny** relative to the field, and a shielded tank is drawn with a
  clean white circle around it.
- **The status bar sits at the TOP**, one compact line: `Power`, `Angle`, a
  colour swatch for the active player, a percentage, weapon name, and `Wind` at
  the right edge. Small bitmap type, tightly packed, no chrome.
- The playfield has a thin light-grey frame around it.

### `scorched-earth-title-screen.png` — the menu

- Vertical sunset gradient: deep blue at the top through purple and magenta into
  orange and yellow at the horizon.
- An enormous yellow sun disc sitting behind a pale, near-white mountain range.
- `Scorched Earth` in bright yellow, with `The Mother of All Games` beneath it in
  cyan, then `** Shareware Version **`.
- A column of grey Motif-style buttons down the left edge.
- Version and copyright line centred at the very bottom.

## Honest scoring

The bar in `GAME_PROMPT.md` is "would wow a player who loved the original".
Concretely, ask of every capture:

1. Does the sky read as *space over a battlefield* rather than a UI background?
2. Does a crater look like something was **torn out** of the ground?
3. Does the explosion have enough weight that landing a hit feels good?
4. Is the terrain silhouette interesting, or is it soft noise?
5. Could a 1991 player glance at this and recognise the game?

A "no" to any of those is a fail, not a nitpick.
