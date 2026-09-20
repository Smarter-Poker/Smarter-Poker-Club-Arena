/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN APPROVAL CAN BE RETRIED, AND A DECLARED FREEZE MEANS SOMETHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-05, phase 7 of the club operations upgrade)
 *
 * The write paths are the best-defended code in this workspace and this phase
 * does not touch them. What was wrong is what wrapped around them, and every
 * item below was proved against production inside a transaction that was
 * rolled back (CLAUDE.md 11.5) before anything changed:
 *
 *   - APPROVING A CHIP REQUEST COULD NOT BE RETRIED. It called
 *     fn_agent_wallet_send with gen_random_uuid() - a fresh retry key every
 *     time - so a lost response left the chips moved and the request approved
 *     while the operator's retry was told "request already approved", which
 *     the client turns into a red toast. Money moved; the person who moved it
 *     was told it had not. chip_requests has carried an `op_id` column and a
 *     unique index on (club_id, requester_id, op_id) since requests were made
 *     idempotent, so the key was designed in and the approval never used one.
 *
 *     Proved, rolled back: approve #1 -> {"success": true, "replayed": false};
 *     the same call again -> {"success": true, "replayed": true,
 *     "transaction_id": ..., "amount": 12.34}; and exactly ONE send exists
 *     under the derived key.
 *
 *   - A DECLARED SETTLEMENT FREEZE FROZE NOTHING. Measured: the only two
 *     functions in the database that read clubs.settlement_locked are
 *     expire_settlement_locks (the sweep that clears it) and
 *     ca_club_operations_overview (which displays it). No money function read
 *     it at all. checkSettlementLock exists in the client, fails open by
 *     design, and is called from the classic cashier only.
 *
 *     Proved, rolled back: with a freeze declared, approving a chip request
 *     answers "this club is squaring its books - approvals resume when the
 *     settlement freeze lifts"; with it lifted, the same approval succeeds.
 *
 *   - THE SETTLEMENT PAGE WROTE WITH THE ROUTE PARAM. `.eq('id', clubId)` with
 *     a club code against a uuid column, on both the read and the write; the
 *     read's failure was swallowed as "non-critical" so a club with
 *     auto-settlement ON rendered OFF, and the write had no .select(), so an
 *     RLS refusal (clubs is UPDATE-able only by owner_id = auth.uid(), which a
 *     co-owner or admin is not) returned 204 with no error and the page
 *     toasted "Auto-settlement enabled".
 *
 *   - THE TWO CASHIERS DISAGREED ABOUT WHAT A CHIP IS. The classic page
 *     refused any fraction, citing an integer ledger column;
 *     club_members.chip_balance is numeric(20,2). See
 *     tests/unit/CashierAmountValidation.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sliceDollarQuoted, sliceMethod } from '../helpers/sourceWindow';

const MIGRATION = readFileSync(
  'supabase/migrations/20260905040100_an_approval_can_be_retried_and_a_freeze_means_something.sql',
  'utf8'
);
const SETTLEMENT = readFileSync('src/pages/SettlementPage.tsx', 'utf8');
const SETTLEMENT_SERVICE = readFileSync('src/services/SettlementService.ts', 'utf8');
const PERIOD_MIGRATION = readFileSync(
  'supabase/migrations/20260905041500_a_settlement_period_belongs_to_a_club.sql',
  'utf8'
);
const AGENT_MIGRATION = readFileSync(
  'supabase/migrations/20260905042100_the_agent_breakdown_reads_the_attributions.sql',
  'utf8'
);
const INDEX_MIGRATION = readFileSync(
  'supabase/migrations/20260905042500_and_an_index_for_the_range_it_reads.sql',
  'utf8'
);
/**
 * The correction that made the rewrite actually pay. The same shape was found
 * in the bomb pot report an hour after this shipped: the live half was bounded
 * by the REQUESTED window and relied on an anti-join to keep only the days the
 * rollup had not finished. An anti-join removes rows from the RESULT, not from
 * the scan - 573,468 rows read to keep 14,091 - so the live edge is bounded by
 * the earliest incomplete day now, and the anti-join stays for the days above
 * that floor which the rollup skipped and later filled.
 */
const LIVE_BOUND_MIGRATION = readFileSync(
  'supabase/migrations/20260905052500_and_the_rake_breakdown_live_edge_is_bounded_the_same_way.sql',
  'utf8'
);
const CASHIER = readFileSync('src/pages/CashierPage.tsx', 'utf8');

const fn = (name: string) => {
  const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(MIGRATION.slice(start), '$function$');
};

describe('the approval carries the same retry key on every attempt', () => {
  const body = fn('fn_respond_chip_request');

  it('derives the key from the request instead of minting a new one', () => {
    expect(body).toContain("md5('chip_request_approve:' || p_request_id::text)::uuid");
    expect(body).not.toContain('gen_random_uuid()');
    expect(body).toContain("'player_wallet', 'Chip Request Approved', v_op_id");
  });

  it('a retry after a lost response reports the original receipt, not a failure', () => {
    expect(body).toContain('if v_req.responded_by = v_me then');
    expect(body).toContain("'replayed', true");
    expect(body).toContain("'transaction_id', v_prior.id");
  });

  it('only claims a replay against a transaction it can actually see', () => {
    // Approvals made before this migration used a random key, so nothing is
    // found under the derived one and the honest refusal stands. Re-sending
    // those is the one outcome that would move money twice.
    expect(body).toContain("ct.metadata ->> 'op_id' = v_op_id::text");
    expect(body).toContain(
      "return jsonb_build_object('success', false, 'error', 'request already '"
    );
  });

  it('still refuses what it always refused', () => {
    expect(body).toContain('only the requester may cancel');
    expect(body).toContain('this request is not addressed to you');
    expect(body).toContain('you cannot approve your own request');
    expect(body).toContain('for update');
  });
});

describe('a declared settlement freeze stops operator movement', () => {
  it('honours the expiry rather than trusting the sweep to have run', () => {
    const body = fn('fn_club_settlement_frozen');
    expect(body).toContain('c.settlement_locked');
    expect(body).toContain('c.settlement_lock_until IS NULL OR c.settlement_lock_until > now()');
  });

  it('is enforced by a trigger on the money table, not bolted into each function', () => {
    // The same pattern the platform already uses for the maintenance freeze,
    // so a money path nobody remembered cannot slip past it.
    expect(MIGRATION).toContain('CREATE TRIGGER zz_settlement_freeze_guard');
    expect(MIGRATION).toContain('BEFORE INSERT ON public.chip_transactions');
  });

  it('freezes operator movement and never a hand being played', () => {
    const guard = fn('fn_refuse_operator_move_while_settling');
    for (const t of [
      'agent_wallet_send',
      'agent_wallet_claim_back',
      'club_bank_send',
      'club_bank_claim',
      'promo_wallet_send',
      'commission_claim',
    ]) {
      expect(guard, t).toContain(`'${t}'`);
    }
    // fn_atomic_buyin writes a 'mint' row: freezing mints would refuse buy-ins
    // mid-session, and a settlement freeze is not a maintenance break.
    const list = /NOT IN \(([\s\S]*?)\)/.exec(guard)?.[1] ?? '';
    for (const t of ['mint', 'buyin', 'cashout', 'topup', 'tournament_buyin']) {
      expect(list, t).not.toContain(`'${t}'`);
    }
  });

  it('lets the settlement runner through, since the freeze exists for its work', () => {
    const guard = fn('fn_refuse_operator_move_while_settling');
    expect(guard).toContain("'role') = 'service_role'");
    expect(guard).toContain("session_user IN ('postgres', 'supabase_admin')");
  });

  it('says why, in a sentence a person can act on', () => {
    expect(fn('fn_refuse_operator_move_while_settling')).toContain('SETTLEMENT_FROZEN');
    expect(fn('fn_respond_chip_request')).toContain(
      'this club is squaring its books - approvals resume when the settlement freeze lifts'
    );
  });

  it('the migration refuses to commit the old shapes', () => {
    const block = sliceDollarQuoted(MIGRATION.slice(MIGRATION.lastIndexOf('DO $$')), '$$');
    expect(block).toContain(
      'approving a chip request still mints a fresh retry key on every attempt'
    );
    expect(block).toContain('a declared settlement freeze still stops nothing');
    expect(block).toContain(
      'the settlement guard would refuse gameplay, not just operator movement'
    );
  });
});

describe('weekly accounting browser controls observe only', () => {
  it('mounts an explicit route scope instead of reading or writing the auto-settlement flag', () => {
    expect(SETTLEMENT).toContain('WeeklyAccountingWorkspace');
    expect(SETTLEMENT).toContain('scopeRef={reference}');
    expect(SETTLEMENT).not.toContain('auto_settlement');
    expect(SETTLEMENT).not.toContain('handleToggleAutoSettlement');
  });
});

describe('one definition of a chip', () => {
  it('the classic cashier accepts the two decimals the ledger column holds', () => {
    expect(CASHIER).toContain('Chips go to two decimal places');
    expect(CASHIER).not.toContain('Chips must be a whole number');
    expect(CASHIER).toContain('Math.round(value * 100) !== value * 100');
  });

  it('and still refuses what it always refused', () => {
    expect(CASHIER).toContain('MAX_CHIP_AMOUNT');
    expect(CASHIER).toContain('Amount exceeds the maximum transfer limit');
  });
});

describe('the settlement period belongs to the club whose page it heads', () => {
  /**
   * Measured: the single OPEN period on the platform today is `5a9811f0`,
   * club_id NULL, union-scoped, running 2026-08-16 to 2026-08-23 - so
   * get_current_settlement_period(), which takes no club and returns the
   * newest open period, headed EVERY club's settlement page with a period
   * belonging to no club at all. The client then hardcoded periodNumber 1,
   * this year and four zeroes over columns the row actually carries
   * (period_number, year, total_bbj_contributions, total_player_winnings,
   * total_player_losses, total_hands_dealt), which is what drew the permanent
   * "Period 1/2026" over a grid of zeros.
   */
  it('asks for one club, and says whose period it found', () => {
    expect(PERIOD_MIGRATION).toContain('get_current_settlement_period(p_club_id uuid)');
    expect(PERIOD_MIGRATION).toContain("THEN 'club' ELSE 'union' END");
    expect(PERIOD_MIGRATION).toContain('ca_can_view_club(p_club_id)');
  });

  it("prefers the club's own period over its union's, and invents nothing", () => {
    expect(PERIOD_MIGRATION).toContain("WHEN sp.club_id = p_club_id AND sp.status = 'open'");
    expect(PERIOD_MIGRATION).toContain("sp.status IN ('processing','disputed')");
    expect(PERIOD_MIGRATION).toContain('ORDER BY c.rank, c.start_at DESC');
    // No INSERT: the club-scoped lookup never creates a period.
    expect(PERIOD_MIGRATION).not.toMatch(/INSERT INTO settlement_periods/i);
  });

  it('retires both old getter contracts without a fallback', () => {
    expect(SETTLEMENT_SERVICE).toContain('async getCurrentPeriodForClub');
    expect(SETTLEMENT_SERVICE).toContain('throw new AutomaticWeeklyAccountingOnlyError()');
    expect(SETTLEMENT_SERVICE).not.toContain("supabase.rpc('get_current_settlement_period'");
  });
  it('uses the scoped workspace and does not turn a period status into a payment receipt', () => {
    expect(SETTLEMENT).toContain('scopeKind={kind}');
    expect(SETTLEMENT).not.toContain('SettlementReceipt');
    expect(SETTLEMENT).not.toContain('executeMondayPayouts');
    expect(SETTLEMENT).not.toContain("status={selectedPeriod.settledAt ? 'paid' : 'pending'}");
  });
});

describe('the cashier stops contradicting itself', () => {
  it('says the send can be claimed back, because the same screen says so', () => {
    // The preview three hundred lines above the confirmation reads
    // "Claim Back Window: Ten Minutes". The warning said "This Action Cannot
    // Be Undone" - not a scarier warning but a false one: an operator who
    // believed it would never look for the Claim Back that could save them.
    expect(CASHIER).toContain('You Can Claim This Back For Ten Minutes, And Not After That.');
    expect(CASHIER).not.toContain('This Action Cannot Be Undone');
    expect(CASHIER).toContain('Claim Back Window');
  });

  it('every banner message goes through the one popup rule', () => {
    // CLAUDE.md 5.7: popup copy is Title Cased and em-dash free centrally, in
    // popupStyle.ts, and is never hand-rolled. Applying it at the three render
    // sites covers all 35 setMessage callers without touching one of them.
    const banners = CASHIER.match(/\{formatPopupText\(message\.text\)\}/g) ?? [];
    expect(banners.length).toBe(3);
    expect(CASHIER).not.toContain('{message.text}');
  });
});

describe('the agent breakdown reads the attributions instead of re-deriving them', () => {
  /**
   * Measured in a browser on /clubs/<slug>/data: ca_rake_snapshot 500 after
   * ~8.2s (57014), while ca_club_data_snapshot answered in under a second.
   * Inside it, fn_ca_rake_window is 0.6s, fn_ca_rake_series 0.13s, and
   * fn_ca_rake_by_agent is 29.7 SECONDS - it called fn_rake_shares_for_record
   * once per raked hand for every day not yet rolled up, which is 61,156
   * lookups on the busiest club, every time an operator opened the page.
   * Expanding the same rows set-based from player_contributions still cost
   * 11.5s, so the live edge had to stop being re-derived at all.
   */
  it('groups the attributions the completed-day rollup is built from', () => {
    expect(AGENT_MIGRATION).toContain('FROM public.rake_attributions ra');
    expect(AGENT_MIGRATION).toContain('GROUP BY ra.player_id');
    // Same column and rounding as fn_club_rake_rollup_day, so the live edge
    // and the completed days are one number rather than two definitions.
    expect(AGENT_MIGRATION).toContain('SUM(round(ra.rake_amount * 100)::bigint)::numeric / 100');
    expect(AGENT_MIGRATION).toContain(
      'the agent breakdown still re-derives a share per raked hand'
    );
  });

  /**
   * The index is a SEPARATE migration on purpose. `rake_attributions` takes a
   * row per player per raked hand, so a plain CREATE INDEX blocks the engine's
   * writers for the length of its scan and has to wait for the :55 freeze -
   * and the function change needs no lock at all. Measured with the function
   * changed and NO index yet, ca_rake_snapshot went from 500 after ~8.2s to
   * 200 in 2.1-2.6s through PostgREST as the club owner, so holding the fix
   * back until the freeze would have left the panel failing for no reason.
   */
  it('has an index for the range it now reads, shipped where the lock belongs', () => {
    // Named, not the words "CREATE INDEX": the header of that file EXPLAINS
    // why a plain CREATE INDEX cannot ship with it, and a pin that cannot tell
    // code from the prose beside it fails on the explanation. That exact
    // mistake cost this migration its first apply.
    expect(AGENT_MIGRATION).not.toContain('idx_rake_attributions_club_created');
    expect(AGENT_MIGRATION).toContain('20260905042500');
    expect(INDEX_MIGRATION).toContain('idx_rake_attributions_club_created');
    expect(INDEX_MIGRATION).toContain('ON public.rake_attributions (club_id, created_at)');
    expect(INDEX_MIGRATION).toContain('INCLUDE (player_id, rake_amount)');
    expect(INDEX_MIGRATION).toContain(':55 MAINTENANCE FREEZE');
  });

  it('bounds the live scan by the earliest incomplete day, not by the window', () => {
    // Measured as postgres with the owner's claims: 3.7-5.2s before this
    // bound, 983ms after, for the page's default month range. From the
    // browser, ca_rake_snapshot went to 1.3-1.6s.
    expect(LIVE_BOUND_MIGRATION).toContain('ra.created_at >= v_live');
    expect(LIVE_BOUND_MIGRATION).toContain('public.club_rake_rollup_complete rc');
    // The anti-join is not replaced by the bound, it is narrowed by it.
    expect(LIVE_BOUND_MIGRATION).toContain('NOT EXISTS (SELECT 1 FROM ok_days o');
    // And the correction re-asserts both of the things that went wrong today:
    // the per-hand allocator stays gone, and the helper stays shut.
    expect(LIVE_BOUND_MIGRATION).toContain(
      'the agent breakdown re-derives a share per raked hand again'
    );
    expect(LIVE_BOUND_MIGRATION).toContain(
      'the ungated breakdown helper is open to authenticated again'
    );
  });

  it('proves equivalence under a snapshot rather than against a moving figure', () => {
    // The first comparison ran READ COMMITTED and the month range came back
    // different while every other case matched: each statement takes a fresh
    // snapshot and this club produces rake continuously. Pinned to one
    // snapshot, old and new agree exactly.
    expect(LIVE_BOUND_MIGRATION).toContain('PROVED EQUIVALENT UNDER REPEATABLE READ');
  });

  it('still only rolls up the days that are complete, live-reading the rest', () => {
    expect(AGENT_MIGRATION).toContain('FROM public.club_rake_daily_user rd');
    expect(AGENT_MIGRATION).toContain('NOT EXISTS (SELECT 1 FROM ok_days o');
  });

  it('keeps every guard the breakdown already had', () => {
    // The denominator is the club, not the search result; the count is
    // counted rather than windowed; the drill-down keeps its three conditions.
    expect(AGENT_MIGRATION).toContain('The denominator is the club, not the search result.');
    expect(AGENT_MIGRATION).toContain("'total', (SELECT count(*) FROM filtered)");
    expect(AGENT_MIGRATION).toContain('fn_is_agent_ancestor(v_uid, ca.user_id, p_club_id)');
  });
});
