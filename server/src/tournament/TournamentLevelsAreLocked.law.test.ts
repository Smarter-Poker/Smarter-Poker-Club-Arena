import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  LOCKED_LEVEL_MINUTES,
  lockedLevelMinutes,
  lockStructureClock,
  withLockedLevelClock,
} from './lockedLevelClock.js';
import { MTT_BLIND_PRESETS } from './mttStructurePolicy.js';
import { describeStoredMttStructure, mttClockDescription } from './mttStructureDescription.js';

/* Dan 2026-10-21: "TOURNAMENT LEVELS CAN NEVER EVER BE A 'RANGE'. ... TURBOS
   AND FREE ROLLS 5 MINUTE LEVELS, STANDARD TOURNAMENTS AND BOUNTY TOURNAMENTS 8
   MINUTE LEVELS, DEEP STACK TOURNAMENTS 10 MINUTE LEVELS." */

const mtt = (over: Record<string, unknown>): Record<string, unknown> => ({
  tournament_type: 'MTT',
  variant: 'freezeout',
  buy_in_amount: 9,
  buy_in_fee: 1,
  late_reg_levels: 6,
  ...over,
});

describe('every tournament level is a locked, defined clock', () => {
  it('states the owner clocks exactly', () => {
    expect(LOCKED_LEVEL_MINUTES).toEqual({
      freeroll: 5,
      turbo: 5,
      standard: 8,
      bounty: 8,
      deep_stack: 10,
    });
  });

  it.each([
    ['Morning Free Buy (NLH)', { buy_in_amount: 0, buy_in_fee: 0 }, MTT_BLIND_PRESETS.STANDARD, 5],
    [
      'Coffee Break Freeroll (PLO4)',
      { buy_in_amount: 0, buy_in_fee: 0 },
      MTT_BLIND_PRESETS.HYPER_TURBO,
      5,
    ],
    ['Midday Turbo (NLH)', {}, MTT_BLIND_PRESETS.TURBO, 5],
    ['Highlighted Turbo', { is_pinned: true }, MTT_BLIND_PRESETS.TURBO, 5],
    ['Friday Graveyard', {}, MTT_BLIND_PRESETS.TURBO, 5],
    ['Turbo Tuesday PKO', { is_pko: true }, MTT_BLIND_PRESETS.TURBO, 5],
    ['Daily 25 Chip Freezeout', {}, MTT_BLIND_PRESETS.STANDARD, 8],
    ['Prime Time Main Event (NLH)', {}, MTT_BLIND_PRESETS.STANDARD, 8],
    ['Midweek Bounty', { is_bounty: true, variant: 'bounty' }, MTT_BLIND_PRESETS.STANDARD, 8],
    ['Midnight Bounty (NLH)', { is_bounty: true }, MTT_BLIND_PRESETS.TURBO, 8],
    ['Night Owl Special (NLH)', { bounty_amount: 10 }, MTT_BLIND_PRESETS.TURBO, 8],
    ['Sunday 200 Deep Stack', {}, MTT_BLIND_PRESETS.STANDARD, 8],
    ['Friday Night Feature', { is_pinned: true }, MTT_BLIND_PRESETS.DEEPSTACK, 10],
    ['Saturday Night Big Stack', {}, MTT_BLIND_PRESETS.DEEPSTACK, 8],
    ['Friday Feature Satellite 5', { variant: 'satellite' }, MTT_BLIND_PRESETS.TURBO, 5],
    ['Sunday Deep Stack Satellite 10', { variant: 'satellite' }, MTT_BLIND_PRESETS.STANDARD, 8],
  ])('%s runs %#', (name, over, ladder, minutes) => {
    const row = withLockedLevelClock(mtt({ name, blind_structure: ladder, ...over }));
    const levels = row.blind_structure as Array<{ durationMinutes: number }>;
    expect(lockedLevelMinutes(mtt({ name, blind_structure: ladder, ...over }))).toBe(minutes);
    for (const level of levels) expect(level.durationMinutes).toBe(minutes);
    const facts = describeStoredMttStructure(levels, 10000);
    expect(facts.minimumMinutes).toBe(facts.maximumMinutes);
    expect(mttClockDescription(facts)).toBe(`${minutes} Min`);
    // Locking a locked row changes nothing: the rule cannot drift on re-save.
    expect(withLockedLevelClock(row)).toEqual(row);
  });

  it('keeps breaks, drops every second clock and leaves the ladder alone', () => {
    const locked = lockStructureClock(
      [
        { level: 1, smallBlind: 25, bigBlind: 50, duration: 600 },
        { isBreak: true, smallBlind: 0, bigBlind: 0, durationMinutes: 5 },
        { level: 2, smallBlind: 50, bigBlind: 100, duration_minutes: 9 },
      ],
      8
    );
    expect(locked).toEqual([
      { level: 1, smallBlind: 25, bigBlind: 50, durationMinutes: 8 },
      { isBreak: true, smallBlind: 0, bigBlind: 0, durationMinutes: 5 },
      { level: 2, smallBlind: 50, bigBlind: 100, durationMinutes: 8 },
    ]);
  });

  it('re-derives late registration from the locked clock', () => {
    const row = withLockedLevelClock(
      mtt({
        name: 'Wednesday Reload',
        blind_structure: MTT_BLIND_PRESETS.STANDARD,
        late_reg_mins: 59,
      })
    );
    // STANDARD tapers 10,10,10,9,9,9 = 57 for six levels; 59 is not derived, so kept.
    expect(row.late_reg_mins).toBe(59);
    const derived = withLockedLevelClock(
      mtt({
        name: 'Wednesday Reload',
        blind_structure: MTT_BLIND_PRESETS.STANDARD,
        late_reg_mins: 57,
      })
    );
    expect(derived.late_reg_mins).toBe(48);
  });

  it('preserves faster Spin and Sit & Go clocks', () => {
    for (const row of [
      {
        tournament_type: 'SPIN',
        variant: 'spin',
        name: 'Spin',
        blind_structure: MTT_BLIND_PRESETS.HYPER_TURBO,
      },
      {
        tournament_type: 'SNG',
        variant: 'sng',
        name: 'SNG',
        blind_structure: MTT_BLIND_PRESETS.TURBO,
      },
    ]) {
      expect(withLockedLevelClock(row)).toBe(row);
    }
  });

  it('enforces the highlighted cap in the database and required native CI', () => {
    const root = new URL('../../../', import.meta.url);
    const migration = readFileSync(
      new URL(
        'supabase/migrations/20261031212642_only_highlighted_tournaments_may_have_ten_minute_levels.sql',
        root
      ),
      'utf8'
    );
    expect(migration).toContain('CASE WHEN NEW.is_pinned IS TRUE THEN 10 ELSE 8 END');
    expect(migration).toContain('UPDATE public.tournament_schedules');
    expect(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')).toContain(
      'python3 -B scripts/ci/test-highlighted-level-clock.py'
    );
  });

  it('caps an oversized custom short format without slowing its faster levels', () => {
    const row = withLockedLevelClock({
      tournament_type: 'SNG',
      variant: 'sng',
      blind_structure: [{ durationMinutes: 12 }, { duration: 180 }],
    });
    expect(row.blind_structure).toEqual([{ durationMinutes: 8 }, { duration: 180 }]);
  });

  it('the database applies the same rule on every insert', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const file = readdirSync(dir).find((f) => f.endsWith('_lock_tournament_level_clocks.sql'));
    expect(file).toBeDefined();
    const sql = readFileSync(new URL(file!, dir), 'utf8');
    expect(sql).toContain('CREATE TRIGGER tournaments_lock_level_clock');
    expect(sql).toContain("n ~ 'free ?buy|free ?roll' THEN RETURN 5");
    expect(sql).toContain("n ~ 'turbo|hyper' THEN RETURN 5");
    expect(sql).toContain("n ~ 'deep' THEN RETURN 10");
    expect(sql).toContain("n ~ 'bounty|pko|knockout') THEN RETURN 8");
    expect(sql).toContain('IF opening <= 5 THEN RETURN 5');
    expect(sql).toContain('IF opening >= 12 OR (uniform AND opening = 10) THEN RETURN 10');
    // The lock also carries the Free Buy hour: twelve 5-minute levels, 60 minutes.
    const hour = readdirSync(dir).find((f) => f.endsWith('_free_buy_hour_on_locked_clock.sql'));
    expect(hour).toBeDefined();
    const hourSql = readFileSync(new URL(hour!, dir), 'utf8');
    expect(hourSql).toContain('NEW.late_reg_levels := 12;');
    expect(hourSql).toContain('NEW.late_reg_mins := 60;');
    // Sorts before tournaments_new_mtt_blind_contract, which derives blind_speed.
    expect('tournaments_lock_level_clock' < 'tournaments_new_mtt_blind_contract').toBe(true);
  });
});
