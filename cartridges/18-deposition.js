/* ============================================================
   EQUILIBRIA · Cartridge 18 — DROPLET DEPOSITION
   Ballistic deposition + splat + solidification: the textbook
   physics of building a solid by landing and freezing droplets.
   (Public-domain surface-growth model — Family & Vicsek 1985 for
   ballistic deposition roughening; a hot splat cools/solidifies.)

   SIDE-VIEW cross-section. A 1D height field h[x] spans the width.
   Droplets are emitted from above at an aim column that SCANS back
   and forth (plus jitter), fall under gravity, and on impact deposit
   a rounded paraboloid bump into h[] — so the surface grows with the
   characteristic roughness of ballistic deposition. Each freshly
   deposited layer is HOT and cools over time, so the built part reads
   as a hot growing surface over a cool frozen body. When the part
   reaches the top it completes, fades, and rebuilds forever — an
   additive-manufacturing part growing layer by layer.

   Theme — "molten metal freezing into a printed part": the just-landed
   top surface / in-flight droplets glow hot; older/deeper material has
   cooled through the verdant end of the palette.

   Conforms to the Substrate cartridge contract (see CARTRIDGE-SPEC.md):
   the shell supplies canvas, live knobs, reseed, readouts + export.
   ============================================================ */
(function () {
  'use strict';

  const TARGET_COLS = 400;  // height-field columns (clamped 300..500 to canvas)
  const BASE_ROWS   = 3;    // thin cool substrate/baseplate to build on
  const GRAV        = 620;  // droplet gravity  (grid-rows / sec^2)
  const V0          = 140;  // droplet initial downward speed (grid-rows / sec)
  const HOT_CUT     = 0.55; // heat above this feeds the additive bloom pass
  const FILL_TOP    = 0.90; // part "complete" when peak height reaches this frac

  // COLOR SOURCE: the studio-global generative palette (window.Substrate).
  // Per-cell thermal heat (0 cool .. 1 just-frozen) drives the ramp; the
  // default palette is thermal->verdant so hot surface / cool body reads as
  // intended. The 256-entry RGB LUT is fetched once per frame via
  // Substrate.rampLUT() and sampled per cell (never rebuilt per cell).

  Substrate.register({
    id: 'deposition',
    name: 'Droplet Deposition',
    blurb: 'molten droplets freeze into a built part',
    tags: ['ballistic-deposition', 'additive', 'solidification'],

    // Knobs — all read LIVE inside step(); the shell mutates this object.
    params: {
      dropRate:  { label: 'Drop rate/s',  min: 2,     max: 40,   step: 1,     default: 14 },
      dropSize:  { label: 'Splat radius', min: 3,     max: 18,   step: 0.5,   default: 8 },
      scanSpeed: { label: 'Scan speed',   min: 0,     max: 3,    step: 0.01,  default: 1.0 },
      spread:    { label: 'Landing jitter', min: 0,   max: 1,    step: 0.01,  default: 0.25 },
      cool:      { label: 'Solidify rate', min: 0.005, max: 0.1, step: 0.005, default: 0.03 },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen crisp part grid + a hot-surface grid for additive glow.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');
      const hot = document.createElement('canvas');
      const hctx = hot.getContext('2d');

      let cols = 0, rows = 0;      // sim grid dimensions
      let cellPx = 1;              // canvas px per sim cell (square cells)
      let h = null;               // Float32Array[cols]: filled height (rows)
      let heat = null;            // Float32Array[cols*rows]: thermal history 0..1
      let img = null, hotImg = null;

      let drops = [];             // in-flight droplets: {x,y,vy,r}
      let emitAccum = 0;          // fractional droplet accumulator
      let aimPhase = 0;           // scan oscillator phase
      let jitPhase = 0;           // slow secondary jitter phase
      let deposited = 0;          // droplets landed (readout)
      let meanH = 0, maxH = 0;    // cached height stats

      let resetting = false;      // completed -> fade-out -> rebuild
      let fade = 1;

      let curSeed = seed >>> 0;
      let rng = Substrate.rng(curSeed);   // ALL randomness flows through here

      // extDrive === null => no coupling; standalone dynamics are identical.
      // Otherwise a scalar in [0,1] (0.5 neutral) nudging deposition rate+spread.
      let extDrive = null;

      // ---- world setup ---------------------------------------------------

      function seedField() {
        h.fill(BASE_ROWS);
        heat.fill(0);
        drops.length = 0;
        emitAccum = 0;
        aimPhase = rng() * Math.PI * 2;
        jitPhase = rng() * Math.PI * 2;
        deposited = 0;
        meanH = BASE_ROWS;
        maxH = BASE_ROWS;
        resetting = false;
        fade = 1;
      }

      function buildWorld() {
        const cw = canvas.width, ch = canvas.height;
        cols = Math.max(300, Math.min(500, Math.round((cw || TARGET_COLS) / 4)));
        cellPx = (cw || cols) / cols;
        rows = Math.max(2, Math.round((ch || cols) / cellPx));
        grid.width = cols; grid.height = rows;
        hot.width = cols;  hot.height = rows;
        img = gctx.createImageData(cols, rows);
        hotImg = hctx.createImageData(cols, rows);
        h = new Float32Array(cols);
        heat = new Float32Array(cols * rows);
        seedField();
      }

      // ---- deposition ----------------------------------------------------

      // Land a rounded (paraboloid) splat of radius Rc cols centred on colF.
      // Raises h[] with ballistic-deposition roughness; freshly filled cells
      // are set HOT (heat = 1).
      function deposit(colF, Rc) {
        const r = Math.max(1, Rc);
        const peak = Math.max(0.9, r * 0.85);        // splat rises ~ its radius
        const lo = Math.max(0, Math.floor(colF - r));
        const hi = Math.min(cols - 1, Math.ceil(colF + r));
        for (let x = lo; x <= hi; x++) {
          const dx = (x - colF) / r;
          const add = peak * (1 - dx * dx);          // paraboloid profile
          if (add <= 0) continue;
          const oldH = h[x];
          let newH = oldH + add;
          if (newH > rows - 1) newH = rows - 1;
          h[x] = newH;
          // heat the newly filled band (from new surface up to old surface).
          let yTop = (rows - newH) | 0; if (yTop < 0) yTop = 0;
          let yOld = (rows - oldH) | 0; if (yOld > rows - 1) yOld = rows - 1;
          for (let y = yTop; y <= yOld; y++) heat[y * cols + x] = 1;
        }
        deposited++;
      }

      // ---- render --------------------------------------------------------

      function render() {
        // COLOR SOURCE: studio-global palette. One 256-entry LUT per frame.
        const LUT = Substrate.rampLUT();
        const data = img.data;
        const hdata = hotImg.data;

        for (let x = 0; x < cols; x++) {
          const surf = rows - h[x];                  // top of the solid (rows)
          for (let y = 0; y < rows; y++) {
            const i = y * cols + x;
            const p = i * 4;
            if (y < surf - 1) {                      // empty air above the part
              data[p] = 10; data[p + 1] = 14; data[p + 2] = 11; data[p + 3] = 255;
              hdata[p] = 0; hdata[p + 1] = 0; hdata[p + 2] = 0; hdata[p + 3] = 0;
              continue;
            }
            // filled cell -> colour by its thermal history (heat 0..1).
            let t = heat[i];
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const c = ((t * 255) | 0) * 3;
            data[p] = LUT[c]; data[p + 1] = LUT[c + 1]; data[p + 2] = LUT[c + 2];
            data[p + 3] = 255;
            if (t > HOT_CUT) {                        // hot surface feeds bloom
              hdata[p] = LUT[c]; hdata[p + 1] = LUT[c + 1]; hdata[p + 2] = LUT[c + 2];
              hdata[p + 3] = 255;
            } else {
              hdata[p] = 0; hdata[p + 1] = 0; hdata[p + 2] = 0; hdata[p + 3] = 0;
            }
          }
        }
        gctx.putImageData(img, 0, 0);
        hctx.putImageData(hotImg, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        // built part (crisp so layer roughness stays legible).
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = resetting ? fade : 1;
        ctx.drawImage(grid, 0, 0, cols, rows, 0, 0, cw, ch);

        // additive bloom on the hot molten surface only.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (resetting ? fade : 1) * 0.7;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(' + Math.max(2, cw * 0.005) + 'px)';
        ctx.drawImage(hot, 0, 0, cols, rows, 0, 0, cw, ch);
        ctx.filter = 'none';

        // in-flight droplets: small hot molten circles above the surface.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1;
        for (let k = 0; k < drops.length; k++) {
          const d = drops[k];
          const px = d.x * cellPx;
          const py = d.y * cellPx;
          const pr = Math.max(1.5, d.r * cellPx * 0.85);
          ctx.fillStyle = Substrate.rampCSS(0.92);
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      function computeStats() {
        let sum = 0, mx = 0;
        for (let x = 0; x < cols; x++) {
          const v = h[x];
          sum += v;
          if (v > mx) mx = v;
        }
        meanH = sum / cols;
        maxH = mx;
      }

      buildWorld();

      return {
        step(dt) {
          const ms = dt > 0 ? dt : 16;
          const sec = ms * 0.001;

          // solidify: every filled cell cools toward the verdant end.
          const cool = params.cool > 0 ? params.cool : 0.005;
          const decay = 1 - cool;
          for (let i = 0; i < heat.length; i++) {
            const v = heat[i] * decay;
            heat[i] = v < 0.001 ? 0 : v;
          }

          if (resetting) {
            // part complete: let droplets clear, fade out, rebuild flat.
            for (let k = drops.length - 1; k >= 0; k--) {
              const d = drops[k];
              d.vy += GRAV * sec;
              d.y += d.vy * sec;
              if (d.y >= rows - h[(d.x | 0)]) drops.splice(k, 1);
            }
            fade -= 0.03;
            if (fade <= 0) {
              curSeed = (curSeed + 0x9e3779b9) >>> 0;
              rng = Substrate.rng(curSeed);
              seedField();
            }
            render();
            return;
          }

          // ---- live knobs (optionally nudged by coupling) ----
          let dropRate = params.dropRate;
          let spread = params.spread;
          if (extDrive !== null) {
            const g = 1 + (extDrive - 0.5);          // 0.5x .. 1.5x
            dropRate *= g;
            spread = spread * g; if (spread > 1) spread = 1; else if (spread < 0) spread = 0;
          }

          // ---- scanning aim: sweep back and forth + slow jitter ----
          aimPhase += params.scanSpeed * sec * 1.4;
          jitPhase += sec * 0.7;
          const centre = cols * 0.5;
          const amp = cols * 0.42;
          const aim = centre + Math.sin(aimPhase) * amp
                             + Math.sin(jitPhase * 1.7) * cols * 0.03;

          // ---- emit droplets at the live rate ----
          emitAccum += dropRate * sec;
          let guard = 0;
          while (emitAccum >= 1 && guard < 64) {
            emitAccum -= 1;
            guard++;
            const jit = (rng() * 2 - 1) * spread * cols * 0.30;
            let tx = aim + jit;
            if (tx < 0) tx = 0; else if (tx > cols - 1) tx = cols - 1;
            drops.push({ x: tx, y: 0, vy: V0, r: params.dropSize / cellPx });
          }

          // ---- integrate falling droplets; deposit on impact ----
          for (let k = drops.length - 1; k >= 0; k--) {
            const d = drops[k];
            d.vy += GRAV * sec;
            d.y += d.vy * sec;
            const col = d.x | 0;
            const surf = rows - h[col < 0 ? 0 : col >= cols ? cols - 1 : col];
            if (d.y >= surf) {
              deposit(d.x, d.r);
              drops.splice(k, 1);
            } else if (d.y > rows) {
              drops.splice(k, 1);
            }
          }

          computeStats();
          render();

          // Loop forever: once the part reaches the top, complete + rebuild.
          if (maxH >= rows * FILL_TOP) resetting = true;
        },

        // Restart the build from a fresh seed.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          rng = Substrate.rng(curSeed);
          seedField();
        },

        // Rebuild size-dependent buffers; the part restarts from the baseplate.
        resize() {
          buildWorld();
        },

        // --- OPTIONAL coupling API (safe to ignore standalone) ---
        // emit(): build progress in [0,1] = mean height / max height.
        emit() {
          const v = meanH / (rows || 1);
          return v < 0 ? 0 : v > 1 ? 1 : v;
        },

        // absorb(signal): store external scalar in [0,1] (0.5 neutral);
        // applied as a bounded nudge to deposition rate + landing spread
        // (incoming heat => faster, wider deposition). null => standalone.
        absorb(signal) {
          if (signal === null || signal === undefined) { extDrive = null; return; }
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          const pct = 100 * meanH / (rows || 1);
          return {
            HEIGHT: pct.toFixed(0) + '%',
            DROPS: deposited,
            STATE: resetting ? 'RESET' : 'BUILDING',
          };
        },
      };
    },
  });
})();
