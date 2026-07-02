/* ============================================================
   EQUILIBRIA · Cartridge 04 — LENIA  (soft artificial life)

   Continuous cellular automaton (Bert Chan's Lenia). Canonical
   "Orbium unicaudatus" glider: R=13, dt=0.10, mu=0.15, sigma=0.017.
   Smooth ring kernel (sum-normalized to 1), Gaussian growth
   G(u) = 2*exp(-(u-mu)^2 / 2 sigma^2) - 1, update
   A = clip(A + dt*G(K*A), 0, 1) on a toroidal grid.

   Ported to the Substrate cartridge contract. The shell supplies
   the canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  // --- canonical Orbium seed (20x20 continuous pattern, values in [0,1]) ---
  const ORBIUM = [
    [0,0,0,0,0,0,0.1,0.14,0.1,0,0,0.03,0.03,0,0,0.3,0,0,0,0],
    [0,0,0,0,0,0.08,0.24,0.3,0.3,0.18,0.14,0.15,0.16,0.15,0.09,0.2,0,0,0,0],
    [0,0,0,0,0,0.15,0.34,0.44,0.46,0.38,0.18,0.14,0.11,0.13,0.19,0.18,0.45,0,0,0],
    [0,0,0,0,0.06,0.13,0.39,0.5,0.5,0.37,0.06,0,0,0,0.02,0.16,0.68,0,0,0],
    [0,0,0,0.11,0.17,0.17,0.33,0.4,0.38,0.28,0.14,0,0,0,0,0,0.18,0.42,0,0],
    [0,0,0.09,0.18,0.13,0.06,0.08,0.26,0.32,0.32,0.27,0,0,0,0,0,0,0.82,0,0],
    [0.27,0,0.16,0.12,0,0,0,0.25,0.38,0.44,0.45,0.34,0,0,0,0,0,0.22,0.17,0],
    [0,0.07,0.2,0.02,0,0,0,0.31,0.48,0.57,0.6,0.57,0,0,0,0,0,0,0.49,0],
    [0,0.59,0.19,0,0,0,0,0.2,0.57,0.69,0.76,0.76,0.49,0,0,0,0,0,0.36,0],
    [0,0.58,0.19,0,0,0,0,0,0.67,0.83,0.9,0.92,0.87,0.12,0,0,0,0,0.22,0.07],
    [0,0,0.46,0,0,0,0,0,0.7,0.93,1,1,1,0.61,0,0,0,0,0.18,0.11],
    [0,0,0.82,0,0,0,0,0,0.47,1,1,0.98,1,0.96,0.27,0,0,0,0.19,0.1],
    [0,0,0.46,0,0,0,0,0,0.25,0.83,0.95,0.98,1,1,0.84,0,0,0,0.21,0.05],
    [0,0,0,0.4,0,0,0,0,0.09,0.8,1,0.82,0.8,0.85,0.63,0.31,0.18,0.19,0.2,0.01],
    [0,0,0,0.36,0.1,0,0,0,0.05,0.54,0.86,0.79,0.74,0.72,0.6,0.39,0.28,0.24,0.13,0],
    [0,0,0,0.01,0.3,0.07,0,0,0.08,0.36,0.64,0.7,0.64,0.6,0.51,0.39,0.29,0.19,0.04,0],
    [0,0,0,0,0.1,0.24,0.14,0.1,0.15,0.29,0.45,0.53,0.52,0.46,0.4,0.31,0.21,0.08,0,0],
    [0,0,0,0,0,0.08,0.21,0.21,0.22,0.29,0.36,0.39,0.37,0.33,0.26,0.18,0.09,0,0,0],
    [0,0,0,0,0,0,0.03,0.13,0.19,0.22,0.24,0.24,0.23,0.18,0.13,0.05,0,0,0,0],
    [0,0,0,0,0,0,0,0,0.02,0.06,0.08,0.09,0.07,0.05,0.01,0,0,0,0,0]
  ];

  const R = 13;                 // kernel radius (cells) — canonical Orbium
  const TARGET_SHORT = 120;     // sim cells on the shorter canvas axis
  const STEPS_PER_FRAME = 1;

  // --- smooth ring kernel: K(r)=exp(4 - 1/(r(1-r))) for 0<r<1, sum -> 1 ---
  // Sparse offset list [dx, dy, weight, ...] for fast toroidal convolution.
  const KERNEL = (() => {
    const offs = [];
    let sum = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const r = Math.hypot(dx, dy) / R;
        if (r > 0 && r < 1) {
          const w = Math.exp(4 - 1 / (r * (1 - r)));
          offs.push(dx, dy, w);
          sum += w;
        }
      }
    }
    for (let i = 2; i < offs.length; i += 3) offs[i] /= sum; // normalize to 1
    return new Float64Array(offs);
  })();
  const KOFFS = KERNEL.length / 3;

  // Colors now come from the studio's GLOBAL generative palette via
  // Substrate.rampLUT() (sampled per-frame in render()). The default palette
  // is thermal->verdant, so the base look is ~unchanged; shuffle/drift of the
  // global palette recolors this cartridge live. No local ramp is defined.

  Substrate.register({
    id: 'lenia',
    name: 'Lenia',
    blurb: 'soft artificial life',
    tags: ['life', 'continuous-ca', 'orbium'],

    // Knobs — read LIVE inside step(). Defaults = known-stable Orbium set.
    params: {
      mu:        { label: 'Growth μ',   min: 0.10,  max: 0.30, step: 0.001, default: 0.15  },
      sigma:     { label: 'Growth σ',   min: 0.008, max: 0.04, step: 0.001, default: 0.017 },
      dt:        { label: 'Time-step',  min: 0.02,  max: 0.25, step: 0.01,  default: 0.10  },
      organisms: { label: 'Organisms',  min: 1,     max: 12,   step: 1,     default: 4, int: true },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen sim grid we colorize then blit scaled-up for the soft look.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let W = 0, H = 0;          // sim grid dimensions
      let A = null, B = null;    // ping-pong state buffers
      let img = null;            // ImageData for the grid
      let mass = 0, minMass = 0;
      let reseeding = false;

      let curSeed = seed >>> 0;
      let curOrganisms = params.organisms | 0;

      // --- optional cross-cartridge coupling ---
      // extDrive === null  => no coupling, behavior is exactly as standalone.
      // Otherwise a scalar in [0,1] (0.5 neutral) that nudges the growth
      // center mu within a clamped safe band around the stable Orbium value.
      let extDrive = null;

      // Stamp one canonical orbium at (ox,oy) with rotation rot (0..3).
      function stampOrbium(ox, oy, rot) {
        const ph = ORBIUM.length, pw = ORBIUM[0].length;
        for (let y = 0; y < ph; y++) {
          for (let x = 0; x < pw; x++) {
            const v = ORBIUM[y][x];
            if (v <= 0) continue;
            let px, py;
            switch (rot & 3) {
              case 1: px = y;          py = pw - 1 - x; break;
              case 2: px = pw - 1 - x; py = ph - 1 - y; break;
              case 3: px = ph - 1 - y; py = x;          break;
              default: px = x;         py = y;
            }
            const gx = ((ox + px) % W + W) % W;
            const gy = ((oy + py) % H + H) % H;
            A[gy * W + gx] = v;
          }
        }
      }

      // Seed n orbia at deterministic pseudo-random positions/rotations.
      function seedWorld(seedVal, n) {
        A.fill(0);
        const rng = Substrate.rng(seedVal >>> 0);
        const count = Math.max(1, n | 0);
        for (let i = 0; i < count; i++) {
          const ox = (rng() * W) | 0;
          const oy = (rng() * H) | 0;
          const rot = (rng() * 4) | 0;
          stampOrbium(ox, oy, rot);
        }
      }

      function buildWorld() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) { H = TARGET_SHORT; W = Math.round(TARGET_SHORT * aspect); }
        else             { W = TARGET_SHORT; H = Math.round(TARGET_SHORT / aspect); }
        grid.width = W; grid.height = H;
        img = gctx.createImageData(W, H);
        A = new Float32Array(W * H);
        B = new Float32Array(W * H);
        minMass = (W * H) * 0.0008;
        seedWorld(curSeed, curOrganisms);
      }

      // One Lenia update: A = clip(A + dt*G(K*A), 0, 1). Reads mu/sigma/dt live.
      function update(mu, sigma, dt) {
        const k = KERNEL, ko = KOFFS;
        const inv2s2 = 1 / (2 * sigma * sigma);
        for (let y = 0; y < H; y++) {
          const rowBase = y * W;
          for (let x = 0; x < W; x++) {
            let u = 0;
            for (let i = 0, j = 0; i < ko; i++, j += 3) {
              const sx = ((x + k[j]) % W + W) % W;
              const sy = ((y + k[j + 1]) % H + H) % H;
              u += A[sy * W + sx] * k[j + 2];
            }
            const d = u - mu;
            const g = 2 * Math.exp(-(d * d) * inv2s2) - 1; // Gaussian growth
            let v = A[rowBase + x] + dt * g;
            v = v < 0 ? 0 : v > 1 ? 1 : v;
            B[rowBase + x] = v;
          }
        }
        const t = A; A = B; B = t; // swap ping-pong
      }

      // Colorize the grid, blit scaled-up with smoothing + a green bloom pass.
      function render() {
        const data = img.data;
        // Global generative palette: fetch the 256-entry RGB LUT once per
        // frame, then index it by the same t = cell-value mapping as before.
        const LUT = Substrate.rampLUT();
        let m = 0;
        for (let i = 0, p = 0; i < A.length; i++, p += 4) {
          const a = A[i];
          m += a;
          const c = ((a * 255) | 0) * 3;
          data[p]     = LUT[c];
          data[p + 1] = LUT[c + 1];
          data[p + 2] = LUT[c + 2];
          data[p + 3] = 255;
        }
        mass = m;
        gctx.putImageData(img, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // base layer, smoothed for the soft organic look
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);

        // additive warm-green bloom / glow
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55;
        ctx.filter = 'blur(' + Math.max(6, cw * 0.012) + 'px)';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      buildWorld();

      return {
        step() {
          // Read knobs live every frame; the shell mutates params in place.
          let mu = params.mu;
          const sigma = params.sigma, dt = params.dt;

          // Optional coupling: nudge the effective growth center from an
          // external signal, clamped to a viable band so life stays alive.
          // When extDrive === null this branch is skipped entirely and the
          // dynamics are byte-for-byte identical to standalone.
          if (extDrive !== null) {
            const muEff = mu + (extDrive - 0.5) * 0.02;
            mu = muEff < 0.12 ? 0.12 : muEff > 0.20 ? 0.20 : muEff;
          }

          // Changing the organism count reseeds with that many.
          if ((params.organisms | 0) !== curOrganisms) {
            curOrganisms = params.organisms | 0;
            seedWorld(curSeed, curOrganisms);
          }

          for (let s = 0; s < STEPS_PER_FRAME; s++) update(mu, sigma, dt);
          render();

          // Auto-reseed when order dissolves (mass collapses) — runs forever.
          // Also guards live mu/sigma edits that push dynamics off the stable
          // manifold and kill the population.
          reseeding = mass < minMass;
          if (reseeding) {
            curSeed = (curSeed + 0x9e3779b9) >>> 0;
            seedWorld(curSeed, curOrganisms);
          }
        },

        // Restart the world from a new seed; re-seeds the organisms.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          curOrganisms = params.organisms | 0;
          seedWorld(curSeed, curOrganisms);
        },

        // Window resized: the canvas backing store is already resized by the
        // shell, and render() reads canvas.width/height live to recompute the
        // scaled blit. The sim grid stays fixed (no re-init, no distortion of
        // dynamics), so nothing to rebuild here.
        resize() { /* scaled blit recomputed live in render() */ },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): this system's vitality output in [0,1], derived from the
        // MASS readout normalized by grid area and clamped. Higher = denser,
        // healthier population; approaches 0 as order dissolves.
        emit() {
          const area = (W * H) || 1;
          const v = mass / (area * 0.02); // avg cell value 0.02 -> full scale
          return v < 0 ? 0 : v > 1 ? 1 : v;
        },

        // absorb(signal): couple to an external scalar in [0,1] (0.5 neutral).
        // Stored in extDrive and applied as a bounded mu nudge in step().
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          return {
            R: R,
            MU: params.mu.toFixed(3),
            SIGMA: params.sigma.toFixed(3),
            MASS: mass.toFixed(1),
            ORGANISMS: curOrganisms,
            STATE: reseeding ? 'RESEEDING' : 'SELF-SUSTAINING',
          };
        },
      };
    },
  });
})();
