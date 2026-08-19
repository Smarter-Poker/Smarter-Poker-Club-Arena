/**
 * REGRESSION (2026-08-19, P0): a full 9/9 SNG was CANCELLED 15 seconds after it
 * started.
 *
 * GameServer.cleanupStaleData() sweep §5 cancelled EVERY running SNG/Spin on
 * boot, justified by the comment "they can't survive a server restart — lobby
 * IDs change, table engines are lost". That premise was false:
 * discoverTournaments() looks for RUNNING tournaments with no engine and calls
 * TournamentManager.resume(), which rebuilds a ServerTableEngine per surviving
 * table and restores the blind level and mid-level clock.
 *
 * Because the engine redeploys on every push touching server/**, the sweep
 * fired constantly. Production over two days: 563 CANCELLED vs 243 COMPLETED,
 * cancellations arriving in same-second pairs — the signature of a boot sweep,
 * not organic under-filling. The tournament Dan joined filled 9/9, started at
 * 03:14:13 and died at 03:14:28 with its table open and all nine seats taken.
 *
 * Invariant locked here: the restart-cancel path must prove a tournament has NO
 * resumable table before killing it, and must fail closed if it cannot tell.
 *
 * Source-level assertions on purpose — cleanupStaleData is a private method
 * that talks to Supabase across half a dozen sweeps; a mocked client would
 * assert the mock, not the policy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(resolve(__dirname, '../../server/src/GameServer.ts'), 'utf8');

/** Sweep §5 — the restart-cancel path for SNG/Spin tournaments. */
const sweep5 = SRC.slice(
  SRC.indexOf('const { data: runningSngSpins }'),
  SRC.indexOf('// 6. Cancel stale RUNNING MTT')
);

describe('running SNG/Spin tournaments survive a server restart', () => {
  it('still has the restart sweep', () => {
    expect(sweep5.length).toBeGreaterThan(400);
    expect(sweep5).toContain('runningSngSpins');
  });

  it('checks for a resumable table before cancelling', () => {
    expect(sweep5).toContain("from('tables')");
    expect(sweep5).toMatch(/\.eq\(\s*'tournament_id'\s*,\s*t\.id\s*\)/);
    expect(sweep5).toMatch(/\.in\(\s*'status'\s*,\s*\[[^\]]*'waiting'[^\]]*'running'[^\]]*\]/);
  });

  it('skips the cancel when a resumable table exists', () => {
    // The guard must `continue` (leave it for resume), not fall through.
    expect(sweep5).toMatch(/resumableTables[\s\S]{0,160}continue;/);
  });

  it('fails CLOSED — an errored lookup must not cancel the tournament', () => {
    expect(sweep5).toMatch(/resumableErr/);
    expect(sweep5).toMatch(/if\s*\(\s*resumableErr\s*\)[\s\S]{0,500}continue;/);
  });

  it('the resumable guard runs BEFORE the status flip to CANCELLED', () => {
    const guardAt = sweep5.indexOf('resumableTables');
    const cancelAt = sweep5.indexOf("status: 'CANCELLED'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(cancelAt);
  });

  it('no longer claims running tournaments cannot survive a restart', () => {
    expect(sweep5).not.toMatch(/can'?t survive a server restart/i);
  });
});

describe('the resume path the sweep defers to', () => {
  it('discovery still resumes RUNNING tournaments that have no engine', () => {
    const discovery = SRC.slice(SRC.indexOf('private async discoverTournaments'));
    expect(discovery).toMatch(/\.eq\(\s*'status'\s*,\s*'RUNNING'\s*\)/);
    expect(discovery).toContain('tm.resume()');
  });
});
