/**
 * @file littleautomata.js
 * LittleAutomata - a zero-dependency, zero-garbage-collection granular cellular automata
 * simulation plugin for the LittleJS 2D game engine.
 *
 * The simulation stores every cell as 4 contiguous bytes (materialId, life, vx, flags) inside
 * a pair of pre-allocated ArrayBuffer instances that are ping-ponged each simulation sub-step.
 * A 64x64 cell chunk hierarchy tracks activity so that settled, unchanging regions of the
 * world are skipped entirely during both simulation and rendering. Materials are declarative,
 * data-driven definitions grouped into five physical archetypes, and material-to-material
 * interactions are resolved in constant time via a flat 256x256 reaction lookup table.
 *
 * This module is authored as a standard ES module. Load it with a `<script type="module">`
 * tag (after LittleJS itself), or `import` it directly from a bundler or Node test runner.
 * No runtime dependencies are required; LittleJS globals (`vec2`, `EngineObject`, `cameraPos`,
 * `mainContext`, `glContext`, `worldToScreen`, `engineObjects`, `drawLight`, and so on) are
 * referenced only where present, and every integration point degrades gracefully to a pure
 * simulation-only mode when those globals are absent (for example inside a Node.js test).
 *
 * @module littleautomata
 * @license MIT
 */

// ============================================================================================
// Section 1: Deterministic Pseudo-Random Number Generator (zero allocation, xorshift32)
// ============================================================================================

/** @type {number} Internal 32-bit xorshift RNG state, reseeded via {@link seedRandom}. */
let rngState = (Date.now() ^ 0x9e3779b9) | 0 || 1;

/**
 * Reseed the deterministic pseudo-random number generator used throughout the simulation.
 * Supplying a fixed seed makes an entire simulation run byte-for-byte reproducible, which is
 * useful for automated testing and for replay/netcode style synchronisation.
 * @param {number} seed - Any 32-bit integer seed. Zero is coerced to a non-zero default.
 * @returns {void}
 */
export function seedRandom(seed) {
  rngState = (seed | 0) || 1;
}

/**
 * Advance and return the next raw unsigned 32-bit value from the internal xorshift32 stream.
 * @returns {number} An unsigned 32-bit integer in the range [0, 4294967295].
 */
function nextRandomUint32() {
  let x = rngState;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  rngState = x | 0;
  return x >>> 0;
}

/**
 * @returns {number} A pseudo-random floating point value in the half-open range [0, 1).
 */
function randomUnitFloat() {
  return nextRandomUint32() / 4294967296;
}

/**
 * @returns {boolean} A pseudo-random boolean with equal probability of true or false.
 */
function randomBool() {
  return (nextRandomUint32() & 1) === 1;
}

/**
 * @param {number} exclusiveMax - Upper exclusive bound. Must be a positive integer.
 * @returns {number} A pseudo-random integer in the range [0, exclusiveMax).
 */
function randomInt(exclusiveMax) {
  return (randomUnitFloat() * exclusiveMax) | 0;
}

// ============================================================================================
// Section 2: Core Constants, Bitfield Layout & Material Archetypes
// ============================================================================================

/** @type {number} Number of bytes occupied by a single grid cell in the packed buffer. */
export const CELL_BYTE_SIZE = 4;
/** @type {number} Byte offset of the `materialId` (Uint8) field within a packed cell. */
export const OFFSET_MATERIAL = 0;
/** @type {number} Byte offset of the `life` (Uint8) field within a packed cell. */
export const OFFSET_LIFE = 1;
/** @type {number} Byte offset of the `vx` (Int8) field within a packed cell. */
export const OFFSET_VX = 2;
/** @type {number} Byte offset of the `flags` (Uint8) field within a packed cell. */
export const OFFSET_FLAGS = 3;

/** @type {number} Flag bit set on a cell that has already been resolved during the current sweep pass. */
export const FLAG_UPDATED = 0x01;
/** @type {number} Flag bit set on every cell belonging to a chunk that is currently asleep. */
export const FLAG_SLEEPING = 0x02;
/** @type {number} Bitmask isolating the 6-bit deterministic colour variant index within `flags`. */
export const MASK_VARIANT = 0xfc;
/** @type {number} Bit shift required to read/write the colour variant index within `flags`. */
export const VARIANT_SHIFT = 2;
/** @type {number} Maximum value representable by the 6-bit colour variant index. */
export const MAX_VARIANT = 63;

/** @type {number} Fixed material identifier reserved for empty space ("Air"). */
export const AIR_MATERIAL_ID = 0;
/** @type {number} Maximum number of distinct materials the registry can hold (8-bit identifier space). */
export const MAX_MATERIALS = 256;
/** @type {number} Width and height, in cells, of a single activity/sleep chunk. */
export const CHUNK_SIZE = 64;
/** @type {number} Default maximum number of cells a falling solid or liquid may traverse in one sub-step. */
export const DEFAULT_TERMINAL_VELOCITY = 4;
/** @type {number} Default number of grid cells per LittleJS world unit. */
export const DEFAULT_PIXELS_PER_UNIT = 16;
/** @type {number} Divisor applied to material density to derive its resistance to explosive destruction. */
export const EXPLOSION_HARDNESS_DIVISOR = 2000;

/**
 * The five foundational physical behaviour archetypes that every material belongs to.
 * @readonly
 * @enum {number}
 */
export const Archetype = Object.freeze({
  /** Non-blocking empty space (Air, vacuum). */
  EMPTY: 0,
  /** Static structural mass unaffected by gravity, fluids, or lateral pressure (Stone, Bedrock). */
  IMMOVABLE_SOLID: 1,
  /** Granular mass that falls, rolls, and settles under gravity (Sand, Dirt, Gravel, Snow). */
  FALLING_SOLID: 2,
  /** Fluid mass that falls and disperses laterally by density (Water, Oil, Acid, Lava). */
  SLIDING_LIQUID: 3,
  /** Low-density vapour that rises and diffuses (Smoke, Steam, Poison Gas). */
  RISING_GAS: 4,
  /** Active thermal energy that propagates, ignites, and decays (Fire, Plasma, Sparks). */
  PROPAGATING_ENERGY: 5
});

/**
 * Convenient default identifiers for the nine materials registered by {@link initGranularEngine}.
 * These are ordinary numbers (not a magic enum) so that user code may freely register additional
 * custom materials at any unused identifier from 9 to 255.
 * @readonly
 * @enum {number}
 */
export const MaterialId = Object.freeze({
  AIR: 0,
  BEDROCK: 1,
  STONE: 2,
  SAND: 3,
  WATER: 4,
  OIL: 5,
  FIRE: 6,
  SMOKE: 7,
  ACID: 8
});

/** @type {Int8Array} Precomputed orthogonal (4-directional) neighbour X offsets, reused every call. */
const NEIGHBOUR_4_DX = Int8Array.of(1, -1, 0, 0);
/** @type {Int8Array} Precomputed orthogonal (4-directional) neighbour Y offsets, reused every call. */
const NEIGHBOUR_4_DY = Int8Array.of(0, 0, 1, -1);
/** @type {Int8Array} Precomputed full-ring (8-directional) neighbour X offsets, reused every call. */
const NEIGHBOUR_8_DX = Int8Array.of(1, -1, 0, 0, 1, 1, -1, -1);
/** @type {Int8Array} Precomputed full-ring (8-directional) neighbour Y offsets, reused every call. */
const NEIGHBOUR_8_DY = Int8Array.of(0, 0, 1, -1, 1, -1, 1, -1);

/**
 * Clamp an integer to the representable range of a signed 8-bit value.
 * @param {number} value - Input integer value.
 * @returns {number} `value` clamped to [-128, 127].
 */
function clampInt8(value) {
  return value < -128 ? -128 : value > 127 ? 127 : value | 0;
}

/**
 * Clamp an integer to the representable range of an unsigned 8-bit value.
 * @param {number} value - Input integer value.
 * @returns {number} `value` clamped to [0, 255].
 */
function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

/**
 * @param {number} archetype - Candidate archetype identifier.
 * @returns {boolean} True if the archetype behaves as a fluid (liquid or gas) for density comparisons.
 */
function isFluidArchetype(archetype) {
  return archetype === Archetype.SLIDING_LIQUID || archetype === Archetype.RISING_GAS;
}

/**
 * @param {number} archetype - Candidate archetype identifier.
 * @returns {boolean} True if the archetype physically blocks lateral movement (a solid mass).
 */
function isBlockingSolidArchetype(archetype) {
  return archetype === Archetype.IMMOVABLE_SOLID || archetype === Archetype.FALLING_SOLID;
}

// ============================================================================================
// Section 3: Colour Packing & Deterministic Spatial Hash Tinting
// ============================================================================================

/**
 * Pack four 8-bit colour channels into a single 32-bit integer using the byte order that
 * matches a little-endian `Uint32Array` view over canvas `ImageData` and a WebGL RGBA8 texture
 * (both store bytes in memory as R, G, B, A; read together as one 32-bit word this becomes
 * an "ABGR" integer, i.e. alpha in the highest byte).
 * @param {number} r - Red channel, 0-255.
 * @param {number} g - Green channel, 0-255.
 * @param {number} b - Blue channel, 0-255.
 * @param {number} a - Alpha channel, 0-255.
 * @returns {number} A packed unsigned 32-bit ABGR colour value.
 */
export function packColourRGBA(r, g, b, a) {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}

/**
 * Normalise a user-supplied colour (either a `#RRGGBB`/`#RRGGBBAA` hex string, a bare hex
 * string without `#`, or a `0xRRGGBB`/`0xRRGGBBAA` numeric literal) into a packed 32-bit ABGR
 * integer suitable for direct use as a pixel value. This runs only during material registration
 * (a one-off setup cost), never inside the simulation or render hot paths.
 * @param {string|number} colour - The colour to normalise.
 * @returns {number} A packed unsigned 32-bit ABGR colour value.
 */
export function normaliseColourToAbgr(colour) {
  if (typeof colour === 'number') {
    const hasAlpha = colour > 0xffffff;
    const r = hasAlpha ? (colour >>> 24) & 0xff : (colour >>> 16) & 0xff;
    const g = hasAlpha ? (colour >>> 16) & 0xff : (colour >>> 8) & 0xff;
    const b = hasAlpha ? (colour >>> 8) & 0xff : colour & 0xff;
    const a = hasAlpha ? colour & 0xff : 0xff;
    return packColourRGBA(r, g, b, a);
  }
  let hex = String(colour).trim();
  if (hex.charAt(0) === '#') hex = hex.slice(1);
  if (hex.length === 6) hex += 'ff';
  const intVal = parseInt(hex, 16) >>> 0;
  const r = (intVal >>> 24) & 0xff;
  const g = (intVal >>> 16) & 0xff;
  const b = (intVal >>> 8) & 0xff;
  const a = intVal & 0xff;
  return packColourRGBA(r, g, b, a);
}

/**
 * Select a material's base colour variant using a deterministic spatial hash of its cell
 * coordinate, so that flat surfaces read as naturally grained rather than a solid flat tint.
 * The same coordinate always yields the same variant, independent of when the cell was placed.
 * @param {MaterialDefinition} materialDef - The material definition to sample a colour from.
 * @param {number} cellX - Grid-space cell X coordinate.
 * @param {number} cellY - Grid-space cell Y coordinate.
 * @returns {number} A packed unsigned 32-bit ABGR colour value from the material's palette.
 */
export function getCellColour(materialDef, cellX, cellY) {
  const palette = materialDef.baseColours;
  const len = palette.length;
  if (len === 1) return palette[0];
  const hash = Math.abs((cellX * 374761393) ^ (cellY * 668265263)) % len;
  return palette[hash];
}

/**
 * Derive the 6-bit deterministic colour variant index (as stored in bits 2-7 of a cell's
 * `flags` byte) from its grid coordinate, using the same spatial hash formula as
 * {@link getCellColour} so the two stay consistent.
 * @param {number} cellX - Grid-space cell X coordinate.
 * @param {number} cellY - Grid-space cell Y coordinate.
 * @returns {number} An integer in the range [0, 63].
 */
function computeVariantIndex(cellX, cellY) {
  return Math.abs((cellX * 374761393) ^ (cellY * 668265263)) & MAX_VARIANT;
}

// ============================================================================================
// Section 4: Double-Buffered Grid Memory
// ============================================================================================

/**
 * Owns the pair of pre-allocated, contiguous `ArrayBuffer` instances that back the simulation
 * grid. Each cell occupies exactly 4 bytes (`materialId`, `life`, `vx`, `flags`), and because
 * `Uint8Array`, `Int8Array`, and `Uint32Array` views are constructed over the very same buffer,
 * an entire cell can be copied, compared, or cleared in a single zero-allocation 32-bit
 * operation via the `*U32` views, while individual fields remain addressable via the `*U8`/`*I8`
 * byte views. {@link swap} exchanges the "current" and "next" view references with zero
 * allocation and zero copying.
 */
export class GranularGridBuffer {
  /**
   * @param {number} width - Grid width in cells.
   * @param {number} height - Grid height in cells.
   */
  constructor(width, height) {
    /** @type {number} Grid width in cells. */
    this.width = width | 0;
    /** @type {number} Grid height in cells. */
    this.height = height | 0;
    /** @type {number} Total number of cells in the grid. */
    this.totalCells = (this.width * this.height) | 0;
    /** @type {number} Total byte length of each of the two backing buffers. */
    this.byteLength = this.totalCells * CELL_BYTE_SIZE;

    /** @type {ArrayBuffer} Backing storage for buffer "A". */
    this.bufferA = new ArrayBuffer(this.byteLength);
    /** @type {ArrayBuffer} Backing storage for buffer "B". */
    this.bufferB = new ArrayBuffer(this.byteLength);

    /** @type {Uint8Array} Byte-field view over buffer A. */
    this.u8A = new Uint8Array(this.bufferA);
    /** @type {Int8Array} Signed byte-field view over buffer A (used for `vx`). */
    this.i8A = new Int8Array(this.bufferA);
    /** @type {Uint32Array} Whole-cell view over buffer A. */
    this.u32A = new Uint32Array(this.bufferA);

    /** @type {Uint8Array} Byte-field view over buffer B. */
    this.u8B = new Uint8Array(this.bufferB);
    /** @type {Int8Array} Signed byte-field view over buffer B (used for `vx`). */
    this.i8B = new Int8Array(this.bufferB);
    /** @type {Uint32Array} Whole-cell view over buffer B. */
    this.u32B = new Uint32Array(this.bufferB);

    /** @type {Uint8Array} Active "current" (read model) byte view, aliases A or B. */
    this.currentU8 = this.u8A;
    /** @type {Int8Array} Active "current" (read model) signed byte view, aliases A or B. */
    this.currentI8 = this.i8A;
    /** @type {Uint32Array} Active "current" (read model) whole-cell view, aliases A or B. */
    this.currentU32 = this.u32A;

    /** @type {Uint8Array} Active "next" (write model) byte view, aliases A or B. */
    this.nextU8 = this.u8B;
    /** @type {Int8Array} Active "next" (write model) signed byte view, aliases A or B. */
    this.nextI8 = this.i8B;
    /** @type {Uint32Array} Active "next" (write model) whole-cell view, aliases A or B. */
    this.nextU32 = this.u32B;
  }

  /**
   * Compute the flat cell index for a grid coordinate. The caller is expected to have already
   * validated that the coordinate lies within bounds; this hot-path helper performs no checks.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @returns {number} The flat index into any of the `*U8`/`*I8`/`*U32` views.
   */
  index(x, y) {
    return (y * this.width + x) | 0;
  }

  /**
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @returns {boolean} True if the coordinate lies within the grid bounds.
   */
  isInBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Swap the "current" and "next" buffer view references with zero allocation and zero copying. */
  swap() {
    const tmpU8 = this.currentU8;
    const tmpI8 = this.currentI8;
    const tmpU32 = this.currentU32;

    this.currentU8 = this.nextU8;
    this.currentI8 = this.nextI8;
    this.currentU32 = this.nextU32;

    this.nextU8 = tmpU8;
    this.nextI8 = tmpI8;
    this.nextU32 = tmpU32;
  }
}

// ============================================================================================
// Section 5: Chunk Activity, Sleep & Dirty Bounds Manager
// ============================================================================================

/** @type {number} Sentinel "empty" minimum bound value used by dirty rectangle tracking. */
const DIRTY_MIN_SENTINEL = 0x7fffffff;
/** @type {number} Sentinel "empty" maximum bound value used by dirty rectangle tracking. */
const DIRTY_MAX_SENTINEL = -1;
/** @type {number} Number of consecutive quiescent sweeps before an active chunk goes to sleep. */
const CHUNK_SLEEP_THRESHOLD = 2;

/**
 * Partitions the simulation grid into uniform square chunks and tracks, per chunk: whether it
 * is currently active (must be simulated/rendered this frame), how many consecutive quiescent
 * sweeps it has endured (its sleep counter), and the tight dirty bounding rectangle of cells
 * touched since the renderer last consumed it. All storage is pre-allocated typed arrays sized
 * once at construction time; no chunk-related allocation ever occurs during simulation.
 */
export class ChunkManager {
  /**
   * @param {number} gridWidth - Simulation grid width in cells.
   * @param {number} gridHeight - Simulation grid height in cells.
   * @param {number} [chunkSize=CHUNK_SIZE] - Width and height of a single chunk, in cells.
   */
  constructor(gridWidth, gridHeight, chunkSize = CHUNK_SIZE) {
    /** @type {number} Simulation grid width in cells. */
    this.gridWidth = gridWidth | 0;
    /** @type {number} Simulation grid height in cells. */
    this.gridHeight = gridHeight | 0;
    /** @type {number} Width and height, in cells, of a single chunk. */
    this.chunkSize = chunkSize | 0;
    /** @type {number} Number of chunks spanning the grid horizontally. */
    this.chunksX = Math.ceil(this.gridWidth / this.chunkSize) | 0;
    /** @type {number} Number of chunks spanning the grid vertically. */
    this.chunksY = Math.ceil(this.gridHeight / this.chunkSize) | 0;
    /** @type {number} Total number of chunks. */
    this.totalChunks = (this.chunksX * this.chunksY) | 0;

    /** @type {Uint8Array} Per-chunk active flag (1 = must be simulated/rendered this frame). */
    this.isActive = new Uint8Array(this.totalChunks);
    /** @type {Uint8Array} Per-chunk count of consecutive quiescent sweeps. */
    this.sleepCounter = new Uint8Array(this.totalChunks);
    /** @type {Int32Array} Per-chunk dirty rectangle minimum X (world cell coordinates). */
    this.dirtyMinX = new Int32Array(this.totalChunks);
    /** @type {Int32Array} Per-chunk dirty rectangle minimum Y (world cell coordinates). */
    this.dirtyMinY = new Int32Array(this.totalChunks);
    /** @type {Int32Array} Per-chunk dirty rectangle maximum X (world cell coordinates). */
    this.dirtyMaxX = new Int32Array(this.totalChunks);
    /** @type {Int32Array} Per-chunk dirty rectangle maximum Y (world cell coordinates). */
    this.dirtyMaxY = new Int32Array(this.totalChunks);

    /** @type {Int32Array} Flat list of currently active chunk indices (fixed capacity, pre-allocated). */
    this.activeList = new Int32Array(this.totalChunks);
    /** @type {number} Number of valid entries at the front of {@link activeList}. */
    this.activeCount = 0;

    /** @type {Int32Array} Chunk indices that fell asleep during the most recent {@link endStep} call. */
    this.justSleptList = new Int32Array(this.totalChunks);
    /** @type {number} Number of valid entries in {@link justSleptList}. */
    this.justSleptCount = 0;
    /** @type {Int32Array} Chunk indices that woke up since the previous {@link endStep} call. */
    this.justWokenList = new Int32Array(this.totalChunks);
    /** @type {number} Number of valid entries in {@link justWokenList}. */
    this.justWokenCount = 0;

    /** @type {{minX: number, minY: number, maxX: number, maxY: number}} Reusable scratch bounds object. */
    this._boundsScratch = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    // Rendering consumes a SEPARATE dirty rectangle that accumulates across every sub-step of a
    // frame (a multi-sub-step update() call would otherwise have each beginStep() wipe out the
    // render-relevant bounds from earlier sub-steps before the renderer ever saw them).
    /** @type {Int32Array} Per-chunk render-dirty rectangle minimum X, accumulated since last upload. */
    this.renderDirtyMinX = new Int32Array(this.totalChunks);
    /** @type {Int32Array} Per-chunk render-dirty rectangle minimum Y, accumulated since last upload. */
    this.renderDirtyMinY = new Int32Array(this.totalChunks);
    /** @type {Int32Array} Per-chunk render-dirty rectangle maximum X, accumulated since last upload. */
    this.renderDirtyMaxX = new Int32Array(this.totalChunks);
    /** @type {Int32Array} Per-chunk render-dirty rectangle maximum Y, accumulated since last upload. */
    this.renderDirtyMaxY = new Int32Array(this.totalChunks);
    /** @type {Uint8Array} Guards against duplicate {@link renderDirtyList} entries within one accumulation period. */
    this.renderDirtyQueued = new Uint8Array(this.totalChunks);
    /** @type {Int32Array} Flat list of chunk indices awaiting a render upload. */
    this.renderDirtyList = new Int32Array(this.totalChunks);
    /** @type {number} Number of valid entries in {@link renderDirtyList}. */
    this.renderDirtyCount = 0;

    for (let i = 0; i < this.totalChunks; i++) {
      this.resetChunkBounds(i);
      this.clearRenderDirty(i);
    }
  }

  /**
   * @param {number} cellX - Grid-space cell X coordinate.
   * @param {number} cellY - Grid-space cell Y coordinate.
   * @returns {number} The flat chunk index containing the given cell coordinate.
   */
  chunkIndexAt(cellX, cellY) {
    const chunkX = Math.floor(cellX / this.chunkSize) | 0;
    const chunkY = Math.floor(cellY / this.chunkSize) | 0;
    return (chunkY * this.chunksX + chunkX) | 0;
  }

  /**
   * Compute the world-cell bounding rectangle covered by a chunk, clipped to the grid extent.
   * The result is written into a reused scratch object rather than allocating a fresh one.
   * @param {number} chunkIndex - Flat chunk index.
   * @returns {{minX: number, minY: number, maxX: number, maxY: number}} The (reused) bounds object.
   */
  getChunkWorldBounds(chunkIndex) {
    const chunkX = (chunkIndex % this.chunksX) | 0;
    const chunkY = (chunkIndex / this.chunksX) | 0;
    const b = this._boundsScratch;
    b.minX = chunkX * this.chunkSize;
    b.minY = chunkY * this.chunkSize;
    b.maxX = Math.min(b.minX + this.chunkSize - 1, this.gridWidth - 1) | 0;
    b.maxY = Math.min(b.minY + this.chunkSize - 1, this.gridHeight - 1) | 0;
    return b;
  }

  /**
   * Collapse a chunk's dirty rectangle back to its empty sentinel state.
   * @param {number} chunkIndex - Flat chunk index.
   * @returns {void}
   */
  resetChunkBounds(chunkIndex) {
    this.dirtyMinX[chunkIndex] = DIRTY_MIN_SENTINEL;
    this.dirtyMinY[chunkIndex] = DIRTY_MIN_SENTINEL;
    this.dirtyMaxX[chunkIndex] = DIRTY_MAX_SENTINEL;
    this.dirtyMaxY[chunkIndex] = DIRTY_MAX_SENTINEL;
  }

  /**
   * @param {number} chunkIndex - Flat chunk index.
   * @returns {boolean} True if the chunk's dirty rectangle currently contains at least one cell.
   */
  hasDirtyBounds(chunkIndex) {
    return this.dirtyMinX[chunkIndex] <= this.dirtyMaxX[chunkIndex];
  }

  /**
   * @param {number} chunkIndex - Flat chunk index.
   * @returns {boolean} True if the chunk has pending render-dirty cells awaiting upload.
   */
  hasRenderDirty(chunkIndex) {
    return this.renderDirtyMinX[chunkIndex] <= this.renderDirtyMaxX[chunkIndex];
  }

  /**
   * Collapse a chunk's render-dirty rectangle back to its empty sentinel state and clear its
   * queue guard, ready to accumulate fresh changes. Called by the renderer once it has
   * consumed (uploaded) a chunk's pending region.
   * @param {number} chunkIndex - Flat chunk index.
   * @returns {void}
   */
  clearRenderDirty(chunkIndex) {
    this.renderDirtyMinX[chunkIndex] = DIRTY_MIN_SENTINEL;
    this.renderDirtyMinY[chunkIndex] = DIRTY_MIN_SENTINEL;
    this.renderDirtyMaxX[chunkIndex] = DIRTY_MAX_SENTINEL;
    this.renderDirtyMaxY[chunkIndex] = DIRTY_MAX_SENTINEL;
    this.renderDirtyQueued[chunkIndex] = 0;
  }

  /**
   * Grow a chunk's dirty rectangle (both the per-step sleep-tracking rectangle and the
   * longer-lived render-upload rectangle) to include a specific cell coordinate.
   * @param {number} cellX - Grid-space cell X coordinate.
   * @param {number} cellY - Grid-space cell Y coordinate.
   * @returns {void}
   */
  markCellDirty(cellX, cellY) {
    const idx = this.chunkIndexAt(cellX, cellY);
    if (cellX < this.dirtyMinX[idx]) this.dirtyMinX[idx] = cellX;
    if (cellY < this.dirtyMinY[idx]) this.dirtyMinY[idx] = cellY;
    if (cellX > this.dirtyMaxX[idx]) this.dirtyMaxX[idx] = cellX;
    if (cellY > this.dirtyMaxY[idx]) this.dirtyMaxY[idx] = cellY;

    if (cellX < this.renderDirtyMinX[idx]) this.renderDirtyMinX[idx] = cellX;
    if (cellY < this.renderDirtyMinY[idx]) this.renderDirtyMinY[idx] = cellY;
    if (cellX > this.renderDirtyMaxX[idx]) this.renderDirtyMaxX[idx] = cellX;
    if (cellY > this.renderDirtyMaxY[idx]) this.renderDirtyMaxY[idx] = cellY;
    if (!this.renderDirtyQueued[idx]) {
      this.renderDirtyQueued[idx] = 1;
      this.renderDirtyList[this.renderDirtyCount++] = idx;
    }
  }

  /**
   * Activate a chunk (marking it for simulation and rendering this frame) if it was not
   * already active, resetting its sleep counter and recording the transition for the engine
   * to apply {@link FLAG_SLEEPING} bookkeeping against.
   * @param {number} chunkIndex - Flat chunk index.
   * @returns {void}
   */
  activate(chunkIndex) {
    if (!this.isActive[chunkIndex]) {
      this.isActive[chunkIndex] = 1;
      this.activeList[this.activeCount++] = chunkIndex;
      this.justWokenList[this.justWokenCount++] = chunkIndex;
    }
    this.sleepCounter[chunkIndex] = 0;
  }

  /**
   * Activate the chunk containing a given cell, plus all (up to) eight neighbouring chunks,
   * per the wake propagation rule: any cell change may influence adjacent chunks next sweep.
   * @param {number} cellX - Grid-space cell X coordinate.
   * @param {number} cellY - Grid-space cell Y coordinate.
   * @returns {void}
   */
  wakeChunkAt(cellX, cellY) {
    const centreChunkX = Math.floor(cellX / this.chunkSize) | 0;
    const centreChunkY = Math.floor(cellY / this.chunkSize) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const chunkY = centreChunkY + dy;
      if (chunkY < 0 || chunkY >= this.chunksY) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const chunkX = centreChunkX + dx;
        if (chunkX < 0 || chunkX >= this.chunksX) continue;
        this.activate((chunkY * this.chunksX + chunkX) | 0);
      }
    }
  }

  /**
   * Prepare all currently active chunks for a fresh simulation sweep: clear their dirty
   * rectangles and reset the woken/slept transition lists.
   * @returns {void}
   */
  beginStep() {
    for (let i = 0; i < this.activeCount; i++) this.resetChunkBounds(this.activeList[i]);
    this.justWokenCount = 0;
    this.justSleptCount = 0;
  }

  /**
   * Conclude a simulation sweep: chunks whose dirty rectangle remained empty accrue sleep
   * counter progress and go dormant once {@link CHUNK_SLEEP_THRESHOLD} is reached; the active
   * list is compacted in place to drop newly-dormant chunks with zero allocation.
   * @returns {void}
   */
  endStep() {
    let writeCursor = 0;
    for (let i = 0; i < this.activeCount; i++) {
      const idx = this.activeList[i];
      if (this.hasDirtyBounds(idx)) {
        this.sleepCounter[idx] = 0;
        this.activeList[writeCursor++] = idx;
      } else {
        this.sleepCounter[idx]++;
        if (this.sleepCounter[idx] >= CHUNK_SLEEP_THRESHOLD) {
          this.isActive[idx] = 0;
          this.justSleptList[this.justSleptCount++] = idx;
        } else {
          this.activeList[writeCursor++] = idx;
        }
      }
    }
    this.activeCount = writeCursor;
  }
}

// ============================================================================================
// Section 6: Material Definitions & Registry
// ============================================================================================

/**
 * An immutable, fully-resolved material definition. Instances are created once during
 * registration (never inside the simulation hot path) and then referenced by identifier for
 * the lifetime of the engine.
 */
export class MaterialDefinition {
  /**
   * @param {object} config - Declarative material configuration.
   * @param {number} config.id - Unique material identifier, 0-255.
   * @param {string} config.name - British English material name.
   * @param {number} config.archetype - One of the {@link Archetype} values.
   * @param {number} [config.density=1] - Mass density in kg/m^3 (controls buoyancy and settling).
   * @param {number} [config.friction=0] - Surface friction, 0.0-1.0 (resists lateral roll/slide).
   * @param {number} [config.dispersionRate=0] - Lateral search radius in cells per tick, 0-8.
   * @param {number} [config.flammability=0] - Combustion vulnerability, 0.0-1.0.
   * @param {number} [config.conductivity=0] - Thermal transmission rate, 0.0-1.0 (reserved for extension).
   * @param {number} [config.lifetime=0] - Initial lifetime in steps (0 = permanent, >0 = countdown).
   * @param {number} [config.decayInto=0] - Target material identifier when lifetime reaches zero.
   * @param {Array<string|number>} [config.baseColours=[0x00000000]] - Palette of colours (hex strings or numbers).
   * @param {string|number} [config.emissiveColour=0] - Packed light emission colour.
   * @param {number} [config.lightRadius=0] - Radius of emitted dynamic light, in LittleJS world units.
   */
  constructor(config) {
    /** @type {number} Unique material identifier, 0-255. */
    this.id = config.id | 0;
    /** @type {string} British English material name. */
    this.name = String(config.name != null ? config.name : 'Unnamed');
    /** @type {number} One of the {@link Archetype} values. */
    this.archetype = config.archetype === undefined ? Archetype.EMPTY : config.archetype | 0;
    /** @type {number} Mass density in kg/m^3. */
    this.density = config.density === undefined ? 1 : +config.density;
    /** @type {number} Surface friction, 0.0-1.0. */
    this.friction = config.friction === undefined ? 0 : +config.friction;
    /** @type {number} Lateral dispersion search radius, in cells. */
    this.dispersionRate = config.dispersionRate === undefined ? 0 : config.dispersionRate | 0;
    /** @type {number} Combustion vulnerability, 0.0-1.0. */
    this.flammability = config.flammability === undefined ? 0 : +config.flammability;
    /** @type {number} Thermal transmission rate, 0.0-1.0. */
    this.conductivity = config.conductivity === undefined ? 0 : +config.conductivity;
    /** @type {number} Initial lifetime in steps (0 = permanent). */
    this.lifetime = config.lifetime === undefined ? 0 : clampByte(config.lifetime);
    /** @type {number} Target material identifier when lifetime reaches zero. */
    this.decayInto = config.decayInto === undefined ? 0 : config.decayInto | 0;

    const sourceColours = config.baseColours && config.baseColours.length ? config.baseColours : [0x00000000];
    /** @type {Uint32Array} Packed 32-bit ABGR colour palette used for spatial hash variance. */
    this.baseColours = new Uint32Array(sourceColours.length);
    for (let i = 0; i < sourceColours.length; i++) {
      this.baseColours[i] = normaliseColourToAbgr(sourceColours[i]);
    }

    /** @type {number} Packed 32-bit ABGR dynamic light emission colour. */
    this.emissiveColour = config.emissiveColour === undefined ? 0 : normaliseColourToAbgr(config.emissiveColour);
    /** @type {number} Radius of emitted dynamic light, in LittleJS world units. */
    this.lightRadius = config.lightRadius === undefined ? 0 : +config.lightRadius;

    Object.freeze(this);
  }
}

/**
 * A fixed-capacity, `O(1)`-indexed registry of up to 256 {@link MaterialDefinition} instances.
 */
export class MaterialRegistry {
  constructor() {
    /** @type {Array<MaterialDefinition|null>} Fixed-size 256-slot material lookup table. */
    this.materials = new Array(MAX_MATERIALS).fill(null);
    /** @type {number} One past the highest registered material identifier. */
    this.count = 0;
  }

  /**
   * Register (or overwrite) a material definition.
   * @param {object} config - See {@link MaterialDefinition} constructor for the full shape.
   * @returns {number} The registered material's identifier.
   */
  register(config) {
    const id = config.id | 0;
    if (id < 0 || id >= MAX_MATERIALS) {
      throw new RangeError('LittleAutomata: material id ' + id + ' is outside the valid range [0, 255].');
    }
    if (!config.name) {
      throw new TypeError('LittleAutomata: a material definition requires a name.');
    }
    const archetype = config.archetype === undefined ? Archetype.EMPTY : config.archetype | 0;
    if (archetype < Archetype.EMPTY || archetype > Archetype.PROPAGATING_ENERGY) {
      throw new RangeError('LittleAutomata: material "' + config.name + '" has an invalid archetype.');
    }
    const definition = new MaterialDefinition(config);
    this.materials[id] = definition;
    if (id + 1 > this.count) this.count = id + 1;
    return id;
  }

  /**
   * @param {number} id - Material identifier.
   * @returns {MaterialDefinition} The material definition, or the Air definition if unregistered.
   */
  get(id) {
    const def = this.materials[id];
    return def || this.materials[AIR_MATERIAL_ID];
  }
}

// ============================================================================================
// Section 7: Flat 256x256 Reaction Lookup Matrix
// ============================================================================================

/**
 * A constant-time material interaction table. Every possible (actor, target) material pair maps
 * to a single packed 32-bit integer encoding the transformation: bits 0-7 the actor's resulting
 * material, bits 8-15 the target's resulting material, bits 16-23 the trigger probability
 * (0-255, where 255 = 100%), and bits 24-31 the lifetime assigned to newly created cells.
 */
export class ReactionMatrix {
  constructor() {
    /** @type {Uint32Array} Flat 256*256 packed reaction lookup table. */
    this.data = new Uint32Array(MAX_MATERIALS * MAX_MATERIALS);
  }

  /**
   * Register a reaction rule triggered when `actorId` touches `targetId`.
   * @param {number} actorId - The initiating material's identifier.
   * @param {number} targetId - The neighbouring material's identifier.
   * @param {number} yieldActor - Material the actor cell becomes if the reaction triggers.
   * @param {number} yieldTarget - Material the target cell becomes if the reaction triggers.
   * @param {number} probability - Chance of the reaction triggering per encounter, 0.0-1.0.
   * @param {number} [yieldLife=0] - Lifetime assigned to the resulting cells (0 = use their own default).
   * @returns {void}
   */
  register(actorId, targetId, yieldActor, yieldTarget, probability, yieldLife = 0) {
    const index = ((actorId & 0xff) << 8) | (targetId & 0xff);
    const probabilityByte = clampByte(Math.max(0, Math.min(1, probability)) * 255);
    this.data[index] =
      (yieldActor & 0xff) |
      ((yieldTarget & 0xff) << 8) |
      ((probabilityByte & 0xff) << 16) |
      ((clampByte(yieldLife) & 0xff) << 24);
  }

  /**
   * @param {number} actorId - The initiating material's identifier.
   * @param {number} targetId - The neighbouring material's identifier.
   * @returns {number} The packed 32-bit reaction payload, or 0 if no reaction is registered.
   */
  get(actorId, targetId) {
    return this.data[((actorId & 0xff) << 8) | (targetId & 0xff)];
  }
}

// ============================================================================================
// Section 8: Default Material Library & Reaction Set
// ============================================================================================

/**
 * Populate a {@link MaterialRegistry} with the nine standard built-in materials.
 * @param {MaterialRegistry} registry - The registry to populate.
 * @returns {void}
 */
export function registerDefaultMaterials(registry) {
  registry.register({
    id: MaterialId.AIR, name: 'Air', archetype: Archetype.EMPTY,
    density: 1, dispersionRate: 0, lifetime: 0,
    baseColours: ['#00000000']
  });
  registry.register({
    id: MaterialId.BEDROCK, name: 'Bedrock', archetype: Archetype.IMMOVABLE_SOLID,
    density: 100000, friction: 1, dispersionRate: 0, lifetime: 0,
    baseColours: ['#2B2B2BFF', '#1E1E1EFF']
  });
  registry.register({
    id: MaterialId.STONE, name: 'Stone', archetype: Archetype.IMMOVABLE_SOLID,
    density: 2700, friction: 0.9, dispersionRate: 0, lifetime: 0,
    baseColours: ['#70737CFF', '#585B63FF']
  });
  registry.register({
    id: MaterialId.SAND, name: 'Sand', archetype: Archetype.FALLING_SOLID,
    density: 1600, friction: 0.4, dispersionRate: 1, flammability: 0, lifetime: 0,
    baseColours: ['#D4A359FF', '#C29247FF']
  });
  registry.register({
    id: MaterialId.WATER, name: 'Water', archetype: Archetype.SLIDING_LIQUID,
    density: 1000, friction: 0.05, dispersionRate: 4, lifetime: 0,
    baseColours: ['#2E72D2CC', '#1D5AB8CC']
  });
  registry.register({
    id: MaterialId.OIL, name: 'Oil', archetype: Archetype.SLIDING_LIQUID,
    density: 800, friction: 0.1, dispersionRate: 3, flammability: 0.8, lifetime: 0,
    baseColours: ['#3B3426EE', '#29241BEE']
  });
  registry.register({
    id: MaterialId.FIRE, name: 'Fire', archetype: Archetype.PROPAGATING_ENERGY,
    density: 0, dispersionRate: 1, flammability: 0, lifetime: 30, decayInto: MaterialId.SMOKE,
    baseColours: ['#FF5722FF', '#FF9800FF'],
    emissiveColour: '#FF6D2CFF', lightRadius: 3
  });
  registry.register({
    id: MaterialId.SMOKE, name: 'Smoke', archetype: Archetype.RISING_GAS,
    density: 0.5, dispersionRate: 2, lifetime: 60, decayInto: MaterialId.AIR,
    baseColours: ['#61616188', '#42424266']
  });
  registry.register({
    id: MaterialId.ACID, name: 'Acid', archetype: Archetype.SLIDING_LIQUID,
    density: 1200, friction: 0.05, dispersionRate: 3, lifetime: 0,
    baseColours: ['#76FF03DD', '#64DD17DD']
  });
}

/**
 * Populate a {@link ReactionMatrix} with the six standard built-in reactions between default
 * materials (fire, water, oil, acid, sand, and stone).
 * @param {ReactionMatrix} reactions - The reaction matrix to populate.
 * @returns {void}
 */
export function registerDefaultReactions(reactions) {
  // Fire + Water -> Air + Smoke.
  reactions.register(MaterialId.FIRE, MaterialId.WATER, MaterialId.AIR, MaterialId.SMOKE, 1.0, 60);
  // Fire + Oil -> Fire + Fire (ignites oil).
  reactions.register(MaterialId.FIRE, MaterialId.OIL, MaterialId.FIRE, MaterialId.FIRE, 0.9, 30);
  // Acid + Stone -> Smoke + Air (dissolves solid).
  reactions.register(MaterialId.ACID, MaterialId.STONE, MaterialId.SMOKE, MaterialId.AIR, 0.2, 60);
  // Acid + Sand -> Smoke + Air.
  reactions.register(MaterialId.ACID, MaterialId.SAND, MaterialId.SMOKE, MaterialId.AIR, 0.25, 60);
  // Acid + Water -> Water + Water (diluted).
  reactions.register(MaterialId.ACID, MaterialId.WATER, MaterialId.WATER, MaterialId.WATER, 0.05, 0);
  // Fire + Sand -> Fire + Stone (smelting to glass/slag).
  reactions.register(MaterialId.FIRE, MaterialId.SAND, MaterialId.FIRE, MaterialId.STONE, 0.005, 30);
}

// ============================================================================================
// Section 9: GranularEngine - Core Orchestrator
// ============================================================================================

/**
 * @typedef {Object} GranularEngineConfig
 * @property {number} gridWidth - Width of the simulation grid, in cells.
 * @property {number} gridHeight - Height of the simulation grid, in cells.
 * @property {number} [pixelsPerUnit=16] - Number of grid cells per LittleJS world unit.
 * @property {number} [originX=0] - World-space X coordinate aligned with grid cell column 0.
 * @property {number} [originY=0] - World-space Y coordinate aligned with grid cell row 0.
 * @property {number} [subSteps=1] - Number of simulation sub-steps performed per {@link updateGranularEngine} call.
 * @property {number} [terminalVelocity=4] - Maximum cells a falling solid/liquid traverses in one sub-step.
 * @property {'auto'|'webgl'|'canvas2d'} [renderer='auto'] - Preferred rendering backend.
 * @property {(HTMLCanvasElement|OffscreenCanvas)} [canvas] - Optional explicit backing canvas.
 * @property {number} [randomSeed] - Optional deterministic seed for the internal RNG.
 */

/**
 * The central orchestrator binding together the grid buffer, chunk manager, material registry,
 * reaction matrix, and rendering backends into a single cohesive granular simulation instance.
 * A single instance is created by {@link initGranularEngine} and exposed as the module-level
 * {@link granularEngine} singleton; direct instantiation is supported for advanced use-cases
 * such as running multiple independent simulations side by side.
 */
export class GranularEngine {
  /** @param {GranularEngineConfig} config - Simulation configuration. */
  constructor(config) {
    if (!config || !(config.gridWidth > 0) || !(config.gridHeight > 0)) {
      throw new TypeError('LittleAutomata: initGranularEngine requires a positive gridWidth and gridHeight.');
    }
    if (config.randomSeed !== undefined) seedRandom(config.randomSeed);

    /** @type {number} Width of the simulation grid, in cells. */
    this.width = config.gridWidth | 0;
    /** @type {number} Height of the simulation grid, in cells. */
    this.height = config.gridHeight | 0;
    /** @type {number} Number of grid cells per LittleJS world unit. */
    this.pixelsPerUnit = config.pixelsPerUnit === undefined ? DEFAULT_PIXELS_PER_UNIT : +config.pixelsPerUnit;
    /** @type {number} World-space X coordinate aligned with grid cell column 0. */
    this.originX = config.originX === undefined ? 0 : +config.originX;
    /** @type {number} World-space Y coordinate aligned with grid cell row 0. */
    this.originY = config.originY === undefined ? 0 : +config.originY;
    /** @type {number} Number of simulation sub-steps performed per update() call. */
    this.subSteps = config.subSteps === undefined ? 1 : Math.max(1, config.subSteps | 0);
    /** @type {number} Maximum cells a falling solid/liquid traverses in one sub-step. */
    this.terminalVelocity = config.terminalVelocity === undefined
      ? DEFAULT_TERMINAL_VELOCITY : Math.max(1, config.terminalVelocity | 0);
    /** @type {number} Monotonically increasing simulation sub-step counter (wraps at 2^32). */
    this.simulationFrame = 0;

    /** @type {GranularGridBuffer} Double-buffered packed cell memory. */
    this.grid = new GranularGridBuffer(this.width, this.height);
    /** @type {ChunkManager} Activity, sleep, and dirty-rectangle tracker. */
    this.chunks = new ChunkManager(this.width, this.height, CHUNK_SIZE);
    /** @type {MaterialRegistry} Registered material definitions. */
    this.materials = new MaterialRegistry();
    /** @type {ReactionMatrix} Constant-time material interaction lookup table. */
    this.reactions = new ReactionMatrix();
    registerDefaultMaterials(this.materials);
    registerDefaultReactions(this.reactions);

    /** @type {number} Remaining camera-shake duration, in seconds. */
    this.shakeTimeRemaining = 0;
    /** @type {number} Current camera-shake intensity, in world units. */
    this.shakeIntensity = 0;

    /** @type {number} Fixed capacity of the per-frame dynamic light registration buffers. */
    this.maxLights = 256;
    /** @type {Float32Array} Registered light world-space X coordinates for the current frame. */
    this.lightX = new Float32Array(this.maxLights);
    /** @type {Float32Array} Registered light world-space Y coordinates for the current frame. */
    this.lightY = new Float32Array(this.maxLights);
    /** @type {Float32Array} Registered light radii, in LittleJS world units, for the current frame. */
    this.lightRadius = new Float32Array(this.maxLights);
    /** @type {Uint32Array} Registered light packed ABGR colours for the current frame. */
    this.lightColour = new Uint32Array(this.maxLights);
    /** @type {number} Number of valid entries in the light registration buffers this frame. */
    this.lightCount = 0;
    /** @type {{x: number, y: number}} Reusable scratch position handed to the `drawLight` integration hook. */
    this._lightPosScratch = { x: 0, y: 0 };

    /** @type {{hit: boolean, cellX: number, cellY: number, worldX: number, worldY: number,
     *   materialId: number, material: (MaterialDefinition|null), normalX: number, normalY: number,
     *   distance: number}} Reusable scratch result returned by {@link raycastWorld}. */
    this._raycastResult = {
      hit: false, cellX: 0, cellY: 0, worldX: 0, worldY: 0,
      materialId: AIR_MATERIAL_ID, material: null, normalX: 0, normalY: 0, distance: 0
    };
    /** @type {{inBounds: boolean, cellX: number, cellY: number, materialId: number,
     *   material: (MaterialDefinition|null), life: number, vx: number, flags: number}}
     *   Reusable scratch result returned by {@link sampleWorld}. */
    this._sampleResult = {
      inBounds: false, cellX: 0, cellY: 0, materialId: AIR_MATERIAL_ID,
      material: null, life: 0, vx: 0, flags: 0
    };

    this._initRenderer(config);
  }

  // ------------------------------------------------------------------------------------------
  // Coordinate conversion
  // ------------------------------------------------------------------------------------------

  /**
   * @param {number} worldX - LittleJS world-space X coordinate.
   * @returns {number} The corresponding grid cell X coordinate.
   */
  worldToCellX(worldX) {
    return Math.floor((worldX - this.originX) * this.pixelsPerUnit);
  }

  /**
   * @param {number} worldY - LittleJS world-space Y coordinate.
   * @returns {number} The corresponding grid cell Y coordinate.
   */
  worldToCellY(worldY) {
    return Math.floor((worldY - this.originY) * this.pixelsPerUnit);
  }

  /**
   * @param {number} cellX - Grid cell X coordinate.
   * @returns {number} The world-space X coordinate of the cell's centre.
   */
  cellToWorldX(cellX) {
    return (cellX + 0.5) / this.pixelsPerUnit + this.originX;
  }

  /**
   * @param {number} cellY - Grid cell Y coordinate.
   * @returns {number} The world-space Y coordinate of the cell's centre.
   */
  cellToWorldY(cellY) {
    return (cellY + 0.5) / this.pixelsPerUnit + this.originY;
  }

  // ------------------------------------------------------------------------------------------
  // Cell queries (always read the finalised "current" buffer)
  // ------------------------------------------------------------------------------------------

  /**
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @returns {number} The material identifier at the given cell, or {@link AIR_MATERIAL_ID} if out of bounds.
   */
  getMaterialId(cellX, cellY) {
    if (!this.grid.isInBounds(cellX, cellY)) return AIR_MATERIAL_ID;
    return this.grid.currentU8[this.grid.index(cellX, cellY) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
  }

  /**
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @returns {MaterialDefinition} The material definition at the given cell (Air if out of bounds or empty).
   */
  getMaterialDef(cellX, cellY) {
    return this.materials.get(this.getMaterialId(cellX, cellY));
  }

  // ------------------------------------------------------------------------------------------
  // Internal write helpers (operate on the "next" working buffer during a simulation sub-step)
  // ------------------------------------------------------------------------------------------

  /**
   * Wake the chunk (and its eight neighbours) containing a cell and grow that chunk's dirty
   * rectangle to include it. Called by every mutation helper below.
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @returns {void}
   */
  _touchCell(cellX, cellY) {
    this.chunks.wakeChunkAt(cellX, cellY);
    this.chunks.markCellDirty(cellX, cellY);
  }

  /**
   * Write a complete cell payload into the "next" working buffer, stamping a fresh
   * {@link FLAG_UPDATED} bit and deterministic colour variant, then wake/mark the chunk dirty.
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @param {number} materialId - Material identifier to write.
   * @param {number} life - Life/lifetime byte to write.
   * @param {number} vx - Signed lateral velocity/bias byte to write.
   * @returns {void}
   */
  _setCellRaw(cellX, cellY, materialId, life, vx) {
    const byteBase = this.grid.index(cellX, cellY) * CELL_BYTE_SIZE;
    const u8 = this.grid.nextU8;
    u8[byteBase + OFFSET_MATERIAL] = materialId;
    u8[byteBase + OFFSET_LIFE] = life;
    this.grid.nextI8[byteBase + OFFSET_VX] = vx;
    const variantBits = (computeVariantIndex(cellX, cellY) << VARIANT_SHIFT) & MASK_VARIANT;
    u8[byteBase + OFFSET_FLAGS] = FLAG_UPDATED | variantBits;
    this._touchCell(cellX, cellY);
  }

  /**
   * Move a cell's full payload from a source coordinate to a destination coordinate, clearing
   * the source to Air.
   * @param {number} sx - Source cell X coordinate.
   * @param {number} sy - Source cell Y coordinate.
   * @param {number} dx - Destination cell X coordinate.
   * @param {number} dy - Destination cell Y coordinate.
   * @returns {void}
   */
  _moveCell(sx, sy, dx, dy) {
    const sBase = this.grid.index(sx, sy) * CELL_BYTE_SIZE;
    const u8 = this.grid.nextU8;
    const materialId = u8[sBase + OFFSET_MATERIAL];
    const life = u8[sBase + OFFSET_LIFE];
    const vx = this.grid.nextI8[sBase + OFFSET_VX];
    this._setCellRaw(dx, dy, materialId, life, vx);
    this._setCellRaw(sx, sy, AIR_MATERIAL_ID, 0, 0);
  }

  /**
   * Exchange the full payloads of two cells (used for density-based fluid displacement).
   * @param {number} ax - First cell X coordinate.
   * @param {number} ay - First cell Y coordinate.
   * @param {number} bx - Second cell X coordinate.
   * @param {number} by - Second cell Y coordinate.
   * @returns {void}
   */
  _swapCells(ax, ay, bx, by) {
    const aBase = this.grid.index(ax, ay) * CELL_BYTE_SIZE;
    const bBase = this.grid.index(bx, by) * CELL_BYTE_SIZE;
    const u8 = this.grid.nextU8;
    const i8 = this.grid.nextI8;
    const aMat = u8[aBase + OFFSET_MATERIAL], aLife = u8[aBase + OFFSET_LIFE], aVx = i8[aBase + OFFSET_VX];
    const bMat = u8[bBase + OFFSET_MATERIAL], bLife = u8[bBase + OFFSET_LIFE], bVx = i8[bBase + OFFSET_VX];
    this._setCellRaw(ax, ay, bMat, bLife, bVx);
    this._setCellRaw(bx, by, aMat, aLife, aVx);
  }

  /**
   * Transform a cell in place into a different material, resetting its velocity to zero and
   * assigning either an explicit life value or the new material's own default lifetime.
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @param {number} newMaterialId - Material identifier to convert the cell to.
   * @param {number} [explicitLife] - Explicit life value; falsy defers to the material's own lifetime.
   * @returns {void}
   */
  _convertCellMaterial(cellX, cellY, newMaterialId, explicitLife) {
    const def = this.materials.get(newMaterialId);
    const life = explicitLife ? clampByte(explicitLife) : def.lifetime;
    this._setCellRaw(cellX, cellY, newMaterialId, life, 0);
  }

  /**
   * Update only a cell's lateral velocity/bias byte, skipping the wake/dirty bookkeeping
   * entirely when the value is unchanged. This is essential for the chunk sleep optimisation:
   * a settled pile that repeatedly "settles" to the same zero velocity must not be treated as
   * dirty forever.
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @param {number} vx - Desired signed lateral velocity/bias value.
   * @returns {void}
   */
  _setVelocityX(cellX, cellY, vx) {
    const byteBase = this.grid.index(cellX, cellY) * CELL_BYTE_SIZE + OFFSET_VX;
    const clamped = clampInt8(vx);
    if (this.grid.nextI8[byteBase] === clamped) return;
    this.grid.nextI8[byteBase] = clamped;
    this.grid.nextU8[byteBase - OFFSET_VX + OFFSET_FLAGS] |= FLAG_UPDATED;
    this._touchCell(cellX, cellY);
  }

  // ------------------------------------------------------------------------------------------
  // Simulation step orchestration
  // ------------------------------------------------------------------------------------------

  /**
   * Advance the simulation by {@link GranularEngine#subSteps} sub-steps and update any active
   * camera shake. Called by the module-level {@link updateGranularEngine} function.
   * @returns {void}
   */
  update() {
    for (let s = 0; s < this.subSteps; s++) this._simulateSubStep();
    this._updateScreenShake();
  }

  /**
   * Execute a single deterministic simulation sub-step: copy active regions into the working
   * buffer, sweep falling solids/liquids bottom-up then rising gases/energy top-down (alternating
   * horizontal traversal direction each sub-step to avoid directional drift), resolve chunk
   * sleep transitions, and finally swap the double buffer.
   * @returns {void}
   */
  _simulateSubStep() {
    this.simulationFrame = (this.simulationFrame + 1) >>> 0;
    const leftToRight = (this.simulationFrame & 1) === 0;
    this.chunks.beginStep();
    this._copyActiveRegionsToNext();
    this._sweepPassOne(leftToRight);
    this._sweepPassTwo(leftToRight);
    this.chunks.endStep();
    this._applySleepFlagTransitions();
    this.grid.swap();
  }

  /**
   * Bulk-copy every active chunk's row data from the "current" buffer into the "next" working
   * buffer (a fast native `Uint32Array.set` per row), then strip the transient
   * {@link FLAG_UPDATED} bit that would otherwise have been carried over from the previous
   * sub-step's finalised state.
   * @returns {void}
   */
  _copyActiveRegionsToNext() {
    const grid = this.grid;
    const chunks = this.chunks;
    const count = chunks.activeCount;
    for (let i = 0; i < count; i++) {
      const bounds = chunks.getChunkWorldBounds(chunks.activeList[i]);
      const minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
      const rowLength = maxX - minX + 1;
      for (let y = minY; y <= maxY; y++) {
        const rowStart = grid.index(minX, y);
        grid.nextU32.set(grid.currentU32.subarray(rowStart, rowStart + rowLength), rowStart);
      }
    }
    const clearUpdatedMask = ~FLAG_UPDATED & 0xff;
    for (let i = 0; i < count; i++) {
      const bounds = chunks.getChunkWorldBounds(chunks.activeList[i]);
      const minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
      const rowCellCount = maxX - minX + 1;
      for (let y = minY; y <= maxY; y++) {
        let byteIdx = grid.index(minX, y) * CELL_BYTE_SIZE + OFFSET_FLAGS;
        const rowEnd = byteIdx + rowCellCount * CELL_BYTE_SIZE;
        for (; byteIdx < rowEnd; byteIdx += CELL_BYTE_SIZE) grid.nextU8[byteIdx] &= clearUpdatedMask;
      }
    }
  }

  /**
   * Sweep every chunk that was active at the start of this sub-step, bottom-up, resolving
   * immovable solids, falling solids, and sliding liquids (and any reactions they trigger).
   * Newly-woken chunks (activated mid-sweep by a reaction near a chunk boundary) are correctly
   * deferred to the next sub-step rather than processed with un-copied working-buffer state.
   * @param {boolean} leftToRight - Horizontal traversal direction for this sub-step.
   * @returns {void}
   */
  _sweepPassOne(leftToRight) {
    const chunks = this.chunks;
    const count = chunks.activeCount;
    for (let i = 0; i < count; i++) {
      const bounds = chunks.getChunkWorldBounds(chunks.activeList[i]);
      const minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
      for (let y = minY; y <= maxY; y++) {
        if (leftToRight) {
          for (let x = minX; x <= maxX; x++) this._processCellPassOne(x, y);
        } else {
          for (let x = maxX; x >= minX; x--) this._processCellPassOne(x, y);
        }
      }
    }
  }

  /**
   * Sweep every chunk that was active at the start of this sub-step, top-down, resolving rising
   * gases and propagating energy (fire), including lifetime decay and ignition.
   * @param {boolean} leftToRight - Horizontal traversal direction for this sub-step.
   * @returns {void}
   */
  _sweepPassTwo(leftToRight) {
    const chunks = this.chunks;
    const count = chunks.activeCount;
    for (let i = 0; i < count; i++) {
      const bounds = chunks.getChunkWorldBounds(chunks.activeList[i]);
      const minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
      for (let y = maxY; y >= minY; y--) {
        if (leftToRight) {
          for (let x = minX; x <= maxX; x++) this._processCellPassTwo(x, y);
        } else {
          for (let x = maxX; x >= minX; x--) this._processCellPassTwo(x, y);
        }
      }
    }
  }

  /**
   * Dispatch a single cell during the bottom-up pass: immovable solids, falling solids, and
   * sliding liquids all react with their neighbours here, then (if not consumed by a reaction)
   * attempt their archetype-specific movement.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @returns {void}
   */
  _processCellPassOne(x, y) {
    const byteBase = this.grid.index(x, y) * CELL_BYTE_SIZE;
    const u8 = this.grid.nextU8;
    if (u8[byteBase + OFFSET_FLAGS] & FLAG_UPDATED) return;
    const materialId = u8[byteBase + OFFSET_MATERIAL];
    if (materialId === AIR_MATERIAL_ID) return;
    this._reactWithNeighbours(x, y);
    if (u8[byteBase + OFFSET_FLAGS] & FLAG_UPDATED) return;
    const def = this.materials.get(materialId);
    if (def.archetype === Archetype.FALLING_SOLID) this._fallingSolidStep(x, y, def);
    else if (def.archetype === Archetype.SLIDING_LIQUID) this._slidingLiquidStep(x, y, def);
  }

  /**
   * Dispatch a single cell during the top-down pass: only rising gases and propagating energy
   * are handled here (everything else was already fully resolved during pass one).
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @returns {void}
   */
  _processCellPassTwo(x, y) {
    const byteBase = this.grid.index(x, y) * CELL_BYTE_SIZE;
    const u8 = this.grid.nextU8;
    if (u8[byteBase + OFFSET_FLAGS] & FLAG_UPDATED) return;
    const materialId = u8[byteBase + OFFSET_MATERIAL];
    if (materialId === AIR_MATERIAL_ID) return;
    const archetype = this.materials.get(materialId).archetype;
    if (archetype !== Archetype.RISING_GAS && archetype !== Archetype.PROPAGATING_ENERGY) return;
    this._reactWithNeighbours(x, y);
    if (u8[byteBase + OFFSET_FLAGS] & FLAG_UPDATED) return;
    const def = this.materials.get(materialId);
    if (this._applyLifetimeDecay(x, y, def)) return;
    if (def.archetype === Archetype.RISING_GAS) this._risingGasStep(x, y, def);
    else this._igniteNeighbours(x, y, materialId, def);
  }

  // ------------------------------------------------------------------------------------------
  // Reactions & ignition
  // ------------------------------------------------------------------------------------------

  /**
   * Scan a cell's four orthogonal neighbours for a registered {@link ReactionMatrix} entry, and
   * apply (at most one, per spec) triggered transformation this sweep.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @returns {void}
   */
  _reactWithNeighbours(x, y) {
    const grid = this.grid;
    const u8 = grid.nextU8;
    const selfMat = u8[grid.index(x, y) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
    for (let i = 0; i < 4; i++) {
      const nx = x + NEIGHBOUR_4_DX[i];
      const ny = y + NEIGHBOUR_4_DY[i];
      if (!grid.isInBounds(nx, ny)) continue;
      const nBase = grid.index(nx, ny) * CELL_BYTE_SIZE;
      const neighbourMat = u8[nBase + OFFSET_MATERIAL];
      if (neighbourMat === AIR_MATERIAL_ID) continue;
      if (u8[nBase + OFFSET_FLAGS] & FLAG_UPDATED) continue;
      const packed = this.reactions.get(selfMat, neighbourMat);
      if (packed === 0) continue;
      const probabilityByte = (packed >>> 16) & 0xff;
      if (randomInt(256) >= probabilityByte) continue;
      const yieldActor = packed & 0xff;
      const yieldTarget = (packed >>> 8) & 0xff;
      const yieldLife = (packed >>> 24) & 0xff;
      this._convertCellMaterial(x, y, yieldActor, yieldLife);
      this._convertCellMaterial(nx, ny, yieldTarget, yieldLife);
      return;
    }
  }

  /**
   * Scan a propagating-energy cell's eight surrounding neighbours and probabilistically ignite
   * any sufficiently flammable neighbour that has no explicit {@link ReactionMatrix} entry
   * against this material (explicit reactions always take precedence over generic ignition).
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {number} selfMaterialId - The igniting material's own identifier.
   * @param {MaterialDefinition} def - The igniting material's definition (unused directly, kept for symmetry).
   * @returns {void}
   */
  _igniteNeighbours(x, y, selfMaterialId, def) {
    const grid = this.grid;
    const u8 = grid.nextU8;
    for (let i = 0; i < 8; i++) {
      const nx = x + NEIGHBOUR_8_DX[i];
      const ny = y + NEIGHBOUR_8_DY[i];
      if (!grid.isInBounds(nx, ny)) continue;
      const nBase = grid.index(nx, ny) * CELL_BYTE_SIZE;
      const neighbourMat = u8[nBase + OFFSET_MATERIAL];
      if (neighbourMat === AIR_MATERIAL_ID) continue;
      if (u8[nBase + OFFSET_FLAGS] & FLAG_UPDATED) continue;
      if (this.reactions.get(selfMaterialId, neighbourMat) !== 0) continue;
      const neighbourDef = this.materials.get(neighbourMat);
      if (neighbourDef.flammability <= 0) continue;
      if (randomUnitFloat() >= neighbourDef.flammability) continue;
      this._convertCellMaterial(nx, ny, selfMaterialId, 20 + randomInt(20));
    }
  }

  /**
   * Decrement a cell's lifetime countdown, converting it into its configured `decayInto`
   * material once the countdown reaches zero. Materials with `lifetime === 0` are permanent
   * and never decay.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {MaterialDefinition} def - The cell's current material definition.
   * @returns {boolean} True if the cell was converted (and should not be processed further this sweep).
   */
  _applyLifetimeDecay(x, y, def) {
    if (def.lifetime <= 0) return false;
    const byteBase = this.grid.index(x, y) * CELL_BYTE_SIZE;
    const life = this.grid.nextU8[byteBase + OFFSET_LIFE];
    if (life > 1) {
      this.grid.nextU8[byteBase + OFFSET_LIFE] = life - 1;
      // The countdown itself is a genuine state change every sub-step: it must mark the chunk
      // dirty so the sleep bookkeeping doesn't let the chunk go dormant mid-countdown (which
      // would desynchronise the double buffer once the chunk stops being copied each sub-step).
      this._touchCell(x, y);
      return false;
    }
    this._convertCellMaterial(x, y, def.decayInto);
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Falling solid archetype (Section 4.2)
  // ------------------------------------------------------------------------------------------

  /**
   * Attempt to fall straight down, checking each intermediate cell one at a time (up to
   * {@link GranularEngine#terminalVelocity} cells) so that thin one-cell barriers can never be
   * tunnelled through, and swapping through less-dense fluids along the way.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {number} materialId - The falling cell's own material identifier (used for defensive symmetry).
   * @param {number} density - The falling cell's own material density.
   * @returns {boolean} True if the cell moved (or swapped) at least one cell downward.
   */
  _attemptFall(x, y, materialId, density) {
    const grid = this.grid;
    let cx = x, cy = y;
    let steps = 0;
    while (steps < this.terminalVelocity) {
      const ny = cy - 1;
      if (ny < 0) break;
      const targetMat = grid.nextU8[grid.index(cx, ny) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
      if (targetMat === AIR_MATERIAL_ID) { cy = ny; steps++; continue; }
      const targetDef = this.materials.get(targetMat);
      if (isFluidArchetype(targetDef.archetype) && targetDef.density < density) {
        this._swapCells(cx, cy, cx, ny);
        return true;
      }
      break;
    }
    if (cy !== y) { this._moveCell(x, y, cx, cy); return true; }
    return false;
  }

  /**
   * Attempt a single-cell diagonal fall for a granular solid, transferring lateral "roll"
   * momentum into the destination cell's `vx` byte on success.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {number} dir - Horizontal direction to test, either +1 or -1.
   * @param {MaterialDefinition} def - The falling solid's own material definition.
   * @returns {boolean} True if the cell moved (or swapped) diagonally.
   */
  _fallingSolidTryDiagonal(x, y, dir, def) {
    const nx = x + dir, ny = y - 1;
    if (!this.grid.isInBounds(nx, ny)) return false;
    const targetMat = this.grid.nextU8[this.grid.index(nx, ny) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
    if (targetMat === AIR_MATERIAL_ID) {
      this._moveCell(x, y, nx, ny);
      this._setVelocityX(nx, ny, dir * 2);
      return true;
    }
    const targetDef = this.materials.get(targetMat);
    if (isFluidArchetype(targetDef.archetype) && targetDef.density < def.density) {
      this._swapCells(x, y, nx, ny);
      this._setVelocityX(nx, ny, dir * 2);
      return true;
    }
    return false;
  }

  /**
   * Attempt a single-cell horizontal slide in the given direction, used when a settled solid
   * still carries lateral momentum but cannot fall or roll diagonally.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {number} dir - Horizontal direction to test, either +1 or -1.
   * @returns {boolean} True if the cell slid.
   */
  _tryLateralSlide(x, y, dir) {
    const nx = x + dir;
    if (!this.grid.isInBounds(nx, y)) return false;
    if (this.grid.nextU8[this.grid.index(nx, y) * CELL_BYTE_SIZE + OFFSET_MATERIAL] !== AIR_MATERIAL_ID) return false;
    this._moveCell(x, y, nx, y);
    return true;
  }

  /**
   * Full falling-solid archetype step: straight-down raymarch, then randomised diagonal
   * roll, then lateral slide on existing momentum, finally settling with zero velocity.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {MaterialDefinition} def - The falling solid's material definition.
   * @returns {void}
   */
  _fallingSolidStep(x, y, def) {
    if (this._attemptFall(x, y, def.id, def.density)) return;
    const firstDir = randomBool() ? 1 : -1;
    if (this._fallingSolidTryDiagonal(x, y, firstDir, def)) return;
    if (this._fallingSolidTryDiagonal(x, y, -firstDir, def)) return;
    const currentVx = this.grid.nextI8[this.grid.index(x, y) * CELL_BYTE_SIZE + OFFSET_VX];
    if (currentVx !== 0 && this._tryLateralSlide(x, y, currentVx > 0 ? 1 : -1)) return;
    this._setVelocityX(x, y, 0);
  }

  // ------------------------------------------------------------------------------------------
  // Sliding liquid archetype (Section 4.3)
  // ------------------------------------------------------------------------------------------

  /**
   * Attempt a single-cell diagonal fall for a liquid (no lateral momentum transfer, unlike
   * granular solids: a liquid's `vx` is reserved for lateral flow-direction memory instead).
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {number} dir - Horizontal direction to test, either +1 or -1.
   * @param {number} density - The liquid's own material density.
   * @returns {boolean} True if the cell moved (or swapped) diagonally.
   */
  _tryDiagonalDown(x, y, dir, density) {
    const nx = x + dir, ny = y - 1;
    if (!this.grid.isInBounds(nx, ny)) return false;
    const targetMat = this.grid.nextU8[this.grid.index(nx, ny) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
    if (targetMat === AIR_MATERIAL_ID) { this._moveCell(x, y, nx, ny); return true; }
    const targetDef = this.materials.get(targetMat);
    if (isFluidArchetype(targetDef.archetype) && targetDef.density < density) {
      this._swapCells(x, y, nx, ny);
      return true;
    }
    return false;
  }

  /**
   * Lateral fluid spread: scan up to `dispersionRate` cells in the preferred flow direction
   * (remembered via `vx`, or chosen randomly if currently zero), stopping at the first solid or
   * denser fluid, and settling at either the furthest reachable empty cell or a swap with the
   * first reachable less-dense fluid.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {MaterialDefinition} def - The liquid's material definition.
   * @returns {void}
   */
  _lateralFluidSpread(x, y, def) {
    const grid = this.grid;
    const byteBase = grid.index(x, y) * CELL_BYTE_SIZE;
    const currentVx = grid.nextI8[byteBase + OFFSET_VX];
    const dir = currentVx > 0 ? 1 : currentVx < 0 ? -1 : (randomBool() ? 1 : -1);
    let bestX = -1;
    let bestIsSwap = false;
    for (let step = 1; step <= def.dispersionRate; step++) {
      const cx = x + dir * step;
      if (!grid.isInBounds(cx, y)) break;
      const targetMat = grid.nextU8[grid.index(cx, y) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
      if (targetMat === AIR_MATERIAL_ID) { bestX = cx; bestIsSwap = false; continue; }
      const targetDef = this.materials.get(targetMat);
      if (isBlockingSolidArchetype(targetDef.archetype)) break;
      if (targetDef.density < def.density) { bestX = cx; bestIsSwap = true; }
      break;
    }
    if (bestX === -1) { this._setVelocityX(x, y, 0); return; }
    if (bestIsSwap) this._swapCells(x, y, bestX, y);
    else this._moveCell(x, y, bestX, y);
    this._setVelocityX(bestX, y, dir * def.dispersionRate);
  }

  /**
   * Full sliding-liquid archetype step: straight-down raymarch, randomised diagonal fall, then
   * lateral dispersion.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {MaterialDefinition} def - The liquid's material definition.
   * @returns {void}
   */
  _slidingLiquidStep(x, y, def) {
    if (this._attemptFall(x, y, def.id, def.density)) return;
    const firstDir = randomBool() ? 1 : -1;
    if (this._tryDiagonalDown(x, y, firstDir, def.density)) return;
    if (this._tryDiagonalDown(x, y, -firstDir, def.density)) return;
    this._lateralFluidSpread(x, y, def);
  }

  // ------------------------------------------------------------------------------------------
  // Rising gas archetype (Section 4.4)
  // ------------------------------------------------------------------------------------------

  /**
   * Attempt a single-cell diagonal rise for a gas.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {number} dir - Horizontal direction to test, either +1 or -1.
   * @returns {boolean} True if the cell rose diagonally.
   */
  _tryDiagonalUp(x, y, dir) {
    const nx = x + dir, ny = y + 1;
    if (!this.grid.isInBounds(nx, ny)) return false;
    if (this.grid.nextU8[this.grid.index(nx, ny) * CELL_BYTE_SIZE + OFFSET_MATERIAL] !== AIR_MATERIAL_ID) return false;
    this._moveCell(x, y, nx, ny);
    return true;
  }

  /**
   * Disperse a blocked gas cell horizontally in a freshly-randomised direction each step
   * (higher diffusion randomness than a liquid's remembered flow direction), up to its
   * material's dispersion rate.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {MaterialDefinition} def - The gas's material definition.
   * @returns {void}
   */
  _lateralGasDisperse(x, y, def) {
    const grid = this.grid;
    const dir = randomBool() ? 1 : -1;
    let bestX = -1;
    for (let step = 1; step <= def.dispersionRate; step++) {
      const cx = x + dir * step;
      if (!grid.isInBounds(cx, y)) break;
      if (grid.nextU8[grid.index(cx, y) * CELL_BYTE_SIZE + OFFSET_MATERIAL] !== AIR_MATERIAL_ID) break;
      bestX = cx;
    }
    if (bestX !== -1) this._moveCell(x, y, bestX, y);
  }

  /**
   * Full rising-gas archetype step: straight-up attempt (with density-based downward-fluid
   * swap), randomised diagonal rise, then lateral diffusion.
   * @param {number} x - Cell X coordinate.
   * @param {number} y - Cell Y coordinate.
   * @param {MaterialDefinition} def - The gas's material definition.
   * @returns {void}
   */
  _risingGasStep(x, y, def) {
    const grid = this.grid;
    const ny = y + 1;
    if (ny < grid.height) {
      const targetMat = grid.nextU8[grid.index(x, ny) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
      if (targetMat === AIR_MATERIAL_ID) { this._moveCell(x, y, x, ny); return; }
      const targetDef = this.materials.get(targetMat);
      if (isFluidArchetype(targetDef.archetype) && targetDef.density > def.density) {
        this._swapCells(x, y, x, ny);
        return;
      }
    }
    const firstDir = randomBool() ? 1 : -1;
    if (this._tryDiagonalUp(x, y, firstDir)) return;
    if (this._tryDiagonalUp(x, y, -firstDir)) return;
    this._lateralGasDisperse(x, y, def);
  }

  // ------------------------------------------------------------------------------------------
  // Chunk sleep <-> FLAG_SLEEPING bookkeeping
  // ------------------------------------------------------------------------------------------

  /**
   * Apply the {@link FLAG_SLEEPING} bit across every cell of every chunk that changed activity
   * state this sub-step (a rare, bounded-cost operation restricted to transitioning chunks only).
   * @returns {void}
   */
  _applySleepFlagTransitions() {
    const chunks = this.chunks;
    for (let i = 0; i < chunks.justSleptCount; i++) this._setChunkSleepFlag(chunks.justSleptList[i], true);
    for (let i = 0; i < chunks.justWokenCount; i++) this._setChunkSleepFlag(chunks.justWokenList[i], false);
  }

  /**
   * @param {number} chunkIndex - Flat chunk index.
   * @param {boolean} isSleeping - Whether to set (true) or clear (false) {@link FLAG_SLEEPING}.
   * @returns {void}
   */
  _setChunkSleepFlag(chunkIndex, isSleeping) {
    const bounds = this.chunks.getChunkWorldBounds(chunkIndex);
    const minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
    const grid = this.grid;
    const clearMask = ~FLAG_SLEEPING & 0xff;
    const rowCellCount = maxX - minX + 1;
    // A sleeping chunk is permanently excluded from _copyActiveRegionsToNext, so whichever of
    // the two ping-pong buffers is NOT touched here would otherwise keep a stale flags byte
    // forever, flickering FLAG_SLEEPING on and off every time the buffers swap. Writing the bit
    // into both buffers keeps it stable for as long as the chunk stays dormant.
    for (let y = minY; y <= maxY; y++) {
      let byteIdx = grid.index(minX, y) * CELL_BYTE_SIZE + OFFSET_FLAGS;
      const rowEnd = byteIdx + rowCellCount * CELL_BYTE_SIZE;
      if (isSleeping) {
        for (; byteIdx < rowEnd; byteIdx += CELL_BYTE_SIZE) {
          grid.nextU8[byteIdx] |= FLAG_SLEEPING;
          grid.currentU8[byteIdx] |= FLAG_SLEEPING;
        }
      } else {
        for (; byteIdx < rowEnd; byteIdx += CELL_BYTE_SIZE) {
          grid.nextU8[byteIdx] &= clearMask;
          grid.currentU8[byteIdx] &= clearMask;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Camera shake
  // ------------------------------------------------------------------------------------------

  /**
   * Advance and apply the current camera-shake effect (triggered by {@link createExplosion}) by
   * directly nudging the LittleJS `cameraPos` global, if present. The previous frame's offset is
   * always undone before a new one is applied, so the camera returns exactly to its intended
   * position once the shake finishes rather than drifting.
   * @returns {void}
   */
  _updateScreenShake() {
    if (typeof cameraPos === 'undefined' || !cameraPos) return;
    cameraPos.x -= this._shakeOffsetX;
    cameraPos.y -= this._shakeOffsetY;
    this._shakeOffsetX = 0;
    this._shakeOffsetY = 0;
    if (this.shakeTimeRemaining <= 0) return;
    const dt = typeof timeDelta === 'number' ? timeDelta : (1 / 60);
    this.shakeTimeRemaining = Math.max(0, this.shakeTimeRemaining - dt);
    const intensity = this.shakeIntensity * this.shakeTimeRemaining;
    this._shakeOffsetX = (randomUnitFloat() * 2 - 1) * intensity;
    this._shakeOffsetY = (randomUnitFloat() * 2 - 1) * intensity;
    cameraPos.x += this._shakeOffsetX;
    cameraPos.y += this._shakeOffsetY;
    if (this.shakeTimeRemaining <= 0) this.shakeIntensity = 0;
  }

  // ------------------------------------------------------------------------------------------
  // External (non-simulation) cell mutation - writes both buffers immediately, so painted or
  // loaded state is instantly queryable without waiting for a subsequent update() + swap.
  // ------------------------------------------------------------------------------------------

  /**
   * Write a fresh material into a cell in both the "current" and "next" buffers simultaneously,
   * so brush/paint/explosion/load operations are immediately reflected by every query and by
   * the very next render, without depending on simulation buffer swap timing.
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @param {number} materialId - Material identifier to place.
   * @returns {void}
   */
  _paintCellMaterial(cellX, cellY, materialId) {
    const def = this.materials.get(materialId);
    const byteBase = this.grid.index(cellX, cellY) * CELL_BYTE_SIZE;
    const variantBits = (computeVariantIndex(cellX, cellY) << VARIANT_SHIFT) & MASK_VARIANT;
    const flags = FLAG_UPDATED | variantBits;

    this.grid.currentU8[byteBase + OFFSET_MATERIAL] = materialId;
    this.grid.currentU8[byteBase + OFFSET_LIFE] = def.lifetime;
    this.grid.currentI8[byteBase + OFFSET_VX] = 0;
    this.grid.currentU8[byteBase + OFFSET_FLAGS] = flags;

    this.grid.nextU8[byteBase + OFFSET_MATERIAL] = materialId;
    this.grid.nextU8[byteBase + OFFSET_LIFE] = def.lifetime;
    this.grid.nextI8[byteBase + OFFSET_VX] = 0;
    this.grid.nextU8[byteBase + OFFSET_FLAGS] = flags;

    this._touchCell(cellX, cellY);
  }

  /**
   * Set a cell's lateral velocity/bias byte in both buffers simultaneously (the external
   * counterpart to {@link GranularEngine#_setVelocityX}, used outside of an active sweep).
   * @param {number} cellX - Grid cell X coordinate.
   * @param {number} cellY - Grid cell Y coordinate.
   * @param {number} vx - Desired signed lateral velocity/bias value.
   * @returns {void}
   */
  _setVelocityXBoth(cellX, cellY, vx) {
    const byteBase = this.grid.index(cellX, cellY) * CELL_BYTE_SIZE;
    const clamped = clampInt8(vx);
    this.grid.currentI8[byteBase + OFFSET_VX] = clamped;
    this.grid.nextI8[byteBase + OFFSET_VX] = clamped;
    this.grid.currentU8[byteBase + OFFSET_FLAGS] |= FLAG_UPDATED;
    this.grid.nextU8[byteBase + OFFSET_FLAGS] |= FLAG_UPDATED;
    this._touchCell(cellX, cellY);
  }

  /**
   * Rasterise a filled circle of a material directly in grid-cell space.
   * @param {number} centreX - Circle centre, grid cell X coordinate.
   * @param {number} centreY - Circle centre, grid cell Y coordinate.
   * @param {number} radiusCells - Circle radius, in cells.
   * @param {number} materialId - Material identifier to stamp.
   * @returns {void}
   */
  _stampCircle(centreX, centreY, radiusCells, materialId) {
    const grid = this.grid;
    const radiusSq = radiusCells * radiusCells;
    const minX = Math.max(0, Math.floor(centreX - radiusCells));
    const maxX = Math.min(grid.width - 1, Math.ceil(centreX + radiusCells));
    const minY = Math.max(0, Math.floor(centreY - radiusCells));
    const maxY = Math.min(grid.height - 1, Math.ceil(centreY + radiusCells));
    for (let y = minY; y <= maxY; y++) {
      const dy = y - centreY;
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centreX;
        if (dx * dx + dy * dy <= radiusSq) this._paintCellMaterial(x, y, materialId);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Brush & world manipulation API (Section 5.3 / AGENTS.md)
  // ------------------------------------------------------------------------------------------

  /**
   * Draw a filled circle of a given material into the world.
   * @param {number} worldX - World-space X coordinate of the circle centre.
   * @param {number} worldY - World-space Y coordinate of the circle centre.
   * @param {number} radiusWorld - Circle radius, in LittleJS world units.
   * @param {number} materialId - Material identifier to paint.
   * @returns {void}
   */
  paintCircle(worldX, worldY, radiusWorld, materialId) {
    const centreX = this.worldToCellX(worldX);
    const centreY = this.worldToCellY(worldY);
    this._stampCircle(centreX, centreY, Math.max(0, radiusWorld * this.pixelsPerUnit), materialId);
  }

  /**
   * Sweep a solid line brush between two world-space points.
   * @param {number} startX - World-space X coordinate of the line start.
   * @param {number} startY - World-space Y coordinate of the line start.
   * @param {number} endX - World-space X coordinate of the line end.
   * @param {number} endY - World-space Y coordinate of the line end.
   * @param {number} radiusWorld - Brush radius, in LittleJS world units.
   * @param {number} materialId - Material identifier to paint.
   * @returns {void}
   */
  paintLine(startX, startY, endX, endY, radiusWorld, materialId) {
    let cx = this.worldToCellX(startX);
    let cy = this.worldToCellY(startY);
    const x1 = this.worldToCellX(endX);
    const y1 = this.worldToCellY(endY);
    const radiusCells = Math.max(0, radiusWorld * this.pixelsPerUnit);
    const dx = Math.abs(x1 - cx);
    const dy = Math.abs(y1 - cy);
    const sx = cx < x1 ? 1 : -1;
    const sy = cy < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      this._stampCircle(cx, cy, radiusCells, materialId);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
  }

  /**
   * Trigger an explosion that destroys terrain, dissolves solids proportionally to their
   * density, propels nearby granular debris and ignites flammable perimeter material, pushes
   * any LittleJS `EngineObject` rigid bodies within range, triggers a camera shake, and (when
   * LittleJS's particle system is present) spawns a short-lived spark burst.
   * @param {number} worldX - World-space X coordinate of the explosion centre.
   * @param {number} worldY - World-space Y coordinate of the explosion centre.
   * @param {number} radiusWorld - Blast radius, in LittleJS world units.
   * @param {number} [power=1.0] - Explosive power; scales destruction of hard solids and impulse strength.
   * @returns {void}
   */
  createExplosion(worldX, worldY, radiusWorld, power = 1.0) {
    const centreX = this.worldToCellX(worldX);
    const centreY = this.worldToCellY(worldY);
    const radiusCells = Math.max(1, radiusWorld * this.pixelsPerUnit);
    const craterRadius = radiusCells * 0.6;
    const craterRadiusSq = craterRadius * craterRadius;
    const radiusSq = radiusCells * radiusCells;
    const minX = Math.max(0, Math.floor(centreX - radiusCells));
    const maxX = Math.min(this.grid.width - 1, Math.ceil(centreX + radiusCells));
    const minY = Math.max(0, Math.floor(centreY - radiusCells));
    const maxY = Math.min(this.grid.height - 1, Math.ceil(centreY + radiusCells));

    for (let y = minY; y <= maxY; y++) {
      const dy = y - centreY;
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centreX;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;
        const materialId = this.getMaterialId(x, y);
        if (materialId === AIR_MATERIAL_ID) continue;
        const def = this.materials.get(materialId);
        if (def.archetype === Archetype.IMMOVABLE_SOLID) {
          if (power >= def.density / EXPLOSION_HARDNESS_DIVISOR) this._paintCellMaterial(x, y, AIR_MATERIAL_ID);
          continue;
        }
        if (distSq <= craterRadiusSq) {
          this._paintCellMaterial(x, y, AIR_MATERIAL_ID);
          continue;
        }
        if (def.archetype === Archetype.FALLING_SOLID || def.archetype === Archetype.SLIDING_LIQUID) {
          if (def.flammability > 0 && randomUnitFloat() < def.flammability) {
            this._paintCellMaterial(x, y, MaterialId.FIRE);
          } else {
            const dirSign = dx === 0 ? (randomBool() ? 1 : -1) : (dx > 0 ? 1 : -1);
            this._setVelocityXBoth(x, y, dirSign * 100);
          }
        }
      }
    }

    this.shakeIntensity = Math.max(this.shakeIntensity, Math.min(1, power * 0.3));
    this.shakeTimeRemaining = Math.max(this.shakeTimeRemaining, Math.min(0.6, 0.15 + power * 0.1));

    if (typeof engineObjects !== 'undefined' && engineObjects) {
      for (let i = 0; i < engineObjects.length; i++) {
        const entity = engineObjects[i];
        if (!entity || !entity.pos || !entity.velocity) continue;
        const ex = entity.pos.x - worldX;
        const ey = entity.pos.y - worldY;
        const distWorld = Math.sqrt(ex * ex + ey * ey);
        if (distWorld <= 0 || distWorld > radiusWorld) continue;
        const impulse = power * (1 - distWorld / radiusWorld) * 8;
        entity.velocity.x += (ex / distWorld) * impulse;
        entity.velocity.y += (ey / distWorld) * impulse;
      }
    }

    if (typeof ParticleEmitter === 'function' && typeof vec2 === 'function') {
      new ParticleEmitter(vec2(worldX, worldY), 0, radiusWorld, 0.2, 200, Math.PI);
    }
  }

  /**
   * Sample material definition and full cell state at a specific world coordinate. The
   * returned object is reused across calls (zero allocation); copy any fields you need to keep
   * before calling this again.
   * @param {number} worldX - World-space X coordinate to sample.
   * @param {number} worldY - World-space Y coordinate to sample.
   * @returns {{inBounds: boolean, cellX: number, cellY: number, materialId: number,
   *   material: MaterialDefinition, life: number, vx: number, flags: number}} The reused sample result.
   */
  sampleWorld(worldX, worldY) {
    const result = this._sampleResult;
    const cellX = this.worldToCellX(worldX);
    const cellY = this.worldToCellY(worldY);
    result.cellX = cellX;
    result.cellY = cellY;
    if (!this.grid.isInBounds(cellX, cellY)) {
      result.inBounds = false;
      result.materialId = AIR_MATERIAL_ID;
      result.material = this.materials.get(AIR_MATERIAL_ID);
      result.life = 0;
      result.vx = 0;
      result.flags = 0;
      return result;
    }
    const byteBase = this.grid.index(cellX, cellY) * CELL_BYTE_SIZE;
    result.inBounds = true;
    result.materialId = this.grid.currentU8[byteBase + OFFSET_MATERIAL];
    result.material = this.materials.get(result.materialId);
    result.life = this.grid.currentU8[byteBase + OFFSET_LIFE];
    result.vx = this.grid.currentI8[byteBase + OFFSET_VX];
    result.flags = this.grid.currentU8[byteBase + OFFSET_FLAGS];
    return result;
  }

  /**
   * Cast a ray through the granular grid using integer Bresenham stepping, returning the first
   * hit cell and an axis-aligned surface normal. The returned object is reused across calls
   * (zero allocation); copy any fields you need to keep before calling this again.
   * @param {number} startX - World-space X coordinate of the ray origin.
   * @param {number} startY - World-space Y coordinate of the ray origin.
   * @param {number} endX - World-space X coordinate of the ray's far end.
   * @param {number} endY - World-space Y coordinate of the ray's far end.
   * @returns {{hit: boolean, cellX: number, cellY: number, worldX: number, worldY: number,
   *   materialId: number, material: MaterialDefinition, normalX: number, normalY: number,
   *   distance: number}} The reused raycast result.
   */
  raycastWorld(startX, startY, endX, endY) {
    const result = this._raycastResult;
    let x0 = this.worldToCellX(startX);
    let y0 = this.worldToCellY(startY);
    const x1 = this.worldToCellX(endX);
    const y1 = this.worldToCellY(endY);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let normalX = 0, normalY = 0;
    const maxSteps = dx + dy + 1;
    let steps = 0;

    while (true) {
      const materialId = this.getMaterialId(x0, y0);
      if (materialId !== AIR_MATERIAL_ID) {
        result.hit = true;
        result.cellX = x0;
        result.cellY = y0;
        result.worldX = this.cellToWorldX(x0);
        result.worldY = this.cellToWorldY(y0);
        result.materialId = materialId;
        result.material = this.materials.get(materialId);
        result.normalX = normalX;
        result.normalY = normalY;
        result.distance = steps / this.pixelsPerUnit;
        return result;
      }
      if ((x0 === x1 && y0 === y1) || steps >= maxSteps) break;
      const e2 = 2 * err;
      normalX = 0;
      normalY = 0;
      if (e2 > -dy) { err -= dy; x0 += sx; normalX = -sx; }
      if (e2 < dx) { err += dx; y0 += sy; normalY = -sy; }
      steps++;
    }

    result.hit = false;
    result.cellX = x0;
    result.cellY = y0;
    result.worldX = this.cellToWorldX(x0);
    result.worldY = this.cellToWorldY(y0);
    result.materialId = AIR_MATERIAL_ID;
    result.material = this.materials.get(AIR_MATERIAL_ID);
    result.normalX = 0;
    result.normalY = 0;
    result.distance = steps / this.pixelsPerUnit;
    return result;
  }

  // ------------------------------------------------------------------------------------------
  // Rendering (Section 6)
  // ------------------------------------------------------------------------------------------

  /**
   * Detect and initialise the appropriate rendering backend for this environment: a 2D canvas
   * compositing path (always available wherever a canvas can be created) and, when requested
   * and a LittleJS WebGL context is present, an additional direct-to-GPU texture path. Running
   * inside Node.js (no `document`/`OffscreenCanvas`) degrades gracefully to `rendererMode = 'none'`,
   * which is exactly what the automated test-suite relies on to exercise pure simulation logic.
   * @param {GranularEngineConfig} config - The engine configuration passed to the constructor.
   * @returns {void}
   */
  _initRenderer(config) {
    /** @type {'webgl'|'canvas2d'|'none'} Active rendering backend. */
    this.rendererMode = 'none';
    /** @type {(HTMLCanvasElement|OffscreenCanvas|null)} Offscreen 2D compositing surface. */
    this._canvas = null;
    /** @type {(CanvasRenderingContext2D|null)} 2D drawing context for {@link _canvas}. */
    this._ctx2d = null;
    /** @type {(ImageData|null)} Pixel buffer backing {@link _canvas}. */
    this._imageData = null;
    /** @type {(Uint32Array|null)} Whole-pixel view over {@link _imageData}'s byte buffer. */
    this._pixelView = null;
    /** @type {(WebGLRenderingContext|null)} LittleJS's WebGL context, if the WebGL path is active. */
    this._gl = null;
    /** @type {number} Remaining camera-shake duration, undone-and-reapplied each frame. */
    this._shakeOffsetX = 0;
    /** @type {number} See {@link _shakeOffsetX}. */
    this._shakeOffsetY = 0;
    /** @type {Uint8Array} Fixed-size scratch buffer (one chunk's worth) for WebGL texture uploads. */
    this._glStagingBuffer = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 4);
    /** @type {Float32Array} Reused 4-vertex NDC position buffer for the WebGL quad draw. */
    this._glPositionScratch = new Float32Array(8);

    const hasDocument = typeof document !== 'undefined';
    const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
    if (config.canvas || hasDocument || hasOffscreenCanvas) {
      this._canvas = config.canvas || (hasOffscreenCanvas
        ? new OffscreenCanvas(this.width, this.height)
        : document.createElement('canvas'));
      if (!config.canvas) {
        this._canvas.width = this.width;
        this._canvas.height = this.height;
      }
      this._ctx2d = this._canvas.getContext && this._canvas.getContext('2d');
      if (this._ctx2d) {
        this._imageData = this._ctx2d.createImageData(this.width, this.height);
        this._pixelView = new Uint32Array(this._imageData.data.buffer);
      }
    }

    const requested = config.renderer || 'auto';
    const autoWantsWebgl = requested === 'auto' && typeof glEnable !== 'undefined' && glEnable;
    if ((requested === 'webgl' || autoWantsWebgl) && typeof glContext !== 'undefined' && glContext) {
      this._initWebglRenderer(glContext);
    }

    this.rendererMode = this._gl ? 'webgl' : (this._ctx2d ? 'canvas2d' : 'none');
  }

  /**
   * Compile the minimal self-contained shader program, texture, and geometry buffers used to
   * draw the granular display texture directly via raw WebGL calls (independent of LittleJS's
   * own internal sprite batcher, so it cannot disturb LittleJS's own draw state).
   * @param {WebGLRenderingContext} gl - LittleJS's WebGL rendering context.
   * @returns {void}
   */
  _initWebglRenderer(gl) {
    const vertexSource =
      'attribute vec2 aPosition;\nattribute vec2 aTexCoord;\nvarying vec2 vTexCoord;\n' +
      'void main() {\n  vTexCoord = aTexCoord;\n  gl_Position = vec4(aPosition, 0.0, 1.0);\n}\n';
    const fragmentSource =
      'precision mediump float;\nvarying vec2 vTexCoord;\nuniform sampler2D uTexture;\n' +
      'void main() {\n  gl_FragColor = texture2D(uTexture, vTexCoord);\n}\n';

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexSource);
    gl.compileShader(vertexShader);
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentSource);
    gl.compileShader(fragmentShader);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const positionBuffer = gl.createBuffer();
    const texCoordBuffer = gl.createBuffer();

    // LittleJS keeps its own sprite batch in the currently-bound ARRAY_BUFFER/vertex attribute
    // state and defers uploading it (via bufferSubData) until glFlush(), which runs AFTER
    // gameRenderPost() in the frame. Sharing the default vertex array object with LittleJS would
    // let our vertexAttribPointer() calls silently repoint its generic attribute slots at our
    // own tiny buffer, corrupting (or crashing) its deferred flush. A dedicated Vertex Array
    // Object fully isolates our attribute bindings, so LittleJS's own VAO state is never touched.
    let vaoExtension = null;
    let vertexArray = null;
    if (typeof gl.createVertexArray === 'function') {
      vertexArray = gl.createVertexArray();
    } else if (typeof gl.getExtension === 'function') {
      vaoExtension = gl.getExtension('OES_vertex_array_object');
      if (vaoExtension) vertexArray = vaoExtension.createVertexArrayOES();
    }
    if (!vertexArray) return; // No VAO support: skip the WebGL path rather than risk corruption.

    const positionAttrib = gl.getAttribLocation(program, 'aPosition');
    const texCoordAttrib = gl.getAttribLocation(program, 'aTexCoord');
    const bindVertexArray = vaoExtension
      ? (va) => vaoExtension.bindVertexArrayOES(va)
      : (va) => gl.bindVertexArray(va);

    bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionAttrib);
    gl.vertexAttribPointer(positionAttrib, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(texCoordAttrib);
    gl.vertexAttribPointer(texCoordAttrib, 2, gl.FLOAT, false, 0, 0);
    bindVertexArray(null);

    this._gl = gl;
    this._glProgram = program;
    this._glTexture = texture;
    this._glPositionBuffer = positionBuffer;
    this._glTexCoordBuffer = texCoordBuffer;
    this._glPositionAttrib = positionAttrib;
    this._glTexCoordAttrib = texCoordAttrib;
    this._glTextureUniform = gl.getUniformLocation(program, 'uTexture');
    this._glVertexArray = vertexArray;
    this._glVaoExtension = vaoExtension;
    this._glBindVertexArray = bindVertexArray;
    this._glVertexArrayBindingParam = vaoExtension
      ? vaoExtension.VERTEX_ARRAY_BINDING_OES : gl.VERTEX_ARRAY_BINDING;
  }

  /**
   * Upload every pending render-dirty chunk region and blit/draw the result to the LittleJS
   * canvas, then re-register dynamic lights for the current frame. A no-op when no rendering
   * backend is available (for example inside a headless Node.js test run).
   * @returns {void}
   */
  render() {
    if (this.rendererMode === 'canvas2d') {
      this._renderCanvas2d();
      this._blitCanvas2dToLittleJS();
    } else if (this.rendererMode === 'webgl') {
      this._renderWebgl();
    }
    this._collectDynamicLights();
  }

  /**
   * Recompute pixel colours for every pending render-dirty chunk region into the offscreen
   * canvas's `ImageData`, uploading each sub-rectangle individually via `putImageData`.
   * @returns {void}
   */
  _renderCanvas2d() {
    const grid = this.grid;
    const pixels = this._pixelView;
    const width = this.width, height = this.height;
    const chunks = this.chunks;
    const count = chunks.renderDirtyCount;
    for (let i = 0; i < count; i++) {
      const idx = chunks.renderDirtyList[i];
      const minX = chunks.renderDirtyMinX[idx], minY = chunks.renderDirtyMinY[idx];
      const maxX = chunks.renderDirtyMaxX[idx], maxY = chunks.renderDirtyMaxY[idx];
      for (let cy = minY; cy <= maxY; cy++) {
        const imageRow = height - 1 - cy;
        let cellIdx = grid.index(minX, cy);
        let pixelIdx = imageRow * width + minX;
        for (let cx = minX; cx <= maxX; cx++, cellIdx++, pixelIdx++) {
          const materialId = grid.currentU8[cellIdx * CELL_BYTE_SIZE + OFFSET_MATERIAL];
          pixels[pixelIdx] = materialId === AIR_MATERIAL_ID ? 0 : getCellColour(this.materials.get(materialId), cx, cy);
        }
      }
      this._ctx2d.putImageData(this._imageData, 0, 0, minX, height - 1 - maxY, maxX - minX + 1, maxY - minY + 1);
      chunks.clearRenderDirty(idx);
    }
    chunks.renderDirtyCount = 0;
  }

  /**
   * Push every pending render-dirty chunk region into the shared GPU texture via
   * `texSubImage2D`, then draw a single textured quad aligned to the LittleJS camera.
   * @returns {void}
   */
  _renderWebgl() {
    const gl = this._gl;
    const grid = this.grid;
    const chunks = this.chunks;
    const staging = this._glStagingBuffer;
    gl.bindTexture(gl.TEXTURE_2D, this._glTexture);
    const count = chunks.renderDirtyCount;
    for (let i = 0; i < count; i++) {
      const idx = chunks.renderDirtyList[i];
      const minX = chunks.renderDirtyMinX[idx], minY = chunks.renderDirtyMinY[idx];
      const maxX = chunks.renderDirtyMaxX[idx], maxY = chunks.renderDirtyMaxY[idx];
      const rectWidth = maxX - minX + 1;
      const rectHeight = maxY - minY + 1;
      let stagingOffset = 0;
      for (let cy = minY; cy <= maxY; cy++) {
        let cellIdx = grid.index(minX, cy);
        for (let cx = minX; cx <= maxX; cx++, cellIdx++) {
          const materialId = grid.currentU8[cellIdx * CELL_BYTE_SIZE + OFFSET_MATERIAL];
          const colour = materialId === AIR_MATERIAL_ID ? 0 : getCellColour(this.materials.get(materialId), cx, cy);
          staging[stagingOffset] = colour & 0xff;
          staging[stagingOffset + 1] = (colour >>> 8) & 0xff;
          staging[stagingOffset + 2] = (colour >>> 16) & 0xff;
          staging[stagingOffset + 3] = (colour >>> 24) & 0xff;
          stagingOffset += 4;
        }
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, minX, minY, rectWidth, rectHeight, gl.RGBA, gl.UNSIGNED_BYTE,
        staging.subarray(0, rectWidth * rectHeight * 4));
      chunks.clearRenderDirty(idx);
    }
    chunks.renderDirtyCount = 0;
    this._drawWebglQuad();
  }

  /**
   * Compute the on-screen rectangle covered by the simulation grid (via LittleJS's
   * `worldToScreen`, when present) and draw the granular display surface into it.
   * @returns {{sx0: number, sy0: number, sx1: number, sy1: number}} The reused scratch screen-rect object.
   */
  _computeScreenRect() {
    const worldMinX = this.originX;
    const worldMinY = this.originY;
    const worldMaxX = this.originX + this.width / this.pixelsPerUnit;
    const worldMaxY = this.originY + this.height / this.pixelsPerUnit;
    const rect = this._screenRectScratch || (this._screenRectScratch = { sx0: 0, sy0: 0, sx1: 0, sy1: 0 });
    if (typeof worldToScreen === 'function' && typeof vec2 === 'function') {
      const p0 = worldToScreen(vec2(worldMinX, worldMinY));
      const p1 = worldToScreen(vec2(worldMaxX, worldMaxY));
      rect.sx0 = Math.min(p0.x, p1.x);
      rect.sx1 = Math.max(p0.x, p1.x);
      rect.sy0 = Math.min(p0.y, p1.y);
      rect.sy1 = Math.max(p0.y, p1.y);
    } else {
      rect.sx0 = worldMinX;
      rect.sx1 = worldMaxX;
      rect.sy0 = worldMinY;
      rect.sy1 = worldMaxY;
    }
    return rect;
  }

  /**
   * Draw the offscreen 2D compositing canvas onto LittleJS's own `mainContext`, scaled and
   * positioned to align exactly with the simulation grid's world-space footprint.
   * @returns {void}
   */
  _blitCanvas2dToLittleJS() {
    if (typeof mainContext === 'undefined' || !mainContext) return;
    const rect = this._computeScreenRect();
    mainContext.drawImage(this._canvas, rect.sx0, rect.sy0, rect.sx1 - rect.sx0, rect.sy1 - rect.sy0);
  }

  /**
   * Draw the granular GPU texture as a single textured quad using our own minimal shader
   * program, positioned in normalised device coordinates derived from the current camera.
   * @returns {void}
   */
  _drawWebglQuad() {
    const gl = this._gl;
    const rect = this._computeScreenRect();
    const canvasWidth = (typeof mainCanvasSize !== 'undefined' && mainCanvasSize)
      ? mainCanvasSize.x : (this._canvas ? this._canvas.width : rect.sx1);
    const canvasHeight = (typeof mainCanvasSize !== 'undefined' && mainCanvasSize)
      ? mainCanvasSize.y : (this._canvas ? this._canvas.height : rect.sy1);

    const ndcX0 = (rect.sx0 / canvasWidth) * 2 - 1;
    const ndcX1 = (rect.sx1 / canvasWidth) * 2 - 1;
    const ndcY0 = 1 - (rect.sy0 / canvasHeight) * 2;
    const ndcY1 = 1 - (rect.sy1 / canvasHeight) * 2;

    const positions = this._glPositionScratch;
    positions[0] = ndcX0; positions[1] = ndcY1;
    positions[2] = ndcX1; positions[3] = ndcY1;
    positions[4] = ndcX0; positions[5] = ndcY0;
    positions[6] = ndcX1; positions[7] = ndcY0;

    // Save every piece of shared GL context state we are about to touch, so LittleJS's own
    // deferred sprite-batch flush (which runs later in this same frame, via glFlush()) finds
    // everything exactly as it left it.
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const previousVertexArray = gl.getParameter(this._glVertexArrayBindingParam);
    const previousActiveTextureUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);

    this._glBindVertexArray(this._glVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._glPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

    gl.useProgram(this._glProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._glTexture);
    gl.uniform1i(this._glTextureUniform, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this._glBindVertexArray(previousVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
    gl.useProgram(previousProgram);
    gl.activeTexture(previousActiveTextureUnit);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture);
  }

  /**
   * Re-register every currently-emissive cell (material `lightRadius > 0`) within an active
   * chunk as a dynamic light for this frame, via the optional `drawLight(pos, radius, colour)`
   * integration hook (Section 6.4). A no-op when the host project does not define that hook.
   * @returns {void}
   */
  _collectDynamicLights() {
    this.lightCount = 0;
    if (typeof drawLight !== 'function') return;
    const grid = this.grid;
    const chunks = this.chunks;
    const scratch = this._lightPosScratch;
    for (let i = 0; i < chunks.activeCount; i++) {
      const bounds = chunks.getChunkWorldBounds(chunks.activeList[i]);
      const minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const materialId = grid.currentU8[grid.index(x, y) * CELL_BYTE_SIZE + OFFSET_MATERIAL];
          if (materialId === AIR_MATERIAL_ID) continue;
          const def = this.materials.get(materialId);
          if (def.lightRadius <= 0 || this.lightCount >= this.maxLights) continue;
          const worldX = this.cellToWorldX(x);
          const worldY = this.cellToWorldY(y);
          this.lightX[this.lightCount] = worldX;
          this.lightY[this.lightCount] = worldY;
          this.lightRadius[this.lightCount] = def.lightRadius;
          this.lightColour[this.lightCount] = def.emissiveColour;
          this.lightCount++;
          scratch.x = worldX;
          scratch.y = worldY;
          drawLight(scratch, def.lightRadius, def.emissiveColour);
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Binary state serialisation (Section 7)
  // ------------------------------------------------------------------------------------------

  /**
   * Compress the current grid buffer into a compact Run-Length Encoded binary stream. This is a
   * one-shot administrative operation (save/export), not part of the per-frame hot path, so it
   * is permitted (and does) allocate its result and a small amount of working memory.
   * @returns {Uint8Array} The serialised RLE byte stream (16-byte header + packed runs).
   */
  serializeGrid() {
    const grid = this.grid;
    const totalCells = grid.totalCells;
    const runs = [];
    let i = 0;
    while (i < totalCells) {
      const base = i * CELL_BYTE_SIZE;
      const material = grid.currentU8[base + OFFSET_MATERIAL];
      const life = grid.currentU8[base + OFFSET_LIFE];
      const vx = grid.currentU8[base + OFFSET_VX];
      const flags = grid.currentU8[base + OFFSET_FLAGS];
      let runLength = 1;
      while (i + runLength < totalCells && runLength < 255) {
        const nextBase = (i + runLength) * CELL_BYTE_SIZE;
        if (grid.currentU8[nextBase + OFFSET_MATERIAL] !== material ||
            grid.currentU8[nextBase + OFFSET_LIFE] !== life ||
            grid.currentU8[nextBase + OFFSET_VX] !== vx ||
            grid.currentU8[nextBase + OFFSET_FLAGS] !== flags) break;
        runLength++;
      }
      runs.push(runLength, material, life, vx, flags);
      i += runLength;
    }

    const totalRuns = runs.length / 5;
    const output = new Uint8Array(16 + totalRuns * 5);
    const view = new DataView(output.buffer);
    view.setUint8(0, 0x4c); // 'L'
    view.setUint8(1, 0x4a); // 'J'
    view.setUint8(2, 0x43); // 'C'
    view.setUint8(3, 0x41); // 'A'
    view.setUint16(4, 1, true);
    view.setUint16(6, this.width, true);
    view.setUint16(8, this.height, true);
    view.setUint16(10, this.pixelsPerUnit, true);
    view.setUint32(12, totalRuns, true);
    let offset = 16;
    for (let r = 0; r < runs.length; r += 5) {
      output[offset] = runs[r];
      output[offset + 1] = runs[r + 1];
      output[offset + 2] = runs[r + 2];
      output[offset + 3] = runs[r + 3];
      output[offset + 4] = runs[r + 4];
      offset += 5;
    }
    return output;
  }

  /**
   * Restore the grid buffer from an RLE-compressed binary stream produced by
   * {@link GranularEngine#serializeGrid}, resizing the simulation if the stored dimensions
   * differ, waking every chunk, and re-initialising both halves of the double buffer.
   * @param {Uint8Array} data - The serialised RLE byte stream.
   * @returns {boolean} True on success; false if the stream is malformed or truncated.
   */
  deserializeGrid(data) {
    if (!data || data.length < 16) return false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint8(0) !== 0x4c || view.getUint8(1) !== 0x4a ||
        view.getUint8(2) !== 0x43 || view.getUint8(3) !== 0x41) return false;
    if (view.getUint16(4, true) !== 1) return false;

    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    const pixelsPerUnit = view.getUint16(10, true);
    const totalRuns = view.getUint32(12, true);

    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.grid = new GranularGridBuffer(width, height);
      this.chunks = new ChunkManager(width, height, CHUNK_SIZE);
    }
    if (pixelsPerUnit > 0) this.pixelsPerUnit = pixelsPerUnit;

    const grid = this.grid;
    const clearTransientFlags = ~(FLAG_UPDATED | FLAG_SLEEPING) & 0xff;
    let offset = 16;
    let cellIndex = 0;
    for (let r = 0; r < totalRuns; r++) {
      if (offset + 5 > data.length) return false;
      const repeatCount = data[offset];
      const material = data[offset + 1];
      const life = data[offset + 2];
      const vx = data[offset + 3];
      const flags = data[offset + 4] & clearTransientFlags;
      offset += 5;
      for (let k = 0; k < repeatCount; k++) {
        if (cellIndex >= grid.totalCells) return false;
        const base = cellIndex * CELL_BYTE_SIZE;
        grid.currentU8[base + OFFSET_MATERIAL] = material;
        grid.currentU8[base + OFFSET_LIFE] = life;
        grid.currentU8[base + OFFSET_VX] = vx;
        grid.currentU8[base + OFFSET_FLAGS] = flags;
        cellIndex++;
      }
    }
    grid.nextU32.set(grid.currentU32);
    this.simulationFrame = 0;

    for (let i = 0; i < this.chunks.totalChunks; i++) this.chunks.activate(i);
    this.chunks.justWokenCount = 0;
    this.chunks.justSleptCount = 0;
    for (let i = 0; i < this.chunks.totalChunks; i++) this.chunks.sleepCounter[i] = 0;

    return true;
  }
}

// ============================================================================================
// Section 10: LittleJS EngineObject Collision Bridge
// ============================================================================================

/**
 * @typedef {Object} EngineObjectLike
 * A minimal duck-typed shape compatible with a LittleJS `EngineObject`: any object exposing
 * `pos`/`size`/`velocity` vector-like fields (each with numeric `x`/`y`) plus a mutable
 * `groundObject` reference.
 * @property {{x: number, y: number}} pos - World-space centre position.
 * @property {{x: number, y: number}} size - World-space axis-aligned bounding box dimensions.
 * @property {{x: number, y: number}} velocity - Per-frame velocity, mutated in place.
 * @property {*} groundObject - Set to a stand-in ground reference when resting on solid terrain.
 */

/**
 * A frozen, zero-velocity, zero-allocation stand-in assigned to `entity.groundObject` on solid
 * contact. Real LittleJS `EngineObject` instances expect `groundObject` (when truthy) to be an
 * object exposing `velocity` and `friction` - it is normally another EngineObject or tile layer
 * a character stands on, used internally to inherit a moving platform's velocity. Our granular
 * terrain has no single coherent rigid-body velocity to expose, so this stationary sentinel
 * satisfies that contract safely (LittleJS's own internal friction step sees a stationary,
 * default-friction surface) without allocating a fresh object every contact frame.
 * @type {{velocity: {x: number, y: number}, friction: number}}
 */
const STATIC_GROUND_STANDIN = Object.freeze({ velocity: Object.freeze({ x: 0, y: 0 }), friction: 1 });

/** @type {number} Maximum number of cell rows {@link pushEntityOutOfSolidGround} will scan upward. */
const MAX_GROUND_PUSH_CELLS = 32;

/**
 * Push an entity's position straight up out of any solid terrain its feet have sunk into this
 * frame. Cancelling velocity on contact is not enough on its own: LittleJS's own physics step
 * re-introduces a small downward velocity from gravity every frame before
 * {@link GranularPhysicsBridge.resolveEntityCollision} gets a chance to zero it again, and that
 * velocity has already moved the entity's position for the frame by the time contact is
 * detected. Left uncorrected, a "grounded" entity creeps downward by one gravity-step every
 * single frame forever, eventually sinking through solid terrain entirely.
 * @param {GranularEngine} engine - The active granular engine.
 * @param {EngineObjectLike} entity - The entity to reposition.
 * @param {number} minCellX - Left edge of the entity's footprint, in grid cells.
 * @param {number} maxCellX - Right edge of the entity's footprint, in grid cells.
 * @param {number} halfHeight - Half the entity's world-space height.
 * @returns {void}
 */
function pushEntityOutOfSolidGround(engine, entity, minCellX, maxCellX, halfHeight) {
  let cellY = engine.worldToCellY(entity.pos.y - halfHeight);
  let highestSolidRow = -1;
  for (let scanned = 0; scanned < MAX_GROUND_PUSH_CELLS; scanned++) {
    let rowIsSolid = false;
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      const materialId = engine.getMaterialId(cx, cellY);
      if (materialId === AIR_MATERIAL_ID) continue;
      const archetype = engine.materials.get(materialId).archetype;
      if (archetype === Archetype.IMMOVABLE_SOLID || archetype === Archetype.FALLING_SOLID) {
        rowIsSolid = true;
        break;
      }
    }
    if (!rowIsSolid) break;
    highestSolidRow = cellY;
    cellY++;
  }
  if (highestSolidRow !== -1) {
    entity.pos.y = engine.cellToWorldY(highestSolidRow) + 0.5 / engine.pixelsPerUnit + halfHeight;
  }
}

/**
 * Provides full physical interaction between LittleJS physics objects and the granular
 * terrain: ground support with lateral friction, and Archimedes fluid buoyancy with viscous
 * drag while submerged. Every field access mutates the entity's own existing `velocity` vector
 * in place; no vectors or objects are allocated.
 */
export class GranularPhysicsBridge {
  /**
   * Test and resolve collision for a LittleJS `EngineObject`-like entity against the active
   * {@link granularEngine} grid.
   * @param {EngineObjectLike} entity - The entity to resolve collision for.
   * @returns {void}
   */
  static resolveEntityCollision(entity) {
    if (!granularEngine || !entity || !entity.pos || !entity.size || !entity.velocity) return;
    const engine = granularEngine;
    const halfWidth = entity.size.x * 0.5;
    const halfHeight = entity.size.y * 0.5;
    const minCellX = engine.worldToCellX(entity.pos.x - halfWidth);
    const maxCellX = engine.worldToCellX(entity.pos.x + halfWidth);
    const minCellY = engine.worldToCellY(entity.pos.y - halfHeight);
    const maxCellY = engine.worldToCellY(entity.pos.y + halfHeight);

    let solidContacts = 0;
    let liquidContacts = 0;
    let totalLiquidDensity = 0;

    for (let cy = minCellY; cy <= maxCellY; cy++) {
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        const materialId = engine.getMaterialId(cx, cy);
        if (materialId === AIR_MATERIAL_ID) continue;
        const def = engine.materials.get(materialId);
        if (def.archetype === Archetype.IMMOVABLE_SOLID || def.archetype === Archetype.FALLING_SOLID) {
          solidContacts++;
        } else if (def.archetype === Archetype.SLIDING_LIQUID) {
          liquidContacts++;
          totalLiquidDensity += def.density;
        }
      }
    }

    if (solidContacts > 0) {
      entity.groundObject = STATIC_GROUND_STANDIN;
      if (entity.velocity.y < 0) entity.velocity.y = 0;
      entity.velocity.x *= 0.85;
      pushEntityOutOfSolidGround(engine, entity, minCellX, maxCellX, halfHeight);
    }

    const totalSampledCells = (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1);
    if (liquidContacts > 0 && totalSampledCells > 0) {
      const immersionRatio = liquidContacts / totalSampledCells;
      const avgDensity = totalLiquidDensity / liquidContacts;
      const entityDensity = 1000;
      const buoyancyAcceleration = 0.02 * (avgDensity / entityDensity) * immersionRatio;
      entity.velocity.y += buoyancyAcceleration;
      entity.velocity.x *= (1 - 0.15 * immersionRatio);
      entity.velocity.y *= (1 - 0.15 * immersionRatio);
    }
  }
}

// ============================================================================================
// Section 11: Module Singleton & Public Free-Function API
// ============================================================================================

/**
 * The active {@link GranularEngine} instance created by the most recent {@link initGranularEngine}
 * call, or `null` before initialisation. Exported as a live binding: consumers that `import`
 * this value always observe its current state.
 * @type {GranularEngine|null}
 */
export let granularEngine = null;

/**
 * Initialise the granular simulation: allocate memory buffers, initialise the chunk hierarchy,
 * register the default material library and reaction matrix, and initialise the rendering
 * backend. Call once during game setup, before the first {@link updateGranularEngine} call.
 * @param {GranularEngineConfig} config - Simulation configuration.
 * @returns {GranularEngine} The newly created (and now active) engine instance.
 */
export function initGranularEngine(config) {
  granularEngine = new GranularEngine(config);
  return granularEngine;
}

/**
 * Advance the cellular automata simulation by its configured number of sub-steps. Intended to
 * be called once per fixed update tick (for example from LittleJS's `gameUpdate`).
 * @returns {void}
 */
export function updateGranularEngine() {
  if (granularEngine) granularEngine.update();
}

/**
 * Upload dirty chunk regions and draw the granular terrain, aligned with the LittleJS camera.
 * Intended to be called once per render (for example from LittleJS's `gameRenderPost`).
 * @returns {void}
 */
export function renderGranularEngine() {
  if (granularEngine) granularEngine.render();
}

/**
 * Register a custom material definition on the active engine.
 * @param {object} config - See {@link MaterialDefinition} for the full configuration shape.
 * @returns {number} The registered material's identifier.
 */
export function registerMaterial(config) {
  if (!granularEngine) throw new Error('LittleAutomata: call initGranularEngine() before registerMaterial().');
  return granularEngine.materials.register(config);
}

/**
 * Register a custom material interaction rule on the active engine's reaction matrix.
 * @param {number} actorId - The initiating material's identifier.
 * @param {number} targetId - The neighbouring material's identifier.
 * @param {number} yieldActor - Material the actor cell becomes if the reaction triggers.
 * @param {number} yieldTarget - Material the target cell becomes if the reaction triggers.
 * @param {number} probability - Chance of the reaction triggering per encounter, 0.0-1.0.
 * @param {number} [yieldLife=0] - Lifetime assigned to the resulting cells.
 * @returns {void}
 */
export function registerReaction(actorId, targetId, yieldActor, yieldTarget, probability, yieldLife = 0) {
  if (!granularEngine) throw new Error('LittleAutomata: call initGranularEngine() before registerReaction().');
  granularEngine.reactions.register(actorId, targetId, yieldActor, yieldTarget, probability, yieldLife);
}

/**
 * Draw a filled circle of a given material into the world.
 * @param {number} worldX - World-space X coordinate of the circle centre.
 * @param {number} worldY - World-space Y coordinate of the circle centre.
 * @param {number} radiusWorld - Circle radius, in LittleJS world units.
 * @param {number} materialId - Material identifier to paint.
 * @returns {void}
 */
export function paintCircle(worldX, worldY, radiusWorld, materialId) {
  if (granularEngine) granularEngine.paintCircle(worldX, worldY, radiusWorld, materialId);
}

/**
 * Sweep a solid line brush between two world-space points.
 * @param {number} startX - World-space X coordinate of the line start.
 * @param {number} startY - World-space Y coordinate of the line start.
 * @param {number} endX - World-space X coordinate of the line end.
 * @param {number} endY - World-space Y coordinate of the line end.
 * @param {number} radiusWorld - Brush radius, in LittleJS world units.
 * @param {number} materialId - Material identifier to paint.
 * @returns {void}
 */
export function paintLine(startX, startY, endX, endY, radiusWorld, materialId) {
  if (granularEngine) granularEngine.paintLine(startX, startY, endX, endY, radiusWorld, materialId);
}

/**
 * Trigger an explosion that destroys terrain, pushes rigid bodies, throws molten embers, and
 * triggers a LittleJS screen shake.
 * @param {number} worldX - World-space X coordinate of the explosion centre.
 * @param {number} worldY - World-space Y coordinate of the explosion centre.
 * @param {number} radiusWorld - Blast radius, in LittleJS world units.
 * @param {number} [power=1.0] - Explosive power.
 * @returns {void}
 */
export function createExplosion(worldX, worldY, radiusWorld, power = 1.0) {
  if (granularEngine) granularEngine.createExplosion(worldX, worldY, radiusWorld, power);
}

/**
 * Sample material definition and cell state at a specific world coordinate.
 * @param {number} worldX - World-space X coordinate to sample.
 * @param {number} worldY - World-space Y coordinate to sample.
 * @returns {?object} The reused sample result, or `null` if no engine is active.
 */
export function sampleWorld(worldX, worldY) {
  return granularEngine ? granularEngine.sampleWorld(worldX, worldY) : null;
}

/**
 * Raycast through the granular grid, returning the first hit cell and surface normal.
 * @param {number} startX - World-space X coordinate of the ray origin.
 * @param {number} startY - World-space Y coordinate of the ray origin.
 * @param {number} endX - World-space X coordinate of the ray's far end.
 * @param {number} endY - World-space Y coordinate of the ray's far end.
 * @returns {?object} The reused raycast result, or `null` if no engine is active.
 */
export function raycastWorld(startX, startY, endX, endY) {
  return granularEngine ? granularEngine.raycastWorld(startX, startY, endX, endY) : null;
}

/**
 * Compress the active engine's grid buffer into a compact binary `Uint8Array` using lossless
 * Run-Length Encoding.
 * @returns {Uint8Array} The serialised RLE byte stream.
 */
export function serializeGrid() {
  if (!granularEngine) throw new Error('LittleAutomata: call initGranularEngine() before serializeGrid().');
  return granularEngine.serializeGrid();
}

/**
 * Restore the grid buffer from an RLE-compressed binary stream, waking all active chunks and
 * re-initialising the display buffer. If no engine has been initialised yet, a minimal default
 * engine is created first so that loading a save file can serve as an alternative entry point.
 * @param {Uint8Array} data - The serialised RLE byte stream.
 * @returns {boolean} Success status.
 */
export function deserializeGrid(data) {
  if (!granularEngine) granularEngine = new GranularEngine({ gridWidth: 1, gridHeight: 1 });
  return granularEngine.deserializeGrid(data);
}

/**
 * @param {number} worldX - LittleJS world-space X coordinate.
 * @returns {number} The corresponding grid cell X coordinate (0 if no engine is active).
 */
export function worldToCellX(worldX) {
  return granularEngine ? granularEngine.worldToCellX(worldX) : 0;
}

/**
 * @param {number} worldY - LittleJS world-space Y coordinate.
 * @returns {number} The corresponding grid cell Y coordinate (0 if no engine is active).
 */
export function worldToCellY(worldY) {
  return granularEngine ? granularEngine.worldToCellY(worldY) : 0;
}

/**
 * @param {number} cellX - Grid cell X coordinate.
 * @returns {number} The world-space X coordinate of the cell's centre (0 if no engine is active).
 */
export function cellToWorldX(cellX) {
  return granularEngine ? granularEngine.cellToWorldX(cellX) : 0;
}

/**
 * @param {number} cellY - Grid cell Y coordinate.
 * @returns {number} The world-space Y coordinate of the cell's centre (0 if no engine is active).
 */
export function cellToWorldY(cellY) {
  return granularEngine ? granularEngine.cellToWorldY(cellY) : 0;
}

// ============================================================================================
// Section 12: Classic Global Namespace (optional convenience for non-bundler <script> usage)
// ============================================================================================

if (typeof window !== 'undefined') {
  window.LittleAutomata = {
    CELL_BYTE_SIZE, OFFSET_MATERIAL, OFFSET_LIFE, OFFSET_VX, OFFSET_FLAGS,
    FLAG_UPDATED, FLAG_SLEEPING, MASK_VARIANT, VARIANT_SHIFT, MAX_VARIANT,
    AIR_MATERIAL_ID, MAX_MATERIALS, CHUNK_SIZE, DEFAULT_TERMINAL_VELOCITY, DEFAULT_PIXELS_PER_UNIT,
    EXPLOSION_HARDNESS_DIVISOR, Archetype, MaterialId,
    seedRandom, packColourRGBA, normaliseColourToAbgr, getCellColour,
    GranularGridBuffer, ChunkManager, MaterialDefinition, MaterialRegistry, ReactionMatrix,
    registerDefaultMaterials, registerDefaultReactions,
    GranularEngine, GranularPhysicsBridge,
    initGranularEngine, updateGranularEngine, renderGranularEngine,
    registerMaterial, registerReaction,
    paintCircle, paintLine, createExplosion, sampleWorld, raycastWorld,
    serializeGrid, deserializeGrid,
    worldToCellX, worldToCellY, cellToWorldX, cellToWorldY,
    get granularEngine() { return granularEngine; }
  };
}
