/**
 * A SEAT NOBODY PAID FOR (2026-09-02, Phase 2 of 6).
 *
 * Every other money check on this platform asks whether the money that came IN
 * reached the players it was owed to. This one asks the question underneath
 * them: did it come in at all.
 *
 * IT HAPPENED, AND THE NUMBERS BELOW ARE MEASURED, NOT ILLUSTRATIVE.
 * Between 2026-08-19 00:01 and 2026-08-20 23:45, 464 seats across 81 events
 * held a place in a paid tournament with no entry paid for them - horses
 * SEEDED into fields rather than registered into them. Two independent
 * witnesses agree: no `wallet_transactions` debit and no `chip_transactions`
 * row, so no wallet moved. `rake_records` proves the register functions never
 * ran at all - across the 39 COMPLETED events in that window there is exactly
 * ONE rake row, from fn_spin_settle_game. Those events collected 6.00 chips of
 * entry and 0.00 of fees, and paid out 1,734.00 in prizes.
 *
 * THE CAUSE WAS FIXED BEFORE THIS FILE EXISTED, and not by this phase.
 * fn_register_horse_for_tournament began charging horses real chips on
 * 2026-08-19 - what tournamentRecovery calls "the day the old rule 'horses
 * paid nothing' became false" - and the last unfunded seat on the platform was
 * created the following night. A horse pays the same buy-in, the same fee and
 * the same rake as anybody else, which is section 10.5 and not a tuning knob.
 *
 * What was missing is that NOTHING would have noticed it running, and nothing
 * would notice it coming back. Each pin below is one of the ways that blindness
 * gets back in. Fix your change; never weaken a pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceBlockAfter, sliceSqlStatement } from '../testHelpers/sourceWindow.js';

const MIGRATION = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260902041336_a_seat_nobody_paid_for.sql'),
  'utf8'
);
const GAME_SERVER = readFileSync(join(__dirname, '../GameServer.ts'), 'utf8');

/** The body of the detector, bounded by its own dollar quotes. */
const FN = sliceSqlStatement(
  MIGRATION,
  'CREATE OR REPLACE FUNCTION public.fn_uncollected_entry_check'
);

describe('the legitimate ways to hold a seat are enumerated, never inferred', () => {
  it('names all four exemptions in the code that applies them', () => {
    // A check that decides for itself what "looks legitimate" will eventually
    // excuse the next leak too. Each of these is a comment sitting on the
    // clause that implements it, so deleting the clause deletes the label.
    expect(FN).toContain('EXEMPTION 1');
    expect(FN).toContain('EXEMPTION 2');
    expect(FN).toContain('EXEMPTION 3');
    expect(FN).toContain('EXEMPTION 4');
  });

  it('the ordinary door is a wallet_transactions tournament_buyin debit', () => {
    expect(FN).toMatch(/category\s*=\s*'tournament_buyin'/);
    expect(FN).toMatch(/type\s*=\s*'debit'/);
  });

  it('a satellite seat counts through THREE witnesses, because each has a birthday', () => {
    // is_satellite_qualifier has only been written since 2026-08-27 and
    // source_satellite_id since 2026-08-30, and a zero-fee target writes no
    // rake row at all. Any one of the three alone would call a legitimately
    // free seat a leak.
    expect(FN).toContain("r.source = 'fn_award_satellite_seat'");
    expect(FN).toContain('NOT s.sat_flag');
    expect(FN).toContain('s.source_satellite_id IS NULL');
  });

  it('a day past the first is bought by surviving day one', () => {
    expect(FN).toMatch(/s\.day_number > 1 OR s\.parent_tournament_id IS NOT NULL/);
  });

  it('a freeroll owes no entry', () => {
    expect(FN).toMatch(/buy_in_amount,\s*0\)\s*\+\s*COALESCE\(t\.buy_in_fee,\s*0\)\s*>\s*0/);
  });
});

describe('the window cannot reach back past the evidence', () => {
  it('refuses any window starting before wallet_transactions carried the debit', () => {
    // The first tournament_buyin row in wallet_transactions is 2026-08-19.
    // Before that an absent debit proves the LOGGER was absent, not the
    // payment - 22,981 healthy seats sit behind that date, and a check that
    // read them would report a catastrophe that never happened.
    expect(FN).toContain("timestamptz '2026-08-19 00:00:00+00'");
    expect(FN).toContain('window_predates_the_evidence');
  });

  it('is bounded, for the reason every other check on this platform is bounded', () => {
    // fn_spin_unpaid_check timed out on every call and said so to nobody;
    // fn_cash_pot_conservation_check reached its ceiling and was cut to 48h.
    // A check that cannot finish tells nobody anything.
    expect(FN).toMatch(/LEAST\(GREATEST\(COALESCE\(p_since_hours,\s*24\),\s*1\),\s*48\)/);
  });
});

describe('it is a check, not a cure', () => {
  it('moves no money', () => {
    // Reporting and paying are different jobs. Phase 1's fn_money_check_health
    // holds the same line, and the back-pay functions that DO move money are
    // separate, named, and idempotent.
    expect(FN).not.toContain('fn_credit_and_log');
    expect(FN).not.toContain('fn_credit_player_wallet_once');
    expect(FN).not.toMatch(/UPDATE\s+public\.club_members/);
    expect(FN).not.toMatch(/UPDATE\s+(public\.)?tournament_players/);
  });

  it('files one open alert for the condition, not one per seat', () => {
    // 464 per-seat alerts would have buried themselves, which is the failure
    // the dedupe key exists to stop.
    expect(FN).toContain("'uncollected_entry'");
  });

  it('is closed to browser roles', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_uncollected_entry_check\(integer\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_uncollected_entry_check\(integer\) TO service_role;/
    );
  });
});

describe('a check that never runs looks like a check finding nothing', () => {
  it('is registered in the heartbeat the moment it exists', () => {
    // Phase 1's rule. Without the row, a check that never fires has no age and
    // reads as nothing rather than as missing.
    expect(MIGRATION).toContain('INSERT INTO public.money_check_heartbeat');
    expect(MIGRATION).toContain("'fn_uncollected_entry_check', 60,");
  });

  it('is stamped by the DRIVER on every hourly pass', () => {
    expect(GAME_SERVER).toContain("this.recordMoneyCheckRun('fn_uncollected_entry_check'");
  });

  it('reports both a failed call and a thrown one', () => {
    // A swallowed error here restores exactly the silence this phase exists to
    // end.
    expect(GAME_SERVER).toContain('GameServer.uncollected_entry_check_failed');
    expect(GAME_SERVER).toContain('GameServer.uncollected_entry_check_threw');
  });

  it('runs in its own try block, so a throw elsewhere cannot skip it', () => {
    const block = sliceBlockAfter(GAME_SERVER, 'const { data: ue, error: ueErr } = await supabase');
    expect(block).toContain('fn_uncollected_entry_check');
  });

  it('the health board still reads LAST, after this stamp too', () => {
    // Matched on the RPC names alone, never on surrounding whitespace: a pin
    // that reads formatting fails on a Prettier run that means nothing.
    const stampAt = GAME_SERVER.indexOf("this.recordMoneyCheckRun('fn_uncollected_entry_check'");
    const healthAt = GAME_SERVER.indexOf("'fn_money_check_health'");
    expect(stampAt).toBeGreaterThan(-1);
    expect(healthAt).toBeGreaterThan(stampAt);
  });
});

describe('a satellite seat is a payout, and the record had never once been written', () => {
  it('back-fills from the rake row the awarding function itself wrote', () => {
    // fn_award_satellite_seat gained its payout-record block in migration
    // 20260831192927 (2026-08-31 19:29). The last satellite seat on this
    // platform was awarded 2026-08-30 20:10. The block is not broken - it has
    // simply never executed, and the 23 seats that predate it carried no
    // record. Every field is reconstructed from that rake row; none is
    // inferred.
    expect(MIGRATION).toContain('INSERT INTO public.tournament_payouts');
    expect(MIGRATION).toContain("r.source = 'fn_award_satellite_seat'");
    expect(MIGRATION).toContain("'reconstructed_from', 'rake_records row written by");
  });

  it('uses the key the live function uses, so a re-drive writes nothing', () => {
    // Same shape as the key inside fn_award_satellite_seat. If these two ever
    // disagree the back-fill and the live path stop deduplicating each other
    // and the next award double-records.
    expect(MIGRATION).toContain(
      "'tourney:' || (r.metadata->>'satellite_id') || ':seat:' || (r.metadata->>'user_id')"
    );
    expect(MIGRATION).toMatch(/ON CONFLICT \(idempotency_key\).*DO NOTHING/s);
  });

  it('leaves an unknown finishing position NULL rather than guessing one', () => {
    expect(MIGRATION).toContain('A guessed position would');
    expect(MIGRATION).toContain('LEFT JOIN public.tournament_players sp');
  });
});

describe('the migration proves its own claims on the way in', () => {
  it('refuses to land if the back-fill is short', () => {
    expect(MIGRATION).toContain('satellite seat backfill is short');
  });

  it('runs the check once and refuses to land if it errors', () => {
    expect(MIGRATION).toContain('fn_uncollected_entry_check did not return ok');
  });

  it('refuses to land if the check was not registered', () => {
    expect(MIGRATION).toContain('the new check was not registered in money_check_heartbeat');
  });

  it('records the positive control, because a detector that returns zero everywhere is not one', () => {
    // Pointed at the known-bad window the identical logic returns 464 / 81 /
    // 2,530.80 - reached independently from chip_transactions before the
    // function was written. Pointed at the live window it returns 0.
    expect(MIGRATION).toContain('POSITIVE CONTROL');
    expect(MIGRATION).toContain('464 seats / 81 events');
  });
});
