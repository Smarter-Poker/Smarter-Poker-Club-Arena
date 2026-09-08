/**
 * 2026-09-02 — three nightly jobs claimed a day, timed out, and lost it.
 *
 * MEASURED: daily_audit claimed 2026-09-01 at 06:03 UTC and died on
 * `supabase_timeout`; self_tuner claimed 2026-09-01 and 2026-09-02 and died on
 * `canceling statement due to statement timeout`. All three wrote nothing, and
 * nothing retried, so the audit row did not exist until an agent generated it
 * by hand 28 hours later and the fleet went two days untuned.
 *
 * The claim lock is NOT what held the day shut - claimNightlyJob has taken
 * over a stale claim with no rows since 2026-08-30. What held it shut was the
 * in-process memo: both services set it on the STAND-DOWN path, so after a
 * failure the next tick returned before it could ever re-ask for the claim.
 * With one engine container, that memo is the whole world.
 *
 * These pin the two halves: a failed run reports failure, and neither
 * stand-down branch marks the day done.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpcMock = vi.fn();

vi.mock('./supabase/client.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      insert: async () => ({ error: null }),
    }),
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

describe('a nightly job that fails must report failure', () => {
  beforeEach(() => rpcMock.mockReset());

  it('runDailyAudit returns false when the RPC times out', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'supabase_timeout' } });
    const mod = await import('./HorseDailyAudit.js');
    await expect(mod.runDailyAudit('2026-09-01')).resolves.toBe(false);
  });

  it('runDailyAudit returns true when the RPC answers', async () => {
    rpcMock.mockResolvedValue({ data: { findings: 44 }, error: null });
    const mod = await import('./HorseDailyAudit.js');
    await expect(mod.runDailyAudit('2026-09-01')).resolves.toBe(true);
  });
});

describe('standing down must never mark the day done', () => {
  const read = (f: string): string =>
    readFileSync(join(__dirname, f), 'utf8').replace(/\r\n/g, '\n');

  /** The stand-down branch, from its `if` to its `return`. */
  const standDownBlock = (src: string, claimCall: string): string => {
    const claim = src.indexOf(claimCall);
    expect(claim).toBeGreaterThan(-1);
    const start = src.indexOf('if (!claimed)', claim);
    expect(start).toBeGreaterThan(claim);
    const end = src.indexOf('return;', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('HorseDailyAudit does not set lastAuditedDay when the claim is lost', () => {
    const block = standDownBlock(
      read('HorseDailyAudit.ts'),
      "const claimed = await claimNightlyJob('daily_audit', target)"
    );
    expect(block).not.toContain('lastAuditedDay = target');
  });

  it('HorseSelfTuner does not set lastRunDate when the claim is lost', () => {
    const block = standDownBlock(
      read('HorseSelfTuner.ts'),
      "const claimed = await claimNightlyJob('self_tuner', today)"
    );
    expect(block).not.toContain('lastRunDate = today');
  });

  it('HorseDailyAudit only records the day after a run that succeeded', () => {
    const src = read('HorseDailyAudit.ts');
    expect(src).toContain('const completed = await runDailyAudit(target);');
    expect(src).toMatch(/if \(completed\) \{\s*lastAuditedDay = target;/);
  });

  it('HorseSelfTuner only records the day after durable tune output exists', () => {
    const src = read('HorseSelfTuner.ts');
    const run = src.indexOf('await runSelfTune(today');
    const proof = src.indexOf('const completed = await alreadyTunedToday(today);', run);
    const latch = src.indexOf('if (completed) lastRunDate = today;', proof);
    expect(run).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(run);
    expect(latch).toBeGreaterThan(proof);
    expect(src.slice(run, latch)).not.toContain('lastRunDate = today');
  });
});
