/**
 * A SPIN DRAW, RESERVE MOVE, JOURNAL, ESCROW FUNDING AND ROW STAMP ARE ONE
 * DATABASE EVENT. The former two-RPC engine path released the reserve lock
 * after choosing a multiplier, then tried to settle and stamp later. A crash
 * or concurrent draw could leave a truthful number with missing money, or
 * money with a missing row. The combined authority returns a complete receipt
 * and an unreadable result remains UNKNOWN; it is never invented locally.
 *
 * The second guard covers settlement and the row write. A failed settlement
 * or an unprovable `spin_multiplier` is a hard pre-deal stop. The old code let
 * the game run and trusted a timer/sweep to fill the financial or row gap
 * later; that made a repair process part of the money path. The next ordinary
 * start attempt adopts the immutable draw from the reserve ledger and retries
 * the same write before dealing, so no background reconciler is needed.
 *
 * These are source guards, in the style of TournamentFixes.guard.test.ts:
 * start() is a ~600-line method against live Supabase and cannot be exercised
 * in a unit test, but the shapes that made the lie possible can be forbidden.
 * If a rule here is deliberately superseded, delete the guard IN THE SAME
 * COMMIT and say why.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import { applySpinDrawPatch } from './spinDrawSync.js';

const BASE = fs.readFileSync(
  path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

/** Strip comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const CODE = code(BASE);

describe('a Spin has one atomic service money door', () => {
  it('never assigns a multiplier from the tier table as a fallback', () => {
    // The exact line that made the wheel lie: `spinMultiplier = SPIN_TIERS[0].multiplier`.
    expect(CODE).not.toMatch(/spinMultiplier\s*=\s*SPIN_TIERS\s*\[\s*0\s*\]/);
  });

  it('calls only the combined draw-and-settle RPC', () => {
    expect(CODE).toMatch(/supabase\.rpc\('fn_spin_draw_and_settle'/);
    expect(CODE).not.toMatch(/supabase\.rpc\('fn_spin_draw_multiplier'/);
    expect(CODE).not.toMatch(/supabase\.rpc\('fn_spin_settle_game'/);
  });

  it('reads the RPC error and validates the whole receipt', () => {
    const call = CODE.slice(CODE.indexOf('fn_spin_draw_and_settle') - 300);
    expect(call).toMatch(/\{ data, error \}/);
    expect(call).toMatch(/if \(error\) throw/);
    expect(call).toMatch(/parseSpinSettlementReceipt\(data/);
  });

  it('stands the start down before reveal or deal when receipt proof fails', () => {
    const failure = sliceEnclosingBlock(CODE, 'if (!atomicReceipt)');
    expect(failure).toMatch(/spin_atomic_settlement_unavailable/);
    expect(failure).toMatch(/this\.running\s*=\s*false/);
    expect(failure).toMatch(/return/);
  });
});

describe('settlement and the drawn row are hard pre-deal gates', () => {
  it('reads every immutable core field back', () => {
    expect(CODE).toMatch(
      /\.select\('id, spin_multiplier, prize_pool, spin_locked_tiers'\)\s*\.maybeSingle\(\)/
    );
    expect(CODE).toMatch(/writtenRow\?\.prize_pool/);
    expect(CODE).toMatch(/lockedMatches/);
  });

  it('stands down when the row cannot be persisted and verified', () => {
    const failure = sliceEnclosingBlock(CODE, 'if (!spinRowWritten)');
    expect(failure).toMatch(/this\.running\s*=\s*false/);
    expect(failure).toMatch(/return/);
  });

  it('has no background row watcher or sweep dependency', () => {
    expect(CODE).not.toMatch(/scheduleSpinRowRepair/);
    expect(CODE).not.toMatch(/spin_row_repair_exhausted/);
    expect(CODE).not.toMatch(/fn_spin_sweep_unbooked/);
    expect(CODE).not.toMatch(/spin_settle_failed/);
  });
});

describe('the reveal asks the hub to hold it (D3)', () => {
  it('the wheel event carries its own replay deadline, and it is the REAL one', () => {
    /* PIN MOVED, NOT WEAKENED (2026-09-02, §10.6). It read
       `/replay_until:\s*holdUntil/`. The engine holds dealing until
       `effectiveHold = Math.max(holdUntil, now + spinPostRevealMs())`, so
       pinning the PLANNED hold pinned the bug: on the overrun path the hub
       dropped the replay packet while the cards were still legally undealt,
       and a player reconnecting in that window lost the reveal entirely.
       The deadline must be the hold the engine actually keeps. */
    /* THERE ARE TWO PACKETS AND THEY ARE NOT THE SAME (2026-09-02). The
       first `type: 'spin_reveal'` in this file is the EARLY emit, fired
       before the engine exists; the second is the main pass. The old pin
       sliced occurrence 0 and asserted `holdUntil`, which passed against
       either - so it never noticed they had to differ. Both are pinned now,
       each to the deadline it actually owes. */
    const early = sliceEnclosingBlock(CODE, "type: 'spin_reveal'", 0);
    expect(early).toMatch(
      /replay_until: Math\.max\(holdUntil, Date\.now\(\) \+ spinPostRevealMs\(\)\)/
    );

    const main = sliceEnclosingBlock(CODE, "type: 'spin_reveal'", 1);
    expect(main).toMatch(/replay_until:\s*effectiveHold/);
    expect(main).not.toMatch(/replay_until:\s*holdUntil\b/);
  });

  it('the post-reveal beats carry one too, ending when dealing may start', () => {
    expect(CODE).toMatch(/const replayUntil = revealAt \+ spinRevealToDealMs\(\)/);
    const post = CODE.slice(CODE.indexOf('private scheduleSpinPostReveal'));
    expect(post.match(/replay_until:\s*replayUntil/g) ?? []).toHaveLength(2);
  });
});

describe('the draw reaches memory WHOLE (2026-08-31)', () => {
  /* THE DEFECT: the sync-back after the row write was a hand-written list of
     field names, and it copied four of the patch's five fields. The one it
     dropped was `payout_structure`, so a started Spin's `tournamentCache` kept
     the pre-draw winner-take-all placeholder for the whole game, and
     recalculateEliminatedPrizes - which reads that cache - topped players up
     against a different structure than the one that had paid them.

     These pins are deliberately NOT a list of today's five field names. A list
     is exactly what failed: it was right until the next field arrived and
     nothing complained when one was forgotten. Instead: the helper must copy
     whatever it is handed, and the draw site must hand it the whole patch. */

  it('applySpinDrawPatch copies EVERY key, including one it has never seen', () => {
    const patch = {
      prize_pool: 30,
      spin_multiplier: 10,
      blind_structure: [{ level: 1 }],
      payout_structure: [
        { place: 1, percentage: 80 },
        { place: 2, percentage: 20 },
      ],
      // The sixth field this test exists for: nothing in the helper knows its
      // name, so it can only arrive by being copied wholesale.
      some_field_added_next_year: 'must land too',
    };
    const tournament: Record<string, unknown> = { prize_pool: 3, spin_multiplier: null };
    const cache: Record<string, unknown> = {};
    applySpinDrawPatch(patch, tournament, cache);
    for (const key of Object.keys(patch)) {
      expect(tournament[key], `tournament.${key}`).toEqual((patch as any)[key]);
      expect(cache[key], `cache.${key}`).toEqual((patch as any)[key]);
    }
  });

  it('skips an absent cache rather than throwing, because a sync must never fail a start', () => {
    expect(() => applySpinDrawPatch({ a: 1 }, null, undefined)).not.toThrow();
  });

  it('the draw site hands over the whole patch, and names no field twice', () => {
    // The sync window: from the patch write to the registration migration that
    // follows it.
    const from = CODE.indexOf('applySpinDrawPatch(');
    expect(from, 'the sync site must call applySpinDrawPatch').toBeGreaterThan(0);
    const window = CODE.slice(from, CODE.indexOf("from('tournament_players')", from));

    // Both in-memory copies are targets of the same call.
    expect(window).toMatch(/spinRowPatch/);
    expect(window).toMatch(/this\.tournamentCache/);

    // And nothing here re-copies a field by name - the shape that dropped
    // payout_structure. Any `tournament.x =` or `this.tournamentCache.x =`
    // inside the sync window is the regression.
    expect(window).not.toMatch(/this\.tournamentCache\.\w+\s*=/);
    expect(window).not.toMatch(/\btournament\.\w+\s*=[^=]/);
  });

  it('the patch itself still carries the payout structure that was drawn', () => {
    const patch = CODE.slice(
      CODE.indexOf('const spinRowPatch = {'),
      CODE.indexOf('let spinRowWritten')
    );
    expect(patch).toMatch(/payout_structure:/);
    // Derived from the drawn tier, never a literal winner-take-all.
    expect(patch).toMatch(/tier\?\.payouts/);
  });
});
