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

const MIG = (f: string) =>
  readFileSync(join(__dirname, '../../../supabase/migrations/', f), 'utf8');

/**
 * The migration that INTRODUCED the check, the heartbeat registration and the
 * satellite back-fill. Those three things happened once and live here forever.
 */
const MIGRATION = MIG('20260902041336_a_seat_nobody_paid_for.sql');

/**
 * The migration that holds the body production actually runs.
 *
 * PINNING THE SUPERSEDED MIGRATION IS PINNING HISTORY, NOT THE CONTRACT, and
 * the first version of this file did exactly that: every structural assertion
 * read the body from 20260902041336, which stopped being the live body the
 * moment the awards lookback was corrected. It is the same mistake as reading
 * a law from a stale worktree instead of origin/main - the assertions stay
 * green while describing something that is no longer deployed.
 *
 * WHEN THIS FUNCTION IS CHANGED AGAIN, point FIX at the newest migration in
 * the same commit. A pin that has drifted off the live body is worse than no
 * pin, because it still reports success.
 */
const FIX = sliceSqlStatement(
  MIG('20260902050552_the_awards_lookback_was_a_month_and_needed_six_hours.sql'),
  'CREATE OR REPLACE FUNCTION public.fn_uncollected_entry_check'
);

const GAME_SERVER = readFileSync(join(__dirname, '../GameServer.ts'), 'utf8');

describe('the legitimate ways to hold a seat are enumerated, never inferred', () => {
  it('names all four exemptions in the code that applies them', () => {
    // A check that decides for itself what "looks legitimate" will eventually
    // excuse the next leak too. Each of these is a comment sitting on the
    // clause that implements it, so deleting the clause deletes the label.
    expect(FIX).toContain('EXEMPTION 1');
    expect(FIX).toContain('EXEMPTION 2');
    expect(FIX).toContain('EXEMPTION 3');
    expect(FIX).toContain('EXEMPTION 4');
  });

  it('the ordinary door is a wallet_transactions tournament_buyin debit', () => {
    expect(FIX).toMatch(/category\s*=\s*'tournament_buyin'/);
    expect(FIX).toMatch(/type\s*=\s*'debit'/);
  });

  it('a satellite seat counts through THREE witnesses, because each has a birthday', () => {
    // is_satellite_qualifier has only been written since 2026-08-27 and
    // source_satellite_id since 2026-08-30, and a zero-fee target writes no
    // rake row at all. Any one of the three alone would call a legitimately
    // free seat a leak.
    expect(FIX).toContain("r.source = 'fn_award_satellite_seat'");
    expect(FIX).toContain('NOT s.sat_flag');
    expect(FIX).toContain('s.source_satellite_id IS NULL');
  });

  it('a day past the first is bought by surviving day one', () => {
    expect(FIX).toMatch(/s\.day_number > 1 OR s\.parent_tournament_id IS NOT NULL/);
  });

  it('a freeroll owes no entry', () => {
    expect(FIX).toMatch(/buy_in_amount,\s*0\)\s*\+\s*COALESCE\(t\.buy_in_fee,\s*0\)\s*>\s*0/);
  });
});

describe('the window cannot reach back past the evidence', () => {
  it('refuses any window starting before wallet_transactions carried the debit', () => {
    // The first tournament_buyin row in wallet_transactions is 2026-08-19.
    // Before that an absent debit proves the LOGGER was absent, not the
    // payment - 22,981 healthy seats sit behind that date, and a check that
    // read them would report a catastrophe that never happened.
    expect(FIX).toContain("timestamptz '2026-08-19 00:00:00+00'");
    expect(FIX).toContain('window_predates_the_evidence');
  });

  it('is bounded, for the reason every other check on this platform is bounded', () => {
    // fn_spin_unpaid_check timed out on every call and said so to nobody;
    // fn_cash_pot_conservation_check reached its ceiling and was cut to 48h.
    // A check that cannot finish tells nobody anything.
    expect(FIX).toMatch(/LEAST\(GREATEST\(COALESCE\(p_since_hours,\s*24\),\s*1\),\s*48\)/);
  });

  it('both evidence CTEs share ONE buffer, and it is not a month', () => {
    // SHIPPED WRONG AND CAUGHT IN VERIFICATION. The awards CTE looked back 30
    // days on the reasoning that a satellite seat might be awarded long before
    // its target event runs - which confuses the target's START with the
    // seat's CREATION. fn_award_satellite_seat writes the rake row and the
    // roster row in the SAME statement, verified on all 23 awards: created_at
    // equals registered_at exactly, worst gap 0.000000 seconds.
    //
    // rake_records has no index on `source`, so the month walked the
    // created_at index discarding 644,620 rows to find 23. On buffers, which
    // database load does not move: 231,267 before, 90,202 after.
    expect(FIX).not.toMatch(/interval '30 days'/);
    expect(FIX).toContain("c_evidence_buffer constant interval := interval '6 hours'");
    // Both CTEs, not one. A buffer only half-applied is the drift this
    // constant exists to prevent.
    const uses = FIX.match(/v_since - c_evidence_buffer/g) ?? [];
    expect(uses).toHaveLength(2);
  });
});

describe('it is a check, not a cure', () => {
  it('moves no money', () => {
    // Reporting and paying are different jobs. Phase 1's fn_money_check_health
    // holds the same line, and the back-pay functions that DO move money are
    // separate, named, and idempotent.
    expect(FIX).not.toContain('fn_credit_and_log');
    expect(FIX).not.toContain('fn_credit_player_wallet_once');
    expect(FIX).not.toMatch(/UPDATE\s+public\.club_members/);
    expect(FIX).not.toMatch(/UPDATE\s+(public\.)?tournament_players/);
  });

  it('files one open alert for the condition, not one per seat', () => {
    // 464 per-seat alerts would have buried themselves, which is the failure
    // the dedupe key exists to stop.
    expect(FIX).toContain("'uncollected_entry'");
  });

  it('is closed to browser roles, in EVERY migration that redefines it', () => {
    // CREATE OR REPLACE does not reset an ACL, so a later migration inheriting
    // the right grants by accident is not the same as declaring them. Each
    // file that declares this SECURITY DEFINER function says on its own face
    // who may call it - which is also what check-definer-authorization reads,
    // one migration at a time.
    const revoke =
      /REVOKE ALL ON FUNCTION public\.fn_uncollected_entry_check\(integer\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/;
    const grant =
      /GRANT EXECUTE ON FUNCTION public\.fn_uncollected_entry_check\(integer\) TO service_role;/;
    for (const [name, sql] of [
      ['20260902041336', MIGRATION],
      [
        '20260902050552',
        MIG('20260902050552_the_awards_lookback_was_a_month_and_needed_six_hours.sql'),
      ],
    ] as const) {
      expect(sql, `${name} does not revoke browser access`).toMatch(revoke);
      expect(sql, `${name} does not grant service_role`).toMatch(grant);
    }
  });

  it('names its own blind spot rather than pretending it has none', () => {
    // atomic_tournament_register debits club_members.chip_balance directly and
    // writes NEITHER chip_transactions NOR wallet_transactions, so a seat it
    // created would be reported here despite the player having paid. It has
    // had no caller since 2026-08-15, when fn_register_for_tournament replaced
    // it, and it sits on the fn_union_law_check watch list - so retiring it
    // belongs to that workstream. What belongs here is saying so in the alert,
    // where whoever reads the alert will be standing.
    expect(FIX).toContain('known_blind_spot');
    expect(FIX).toContain('atomic_tournament_register');
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
    // THIS PIN WAS VACUOUS WHEN FIRST WRITTEN, and was caught by reading what
    // the slice actually returns rather than trusting a green tick. It sliced
    // from `const { data: ue, error: ueErr } = await supabase` and asserted the
    // slice contained 'fn_uncollected_entry_check' - but the RPC name is on
    // that very line, so the assertion could not fail while the code existed
    // at all. It tested nothing while its NAME claimed to verify the try-block
    // isolation, which is the exact property Phase 1's verification caught me
    // getting wrong in the block above this one.
    //
    // What the structure actually has to be:
    //   try {  ...call...  ...stamp...  } catch (ueEx) { report }
    // with the whole thing CLOSED before the health read opens.
    const openAt = GAME_SERVER.indexOf('const { data: ue, error: ueErr } = await supabase');
    const stampAt = GAME_SERVER.indexOf("this.recordMoneyCheckRun('fn_uncollected_entry_check'");
    const catchAt = GAME_SERVER.indexOf('catch (ueEx)');
    const healthAt = GAME_SERVER.indexOf("'fn_money_check_health'");

    expect(openAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(-1);
    // The stamp is inside the try, between the call and the catch - so a
    // failure of the rpc cannot leave a heartbeat claiming the check ran.
    expect(stampAt).toBeGreaterThan(openAt);
    expect(catchAt).toBeGreaterThan(stampAt);
    // And the catch closes before the health read opens, so a throw here
    // cannot silence the instrument that notices checks going quiet.
    expect(healthAt).toBeGreaterThan(catchAt);
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
