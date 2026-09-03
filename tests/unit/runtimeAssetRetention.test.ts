import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
/**
 * Club Arena runtime asset retention (rewritten 2026-09-03).
 *
 * The rule: a player whose tab still holds the previous index.html must be
 * able to fetch the previous hashed assets, or a mid-hand chunk load 404s.
 * The World Hub sync kept one earlier generation via
 * scripts/ci/sync-club-arena-dist.mjs. That script is gone with the sync;
 * the static origin keeps an ADDITIVE pool of hashed assets and fonts,
 * pruned by age only. This pins the three lines of the publisher that make
 * that true.
 */
describe('Club Arena runtime asset retention', () => {
  it('the origin keeps previous generations: the pool is additive and pruned by age only', async () => {
    // 2026-09-03: dist/ no longer goes through sync-club-arena-dist.mjs into
    // the World Hub. The origin serves /assets/* and /fonts/* from an
    // additive pool; the release directory is swapped underneath. The rule
    // this file exists for - a player holding the previous index.html can
    // still fetch the previous hashed assets - now lives in three lines of
    // the publish step: no --delete on the pool syncs, and a prune by mtime.
    const workflow = await readFile(
      path.join(process.cwd(), '.github', 'workflows', 'publish-club-arena.yml'),
      'utf8'
    );
    const poolSyncs =
      workflow.match(
        /rsync -az -e "ssh \$SSHOPTS" dist\/(assets|fonts)\/ [^\n]*pool\/(assets|fonts)\//g
      ) ?? [];
    expect(poolSyncs).toHaveLength(2);
    for (const line of poolSyncs) expect(line).not.toContain('--delete');
    expect(workflow).toMatch(/find pool -type f -mtime \+30 -delete/);
    expect(workflow).not.toContain('sync-club-arena-dist.mjs');
  });
});
