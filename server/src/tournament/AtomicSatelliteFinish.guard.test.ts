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
const ROLLBACK_PROBE = readFileSync(
  join(HERE, '..', '..', '..', 'scripts', 'ci', 'probes', 'atomic-satellite-closeout-rollback.sql'),
  'utf8'
);
const CATALOG_PROBE = readFileSync(
  join(HERE, '..', '..', '..', 'scripts', 'ci', 'probes', 'atomic-satellite-settlement.sql'),
  'utf8'
);
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

const SQL = latestMigrationContaining('$settle_satellite$');
const CASH_SQL = readFileSync(
  join(MIGRATIONS, '20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql'),
  'utf8'
);
const TERMINAL_SQL = latestMigrationContaining('$complete_terminal$');
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
const ESCROW_READER = taggedBody('exact_refund_read_model');
const ADOPTION = taggedBody('adopt_b066');
const ADOPTION_682 = taggedBody('adopt_exact_682_completion');
const ADOPTION_CLOSEOUT_SQL = latestMigrationContaining(
  'DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder()'
);

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
    expect(SQL).toContain('bubble_position <= field_size)\n  ) IS TRUE)');
    expect(SQL).toContain("delivery_kind = 'ticket'");
    expect(SQL).toContain("payout_source = 'satellite_ticket'");
    expect(SETTLE).toContain('tp.status IS NULL');
    expect(RECEIPT).toContain("tp.status::text IS DISTINCT FROM 'eliminated'");
    expect(SETTLE).toContain('v_source_escrow.reserve_out IS DISTINCT FROM 0');
    expect(SETTLE).toContain('v_source_escrow.bounty_in IS DISTINCT FROM 0');
    expect(RECEIPT).toContain('v_source_escrow.prize_out IS DISTINCT FROM v_h.pool');
    expect(RECEIPT).toContain('v_source_escrow.refund_bounty IS DISTINCT FROM 0');
    expect(ROLLBACK_PROBE).toContain(
      'malformed source escrow history was not refused before any write'
    );
  });

  it('stores the next-finisher residual as immutable first-class evidence', () => {
    expect(SQL).toContain('CREATE TABLE public.tournament_satellite_remainders');
    expect(SQL).toContain('tournament_satellite_remainders_append_only');
    expect(SQL).toContain(
      'ALTER TABLE public.tournament_satellite_remainders ENABLE ROW LEVEL SECURITY'
    );
    expect(SQL).toContain('payout_position IS NOT DISTINCT FROM place');
    expect(SQL).toContain('obligation_place IS NOT DISTINCT FROM place');
    expect(SQL).toMatch(
      /REVOKE ALL ON public\.tournament_satellite_settlements,[\s\S]*?public\.tournament_satellite_remainders[\s\S]*?service_role;/
    );
    expect(SETTLE).toContain('INSERT INTO public.tournament_satellite_remainders');
    expect(SETTLE).toContain("'satellite_remainder', v_bubble_position, 'atomic'");
    expect(RECEIPT).toContain('public.tournament_satellite_remainders');
    expect(RECEIPT).toContain("r.evidence_kind = 'atomic'");
  });
});

describe('every full ticket has one immutable delivery line', () => {
  it('classifies every top finisher as one seat, cash substitute, or noncash ticket', () => {
    expect(SQL).toContain("delivery_kind IN ('seat','cash','ticket')");
    expect(SQL).toContain(
      'CHECK (ticket_award_count = seat_count + cash_ticket_count + entry_ticket_count)'
    );
    expect(SETTLE).toContain('IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count');
    expect(RECEIPT).toContain('a.amount IS DISTINCT FROM v_h.ticket_cost');
  });

  it('serializes the four-table decision and holds a blocked award as a target ticket', () => {
    const capLocks = SETTLE.indexOf('FOR v_cap_user_id IN');
    const classification = SETTLE.indexOf('FOR v_place IN 1..v_ticket_award_count');
    expect(capLocks).toBeGreaterThan(-1);
    expect(classification).toBeGreaterThan(capLocks);
    expect(SETTLE.slice(capLocks, classification)).toContain('ORDER BY tp.user_id');
    expect(SETTLE.slice(capLocks, classification)).toContain(
      "hashtextextended('table_cap:'||v_cap_user_id::text,0)"
    );
    expect(SETTLE).toContain(
      'v_cap_load:=public.fn_concurrent_game_load(\n          v_finisher.user_id,NULL,NULL,v_target_id)'
    );
    expect(SETTLE).toContain('IF v_cap_load>=4 THEN');
    expect(SETTLE).toContain("v_delivery_kind := 'ticket'");
    expect(SETTLE).not.toContain('winner_at_concurrent_game_cap');
  });

  it('moves a cap-blocked award from source pool to immutable ticket escrow without a wallet', () => {
    const ticket = SETTLE.slice(
      SETTLE.indexOf("ELSIF v_delivery_kind = 'ticket' THEN"),
      SETTLE.indexOf("ELSIF v_delivery_kind = 'cash' THEN")
    );
    expect(ticket).toContain('INSERT INTO public.tournament_tickets');
    expect(ticket).toContain("'tournament_entry_only', v_target_id, p_tournament_id");
    expect(ticket).toContain('source_satellite_award_place');
    expect(ticket).toContain("'direct_satellite_entry_ticket'");
    expect(ticket).toContain("'prize_liability', p_tournament_id");
    expect(ticket).toContain("'escrow', v_ticket_id");
    expect(ticket).toContain('p_prize_out => v_ticket_cost');
    expect(ticket).toContain("'wallet_chips_credited', 0");
    expect(ticket).not.toContain('fn_credit_and_log');
    expect(ticket).not.toContain('wallet_transactions');
    expect(RECEIPT).toContain('tk.source_tournament_id IS DISTINCT FROM v_h.target_id');
    expect(RECEIPT).toContain('tk.source_satellite_award_place IS DISTINCT FROM a.place');
    expect(RECEIPT).toContain('wallet_key.key=a.idempotency_key');
    expect(RECEIPT).toContain("a.delivery_kind='ticket'");
    expect(SQL).toContain("a.delivery_kind IN ('seat','ticket')");
    expect(RECEIPT).toContain('(v_h.seat_count > 0 OR v_h.entry_ticket_count > 0)');
    expect(ESCROW_READER).toContain("a.delivery_kind='ticket'");
    expect(ESCROW_READER).toContain('sat.funded_awards_out');
    expect(ESCROW_READER).not.toContain("p.source IN ('satellite_seat','satellite_ticket')");
    expect(ROLLBACK_PROBE).toContain("VALUES('92500000-0000-4000-8000-000000000201',4)");
    expect(ROLLBACK_PROBE).toContain(
      'four-table cap did not commit one exact noncash ticket receipt'
    );
    expect(ROLLBACK_PROBE).toContain('v_cap_replay::text IS DISTINCT FROM v_receipt::text');
    expect(ROLLBACK_PROBE).toContain('rollback successful four-table-cap ticket case');
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

  it('fails closed before seating into a bounty or Spin target', () => {
    for (const flag of [
      'v_target.is_bounty IS DISTINCT FROM false',
      'v_target.is_pko IS DISTINCT FROM false',
      'v_target.is_mystery_bounty IS DISTINCT FROM false',
      'v_target.is_premium_spin IS DISTINCT FROM false',
    ]) {
      expect(SETTLE).toContain(flag);
    }
    expect(SETTLE).toContain("lower(COALESCE(v_target.variant,'')) = 'spin'");
    expect(SETTLE).toContain("upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'");
    expect(SETTLE).toContain('uses an unsupported bounty or Spin entry split');
    expect(ROLLBACK_PROBE).toContain('bounty target split was not refused before any write');
  });

  it('proves the exact target aggregate and escrow transition before success', () => {
    expect(SETTLE).toContain('v_target_count_before + v_seat_count');
    expect(SETTLE).toContain('SET current_players = v_target.current_players + v_seat_count');
    expect(SETTLE).toContain(
      'v_target_after.current_players IS DISTINCT FROM\n            v_target.current_players + v_seat_count'
    );
    expect(SETTLE).not.toContain('SET current_players = v_target_count,');
    expect(SETTLE).toContain('v_target_after.prize_pool IS DISTINCT FROM');
    expect(SETTLE).toContain('v_target_after.total_rake IS DISTINCT FROM');
    for (const component of ['satellite_in', 'satellite_fee_in', 'prize_balance', 'fee_balance']) {
      expect(SETTLE).toContain(`v_target_escrow_after.${component} IS DISTINCT FROM`);
    }
    expect(SETTLE).toContain(
      'target aggregate or escrow delta is not the exact delivered seat value'
    );
    expect(SETTLE).toContain('v_target_escrow.prize_balance < 0');
    expect(SETTLE).toContain('v_target_escrow.fee_balance < 0');
    expect(SETTLE).toContain('v_target_escrow.bounty_balance IS DISTINCT FROM 0');
    expect(SETTLE).toContain('v_source_escrow.closed_at IS NOT NULL');
    expect(SETTLE).toContain('v_source_escrow.close_note IS NOT NULL');
    expect(SETTLE).toContain('v_target_escrow.close_note IS NOT NULL');
    expect(SETTLE).toContain('v_target.current_players IS DISTINCT FROM v_target_counter_before');
    expect(SETTLE).toContain('v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance');
    expect(SETTLE).toContain('v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance');
    expect(SETTLE).toContain(
      'v_target_after.current_players IS DISTINCT FROM v_target_counter_after'
    );
    expect(SETTLE).toContain("upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')");
    expect(SETTLE).toContain('THEN v_target_live_count_before');
    expect(SETTLE).toContain('ELSE v_target_count_before');
    expect(SETTLE).toContain("'reserve_out','reserve_in'");
    expect(ROLLBACK_PROBE).toContain(
      'ALTER TABLE pg_temp.rake_records DISABLE TRIGGER probe_target_fee_reclassifies'
    );
    expect(ROLLBACK_PROBE).toContain('negative target escrow was not refused before any write');
    expect(ROLLBACK_PROBE).toContain('missing target was not refused before any write');
    expect(ROLLBACK_PROBE).toContain(
      'missing target fee rail was not caught and fully rolled back'
    );
    expect(ROLLBACK_PROBE).toContain('stale status-aware target entrant counter was not refused');
    expect(ROLLBACK_PROBE).toContain(
      'RUNNING late-registration target preserved its total entrant counter'
    );
    expect(CATALOG_PROBE).toContain(
      'v_target.current_players IS DISTINCT FROM v_target_counter_before'
    );
    expect(CATALOG_PROBE).toContain(
      'v_target_after.current_players IS DISTINCT FROM v_target_counter_after'
    );
    expect(CATALOG_PROBE).not.toContain(
      'v_target.current_players IS DISTINCT FROM v_target_live_count_before'
    );
    expect(ROLLBACK_PROBE).toContain('target prize aggregate/escrow mismatch was not refused');
    expect(ROLLBACK_PROBE).toContain('target fee aggregate/escrow mismatch was not refused');
    expect(ROLLBACK_PROBE).toContain('pre-closed source escrow was not refused');
    expect(ROLLBACK_PROBE).toContain('orphan target escrow close marker was not refused');
    expect(ROLLBACK_PROBE).toContain('rollback successful zero-fee matrix case');
    expect(ROLLBACK_PROBE).toContain('rollback successful multi-seat matrix case');
    expect(ROLLBACK_PROBE).toContain("'level-fallback-null-current'");
    expect(ROLLBACK_PROBE).toContain(
      'NULL-current level-fallback fixtures accepted valid NULL bounds'
    );
    expect(ROLLBACK_PROBE).toContain('a negative RUNNING target level was not refused');
    expect(ROLLBACK_PROBE).toContain('a negative target capacity was not refused');
    expect(ROLLBACK_PROBE).toContain('a negative target late-registration bound was not refused');
    expect(ROLLBACK_PROBE).toContain('a negative target rebuy bound was not refused');
    expect(ROLLBACK_PROBE).toContain('funded satellite target accepted later economic repricing');
    expect(ROLLBACK_PROBE).toContain(
      'refused target repricing changed the immutable settlement receipt'
    );
    expect(ROLLBACK_PROBE).toContain(
      'duplicate target fee registration passed exact receipt verification'
    );
  });

  it('cash-substitutes a locked closed or full target or independent existing seat', () => {
    expect(SETTLE).toMatch(
      /\('COMPLETING','COMPLETED','CANCELLED','CANCELED'\)[\s\S]*?v_target_open := false/
    );
    expect(SETTLE).toContain('v_target_count >= v_target.max_players');
    expect(SETTLE).toContain('target % is missing; absence cannot authorize cash substitution');
    expect(SETTLE).toMatch(/WHERE t\.id = v_target_id\s+FOR UPDATE;\s+IF v_target\.id IS NULL/);
    expect(SETTLE).not.toContain('FROM public.managed_game_contract_versions');
    expect(SETTLE).not.toContain('v_target_was_missing := true');
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
    expect(RECEIPT).toContain('v_h.receipt_version IS DISTINCT FROM 2');
    expect(RECEIPT).toContain("a.delivery_kind = 'ticket'");
    expect(RECEIPT).toContain("'entry_ticket_count', v_h.entry_ticket_count");
    expect(RECEIPT).toContain("'ticket_id', a.ticket_id");
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
    expect(SQL).toMatch(
      /target_id\s+uuid NOT NULL\s+REFERENCES public\.tournaments\(id\) ON DELETE RESTRICT/
    );
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
    expect(SETTLE.slice(release, receipt)).toContain('ts.id = ANY(v_source_seat_ids)');
    expect(SETTLE.slice(release, receipt)).toContain("ts.status IS DISTINCT FROM 'left'");
    expect(SETTLE.slice(release, receipt)).toContain('ts.leave_pending IS DISTINCT FROM false');
    expect(SETTLE.slice(release, receipt)).toContain('ts.is_sitting_out IS DISTINCT FROM false');
    expect(SETTLE.slice(release, receipt)).toContain('ts.is_away IS DISTINCT FROM false');
    expect(SETTLE.slice(release, receipt)).toContain('ts.sit_out_at IS NOT NULL');
    expect(SETTLE.slice(release, receipt)).toContain('ts.scheduled_leave_hands IS NOT NULL');
    expect(SETTLE.slice(release, receipt)).not.toContain(
      'left_at = COALESCE(ts.left_at, v_closeout_at)'
    );
    expect(SETTLE.slice(completed, receipt)).toContain("lifecycle = 'closed'");
    expect(SETTLE.slice(completed, receipt)).toContain('current_players = 0');
    expect(SETTLE.slice(release, close)).toContain('table-status trigger');
    expect(SQL).toContain('ADD COLUMN terminal_closed_at timestamptz');
    expect(SETTLE).toContain('terminal_closed_at = v_closeout_at');
    expect(RECEIPT).toContain('tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at');
    expect(RECEIPT).toContain('v_source.ended_at IS DISTINCT FROM v_h.source_closed_at');
    expect(RECEIPT).toContain("'closed_at', v_h.source_closed_at");
    expect(TERMINAL_SQL).toContain('ADD CONSTRAINT tables_terminal_closed_shape');
    expect(TERMINAL_SQL).toContain('current_players IS NOT DISTINCT FROM 0');
    expect(TERMINAL_SQL).toContain('live tournament table % cannot supply a terminal marker');
    expect(TERMINAL_SQL).toContain('unscoped table % cannot supply a terminal marker');
    expect(TERMINAL_SQL).not.toContain('$harden_satellite_receipt_terminal_marker$');
    expect(ROLLBACK_PROBE).toContain('v_null_marker_caught');
    expect(ROLLBACK_PROBE).toContain('v_mismatch_marker_caught');
  });

  it('replay proves exact source table, source seat and released-seat identities', () => {
    expect(RECEIPT).toContain('v_source_table_ids IS DISTINCT FROM v_h.source_table_ids');
    expect(RECEIPT).toContain('v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids');
    expect(RECEIPT).toContain('v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids');
    expect(RECEIPT).toContain('v_durable_released_count IS DISTINCT FROM v_h.released_seat_count');
    expect(RECEIPT).toContain('ts.left_at IS NULL');
    expect(RECEIPT).toContain("ts.status IS DISTINCT FROM 'left'");
    expect(RECEIPT).toContain('ts.leave_pending IS DISTINCT FROM false');
    expect(RECEIPT).toContain('ts.is_sitting_out IS DISTINCT FROM false');
    expect(RECEIPT).toContain('ts.is_away IS DISTINCT FROM false');
    expect(RECEIPT).toContain('ts.sit_out_at IS NOT NULL');
    expect(RECEIPT).toContain('ts.scheduled_leave_hands IS NOT NULL');
    expect(RECEIPT).toContain(
      'v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at'
    );
    expect(RECEIPT).toContain(
      'v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note'
    );
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
    expect(SQL).toContain("SET LOCAL transaction_timeout = '180s';");
    expect(SQL).toContain('CREATE TABLE public.tournament_satellite_settlement_cutover');
    const transactionBudget = SQL.indexOf("SET LOCAL transaction_timeout = '180s';");
    const terminalBoundary = SQL.indexOf(
      "hashtextextended('ca:tournament-terminal-settlement:v1',0)",
      transactionBudget
    );
    const maintenanceBoundary = SQL.indexOf(
      'pg_advisory_xact_lock_shared(530090,1)',
      terminalBoundary
    );
    const liveFreezeGate = SQL.indexOf(
      'AND NOT public.fn_entry_purchases_frozen() THEN',
      maintenanceBoundary
    );
    const commitFreezeGate = SQL.indexOf(
      ') AND NOT public.fn_entry_purchases_frozen() THEN',
      liveFreezeGate + 1
    );
    const parentBarrier = SQL.indexOf('LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE');
    const tablesDdl = SQL.indexOf('ALTER TABLE public.tables\n  ADD COLUMN terminal_closed_at');
    const finalProof = SQL.indexOf('$verify_satellite_authority$;');
    const commit = SQL.lastIndexOf('COMMIT;');
    expect(terminalBoundary).toBeGreaterThan(transactionBudget);
    expect(maintenanceBoundary).toBeGreaterThan(terminalBoundary);
    expect(liveFreezeGate).toBeGreaterThan(maintenanceBoundary);
    expect(parentBarrier).toBeGreaterThan(liveFreezeGate);
    expect(parentBarrier).toBeGreaterThan(-1);
    expect(tablesDdl).toBeGreaterThan(parentBarrier);
    expect(SQL).toContain(
      'no lock upgrade remains and the relation order is always tournaments then'
    );
    expect(SQL).toContain('v_database_is_pristine boolean');
    expect(SQL).toContain('EXISTS (SELECT 1 FROM auth.users)');
    expect(SQL).toContain('EXISTS (SELECT 1 FROM public.chip_ledger)');
    expect(SQL).toContain(
      'atomic satellite settlement live cutover requires the maintenance entry freeze'
    );
    expect(commitFreezeGate).toBeGreaterThan(parentBarrier);
    expect(finalProof).toBeGreaterThan(commitFreezeGate);
    expect(commit).toBeGreaterThan(finalProof);
    expect(SQL).toContain('atomic satellite settlement live cutover freeze expired before commit');
    expect(SQL).toContain('preexisting_completed_ids uuid[] NOT NULL');
    expect(SQL).toContain('clock_timestamp()');
    expect(SQL).toContain('array_position(preexisting_completed_ids, NULL) IS NULL');
    expect(SQL).toContain('audited_tournament_ids uuid[] NOT NULL');
    expect(SQL).toMatch(
      /REVOKE ALL ON public\.tournament_satellite_settlement_cutover[\s\S]*?service_role;/
    );
    for (const id of [
      'b066f432-2aae-4994-85c8-f9bfbfa4cd2f',
      'a6a1b360-821c-4201-b378-1591e3df3892',
      'e3570642-2e39-42ae-a8f6-164055ffd6e6',
      'eddd8116-5792-47fd-b570-790c67581e9f',
      '6b0c3243-75fb-487f-8da2-245b2426dbbe',
      '682045c5-cb07-47ed-ad0e-adbff9cb41af',
      'ed78a8ac-d869-469f-a4da-c04b67429064',
      'fe8dc50c-8995-4441-b289-43993975f74f',
    ]) {
      expect(SQL).toContain(`'${id}'::uuid`);
    }
  });

  it('keeps the database-owned elimination witness valid across all-busted promotion and rebuy revival', () => {
    for (const source of [CASH_SQL, SQL]) {
      expect(source).toContain("OLD.status::text = 'eliminated'");
      expect(source).toContain("NEW.status::text IS DISTINCT FROM 'eliminated'");
      expect(source).toContain('NEW.elimination_sequence := NULL');
      expect(source).toContain('elimination_sequence is database-owned');
    }
    expect(SETTLE).toContain("SET status = 'winner', position = 1,");
    expect(SETTLE).toContain('eliminated_at = NULL, elimination_sequence = NULL');
    expect(RECEIPT).toContain('tp.eliminated_at IS NULL');
    expect(RECEIPT).toContain('tp.elimination_sequence IS NULL');
    expect(ROLLBACK_PROBE).toContain('all-busted promotion retained an elimination witness');
    expect(ROLLBACK_PROBE).toContain('rebuy revival retained a stale elimination witness');
    expect(ROLLBACK_PROBE).toContain('an eliminated witness accepted a caller rewrite');
  });

  it('requires the exact origin-capable escrow rails and owner-only evidence ACLs', () => {
    for (const trigger of [
      'zz_ca_escrow_wallet_tx',
      'zz_ca_escrow_rake_record',
      'zz_ca_escrow_seat_payout',
      'zz_ca_escrow_rake_settlement',
      'zz_ca_escrow_close',
      'zz_ca_escrow_seat_transfer_leg',
    ]) {
      expect(SQL).toContain(`'${trigger}'`);
    }
    expect(SQL).toContain("tg.tgenabled IN ('O','A')");
    expect(SQL).toContain('tg.tgtype = required.trigger_type');
    expect(SQL).toContain('pg_get_triggerdef(tg.oid) = required.trigger_definition');
    expect(SQL).toContain('has_table_privilege(');
    expect(SQL).toContain("('REFERENCES'),('TRIGGER')");
    expect(SQL).toContain('c.relrowsecurity IS DISTINCT FROM true');
    expect(SQL).toContain('EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid)');
  });

  it('keeps the internal award leaf present and owner-only without making it canonical schema', () => {
    expect(MANIFEST).toContain('"tournament_satellite_settlement_cutover"');
    expect(CATALOG_PROBE).toContain('internal satellite award leaf retained application EXECUTE');
    expect(MANIFEST).not.toContain('fn_award_satellite_seat');
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
    expect(MANAGER).toContain('verified.entryTicketCount');
    expect(MANAGER).toContain('verified.cashTicketCount');
    expect(RECEIPT_VERIFIER).toContain('receipt.receipt_version !== 2');
    expect(RECEIPT_VERIFIER).toContain(
      'ticketAwardCount !== seatCount + cashTicketCount + entryTicketCount'
    );
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
    const end = ELIMINATIONS.indexOf('let refreshedPool', start);
    const branch = ELIMINATIONS.slice(start, end);
    expect(branch).toContain('await this.processSatelliteAwards(tournament, winnerId)');
    expect(branch).toContain('satErr instanceof SatelliteSettlementOutcomeUnknownError');
    expect(branch).toContain('satErr instanceof SatelliteSettlementRefusedError');
    expect(branch).toContain('if (provenRefusal) releaseFinishGuard();');
    expect(branch).toContain('if (!provenRefusal) await this.stopAndWait();');
    expect(branch).toContain('await raiseFinancialAlert(');
    expect(branch).toContain('return;');
    expect(branch).not.toContain("status: 'COMPLETING'");
    expect(branch).not.toContain('readDurableTournamentStatus');
  });

  it('does not run rake or a second COMPLETED transition after atomic satellite success', () => {
    const start = ELIMINATIONS.indexOf('if (isSatelliteFinish) {');
    const end = ELIMINATIONS.indexOf('let refreshedPool', start);
    const branch = ELIMINATIONS.slice(start, end);
    expect(branch).not.toContain("rpc('fn_settle_tournament_rake'");
    expect(branch).not.toContain("rpc('fn_finalize_bounty_pool'");
    expect(branch).not.toContain("status: 'COMPLETED'");
    expect(branch).not.toContain('settleTournamentRake(');
    expect(branch).not.toContain('settleTournamentPlacesAtomically(');
    expect(branch).toContain('cleanupCommittedSatellite(receipt)');
    expect(ELIMINATIONS).toContain(
      'protected abstract processSatelliteAwards(\n    tournament: any,\n    winnerId: string\n  ): Promise<VerifiedSatelliteSettlementReceipt>'
    );
  });
});

describe('the one audited production miss is adopted exactly once', () => {
  it('accepts only b066 with one existing 200 cash ticket and pays place two exactly 85', () => {
    for (const identity of [
      'b066f432-2aae-4994-85c8-f9bfbfa4cd2f',
      '13dd6b98-b882-4690-a479-3a6f77783ad6',
      '3d15bbe7-f752-4a49-be3a-079232d23b0f',
      'ed3f0662-8da7-4c24-b8d7-a1000d60cb1f',
      '73a2e426-9c82-4674-a267-d73502cd2df8',
      '438045e8-d7d3-4a05-b8ba-c7b25f8e9b03',
      'bbcb41fc-dfa4-4a56-a6e6-00601279a1ce',
      'ce188179-6b89-45aa-b0d0-94c5441ca2a2',
      'f2ab8f6c-cb2b-4585-b4b4-90cb5e775d99',
      '4c67b481-22e6-4edd-887a-cdb665b2257f',
      '5a771fcc-2d5c-4fcf-a126-64abd9377125',
    ]) {
      expect(ADOPTION).toContain(`'${identity}'`);
    }
    const globalLock = ADOPTION.indexOf(
      "hashtextextended('ca:tournament-terminal-settlement:v1',0)"
    );
    expect(globalLock).toBeGreaterThan(-1);
    expect(ADOPTION.indexOf('FOR UPDATE')).toBeGreaterThan(globalLock);
    expect(ADOPTION).toContain('v_rows <> 1 OR v_paid IS DISTINCT FROM 200.00');
    expect(ADOPTION).toContain("v_existing_payout.source IS DISTINCT FROM 'structure'");
    expect(ADOPTION).toContain('exact append-only ledger evidence changed');
    expect(ADOPTION).toContain('exact entry-fee evidence changed');
    expect(ADOPTION).toContain('exact terminal rake settlement changed');
    expect(ADOPTION).toContain('exact wallet movement evidence changed');
    expect(ADOPTION).toContain('v_source_escrow.prize_balance IS DISTINCT FROM 85.00');
    expect(ADOPTION).toContain('p_amount => 85.00');
    expect(ADOPTION).toContain('p_payout_position => 2');
    expect(ADOPTION).toContain("p_payout_source => 'satellite_remainder'");
    expect(ADOPTION).toContain('v_paid IS DISTINCT FROM 285.00');
    expect(ADOPTION).toContain('immutable whole-pool receipt did not verify');
    expect(ADOPTION).not.toContain('public.fn_settle_tournament_rake(');
    expect(ADOPTION).not.toContain('UPDATE public.tournament_players SET prize = 0');
  });

  it('defers historical writes until after broad DDL and drops both owner-only helpers', () => {
    expect(SQL).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_adopt_682_satellite_completion()'
    );
    expect(SQL).not.toContain('PERFORM public.fn_ca_adopt_b066_satellite_remainder()');
    expect(SQL).not.toContain('PERFORM public.fn_ca_adopt_682_satellite_completion()');
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_adopt_b066_satellite_remainder\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_adopt_682_satellite_completion\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    const cutoverPrerequisite = ADOPTION_CLOSEOUT_SQL.indexOf(
      "c.migration_version = '20260909014421'"
    );
    const terminalBoundary = ADOPTION_CLOSEOUT_SQL.indexOf(
      "hashtextextended('ca:tournament-terminal-settlement:v1',0)",
      cutoverPrerequisite
    );
    const maintenanceBoundary = ADOPTION_CLOSEOUT_SQL.indexOf(
      'pg_advisory_xact_lock_shared(530090,1)',
      terminalBoundary
    );
    const freezeGate = ADOPTION_CLOSEOUT_SQL.indexOf(
      'IF public.fn_entry_purchases_frozen() THEN',
      maintenanceBoundary
    );
    const b066Call = ADOPTION_CLOSEOUT_SQL.indexOf(
      'v_receipt := public.fn_ca_adopt_b066_satellite_remainder()'
    );
    const completion682Call = ADOPTION_CLOSEOUT_SQL.indexOf(
      'PERFORM public.fn_ca_adopt_682_satellite_completion()'
    );
    const b066ReceiptVerification = ADOPTION_CLOSEOUT_SQL.indexOf(
      'b066 closeout did not produce its exact immutable 285/200/85 receipt'
    );
    const completion682ReceiptVerification = ADOPTION_CLOSEOUT_SQL.indexOf(
      '682 closeout did not produce its exact immutable 285/200/85 receipt'
    );
    const firstHelperDrop = ADOPTION_CLOSEOUT_SQL.indexOf(
      'DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder()'
    );
    expect(cutoverPrerequisite).toBeGreaterThan(-1);
    expect(terminalBoundary).toBeGreaterThan(cutoverPrerequisite);
    expect(maintenanceBoundary).toBeGreaterThan(terminalBoundary);
    expect(freezeGate).toBeGreaterThan(-1);
    expect(freezeGate).toBeGreaterThan(maintenanceBoundary);
    expect(b066Call).toBeGreaterThan(freezeGate);
    expect(completion682Call).toBeGreaterThan(freezeGate);
    expect(b066ReceiptVerification).toBeGreaterThan(b066Call);
    expect(completion682ReceiptVerification).toBeGreaterThan(completion682Call);
    expect(firstHelperDrop).toBeGreaterThan(b066ReceiptVerification);
    expect(firstHelperDrop).toBeGreaterThan(completion682ReceiptVerification);
    expect(ADOPTION_CLOSEOUT_SQL).not.toMatch(/ALTER TABLE|LOCK TABLE/);
    expect(ADOPTION_CLOSEOUT_SQL).toContain(
      'DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder()'
    );
    expect(ADOPTION_CLOSEOUT_SQL).toContain(
      'DROP FUNCTION public.fn_ca_adopt_682_satellite_completion()'
    );
  });

  it('registers the atomic satellite payer with the enforced money path and removes the adoption door', () => {
    expect(ADOPTION_CLOSEOUT_SQL).toContain(
      'RENAME TO fn_settle_satellite_tournament_pre_money_path_gate'
    );
    expect(ADOPTION_CLOSEOUT_SQL).toContain(
      "set_config(\n    'app.money_path','fn_settle_satellite_tournament',true)"
    );
    expect(ADOPTION_CLOSEOUT_SQL).toContain(
      "set_config(\n      'app.money_path','fn_ca_adopt_b066_satellite_remainder',true)"
    );
    expect(ADOPTION_CLOSEOUT_SQL).not.toContain('SET app.money_path TO');

    const finalGuardAt = ADOPTION_CLOSEOUT_SQL.lastIndexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_money_path_log()'
    );
    const finalGuard = ADOPTION_CLOSEOUT_SQL.slice(finalGuardAt);
    expect(finalGuard).toContain("'fn_settle_tournament_obligation'");
    expect(finalGuard).toContain("'fn_settle_satellite_tournament'");
    expect(finalGuard).not.toContain("'fn_ca_adopt_b066_satellite_remainder'");
    expect(
      ADOPTION_CLOSEOUT_SQL.indexOf('DROP FUNCTION public.fn_ca_adopt_b066_satellite_remainder()')
    ).toBeLessThan(finalGuardAt);
  });

  it('uses PostgreSQL-supported object-key evidence for the one-time 682 proof', () => {
    expect(ADOPTION_CLOSEOUT_SQL).not.toContain('jsonb_object_length(');
    expect(
      ADOPTION_CLOSEOUT_SQL.match(/jsonb_object_keys\(r\.player_contributions\)/g)
    ).toHaveLength(3);
  });
});

describe('the completed 682 legacy split is adopted without moving money again', () => {
  it('accepts only the exact fully paid event and preserves its append-only evidence', () => {
    expect(ADOPTION_682).toContain("'682045c5-cb07-47ed-ad0e-adbff9cb41af'");
    expect(ADOPTION_682).toContain("'57b96759-2acd-4142-bc4e-37b273cd3542'");
    expect(ADOPTION_682).toContain("'0de0bc80-dd26-4631-b7f5-3baf0fb4a9da'");
    expect(ADOPTION_682).toContain("'a15db36e-6684-4edd-be48-277bfb3113ba'");
    expect(ADOPTION_682).toContain('v_rows <> 2 OR v_amount IS DISTINCT FROM 285.00');
    expect(ADOPTION_682).toContain('v_escrow.prize_out IS DISTINCT FROM 285.00');
    expect(ADOPTION_682).toContain('v_source.is_pko IS DISTINCT FROM false');
    expect(ADOPTION_682).toContain('v_source.is_premium_spin IS DISTINCT FROM false');
    expect(ADOPTION_682).toContain('v_source.buy_in_amount IS DISTINCT FROM 142.50');
    expect(ADOPTION_682).toContain("'2026-09-08 11:17:39.702118+00'");
    expect(ADOPTION_682).toContain('v_winner.chip_count IS DISTINCT FROM 0');
    expect(ADOPTION_682).toContain('v_bubble.eliminated_at IS DISTINCT FROM');
    expect(ADOPTION_682).toContain('v_registration.seat_number IS NOT NULL');
    expect(ADOPTION_682).toContain("tb.name = 'Sunday $200 Deep Stack Satellite Heads-Up'");
    expect(ADOPTION_682).toContain('ts.horse_id = v_winner_id');
    expect(ADOPTION_682).toContain('ts.horse_id = v_bubble_id');
    expect(ADOPTION_682).toContain('v_winner.chips IS DISTINCT FROM 600.00');
    expect(ADOPTION_682).toContain('v_bubble.chips IS DISTINCT FROM 0');
    expect(ADOPTION_682).toContain(
      'v_target_escrow.prize_balance IS DISTINCT FROM v_target.prize_pool'
    );
    expect(ADOPTION_682).not.toContain('fn_credit_and_log');

    const mutations = [
      ...ADOPTION_682.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.([a-z_]+)/gi),
    ].map((match) => `${match[1].toUpperCase().replace(/\s+/g, ' ')} public.${match[2]}`);
    expect(mutations).toEqual([
      'UPDATE public.tournaments',
      'UPDATE public.tournament_players',
      'UPDATE public.tables',
      'UPDATE public.table_seats',
      'INSERT INTO public.tournament_satellite_settlements',
      'INSERT INTO public.tournament_satellite_awards',
      'INSERT INTO public.tournament_satellite_remainders',
    ]);
  });

  it('normalizes only stale caches and writes an exact immutable receipt', () => {
    expect(ADOPTION_682).toContain('SET prize_pool = 285.00');
    expect(ADOPTION_682).toContain('UPDATE public.tournament_players SET prize = 85.00');
    expect(ADOPTION_682).toMatch(
      /UPDATE public\.tables\s+SET lifecycle = 'closed', terminal_closed_at = v_source\.ended_at/
    );
    expect(ADOPTION_682).toContain("SET status = 'left'");
    expect(ADOPTION_682).toContain('INSERT INTO public.tournament_satellite_settlements');
    expect(ADOPTION_682).toContain('INSERT INTO public.tournament_satellite_awards');
    expect(ADOPTION_682).toContain('INSERT INTO public.tournament_satellite_remainders');
    expect(ADOPTION_682).toContain("'legacy_20260908_682'");
    expect(ADOPTION_682).toContain('public.fn_ca_satellite_settlement_receipt');
  });
});
