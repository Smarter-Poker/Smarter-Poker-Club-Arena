import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionBuyInTotal } from '../../src/utils/sessionBuyInTotal';

describe('a session result counts what was bought in', () => {
  it('after a reload the server figure replaces the stack placeholder', () => {
    // Bought in for 1,000, down to 700 when the phone woke: the placeholder
    // was 700 and the summary read break-even.
    expect(sessionBuyInTotal({ serverBaseline: 1000, totalAtAsk: 700, totalNow: 700 })).toBe(1000);
    expect(sessionBuyInTotal({ serverBaseline: '1010.00', totalAtAsk: 700, totalNow: 700 })).toBe(
      1010
    );
  });

  it('chips added in this tab after the ask are carried over, once', () => {
    expect(sessionBuyInTotal({ serverBaseline: 1000, totalAtAsk: 700, totalNow: 900 })).toBe(1200);
  });

  it('an answer that is not a positive number leaves the page figure alone', () => {
    for (const bad of [null, undefined, 'x', 0, -5, Number.NaN]) {
      expect(sessionBuyInTotal({ serverBaseline: bad, totalAtAsk: 700, totalNow: 750 })).toBe(750);
    }
  });

  it('the table page asks once per table and applies the answer', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');
    expect(src).toContain("supabase.rpc('fn_my_cash_session_baseline', { p_table_id: askedFor })");
    expect(src).toContain('sessionBaselineAskedRef.current !== askedFor');
    expect(src).toContain('totalBuyInRef.current = sessionBuyInTotal({');
  });

  it('the function is bound to the caller and closed to anon', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'supabase',
        'migrations',
        '20261006062341_a_player_can_read_what_they_bought_in_for.sql'
      ),
      'utf8'
    );
    expect(sql).toContain('WHERE s.player_id = auth.uid()');
    expect(sql).toContain('AND s.closed_at IS NULL');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_my_cash_session_baseline(uuid) FROM PUBLIC, anon;'
    );
    expect(sql).not.toMatch(/GRANT[^;]*fn_my_cash_session_baseline[^;]*\banon\b/i);
  });
});
