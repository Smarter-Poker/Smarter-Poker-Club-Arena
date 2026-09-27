import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = 'tests/fixtures/mixed-rake-period/request-lock/';
const read = (p: string) => readFileSync(p, 'utf8');
const baseline = JSON.parse(read(`${dir}baseline.json`));
const after = read(`${dir}wrapper-after.sql`).slice(0, -2);
const migration = read(
  'supabase/migrations/20260927154806_open_week_pages_lock_the_recompute_request_after_calculation.sql'
);
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('open-week page request lock', () => {
  it('retains exact captured financial, recognition and authority owners', () => {
    for (const fn of baseline.functions) {
      expect(md5(fn.definition)).toBe(fn.md5);
      expect(read(`${dir}${fn.name}.sql`)).toBe(`${fn.definition};\n`);
      expect(migration).toContain(fn.md5);
    }
    expect(migration).toContain(baseline.recognition_week_lock.md5);
    expect(migration).not.toMatch(/GRANT\s|REVOKE\s|CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  });
  it('keeps the original calculator, private scope and durable result contract', () => {
    expect(after).toContain(
      'result:=public.fn_calculate_cash_rakeback_periods(p_club_id,p_period_start,p_period_end,p_user_ids);'
    );
    expect(after).toContain(
      "WHEN result->>'status'='ready' AND p_user_ids IS NULL THEN 'complete'"
    );
    expect(after).toContain("WHEN result->>'status'='ready' THEN 'pending' ELSE 'blocked' END");
    expect(after).toContain("SET statement_timeout TO '300s'");
    expect(after).toContain('clock_timestamp()>=v_from AND clock_timestamp()<v_to');
    expect(after).toContain('attempts=attempts+1,last_result=result WHERE id=request.id');
    expect(after).toContain("'request_id',request.id,'requested_at',request.requested_at");
  });
  it('binds live proof and installation refusal to the exact candidate and table authority', () => {
    expect(migration).toContain(`='${md5(after)}' AS present`);
    expect(migration).toContain(`IS DISTINCT FROM '${md5(after)}'`);
    expect(migration).toContain('OPEN_WEEK_REQUEST_TABLE_CHANGED');
    expect(migration).toContain('i.indimmediate AND i.indisvalid AND i.indisready AND i.indislive');
    expect(migration).toContain("proacl::text='{postgres=X/postgres,service_role=X/postgres}'");
  });
  it('runs real concurrency and rollover qualification in the existing required accounting job', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain(
      'run: python3 tests/fixtures/mixed-rake-period/request-lock/native.py'
    );
    const native = read(`${dir}native.py`);
    for (const phrase of [
      'baseline original request-row order blocks actual terminal recognizer',
      'actual terminal recognizer commits while the page calculation remains blocked',
      'concurrent duplicate page reuses the certificate',
      'definite canceled call leaves no attempted result',
      'week rolled over while waiting',
      'production NOSUPERUSER BYPASSRLS owner',
    ])
      expect(native).toContain(phrase);
    expect(native).toContain("file(FIX/'adapters.sql')");
    expect(read(`${dir}adapters.sql`)).toContain('this does not certify these');
  });
});
