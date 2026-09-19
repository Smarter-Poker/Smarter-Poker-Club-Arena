#!/usr/bin/env node
/**
 * build-diamond-test.mjs - the standalone Diamond bonus test entry, as a
 * second Vite pass into the dist the application build just wrote.
 *
 * Runs from build:ci directly after `vite build`. It sets CA_HTML_ENTRY, which
 * vite.config.ts reads to build diamond-test.html alone into dist/diamond-test/
 * (see the TEST_ENTRY note there for why this is a pass of its own and not a
 * second Rollup input: a second input reorders the application's CSS).
 *
 * The native bundle (VITE_NATIVE=1, dist-native/) never gets this pass: the
 * app shell opens index.html only, and dist-native stays exactly the bundle it
 * was before the test entry existed.
 */
if (process.env.VITE_NATIVE === '1') {
  console.log('[diamond-test] native bundle: the standalone test entry is web-only, skipping');
  process.exit(0);
}

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, whatever the caller's working directory: the config resolves
// diamond-test.html against its own directory, so the build root must agree.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The switch must be in the environment before vite.config.ts is evaluated,
// which happens inside build() when it loads the config file.
process.env.CA_HTML_ENTRY = 'diamond-test';
const { build } = await import('vite');
try {
  await build({ root: ROOT, configFile: resolve(ROOT, 'vite.config.ts') });
  console.log('[diamond-test] standalone test entry built into dist/assets/diamond-test.*');
} catch (error) {
  // Rollup names the module and frame on the error; keep them.
  const detail = [error?.id, error?.message ?? String(error), error?.frame].filter(Boolean);
  console.error(`[diamond-test] the standalone test entry did not build:\n${detail.join('\n')}`);
  process.exit(1);
}
