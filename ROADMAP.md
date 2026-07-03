# Roadmap

Where Equilibria is and what's next. Current state: **20 cartridges**, generative palette,
coupling (COUPLE mode, original 4 systems), breeding, permalinks, and a v1 modulation transport.
Live at https://jnarwell.github.io/equilibria/.

The through-line: **coupling and modulation are the same idea** — something other than your hand
driving a value. The end state is one *modulation matrix* where LFOs, envelopes, sequencers, and a
coupled system's `emit()` are interchangeable sources routed to any knob (or the palette), on one
transport clock.

## Modulation (the conductor) — build on Part 2 v1

- [ ] **Keyframe sequencer / one-shot envelopes** — deliberate arcs ("ramp coupling 0→max over 20s,
      then hold"), not just looping LFOs. This is what turns a lucky take into a *score*.
- [ ] **Persist modulators** in the permalink hash, and make them a **breeding gene** — so a whole
      composition (system + palette + modulation) is one shareable, evolvable object.
- [ ] **Color into the transport** — expose palette phase / a palette-morph as a modulation target,
      so color is conducted on the same clock as form.
- [ ] **Modulation in COUPLE mode** (currently solo-only).
- [ ] **Unified mod-matrix** — let a coupled system's `emit()` be a modulator *source*, collapsing
      coupling + modulation into one routing surface.

## Color

- [ ] **Per-system intrinsic color** — color each system from its own richer state, not one scalar
      (fluid by velocity direction, boids by heading, Lenia by growth-vs-decay sign, Kuramoto phase
      is already intrinsic). The palette centralization makes this cheap now.
- [ ] **Color as a coupled subsystem** — a system's `emit()` drives the global hue (Ising warming
      the whole rack as it orders).
- [ ] **Palette as a breeding gene** — add the 12-number cosine genome to the breed pool.

## Coupling

- [ ] **Per-cell cartridge swap in COUPLE** — the grid is hardcoded to the original 4
      (`COUPLE_IDS` in `index.html`); let any of the 20 join the ecosystem.
- [ ] **The Drip process chain** — wire the four AM systems as a coupled pipeline:
      Rayleigh (generation) → Acoustic (guidance) → Deposition (build) → Dendrite (solidification).

## Polish

- [ ] **Acoustic node-lock** reads diffuse — tighten the trapping so particles snap into a crisp
      node lattice.
- [ ] **Dendrite arms** — sharper branching / side-branching; catch it mid-freeze more.
- [ ] Make sure all AM systems read clearly **molten-then-frozen**.
- [ ] Optional de-theming: neutralize the **Societal Homeostat** labels
      (TECH/CAPITAL/POLITY/WELFARE → abstract) to match the AI-art-for-itself framing.

## Performance

- [ ] **GPU-accelerate the heavy sims** (Lenia, Gray–Scott, Physarum, Stable Fluids) via WebGL2 so
      COUPLE mode runs glass-smooth and grids can grow. Keep a Canvas2D fallback (the shell hands a
      fresh canvas each load, so a cartridge can try `webgl2` then fall back to `2d`).

## Provenance / export

- [ ] Higher-resolution PNG export; longer/quality video capture.
- [ ] Include modulators + palette in the permalink so a shared link reproduces the full performance.

## Notes for contributors

- **Verify behavior, not just green checks.** A cartridge whose `readouts()`/`step()` throws an
  *uncaught* exception silently stalls the frame loop — and headless `console --errors` does NOT
  capture uncaught exceptions. Always confirm the readout/state actually updates over time.
- The shell now `try/catch`es `readouts()`, so a readout bug degrades instead of freezing.
- All cartridges are CPU/Canvas2D and vanilla. See [CARTRIDGE-SPEC.md](CARTRIDGE-SPEC.md).
