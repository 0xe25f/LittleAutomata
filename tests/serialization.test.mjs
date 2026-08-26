// Tests for the RLE binary state serialisation format (Section 7 of AGENTS.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GranularEngine, MaterialId, OFFSET_MATERIAL, OFFSET_LIFE, OFFSET_VX, OFFSET_FLAGS,
  FLAG_SLEEPING, FLAG_UPDATED, CELL_BYTE_SIZE
} from '../src/littleautomata.js';

describe('serializeGrid / deserializeGrid', () => {
  test('the header begins with the "LJCA" magic signature and version 1', () => {
    const engine = new GranularEngine({ gridWidth: 8, gridHeight: 8, pixelsPerUnit: 16 });
    const data = engine.serializeGrid();
    assert.equal(String.fromCharCode(data[0], data[1], data[2], data[3]), 'LJCA');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    assert.equal(view.getUint16(4, true), 1);
    assert.equal(view.getUint16(6, true), 8);
    assert.equal(view.getUint16(8, true), 8);
    assert.equal(view.getUint16(10, true), 16);
  });

  test('round-trips materialId, life, and vx exactly for a varied world', () => {
    const engine = new GranularEngine({ gridWidth: 48, gridHeight: 48, pixelsPerUnit: 16, randomSeed: 42 });
    engine._stampCircle(24, 40, 8, MaterialId.SAND);
    engine._stampCircle(10, 20, 6, MaterialId.WATER);
    engine._paintCellMaterial(30, 10, MaterialId.FIRE);
    for (let i = 0; i < 60; i++) engine.update(); // Introduce varied life/vx/settled states.

    const before = {
      material: engine.grid.currentU8.filter((_, i) => i % CELL_BYTE_SIZE === OFFSET_MATERIAL),
      life: engine.grid.currentU8.filter((_, i) => i % CELL_BYTE_SIZE === OFFSET_LIFE),
      vx: engine.grid.currentI8.filter((_, i) => i % CELL_BYTE_SIZE === OFFSET_VX)
    };

    const data = engine.serializeGrid();
    const ok = engine.deserializeGrid(data);
    assert.equal(ok, true);

    const after = {
      material: engine.grid.currentU8.filter((_, i) => i % CELL_BYTE_SIZE === OFFSET_MATERIAL),
      life: engine.grid.currentU8.filter((_, i) => i % CELL_BYTE_SIZE === OFFSET_LIFE),
      vx: engine.grid.currentI8.filter((_, i) => i % CELL_BYTE_SIZE === OFFSET_VX)
    };

    assert.deepEqual(Array.from(after.material), Array.from(before.material));
    assert.deepEqual(Array.from(after.life), Array.from(before.life));
    assert.deepEqual(Array.from(after.vx), Array.from(before.vx));
  });

  test('deserializeGrid mirrors the loaded state into both halves of the double buffer', () => {
    const engine = new GranularEngine({ gridWidth: 16, gridHeight: 16, pixelsPerUnit: 16 });
    engine._paintCellMaterial(5, 5, MaterialId.SAND);
    const data = engine.serializeGrid();
    engine.deserializeGrid(data);
    assert.deepEqual(Array.from(engine.grid.currentU32), Array.from(engine.grid.nextU32));
  });

  test('deserializeGrid wakes every chunk and clears FLAG_SLEEPING/FLAG_UPDATED', () => {
    const engine = new GranularEngine({ gridWidth: 128, gridHeight: 128, pixelsPerUnit: 16 });
    engine._paintCellMaterial(10, 10, MaterialId.SAND);
    for (let i = 0; i < 10; i++) engine.update(); // Let some chunks settle and sleep.
    const data = engine.serializeGrid();
    engine.deserializeGrid(data);

    for (let i = 0; i < engine.chunks.totalChunks; i++) {
      assert.equal(engine.chunks.isActive[i], 1, `chunk ${i} should be awake after load`);
    }
    let stillFlagged = 0;
    const u8 = engine.grid.currentU8;
    for (let i = OFFSET_FLAGS; i < u8.length; i += CELL_BYTE_SIZE) {
      if (u8[i] & (FLAG_SLEEPING | FLAG_UPDATED)) stillFlagged++;
    }
    assert.equal(stillFlagged, 0);
  });

  test('resizes the grid when the stored dimensions differ from the current instance', () => {
    const small = new GranularEngine({ gridWidth: 8, gridHeight: 8, pixelsPerUnit: 16 });
    small._paintCellMaterial(2, 2, MaterialId.STONE);
    const data = small.serializeGrid();

    const target = new GranularEngine({ gridWidth: 64, gridHeight: 64, pixelsPerUnit: 16 });
    const ok = target.deserializeGrid(data);
    assert.equal(ok, true);
    assert.equal(target.width, 8);
    assert.equal(target.height, 8);
    assert.equal(target.getMaterialId(2, 2), MaterialId.STONE);
  });

  test('rejects data with a bad magic signature or unsupported version', () => {
    const engine = new GranularEngine({ gridWidth: 8, gridHeight: 8, pixelsPerUnit: 16 });
    const corrupted = engine.serializeGrid();
    corrupted[0] = 0x00;
    assert.equal(engine.deserializeGrid(corrupted), false);

    const wrongVersion = engine.serializeGrid();
    const view = new DataView(wrongVersion.buffer);
    view.setUint16(4, 99, true);
    assert.equal(engine.deserializeGrid(wrongVersion), false);
  });

  test('rejects truncated data without throwing', () => {
    const engine = new GranularEngine({ gridWidth: 8, gridHeight: 8, pixelsPerUnit: 16 });
    const data = engine.serializeGrid();
    const truncated = data.slice(0, 18);
    assert.doesNotThrow(() => {
      assert.equal(engine.deserializeGrid(truncated), false);
    });
  });

  test('rejects an empty or undersized buffer', () => {
    const engine = new GranularEngine({ gridWidth: 8, gridHeight: 8, pixelsPerUnit: 16 });
    assert.equal(engine.deserializeGrid(new Uint8Array(0)), false);
    assert.equal(engine.deserializeGrid(null), false);
  });

  test('a uniform Air grid compresses to a single run', () => {
    const engine = new GranularEngine({ gridWidth: 64, gridHeight: 64, pixelsPerUnit: 16 });
    const data = engine.serializeGrid();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const totalRuns = view.getUint32(12, true);
    // 64*64 = 4096 identical Air cells, capped at 255 per run -> ceil(4096/255) runs.
    assert.equal(totalRuns, Math.ceil((64 * 64) / 255));
  });
});
