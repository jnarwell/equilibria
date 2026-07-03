# EQUILIBRIA

**A generative-art studio in the browser.** Twenty self-organizing systems — chaos, cellular
automata, synchronization, statistical mechanics, growth, fluids, flocking, and the physics of
acoustic-guided additive manufacturing — that you can **operate, modulate, breed, couple, and
record.** No dependencies, no build, no server. One HTML file and a folder of small scripts.

> ▶ **Play it live: https://jnarwell.github.io/equilibria/**
>
> Or clone and open `index.html` directly in a browser.

Aesthetic: *cyberdeck × solarpunk × thermodynamic equilibrium.* A generative thermal→verdant
palette runs through every system as a metabolism — heat dissipated, captured, returned.

---

## What's inside

Open **`index.html`** — the playground.

- **Rack** (left) — the **cartridges** (systems).
- **Stage** (center) — the running canvas. **SOLO** runs one system; **COUPLE** runs four at once
  and wires each one's output (`emit`) into another's input (`absorb`) — a coupled ecosystem.
- **Controls** (right) — knobs auto-generated per system, a **Motion** transport, a global
  **Palette**, plus reseed, PNG, and video capture.
- **Library** (bottom) — save runs and **breed** two of them into offspring.

Three things make it an instrument, not a gallery:

- **Modulation (Motion transport)** — tap **∿** on any knob to drive it over time with an LFO
  (sine / triangle / saw / square) or a smooth random walk, on a shared play/pause clock. Compose
  arcs; don't just drag sliders.
- **Generative palette** — color isn't static. **Shuffle** picks a new Iñigo-Quílez cosine palette
  across every system at once; **Color-drift** makes it breathe. Default is the thermal→verdant ramp.
- **Coupling & breeding** — wire systems together, or evolve two saved runs into offspring.

Nothing is pre-rendered. Every frame is computed live from a local rule; the organisms, spirals,
flocks, coral, and droplets are *emergent* — no keyframes, no sprites.

### The systems (20)

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
| Additive manufacturing | Rayleigh Breakup · Acoustic Trap (Gorkov) · Droplet Deposition · Dendritic Solidification |
| Reference | Calibration Field |

The additive-manufacturing set renders the four physical acts of acoustic-guided metal 3D printing
— droplet *generation*, acoustic *guidance*, *deposition*, and *solidification* — as generative
systems, using generic public-domain physics (Rayleigh–Plateau, Gorkov potential, ballistic
deposition, solidification CA).

---

## Add your own system

Every system is a **cartridge** conforming to one contract. Satisfy it and the studio hands your
system knobs, modulation, reseed, save, breeding, permalinks, coupling, the generative palette, and
export — you write zero UI. See **[CARTRIDGE-SPEC.md](CARTRIDGE-SPEC.md)**.

```js
Substrate.register({
  id: 'my-system', name: 'My System', blurb: 'what it does',
  params: { speed: { label: 'Speed', min: 0, max: 2, step: 0.01, default: 1 } },
  create({ canvas, dpr, params, seed, Substrate }) {
    const ctx = canvas.getContext('2d');
    return {
      step(dt) {
        const lut = Substrate.rampLUT();   // 256×3 RGB LUT — color via the global palette
        // read params.* live; draw one frame
      },
      reseed(newSeed) {},                  // restart from a seed
      readouts() { return { STATUS: 'live' }; },
      emit()  { return 0.5; },             // optional [0,1] signal for coupling
      absorb(signal) {},                   // optional: respond to a coupled signal
    };
  },
});
```

Then add one `<script src="cartridges/NN-my-system.js"></script>` line to `index.html`.
Color through `Substrate.rampLUT()` (or `rampCSS(t)`) so palette shuffle/drift reaches your system,
and any knob you declare is automatically modulatable and breedable — for free.

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

Built by **Jamie Marwell** with **Claude Code** — each system was authored by describing an
algorithm to an AI agent that wrote it to the cartridge contract. The AI builds the instruments;
the human performs. The art isn't the output; it's the rule and what you do with it. MIT licensed.
