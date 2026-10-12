/**
 * LAW: A DEFAULT CASHIER TOTAL READS ITS RANGE AS CONCURRENT SLICES (2026-10-11).
 *
 * fn_cashier_statement_totals answered owners and admins with HTTP 500
 * (57014, the 8 s statement timeout) whenever the disk was busy. The default
 * owner total (#6615) was already one set-based pass, index-only, but a cold
 * call read ~7,000 scattered leaf pages through one btree chain per source,
 * and a btree range scan cannot read ahead: each leaf names the next, and a
 * parallel index scan hands the same chain out in order (measured: seven
 * participants, 0.65 ms a page, the same as one). Shark Club's week cost
 * 3.8 s cold and 8.09 s while the hand-history prune ran.
 *
 * The fix cuts each source range into at most 16 consecutive slices, each its
 * own range scan, so a Parallel Append reads several chains at once, and lets
 * that one statement use up to six workers. Every other path stays #6615's.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const FIX = read(
  'supabase/migrations/20261011225840_cashier_totals_read_the_range_as_concurrent_slices.sql'
);
const BEFORE = read(
  'supabase/migrations/20261010011934_cashier_totals_count_directional_ranges_without_rescanning.sql'
);
const definition = (sql: string) => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(');
  return sql.slice(start, sql.indexOf('$function$;', start) + '$function$;'.length);
};
const NARROW = "  IF v_totals_only AND p_scope='all' AND v_wallet IS NULL";
const EXECUTE = '  RETURN QUERY EXECUTE v_sql';
const DECLARED =
  '  v_bounds timestamptz[];\n  v_slices integer;\n  v_slice integer;\n' +
  '  v_ranged text[] := ARRAY[]::text[];\n  v_workers text;\n';

describe('a default cashier total reads its range as concurrent slices', () => {
  const after = definition(FIX);
  const before = definition(BEFORE);

  it('one guarded transaction that replaces exactly #6615 and keeps its authority', () => {
    expect(FIX.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FIX.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FIX).toContain("SET LOCAL lock_timeout = '2s';");
    expect(FIX).toContain("<> '8a47b11b861fef1357ae8749d1370a11'");
    expect(FIX).toContain("<> '3e0925223743726b1f175b6da3ab0294'");
    expect(FIX).toContain('cashier_source_preimage_changed');
    expect(FIX).toContain('cashier_postimage_or_authority_changed');
    expect(FIX).toContain("to_jsonb(p) - 'prosrc'");
    expect(FIX).toMatch(/^-- @live-proof: /m);
    const body = FIX.replace(/--[^\n]*/g, '');
    expect(body).not.toMatch(/\b(?:DROP|GRANT|cron\.|statement_timeout|CREATE INDEX)\b/i);
    expect(body).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\b\s+(?:INTO\s+)?public\./i);
    expect(body).not.toMatch(/is_horse/);
  });

  it('changes only the default owner aggregate: every other byte is #6615', () => {
    const aStart = after.indexOf(NARROW);
    const aEnd = after.indexOf(EXECUTE, aStart);
    const bStart = before.indexOf(NARROW);
    const bEnd = before.indexOf(EXECUTE, bStart);
    expect(aStart).toBeGreaterThan(0);
    expect(bStart).toBeGreaterThan(0);
    expect(after.slice(0, aStart).replace(DECLARED, '')).toBe(before.slice(0, bStart));
    const tail = after
      .slice(aEnd)
      .replace(
        '          v_omitted,                                  -- $19 (totals, scope all)\n' +
          '          v_bounds;                                   -- $20 (default total slice bounds)\n' +
          '\n  IF v_workers IS NOT NULL THEN\n' +
          "    PERFORM set_config('max_parallel_workers_per_gather', v_workers, true);\n" +
          '  END IF;\n',
        '          v_omitted;                                  -- $19 (totals, scope all)\n'
      );
    expect(tail).toBe(before.slice(bEnd));
  });

  it('both sources are read slice by slice, and the omitted mirrors still use the whole range', () => {
    const narrow = after.slice(after.indexOf(NARROW), after.indexOf(EXECUTE));
    expect(narrow.match(/'\$20\[' \|\| v_slice \|\| '\]'/g)).toHaveLength(2);
    expect(narrow.match(/'\$20\[' \|\| \(v_slice \+ 1\) \|\| '\]'/g)).toHaveLength(2);
    expect(narrow).toContain(
      'FROM public.chip_transactions WHERE club_id=$1 AND created_at >= @LO@ AND created_at < @HI@$slice$'
    );
    expect(narrow).toContain(
      "FROM public.chip_ledger WHERE club_id=$1 AND created_at >= @LO@ AND created_at < @HI@ AND status='posted' AND category=ANY($17)$slice$"
    );
    expect(narrow).toContain(
      "created_at >= $3 AND created_at < $4 AND status='posted' AND category=ANY($17) AND id=ANY($19)"
    );
    expect(narrow).toContain(
      "FROM ($narrow$ || array_to_string(v_ranged, ' UNION ALL ') || $narrow$) ranged GROUP BY direction"
    );
  });

  it('the bounds partition [from, to) exactly: first is from, last is to, strictly increasing', () => {
    expect(after).toContain(
      'v_slices := least(16, greatest(1, ceil(extract(epoch FROM p_to - p_from) / 43200.0)::integer));'
    );
    expect(after).toContain('CASE WHEN g = v_slices THEN p_to');
    expect(after).toContain('FROM generate_series(0, v_slices) g;');
    // The same arithmetic, in seconds, across the ranges the page offers.
    for (const seconds of [1, 3600, 43200, 43201, 86400, 7 * 86400, 30 * 86400, 92 * 86400]) {
      const slices = Math.min(16, Math.max(1, Math.ceil(seconds / 43200)));
      const bounds = Array.from({ length: slices + 1 }, (_, g) =>
        g === slices ? seconds : (seconds * g) / slices
      );
      expect(bounds[0]).toBe(0);
      expect(bounds[slices]).toBe(seconds);
      for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
    }
  });

  it('more workers only for that one statement, and the setting is put back', () => {
    const narrow = after.slice(after.indexOf(NARROW), after.indexOf(EXECUTE));
    expect(narrow).toContain("v_workers := current_setting('max_parallel_workers_per_gather');");
    expect(narrow).toContain("PERFORM set_config('max_parallel_workers_per_gather', '6', true);");
    const restore = after.indexOf(
      "PERFORM set_config('max_parallel_workers_per_gather', v_workers, true);"
    );
    expect(restore).toBeGreaterThan(after.indexOf(EXECUTE));
  });
});
