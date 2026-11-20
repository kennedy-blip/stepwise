# Stepwise

**A procedural IK rooftop parkour runner.** Real-time inverse kinematics,
procedurally generated rooftops, and a physics engine written from scratch —
no sprite sheets, no audio files, no game engine.

The simulation is strictly 2D and runs on a fixed `Z = 0` traversal plane.
The presentation layer is a Three.js 2.5D scene: extruded rooftops, a parallax
city, atmospheric fog and a 3D-lit articulated runner driven by the existing
two-bone IK. Browsers without WebGL fall back to the original Canvas 2D
renderer, so the game is always playable.

Runs on desktop web, mobile web, and as an installable Android APK.

**Live:** https://stepwise-kmokaya864-5310.vercel.app

```bash
npm install
npm run dev      # http://localhost:5173
```

---

## What makes it different

**Everything is simulated, nothing is baked.**

The runner is an articulated skeleton whose legs and arms are driven by a
real **two-bone inverse kinematics solver** built on the Law of Cosines. Every
frame, each foot casts a ray down into the terrain, finds the exact surface
height _and_ the surface normal, and the leg is solved so the sole sits flush
on the slope. The pelvis lowers and rises automatically so neither leg ever
over-extends while crossing steps, vents and AC units.

The rooftops themselves are generated: roof widths, gaps, drops, ramps, AC
units, fragile planks, glass skylights, overhead pipes, ziplines and spring
awnings are all produced from a seeded PRNG, so a run is reproducible and
difficulty is a tuning table rather than hand-authored level data.

Audio is a **Web Audio synthesizer** — footsteps are noise bursts filtered by
the material underfoot (concrete, hollow metal, glass, wood), and every other
sound is generated from oscillators at runtime. There are no `.mp3` or `.wav`
files anywhere in the project.

The total shipped bundle is **~24 KB gzipped**, with zero external assets.

---

## Controls

### Desktop

| Key                    | Action                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `A` / `D` or `←` / `→` | Accelerate, pace, brake                                           |
| `Space` / `W` / `↑`    | Jump (tap for a short hop, hold for full height) · Mantle / Vault |
| `S` / `↓` / `Shift`    | Crouch · Parkour slide · Mid-air tuck-roll                        |
| `R`                    | Instant restart                                                   |
| `Esc`                  | Pause                                                             |
| `I`                    | Toggle the IK skeleton & raycast debug overlay                    |

### Pause menu

`Esc` (or the ❙❙ button) freezes the run and opens a menu with:

- **RESUME** — back into the run
- **SETTINGS** — audio, difficulty, sky mood and developer options; closing
  the modal returns you to the pause menu, not back into the action
- **RESTART RUN** — start the run again from the beginning
- **HOME** — abandon the run and return to the title screen

The run summary carries the same **SETTINGS** and **HOME** actions, so a
finished run can be left for the title screen without starting another one.

### Mobile

- **Left thumb** — drag horizontally to pace. An optional _Auto-Sprint Assist_
  toggle in Settings removes the need to hold anything at all.
- **Right thumb** — tap to jump, hold for height, swipe down to slide or
  tuck-roll.
- Gesture guides fade out over the first few seconds of your first run.

---

## The Flow Meter

Flow is the game's only health bar and doubles as a momentum multiplier.

| Action                                    | Flow     |
| ----------------------------------------- | -------- |
| Clean slope landing or timed tuck-roll    | `+15`    |
| Clean ledge vault or slide-under          | `+20`    |
| Edge leap (jumping within 16 px of a lip) | `+25`    |
| Hard landing / stumble                    | `-40`    |
| Standing still                            | `-5/sec` |

| Tier          | Range   | Effect                                                       |
| ------------- | ------- | ------------------------------------------------------------ |
| **Steady**    | 0–33%   | Base speed, muted scarf                                      |
| **In Stride** | 34–79%  | +15% top speed, longer leaps, amber scarf                    |
| **Pure Flow** | 80–100% | +25% top speed, glowing rim-light trail, **Flow Save armed** |

At Pure Flow a fatal mistake — a missed ledge or a mistimed drop — triggers a
0.15 s hit-stop flash and an automatic handspring recovery onto the next
roof, costing 50% of the meter instead of ending the run.

---

## Difficulty

|                  | Easy — Rooftop Cruise                   | Medium — City Flow                            | Hard — Razorline                                   |
| ---------------- | --------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Coyote time      | 160 ms                                  | 100 ms                                        | 60 ms                                              |
| Input buffer     | 180 ms                                  | 120 ms                                        | 80 ms                                              |
| Base / max speed | 320 / 480 px/s                          | 380 / 580 px/s                                | 440 / 680 px/s                                     |
| Gaps & drops     | Narrow, gentle                          | Balanced, multi-tier                          | Wide, steep                                        |
| Hazards          | Static roofs, ramps, vents, slow planks | + skylights, ziplines, planks, spring awnings | + fast-cracking planks, fragile glass, tight pipes |

---

## Architecture

The simulation is pure TypeScript and completely separated from rendering.

```
src/core/      types, math helpers              no DOM
src/physics/   IK solver, terrain + raycast     no DOM
src/game/      player, rig, flow, chunks, world  no DOM
src/engine/    graphics quality presets         no DOM
src/render/    Canvas 2D renderer (fallback)    reads simulation only
src/render3d/  Three.js 2.5D scene               reads simulation only
src/ui/        DOM HUD, title, summary, settings reads simulation only
src/audio/     Web Audio synthesizer
src/main.ts    app shell: fixed-timestep loop + wiring
```

The 3D layer is split into focused modules: `units.ts` owns the
simulation↔scene coordinate boundary, `camera3d.ts` the framing, `world3d.ts`
the rooftops and city, `humanoid3d.ts` the runner, `lighting3d.ts` the
atmospheres, `textures3d.ts` the procedural materials, `renderer3d.ts` the
renderer and post-processing, and `presenter.ts` the WebGL probe and the
fallback to 2D.

Because the simulation never touches the DOM, the entire game is unit tested
in Node — 190 tests covering the IK maths, raycasting, the Flow state machine,
the difficulty tables, chunk generation, the full game loop, the parkour
mechanics, and the simulation↔3D contract (depth bands, camera framing,
lighting rigs, geometry pooling and the presenter fallback).

`npx tsx tools/three-check.ts` runs the real 3D pipeline against the real
simulation offline, so the scene graph can be validated in CI without a GPU.

See [`AGENTS.md`](./AGENTS.md) for the full working rules.

---

## Commands

```bash
npm run dev         # Vite dev server
npm run build       # typecheck + production build
npm run preview     # serve the build
npm test            # Vitest suite
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run format      # Prettier
```

### Development tools

```bash
npx tsx tools/rig-check.ts                    # bone-length + foot-contact audit
npx tsx tools/render-png.ts out.png 900 dusk  # PNG snapshot of the real renderer
npx tsx tools/render-svg.ts out.svg 900 dusk  # SVG snapshot of the scene
npx tsx tools/render-ui.ts outdir           # PNG snapshots of the UI overlays
npx tsx tools/autopilot.ts                    # state-driven Medium pilot
```

`tools/render-png.ts` drives the shipped `Renderer` through a minimal Canvas2D
implementation, so the game's actual output can be inspected as an image
without a browser.

---

## Android

The in-game **Download Android APK (One-Tap)** button points at
`/downloads/stepwise.apk`, configured by the single constant `APK_DOWNLOAD_URL`
in `src/game/config.ts`.

To ship a real binary, follow [`public/downloads/README.txt`](./public/downloads/README.txt) —
it covers both Bubblewrap (TWA) and Capacitor, including release signing.

Until a signed build is dropped in, `/downloads/stepwise.apk` is rewritten to
`/downloads/stepwise.apk.txt`, a plain-text notice. The in-game card reads
**"Android APK — coming soon"** rather than promising an install that would
fail, and the game remains fully playable in the browser.

Two flags in `src/game/config.ts` control this:

| Constant           | Meaning                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `APK_DOWNLOAD_URL` | The route the button points at                                                                                                            |
| `APK_AVAILABLE`    | `false` while no signed binary exists; set to `true` when `public/downloads/stepwise.apk` is dropped in and `stepwise.apk.txt` is removed |

`tests/deploy.test.ts` asserts the two stay in sync, so the download route can
never again point at a file that does not exist.

---

## Stack

Vite · TypeScript (strict) · Three.js · Web Audio · Vitest · ESLint · Prettier · Vercel

Three.js is loaded with a dynamic import, so devices without WebGL never
download it — the main bundle stays at 93 kB (28 kB gzipped) and the 3D chunk
is fetched only when it can actually be used.
