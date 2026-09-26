import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  PERIOD_RECOMPUTE_SERVER_BUDGET_MS,
  periodRecomputeClientTimeoutMs,
} from '../server/src/services/cashAccountingBatchBudget';

/**
 * THE PERIOD RECOMPUTE OUTLIVES ITS SERVER (2026-09-26).
 *
 * `fn_rakeback_recompute_periods` rebuilds a whole (club, week) rakeback book
 * and declares a 300-second server statement_timeout. The settler called it
 * through the 15-second hand client. On 2026-09-26 the call for Deep Stack
 * Society week 2026-09-21 ran 137 s on the server and COMMITTED, while the
 * client reported `supabase_timeout` at 15 s; the settler counted 46 failures,
 * held its cursor, and `daemon_state.rakeback_settler` sat at
 * 2026-09-22 10:37:05 for 3.6 days with 234,593 rake_records behind it.
 *
 * A client that gives up before the server finishes turns committed work into
 * a reported failure. This law keeps the recompute's client deadline derived
 * from - and strictly longer than - the budget the SQL itself declares.
 */
const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

function createDefinitions(): Array<{ file: string; seconds: number | null }> {
  const dirs = ['supabase/migrations', 'supabase/accounting/weekly-v3/components'];
  const out: Array<{ file: string; seconds: number | null }> = [];
  for (const dir of dirs) {
    for (const name of readdirSync(resolve(root, dir))) {
      if (!name.endsWith('.sql')) continue;
      const sql = readFileSync(resolve(root, join(dir, name)), 'utf8');
      const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_rakeback_recompute_periods\s*\(/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql))) {
        const head = sql.slice(m.index, sql.indexOf('$', m.index + 1));
        const t = /statement_timeout\s*(?:=|TO)\s*'(\d+)s'/i.exec(head);
        out.push({ file: name, seconds: t ? Number(t[1]) : null });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe('the period recompute outlives its server', () => {
  it('names the budget the latest SQL definition declares', () => {
    const defs = createDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    const latest = defs[defs.length - 1];
    expect(latest.seconds, `${latest.file} must declare its statement_timeout`).not.toBeNull();
    expect(latest.seconds! * 1000).toBe(PERIOD_RECOMPUTE_SERVER_BUDGET_MS);
  });

  it('waits strictly longer than the server works, and never less than any call', () => {
    const client = periodRecomputeClientTimeoutMs();
    expect(client).toBeGreaterThan(PERIOD_RECOMPUTE_SERVER_BUDGET_MS);
    expect(client).toBeGreaterThanOrEqual(DEFAULT_CLIENT_TIMEOUT_MS);
    // An unreadable budget is not a generous one.
    expect(periodRecomputeClientTimeoutMs(Number.NaN)).toBe(DEFAULT_CLIENT_TIMEOUT_MS);
    expect(periodRecomputeClientTimeoutMs(0)).toBe(DEFAULT_CLIENT_TIMEOUT_MS);
  });

  it('builds the recompute client from that derivation, not a literal', () => {
    const client = read('server/src/services/supabase/client.ts');
    expect(client).toMatch(
      /export const accountingPeriodSupabase:\s*SupabaseClient\s*=\s*createBoundedServiceClient\(\s*periodRecomputeClientTimeoutMs\(\)\s*\)/
    );
  });

  it('calls fn_rakeback_recompute_periods only through the recompute client', () => {
    const settler = read('server/src/services/RakebackSettlerService.ts');
    expect(settler).toMatch(/accountingPeriodSupabase\.rpc\(\s*'fn_rakeback_recompute_periods'/);
    expect(settler).not.toMatch(/\bsupabase\.rpc\(\s*'fn_rakeback_recompute_periods'/);
    // Through the barrel, never the client module (four suites mock the barrel).
    expect(settler).toMatch(
      /import\s*\{[^}]*accountingPeriodSupabase[^}]*\}\s*from\s*'\.\/supabase\.js'/
    );
  });
});
