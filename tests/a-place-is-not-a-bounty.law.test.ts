/**
 * A PLACE IS NOT A BOUNTY (2026-09-10).
 *
 * `fn_claim_bounty_legacy_candidate_20260907` does two jobs in one call: it
 * RECORDS the elimination - status, finishing place, prize, seat closed - and
 * it SETTLES the bounty. Every gate in it returned `ok:false` for the whole
 * call, so a bounty that could not be settled meant a player who provably
 * busted was never given a finishing place. An unranked player keeps the event
 * from finishing, so the prize escrow was paid to nobody.
 *
 * Measured across the ten events frozen on 2026-09-10: 62 knockout candidates
 * still `pending`, 33 behind a PKO settlement watermark, 33 unable to name an
 * exact pot claimant, only 2 blocked by neither. Zero had a live seat, zero had
 * chips again, zero of their hands had been pruned. 3,600.00 of escrow behind
 * them, the oldest bust 44.7 hours old.
 *
 * Both rules are correct FOR A BOUNTY. `fn_exact_tournament_knockout_claimants`
 * returns NULL rather than name someone who might not have owned the knockout.
 * The watermark refuses an out-of-order bounty and cannot be rewound without
 * letting settled bounties re-settle. Neither says anything about whether a
 * player busted.
 *
 * A finishing place belongs to the PLAYER and is knowable from the bust order.
 * A bounty belongs to a KNOCKER and needs exact evidence. Conflating them lets
 * an unpayable 8.00 head freeze a 600.00 event.
 *
 * THE RULE: a bounty that cannot be settled never withholds a finishing place.
 * The elimination is recorded, the place assigned, no obligation is written,
 * the head stays in the pool for `fn_finalize_bounty_pool` to resolve as
 * residual, and one `financial_alerts` row records that it happened.
 *
 * WHAT MUST NEVER BE WEAKENED, and what this file mostly exists to hold: every
 * EVIDENCE gate. Those answer "did this bust actually happen", and without them
 * a player could be placed on no proof at all.
 *
 * docs/changelog/2026-09-10-a-place-is-not-a-bounty.md
 */
import { describe, it, expect } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const NAME = '20260910145833_a_place_is_not_a_bounty.sql';

const migration = () => {
  const hit = migrationCorpus().find((m) => m.name === NAME);
  expect(hit, `${NAME} must exist`).toBeDefined();
  return hit!.sql;
};

/** The three refusals that used to end the whole call. */
const BOUNTY_REFUSALS = [
  'exact_pot_claimants_not_found',
  'pko_order_already_advanced',
  'exact_head_value_not_found',
];

/** The gates that answer "did this bust happen". These may never be relaxed. */
const EVIDENCE_GATES = [
  'atomic_knockout_evidence_required',
  'accepted_zero_settlement_not_found',
  'exact_knockout_history_not_found',
  'atomic_knockout_candidate_identity_conflict',
  'player_has_chips',
  'status_not_claimable',
  'invalid_place_or_prize',
  'obligation_identity_conflict',
  'bounty elimination CAS missed after locked claim',
];

describe('a place is not a bounty', () => {
  it('an unsettleable bounty sets a flag instead of ending the call', () => {
    const sql = migration();
    for (const reason of BOUNTY_REFUSALS) {
      // the refusal RETURN is gone from the live definition after this migration
      expect(sql, `${reason} must no longer end the elimination call`).toContain(
        `''ok'',false,''reason'',''${reason}''`
      );
      // and the migration asserts its absence afterwards
      expect(sql).toContain('a bounty-settlement refusal still ends the elimination call');
    }
    expect(sql).toContain('v_bounty_blocked text := NULL;');
  });

  it('every evidence gate is asserted to survive', () => {
    const sql = migration();
    for (const gate of EVIDENCE_GATES) {
      expect(sql, `the migration must assert ${gate} survives`).toContain(gate);
    }
    expect(sql).toContain('an evidence gate was lost; a player could be placed on no proof');
  });

  it('the bounty ordering rules still apply when a bounty IS being settled', () => {
    const sql = migration();
    for (const rule of [
      'pending_pko_predecessor',
      'same_hand_pko_predecessor',
      'invalid_knocker',
      'claimants_do_not_match_exact_pot',
    ]) {
      expect(sql).toContain(rule);
    }
    expect(sql).toContain('a bounty ordering rule was lost');
    // each is skipped only when there is no payment to order
    expect(sql).toContain('IF v_bounty_blocked IS NULL AND');
  });

  it('no obligation is written when the head cannot be attributed', () => {
    const sql = migration();
    // the INSERT is gated
    expect(sql).toContain(
      'IF v_bounty_blocked IS NULL THEN\\n  INSERT INTO public.tournament_bounty_obligations('
    );
    // and the head is recorded instead, as a warning so it is not promoted to
    // a drift incident per bust
    expect(sql).toContain('bounty_head_not_attributed');
    expect(sql).toContain("VALUES (''warning''");
    // never as a payment to somebody unproven
    expect(sql).not.toContain('fn_credit_and_log');
  });

  it('the substitution is asserted anchor by anchor and wired end to end', () => {
    const sql = migration();
    expect(sql).toContain('anchor % appears % times in the knockout door, expected exactly 1');
    expect(sql).toContain('the knockout door has % definitions, expected exactly 1');
    expect(sql).toContain('the substitution is incomplete');
  });
});
