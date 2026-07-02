# EQUILIBRIA

**A generative-art studio in the browser.** Sixteen self-organizing systems — chaos, cellular
automata, synchronization, statistical mechanics, growth, fluids, flocking — that you can
operate, breed, couple, and record. No dependencies, no build, no server. It's one HTML file
and a folder of small scripts.

> ▶ **Play it live: https://jnarwell.github.io/equilibria/**
>
> Or clone and open `index.html` directly in a browser.

Aesthetic: *cyberdeck × solarpunk × thermodynamic equilibrium.* One thermal→verdant palette runs
through every system as a metabolism — heat dissipated, captured, returned.

---

## What's inside

Open **`index.html`** — the playground. On the left, a rack of **cartridges** (systems). In the
center, the running canvas. On the right, knobs auto-generated from each system, plus reseed,
PNG export, and video capture. Below, a **library** where you save runs and **breed** two of them
into offspring. Up top, a **COUPLE** mode that runs four systems at once and wires each one's
output into another's input — a coupled ecosystem.

Nothing here is pre-rendered. Every frame is computed live from a local rule. The organisms,
spirals, flocks, and coral patterns are *emergent* — no keyframes, no sprites.

### The systems

| Family | Systems |
|--------|---------|
| Flow & control | Exergy Flowfield · Societal Homeostat |
| Reaction–diffusion | Gray–Scott Metabolism |
| Cellular automata | Lenia · Cyclic Automaton · Game of Life |
| Synchronization | Kuramoto |
| Statistical mechanics | Ising Model |
| Growth | Differential Growth · Dielectric Circuitry (DLA) · Physarum |
| Chaos | Strange Attractor (de Jong) |
| Fluids & waves | Stable Fluids (Navier–Stokes) · Chladni Plate |
| Flocking | Murmuration (boids) |

---

## Add your own system

Every system is a **cartridge**: a small script conforming to one contract. Satisfy the contract
and the studio hands your system knobs, reseed, save, breeding, permalinks, and export for free —
you write zero UI. See **[CARTRIDGE-SPEC.md](CARTRIDGE-SPEC.md)**.

```js
Substrate.register({
  id: 'my-system', name: 'My System', blurb: 'what it does',
  params: { speed: { label: 'Speed', min: 0, max: 2, step: 0.01, default: 1 } },
  create({ canvas, dpr, params, seed, Substrate }) {
    const ctx = canvas.getContext('2d');
    return {
      step(dt) { /* read params.* live; draw one frame */ },
      reseed(newSeed) { /* restart from a seed */ },
      readouts() { return { STATUS: 'live' }; },
    };
  },
});
```

Then add one `<script src="cartridges/NN-my-system.js"></script>` line to `studio.html`.

---

## Run locally

No install. Clone and open the file:

```bash
git clone https://github.com/jnarwell/equilibria.git
cd equilibria
open index.html       # macOS  (or just double-click it)
```

The standalone `01`–`04` HTML files are the original single-piece versions, kept alongside the studio.

---

## Credits

Built by **Jamie Marwell** with **Claude Code** — the systems were authored by describing each
algorithm to an AI agent that wrote it to the cartridge contract. The art isn't the output; it's
the rule. MIT licensed.
