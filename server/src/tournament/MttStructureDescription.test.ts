import { describe, expect, it } from 'vitest';
import {
  describeMttStructure,
  describeStoredMttStructure,
  mttSpeedForMinutes,
  mttClockDescription,
} from './mttStructureDescription.js';

const level = (durationMinutes: number, bigBlind = 50, isBreak = false) => ({
  durationMinutes,
  bigBlind,
  isBreak,
});

describe('MTT presentation follows engine clock and independent stack depth', () => {
  it.each([
    [1, 'hyper_turbo'],
    [2, 'hyper_turbo'],
    [2.5, 'turbo'],
    [3, 'turbo'],
    [5, 'turbo'],
    [6, 'standard'],
    [10, 'standard'],
    [11, 'standard'],
    [12, 'slow'],
    [15, 'slow'],
  ] as const)('classifies %s minutes as %s', (minutes, expected) => {
    expect(mttSpeedForMinutes(minutes)).toBe(expected);
  });

  it.each([0, -1, NaN, Infinity])('does not invent a speed for %s', (minutes) => {
    expect(mttSpeedForMinutes(minutes)).toBeNull();
  });

  it('calls a slow shallow event Slow and discloses its actual depth', () => {
    expect(describeMttStructure([level(15)], 1000)).toMatchObject({
      speedLabel: 'Slow',
      startingDepthBB: 20,
      openingMinutes: 15,
    });
  });

  it('does not change a regular clock label because the event is 600 BB deep', () => {
    expect(describeMttStructure([level(10)], 30000)).toMatchObject({
      speedLabel: 'Regular',
      startingDepthBB: 600,
    });
  });

  it('displays hyper events as Hyper Turbo rather than Turbo', () => {
    expect(describeMttStructure([level(2, 100)], 5000)).toMatchObject({
      speedLabel: 'Hyper Turbo',
      startingDepthBB: 50,
    });
  });

  it('skips break rows and describes the whole playing-clock range', () => {
    expect(
      describeMttStructure([level(5, 0, true), level(10), level(5, 100), level(15, 0, true)], 10000)
    ).toMatchObject({
      openingMinutes: 10,
      minimumMinutes: 5,
      maximumMinutes: 10,
      speedLabel: 'Regular',
      startingDepthBB: 200,
    });
  });

  it('does not derive opening depth from a later valid blind when opening evidence is absent', () => {
    expect(describeMttStructure([level(10, 0), level(5, 100)], 10000).startingDepthBB).toBeNull();
  });

  it('does not advertise a complete duration range if a playing level is unknown', () => {
    expect(describeMttStructure([level(10), level(0, 100)], 10000)).toMatchObject({
      speedLabel: 'Regular',
      minimumMinutes: null,
      maximumMinutes: null,
    });
  });

  it('does not invent a structure for no playing levels or unknown stack', () => {
    expect(describeMttStructure([level(5, 0, true)], 10000)).toMatchObject({
      speedLabel: null,
      openingMinutes: null,
      startingDepthBB: null,
    });
    expect(describeMttStructure([level(10)], NaN).startingDepthBB).toBeNull();
  });
});

describe('stored MTT structures retain units and unknown evidence', () => {
  it.each([
    { raw: [{ duration: 180, bigBlind: 20 }], minutes: 3, label: 'Turbo' },
    { raw: [{ durationMinutes: 2, bigBlind: 20 }], minutes: 2, label: 'Hyper Turbo' },
    { raw: [{ duration_minutes: 12, big_blind: 20 }], minutes: 12, label: 'Slow' },
    {
      raw: [{ durationMinutes: 10, duration_minutes: 2, duration: 180, bigBlind: 20 }],
      minutes: 10,
      label: 'Regular',
    },
    { raw: [{ durationMinutes: 0, duration: 180, bigBlind: 20 }], minutes: 3, label: 'Turbo' },
  ])('normalizes stored shape $raw', ({ raw, minutes, label }) => {
    const original = JSON.stringify(raw);
    const facts = describeStoredMttStructure(raw, '1000');
    expect(facts).toMatchObject({
      openingMinutes: minutes,
      startingDepthBB: 50,
      speedLabel: label,
    });
    expect(describeStoredMttStructure(JSON.stringify(raw), 1000)).toEqual(facts);
    expect(mttClockDescription(facts)).toBe(`${minutes} Min`);
    expect(JSON.stringify(raw)).toBe(original);
  });
  it.each(['deep stack', 'turbo', '[', '{}', '', null, undefined, []])(
    'does not guess from %s',
    (raw) => {
      const facts = describeStoredMttStructure(raw, 1000);
      expect(facts.speedLabel).toBeNull();
      expect(facts.startingDepthBB).toBeNull();
      expect(mttClockDescription(facts)).toBe('Unconfirmed');
    }
  );
  it.each([null, false, [], { isBreak: 'false', durationMinutes: 10, bigBlind: 20 }])(
    'preserves invalid opening %s',
    (raw) => {
      expect(
        describeStoredMttStructure([raw, { durationMinutes: 5, bigBlind: 40 }], 1000)
      ).toMatchObject({ openingMinutes: null, startingDepthBB: null });
    }
  );
  it('skips true breaks while retaining later unknown clocks', () => {
    const facts = describeStoredMttStructure(
      [{ isBreak: true, durationMinutes: 5 }, { duration: 600, bigBlind: 50 }, {}],
      1000
    );
    expect(facts).toMatchObject({ openingMinutes: 10, startingDepthBB: 20, minimumMinutes: null });
    expect(mttClockDescription(facts)).toBe('10 Min Opening');
  });
});
