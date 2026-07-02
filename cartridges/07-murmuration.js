/* ============================================================
   EQUILIBRIA · Cartridge 07 — MURMURATION  (emergent flocking)

   Craig Reynolds' Boids (1986). Each agent steers by three local
   rules against neighbors inside a radius:
     SEPARATION — steer away from crowding
     ALIGNMENT  — match neighbors' mean heading
     COHESION   — steer toward neighbors' center of mass
   plus a max-speed limit and wrap-around boundary. Nothing is
   scripted; the living starling-flock murmuration emerges purely
   from the three rules.

   PERFORMANCE: naive O(N^2) neighbor search is too slow for a few
   thousand boids, so neighbor queries go through a SPATIAL HASH
   (uniform grid, head/next linked-list buckets, zero per-frame
   allocation). Each boid only tests the 3x3 grid cells around it.

   Ported to the Substrate cartridge contract — the shell supplies
   the canvas, knobs, reseed, readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  const CAP = 5000;              // max boids ever allocated (= count knob max)

  // --- thermal -> verdant palette LUT ------------------------------------
  // Low t (slow / sparse) = verdant; high t (fast / dense) = amber -> hot.
  const STOPS = [
    [0.00, [42, 157, 143]],   // verdigris   #2a9d8f  (slow / lonely)
    [0.30, [0, 255, 156]],    // phosphor    #00ff9c
    [0.60, [212, 160, 23]],   // warm gold   #d4a017
    [0.82, [255, 123, 0]],    // amber       #ff7b00
    [1.00, [255, 77, 0]],     // hot core    #ff4d00  (fast / packed)
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
    id: 'murmuration',
    name: 'Murmuration',
    blurb: 'emergent flocking',
    tags: ['boids', 'flocking', 'emergence', 'reynolds'],

    // Knobs — read LIVE inside step(). Defaults tuned for a coherent flock.
    params: {
      count:          { label: 'Boids',        min: 500, max: CAP, step: 50,   default: 2200, int: true },
      separation:     { label: 'Separation',   min: 0,   max: 3,   step: 0.01, default: 1.4  },
      alignment:      { label: 'Alignment',    min: 0,   max: 3,   step: 0.01, default: 1.0  },
      cohesion:       { label: 'Cohesion',     min: 0,   max: 3,   step: 0.01, default: 0.9  },
      maxSpeed:       { label: 'Max speed',    min: 1,   max: 6,   step: 0.1,  default: 3.0  },
      neighborRadius: { label: 'Neighbor r',   min: 10,  max: 80,  step: 1,    default: 34   },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });
      const scale = dpr || 1;    // work in device px; scale knobs by dpr so the
                                 // flock looks identical at any pixel density.

      // --- boid state (flat typed arrays for cache-friendly iteration) ---
      const px = new Float32Array(CAP);   // position x  (device px)
      const py = new Float32Array(CAP);   // position y
      const vx = new Float32Array(CAP);   // velocity x  (device px / frame)
      const vy = new Float32Array(CAP);   // velocity y
      const nbr = new Uint16Array(CAP);   // neighbor count this frame (density)

      let N = 0;                          // live boid count (window into CAP)
      let W = canvas.width, H = canvas.height;
      let curSeed = seed >>> 0;

      // --- spatial hash (uniform grid, head/next linked list) ------------
      // Rebuilt every frame because neighborRadius (cell size) is a live knob.
      let cols = 1, rows = 1, cell = 1;
      let head = new Int32Array(1);       // head[cellIdx] -> first boid, or -1
      const next = new Int32Array(CAP);   // next[boid]    -> next boid in cell

      // --- optional cross-cartridge coupling ---
      // extDrive === null => no coupling; dynamics byte-identical to standalone.
      // Otherwise a scalar in [0,1] (0.5 neutral) that applies a BOUNDED nudge
      // to effective cohesion, clamped so the flock never collapses/explodes.
      let extDrive = null;

      let order = 0;                      // last computed order parameter [0,1]

      // Deterministically seed all CAP boids from a seed. The count knob then
      // just windows the first N of them, so growing/shrinking is graceful and
      // reproducible (revealed boids already have valid, seeded state).
      function seedFlock(seedVal) {
        const rng = Substrate.rng(seedVal >>> 0);
        const sp = params.maxSpeed * scale;
        for (let i = 0; i < CAP; i++) {
          px[i] = rng() * W;
          py[i] = rng() * H;
          const ang = rng() * Math.PI * 2;
          const s = sp * (0.5 + 0.5 * rng());
          vx[i] = Math.cos(ang) * s;
          vy[i] = Math.sin(ang) * s;
        }
        N = clampCount(params.count | 0);
      }

      function clampCount(c) { return c < 1 ? 1 : c > CAP ? CAP : c; }

      // Size the hash grid for the current canvas + neighbor radius.
      function rebuildGridExtents(radius) {
        cell = Math.max(1, radius);
        cols = Math.max(1, Math.ceil(W / cell));
        rows = Math.max(1, Math.ceil(H / cell));
        const needed = cols * rows;
        if (head.length < needed) head = new Int32Array(needed);
      }

      // Bucket every live boid into the grid (linked-list heads).
      function hashBoids() {
        const nCells = cols * rows;
        for (let c = 0; c < nCells; c++) head[c] = -1;
        for (let i = 0; i < N; i++) {
          let cx = (px[i] / cell) | 0;
          let cy = (py[i] / cell) | 0;
          if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
          if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
          const idx = cy * cols + cx;
          next[i] = head[idx];
          head[idx] = i;
        }
      }

      seedFlock(curSeed);

      // One flocking step: accumulate the three rules over hashed neighbors,
      // apply Reynolds-style normalized steering, integrate, wrap.
      function update() {
        const radius = params.neighborRadius * scale;
        const rad2 = radius * radius;
        const sepR = radius * 0.5;          // separation acts closer in
        const sepR2 = sepR * sepR;
        const maxSpeed = params.maxSpeed * scale;
        const maxForce = 0.05 * maxSpeed;   // per-frame steering cap
        const wSep = params.separation;
        const wAli = params.alignment;

        // Base cohesion = live slider; external drive adds a bounded nudge on
        // top, clamped to a viable band so the murmuration stays coherent.
        let wCoh = params.cohesion;
        if (extDrive !== null) {
          wCoh = wCoh + (extDrive - 0.5) * 1.2;   // bounded ±0.6 nudge
          if (wCoh < 0.1) wCoh = 0.1; else if (wCoh > 2.5) wCoh = 2.5;
        }

        rebuildGridExtents(radius);
        hashBoids();

        let sumHx = 0, sumHy = 0;           // for order parameter (mean heading)

        for (let i = 0; i < N; i++) {
          const x = px[i], y = py[i];
          const cx0 = Math.min(cols - 1, Math.max(0, (x / cell) | 0));
          const cy0 = Math.min(rows - 1, Math.max(0, (y / cell) | 0));

          let aliX = 0, aliY = 0;           // sum of neighbor velocities
          let cohX = 0, cohY = 0;           // sum of neighbor positions
          let sepX = 0, sepY = 0;           // accumulated repulsion
          let n = 0, nSep = 0;

          // Scan the 3x3 block of grid cells around this boid.
          for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
            if (gy < 0 || gy >= rows) continue;
            for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
              if (gx < 0 || gx >= cols) continue;
              for (let j = head[gy * cols + gx]; j !== -1; j = next[j]) {
                if (j === i) continue;
                const dx = x - px[j], dy = y - py[j];
                const d2 = dx * dx + dy * dy;
                if (d2 > 0 && d2 < rad2) {
                  n++;
                  aliX += vx[j]; aliY += vy[j];
                  cohX += px[j]; cohY += py[j];
                  if (d2 < sepR2) {         // repel, weighted by 1/distance
                    const inv = 1 / Math.sqrt(d2);
                    sepX += dx * inv * inv;
                    sepY += dy * inv * inv;
                    nSep++;
                  }
                }
              }
            }
          }

          let ax = 0, ay = 0;

          if (n > 0) {
            // ALIGNMENT: steer toward neighbors' mean velocity.
            ax += steerToward(aliX / n, aliY / n, vx[i], vy[i], maxSpeed, maxForce, wAli, acc, 0);
            ay += acc[1];
            // COHESION: steer toward neighbors' center of mass.
            ax += steerToward(cohX / n - x, cohY / n - y, vx[i], vy[i], maxSpeed, maxForce, wCoh, acc, 1);
            ay += acc[1];
          }
          if (nSep > 0) {
            // SEPARATION: steer along the mean repulsion vector.
            ax += steerToward(sepX / nSep, sepY / nSep, vx[i], vy[i], maxSpeed, maxForce, wSep, acc, 2);
            ay += acc[1];
          }

          // Integrate velocity, clamp to max speed.
          let nvx = vx[i] + ax, nvy = vy[i] + ay;
          const sp = Math.sqrt(nvx * nvx + nvy * nvy);
          if (sp > maxSpeed && sp > 0) { const k = maxSpeed / sp; nvx *= k; nvy *= k; }
          vx[i] = nvx; vy[i] = nvy;
          nbr[i] = n > 65535 ? 65535 : n;

          // Contribution to the flock order parameter (mean unit heading).
          if (sp > 1e-6) { sumHx += nvx / sp; sumHy += nvy / sp; }
        }

        // Second pass: move + wrap (kept separate so neighbor reads use the
        // consistent pre-move positions above).
        for (let i = 0; i < N; i++) {
          let x = px[i] + vx[i], y = py[i] + vy[i];
          if (x < 0) x += W; else if (x >= W) x -= W;
          if (y < 0) y += H; else if (y >= H) y -= H;
          px[i] = x; py[i] = y;
        }

        // Order parameter = magnitude of the mean normalized velocity, clamped.
        const mag = N > 0 ? Math.sqrt(sumHx * sumHx + sumHy * sumHy) / N : 0;
        order = mag < 0 ? 0 : mag > 1 ? 1 : mag;
      }

      // Reynolds normalized steering: desired = normalize(target)*maxSpeed,
      // steer = limit(desired - vel, maxForce), returns weight*steer.x and
      // writes weight*steer.y into out[1]. Scale-robust, so weights stay tidy.
      const acc = [0, 0];
      function steerToward(tx, ty, velX, velY, maxSpeed, maxForce, weight, out, slot) {
        const tl = Math.sqrt(tx * tx + ty * ty);
        if (tl < 1e-9) { out[1] = 0; return 0; }
        const dx = tx / tl * maxSpeed - velX;
        const dy = ty / tl * maxSpeed - velY;
        const sl = Math.sqrt(dx * dx + dy * dy);
        let fx = dx, fy = dy;
        if (sl > maxForce && sl > 0) { const k = maxForce / sl; fx *= k; fy *= k; }
        out[1] = fy * weight;
        return fx * weight;   // slot kept for readability / future per-rule use
      }

      // Draw oriented streaks with motion trails + additive glow.
      function render() {
        // Slight translucent wash each frame => persistence-of-vision trails.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(10, 14, 11, 0.20)';   // #0a0e0b, low alpha
        ctx.fillRect(0, 0, W, H);

        // Boids glow additively.
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        const lw = Math.max(1, 1.1 * scale);
        ctx.lineWidth = lw;
        const maxSpeed = params.maxSpeed * scale;
        const streak = 4 * scale;

        for (let i = 0; i < N; i++) {
          const vX = vx[i], vY = vy[i];
          const sp = Math.sqrt(vX * vX + vY * vY);

          // Color by local density (dominant) blended with speed.
          const dens = nbr[i] / 24;                       // ~24 neighbors -> hot
          const fast = maxSpeed > 0 ? sp / maxSpeed : 0;
          let t = 0.30 + dens * 0.55 + fast * 0.15;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const c = (t * 255 | 0) * 3;

          const x = px[i], y = py[i];
          const inv = sp > 1e-6 ? streak / sp : 0;
          ctx.strokeStyle = 'rgb(' + LUT[c] + ',' + LUT[c + 1] + ',' + LUT[c + 2] + ')';
          ctx.beginPath();
          ctx.moveTo(x - vX * inv, y - vY * inv);         // tail (back along vel)
          ctx.lineTo(x, y);                               // head
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      return {
        step() {
          // Read the count knob live; window / grow the flock gracefully.
          const want = clampCount(params.count | 0);
          if (want !== N) N = want;

          update();
          render();
        },

        // Restart the murmuration from a new seed (re-inits every boid).
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          seedFlock(curSeed);
        },

        // Window resized: adopt new bounds and fold existing boids inside them.
        // No re-seed, so the flock keeps flowing across a resize.
        resize(w, h) {
          W = w || canvas.width;
          H = h || canvas.height;
          for (let i = 0; i < CAP; i++) {
            px[i] = ((px[i] % W) + W) % W;
            py[i] = ((py[i] % H) + H) % H;
          }
        },

        // --- OPTIONAL coupling API (safe to ignore standalone) ---
        // emit(): flock ORDER PARAMETER in [0,1] = magnitude of the mean
        // normalized velocity. 1 = a perfectly aligned murmuration, 0 = an
        // incoherent scatter.
        emit() { return order; },

        // absorb(signal): couple to an external scalar in [0,1] (0.5 neutral).
        // Stored in extDrive and applied as a bounded cohesion nudge in update.
        // Passing null (shell does this on decouple) restores standalone mode.
        absorb(signal) {
          if (signal === null || signal === undefined) { extDrive = null; return; }
          const s = +signal;
          extDrive = Number.isFinite(s) ? (s < 0 ? 0 : s > 1 ? 1 : s) : 0.5;
        },

        readouts() {
          return {
            BOIDS: N,
            ORDER: (order * 100).toFixed(0) + '%',
            STATE: order >= 0.5 ? 'FLOCKING' : 'SCATTERED',
          };
        },
      };
    },
  });
})();
