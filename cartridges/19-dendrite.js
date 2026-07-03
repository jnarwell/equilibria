/* ============================================================
   EQUILIBRIA · Cartridge 19 — DENDRITE  (solidification microstructure)

   An undercooled melt freezing into dendrites and grains — the
   microstructure of a solidifying alloy, as a solidification
   cellular automaton on a fixed grid. Standard, generic textbook
   physics (nothing proprietary): a two-phase field (LIQUID/SOLID)
   coupled to a diffusing thermal / undercooling field.

   Each cell is LIQUID or SOLID. A handful of N crystalline nuclei
   are seeded from Substrate.rng, each with its own crystallographic
   orientation θ. A liquid cell touching solid freezes with a
   probability set by (a) the local UNDERCOOLING (driving force) and
   (b) ANISOTROPY — growth is fastest along the crystal's preferred
   axes, modeled as a 4-fold factor 1 + A·cos(4·(φ − θ)) where φ is
   the growth direction and θ the neighbouring grain's orientation.
   That directional bias is what turns blobs into branching dendrite
   arms with side-branches.

   A TEMPERATURE / undercooling field diffuses every step. LATENT
   heat is released at the freezing front (a just-frozen cell warms
   locally), which reduces the local undercooling and slows nearby
   growth — the Mullins–Sekerka feedback that drives tip-splitting
   and side-branching rather than a smooth interface. Grains grown
   from separate nuclei collide and lock into GRAIN BOUNDARIES, a
   real polycrystalline casting in miniature.

   Cells are coloured by thermal history: just-frozen tips ride the
   hot end of the ramp, older interior cools toward the base. When
   the melt is fully solid it fades and a fresh melt re-nucleates, so
   the casting loops forever.

   Conforms to the Substrate cartridge contract. The shell supplies
   the canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  const TARGET_LONG = 380;   // sim cells on the LONGER canvas axis
  const GROWTH_RATE = 0.60;  // base front-advance scale
  const LATENT      = 0.55;  // latent heat dumped into a cell on freezing
  const HEAT_CAP    = 1.60;  // ceiling on the local temperature field
  const COOL        = 0.004; // slow ambient heat loss (keeps the melt undercooled)
  const TAU         = 90;    // recency decay (steps) for the hot-tip colour trail
  const HOLD_MS     = 2000;  // dwell on a finished casting before re-melting
  const MAX_NUCLEI  = 40;

  // 8-neighbourhood: growth directions φ (from a solid neighbour toward the
  // candidate liquid cell) and a distance weight (diagonals grow slower).
  // Offsets are (ndx,ndy) of the NEIGHBOUR relative to the cell, so the growth
  // vector cell←neighbour is (−ndx,−ndy).
  const NB = (function () {
    const raw = [
      [ 1, 0], [-1, 0], [0, 1], [0, -1],
      [ 1, 1], [ 1,-1], [-1, 1], [-1,-1],
    ];
    return raw.map(([ndx, ndy]) => {
      const phi = Math.atan2(-ndy, -ndx);      // growth direction
      const axis = (ndx === 0 || ndy === 0);
      return {
        ndx, ndy,
        c4: Math.cos(4 * phi),                 // for cos(4(φ−θ)) via angle-add
        s4: Math.sin(4 * phi),
        w: axis ? 1.0 : 0.68,
      };
    });
  })();

  // Colours come from the studio GLOBAL generative palette (Substrate.rampLUT),
  // sampled once per frame in render(). Default palette is thermal→verdant, so
  // the base look reads as part of the same body of work; shuffle/drift recolors.

  Substrate.register({
    id: 'dendrite',
    name: 'Dendrite',
    blurb: 'undercooled melt freezing to grains',
    tags: ['solidification', 'crystal-growth', 'cellular-automaton'],

    // Knobs — read LIVE inside step().
    params: {
      undercooling: { label: 'Undercooling', min: 0.1,  max: 1.0,  step: 0.01, default: 0.5  },
      anisotropy:   { label: 'Anisotropy',   min: 0.0,  max: 1.0,  step: 0.01, default: 0.6  },
      nuclei:       { label: 'Nuclei',       min: 1,    max: 40,   step: 1,    default: 10, int: true },
      noise:        { label: 'Thermal noise',min: 0.0,  max: 0.3,  step: 0.005,default: 0.08 },
      diffusion:    { label: 'Heat diffusion',min: 0.05, max: 0.4, step: 0.01, default: 0.18 },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen sim grid we colorize then blit scaled-up.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let W = 0, H = 0, N = 0;
      let solid = null;        // Uint8Array  0 = liquid, 1 = solid
      let grainArr = null;     // Int16Array  grain id per cell (−1 = liquid)
      let temp = null;         // Float32Array thermal / reheat field
      let tempNext = null;     // diffusion double buffer
      let froze = null;        // Float32Array step at which a cell solidified
      let img = null;          // ImageData for the grid

      // per-grain 4-fold orientation basis: cos(4θ), sin(4θ)
      const grainCos4 = new Float32Array(MAX_NUCLEI);
      const grainSin4 = new Float32Array(MAX_NUCLEI);

      // simultaneous-update batch (collect freezes, then apply)
      let batchIdx = null, batchGrain = null, batchCnt = 0;

      let rand = null;         // persistent deterministic PRNG stream
      let curSeed = seed >>> 0;
      let solidCount = 0;
      let grainCount = 0;
      let stepCounter = 0;
      let phase = 'FREEZING';  // 'FREEZING' | 'SOLID'
      let holdTimer = 0;

      // --- optional cross-cartridge coupling ---
      // extDrive === null => standalone, dynamics byte-identical to no coupling.
      // Otherwise a scalar in [0,1] (0.5 neutral): a bounded nudge to the
      // effective undercooling — a higher incoming signal freezes FASTER.
      let extDrive = null;

      function effectiveUndercooling() {
        let U = params.undercooling;
        if (extDrive !== null) U += (extDrive - 0.5) * 0.6;   // ±0.3 bounded nudge
        if (U < 0.05) U = 0.05; else if (U > 1.2) U = 1.2;
        return U;
      }

      // Drop a fresh set of nuclei into a fully-liquid, undercooled melt.
      // Draws from the persistent PRNG stream so the infinite loop of castings
      // is fully reproducible from the seed.
      function newMelt() {
        solid.fill(0);
        grainArr.fill(-1);
        temp.fill(0);
        froze.fill(0);
        solidCount = 0;
        stepCounter = 0;
        phase = 'FREEZING';
        holdTimer = 0;

        let want = params.nuclei | 0;
        if (want < 1) want = 1; else if (want > MAX_NUCLEI) want = MAX_NUCLEI;
        grainCount = want;
        for (let g = 0; g < want; g++) {
          const theta = rand() * Math.PI * 2;
          grainCos4[g] = Math.cos(4 * theta);
          grainSin4[g] = Math.sin(4 * theta);
          const i = (rand() * N) | 0;
          if (solid[i]) continue;               // rare collision: skip placement
          solid[i] = 1;
          grainArr[i] = g;
          froze[i] = 0;
          solidCount++;
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

        solid = new Uint8Array(N);
        grainArr = new Int16Array(N);
        temp = new Float32Array(N);
        tempNext = new Float32Array(N);
        froze = new Float32Array(N);
        batchIdx = new Int32Array(N);
        batchGrain = new Int32Array(N);

        rand = Substrate.rng(curSeed);
        newMelt();
      }

      // One growth pass: scan liquid cells, decide freezes from the CURRENT
      // solid state (simultaneous update via a batch), then apply. Reads the
      // undercooling / anisotropy / noise knobs live.
      function grow() {
        const effU = effectiveUndercooling();
        const A = params.anisotropy;
        const noiseP = params.noise;
        batchCnt = 0;

        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const i = row + x;
            if (solid[i]) continue;

            // local driving force, reduced by any latent reheating here
            let localU = effU * (1 - temp[i]);
            if (localU <= 0) continue;
            if (localU > 1.2) localU = 1.2;

            // pick the solid neighbour giving the strongest (anisotropic) growth
            let best = 0, bestGrain = -1;
            for (let d = 0; d < 8; d++) {
              const nb = NB[d];
              const nx = x + nb.ndx, ny = y + nb.ndy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              const ni = ny * W + nx;
              if (!solid[ni]) continue;
              const g = grainArr[ni];
              // cos(4(φ−θ)) = cos4φ·cos4θ + sin4φ·sin4θ  (no trig in the hot loop)
              const cos4 = nb.c4 * grainCos4[g] + nb.s4 * grainSin4[g];
              let aniso = 1 + A * cos4;
              if (aniso < 0) aniso = 0;
              const p = GROWTH_RATE * localU * aniso * nb.w;
              if (p > best) { best = p; bestGrain = g; }
            }
            if (bestGrain < 0) continue;

            // thermal fluctuation seeds side-branches
            let p = best * (1 + (rand() * 2 - 1) * noiseP);
            if (p > 0.95) p = 0.95;
            if (rand() < p) {
              batchIdx[batchCnt] = i;
              batchGrain[batchCnt] = bestGrain;
              batchCnt++;
            }
          }
        }

        // apply the batch: solidify, inherit grain, release latent heat
        for (let b = 0; b < batchCnt; b++) {
          const i = batchIdx[b];
          if (solid[i]) continue;
          solid[i] = 1;
          grainArr[i] = batchGrain[b];
          froze[i] = stepCounter;
          let t = temp[i] + LATENT;
          if (t > HEAT_CAP) t = HEAT_CAP;
          temp[i] = t;
          solidCount++;
        }
      }

      // Diffuse the thermal field (explicit 5-point Laplacian, Neumann edges)
      // with a slow ambient cool. Sub-steps keep the scheme stable for large D.
      function diffuse() {
        const D = params.diffusion;
        const passes = D > 0.24 ? 2 : 1;
        const dEff = D / passes;
        const keep = 1 - COOL;
        for (let ppass = 0; ppass < passes; ppass++) {
          for (let y = 0; y < H; y++) {
            const row = y * W;
            const up = (y > 0 ? row - W : row);
            const dn = (y < H - 1 ? row + W : row);
            for (let x = 0; x < W; x++) {
              const i = row + x;
              const il = (x > 0 ? i - 1 : i);
              const ir = (x < W - 1 ? i + 1 : i);
              const c = temp[i];
              const lap = temp[il] + temp[ir] + temp[up + x] + temp[dn + x] - 4 * c;
              let v = (c + dEff * lap) * keep;
              if (v < 0) v = 0;
              tempNext[i] = v;
            }
          }
          const swap = temp; temp = tempNext; tempNext = swap;
        }
      }

      // Colorize by thermal history through the GLOBAL palette, sampled ONCE
      // per frame into a 256-entry RGB LUT. Solid cells: recency (just-frozen
      // tips hot, old interior cool). Liquid: dark, glowing where latent heat
      // lingers at the front. Differing-grain contacts darken to grain lines.
      function render() {
        const data = img.data;
        const LUT = Substrate.rampLUT();
        const now = stepCounter;

        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const i = row + x;
            let t;
            if (solid[i]) {
              const rec = Math.exp(-(now - froze[i]) / TAU);   // 1 recent → 0 old
              t = 0.33 + 0.62 * rec;
              // grain boundary: differing solid neighbour to the right / below
              const gi = grainArr[i];
              const rgt = (x < W - 1) && solid[i + 1] && grainArr[i + 1] !== gi;
              const bel = (y < H - 1) && solid[i + W] && grainArr[i + W] !== gi;
              if (rgt || bel) t *= 0.35;
            } else {
              let tc = temp[i];
              if (tc > 1) tc = 1;
              t = 0.04 + 0.18 * tc;
            }
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const c = ((t * 255) | 0) * 3;
            const p = i * 4;
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

        // crisp base: nearest-neighbour so the dendrite arms stay sharp
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);

        // additive bloom so hot tips glow
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.26;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(' + Math.max(3, cw * 0.006) + 'px)';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';

        // fade the finished casting out before it re-melts
        if (phase === 'SOLID') {
          let a = (holdTimer - HOLD_MS * 0.4) / (HOLD_MS * 0.6);
          if (a < 0) a = 0; else if (a > 1) a = 1;
          if (a > 0) {
            ctx.globalAlpha = a * 0.9;
            ctx.fillStyle = '#0a0e0b';
            ctx.fillRect(0, 0, cw, ch);
            ctx.globalAlpha = 1;
          }
        }
      }

      buildWorld();

      return {
        step(dt) {
          if (phase === 'FREEZING') {
            grow();
            diffuse();
            stepCounter++;
            if (solidCount >= N * 0.999) { phase = 'SOLID'; holdTimer = 0; }
          } else {
            // finished casting: keep relaxing the thermal field while it fades
            diffuse();
            holdTimer += (dt || 16);
            if (holdTimer > HOLD_MS) {
              curSeed = (curSeed + 0x9e3779b9) >>> 0;   // advance for a new casting
              newMelt();                                // reuses the same PRNG stream
            }
          }
          render();
        },

        // Restart from a new seed: a fresh undercooled melt with new nuclei.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          rand = Substrate.rng(curSeed);
          newMelt();
        },

        // Window resized: canvas backing store already resized by the shell.
        // Grid re-scales to the new aspect (this restarts the casting geometry).
        resize() {
          buildWorld();
        },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): solid fraction in [0,1] — 0 fresh melt, 1 fully solidified.
        emit() {
          const f = N ? solidCount / N : 0;
          return f < 0 ? 0 : f > 1 ? 1 : f;
        },

        // absorb(signal): store a scalar in [0,1] (0.5 neutral). Applied as a
        // bounded nudge to the effective undercooling in step() — higher = faster.
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          const pct = N ? (solidCount / N) * 100 : 0;
          return {
            SOLID: pct.toFixed(1) + '%',
            GRAINS: grainCount,
            STATE: phase,
          };
        },
      };
    },
  });
})();
