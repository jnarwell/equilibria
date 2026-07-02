/* ============================================================
   EQUILIBRIA · Cartridge 12 — ISING  (order/disorder transition)

   2D Ising model of a ferromagnet, evolved by the Metropolis
   Monte Carlo algorithm — statistical mechanics itself. A grid
   of spins s ∈ {+1,-1} on a torus. Neighbor agreement lowers
   energy (ferromagnetic coupling J). Each frame does many
   single-spin-flip trials: pick a random site, compute
   dE = 2·J·s·(Σ 4 neighbors) + 2·h·s, and flip if dE ≤ 0, else
   with probability exp(-dE/T) (the Boltzmann factor).

   Below the Onsager critical temperature Tc = 2/ln(1+√2) ≈ 2.269
   (for J=1) large ordered domains grow and |magnetization| → 1;
   right AT Tc, scale-free fractal critical clusters appear; well
   above Tc, thermal noise wins and order dissolves. Dragging T
   through Tc live is the whole instrument.

   Ported to the Substrate cartridge contract. The shell supplies
   the canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  const TARGET_LONG = 360;      // sim cells on the LONGER canvas axis
  const TC_OVER_J = 2 / Math.log(1 + Math.SQRT2); // ≈ 2.2691853 (Onsager)

  // --- thermal -> verdant palette LUT ---------------------------------------
  // Spin −1 domain reads deep verdant; spin +1 domain reads hot amber; mixed
  // boundary cells land mid-ramp (phosphor/gold) so domain walls glow.
  const STOPS = [
    [0.00, [27, 77, 62]],     // deep verdant    #1b4d3e   (spin −1 domain)
    [0.20, [42, 157, 143]],   // verdigris       #2a9d8f
    [0.40, [0, 255, 156]],    // phosphor        #00ff9c
    [0.60, [212, 160, 23]],   // warm gold       #d4a017
    [0.80, [255, 123, 0]],    // amber           #ff7b00
    [1.00, [255, 77, 0]]      // hottest         #ff4d00   (spin +1 domain)
  ];
  const LUT = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = STOPS[0], b = STOPS[STOPS.length - 1];
    for (let s = 1; s < STOPS.length; s++) {
      if (t <= STOPS[s][0]) { a = STOPS[s - 1]; b = STOPS[s]; break; }
    }
    const f = (t - a[0]) / (b[0] - a[0] || 1);
    LUT[i * 3]     = a[1][0] + (b[1][0] - a[1][0]) * f;
    LUT[i * 3 + 1] = a[1][1] + (b[1][1] - a[1][1]) * f;
    LUT[i * 3 + 2] = a[1][2] + (b[1][2] - a[1][2]) * f;
  }

  Substrate.register({
    id: 'ising',
    name: 'Ising',
    blurb: 'order/disorder transition',
    tags: ['statistical-mechanics', 'metropolis', 'phase-transition'],

    // Knobs — read LIVE inside step(). Default T = critical temperature.
    params: {
      T:      { label: 'Temperature', min: 0.2, max: 5,    step: 0.02, default: 2.27 },
      J:      { label: 'Coupling',    min: 0.2, max: 2,    step: 0.01, default: 1.0  },
      h:      { label: 'Field',       min: -1,  max: 1,    step: 0.01, default: 0.0  },
      sweeps: { label: 'Flips/frame', min: 500, max: 8000, step: 100,  default: 3000, int: true },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen sim grid we colorize then blit scaled-up.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let W = 0, H = 0, N = 0;   // sim grid dimensions / cell count
      let spins = null;          // Int8Array of ±1
      let img = null;            // ImageData for the grid
      let spinSum = 0;           // running Σ spin  → magnetization = spinSum/N
      let rand = null;           // persistent deterministic PRNG stream
      let curSeed = seed >>> 0;

      // --- optional cross-cartridge coupling ---
      // extDrive === null  => no coupling, dynamics byte-identical to standalone.
      // Otherwise a scalar in [0,1] (0.5 neutral). INVERTED onto temperature:
      // a higher incoming signal COOLS the lattice (more order), a lower signal
      // heats it — a clamped nudge to the effective T used this frame.
      let extDrive = null;

      // Seed a fresh hot (fully disordered) lattice from the PRNG stream.
      function seedWorld(seedVal) {
        rand = Substrate.rng(seedVal >>> 0);
        spinSum = 0;
        for (let i = 0; i < N; i++) {
          const s = rand() < 0.5 ? -1 : 1;
          spins[i] = s;
          spinSum += s;
        }
      }

      function buildWorld() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) { W = TARGET_LONG; H = Math.max(2, Math.round(TARGET_LONG / aspect)); }
        else             { H = TARGET_LONG; W = Math.max(2, Math.round(TARGET_LONG * aspect)); }
        N = W * H;
        grid.width = W; grid.height = H;
        img = gctx.createImageData(W, H);
        spins = new Int8Array(N);
        seedWorld(curSeed);
      }

      // One frame of Metropolis Monte Carlo: `trials` random single-spin flips.
      // Reads Teff/J/h live. The accept probability depends only on (s, nsum)
      // where nsum ∈ {−4,−2,0,2,4}, so we precompute the 2×5 Boltzmann table
      // once per frame instead of calling exp() thousands of times.
      function metropolis(Teff, J, h, trials) {
        const invT = 1 / (Teff > 1e-6 ? Teff : 1e-6);
        // boltz[sIdx][ (nsum+4)/2 ] = accept prob for dE = 2·s·(J·nsum + h)
        const boltz = [new Float64Array(5), new Float64Array(5)];
        for (let si = 0; si < 2; si++) {
          const s = si === 0 ? -1 : 1;
          for (let k = 0; k < 5; k++) {
            const nsum = k * 2 - 4;              // −4,−2,0,2,4
            const dE = 2 * s * (J * nsum + h);
            boltz[si][k] = dE <= 0 ? 1 : Math.exp(-dE * invT);
          }
        }
        for (let n = 0; n < trials; n++) {
          const i = (rand() * N) | 0;
          const x = i % W;
          const y = (i - x) / W;
          const xl = x === 0 ? W - 1 : x - 1;
          const xr = x === W - 1 ? 0 : x + 1;
          const yu = y === 0 ? H - 1 : y - 1;
          const yd = y === H - 1 ? 0 : y + 1;
          const nsum = spins[y * W + xl] + spins[y * W + xr] +
                       spins[yu * W + x] + spins[yd * W + x];
          const s = spins[i];
          const p = boltz[s === 1 ? 1 : 0][(nsum + 4) >> 1];
          if (p >= 1 || rand() < p) {
            spins[i] = -s;
            spinSum -= 2 * s;   // Δ(Σ) = (−s) − s = −2s
          }
        }
      }

      // Colorize via a locally-smoothed spin field so domains read as solid
      // colour and domain walls (mixed neighbourhoods) glow mid-ramp.
      function render() {
        const data = img.data;
        for (let y = 0; y < H; y++) {
          const yu = y === 0 ? H - 1 : y - 1;
          const yd = y === H - 1 ? 0 : y + 1;
          const rb = y * W, ub = yu * W, db = yd * W;
          for (let x = 0; x < W; x++) {
            const xl = x === 0 ? W - 1 : x - 1;
            const xr = x === W - 1 ? 0 : x + 1;
            // 5-cell agreement in [−5,5] → u in [0,1]
            const sum5 = spins[rb + x] + spins[rb + xl] + spins[rb + xr] +
                         spins[ub + x] + spins[db + x];
            let u = (sum5 + 5) * 0.1;            // (sum5/5 + 1)/2
            if (u < 0) u = 0; else if (u > 1) u = 1;
            const c = ((u * 255) | 0) * 3;
            const p = (rb + x) * 4;
            data[p]     = LUT[c];
            data[p + 1] = LUT[c + 1];
            data[p + 2] = LUT[c + 2];
            data[p + 3] = 255;
          }
        }
        gctx.putImageData(img, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // crisp base: nearest-neighbour so the lattice stays sharp
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);

        // subtle additive bloom so domain walls glow
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.28;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(' + Math.max(3, cw * 0.006) + 'px)';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // Effective temperature for this frame, applying the optional coupling.
      function effectiveT() {
        const T = params.T;
        if (extDrive === null) return T;          // standalone: exactly params.T
        // Higher signal → cooler (more order). Bounded ±0.9 nudge, clamped safe.
        let Teff = T + (0.5 - extDrive) * 1.8;
        if (Teff < 0.2) Teff = 0.2; else if (Teff > 5) Teff = 5;
        return Teff;
      }

      buildWorld();

      return {
        step() {
          // Read knobs live every frame; the shell mutates params in place.
          const J = params.J, h = params.h;
          const trials = params.sweeps | 0;
          metropolis(effectiveT(), J, h, trials);
          render();
        },

        // Restart from a new seed: a fresh hot, disordered lattice.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          seedWorld(curSeed);
        },

        // Window resized: canvas backing store already resized by the shell.
        // Grid re-scales to the new aspect (re-seeds — a resize is a restart of
        // the lattice geometry, not of the physics knobs).
        resize() {
          buildWorld();
        },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): order parameter |magnetization| = |mean spin| in [0,1].
        // → 1 in an ordered (aligned) phase, → 0 in the disordered phase.
        emit() {
          const m = N ? Math.abs(spinSum / N) : 0;
          return m < 0 ? 0 : m > 1 ? 1 : m;
        },

        // absorb(signal): store a scalar in [0,1] (0.5 neutral). Applied as a
        // clamped, INVERTED nudge to the effective temperature in step().
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          const m = N ? spinSum / N : 0;
          const am = Math.abs(m);
          const Teff = effectiveT();
          const Tc = TC_OVER_J * params.J;       // critical T scales with J
          let phase;
          if (am > 0.5 && Teff < Tc * 0.96)      phase = 'ORDERED';
          else if (Math.abs(Teff - Tc) < Tc * 0.12) phase = 'CRITICAL';
          else                                   phase = 'DISORDERED';
          const mag = (m >= 0 ? '+' : '-') + am.toFixed(2);
          return {
            T: Teff.toFixed(2),
            TC: Tc.toFixed(2),
            MAG: mag,
            PHASE: phase,
          };
        },
      };
    },
  });
})();
