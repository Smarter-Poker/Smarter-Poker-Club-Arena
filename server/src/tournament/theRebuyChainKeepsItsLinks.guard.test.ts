/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A WRAPPER STACK CAN LOSE A LINK AND SAY NOTHING (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `process_tournament_rebuy` is a stack of wrappers, each renaming its
 * predecessor to `..._before_<what_it_added>` and calling it. On 2026-09-08 a
 * new outermost wrapper re-implemented the lifecycle/clock gate and then
 * called `_before_one_minute_addon` directly, describing it as "the audited
 * money core".
 *
 * It is not the core. It is a LOWER wrapper, and jumping to it stranded the two
 * layers above it - `_before_atomic_pool_gate` and
 * `_before_bounty_guard_20260907` - which nothing else calls. Everything they
 * did stopped happening, silently:
 *
 *   - `fn_after_tournament_rebuy` (ONLY caller: the pool gate), which resolves
 *     the pending knockout candidate to 'rebought' and clears
 *     `rebuy_prompt_until`;
 *   - "Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry
 *     Generation Yet";
 *   - "A Zero-Stack Bounty Entry Cannot Take An Add-On";
 *   - "Bubble Protection Already Paid - This Result Cannot Be Resurrected";
 *   - `fn_emit_tournament_manager_wake`.
 *
 * Measured on production before the fix, across every RUNNING tournament -
 * `rebuy_prompt_until` is cleared by exactly one statement on the platform, the
 * last line of `fn_after_tournament_rebuy`:
 *
 *     rebought players whose prompt is STILL SET : 70
 *     rebought players whose prompt was cleared  :  1
 *
 * That is what a function nobody calls looks like. Beside it, 147 entrants were
 * `playing` with no seat and 57 of those held chips, their knockout candidates
 * pending for ever.
 *
 * Nothing failed. No test went red. A layer simply stopped being reached, and
 * the only evidence was a column that had stopped being written.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceDollarQuoted } from '../testHelpers/sourceWindow.js';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260909071226_the_rebuy_chain_lost_two_links.sql'
  ),
  'utf8'
);

const RELINK = sliceDollarQuoted(MIGRATION, '$guard1$');
const CLEANUP = sliceDollarQuoted(MIGRATION, '$guard2$');
const PROOF = sliceDollarQuoted(MIGRATION, '$proof$');

describe('the rebuy chain keeps its links', () => {
  it('re-links the outermost gate to the pool gate, not past it', () => {
    expect(RELINK).toContain('process_tournament_rebuy_before_atomic_pool_gate');
    expect(RELINK).toContain('RETURN public.process_tournament_rebuy_before_atomic_pool_gate(');
  });

  it('still passes the authoritative level down, so the add-on clock fix survives', () => {
    // The 2026-09-08 wrapper existed to stop the lower wrapper closing rebuys at
    // the base level during the add-on clock. Re-linking must not undo that.
    expect(RELINK).toContain('v_t.current_level, p_client_token');
  });

  it('refuses to edit a body that has moved on', () => {
    // Read the LIVE definition, assert the anchor, replace literally. A stale
    // copy must abort, never be silently rewritten over the top of somebody
    // else's change.
    expect(RELINK).toContain('pg_get_functiondef');
    expect(RELINK).toMatch(/RETURN public\.process_tournament_rebuy_before_one_minute_addon\(/);
    expect(RELINK).toContain('the chain has changed');
    expect(RELINK).toContain('the re-link replacement matched nothing');
  });

  it('checks the layer it re-links to still does the work, before pointing at it', () => {
    // Re-linking to a pool gate that no longer calls the clean-up would restore
    // the shape and none of the behaviour.
    expect(RELINK).toContain('the pool gate no longer calls fn_after_tournament_rebuy');
  });

  it('keeps the outer wrapper own lifecycle gate as a sibling landmark', () => {
    expect(RELINK).toContain('Tournament is not accepting rebuys or re-entries');
  });

  it('makes the restored layer safe BEFORE it becomes reachable', () => {
    // fn_after_tournament_rebuy raised on more than one pending generation, and
    // it runs after the wallet debit and chip credit in the same transaction -
    // so the raise rolled the whole rebuy back. Re-linking without this would
    // turn a dormant refusal into a live one that takes a player's rebuy away.
    expect(CLEANUP).toContain('fn_after_tournament_rebuy');
    expect(CLEANUP).toContain('MORE THAN ONE PENDING GENERATION IS A REBUY');
    expect(CLEANUP).toMatch(/IF v_count>0 THEN/);
    // The raise appears exactly TWICE and both are needles, never behaviour:
    // once in the anchor assertion and once as the search half of the replace.
    // A third occurrence would mean the replacement itself still raises.
    expect(CLEANUP.match(/rebuy has % unresolved knockout generations/g) ?? []).toHaveLength(2);
    // And the live function is checked afterwards, not assumed - see the proof.
  });

  it('resolves every pending generation, not just the one it happened to pick', () => {
    expect(CLEANUP).toMatch(/state=''rebought''/);
    expect(CLEANUP).toContain("AND state=''pending''");
  });

  it('proves the chain after the edit rather than assuming it', () => {
    // Three post-checks, because each one can be true while the others are not.
    expect(PROOF).toContain('post-check: the gate still does not call the pool gate');
    expect(PROOF).toContain('post-check: the pool gate does not call fn_after_tournament_rebuy');
    expect(PROOF).toContain(
      'post-check: fn_after_tournament_rebuy still raises on multiple generations'
    );
  });

  it('is one transaction, per the production DDL policy', () => {
    // Every DDL statement fires a ~28s PostgREST schema reload; ten loose ones
    // mean ten reloads (CLAUDE.md section 2 rule 1).
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
  });
});
