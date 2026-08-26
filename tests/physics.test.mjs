// Tests for GranularPhysicsBridge.resolveEntityCollision (Section 5.2 of AGENTS.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GranularEngine, GranularPhysicsBridge, MaterialId, initGranularEngine
} from '../src/littleautomata.js';

/** @returns {{pos: {x:number,y:number}, size:{x:number,y:number}, velocity:{x:number,y:number}, groundObject:boolean}} */
function makeEntity(x, y, size = 0.3) {
  return { pos: { x, y }, size: { x: size, y: size }, velocity: { x: 2, y: -3 }, groundObject: false };
}

describe('GranularPhysicsBridge.resolveEntityCollision', () => {
  test('does nothing when no engine has been initialised', () => {
    // initGranularEngine() is required because resolveEntityCollision reads the module-level
    // singleton; simulate the "uninitialised" state via a throwaway entity and no assertions
    // beyond "does not throw" would be meaningless once other test files have initialised the
    // singleton, so this suite always initialises its own engine explicitly below instead.
    const entity = makeEntity(0, 0);
    assert.doesNotThrow(() => GranularPhysicsBridge.resolveEntityCollision(entity));
  });

  test('standing on solid ground sets groundObject and cancels downward velocity', () => {
    const engine = initGranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16, originX: -1.25, originY: -1.25 });
    engine.paintCircle(0, -0.3, 0.5, MaterialId.STONE);
    const entity = makeEntity(0, 0);
    GranularPhysicsBridge.resolveEntityCollision(entity);
    // groundObject must be a truthy *object* exposing velocity/friction (matching real LittleJS's
    // own contract for a moving-platform reference), not a bare boolean - a real EngineObject's
    // updatePhysics() reads groundObject.velocity.x internally and would throw on `true`.
    assert.ok(entity.groundObject);
    assert.equal(typeof entity.groundObject, 'object');
    assert.equal(entity.groundObject.velocity.x, 0);
    assert.equal(entity.groundObject.velocity.y, 0);
    assert.equal(entity.velocity.y, 0);
  });

  // Real LittleJS EngineObjects clamp velocity to +/-objectMaxSpeed (default 1 world unit per
  // frame) every step; these tests replicate that clamp so the simulated fall matches how a
  // real character actually moves instead of accelerating without bound.
  const OBJECT_MAX_SPEED = 1;

  test('a grounded entity does not creep downward frame after frame under repeated gravity', () => {
    // Regression test: cancelling velocity on contact is not enough on its own. LittleJS's own
    // physics step re-applies gravity to velocity.y *before* resolveEntityCollision runs each
    // frame, so if contact only zeroed velocity (and never corrected position), the entity would
    // sink by one gravity-step's worth of movement every single frame, forever.
    const engine = initGranularEngine({ gridWidth: 60, gridHeight: 60, pixelsPerUnit: 16, originX: -1.875, originY: -1.875 });
    // A floor several cells thick: a single-cell floor is thinner than one frame's fall
    // movement at typical speeds and would be skipped over regardless of ground handling.
    for (let y = 20; y <= 30; y++) for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, y, MaterialId.STONE);
    const entity = makeEntity(0, 1, 0.3);
    const gravityY = -0.018;

    // Let it fall and land.
    for (let i = 0; i < 300; i++) {
      entity.velocity.y = Math.max(entity.velocity.y + gravityY, -OBJECT_MAX_SPEED);
      entity.pos.y += entity.velocity.y;
      GranularPhysicsBridge.resolveEntityCollision(entity);
    }
    const restingY = entity.pos.y;
    assert.ok(entity.groundObject, 'entity should have landed and be grounded');

    // Keep simulating for a long time while grounded: the resting height must not drift.
    for (let i = 0; i < 300; i++) {
      entity.velocity.y = Math.max(entity.velocity.y + gravityY, -OBJECT_MAX_SPEED);
      entity.pos.y += entity.velocity.y;
      GranularPhysicsBridge.resolveEntityCollision(entity);
    }
    assert.ok(
      Math.abs(entity.pos.y - restingY) < 1e-9,
      `entity sank from ${restingY} to ${entity.pos.y} while resting on solid ground`
    );
  });

  test('a grounded entity does not creep downward while resting on a falling solid (sand)', () => {
    const engine = initGranularEngine({ gridWidth: 60, gridHeight: 60, pixelsPerUnit: 16, originX: -1.875, originY: -1.875 });
    for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, 5, MaterialId.STONE);
    for (let x = 0; x < engine.width; x++) for (let y = 6; y < 30; y++) engine._paintCellMaterial(x, y, MaterialId.SAND);
    for (let i = 0; i < 40; i++) engine.update(); // let the sand settle into a solid bed first
    const entity = makeEntity(0, 2, 0.3);
    const gravityY = -0.018;

    for (let i = 0; i < 200; i++) {
      entity.velocity.y = Math.max(entity.velocity.y + gravityY, -OBJECT_MAX_SPEED);
      entity.pos.y += entity.velocity.y;
      GranularPhysicsBridge.resolveEntityCollision(entity);
    }
    const restingY = entity.pos.y;
    assert.ok(entity.groundObject, 'entity should have landed on the sand bed');

    for (let i = 0; i < 200; i++) {
      entity.velocity.y = Math.max(entity.velocity.y + gravityY, -OBJECT_MAX_SPEED);
      entity.pos.y += entity.velocity.y;
      GranularPhysicsBridge.resolveEntityCollision(entity);
    }
    assert.ok(
      Math.abs(entity.pos.y - restingY) < 1e-9,
      `entity sank from ${restingY} to ${entity.pos.y} while resting on sand`
    );
  });

  test('an entity that spawns already overlapping solid ground is immediately pushed to the surface', () => {
    const engine = initGranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16, originX: -1.25, originY: -1.25 });
    for (let y = 15; y <= 20; y++) for (let x = 0; x < engine.width; x++) engine._paintCellMaterial(x, y, MaterialId.STONE);
    const surfaceWorldY = engine.cellToWorldY(20) + 0.5 / engine.pixelsPerUnit;
    // Spawn with its feet (pos.y - halfHeight) a couple of cells deep inside the solid block.
    const entity = makeEntity(0, engine.cellToWorldY(17) + 0.15, 0.3);
    GranularPhysicsBridge.resolveEntityCollision(entity);
    assert.ok(entity.pos.y >= surfaceWorldY - 1e-9, 'entity must be pushed at or above the ground surface');
  });

  test('lateral velocity is damped by ground friction on contact', () => {
    const engine = initGranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16, originX: -1.25, originY: -1.25 });
    engine.paintCircle(0, -0.3, 0.5, MaterialId.STONE);
    const entity = makeEntity(0, 0);
    const initialVx = entity.velocity.x;
    GranularPhysicsBridge.resolveEntityCollision(entity);
    assert.ok(entity.velocity.x < initialVx);
  });

  test('an entity floating in open air is left entirely unaffected', () => {
    const engine = initGranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16 });
    const entity = makeEntity(1, 1);
    const before = { x: entity.velocity.x, y: entity.velocity.y };
    GranularPhysicsBridge.resolveEntityCollision(entity);
    assert.equal(entity.groundObject, false);
    assert.equal(entity.velocity.x, before.x);
    assert.equal(entity.velocity.y, before.y);
  });

  test('submersion in liquid applies buoyancy (reduces downward speed) and viscous drag', () => {
    const engine = initGranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16, originX: -1.25, originY: -1.25 });
    engine.paintCircle(0, 0, 0.8, MaterialId.WATER);
    const entity = makeEntity(0, 0);
    const initialVy = entity.velocity.y;
    const initialVx = entity.velocity.x;
    GranularPhysicsBridge.resolveEntityCollision(entity);
    assert.ok(entity.velocity.y > initialVy, 'buoyancy should reduce downward speed');
    assert.ok(Math.abs(entity.velocity.x) < Math.abs(initialVx), 'viscous drag should reduce lateral speed');
  });

  test('denser liquids (water) provide more buoyancy than lighter liquids (oil)', () => {
    const waterEngine = initGranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16, originX: -1.25, originY: -1.25 });
    waterEngine.paintCircle(0, 0, 0.8, MaterialId.WATER);
    const inWater = makeEntity(0, 0);
    GranularPhysicsBridge.resolveEntityCollision(inWater);

    const oilEngine = initGranularEngine({ gridWidth: 40, gridHeight: 40, pixelsPerUnit: 16, originX: -1.25, originY: -1.25 });
    oilEngine.paintCircle(0, 0, 0.8, MaterialId.OIL);
    const inOil = makeEntity(0, 0);
    GranularPhysicsBridge.resolveEntityCollision(inOil);

    assert.ok(inWater.velocity.y > inOil.velocity.y, 'water is denser than oil, so it should buoy the entity up more');
  });

  test('gracefully ignores entities missing required vector fields', () => {
    initGranularEngine({ gridWidth: 10, gridHeight: 10, pixelsPerUnit: 16 });
    assert.doesNotThrow(() => GranularPhysicsBridge.resolveEntityCollision({}));
    assert.doesNotThrow(() => GranularPhysicsBridge.resolveEntityCollision(null));
  });
});
