/* ============================================================
   EQUILIBRIA · Cartridge 06 — DIELECTRIC CIRCUITRY
   Diffusion-Limited Aggregation (Witten & Sander 1981) — the
   same growth law behind Lichtenberg figures and dielectric
   breakdown: random-walking "heat" wanders until it touches the
   frozen cluster, then STICKS, branching into circuit-like fractals.

   Theme — "heat pools into rivers that freeze into circuitry":
   freshly-frozen growth tips read HOT (amber), the aging frozen
   structure cools through gold -> phosphor -> deep verdigris.

   Performance: walkers don't random-walk from infinity. They are
   spawned on a frontier circle/line just outside the current
   cluster, with a hard cap of walkers-per-frame and a hard cap of
   steps-per-walker (respawn if they wander past a kill boundary).
   When the cluster fills fillTarget, it fades out and regrows —
   the composition loops forever.

   Conforms to the Substrate cartridge contract (see CARTRIDGE-SPEC.md):
   the shell supplies canvas, live knobs, reseed, readouts + export.
   ============================================================ */
(function () {
  'use strict';

  const TARGET_LONG   = 360;  // sim cells on the LONGER canvas axis
  const SPAWN_MARGIN  = 4;    // spawn walkers this far outside the frontier
  const KILL_MARGIN   = 18;   // respawn a walker once it strays past this
  const MAX_STEPS     = 260;  // hard cap on steps per walker per attempt
  const TIP_WINDOW    = 26;   // a cell is a "tip" if frozen within this many frames

  // COLOR SOURCE: the studio-global generative palette (window.Substrate).
  // The recency t = age-recency value drives the ramp; default palette is
  // thermal->verdant so the base look is ~unchanged. See render() — the LUT is
  // fetched once per frame via Substrate.rampLUT() and sampled per cell.

  // 8-neighbour offsets, used for both walking and stick-contact tests.
  const NX = [1, 1, 0, -1, -1, -1, 0, 1];
  const NY = [0, 1, 1, 1, 0, -1, -1, -1];

  Substrate.register({
    id: 'circuitry',
    name: 'Dielectric Circuitry',
    blurb: 'heat freezes into branching circuits',
    tags: ['dla', 'fractal', 'lichtenberg'],

    // Knobs — all read LIVE inside step(); the shell mutates this object.
    params: {
      walkersPerFrame: { label: 'Walkers/frame', min: 20,   max: 400, step: 10,    default: 120, int: true },
      stickiness:      { label: 'Stickiness',    min: 0.1,  max: 1.0, step: 0.01,  default: 1.0 },
      stepLen:         { label: 'Step length',   min: 1,    max: 3,   step: 1,     default: 1,   int: true },
      seedMode:        { label: 'Seed 0pt/1edge', min: 0,   max: 1,   step: 1,     default: 0,   int: true },
      fillTarget:      { label: 'Fill target',   min: 0.05, max: 0.5, step: 0.01,  default: 0.18 },
      coolSpeed:       { label: 'Cool speed',    min: 0.001, max: 0.05, step: 0.001, default: 0.012 },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen crisp cluster grid + a hot-tips grid for additive glow.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');
      const hot = document.createElement('canvas');
      const hctx = hot.getContext('2d');

      let W = 0, H = 0;                 // sim grid dimensions
      let age = null;                   // Int32Array: frame a cell froze, -1 = empty
      let img = null, hotImg = null;    // ImageData for grid + hot
      let cx = 0, cy = 0;               // cluster centre (point-seed mode)
      let count = 0;                    // occupied cells
      let maxR = 0;                     // frontier radius (point mode)
      let topY = 0;                     // frontier top row (edge mode)
      let frame = 0;                    // monotonic frame counter (age clock)
      let tips = 0;                     // cells frozen within TIP_WINDOW (readout)
      let curSeed = seed >>> 0;
      let rng = Substrate.rng(curSeed); // ALL randomness flows through here

      let resetting = false;            // fade-out-and-regrow state
      let fade = 1;                     // fade alpha while resetting

      // extDrive === null  => no coupling; standalone dynamics are identical.
      // Otherwise a scalar in [0,1] (0.5 neutral) nudging effective walker count.
      let extDrive = null;

      // ---- geometry / seeding -------------------------------------------

      function seedCluster() {
        age.fill(-1);
        count = 0;
        maxR = 0;
        topY = H - 1;
        frame = 0;
        if ((params.seedMode | 0) === 1) {
          // edge mode: freeze the whole bottom row — growth climbs upward.
          for (let x = 0; x < W; x++) freeze(x, H - 1);
        } else {
          // point mode: a single hot seed at centre — growth radiates out.
          freeze(cx, cy);
        }
      }

      function freeze(x, y) {
        const idx = y * W + x;
        if (age[idx] >= 0) return;      // already frozen
        age[idx] = frame;
        count++;
        // update the frontier bound used to place fresh walkers.
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > maxR) maxR = r;
        if (y < topY) topY = y;
      }

      function occupied(x, y) {
        return x >= 0 && x < W && y >= 0 && y < H && age[y * W + x] >= 0;
      }

      function buildWorld() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) { W = TARGET_LONG; H = Math.max(2, Math.round(TARGET_LONG / aspect)); }
        else             { H = TARGET_LONG; W = Math.max(2, Math.round(TARGET_LONG * aspect)); }
        grid.width = W; grid.height = H;
        hot.width = W;  hot.height = H;
        img = gctx.createImageData(W, H);
        hotImg = hctx.createImageData(W, H);
        age = new Int32Array(W * H);
        cx = W >> 1; cy = H >> 1;
        seedCluster();
      }

      // ---- growth --------------------------------------------------------

      // Spawn one walker on the frontier, walk until it sticks / strays /
      // exhausts MAX_STEPS. Returns true if it stuck to the cluster.
      function launchWalker(stick, step) {
        let x, y, killR2 = 0, killTop = 0;
        const edge = (params.seedMode | 0) === 1;

        if (edge) {
          // spawn on a horizontal line just above the highest frozen cell.
          y = Math.max(1, (topY - SPAWN_MARGIN) | 0);
          x = (rng() * W) | 0;
          killTop = topY - (SPAWN_MARGIN + KILL_MARGIN);
        } else {
          // spawn on a circle just outside the current cluster radius.
          const bound = Math.min(W, H) * 0.5 - 2;
          const spawnR = Math.min(maxR + SPAWN_MARGIN, bound);
          const ang = rng() * Math.PI * 2;
          x = (cx + Math.cos(ang) * spawnR) | 0;
          y = (cy + Math.sin(ang) * spawnR) | 0;
          const killR = Math.min(spawnR + KILL_MARGIN, bound + KILL_MARGIN);
          killR2 = killR * killR;
        }

        for (let s = 0; s < MAX_STEPS; s++) {
          // contact test: any frozen 8-neighbour lets it stick (prob = stick).
          let touching = false;
          for (let n = 0; n < 8; n++) {
            if (occupied(x + NX[n], y + NY[n])) { touching = true; break; }
          }
          if (touching) {
            if (rng() < stick) {
              if (x >= 0 && x < W && y >= 0 && y < H) { freeze(x, y); return true; }
              return false;
            }
            // slippery: didn't stick this contact — keep wandering.
          }

          // random 8-directional hop of `step` cells.
          const d = (rng() * 8) | 0;
          x += NX[d] * step;
          y += NY[d] * step;

          if (edge) {
            // wrap horizontally; die if it climbs too high or falls off bottom.
            if (x < 0) x += W; else if (x >= W) x -= W;
            if (y < killTop || y >= H) return false;
          } else {
            if (x < 0 || x >= W || y < 0 || y >= H) return false;
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy > killR2) return false;
          }
        }
        return false; // exhausted steps -> abandoned (respawn next frame)
      }

      // ---- render --------------------------------------------------------

      function render() {
        // recency window (in frames): higher coolSpeed => shorter => cools fast.
        const cool = params.coolSpeed > 0 ? params.coolSpeed : 0.001;
        const window = 1 / cool;
        const data = img.data;
        const hdata = hotImg.data;

        // COLOR SOURCE: studio-global generative palette. Fetch the 256-entry
        // RGB LUT once per frame (never per cell) and sample it by the same
        // recency t computed below. Default palette is thermal->verdant, so the
        // tips-hot / old-cool base look is preserved; shuffle/drift recolors live.
        const LUT = Substrate.rampLUT();

        tips = 0;
        for (let i = 0, p = 0; i < age.length; i++, p += 4) {
          const a = age[i];
          if (a < 0) {                       // empty cell -> background
            data[p] = 10; data[p + 1] = 14; data[p + 2] = 11; data[p + 3] = 255;
            hdata[p] = 0; hdata[p + 1] = 0; hdata[p + 2] = 0; hdata[p + 3] = 0;
            continue;
          }
          // recency in [0,1]: 1 just frozen (hot), 0 fully cooled (verdant).
          let rec = 1 - (frame - a) / window;
          if (rec < 0) rec = 0; else if (rec > 1) rec = 1;
          const c = ((rec * 255) | 0) * 3;
          data[p] = LUT[c]; data[p + 1] = LUT[c + 1]; data[p + 2] = LUT[c + 2];
          data[p + 3] = 255;

          // hot tips feed the additive glow pass and the TIPS readout.
          if (frame - a < TIP_WINDOW) {
            tips++;
            hdata[p] = LUT[c]; hdata[p + 1] = LUT[c + 1]; hdata[p + 2] = LUT[c + 2];
            hdata[p + 3] = 255;
          } else {
            hdata[p] = 0; hdata[p + 1] = 0; hdata[p + 2] = 0; hdata[p + 3] = 0;
          }
        }
        gctx.putImageData(img, 0, 0);
        hctx.putImageData(hotImg, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // crisp cluster (nearest-neighbour keeps the branch filaments sharp).
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = resetting ? fade : 1;
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);

        // additive bloom on the hot growth tips only.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (resetting ? fade : 1) * 0.7;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(' + Math.max(3, cw * 0.006) + 'px)';
        ctx.drawImage(hot, 0, 0, W, H, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      buildWorld();

      return {
        step() {
          frame++;

          const total = W * H;
          const fillTarget = params.fillTarget;

          if (resetting) {
            // fade the frozen circuitry out, then reseed and regrow.
            fade -= 0.03;
            if (fade <= 0) {
              curSeed = (curSeed + 0x9e3779b9) >>> 0;
              rng = Substrate.rng(curSeed);
              seedCluster();
              resetting = false;
              fade = 1;
            }
            render();
            return;
          }

          // Base walker budget from the live slider.
          let budget = params.walkersPerFrame | 0;
          // Optional coupling: incoming heat speeds crystallization (bounded
          // 0.5x .. 1.5x). Skipped entirely when extDrive === null so the
          // standalone growth is byte-for-byte identical.
          if (extDrive !== null) {
            budget = Math.round(budget * (1 + (extDrive - 0.5)));
            if (budget < 1) budget = 1; else if (budget > 800) budget = 800;
          }

          const stick = params.stickiness;
          const step = params.stepLen | 0 || 1;
          for (let i = 0; i < budget; i++) launchWalker(stick, step);

          render();

          // Loop forever: once the cluster fills the target fraction, fade out.
          if (count / total >= fillTarget) resetting = true;
        },

        // Restart the composition from a fresh seed.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          rng = Substrate.rng(curSeed);
          resetting = false;
          fade = 1;
          seedCluster();
        },

        // Grid stays fixed on resize; render() reads canvas.width/height live
        // to recompute the scaled blit, so there's nothing to rebuild.
        resize() { /* scaled blit recomputed live in render() */ },

        // --- OPTIONAL coupling API (safe to ignore standalone) ---
        // emit(): crystallization output in [0,1] = coverage / fillTarget,
        // clamped. Rises as the lattice freezes over, resets after each loop.
        emit() {
          const ft = params.fillTarget || 0.18;
          const v = (count / (W * H)) / ft;
          return v < 0 ? 0 : v > 1 ? 1 : v;
        },

        // absorb(signal): store an external scalar in [0,1] (0.5 neutral);
        // applied as a bounded nudge to the walker budget in step().
        absorb(signal) {
          if (signal === null || signal === undefined) { extDrive = null; return; }
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          const pct = (100 * count / (W * H));
          return {
            COVERAGE: pct.toFixed(1) + '%',
            TIPS: tips,
            STATE: resetting ? 'RESET' : 'GROWING',
          };
        },
      };
    },
  });
})();
