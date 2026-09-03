/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROUND 8 AUDIT PINS — TournamentService stops answering questions it
 *  could not answer (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Round 7 (PR #1702) closed twelve places where the CLIENT PAGES substituted
 * a convenient answer for one they could not obtain. TournamentService.ts —
 * the service those pages call — carried twenty reads of the same shape:
 * `const { data } = await supabase...` with the error never bound, so a
 * failed query was indistinguishable from an empty result. Each pin below
 * guards one fix, and each fix answers the same question round 7 asked:
 * if this read fails, what does the code then tell the player?
 *
 * The worst of them, for the record:
 * - a failed `unions.settings` read FAILED OPEN on the exact check whose own
 *   comment says it must fail closed;
 * - a failed roster read on the start path could impersonate an empty roster
 *   and CANCEL the tournament;
 * - a failed final-table lookup fell into the create branch and minted a
 *   duplicate Final Table;
 * - the add-on and re-entry duplicate gates (money actions) waved through
 *   anyone whose check query timed out.
 *
 * Every window is structure-bounded (tests/helpers/sourceWindow.ts). Fixed
 * byte windows are forbidden — see noFixedSizeSourceWindows.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween, sliceMethod } from '../helpers/sourceWindow';

const SRC = readFileSync(
  join(__dirname, '..', '..', 'src', 'services', 'TournamentService.ts'),
  'utf8'
);

describe('round 8: the union resolver cannot conclude standalone from a failure', () => {
  const method = sliceMethod(SRC, 'async getTournaments(');

  it('binds the error on the clubs.union_id fallback read', () => {
    expect(method).toContain('error: clubErr');
    expect(method).toContain('clubRowErr = clubErr');
  });

  it('consults the cached union scope when EITHER resolve read failed', () => {
    expect(method).toContain('const anyResolveErr = unionClubErr || clubRowErr');
    expect(method).toContain('if (!resolvedUnionId && anyResolveErr)');
  });

  it('clears the cache only when every read succeeded and found nothing', () => {
    expect(method).toContain('else if (!anyResolveErr) sessionStorage.removeItem(unionCacheKey)');
  });

  it('fails CLOSED when the union settings row cannot be read, and reports it', () => {
    const settingsGate = sliceBetween(method, 'error: unionSettingsErr', 'if (allowCrossClub)');
    expect(settingsGate).toContain('if (unionSettingsErr)');
    expect(settingsGate).toContain('allowCrossClub = false');
    expect(settingsGate).toContain('union_settings_read_failed_failing_closed');
  });

  it('reports a failed union tournament read instead of dressing it as an empty union', () => {
    expect(method).toContain('error: xmttErr');
    expect(method).toContain('union_tournaments_read_failed');
  });
});

describe('round 8: creation paths', () => {
  const create = sliceMethod(SRC, 'async createTournament(');

  it('a failed union verify read is a retry, never "Union not found"', () => {
    const gate = sliceBetween(create, 'error: unionReadErr', "throw new Error('Union not found')");
    expect(gate).toContain('if (unionReadErr)');
    expect(gate).toContain('createTournament_union_read_failed');
    expect(gate).toContain('Could not verify union settings. Please try again.');
  });

  it('a failed post-create refetch says the tournament WAS created', () => {
    expect(create).toContain('error: refetchErr');
    expect(create).toContain('created_tournament_refetch_failed');
    expect(create).toContain('The tournament was created.');
    // The old shape — returning `data` bare with no error check — is gone:
    // the return is now guarded so a null can never leave a method typed
    // Promise<Tournament>.
    expect(create).toContain('if (refetchErr || !data)');
  });
});

describe('round 8: the start path cannot cancel a tournament off a failed read', () => {
  const start = sliceMethod(SRC, 'async startTournament(');

  it('binds and reports the roster read error before any player-count logic', () => {
    const gate = sliceBetween(
      start,
      'error: rosterErr',
      "throw new Error('No players registered')"
    );
    expect(gate).toContain('if (rosterErr)');
    expect(gate).toContain('start_roster_read_failed');
    expect(gate).toContain('Could not load the player list. Please try again.');
  });

  it('a short field waits without cancelling registered players', () => {
    expect(start).toContain('players.length < 3');
    expect(start).not.toContain('await this.cancelTournament(');
    expect(start).toContain('Tournament Needs At Least 3 Players To Start');
  });
});

describe('round 8: money-action gates fail closed on a failed read', () => {
  it('add-on duplicate check refuses, retryably, when it cannot read', () => {
    const addOn = sliceMethod(SRC, 'async processAddOn(');
    expect(addOn).toContain('error: addonCheckErr');
    expect(addOn).toContain('addon_duplicate_check_read_failed');
    expect(addOn).toContain('Could not verify your add-on status. Please try again.');
  });

  it('there is no second re-entry path to gate', () => {
    /* REPLACED 2026-09-02 with the change it pins, per CLAUDE.md 5.8. This
       asserted that `processReentry`'s read failures fail closed — which they
       did, and it did not matter, because the method had ZERO production
       callers and could not have worked if it had any: its eligibility check
       ordered `tournament_players` by `created_at`, a column that table does
       not have (its timestamps are `registered_at` and `eliminated_at`).
       Every call would have returned 42703 and stopped at "Could not verify
       your entries."

       Re-entry flows through `processRebuy` (`p_rebuy_type: 'reentry'`), which
       is what 314 re-entry tournaments have actually used. A test asserting
       the shape of a dead duplicate money path is worse than no test: it
       reads as coverage of re-entry, so the next auditor skips the path that
       is really taking players' money. The method is deleted; this pins that
       it stays deleted. */
    expect(SRC).not.toContain('async processReentry(');
    expect(SRC, 'the live re-entry path must remain').toContain('p_rebuy_type:');
  });

  it('canRebuy answers a failed stack read with a retry, not "Player not found"', () => {
    const canRebuy = sliceMethod(SRC, 'async canRebuy(');
    expect(canRebuy).toContain('error: stackErr');
    expect(canRebuy).toContain('canRebuy_stack_read_failed');
    expect(canRebuy).toContain('Could not check your stack. Please try again.');
  });
});

describe('round 8: a failed final-table lookup can never mint a duplicate table', () => {
  const finalTable = sliceMethod(SRC, 'async createFinalTable(');

  it('stands down on a lookup error before the create branch', () => {
    const gate = sliceBetween(finalTable, 'error: finalLookupErr', 'if (!finalTable)');
    expect(gate).toContain('final_table_lookup_failed');
    expect(gate).toContain('return { finalTableId: null }');
  });

  it('reports a failed final-table insert', () => {
    expect(finalTable).toContain('error: finalCreateErr');
    expect(finalTable).toContain('final_table_create_failed');
  });
});

describe('round 8: waitlist joins cannot be positioned by a failed count', () => {
  const join_ = sliceMethod(SRC, 'async joinTournamentWaitlist(');

  it('duplicate check refuses retryably when it cannot read', () => {
    expect(join_).toContain('error: existingErr');
    expect(join_).toContain('waitlist_duplicate_check_read_failed');
  });

  it('the count read refuses retryably instead of minting position 1', () => {
    const gate = sliceBetween(join_, 'error: countErr', 'const position');
    expect(gate).toContain('if (countErr)');
    expect(gate).toContain('waitlist_count_read_failed');
    expect(gate).toContain('Could not check the waitlist. Please try again.');
  });
});

describe('round 8: silent under-reports and confident zeros now leave a trace', () => {
  it('the total_rake fallback read reports its failure', () => {
    const rec = sliceMethod(SRC, 'private async recordTournamentFee(');
    expect(rec).toContain('recordTournamentFee_fallback_read_failed');
    expect(rec).toContain('recordTournamentFee_union_read_failed');
  });

  it('a failed bounty read reports before returning its display 0', () => {
    const bounties = sliceMethod(SRC, 'async getPlayerBounties(');
    expect(bounties).toContain('player_bounties_read_failed');
  });

  it('a failed POY placements read reports instead of vanishing the event from the race', () => {
    const finalize = sliceMethod(SRC, 'async finalizeTournament(');
    expect(finalize).toContain('error: poyReadErr');
    expect(finalize).toContain('poy_placements_read_failed');
  });

  it('the balance and merge checks report a failed read behind their safe false', () => {
    expect(sliceMethod(SRC, 'async checkBalanceNeeded(')).toContain('balance_check_read_failed');
    expect(sliceMethod(SRC, 'async checkTableMerge(')).toContain('merge_check_read_failed');
  });

  it('the SNG autostart nudge reports a failed freshness read', () => {
    expect(sliceMethod(SRC, 'async registerPlayer(')).toContain(
      'SNG_autostart_freshness_read_failed'
    );
    expect(sliceMethod(SRC, 'async cancelTournament(')).toContain(
      "gameManagementService.close('tournament', tournamentId)"
    );
  });

  it('the waitlist position display reports a failed read behind its null', () => {
    expect(sliceMethod(SRC, 'async getTournamentWaitlistPosition(')).toContain(
      'waitlist_position_read_failed'
    );
  });
});
