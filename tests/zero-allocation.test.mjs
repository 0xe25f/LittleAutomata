// Static source-level guard enforcing AGENTS.md's "Zero Runtime Allocations" invariant: none of
// the per-frame simulation, chunk-activity, or rendering-upload hot-path methods may contain an
// object literal, array literal, or `new` expression in their body. Pre-allocated buffers are
// all constructed once, in constructors/initialisers, which are deliberately excluded below.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'littleautomata.js');
const source = readFileSync(sourcePath, 'utf8');

/**
 * Extract the full `{ ... }` body text of a named method/function via balanced-brace matching,
 * starting the search after its declaration signature (`name(...) {`).
 * @param {string} name - Method or function name to locate.
 * @returns {string} The method body, including the enclosing braces.
 */
function extractMethodBody(name) {
  const signature = new RegExp('(?:^|[\\s.])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\([^)]*\\)\\s*\\{');
  const match = signature.exec(source);
  assert.ok(match, `could not locate method "${name}" in littleautomata.js`);
  let depth = 0;
  let start = -1;
  for (let i = match.index; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting "${name}"`);
}

/**
 * Strip line and block comments so comment text (which may legitimately mention `new` or `{key:`
 * in prose) never produces a false positive.
 * @param {string} code - Raw JavaScript source text.
 * @returns {string} The same code with comments blanked out.
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Every per-frame hot-path method that must remain allocation-free. */
const HOT_PATH_METHODS = [
  '_simulateSubStep', '_copyActiveRegionsToNext', '_sweepPassOne', '_sweepPassTwo',
  '_processCellPassOne', '_processCellPassTwo', '_reactWithNeighbours', '_igniteNeighbours',
  '_applyLifetimeDecay', '_attemptFall', '_fallingSolidTryDiagonal', '_tryLateralSlide',
  '_fallingSolidStep', '_tryDiagonalDown', '_lateralFluidSpread', '_slidingLiquidStep',
  '_tryDiagonalUp', '_lateralGasDisperse', '_risingGasStep', '_touchCell', '_setCellRaw',
  '_moveCell', '_swapCells', '_convertCellMaterial', '_setVelocityX', '_updateScreenShake',
  '_applySleepFlagTransitions', '_setChunkSleepFlag',
  'render', '_renderCanvas2d', '_renderWebgl', '_drawWebglQuad', '_collectDynamicLights',
  'resolveEntityCollision', 'pushEntityOutOfSolidGround',
  // ChunkManager activity bookkeeping, invoked every sub-step and on every cell mutation.
  'chunkIndexAt', 'getChunkWorldBounds', 'hasDirtyBounds', 'hasRenderDirty', 'clearRenderDirty',
  'markCellDirty', 'activate', 'wakeChunkAt', 'beginStep', 'endStep'
];

describe('zero-allocation hot-path guard', () => {
  for (const name of HOT_PATH_METHODS) {
    test(`${name}() contains no "new", array literal, or object literal`, () => {
      const body = stripComments(extractMethodBody(name));
      assert.doesNotMatch(body, /\bnew\s+[A-Za-z_$]/, 'hot-path method must not construct new instances');
      assert.doesNotMatch(body, /=\s*\[/, 'hot-path method must not allocate an array literal');
      assert.doesNotMatch(body, /\[\s*\]/, 'hot-path method must not allocate an empty array literal');
      assert.doesNotMatch(body, /\{\s*[A-Za-z_$][\w$]*\s*:/, 'hot-path method must not allocate an object literal');
    });
  }

  test('GranularGridBuffer.swap() performs zero copying and zero allocation (reference exchange only)', () => {
    const body = stripComments(extractMethodBody('swap'));
    assert.doesNotMatch(body, /\bnew\s+[A-Za-z_$]/);
    assert.doesNotMatch(body, /\.set\(/, 'swap() must exchange references, never copy buffer contents');
  });

  test('serializeGrid()/deserializeGrid() are explicitly exempt (documented one-shot admin operations)', () => {
    // No assertion: these are one-shot save/load calls, not part of the continuous simulation,
    // rendering-upload, or collision-query hot paths that AGENTS.md's zero-allocation law targets.
    assert.ok(source.includes('serializeGrid()'), 'sanity check that the method still exists');
  });
});
