import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { syncClubArenaDist } from '../../scripts/ci/sync-club-arena-dist.mjs';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'club-arena-sync-'));
  roots.push(root);
  const source = path.join(root, 'dist');
  const target = path.join(root, 'public');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await mkdir(path.join(target, 'assets'), { recursive: true });
  return { source, target };
}

describe('Club Arena runtime asset retention', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps one deployed JS/CSS generation while replacing stale media and root files', async () => {
    const { source, target } = await fixture();
    await writeFile(path.join(target, 'index.html'), 'old');
    await writeFile(path.join(target, 'retired.txt'), 'remove');
    await writeFile(path.join(target, 'assets', 'old.js'), 'old js');
    await writeFile(path.join(target, 'assets', 'old.css'), 'old css');
    await writeFile(path.join(target, 'assets', 'old.png'), 'old image');
    await writeFile(path.join(source, 'index.html'), 'new');
    await writeFile(path.join(source, 'assets', 'new.js'), 'new js');
    await writeFile(path.join(source, 'assets', 'new.css'), 'new css');
    await writeFile(path.join(source, 'assets', 'new.png'), 'new image');

    await syncClubArenaDist(source, target);

    await expect(readFile(path.join(target, 'assets', 'old.js'), 'utf8')).resolves.toBe('old js');
    await expect(readFile(path.join(target, 'assets', 'old.css'), 'utf8')).resolves.toBe('old css');
    await expect(readFile(path.join(target, 'assets', 'old.png'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(target, 'retired.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(target, 'index.html'), 'utf8')).resolves.toBe('new');
  });

  it('mirrors nested non-asset directories so every retired command-bar binary is deleted', async () => {
    const { source, target } = await fixture();
    const retiredPaths = [
      'images/btn-hamburger-v4.png',
      'images/btn-hamburger.png',
      'images/btn-hamburger.webp',
      'images/global-header/menu.png',
      'images/global-header/global-header-approved-source.png',
      'images/global-header/global-header-desktop.png',
    ];
    await mkdir(path.join(source, 'images', 'global-header'), { recursive: true });
    await mkdir(path.join(target, 'images', 'global-header'), { recursive: true });
    await mkdir(path.join(target, 'images', 'retired', 'nested'), { recursive: true });
    await writeFile(
      path.join(source, 'images', 'global-header', 'global-header-command-center-v1.png'),
      'current command grid'
    );
    await Promise.all(
      retiredPaths.map(async (relative) => {
        await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
        await writeFile(path.join(target, relative), 'retired three-bar artwork');
      })
    );
    await writeFile(
      path.join(target, 'images', 'retired', 'nested', 'stale.png'),
      'arbitrary stale nested file'
    );
    await writeFile(path.join(source, 'assets', 'current.js'), 'current runtime');
    await writeFile(path.join(target, 'assets', 'previous.js'), 'previous runtime');

    const result = await syncClubArenaDist(source, target);

    expect(result).toEqual({ currentRuntimeAssets: 1, retainedPreviousRuntimeAssets: 1 });
    await expect(
      readFile(
        path.join(source, 'images', 'global-header', 'global-header-command-center-v1.png'),
        'utf8'
      )
    ).resolves.toBe('current command grid');
    await expect(
      readFile(
        path.join(target, 'images', 'global-header', 'global-header-command-center-v1.png'),
        'utf8'
      )
    ).resolves.toBe('current command grid');
    for (const relative of retiredPaths) {
      await expect(readFile(path.join(target, relative), 'utf8')).rejects.toThrow();
    }
    await expect(
      readFile(path.join(target, 'images', 'retired', 'nested', 'stale.png'), 'utf8')
    ).rejects.toThrow();
    await expect(readFile(path.join(target, 'assets', 'previous.js'), 'utf8')).resolves.toBe(
      'previous runtime'
    );
  });

  it('drops runtime assets older than the manifest generation', async () => {
    const { source, target } = await fixture();
    await writeFile(path.join(target, 'assets', 'ancient.js'), 'ancient');
    await writeFile(path.join(target, 'assets', 'previous.js'), 'previous');
    await writeFile(
      path.join(target, 'runtime-asset-manifest.json'),
      JSON.stringify({ assets: ['previous.js'] })
    );
    await writeFile(path.join(source, 'index.html'), 'current');
    await writeFile(path.join(source, 'assets', 'current.js'), 'current');

    const result = await syncClubArenaDist(source, target);

    expect(result).toEqual({ currentRuntimeAssets: 1, retainedPreviousRuntimeAssets: 1 });
    await expect(readFile(path.join(target, 'assets', 'ancient.js'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(target, 'assets', 'previous.js'), 'utf8')).resolves.toBe(
      'previous'
    );
    await expect(readFile(path.join(target, 'assets', 'current.js'), 'utf8')).resolves.toBe(
      'current'
    );
  });

  it('does not rotate away the retained generation when the same build is republished', async () => {
    const { source, target } = await fixture();
    await writeFile(path.join(source, 'index.html'), 'rebuilt shell');
    await writeFile(path.join(source, 'assets', 'current.js'), 'current');
    await writeFile(path.join(target, 'index.html'), 'deployed shell');
    await writeFile(path.join(target, 'assets', 'current.js'), 'current');
    await writeFile(path.join(target, 'assets', 'previous.js'), 'previous');
    await writeFile(
      path.join(target, 'runtime-asset-manifest.json'),
      JSON.stringify({ assets: ['current.js'] })
    );

    const result = await syncClubArenaDist(source, target);

    expect(result).toEqual({ currentRuntimeAssets: 1, retainedPreviousRuntimeAssets: 1 });
    await expect(readFile(path.join(target, 'index.html'), 'utf8')).resolves.toBe('rebuilt shell');
    await expect(readFile(path.join(target, 'assets', 'previous.js'), 'utf8')).resolves.toBe(
      'previous'
    );
  });

  it('checks out the sync helper and invokes it once after the publish verdict', async () => {
    const workflow = await readFile(
      path.join(process.cwd(), '.github', 'workflows', 'publish-club-arena.yml'),
      'utf8'
    );
    const scriptCalls = workflow.match(
      /node \.\.\/club-arena-source\/scripts\/ci\/sync-club-arena-dist\.mjs/g
    );

    expect(workflow).toContain('- name: Checkout Club Arena sync tooling');
    expect(workflow).toContain('path: club-arena-source');
    expect(workflow).toContain('sparse-checkout: scripts/ci/sync-club-arena-dist.mjs');
    expect(scriptCalls).toHaveLength(1);
    expect(workflow).not.toContain('- name: Sync dist/ to World Hub');
  });
});
