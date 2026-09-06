/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROUND 9 AUDIT PINS — the last discarded-error reads on the table
 *  surfaces (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Round 7 fixed the pages, round 8 fixed TournamentService, and this round
 * closes the remainder the handoff counted: TablePage.tsx (17),
 * TableService.ts (3) and ClubHomePage.tsx (3). Same question throughout:
 * if this read fails, what does the code then tell the player?
 *
 * The standouts, for the record:
 * - TableService.leaveTable decided WHICH MONEY PATH a leave takes from a
 *   read whose failure was indistinguishable from "cash table";
 * - the busted-player routing retry was DEFEATED by the seam between
 *   "throws" and "resolves with { error }" - a failed read broke the loop
 *   on attempt 1 with no error recorded, stranding the player on a dead
 *   table, the exact bug its own 2026-08-26 comment says was fixed;
 * - a failed paid-entrant read demoted a registered player to Spectating,
 *   the complaint that started this entire sweep;
 * - a failed rebalance read left a moved player on their old table with
 *   neither the redirect nor the refresh fallback.
 *
 * Windows are structure-bounded (tests/helpers/sourceWindow.ts).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBlockAfter, sliceEnclosingBlock } from '../helpers/sourceWindow';

const root = join(__dirname, '..', '..');
const TABLE_PAGE = readFileSync(join(root, 'src', 'pages', 'TablePage.tsx'), 'utf8');
const TABLE_SERVICE = readFileSync(join(root, 'src', 'services', 'TableService.ts'), 'utf8');
const CLUB_HOME = readFileSync(join(root, 'src', 'pages', 'ClubHomePage.tsx'), 'utf8');

describe('round 9: TableService', () => {
  it('leaveTable refuses when the table-context read fails, instead of guessing cash', () => {
    const gate = sliceEnclosingBlock(TABLE_SERVICE, 'leaveTable_table_context_read_failed', 0, 2);
    expect(gate).toContain('return { success: false, chipsReturned: 0 }');
    // The cash-path fork must still sit BELOW the guard.
    const guardAt = TABLE_SERVICE.indexOf('leaveTable_table_context_read_failed');
    // CHIP STANDARD C1 (2026-09-02): the browser's cash-out RPC is now
    // atomic_seat_cashout_locked (one cash-out path); the fork position pin
    // is unchanged.
    const forkAt = TABLE_SERVICE.indexOf("'atomic_seat_cashout_locked'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(forkAt).toBeGreaterThan(guardAt);
  });

  it('getClubTables consults the cached union scope on a failed union read', () => {
    const block = sliceBlockAfter(TABLE_SERVICE, 'async getClubTables(');
    expect(block).toContain('error: ucErr');
    expect(block).toContain('getClubTables_union_read_failed');
    expect(block).toContain('ca_union_of_');
    expect(block).toContain('sessionStorage.getItem(unionCacheKey)');
  });

  it('the legacy delete entry point delegates to the authoritative close command', () => {
    const block = sliceBlockAfter(TABLE_SERVICE, 'async deleteTable(');
    expect(block).toContain("gameManagementService.close('table', tableId)");
    expect(block).not.toContain(".from('tables')");
    expect(block).not.toContain("status: 'deleted'");
  });
});

describe('round 9: ClubHomePage', () => {
  it('reports remaining reads and never invokes the removed legacy level re-read', () => {
    expect(CLUB_HOME).toContain('union_member_counts_read_failed');
    expect(CLUB_HOME).not.toContain('level_reread_failed');
    expect(CLUB_HOME).not.toContain("rpc('recompute_club_levels'");
    expect(CLUB_HOME).toContain('getClubLevelInfoFromMembers(clubData.member_count || 0)');
    expect(CLUB_HOME).toContain('share_ref_profile_read_failed');
  });
});

describe('round 9: the busted player is routed even when the read RESOLVES its error', () => {
  const loop = sliceEnclosingBlock(TABLE_PAGE, 'error: elimReadErr', 0, 3);

  it('a resolved error is thrown into the retry, not mistaken for success', () => {
    expect(loop).toContain('if (elimReadErr) throw elimReadErr');
  });

  it('the retry loop and backoff are still intact around it', () => {
    // The for-header lives outside the innermost block, so assert it at file
    // level: the guarded read must still sit inside the ELIM_ATTEMPTS loop.
    const loopAt = TABLE_PAGE.indexOf('attempt <= ELIM_ATTEMPTS');
    const guardAt = TABLE_PAGE.indexOf('if (elimReadErr) throw elimReadErr');
    const backoffAt = TABLE_PAGE.indexOf('400 * attempt');
    expect(loopAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(loopAt);
    expect(backoffAt).toBeGreaterThan(guardAt);
  });
});

describe('round 9: a paid entrant is never demoted to spectator by a timeout', () => {
  const block = sliceEnclosingBlock(TABLE_PAGE, 'paid_entrant_read_failed', 0, 3);

  it('a failed entry read keeps the awaiting flag instead of overwriting it', () => {
    // The setter must live in the ELSE of the error check, so a failure
    // cannot reach it.
    expect(block).toContain('error: myEntryErr');
    const errorAt = block.indexOf('paid_entrant_read_failed');
    const elseAt = block.indexOf('} else {', errorAt);
    const setterAt = block.indexOf('setAwaitingTournamentSeat', errorAt);
    expect(elseAt).toBeGreaterThan(-1);
    expect(setterAt).toBeGreaterThan(elseAt);
  });

  it('a failed seat count reports and errs toward "awaiting a seat"', () => {
    expect(block).toContain('paid_entrant_seat_count_failed');
  });
});

describe('round 9: rebalance and bounty reads take their fallbacks on resolved errors', () => {
  it('a failed rebalance read reaches the catch that refreshes the seats', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'error: rebalanceErr', 0, 2);
    expect(block).toContain('if (rebalanceErr) throw rebalanceErr');
  });

  it('a failed bounty read keeps the map the table already has', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'bounty_map_read_failed', 0, 2);
    expect(block).toContain('bountyErr ? prev.bountyMap : bMap');
  });

  it('the heads-up and final-table announcement reads throw into their catches', () => {
    expect(TABLE_PAGE).toContain('if (huRowsErr) throw huRowsErr');
    expect(TABLE_PAGE).toContain('if (ftRowsErr) throw ftRowsErr');
    expect(TABLE_PAGE).toContain('if (ftPoolErr) throw ftPoolErr');
  });
});

describe('round 9: identity and display reads leave a trace', () => {
  it('a failed profile read cannot overwrite the first-paint identity cache', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'initUser_profile_read_failed', 0, 2);
    // The guard returns BEFORE persistIdentity can run with nulls.
    const guardAt = block.indexOf('initUser_profile_read_failed');
    const returnAt = block.indexOf('return;', guardAt);
    const persistAt = TABLE_PAGE.indexOf(
      'persistIdentity',
      TABLE_PAGE.indexOf('initUser_profile_read_failed')
    );
    expect(returnAt).toBeGreaterThan(guardAt);
    expect(persistAt).toBeGreaterThan(-1);
  });

  it('the remaining display reads all report their failures', () => {
    for (const key of [
      'bbj_table_read_failed',
      /* `bbj_pool_read_failed` and `bbj_hit_baseline_read_failed` left this
         file with the reads themselves (BBJ phase 3.1/3.2, 2026-09-06): the
         pool figure is now one shared poll (lib/bbjPoolFeed, which reports as
         bbjPoolFeed.read_failed) and the hit-count baseline is gone entirely,
         replaced by the bbj_winners INSERT. The rule is unchanged - every
         display read leaves a trace - and it is pinned where the reads now
         live, in bbjPoolFeed.test.ts and bbjHitFeed.test.ts. */
      'hole_card_recovery_read_failed',
      'masthead_viewer_club_read_failed',
      'seat_restore_read_failed',
      'seat_profiles_read_failed',
      'waitlist_profiles_read_failed',
      'buyin_seat_precheck_read_failed',
    ]) {
      expect(TABLE_PAGE, `missing reporter key ${key}`).toContain(key);
    }
  });
});
