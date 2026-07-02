/* ============================================================
   EQUILIBRIA · Cartridge 09 — CYCLIC  (cyclic cellular automaton)

   David Griffeath's "cyclic space". Each cell holds an integer
   state in 0..(N-1). A cell in state s advances to (s+1) mod N
   IF at least `threshold` of its neighbors are already in state
   (s+1) mod N; otherwise it holds. From uniform noise this self-
   organizes: debris first, then advancing wavefronts, then locked
   rotating spiral domains (Belousov-Zhabotinsky-like) that cycle
   the palette forever.

   Toroidal wrap. Moore neighborhood of radius `range`. State value
   is mapped through the thermal->verdant ramp so the spirals cycle
   colour as they rotate. Ported to the Substrate cartridge contract:
   the shell supplies canvas, knobs, reseed, readouts + export chrome.
   ============================================================ */
(function () {
  'use strict';

  const LONG = 360;   // sim cells on the longer canvas axis
  const SHORT_MIN = 160;

  // --- thermal -> verdant ramp (6 named stops, evenly spaced) ---
  const RAMP = [
    [27, 77, 62],    // #1b4d3e deep verdant
    [42, 157, 143],  // #2a9d8f verdigris
    [0, 255, 156],   // #00ff9c phosphor
    [212, 160, 23],  // #d4a017 warm gold
    [255, 123, 0],   // #ff7b00 amber
    [255, 77, 0],    // #ff4d00 hottest core
  ];
  function rampRGB(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const u = t * (RAMP.length - 1);
    const i = u | 0, f = u - i;
    const a = RAMP[i], b = RAMP[Math.min(i + 1, RAMP.length - 1)];
    return [
      (a[0] + (b[0] - a[0]) * f) | 0,
      (a[1] + (b[1] - a[1]) * f) | 0,
      (a[2] + (b[2] - a[2]) * f) | 0,
    ];
  }

  Substrate.register({
    id: 'cyclic',
    name: 'Cyclic',
    blurb: 'spiral-wave cellular automaton',
    tags: ['ca', 'griffeath', 'spirals', 'bz'],

    // Knobs — read LIVE inside step(). states change is structural (reseed);
    // threshold and range apply live without disturbing the field.
    params: {
      states:    { label: 'States N',     min: 4, max: 20, step: 1, default: 12, int: true },
      threshold: { label: 'Threshold',    min: 1, max: 5,  step: 1, default: 1,  int: true },
      range:     { label: 'Neighborhood', min: 1, max: 3,  step: 1, default: 1,  int: true },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen sim grid: colorized at native cell resolution, blit scaled up.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let W = 0, H = 0;             // sim grid dimensions
      let A = null, B = null;       // ping-pong state buffers (Uint8)
      let img = null;               // ImageData for the grid
      let palette = null;           // Uint8 RGB per state, length N*3

      let curSeed = seed >>> 0;
      let curN = params.states | 0;
      let curRange = params.range | 0;
      let offs = null;              // Int neighbor offsets [dx,dy,...] for curRange
      let rand = null;              // persistent deterministic PRNG stream

      let changedFrac = 0;          // fraction of cells that changed last tick
      let smoothAct = 0;            // smoothed activity for readouts
      let frozenTicks = 0;          // consecutive near-static ticks

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; behavior is byte-identical to
      // standalone (deterministic from seed). Otherwise a scalar in [0,1]
      // (0.5 neutral) that raises the injected-noise rate: higher incoming
      // signal => more churn / more revival sparks keeping spirals alive.
      let extDrive = null;

      // Build Moore-neighborhood offset list for a given radius (excludes 0,0).
      function buildOffsets(rad) {
        const list = [];
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (dx === 0 && dy === 0) continue;
            list.push(dx, dy);
          }
        }
        offs = new Int32Array(list);
      }

      // Precompute the per-state palette for N states through the ramp.
      function buildPalette(n) {
        palette = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
          const c = rampRGB(n > 1 ? i / (n - 1) : 0);
          palette[i * 3] = c[0];
          palette[i * 3 + 1] = c[1];
          palette[i * 3 + 2] = c[2];
        }
      }

      // Fill the grid with uniform random states in 0..N-1 (deterministic).
      function seedField(seedVal, n) {
        rand = Substrate.rng(seedVal >>> 0);
        for (let i = 0; i < A.length; i++) A[i] = (rand() * n) | 0;
        changedFrac = 0;
        smoothAct = 0;
        frozenTicks = 0;
      }

      function buildWorld() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) { W = LONG; H = Math.max(SHORT_MIN, Math.round(LONG / aspect)); }
        else { H = LONG; W = Math.max(SHORT_MIN, Math.round(LONG * aspect)); }
        grid.width = W; grid.height = H;
        img = gctx.createImageData(W, H);
        A = new Uint8Array(W * H);
        B = new Uint8Array(W * H);
        curN = params.states | 0;
        curRange = params.range | 0;
        buildPalette(curN);
        buildOffsets(curRange);
        seedField(curSeed, curN);
      }

      // One cyclic-CA update. Reads N and threshold live. Toroidal wrap.
      // Counts neighbors already in the successor state; advances if >= thr.
      function update(n, thr) {
        const o = offs, no = o.length;
        let changed = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            const s = A[idx];
            const target = s + 1 >= n ? 0 : s + 1;
            let count = 0;
            for (let k = 0; k < no; k += 2) {
              let sx = x + o[k]; if (sx < 0) sx += W; else if (sx >= W) sx -= W;
              let sy = y + o[k + 1]; if (sy < 0) sy += H; else if (sy >= H) sy -= H;
              if (A[sy * W + sx] === target) {
                if (++count >= thr) break;
              }
            }
            if (count >= thr) { B[idx] = target; changed++; }
            else { B[idx] = s; }
          }
        }
        const t = A; A = B; B = t; // swap ping-pong
        changedFrac = changed / (W * H || 1);
      }

      // Inject a random patch of fresh states to revive a stalled field.
      // Uses the persistent deterministic stream so seeds stay reproducible.
      function injectPatch(n, cells) {
        for (let i = 0; i < cells; i++) {
          const px = (rand() * W) | 0;
          const py = (rand() * H) | 0;
          A[py * W + px] = (rand() * n) | 0;
        }
      }

      // Colorize the grid then blit scaled-up (crisp cells + a soft bloom).
      function render() {
        const data = img.data;
        for (let i = 0, p = 0; i < A.length; i++, p += 4) {
          const c = A[i] * 3;
          data[p] = palette[c];
          data[p + 1] = palette[c + 1];
          data[p + 2] = palette[c + 2];
          data[p + 3] = 255;
        }
        gctx.putImageData(img, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // crisp cells — keep the spiral fronts sharp
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);

        // subtle additive bloom for palette continuity with the rest of the rack
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.22;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(' + Math.max(3, cw * 0.006) + 'px)';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      buildWorld();

      return {
        step() {
          // Read knobs live every frame; the shell mutates params in place.
          let n = params.states | 0;
          let thr = params.threshold | 0;
          const rad = params.range | 0;

          // Structural change: state count changed -> reseed the whole field.
          if (n !== curN) {
            curN = n;
            buildPalette(curN);
            curSeed = (curSeed + 0x9e3779b9) >>> 0;
            seedField(curSeed, curN);
          }
          // Range change: rebuild neighbor offsets live (no reseed).
          if (rad !== curRange) {
            curRange = rad;
            buildOffsets(curRange);
          }
          if (thr < 1) thr = 1;

          update(n, thr);
          smoothAct += (changedFrac - smoothAct) * 0.1;

          // Near-static? count it. When the field freezes or goes homogeneous,
          // inject a revival patch so the spirals never fully die.
          if (changedFrac < 0.0008) frozenTicks++; else frozenTicks = 0;
          if (frozenTicks > 12) {
            injectPatch(n, Math.max(4, (W * H * 0.001) | 0));
            frozenTicks = 0;
          }

          // Optional coupling: an external drive above neutral adds continuous
          // churn (extra revival sparks). Skipped entirely when extDrive===null,
          // so standalone output stays byte-for-byte deterministic from seed.
          if (extDrive !== null && extDrive > 0.5) {
            const rate = (extDrive - 0.5) * 2; // 0..1
            const cells = (W * H * 0.004 * rate) | 0;
            if (cells > 0) injectPatch(n, cells);
          }

          render();
        },

        // Restart the field from a new seed (fresh uniform-random states).
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          curN = params.states | 0;
          buildPalette(curN);
          curRange = params.range | 0;
          buildOffsets(curRange);
          seedField(curSeed, curN);
        },

        // Window resized: rebuild the size-dependent grid to match new aspect.
        resize() {
          buildWorld();
        },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): spiral activity in [0,1] — the fraction of cells that changed
        // state last tick. 0 = frozen field, ~1 = fully churning noise.
        emit() {
          const v = changedFrac;
          return v < 0 ? 0 : v > 1 ? 1 : v;
        },

        // absorb(signal): store an external scalar in [0,1] (0.5 neutral).
        // Applied as an injected-noise rate in step(): higher => more churn.
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          const pct = (smoothAct * 100);
          return {
            STATES: curN,
            ACTIVITY: pct.toFixed(1) + '%',
            PHASE: smoothAct < 0.004 ? 'FROZEN' : 'SPIRALS',
          };
        },
      };
    },
  });
})();
