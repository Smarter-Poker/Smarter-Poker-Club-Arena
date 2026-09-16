/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE SUPPLY METER COUNTS THE TICKETS IT ISSUED (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Five of the sixteen drift incidents open on the morning of 2026-09-11 were
 * fn_ca_supply_snapshot reporting that the chip supply had moved beyond
 * ledgered issuance: -400.00, -415.82, -114.18, -194.41, -175.59 in the hours
 * 01:00 to 05:00 UTC. No chips moved beyond issuance. The meter was looking
 * away.
 *
 * ticket_issue moves chips from prize_liability into the store 'escrow'.
 * fn_ca_supply_snapshot counted fourteen stores and 'escrow' was not one of
 * them, and fn_ca_noncirculating_chip_stores did not name it either - so the
 * move was neither counted as a balance nor treated as retirement. Every
 * ticket issued read as chips leaving the world; every redeem, as chips
 * arriving from nowhere.
 *
 * Measured over the sixty hours to 15:00 UTC, EVERY hour with a nonzero
 * unexplained figure had a matching escrow movement of the opposite sign, and
 * the six incident hours summed to exactly -1400.00 against exactly +1400.00
 * of escrow. That is not a correlation, it is the same number twice.
 *
 * THE LAW, and the half that matters more than the ticket: every store the
 * chip journal will accept declares how the supply basis treats it. counted,
 * with the component that holds it named; noncirculating, so crossing it is
 * mint or burn; or uncounted, which raises a finding the moment it moves. A
 * store the journal accepts and the coverage table has never heard of is
 * refused at first use. The escrow store was uncounted for as long as tickets
 * have existed and nothing said so, which is the actual defect here - the
 * missing ticket float is just the first bill for it.
 *
 * WHAT MUST NOT HAPPEN TO THIS LAW. The cheap way to quiet the meter is the
 * 100 / 300 thresholds. They are pinned below at the values that were catching
 * this correctly, so raising them to hide a leak turns this file red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read('supabase/migrations/20260911161027_the_supply_meter_counts_the_tickets_it_issued.sql');

const fnBody = (name: string): string => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} is not in the migration`).toBeGreaterThan(-1);
  const end = SQL.indexOf('$function$;', start);
  expect(end, `${name} has no closing $function$`).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

describe('the migration obeys the production DDL policy', () => {
  it('is one transaction, so one schema cache reload and not ten', () => {
    expect(SQL.match(/^BEGIN;/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;/gm)?.length).toBe(1);
  });

  it('does not probe the money journal to prove its own trigger', () => {
    // chip_ledger carries its own triggers; a probe row, even rolled back, is
    // not something to fire at production. pg_trigger is read instead.
    const proof = SQL.slice(SQL.indexOf('-- 7. prove it'));
    expect(proof).not.toMatch(/INSERT INTO public\.chip_ledger/);
    expect(proof).toMatch(/FROM pg_trigger t JOIN pg_proc p/);
  });
});

describe('the ticket float is in the basis', () => {
  const snap = fnBody('fn_ca_supply_snapshot');

  it('the float is the chips behind OUTSTANDING tickets, not every ticket ever', () => {
    const float = fnBody('fn_ca_ticket_escrow_float');
    expect(float).toMatch(/FROM public\.tournament_tickets t/);
    expect(float).toMatch(/WHERE t\.status = 'issued'/);
    // a redeemed or cancelled ticket has already given its chips back
    expect(float).not.toMatch(/status = 'redeemed'/);
  });

  it('the meter reads it', () => {
    expect(snap).toMatch(/public\.fn_ca_ticket_escrow_float\(\)\s+AS ticket_escrow/);
  });

  it('and ADDS it to the total, which is the whole fix', () => {
    // Selecting it and forgetting to add it would leave the incident open and
    // the column looking as though someone had dealt with it.
    expect(snap).toMatch(/\+ s\.tourn_liab \+ s\.lb_liab \+ s\.ticket_escrow;/);
  });

  it('and stores it, so the next reader can see the component and not just the total', () => {
    expect(snap).toMatch(/ticket_escrow, total,/);
    expect(snap).toMatch(/s\.ticket_escrow, v_total,/);
  });

  it('the basis version moves, so the first snapshot is not compared across bases', () => {
    // unexplained is NULLed when basis_version differs from the previous row.
    // Without the bump, the first snapshot on the new basis reads as a jump the
    // size of the entire ticket float and files a critical incident.
    expect(snap).toMatch(/v_basis CONSTANT text := 'ticket-escrow-v3';/);
    expect(snap).not.toMatch(/'escrow-liability-v2'/);
    expect(snap).toMatch(/COALESCE\(prev\.basis_version,''\) <> v_basis THEN NULL/);
  });

  it('THE THRESHOLD IS NOT THE FIX: 100 in the hour, 300 over four, unchanged', () => {
    expect(snap).toMatch(/abs\(v_unexplained\) > 100 AND abs\(v_trailing\) > 300/);
    expect(snap).toMatch(/abs\(v_unexplained\) > 25000/);
  });

  it('and the kill switch still reads every hour', () => {
    expect(snap).toMatch(/fn_ca_kill_switch_trip\('fn_ca_supply_snapshot', v_unexplained/);
  });
});

describe('every store declares how the basis treats it', () => {
  it('the coverage table exists and admits only three treatments', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_chip_store_coverage/);
    expect(SQL).toMatch(/CHECK \(treatment IN \('counted','noncirculating','uncounted'\)\)/);
  });

  it('escrow is declared COUNTED, by the component that holds it', () => {
    expect(SQL).toMatch(/\('escrow',\s*'counted',\s*'ticket_escrow'/);
  });

  it('all twenty five journal stores are declared', () => {
    const stores = [
      'player_wallet', 'club_treasury', 'union_bank', 'agent_wallet', 'system_mint',
      'system_burn', 'table_stack', 'promo_wallet', 'club_wallet', 'union_wallet',
      'bbj_pool', 'spin_reserve', 'insurance_bank', 'escrow', 'prize_liability',
      'bounty_liability', 'rakeback_payable', 'refund_payable', 'settlement_suspense',
      'issuance_reserve', 'chip_retirement', 'credit_facility', 'credit_receivable',
      'opening_setup', 'leaderboard_round',
    ];
    for (const s of stores) {
      expect(SQL, `${s} is not declared`).toMatch(new RegExp(`\\('${s}',\\s*'(counted|noncirculating|uncounted)'`));
    }
    expect(stores.length).toBe(25);
  });

  it('the four non-circulating stores are exactly the ones the meter treats as mint and burn', () => {
    for (const s of ['system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement']) {
      expect(SQL).toMatch(new RegExp(`\\('${s}',\\s*'noncirculating'`));
    }
  });

  it('settlement_suspense is declared uncounted and NOT guessed into the total', () => {
    // It holds a large historical net and had not moved in the sixty hours to
    // 2026-09-11 15:00, so it is not implicated here. Adding it to the basis on
    // a guess would double count if it is a routing label, and a wrong basis is
    // worse than a declared gap. Its movement now raises a finding instead.
    expect(SQL).toMatch(/\('settlement_suspense',\s*'uncounted'/);
    const snap = fnBody('fn_ca_supply_snapshot');
    expect(snap).not.toMatch(/settlement_suspense/);
  });
});

describe('a gap cannot stay quiet', () => {
  it('the gap check reads the journal constraint, not a copy of the store list', () => {
    const gaps = fnBody('fn_ca_chip_store_coverage_gaps');
    expect(gaps).toMatch(/c\.conrelid = 'public\.chip_ledger'::regclass/);
    expect(gaps).toMatch(/'chip_ledger_from_type_check','chip_ledger_to_type_check'/);
  });

  it('an undeclared store is a finding, and so is an uncounted store that moved', () => {
    const gaps = fnBody('fn_ca_chip_store_coverage_gaps');
    expect(gaps).toMatch(/'undeclared'::text/);
    expect(gaps).toMatch(/'uncounted store moved'::text/);
    expect(gaps).toMatch(/g\.treatment = 'uncounted' AND x\.net <> 0/);
  });

  it('the hourly sweep runs it', () => {
    const sweep = fnBody('fn_ca_conservation_sweep');
    expect(sweep).toMatch(/'fn_ca_chip_store_coverage_gaps'/);
    expect(sweep).toMatch(/public\.fn_ca_chip_store_coverage_gaps\(\) limit 20/);
  });

  it('and the sweep keeps every check it already carried', () => {
    // Rewriting this function to add one line is how twenty checks become
    // nineteen. Spot-check the ends and the count.
    const sweep = fnBody('fn_ca_conservation_sweep');
    for (const c of [
      'fn_chip_integrity_report', 'fn_settlement_conservation_check',
      'fn_tournament_chip_conservation_check', 'fn_ca_hand_commit_refusals',
      'fn_ca_absent_tournament_players', 'fn_union_law_integrity_breaches',
    ]) {
      expect(sweep, `${c} was dropped from the sweep`).toMatch(new RegExp(`'${c}'`));
    }
    expect(sweep.match(/^\s+\('fn_[a-z_0-9]+',$/gm)?.length).toBe(21);
  });

  it('an undeclared store is refused at first use', () => {
    expect(SQL).toMatch(/CREATE TRIGGER ab_ca_chip_store_declared\s*\n\s*BEFORE INSERT ON public\.chip_ledger/);
    const trg = fnBody('fn_ca_chip_store_declared');
    expect(trg).toMatch(/REFUSED: chip store % is not declared in ca_chip_store_coverage/);
    expect(trg).toMatch(/\(VALUES \(NEW\.from_type\), \(NEW\.to_type\)\)/);
    expect(trg).toMatch(/INSERT INTO public\.ca_chip_store_coverage/);
  });
});

describe('the migration refuses to apply on a false claim', () => {
  it('aborts unless the ticket float equals the journal net for the escrow store', () => {
    // Two independent measurements of the same store. If they disagree, the
    // float is the wrong definition and adding it would replace one wrong
    // total with another.
    expect(SQL).toMatch(/ABORT: the ticket float \(%\) and the journal net for the escrow store \(%\) disagree/);
  });

  it('aborts if any store is still undeclared', () => {
    expect(SQL).toMatch(/ABORT: % chip store\(s\) are still undeclared/);
  });

  it('aborts if escrow ended up declared but not counted', () => {
    expect(SQL).toMatch(/ABORT: the escrow store is not declared as counted by ticket_escrow/);
  });

  it('aborts if the basis version did not move', () => {
    expect(SQL).toMatch(/ABORT: the supply meter did not move to the ticket-escrow-v3 basis/);
  });
});

/**
 * The incident restated as arithmetic. unexplained is total delta minus mint
 * plus burn, so bringing a store inside the basis adds that store's net
 * movement to the figure. These are the measured hours.
 */
const corrected = (unexplained: number, netEscrow: number) =>
  Math.round((unexplained + netEscrow) * 100) / 100;

describe('the fix, on the numbers that opened the incidents', () => {
  const hours: Array<[string, number, number]> = [
    ['01:05', -400.0, 400.0],
    ['02:05', -415.82, 280.0],
    ['03:05', -114.18, 250.0],
    ['04:05', -194.41, -30.0],
    ['05:05', -175.59, 400.0],
    ['06:05', -100.0, 100.0],
  ];

  it('the six incident hours sum to exactly minus the escrow that moved', () => {
    const unexplained = hours.reduce((a, [, u]) => a + u, 0);
    const escrow = hours.reduce((a, [, , e]) => a + e, 0);
    expect(Math.round(unexplained * 100) / 100).toBe(-1400);
    expect(Math.round(escrow * 100) / 100).toBe(1400);
    expect(Math.round((unexplained + escrow) * 100) / 100).toBe(0);
  });

  it('the two clean hours go to exactly zero', () => {
    expect(corrected(-400.0, 400.0)).toBe(0);
    expect(corrected(-100.0, 100.0)).toBe(0);
  });

  it('and the rest collapse to straddle pairs that cancel within the hour', () => {
    // A ledger row committing between the cut and the balance read lands on one
    // side of one window and the other side of the next, so it shows up twice
    // with opposite signs. Self-cancelling and sub-threshold: the trailing-4h
    // arm of the raise condition is what keeps it from filing an incident.
    expect(corrected(-415.82, 280.0)).toBe(-135.82);
    expect(corrected(-114.18, 250.0)).toBe(135.82);
    expect(corrected(-194.41, -30.0)).toBe(-224.41);
    expect(corrected(-175.59, 400.0)).toBe(224.41);
    expect(corrected(-415.82, 280.0) + corrected(-114.18, 250.0)).toBe(0);
    expect(corrected(-194.41, -30.0) + corrected(-175.59, 400.0)).toBe(0);
  });

  it('and no corrected hour would have raised an incident on its own', () => {
    // The raise needs BOTH |hour| > 100 and |trailing 4h| > 300. Each pair sums
    // to zero inside the four hour window, so the second arm never arms.
    const trailing = hours.reduce((a, [, u, e]) => a + corrected(u, e), 0);
    expect(Math.round(trailing * 100) / 100).toBe(0);
    expect(Math.abs(trailing) > 300).toBe(false);
  });
});
