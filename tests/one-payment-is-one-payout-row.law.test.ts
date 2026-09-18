/**
 * ONE PAYMENT IS ONE PAYOUT ROW.
 *
 * On 2026-09-06 a settlement migration of mine credited two players through
 * `fn_credit_and_log` - the platform's own idempotent path - AND inserted the
 * `tournament_payouts` rows itself. `fn_credit_and_log` records the payout too,
 * so tournament 3e281f5c ended up with four rows totalling 142.50 against a
 * 71.25 pool.
 *
 * Nobody was paid twice. `chip_ledger` holds exactly 47.50 + 23.75 to the two
 * players and 3.75 of rake - 75.00, which is 3 entries x 25.00 - so the money
 * moved once and the RECORD said it moved twice. That is not harmless: a
 * conservation query sums `tournament_payouts`, so the event read as a 71.25
 * overpay to everyone who would ever look at it.
 *
 * THE RULE: if a migration credits a player through the platform's idempotent
 * path, it does NOT also write the payout row. The path writes it.
 *
 * No trigger can see this mistake - both writes are legitimate on their own -
 * so it is pinned here, over the migration text itself. The database half of
 * the fix lives in `20260906233733_one_payment_is_one_payout_row.sql`: every
 * payout row is given an idempotency key if its writer supplies none, so the
 * partial unique index on that column finally covers every row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/**
 * The one migration that broke this rule, before the rule was written down.
 * Its two duplicate rows were removed by 20260906233733, which records the
 * removal in ca_drift_incidents. It stays on the allowlist because a migration
 * that has already been applied is history: correcting it forward is what the
 * follow-up did, and editing the file would not change the database.
 */
const ALREADY_CORRECTED = [
  // the one that recorded a payment twice; its duplicate rows were removed by
  // 20260906233733, which files the removal in ca_drift_incidents
  '20260906153943_the_suspended_heads_up_is_settled_by_a_chip_proportional_dea.sql',
  // settlement migrations that predate the rule. All are APPLIED, so editing
  // the files would change nothing in the database; they are listed by name so
  // the exception is closed rather than open-ended, and the count below fails
  // the moment a new one joins them.
  '20260831133146_the_deal_writes_its_record_once.sql',
  '20260831133423_every_prize_writes_its_own_evidence.sql',
  '20260831133650_the_record_reads_the_place_from_the_key.sql',
  '20260901133542_a_place_pays_once_and_a_finisher_places_once.sql',
  '20260902224000_every_entry_and_prize_leg_names_its_counterparty.sql',
  // the correction itself: its INSERT is a probe it rolls back, proving the
  // key trigger fills a blank rather than refusing a row
  '20260906233733_one_payment_is_one_payout_row.sql',
];

const CREDIT_PATHS = /fn_credit_and_log|credit_and_log\(/i;
const HAND_WRITES = /INSERT\s+INTO\s+(public\.)?tournament_payouts/i;

/** Find the matched dollar quote and its statement terminator, including whitespace. */
function functionDefinitionEnd(sql: string, start: number): number {
  const as = sql.slice(start).match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/i);
  if (!as) return -1;
  const tag = as[1];
  const bodyStart = start + (as.index ?? 0) + as[0].length;
  const close = sql.indexOf(tag, bodyStart);
  if (close < 0) return -1;
  const terminator = sql.slice(close + tag.length).match(/^\s*;/);
  return terminator ? close + tag.length + terminator[0].length : -1;
}

/**
 * The credit primitive itself owns the payout-evidence INSERT. Remove that
 * definition before asking whether a caller both invokes the primitive and
 * hand-writes a second row.
 */
function withoutCreditPrimitive(sql: string): string {
  const signature = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_credit_and_log\s*\(/gi;
  let result = sql;
  let start = signature.exec(result)?.index ?? -1;
  while (start >= 0) {
    const end = functionDefinitionEnd(result, start);
    if (end < 0) break;
    result = result.slice(0, start) + result.slice(end);
    signature.lastIndex = 0;
    start = signature.exec(result)?.index ?? -1;
  }
  return result;
}

/**
 * A whole-event satellite has three mutually exclusive delivery branches.
 * Cash uses fn_credit_and_log (which owns its payout row); an actual target
 * seat and a noncash tournament ticket move no wallet money, so those branches
 * write their own payout evidence. Remove that authority from the generic
 * mixed-writer scan only when the separation and whole-pool proof are visible.
 *
 * THE AUTHORITY KEPT ITS BODY AND CHANGED ITS NAME (2026-09-17). The same
 * three branches now live in fn_settle_satellite_tournament_pre_money_path_gate,
 * which is what the finish path calls; a migration that carries that body
 * forward (20260917191322 takes the satellite off the global settlement lane)
 * was refused by this rule for writing the seat and ticket rows the cash
 * branch does not write. Both names are admitted HERE ONLY, and each still has
 * to prove the separation below: the exception is the proof, never the name.
 */
function withoutSeparatedSatelliteDelivery(sql: string): string {
  const signature =
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_settle_satellite_tournament(?:_pre_money_path_gate)?\s*\(/gi;
  let result = sql;
  let start = signature.exec(result)?.index ?? -1;
  while (start >= 0) {
    const end = functionDefinitionEnd(result, start);
    if (end < 0) break;
    const definition = result.slice(start, end);
    const seatStart = definition.lastIndexOf("IF v_delivery_kind = 'seat' THEN");
    const ticketStart = definition.indexOf("ELSIF v_delivery_kind = 'ticket' THEN", seatStart);
    const cashStart = definition.indexOf("ELSIF v_delivery_kind = 'cash' THEN", ticketStart);
    const cashEnd = definition.indexOf('\n    ELSE', cashStart);
    const seat = definition.slice(seatStart, ticketStart);
    const ticket = definition.slice(ticketStart, cashStart);
    const cash = definition.slice(cashStart, cashEnd);
    const directPayoutWrites = definition.match(new RegExp(HAND_WRITES.source, 'gi')) ?? [];
    const separated =
      seatStart >= 0 &&
      ticketStart > seatStart &&
      cashStart > ticketStart &&
      cashEnd > cashStart &&
      directPayoutWrites.length === 2 &&
      HAND_WRITES.test(seat) &&
      !CREDIT_PATHS.test(seat) &&
      HAND_WRITES.test(ticket) &&
      !CREDIT_PATHS.test(ticket) &&
      CREDIT_PATHS.test(cash) &&
      !HAND_WRITES.test(cash) &&
      seat.includes("'satellite_seat'") &&
      ticket.includes("'satellite_ticket'") &&
      ticket.includes("'tournament_entry_only'") &&
      cash.includes("p_payout_source => 'satellite_ticket'") &&
      definition.includes('v_paid IS DISTINCT FROM v_pool');
    if (separated) {
      result = result.slice(0, start) + result.slice(end);
      signature.lastIndex = 0;
      start = signature.exec(result)?.index ?? -1;
    } else {
      start = signature.exec(result)?.index ?? -1;
    }
  }
  return result;
}

function hasMixedPayoutWriters(sql: string): boolean {
  const code = withoutSeparatedSatelliteDelivery(withoutCreditPrimitive(sql))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return CREDIT_PATHS.test(code) && HAND_WRITES.test(code);
}

describe('one payment is one payout row', () => {
  it('the corrective migration exists and removes exactly the duplicate record', () => {
    const f = files.find((x) => x.includes('one_payment_is_one_payout_row'));
    expect(f, 'the corrective migration must not be deleted').toBeTruthy();
    const sql = readFileSync(join(MIGRATIONS, f!), 'utf8');
    // it refuses to run if the board has moved underneath it
    expect(sql).toMatch(/ABORT: expected exactly 2 duplicate payout records to remove/);
    // and it says where the removed rows went, rather than erasing them quietly
    expect(sql).toContain('ca_drift_incidents');
    expect(sql).toMatch(/'removed', v_dupes/);
    expect(sql).toMatch(/VERIFY FAILED: the event records % paid against a 71\.25 pool/);
  });

  it('the key is derived, never refused, so a payout row is never lost to a guard', () => {
    const f = files.find((x) => x.includes('one_payment_is_one_payout_row'))!;
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.zz_a_payout_row_carries_its_key'),
      sql.indexOf(
        '$function$;',
        sql.indexOf('CREATE OR REPLACE FUNCTION public.zz_a_payout_row_carries_its_key')
      )
    );
    expect(fn).toMatch(/NEW\.idempotency_key := 'tourney:'/);
    expect(fn).not.toMatch(/RAISE EXCEPTION/);
  });

  it('the list of migrations that predate this rule is closed', () => {
    expect(ALREADY_CORRECTED).toHaveLength(7);
    for (const f of ALREADY_CORRECTED) {
      expect(files, `${f} is on the exception list but not in the tree`).toContain(f);
    }
  });

  const creditCall = 'SELECT public.fn_credit_and_log(NULL, 1);';
  const directPayout = 'INSERT INTO public.tournament_payouts(amount) VALUES (1);';
  const primitive = (tag: string, terminator: string) =>
    `CREATE OR REPLACE FUNCTION public.fn_credit_and_log() RETURNS void
     LANGUAGE plpgsql AS ${tag} BEGIN ${directPayout} END; ${tag}${terminator}`;

  it.each(['$function$', '$$', '$credit_17$'])(
    'recognizes the primitive with matched %s delimiters and legal terminator whitespace',
    (tag) => {
      for (const terminator of [';', '\n;', ' \t\r\n;']) {
        const sql = primitive(tag, terminator) + '\n' + creditCall;
        expect(withoutCreditPrimitive(sql)).toBe('\n' + creditCall);
        expect(hasMixedPayoutWriters(sql)).toBe(false);
      }
    }
  );

  it.each([';', '\n;', ' \t\r\n;'])(
    'still rejects a separate duplicate payout before or after a primitive ending with %j',
    (terminator) => {
      const owner = primitive('$function$', terminator);
      const duplicate = `${creditCall}\n${directPayout}`;
      expect(hasMixedPayoutWriters(`${owner}\n${duplicate}`)).toBe(true);
      expect(hasMixedPayoutWriters(`${duplicate}\n${owner}`)).toBe(true);
      expect(
        hasMixedPayoutWriters(`${owner}\n${creditCall}
          CREATE OR REPLACE FUNCTION public.other_writer() RETURNS void
          LANGUAGE plpgsql AS $function$ BEGIN ${directPayout} END; $function$;`)
      ).toBe(true);
    }
  );

  it('does not exempt a malformed or unterminated primitive', () => {
    for (const ending of ['', '$other$;', '$function$ unexpected;']) {
      const sql = `CREATE OR REPLACE FUNCTION public.fn_credit_and_log() RETURNS void
        LANGUAGE plpgsql AS $function$ BEGIN ${directPayout} END; ${ending}`;
      expect(withoutCreditPrimitive(sql)).toBe(sql);
      expect(hasMixedPayoutWriters(sql)).toBe(true);
    }
  });

  it('no migration credits through the platform path AND writes the payout row itself', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALREADY_CORRECTED.includes(f)) continue;
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      // Comments and verifier string literals quote both freely; only look at
      // executable SQL after removing the primitive that legitimately owns
      // the one payout-evidence insert.
      if (hasMixedPayoutWriters(sql)) offenders.push(f);
    }
    expect(
      offenders,
      'a migration that credits through fn_credit_and_log must not also INSERT INTO tournament_payouts - the credit path records the payout itself, and doing both records one payment twice'
    ).toEqual([]);
  }, 15_000);
});
