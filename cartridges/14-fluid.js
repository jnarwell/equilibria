/* ============================================================
   EQUILIBRIA · Cartridge 14 — STABLE FLUIDS  (smoke / ink)

   Jos Stam's "Stable Fluids" (SIGGRAPH 1999) semi-Lagrangian
   Navier–Stokes solver with dye advection. Per frame:
     1. animated emitters inject dye + directional force
     2. vorticity confinement (curl) + buoyancy forcing
     3. velStep : diffuse → project → advect → project
     4. densStep: advect dye, then dissipate
   The pressure Poisson solve uses a handful of Gauss–Seidel /
   Jacobi iterations; advection back-traces velocity, so the
   method is unconditionally stable. The emitters slowly orbit
   and rotate on their own, so the field self-drives forever
   with no user input. Dye is blitted scaled-up with smoothing
   and an additive bloom, coloured through the thermal→verdant
   ramp (dense / fast = amber-hot, calm = verdant).

   Conforms to the Substrate cartridge contract. The shell
   supplies the canvas, knobs, reseed, readouts, export chrome.
   ============================================================ */
(function () {
  'use strict';

  const TARGET_CELLS = 21000; // total sim cells budget (CPU-bounded)
  const MIN_DIM = 40, MAX_DIM = 210;
  const N_EMITTERS = 3;
  const DIFFUSE_ITERS = 4;    // gentle; pressure uses the live `iterations` knob

  // Forcing gains (blind-tuned constants; knobs scale these live).
  const DYE_AMT = 22;   // dye injected per emitter core per second
  const VEL_K   = 46;   // emitter velocity impulse gain
  const VORT_K  = 9;    // vorticity-confinement gain
  const BUOY_K  = 7;    // buoyancy (dye rises)
  const DENS_SCALE = 0.6, SPEED_SCALE = 0.03;

  // --- thermal -> verdant palette LUT (calm verdant → dense/hot amber) ---
  const STOPS = [
    [0.00, [10, 14, 11]],     // near-black background   #0a0e0b
    [0.10, [27, 77, 62]],     // deep verdant            #1b4d3e
    [0.28, [42, 157, 143]],   // verdigris               #2a9d8f
    [0.48, [0, 255, 156]],    // phosphor                #00ff9c
    [0.66, [212, 160, 23]],   // warm gold               #d4a017
    [0.85, [255, 123, 0]],    // amber                   #ff7b00
    [1.00, [255, 77, 0]]      // hottest core            #ff4d00
  ];
  const LUT = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = STOPS[0], b = STOPS[STOPS.length - 1];
    for (let s = 1; s < STOPS.length; s++) {
      if (t <= STOPS[s][0]) { a = STOPS[s - 1]; b = STOPS[s]; break; }
    }
    const f = (t - a[0]) / (b[0] - a[0] || 1);
    LUT[i * 3]     = a[1][0] + (b[1][0] - a[1][0]) * f;
    LUT[i * 3 + 1] = a[1][1] + (b[1][1] - a[1][1]) * f;
    LUT[i * 3 + 2] = a[1][2] + (b[1][2] - a[1][2]) * f;
  }

  Substrate.register({
    id: 'fluid',
    name: 'Stable Fluids',
    blurb: 'semi-Lagrangian smoke',
    tags: ['fluid', 'navier-stokes', 'stam', 'smoke'],

    // Knobs — read LIVE inside step(). Defaults = a calm, always-swirling plume.
    params: {
      viscosity:   { label: 'Viscosity',   min: 0,    max: 0.001, step: 0.00001, default: 0.0001 },
      dissipation: { label: 'Dye fade',    min: 0.9,  max: 1.0,   step: 0.001,   default: 0.985  },
      force:       { label: 'Force',       min: 0,    max: 5,     step: 0.05,    default: 2.0    },
      iterations:  { label: 'Pressure it', min: 6,    max: 40,    step: 1,       default: 16, int: true },
      swirl:       { label: 'Swirl',       min: 0,    max: 3,     step: 0.01,    default: 1.0    },
    },

    create({ canvas, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });

      // Offscreen sim-resolution canvas we colorize then blit scaled-up.
      const grid = document.createElement('canvas');
      const gctx = grid.getContext('2d');

      let nx = 0, ny = 0, size = 0;
      let u, v, u0, v0, dens, dens0, curl; // Float32 fields (swapped by reference)
      let img = null;
      let emitters = [];
      let curSeed = seed >>> 0;
      let tSec = 0;               // self-running clock (seconds)
      let meanSpeed = 0, meanKE = 0;

      // Optional coupling. extDrive === null => byte-identical to standalone.
      // Otherwise a scalar in [0,1] (0.5 neutral) that nudges emitter force
      // and swirl within a clamped band, so an incoming signal energizes flow.
      let extDrive = null;

      // -------------------------------------------------- helpers
      function setBnd(b, x) {
        for (let j = 1; j < ny - 1; j++) {
          x[j * nx]            = b === 1 ? -x[1 + j * nx]      : x[1 + j * nx];
          x[nx - 1 + j * nx]   = b === 1 ? -x[nx - 2 + j * nx] : x[nx - 2 + j * nx];
        }
        for (let i = 1; i < nx - 1; i++) {
          x[i]                 = b === 2 ? -x[i + nx]          : x[i + nx];
          x[i + (ny - 1) * nx] = b === 2 ? -x[i + (ny - 2) * nx] : x[i + (ny - 2) * nx];
        }
        x[0]                     = 0.5 * (x[1] + x[nx]);
        x[(ny - 1) * nx]         = 0.5 * (x[1 + (ny - 1) * nx] + x[(ny - 2) * nx]);
        x[nx - 1]                = 0.5 * (x[nx - 2] + x[nx - 1 + nx]);
        x[nx - 1 + (ny - 1) * nx] = 0.5 * (x[nx - 2 + (ny - 1) * nx] + x[nx - 1 + (ny - 2) * nx]);
      }

      function linSolve(b, x, x0, a, c, iter) {
        const invc = 1 / c;
        for (let k = 0; k < iter; k++) {
          for (let j = 1; j < ny - 1; j++) {
            const row = j * nx;
            for (let i = 1; i < nx - 1; i++) {
              const idx = i + row;
              x[idx] = (x0[idx] + a * (x[idx - 1] + x[idx + 1] + x[idx - nx] + x[idx + nx])) * invc;
            }
          }
          setBnd(b, x);
        }
      }

      function diffuse(b, x, x0, diff, dt, iter) {
        const a = dt * diff * nx * ny;
        if (a < 1e-6) { x.set(x0); setBnd(b, x); return; }
        linSolve(b, x, x0, a, 1 + 4 * a, iter);
      }

      // Semi-Lagrangian back-trace. u,v are in cells/second; dt in seconds.
      function advect(b, d, d0, uu, vv, dt) {
        const maxx = nx - 1.5, maxy = ny - 1.5;
        for (let j = 1; j < ny - 1; j++) {
          const row = j * nx;
          for (let i = 1; i < nx - 1; i++) {
            const idx = i + row;
            let x = i - dt * uu[idx];
            let y = j - dt * vv[idx];
            if (x < 0.5) x = 0.5; else if (x > maxx) x = maxx;
            if (y < 0.5) y = 0.5; else if (y > maxy) y = maxy;
            const i0 = x | 0, j0 = y | 0, i1 = i0 + 1, j1 = j0 + 1;
            const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
            const a0 = i0 + j0 * nx, a1 = i0 + j1 * nx;
            const b0 = i1 + j0 * nx, b1 = i1 + j1 * nx;
            d[idx] = s0 * (t0 * d0[a0] + t1 * d0[a1]) + s1 * (t0 * d0[b0] + t1 * d0[b1]);
          }
        }
        setBnd(b, d);
      }

      function project(uu, vv, p, div, iter) {
        const M = 0.5 * (nx + ny);
        for (let j = 1; j < ny - 1; j++) {
          const row = j * nx;
          for (let i = 1; i < nx - 1; i++) {
            const idx = i + row;
            div[idx] = -0.5 * (uu[idx + 1] - uu[idx - 1] + vv[idx + nx] - vv[idx - nx]) / M;
            p[idx] = 0;
          }
        }
        setBnd(0, div); setBnd(0, p);
        linSolve(0, p, div, 1, 4, iter);
        for (let j = 1; j < ny - 1; j++) {
          const row = j * nx;
          for (let i = 1; i < nx - 1; i++) {
            const idx = i + row;
            uu[idx] -= 0.5 * M * (p[idx + 1] - p[idx - 1]);
            vv[idx] -= 0.5 * M * (p[idx + nx] - p[idx - nx]);
          }
        }
        setBnd(1, uu); setBnd(2, vv);
      }

      // Full Stam velocity step (reads viscosity + pressure-iters live).
      function velStep(visc, dt, iter) {
        let tmp;
        tmp = u0; u0 = u; u = tmp;               // SWAP(u0,u)
        diffuse(1, u, u0, visc, dt, DIFFUSE_ITERS);
        tmp = v0; v0 = v; v = tmp;               // SWAP(v0,v)
        diffuse(2, v, v0, visc, dt, DIFFUSE_ITERS);
        project(u, v, u0, v0, iter);
        tmp = u0; u0 = u; u = tmp;
        tmp = v0; v0 = v; v = tmp;
        advect(1, u, u0, u0, v0, dt);
        advect(2, v, v0, u0, v0, dt);
        project(u, v, u0, v0, iter);
      }

      function densStep(dt) {
        let tmp;
        tmp = dens0; dens0 = dens; dens = tmp;   // SWAP(dens0,dens)
        advect(0, dens, dens0, u, v, dt);
        const dis = params.dissipation;
        for (let i = 0; i < size; i++) dens[i] *= dis;
      }

      // Curl / vorticity confinement keeps the flow swirling; buoyancy lifts dye.
      function vortAndBuoy(swirl, dt) {
        for (let j = 1; j < ny - 1; j++) {
          const row = j * nx;
          for (let i = 1; i < nx - 1; i++) {
            const idx = i + row;
            curl[idx] = 0.5 * ((v[idx + 1] - v[idx - 1]) - (u[idx + nx] - u[idx - nx]));
          }
        }
        for (let j = 1; j < ny - 1; j++) {
          const row = j * nx;
          for (let i = 1; i < nx - 1; i++) {
            const idx = i + row;
            const dwdx = 0.5 * (Math.abs(curl[idx + 1]) - Math.abs(curl[idx - 1]));
            const dwdy = 0.5 * (Math.abs(curl[idx + nx]) - Math.abs(curl[idx - nx]));
            const len = Math.sqrt(dwdx * dwdx + dwdy * dwdy) + 1e-5;
            const w = curl[idx];
            u[idx] += swirl * VORT_K * (dwdy / len) * w * dt;
            v[idx] += swirl * VORT_K * (-(dwdx / len)) * w * dt;
            v[idx] -= BUOY_K * dens[idx] * dt;   // dye rises
          }
        }
      }

      // -------------------------------------------------- emitters (self-driving)
      function buildEmitters(seedVal) {
        const rng = Substrate.rng(seedVal >>> 0);
        emitters = [];
        for (let e = 0; e < N_EMITTERS; e++) {
          emitters.push({
            cx: 0.25 + rng() * 0.5,          // orbit center (grid fraction)
            cy: 0.30 + rng() * 0.5,
            r:  0.06 + rng() * 0.14,         // orbit radius
            phase: rng() * Math.PI * 2,
            w:  (0.15 + rng() * 0.35) * (rng() < 0.5 ? -1 : 1), // orbit rate
            dir: rng() * Math.PI * 2,        // injection heading
            spin: (0.2 + rng() * 0.6) * (rng() < 0.5 ? -1 : 1), // heading rotation
            wob: 0.3 + rng() * 0.7,          // heading wobble rate
          });
        }
      }

      function injectEmitters(dt) {
        // Effective force/swirl — nudged by coupling only when extDrive is set.
        let force = params.force, swirl = params.swirl;
        if (extDrive !== null) {
          const k = (extDrive - 0.5) * 0.6;    // ±0.3 band
          force = Math.max(0, force * (1 + k));
          swirl = Math.max(0, swirl * (1 + k));
        }
        const rad = Math.max(2, Math.round(Math.min(nx, ny) * 0.03));
        const sig2 = 2 * (rad * 0.6) * (rad * 0.6);
        for (const e of emitters) {
          e.phase += e.w * dt;
          e.dir += e.spin * dt;
          const ang = e.dir + Math.sin(tSec * e.wob) * 0.8;
          const dx = Math.cos(ang), dy = Math.sin(ang);
          const gx = (e.cx + e.r * Math.cos(e.phase)) * nx;
          const gy = (e.cy + e.r * Math.sin(e.phase)) * ny;
          const ci = Math.max(rad + 1, Math.min(nx - rad - 2, gx | 0));
          const cj = Math.max(rad + 1, Math.min(ny - rad - 2, gy | 0));
          for (let oy = -rad; oy <= rad; oy++) {
            for (let ox = -rad; ox <= rad; ox++) {
              const fall = Math.exp(-(ox * ox + oy * oy) / sig2);
              if (fall < 0.02) continue;
              const idx = (ci + ox) + (cj + oy) * nx;
              dens[idx] += DYE_AMT * fall * dt;
              u[idx] += dx * force * VEL_K * fall * dt;
              v[idx] += dy * force * VEL_K * fall * dt;
            }
          }
        }
        return swirl;
      }

      // -------------------------------------------------- render
      function render() {
        const data = img.data;
        let sSum = 0, keSum = 0;
        for (let i = 0, p = 0; i < size; i++, p += 4) {
          const uu = u[i], vv = v[i];
          const sp = Math.sqrt(uu * uu + vv * vv);
          sSum += sp; keSum += 0.5 * (uu * uu + vv * vv);
          const densT = 1 - Math.exp(-dens[i] * DENS_SCALE);
          const spN   = 1 - Math.exp(-sp * SPEED_SCALE);
          let t = densT * 0.78 + spN * 0.42 * densT; // speed only heats where dye is
          if (t > 1) t = 1; else if (t < 0) t = 0;
          const c = ((t * 255) | 0) * 3;
          data[p]     = LUT[c];
          data[p + 1] = LUT[c + 1];
          data[p + 2] = LUT[c + 2];
          data[p + 3] = 255;
        }
        meanSpeed = sSum / size;
        meanKE = keSum / size;
        gctx.putImageData(img, 0, 0);

        const cw = canvas.width, ch = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, cw, ch);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(grid, 0, 0, nx, ny, 0, 0, cw, ch);

        // additive bloom
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5;
        ctx.filter = 'blur(' + Math.max(6, cw * 0.012) + 'px)';
        ctx.drawImage(grid, 0, 0, nx, ny, 0, 0, cw, ch);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // -------------------------------------------------- build / (re)size
      function buildGrid() {
        const cw = canvas.width, ch = canvas.height;
        const aspect = (cw && ch) ? cw / ch : 1;
        if (aspect >= 1) {
          ny = Math.round(Math.sqrt(TARGET_CELLS / aspect));
          nx = Math.round(ny * aspect);
        } else {
          nx = Math.round(Math.sqrt(TARGET_CELLS * aspect));
          ny = Math.round(nx / aspect);
        }
        nx = Math.max(MIN_DIM, Math.min(MAX_DIM, nx));
        ny = Math.max(MIN_DIM, Math.min(MAX_DIM, ny));
        size = nx * ny;
        grid.width = nx; grid.height = ny;
        img = gctx.createImageData(nx, ny);
        u = new Float32Array(size);  v = new Float32Array(size);
        u0 = new Float32Array(size); v0 = new Float32Array(size);
        dens = new Float32Array(size); dens0 = new Float32Array(size);
        curl = new Float32Array(size);
        buildEmitters(curSeed);
      }

      buildGrid();

      return {
        step(dt) {
          tSec += Math.min(dt * 0.001, 0.05);
          const dtS = Math.min(Math.max(dt * 0.001, 0.001), 0.033); // clamp for stability
          const visc = params.viscosity;
          const iters = Math.max(1, params.iterations | 0);

          const swirl = injectEmitters(dtS);   // reads force/swirl live (+ coupling)
          vortAndBuoy(swirl, dtS);
          velStep(visc, dtS, iters);
          densStep(dtS);
          render();
        },

        // Restart from a new seed: fresh (empty) fields + new emitter layout.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          u.fill(0); v.fill(0); u0.fill(0); v0.fill(0);
          dens.fill(0); dens0.fill(0); curl.fill(0);
          tSec = 0;
          buildEmitters(curSeed);
        },

        // Aspect may have changed: rebuild size-dependent buffers.
        resize() { buildGrid(); },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): mean kinetic energy of the field, normalized to [0,1].
        emit() {
          const e = 1 - Math.exp(-meanKE * 0.004);
          return e < 0 ? 0 : e > 1 ? 1 : e;
        },
        // absorb(signal): store a [0,1] scalar (0.5 neutral) that nudges emitter
        // force + swirl within a clamped band. Null until first call → standalone
        // dynamics are byte-for-byte identical.
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          const e = 1 - Math.exp(-meanKE * 0.004);
          const state = e < 0.05 ? 'SETTLING' : e > 0.55 ? 'TURBULENT' : 'FLOWING';
          return {
            GRID: nx + '×' + ny,
            ENERGY: (Math.min(1, e) * 100).toFixed(0) + '%',
            SPEED: meanSpeed.toFixed(1),
            STATE: state,
          };
        },
      };
    },
  });
})();
