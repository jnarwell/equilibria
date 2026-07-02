/* ============================================================
   EQUILIBRIA · Cartridge 13 — CHLADNI  (cymatic sand figures)

   Sand on a vibrating square plate collects at the NODAL LINES
   of a standing wave. Displacement field on the unit square:

     w(x,y) = cos(nπx)cos(mπy) - cos(mπx)cos(nπy)

   the classic square-plate mode for mode numbers n,m. The nodal
   set is w=0. A few thousand particles each frame take a damped
   Newton step toward the nearest zero of w (down the gradient of
   |w|), plus a random jitter whose magnitude scales with |w| so
   antinodes shake sand off and it self-organizes onto the nodes.

   A gentle sweep morphs the (continuous) mode numbers, so the
   figure slowly re-forms into new patterns. Particles render as
   additive glowing dots colored by local |w| — bright gold on the
   nodes, dim verdant in the antinode chop — over a fading trail.

   Conforms to the Substrate cartridge contract. The shell supplies
   the canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  const PI = Math.PI;
  const MORPH_AMP = 2.0;   // how many modes the auto-sweep breathes over
  const W_MAX = 2.0;       // |w| ceiling (two cos products, difference)
  const SETTLE_EPS = 0.08; // |w| below this = "sitting on a node"
  const TRAIL_FADE = 0.18; // per-frame background wash (lower = longer trails)

  // --- thermal -> verdant palette LUT (nodes hot/gold, antinodes verdant) ---
  const STOPS = [
    [0.00, [10, 14, 11]],     // near-black background   #0a0e0b
    [0.10, [27, 77, 62]],     // deep verdant            #1b4d3e
    [0.28, [42, 157, 143]],   // verdigris               #2a9d8f
    [0.48, [0, 255, 156]],    // phosphor                #00ff9c
    [0.68, [212, 160, 23]],   // warm gold               #d4a017
    [0.86, [255, 123, 0]],    // amber                   #ff7b00
    [1.00, [255, 77, 0]]      // hottest core            #ff4d00
  ];
  const LUT_STR = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = STOPS[0], b = STOPS[STOPS.length - 1];
    for (let s = 1; s < STOPS.length; s++) {
      if (t <= STOPS[s][0]) { a = STOPS[s - 1]; b = STOPS[s]; break; }
    }
    const f = (t - a[0]) / (b[0] - a[0] || 1);
    const r = (a[1][0] + (b[1][0] - a[1][0]) * f) | 0;
    const g = (a[1][1] + (b[1][1] - a[1][1]) * f) | 0;
    const bl = (a[1][2] + (b[1][2] - a[1][2]) * f) | 0;
    LUT_STR[i] = 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  Substrate.register({
    id: 'chladni',
    name: 'Chladni',
    blurb: 'cymatic sand figures',
    tags: ['cymatics', 'standing-wave', 'nodal', 'particles'],

    // Knobs — read LIVE inside step(). The shell mutates params in place.
    params: {
      freq:      { label: 'Frequency', min: 1,    max: 12,   step: 0.01, default: 4     },
      modeRatio: { label: 'Mode skew', min: 0.2,  max: 3,    step: 0.01, default: 1.0   },
      particles: { label: 'Particles', min: 1000, max: 8000, step: 100,  default: 4000, int: true },
      sharpness: { label: 'Snap',      min: 0.2,  max: 3,    step: 0.01, default: 1.0   },
      sweep:     { label: 'Morph',     min: 0,    max: 0.05, step: 0.001, default: 0.006 },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });
      const DPR = Math.max(1, dpr || 1);

      let PX = null, PY = null;      // particle positions in unit square [0,1]
      let count = 0;                 // current particle count
      let rand = null;               // deterministic jitter stream
      let curSeed = seed >>> 0;

      let sweepPhase = 0;            // accumulates the auto-morph
      let feNow = params.freq;       // effective frequency (for readouts)
      let nNow = 1, mNow = 1;        // current mode numbers (for readouts)
      let settledFrac = 0;          // fraction of sand sitting on nodes
      let cleared = false;           // whether we've laid the first bg

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; dynamics are standalone-identical.
      // Otherwise a scalar in [0,1] (0.5 neutral) that nudges the effective
      // frequency and morph rate within a clamped, bounded band.
      let extDrive = null;

      // Build/seed the particle cloud deterministically from a seed. The same
      // stream is then reused for per-frame jitter, so reseed reproduces.
      function buildParticles(seedVal, n) {
        count = Math.max(1, n | 0);
        PX = new Float32Array(count);
        PY = new Float32Array(count);
        rand = Substrate.rng(seedVal >>> 0);
        for (let i = 0; i < count; i++) { PX[i] = rand(); PY[i] = rand(); }
        cleared = false;
      }

      buildParticles(curSeed, params.particles | 0);

      // Advance one frame: migrate every particle toward the nearest nodal line,
      // shake it by an antinode-scaled jitter, then draw the glowing sand.
      function frame(dt) {
        // frame-rate normalization (60fps reference)
        const dtn = Math.min(3, Math.max(0.1, dt / 16.667));

        // Rebuild if the particle-count knob moved.
        if ((params.particles | 0) !== count) buildParticles(curSeed, params.particles | 0);

        // --- effective mode numbers (knob + gentle auto-sweep) ---
        sweepPhase += params.sweep * dtn;
        let fe = params.freq + MORPH_AMP * Math.sin(sweepPhase);

        // Optional coupling: bounded nudge to frequency from an external drive.
        if (extDrive !== null) {
          fe += (extDrive - 0.5) * 3;            // +/- 1.5 modes
          fe = fe < 1 ? 1 : fe > 14 ? 14 : fe;
        }
        feNow = fe;

        let n = fe;
        let m = 1 + fe * params.modeRatio;
        // keep the pair distinct — n==m makes w identically zero (blank plate).
        if (Math.abs(n - m) < 0.25) m += 0.25;
        nNow = n; mNow = m;

        const nPI = n * PI, mPI = m * PI;
        // damped-Newton gain: sharpness tightens the snap onto the node.
        const snap = 0.55 * params.sharpness * dtn;
        const jitBase = 0.011 * dtn;

        // --- background trail wash (source-over) ---
        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        if (!cleared) { ctx.fillStyle = '#0a0e0b'; ctx.fillRect(0, 0, cw, ch); cleared = true; }
        else { ctx.fillStyle = 'rgba(10,14,11,' + TRAIL_FADE + ')'; ctx.fillRect(0, 0, cw, ch); }

        // --- particle pass (additive glow) ---
        ctx.globalCompositeOperation = 'lighter';
        const core = 1.6 * DPR, glow = 4.2 * DPR;
        let settled = 0;

        for (let i = 0; i < count; i++) {
          let x = PX[i], y = PY[i];

          // standing-wave displacement + analytic gradient
          const cnx = Math.cos(nPI * x), cmy = Math.cos(mPI * y);
          const cmx = Math.cos(mPI * x), cny = Math.cos(nPI * y);
          const w = cnx * cmy - cmx * cny;
          const dwdx = -nPI * Math.sin(nPI * x) * cmy + mPI * Math.sin(mPI * x) * cny;
          const dwdy = -mPI * cnx * Math.sin(mPI * y) + nPI * cmx * Math.sin(nPI * y);

          // damped Newton step toward w=0 (down the gradient of |w|)
          const g2 = dwdx * dwdx + dwdy * dwdy + 1e-4;
          const fac = (w / g2) * snap;
          x -= fac * dwdx;
          y -= fac * dwdy;

          // vibration jitter — scales with |w|, so antinodes shake sand loose
          const aw = w < 0 ? -w : w;
          const jit = jitBase * aw;
          x += (rand() * 2 - 1) * jit;
          y += (rand() * 2 - 1) * jit;

          // reflect at the plate edges
          if (x < 0) x = -x; else if (x > 1) x = 2 - x;
          if (y < 0) y = -y; else if (y > 1) y = 2 - y;
          if (x < 0) x = 0; else if (x > 1) x = 1;
          if (y < 0) y = 0; else if (y > 1) y = 1;
          PX[i] = x; PY[i] = y;

          if (aw < SETTLE_EPS) settled++;

          // color: bright gold on the node, dim verdant off it
          const awN = aw > W_MAX ? 1 : aw / W_MAX;
          const u = 1 - awN;
          const ci = (u * 255) | 0;
          const px = x * cw, py = y * ch;

          ctx.fillStyle = LUT_STR[ci];
          ctx.globalAlpha = 0.10 + 0.16 * u;
          ctx.fillRect(px - glow * 0.5, py - glow * 0.5, glow, glow);
          ctx.globalAlpha = 0.35 + 0.5 * u;
          ctx.fillRect(px - core * 0.5, py - core * 0.5, core, core);
        }

        settledFrac = settled / count;

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      return {
        step(dt) { frame(dt); },

        // Restart the cloud from a new seed; re-scatters the sand.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          sweepPhase = 0;
          buildParticles(curSeed, params.particles | 0);
        },

        // Particles live in normalized [0,1] coords and the field is read live
        // against canvas.width/height each frame, so nothing to rebuild — just
        // re-lay the background so old trails don't stretch across the resize.
        resize() { cleared = false; },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): pattern order = fraction of sand sitting on the nodal lines,
        // clamped to [0,1]. Rises as the figure crystallizes, falls while it
        // morphs through a chaotic transition between modes.
        emit() {
          const v = settledFrac;
          return v < 0 ? 0 : v > 1 ? 1 : v;
        },

        // absorb(signal): couple to an external scalar in [0,1] (0.5 neutral).
        // Stored in extDrive and applied as a bounded frequency nudge in step().
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          return {
            FREQ: feNow.toFixed(2),
            MODE: Math.round(nNow) + ',' + Math.round(mNow),
            SETTLED: (settledFrac * 100).toFixed(0) + '%',
          };
        },
      };
    },
  });
})();
