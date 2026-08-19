/**
 * POLICY (Dan, 2026-08-19): TOURNAMENTS RUN. THEY DO NOT CANCEL.
 *
 * "WE DON'T CANCEL TOURNAMENTS, WE RUN THEM... THAT CAN NEVER EVER HAPPEN ON A
 * REAL ONLINE POKER ROOM!"
 *
 * The server had six paths that could cancel a tournament:
 *
 *   1. GameServer §4  — boot: refund + cancel REGISTERING past start by 1h
 *   2. GameServer §5  — boot: cancel EVERY running SNG/Spin
 *   3. GameServer §6  — boot: cancel RUNNING tournaments stalled >12h
 *   4. GameServer discovery — cancel if short of min_players 30min past start
 *   5. TournamentManagerBase.start() — cancel if fewer than 3 registered
 *   6. HorseLifecycleManager — cancel SNGs sitting in REGISTERING for hours
 *
 * Measured over two days before the fix: 563 CANCELLED vs 243 COMPLETED, and
 * 557 of 562 were short by exactly ONE player (363 at 2/3, 138 at 5/6, 56 at
 * 8/9) — every one a game a real room would simply have dealt.
 *
 * They now fill, resume or settle instead. This asserts the policy at the only
 * level that actually holds: no source file under server/ may write
 * status: 'CANCELLED' to a tournament.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const SERVER_SRC = resolve(__dirname, '../../server/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = walk(SERVER_SRC);

describe('no server path may cancel a tournament', () => {
  it('finds the server sources', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no file writes status: 'CANCELLED'", () => {
    const offenders = files.filter((f) =>
      // The WRITE, not a status comparison or allowlist membership.
      /status:\s*'CANCELLED'/.test(readFileSync(f, 'utf8'))
    );
    expect(offenders.map((f) => f.replace(SERVER_SRC, 'server/src'))).toEqual([]);
  });
});

describe('what replaced each cancel path', () => {
  const gameServer = readFileSync(join(SERVER_SRC, 'GameServer.ts'), 'utf8');
  const base = readFileSync(join(SERVER_SRC, 'tournament/TournamentManagerBase.ts'), 'utf8');
  const recurring = readFileSync(
    join(SERVER_SRC, 'services/TournamentRecurringService.ts'),
    'utf8'
  );
  const lifecycle = readFileSync(join(SERVER_SRC, 'services/HorseLifecycleManager.ts'), 'utf8');

  it('an under-filled tournament is topped up with players, not cancelled', () => {
    expect(gameServer).toContain('topUpWithHorses');
    expect(recurring).toContain('async topUpWithHorses');
  });

  it('the top-up rewrites current_players from the authoritative count', () => {
    // Never `liveCount + added` — a human may register in the same window.
    expect(recurring).toMatch(/finalCount[\s\S]{0,200}current_players:\s*finalCount/);
  });

  it('start() stands down when short instead of cancelling', () => {
    expect(base).toMatch(/NOT cancelling/i);
    expect(base).not.toMatch(/cancelling \(minimum 3\)/);
  });

  it('a resumed tournament with no tables is rebuilt, not abandoned', () => {
    expect(base).toContain('createTablesAndSeatPlayers(tournament)');
    expect(base).toMatch(/Resuming with NO open tables/);
  });

  it('a tournament stalled >12h is settled and paid, not voided', () => {
    expect(gameServer).toContain('recoverStuckCompletingTournaments');
    expect(gameServer).toMatch(/COMPLETING/);
  });

  it('the horse lifecycle sweep only observes slow-filling SNGs now', () => {
    expect(lifecycle).toContain('stale_sng_observed');
    expect(lifecycle).not.toContain('stale_sng_cancelled');
  });

  it('GameServer no longer imports the cancel-cleanup helper', () => {
    expect(gameServer).not.toMatch(/^\s*refundAndCloseCancelledTournament,$/m);
  });
});
