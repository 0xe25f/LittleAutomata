// Tests for GranularGridBuffer and ChunkManager (Section 4 & 5 of littleautomata.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GranularGridBuffer, ChunkManager, CELL_BYTE_SIZE, OFFSET_MATERIAL
} from '../src/littleautomata.js';

describe('GranularGridBuffer', () => {
  test('allocates two independent buffers of the correct byte length', () => {
    const buf = new GranularGridBuffer(10, 5);
    assert.equal(buf.totalCells, 50);
    assert.equal(buf.byteLength, 50 * CELL_BYTE_SIZE);
    assert.equal(buf.bufferA.byteLength, buf.byteLength);
    assert.equal(buf.bufferB.byteLength, buf.byteLength);
    assert.notEqual(buf.bufferA, buf.bufferB);
  });

  test('index() computes row-major flat indices', () => {
    const buf = new GranularGridBuffer(10, 5);
    assert.equal(buf.index(0, 0), 0);
    assert.equal(buf.index(3, 0), 3);
    assert.equal(buf.index(0, 1), 10);
    assert.equal(buf.index(3, 2), 23);
  });

  test('isInBounds() rejects negative and out-of-range coordinates', () => {
    const buf = new GranularGridBuffer(10, 5);
    assert.equal(buf.isInBounds(0, 0), true);
    assert.equal(buf.isInBounds(9, 4), true);
    assert.equal(buf.isInBounds(10, 0), false);
    assert.equal(buf.isInBounds(0, 5), false);
    assert.equal(buf.isInBounds(-1, 0), false);
  });

  test('swap() exchanges buffer view references with zero copying', () => {
    const buf = new GranularGridBuffer(4, 4);
    const originalCurrentU32 = buf.currentU32;
    const originalNextU32 = buf.nextU32;
    buf.nextU32[0] = 0xdeadbeef;
    buf.swap();
    assert.equal(buf.currentU32, originalNextU32);
    assert.equal(buf.nextU32, originalCurrentU32);
    assert.equal(buf.currentU32[0], 0xdeadbeef);
  });
});

describe('ChunkManager', () => {
  test('computes chunk grid dimensions from chunk size', () => {
    const chunks = new ChunkManager(130, 65, 64);
    assert.equal(chunks.chunksX, 3);
    assert.equal(chunks.chunksY, 2);
    assert.equal(chunks.totalChunks, 6);
  });

  test('chunkIndexAt() maps a cell coordinate to its containing chunk', () => {
    const chunks = new ChunkManager(128, 128, 64);
    assert.equal(chunks.chunkIndexAt(0, 0), 0);
    assert.equal(chunks.chunkIndexAt(63, 63), 0);
    assert.equal(chunks.chunkIndexAt(64, 0), 1);
    assert.equal(chunks.chunkIndexAt(0, 64), 2);
    assert.equal(chunks.chunkIndexAt(127, 127), 3);
  });

  test('getChunkWorldBounds() clips to the grid extent for edge chunks', () => {
    const chunks = new ChunkManager(100, 100, 64);
    const bounds = chunks.getChunkWorldBounds(chunks.chunkIndexAt(80, 80));
    assert.equal(bounds.minX, 64);
    assert.equal(bounds.minY, 64);
    assert.equal(bounds.maxX, 99);
    assert.equal(bounds.maxY, 99);
  });

  test('wakeChunkAt() activates the target chunk and its eight neighbours', () => {
    const chunks = new ChunkManager(256, 256, 64);
    chunks.wakeChunkAt(96, 96); // Centre chunk is (1,1) in a 4x4 chunk grid.
    assert.equal(chunks.activeCount, 9);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const idx = (1 + dy) * chunks.chunksX + (1 + dx);
        assert.equal(chunks.isActive[idx], 1, `chunk (${1 + dx},${1 + dy}) should be active`);
      }
    }
  });

  test('wakeChunkAt() clips neighbour activation at the grid edge', () => {
    const chunks = new ChunkManager(128, 128, 64);
    chunks.wakeChunkAt(0, 0); // Corner chunk only has 3 valid neighbours (plus itself = 4).
    assert.equal(chunks.activeCount, 4);
  });

  test('markCellDirty() grows both the step and render dirty rectangles', () => {
    const chunks = new ChunkManager(128, 128, 64);
    chunks.wakeChunkAt(10, 20);
    const idx = chunks.chunkIndexAt(10, 20);
    chunks.markCellDirty(10, 20);
    chunks.markCellDirty(15, 25);
    assert.equal(chunks.dirtyMinX[idx], 10);
    assert.equal(chunks.dirtyMaxX[idx], 15);
    assert.equal(chunks.dirtyMinY[idx], 20);
    assert.equal(chunks.dirtyMaxY[idx], 25);
    assert.equal(chunks.hasDirtyBounds(idx), true);
    assert.equal(chunks.hasRenderDirty(idx), true);
    assert.equal(chunks.renderDirtyMinX[idx], 10);
    assert.equal(chunks.renderDirtyMaxX[idx], 15);
  });

  test('render-dirty bounds persist across beginStep()/endStep() cycles until explicitly cleared', () => {
    const chunks = new ChunkManager(128, 128, 64);
    chunks.wakeChunkAt(5, 5);
    chunks.markCellDirty(5, 5);
    const idx = chunks.chunkIndexAt(5, 5);

    // Simulate a second sub-step with no further activity in this chunk: the per-step dirty
    // rectangle resets (used for sleep bookkeeping), but the render-dirty rectangle must survive.
    chunks.beginStep();
    assert.equal(chunks.hasDirtyBounds(idx), false, 'step-dirty bounds reset on beginStep()');
    assert.equal(chunks.hasRenderDirty(idx), true, 'render-dirty bounds must persist across sub-steps');
    chunks.endStep();

    chunks.clearRenderDirty(idx);
    assert.equal(chunks.hasRenderDirty(idx), false);
  });

  test('a chunk sleeps after two consecutive quiescent sweeps and is removed from the active list', () => {
    // A grid several chunks wide/tall so that waking a cell away from any edge only activates
    // its full 3x3 neighbourhood, not the entire grid (which would make every chunk sleep
    // together and defeat the point of checking one specific chunk's transition).
    const chunks = new ChunkManager(320, 320, 64);
    chunks.wakeChunkAt(160, 160); // Comfortably interior: activates a full 3x3 block of chunks.
    const idx = chunks.chunkIndexAt(160, 160);
    const activeAfterWake = chunks.activeCount;
    assert.equal(activeAfterWake, 9, 'a fully-interior wake should activate exactly 3x3 chunks');

    chunks.beginStep();
    chunks.endStep(); // sleepCounter -> 1 for all nine, still active
    assert.equal(chunks.isActive[idx], 1);
    assert.equal(chunks.sleepCounter[idx], 1);
    assert.equal(chunks.activeCount, activeAfterWake);

    chunks.beginStep();
    chunks.endStep(); // sleepCounter -> 2 for all nine: every one of them falls asleep together
    assert.equal(chunks.isActive[idx], 0);
    assert.equal(chunks.activeCount, 0);
    assert.equal(chunks.justSleptCount, activeAfterWake);
    assert.ok(Array.from(chunks.justSleptList.slice(0, chunks.justSleptCount)).includes(idx));
  });

  test('activity touched every sub-step never sleeps', () => {
    const chunks = new ChunkManager(128, 128, 64);
    chunks.wakeChunkAt(5, 5);
    const idx = chunks.chunkIndexAt(5, 5);
    for (let i = 0; i < 10; i++) {
      chunks.beginStep();
      chunks.markCellDirty(5, 5);
      chunks.endStep();
    }
    assert.equal(chunks.isActive[idx], 1);
    assert.equal(chunks.sleepCounter[idx], 0);
  });
});
