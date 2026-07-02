/* ================================================================
   EQUILIBRIA 02 — REACTION-DIFFUSION METABOLISM  (cartridge)
   ----------------------------------------------------------------
   Gray-Scott reaction-diffusion, ported from the CANVAS2D CPU
   solver in 02-reaction-diffusion.html (startCanvas2DFallback).

   The CPU path is used deliberately: the studio shell hands us a
   canvas we take a '2d' context from, and this must render on every
   machine — including GPU-less ones. A fixed small sim grid is
   solved several steps per frame, painted into an offscreen
   ImageData, then blitted scaled-up (with smoothing) into a centered
   "contain" rect. Coloring reuses the file's thermal->verdant palette
   with the same front/bloom treatment.

   Two chemicals U and V diffuse and react:
       U' = Du*Lap(U) - U*V^2 + f*(1 - U)
       V' = Dv*Lap(V) + U*V^2 - (f + k)*V

   Parameters are the Karl Sims "coral" set (Du=1, Dv=0.5, dt=1,
   feed~0.0545, kill~0.062) — the reliably-alive regime for an
   explicit Euler solver with the weighted 9-point Laplacian below.
   ================================================================ */
(function () {
  "use strict";

  Substrate.register({
    id: 'reaction-diffusion',
    name: 'Reaction–Diffusion',
    blurb: 'gray-scott metabolism',
    tags: ['reaction-diffusion', 'gray-scott', 'metabolism'],

    params: {
      feed:          { label: 'Feed f',        min: 0.01, max: 0.09, step: 0.001, default: 0.0545 },
      kill:          { label: 'Kill k',        min: 0.03, max: 0.075, step: 0.001, default: 0.062 },
      stepsPerFrame: { label: 'Steps / frame', min: 1,    max: 16,   step: 1,     default: 8, int: true },
      driftAmount:   { label: 'f/k drift',     min: 0,    max: 0.003, step: 0.0001, default: 0.0010 },
    },

    create({ canvas, width, height, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d');

      // ---- Fixed CPU sim grid (small enough for ~30fps on CPU) ----
      const GRID = 160;
      const N    = GRID * GRID;

      // ---- Gray-Scott physics constants (Karl Sims "coral" set) ---
      // The live-growing regime. feed/kill come live from the knobs.
      const DU = 1.0, DV = 0.5, DT = 1.0;
      const DRIFT_SPEED = 0.00035; // radians per ms-ish (very slow)

      // Two chemicals, double-buffered.
      let U  = new Float32Array(N);
      let V  = new Float32Array(N);
      let U2 = new Float32Array(N);
      let V2 = new Float32Array(N);

      // ---- Seed: U=1 everywhere, a jittered cluster of V spots ----
      // Positions/radii perturbed via Substrate.rng(seed) so reseed()
      // gives a different-but-reproducible start.
      function seedGrid(s) {
        const rng = Substrate.rng(s);
        for (let i = 0; i < N; i++) { U[i] = 1.0; V[i] = 0.0; }
        const cx = GRID >> 1, cy = GRID >> 1;

        // Base cluster (mirrors the source fallback) then jittered.
        const base = [
          [0,    0,  6],
          [-11,  7,  4],
          [10,  -9,  4],
          [8,   11,  3],
          [-9, -10,  3],
        ];
        // A couple of extra rng-placed spots for seed variety.
        const extra = 2 + Math.floor(rng() * 3); // 2..4
        const spots = base.slice();
        for (let e = 0; e < extra; e++) {
          const ox = Math.round((rng() * 2 - 1) * 26);
          const oy = Math.round((rng() * 2 - 1) * 26);
          const rad = 3 + Math.floor(rng() * 4); // 3..6
          spots.push([ox, oy, rad]);
        }

        for (const [bx, by, brad] of spots) {
          // jitter each spot's centre a few cells and its radius ±1
          const ox = bx + Math.round((rng() * 2 - 1) * 3);
          const oy = by + Math.round((rng() * 2 - 1) * 3);
          const rad = Math.max(2, brad + (rng() < 0.5 ? 0 : 1));
          const sx = cx + ox, sy = cy + oy;
          for (let y = -rad; y <= rad; y++) {
            for (let x = -rad; x <= rad; x++) {
              if (x * x + y * y > rad * rad) continue;
              const px = sx + x, py = sy + y;
              if (px < 0 || px >= GRID || py < 0 || py >= GRID) continue;
              const idx = py * GRID + px;
              U[idx] = 0.5;  // U knocked down
              V[idx] = 0.92; // V planted
            }
          }
        }
      }

      // ---- Gray-Scott update (toroidal wrap, weighted 9-pt Laplacian) ----
      function stepSim(feed, kill) {
        for (let y = 0; y < GRID; y++) {
          const yu = (y - 1 + GRID) % GRID;
          const yd = (y + 1) % GRID;
          const row = y * GRID, rowU = yu * GRID, rowD = yd * GRID;
          for (let x = 0; x < GRID; x++) {
            const xl = (x - 1 + GRID) % GRID;
            const xr = (x + 1) % GRID;
            const i  = row + x;
            const uC = U[i], vC = V[i];

            // ortho weight 0.2, diagonal 0.05, center -1.0
            const lapU =
              (U[row + xl] + U[row + xr] + U[rowU + x] + U[rowD + x]) * 0.2 +
              (U[rowU + xl] + U[rowU + xr] + U[rowD + xl] + U[rowD + xr]) * 0.05 - uC;
            const lapV =
              (V[row + xl] + V[row + xr] + V[rowU + x] + V[rowD + x]) * 0.2 +
              (V[rowU + xl] + V[rowU + xr] + V[rowD + xl] + V[rowD + xr]) * 0.05 - vC;

            const reaction = uC * vC * vC;
            const nU = uC + (DU * lapU - reaction + feed * (1.0 - uC)) * DT;
            const nV = vC + (DV * lapV + reaction - (feed + kill) * vC) * DT;
            U2[i] = nU < 0 ? 0 : nU > 1 ? 1 : nU;
            V2[i] = nV < 0 ? 0 : nV > 1 ? 1 : nV;
          }
        }
        let t;
        t = U; U = U2; U2 = t;
        t = V; V = V2; V2 = t;
      }

      // ---- Palette: colors now come from the studio GLOBAL palette ----
      // Formerly a local thermal->verdant ramp (thermalVerdant + its
      // 7 hardcoded stops). The ramp SHAPE lives elsewhere now — the
      // default global palette is thermal->verdant so the base look is
      // ~unchanged, and shuffle/drift on the palette recolors live.
      //
      // Substrate.rampLUT() -> Uint8ClampedArray(768): 256-entry RGB LUT
      // for t in [0,1], sampled ONCE per frame (cached in paint()).
      // The rest of the paint math works in 0-1 floats, so we normalize
      // each sampled channel to [0,1] to preserve every downstream effect
      // (presence fade, bloom add, tone curve, gamma) byte-for-byte.
      const BG_C = [0.039, 0.055, 0.043]; // #0a0e0b — void/background fade target

      function smoothstep(e0, e1, x) {
        let t = (x - e0) / (e1 - e0);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        return t * t * (3 - 2 * t);
      }
      // Sample the cached global LUT at t, writing 0-1 floats into `out`.
      function sampleRamp(lut, t, out) {
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const o = ((t * 255) | 0) * 3;
        out[0] = lut[o]     / 255;
        out[1] = lut[o + 1] / 255;
        out[2] = lut[o + 2] / 255;
        return out;
      }

      // ---- Offscreen grid -> ImageData, blitted scaled-up ---------
      const off    = document.createElement('canvas');
      off.width    = GRID;
      off.height   = GRID;
      const offCtx = off.getContext('2d');
      const img    = offCtx.createImageData(GRID, GRID);
      const pix    = img.data;
      const _col   = [0, 0, 0];
      const _col2  = [0, 0, 0];

      function paint() {
        // Global palette LUT: sampled ONCE per frame, never per cell.
        const lut = Substrate.rampLUT();
        for (let y = 0; y < GRID; y++) {
          const yu = (y - 1 + GRID) % GRID;
          const yd = (y + 1) % GRID;
          const row = y * GRID, rowU = yu * GRID, rowD = yd * GRID;
          for (let x = 0; x < GRID; x++) {
            const xl = (x - 1 + GRID) % GRID;
            const xr = (x + 1) % GRID;
            const i  = row + x;
            const v  = V[i];

            // soft halo for bloom + front detection
            const halo = (V[row + xr] + V[row + xl] + V[rowU + x] + V[rowD + x] +
                          V[rowU + xr] + V[rowD + xl]) / 6.0;

            let t = smoothstep(0.04, 0.34, v);
            let front = (halo - v) * 6.0;
            front = front < -1 ? -1 : front > 1 ? 1 : front;
            t += (front > 0 ? front : 0) * 0.25;
            t = t < 0 ? 0 : t > 1 ? 1 : t;

            sampleRamp(lut, t, _col);

            // fade very-low-V tissue into the warm-black "void"
            const presence = smoothstep(0.02, 0.12, v);
            _col[0] = BG_C[0] + (_col[0] - BG_C[0]) * presence;
            _col[1] = BG_C[1] + (_col[1] - BG_C[1]) * presence;
            _col[2] = BG_C[2] + (_col[2] - BG_C[2]) * presence;

            // warm-biased bloom add
            const bloom = smoothstep(0.18, 0.45, halo);
            sampleRamp(lut, t + 0.15 > 1 ? 1 : t + 0.15, _col2);
            _col[0] += _col2[0] * bloom * 0.35;
            _col[1] += _col2[1] * bloom * 0.35;
            _col[2] += _col2[2] * bloom * 0.35;

            // gentle filmic-ish tone curve + gamma
            let r  = _col[0] / (_col[0] + 0.85) * 1.85;
            let g  = _col[1] / (_col[1] + 0.85) * 1.85;
            let bb = _col[2] / (_col[2] + 0.85) * 1.85;
            r  = Math.pow(r  < 0 ? 0 : r,  0.92);
            g  = Math.pow(g  < 0 ? 0 : g,  0.92);
            bb = Math.pow(bb < 0 ? 0 : bb, 0.92);

            const p = i * 4;
            pix[p]     = r  > 1 ? 255 : r  * 255;
            pix[p + 1] = g  > 1 ? 255 : g  * 255;
            pix[p + 2] = bb > 1 ? 255 : bb * 255;
            pix[p + 3] = 255;
          }
        }
        offCtx.putImageData(img, 0, 0);
      }

      // ---- Centered "contain" blit rect (recomputed on resize) ----
      let vw = 0, vh = 0, blitX = 0, blitY = 0, blitSide = 0;
      function computeBlit(w, h) {
        vw = w; vh = h;
        blitSide = Math.min(vw, vh);
        blitX = (vw - blitSide) / 2;
        blitY = (vh - blitSide) / 2;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
      }
      // The shell already sized the backing store; width/height are the
      // device-pixel dimensions of the passed canvas.
      computeBlit(width, height);

      function drawScaled() {
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, vw, vh);
        ctx.drawImage(off, 0, 0, GRID, GRID, blitX, blitY, blitSide, blitSide);
      }

      // ---- Active-fraction measurement (throttled) ----------------
      function measureActive() {
        let active = 0;
        for (let i = 0; i < N; i++) if (V[i] > 0.12) active++;
        return active / N;
      }

      // ---- State ---------------------------------------------------
      let iter = 0;
      let phase = 0;               // drift phase, accumulates with dt
      let activeFrac = 0;
      let measureClock = 0;
      let feedNow = params.feed;
      let killNow = params.kill;
      let extDrive = null;         // optional coupling input; null = standalone

      seedGrid(seed);

      return {
        step(dt) {
          // Read knobs LIVE every frame — retunes the running simulation.
          phase += dt * DRIFT_SPEED;
          const drift = params.driftAmount;
          feedNow = params.feed + Math.sin(phase) * drift;
          killNow = params.kill + Math.cos(phase * 0.73) * (drift * 0.7);

          // Optional external coupling: a small, clamped feed nudge.
          // extDrive === null → standalone, feedEff === feedNow (unchanged).
          let feedEff = feedNow;
          if (extDrive !== null) {
            feedEff = feedNow + (extDrive - 0.5) * 0.006;
            feedEff = feedEff < 0.01 ? 0.01 : feedEff > 0.09 ? 0.09 : feedEff;
          }

          const steps = params.stepsPerFrame | 0;
          for (let s = 0; s < steps; s++) { stepSim(feedEff, killNow); iter++; }

          paint();
          drawScaled();

          measureClock += dt;
          if (measureClock >= 350) {
            measureClock = 0;
            activeFrac = measureActive();
          }
        },

        reseed(newSeed) {
          seedGrid(newSeed);
          iter = 0;
          phase = 0;
          activeFrac = 0;
          measureClock = 0;
        },

        resize(w, h /*, dpr */) {
          // Sim grid stays fixed; just recompute the centered blit rect.
          computeBlit(w, h);
        },

        readouts() {
          let mass = 'STEADY';
          if (activeFrac < 0.015)      mass = 'DECAYING';
          else if (activeFrac > 0.93)  mass = 'FLOODING';
          return {
            FEED:   feedNow.toFixed(4),
            KILL:   killNow.toFixed(4),
            ACTIVE: (activeFrac * 100).toFixed(0) + '%',
            MASS:   mass,
            ITER:   iter.toLocaleString(),
          };
        },

        // ---- Optional coupling (no-ops for standalone) --------------
        // emit(): this system's mass/vitality output in [0,1].
        emit() {
          return activeFrac;
        },

        // absorb(signal): signal in [0,1] (0.5 neutral). Stored and
        // applied as a small clamped feed nudge in step().
        absorb(signal) {
          extDrive = signal;
        },
      };
    },
  });

})();
