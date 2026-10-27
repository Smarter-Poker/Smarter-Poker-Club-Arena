import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import {
  FINISH_REFUSAL_REASONS,
  classifyFinishRefusal,
  finishRefusalIsTransient,
  finishRefusalRetryDelayMs,
} from '../observability/engineInstruments.js';

const MANAGER = readFileSync(resolve(__dirname, './TournamentManager.ts'), 'utf8');
const BASE = 5_000;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TERMINAL HANDOFF IS TOLD, NOT JUST LOGGED (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tournament bfcfaf17 ("DSS Thursday $5.50 NLH Turbo") was decided at
 * 2026-09-18 05:17:48 UTC and sat RUNNING, unpaid, for nine days. Proven live
 * in a rolled-back probe (CLAUDE.md 11.5): calling
 * `fn_complete_tournament_terminal` for this exact tournament and winner
 * raises exactly `F06_SOURCE_EXCLUDED` (SQLSTATE 55000) - its winner's table
 * (0cfc4303) is bound to F06 break 544dc515, still `park_requested`, never
 * admitted, and a table down to its final winner can never deal another hand
 * to trigger the ordinary hand-refusal admission path
 * (`holdSourceForItsBreak` / `startParkedMovementEngine`).
 *
 * Two defects compounded into nine days of silence:
 *
 * 1. `classifyFinishRefusal` had no bucket for this message. It fell to
 *    `timeout` (when the resolver's own status check separately hit lock
 *    contention and appended "...canceling statement...") or `other`
 *    (otherwise) - both transient-shaped or unclassified, so the refusal
 *    retried at a flat five-second cadence with no backoff, exactly the shape
 *    `aRuleRefusalStopsAskingEveryFiveSeconds` already fixed for a NAMED rule
 *    refusal. An unnamed one reopened it.
 * 2. `recoverTournamentBreak`'s own `terminal_handoff_required` branch already
 *    names the missing step out loud in its error message - "F06 terminal
 *    owner disposition required" - and then calls only `reportError`, which
 *    reaches the error reporter and nothing durable. Measured live: zero rows
 *    ever reached `financial_alerts` or `operational_alert_events` for
 *    `Tournament.break_terminal_handoff`, though this branch ran on every
 *    elimination sweep for nine days straight.
 *
 * Neither pin proves the underlying F06 park gets admitted - that decision
 * belongs to the terminal settlement authority, not to this fleet's incident
 * response. Both pins prove the platform can no longer be silent about it:
 * the refusal is classified as a rule (escalating backoff, one critical alert
 * per reason, not a five-second treadmill), and the terminal-handoff branch
 * raises that critical alert durably instead of only logging it.
 */
describe('an F06 table exclusion is classified as a rule refusal, not a transient one', () => {
  it('is a declared reason', () => {
    expect(FINISH_REFUSAL_REASONS).toContain('f06_table_excluded');
  });

  it('classifies the raw database message', () => {
    expect(classifyFinishRefusal('F06_SOURCE_EXCLUDED')).toBe('f06_table_excluded');
    expect(
      classifyFinishRefusal(
        'terminal settlement outcome is unknown after 1 identical attempt(s): F06_SOURCE_EXCLUDED'
      )
    ).toBe('f06_table_excluded');
  });

  it('is not swallowed by the timeout bucket even when the composed failure text says "timeout"', () => {
    // The exact shape bfcfaf17 produced: the write attempt fails with
    // F06_SOURCE_EXCLUDED, and the resolver's separate status check appends a
    // lock/statement timeout from unrelated contention on the same failure
    // string. The word "timeout" appearing later must not override the rule.
    const composed =
      'F06_SOURCE_EXCLUDED; serialized outcome check failed: canceling statement due to statement timeout';
    expect(classifyFinishRefusal(composed)).toBe('f06_table_excluded');
  });

  it('is not classified as a transient contention reason', () => {
    expect(finishRefusalIsTransient('f06_table_excluded')).toBe(false);
  });

  it('backs off exactly like every other rule refusal: one fast pass, then doubling to the cap', () => {
    expect(finishRefusalRetryDelayMs('f06_table_excluded', 1, BASE)).toBe(BASE);
    expect(finishRefusalRetryDelayMs('f06_table_excluded', 2, BASE)).toBe(BASE * 2);
    expect(finishRefusalRetryDelayMs('f06_table_excluded', 9, BASE)).toBe(900_000);
  });
});

describe('a terminal handoff requirement is a durable critical alert, not only a log line', () => {
  const HANDOFF = sliceMethod(
    MANAGER,
    'recoverTournamentBreak(state: TournamentTableBreakState): Promise<void>'
  );

  it('the window under test is real and covers the terminal_handoff_required branch', () => {
    expect(HANDOFF.length).toBeGreaterThan(200);
    expect(HANDOFF).toContain('current.terminal_handoff_required');
  });

  it('imports the durable alert path', () => {
    expect(MANAGER).toContain(
      "import { raiseFinancialAlert } from '../services/financialAlerts.js';"
    );
  });

  it('still reports the condition for error-tracking, unchanged', () => {
    const branch = HANDOFF.slice(HANDOFF.indexOf('if (current.terminal_handoff_required)'));
    expect(branch).toContain('reportError(');
    expect(branch).toContain('F06 terminal owner disposition required');
  });

  it('also raises a durable critical alert naming the tournament, table and break', () => {
    const branch = HANDOFF.slice(HANDOFF.indexOf('if (current.terminal_handoff_required)'));
    const reportIdx = branch.indexOf('reportError(');
    const alertIdx = branch.indexOf('raiseFinancialAlert(');
    expect(alertIdx).toBeGreaterThan(reportIdx);
    const alertCall = branch.slice(alertIdx, branch.indexOf('return;', alertIdx));
    expect(alertCall).toContain("'critical'");
    expect(alertCall).toContain("'Tournament.break_terminal_handoff'");
    expect(alertCall).toContain('current.source_table_id');
    expect(alertCall).toContain('current.break_id');
  });

  it('dedupes per (tournament, break) so the five-second sweep cadence cannot flood it', () => {
    const branch = HANDOFF.slice(HANDOFF.indexOf('if (current.terminal_handoff_required)'));
    expect(branch).toMatch(/`\$\{this\.tournamentId\}:\$\{current\.break_id\}:terminal_handoff`/);
  });

  it('does not itself admit or retire the break - it only tells someone', () => {
    const branch = HANDOFF.slice(
      HANDOFF.indexOf('if (current.terminal_handoff_required)'),
      HANDOFF.indexOf('return;', HANDOFF.indexOf('raiseFinancialAlert('))
    );
    expect(branch).not.toContain('fn_f06_admit_parked_movement');
    expect(branch).not.toContain('startParkedMovementEngine');
    expect(branch).not.toContain('retireTournamentBreak');
  });
});
