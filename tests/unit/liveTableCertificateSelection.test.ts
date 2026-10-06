import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  eligibleHudClock,
  MTT_HUD_LEVEL_CAP_MS,
  MTT_SELECTION_LOOKAHEAD_LEVELS,
  selectableHudClock,
} from '../e2e/support/tournamentHudWitness';

/**
 * Production runs 36525050502 and 36526016402 (2026-09-29) both chose the MTT
 * table of the 383-player field, whose add-on period was open until 06:07:47Z,
 * and then refused "no eligible natural HUD clock" minutes later. The clock
 * predicate was right; the selector never asked it. Cash run 36525050502 failed
 * inside a 112-second, twelve-action hand that legitimately outlasted the fixed
 * 90-second budget (hand_history: started 05:27:17, ended 05:29:09).
 */
const id = '4dddfe78-e557-4237-87cc-428c4c9a98f8';
const now = Date.parse('2026-09-29T05:45:00Z');
const level = (minutes: number, extra: Record<string, unknown> = {}) => ({
  durationMinutes: minutes,
  ...extra,
});
const running = {
  id,
  status: 'RUNNING',
  current_players: 381,
  started_at: '2026-09-29T05:00:00Z',
  current_level: 3,
  level_started_at: '2026-09-29T05:43:00Z',
  on_break: false,
  accelerated_mtt: false,
  addon_period_started_at: null,
  addon_period_ends_at: null,
  blind_structure: [level(10), level(10), level(10), level(10), level(10), level(10), level(10)],
};

describe('an MTT table is selected only if its tournament can yield an eligible HUD clock', () => {
  it('refuses the field whose add-on period is open, the exact production refusal', () => {
    const addOnOpen = {
      ...running,
      addon_period_started_at: '2026-09-29T05:09:47.640Z',
      addon_period_ends_at: '2026-09-29T06:07:47.640Z',
    };
    expect(eligibleHudClock(addOnOpen, now)).toBeNull();
    expect(selectableHudClock(addOnOpen, now)).toBeNull();
    // The same field once its add-on period has closed is selectable again.
    expect(
      selectableHudClock({ ...addOnOpen, addon_period_ends_at: '2026-09-29T05:44:00Z' }, now)
    ).not.toBeNull();
  });

  it('accepts a running, break-free, add-on-free tournament with its real clock', () => {
    const clock = selectableHudClock(running, now);
    expect(clock).toEqual(eligibleHudClock(running, now));
    expect(clock?.tournamentId).toBe(id);
    expect(clock?.remainingMs).toBe(8 * 60_000);
  });

  it.each([
    ['on a break', { on_break: true }],
    ['accelerated', { accelerated_mtt: true }],
    ['paused or terminal', { status: 'PAUSED' }],
    ['too few players', { current_players: 3 }],
    ['unreadable structure', { blind_structure: 'not json' }],
  ])('refuses a tournament that is %s', (_name, patch) => {
    expect(selectableHudClock({ ...running, ...patch }, now)).toBeNull();
  });

  it('refuses a break inside the look-ahead a level roll-over during setup would reach', () => {
    for (let ahead = 1; ahead <= MTT_SELECTION_LOOKAHEAD_LEVELS; ahead++) {
      const structure = running.blind_structure.map((entry) => ({ ...entry }));
      structure[3 + ahead] = level(5, { isBreak: true }) as never;
      expect(selectableHudClock({ ...running, blind_structure: structure }, now)).toBeNull();
    }
    // Past the look-ahead the later read is a fresh selection problem.
    const far = running.blind_structure.map((entry) => ({ ...entry }));
    far.push(level(5, { isBreak: true }) as never);
    expect(
      selectableHudClock({ ...running, current_level: 2, blind_structure: far }, now)
    ).not.toBeNull();
  });

  it('refuses a look-ahead level longer than the certifiable cap', () => {
    const structure = running.blind_structure.map((entry) => ({ ...entry }));
    structure[5] = level(MTT_HUD_LEVEL_CAP_MS / 60_000 + 1) as never;
    expect(selectableHudClock({ ...running, blind_structure: structure }, now)).toBeNull();
  });

  it('holds the last level once the schedule ends, as the engine does', () => {
    const short = { ...running, current_level: 5 };
    expect(selectableHudClock(short, now)).not.toBeNull();
  });
});

describe('the certificate spec applies that selection and a cash budget sized from real hands', () => {
  const spec = readFileSync(
    join(__dirname, '..', 'e2e', 'production-live-table-realtime.spec.ts'),
    'utf8'
  );
  const tournament = spec.slice(
    spec.indexOf('async function certifyReadOnlyTournamentFormat('),
    spec.indexOf("test.describe('production mobile WebKit live-table realtime continuity'")
  );
  const selection = spec.slice(
    spec.indexOf('async function selectProgressingTournamentTable('),
    spec.indexOf('function tableIdFromUrl(')
  );
  const cash = spec.slice(spec.indexOf("test('an already-running table stays live"));

  it('qualifies MTT tables by the HUD clock at selection, and only MTT', () => {
    expect(tournament).toContain("gameFormat === 'mtt' ? boardReader : undefined");
    expect(selection).toContain('options.hudReader.clocks(');
    expect(selection).toContain('selectableHudClock');
    expect(selection).toContain('return fresh.filter((table) => clocks.has(table.tableId));');
    // It still refuses loudly when nothing qualifies, naming why.
    expect(selection).toContain('can yield an eligible natural HUD clock');
    // The post-recovery clock read is unchanged and still mandatory.
    expect(tournament).toContain('reader.clocks([candidate.id])');
    expect(tournament).toContain('The recovered MTT has no eligible natural HUD clock');
  });

  it('gives cash the tournament budget: base case + one hand bound, one fixed deadline', () => {
    expect(cash).toContain('testInfo.setTimeout(testInfo.timeout + CAUSAL_HAND_TIMEOUT_MS)');
    expect(cash).toContain(
      'const observationDeadline = caseStartedAt + testInfo.timeout - CASH_CASE_TAIL_MS'
    );
    // Both causal cycles draw on what is left of that one deadline, never on
    // a fresh fixed 90 seconds that a 112-second hand outlasts.
    expect(cash.match(/remainingObservationMs\(observationDeadline\)/g)).toHaveLength(2);
    expect(cash).not.toMatch(/CAUSAL_HAND_TIMEOUT_MS,\s*MAX_GAMEPLAY_SILENCE_MS/);
    // The silence limit, the real liveness proof, is untouched.
    expect(spec).toContain('const MAX_GAMEPLAY_SILENCE_MS = 45_000');
  });

  it('races several occupied cash tables to their next deal instead of one', () => {
    expect(spec).toContain('const CASH_PROGRESS_CANDIDATES = 8');
    expect(cash).toContain('selectOccupiedRunningCashTables(page, request)');
    expect(cash).toContain('selected.tables,');
    expect(cash).toContain('const { candidate } = engineBeforeNavigation.selected;');
    const prove = spec.slice(
      spec.indexOf('async function proveTableProgressedBeforeNavigation('),
      spec.indexOf('/**\n * Pick only from tables that were live before the browser existed')
    );
    expect(prove).toContain('continuouslyActive(');
    expect(prove).toContain('current.handCount > contender.table.handCount');
    expect(prove).toContain('remainingObservationMs(deadline)');
  });
});
