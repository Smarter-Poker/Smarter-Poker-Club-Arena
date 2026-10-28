import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
describe('committed public stats delivery', () => {
  it('physical tables release the summary after authoritative commit and lifecycle validation', () => {
    const s = source('server/src/engine/ServerTableEngineSettlement.ts');
    const summary = s.indexOf('if (result.publicStatsFrame)');
    expect(summary).toBeGreaterThan(
      s.lastIndexOf('if (!this.lifecycleCanMutate()) return;', summary)
    );
    expect(s.lastIndexOf('authoritativeCommitSucceeded', summary)).toBeGreaterThan(0);
    const h = source('server/src/services/supabase/handHistory.ts');
    expect(h).toContain('const publicFrame = inserted.settlementCommitted');
    expect(h).toContain('params.atomicCommit.acceptedPostCommitFacts?.stats_facts?.facts');
  });
  it('Lightning sends a committed result to watchers and early-folded participants', () => {
    const s = source('server/src/lightning/LightningHandHost.ts');
    const start = s.indexOf('const publicFrame = publicHandStatsFrame');
    expect(s.lastIndexOf('if (out.ok)', start)).toBeGreaterThan(0);
    const block = s.slice(start, s.indexOf('// EVERY LIGHTNING HAND', start));
    expect(block).toContain('this.emitAll(publicFrame)');
    expect(block).toContain('!this.watching.has(participant.playerId)');
    expect(block).toContain('participant.poolSessionId');
  });
});
