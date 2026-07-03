/* ============================================================
   EQUILIBRIA · Cartridge 16 — RAYLEIGH  (Rayleigh-Plateau jet breakup)

   A vertical liquid column issues from a nozzle at the top. Surface
   tension amplifies any perturbation whose wavelength exceeds the jet
   circumference; the FASTEST-GROWING mode is the Rayleigh wavelength

       lambda = 9.01 * r0

   so the column necks and pinches into a regular train of main droplets
   (diameter ~1.89*r0, by volume: pi r0^2 lambda = 4/3 pi R^3) with small
   SATELLITE droplets threaded between them. This is the physics behind
   inkjet / drop-on-demand printing — pure textbook fluid mechanics.

   Tractable model: the jet is a 1D radius profile r(y) down the axis,

       r(y,t) = r0 * ( 1 + A(y) * sin( k*(y - vt) + phi ) )

   a downward-CONVECTED wave (frozen into the moving fluid) whose
   amplitude A(y) = eps0 * exp(g*(y - y0)) grows exponentially with
   distance from the nozzle (surface-tension instability, rate ~ tension).
   Where A reaches ~1 the neck radius hits zero: the jet PINCHES OFF.
   One wavelength of advection => one main droplet spawned at the break
   point, plus a satellite between mains. Detached droplets fall under
   gravity with slight drag and a decaying surface wobble (oblate <-> ...).

   Render: the connected jet as a filled ribbon of half-width r(y) mirrored
   about the axis (colored by neck narrowness) plus the wobbling droplets,
   all through an additive glow pass on a dark field.

   Colors come from the studio's GLOBAL generative palette
   (window.Substrate.rampLUT), cached once per frame. Default palette is
   thermal -> verdant, so necks / fast drops read hot and fat / slow bodies
   read cool; a global shuffle or drift recolors the whole jet live.

   Conforms to the Substrate cartridge contract. The shell supplies the
   canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  const PI = Math.PI;
  const TWO_PI = 2 * PI;

  const RAYLEIGH = 9.01;   // lambda / r0 for the fastest-growing mode
  const DROP_RATIO = 1.89; // main-droplet diameter / r0 (volume conservation)
  const SAT_RATIO = 0.36;  // satellite radius / main radius

  const BASE_V = 2.2;      // px per normalized frame at flow = 1
  const G_BASE = 0.5;      // instability growth constant (per lambda) at tension = 1
  const AMP_BREAK = 0.92;  // neck amplitude at which the jet pinches off
  const AMP_MAX = 0.97;    // amplitude ceiling for rendering (neck floor)

  const G_ACCEL = 0.16;    // gravity acceleration scale (px / frame^2) at gravity = 1
  const DRAG = 0.0016;     // per-frame velocity drag on falling drops
  const WOB_BASE = 0.22;   // base surface-oscillation frequency
  const WOB_DECAY = 0.975; // per-frame wobble amplitude decay
  const MAX_DROPS = 500;   // hard cap on live droplet objects

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  Substrate.register({
    id: 'rayleigh',
    name: 'Rayleigh',
    blurb: 'jet breakup into droplets',
    tags: ['fluid', 'surface-tension', 'instability', 'inkjet'],

    // Knobs — read LIVE inside step(). The shell mutates params in place.
    params: {
      jetRadius: { label: 'Jet radius', min: 4,    max: 24, step: 0.1,  default: 10  },
      perturb:   { label: 'Perturb',    min: 0.01, max: 0.5, step: 0.01, default: 0.12 },
      flow:      { label: 'Flow',       min: 0.3,  max: 3,  step: 0.01, default: 1.2 },
      tension:   { label: 'Tension',    min: 0.2,  max: 3,  step: 0.01, default: 1.0 },
      gravity:   { label: 'Gravity',    min: 0,    max: 2,  step: 0.01, default: 0.7 },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });
      const DPR = Math.max(1, dpr || 1);

      let rand = null;          // deterministic stream (seed -> jitter/wobble)
      let curSeed = seed >>> 0;
      let seedPhase = 0;        // frozen nozzle phase of the perturbation

      let waveOffset = 0;       // downward advection of the frozen pattern (px)
      let emitAccum = 0;        // advection since the last pinch (px)
      const drops = [];         // live free droplets

      let totalPinched = 0;     // lifetime main-droplet count
      let yBreakNow = 0;        // current breakup depth (px) — for readouts/emit
      let brokeFrac = 0;        // fraction of the on-screen axis that has broken up

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; dynamics are standalone byte-identical.
      // Otherwise a scalar in [0,1] (0.5 neutral) that nudges effective flow and
      // perturbation within a clamped, bounded band (higher => faster / more breakup).
      let extDrive = null;

      // Seed the frozen perturbation phase deterministically. The same stream is
      // then reused for per-droplet jitter/wobble, so reseed reproduces the run.
      function buildJet(seedVal) {
        rand = Substrate.rng(seedVal >>> 0);
        seedPhase = rand() * TWO_PI;
        waveOffset = 0;
        emitAccum = 0;
        drops.length = 0;
        totalPinched = 0;
      }

      buildJet(curSeed);

      // Spawn one free droplet. R = radius (px), yTop = axial depth of the neck,
      // xOff = lateral offset from the axis, wob = initial surface-oscillation amp.
      function spawn(cx, R, yPos, xOff, vy, wob) {
        if (drops.length >= MAX_DROPS) drops.shift();
        drops.push({
          x: cx + xOff,
          y: yPos,
          r: R,
          vy: vy,
          vx: xOff * 0.02 * (rand() - 0.5),
          wobAmp: wob,
          wobPhase: rand() * TWO_PI,
          wobFreq: WOB_BASE * Math.sqrt(Math.max(0.2, R > 0 ? (R * 0.5 + 1) / R : 1)),
        });
      }

      function frame(dt) {
        const dtn = Math.min(3, Math.max(0.1, dt / 16.667));

        const cw = canvas.width, ch = canvas.height;
        const cx = cw * 0.5;
        const nozzleY = 8 * DPR;

        // --- live knobs (+ bounded external nudge) ---
        let effFlow = params.flow;
        let effPerturb = params.perturb;
        if (extDrive !== null) {
          const d = (extDrive - 0.5);          // [-0.5, 0.5]
          effFlow = effFlow * (1 + d * 0.6);   // +/- 30% speed
          effPerturb = effPerturb * (1 + d * 0.6);
          effFlow = effFlow < 0.15 ? 0.15 : effFlow > 4 ? 4 : effFlow;
          effPerturb = effPerturb < 0.01 ? 0.01 : effPerturb > 0.6 ? 0.6 : effPerturb;
        }

        const r0 = params.jetRadius * DPR;
        const lambda = RAYLEIGH * r0;
        const k = TWO_PI / lambda;
        const vpx = effFlow * BASE_V * DPR;
        const eps0 = effPerturb;

        // instability growth per pixel (scales with tension, ~1/lambda)
        const gpp = (params.tension * G_BASE) / lambda;

        // depth at which the neck amplitude reaches the pinch threshold
        let yBreak;
        if (eps0 >= AMP_BREAK) {
          yBreak = nozzleY;
        } else {
          yBreak = nozzleY + Math.log(AMP_BREAK / eps0) / gpp;
        }
        if (yBreak < nozzleY) yBreak = nozzleY;
        if (yBreak > ch) yBreak = ch;
        yBreakNow = yBreak;
        brokeFrac = clamp01((ch - yBreak) / ch);

        // advect the frozen pattern downward
        waveOffset += vpx * dtn;
        if (waveOffset > 1e7) waveOffset -= 1e7;

        // --- background (opaque, so the additive pass reads as emission) ---
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        const lut = Substrate.rampLUT();

        // --- connected jet ribbon (additive) ---
        ctx.globalCompositeOperation = 'lighter';
        const ds = 2 * DPR;                       // vertical slice height (px)
        const minR = r0 * 0.03;

        for (let y = nozzleY; y <= yBreak; y += ds) {
          let amp = eps0 * Math.exp(gpp * (y - nozzleY));
          if (amp > AMP_MAX) amp = AMP_MAX;
          let rr = r0 * (1 + amp * Math.sin(k * (y - waveOffset) + seedPhase));
          if (rr < minR) rr = minR;

          // color by neck narrowness: thin necks read hot, fat crests cool
          const u = clamp01(1 - rr / r0);
          const ci = (u * 255) | 0, li = ci * 3;
          const col = lut[li] + ',' + lut[li + 1] + ',' + lut[li + 2];

          // glow (wide, dim) then core (tight, bright)
          const gw = rr + 3 * DPR;
          ctx.fillStyle = 'rgb(' + col + ')';
          ctx.globalAlpha = 0.10 + 0.12 * u;
          ctx.fillRect(cx - gw, y, gw * 2, ds + 0.5);
          ctx.globalAlpha = 0.5 + 0.4 * u;
          ctx.fillRect(cx - rr, y, rr * 2, ds + 0.5);
        }

        // rounded jet head at the nozzle
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = Substrate.rampCSS(0.12);
        ctx.beginPath();
        ctx.ellipse(cx, nozzleY, r0 * 1.3, r0 * 0.9, 0, 0, TWO_PI);
        ctx.fill();

        // --- pinch-off: one main + one satellite per wavelength of advection ---
        emitAccum += vpx * dtn;
        let guard = 0;
        while (emitAccum >= lambda && yBreak < ch - 1 && guard < 8) {
          emitAccum -= lambda;
          guard++;
          const Rmain = DROP_RATIO * r0;
          spawn(cx, Rmain, yBreak, (rand() - 0.5) * r0 * 0.15, vpx, 0.34);
          // satellite forms between mains, slightly below and offset
          const Rsat = SAT_RATIO * Rmain;
          spawn(cx, Rsat, yBreak - lambda * 0.42, (rand() - 0.5) * r0 * 0.6, vpx * 0.92, 0.5);
          totalPinched++;
        }

        // --- falling droplets (additive) ---
        const gAcc = params.gravity * G_ACCEL * DPR;
        const vmax = vpx * 6 + 1;
        for (let i = drops.length - 1; i >= 0; i--) {
          const p = drops[i];
          p.vy += gAcc * dtn;
          p.vy *= (1 - DRAG * dtn);
          p.y += p.vy * dtn;
          p.x += p.vx * dtn;
          p.wobPhase += p.wobFreq * dtn;
          p.wobAmp *= Math.pow(WOB_DECAY, dtn);

          if (p.y - p.r > ch) { drops.splice(i, 1); continue; }

          // oblate wobble: volume-preserving stretch across the two axes
          const wob = p.wobAmp * Math.sin(p.wobPhase);
          const rx = p.r * (1 + wob);
          const ry = p.r * (1 - wob);

          // color by fall speed: fast drops hot, slow (fresh) drops cool
          const t = clamp01(p.vy / vmax);
          const ci = (t * 255) | 0, li = ci * 3;
          const col = lut[li] + ',' + lut[li + 1] + ',' + lut[li + 2];

          ctx.fillStyle = 'rgb(' + col + ')';
          ctx.globalAlpha = 0.16;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rx + 3 * DPR, ry + 3 * DPR, 0, 0, TWO_PI);
          ctx.fill();
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TWO_PI);
          ctx.fill();
        }

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      return {
        step(dt) { frame(dt); },

        // Restart from a new seed: new frozen phase, cleared droplet train.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          buildJet(curSeed);
        },

        // Everything is derived from canvas.width/height live each frame; just
        // drop the in-flight droplet train so nothing snaps across the resize.
        resize() { drops.length = 0; emitAccum = 0; },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): fraction of the on-screen axis that has broken into droplets,
        // clamped to [0,1]. Rises as the breakup point climbs toward the nozzle
        // (faster flow / higher perturb / higher tension), falls toward a long
        // intact jet.
        emit() { return clamp01(brokeFrac); },

        // absorb(signal): couple to an external scalar in [0,1] (0.5 neutral).
        // Stored in extDrive and applied as a bounded nudge to effective flow and
        // perturbation in step() — higher incoming => faster jet / earlier breakup.
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          return {
            DROPLETS: drops.length,
            MODE: 'λ/r=9.0',
            STATE: yBreakNow < canvas.height * 0.9 ? 'BREAKUP' : 'JETTING',
          };
        },
      };
    },
  });
})();
