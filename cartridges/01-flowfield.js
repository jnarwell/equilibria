/* ============================================================
   EXERGY FLOWFIELD — cartridge port of 01-exergy-flowfield.html
   ------------------------------------------------------------
   A closed thermodynamic loop. Particles are born HOT at a source
   band along the top edge, advect through an fBm flow field, cool
   from amber -> verdigris as energy dissipates, then are RECAPTURED
   and REINJECTED hot at the source. Population is conserved.

   Conforms to CARTRIDGE-SPEC.md:
     - classic script, registers itself once via Substrate.register
     - gets its own 2d context off the shell-owned canvas
     - all randomness via Substrate.rng(seed) so reseed() reproduces
     - params read LIVE every frame (never snapshotted in create)
     - shell owns sizing; resize() rebuilds size-dependent buffers
   ============================================================ */
(function () {
  "use strict";

  // ---- Palette: sourced from the studio's GLOBAL generative palette ----
  // Colors now come from Substrate's global ramp API. The default global
  // palette reproduces the original thermal -> verdant look, and switching
  // the palette (shuffle/drift) recolors this system live. The mapping from
  // the system's internal quantity (temperature t in [0,1]) to a color is
  // unchanged — only the color SOURCE moved from a local ramp to the global
  // palette.
  //
  // Sample a cached 768-byte RGB LUT (Uint8ClampedArray from rampLUT()) at a
  // normalized scalar t in [0,1]. Returns {r,g,b} ints. Callers cache the LUT
  // once per frame and call this in the hot loop (never re-fetch per pixel).
  function sampleLUT(lut, t) {
    const i = (Math.max(0, Math.min(1, t)) * 255) | 0;
    const j = i * 3;
    return { r: lut[j], g: lut[j + 1], b: lut[j + 2] };
  }

  const BG = "#0a0e0b"; // near-black, slightly warm-green ground

  // ---- Non-tunable internals (kept off the slider rack) ----
  const CONST = {
    fieldTurns:    2.4,     // how many radians the flow field spans
    octaves:       4,       // fBm octaves
    hotBandFrac:   0.16,    // source band height as fraction of canvas
    recaptureGlow: 0.06,    // opacity of faint return-current traces
    noiseDriftPerMs: 0.0036,// slow temporal drift of the field (~0.06/frame @60fps)
    baseFreq:      0.0016,  // spatial frequency at noiseScale = 1
  };

  Substrate.register({
    id: 'flowfield',
    name: 'Exergy Flowfield',
    blurb: 'conserved particle loop',
    tags: ['flow', 'conservation', 'thermal'],

    // Auto-rendered as sliders. Read live inside step().
    params: {
      particleCount: { label: 'Particles',     min: 200,   max: 6000, step: 100,    default: 2600, int: true },
      noiseScale:    { label: 'Noise scale',   min: 0.3,   max: 3.5,  step: 0.05,   default: 1.0  },
      speed:         { label: 'Flow speed',    min: 0.1,   max: 4,    step: 0.05,   default: 1.35 },
      coolRate:      { label: 'Cool rate',     min: 0.0005,max: 0.01, step: 0.0005, default: 0.0019 },
      strokeAlpha:   { label: 'Stroke alpha',  min: 0.02,  max: 0.4,  step: 0.01,   default: 0.10 },
      fadeAlpha:     { label: 'Fade alpha',    min: 0.002, max: 0.05, step: 0.002,  default: 0.010 },
    },

    create({ canvas, width, height, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // --- size-dependent state (rebuilt on resize) ---
      let W = width, H = height;
      let DPR = dpr || 1;

      // --- seeded state (rebuilt on reseed) ---
      let rng = Substrate.rng(seed);       // mulberry32 stream for ALL randomness
      let noiseFn = Substrate.noise2D(seed); // single-octave value noise -> [-1,1]

      // --- simulation state ---
      let particles = [];
      let lastCount = params.particleCount | 0;
      let recapturedTotal = 0;
      let iter = 0;
      let zTime = 0;        // temporal noise offset (slow field drift)
      let meanTemp = 0.5;   // smoothed readout temperature
      let extDrive = null;  // OPTIONAL patchbay coupling: null = standalone (no external drive)

      // Fractal Brownian motion layered on the shell's value noise.
      function fbm(x, y, octaves) {
        let sum = 0, amp = 0.5, freq = 1, norm = 0;
        for (let o = 0; o < octaves; o++) {
          sum += amp * noiseFn(x * freq, y * freq);
          norm += amp;
          amp *= 0.5;
          freq *= 2.0;
        }
        return sum / norm; // ~[-1,1]
      }

      // The hot source is a horizontal band along the TOP of the canvas.
      function sourceY() { return H * CONST.hotBandFrac * 0.5; }

      // Spawn (or respawn) a particle jittered within the hot source band.
      function spawnAtSource(p) {
        p.x = rng() * W;
        p.y = rng() * (H * CONST.hotBandFrac);
        p.px = p.x;
        p.py = p.y;
        p.t = 1.0;                            // born hot
        p.life = 0;
        p.maxLife = 520 + rng() * 520;        // lifetime spread (frames @60fps)
        p.w = 0.6 + rng() * 1.7;              // stroke width base
        p.returning = false;                  // in recapture phase?
        p.homeX = 0;
        return p;
      }

      // One fresh, pre-warmed particle (temps/positions spread so the
      // field doesn't start as a flat front).
      function makeParticle() {
        const p = spawnAtSource({});
        p.t = rng();
        p.y = rng() * H;
        p.py = p.y;
        p.px = p.x;
        return p;
      }

      function initParticles() {
        particles = [];
        const n = params.particleCount | 0;
        for (let i = 0; i < n; i++) particles.push(makeParticle());
        lastCount = n;
      }

      // Grow/shrink the pool in place when particleCount changes live.
      function reconcileCount() {
        const target = params.particleCount | 0;
        if (target === lastCount) return;
        if (target > particles.length) {
          while (particles.length < target) particles.push(makeParticle());
        } else if (target < particles.length) {
          particles.length = target;
        }
        lastCount = target;
      }

      // Recapture a spent particle: re-ignite hot at the source. This is the
      // closed-loop mechanism — population never changes.
      function recapture(p) {
        recapturedTotal++;
        spawnAtSource(p);
      }

      function paintGround() {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);
      }

      // ---- boot ----
      paintGround();
      initParticles();

      return {
        step(dt) {
          // Frame-rate independence: normalize motion to a 60fps step.
          const f = Math.max(0.0001, dt / 16.6667);
          iter++;
          zTime += CONST.noiseDriftPerMs * dt;
          reconcileCount();

          // Read tunable knobs LIVE every frame.
          const ns    = CONST.baseFreq * params.noiseScale;
          const spd   = params.speed * DPR;   // scale to device px so look is DPR-stable
          const cool  = params.coolRate;
          const sA    = params.strokeAlpha;
          const fade  = params.fadeAlpha;
          const turns = CONST.fieldTurns;

          // OPTIONAL external coupling: map extDrive [0,1] (0.5 = neutral) to a
          // gentle, bounded born-heat factor in [0.6, 1.4]. When extDrive is null
          // (standalone) driveFactor is exactly 1 and every branch below is inert.
          const driveFactor = extDrive === null ? 1 : (0.6 + extDrive * 0.8);

          // Cache the global palette LUT ONCE per frame; sampled in the hot
          // particle loop below via sampleLUT(). Switching the global palette
          // recolors every particle on the next frame.
          const lut = Substrate.rampLUT();

          // Global gentle fade keeps the canvas in equilibrium (trails decay).
          ctx.globalCompositeOperation = "source-over";
          ctx.fillStyle = "rgba(10, 14, 11, " + fade + ")";
          ctx.fillRect(0, 0, W, H);

          // Additive strokes for luminous accumulation.
          ctx.globalCompositeOperation = "lighter";
          ctx.lineCap = "round";

          let tempSum = 0;

          for (let i = 0; i < particles.length; i++) {
            const p = particles[i];

            if (p.returning) {
              // ---- RECAPTURE PHASE: drift back toward the hot source ----
              const tx = p.homeX;
              const ty = sourceY();
              const dx = tx - p.x;
              const dy = ty - p.y;
              const d = Math.hypot(dx, dy) || 1;
              const rs = spd * 1.5 * f;
              p.px = p.x; p.py = p.y;
              p.x += (dx / d) * rs;
              p.y += (dy / d) * rs;

              // Faint cool return trace.
              const col = sampleLUT(lut, 0.10);
              ctx.strokeStyle = "rgba(" + col.r + "," + col.g + "," + col.b + "," + CONST.recaptureGlow + ")";
              ctx.lineWidth = 0.5 * DPR;
              ctx.beginPath();
              ctx.moveTo(p.px, p.py);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();

              if (d < 6 * DPR) {
                recapture(p); // arrived home -> re-ignite (born hot, p.t = 1.0)
                // Bounded injection-heat modulation from the patchbay signal.
                // Only fires under external coupling; clamped so the loop can
                // never be starved (t stays well above the recapture threshold).
                if (extDrive !== null) {
                  p.t = Math.max(0.15, Math.min(1.0, p.t * driveFactor));
                }
              }
              tempSum += p.t;
              continue;
            }

            // ---- ADVECTION PHASE ----
            // Flow angle from the fBm field; temporal offset drifts it slowly.
            const n = fbm(p.x * ns, p.y * ns + zTime, CONST.octaves);
            const angle = n * Math.PI * turns;

            // Temperature subtly biases flow (hot particles spread a touch).
            const vx = Math.cos(angle) * spd;
            const vy = Math.sin(angle) * spd + (p.t - 0.5) * 0.25 * DPR;

            p.px = p.x; p.py = p.y;
            p.x += vx * f;
            p.y += vy * f;

            // Cool as it travels (energy dissipates along the path).
            p.t -= cool * f;
            p.life += f;

            // Stroke colored by current temperature; hotter = brighter/thicker.
            const col = sampleLUT(lut, p.t);
            const a = sA * (0.45 + p.t * 0.55);
            ctx.strokeStyle = "rgba(" + col.r + "," + col.g + "," + col.b + "," + a + ")";
            ctx.lineWidth = p.w * (0.6 + p.t * 0.9) * DPR;
            ctx.beginPath();
            ctx.moveTo(p.px, p.py);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();

            tempSum += p.t;

            // ---- TRIGGER RECAPTURE: cooled, expired, or exited frame ----
            const cooled  = p.t <= 0.02;
            const expired = p.life >= p.maxLife;
            const exited  = p.x < -20 || p.x > W + 20 || p.y > H + 20;

            if (cooled || expired || exited) {
              // Begin a visible return journey rather than teleporting.
              p.returning = true;
              p.homeX = rng() * W;
              p.x = Math.max(-20, Math.min(W + 20, p.x));
              p.y = Math.max(-20, Math.min(H + 20, p.y));
              p.t = Math.max(p.t, 0.0);
            }
          }

          // Smooth the readout temperature toward the instantaneous mean.
          const inst = particles.length ? tempSum / particles.length : 0.5;
          meanTemp += (inst - meanTemp) * 0.04;

          // Restore default op for any downstream consumers.
          ctx.globalCompositeOperation = "source-over";
        },

        // ---- OPTIONAL patchbay coupling (safe to ignore in standalone use) ----

        // emit(): this system's "heat/exergy output" as a scalar in [0,1].
        // Backed by the same smoothed mean temperature behind TEMP/EXERGY.
        emit() {
          return Math.max(0, Math.min(1, meanTemp));
        },

        // absorb(signal): accept an external drive in [0,1] (0.5 = neutral).
        // Stored in extDrive and consumed by step() to gently modulate born
        // (injected) particle heat. Never called => extDrive stays null =>
        // standalone behavior is byte-for-byte identical.
        absorb(signal) {
          const s = Number(signal);
          extDrive = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : null;
        },

        // Restart the composition from a new random seed.
        reseed(newSeed) {
          rng = Substrate.rng(newSeed);
          noiseFn = Substrate.noise2D(newSeed);
          recapturedTotal = 0;
          iter = 0;
          zTime = 0;
          meanTemp = 0.5;
          paintGround();
          initParticles();
        },

        // Shell already resized the canvas backing store; rebuild size state.
        resize(w, h, newDpr) {
          W = w; H = h;
          if (newDpr) DPR = newDpr;
          paintGround();
          initParticles(); // positions are absolute pixels -> re-seed the field
        },

        // Live stats for the readout strip.
        readouts() {
          // Map mean temperature t in [0,1] to a plausible Kelvin range:
          // t=0 -> ~298 K (ambient/return), t=1 -> ~1873 K (hot dissipation).
          const T = 298 + meanTemp * (1873 - 298);
          const exergy = Math.max(0, (T - 298) / (1873 - 298)) * 100;
          return {
            TEMP:      T.toFixed(0) + 'K',
            EXERGY:    exergy.toFixed(0) + '%',
            PARTICLES: particles.length,
            RECAP:     recapturedTotal.toLocaleString(),
            LOOP:      'CLOSED',
          };
        },
      };
    },
  });
})();
