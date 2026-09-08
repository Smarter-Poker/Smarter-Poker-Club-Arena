/**
 * A SATELLITE HAS ONE PAYER, ONE LOCKED POOL, AND ONE BUBBLE.
 *
 * These source guards pin the transaction boundary as well as the product
 * rule. Arithmetic in TypeScript used to decide awards before several
 * independent writes; a retry could therefore see half a settlement. The
 * database now derives and commits the complete immutable allocation once.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', '..', 'supabase', 'migrations');
const MANAGER = readFileSync(join(HERE, 'TournamentManager.ts'), 'utf8');
const ELIMINATIONS = readFileSync(join(HERE, 'TournamentManagerEliminations.ts'), 'utf8');
const RECEIPT_VERIFIER = readFileSync(join(HERE, 'satelliteSettlementReceipt.ts'), 'utf8');
const SETTLEMENT_RPC = readFileSync(join(HERE, 'satelliteSettlementRpc.ts'), 'utf8');
const MANIFEST = readFileSync(
  join(
    MIGRATIONS,
    '..',
    '..',
    'scripts',
    'ci',
    'schema-manifest.d',
    'codex-atomic-satellite-settlement.json'
  ),
  'utf8'
);

function latestMigrationContaining(needle: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => readFileSync(join(MIGRATIONS, file), 'utf8').includes(needle));
  expect(files.length, `no migration contains ${needle}`).toBeGreaterThan(0);
  return readFileSync(join(MIGRATIONS, files.at(-1)!), 'utf8');
}

const SQL = latestMigrationContaining(
  'CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament('
);
const TERMINAL_SQL = latestMigrationContaining(
  'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal('
);
function taggedBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = SQL.indexOf(delimiter);
  const second = SQL.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return SQL.slice(first + delimiter.length, second);
}

const SETTLE = taggedBody('settle_satellite');
const RECEIPT = taggedBody('satellite_receipt');
const ADOPTION = taggedBody('adopt_b066');

describe('the finalized source pool is the complete allocation authority', () => {
  it('buys floor(pool / ticket) tickets and gives all sub-ticket residual to place N+1', () => {
    expect(SETTLE).toContain('v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer');
    expect(SETTLE).toContain(
      'v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2)'
    );
    expect(SETTLE).toContain('v_bubble_position := v_ticket_award_count + 1');
    expect(SETTLE).toContain("kind = 'satellite_remainder'");
    expect(SETTLE).toContain("p_payout_source => 'satellite_remainder'");
    expect(SETTLE).not.toMatch(/LEAST\s*\(/i);
  });

  it('refuses an unfunded advertised guarantee instead of minting it at settlement', () => {
    expect(SETTLE).toContain('v_pool < v_advertised_seats * v_ticket_cost');
    expect(SETTLE).toContain('finalized pool % does not fund its % advertised tickets');
    expect(SETTLE).not.toMatch(/GREATEST\s*\(\s*v_advertised_seats/i);
    expect(SQL).toContain('CHECK (pool >= advertised_seats * ticket_cost)');
  });

  it('refuses a short field instead of returning residual to a ticket winner', () => {
    expect(SETTLE).toContain('v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END');
    expect(SETTLE).toContain('has no single bubble at place %');
    expect(SETTLE).not.toContain('v_bubble_position := v_field_size');
  });

  it('proves ticket value plus one remainder equals the locked pool exactly', () => {
    expect(SQL).toContain('CHECK (pool = ticket_award_count * ticket_cost + remainder)');
    expect(SQL).toContain('CHECK (remainder < ticket_cost)');
    expect(SETTLE).toContain('v_paid IS DISTINCT FROM v_pool');
    expect(RECEIPT).toContain('v_amount IS DISTINCT FROM v_h.pool');
    expect(RECEIPT).toContain(
      'floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count'
    );
  });
});

describe('every full ticket has one immutable delivery line', () => {
  it('classifies every top finisher as exactly one seat or exact-price cash substitute', () => {
    expect(SQL).toContain("delivery_kind IN ('seat','cash')");
    expect(SQL).toContain('CHECK (ticket_award_count = seat_count + cash_ticket_count)');
    expect(SETTLE).toContain('IF v_seat_count + v_cash_ticket_count <> v_ticket_award_count');
    expect(RECEIPT).toContain('a.amount IS DISTINCT FROM v_h.ticket_cost');
  });

  it('seats only through a target registration, pool-transfer leg, fee row and payout row', () => {
    expect(SETTLE).toContain('INSERT INTO public.tournament_players');
    expect(SETTLE).toContain('INSERT INTO public.chip_ledger');
    expect(SETTLE).toContain("'satellite_seat_pool_transfer'");
    expect(SETTLE).toContain('INSERT INTO public.rake_records');
    expect(SETTLE).toContain('INSERT INTO public.tournament_payouts');
    expect(SETTLE).toContain("'satellite_seat'");
    expect(RECEIPT).toContain('malformed or extra actual-seat evidence');
    expect(RECEIPT).toContain('malformed target-entry evidence');
  });

  it('cash-substitutes a definitive unavailable target or independent existing seat', () => {
    expect(SETTLE).toMatch(
      /\('COMPLETING','COMPLETED','CANCELLED','CANCELED'\)[\s\S]*?v_target_open := false/
    );
    expect(SETTLE).toContain('v_target_count >= v_target.max_players');
    expect(SETTLE).toContain('target % is missing without a published contract');
    expect(SETTLE).toContain(
      'IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE'
    );
    expect(SETTLE).toContain("v_delivery_kind := 'cash'");
    expect(SETTLE).toContain("p_payout_source => 'satellite_ticket'");
  });

  it('fails closed when an existing target seat origin is unknown or belongs to this unreceipted run', () => {
    expect(SETTLE).toContain('cannot prove origin of target seat held by place %');
    expect(SETTLE).toContain('has an unreceipted target seat already delivered to place %');
    expect(SETTLE).toContain('target % admission state % is ambiguous');
  });

  it('replays only immutable lines and never re-decides a target that later closes', () => {
    const replay = SETTLE.slice(0, SETTLE.indexOf('SELECT COALESCE(t.satellite_target_id'));
    expect(replay).toContain('FROM public.tournament_satellite_settlements');
    expect(replay).toContain('RETURN public.fn_ca_satellite_settlement_receipt');
    expect(RECEIPT).toContain('Target lifecycle state is intentionally absent from replay');
  });
});

describe('all financial effects share one database transaction', () => {
  it('takes the shared terminal-money lock before either authority acquires a row lock', () => {
    const lock = "hashtextextended('ca:tournament-terminal-settlement:v1',0)";
    const satelliteLock = SETTLE.indexOf(lock);
    const satelliteRowLock = SETTLE.indexOf('FROM public.tournament_satellite_settlements');
    const terminalBodyStart = TERMINAL_SQL.indexOf('$complete_terminal$');
    const terminalBodyEnd = TERMINAL_SQL.indexOf('$complete_terminal$', terminalBodyStart + 1);
    const terminal = TERMINAL_SQL.slice(terminalBodyStart, terminalBodyEnd);
    const terminalLock = terminal.indexOf(lock);
    const terminalRowLock = terminal.indexOf('FROM public.tournaments');

    expect(satelliteLock).toBeGreaterThan(-1);
    expect(satelliteRowLock).toBeGreaterThan(satelliteLock);
    expect(terminalLock).toBeGreaterThan(-1);
    expect(terminalRowLock).toBeGreaterThan(terminalLock);
  });

  it('keeps target before source while the rolling legacy seat door is still live', () => {
    expect(SETTLE).toContain(
      'ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id'
    );
    expect(RECEIPT).toContain('ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id');
    expect(SQL).toContain('ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END,t.id');
    expect(SQL).toContain('target changed while outcome acquired locks');
  });

  it('has no catch-and-continue inside the settlement authority', () => {
    expect(SETTLE).not.toMatch(/EXCEPTION\s+WHEN/i);
    for (const evidence of [
      'INSERT INTO public.tournament_satellite_settlements',
      'INSERT INTO public.tournament_satellite_awards',
      'public.fn_credit_and_log(',
      'public.fn_settle_tournament_rake(',
      "SET status = 'COMPLETED'",
      'RETURN public.fn_ca_satellite_settlement_receipt(',
    ]) {
      expect(SETTLE).toContain(evidence);
    }
  });

  it('locks, snapshots and closes every source table and live seat before returning success', () => {
    for (const column of [
      'source_table_count',
      'source_table_ids',
      'source_seat_count',
      'source_seat_ids',
      'released_seat_count',
      'released_seat_ids',
    ]) {
      expect(SQL).toContain(column);
    }
    expect(SQL).toContain('CHECK (released_seat_ids <@ source_seat_ids)');
    expect(SETTLE).toMatch(
      /FROM public\.tables tb[\s\S]*?ORDER BY tb\.id FOR UPDATE;[\s\S]*?FROM public\.table_seats ts[\s\S]*?ORDER BY ts\.table_id, ts\.id FOR UPDATE OF ts;/
    );
    const rake = SETTLE.indexOf('v_rake_result := public.fn_settle_tournament_rake(');
    const release = SETTLE.indexOf('UPDATE public.table_seats ts', rake);
    const completed = SETTLE.indexOf("SET status = 'COMPLETED'", release);
    const close = SETTLE.indexOf('UPDATE public.tables tb', completed);
    const receipt = SETTLE.indexOf('RETURN public.fn_ca_satellite_settlement_receipt(', close);
    expect(rake).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(rake);
    expect(completed).toBeGreaterThan(release);
    expect(close).toBeGreaterThan(completed);
    expect(receipt).toBeGreaterThan(close);
    expect(SETTLE.slice(release, receipt)).toContain('left_at = v_closeout_at');
    expect(SETTLE.slice(completed, receipt)).toContain("lifecycle = 'closed'");
    expect(SETTLE.slice(completed, receipt)).toContain('current_players = 0');
    expect(SETTLE.slice(release, close)).toContain('table-status trigger');
  });

  it('replay proves exact source table, source seat and released-seat identities', () => {
    expect(RECEIPT).toContain('v_source_table_ids IS DISTINCT FROM v_h.source_table_ids');
    expect(RECEIPT).toContain('v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids');
    expect(RECEIPT).toContain('v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids');
    expect(RECEIPT).toContain('v_durable_released_count IS DISTINCT FROM v_h.released_seat_count');
    expect(RECEIPT).toContain('ts.left_at IS NULL');
    expect(RECEIPT).toContain("lower(COALESCE(tb.lifecycle, '')) <> 'closed'");
    expect(RECEIPT).toContain('source_closeout');
    expect(RECEIPT_VERIFIER).toContain('uniqueUuidArray');
    expect(RECEIPT_VERIFIER).toContain('releasedSeatIds.some((id) => !sourceSeatIds.includes(id))');
  });

  it('keeps the old per-seat RPC available for the rolling engine cutover', () => {
    expect(SQL).not.toContain(
      'DROP FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_settle_satellite_tournament\(uuid,uuid\)[\s\S]*?TO service_role/
    );
  });

  it('records an exact stage-one watermark and every audited production id', () => {
    expect(SQL).toContain('CREATE TABLE public.tournament_satellite_settlement_cutover');
    expect(SQL).toContain('transaction_timestamp()');
    expect(SQL).toContain('audited_tournament_ids uuid[] NOT NULL');
    expect(SQL).toMatch(
      /REVOKE ALL ON public\.tournament_satellite_settlement_cutover[\s\S]*?service_role;/
    );
    for (const id of [
      'b066f432-2aae-4994-85c8-f9bfbfa4cd2f',
      'a6a1b360-821c-4201-b378-1591e3df3892',
      'e3570642-2e39-42ae-a8f6-164055ffd6e6',
      'eddd8116-5792-47fd-b570-790c67581e9f',
    ]) {
      expect(SQL).toContain(`'${id}'::uuid`);
    }
  });

  it('describes the deferred legacy-door retirement honestly in the manifest fragment', () => {
    expect(MANIFEST).toContain('"tournament_satellite_settlement_cutover"');
    expect(MANIFEST).toContain('retirement is deferred to a separately gated stage two');
    expect(MANIFEST).not.toContain('inert refusal');
  });

  it('removes the obsolete process-side arithmetic and target-open helpers', () => {
    expect(existsSync(join(HERE, 'satelliteAwardPlan.ts'))).toBe(false);
    expect(existsSync(join(HERE, 'satelliteTargetOpen.ts'))).toBe(false);
    expect(MANAGER).not.toContain('planSatelliteAwards');
    expect(MANAGER).not.toContain("rpc('fn_award_satellite_seat'");
  });
});

describe('the server treats the atomic receipt as the only success signal', () => {
  it('requests one verified whole-settlement receipt with the observed winner', () => {
    expect(MANAGER).toContain('requestSatelliteSettlementReceipt(this.tournamentId, winnerId)');
    expect(MANAGER).not.toContain("rpc('fn_settle_satellite_tournament'");
    expect(SETTLEMENT_RPC).toContain("rpc('fn_settle_satellite_tournament'");
    expect(SETTLEMENT_RPC).toContain('p_observed_winner_id: observedWinnerId');
    expect(SETTLEMENT_RPC).toContain('verifySatelliteSettlementReceipt(');
    expect(MANAGER).toContain('verified.ticketAwardCount');
    expect(MANAGER).toContain('verified.cashTicketCount');
    expect(RECEIPT_VERIFIER).toContain('receipt.receipt_version !== 2');
  });

  it('replays identical requests and serializes an ambiguous outcome before classifying it', () => {
    expect(SETTLEMENT_RPC).toContain('for (let attempt = 1; attempt <= attempts; attempt++)');
    expect(SETTLEMENT_RPC).toContain("rpc('fn_resolve_satellite_settlement_outcome'");
    expect(SETTLEMENT_RPC).toContain('SatelliteSettlementRefusedError');
    expect(SETTLEMENT_RPC).toContain('SatelliteSettlementOutcomeUnknownError');
    expect(SQL).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_resolve_satellite_settlement_outcome('
    );
    expect(SQL).toContain("'satellite_committed',true");
    expect(SQL).toContain("'definitively_not_committed',true");
  });

  it('reopens only a proven refusal and stops all engines on an unknown outcome', () => {
    const start = ELIMINATIONS.indexOf('if (isSatelliteFinish) {');
    const end = ELIMINATIONS.indexOf('} else {', start);
    const branch = ELIMINATIONS.slice(start, end);
    expect(branch).toContain('await this.processSatelliteAwards(tournament, winnerId)');
    expect(branch).toContain('satErr instanceof SatelliteSettlementOutcomeUnknownError');
    expect(branch).toContain('if (!outcomeUnknown) releaseFinishGuard();');
    expect(branch).toContain('if (outcomeUnknown) await this.stopAndWait();');
    expect(branch).toContain('await raiseFinancialAlert(');
    expect(branch).toContain('return;');
    expect(branch).not.toContain("status: 'COMPLETING'");
  });

  it('does not run rake or a second COMPLETED transition after atomic satellite success', () => {
    const start = ELIMINATIONS.indexOf('protected async finishTournament');
    const end = ELIMINATIONS.indexOf('protected abstract checkTableBalance', start);
    const finish = ELIMINATIONS.slice(start, end);
    expect(finish).not.toContain("rpc('fn_settle_tournament_rake'");
    expect(finish).not.toContain("rpc('fn_finalize_bounty_pool'");
    expect(finish).not.toContain("status: 'COMPLETED'");
    expect(finish).toContain('requestTournamentTerminalReceipt(');
    expect(ELIMINATIONS).toContain(
      'protected abstract processSatelliteAwards(tournament: any, winnerId: string): Promise<number>'
    );
  });
});

describe('the one audited production miss is adopted exactly once', () => {
  it('accepts only b066 with one existing 200 cash ticket and pays place two exactly 85', () => {
    expect(ADOPTION).toContain("'b066f432-2aae-4994-85c8-f9bfbfa4cd2f'");
    expect(ADOPTION).toContain('v_rows <> 1 OR v_paid IS DISTINCT FROM 200.00');
    expect(ADOPTION).toContain('v_source_escrow.prize_balance IS DISTINCT FROM 85.00');
    expect(ADOPTION).toContain('p_amount => 85.00');
    expect(ADOPTION).toContain('p_payout_position => 2');
    expect(ADOPTION).toContain("p_payout_source => 'satellite_remainder'");
    expect(ADOPTION).toContain('v_paid IS DISTINCT FROM 285.00');
  });

  it('drops the owner-only adoption function before commit', () => {
    expect(SQL).toContain('DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder()');
  });
});
