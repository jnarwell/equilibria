/* ============================================================
   EQUILIBRIA · Cartridge 05 — PHYSARUM  (slime-mold transport nets)

   Jones 2010 agent model. Thousands of agents crawl over a 2D
   trail-map grid. Each step an agent SENSES the trail at three
   points ahead (left / center / right, at a sensor angle and
   distance), STEERS toward the strongest, MOVES forward one cell,
   and DEPOSITS trail into its current cell. Every step the trail
   map DIFFUSES (3x3 blur) and DECAYS (multiply < 1). Agents
   self-organize into branching, vein-like transport networks
   that continuously reconfigure — efficient self-organizing
   return-networks.

   Ported to the Substrate cartridge contract: the shell supplies
   the canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  const LONG_AXIS = 440;   // trail-grid cells on the LONGER canvas axis
  const MAX_AGENTS = 12000; // hard pool ceiling (see agentCount knob max)
  const SPEED = 1.0;        // agent step length, in grid cells / step
  const TONE_K = 0.30;      // density -> brightness curve steepness

  // Colors come from the studio's GLOBAL generative palette
  // (window.Substrate.rampLUT()) — the default palette is thermal->verdant so
  // the base look is ~unchanged, while shuffle/drift recolors live. The LUT is
  // sampled once per frame (see render()) and indexed by the same tone-curve t
  // the trail density derives.

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  Substrate.register({
    id: 'physarum',
    name: 'Physarum',
    blurb: 'slime-mold transport networks',
    tags: ['agents', 'self-organizing', 'transport-net'],

    // Knobs — read LIVE inside step(); the shell mutates this object in place.
    params: {
      agentCount:  { label: 'Agents',       min: 1000, max: 12000, step: 100,  default: 7000, int: true },
      sensorAngle: { label: 'Sensor angle', min: 0.20, max: 1.20,  step: 0.01, default: 0.60 },
      sensorDist:  { label: 'Sensor dist',  min: 4,    max: 24,    step: 0.5,  default: 9 },
      turnSpeed:   { label: 'Turn speed',   min: 0.10, max: 1.20,  step: 0.01, default: 0.40 },
      deposit:     { label: 'Deposit',      min: 0.05, max: 1.00,  step: 0.01, default: 0.30 },
      decay:       { label: 'Decay',        min: 0.85, max: 0.99,  step: 0.005, default: 0.94 },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen grid canvas we colorize then blit scaled-up for the soft look.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let W = 0, H = 0;             // trail-grid dimensions
      let trail = null;            // Float32Array(W*H) — current trail map
      let blur = null;             // Float32Array(W*H) — diffusion scratch buffer
      let img = null;              // ImageData for the grid canvas

      // Agents as parallel arrays (structure-of-arrays for cache-friendliness).
      // The whole MAX_AGENTS pool is initialized deterministically at (re)seed;
      // the live agentCount knob just changes how many of them we STEP each
      // frame, so growing/shrinking is graceful AND fully reproducible.
      const ax = new Float32Array(MAX_AGENTS);   // x in grid cells
      const ay = new Float32Array(MAX_AGENTS);   // y in grid cells
      const ah = new Float32Array(MAX_AGENTS);   // heading (radians)

      let curSeed = seed >>> 0;
      let activeCount = clamp(params.agentCount | 0, 1, MAX_AGENTS);
      let meanDensity = 0;         // last measured mean trail (for emit/readout)
      let churn = 0;               // smoothed steering activity -> FORMING/STABLE

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; behavior byte-identical to standalone.
      // Otherwise a scalar in [0,1] (0.5 neutral); higher = more exploratory /
      // denser, applied as a BOUNDED nudge to effective sensorAngle + deposit.
      let extDrive = null;

      // Initialize the full agent pool from a seed: random positions + headings.
      function seedAgents(seedVal) {
        const rng = Substrate.rng(seedVal >>> 0);
        for (let i = 0; i < MAX_AGENTS; i++) {
          ax[i] = rng() * W;
          ay[i] = rng() * H;
          ah[i] = rng() * Math.PI * 2;
        }
      }

      function buildWorld() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) { W = LONG_AXIS; H = Math.max(1, Math.round(LONG_AXIS / aspect)); }
        else             { H = LONG_AXIS; W = Math.max(1, Math.round(LONG_AXIS * aspect)); }
        grid.width = W; grid.height = H;
        img = gctx.createImageData(W, H);
        trail = new Float32Array(W * H);
        blur = new Float32Array(W * H);
        seedAgents(curSeed);
      }

      // Toroidal trail sample at float (x,y) via nearest cell (fast, adequate).
      function sampleTrail(x, y) {
        let ix = Math.round(x) % W; if (ix < 0) ix += W;
        let iy = Math.round(y) % H; if (iy < 0) iy += H;
        return trail[iy * W + ix];
      }

      // One agent update pass: sense -> steer -> move -> deposit.
      // Reads effective (already-nudged) knob values passed in.
      function stepAgents(sAngle, sDist, turn, dep) {
        let steers = 0;
        const n = activeCount;
        for (let i = 0; i < n; i++) {
          const x = ax[i], y = ay[i], h = ah[i];

          // Three sensors ahead: center, left, right.
          const cX = x + Math.cos(h) * sDist,           cY = y + Math.sin(h) * sDist;
          const lX = x + Math.cos(h - sAngle) * sDist,  lY = y + Math.sin(h - sAngle) * sDist;
          const rX = x + Math.cos(h + sAngle) * sDist,  rY = y + Math.sin(h + sAngle) * sDist;
          const c = sampleTrail(cX, cY);
          const l = sampleTrail(lX, lY);
          const r = sampleTrail(rX, rY);

          // Steer toward the strongest sensor (Jones 2010 rule set).
          let nh = h;
          if (c > l && c > r) {
            // keep heading — following an established vein
          } else if (l > r) {
            nh = h - turn; steers++;
          } else if (r > l) {
            nh = h + turn; steers++;
          } else {
            // l === r (often both zero): small deterministic wiggle to explore.
            nh = h + (((i * 2654435761) & 1) ? turn : -turn) * 0.5;
            steers++;
          }
          ah[i] = nh;

          // Move forward one step, wrapping toroidally.
          let mx = x + Math.cos(nh) * SPEED;
          let my = y + Math.sin(nh) * SPEED;
          mx %= W; if (mx < 0) mx += W;
          my %= H; if (my < 0) my += H;
          ax[i] = mx; ay[i] = my;

          // Deposit trail into the current cell.
          const ci = ((my | 0) * W + (mx | 0));
          trail[ci] += dep;
        }
        // Smoothed fraction of agents that turned this step (network activity).
        churn += (((n ? steers / n : 0)) - churn) * 0.1;
      }

      // Diffuse (3x3 box blur) then decay the whole trail map. Also accumulates
      // the mean density used by emit()/readouts(). Toroidal edges.
      function diffuseDecay(decay) {
        let sum = 0;
        for (let y = 0; y < H; y++) {
          const y0 = ((y - 1 + H) % H) * W;
          const y1 = y * W;
          const y2 = ((y + 1) % H) * W;
          for (let x = 0; x < W; x++) {
            const xl = (x - 1 + W) % W;
            const xr = (x + 1) % W;
            const s =
              trail[y0 + xl] + trail[y0 + x] + trail[y0 + xr] +
              trail[y1 + xl] + trail[y1 + x] + trail[y1 + xr] +
              trail[y2 + xl] + trail[y2 + x] + trail[y2 + xr];
            const v = (s * 0.111111) * decay; // mean of 9 neighbors, then decay
            blur[y1 + x] = v;
            sum += v;
          }
        }
        // swap: blurred+decayed map becomes the live trail
        const t = trail; trail = blur; blur = t;
        meanDensity = sum / (W * H || 1);
      }

      // Colorize the trail with a saturating tone curve, blit scaled-up with
      // smoothing plus an additive bloom pass for the phosphor glow.
      function render() {
        const data = img.data;
        // Global generative palette: fetch the 256-entry RGB LUT ONCE per frame,
        // then sample per cell — never call rampLUT() inside the pixel loop.
        const lut = Substrate.rampLUT();
        for (let i = 0, p = 0; i < trail.length; i++, p += 4) {
          // v in [0,1): dense veins saturate toward gold/amber, sparse -> verdant.
          const v = 1 - Math.exp(-trail[i] * TONE_K);
          const c = ((v * 255) | 0) * 3;
          data[p]     = lut[c];
          data[p + 1] = lut[c + 1];
          data[p + 2] = lut[c + 2];
          data[p + 3] = 255;
        }
        gctx.putImageData(img, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // base layer, smoothed for soft organic veins
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);

        // additive phosphor bloom / glow
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.45;
        ctx.filter = 'blur(' + Math.max(4, cw * 0.010) + 'px)';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      buildWorld();

      return {
        step() {
          // Read knobs LIVE each frame (shell mutates params in place).
          let sAngle = params.sensorAngle;
          const sDist = params.sensorDist;
          const turn = params.turnSpeed;
          let dep = params.deposit;
          const decay = clamp(params.decay, 0.80, 0.995);

          // Live agentCount changes grow/shrink the stepped pool gracefully.
          activeCount = clamp(params.agentCount | 0, 1, MAX_AGENTS);

          // Optional coupling: a higher incoming signal pushes the system to be
          // more exploratory (wider sensor angle) and denser (more deposit),
          // both clamped to safe bands. Skipped entirely when extDrive === null,
          // so standalone dynamics are byte-for-byte identical.
          if (extDrive !== null) {
            const k = extDrive - 0.5;                 // [-0.5, 0.5], 0 = neutral
            sAngle = clamp(sAngle + k * 0.5, 0.15, 1.30);
            dep = clamp(dep + k * 0.3, 0.03, 1.20);
          }

          stepAgents(sAngle, sDist, turn, dep);
          diffuseDecay(decay);
          render();
        },

        // Restart: re-init the agent pool from a new seed and clear the trail.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          trail.fill(0);
          blur.fill(0);
          activeCount = clamp(params.agentCount | 0, 1, MAX_AGENTS);
          seedAgents(curSeed);
          churn = 0;
        },

        // Window resized: rebuild size-dependent buffers (grid follows aspect).
        // Agents are re-seeded deterministically so the composition is stable.
        resize() {
          buildWorld();
        },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): network richness in [0,1] = mean trail density mapped through
        // the same saturating tone curve and clamped. Higher = denser veins.
        emit() {
          const v = 1 - Math.exp(-meanDensity * TONE_K * 4);
          return clamp(v, 0, 1);
        },

        // absorb(signal): store an external scalar in [0,1] (0.5 neutral) used as
        // a bounded nudge to effective sensorAngle + deposit inside step().
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? clamp(s, 0, 1) : 0.5;
        },

        readouts() {
          return {
            AGENTS: activeCount,
            DENSITY: (clamp(1 - Math.exp(-meanDensity * TONE_K * 4), 0, 1) * 100).toFixed(0) + '%',
            NETWORK: churn > 0.30 ? 'FORMING' : 'STABLE',
          };
        },
      };
    },
  });
})();
