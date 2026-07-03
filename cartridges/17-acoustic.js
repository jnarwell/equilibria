/* ============================================================
   EQUILIBRIA · Cartridge 17 — ACOUSTIC  (Gorkov node trapping)

   Textbook acoustic levitation. A small array of point
   transducers (a ring) each radiate a wave of wavenumber
   k = 2pi/lambda with a steerable PHASE. The complex pressure
   field is the classic point-source sum:

       p(x,y) = sum_i  (A / max(r_i, eps)) * exp( i*(k*r_i + phase_i) )

   The time-averaged acoustic radiation (Gorkov) potential for a
   dense particle has minima at PRESSURE NODES; here we take the
   trapping potential U ~ |p(x,y)|^2, so particles seek the nodes
   (|p|^2 minima) of the standing wave — levitation.

   Each frame we compute a COARSE 128x128 grid of |p|^2 from the
   transducers, then push every particle DOWN the gradient of that
   grid (sampled from neighbours) with damping, so beads snap into
   the node lattice. A global phase offset (knob + slow auto-drift)
   applies a phase RAMP across the array — textbook phased-array
   steering — which translates the nodes and DRAGS the trapped
   beads. The faint standing-wave field is drawn behind the beads
   (nodes dark); beads glow additively, coloured by how tightly
   trapped they are through the GLOBAL palette.

   Public-domain acoustics only: generic transducer array, generic
   frequency, no control IP.
   ============================================================ */
(function () {
  'use strict';

  const GRID = 128;            // coarse |p|^2 potential grid (GRID x GRID)
  const MAX_PARTICLES = 4000;  // hard pool ceiling (see particles knob max)
  const EPS = 4.0;             // near-source softening on 1/r (pixels)
  const TAU = Math.PI * 2;
  const NODE_T = 0.12;         // normalized |p|^2 below this counts as "at a node"
  const FIELD_DIM = 0.32;      // how faint the background standing-wave field is
  const CBUCKETS = 32;         // per-frame quantized palette strings for beads

  // Colors come from the studio's GLOBAL generative palette
  // (window.Substrate.rampLUT / rampCSS) — never a hardcoded ramp — so a global
  // palette shuffle/drift recolors both the field and the beads live. The LUT is
  // sampled once per frame; per-bead we index a small cache of palette strings.

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

  Substrate.register({
    id: 'acoustic',
    name: 'Acoustic',
    blurb: 'Gorkov standing-wave node trapping',
    tags: ['acoustics', 'levitation', 'phased-array', 'physics'],

    // Knobs — read LIVE inside step(); the shell mutates this object in place.
    params: {
      frequency:   { label: 'Frequency',   min: 2, max: 12,   step: 0.1,  default: 6 },
      transducers: { label: 'Transducers', min: 2, max: 16,   step: 1,    default: 8,   int: true },
      phase:       { label: 'Steering',    min: 0, max: 1,    step: 0.01, default: 0 },
      damping:     { label: 'Damping',     min: 0.02, max: 0.4, step: 0.01, default: 0.12 },
      particles:   { label: 'Particles',   min: 400, max: 4000, step: 50, default: 1600, int: true },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });
      const DPR = dpr || 1;

      // Offscreen field canvas (GRID x GRID) blitted scaled-up for the soft field.
      const field = document.createElement('canvas');
      field.width = GRID; field.height = GRID;
      const fctx = field.getContext('2d');
      const fimg = fctx.createImageData(GRID, GRID);

      // Offscreen bead canvas (full res) — beads drawn here, then composited
      // sharp + blurred for an additive phosphor glow.
      const beads = document.createElement('canvas');
      const bctx = beads.getContext('2d');

      let W = 0, H = 0;         // canvas backing-store size (pixels)
      let sx = 1, sy = 1;       // grid-cell size in pixels (W/GRID, H/GRID)
      const pot = new Float32Array(GRID * GRID);   // normalized |p|^2 in [0,1]

      // Transducer array (point sources on a ring). Sized to the pool ceiling.
      const tx = new Float32Array(16), ty = new Float32Array(16);

      // Particles as structure-of-arrays. The full pool is seeded
      // deterministically; the live `particles` knob only changes how many we
      // STEP + DRAW, so growing/shrinking stays graceful and reproducible.
      const px = new Float32Array(MAX_PARTICLES);
      const py = new Float32Array(MAX_PARTICLES);
      const pvx = new Float32Array(MAX_PARTICLES);
      const pvy = new Float32Array(MAX_PARTICLES);

      let curSeed = seed >>> 0;
      let activeCount = clamp(params.particles | 0, 1, MAX_PARTICLES);
      let autoPhase = 0;        // slow deterministic steering drift (levitation creep)
      let effSteer = 0, lastSteer = 0, steerSpeed = 0;
      let trappedFrac = 0;      // fraction of beads sitting near nodes (emit/readout)
      let nodeCount = 0;        // counted local minima of the coarse potential

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; standalone dynamics byte-identical.
      // Otherwise a scalar in [0,1] (0.5 neutral); a BOUNDED nudge to the steering
      // phase, so an incoming signal drives the nodes to move.
      let extDrive = null;

      function seedParticles(seedVal) {
        const rng = Substrate.rng(seedVal >>> 0);
        for (let i = 0; i < MAX_PARTICLES; i++) {
          px[i] = rng() * W; py[i] = rng() * H;
          pvx[i] = 0; pvy[i] = 0;
        }
      }

      function buildWorld() {
        W = canvas.width; H = canvas.height;
        sx = W / GRID; sy = H / GRID;
        beads.width = W; beads.height = H;
        seedParticles(curSeed);
      }

      // Place `n` transducers on a ring centred on the field.
      function placeTransducers(n) {
        const cx = W * 0.5, cy = H * 0.5;
        const R = 0.46 * Math.min(W, H);
        for (let i = 0; i < n; i++) {
          const a = TAU * i / n;
          tx[i] = cx + Math.cos(a) * R;
          ty[i] = cy + Math.sin(a) * R;
        }
      }

      // Recompute the coarse |p|^2 grid from the transducer sum, normalize to
      // [0,1], and count node-like local minima. This is the ONLY place the full
      // transducer sum runs — particles just sample the cheap grid afterwards.
      function computeField(n, k, steer) {
        const cx = W * 0.5;
        // Phase RAMP across the array = phased-array steering: transducers offset
        // along +x lead in phase, tilting the wavefront and translating the nodes.
        // (A uniform phase would cancel in |p|^2, so a ramp is what actually moves
        // the lattice.)
        const ph = new Float64Array(n);
        for (let i = 0; i < n; i++) ph[i] = TAU * steer * ((tx[i] - cx) / (W || 1));

        let maxP = 1e-9;
        for (let j = 0; j < GRID; j++) {
          const wy = (j + 0.5) * sy;
          for (let i = 0; i < GRID; i++) {
            const wx = (i + 0.5) * sx;
            let re = 0, im = 0;
            for (let s = 0; s < n; s++) {
              const dx = wx - tx[s], dy = wy - ty[s];
              const r = Math.sqrt(dx * dx + dy * dy);
              const inv = 1 / (r > EPS ? r : EPS);
              const ang = k * r + ph[s];
              re += inv * Math.cos(ang);
              im += inv * Math.sin(ang);
            }
            const p2 = re * re + im * im;
            pot[j * GRID + i] = p2;
            if (p2 > maxP) maxP = p2;
          }
        }
        // Normalize to [0,1] so gradient descent + coloring are scale-free.
        const invMax = 1 / maxP;
        for (let m = 0; m < pot.length; m++) pot[m] *= invMax;

        // Count node-like local minima (a real readout).
        let nodes = 0;
        for (let j = 1; j < GRID - 1; j++) {
          for (let i = 1; i < GRID - 1; i++) {
            const c = pot[j * GRID + i];
            if (c > NODE_T) continue;
            if (c <= pot[j * GRID + i - 1] && c <= pot[j * GRID + i + 1] &&
                c <= pot[(j - 1) * GRID + i] && c <= pot[(j + 1) * GRID + i]) nodes++;
          }
        }
        nodeCount = nodes;
      }

      // Nearest-cell normalized potential at a pixel position.
      function potAtPixel(x, y) {
        let i = (x / sx) | 0, j = (y / sy) | 0;
        i = i < 0 ? 0 : i > GRID - 1 ? GRID - 1 : i;
        j = j < 0 ? 0 : j > GRID - 1 ? GRID - 1 : j;
        return pot[j * GRID + i];
      }

      // Push every active particle DOWN the potential gradient (toward nodes),
      // with velocity damping. force scales with cell size so motion is
      // resolution-independent.
      function stepParticles(damp) {
        const gain = 0.9;               // gradient-descent strength
        let trapped = 0;
        const n = activeCount;
        for (let a = 0; a < n; a++) {
          let x = px[a], y = py[a];
          let ci = (x / sx) | 0, cj = (y / sy) | 0;
          ci = ci < 1 ? 1 : ci > GRID - 2 ? GRID - 2 : ci;
          cj = cj < 1 ? 1 : cj > GRID - 2 ? GRID - 2 : cj;
          const base = cj * GRID + ci;
          // central-difference gradient of the normalized potential
          const gx = (pot[base + 1] - pot[base - 1]) * 0.5;
          const gy = (pot[base + GRID] - pot[base - GRID]) * 0.5;

          // accelerate downhill, damp velocity (higher damping = faster settle)
          let vx = pvx[a] * (1 - damp) - gx * gain * sx;
          let vy = pvy[a] * (1 - damp) - gy * gain * sy;
          x += vx; y += vy;

          // clamp inside the field; kill outward velocity at the walls
          if (x < 0) { x = 0; vx = 0; } else if (x > W - 1) { x = W - 1; vx = 0; }
          if (y < 0) { y = 0; vy = 0; } else if (y > H - 1) { y = H - 1; vy = 0; }

          px[a] = x; py[a] = y; pvx[a] = vx; pvy[a] = vy;
          if (potAtPixel(x, y) < NODE_T) trapped++;
        }
        trappedFrac += ((n ? trapped / n : 0) - trappedFrac) * 0.15;
      }

      // Render: dark bg -> faint standing-wave field (nodes dark) -> additive
      // glowing beads coloured by trapping tightness through the global palette.
      function render() {
        const lut = Substrate.rampLUT();   // 256*3, cached; sampled once per frame

        // faint background field: brighter at antinodes, near-black at nodes
        const fd = fimg.data;
        for (let m = 0, p = 0; m < pot.length; m++, p += 4) {
          const c = ((pot[m] * 255) | 0) * 3;
          fd[p]     = lut[c]     * FIELD_DIM;
          fd[p + 1] = lut[c + 1] * FIELD_DIM;
          fd[p + 2] = lut[c + 2] * FIELD_DIM;
          fd[p + 3] = 255;
        }
        fctx.putImageData(fimg, 0, 0);

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, W, H);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(field, 0, 0, GRID, GRID, 0, 0, W, H);

        // per-frame quantized palette strings so beads don't build a CSS string
        // each; tightly-trapped beads (low |p|^2) map to the bright warm end.
        const cols = render._cols || (render._cols = new Array(CBUCKETS));
        for (let b = 0; b < CBUCKETS; b++) {
          const c = (((b / (CBUCKETS - 1)) * 255) | 0) * 3;
          cols[b] = 'rgb(' + lut[c] + ',' + lut[c + 1] + ',' + lut[c + 2] + ')';
        }

        // draw beads onto the offscreen additively
        bctx.clearRect(0, 0, W, H);
        bctx.globalCompositeOperation = 'lighter';
        const sz = Math.max(1.5, 1.6 * DPR);
        const n = activeCount;
        for (let a = 0; a < n; a++) {
          const t = 1 - potAtPixel(px[a], py[a]);   // tightness: node -> ~1
          let b = (t * (CBUCKETS - 1)) | 0;
          if (b < 0) b = 0; else if (b > CBUCKETS - 1) b = CBUCKETS - 1;
          bctx.fillStyle = cols[b];
          bctx.globalAlpha = 0.35 + 0.55 * t;       // untrapped beads stay faint
          bctx.fillRect(px[a], py[a], sz, sz);
        }
        bctx.globalAlpha = 1;
        bctx.globalCompositeOperation = 'source-over';

        // composite beads: sharp cores + blurred bloom, both additive
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1;
        ctx.drawImage(beads, 0, 0);
        ctx.globalAlpha = 0.5;
        ctx.filter = 'blur(' + Math.max(3, W * 0.006) + 'px)';
        ctx.drawImage(beads, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      buildWorld();

      return {
        step(dt) {
          // Read knobs LIVE each frame (shell mutates params in place).
          const nHalf = clamp(params.frequency, 2, 12);
          const n = clamp(params.transducers | 0, 2, 16);
          const damp = clamp(params.damping, 0.02, 0.4);
          activeCount = clamp(params.particles | 0, 1, MAX_PARTICLES);

          // k so that `nHalf` half-wavelengths span the field width (in pixels):
          // lambda = 2*W/nHalf  ->  k = 2pi/lambda = pi*nHalf/W.
          const k = Math.PI * nHalf / (W || 1);

          // slow deterministic steering drift so the lattice gently creeps
          autoPhase += (dt || 16) * 0.001 * 0.02;

          // effective steering phase: knob + drift + optional bounded coupling.
          // extDrive nudges the steering (incoming signal moves the nodes); when
          // null this term vanishes so standalone dynamics are byte-identical.
          let steer = params.phase + autoPhase;
          if (extDrive !== null) steer += (extDrive - 0.5) * 0.6;

          steerSpeed += (Math.abs(steer - lastSteer) / ((dt || 16) * 0.001) - steerSpeed) * 0.2;
          lastSteer = steer; effSteer = steer;

          placeTransducers(n);
          computeField(n, k, steer);
          stepParticles(damp);
          render();
        },

        // Restart: re-seed the bead pool + zero the drift/phase state.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          activeCount = clamp(params.particles | 0, 1, MAX_PARTICLES);
          seedParticles(curSeed);
          autoPhase = 0; lastSteer = 0; steerSpeed = 0;
          trappedFrac = 0;
        },

        // Window resized: rebuild size-dependent buffers; beads re-seeded
        // deterministically so the composition is stable.
        resize() { buildWorld(); },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): trapping order in [0,1] = fraction of beads sitting near nodes
        // (low |p|^2). Rises as the array locks the beads into the lattice.
        emit() { return clamp01(trappedFrac); },

        // absorb(signal): store an external scalar in [0,1] (0.5 neutral) used as
        // a BOUNDED nudge to the steering phase inside step().
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? clamp(s, 0, 1) : 0.5;
        },

        readouts() {
          return {
            PARTICLES: activeCount,
            NODES: nodeCount,
            STATE: steerSpeed > 0.02 ? 'STEERING' : 'TRAPPED',
          };
        },
      };
    },
  });
})();
