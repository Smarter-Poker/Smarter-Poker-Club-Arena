/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE OPEN BUG IS ONE ROW, AND THE CATEGORY SAYS WHAT BROKE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Both halves of the 2026-09-12 `horse_bug_reports` audit, pinned.
 *
 *   - 243 rows, one defect. The old dedupe compared raw titles inside a
 *     5-second window held in ONE page session, so two literals that differed
 *     only in a path segment were two bugs, and a fresh browser context half
 *     an hour later was a third. Identity is a fingerprint now.
 *   - Every one of those rows said `tournament_bug`. The categoriser tested
 *     the whole console message, and `reportError` puts the CONTEXT LABEL at
 *     the front of it, so a client uuid bug in a component whose name contains
 *     "Tournament" arrived looking like a tournament money incident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const writes: { op: string; row: any }[] = [];

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      insert: (row: any) => {
        writes.push({ op: `insert:${table}`, row });
        return Promise.resolve({ data: null, error: null });
      },
      upsert: (row: any, opts?: any) => {
        writes.push({ op: `upsert:${table}`, row: { ...row, __opts: opts } });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import {
  horseBugReporter,
  bugFingerprint,
  categoriseConsoleError,
  normaliseBugMessage,
  splitContextLabel,
  isAutomatedSession,
} from '../../src/services/HorseBugReporter';

/** The exact two messages that produced the 243 rows. */
const label = 'TournamentStartingTicker.loadManagedSettings';
const err = (literal: string) =>
  `[${label}] {"code":"22P02","details":null,"hint":null,"message":"invalid input syntax for type uuid: \\"${literal}\\""}`;

const setWebdriver = (value: boolean) =>
  Object.defineProperty(navigator, 'webdriver', { value, configurable: true });

beforeEach(() => {
  writes.length = 0;
  horseBugReporter.clear();
  setWebdriver(false);
});
afterEach(() => {
  horseBugReporter.stopCapturing();
  setWebdriver(false);
});

describe('the fingerprint is the identity of a bug', () => {
  it('collapses the two literals that made 243 rows into ONE', () => {
    expect(bugFingerprint(err('demo'))).toBe(bugFingerprint(err('nonexistent-table-id')));
  });

  it('keeps two genuinely different errors at the same call site apart', () => {
    const permissionDenied = `[${label}] {"code":"42501","details":null,"hint":null,"message":"permission denied for table tables"}`;
    expect(bugFingerprint(err('demo'))).not.toBe(bugFingerprint(permissionDenied));
  });

  it('keeps the same error at two different call sites apart', () => {
    expect(bugFingerprint(err('demo'))).not.toBe(
      bugFingerprint(err('demo').replace(label, 'SomewhereElse.load'))
    );
  });

  it('strips uuids, timestamps and numbers but keeps the SQLSTATE readable', () => {
    const n = normaliseBugMessage(
      '{"code":"22P02","at":"2026-09-12T04:49:45.073Z","id":"3f1a7c22-1111-4222-8333-444455556666","n":1234}'
    );
    expect(n).toContain('"22P02"');
    expect(n).toContain('<uuid>');
    expect(n).toContain('<ts>');
    expect(n).toContain('<n>');
  });

  it('splits the context label reportError writes from the error body', () => {
    const { label: l, body } = splitContextLabel(err('demo'));
    expect(l).toBe(label);
    expect(body.startsWith('{')).toBe(true);
  });
});

describe('the category says what broke, not which component held it', () => {
  it('a uuid boundary error is NOT a tournament bug', () => {
    const routed = categoriseConsoleError(splitContextLabel(err('demo')).body);
    expect(routed).not.toBeNull();
    expect(routed!.category).toBe('runtime_error');
    expect(routed!.category).not.toBe('tournament_bug');
  });

  it('the component name alone can no longer route or set severity', () => {
    // Every one of these labels used to decide the outcome on its own.
    for (const l of ['TournamentStartingTicker.load', 'WalletPanel.load', 'RpcThing.load']) {
      const body = splitContextLabel(`[${l}] {"message":"boom"}`).body;
      expect(categoriseConsoleError(body)).toBeNull();
    }
  });

  it('a real wallet failure still files as wallet_sync/high', () => {
    const routed = categoriseConsoleError('Wallet balance could not be debited');
    expect(routed).toEqual({ category: 'wallet_sync', severity: 'high' });
  });

  it('a real tournament failure still files as tournament_bug', () => {
    const routed = categoriseConsoleError('tournament registration was rejected');
    expect(routed).toEqual({ category: 'tournament_bug', severity: 'medium' });
  });

  it('a TypeError is a runtime error, not an rpc error', () => {
    // The old rule matched the bare word "function" anywhere in the message.
    const routed = categoriseConsoleError('x.foo is not a function');
    expect(routed!.category).toBe('runtime_error');
  });

  /* THE WIRING, NOT ONLY THE FUNCTION. The two tests above call
     categoriseConsoleError directly, so they stay green even if the console
     hook goes back to handing it the WHOLE message - which was the actual
     defect. Found by reverting that one call site and watching every test
     pass. These two go through console.error itself. */
  it('the console hook feeds it the body, never the label', () => {
    horseBugReporter.startCapturing();
    // Body matches no rule. Label contains "Tournament". Nothing may be filed.
    console.error('[TournamentStartingTicker.load]', { message: 'boom' });
    expect(horseBugReporter.getReports()).toEqual([]);
  });

  it('end to end, the 243-row message files as a runtime error', () => {
    horseBugReporter.startCapturing();
    console.error(err('demo'));
    const [report] = horseBugReporter.getReports();
    expect(report.category).toBe('runtime_error');
    expect(report.severity).toBe('high');
  });
});

describe('a repeated bug is one row, refreshed', () => {
  it('50 occurrences across two literals produce ONE report and ONE write', () => {
    horseBugReporter.startCapturing();
    for (let i = 0; i < 25; i++) {
      console.error(err('demo'));
      console.error(err('nonexistent-table-id'));
    }
    const reports = horseBugReporter.getReports();
    expect(reports.length).toBe(1);
    expect(reports[0].id.startsWith('cbug:')).toBe(true);
    expect(reports[0].context.occurrences_this_session).toBe(50);
    const persisted = writes.filter((w) => w.op === 'upsert:horse_bug_reports');
    expect(persisted.length).toBe(1);
  });

  it('the row it writes is an upsert on the primary key, with no created_at', () => {
    horseBugReporter.startCapturing();
    console.error(err('demo'));
    const w = writes.find((x) => x.op === 'upsert:horse_bug_reports')!;
    expect(w).toBeTruthy();
    expect(w.row.__opts).toEqual({ onConflict: 'id' });
    // created_at must keep its column default, so it means FIRST seen.
    expect('created_at' in w.row).toBe(false);
    expect(w.row.context.fingerprint).toBe(bugFingerprint(err('demo')));
    expect(w.row.resolved).toBe(false);
  });

  it('a distinct report is still one row per call, with the original id shape', () => {
    horseBugReporter.report({
      horseName: 'H1',
      horseId: 'h1',
      tableId: 't1',
      tableName: 'T1',
      handNumber: 7,
      category: 'chip_integrity',
      severity: 'critical',
      title: 'Negative Stack',
      description: '',
      context: {},
    });
    expect(horseBugReporter.getReports()[0].id).toMatch(/^bug_/);
    expect(writes.filter((w) => w.op === 'insert:horse_bug_reports').length).toBe(1);
  });
});

describe('a robot does not write to the production bug table', () => {
  it('withholds the write under navigator.webdriver, and still captures', () => {
    setWebdriver(true);
    expect(isAutomatedSession()).toBe(true);
    horseBugReporter.startCapturing();
    console.error(err('demo'));
    // Captured in memory for the spec to assert on...
    expect(horseBugReporter.getReports().length).toBe(1);
    // ...and not written to production.
    expect(writes.length).toBe(0);
  });

  it('is a ROBOT gate, never an is_horse gate (CLAUDE.md 10.5)', () => {
    // A horse is a player. Its bugs are real bugs and they get written like
    // anybody's. Only an automation driver is excluded, and a horse has no
    // browser, so it can never set navigator.webdriver in the first place.
    setWebdriver(false);
    horseBugReporter.report({
      horseName: 'Thunderbolt',
      horseId: 'horse-123',
      tableId: 't1',
      tableName: 'T1',
      handNumber: 3,
      category: 'chip_integrity',
      severity: 'critical',
      title: 'Negative Stack After Bet',
      description: '',
      context: { is_horse: true },
    });
    expect(writes.filter((w) => w.op === 'insert:horse_bug_reports').length).toBe(1);
  });
});
