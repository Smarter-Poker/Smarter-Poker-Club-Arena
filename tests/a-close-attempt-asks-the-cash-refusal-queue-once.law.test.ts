/**
 * A CLOSE ATTEMPT ASKS THE CASH REFUSAL QUEUE ONCE (2026-10-03).
 *
 * Pinned on migration 20261003095444_a_close_attempt_asks_the_cash_refusal_queue_once.sql.
 * One union close attempt prepares its book twice (the scheduler, then the
 * cascade), and each preparation read the whole blocked refusal queue: 95 s
 * and 98 s in the 2026-10-01 Midway close. Inside one attempt a 'ready'
 * answer for the book is now reused by the second preparation; a blocked
 * answer, a standalone club attempt and every call outside an attempt still
 * ask the queue.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003095444_a_close_attempt_asks_the_cash_refusal_queue_once.sql'
  ),
  'utf8'
);

describe('a close attempt asks the cash refusal queue once', () => {
  it('is one transaction with live proofs', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(3);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('edits only the 2026-10-03 preimages, by exact anchors, and verifies each result', () => {
    expect(sql).toContain("IF md5(d)<>'7d3265c14419e519399d9273c940e299' THEN");
    expect(sql).toContain("IF md5(d)<>'130c004569f961aa6f312c4f2ed15961' THEN");
    expect(sql).toContain("IF md5(d)<>'60f06cac8b45e49447155914600f7ca6' THEN");
    expect(sql.match(/IF pg_get_functiondef\(s\)<>d THEN/g)?.length).toBe(3);
  });

  it('reuses only a ready answer, only inside a union close attempt, only for the same book', () => {
    expect(sql).toContain(
      "refusal_key:=COALESCE(p_union_id,p_club_id)::text||'|'||p_from::text||'|'||p_to::text;"
    );
    expect(sql).toContain("IF current_setting('app.accounting_close_memo',true)='on'");
    expect(sql).toContain(
      "AND current_setting('app.accounting_cash_refusal_memo',true)=refusal_key THEN"
    );
    expect(sql).toContain(
      "source_check:=jsonb_build_object('status','ready','count',0,'sources','[]'::jsonb);"
    );
    expect(sql).toContain(
      "AND source_check->'count'='0'::jsonb AND source_check->'sources'='[]'::jsonb THEN"
    );
    expect(sql).toContain(
      "PERFORM set_config('app.accounting_cash_refusal_memo',refusal_key,true);"
    );
    // Otherwise the queue is asked, as before.
    expect(sql).toContain(
      '  source_check:=public.fn_cash_source_refusals_for_period(p_union_id,p_club_id,p_from,p_to);'
    );
  });

  it('clears the memo where every other close memo is cleared', () => {
    expect(
      sql.match(/ PERFORM set_config\('app\.accounting_cash_refusal_memo','',true\);/g)?.length
    ).toBe(2);
  });

  it('changes no table, index, grant or schedule', () => {
    expect(sql).not.toMatch(/^\s*(CREATE|DROP)\s+(UNIQUE\s+)?INDEX/im);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\s/im);
    expect(sql).not.toMatch(/cron\.(schedule|alter_job|unschedule)\(/);
  });
});
