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
 * cancellations arriving in same-second pairs. Dan's tournament filled 9/9,
 * started 03:14:13 and died 03:14:28 with its table open and all nine seats
 * taken.
 *
 * The sweep is now GONE — not narrowed. resume() additionally rebuilds the
 * tables when none survived, so a restart has no unrecoverable state left.
 *
 * Source-level assertions on purpose: cleanupStaleData is a private method
 * spanning half a dozen Supabase sweeps, and a mocked client would assert the
 * mock rather than the policy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(resolve(__dirname, '../../server/src/GameServer.ts'), 'utf8');
const BASE = readFileSync(
  resolve(__dirname, '../../server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

describe('running tournaments survive a server restart', () => {
  it('the boot sweep no longer cancels running SNG/Spin tournaments', () => {
    // Assert the CODE, not the prose — the comment deliberately quotes the old
    // premise so future readers know why the sweep was removed.
    const code = SRC.split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toContain("status: 'CANCELLED'");
    expect(code).not.toContain('refundAndCloseCancelledTournament(');
  });

  it('the boot sweep preserves them for the resume path', () => {
    expect(SRC).toMatch(/preserved across restart/i);
  });

  it('discovery still resumes RUNNING tournaments that have no engine', () => {
    const discovery = SRC.slice(SRC.indexOf('private async discoverTournaments'));
    expect(discovery).toMatch(/\.eq\(\s*'status'\s*,\s*'RUNNING'\s*\)/);
    expect(discovery).toContain('tm.resume()');
  });

  it('resume rebuilds the tables when none survived, instead of giving up', () => {
    const resume = BASE.slice(BASE.indexOf('async resume()'));
    expect(resume).toMatch(/tables\.length === 0|!tables \|\| tables\.length === 0/);
    expect(resume).toContain('createTablesAndSeatPlayers(tournament)');
  });

  it('resume only rebuilds when entrants actually remain', () => {
    const resume = BASE.slice(BASE.indexOf('async resume()'));
    expect(resume).toMatch(/liveEntrants/);
    expect(resume).toMatch(/\.in\(\s*'status'\s*,\s*\[[^\]]*'registered'[^\]]*'playing'[^\]]*\]/);
  });
});
