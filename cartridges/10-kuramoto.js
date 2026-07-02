/* ============================================================
   EQUILIBRIA · Cartridge 10 — KURAMOTO  (coupled oscillators)

   The synchronization thesis. N phase oscillators, each with a
   phase theta_i and an intrinsic natural frequency omega_i drawn
   from a distribution (Gaussian, width = spread). Mean-field form
   for O(N) cost: the complex order parameter

       r * e^{i*psi} = (1/N) * sum_j e^{i*theta_j}

   gives coherence r in [0,1] (0 = incoherent, 1 = fully locked).
   Each oscillator then obeys

       d(theta_i)/dt = omega_i + K * r * sin(psi - theta_i).

   As coupling K climbs past the critical value the field
   spontaneously locks — a rainbow of phases collapses into
   coherent colour waves sweeping the whole grid.

   Ported to the Substrate cartridge contract. The shell supplies
   canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  const TWO_PI = Math.PI * 2;

  // --- COLOR SOURCE: studio GLOBAL generative palette ---
  // Colour comes from window.Substrate.rampLUT() (256-entry RGB LUT for t in
  // [0,1]); the default palette is thermal -> verdant so the base look is
  // unchanged, while shuffle/drift recolours live. rampLUT() is fetched ONCE
  // per frame in render() and the cached LUT is threaded into phaseColor() —
  // never called per cell. The phase -> t mapping (t = phase / 2pi) and the
  // wrap + index math are preserved exactly.
  function phaseColor(theta, lut) {
    // wrap theta into [0,2pi) then index the ramp
    let u = theta / TWO_PI;
    u -= Math.floor(u);
    let idx = (u * 256) | 0;
    if (idx > 255) idx = 255; else if (idx < 0) idx = 0;
    idx *= 3;
    return 'rgb(' + lut[idx] + ',' + lut[idx + 1] + ',' + lut[idx + 2] + ')';
  }

  Substrate.register({
    id: 'kuramoto',
    name: 'Kuramoto',
    blurb: 'coupled oscillators · synchronization',
    tags: ['sync', 'emergence', 'order-parameter'],

    // Knobs — read LIVE inside step(). The shell mutates this object in place.
    params: {
      count:    { label: 'Oscillators', min: 400, max: 4000, step: 100, default: 1600, int: true },
      coupling: { label: 'Coupling K',  min: 0,   max: 8,    step: 0.05, default: 2.0 },
      spread:   { label: 'Freq spread', min: 0,   max: 2,    step: 0.01, default: 0.6 },
      speed:    { label: 'Time scale',  min: 0.2, max: 3,    step: 0.01, default: 1.0 },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });
      const DPR = dpr || 1;

      let N = 0;
      let theta = null;      // current phase of each oscillator
      let baseOmega = null;  // unit-Gaussian natural frequency (scaled by spread live)

      let curSeed = seed >>> 0;
      let r = 0, psi = 0;    // latest order parameter (magnitude, angle)

      // --- optional cross-cartridge coupling ---
      // extDrive === null => standalone: dynamics are byte-for-byte identical.
      // Otherwise a scalar in [0,1] (0.5 neutral) that nudges effective K:
      // higher incoming drive pulls the ensemble toward synchrony.
      let extDrive = null;

      // Deterministic standard-normal via Box-Muller off the shell PRNG.
      function makeGaussian(rng) {
        let spare = null;
        return function () {
          if (spare !== null) { const v = spare; spare = null; return v; }
          let u1 = 0, u2 = 0;
          while (u1 <= 1e-12) u1 = rng();
          u2 = rng();
          const mag = Math.sqrt(-2 * Math.log(u1));
          spare = mag * Math.sin(TWO_PI * u2);
          return mag * Math.cos(TWO_PI * u2);
        };
      }

      // Build N oscillators with deterministic phases + natural frequencies.
      function build(seedVal, n) {
        N = Math.max(1, n | 0);
        theta = new Float64Array(N);
        baseOmega = new Float64Array(N);
        const rng = Substrate.rng(seedVal >>> 0);
        const gauss = makeGaussian(rng);
        for (let i = 0; i < N; i++) {
          theta[i] = rng() * TWO_PI;   // uniform initial phase
          baseOmega[i] = gauss();      // unit-variance; scaled by `spread` live
        }
      }

      // Grid layout that fills the canvas as squarely as possible.
      function layout() {
        const W = canvas.width, H = canvas.height;
        const aspect = (W && H) ? W / H : 1;
        let cols = Math.max(1, Math.round(Math.sqrt(N * aspect)));
        let rows = Math.ceil(N / cols);
        return { W, H, cols, rows, cw: W / cols, ch: H / rows };
      }

      function render() {
        const { W, H, cols, cw, ch } = layout();

        // Global generative palette — fetched ONCE per frame, cached, then
        // sampled per oscillator via phaseColor(theta, lut).
        const lut = Substrate.rampLUT();

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, W, H);

        // Field of phase-coloured cells. When incoherent this is rainbow
        // noise; as r -> 1 it collapses to a single sweeping colour.
        const w = Math.ceil(cw) + 1, h = Math.ceil(ch) + 1;
        for (let i = 0; i < N; i++) {
          const col = i % cols, row = (i / cols) | 0;
          ctx.fillStyle = phaseColor(theta[i], lut);
          ctx.fillRect(col * cw, row * ch, w, h);
        }

        // Additive bloom for the glowing organic look.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.35;
        ctx.filter = 'blur(' + Math.max(4, W * 0.008) + 'px)';
        ctx.drawImage(canvas, 0, 0, W, H);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';

        // --- inset phase circle: oscillators on the unit circle ---
        // Points fan around the ring when incoherent, collapse to an arc
        // as r -> 1. The order vector (length r) is drawn from the centre.
        const R = Math.min(W, H) * 0.13;
        const cx = W - R - 22 * DPR, cy = H - R - 22 * DPR;

        ctx.lineWidth = 1 * DPR;
        ctx.strokeStyle = 'rgba(0,255,156,0.25)';
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, TWO_PI);
        ctx.stroke();

        // subsample so the overlay stays cheap for large N
        const stride = Math.max(1, (N / 480) | 0);
        const dot = 1.6 * DPR;
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < N; i += stride) {
          const th = theta[i];
          const px = cx + R * Math.cos(th);
          const py = cy - R * Math.sin(th);
          ctx.fillStyle = phaseColor(th, lut);
          ctx.fillRect(px - dot, py - dot, dot * 2, dot * 2);
        }
        ctx.globalCompositeOperation = 'source-over';

        // order-parameter vector r*e^{i*psi}
        ctx.strokeStyle = '#ff7b00';
        ctx.lineWidth = 2 * DPR;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + r * R * Math.cos(psi), cy - r * R * Math.sin(psi));
        ctx.stroke();
        ctx.fillStyle = '#ff4d00';
        ctx.beginPath();
        ctx.arc(cx + r * R * Math.cos(psi), cy - r * R * Math.sin(psi), 3 * DPR, 0, TWO_PI);
        ctx.fill();
      }

      build(curSeed, params.count | 0);

      return {
        step(dt) {
          // Read knobs live every frame.
          if ((params.count | 0) !== N) build(curSeed, params.count | 0);
          const K = params.coupling;
          const spread = params.spread;
          const speed = params.speed;

          // clamp dt so a stalled tab can't fling phases across many cycles
          let ms = dt;
          if (!(ms > 0)) ms = 16;
          if (ms > 50) ms = 50;
          const h = ms * 0.001 * speed;

          // 1) order parameter r*e^{i*psi} = (1/N) sum e^{i*theta}
          let sumC = 0, sumS = 0;
          for (let i = 0; i < N; i++) { sumC += Math.cos(theta[i]); sumS += Math.sin(theta[i]); }
          sumC /= N; sumS /= N;
          r = Math.sqrt(sumC * sumC + sumS * sumS);
          psi = Math.atan2(sumS, sumC);

          // Effective coupling. extDrive===null => Keff===K exactly (standalone).
          let Keff = K;
          if (extDrive !== null) {
            Keff = K + (extDrive - 0.5) * 4;   // +/- 2 nudge, higher => more sync
            if (Keff < 0) Keff = 0; else if (Keff > 12) Keff = 12;
          }

          // 2) mean-field update: theta += h*(omega + Keff*r*sin(psi - theta))
          const kr = Keff * r;
          for (let i = 0; i < N; i++) {
            const om = baseOmega[i] * spread;
            let th = theta[i] + h * (om + kr * Math.sin(psi - theta[i]));
            th %= TWO_PI;
            if (th < 0) th += TWO_PI;
            theta[i] = th;
          }

          render();
        },

        // Restart with a fresh random ensemble of phases + frequencies.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          build(curSeed, params.count | 0);
        },

        // Canvas backing store already resized by the shell; layout() reads
        // canvas.width/height live, so nothing size-dependent to rebuild.
        resize() { /* layout recomputed live in render() */ },

        // --- OPTIONAL coupling API ---
        // emit(): the order parameter r in [0,1] — a clean synchronization
        // signal. 0 = incoherent, 1 = fully locked.
        emit() {
          return r < 0 ? 0 : r > 1 ? 1 : r;
        },

        // absorb(signal): store a bounded external drive in [0,1] (0.5 neutral)
        // that nudges effective K in step(). null decouples (byte-identical).
        absorb(signal) {
          if (signal === null || signal === undefined) { extDrive = null; return; }
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          return {
            OSC: N,
            ORDER: 'r=' + r.toFixed(2),
            STATE: r > 0.65 ? 'SYNCED' : 'INCOHERENT',
          };
        },
      };
    },
  });
})();
