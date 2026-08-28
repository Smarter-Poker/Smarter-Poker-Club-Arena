/**
 * V23 PLATFORM (2026-08-28): the second daily league window and the fleet's
 * first straddle table. Source-shape pins, the HorseLeagueSchedule.test.ts
 * convention — these guard wiring that regresses silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const leagueSrc = readFileSync(join(__dirname, '../benchmark/HorseLeague.ts'), 'utf8');
const fleetSrc = readFileSync(join(__dirname, 'HorseFleetManager.ts'), 'utf8');

describe('league PM window', () => {
  it('a second daily window exists and claims under its own job name', () => {
    // Two windows double measurement throughput on a ~30-matchup card;
    // without a separate claim, leader/standby pairs would both run it.
    expect(leagueSrc).toContain('LEAGUE_PM_HOUR_UTC');
    expect(leagueSrc).toContain("claimNightlyJob('league_pm', today)");
  });

  it('the PM window does not consult alreadyRanToday — the claim is the dedup', () => {
    // The night run's rows exist by design when the PM window opens; gating
    // on them would make the PM window a no-op forever.
    const pm = leagueSrc.slice(leagueSrc.indexOf('V23 PM WINDOW'));
    const pmBlock = pm.slice(0, pm.indexOf('\n}\n'));
    // The comment names the function; the CODE must not call it.
    expect(pmBlock).not.toContain('await alreadyRanToday');
  });

  it('the AM path is untouched: DB guard first, then the claim', () => {
    expect(leagueSrc).toContain('alreadyRanToday(today)');
    expect(leagueSrc).toContain("claimNightlyJob('league', today)");
  });
});

describe('fleet straddle table', () => {
  it('exactly one straddle config exists and it is NLH', () => {
    const matches = fleetSrc.match(/straddleEnabled: true/g) ?? [];
    expect(matches.length).toBe(1);
    const idx = fleetSrc.indexOf('straddleEnabled: true');
    const block = fleetSrc.slice(Math.max(0, idx - 600), idx);
    expect(block).toContain("gameVariant: 'nlh'");
  });

  it('the insert writes straddle_enabled from the config', () => {
    expect(fleetSrc).toContain('straddle_enabled: config.straddleEnabled === true');
  });

  it('the reuse path COMPARES before writing (an unconditional write would reset current_players every cycle)', () => {
    // Whitespace-tolerant: the pre-commit Prettier wraps this line, and an
    // exact-substring pin broke in CI the first time it did (run 33141442420).
    expect(fleetSrc).toMatch(/straddle_enabled !==\s*\(config\.straddleEnabled === true\)/);
    expect(fleetSrc).toContain(
      "select('id, status, union_id, game_variant, small_blind, big_blind, straddle_enabled')"
    );
  });
});
