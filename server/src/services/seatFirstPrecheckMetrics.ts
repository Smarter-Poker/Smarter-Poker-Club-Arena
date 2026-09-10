/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SEAT-FIRST PRE-CHECK, COUNTED WHERE A DASHBOARD CAN SEE IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * topUpWithHorses skips fn_seat_horse_in_seat_first_game for a horse the seat
 * rows show seated and for a table they show full (see seatFirstSeatPrecheck
 * in TournamentRecurringService.ts). The saving is a lock acquisition that
 * did not happen on the one platform-wide key every hand settlement waits on,
 * and until now the only evidence of it was a log line per fill pass. A log
 * line needs log access; a counter needs a scrape.
 *
 * One counter family, one label. `outcome` carries every field of the
 * per-pass tally, so the ratio that matters - `seated` against `rpc_called`,
 * which should move toward one - is a PromQL division, and the residue the
 * ledger cannot see (`rpc_already_seated`, `rpc_table_full`, the race within
 * a tick) is a series that can be watched rather than grepped.
 *
 * Module-level, like wsAuthRefusals in transport/wsHelpers.ts: the counters
 * belong to the process, not to a service instance, because several services
 * (GameServer discovery, the scheduler, the overlay guard) drive the same
 * top-up. Every series is present from the first scrape, at zero, so a rule
 * can tell "nothing skipped" from "nothing reported".
 */

export const SEAT_FIRST_PRECHECK_OUTCOMES = [
  'rpc_called',
  'skipped_already_seated',
  'skipped_table_full',
  'verify_reads',
  'seated',
  'rpc_already_seated',
  'rpc_table_full',
  'rpc_refused',
  'rpc_other_noop',
] as const;

export type SeatFirstPrecheckOutcome = (typeof SEAT_FIRST_PRECHECK_OUTCOMES)[number];

export interface SeatFirstPrecheckTally {
  rpcCalled: number;
  skippedAlreadySeated: number;
  skippedTableFull: number;
  /** Lock-free re-reads of the seat rows made to confirm a skip before taking it. */
  verifyReads: number;
  seated: number;
  rpcAlreadySeated: number;
  rpcTableFull: number;
  rpcRefused: number;
  rpcOtherNoop: number;
}

export function emptySeatFirstPrecheckTally(): SeatFirstPrecheckTally {
  return {
    rpcCalled: 0,
    skippedAlreadySeated: 0,
    skippedTableFull: 0,
    verifyReads: 0,
    seated: 0,
    rpcAlreadySeated: 0,
    rpcTableFull: 0,
    rpcRefused: 0,
    rpcOtherNoop: 0,
  };
}

const totals = new Map<SeatFirstPrecheckOutcome, number>(
  SEAT_FIRST_PRECHECK_OUTCOMES.map((k) => [k, 0] as const)
);

function bump(outcome: SeatFirstPrecheckOutcome, by: number): void {
  const n = Math.max(0, Math.floor(Number(by) || 0));
  if (n === 0) return;
  totals.set(outcome, (totals.get(outcome) ?? 0) + n);
}

/** Fold one fill pass's tally into the process-wide counters. */
export function recordSeatFirstPrecheck(tally: SeatFirstPrecheckTally): void {
  bump('rpc_called', tally.rpcCalled);
  bump('skipped_already_seated', tally.skippedAlreadySeated);
  bump('skipped_table_full', tally.skippedTableFull);
  bump('verify_reads', tally.verifyReads);
  bump('seated', tally.seated);
  bump('rpc_already_seated', tally.rpcAlreadySeated);
  bump('rpc_table_full', tally.rpcTableFull);
  bump('rpc_refused', tally.rpcRefused);
  bump('rpc_other_noop', tally.rpcOtherNoop);
}

/** The running totals, for tests and for anything that wants them without parsing exposition text. */
export function seatFirstPrecheckTotals(): Record<SeatFirstPrecheckOutcome, number> {
  const out = {} as Record<SeatFirstPrecheckOutcome, number>;
  for (const k of SEAT_FIRST_PRECHECK_OUTCOMES) out[k] = totals.get(k) ?? 0;
  return out;
}

/** Tests only: a fresh process has no history. */
export function resetSeatFirstPrecheckTotalsForTests(): void {
  for (const k of SEAT_FIRST_PRECHECK_OUTCOMES) totals.set(k, 0);
}

/** Prometheus exposition lines (always present, every outcome, even at zero). */
export function seatFirstPrecheckPrometheusLines(): string[] {
  const lines = [
    '# HELP poker_seat_first_precheck_total Seat-first horse fill decisions (label: outcome). rpc_called = fn_seat_horse_in_seat_first_game taken; skipped_already_seated / skipped_table_full = calls the seat rows made unnecessary; verify_reads = lock-free re-reads that confirmed a skip; seated / rpc_already_seated / rpc_table_full / rpc_refused / rpc_other_noop = what the calls answered',
    '# TYPE poker_seat_first_precheck_total counter',
  ];
  for (const k of SEAT_FIRST_PRECHECK_OUTCOMES) {
    lines.push(`poker_seat_first_precheck_total{outcome="${k}"} ${totals.get(k) ?? 0}`);
  }
  return lines;
}
