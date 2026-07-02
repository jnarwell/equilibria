/* ============================================================
   EQUILIBRIA · Cartridge 15 — LIFE  (Conway's Game of Life)

   The discrete ancestor of Lenia (cartridge 04), shipped as a
   knowing companion piece. Binary toroidal grid; each cell lives
   or dies by its 8 live neighbors:

     survive  if alive and neighbors in SURVIVE set (classic 2,3)
     born     if dead  and neighbors in BIRTH  set (classic 3)
     else dead.

   Beyond on/off, every cell carries a thermal "heat":
     · newborn cells glow hot amber      (heat -> 1.0)
     · long-lived stable cells cool to verdant (heat -> ~0.25)
     · freshly-dead cells leave a fading ember (heat decays -> 0)
   coloured through the shared thermal->verdant ramp so the board
   reads as a thermal map of activity, not a flat bitmap.

   The rule is generalized (tunable birth bitmask) so it can run
   other Life-like automata, and the board self-sustains forever:
   if the population stops changing (still lifes / oscillators) or
   dies out, a fresh random soup patch is sprinkled in.

   Life generations advance on their own clock (stepRate gen/sec),
   decoupled from render, so it is watchable — never seizure-fast.
   ============================================================ */
(function () {
  'use strict';

  const TARGET_LONG = 280;   // sim cells on the LONGER canvas axis (200..360 band)
  const MIN_SHORT   = 90;    // floor for the shorter axis
  const MAX_STEPS   = 4;     // generations per render frame (anti-spiral cap)

  const SURVIVE_MASK = (1 << 2) | (1 << 3);   // classic S23 (held constant)
  // birth is a live knob (bitmask over neighbor counts); default 1<<3 = B3.

  const STAG_LIMIT   = 40;    // generations of ~flat population -> sprinkle soup
  const RESEED_HOLD  = 8;     // render frames the 'RESEED' state is shown

  // COLOR SOURCE: the heat field is coloured through the studio's GLOBAL
  // generative palette (Substrate.rampLUT), sampled per cell by the same
  // t = heat value. The default palette is thermal->verdant so the base
  // look is unchanged; palette shuffle/drift recolors the live board.

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  Substrate.register({
    id: 'life',
    name: 'Game of Life',
    blurb: "Conway's discrete ancestor of Lenia",
    tags: ['life', 'cellular-automata', 'conway'],

    // Knobs — read LIVE inside step(). Defaults = classic Conway B3/S23.
    params: {
      stepRate:  { label: 'Generations/s', min: 2,    max: 30,  step: 1,     default: 10, int: true },
      density:   { label: 'Soup density',  min: 0.05, max: 0.6, step: 0.01,  default: 0.3 },
      birth:     { label: 'Birth mask (B3=8)', min: 0, max: 511, step: 1,    default: 8, int: true },
      coolSpeed: { label: 'Cool rate',     min: 0.01, max: 0.3, step: 0.01,  default: 0.08 },
      wild:      { label: 'Mutation',      min: 0,    max: 0.02, step: 0.001, default: 0.002 },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen sim grid, colorized then blit scaled-up (crisp).
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let W = 0, H = 0;            // sim grid dimensions (cells)
      let cur = null, next = null; // Uint8 ping-pong occupancy buffers
      let heat = null;             // Float32 thermal field, per cell [0,1]
      let img = null;              // ImageData for the grid

      let curSeed = seed >>> 0;
      let rng = Substrate.rng(curSeed);  // persistent, advances across gens

      let gen = 0;
      let pop = 0;
      let lastPop = -1;
      let stagCounter = 0;
      let holdReseed = 0;

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; behavior is byte-identical to
      // standalone. Otherwise a scalar in [0,1] that raises mutation and
      // shortens the stagnation window (more incoming drive = more activity).
      let extDrive = null;

      // Fill the WHOLE board with random soup at the live density.
      function seedSoup(d) {
        cur.fill(0);
        heat.fill(0);
        for (let i = 0; i < cur.length; i++) {
          if (rng() < d) { cur[i] = 1; heat[i] = 1.0; }
        }
      }

      // Sprinkle a random soup PATCH (keeps existing structure alive forever).
      function sprinklePatch(d) {
        const pw = Math.max(8, (W * 0.3) | 0);
        const ph = Math.max(8, (H * 0.3) | 0);
        const ox = (rng() * W) | 0;
        const oy = (rng() * H) | 0;
        for (let y = 0; y < ph; y++) {
          const gy = (oy + y) % H;
          for (let x = 0; x < pw; x++) {
            if (rng() < d) {
              const gx = (ox + x) % W;
              const i = gy * W + gx;
              if (cur[i] === 0) heat[i] = 1.0;  // seeded cells read as newborn
              cur[i] = 1;
            }
          }
        }
      }

      function buildWorld() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) { W = TARGET_LONG; H = Math.max(MIN_SHORT, Math.round(TARGET_LONG / aspect)); }
        else             { H = TARGET_LONG; W = Math.max(MIN_SHORT, Math.round(TARGET_LONG * aspect)); }
        grid.width = W; grid.height = H;
        img = gctx.createImageData(W, H);
        cur  = new Uint8Array(W * H);
        next = new Uint8Array(W * H);
        heat = new Float32Array(W * H);
        gen = 0; pop = 0; lastPop = -1; stagCounter = 0; holdReseed = 0;
        seedSoup(clamp(params.density, 0.05, 0.6));
      }

      // Advance exactly one Life generation. Reads birth/cool/wild live.
      function generation() {
        const birthMask = params.birth | 0;
        const cool = params.coolSpeed;
        // Coupling: raise mutation rate within a clamped safe band.
        let wildRate = params.wild;
        if (extDrive !== null) wildRate = clamp(wildRate + extDrive * 0.01, 0, 0.03);

        let p = 0;
        for (let y = 0; y < H; y++) {
          const ym = ((y - 1 + H) % H) * W;
          const y0 = y * W;
          const yp = ((y + 1) % H) * W;
          for (let x = 0; x < W; x++) {
            const xm = (x - 1 + W) % W;
            const xp = (x + 1) % W;
            const n = cur[ym + xm] + cur[ym + x] + cur[ym + xp]
                    + cur[y0 + xm]              + cur[y0 + xp]
                    + cur[yp + xm] + cur[yp + x] + cur[yp + xp];
            const i = y0 + x;
            const alive = cur[i];
            let nv = alive ? ((SURVIVE_MASK >> n) & 1)
                           : ((birthMask   >> n) & 1);
            // wild mutation: rare random birth/death for perpetual novelty.
            if (wildRate > 0 && rng() < wildRate) nv ^= 1;
            next[i] = nv;

            if (nv) {
              p++;
              if (!alive) heat[i] = 1.0;                       // newborn: hot
              else { const h = heat[i] - cool; heat[i] = h < 0.25 ? 0.25 : h; } // cool -> verdant
            } else {
              if (alive) heat[i] = 0.5;                        // just died: ember
              else heat[i] = heat[i] > 0.02 ? heat[i] * 0.8 : 0; // fade out
            }
          }
        }

        const t = cur; cur = next; next = t; // swap ping-pong
        pop = p;
        gen++;

        // --- longevity: keep it running forever ---
        const area = W * H;
        if (pop === 0) {
          curSeed = (curSeed + 0x9e3779b9) >>> 0;
          rng = Substrate.rng(curSeed);
          seedSoup(clamp(params.density, 0.05, 0.6));
          stagCounter = 0; holdReseed = RESEED_HOLD;
        } else {
          const stagThresh = Math.max(1, (area * 0.0006) | 0);
          if (lastPop >= 0 && Math.abs(pop - lastPop) <= stagThresh) stagCounter++;
          else stagCounter = 0;
          // Coupling shortens the stagnation window (drives more reseeds).
          let limit = STAG_LIMIT;
          if (extDrive !== null) limit = Math.max(8, (STAG_LIMIT * (1 - extDrive * 0.5)) | 0);
          if (stagCounter >= limit) {
            sprinklePatch(clamp(params.density, 0.05, 0.6));
            stagCounter = 0; holdReseed = RESEED_HOLD;
          }
        }
        lastPop = pop;
      }

      // Colorize the thermal field and blit crisp (Life reads best sharp),
      // with a faint additive bloom so hot cells glow.
      function render() {
        const d = img.data;
        // Global generative palette: fetch the 256-entry RGB LUT ONCE per
        // frame, then sample it per cell by t = heat (same mapping as before).
        const lut = Substrate.rampLUT();
        for (let i = 0, q = 0; i < heat.length; i++, q += 4) {
          const c = ((heat[i] * 255) | 0) * 3;
          d[q]     = lut[c];
          d[q + 1] = lut[c + 1];
          d[q + 2] = lut[c + 2];
          d[q + 3] = 255;
        }
        gctx.putImageData(img, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // crisp base — nearest-neighbor keeps the cellular grid sharp
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);

        // faint bloom on the hot activity
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.3;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(' + Math.max(3, cw * 0.006) + 'px)';
        ctx.drawImage(grid, 0, 0, W, H, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.imageSmoothingEnabled = false;
      }

      buildWorld();

      // Generation clock, decoupled from render so it stays watchable.
      let acc = 0;

      return {
        step(dt) {
          acc += (dt > 100 ? 100 : dt);         // clamp huge tab-switch jumps
          const rate = clamp(params.stepRate | 0, 2, 30);
          const interval = 1000 / rate;
          let steps = 0;
          while (acc >= interval && steps < MAX_STEPS) {
            generation();
            acc -= interval;
            steps++;
          }
          if (steps === 0 && acc > interval) acc = interval; // avoid runaway backlog
          if (holdReseed > 0) holdReseed--;
          render();
        },

        // Restart the board from a fresh seed and a new random soup.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          rng = Substrate.rng(curSeed);
          gen = 0; pop = 0; lastPop = -1; stagCounter = 0; holdReseed = 0; acc = 0;
          seedSoup(clamp(params.density, 0.05, 0.6));
        },

        // Grid dimensions follow the canvas aspect, so rebuild on resize.
        resize() {
          rng = Substrate.rng(curSeed);
          buildWorld();
        },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): live fraction of the board in [0,1] (population vitality).
        emit() {
          const area = (W * H) || 1;
          return clamp(pop / area, 0, 1);
        },

        // absorb(signal): bounded nudge to the reseed/mutation rate — higher
        // incoming drive => more mutation + faster reseeds => more activity.
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? clamp(s, 0, 1) : 0.5;
        },

        readouts() {
          const area = (W * H) || 1;
          const state = holdReseed > 0 ? 'RESEED'
                      : stagCounter >= STAG_LIMIT * 0.5 ? 'STAGNANT'
                      : 'ALIVE';
          return {
            GEN: gen,
            POP: (pop / area * 100).toFixed(1) + '%',
            STATE: state,
          };
        },
      };
    },
  });
})();
