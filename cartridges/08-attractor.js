/* ============================================================
   EQUILIBRIA · Cartridge 08 — ATTRACTOR  (strange attractor)

   Peter de Jong map iterated tens of thousands of times per frame:
       x' = sin(a*y) - cos(b*x)
       y' = sin(c*x) - cos(d*y)
   Each point is plotted additively into a persistent accumulation
   buffer that fades slowly every frame, so the filament cloud
   builds and breathes rather than saturating. Points are colored
   by local step-length (speed) through the thermal->verdant ramp,
   and the a,b,c,d parameters drift VERY gently over time so the
   attractor morphs continuously.

   Conforms to the Substrate cartridge contract. The shell supplies
   the canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  // Internal accumulation-buffer resolution (short axis, px). Fixed and
  // independent of DPR: the buffer is colorized then blitted scaled-up
  // with smoothing for the soft glow, so cost stays bounded at any size.
  const BUFFER_SHORT = 680;

  // Gentle parameter-morph tuning.
  const DRIFT_RATE = 0.09;   // phase advance per (drift * freq * dt)
  const DRIFT_AMP  = 0.32;   // wobble amplitude added to each live param
  const ADD        = 0.085;  // per-hit energy deposited into the buffer
  const ADDN       = ADD / 255;

  // Color source: the studio-wide GLOBAL generative palette. The shell's
  // Substrate.rampLUT() returns a 256-entry RGB LUT (Uint8ClampedArray(768))
  // for t in [0,1]; the default palette is thermal->verdant so the base look
  // matches the former local ramp, while shuffle/drift recolors live. We cache
  // it once per frame (see step()) and index it by the same displacement t.
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  Substrate.register({
    id: 'attractor',
    name: 'Attractor',
    blurb: 'de Jong strange attractor',
    tags: ['chaos', 'strange-attractor', 'de-jong'],

    // Knobs — read LIVE inside step(). Defaults give a rich, stable cloud.
    params: {
      a:          { label: 'Param a',    min: -3,     max: 3,      step: 0.001, default: 1.4   },
      b:          { label: 'Param b',    min: -3,     max: 3,      step: 0.001, default: -2.3  },
      c:          { label: 'Param c',    min: -3,     max: 3,      step: 0.001, default: 2.4   },
      d:          { label: 'Param d',    min: -3,     max: 3,      step: 0.001, default: -2.1  },
      iterations: { label: 'Iterations', min: 20000,  max: 150000, step: 1000,  default: 60000, int: true },
      drift:      { label: 'Drift',      min: 0,      max: 0.02,   step: 0.0005, default: 0.004 },
      fade:       { label: 'Fade',       min: 0.01,   max: 0.3,    step: 0.01,  default: 0.08  },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen buffer canvas we tone-map into, then blit scaled-up.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let BW = 0, BH = 0;      // buffer dimensions
      let acc = null;          // Float32 RGB accumulation buffer (BW*BH*3)
      let img = null;          // ImageData for the buffer
      let x = 0, y = 0;        // current orbit point
      let coverage = 0;        // fraction of buffer lit (spread)

      // Global-palette LUT (Uint8ClampedArray(768)) cached once per frame in
      // step() and read inside iterate() for the point color source.
      let frameLUT = null;

      // Per-parameter drift oscillators — seeded so reseed reproduces morph.
      const phase = new Float64Array(4);
      const freq  = new Float64Array(4);

      // Effective (drifted) parameters, exposed to readouts.
      let effA = 0, effB = 0, effC = 0, effD = 0;

      let curSeed = seed >>> 0;

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; dynamics byte-identical to standalone.
      // Otherwise a scalar in [0,1] (0.5 neutral) that nudges the morph speed
      // (drift) and amplitude within a clamped safe band.
      let extDrive = null;

      // Seed the orbit start and the four drift oscillators deterministically.
      function seedState(seedVal) {
        const rng = Substrate.rng(seedVal >>> 0);
        x = (rng() - 0.5) * 0.2;
        y = (rng() - 0.5) * 0.2;
        for (let i = 0; i < 4; i++) {
          phase[i] = rng() * Math.PI * 2;
          freq[i]  = 0.6 + rng() * 0.8;   // desynchronized slow frequencies
        }
      }

      // (Re)allocate the accumulation buffer sized to the canvas aspect.
      function buildBuffer() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) { BH = BUFFER_SHORT; BW = Math.round(BUFFER_SHORT * aspect); }
        else             { BW = BUFFER_SHORT; BH = Math.round(BUFFER_SHORT / aspect); }
        grid.width = BW; grid.height = BH;
        img = gctx.createImageData(BW, BH);
        acc = new Float32Array(BW * BH * 3);
        // Prime the ImageData alpha channel to opaque once.
        const data = img.data;
        for (let p = 3; p < data.length; p += 4) data[p] = 255;
      }

      // Iterate the de Jong map, depositing colored energy into `acc`.
      // Colors by per-step displacement length (fast strokes read hot).
      function iterate(a, b, c, d, n) {
        const sx = 0.25 * BW, sy = 0.25 * BH; // map [-2,2] -> [0,B]
        let px = x, py = y;
        for (let i = 0; i < n; i++) {
          const nx = Math.sin(a * py) - Math.cos(b * px);
          const ny = Math.sin(c * px) - Math.cos(d * py);
          const dxs = nx - px, dys = ny - py;
          px = nx; py = ny;

          const bx = ((nx + 2) * sx) | 0;
          const by = ((ny + 2) * sy) | 0;
          if (bx < 0 || bx >= BW || by < 0 || by >= BH) continue;

          const speed = Math.sqrt(dxs * dxs + dys * dys);
          let ti = (speed * 85) | 0;      // ~[0,4] step -> palette index
          if (ti > 255) ti = 255;
          const li = ti * 3;
          const bi = (by * BW + bx) * 3;
          acc[bi]     += frameLUT[li]     * ADDN;
          acc[bi + 1] += frameLUT[li + 1] * ADDN;
          acc[bi + 2] += frameLUT[li + 2] * ADDN;
        }
        x = px; y = py;
        // If the orbit escaped to a non-finite value, re-seed the point.
        if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 0.01; y = 0.01; }
      }

      // Tone-map (Reinhard) the accumulation buffer into the ImageData and
      // measure coverage (fraction of lit pixels) for the SPREAD readout.
      function tonemap() {
        const data = img.data;
        const n = BW * BH;
        let lit = 0;
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          const j = i * 3;
          const r = acc[j], g = acc[j + 1], b = acc[j + 2];
          const R = (r / (1 + r)) * 255;
          const G = (g / (1 + g)) * 255;
          const B = (b / (1 + b)) * 255;
          data[p]     = R;
          data[p + 1] = G;
          data[p + 2] = B;
          if (R + G + B > 42) lit++;
        }
        coverage = lit / (n || 1);
        gctx.putImageData(img, 0, 0);
      }

      // Composite the buffer onto the main canvas over #0a0e0b with an
      // additive base pass plus a blurred bloom pass for the glow.
      function render() {
        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // additive base (black buffer regions add nothing under 'lighter')
        ctx.globalCompositeOperation = 'lighter';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(grid, 0, 0, BW, BH, 0, 0, cw, ch);

        // additive bloom / glow
        ctx.globalAlpha = 0.5;
        ctx.filter = 'blur(' + Math.max(5, cw * 0.01) + 'px)';
        ctx.drawImage(grid, 0, 0, BW, BH, 0, 0, cw, ch);

        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      seedState(curSeed);
      buildBuffer();

      return {
        step(dt) {
          // Read knobs live every frame; the shell mutates params in place.
          const baseA = params.a, baseB = params.b, baseC = params.c, baseD = params.d;
          const iterations = params.iterations | 0;
          const fade = params.fade;

          // Morph speed/amplitude. When extDrive is null this stays exactly
          // at the slider value; otherwise a bounded clamped nudge applies.
          let driftEff = params.drift;
          let ampEff = DRIFT_AMP;
          if (extDrive !== null) {
            driftEff = clamp(params.drift + (extDrive - 0.5) * 0.02, 0, 0.04);
            ampEff   = clamp(DRIFT_AMP + (extDrive - 0.5) * 0.5, 0.1, 0.9);
          }

          // Advance the four drift oscillators very gently.
          const adv = driftEff * dt * DRIFT_RATE;
          for (let i = 0; i < 4; i++) phase[i] += adv * freq[i];

          effA = baseA + Math.sin(phase[0]) * ampEff;
          effB = baseB + Math.sin(phase[1]) * ampEff;
          effC = baseC + Math.sin(phase[2]) * ampEff;
          effD = baseD + Math.sin(phase[3]) * ampEff;

          // Slow per-frame fade so the cloud accumulates and breathes.
          const keep = 1 - fade;
          for (let i = 0; i < acc.length; i++) acc[i] *= keep;

          // Cache the global generative palette LUT once per frame; iterate()
          // indexes it by displacement t for the point color source.
          frameLUT = Substrate.rampLUT();

          iterate(effA, effB, effC, effD, iterations);
          tonemap();
          render();
        },

        // Restart the composition from a new seed: new orbit + drift phases,
        // and clear the accumulation buffer so the cloud rebuilds fresh.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          seedState(curSeed);
          if (acc) acc.fill(0);
        },

        // Window resized: rebuild the size-dependent accumulation buffer.
        resize() {
          buildBuffer();
        },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): normalized spread/coverage of the cloud in [0,1] — how much
        // of the frame is currently lit. Rises as the attractor fills space.
        emit() {
          const v = coverage * 3.5; // typical filament coverage ~10-25% -> scale
          return v < 0 ? 0 : v > 1 ? 1 : v;
        },

        // absorb(signal): couple to an external scalar in [0,1] (0.5 neutral).
        // Stored in extDrive and applied as a bounded morph-speed nudge.
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? clamp(s, 0, 1) : 0.5;
        },

        readouts() {
          return {
            ITER: (params.iterations | 0).toLocaleString(),
            PARAMS: effA.toFixed(2) + ',' + effB.toFixed(2) + ',' +
                    effC.toFixed(2) + ',' + effD.toFixed(2),
            SPREAD: (coverage * 100).toFixed(1) + '%',
          };
        },
      };
    },
  });
})();
