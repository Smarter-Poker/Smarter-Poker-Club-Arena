/**
 * WHY A TOURNAMENT DECISION HAD NO COMPLETE CONTEXT (2026-10-16).
 * ServerTableEngineTurns.noteTournamentContextIssues names every issue of an
 * incomplete Phase 6 context once per decision in the daily brain telemetry,
 * so launch-day data says which issue cost a decision its ICM utility.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import { ledgerReceiptFor } from './HorseDataLedger.js';
import { TOURNAMENT_CONTEXT_INCOMPLETE } from './HorseTournamentPreflop.js';
import { noteTournamentContextIssues } from './ServerTableEngineTurns.js';
import {
  __clearTournamentBrainCache,
  getTournamentBrainContextSnapshot,
} from '../services/TournamentBrainContext.js';

beforeEach(() => {
  enableBrainTelemetry();
  drainFires();
});

const fired = () => Object.fromEntries(drainFires().map(({ feature, fires }) => [feature, fires]));

describe('tournament context issue receipts', () => {
  it('names each issue of an incomplete context once, and its status, never the umbrella marker', () => {
    expect(
      noteTournamentContextIssues('incomplete', [
        TOURNAMENT_CONTEXT_INCOMPLETE,
        'payout_or_ticket_structure_missing',
        'blind_level_cache_lag',
        'blind_level_cache_lag',
      ])
    ).toEqual(['status_incomplete', 'payout_or_ticket_structure_missing', 'blind_level_cache_lag']);
    expect(fired()).toEqual({
      phase6_context_issue_status_incomplete: 1,
      phase6_context_issue_payout_or_ticket_structure_missing: 1,
      phase6_context_issue_blind_level_cache_lag: 1,
    });
  });

  it('counts nothing for a complete context', () => {
    expect(noteTournamentContextIssues('complete', [])).toEqual([]);
    expect(drainFires()).toEqual([]);
  });

  it('keeps the key set closed: an unexpected issue string is counted as unrecognized', () => {
    noteTournamentContextIssues('stale', [
      'Weird Issue!',
      'x'.repeat(65),
      'tournament_context_stale',
    ]);
    expect(fired()).toEqual({
      phase6_context_issue_status_stale: 1,
      phase6_context_issue_unrecognized: 1,
      phase6_context_issue_tournament_context_stale: 1,
    });
  });

  it('names the snapshot issue of a tournament whose context was never refreshed', () => {
    __clearTournamentBrainCache();
    const snapshot = getTournamentBrainContextSnapshot('never-refreshed');
    noteTournamentContextIssues(snapshot.status, snapshot.issues);
    expect(fired()).toEqual({
      phase6_context_issue_status_incomplete: 1,
      phase6_context_issue_tournament_context_refresh_not_started: 1,
    });
  });

  it('is registered in the data ledger and called once from the decision snapshot', () => {
    expect(ledgerReceiptFor('phase6_context_issue_blind_level_cache_lag')?.key).toBe(
      'phase6_context_issue_*'
    );
    const src = readFileSync(join(process.cwd(), 'src/engine/ServerTableEngineTurns.ts'), 'utf8');
    const start = src.indexOf('private horseTournamentContext(');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    expect(body.match(/noteTournamentContextIssues\(/g)).toHaveLength(1);
    expect(body).toContain('noteTournamentContextIssues(contextStatus, localIssues);');
  });
});
