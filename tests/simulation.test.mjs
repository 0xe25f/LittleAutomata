// Functional simulation tests covering the archetype step algorithms (Section 4 of
// littleautomata.js): falling solids, sliding liquids, rising gases, propagating energy,
// lifetime decay, reactions, chunk sleep, and deterministic reproducibility.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GranularEngine, MaterialId, Archetype, OFFSET_MATERIAL, CELL_BYTE_SIZE
} from '../src/littleautomata.js';

/** @returns {GranularEngine} A small, deterministic engine for fast, isolated tests. */
function makeEngine(overrides = {}) {
  return new GranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16, randomSeed: 1234, ...overrides });
}

/**
 * @param {GranularEngine} engine
 * @param {number} materialId
 * @returns {Array<[number, number]>} Every [x, y] cell coordinate currently holding `materialId`.
 */
function findAll(engine, materialId) {
  const found = [];
  const u8 = engine.grid.currentU8;
  for (let y = 0; y < engine.height; y++) {
    for (let x = 0; x < engine.width; x++) {
      if (u8[engine.grid.index(x, y) * CELL_BYTE_SIZE + OFFSET_MATERIAL] === materialId) found.push([x, y]);
    }
  }
  return found;
}

describe('falling solid archetype', () => {
  test('sand falls straight down through open air onto a solid floor and settles', () => {
    const engine = makeEngine();
    // A floor several cells wide: a single floor cell would let sand roll off either diagonal
    // edge into the open air beside it instead of coming to rest directly above.
    for (let x = 15; x <= 25; x++) engine._paintCellMaterial(x, 5, MaterialId.STONE);
    engine._paintCellMaterial(20, 30, MaterialId.SAND); // Sand dropped high above it.
    for (let i = 0; i < 200; i++) engine.update();
    const sandPositions = findAll(engine, MaterialId.SAND);
    assert.equal(sandPositions.length, 1, 'sand mass must be conserved');
    assert.equal(sandPositions[0][0], 20);
    assert.equal(sandPositions[0][1], 6, 'sand should rest exactly on top of the floor');
  });

  test('a tall narrow sand column collapses into a wider pile (angle of repose)', () => {
    const engine = makeEngine({ gridWidth: 60, gridHeight: 60, randomSeed: 99 });
    for (let x = 29; x <= 31; x++) {
      engine._paintCellMaterial(x, 0, MaterialId.STONE);
    }
    for (let y = 1; y <= 40; y++) engine._paintCellMaterial(30, y, MaterialId.SAND);
    const initialCount = findAll(engine, MaterialId.SAND).length;
    for (let i = 0; i < 400; i++) engine.update();
    const finalPositions = findAll(engine, MaterialId.SAND);
    assert.equal(finalPositions.length, initialCount, 'sand mass must be conserved while settling');
    const xs = finalPositions.map(p => p[0]);
    const spread = Math.max(...xs) - Math.min(...xs);
    assert.ok(spread > 4, `settled pile should spread wider than its 3-cell source column (spread=${spread})`);
  });

  test('sand never falls through a solid floor (no tunnelling)', () => {
    const engine = makeEngine();
    for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, 3, MaterialId.STONE);
    engine._paintCellMaterial(20, 39, MaterialId.SAND);
    for (let i = 0; i < 300; i++) engine.update();
    const [sand] = findAll(engine, MaterialId.SAND);
    assert.ok(sand[1] >= 4, 'sand must rest above the floor row, never inside or below it');
  });

  test('a settled sand pile eventually puts its chunks to sleep', () => {
    const engine = makeEngine();
    engine._paintCellMaterial(20, 5, MaterialId.STONE);
    engine._paintCellMaterial(20, 10, MaterialId.SAND);
    for (let i = 0; i < 500; i++) engine.update();
    assert.equal(engine.chunks.activeCount, 0, 'a fully settled world should have zero active chunks');
  });
});

describe('sliding liquid archetype', () => {
  test('water conserves its cell count while falling and dispersing', () => {
    const engine = makeEngine({ gridWidth: 60, gridHeight: 40 });
    for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, 2, MaterialId.STONE);
    engine._stampCircle(30, 30, 3, MaterialId.WATER);
    const initialCount = findAll(engine, MaterialId.WATER).length;
    for (let i = 0; i < 150; i++) engine.update();
    assert.equal(findAll(engine, MaterialId.WATER).length, initialCount);
  });

  test('water spreads laterally across a floor far wider than its initial footprint', () => {
    const engine = makeEngine({ gridWidth: 60, gridHeight: 40 });
    for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, 2, MaterialId.STONE);
    engine._stampCircle(30, 30, 3, MaterialId.WATER);
    for (let i = 0; i < 150; i++) engine.update();
    const positions = findAll(engine, MaterialId.WATER);
    const xs = positions.map(p => p[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 10, 'water should have flowed well beyond a 6-cell-wide puddle');
  });

  test('oil (lower density) floats on top of water (higher density)', () => {
    const engine = makeEngine({ gridWidth: 40, gridHeight: 60, randomSeed: 55 });
    for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, 2, MaterialId.STONE);
    for (let y = 3; y < 20; y++) for (let x = 5; x < 35; x++) engine._paintCellMaterial(x, y, MaterialId.WATER);
    for (let x = 15; x < 25; x++) engine._paintCellMaterial(x, 22, MaterialId.OIL);
    for (let i = 0; i < 200; i++) engine.update();
    const waterMaxY = Math.max(...findAll(engine, MaterialId.WATER).map(p => p[1]));
    const oilMinY = Math.min(...findAll(engine, MaterialId.OIL).map(p => p[1]));
    assert.ok(oilMinY >= waterMaxY, 'oil should settle at or above the water surface, never sink below it');
  });
});

describe('rising gas archetype', () => {
  test('smoke rises through open air', () => {
    const engine = makeEngine();
    engine._paintCellMaterial(20, 5, MaterialId.SMOKE);
    for (let i = 0; i < 10; i++) engine.update();
    const [smoke] = findAll(engine, MaterialId.SMOKE);
    assert.ok(smoke[1] > 5, 'smoke should have risen above its starting row');
  });

  test('smoke decays into air once its lifetime elapses', () => {
    const engine = makeEngine({ gridHeight: 200, gridWidth: 20 });
    engine._paintCellMaterial(10, 5, MaterialId.SMOKE);
    const smokeLifetime = engine.materials.get(MaterialId.SMOKE).lifetime;
    for (let i = 0; i < smokeLifetime + 5; i++) engine.update();
    assert.equal(findAll(engine, MaterialId.SMOKE).length, 0, 'smoke must have fully decayed away by now');
  });

  test('a lighter gas swaps upward through a denser liquid column above it', () => {
    const engine = makeEngine({ gridWidth: 20, gridHeight: 40 });
    for (let y = 10; y < 30; y++) engine._paintCellMaterial(10, y, MaterialId.WATER);
    engine._paintCellMaterial(10, 9, MaterialId.SMOKE);
    for (let i = 0; i < 60; i++) engine.update();
    const smokePositions = findAll(engine, MaterialId.SMOKE);
    assert.ok(smokePositions.length > 0, 'smoke must still exist (not destroyed)');
    assert.ok(smokePositions.some(p => p[1] > 20), 'smoke should have bubbled up through the water column');
  });
});

describe('propagating energy archetype (fire)', () => {
  test('fire decays into smoke once its lifetime elapses', () => {
    const engine = makeEngine({ gridHeight: 200, gridWidth: 20 });
    engine._paintCellMaterial(10, 5, MaterialId.FIRE);
    const fireLifetime = engine.materials.get(MaterialId.FIRE).lifetime;
    for (let i = 0; i < fireLifetime + 2; i++) engine.update();
    assert.equal(findAll(engine, MaterialId.FIRE).length, 0);
    assert.ok(findAll(engine, MaterialId.SMOKE).length > 0, 'fire should have decayed into smoke, not vanished');
  });

  test('fire spreads to adjacent flammable oil', () => {
    const engine = makeEngine({ randomSeed: 2 });
    engine._paintCellMaterial(20, 20, MaterialId.OIL);
    engine._paintCellMaterial(21, 20, MaterialId.FIRE);
    let ignited = false;
    for (let i = 0; i < 40 && !ignited; i++) {
      engine.update();
      ignited = findAll(engine, MaterialId.FIRE).some(([x, y]) => x === 20 && y === 20);
    }
    assert.ok(ignited, 'oil adjacent to fire should eventually ignite');
  });
});

describe('reactions', () => {
  test('fire touching water is extinguished into air, producing smoke', () => {
    const engine = makeEngine();
    engine._paintCellMaterial(20, 20, MaterialId.WATER);
    engine._paintCellMaterial(21, 20, MaterialId.FIRE);
    engine.update();
    const fireMat = engine.getMaterialId(21, 20);
    assert.notEqual(fireMat, MaterialId.FIRE, 'the fire cell should have been consumed by the reaction');
  });

  test('acid dissolves stone into smoke and air over repeated exposure', () => {
    const engine = makeEngine({ randomSeed: 3 });
    engine._paintCellMaterial(20, 20, MaterialId.STONE);
    engine._paintCellMaterial(20, 21, MaterialId.ACID);
    engine._paintCellMaterial(19, 20, MaterialId.ACID);
    engine._paintCellMaterial(21, 20, MaterialId.ACID);
    engine._paintCellMaterial(20, 19, MaterialId.ACID);
    let dissolved = false;
    for (let i = 0; i < 500 && !dissolved; i++) {
      engine.update();
      dissolved = engine.getMaterialId(20, 20) !== MaterialId.STONE;
    }
    assert.ok(dissolved, 'stone surrounded by acid should eventually dissolve');
  });
});

describe('deterministic reproducibility', () => {
  test('two engines with the same seed and the same operations reach an identical final state', () => {
    /** @param {GranularEngine} engine */
    function scenario(engine) {
      for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, 2, MaterialId.STONE);
      engine._stampCircle(20, 30, 5, MaterialId.SAND);
      engine._stampCircle(10, 25, 4, MaterialId.WATER);
      engine._paintCellMaterial(30, 20, MaterialId.FIRE);
      engine._paintCellMaterial(31, 20, MaterialId.OIL);
      for (let i = 0; i < 120; i++) engine.update();
    }

    // The internal RNG is a single shared module-level stream (by design, so any code path can
    // draw from it deterministically without threading a generator instance everywhere). That
    // means each engine's full construct-then-run lifecycle must complete before the next one's
    // seed takes effect: constructing engineB before running engineA's scenario would reset the
    // stream, but then engineA's scenario would immediately consume it away from under engineB.
    const engineA = makeEngine({ gridWidth: 50, gridHeight: 50, randomSeed: 777 });
    scenario(engineA);
    const finalA = Array.from(engineA.grid.currentU32);

    const engineB = makeEngine({ gridWidth: 50, gridHeight: 50, randomSeed: 777 });
    scenario(engineB);
    const finalB = Array.from(engineB.grid.currentU32);

    assert.deepEqual(finalA, finalB);
  });
});
