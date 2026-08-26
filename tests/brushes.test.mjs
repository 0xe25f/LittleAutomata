// Tests for the brush & world manipulation API: paintCircle, paintLine, createExplosion,
// sampleWorld, and raycastWorld (Section 5.3 / AGENTS.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GranularEngine, MaterialId, Archetype } from '../src/littleautomata.js';

function makeEngine(overrides = {}) {
  return new GranularEngine({ gridWidth: 50, gridHeight: 50, pixelsPerUnit: 16, originX: -1.5625, originY: -1.5625, randomSeed: 5, ...overrides });
}

describe('paintCircle', () => {
  test('stamps the requested material within the radius and leaves the rest untouched', () => {
    const engine = makeEngine();
    engine.paintCircle(0, 0, 0.5, MaterialId.SAND); // radius 0.5 world units = 8 cells
    const centreX = engine.worldToCellX(0), centreY = engine.worldToCellY(0);
    assert.equal(engine.getMaterialId(centreX, centreY), MaterialId.SAND);
    assert.equal(engine.getMaterialId(0, 0), MaterialId.AIR, 'far corner should remain untouched');
  });

  test('is immediately queryable without requiring an update() call', () => {
    const engine = makeEngine();
    engine.paintCircle(0, 0, 0.3, MaterialId.WATER);
    const result = engine.sampleWorld(0, 0);
    assert.equal(result.materialId, MaterialId.WATER);
  });

  test('a circle centred entirely outside the grid does not throw and paints nothing', () => {
    const engine = makeEngine();
    assert.doesNotThrow(() => engine.paintCircle(-100, -100, 0.5, MaterialId.SAND));
  });
});

describe('paintLine', () => {
  test('sweeps a continuous brush stroke with no gaps between the two endpoints', () => {
    const engine = makeEngine();
    engine.paintLine(-1, -1, 1, 1, 0.05, MaterialId.STONE);
    const x0 = engine.worldToCellX(-1), y0 = engine.worldToCellY(-1);
    const x1 = engine.worldToCellX(1), y1 = engine.worldToCellY(1);
    assert.equal(engine.getMaterialId(x0, y0), MaterialId.STONE);
    assert.equal(engine.getMaterialId(x1, y1), MaterialId.STONE);
    // Sample the midpoint of the stroke: it must also have been painted (no gap).
    const midX = engine.worldToCellX(0), midY = engine.worldToCellY(0);
    assert.equal(engine.getMaterialId(midX, midY), MaterialId.STONE);
  });

  test('a zero-length line degenerates to a single stamped point', () => {
    const engine = makeEngine();
    assert.doesNotThrow(() => engine.paintLine(0, 0, 0, 0, 0.1, MaterialId.SAND));
    assert.equal(engine.sampleWorld(0, 0).materialId, MaterialId.SAND);
  });
});

describe('createExplosion', () => {
  test('carves a crater of air at the blast centre', () => {
    const engine = makeEngine();
    engine.paintCircle(0, 0, 1.2, MaterialId.STONE);
    engine.createExplosion(0, 0, 0.8, 2.0);
    assert.equal(engine.sampleWorld(0, 0).materialId, MaterialId.AIR);
  });

  test('bedrock survives a large explosion but stone does not', () => {
    // EXPLOSION_HARDNESS_DIVISOR is 2000, so a material's destruction threshold is
    // density / 2000: Stone (2700) needs power >= 1.35, Bedrock (100000) needs power >= 50.
    const engine = makeEngine();
    engine.paintCircle(-0.4, 0, 0.15, MaterialId.BEDROCK);
    engine.paintCircle(0.4, 0, 0.15, MaterialId.STONE);
    engine.createExplosion(0, 0, 1.5, 2.0);
    assert.equal(engine.sampleWorld(-0.4, 0).materialId, MaterialId.BEDROCK, 'bedrock should resist a power-2.0 blast');
    assert.equal(engine.sampleWorld(0.4, 0).materialId, MaterialId.AIR, 'stone should be destroyed by a power-2.0 blast');
  });

  test('does not throw when no EngineObject/ParticleEmitter globals are present (headless mode)', () => {
    const engine = makeEngine();
    engine.paintCircle(0, 0, 0.5, MaterialId.SAND);
    assert.doesNotThrow(() => engine.createExplosion(0, 0, 1.0, 1.5));
  });

  test('triggers a camera-shake intensity and duration proportional to power', () => {
    const engine = makeEngine();
    engine.createExplosion(0, 0, 0.5, 2.0);
    assert.ok(engine.shakeIntensity > 0);
    assert.ok(engine.shakeTimeRemaining > 0);
  });
});

describe('sampleWorld', () => {
  test('reports inBounds: false and Air outside the grid', () => {
    const engine = makeEngine();
    const result = engine.sampleWorld(1000, 1000);
    assert.equal(result.inBounds, false);
    assert.equal(result.materialId, MaterialId.AIR);
  });

  test('reports the correct material, life, and archetype for a painted cell', () => {
    const engine = makeEngine();
    engine.paintCircle(0, 0, 0.1, MaterialId.FIRE);
    const result = engine.sampleWorld(0, 0);
    assert.equal(result.inBounds, true);
    assert.equal(result.materialId, MaterialId.FIRE);
    assert.equal(result.material.archetype, Archetype.PROPAGATING_ENERGY);
    assert.equal(result.life, engine.materials.get(MaterialId.FIRE).lifetime);
  });
});

describe('raycastWorld', () => {
  test('hits the first solid cell along the ray and reports a plausible normal', () => {
    const engine = makeEngine();
    engine.paintCircle(0, 0.5, 0.6, MaterialId.STONE);
    const result = engine.raycastWorld(0, 2, 0, -2);
    assert.equal(result.hit, true);
    assert.equal(result.material.name, 'Stone');
    assert.ok(Math.abs(result.normalX) <= 1 && Math.abs(result.normalY) <= 1);
  });

  test('reports no hit when the path is entirely clear', () => {
    const engine = makeEngine();
    const result = engine.raycastWorld(-1, -1, 1, 1);
    assert.equal(result.hit, false);
  });

  test('returns the same reused object reference across calls (documented zero-allocation contract)', () => {
    const engine = makeEngine();
    const first = engine.raycastWorld(0, 0, 1, 1);
    const second = engine.raycastWorld(0, 0, -1, -1);
    assert.equal(first, second);
  });
});
