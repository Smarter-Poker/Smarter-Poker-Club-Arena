import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * LAW: a realtime subscription on a high-volume table must not call a full
 * reload once per row.
 *
 * Measured in production on 2026-09-01 via pg_stat_statements:
 *   - Supabase Realtime's WAL decode + RLS check was 13% of ALL database time
 *     (50,739 seconds across 96,968 batches, 523ms mean).
 *   - agent_commissions is the highest-write table in the supabase_realtime
 *     publication: 1,878,396 lifetime writes, 1,539,684 rows since 2026-05-01,
 *     averaging 0.40 chips each. It is a PER-HAND ledger.
 *   - SettlementDashboardPage subscribed to every INSERT on it, platform-wide,
 *     with no filter and no debounce, calling loadData() directly - while the six
 *     masterBus subscriptions immediately above it were all debounced 500-2000ms.
 *
 * The in-flight guard inside loadData() dropped overlapping reloads, so this was
 * never as bad on the client as it looks. That is exactly why it survived: it was
 * invisible from the outside. The cost was real anyway, and a settlement dashboard
 * does not need per-hand granularity to be correct.
 *
 * The dashboard now delegates to scoped weekly records and a status observer.
 * Preserve the no-per-hand-reload rule across that real read boundary without
 * requiring the retired commission subscription or its debounce timer.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const page = code('src/pages/SettlementDashboardPage.tsx');
const workspace = code('src/components/accounting/WeeklyAccountingWorkspace.tsx');
const summary = code('src/components/accounting/ClubWeeklyAccountingSummary.tsx');
const reader = code('src/services/ClubWeeklyAccountingReader.ts');
const status = code('src/components/agent/UnionAccountingRunStatus.tsx');
const observation = code('src/hooks/useAccountingRunObservation.ts');
const boundary = [page, workspace, summary, reader, status, observation];

describe('LAW: weekly accounting does not reload on per-hand ledger events', () => {
  it('the dashboard reads scoped weekly summaries and status without a commission firehose', () => {
    expect(page).toMatch(
      /<WeeklyAccountingWorkspace\s+key=\{`\$\{scopeClubId\}:\$\{user\.id\}`\}\s+scopeKind="club"\s+scopeRef=\{scopeClubId\}/
    );
    expect(workspace).toMatch(
      /scopeKind\s*===\s*'club'\s*\?\s*\(\s*<ClubWeeklyAccountingSummary\s+key=\{`\$\{id\}:\$\{user\.id\}`\}\s+clubId=\{id\}/
    );
    expect(summary).toMatch(
      /readClubWeeklyStatements\(\{\s*clubId,\s*userId:\s*user\.id,\s*limit:\s*CLUB_WEEKLY_STATEMENT_LIMIT,\s*isCurrent:\s*current\s*,?\s*\}\)/
    );
    expect(reader).toMatch(
      /\.eq\('club_id',\s*clubId\)\s*\.eq\('invoice_type',\s*CLUB_WEEKLY_INVOICE_TYPE\)/
    );
    expect(workspace).toMatch(
      /<AccountingRunStatus\s+key=\{`\$\{id\}:\$\{user\.id\}:\$\{ending\}`\}\s+scopeKind=\{scopeKind\}\s+scopeId=\{id\}/
    );
    expect(status).toMatch(/useAccountingRunObservation\(input\)/);
    for (const src of boundary) {
      expect(src).not.toMatch(
        /agent_commissions|postgres_changes|\.channel\s*\(|getOrCreateChannel\s*\(/
      );
    }
    // Auth changes invalidate the account, but hand/ledger events cannot reload
    // this observer. Pin the complete direct bus subscription inventory.
    expect(
      boundary.flatMap((src) =>
        [...src.matchAll(/masterBus\.subscribe(?:Debounced)?\(\s*'([^']+)'/g)].map(
          (match) => match[1]
        )
      )
    ).toEqual(['AUTH_STATE_CHANGED']);
  });

  it('refreshes explicitly and invalidates pending reads on cleanup without a reload timer', () => {
    for (const src of boundary) {
      expect(src).not.toMatch(/commissionReloadTimer|\bsetTimeout\s*\(|\bsetInterval\s*\(/);
    }
    expect(summary).toMatch(/onClick=\{\(\)\s*=>\s*void refresh\(\)\}/);
    expect(status).toMatch(/onClick=\{refresh\}/);
    expect(summary).toMatch(
      /const current\s*=\s*\(\)\s*=>\s*scope\(\)\s*&&\s*sequence\.current\s*===\s*read/
    );
    expect(summary).toMatch(/return\s*\(\)\s*=>\s*\{\s*\+\+sequence\.current;\s*\}/);
    expect(observation).toMatch(
      /readAccountingRunObservation\(\{\s*\.\.\.input,\s*isCurrent:\s*\(\)\s*=>\s*active\s*&&\s*isCurrent\(\)\s*,?\s*\}\)/
    );
    expect(observation).toMatch(/if\s*\(active\s*&&\s*isCurrent\(\)\)\s*setState\(/);
    expect(observation).toMatch(/return\s*\(\)\s*=>\s*\{\s*active\s*=\s*false;\s*\}/);
  });
});
