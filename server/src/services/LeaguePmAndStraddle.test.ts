/**
 * V23 PLATFORM (2026-08-28): the second daily league window and the fleet's
 * first straddle table. Source-shape pins, the HorseLeagueSchedule.test.ts
 * convention - these guard wiring that regresses silently.
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

describe('the straddle lane is retired (R2), so the fleet writes no straddle onto any table', () => {
  /* Moved 2026-09-05 for Gate 7. This block used to pin the fleet's straddle
     TABLE: `straddle_enabled: config.straddleEnabled === true` and
     `auto_utg_straddle: ...` on the boot insert and on the '#2 / #3' overflow
     clone, and a compare-before-write on the reuse path. All three writers
     are gone (OPORD 1.4 s2.11: a cash table is opened only by the cluster
     controller) and ruling R2 retires the lane itself: no straddle on any
     cash game. A table's rules now come from its game's ruleset_snapshot,
     which the tick writes onto every open table (Gate 5), and that applier
     forces the straddle flags OFF. So the pin is inverted: the fleet must
     never again grow a straddle writer, and the applier must keep saying no. */
  const gate5 = readFileSync(
    join(__dirname, '../../../supabase/migrations/20260905033729_the_snapshot_is_the_rule.sql'),
    'utf8'
  );
  const gate7 = readFileSync(
    join(
      __dirname,
      '../../../supabase/migrations/20260905034937_gate_7_every_cash_table_is_a_game.sql'
    ),
    'utf8'
  );

  it('the fleet writes neither straddle flag onto a table, and inserts no table at all', () => {
    expect(fleetSrc).not.toContain('straddle_enabled:');
    expect(fleetSrc).not.toContain('auto_utg_straddle:');
    expect(fleetSrc).not.toMatch(/\.from\(['"]tables['"]\)\s*\.insert\(/);
  });

  it('the config flag has no reader: nothing in the fleet acts on straddleEnabled', () => {
    // The TableConfig field may stay declared for the union ladder's history;
    // the moment code READS it, a straddle is being wired back in.
    expect(fleetSrc).not.toContain('config.straddleEnabled');
  });

  it('the snapshot applier forces the straddle off every cash table, every tick', () => {
    expect(gate5).toMatch(
      /straddle_enabled = false, auto_utg_straddle = false, voluntary_straddle = false/
    );
  });

  it('the cutover snapshot was built with straddle false for every adopted game', () => {
    expect(gate7).toMatch(/'straddle', false/);
  });
});
