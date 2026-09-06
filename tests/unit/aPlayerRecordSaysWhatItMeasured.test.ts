/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PLAYER RECORD SAYS WHAT IT MEASURED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04, phase 5 of the club operations upgrade)
 *
 * The Players pages had been rebuilt since the phase 5 audit was written, so
 * the audit was redone against what is on main. What it found, each proved
 * against production before it was changed:
 *
 *   - "3-Bet" divided 3-bets by the hands the player was 3-BET in after
 *     opening (the fold-to-3-bet denominator). Three of the club's five most
 *     active players read over 100%; one read 316.7%.
 *   - "Total Games", "Total Hands" and "Winner" were three labels on two
 *     numbers; "Club Chips" and "Player Wallet" two labels on one.
 *   - ca_can_view_club and ca_can_view_club_finances answered TRUE to a
 *     caller with no account.
 *   - resolveClubUUID never returns falsy, so the `!resolved` guards on both
 *     detail pages were dead and a bad slug reached a uuid RPC as 22P02,
 *     shown as an outage. "Member Not Found" was unreachable.
 *   - the roster reset a deep-linked financial filter whenever the page RPC
 *     answered before the summary RPC; a flapping realtime channel scheduled
 *     forced reloads for ever; every roster open advanced a rollup nothing
 *     reads; notes saved as "Bob" stayed "Not Saved Yet" for "Bob ".
 *   - the member console emitted bus events with the route slug; upline
 *     "None" was shown to viewers the server hides it from; the downline
 *     list stopped at 50 with no way to row 51.
 *
 * The transfer modal's money-routing defects have their own mount test:
 * tests/components/chip-transfer-modal-knows-both-ends.test.tsx.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sliceDollarQuoted, sliceMethod } from '../helpers/sourceWindow';

const MIGRATION = readFileSync(
  'supabase/migrations/20260904180000_a_player_record_says_what_it_measured.sql',
  'utf8'
);
const MODAL = readFileSync('src/components/agent/ChipTransferModal.tsx', 'utf8');
const MEMBER = readFileSync('src/pages/MemberManagementPage.tsx', 'utf8');
const STATS = readFileSync('src/pages/PlayerStatisticsPage.tsx', 'utf8');
const PRODUCTION_PLAYERS = readFileSync('tests/e2e/production-club-members.spec.ts', 'utf8');
const ROSTER = readFileSync('src/pages/ClubMembersPage.tsx', 'utf8');
const SERVICE = readFileSync('src/services/ClubRosterService.ts', 'utf8');

const fn = (name: string) => {
  const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(MIGRATION.slice(start), '$function$');
};

describe('the two membership gates name their internal callers', () => {
  it.each(['ca_can_view_club', 'ca_can_view_club_finances'])('%s', (name) => {
    const body = fn(name);
    expect(body).not.toContain('auth.uid() IS NULL');
    expect(body).toContain("session_user IN ('postgres', 'supabase_admin')");
    expect(body).toContain("coalesce(auth.role(), '') = 'service_role'");
    expect(body).toContain('auth.uid() IS NOT NULL');
    expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION public.${name}(uuid) FROM PUBLIC, anon;`);
  });

  it('the migration refuses to commit the old shape', () => {
    const block = sliceDollarQuoted(MIGRATION.slice(MIGRATION.lastIndexOf('DO $$')), '$$');
    expect(block).toContain("LIKE '%auth.uid() IS NULL%'");
    expect(block).toContain('still admits a caller with no account');
  });
});

describe('the statistics read', () => {
  const body = fn('ca_club_member_statistics');

  it('measures 3-bets per hand and says so, and fold-to-3-bet per open that was 3-bet', () => {
    expect(body).toContain("'three_bet', COALESCE(round(100.0*a.tb_hands/NULLIF(a.hands,0),2),0)");
    expect(body).toContain("'three_bet_basis', 'hands'");
    expect(body).toContain(
      "'fold_to_three_bet', COALESCE(round(100.0*a.folded_tb/NULLIF(a.faced_tb,0),2),0)"
    );
    expect(body).not.toContain('a.tb_hands/NULLIF(a.tb_opps');
  });

  it('names hands, hands won and win rate, keeping the old keys one release', () => {
    for (const key of [
      'hands',
      'hands_won',
      'win_rate',
      'three_bets',
      'faced_three_bets',
      'cbet_opportunities',
    ]) {
      expect(body, key).toContain(`'${key}'`);
    }
    expect(body).toMatch(/LEGACY, one release/);
  });

  it('tells a member the difference between not-a-member and restricted', () => {
    expect(body).toContain("THEN 'not_member' ELSE 'restricted' END");
    expect(body).toContain('v_viewer_is_member AND NOT v_target_is_member');
  });

  it('never filters on whether a player is house-run', () => {
    expect(MIGRATION).not.toMatch(/is_horse/);
  });
});

describe('the service reads the new keys and falls back to the old', () => {
  it('maps hands / hands_won / win_rate / fold_to_three_bet / reason', () => {
    // The `?? d.total_hands` / `?? d.wins` fallbacks rode for one release
    // and came down with the keys (20260904200000).
    expect(SERVICE).toContain('hands: num(d.hands),');
    expect(SERVICE).toContain('hands_won: num(d.hands_won),');
    expect(SERVICE).toContain('fold_to_three_bet: num(d.fold_to_three_bet)');
    expect(SERVICE).toContain(
      "reason: d.reason === 'not_member' || d.reason === 'restricted' ? d.reason : null"
    );
  });
});

describe('the statistics page', () => {
  it('labels the 3-bet figure as per hand and shows fold-to-3-bet with its opportunity count', () => {
    expect(STATS).toContain('label="3-Bet Per Hand"');
    expect(STATS).toContain('label="Fold To 3-Bet"');
    expect(STATS).not.toContain('label="3-Bet"');
  });

  it('shows hands, hands won and win rate, not the same number twice', () => {
    expect(STATS).toContain('label="Hands"');
    expect(STATS).toContain('label="Hands Won"');
    expect(STATS).toContain('label="Win Rate"');
    expect(STATS).not.toContain('label="Total Games"');
    expect(STATS).not.toContain('label="Winner"');
  });

  it('resolves the club strictly and checks the user id before any uuid RPC', () => {
    const load = sliceMethod(STATS, 'const load = useCallback');
    expect(load).toContain('resolveClubUUIDStrict(clubId)');
    expect(load).toContain('if (!isUUID(userId)) {');
    expect(load).toContain('e instanceof ClubNotFoundError');
    expect(STATS).not.toMatch(/\bresolveClubUUID\(/);
  });

  it('reaches "not found" from the server reason, and marks the range tabs', () => {
    expect(STATS).toContain("setNotFound(!result.authorized && result.reason === 'not_member')");
    expect(STATS).toContain('aria-pressed={rangeMode === mode}');
    expect(STATS).toContain("? 'Loading The Selected Range...'");
    expect(STATS).toContain('aria-busy={loading}');
  });

  it('keeps production certification aligned with every real range control', () => {
    expect(STATS).toContain("day: 'Day'");
    expect(STATS).toContain("week: 'Week'");
    expect(STATS).toContain("month: 'Month'");
    expect(STATS).toContain("custom: 'Custom'");
    expect(PRODUCTION_PLAYERS).toContain("['Day', 'Week', 'Month', 'Custom']");
    expect(PRODUCTION_PLAYERS).not.toContain("['Overall', '7 Days', 'Custom']");
  });
});

describe('the member record', () => {
  it('resolves strictly and names a missing club or member instead of an outage', () => {
    const load = sliceMethod(MEMBER, 'const loadDetail = useCallback');
    expect(load).toContain('resolveClubUUIDStrict(clubId)');
    expect(load).toContain('if (!isUUID(userId)) {');
    expect(load).toContain('setNotFound(true)');
    expect(MEMBER).toContain('const found = !notFound && !!identity?.user_id;');
  });

  it('shows cash and MTT hands, and one wallet row per wallet', () => {
    expect(MEMBER).toContain('label="Cash Hands"');
    expect(MEMBER).toContain('label="MTT Hands"');
    expect(MEMBER).not.toContain('label="Club Chips"');
    expect(MEMBER).toContain('label="Player Wallet"');
  });

  it('hides the upline line from viewers the server hides it from', () => {
    const at = MEMBER.indexOf('label="Upline Agent"');
    expect(at).toBeGreaterThan(-1);
    const before = MEMBER.slice(Math.max(0, at - 400), at);
    expect(before).toContain('detail!.capabilities.can_view_financials && (');
  });

  it('reaches every downline row', () => {
    expect(MEMBER).toContain('const shownDownline = downline.slice(0, downlineShown);');
    expect(MEMBER).toContain('setDownlineShown((n) => n + DOWNLINE_RENDER_CAP)');
    expect(MEMBER).not.toContain('downline.slice(0, DOWNLINE_RENDER_CAP)');
  });

  it('emits bus events with the resolved uuid, never the route slug', () => {
    expect(MEMBER).toContain("masterBus.emit('CLUB_UPDATED', { clubId: resolvedClubId })");
    expect(MEMBER).not.toMatch(/masterBus\.emit\('CLUB_UPDATED', \{ clubId \}\)/);
    expect(MEMBER).not.toMatch(/masterBus\.emit\('AGENT_UPDATED', \{ clubId, /);
  });

  it('adopts the server-normalised note text after a save', () => {
    const save = sliceMethod(MEMBER, 'const save = useCallback');
    expect(save).toContain('if (draftRef.current.nickname === draft.nickname) {');
    expect(save).toContain('draftRef.current.nickname = persisted.nickname;');
    expect(save).toContain('setNicknameUnsaved(false);');
  });

  it('marks the range tabs and dims the figures while a range loads', () => {
    expect(MEMBER).toContain('aria-pressed={rangeMode === mode}');
    expect(MEMBER).toContain("? 'Loading The Selected Range...'");
    expect(MEMBER).toContain('mm-stats--busy');
  });
});

describe('the roster', () => {
  it('reconciles a filter against capabilities only once the summary is fresh', () => {
    expect(ROSTER).toContain("if (summaryFreshness !== 'fresh') return;");
    expect(ROSTER).not.toMatch(/if \(loading\) return;\s+if \(!filters\.includes\(filter\)\)/);
  });

  it('reloads only after realtime confirms that it recovered', () => {
    const channelError = sliceMethod(ROSTER, 'onSubscriptionError: () => {');
    expect(channelError).not.toContain('scheduleConnectionRecovery');
    expect(channelError).not.toContain('latestLoadRef');
    expect(ROSTER).toContain('if (recovered) scheduleStructuralRefresh();');
  });

  it('no longer advances a rollup nothing reads', () => {
    expect(ROSTER).not.toContain('touchFeeRollup');
    expect(ROSTER).not.toContain('shouldTouchFeeRollup');
  });

  it('does not announce "0 Results" before the first page', () => {
    expect(ROSTER).toMatch(/\{loading && !hasVerifiedDirectory\s*\?\s*'Loading\.\.\.'/);
  });

  it('surfaces the export refusal the server gave', () => {
    expect(ROSTER).toContain("safeErrorMessage(error, 'Could Not Export The Roster')");
  });
});

describe('the transfer modal (source pins beside the mount test)', () => {
  it('reads the named recipient directly and offers only members who can receive', () => {
    expect(MODAL).toContain("setPinnedRecipient('missing')");
    expect(MODAL).toContain(".or('status.is.null,status.in.(active,approved)')");
  });

  it('previews the wallet the chips land in', () => {
    expect(MODAL).toContain('const destinationIsAgentWallet =');
    expect(MODAL).toContain("select('agent_wallet_balance')");
  });

  it('is a dialog with labelled fields', () => {
    expect(MODAL).toContain('role="dialog"');
    expect(MODAL).toContain('aria-modal="true"');
    expect(MODAL).toContain('htmlFor="chip-transfer-amount"');
    expect(MODAL).toContain('aria-label="Close"');
  });
});
