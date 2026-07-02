/* ============================================================
   EQUILIBRIA · Cartridge 11 — DIFFERENTIAL GROWTH  (organic winding boundary)

   A closed path of ordered nodes evolves under three local forces:
     (1) ATTRACTION — each node springs toward its two ring-neighbors,
         holding segment length near a target.
     (2) REPULSION — each node pushes away from any other node inside
         repelRadius (queried through a SPATIAL HASH, not O(N^2)).
     (3) ALIGNMENT — a slight pull toward the midpoint of its neighbors,
         smoothing the curve.
   When a segment stretches past maxSegment a new node is inserted at its
   midpoint. That lengthening is the "growth": the boundary must fold to
   fit, producing endless coral / intestine / leaf-margin wrinkling.

   The loop is immortal: at maxNodes it reseeds a fresh circle (STATE RESET).

   Conforms to the Substrate cartridge contract. The shell supplies the
   canvas, knobs, reseed, live readouts, export + overlay chrome.
   ============================================================ */
(function () {
  'use strict';

  // --- thermal -> verdant palette LUT (straight edges verdant, folds hot) ---
  const STOPS = [
    [0.00, [27, 77, 62]],     // deep verdant           #1b4d3e
    [0.20, [42, 157, 143]],   // verdigris              #2a9d8f
    [0.42, [0, 255, 156]],    // phosphor               #00ff9c
    [0.62, [212, 160, 23]],   // warm gold              #d4a017
    [0.82, [255, 123, 0]],    // amber                  #ff7b00
    [1.00, [255, 77, 0]]      // hottest fold           #ff4d00
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
  const BUCKETS = 32;                 // color batches for the stroke pass
  const CAP = 4200;                   // hard node-array capacity (> max knob)

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  Substrate.register({
    id: 'diffgrowth',
    name: 'Differential Growth',
    blurb: 'winding organic boundary',
    tags: ['growth', 'organic', 'coral'],

    // Knobs — read LIVE every frame. Defaults per the classic coral look.
    params: {
      attraction:  { label: 'Attraction',    min: 0,   max: 2,    step: 0.01, default: 0.9  },
      repulsion:   { label: 'Repulsion',     min: 0,   max: 3,    step: 0.01, default: 1.1  },
      repelRadius: { label: 'Repel radius',  min: 6,   max: 40,   step: 1,    default: 18   },
      maxSegment:  { label: 'Growth rate',   min: 4,   max: 20,   step: 0.5,  default: 9    },
      maxNodes:    { label: 'Max nodes',     min: 500, max: 4000, step: 100,  default: 2600, int: true },
    },

    create({ canvas, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d', { alpha: false });
      const DPR = dpr || 1;

      // --- ring state as flat typed arrays (double-buffered for growth) ---
      let px = new Float32Array(CAP);
      let py = new Float32Array(CAP);
      let age = new Float32Array(CAP);      // frames alive, for optional tinting
      let px2 = new Float32Array(CAP);
      let py2 = new Float32Array(CAP);
      let age2 = new Float32Array(CAP);
      let N = 0;                            // live node count
      let totalLen = 0;                     // path length in backing-store px
      let resetHold = 0;                    // frames to show STATE=RESET

      // --- spatial hash (rebuilt each frame) ---
      let cols = 1, rows = 1, cellSize = 1;
      let cellHead = new Int32Array(1);
      const nextIdx = new Int32Array(CAP);

      // --- per-bucket segment vertex buffers (reused; grown as needed) ---
      const bucketBuf = new Array(BUCKETS);
      const bucketLen = new Int32Array(BUCKETS);
      for (let b = 0; b < BUCKETS; b++) bucketBuf[b] = new Float32Array(256);

      // --- deterministic PRNG, re-created on every (re)seed ---
      let rng = Substrate.rng(seed >>> 0);
      let curSeed = seed >>> 0;

      // --- optional coupling: null => byte-identical to standalone ---
      // When set (0..1, 0.5 neutral) it applies a bounded reduction of the
      // effective maxSegment, so a stronger incoming drive => denser, faster
      // growth. Clamped to a viable band so the loop never degenerates.
      let extDrive = null;

      // Seed a small circle of nodes with slight jitter (the jitter breaks
      // symmetry so folds can nucleate; it is fully seed-reproducible).
      function seedCircle(seedVal) {
        rng = Substrate.rng(seedVal >>> 0);
        const W = canvas.width || 1, H = canvas.height || 1;
        const cx = W * 0.5, cy = H * 0.5;
        const radius = Math.min(W, H) * 0.12;
        const target = Math.max(1, params.maxSegment * DPR * 0.5);
        let n = Math.round((2 * Math.PI * radius) / target);
        n = clamp(n, 24, 200);
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * Math.PI * 2;
          const jr = radius * (1 + (rng() - 0.5) * 0.06);
          px[i] = cx + Math.cos(ang) * jr + (rng() - 0.5) * DPR;
          py[i] = cy + Math.sin(ang) * jr + (rng() - 0.5) * DPR;
          age[i] = 0;
        }
        N = n;
      }

      // Rebuild the uniform-grid spatial hash for the current nodes.
      function buildHash(radiusPx) {
        const W = canvas.width || 1, H = canvas.height || 1;
        cellSize = Math.max(2, radiusPx);
        cols = Math.max(1, Math.ceil(W / cellSize));
        rows = Math.max(1, Math.ceil(H / cellSize));
        const nCells = cols * rows;
        if (cellHead.length < nCells) cellHead = new Int32Array(nCells);
        cellHead.fill(-1, 0, nCells);
        for (let i = 0; i < N; i++) {
          let cxi = (px[i] / cellSize) | 0;
          let cyi = (py[i] / cellSize) | 0;
          cxi = cxi < 0 ? 0 : cxi >= cols ? cols - 1 : cxi;
          cyi = cyi < 0 ? 0 : cyi >= rows ? rows - 1 : cyi;
          const c = cyi * cols + cxi;
          nextIdx[i] = cellHead[c];
          cellHead[c] = i;
        }
      }

      // One dynamics step: accumulate forces, move nodes, then grow.
      function evolve() {
        const W = canvas.width || 1, H = canvas.height || 1;

        // Live knob reads (never cached across frames).
        const attraction = params.attraction;
        const repulsion = params.repulsion;
        const radiusPx = clamp(params.repelRadius * DPR, 2, Math.min(W, H));
        let maxSegPx = params.maxSegment * DPR;
        if (extDrive !== null) {
          // Bounded nudge: higher drive shortens the split threshold.
          maxSegPx *= (1 - (extDrive - 0.5) * 0.5);
        }
        maxSegPx = clamp(maxSegPx, 3 * DPR, 40 * DPR);
        const targetLen = maxSegPx * 0.5;
        const invRadius = 1 / radiusPx;
        const maxMove = 2.2 * DPR;
        const margin = 4 * DPR;

        buildHash(radiusPx);

        // --- accumulate displacement into the second buffer's slots ---
        for (let i = 0; i < N; i++) {
          const x = px[i], y = py[i];
          const prev = i === 0 ? N - 1 : i - 1;
          const next = i === N - 1 ? 0 : i + 1;
          let dx = 0, dy = 0;

          // (1) ATTRACTION — spring toward each ring-neighbor to targetLen.
          for (let s = 0; s < 2; s++) {
            const nb = s === 0 ? prev : next;
            const vx = px[nb] - x, vy = py[nb] - y;
            const d = Math.hypot(vx, vy);
            if (d > 1e-4) {
              const diff = ((d - targetLen) / d) * 0.5 * attraction;
              dx += vx * diff;
              dy += vy * diff;
            }
          }

          // (3) ALIGNMENT — slight pull toward neighbor midpoint (smoothing).
          const mx = (px[prev] + px[next]) * 0.5 - x;
          const my = (py[prev] + py[next]) * 0.5 - y;
          dx += mx * 0.12;
          dy += my * 0.12;

          // (2) REPULSION — push from other nodes within radius (3x3 cells).
          let cxi = (x / cellSize) | 0;
          let cyi = (y / cellSize) | 0;
          cxi = cxi < 0 ? 0 : cxi >= cols ? cols - 1 : cxi;
          cyi = cyi < 0 ? 0 : cyi >= rows ? rows - 1 : cyi;
          for (let oy = -1; oy <= 1; oy++) {
            const ry = cyi + oy;
            if (ry < 0 || ry >= rows) continue;
            for (let ox = -1; ox <= 1; ox++) {
              const rx = cxi + ox;
              if (rx < 0 || rx >= cols) continue;
              let j = cellHead[ry * cols + rx];
              while (j !== -1) {
                if (j !== i && j !== prev && j !== next) {
                  const ux = x - px[j], uy = y - py[j];
                  const d = Math.hypot(ux, uy);
                  if (d > 1e-4 && d < radiusPx) {
                    const f = (1 - d * invRadius) * repulsion * 1.4;
                    dx += (ux / d) * f;
                    dy += (uy / d) * f;
                  }
                }
                j = nextIdx[j];
              }
            }
          }

          // Clamp displacement magnitude, move, keep inside the frame.
          const dm = Math.hypot(dx, dy);
          if (dm > maxMove) { const k = maxMove / dm; dx *= k; dy *= k; }
          px2[i] = clamp(x + dx, margin, W - margin);
          py2[i] = clamp(y + dy, margin, H - margin);
          age2[i] = age[i] + 1;
        }
        // Commit moved positions (swap primary <-> secondary).
        let t;
        t = px; px = px2; px2 = t;
        t = py; py = py2; py2 = t;
        t = age; age = age2; age2 = t;

        // --- GROWTH pass: build a new ring, inserting midpoints on long
        //     segments. Also measures total path length. O(N). ---
        const maxNodes = clamp(params.maxNodes | 0, 500, 4000);
        let m = 0;
        let len = 0;
        const splitLen = maxSegPx;
        for (let i = 0; i < N && m < CAP - 1; i++) {
          const next = i === N - 1 ? 0 : i + 1;
          // keep the current node
          px2[m] = px[i]; py2[m] = py[i]; age2[m] = age[i]; m++;
          const vx = px[next] - px[i], vy = py[next] - py[i];
          const segLen = Math.hypot(vx, vy);
          len += segLen;
          if (segLen > splitLen && m < CAP - 1 && (m + N - i) < maxNodes + 4) {
            // insert a fresh midpoint node (age 0 = a new, hot fold)
            px2[m] = px[i] + vx * 0.5;
            py2[m] = py[i] + vy * 0.5;
            age2[m] = 0;
            m++;
          }
        }
        totalLen = len;
        t = px; px = px2; px2 = t;
        t = py; py = py2; py2 = t;
        t = age; age = age2; age2 = t;
        N = m;

        // --- immortal loop: reseed a fresh circle when we hit the cap ---
        if (N >= maxNodes || N >= CAP - 2) {
          curSeed = (curSeed + 0x9e3779b9) >>> 0;
          seedCircle(curSeed);
          resetHold = 18;
        } else if (resetHold > 0) {
          resetHold--;
        }
      }

      // Local turn angle at node i, normalized [0,1] for the palette.
      function curvatureT(i) {
        const prev = i === 0 ? N - 1 : i - 1;
        const next = i === N - 1 ? 0 : i + 1;
        const ax = px[i] - px[prev], ay = py[i] - py[prev];
        const bx = px[next] - px[i], by = py[next] - py[i];
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la < 1e-4 || lb < 1e-4) return 0;
        let c = (ax * bx + ay * by) / (la * lb);
        c = c < -1 ? -1 : c > 1 ? 1 : c;
        const turn = Math.acos(c);              // 0 straight .. PI hairpin
        return clamp(turn / (Math.PI * 0.6), 0, 1);
      }

      function pushSeg(b, x1, y1, x2, y2) {
        let buf = bucketBuf[b];
        const n = bucketLen[b];
        if (n + 4 > buf.length) {
          const grown = new Float32Array(buf.length * 2);
          grown.set(buf);
          bucketBuf[b] = grown;
          buf = grown;
        }
        buf[n] = x1; buf[n + 1] = y1; buf[n + 2] = x2; buf[n + 3] = y2;
        bucketLen[b] = n + 4;
      }

      // Render: dark clear, blurred glow pass, then curvature-colored stroke.
      function render() {
        const W = canvas.width, H = canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.fillStyle = '#0a0e0b';
        ctx.fillRect(0, 0, W, H);
        if (N < 2) return;

        // additive green glow: whole ring, blurred, low alpha
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(0,255,156,0.5)';
        ctx.lineWidth = 3.5 * DPR;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.filter = 'blur(' + Math.max(3, W * 0.006) + 'px)';
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(px[0], py[0]);
        for (let i = 1; i < N; i++) ctx.lineTo(px[i], py[i]);
        ctx.closePath();
        ctx.stroke();
        ctx.filter = 'none';

        // bucket segments by local curvature, then one stroke per color
        bucketLen.fill(0);
        for (let i = 0; i < N; i++) {
          const next = i === N - 1 ? 0 : i + 1;
          let b = (curvatureT(i) * (BUCKETS - 1)) | 0;
          b = b < 0 ? 0 : b >= BUCKETS ? BUCKETS - 1 : b;
          pushSeg(b, px[i], py[i], px[next], py[next]);
        }
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 1.5 * DPR;
        for (let b = 0; b < BUCKETS; b++) {
          const n = bucketLen[b];
          if (n === 0) continue;
          const ci = ((b / (BUCKETS - 1)) * 255) | 0;
          ctx.strokeStyle = 'rgb(' + LUT[ci * 3] + ',' + LUT[ci * 3 + 1] + ',' + LUT[ci * 3 + 2] + ')';
          const buf = bucketBuf[b];
          ctx.beginPath();
          for (let k = 0; k < n; k += 4) {
            ctx.moveTo(buf[k], buf[k + 1]);
            ctx.lineTo(buf[k + 2], buf[k + 3]);
          }
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }

      seedCircle(curSeed);

      return {
        step() {
          evolve();
          render();
        },

        // Restart from a new seed: fresh circle, fresh PRNG.
        reseed(newSeed) {
          curSeed = newSeed >>> 0;
          seedCircle(curSeed);
          resetHold = 0;
        },

        // Canvas backing store already resized by the shell. Restart the
        // composition so the circle is centered/scaled to the new frame.
        resize() {
          seedCircle(curSeed);
          resetHold = 0;
        },

        // --- OPTIONAL coupling API (safe to ignore for standalone use) ---
        // emit(): boundary complexity in [0,1] = live node count as a
        // fraction of the maxNodes cap. Rises as the boundary folds/grows.
        emit() {
          const maxNodes = clamp(params.maxNodes | 0, 500, 4000);
          return clamp(N / maxNodes, 0, 1);
        },

        // absorb(signal): store an external drive in [0,1] (0.5 neutral).
        // Applied as a bounded reduction of maxSegment in evolve(), so a
        // stronger signal drives faster, denser growth.
        absorb(signal) {
          const s = +signal;
          extDrive = Number.isFinite(s) ? clamp(s, 0, 1) : 0.5;
        },

        readouts() {
          return {
            NODES: N,
            LENGTH: (totalLen / DPR).toFixed(0),
            STATE: resetHold > 0 ? 'RESET' : 'GROWING',
          };
        },
      };
    },
  });
})();
