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
src/core/      types, math helpers, platform     no DOM
src/physics/   IK solver, terrain + raycast     no DOM
src/game/      player, rig, flow, chunks, world  no DOM
src/engine/    graphics quality presets         no DOM
src/render/    Canvas 2D renderer (fallback)    reads simulation only
src/render3d/  Three.js 2.5D scene               reads simulation only
src/ui/        DOM HUD, title, summary, settings reads simulation only
src/audio/     Web Audio synthesizer
src/main.ts    app shell: fixed-timestep loop + wiring

android/       Android APK project (manifest, smali, resources)
scripts/       APK build + verification scripts
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
npm run build:apk   # build + sign the Android package
npm run verify:apk  # validate the shipped APK
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
in `src/game/config.ts`. **A real, signed Android package ships there** — it
installs and runs, it is not a placeholder.

### What is in the APK

The APK is a full-screen, landscape-locked WebView Activity that loads the
production web build from `file:///android_asset/www/index.html`. The same
bundle is used for the web deploy, so the two editions never drift apart.

Inside the wrapper the game gains:

- **Native haptics** — the Activity injects a `StepwiseNative` bridge; jumps,
  landings, flow changes and Flow Saves pulse the device vibrator. The browser
  falls back to the Vibration API.
- **A native frame-rate target** — the wrapper recommends 60 Hz to stay inside
  the WebView's thermal budget; the Settings panel exposes it.
- **Immersive fullscreen** — the system bars are hidden and stay hidden.

`src/core/platform.ts` owns the bridge; it degrades to no-ops when the bridge
is absent, so the browser build is unaffected.

### Building it

The build deliberately avoids the Android SDK, so it runs anywhere Node and a
JRE are available:

```bash
tools/fetch-android-tools.sh   # one-off: aapt2, smali.jar, a keystore
npm run build:apk              # builds + signs public/downloads/stepwise.apk
npm run verify:apk             # checks the artefact is a valid signed package
```

`npm run build:apk` runs five stages:

| Stage                | What happens                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| 1. web bundle        | `vite build` with `VITE_BASE=./` so asset paths resolve from `file://`   |
| 2. asset staging     | the bundle is copied to `assets/www/` inside the package                  |
| 3. smali → dex       | `android/smali/**` is assembled into `classes.dex`                        |
| 4. resource linking  | `aapt2 compile` + `aapt2 link` produce the manifest and resource table    |
| 5. signing           | `apk_sign_ts` applies the v1 (JAR), v2 and v3 signature schemes          |

The Activity itself is written in **smali** (`android/smali/com/stepwise/game/`)
rather than Java, so no Java compiler is needed — only a runtime.

Because there is no platform `framework-res.apk` on the build machine, the
linker is given a **synthetic framework** (`android/framework/res/values/attrs.xml`)
that declares exactly the framework attributes the manifest uses. The resource
IDs are still resolved against the real device framework at runtime.

### Keeping it honest

`tests/apk.test.ts` asserts against the shipped binary itself, not against the
build script's output: valid zip, required members, DEX magic, relative asset
paths, matching v1 manifest digests, and the v2/v3 signing blocks. It also
asserts that every asset the page references is actually packaged.

Two flags in `src/game/config.ts` control the download card:

| Constant           | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `APK_DOWNLOAD_URL` | The route the button points at                                             |
| `APK_AVAILABLE`    | `true` while a signed binary exists; `false` reverts the card to a notice |

`tests/deploy.test.ts` asserts the two stay in sync with the filesystem, so the
download route can never again point at a file that does not exist.

---

## Stack

Vite · TypeScript (strict) · Three.js · Web Audio · Vitest · ESLint · Prettier · Vercel

Three.js is loaded with a dynamic import, so devices without WebGL never
download it — the main bundle stays at 93 kB (28 kB gzipped) and the 3D chunk
is fetched only when it can actually be used.
