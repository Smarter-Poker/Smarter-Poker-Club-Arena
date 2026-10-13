import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  qualifyRakeReportHistory,
  rakeReportRequest,
  RAKE_REPORT_MIGRATION,
} from '../scripts/ci/rake-report-history-baseline.mjs';

const installed = {
  rows: [{ exact: true, helper_exact: true, helper_private: true, writers_exact: true }],
};
const first = { club_id: '11111111-1111-1111-1111-111111111111', day: '2026-10-01' };
const second = { ...first, day: '2026-10-02' };
const marker = { rows: [{ complete: true, computed_at: '2026-10-13T12:00:00Z' }] };
function client(days = [first, second]) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce({ rows: days })
      .mockResolvedValueOnce({ rows: [{ rows: 2 }] })
      .mockResolvedValueOnce(marker)
      .mockResolvedValueOnce({ rows: [{ rows: 2 }] })
      .mockResolvedValueOnce(marker),
  };
}

describe('explicit rake report history qualification', () => {
  it('refuses a different migration or a combined recovery operation', () => {
    expect(rakeReportRequest('other.sql', false, null, null)).toBe(false);
    expect(() => rakeReportRequest('other.sql', true, null, null)).toThrow('exact migration');
    expect(() => rakeReportRequest(RAKE_REPORT_MIGRATION, true, {}, null)).toThrow();
    expect(() => rakeReportRequest(RAKE_REPORT_MIGRATION, true, null, {})).toThrow();
    expect(rakeReportRequest(RAKE_REPORT_MIGRATION, true, null, null)).toBe(true);
  });
  it('requires exact installed bytes and a private exact helper before any writes', async () => {
    for (const field of ['exact', 'helper_exact', 'helper_private', 'writers_exact']) {
      const c = client();
      c.query
        .mockReset()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ ...installed.rows[0], [field]: false }] });
      await expect(qualifyRakeReportHistory(c, 'source', false, vi.fn())).rejects.toThrow(
        'not installed'
      );
      expect(c.query).toHaveBeenCalledTimes(2);
    }
  });
  it('qualifies each day once in its own transaction and reads its durable marker', async () => {
    const c = client();
    const log = vi.fn();
    await qualifyRakeReportHistory(c, 'source', false, log);
    expect(c.query).toHaveBeenCalledTimes(7);
    expect(c.query.mock.calls[3][1]).toEqual([first.club_id, first.day]);
    expect(c.query.mock.calls[4][1]).toEqual([first.club_id, first.day]);
    expect(c.query.mock.calls[5][1]).toEqual([second.club_id, second.day]);
    expect(c.query.mock.calls[6][1]).toEqual([second.club_id, second.day]);
    expect(c.query.mock.calls.map(([q]) => q).join('\n')).not.toMatch(/\bBEGIN\b/);
    expect(log.mock.calls.at(-1)?.[0]).toContain('every day in this finite plan committed');
  });
  it('dry run verifies the bounded plan without calling the writer', async () => {
    const c = client();
    await qualifyRakeReportHistory(c, 'source', true, vi.fn());
    expect(c.query).toHaveBeenCalledTimes(3);
    expect(c.query.mock.calls[0][0]).toContain('SET jit=off');
    expect(c.query.mock.calls[0][0]).toContain("statement_timeout='5s'");
  });
  it('stops on an unknown write acknowledgment without retrying or advancing', async () => {
    const c = client();
    c.query
      .mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce({ rows: [first, second] })
      .mockRejectedValueOnce(new Error('connection lost'));
    await expect(qualifyRakeReportHistory(c, 'source', false, vi.fn())).rejects.toThrow(
      'connection lost'
    );
    expect(c.query).toHaveBeenCalledTimes(4);
  });
  it('stops when the committed marker is unreadable or invalidated', async () => {
    const c = client();
    c.query
      .mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce({ rows: [first, second] })
      .mockResolvedValueOnce({ rows: [{ rows: 2 }] })
      .mockResolvedValueOnce({ rows: [{ complete: false }] });
    await expect(qualifyRakeReportHistory(c, 'source', false, vi.fn())).rejects.toThrow(
      'do not retry blindly'
    );
    expect(c.query).toHaveBeenCalledTimes(5);
  });
  it('refuses a plan beyond its finite installation budget before any writer runs', async () => {
    const c = client(Array.from({ length: 1025 }, () => first));
    await expect(qualifyRakeReportHistory(c, 'source', false, vi.fn())).rejects.toThrow('1024-day');
    expect(c.query).toHaveBeenCalledTimes(3);
  });
  it('stops at the operation deadline without sending another day', async () => {
    const c = client();
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(600001);
    try {
      await expect(qualifyRakeReportHistory(c, 'source', false, vi.fn())).rejects.toThrow(
        'budget exhausted'
      );
      expect(c.query).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });
  it('is wired only to the existing explicit installer and dispatch workflow', () => {
    const script = readFileSync('scripts/ci/apply-recorded-migration.mjs', 'utf8');
    const workflow = readFileSync('.github/workflows/apply-merged-migration.yml', 'utf8');
    expect(script).toContain('await qualifyRakeReportHistory(client, sql, DRY_RUN)');
    expect(workflow).toContain('recovery_args+=(--qualify-rake-report-history)');
    expect(workflow).toContain('qualify_rake_report_history:');
    expect(workflow).not.toContain('schedule:');
    expect(script).not.toContain('import { rakeReportRequest, qualifyRakeReportHistory }');
    expect(script).toContain("if (args.includes('--qualify-rake-report-history'))");
    expect(script).toContain("await import('./rake-report-history-baseline.mjs')");
    const fixture = readFileSync(
      'scripts/dev/qualify-rake-report-installation-fixture.mjs',
      'utf8'
    );
    expect(fixture).toContain("['../../', '../../server/']");
    expect(fixture).toContain("installed.version !== locked.packages['node_modules/pg']?.version");
    expect(fixture).toContain(
      "realpathSync(packagePath).startsWith(resolve(ownerRoot, 'node_modules') + '/')"
    );
  });
});
