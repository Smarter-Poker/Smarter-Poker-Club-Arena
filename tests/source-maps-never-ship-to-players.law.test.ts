import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
describe('source maps never ship to players', () => {
  it('disables maps in both application targets', () => {
    expect(read('vite.config.ts')).toContain('sourcemap: false');
  });
  it('the publisher strips maps and refuses any surviving source map', () => {
    /* The publisher is the workflow AND the transaction it pipes to the
       origin: the second moved into a file on 2026-09-22 because a run step
       may not exceed 21,000 characters and GitHub stops LOADING a workflow
       past that. */
    const publisher =
      read('.github/workflows/publish-club-arena.yml') +
      read('.github/scripts/publish-origin-activate.sh');
    expect(publisher).toContain("find dist -name '*.map' -delete");
    expect(publisher).toContain('source maps survived the strip');
    expect(publisher).toContain(`find "$ROOT/pool" -type f -name '*.map' -delete`);
  });
  it('retains exact application release identity', () => {
    expect(read('.github/workflows/publish-club-arena.yml')).toContain(
      'VITE_APP_VERSION: ${{ needs.publish-needed.outputs.target_sha }}'
    );
  });
});
