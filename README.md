# Stepwise

**A 2D procedural IK rooftop parkour runner.** Real-time inverse kinematics,
procedurally generated rooftops, and a physics engine written from scratch —
no sprite sheets, no audio files, no game engine.

Runs on desktop web, mobile web, and as an installable Android APK.

**Live:** https://stepwise-nine-gamma.vercel.app

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
src/render/    Canvas 2D renderer               reads simulation only
src/ui/        DOM HUD, title, summary, settings reads simulation only
src/audio/     Web Audio synthesizer
src/main.ts    app shell: fixed-timestep loop + wiring
```

Because the simulation never touches the DOM, the entire game is unit tested
in Node — 81 tests covering the IK maths, raycasting, the Flow state machine,
the difficulty tables, chunk generation, the full game loop and the parkour
mechanics.

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
it covers both Bubblewrap (TWA) and Capacitor, including release signing. Until
a signed build is dropped in, the download route serves a notice instead of a
broken binary, and the game remains fully playable in the browser.

---

## Stack

Vite · TypeScript (strict) · Canvas 2D · Web Audio · Vitest · ESLint · Prettier · Vercel

No runtime dependencies.
