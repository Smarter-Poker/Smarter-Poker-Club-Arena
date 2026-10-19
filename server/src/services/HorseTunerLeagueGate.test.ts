/**
 * League-gated self-tuner nudges (Dan 2026-10-19). A dial move reaches a live
 * horse only when its direction is league-admitted; everything else stays.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  admittedDialMoves,
  leagueGatedApplyEnabled,
  tunerMoveClass,
} from './HorseTunerLeagueGate.js';
import { LEAGUE_MATCHUPS, runMatchup } from '../benchmark/HorseLeague.js';

describe('tuner move classes', () => {
  it('names the direction of each dial move', () => {
    expect(tunerMoveClass('tightness', 1, 1.02)).toBe('tightness_up');
    expect(tunerMoveClass('aggression', 1, 0.98)).toBe('aggression_down');
    expect(tunerMoveClass('bluffFreq', 1, 1.02)).toBe('bluff_up');
    expect(tunerMoveClass('tightness', 1, 1)).toBeNull();
  });

  it('every class has a league matchup on the card', () => {
    const names = new Set(LEAGUE_MATCHUPS.map((m) => m.name));
    for (const c of [
      'tightness_up',
      'tightness_down',
      'aggression_up',
      'aggression_down',
      'bluff_up',
      'bluff_down',
    ])
      expect(names.has(`tuner_${c}`)).toBe(true);
  });
});

describe('admittedDialMoves', () => {
  const before = { tightness: 1, aggression: 1, bluffFreq: 1 };

  it('applies nothing when nothing is admitted', () => {
    expect(admittedDialMoves(before, { tightness: 1.02, aggression: 0.98 }, new Set())).toBeNull();
  });

  it('keeps only the admitted direction and holds every other dial', () => {
    const r = admittedDialMoves(
      before,
      { tightness: 1.02, aggression: 0.98, bluffFreq: 1.02 },
      new Set(['tightness_up', 'bluff_down'])
    );
    expect(r).toEqual({
      mods: { tightness: 1.02, aggression: 1, bluffFreq: 1 },
      classes: ['tightness_up'],
    });
  });

  it('refuses a move larger than one step or outside the 0.85..1.18 band', () => {
    const all = new Set(['tightness_up', 'aggression_down']);
    expect(admittedDialMoves(before, { tightness: 1.05 }, all)).toBeNull();
    expect(admittedDialMoves({ aggression: 0.86 }, { aggression: 0.84 }, all)).toBeNull();
  });
});

describe('switch', () => {
  it('is off unless HORSE_TUNER_LEAGUE_GATED_APPLY is exactly 1', () => {
    expect(leagueGatedApplyEnabled({})).toBe(false);
    expect(leagueGatedApplyEnabled({ HORSE_TUNER_LEAGUE_GATED_APPLY: 'true' })).toBe(false);
    expect(leagueGatedApplyEnabled({ HORSE_TUNER_LEAGUE_GATED_APPLY: '1' })).toBe(true);
  });
});

describe('league arms carry profile dials', () => {
  it('identical dials on both arms measure exactly zero', async () => {
    const r = await runMatchup(
      { name: 't_same', a: {}, b: {}, modsA: { tightness: 1.1 }, modsB: { tightness: 1.1 } },
      40,
      4242
    );
    expect(r.divergentPairs).toBe(0);
  });

  it('a moved dial changes play (the matchup is not inert)', async () => {
    const r = await runMatchup(
      { name: 't_moved', a: {}, b: {}, modsA: { tightness: 1.18 } },
      120,
      4242
    );
    expect(r.illegalActions ?? 0).toBe(0);
    expect(r.divergentPairs ?? 0).toBeGreaterThan(0);
  });
});

describe('wiring', () => {
  it('the tuner reads admission once and applies only admitted moves', () => {
    const src = fs.readFileSync(path.join(__dirname, 'HorseSelfTuner.ts'), 'utf8');
    expect(src).toMatch(/leagueGatedApplyEnabled\(\) \? await readAdmittedTunerClasses\(\) : null/);
    expect(src).toMatch(/admittedDialMoves\(/);
    expect(src).toMatch(/applyLeagueGatedNudge\(/);
  });

  it('the database re-checks the league evidence itself', () => {
    const sql = fs.readFileSync(
      path.join(
        __dirname,
        '../../../supabase/migrations/20261019154819_the_tuner_moves_a_dial_only_on_league_evidence.sql'
      ),
      'utf8'
    );
    expect(sql).toMatch(/admitted := public\.fn_horse_tuner_admitted_classes\(\)/);
    expect(sql).toMatch(/'not_league_admitted'/);
    expect(sql).toMatch(/\(next_profile - dials\) IS DISTINCT FROM \(expected - dials\)/);
  });
});
