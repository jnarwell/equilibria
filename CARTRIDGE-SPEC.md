# Cartridge Spec — the substrate contract

A **cartridge** is one generative system. Conform to this contract and the studio
shell gives you knobs, reseed, live readouts, and export (PNG + video) for free.

Cartridges are plain classic scripts (NOT ES modules — must load over `file://`).
Each file registers itself into the global `Substrate` registry:

```js
Substrate.register({
  id:    'flowfield',                 // unique slug
  name:  'Exergy Flowfield',          // display name
  blurb: 'conserved particle loop',   // one-line tag under the name
  tags:  ['flow', 'conservation'],    // optional

  // Knobs: the shell auto-generates a labeled slider for each entry.
  // Read these live inside step() — the shell mutates this same object
  // when the user drags a slider. Never cache a param value across frames.
  params: {
    speed:      { label: 'Flow speed',   min: 0.1, max: 4,   step: 0.01, default: 1   },
    noiseScale: { label: 'Noise scale',  min: 0.5, max: 6,   step: 0.1,  default: 2   },
    count:      { label: 'Particles',    min: 200, max: 6000, step: 100, default: 2600, int: true },
  },

  // Called once when the cartridge is loaded. Get your own context off `canvas`
  // (2d OR webgl2 — the shell hands you a FRESH canvas each load, so either works).
  // Return an instance with the methods below.
  create({ canvas, width, height, dpr, params, seed, Substrate }) {
    const ctx = canvas.getContext('2d');
    // ... build state, seed with Substrate.rng(seed) ...
    return {
      // Advance + draw exactly one frame. dt = ms since last frame.
      step(dt) { /* read params.* live; render to ctx */ },

      // Optional. Restart the composition from a new random seed.
      reseed(newSeed) { /* re-init using Substrate.rng(newSeed) */ },

      // Optional. Window resized; canvas already resized by the shell.
      resize(width, height, dpr) { /* rebuild size-dependent buffers */ },

      // Optional. Live stats shown in the readout strip. Return a flat object.
      readouts() { return { TEMP: '699K', EXERGY: '25%', LOOP: 'CLOSED' }; },

      // Optional (v2 coupling). Radiate one scalar the rack can route.
      emit() { return 0.0; },
      // Optional (v2 coupling). React to an incoming routed scalar in [0,1].
      absorb(signal) { /* nudge internal drive */ },

      // Optional. Free timers/buffers when the cartridge is unloaded.
      dispose() {},
    };
  },
});
```

## What the shell provides (`window.Substrate`)

- `Substrate.register(def)` — call once per cartridge file.
- `Substrate.rng(seed)` — returns a deterministic `() => [0,1)` PRNG (mulberry32).
  Use it for ALL randomness so `reseed` is reproducible and seeds are shareable.
- `Substrate.noise2D` — a small value-noise `(x, y) => [-1,1]` helper (optional use).
- **Color — the global generative palette** (so palette shuffle/drift/breeding reach you):
  - `Substrate.rampLUT()` → `Uint8ClampedArray(768)`: a 256-entry RGB LUT for `t ∈ [0,1]`. Call
    ONCE per frame (cache it), index `i = (clamp01(t)*255)|0` → `[lut[i*3], lut[i*3+1], lut[i*3+2]]`.
    Use this in per-pixel / hot loops.
  - `Substrate.ramp(t)` → `[r,g,b]` (0-255); `Substrate.rampCSS(t)` → `'rgb(...)'` (for fillStyle).
  The default palette is thermal→verdant, so sourcing the LUT keeps your look but lets the global
  **Shuffle** / **Color-drift** recolor your system live.

## Rules

- **Vanilla, no deps, no CDN.** Must run by double-clicking `index.html`.
- **Read params live** every frame from the passed `params` object. The slider (and the
  modulation transport) mutate it in place; don't snapshot values in `create`.
- **All randomness via `Substrate.rng(seed)`** so a seed reproduces a composition.
- **DPR-aware.** `create` gets `dpr`; the shell sizes the canvas backing store.
- **Color via the global palette** (`Substrate.rampLUT()`/`ramp()`/`rampCSS()`), never a hardcoded
  ramp, so Shuffle/Color-drift reach you. Background stays `#0a0e0b`.
- **Every knob is free machinery.** Any `params` entry you declare is automatically a modulation
  target (the ∿ transport) and a breeding gene — no extra work.
- **Don't let `readouts()`/`step()` throw** — an uncaught exception can stall the frame loop. Keep
  any variable a method uses (e.g. `canvas.height`) in that method's scope.

## The commission loop

New cartridge = describe it → the agent writes `cartridges/NN-slug.js` to this
contract → add one `<script src>` line to `index.html` → it appears in the rack.
That's the whole substrate: a sentence becomes an operable instrument.
