/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RAKE ATTRIBUTION RETRIES INSIDE ITS OWN TRANSACTION (2026-09-09)
 *  CLAUDE.md 10.12 - "retried inside its own transaction ... not swept up an
 *  hour later by somebody else"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured over the seven days before this landed: 77,627 tournament rake
 * settlements, every one eventually attributed - 435 of them only by the
 * repair sweep, 21 minutes late on average, worst 6.9 hours. 474 alerts:
 * 336 deadlocks, 133 lock timeouts. Until attribution lands nobody in the
 * event has VIP points, agent commission or a rakeback basis (10.5).
 *
 * The attribution walks players in uid order so two settlements cannot
 * deadlock each other, but live cash hands lock the same players' rows in
 * hand order, and a 200-player walk collides with live play. The failed
 * attempt was already a subtransaction that rolled back cleanly; it just never
 * tried again. Now it retries exactly the two transient SQLSTATEs, bounded,
 * and stamps attributed_at in the same call.
 *
 * This law pins the shape so the retry cannot quietly become unbounded, catch
 * everything, or disappear.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const SQL = read(
  'supabase/migrations/20260909202824_tournament_rake_attribution_retries_inside_its_own_transaction.sql'
);
const body = SQL.slice(SQL.indexOf('LOOP'), SQL.indexOf('END LOOP;'));

describe('the attribution is retried inside the settle', () => {
  it('is a loop of subtransactions, not a single attempt', () => {
    expect(SQL).toMatch(
      /LOOP\s+v_attempt := v_attempt \+ 1;\s+BEGIN\s+v_att := public\.fn_attribute_tournament_rake/
    );
    expect(SQL).toContain('END LOOP;');
  });

  it('retries exactly the two transient lock classes, and nothing else', () => {
    expect(body).toContain('WHEN deadlock_detected OR lock_not_available THEN');
    // everything else fails once, alerts, and exits - as before
    expect(body).toMatch(/WHEN OTHERS THEN[\s\S]*?EXIT;/);
    const others = body.slice(body.indexOf('WHEN OTHERS THEN'));
    expect(others).not.toContain('pg_sleep');
  });

  it('is bounded: four attempts, back-off totalling one second', () => {
    expect(body).toContain('IF v_attempt >= 4 THEN');
    expect(body).toContain(
      'PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);'
    );
  });

  it('still alerts when the retries are exhausted - the net stays, expected to find nothing', () => {
    const exhausted = body.slice(body.indexOf('IF v_attempt >= 4 THEN'), body.indexOf('pg_sleep'));
    expect(exhausted).toContain("'Rake settled but attribution failed: '");
    expect(exhausted).toContain("'sqlstate', v_state, 'attempts', v_attempt");
  });

  it('stamps attributed_at in the same call on success, never leaving it to a cron', () => {
    expect(SQL).toContain('attributed_at = CASE WHEN v_done THEN now() ELSE NULL END');
    expect(SQL).toContain("'attribution_attempts', v_attempts");
  });

  it('keeps the settle itself untouched: the lock order note and NO KEY UPDATE survive', () => {
    expect(SQL).toContain(
      'PERFORM 1 FROM public.club_wallets WHERE club_id = v_t.club_id FOR NO KEY UPDATE;'
    );
    expect(SQL).toContain('FOR NO KEY UPDATE;\n  /* NO KEY UPDATE, not UPDATE (20260906)');
  });

  it('asserts its own shape at apply time and refuses browser roles', () => {
    expect(SQL).toContain(
      "IF v_src NOT LIKE '%WHEN deadlock_detected OR lock_not_available THEN%' THEN"
    );
    expect(SQL).toContain("IF v_src NOT LIKE '%IF v_attempt >= 4 THEN%' THEN");
    expect(SQL).toContain(
      "has_function_privilege('anon', 'public.fn_settle_tournament_rake(uuid,text)', 'EXECUTE')"
    );
  });

  it('is one transaction, per the production DDL policy', () => {
    expect(SQL.trim().startsWith('BEGIN;')).toBe(true);
    expect(SQL.trim().endsWith('COMMIT;')).toBe(true);
  });
});
