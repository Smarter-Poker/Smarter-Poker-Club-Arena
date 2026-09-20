/**
 * After a Club Arena publish, the arena's public pages on smarter.poker are
 * submitted to IndexNow (AEO phase 1, 2026-09-17). Pins the URL shape and
 * that the workflow listens to the publisher by its name.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - a plain .mjs script with named exports
import { indexNowBody, publicUrlsFromManifest } from '../scripts/indexnow-public-routes.mjs';

const ROOT = join(__dirname, '..');

describe('indexnow public routes', () => {
  it('builds the public URLs from the prerender manifest', () => {
    const manifest = {
      base: '/hub/club-arena',
      routes: [{ route: '/' }, { route: '/help' }, { route: '/legal/tos' }, { route: 'bad' }],
    };
    expect(publicUrlsFromManifest(manifest)).toEqual([
      'https://smarter.poker/hub/club-arena',
      'https://smarter.poker/hub/club-arena/help',
      'https://smarter.poker/hub/club-arena/legal/tos',
    ]);
    expect(publicUrlsFromManifest({})).toEqual([]);
  });

  it('submits with the host key served at its public location', () => {
    const body = indexNowBody(['https://smarter.poker/hub/club-arena'], 'abc');
    expect(body).toEqual({
      host: 'smarter.poker',
      key: 'abc',
      keyLocation: 'https://smarter.poker/ebee30927d6f8e9d19a8deb450a4359e.txt',
      urlList: ['https://smarter.poker/hub/club-arena'],
    });
  });

  it('the workflow fires off a successful Publish Club Arena run and is best effort', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/indexnow-public-routes.yml'), 'utf8');
    expect(wf).toMatch(/workflows: \['Publish Club Arena'\]/);
    expect(wf).toMatch(/conclusion == 'success'/);
    expect(wf).not.toMatch(/schedule:/);
    expect(wf).toMatch(/node scripts\/indexnow-public-routes\.mjs/);
    expect(wf).not.toMatch(/workflow_run\.head_sha/);
    expect(wf).toMatch(/continue-on-error: true/);
  });
});
