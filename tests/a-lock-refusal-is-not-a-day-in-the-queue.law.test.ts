/**
 * A LOCK REFUSAL IS NOT A DAY IN THE QUEUE (2026-10-19)
 *
 * Thirteen Midway Union cash rake receipts were refused once by a lock
 * (deadlock 40P01 on two clubs' agent-commission keys, lock timeout 55P03) and
 * then waited up to 28 hours in accounting_cash_source_work, because
 * fn_retry_cash_accounting_sources took five rows a cycle oldest-due first and
 * ~900 sources still waiting on commission attribution were older. The union's
 * week could not certify (union_cash_sources_do_not_match_bank). The same day
 * the week's original inventory seal wrote one 17,000-row page per five-minute
 * close tick, 21 hours from done, and the engine's 8 s probe of
 * fn_union_settlement_cascade_due ran the full scope scan and was cancelled.
 * Pinned on 20261019102410:
 *   - a deadlocked cash source is retried inside its own subtransaction, at
 *     most three times, before it is refused;
 *   - a lock refusal that remains is due again in seconds, not minutes;
 *   - the retry queue takes the fewest refusals first, in its key walk and loop;
 *   - the seal writes several bounded pages a call, inside a 384 MB WAL span,
 *     45 s and 64 pages, and still publishes on a later call;
 *   - the engine's bounded probe visits no scope and leaves the close to job 272.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261019102410_a_transient_cash_refusal_is_retried_first_and_the_seal_write.sql',
  'utf8'
);

const fn = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = sql.indexOf('END $function$;', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
};

describe('a lock refusal is not a day in the queue', () => {
  it('is one guarded transaction replacing four exact preimages', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    for (const [name, before, after] of [
      [
        'fn_process_cash_accounting_source',
        'b7fc736283913d209244082467eae64c',
        '460e4b0a936b41246548cb0a9efc9f7f',
      ],
      [
        'fn_retry_cash_accounting_sources',
        '3788581d5e8f1953663b8929b4688d0a',
        '0ab1bf9282426f348c034785513724e0',
      ],
      [
        'fn_union_pnl_inventory_seal_advance',
        'c8fde7360b3696f1e11db11613e91ba6',
        'c2550f8714fede1047ed2efcf396d697',
      ],
      [
        'fn_union_settlement_cascade_due',
        '3b3c3281bc9a51f3acf79039c17b8f2b',
        '9b9b4ad4bd11c9456ddf1e63509b6780',
      ],
    ]) {
      expect(sql).toContain(
        `<>'${before}'\n THEN RAISE EXCEPTION 'cash_retry_exact_preimage_required:%','${name}'`
      );
      expect(sql).toContain(
        `<>'${after}'\n THEN RAISE EXCEPTION 'cash_retry_exact_postimage_required:%','${name}'`
      );
    }
    expect(sql).toContain(
      "pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))"
    );
    expect(sql).toContain(
      "pg_try_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0))"
    );
    expect(sql).toContain('public.fn_ca_break_window_refuses_migrations(now())');
    expect(sql.replace(/--[^\n]*/g, ' ')).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
  });

  it('a deadlocked cash source is retried inside its own subtransaction, at most three times', () => {
    const body = fn('fn_process_cash_accounting_source');
    expect(body).toContain(' <<item>> LOOP\n v_try:=v_try+1;\n BEGIN\n');
    expect(body).toContain(
      " EXIT item WHEN status_value IS DISTINCT FROM 'blocked' OR v_terminal OR state_value IS DISTINCT FROM '40P01' OR v_try>=3;"
    );
    expect(body).toContain(' END LOOP item;\n scope:=public.fn_cash_source_refusal_scope(r.id);');
    // The receipt and work row are still written once, after the loop.
    expect(body.split('INSERT INTO public.accounting_cash_source_receipts').length).toBe(2);
    expect(body.split('INSERT INTO public.accounting_cash_source_work').length).toBe(2);
    expect(body).toContain(
      "WHEN status_value='blocked' AND state_value IN('40P01','55P03','40001') THEN clock_timestamp()+make_interval(secs=>LEAST(300,15*next_attempt)::int)"
    );
    expect(body).toContain(
      'ELSE clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int) END)'
    );
  });

  it('the retry queue takes the fewest refusals first, in its key walk and its loop', () => {
    const body = fn('fn_retry_cash_accounting_sources');
    expect(body).toContain(
      'ORDER BY s.attempts,s.next_attempt_at,s.rake_record_id LIMIT p_limit))'
    );
    expect(body).toContain('ORDER BY attempts,next_attempt_at,rake_record_id LIMIT p_limit LOOP');
    expect(body).not.toContain('ORDER BY next_attempt_at,rake_record_id LIMIT');
    expect(body).toContain(
      "EXIT WHEN NOT pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));"
    );
  });

  it('the seal writes several bounded pages a call and publishes on a later call', () => {
    const body = fn('fn_union_pnl_inventory_seal_advance');
    const loop = body.slice(
      body.indexOf('  v_pages:=1;'),
      body.indexOf('  END LOOP;', body.indexOf('  v_pages:=1;'))
    );
    expect(loop).toContain(
      "EXIT WHEN v_pages>=64 OR clock_timestamp()>began+interval '45 seconds'"
    );
    expect(loop).toContain('OR pg_wal_lsn_diff(pg_current_wal_insert_lsn(),v_wal0)>=402653184;');
    expect(loop).toContain(
      'WHERE (s.o_kind,s.o_source_name,s.o_row_id,s.o_event_id)>(c_kind,c_source,c_row,c_event));'
    );
    expect(loop).toContain('EXIT WHEN public.fn_union_pnl_inventory_seal_write_page(p_at,v_base);');
    expect(loop).not.toContain('union_pnl_inventory_checkpoints');
    expect(body).toContain(
      "RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'stage','committed_build_page','pages',v_pages);"
    );
    // Publication still follows only a call that wrote nothing.
    const publish = body.indexOf('INSERT INTO public.union_pnl_inventory_checkpoints');
    expect(publish).toBeGreaterThan(body.indexOf("'pages',v_pages);\n END IF;"));
    expect(body).toContain(' v_wal0 pg_lsn:=pg_current_wal_insert_lsn();');
  });

  it("the engine's bounded probe visits no scope and leaves the close to job 272", () => {
    const body = fn('fn_union_settlement_cascade_due');
    const guard = body.indexOf(
      "IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'"
    );
    expect(guard).toBeGreaterThan(body.indexOf('fn_caller_is_engine()'));
    expect(guard).toBeLessThan(body.indexOf('fn_midway_weekly_horse_promo_due()'));
    expect(body).toContain(
      "AND current_setting('statement_timeout')::interval<interval '60 seconds' THEN"
    );
    expect(body).toContain(
      "RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,"
    );
    expect(body).toContain("'deferred_to','union-weekly-rakeback-close');");
    expect(body).toContain('RETURN public.fn_process_weekly_accounting(NULL);');
  });
});
