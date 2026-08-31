import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const workflow = readFileSync(
  resolve(__dirname, '../.github/workflows/build-for-world-hub.yml'),
  'utf8'
);

describe('World Hub immutable-asset rollover', () => {
  it('publishes a manifest for the exact current asset generation', () => {
    expect(workflow).toContain('> dist/asset-manifest.txt');
    expect(workflow).toContain('if [ ! -s dist/asset-manifest.txt ]');
  });

  it('retains the deployed manifest generation across the destructive sync', () => {
    const snapshot = workflow.indexOf('done < "$target/asset-manifest.txt"');
    const destructiveSync = workflow.indexOf('rsync -av --delete');
    const restore = workflow.indexOf('rsync -av --ignore-existing');

    expect(snapshot).toBeGreaterThan(-1);
    expect(destructiveSync).toBeGreaterThan(snapshot);
    expect(restore).toBeGreaterThan(destructiveSync);
  });

  it('rejects manifest paths outside the immutable assets directory', () => {
    expect(workflow).toContain('case "$asset" in');
    expect(workflow).toContain('assets/*)');
    expect(workflow).toContain('Unsafe path in deployed asset-manifest.txt');
    expect(workflow).toContain('Unsafe traversal in deployed asset-manifest.txt');
  });
});
