/**
 * ===========================================================================
 *  LAW: A BUST AWAITING ITS ELIMINATION DOES NOT HOLD A DEAD HAND
 * ===========================================================================
 *
 * public.fn_f06_abort_abandoned_generation voids the hand a dead lease
 * generation left reserved, and refuses F06_ABANDONED_ROSTER_CHANGED when a
 * 'playing' registration names the table without a live chair there: "a
 * player's chips are somewhere this door cannot see".
 *
 * Measured on production 2026-09-26 (engine f1d956c3, adoption at 04:12:22
 * UTC): that refusal held 48 RUNNING events. In all 48 the registration was a
 * player who had busted in an EARLIER committed hand - chips 0, no live chair
 * anywhere in the event, every chair they ever had holding 0 - and whose
 * elimination the dead generation never wrote. The adopting manager's own
 * elimination pass wrote it from 04:12:42, and the table admission's
 * ten-minute re-ask then aborted 45 generations with the unchanged door. The
 * door was waiting for a status write that has nothing to do with the hand.
 *
 * Migration 20260926043558 narrows exactly that one clause. This law pins:
 *   1. the new definition is the previous one (20260922132318, byte-identical
 *      to production before this change) plus ONLY the documented edits;
 *   2. the admitted shape is exactly "chips = 0 AND no chair of this player in
 *      the event is live or holds a chip" - never chips > 0, never a live chair;
 *   3. every other refusal of the door is still raised, including the one that
 *      keeps a bust from having been dealt into the voided hand;
 *   4. the migration carries its pre-image and post-image guards and states
 *      the service_role grant explicitly.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const PREVIOUS = readFileSync(
  join(
    MIGRATIONS,
    '20260922132318_a_late_chair_a_bought_addon_and_a_foreign_park_do_not_hold_an_event_frozen.sql'
  ),
  'utf8'
);
const NARROWED = readFileSync(
  join(MIGRATIONS, '20260926043558_a_bust_awaiting_its_elimination_does_not_hold_a_dead_hand.sql'),
  'utf8'
);

const PRE_MD5 = '9dc6adcbe4ea282151638ce2b5fb4e5d';
const POST_MD5 = '53950f516ec6139b4ad30d7753ab47e9';

function doorBody(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_f06_abort_abandoned_generation');
  expect(start, 'the file defines the door').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

const OLD_CLAUSE = `                                        AND s.seat_number = tp.seat_number AND s.left_at IS NULL)) THEN
      RAISE EXCEPTION 'F06_ABANDONED_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;
`;

const ADMITTED_BUST = `                     AND NOT (tp.chips = 0
                              AND NOT EXISTS (SELECT 1 FROM public.table_seats b
                                                JOIN public.tables bt ON bt.id = b.table_id
                                               WHERE bt.tournament_id = t AND b.user_id = tp.user_id
                                                 AND (b.left_at IS NULL OR b.stack IS DISTINCT FROM 0)))) THEN
      RAISE EXCEPTION 'F06_ABANDONED_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;
`;

const stripComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

describe('a bust awaiting its elimination does not hold a dead hand', () => {
  const before = doorBody(PREVIOUS);
  const after = doorBody(NARROWED);

  it('starts from the definition production held (byte-identical, md5 pinned)', () => {
    expect(md5(before)).toBe(PRE_MD5);
    expect(md5(after)).toBe(POST_MD5);
  });

  it('changes nothing but the documented edits', () => {
    // Undo each documented edit; what is left must be the previous door exactly.
    let undone = after
      .replace('  actual jsonb;\n  v_busts jsonb;\nBEGIN\n', '  actual jsonb;\nBEGIN\n')
      .replace(
        "'roster', roster, 'busts_pending_elimination', v_busts, 'break_id', v_break,",
        "'roster', roster, 'break_id', v_break,"
      )
      .replace(
        "'permit', to_jsonb(h), 'roster', roster, 'busts_pending_elimination', v_busts));",
        "'permit', to_jsonb(h), 'roster', roster));"
      );
    const clauseStart = undone.indexOf(
      '                                        AND s.seat_number = tp.seat_number AND s.left_at IS NULL)\n                     -- A BUST WHOSE ELIMINATION'
    );
    expect(clauseStart, 'the narrowed clause follows the live-chair test').toBeGreaterThan(0);
    const receiptEnd =
      undone.indexOf('AND s.seat_number = tp.seat_number AND s.left_at IS NULL);\n', clauseStart) +
      'AND s.seat_number = tp.seat_number AND s.left_at IS NULL);\n'.length;
    undone = undone.slice(0, clauseStart) + OLD_CLAUSE + undone.slice(receiptEnd);
    expect(undone).toBe(before);
  });

  it('admits only a registration holding zero chips with no live or non-empty chair anywhere in the event', () => {
    expect(after).toContain(ADMITTED_BUST);
    const code = stripComments(after);
    // Exactly one admission, and it is conjunctive with the chairless test.
    expect(code.match(/tp\.chips = 0/g)).toHaveLength(1);
    expect(code).not.toMatch(/tp\.chips\s*(<=|<|>=)\s*0/);
    expect(code).not.toMatch(/COALESCE\(tp\.chips/);
    // The chair test is event-wide and refuses a live chair OR any chip on any chair.
    expect(code).toContain('(b.left_at IS NULL OR b.stack IS DISTINCT FROM 0)');
    expect(code).toContain('WHERE bt.tournament_id = t AND b.user_id = tp.user_id');
  });

  it('still refuses every other unsafe shape', () => {
    const code = stripComments(after);
    for (const refusal of [
      'F06_ABANDONED_ROSTER_CHANGED',
      'F06_ABORT_SAVED_STACKS_CHANGED',
      'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT',
      'F06_ABORT_COMMITTED_OR_DISPATCHED',
      'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION',
      'F06_ABANDONED_PERMIT_CHANGED',
      'F06_ABORT_SNAPSHOT_AMBIGUOUS',
      'F06_ABANDONED_PARK_CHANGED',
      'F06_GENERATION_STILL_LIVE',
      'F06_MIXED_CUSTODY_PENDING',
    ]) {
      expect(code, refusal).toContain(`RAISE EXCEPTION '${refusal}'`);
    }
    // A live chair that does not match its registration's chips still refuses.
    expect(code).toContain(
      "OR (r->>'stack')::numeric IS DISTINCT FROM (r->>'chips')::numeric)"
    );
    // A snapshot player must still hold a LIVE chair on the roster: a bust
    // that was dealt into the voided hand can never pass as a pending bust.
    expect(code).toContain("AND EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r\n                                WHERE r->>'user_id' = x->>'user_id'");
    // The roster itself is still built from live chairs only.
    expect(code).toContain('WHERE s.table_id = h.table_id AND s.left_at IS NULL;');
  });

  it('names every admitted bust on the receipt', () => {
    expect(after).toContain("'busts_pending_elimination', v_busts, 'break_id', v_break");
    expect(after).toContain("'roster', roster, 'busts_pending_elimination', v_busts));");
  });

  it('is one transaction with pre-image and post-image guards and an explicit service_role grant', () => {
    expect(NARROWED.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(NARROWED.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(NARROWED).not.toMatch(/CONCURRENTLY|VACUUM|break_window_migration_override/);
    const pre = NARROWED.slice(NARROWED.indexOf('DO $pre$'), NARROWED.indexOf('$pre$;'));
    expect(pre).toContain(`'${PRE_MD5}'`);
    for (const pinned of [
      "pg_get_userbyid(p.proowner) = 'postgres'",
      "p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'",
      `p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'`,
      'p.prosecdef',
      "p.provolatile = 'v'",
    ]) {
      expect(pre, pinned).toContain(pinned);
    }
    const post = NARROWED.slice(NARROWED.indexOf('DO $post$'));
    expect(post).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(post).toContain("p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(NARROWED).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_f06_abort_abandoned_generation\(uuid, uuid, uuid, text, boolean\)\s+FROM PUBLIC, anon, authenticated;/
    );
    expect(NARROWED).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_f06_abort_abandoned_generation\(uuid, uuid, uuid, text, boolean\)\s+TO service_role;/
    );
  });
});
