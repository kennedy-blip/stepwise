# AGENTS.md — Working on Stepwise

Stepwise is a 2D procedural IK rooftop parkour runner built with Vite, TypeScript
(strict) and the native HTML5 Canvas 2D API. It ships to Vercel and is
packaged for Android.

Read this file before changing anything. The architecture rules below are what
keep the project coherent.

---

## 1. Architecture — the one rule that matters

**The simulation is pure. The renderer and the UI are pure outputs.**

```
src/core/     types, math helpers            — no DOM, no canvas
src/physics/  IK solver, terrain + raycast   — no DOM, no canvas
src/game/     player, rig, flow, chunks,     — no DOM, no canvas
               world, config
src/render/   Canvas 2D renderer             — READS simulation state only
src/ui/       DOM HUD, title, summary,       — READS simulation state only
               settings modal
src/audio/    Web Audio synthesizer          — called from the app shell
src/main.ts   the app shell: loop + wiring
```

Rules that follow from this:

1. **Never import `document`, `window`, `CanvasRenderingContext2D` or
   `AudioContext` inside `src/core`, `src/physics` or `src/game`.** If a
   gameplay module needs to know something about the browser, expose a plain
   data hook and let `src/main.ts` bridge it.
2. **The renderer and the UI never write back into the simulation.** If the
   renderer needs data the simulation does not expose, add it to the
   simulation — do not reach into it from the renderer.
3. **Gameplay modules communicate outward through a typed event queue**
   (`GameEvent` in `src/game/player.ts`). The app shell drains it and turns it
   into audio, particles and floating labels.

This separation is what lets the entire game be unit tested in Node with no
browser. Keep it that way.

---

## 2. Coordinate system — the single biggest source of bugs

**Screen space: +x is right, +y is DOWN.**

This is counter-intuitive for "up" and it has already caused several bugs in
this codebase. Rules:

- Smaller `y` = higher on screen.
- "Above" a surface means a **smaller** y.
- A downward ray starts at `y` and travels toward **increasing** y.
- `Terrain.groundAt(x, y)` casts a ray that starts at exactly `y`. Starting
  even slightly lower will skip past the surface the caller is standing on.

When you write a raycast, ask "is the thing I am looking for at a larger y
than my origin?" before you write the comparison.

---

## 3. The IK solver (`src/physics/ik.ts`)

`solveTwoBoneIK(root, target, upperLen, lowerLen, bendDirection, options)`

- Implemented with the **Law of Cosines**. Do not replace it with an
  iterative approximation — the exact solution is what keeps feet welded to the
  terrain.
- The `bendDirection` decides which side of the root→target axis the joint
  bulges toward. Reversing it mirrors the solution exactly. KNEES bend
  forward (`{x: facing, y: 0}`), ELBOWS bend backward (`{x: -facing, y: 0}`).
- `maxFold` (0..1) caps the interior angle at the joint. `maxFold = 1` allows
  the chain to fold flat; `0` keeps it rigid. It changes the minimum
  reachable distance — see the `minReach` derivation in the file.
- When the target is **out of reach**, the chain fully extends along the
  root→target direction and the end effector sits at the far end of that
  straight chain — _not_ on the target. Bone lengths must stay exact.
- `src/game/rig.ts` is the only caller. It must never mutate a bone; it feeds
  new targets in and reads positions out.

Verify changes with `npx vitest run tests/ik.test.ts` and the rig diagnostic:

```bash
npx tsx tools/rig-check.ts
# bone violations must be 0 and max foot gap must be 0.00 px
```

---

## 4. The simulation loop (`src/main.ts`)

- The simulation runs on a **fixed timestep** of `1/120 s`, decoupled from
  `requestAnimationFrame`. `PHYSICS.fixedDt` is the single source of truth.
- Each rendered frame drains an accumulator in fixed steps, capped at
  `PHYSICS.maxStepsPerFrame` to avoid a spiral of death.
- `requestAnimationFrame` is used **only** for rendering and for sampling
  input. Never drive physics from it.
- Simulation speed must therefore be identical on a 60 Hz phone and a 144 Hz
  monitor. If you make a change that alters this, it is a bug.

---

## 5. Terrain and chunk generation (`src/game/chunks.ts`, `src/physics/terrain.ts`)

- Chunks are generated from a **seed** — the same seed must always produce
  the same level. Use `makeRng` (mulberry32), never `Math.random()`, in
  generation code.
- Furniture **may not overlap**. The generator keeps an `occupied` list of
  x-ranges and reserves a generous region per piece (`objW + 140`) because
  some pieces add geometry beyond their own width (ramp landing pads).
- **Overhead pipes are placed in a dedicated pass, last.** Their clearance
  must be measured against the _final_ roof surface across their whole span
  (a pipe buried in an AC unit is impassable). The `surfaceUnder` helper does
  this.
- Everything must be reachable by a downward raycast. If you add a new
  obstacle, add a test that walks the runner through it.

---

## 6. The Flow Meter (`src/game/flow.ts`)

- Flow is the game's only health resource and also a speed multiplier.
- Tiers: `0–33` steady, `34–79` in stride (+15% speed), `80–100` pure flow
  (+25% speed, Flow Save armed).
- Use `addFlow` / `consumeFlowSave` / `decayFlow` — do not poke `flow.value`
  directly, because the tier and the armed flag have to be re-derived.
- Rewards: clean landing / roll `+15`, vault or slide-under `+20`, edge leap
  `+25`. Penalties: hard landing / stumble `-40`, pipe hit `-15`.
- Passive decay (`-5%/sec`) only applies while the runner is genuinely
  hesitating: **no movement input AND** a low speed. A runner accelerating
  from a standstill is not hesitating.

---

## 7. Adding a feature — the checklist

1. **Simulation first.** Add the behaviour to `src/game/` or `src/physics/`.
   It must be testable in Node with no DOM.
2. **Emit a `GameEvent`** for anything the player should see or hear.
3. **Tests first-class.** Add a case to `tests/` that fails without the
   feature. The existing suites are:
   - `tests/ik.test.ts` — solver maths
   - `tests/terrain.test.ts` — raycasting and collision
   - `tests/flow.test.ts` — meter rules
   - `tests/difficulty.test.ts` — tuning tables and chunk generation
   - `tests/simulation.test.ts` — the whole game loop
   - `tests/parkour.test.ts` — vaults, rolls, slides, flow saves
   - `tests/render.test.ts` — the draw path never throws and never emits NaN
4. **Then the presentation layer.** Renderer or UI only.
5. **Run the full gate** before you commit:
   ```bash
   npm run typecheck && npm run lint && npm run test && npm run build
   ```

---

## 8. The overlay screens (`src/ui/hud.ts`, `index.html`)

The game has five overlay layers: **title**, **HUD**, **pause**, **summary**
and **settings**. They are plain markup in `index.html`; `src/ui/hud.ts`
binds behaviour to it and `src/main.ts` owns the state transitions.

- **The settings modal is reachable from three places** — the title screen,
  the pause menu and the run summary. `UI.openSettings(from)` records where
  it was opened from, and `UI.closeSettings()` restores that screen. Never
  close the modal with a plain `classList.remove` from elsewhere; use
  `closeSettings()` (restores) or `dismissSettings()` (does not).
- **The pause menu must always offer a way out.** RESUME, SETTINGS, RESTART
  RUN and HOME are the expected set. `HOME` calls `App.goHome()`, which
  returns the world to its title phase via `World.toTitle()`.
- The UI dispatches `stepwise:*` events on the app root; `src/main.ts`
  listens for them. The UI handles its own `stepwise:open-settings` so the
  modal works without the app shell.
- When you add a screen, add it to `UI.showTitle` / `showHud` / `showPause`
  so the overlays never stack.

---

## 9. Conventions

- TypeScript `strict: true`. No `any`. No non-null assertions in `src/`
  (they are allowed in `tests/`).
- Prefer `const`. Let `tsc` and `eslint` catch the rest.
- Comments should explain **why**, not **what**. The code says what it does;
  the comment should say why it does it that way and what breaks otherwise.
- Pure functions where possible — they are trivially testable.
- No runtime dependencies. The whole game is ~24 KB gzipped with zero
  external assets: audio is synthesised, art is drawn procedurally.

---

## 10. Commands

| Command              | What it does                                 |
| -------------------- | -------------------------------------------- |
| `npm run dev`        | Vite dev server on `:5173`                   |
| `npm run build`      | Typecheck then production build into `dist/` |
| `npm run preview`    | Serve the built site on `:4173`              |
| `npm test`           | Run the Vitest suite once                    |
| `npm run test:watch` | Vitest in watch mode                         |
| `npm run typecheck`  | `tsc --noEmit`                               |
| `npm run lint`       | ESLint over the project                      |
| `npm run format`     | Prettier write                               |

---

## 11. Deploying

- `vercel.json` holds the build command, the output directory and the caching
  headers. The `/downloads/` route serves the Android APK.
- The APK path is a single constant: `APK_DOWNLOAD_URL` in
  `src/game/config.ts`. Point it somewhere else rather than hard-coding a new
  URL in the UI.
- `public/downloads/README.txt` explains exactly how to produce and drop a
  signed `.apk` in. The download button must never 404 — if the binary is
  missing, ship the README notice in its place.
- **Never write a self-referencing rewrite.** `"source": "/x.apk",
"destination": "/x.apk"` is an infinite loop: Vercel never reaches the
  filesystem and the route fails. This shipped once and broke the download.
- `APK_AVAILABLE` in `src/game/config.ts` tells the UI whether a signed binary
  exists. Keep it in sync with `public/downloads/`, or the button will
  promise an install that fails.
- `tests/deploy.test.ts` asserts all of the above, plus that the security
  headers are present and that a favicon is declared. Run it after any change
  to `vercel.json`, `index.html` or the download route.
- The browser requests `/favicon.ico` by default. Declare a `<link
rel="icon">` in `index.html` and ship the file in `public/` so the
  deployment does not log a 404 on every page load.

---

## 12. Debugging aids

- `I` toggles the IK skeleton, raycasts and hitbox overlay in game.
- `npx tsx tools/rig-check.ts` — validates bone lengths and foot contact
  over a long simulated run. Both numbers must be zero.
- `npx tsx tools/render-svg.ts out.svg <frames> <mood>` — dumps the scene as
  SVG using the real world→screen transform, for inspecting composition
  without a browser.
- `npx tsx tools/render-ui.ts [outdir]` — renders PNG snapshots of the
  title / pause / summary / settings overlays, so the UI can be reviewed
  as an image without a browser.
- `npx tsx tools/render-png.ts out.png <frames> <mood> <difficulty>` — renders a
  real PNG snapshot of the shipped `Renderer` by driving it through a minimal
  Canvas2D implementation (transforms, gradients, paths, arcs, strokes). Use
  this to eyeball the actual output of the game without a browser. Set
  `SW_DEBUG=0` to omit the IK debug overlay.
- `npx tsx tools/autopilot.ts` — runs the state-driven Medium pilot used by the
  scenario suite, reporting distance, Flow and the mechanics it exercised.
