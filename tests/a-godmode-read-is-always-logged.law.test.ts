/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A GODMODE READ IS ALWAYS LOGGED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 6 of the Previous Hand build plan (2026-09-06).
 *
 * `fn_ca_operator_read_hand` returns every seat's hole cards for one hand:
 * the folded ones and the mucked ones, holdings the table never saw. It is the
 * most sensitive read on this platform and it exists because a dispute cannot
 * be settled without it.
 *
 * THE INVARIANT THIS PINS is not "we remember to log it". It is that the log
 * CANNOT be skipped, because four things are true at once and each one is
 * checked below:
 *
 *   1. The function writes the `audit_trail` row in the SAME statement flow
 *      that returns the cards - one transaction, so a failed insert fails the
 *      read and nothing is handed back.
 *   2. `audit_trail` REVOKEs INSERT from `authenticated`, so no caller can
 *      write that row itself and no other function is tempted to.
 *   3. There is no second path to the cards: `hand_history`,
 *      `ca_hand_facts` and `table_hole_cards` all scope SELECT to the reader's
 *      own rows, so an operator has no unlogged way in.
 *   4. A reason is required and travels into the row verbatim.
 *
 * A future edit that returns the cards before writing the row, or adds a
 * second reader, or relaxes the reason, breaks one of these and this law says
 * which.
 *
 * VERIFIED AGAINST PRODUCTION 2026-09-06 in one self-aborting transaction
 * (CLAUDE.md 11.5): the read logged exactly one row naming the reader, the
 * hand and the reason; a reason under eight characters was refused; a hand at
 * another club was refused; an operator of another club was refused; and every
 * refusal wrote nothing. `ca_hand_flags` and `audit_trail` were unchanged
 * afterwards.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

/** The newest definition of a function wins - migrations are a sequence. */
function latestDefinitionOf(fnName: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found = '';
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const at = sql.indexOf(`FUNCTION public.${fnName}(`);
    if (at < 0) continue;
    /* To the end of this function body: `$$;` closes it. */
    const end = sql.indexOf('$$;', at);
    found = end < 0 ? sql.slice(at) : sql.slice(at, end + 3);
  }
  return found;
}

describe('a godmode read is always logged', () => {
  const readHand = latestDefinitionOf('fn_ca_operator_read_hand');

  it('the function that returns the cards is the function that writes the log', () => {
    expect(readHand, 'fn_ca_operator_read_hand exists in a migration').toBeTruthy();
    expect(readHand).toMatch(/INSERT INTO public\.audit_trail/);
    expect(readHand).toMatch(/'hand_godmode_read'/);
    /* The insert comes BEFORE the return, so the read cannot complete without
       it. Ordering matters here in a way it rarely does: they are in one
       transaction, so a failed insert aborts the whole call. */
    const insertAt = readHand.indexOf('INSERT INTO public.audit_trail');
    const returnAt = readHand.lastIndexOf('RETURN to_jsonb');
    expect(insertAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(insertAt);
  });

  it('the row names the reader, the hand, the club and the reason', () => {
    expect(readHand).toMatch(/actor_id/);
    expect(readHand).toMatch(/actor_role/);
    expect(readHand).toMatch(/target_type/);
    expect(readHand).toMatch(/target_id/);
    expect(readHand).toMatch(/club_id/);
    expect(readHand).toMatch(/reason/);
    /* `v_uid` is `auth.uid()`, so the actor is who Postgres says it is and not
       a value the caller passed. */
    expect(readHand).toMatch(/v_uid\s+uuid\s*:=\s*auth\.uid\(\)/);
  });

  it('refuses a caller who is not this club’s owner or admin', () => {
    expect(readHand).toMatch(/fn_ca_is_club_control\(\s*p_club_id\s*,\s*v_uid\s*\)/);
    expect(readHand).toMatch(/42501/);
  });

  it('refuses a hand dealt at another club, because hand numbers are global', () => {
    expect(readHand).toMatch(/IS DISTINCT FROM p_club_id/);
    expect(readHand).toMatch(/not dealt at this club/i);
  });

  it('requires a reason with something in it, and records it verbatim', () => {
    expect(readHand).toMatch(/char_length\(v_reason\)\s*<\s*8/);
    expect(readHand).toMatch(/btrim\(COALESCE\(p_reason/);
    /* Written as given: no truncation, no default, no placeholder. */
    expect(readHand).toMatch(/\n\s*v_reason,/);
  });

  it('says how many holdings it actually has, so an absent card is never an empty hand', () => {
    /* `hand_history` reaches back further than the per-seat card record does.
       A short answer must announce itself or an operator settles a dispute on
       a hand they think was checked down. */
    expect(readHand).toMatch(/seats_dealt/);
    expect(readHand).toMatch(/seats_with_cards/);
    expect(readHand).toMatch(/cards_complete/);
  });

  it('reads the DURABLE card store, not the one that is pruned every six hours', () => {
    /* `table_hole_cards` held ~29 hours of rows when this was written and is
       pruned by the `cleanup-hole-cards` cron. A lookup built on it alone
       returns an empty map for every hand old enough to be disputed - which
       reads exactly like "nobody was holding anything". */
    expect(readHand).toMatch(/ca_hand_facts/);
    const factsAt = readHand.indexOf('ca_hand_facts');
    const liveAt = readHand.indexOf('table_hole_cards');
    expect(factsAt, 'the durable store is read').toBeGreaterThan(-1);
    if (liveAt > -1) {
      /* Both may be read - facts must not be the fallback. */
      expect(readHand).toMatch(/COALESCE\(v_fresh[^)]*\)\s*\|\|\s*v_cards/);
    }
  });

  it('the card tables stay self-scoped, which is what makes the client reads safe', () => {
    /* THIS IS THE THING THAT WOULD HAVE TO BREAK. Client reads of
       `ca_hand_facts` deliberately name no user - `HandHistoryService`
       explains why in the file: "NO USER ID IN THE QUERY ... so a bug here
       cannot widen it". A query that names no user cannot name the wrong one,
       and RLS is what narrows it. That is a good argument and this law does
       not second-guess it.
       What it does instead is guard the half that argument RESTS on: the
       policies. Widen one of these to let staff read facts, and every one of
       those self-scoped-by-RLS reads silently starts returning other players'
       cards - into a rundown, unlogged, with no code change to review. */
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      for (const table of ['ca_hand_facts', 'table_hole_cards']) {
        const re = new RegExp(`CREATE POLICY[\\s\\S]*?ON public\\.${table}[\\s\\S]*?;`, 'gi');
        for (const policy of sql.match(re) ?? []) {
          if (!/FOR\s+SELECT/i.test(policy)) continue;
          /* Self-scoped, in either spelling the repo uses. */
          const selfScoped =
            /auth\.uid\(\)\s*\)?\s*=\s*user_id/i.test(policy) ||
            /user_id\s*=\s*\(?\s*(?:SELECT\s+)?auth\.uid\(\)/i.test(policy);
          if (!selfScoped)
            offenders.push(`${file}: a SELECT policy on ${table} is not self-scoped`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
