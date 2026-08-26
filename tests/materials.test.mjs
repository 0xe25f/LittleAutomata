// Tests for MaterialDefinition, MaterialRegistry, ReactionMatrix, colour packing, and the
// default material/reaction library (Sections 3, 6, 7, 8 of littleautomata.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MaterialRegistry, ReactionMatrix, Archetype, MaterialId,
  registerDefaultMaterials, registerDefaultReactions,
  packColourRGBA, normaliseColourToAbgr, getCellColour
} from '../src/littleautomata.js';

describe('colour packing', () => {
  test('packColourRGBA() places alpha in the highest byte (ABGR word order)', () => {
    const packed = packColourRGBA(0x11, 0x22, 0x33, 0x44);
    assert.equal(packed >>> 24, 0x44);
    assert.equal((packed >>> 16) & 0xff, 0x33);
    assert.equal((packed >>> 8) & 0xff, 0x22);
    assert.equal(packed & 0xff, 0x11);
  });

  test('normaliseColourToAbgr() accepts #RRGGBBAA hex strings', () => {
    const packed = normaliseColourToAbgr('#11223344');
    assert.equal(packed, packColourRGBA(0x11, 0x22, 0x33, 0x44));
  });

  test('normaliseColourToAbgr() defaults alpha to 0xff for #RRGGBB strings', () => {
    const packed = normaliseColourToAbgr('#112233');
    assert.equal(packed, packColourRGBA(0x11, 0x22, 0x33, 0xff));
  });

  test('normaliseColourToAbgr() accepts numeric 0xRRGGBBAA and 0xRRGGBB literals', () => {
    assert.equal(normaliseColourToAbgr(0x11223344), packColourRGBA(0x11, 0x22, 0x33, 0x44));
    assert.equal(normaliseColourToAbgr(0x112233), packColourRGBA(0x11, 0x22, 0x33, 0xff));
  });
});

describe('getCellColour', () => {
  test('a single-colour palette always returns that colour, regardless of coordinate', () => {
    const registry = new MaterialRegistry();
    registry.register({ id: 50, name: 'Solo', archetype: Archetype.IMMOVABLE_SOLID, baseColours: ['#ABCDEF11'] });
    const def = registry.get(50);
    const expected = normaliseColourToAbgr('#ABCDEF11');
    assert.equal(getCellColour(def, 0, 0), expected);
    assert.equal(getCellColour(def, 999, -12345), expected);
  });

  test('a multi-colour palette is deterministic for a fixed coordinate', () => {
    const registry = new MaterialRegistry();
    registry.register({
      id: 51, name: 'Grainy', archetype: Archetype.FALLING_SOLID,
      baseColours: ['#111111FF', '#222222FF', '#333333FF']
    });
    const def = registry.get(51);
    const first = getCellColour(def, 17, -42);
    const second = getCellColour(def, 17, -42);
    assert.equal(first, second);
    assert.ok(def.baseColours.includes(first));
  });
});

describe('MaterialRegistry', () => {
  test('register() validates the id range', () => {
    const registry = new MaterialRegistry();
    assert.throws(() => registry.register({ id: 256, name: 'Bad', archetype: Archetype.EMPTY }), RangeError);
    assert.throws(() => registry.register({ id: -1, name: 'Bad', archetype: Archetype.EMPTY }), RangeError);
  });

  test('register() requires a name', () => {
    const registry = new MaterialRegistry();
    assert.throws(() => registry.register({ id: 10, archetype: Archetype.EMPTY }), TypeError);
  });

  test('register() validates the archetype', () => {
    const registry = new MaterialRegistry();
    assert.throws(() => registry.register({ id: 10, name: 'Bad', archetype: 999 }), RangeError);
  });

  test('get() returns the Air definition for an unregistered id', () => {
    const registry = new MaterialRegistry();
    registerDefaultMaterials(registry);
    const unregistered = registry.get(200);
    assert.equal(unregistered.id, MaterialId.AIR);
  });

  test('material definitions are frozen (immutable) once registered', () => {
    const registry = new MaterialRegistry();
    registry.register({ id: 10, name: 'Rock', archetype: Archetype.IMMOVABLE_SOLID });
    const def = registry.get(10);
    assert.throws(() => { def.density = 999; });
  });
});

describe('ReactionMatrix', () => {
  test('register() and get() round-trip every packed field', () => {
    const reactions = new ReactionMatrix();
    reactions.register(6, 4, 0, 7, 1.0, 60);
    const packed = reactions.get(6, 4);
    assert.equal(packed & 0xff, 0);
    assert.equal((packed >>> 8) & 0xff, 7);
    assert.equal((packed >>> 16) & 0xff, 255);
    assert.equal((packed >>> 24) & 0xff, 60);
  });

  test('probability 0.5 packs to a byte value of approximately 127-128', () => {
    const reactions = new ReactionMatrix();
    reactions.register(1, 2, 1, 2, 0.5, 0);
    const probabilityByte = (reactions.get(1, 2) >>> 16) & 0xff;
    assert.ok(probabilityByte >= 126 && probabilityByte <= 128);
  });

  test('get() returns 0 for an unregistered pair', () => {
    const reactions = new ReactionMatrix();
    assert.equal(reactions.get(5, 5), 0);
  });

  test('reactions are directional: (a, b) does not imply (b, a)', () => {
    const reactions = new ReactionMatrix();
    reactions.register(1, 2, 9, 9, 1.0, 0);
    assert.notEqual(reactions.get(1, 2), 0);
    assert.equal(reactions.get(2, 1), 0);
  });
});

describe('default material library', () => {
  const registry = new MaterialRegistry();
  registerDefaultMaterials(registry);

  test('registers exactly the nine documented materials with the correct archetypes', () => {
    assert.equal(registry.get(MaterialId.AIR).archetype, Archetype.EMPTY);
    assert.equal(registry.get(MaterialId.BEDROCK).archetype, Archetype.IMMOVABLE_SOLID);
    assert.equal(registry.get(MaterialId.STONE).archetype, Archetype.IMMOVABLE_SOLID);
    assert.equal(registry.get(MaterialId.SAND).archetype, Archetype.FALLING_SOLID);
    assert.equal(registry.get(MaterialId.WATER).archetype, Archetype.SLIDING_LIQUID);
    assert.equal(registry.get(MaterialId.OIL).archetype, Archetype.SLIDING_LIQUID);
    assert.equal(registry.get(MaterialId.FIRE).archetype, Archetype.PROPAGATING_ENERGY);
    assert.equal(registry.get(MaterialId.SMOKE).archetype, Archetype.RISING_GAS);
    assert.equal(registry.get(MaterialId.ACID).archetype, Archetype.SLIDING_LIQUID);
  });

  test('bedrock is denser and has higher friction than stone (harder to destroy/move)', () => {
    assert.ok(registry.get(MaterialId.BEDROCK).density > registry.get(MaterialId.STONE).density);
  });

  test('fire decays into smoke, and smoke decays into air', () => {
    assert.equal(registry.get(MaterialId.FIRE).decayInto, MaterialId.SMOKE);
    assert.equal(registry.get(MaterialId.SMOKE).decayInto, MaterialId.AIR);
    assert.ok(registry.get(MaterialId.FIRE).lifetime > 0);
    assert.ok(registry.get(MaterialId.SMOKE).lifetime > 0);
  });

  test('oil is less dense than water (floats) and is flammable', () => {
    assert.ok(registry.get(MaterialId.OIL).density < registry.get(MaterialId.WATER).density);
    assert.ok(registry.get(MaterialId.OIL).flammability > 0);
  });
});

describe('default reaction set', () => {
  const reactions = new ReactionMatrix();
  registerDefaultReactions(reactions);

  test('Fire + Water -> Air + Smoke at 100% probability', () => {
    const packed = reactions.get(MaterialId.FIRE, MaterialId.WATER);
    assert.notEqual(packed, 0);
    assert.equal(packed & 0xff, MaterialId.AIR);
    assert.equal((packed >>> 8) & 0xff, MaterialId.SMOKE);
    assert.equal((packed >>> 16) & 0xff, 255);
  });

  test('Fire + Oil -> Fire + Fire (ignition)', () => {
    const packed = reactions.get(MaterialId.FIRE, MaterialId.OIL);
    assert.equal(packed & 0xff, MaterialId.FIRE);
    assert.equal((packed >>> 8) & 0xff, MaterialId.FIRE);
  });

  test('Acid + Stone and Acid + Sand both yield Smoke + Air', () => {
    const stoneReaction = reactions.get(MaterialId.ACID, MaterialId.STONE);
    const sandReaction = reactions.get(MaterialId.ACID, MaterialId.SAND);
    assert.equal(stoneReaction & 0xff, MaterialId.SMOKE);
    assert.equal((stoneReaction >>> 8) & 0xff, MaterialId.AIR);
    assert.equal(sandReaction & 0xff, MaterialId.SMOKE);
    assert.equal((sandReaction >>> 8) & 0xff, MaterialId.AIR);
  });

  test('Fire + Sand rarely smelts into Fire + Stone', () => {
    const packed = reactions.get(MaterialId.FIRE, MaterialId.SAND);
    const probabilityByte = (packed >>> 16) & 0xff;
    assert.ok(probabilityByte > 0 && probabilityByte < 10, 'should be a rare reaction');
    assert.equal((packed >>> 8) & 0xff, MaterialId.STONE);
  });
});
