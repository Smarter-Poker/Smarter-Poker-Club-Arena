import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { AtlasSprite } from '../../src/throwables/AtlasSprite';
import { throwableAtlasUrl } from '../../src/throwables/atlasUrl';
import manifest from '../../src/throwables/artwork.generated.json';
describe('throwable atlas cache identity', () => {
  it('fingerprints the actual delivered bytes for every registered atlas', () => {
    for (const [name, hash] of Object.entries(manifest.hashes)) {
      const bytes = readFileSync(`public/images/throwables/animated/${name}.webp`);
      expect(hash).toBe(createHash('sha256').update(bytes).digest('hex').slice(0, 16));
      expect(throwableAtlasUrl(name)).toContain(`${name}.webp?v=${hash}`);
    }
    expect(Object.keys(manifest.hashes).sort()).toEqual(Object.keys(manifest.sizes).sort());
  });
  it('renders the same fingerprinted URL used for readiness', () => {
    const html = renderToStaticMarkup(
      <AtlasSprite src="anvil" rect={[0, 0, 627, 627]} x={0} y={0} width={100} height={100} />
    );
    expect(html).toContain(throwableAtlasUrl('anvil'));
  });
  it('rejects unknown atlas names instead of requesting an unversioned URL', () => {
    expect(() => throwableAtlasUrl('missing-atlas')).toThrow('Unknown throwable atlas');
  });
});
