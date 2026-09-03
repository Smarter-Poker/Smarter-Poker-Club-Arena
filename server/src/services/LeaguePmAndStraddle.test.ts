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

  it('the PM window does not consult alreadyRanToday - the claim is the dedup', () => {
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

  it('a straddle table actually POSTS a straddle, not merely permits one', () => {
    // MEASURED 2026-08-28: the table went live, seated 8 horses, dealt 107
    // hands in two hours - and v18_straddle telemetry stayed at ZERO.
    // straddle_enabled only grants PERMISSION; the post comes from
    // StraddleEngine, which needs a player who toggled auto-straddle or
    // mandatoryUtg. Horses toggle nothing, so nobody ever straddled.
    expect(fleetSrc).toContain('auto_utg_straddle: config.straddleEnabled === true');
  });

  it('OVERFLOW tables inherit the straddle identity', () => {
    // "NLH Straddle 1.00/2.00 #2" went live with straddle_enabled FALSE:
    // a table named for a game it was not running.
    const overflow = fleetSrc.slice(fleetSrc.indexOf('const name = `${config.name} #'));
    const insert = overflow.slice(0, overflow.indexOf('});'));
    expect(insert).toContain('straddle_enabled: config.straddleEnabled === true');
    expect(insert).toContain('auto_utg_straddle: config.straddleEnabled === true');
  });

  it('the reuse path COMPARES before writing (an unconditional write would reset current_players every cycle)', () => {
    // Whitespace-tolerant: the pre-commit Prettier wraps this line, and an
    // exact-substring pin broke in CI the first time it did (run 33141442420).
    expect(fleetSrc).toMatch(/straddle_enabled !==\s*\(config\.straddleEnabled === true\)/);
    // Dan 2026-08-28 (40BB-200BB law): the reuse lookup now also reads
    // min_buy_in/max_buy_in so a blind bump resyncs the buy-in band instead
    // of carrying a stale one. Whitespace-tolerant for the same Prettier
    // reason as the line above — the longer list wraps.
    expect(fleetSrc).toMatch(
      /select\(\s*'id, status, union_id, game_variant, small_blind, big_blind, straddle_enabled, min_buy_in, max_buy_in'\s*\)/
    );
  });
});
