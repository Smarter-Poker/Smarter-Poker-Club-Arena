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

// The switch must be in the environment before vite.config.ts is evaluated,
// which happens inside build() when it loads the config file.
process.env.CA_HTML_ENTRY = 'diamond-test';
const { build } = await import('vite');
try {
  await build({ configFile: 'vite.config.ts' });
  console.log('[diamond-test] standalone test entry built into dist/diamond-test/');
} catch (error) {
  console.error(`[diamond-test] the standalone test entry did not build: ${error?.message ?? error}`);
  process.exit(1);
}
