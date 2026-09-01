/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  "THE CHIPS DO NOT ADD UP" IS NOT A DIAGNOSIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_spin_chip_conservation_check found the drift. It could not say which of
 * two very different things had happened, and the difference is everything:
 *
 *   LOST FINAL WRITE - the engine's own last hand ends on the RIGHT total and
 *   tournament_players holds a different one. The play was correct; only the
 *   record is wrong. Nothing repairs it, because during a tournament the next
 *   hand's settlement rewrites both copies and a completed tournament has no
 *   next hand. fn_reconcile_tournament_denormals does not touch chips at all.
 *
 *   CHIPS MOVED IN PLAY - the engine's own last hand AGREES with the wrong
 *   total. Chips were really created or destroyed at the table and the engine
 *   never knew. This is the serious one.
 *
 * On the 12 drifted games in the five hours after the creditSeatStacks mint
 * fix: 2 lost writes, 10 chips-moved-in-play, and all ten of the second kind
 * started between 00:31 and 00:41 straddling a 39-second board-wide dealing
 * gap - an engine restart (issue #2406).
 *
 * Working that out took a hand-written query against hand_history. Nobody
 * reading an alert at 3am should have to repeat it, so the check now does it
 * and reports the counts.
 *
 * This test pins the comparison, because the tempting simplification - drop
 * the hand_history join, it's expensive - silently turns the alert back into
 * "something is wrong somewhere".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = resolve(
  __dirname,
  '../../supabase/migrations/20260901101500_chip_guard_classifies_the_drift.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');
const body = sql.slice(sql.indexOf('AS $function$'), sql.indexOf('$function$;'));
/** `--` comments stripped, so prose about a filter is not a filter. */
const code = sql
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

describe('the chip guard says which kind of wrong', () => {
  it('compares each sampled game against its own last hand', () => {
    expect(body).toMatch(/FROM public\.hand_history h/);
    expect(body).toMatch(/ORDER BY h2\.hand_number DESC LIMIT 1/);
    expect(body).toMatch(/sum\(\(p->>'stack'\)::numeric\)/);
  });

  it('separates a lost write from chips that really moved', () => {
    expect(body).toMatch(/last_hand = expected AND last_hand <> actual/);
    expect(body).toMatch(/last_hand = actual AND last_hand <> expected/);
  });

  it('counts the cases it cannot classify rather than hiding them', () => {
    expect(body).toMatch(/last_hand NOT IN \(expected, actual\)/);
    expect(body).toMatch(/'classification_unclear'/);
  });

  it('reports all three counts in the alert context', () => {
    for (const key of ['lost_final_write', 'chips_moved_in_play', 'classification_unclear']) {
      expect(body).toContain(`'${key}'`);
    }
  });

  it('puts the diagnosis in the message, not only the context', () => {
    expect(body).toMatch(/lost the final write/);
    expect(body).toMatch(/chips move in play/);
  });

  it('bounds the classification by the sample, not by how bad the hour was', () => {
    // The join runs over v_ids, which is capped at 20 by the [1:20] slice.
    expect(body).toMatch(/\[1:20\]/);
    expect(body).toMatch(/WHERE t\.id = ANY\(v_ids\)/);
  });

  it('still restricts itself to the two fixed-entry variants', () => {
    expect(body).toMatch(/t\.variant\s+IN\s*\(\s*'spin'\s*,\s*'sng'\s*\)/);
  });

  it('still skips rebuy and add-on games rather than guessing', () => {
    expect(body).toMatch(/'rebuy'\s*,\s*'addon'\s*,\s*'addon_refund'/);
  });

  it('reports and repairs nothing', () => {
    expect(body).not.toMatch(/\bUPDATE\s+public\./i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
    const inserts = body.match(/\bINSERT\s+INTO\s+public\.(\w+)/gi) ?? [];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/financial_alerts/);
  });

  it('treats horses as players, CLAUDE.md 10.5', () => {
    expect(code).not.toMatch(/is_horse/i);
    expect(code).not.toMatch(/p_include_horses/i);
  });

  it('stays closed to anon and proves it in the migration', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role;/);
    expect(sql).toMatch(/has_function_privilege\('anon'/);
  });
});
