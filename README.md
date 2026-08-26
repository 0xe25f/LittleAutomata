# LittleAutomata

An ultra-lightweight, high-performance, single-file granular materials and cellular automata simulation plugin for the **LittleJS** 2D game engine.

Simulate dynamic pixel-art terrain, falling sands, settling fluids, rising gases, thermal combustion, and chemical reactions with deterministic sub-stepping, zero garbage collection overhead, and seamless LittleJS physics and rendering integration.

**[Play the live demo &raquo;](https://0xe25f.github.io/LittleAutomata/demo.html)** &middot; **[Read the docs &raquo;](https://0xe25f.github.io/LittleAutomata/)**

---

## Key Features

* **Zero Runtime Allocations (0 GC):** Pre-allocated double-buffered memory layout operating strictly on flat typed arrays (`Uint8Array`, `Int8Array`, `Uint32Array`).
* **Chunk-Based Active Culling:** $64 \times 64$ cell chunks with dynamic bounding box tracking and sleep states skip dormant regions completely during updates and GPU uploads.
* **Five Physical Archetypes:** Out-of-the-box support for Immovable Solids, Falling Solids, Sliding Liquids, Rising Gases, and Propagating Energy.
* **$O(1)$ Reaction Matrix:** Flat $256 \times 256$ transition lookup table resolving material conversions, probabilities, yields, and lifespans in constant time.
* **Anti-Tunneling Physics:** Multi-cell raymarching steps for fast-falling granular particles prevent phase-through glitches across thin barriers.
* **Bidirectional LittleJS Physics Bridge:** LittleJS `EngineObject` instances naturally collide with solid terrain, slide with friction, float via Archimedes buoyancy, and experience viscous fluid drag.
* **Dual Rendering Pipelines:** High-throughput dynamic WebGL texture sub-image updating (`gl.texSubImage2D`, fully isolated from LittleJS's own WebGL state via a dedicated Vertex Array Object) and a 2D canvas compositing fallback.
* **Deterministic Spatial Hash Texturing:** Flat surfaces read as naturally grained rather than a solid flat tint, and an optional `drawLight(pos, radius, colour)` hook lets a host project wire emissive cells into its own lighting system.
* **Lossless Binary Serialisation:** High-speed Run-Length Encoded (RLE) save/load routines for world state persistence.
* **Zero Dependencies & Single-File Delivery:** Drop-in ES module with comprehensive JSDoc annotations providing immediate TypeScript autocomplete and type validation.

*LittleAutomata is 37KB minified.*

---

## Installation

Download the minified [`release/littleautomata.js`](./release/littleautomata.js) build and load it as an ES module alongside LittleJS, or import it into your bundler pipeline. It is a standard ES module (uses top-level `export`), so it must be loaded with `type="module"` or via `import` &mdash; a classic non-module `<script>` tag cannot parse it.

The readable, fully commented source lives in [`src/littleautomata.js`](./src/littleautomata.js).

```html
<!-- Direct script tag inclusion -->
<script src="littlejs.js"></script>
<script type="module" src="littleautomata.js"></script>
```

```javascript
// ES module import
import {
    initGranularEngine,
    updateGranularEngine,
    renderGranularEngine,
    paintCircle,
    createExplosion,
    Archetype
} from './littleautomata.js';
```

For convenience the module also attaches a `window.LittleAutomata` namespace containing every export, so a `<script type="module">` consumer can access the API as `LittleAutomata.paintCircle(...)` without individually importing each name.

---

## Quick Start Example

```javascript
// 1. Initialise LittleJS and the Granular Engine
function gameInit() {
    // Initialise the granular simulation grid (e.g. 512x256 cells at 16 cells per world unit)
    initGranularEngine({
        gridWidth: 512,
        gridHeight: 256,
        pixelsPerUnit: 16,
        subSteps: 1
    });

    // Populate initial landscape terrain
    paintCircle(0, -2, 6, 2); // Paint a Stone base (Material ID 2)
    paintCircle(0, 4, 3, 3);  // Paint a Sand mound above (Material ID 3)
}

// 2. Step the simulation and resolve physics in your update loop
function gameUpdate() {
    // Update cellular automata and resolve registered entity collisions
    updateGranularEngine();

    // Spawn falling sand on mouse click
    if (mouseIsDown(0)) {
        paintCircle(mousePos.x, mousePos.y, 0.5, 3);
    }

    // Trigger an explosive crater on right click
    if (mouseWasPressed(1)) {
        createExplosion(mousePos.x, mousePos.y, 2.0, 1.5);
    }
}

// 3. Render terrain before or after game sprites
function gameRenderPost() {
    // Render dynamic terrain and register emissive lights with LittleJS
    renderGranularEngine();
}

// Start LittleJS
engineInit(gameInit, gameUpdate, null, null, gameRenderPost);
```

See [`examples/`](./examples) for complete, runnable HTML files with accordion code walkthroughs, and [`docs/demo.html`](./docs/demo.html) for a fully-featured interactive sandbox with a material palette, brush sizing, explosions, a playable character, and save/load.

---

## Core Architecture & Memory Layout

Each cell in the grid occupies exactly **4 contiguous bytes (32 bits)** in a pre-allocated flat array:

```
┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐
│  Byte 0 (Uint8) │  Byte 1 (Uint8) │  Byte 2 (Int8)  │  Byte 3 (Uint8) │
│   materialId    │      life       │       vx        │      flags      │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┘
```

* **`materialId` ($0\text{--}255$):** Index of the registered material definition ($0 = \text{Air}$).
* **`life` ($0\text{--}255$):** Thermal energy, combustion timer, or gas dissipation counter.
* **`vx` ($-128\text{ to }127$):** Sub-pixel lateral dispersion momentum and roll bias.
* **`flags` (Bitfield):** Tracks per-frame update status, sleep states, and deterministic colour variants.

Two of these buffers are ping-ponged each simulation sub-step (`GranularGridBuffer`), and a `ChunkManager` partitions the world into $64 \times 64$ cell chunks that track activity, a sleep counter, and a dirty render rectangle &mdash; a chunk with zero cell changes for two consecutive sweeps is put to sleep, skipping both simulation and GPU upload entirely until something wakes it again.

---

## Built-in Materials & Physical Archetypes

The engine provides five core physical archetypes:

| Archetype | Behavioural Description | Example Elements |
| --- | --- | --- |
| `EMPTY` | Non-blocking empty space. | Air, Vacuum |
| `IMMOVABLE_SOLID` | Static structural mass unaffected by gravity; resists displacement. | Bedrock, Stone, Metal, Glass |
| `FALLING_SOLID` | Granular solid; falls vertically, slides down resting angles, and stacks. | Sand, Dirt, Gravel, Snow |
| `SLIDING_LIQUID` | Fluid mass; flows downward, displaces lighter fluids, and disperses laterally. | Water, Oil, Acid, Lava |
| `RISING_GAS` | Low-density vapour; diffuses upward and dissipates over time. | Smoke, Steam, Toxic Gas |
| `PROPAGATING_ENERGY` | Thermal energy; consumes flammables, heats neighbours, and decays. | Fire, Plasma, Sparks |

### Default Material Library

| ID | Material Name | Archetype | Density ($\text{kg/m}^3$) | Dispersion | Default Lifetime |
| --- | --- | --- | --- | --- | --- |
| **0** | Air | `EMPTY` | 1 | 0 | 0 (Permanent) |
| **1** | Bedrock | `IMMOVABLE_SOLID` | 100,000 | 0 | 0 (Permanent) |
| **2** | Stone | `IMMOVABLE_SOLID` | 2,700 | 0 | 0 (Permanent) |
| **3** | Sand | `FALLING_SOLID` | 1,600 | 1 | 0 (Permanent) |
| **4** | Water | `SLIDING_LIQUID` | 1,000 | 4 | 0 (Permanent) |
| **5** | Oil | `SLIDING_LIQUID` | 800 | 3 | 0 (Permanent) |
| **6** | Fire | `PROPAGATING_ENERGY` | 0 | 1 | 30 steps |
| **7** | Smoke | `RISING_GAS` | 0.5 | 2 | 60 steps |
| **8** | Acid | `SLIDING_LIQUID` | 1,200 | 3 | 0 (Permanent) |

`MaterialId.AIR` through `MaterialId.ACID` are exported as friendly constants for these nine identifiers; custom materials can register at any free id from 9&ndash;255.

---

## Chemical & Physical Reaction Engine

Interactions are resolved in $O(1)$ time via a $256 \times 256$ matrix. Custom materials and reactions can be registered at runtime:

```javascript
import { registerMaterial, registerReaction, Archetype } from './littleautomata.js';

// 1. Define a custom explosive gunpowder material
const GUNPOWDER_ID = registerMaterial({
    id: 9,
    name: "Gunpowder",
    archetype: Archetype.FALLING_SOLID,
    density: 1300,
    friction: 0.6,
    flammability: 0.9,
    baseColours: [0xFF454545, 0xFF383838, 0xFF2D2D2D]
});

// 2. Register reaction: Fire ignites Gunpowder into Fire and Smoke
registerReaction(
    6,              // Actor: Fire (ID 6)
    GUNPOWDER_ID,   // Target: Gunpowder (ID 9)
    6,              // Actor Yield: Fire
    6,              // Target Yield: Fire
    1.0,            // 100% reaction probability
    40              // Assigned lifetime
);
```

---

## LittleJS Physics Integration

The `GranularPhysicsBridge` automatically samples the terrain beneath any LittleJS `EngineObject`:

```javascript
class Player extends EngineObject {
    constructor(pos) {
        super(pos, vec2(0.8, 1.6));
    }

    update() {
        super.update();

        // Resolve collision against granular landscape:
        // Sets this.groundObject, applies surface friction,
        // and computes fluid buoyancy/drag when submerged in liquids.
        GranularPhysicsBridge.resolveEntityCollision(this);
    }
}
```

`resolveEntityCollision` must run *after* `super.update()`: LittleJS's own physics step resets `groundObject` to `undefined` at the start of every frame, so setting it any earlier would immediately be discarded.

---

## API Reference

### Lifecycle Functions

* `initGranularEngine(config)`: Allocates memory buffers, initialises chunks, and compiles material palettes.
* `updateGranularEngine()`: Advances the cellular simulation by configured sub-steps and swaps double buffers.
* `renderGranularEngine()`: Uploads dirty chunk bounding boxes and draws the terrain quad to the screen.

### Manipulation & Brush Utilities

* `paintCircle(worldX, worldY, radiusWorld, materialId)`: Draws a solid circular region of elements.
* `paintLine(startX, startY, endX, endY, radiusWorld, materialId)`: Draws a line brush between two points.
* `createExplosion(worldX, worldY, radiusWorld, power)`: Carves craters, flings particles, and applies radial impulses.
* `sampleWorld(worldX, worldY)`: Returns material definition and cell state at the given world coordinate.
* `raycastWorld(startX, startY, endX, endY)`: Casts a ray through the grid and returns the first impacted cell and surface normal.

### Persistence (Save / Load)

* `serializeGrid()`: Compresses the entire world buffer into a compact `Uint8Array` using lossless Run-Length Encoding (RLE).
* `deserializeGrid(byteArray)`: Restores world state from an RLE byte stream, waking all active chunks and updating textures.

### Classes

* `GranularEngine`: The orchestrator instance exposed as the `granularEngine` singleton once initialised.
* `GranularPhysicsBridge`: Static `resolveEntityCollision(entity)` method bridging LittleJS physics objects to the grid.
* `GranularGridBuffer`, `ChunkManager`, `MaterialRegistry`, `ReactionMatrix`, `MaterialDefinition`: Lower-level building blocks, each fully documented with JSDoc in the source, available for advanced or standalone use.

---

## Performance & Best Practices

1. **Resolution Scaling:** Balance world size and cell count using `pixelsPerUnit`. A standard setting of $16\text{ cells per unit}$ provides high visual detail while maintaining low memory footprints.
2. **Sub-stepping:** For fast-moving sand and fluids, 1 to 2 sub-steps per frame at 60 Hz provides stable, responsive physics without impacting frame rates.
3. **Chunk Culling:** Keep static geometry settled; dormant $64 \times 64$ chunks enter a sleep state after two inactive frames, bypassing simulation loops and GPU texture transfers entirely.

---

## Development

```bash
npm install       # install build tooling (terser)
npm run build     # minify src/littleautomata.js → release/ and docs/
npm test          # run the Node.js built-in test-runner suite (tests/)
```

The test suite covers buffer/chunk mechanics, materials and reactions, every simulation archetype, the brush API, the physics bridge, RLE serialisation round-tripping, deterministic reproducibility, and a static source-level guard that fails the build if any per-frame hot-path method in `src/littleautomata.js` contains a `new`, array literal, or object literal.

The [`tools/build-release.mjs`](./tools/build-release.mjs) script produces the compact minified bundle in `release/littleautomata.js` and copies the same artefact to `docs/littleautomata.js` for the GitHub Pages site.

---

## Author & Links

* **Author:** Agent 57951
* **Repository:** [https://github.com/0xe25f/LittleAutomata](https://github.com/0xe25f/LittleAutomata)
* **Documentation:** [https://0xe25f.github.io/LittleAutomata](https://0xe25f.github.io/LittleAutomata)

See [ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md) for third-party credits.

---

## Licence

MIT Licence. Copyright &copy; 2026 Agent 57951. Free for use in open-source and commercial game projects. See [LICENSE](./LICENSE).
