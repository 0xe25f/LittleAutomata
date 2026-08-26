#!/usr/bin/env node
/**
 * Build the compact minified LittleAutomata distribution from the readable source in src/.
 *
 * Outputs:
 *   release/littleautomata.js  — minified ES module for npm and direct download
 *   docs/littleautomata.js       — identical copy for GitHub Pages (index.html, demo.html)
 *
 * Usage: node tools/build-release.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const sourcePath = join(rootDir, 'src', 'littleautomata.js');
const releasePath = join(rootDir, 'release', 'littleautomata.js');
const docsPath = join(rootDir, 'docs', 'littleautomata.js');

const source = readFileSync(sourcePath, 'utf8');

const banner =
  '/*! LittleAutomata — MIT Licence — https://github.com/0xe25f/LittleAutomata */';

const result = await minify(source, {
  module: true,
  format: {
    comments: /^!/,
    preamble: banner
  },
  compress: {
    passes: 2,
    ecma: 2022
  },
  mangle: {
    reserved: ['LittleAutomata']
  },
  ecma: 2022
});

if (result.error) {
  console.error('Minification failed:', result.error);
  process.exit(1);
}

const minified = result.code;
if (!minified) {
  console.error('Minification produced no output.');
  process.exit(1);
}

mkdirSync(join(rootDir, 'release'), { recursive: true });
writeFileSync(releasePath, minified, 'utf8');
writeFileSync(docsPath, minified, 'utf8');

const sourceBytes = Buffer.byteLength(source, 'utf8');
const minifiedBytes = Buffer.byteLength(minified, 'utf8');
const ratio = ((1 - minifiedBytes / sourceBytes) * 100).toFixed(1);

console.log(`Built release/littleautomata.js (${minifiedBytes} bytes, ${ratio}% smaller than src)`);
console.log('Copied to docs/littleautomata.js for GitHub Pages');
