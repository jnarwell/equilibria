/* ============================================================
   EQUILIBRIA 03 — SOCIETAL HOMEOSTAT  (cartridge port)
   Ported to the Substrate cartridge contract. Classic script,
   no ES module, no deps — registers itself once.

   MODEL
   -----
   Four reservoirs: TECH, CAPITAL, POLITY, WELFARE, coupled as a
   complete graph (K4). Each holds a level L_i. The total Σ L_i is
   STRICTLY CONSERVED (renormalized to 1.0 every tick). Corrective
   flows run along channels proportional to the difference in
   deviation from a shared setpoint — negative feedback that pulls
   every reservoir toward the common target. Momentum damping
   (damp < 1) dissipates energy so it never diverges, while noise
   and periodic conserving shocks keep it perpetually self-correcting
   so it never flatlines.

   Stability note: the pairwise flow GAIN*(devI-devJ) == GAIN*(L_i-L_j)
   (setpoint cancels), i.e. a damped diffusion on K4. The (x,v)
   momentum map has det == damp < 1, so it is unconditionally stable
   across the whole knob range.
   ============================================================ */
(function () {
  "use strict";

  // ----- Palette ----------------------------------------------
  // Non-ramp fixed colors only. Reservoir / channel / particle / chart
  // colors now come from the studio's GLOBAL generative palette via
  // window.Substrate (default palette ~= thermal->verdant, so the base
  // look is unchanged; shuffle/drift recolors live).
  const COL = {
    bg:   [10, 14, 11],  // background wash
    deep: [27, 77, 62],  // liquid-gradient darken target (see drawReservoir)
  };
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function lerp3(c1, c2, t) {
    return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
  }
  // t in [0,1]: color source is now the global palette. The t mappings
  // (deviation->t, flow->t) are unchanged; only the COLOR source moved.
  // Returns an [r,g,b] array so existing rgba(col, alpha) wrappers keep
  // their alpha (glow underlayers, dashes, gradient stops all preserved).
  function thermal(t) {
    return window.Substrate.ramp(clamp(t, 0, 1));
  }
  function rgba(c, a) { return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }

  // ----- Model constants --------------------------------------
  const NAMES = ['TECH', 'CAPITAL', 'POLITY', 'WELFARE'];
  const N = NAMES.length;
  // Ring + both diagonals over 4 nodes == complete graph K4.
  const EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 0],  // ring
    [0, 2], [1, 3],                  // diagonals
  ];
  const TOTAL = 1.0;    // conserved total resource (Σ L_i)
  const HIST_MAX = 480; // strip-chart ring buffer length
  const TICK_MS = 1000 / 60; // fixed physics step

  Substrate.register({
    id: 'homeostat',
    name: 'Societal Homeostat',
    blurb: 'coupled reservoirs → setpoint',
    tags: ['control', 'conservation', 'feedback'],

    params: {
      gain:      { label: 'Feedback gain', min: 0.02, max: 0.2,  step: 0.001, default: 0.085 },
      damp:      { label: 'Damping',       min: 0.7,  max: 0.98, step: 0.005, default: 0.86  },
      noise:     { label: 'Noise',         min: 0,    max: 0.03, step: 0.001, default: 0.011 },
      kickSize:  { label: 'Shock size',    min: 0,    max: 0.4,  step: 0.005, default: 0.22  },
      kickEvery: { label: 'Shock interval',min: 60,   max: 800,  step: 1,     default: 260, int: true },
      setpoint:  { label: 'Setpoint',      min: 0.15, max: 0.4,  step: 0.005, default: 0.25  },
    },

    create({ canvas, width, height, dpr, params, seed, Substrate }) {
      const ctx = canvas.getContext('2d');

      // ---- deterministic randomness ----
      let rand = Substrate.rng(seed);
      function noise(amt) { return (rand() * 2 - 1) * amt; }

      // ---- layout state (CSS-pixel space via dpr transform) ----
      let DPR = dpr, W = 0, H = 0;
      let nodes = [];                 // {x,y,r,ang}
      let centerX = 0, centerY = 0, ringR = 0;
      let chart = { x: 0, y: 0, w: 0, h: 0 };

      function layout() {
        centerX = W * 0.5;
        centerY = H * 0.46;
        ringR = Math.min(W, H) * 0.27;
        const nodeR = clamp(Math.min(W, H) * 0.085, 42, 120);
        nodes = [];
        for (let i = 0; i < N; i++) {
          const ang = -Math.PI / 2 + i * (Math.PI * 2 / N);
          nodes.push({
            x: centerX + Math.cos(ang) * ringR,
            y: centerY + Math.sin(ang) * ringR,
            r: nodeR,
            ang,
          });
        }
        const margin = 20;
        chart.h = clamp(H * 0.12, 70, 150);
        chart.w = W - margin * 2;
        chart.x = margin;
        chart.y = H - chart.h - 34;
      }

      function applyTransform(w, h, d) {
        DPR = d || 1;
        W = w / DPR; H = h / DPR;
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        layout();
      }
      applyTransform(width, height, dpr);

      // ---- dynamical state (rebuilt immutably each tick) ----
      function initState() {
        // Random start away from equilibrium; renormalized to TOTAL.
        let levels = [];
        for (let i = 0; i < N; i++) levels.push(0.05 + rand() * 0.55);
        levels = conserve(levels);
        return {
          tick: 0,
          levels,
          vel: new Array(N).fill(0),
          flows: EDGES.map(() => 0),
          history: [],
        };
      }

      // Renormalize to enforce exact conservation against float drift.
      function conserve(levels) {
        let sum = 0; for (let i = 0; i < N; i++) sum += levels[i];
        const k = TOTAL / sum;
        const out = new Array(N);
        for (let i = 0; i < N; i++) out[i] = levels[i] * k;
        return out;
      }

      // One physics tick -> a NEW state (immutable-friendly). Reads
      // knobs live from `params` every tick.
      function stepPhysics(prev) {
        const GAIN = params.gain;
        const DAMP = params.damp;
        const NOISE = params.noise;
        const KICK_SIZE = params.kickSize;
        const KICK_EVERY = Math.max(1, params.kickEvery | 0);
        const SP = params.setpoint;

        const tick = prev.tick + 1;
        const L = prev.levels;
        const flows = new Array(EDGES.length).fill(0);
        const delta = new Array(N).fill(0);

        // Corrective flow per channel: proportional to the difference
        // in deviation from setpoint. Resource moves from the reservoir
        // further above setpoint toward the one below — negative feedback.
        for (let e = 0; e < EDGES.length; e++) {
          const i = EDGES[e][0], j = EDGES[e][1];
          const devI = L[i] - SP;
          const devJ = L[j] - SP;
          const f = GAIN * (devI - devJ) * 0.5;
          flows[e] = f;
          delta[i] -= f; // i gives
          delta[j] += f; // j receives
        }

        // Integrate with damping (momentum) + perturbation.
        const vel = new Array(N);
        let levels = new Array(N);
        for (let i = 0; i < N; i++) {
          vel[i] = prev.vel[i] * DAMP + delta[i];
          levels[i] = L[i] + vel[i] + noise(NOISE);
          if (levels[i] < 0.001) levels[i] = 0.001; // no negative reservoirs
        }

        // Scheduled conserving shock: add to one reservoir, take the
        // same amount from another, keeping Σ constant.
        if (tick % KICK_EVERY === 0 && KICK_SIZE > 0) {
          const a = (rand() * N) | 0;
          let b = (rand() * N) | 0;
          if (b === a) b = (b + 1) % N;
          const amt = KICK_SIZE * (0.6 + rand() * 0.4);
          levels[a] += amt;
          levels[b] = Math.max(0.001, levels[b] - amt);
        }

        // OPTIONAL external drive: a conserving perturbation. Only active
        // when coupled (extDrive !== null). Higher incoming (>0.5) nudges a
        // little resource between two reservoirs, scaled by (extDrive-0.5);
        // lower/neutral is calmer (no nudge). This is a paired add/subtract
        // (like the scheduled shock) so it never touches velocity/damping —
        // conserve() below still renormalizes Σ to exactly 1.0 each tick.
        if (extDrive !== null) {
          const push = extDrive - 0.5; // (-0.5 .. +0.5]
          if (push > 0) {
            const EXT_MAX = 0.02; // small, well under kick scale
            const a = (rand() * N) | 0;
            let b = (rand() * N) | 0;
            if (b === a) b = (b + 1) % N;
            const amt = EXT_MAX * push * (0.6 + rand() * 0.4);
            levels[a] += amt;
            levels[b] = Math.max(0.001, levels[b] - amt);
          }
        }

        // Enforce exact conservation.
        levels = conserve(levels);

        const history = prev.history.slice(-HIST_MAX + 1);
        history.push(levels.slice());

        return { tick, levels, vel, flows, history };
      }

      let S = initState();
      let time = 0;   // animation seconds
      let acc = 0;    // fixed-step accumulator

      // Optional coupling: external drive signal in [0,1] (0.5 neutral).
      // null == not coupled -> standalone behavior is byte-identical.
      let extDrive = null;

      // ----- Rendering ------------------------------------------
      function drawBackground() {
        ctx.fillStyle = rgba(COL.bg, 1);
        ctx.fillRect(0, 0, W, H);
        const g = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, ringR * 2.2);
        g.addColorStop(0, 'rgba(42,157,143,0.06)');
        g.addColorStop(1, 'rgba(10,14,11,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }

      function drawChannel(e) {
        const i = EDGES[e][0], j = EDGES[e][1];
        const a = nodes[i], b = nodes[j];
        const f = S.flows[e];
        const mag = Math.abs(f);
        const t = clamp(mag / 0.05, 0, 1);
        const col = thermal(0.12 + t * 0.85);

        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const ax = a.x + ux * a.r, ay = a.y + uy * a.r;
        const bx = b.x - ux * b.r, by = b.y - uy * b.r;

        const thick = clamp(2 + mag * 220, 2, 26);

        ctx.lineCap = 'round';
        ctx.strokeStyle = rgba(col, 0.10 + t * 0.18);
        ctx.lineWidth = thick + 8;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();

        ctx.strokeStyle = rgba(col, 0.55 + t * 0.4);
        ctx.lineWidth = thick;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();

        if (mag > 0.0006) {
          const dir = f >= 0 ? 1 : -1;
          const speed = clamp(mag * 800, 0.4, 6);
          const phase = (time * speed * dir) % 1;
          ctx.save();
          ctx.setLineDash([6, 14]);
          ctx.lineDashOffset = -phase * 20 - time * speed * 20 * dir;
          ctx.strokeStyle = rgba(thermal(0.5 + t * 0.5), 0.85);
          ctx.lineWidth = clamp(thick * 0.4, 1.2, 8);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
          ctx.restore();
          ctx.setLineDash([]);

          const np = Math.max(2, Math.round(len / 60));
          for (let p = 0; p < np; p++) {
            let u = ((p / np) + (time * speed * 0.06 * dir)) % 1;
            if (u < 0) u += 1;
            const px = ax + (bx - ax) * u;
            const py = ay + (by - ay) * u;
            const pr = clamp(thick * 0.22, 1.2, 4);
            ctx.fillStyle = rgba(thermal(0.6 + t * 0.4), 0.9);
            ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
          }
        }
      }

      function drawReservoir(i) {
        const SP = params.setpoint;
        const n = nodes[i];
        const L = S.levels[i];
        const dev = L - SP;
        const tdev = clamp(0.5 + dev / (SP * 1.5), 0, 1);
        const col = thermal(tdev);
        const fillFrac = clamp(L / (SP * 2), 0.04, 1);

        ctx.save();
        ctx.shadowBlur = 24;
        ctx.shadowColor = rgba(col, 0.55);
        ctx.strokeStyle = rgba(col, 0.85);
        ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.save();
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r - 2, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = 'rgba(8,12,9,0.92)';
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);

        const liquidTop = n.y + n.r - fillFrac * n.r * 2;
        const lg = ctx.createLinearGradient(0, liquidTop, 0, n.y + n.r);
        lg.addColorStop(0, rgba(col, 0.95));
        lg.addColorStop(1, rgba(lerp3(col, COL.deep, 0.5), 0.95));
        ctx.fillStyle = lg;
        const waveAmp = 3 + Math.abs(dev) * 40;
        ctx.beginPath();
        ctx.moveTo(n.x - n.r, n.y + n.r);
        for (let x = -n.r; x <= n.r; x += 4) {
          const wy = liquidTop + Math.sin((x * 0.06) + time * 2.2 + i) * waveAmp
                              + Math.sin((x * 0.13) - time * 1.3) * waveAmp * 0.4;
          ctx.lineTo(n.x + x, wy);
        }
        ctx.lineTo(n.x + n.r, n.y + n.r);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = rgba(thermal(Math.min(1, tdev + 0.15)), 0.9);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = -n.r; x <= n.r; x += 4) {
          const wy = liquidTop + Math.sin((x * 0.06) + time * 2.2 + i) * waveAmp
                              + Math.sin((x * 0.13) - time * 1.3) * waveAmp * 0.4;
          if (x === -n.r) ctx.moveTo(n.x + x, wy); else ctx.lineTo(n.x + x, wy);
        }
        ctx.stroke();
        ctx.restore();

        // Setpoint tick mark on the tank.
        const spTop = n.y + n.r - clamp(SP / (SP * 2), 0, 1) * n.r * 2;
        ctx.strokeStyle = 'rgba(0,255,156,0.35)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(n.x - n.r, spTop); ctx.lineTo(n.x + n.r, spTop); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Labels.
        ctx.textAlign = 'center';
        ctx.font = '600 12px IBM Plex Mono, monospace';
        ctx.fillStyle = rgba(col, 0.95);
        ctx.shadowBlur = 8; ctx.shadowColor = rgba(col, 0.5);
        const lx = n.x + Math.cos(n.ang) * (n.r + 18);
        const ly = n.y + Math.sin(n.ang) * (n.r + 18);
        ctx.fillText(NAMES[i], lx, ly + (Math.sin(n.ang) > 0.2 ? 12 : 0));
        ctx.shadowBlur = 0;

        ctx.font = '10px IBM Plex Mono, monospace';
        ctx.fillStyle = 'rgba(0,255,156,0.6)';
        const pct = (L * 100).toFixed(1);
        const sign = dev >= 0 ? '+' : '−';
        ctx.fillText(`${pct}%  ${sign}${Math.abs(dev * 100).toFixed(1)}`,
                     lx, ly + (Math.sin(n.ang) > 0.2 ? 26 : 14));
      }

      function drawHub() {
        const SP = params.setpoint;
        ctx.save();
        ctx.translate(centerX, centerY);
        const pulse = 0.5 + 0.5 * Math.sin(time * 1.6);
        ctx.strokeStyle = `rgba(0,255,156,${0.18 + pulse * 0.12})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, 16 + pulse * 4, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(0,255,156,0.7)';
        ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
        ctx.font = '9px IBM Plex Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,255,156,0.45)';
        ctx.fillText('SETPOINT', 0, 34);
        ctx.fillText((SP * 100).toFixed(1) + '%', 0, 46);
        ctx.restore();
      }

      function drawChart() {
        const SP = params.setpoint;
        const { x, y, w, h } = chart;
        ctx.fillStyle = 'rgba(8,12,9,0.55)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(0,255,156,0.14)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);

        const vmin = 0, vmax = SP * 2;
        const toY = (v) => y + h - clamp((v - vmin) / (vmax - vmin), 0, 1) * h;

        const spY = toY(SP);
        ctx.strokeStyle = 'rgba(0,255,156,0.3)';
        ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.moveTo(x, spY); ctx.lineTo(x + w, spY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '8px IBM Plex Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0,255,156,0.4)';
        ctx.fillText('SETPOINT', x + 6, spY - 4);

        const hist = S.history;
        const n = hist.length;
        if (n < 2) return;
        for (let s = 0; s < N; s++) {
          const dev = S.levels[s] - SP;
          const tdev = clamp(0.5 + dev / (SP * 1.5), 0, 1);
          ctx.strokeStyle = rgba(thermal(tdev), 0.9);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          for (let p = 0; p < n; p++) {
            const px = x + (p / (HIST_MAX - 1)) * w;
            const py = toY(hist[p][s]);
            if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
          const lastY = toY(hist[n - 1][s]);
          ctx.font = '8px IBM Plex Mono, monospace';
          ctx.textAlign = 'left';
          ctx.fillStyle = rgba(thermal(tdev), 0.95);
          ctx.fillText(NAMES[s], x + w - 56, lastY - 3);
        }
      }

      function maxError() {
        const SP = params.setpoint;
        let m = 0;
        for (let i = 0; i < N; i++) m = Math.max(m, Math.abs(S.levels[i] - SP));
        return m;
      }

      // ----- Cartridge instance ---------------------------------
      return {
        step(dt) {
          // Fixed-step physics integration (bounded catch-up).
          acc += dt;
          let steps = 0;
          while (acc >= TICK_MS && steps < 4) {
            S = stepPhysics(S);
            acc -= TICK_MS;
            steps++;
          }
          time += dt * 0.001;

          drawBackground();
          for (let e = 0; e < EDGES.length; e++) drawChannel(e);
          drawHub();
          for (let i = 0; i < N; i++) drawReservoir(i);
          drawChart();
        },

        reseed(newSeed) {
          rand = Substrate.rng(newSeed);
          S = initState();
          time = 0;
          acc = 0;
        },

        resize(w, h, d) {
          applyTransform(w, h, d);
        },

        // ---- OPTIONAL coupling API ----
        // Stress output in [0,1]: normalized mean absolute deviation of the
        // four reservoirs from the setpoint. 0 = perfectly balanced;
        // ->1 = highly perturbed. Full theoretical range (one reservoir
        // holding everything) maps to ~1 via the SP*1.5 scale used elsewhere.
        emit() {
          const SP = params.setpoint;
          let mad = 0;
          for (let i = 0; i < N; i++) mad += Math.abs(S.levels[i] - SP);
          mad /= N;
          return clamp(mad / (SP * 1.5), 0, 1);
        },

        // Accept a neighbor's stress signal in [0,1] (0.5 neutral). Stored
        // for the next physics step(s); see stepPhysics for the conserving
        // perturbation it drives. Passing null re-enters standalone mode.
        absorb(signal) {
          extDrive = (signal === null || signal === undefined)
            ? null
            : clamp(signal, 0, 1);
        },

        readouts() {
          const SP = params.setpoint;
          const err = maxError();
          const inBand = err < 0.035;
          return {
            SETPOINT: (SP * 100).toFixed(1) + '%',
            ERROR: (err * 100).toFixed(1) + '%',
            FLOWS: 'CONSERVED',
            STATE: inBand ? 'IN-BAND' : 'CORRECTING',
            TICK: S.tick.toString().padStart(6, '0'),
          };
        },
      };
    },
  });
})();
