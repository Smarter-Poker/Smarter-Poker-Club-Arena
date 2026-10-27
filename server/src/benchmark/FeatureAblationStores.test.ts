import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  decodeFrozenFeatureAblationStore,
  hydrateFrozenFeatureAblationStores,
} from './FeatureAblationStores.js';
const fixture = fileURLToPath(
  new URL('../../../tests/fixtures/horse-feature-ablation-stores/', import.meta.url)
);
describe('frozen exact current solver inputs', () => {
  it('hydrates both real corpus snapshots through original production modules with matching digests', async () => {
    const loaded = await hydrateFrozenFeatureAblationStores();
    expect(loaded.stores.charts).toBe(240);
    expect(loaded.stores.postflop).toBe(7747);
    expect(loaded.stores.identity?.charts.digest).toBe(
      '2c8a2d9f448e5dd22f4433faeb40f70ac6a111d6c7e7bacae89e4fbf106a5dbf'
    );
    expect(loaded.stores.identity?.postflop.digest).toBe(
      'dff78313b437357d3657fe256fc3b3b82cd4740afffe9125e530dfcc79f57c1d'
    );
    expect(loaded.stores.postflopV31).toBe(0);
    expect(loaded.stores.postflopV31Dataset).toBeNull();
  }, 30000);
  it('rejects compressed corruption, changed decoded hash and excessive declared expansion before use', async () => {
    const manifest = JSON.parse(await readFile(fixture + 'manifest.json', 'utf8'));
    const entry = manifest.files[0],
      bytes = await readFile(fixture + entry.file),
      bad = Buffer.from(bytes);
    bad[20] ^= 1;
    expect(() => decodeFrozenFeatureAblationStore(bad, entry)).toThrow('digest/size');
    expect(() =>
      decodeFrozenFeatureAblationStore(bytes, { ...entry, uncompressedSha256: '0'.repeat(64) })
    ).toThrow('digest/size');
    expect(() =>
      decodeFrozenFeatureAblationStore(bytes, { ...entry, uncompressedBytes: 64 * 1024 * 1024 + 1 })
    ).toThrow('Oversized');
  });
});
